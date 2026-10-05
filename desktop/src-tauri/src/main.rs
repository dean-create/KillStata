// Prevents a second console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(debug_assertions)]
use std::process::Child;
use std::{
    fs,
    io::Read,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{ipc::Response, AppHandle, Manager, State};
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use uuid::Uuid;

fn keyring_service_for(identifier: &str) -> &'static str {
    match identifier {
        "com.killstata.desktop.dev" => "KillStata Desktop Dev",
        _ => "KillStata Desktop",
    }
}

fn keyring_service() -> &'static str {
    // Debug 必须由 desktop:dev 的独立 Tauri 配置启动；正式发布不能读取测试密钥。
    if cfg!(debug_assertions) {
        keyring_service_for("com.killstata.desktop.dev")
    } else {
        keyring_service_for("com.killstata.desktop")
    }
}
const KEYRING_ACCOUNT: &str = "deepseek-api-key";
const CUSTOM_KEYRING_ACCOUNT: &str = "custom-api-key";
const PROVIDER_CONFIG_KEYRING_ACCOUNT: &str = "provider-config";
const ANTHROPIC_API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
const GOOGLE_API_KEY_ENV: &str = "GOOGLE_GENERATIVE_AI_API_KEY";
const ANTHROPIC_DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
const GOOGLE_DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_COMPATIBLE_NPM: &str = "@ai-sdk/openai-compatible";
const ANTHROPIC_NPM: &str = "@ai-sdk/anthropic";
const GOOGLE_NPM: &str = "@ai-sdk/google";
const MODEL_CATALOG_REQUEST_TIMEOUT_SECONDS: &str = "8";
const MAX_MODEL_CATALOG_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_MODEL_CATALOG_PAGES: usize = 20;
const MAX_MODEL_CATALOG_ITEMS: usize = 10_000;
// v2 组合凭据可能阻塞。v3 单档案迁移到 v4 多档案；任何旧条目都保留、不删除。
const LEGACY_PROVIDER_SETTINGS_KEYRING_ACCOUNT: &str = "provider-settings-v3";
const PROVIDER_SETTINGS_KEYRING_ACCOUNT: &str = "provider-settings-v4";
const PROVIDER_PROFILES_SCHEMA_VERSION: u8 = 1;
const MAX_PROVIDER_PROFILES: usize = 64;
const MIGRATED_V3_PROFILE_ID: &str = "migrated-provider-settings-v3";
const MIGRATED_LEGACY_PROFILE_ID: &str = "migrated-legacy-provider-settings";
static PROVIDER_PROFILE_STORE_LOCK: Mutex<()> = Mutex::new(());
const KEYCHAIN_OPERATION_TIMEOUT: Duration = Duration::from_secs(10);
const CORE_LISTENER_START_TIMEOUT: Duration = Duration::from_secs(15);
const CORE_LISTENER_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAXIMUM_WORKSPACE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAXIMUM_WORKSPACE_SNAPSHOT_BYTES: u64 = 5 * 1024 * 1024;
const WORKSPACE_SNAPSHOT_FILENAME: &str = "workspaces.json";
const WORKSPACE_HISTORY_ENABLED_FILENAME: &str = "workspace-history-enabled";

#[derive(Serialize, Clone)]
struct EngineConnection {
    url: String,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
    configured: bool,
    profile_id: Option<String>,
    provider: String,
    model: String,
    base_url: Option<String>,
    small_model: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    provider: String,
    model: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    small_model: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StoredProviderSettings {
    config: ProviderConfig,
    api_key: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderProfile {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    config: ProviderConfig,
    api_key: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderProfilesStore {
    schema_version: u8,
    default_profile_id: Option<String>,
    profiles: Vec<ProviderProfile>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderProfileSummary {
    id: String,
    display_name: Option<String>,
    provider: String,
    model: String,
    base_url: Option<String>,
    small_model: Option<String>,
    configured: bool,
    is_default: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderProfilesSnapshot {
    profiles: Vec<ProviderProfileSummary>,
    default_profile_id: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderProfileMutation {
    profile_id: String,
    snapshot: ProviderProfilesSnapshot,
    active_changed: bool,
}
struct WorkspaceSelection {
    directory: Mutex<Option<(String, PathBuf)>>,
}

impl WorkspaceSelection {
    fn new() -> Self {
        Self {
            directory: Mutex::new(None),
        }
    }
}

#[derive(Serialize)]
struct WorkspaceDescriptor {
    id: String,
    name: String,
}

fn workspace_descriptor(path: &Path) -> Result<WorkspaceDescriptor, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "无法使用所选本地工作区".to_string())?;
    if !canonical.is_dir() {
        return Err("所选位置不是可用的本地工作区".to_string());
    }
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or("无法读取本地工作区名称")?
        .to_string();
    let mut digest = Sha256::new();
    digest.update(canonical.to_string_lossy().as_bytes());
    let id = format!("workspace-{}", hex::encode(digest.finalize()));
    Ok(WorkspaceDescriptor { id, name })
}

#[cfg(not(debug_assertions))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreProvenance {
    schema_version: u8,
    protocol_version: String,
    source_dirty: bool,
    target_triple: String,
    binary_sha256: String,
}
#[derive(Serialize)]
struct WorkspaceFileMetadata {
    name: Option<String>,
    bytes: u64,
}

struct EngineSupervisor {
    connection: EngineConnection,
    core: Mutex<Option<ManagedChild>>,
}

enum ManagedChild {
    #[cfg(debug_assertions)]
    Development(Child),
    #[cfg(not(debug_assertions))]
    Release(CommandChild),
}

impl ManagedChild {
    fn stop(self) {
        match self {
            #[cfg(debug_assertions)]
            Self::Development(mut child) => {
                let _ = child.kill();
            }
            #[cfg(not(debug_assertions))]
            Self::Release(child) => {
                let _ = child.kill();
            }
        }
    }
}

impl EngineSupervisor {
    fn new() -> Self {
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("无法为本地引擎选择端口")
            .local_addr()
            .expect("无法读取本地引擎端口")
            .port();
        Self {
            connection: EngineConnection {
                url: format!("http://127.0.0.1:{port}"),
                token: Uuid::new_v4().to_string(),
            },
            core: Mutex::new(None),
        }
    }

    fn restart_with_config(
        &self,
        app: &AppHandle,
        config: ProviderConfig,
        api_key: Option<String>,
    ) -> Result<(), String> {
        let port = self.port()?;
        let mut core = self
            .core
            .lock()
            .map_err(|_| "本地 Core 状态不可用".to_string())?;
        if let Some(child) = core.take() {
            child.stop();
            if !wait_for_listener_closed(port, 20) {
                return Err("本地 KillStata Core 未能停止".to_string());
            }
        }
        let child = self.start_core(app, port, api_key.as_deref(), &config)?;
        if !wait_for_listener(port, CORE_LISTENER_START_TIMEOUT) {
            child.stop();
            return Err("本地 KillStata Core 启动超时".to_string());
        }
        *core = Some(child);
        Ok(())
    }

    fn connection_without_credentials(&self, app: &AppHandle) -> Result<EngineConnection, String> {
        self.connection_with_credential_reader(app, default_provider_config(), || Ok(None))
    }

    fn connection_with_credential_reader(
        &self,
        app: &AppHandle,
        config: ProviderConfig,
        read_api_key: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<EngineConnection, String> {
        let mut core = self
            .core
            .lock()
            .map_err(|_| "本地 Core 状态不可用".to_string())?;
        if core.is_none() {
            let port = self.port()?;
            let child = self.start_core(app, port, read_api_key()?.as_deref(), &config)?;
            if !wait_for_listener(port, CORE_LISTENER_START_TIMEOUT) {
                child.stop();
                return Err("本地 KillStata Core 启动超时".to_string());
            }
            *core = Some(child);
        }
        Ok(self.connection.clone())
    }

    fn port(&self) -> Result<u16, String> {
        self.connection
            .url
            .rsplit(':')
            .next()
            .unwrap_or("4318")
            .parse::<u16>()
            .map_err(|_| "本地引擎端口无效".to_string())
    }

    fn stop(&self) {
        if let Ok(mut core) = self.core.lock() {
            if let Some(child) = core.take() {
                child.stop();
            }
        }
    }

    #[cfg(debug_assertions)]
    fn start_core(
        &self,
        _app: &AppHandle,
        port: u16,
        api_key: Option<&str>,
        config: &ProviderConfig,
    ) -> Result<ManagedChild, String> {
        let core_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|path| path.parent())
            .ok_or("无法定位 KillStata Core 工作目录")?;
        let core_entry = core_root.join("packages/killstata/src/core/host.ts");
        if !core_entry.exists() {
            return Err("KillStata Core host 尚未随应用提供".to_string());
        }
        let mut command = Command::new(resolve_bun_executable());
        command
            .args(["run", "--conditions=browser"])
            .arg(core_entry)
            .env_clear()
            .envs(inherited_sidecar_environment(std::env::vars()))
            .env("KILLSTATA_CORE_DIRECTORY", core_root)
            .env("KILLSTATA_CORE_PORT", port.to_string())
            .env("KILLSTATA_CORE_PARENT_PID", std::process::id().to_string())
            .env("KILLSTATA_CORE_TOKEN", &self.connection.token)
            .env("KILLSTATA_CONFIG_CONTENT", engine_config_content(config)?)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        if let Some(api_key) = api_key {
            let env_name = provider_api_key_env(&config.provider)?;
            command.env(env_name, api_key);
        }
        command
            .spawn()
            .map(ManagedChild::Development)
            .map_err(|error| format!("无法启动 KillStata Core：{error}"))
    }

    #[cfg(not(debug_assertions))]
    fn start_core(
        &self,
        app: &AppHandle,
        port: u16,
        api_key: Option<&str>,
        config: &ProviderConfig,
    ) -> Result<ManagedChild, String> {
        let core_binary = packaged_core_binary()?;
        packaged_core_provenance(app, &core_binary)?;
        let inherited_environment = inherited_sidecar_environment(std::env::vars());
        let core = app
            .shell()
            .sidecar("killstata-core")
            .map_err(|error| format!("无法定位内置 KillStata Core：{error}"))?
            .env_clear()
            .envs(inherited_environment)
            .env("KILLSTATA_CORE_DIRECTORY", ".")
            .env("KILLSTATA_CORE_PORT", port.to_string())
            .env("KILLSTATA_CORE_PARENT_PID", std::process::id().to_string())
            .env("KILLSTATA_CORE_TOKEN", &self.connection.token)
            .env("KILLSTATA_CONFIG_CONTENT", engine_config_content(config)?);
        let core = if let Some(api_key) = api_key {
            let env_name = provider_api_key_env(&config.provider)?;
            core.env(env_name, api_key)
        } else {
            core
        };
        let (_, child) = core
            .spawn()
            .map_err(|error| format!("无法启动内置 KillStata Core：{error}"))?;
        Ok(ManagedChild::Release(child))
    }
}

#[cfg(not(debug_assertions))]
fn packaged_core_binary() -> Result<PathBuf, String> {
    let filename = if cfg!(target_os = "windows") {
        "killstata-core.exe"
    } else {
        "killstata-core"
    };
    let path = std::env::current_exe()
        .map_err(|error| format!("无法定位 Desktop 可执行文件：{error}"))?
        .parent()
        .ok_or("无法定位内置分析核心目录")?
        .join(filename);
    if !path.exists() {
        return Err("内置分析核心未随 Desktop 应用打包".to_string());
    }
    Ok(path)
}

#[cfg(not(debug_assertions))]
fn packaged_core_provenance(app: &AppHandle, core_binary: &Path) -> Result<(), String> {
    let path = app
        .path()
        .resource_dir()
        .map_err(|_| "无法定位内置核心 provenance".to_string())?
        .join("resources")
        .join("killstata-core-provenance.json");
    let text = fs::read_to_string(path)
        .map_err(|_| "内置核心 provenance 未随 Desktop 应用打包".to_string())?;
    let provenance: CoreProvenance =
        serde_json::from_str(&text).map_err(|_| "内置核心 provenance 无效".to_string())?;
    if provenance.protocol_version != "v1"
        || provenance.schema_version != 1
        || provenance.target_triple != "aarch64-apple-darwin"
    {
        return Err("内置核心 provenance 声明不受支持".to_string());
    }
    if provenance.source_dirty {
        return Err("正式 Desktop 不允许使用 dirty Core provenance".to_string());
    }
    let expected = provenance.binary_sha256;
    let bytes = fs::read(core_binary).map_err(|_| "无法读取内置分析核心".to_string())?;
    let mut digest = Sha256::new();
    digest.update(bytes);
    if hex::encode(digest.finalize()) != expected {
        return Err("内置分析核心与 provenance SHA-256 不匹配".to_string());
    }
    Ok(())
}

/// 打包后的 sidecar 只继承进程运行所必需的少量系统变量。
/// 用 allowlist 而不是 denylist：代理、运行时选项和用户自定义变量都不应影响受管引擎，
/// 也不能让本机环境覆盖 Desktop 显式注入的配置与凭据。
const INHERITED_SIDECAR_ENVIRONMENT: [&str; 6] =
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER"];

#[cfg(debug_assertions)]
fn resolve_bun_executable_from(
    path: Option<&std::ffi::OsStr>,
    bun_install: Option<&std::ffi::OsStr>,
    home: Option<&std::ffi::OsStr>,
    exists: impl Fn(&Path) -> bool,
) -> PathBuf {
    let mut candidates = Vec::new();
    if let Some(path) = path {
        candidates.extend(std::env::split_paths(path).map(|directory| directory.join("bun")));
    }
    if let Some(root) = bun_install {
        candidates.push(PathBuf::from(root).join("bin").join("bun"));
    }
    if let Some(home) = home {
        candidates.push(PathBuf::from(home).join(".bun").join("bin").join("bun"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/bun"));
    candidates.push(PathBuf::from("/usr/local/bin/bun"));
    candidates
        .into_iter()
        .find(|candidate| exists(candidate))
        .unwrap_or_else(|| PathBuf::from("bun"))
}

#[cfg(debug_assertions)]
fn resolve_bun_executable() -> PathBuf {
    resolve_bun_executable_from(
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("BUN_INSTALL").as_deref(),
        std::env::var_os("HOME").as_deref(),
        |candidate| candidate.is_file(),
    )
}

fn inherited_sidecar_environment(
    variables: impl Iterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    variables
        .filter(|(key, _)| INHERITED_SIDECAR_ENVIRONMENT.contains(&key.as_str()))
        .collect()
}

/// 应用数据目录中的偏好与历史都只属于当前用户；多用户机器上不应被其他账户读取。
#[cfg(unix)]
fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| "无法写入应用数据目录".to_string())?;
    file.write_all(contents)
        .map_err(|_| "无法写入应用数据目录".to_string())
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    fs::write(path, contents).map_err(|_| "无法写入应用数据目录".to_string())
}

fn wait_for_listener(port: u16, timeout: Duration) -> bool {
    wait_for_listener_with(timeout, CORE_LISTENER_POLL_INTERVAL, || {
        TcpStream::connect(("127.0.0.1", port)).is_ok()
    })
}

fn wait_for_listener_with(
    timeout: Duration,
    interval: Duration,
    mut is_listening: impl FnMut() -> bool,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if is_listening() {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        thread::sleep(interval.min(remaining));
    }
}

fn wait_for_listener_closed(port: u16, attempts: u8) -> bool {
    for attempt in 0..attempts {
        if TcpStream::connect(("127.0.0.1", port)).is_err() {
            return true;
        }
        if attempt + 1 < attempts {
            thread::sleep(Duration::from_millis(100));
        }
    }
    false
}

#[cfg(not(debug_assertions))]
fn free_loopback_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "无法为内置分析核心选择端口".to_string())?
        .local_addr()
        .map(|address| address.port())
        .map_err(|_| "无法读取内置分析核心端口".to_string())
}

fn normalize_provider_config(config: ProviderConfig) -> Result<ProviderConfig, String> {
    let provider = config.provider.trim().to_lowercase();
    // 旧版默认模型仍可能存在于 Keychain；升级时只迁移这个产品默认值，
    // 不触碰用户明确配置的其它 provider 或自定义模型。
    let model = match (provider.as_str(), config.model.trim()) {
        ("deepseek", "deepseek/deepseek-v4.1-flash-expires-on-0910") => {
            "deepseek/deepseek-v4-flash".to_string()
        }
        _ => config.model.trim().to_string(),
    };
    if !matches!(
        provider.as_str(),
        "deepseek" | "custom" | "anthropic" | "google"
    ) {
        return Err("不支持的模型提供商".to_string());
    }
    if model.is_empty()
        || !model.starts_with(&format!("{provider}/"))
        || model.len() <= provider.len() + 1
    {
        return Err("模型必须使用 provider/model 格式".to_string());
    }
    if provider == "deepseek"
        && model != "deepseek/deepseek-v4-flash"
        && model != "deepseek/deepseek-v4-pro"
    {
        return Err("DeepSeek 只支持内置 deepseek-v4-flash 或 V4 Pro 模型".to_string());
    }
    let base_url = match provider.as_str() {
        "custom" => {
            let raw = config
                .base_url
                .unwrap_or_default()
                .trim()
                .trim_end_matches('/')
                .to_string();
            validate_provider_base_url(&raw)?;
            Some(raw)
        }
        "anthropic" | "google" => config
            .base_url
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .map(|value| {
                validate_provider_base_url(&value)?;
                Ok::<String, String>(value)
            })
            .transpose()?,
        _ => None,
    };
    let small_model = config.small_model.and_then(|value| {
        let value = match (provider.as_str(), value.trim()) {
            ("deepseek", "deepseek/deepseek-v4.1-flash-expires-on-0910") => {
                "deepseek/deepseek-v4-flash".to_string()
            }
            (_, value) => value.to_string(),
        };
        (!value.is_empty()).then_some(value)
    });
    if let Some(small_model) = &small_model {
        if !small_model.starts_with(&format!("{provider}/"))
            || small_model.len() <= provider.len() + 1
        {
            return Err("小模型必须使用 provider/model 格式".to_string());
        }
        if provider == "deepseek"
            && small_model != "deepseek/deepseek-v4-flash"
            && small_model != "deepseek/deepseek-v4-pro"
        {
            return Err("DeepSeek 小模型只支持内置 deepseek-v4-flash 或 V4 Pro".to_string());
        }
    }
    Ok(ProviderConfig {
        provider,
        model,
        base_url,
        small_model,
    })
}

fn empty_provider_profiles() -> ProviderProfilesStore {
    ProviderProfilesStore {
        schema_version: PROVIDER_PROFILES_SCHEMA_VERSION,
        default_profile_id: None,
        profiles: Vec::new(),
    }
}

fn validate_provider_profiles(
    mut store: ProviderProfilesStore,
) -> Result<ProviderProfilesStore, String> {
    if store.schema_version != PROVIDER_PROFILES_SCHEMA_VERSION {
        return Err("系统凭据库中的模型档案版本不受支持，请重新配置模型。".to_string());
    }
    if store.profiles.len() > MAX_PROVIDER_PROFILES {
        return Err("模型档案数量超过安全上限。".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    for profile in &mut store.profiles {
        profile.id = profile.id.trim().to_string();
        if profile.id.is_empty() || !ids.insert(profile.id.clone()) {
            return Err("模型档案 ID 无效或重复，请重新保存模型配置。".to_string());
        }
        profile.config = normalize_provider_config(profile.config.clone())?;
        profile.display_name = normalize_profile_display_name(profile.display_name.take());
        profile.api_key = profile
            .api_key
            .as_deref()
            .map(normalize_api_key)
            .transpose()?;
    }
    if let Some(profile_id) = store.default_profile_id.as_ref() {
        let Some(profile) = store
            .profiles
            .iter()
            .find(|profile| &profile.id == profile_id)
        else {
            return Err("默认模型档案不存在；为保护现有配置，未自动切换。".to_string());
        };
        if profile.api_key.is_none() {
            return Err("默认模型档案尚未配置 API Key；已恢复内置 DeepSeek 默认。".to_string());
        }
    }
    Ok(store)
}

fn migrate_v3_provider_settings(
    legacy: StoredProviderSettings,
    profile_id: &str,
) -> Result<ProviderProfilesStore, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() {
        return Err("模型档案 ID 不能为空。".to_string());
    }
    validate_provider_profiles(ProviderProfilesStore {
        schema_version: PROVIDER_PROFILES_SCHEMA_VERSION,
        default_profile_id: Some(profile_id.to_string()),
        profiles: vec![ProviderProfile {
            id: profile_id.to_string(),
            display_name: None,
            config: normalize_provider_config(legacy.config)?,
            api_key: Some(normalize_api_key(&legacy.api_key)?),
        }],
    })
}

fn migrate_legacy_provider_config(
    config: ProviderConfig,
    api_key: Option<String>,
    profile_id: &str,
) -> Result<ProviderProfilesStore, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() {
        return Err("模型档案 ID 不能为空。".to_string());
    }
    let default_profile_id = api_key.as_ref().map(|_| profile_id.to_string());
    validate_provider_profiles(ProviderProfilesStore {
        schema_version: PROVIDER_PROFILES_SCHEMA_VERSION,
        default_profile_id,
        profiles: vec![ProviderProfile {
            id: profile_id.to_string(),
            display_name: None,
            config: normalize_provider_config(config)?,
            api_key: api_key.as_deref().map(normalize_api_key).transpose()?,
        }],
    })
}

fn active_profile_identity(
    store: &ProviderProfilesStore,
) -> Option<(String, ProviderConfig, Option<String>)> {
    let id = store.default_profile_id.as_ref()?;
    let profile = store.profiles.iter().find(|profile| &profile.id == id)?;
    Some((
        profile.id.clone(),
        profile.config.clone(),
        profile.api_key.clone(),
    ))
}

fn upsert_provider_profile(
    store: &mut ProviderProfilesStore,
    profile_id: Option<&str>,
    create_if_missing: bool,
    config: ProviderConfig,
    api_key: Option<String>,
    make_default: bool,
) -> Result<(String, bool), String> {
    let before_default = store.default_profile_id.clone();
    let before_active = active_profile_identity(store);
    let config = normalize_provider_config(config)?;
    let requested_id = profile_id.map(str::trim).filter(|id| !id.is_empty());
    let existing_index =
        requested_id.and_then(|id| store.profiles.iter().position(|profile| profile.id == id));
    let is_edit = existing_index.is_some();
    let id = match (requested_id, existing_index) {
        (Some(id), Some(index)) => {
            let existing = &mut store.profiles[index];
            let api_key = match api_key {
                Some(api_key) => Some(normalize_api_key(&api_key)?),
                None => existing.api_key.clone(),
            };
            existing.config = config;
            existing.api_key = api_key;
            id.to_string()
        }
        (Some(id), None) if create_if_missing => {
            if store.profiles.len() >= MAX_PROVIDER_PROFILES {
                return Err("模型档案数量已达到安全上限，请先移除不再使用的档案。".to_string());
            }
            let api_key = Some(normalize_api_key(
                &api_key.ok_or("添加模型前请先输入 API Key。".to_string())?,
            )?);
            if id.len() > 128 {
                return Err("模型档案 ID 超出长度限制。".to_string());
            }
            store.profiles.push(ProviderProfile {
                id: id.to_string(),
                display_name: None,
                config,
                api_key,
            });
            id.to_string()
        }
        (Some(_), None) => return Err("要编辑的模型档案已不存在，请刷新模型管理页。".to_string()),
        (None, None) if create_if_missing => {
            if store.profiles.len() >= MAX_PROVIDER_PROFILES {
                return Err("模型档案数量已达到安全上限，请先移除不再使用的档案。".to_string());
            }
            let api_key = Some(normalize_api_key(
                &api_key.ok_or("添加模型前请先输入 API Key。".to_string())?,
            )?);
            let id = Uuid::new_v4().to_string();
            store.profiles.push(ProviderProfile {
                id: id.clone(),
                display_name: None,
                config,
                api_key,
            });
            id
        }
        (None, Some(_)) => return Err("编辑模型档案必须提供档案 ID。".to_string()),
        (None, None) => return Err("添加模型档案必须提供创建请求 ID。".to_string()),
    };
    if make_default {
        if !store
            .profiles
            .iter()
            .any(|profile| profile.id == id && profile.api_key.is_some())
        {
            return Err("该模型档案尚未配置 API Key，不能设为默认。".to_string());
        }
        store.default_profile_id = Some(id.clone());
    } else if is_edit && store.default_profile_id.as_deref() == Some(id.as_str()) {
        store.default_profile_id = None;
    }
    let validated = validate_provider_profiles(store.clone())?;
    *store = validated;
    let active_changed = before_default != store.default_profile_id
        || before_active != active_profile_identity(store);
    Ok((id, active_changed))
}

fn upsert_provider_profile_named(
    store: &mut ProviderProfilesStore,
    profile_id: Option<&str>,
    create_if_missing: bool,
    config: ProviderConfig,
    api_key: Option<String>,
    make_default: bool,
    display_name: Option<String>,
) -> Result<(String, bool), String> {
    let config = normalize_provider_config(config)?;
    if let (Some(id), None) = (
        profile_id.map(str::trim).filter(|id| !id.is_empty()),
        api_key.as_ref(),
    ) {
        if let Some(existing) = store.profiles.iter().find(|profile| profile.id == id) {
            if existing.api_key.is_some()
                && !profile_credential_target_matches(&existing.config, &config)
            {
                return Err(
                    "服务商或 Base URL 已更改。为避免把原 API Key 发往新服务，请重新输入该档案的 API Key。"
                        .to_string(),
                );
            }
        }
    }
    let (id, active_changed) = upsert_provider_profile(
        store,
        profile_id,
        create_if_missing,
        config,
        api_key,
        make_default,
    )?;
    let profile = store
        .profiles
        .iter_mut()
        .find(|profile| profile.id == id)
        .ok_or("保存后的模型档案未找到。".to_string())?;
    profile.display_name = normalize_profile_display_name(display_name);
    Ok((id, active_changed))
}

fn set_default_profile_in_store(
    store: &mut ProviderProfilesStore,
    profile_id: Option<&str>,
) -> Result<bool, String> {
    let before_default = store.default_profile_id.clone();
    match profile_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id)
            if store
                .profiles
                .iter()
                .any(|profile| profile.id == id && profile.api_key.is_some()) =>
        {
            store.default_profile_id = Some(id.to_string());
        }
        Some(id) if store.profiles.iter().any(|profile| profile.id == id) => {
            return Err("该模型档案尚未配置 API Key，不能设为默认。".to_string());
        }
        Some(_) => return Err("要设为默认的模型档案不存在，请刷新后重试。".to_string()),
        None => store.default_profile_id = None,
    }
    Ok(before_default != store.default_profile_id)
}

fn delete_profile_from_store(
    store: &mut ProviderProfilesStore,
    profile_id: &str,
) -> Result<bool, String> {
    let before_default = store.default_profile_id.clone();
    let Some(index) = store
        .profiles
        .iter()
        .position(|profile| profile.id == profile_id)
    else {
        return Ok(false);
    };
    store.profiles.remove(index);
    if store.default_profile_id.as_deref() == Some(profile_id) {
        store.default_profile_id = store
            .profiles
            .iter()
            .find(|profile| profile.api_key.is_some())
            .map(|profile| profile.id.clone());
    }
    let validated = validate_provider_profiles(store.clone())?;
    *store = validated;
    Ok(before_default != store.default_profile_id)
}

fn provider_profiles_snapshot(store: &ProviderProfilesStore) -> ProviderProfilesSnapshot {
    ProviderProfilesSnapshot {
        default_profile_id: store.default_profile_id.clone(),
        profiles: store
            .profiles
            .iter()
            .map(|profile| ProviderProfileSummary {
                id: profile.id.clone(),
                display_name: profile.display_name.clone(),
                provider: profile.config.provider.clone(),
                model: profile.config.model.clone(),
                base_url: profile.config.base_url.clone(),
                small_model: profile.config.small_model.clone(),
                configured: profile.api_key.is_some(),
                is_default: store.default_profile_id.as_deref() == Some(profile.id.as_str()),
            })
            .collect(),
    }
}

fn normalize_profile_display_name(display_name: Option<String>) -> Option<String> {
    display_name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().take(80).collect())
}

fn profile_credential_target_matches(saved: &ProviderConfig, requested: &ProviderConfig) -> bool {
    if saved.provider != requested.provider {
        return false;
    }
    let default_url = |provider: &str| match provider {
        "anthropic" => Some(ANTHROPIC_DEFAULT_BASE_URL),
        "google" => Some(GOOGLE_DEFAULT_BASE_URL),
        _ => None,
    };
    let endpoint = |config: &ProviderConfig| {
        config
            .base_url
            .as_deref()
            .or_else(|| default_url(&config.provider))
            .map(|value| value.trim().trim_end_matches('/').to_string())
    };
    endpoint(saved) == endpoint(requested)
}

fn migrate_optional_legacy_provider_config(
    config: Option<ProviderConfig>,
    api_key: Option<String>,
    profile_id: &str,
) -> Result<Option<ProviderProfilesStore>, String> {
    match (config, api_key) {
        (Some(config), api_key) => {
            migrate_legacy_provider_config(config, api_key, profile_id).map(Some)
        }
        (None, Some(api_key)) => {
            migrate_legacy_provider_config(default_provider_config(), Some(api_key), profile_id)
                .map(Some)
        }
        (None, None) => Ok(None),
    }
}

fn default_provider_config_for_store(store: &ProviderProfilesStore) -> ProviderConfig {
    store
        .default_profile_id
        .as_ref()
        .and_then(|id| store.profiles.iter().find(|profile| &profile.id == id))
        .map(|profile| profile.config.clone())
        .unwrap_or_else(default_provider_config)
}

fn default_api_key_for_store(store: &ProviderProfilesStore) -> Option<&str> {
    let id = store.default_profile_id.as_ref()?;
    store
        .profiles
        .iter()
        .find(|profile| &profile.id == id)
        .and_then(|profile| profile.api_key.as_deref())
}

fn profile_for_model_discovery<'a>(
    store: &'a ProviderProfilesStore,
    profile_id: Option<&str>,
    provider: &str,
) -> Option<&'a ProviderProfile> {
    let profile = match profile_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => store.profiles.iter().find(|profile| profile.id == id),
        None => store
            .default_profile_id
            .as_deref()
            .and_then(|id| store.profiles.iter().find(|profile| profile.id == id)),
    }?;
    (profile.config.provider == provider && profile.api_key.is_some()).then_some(profile)
}

fn profile_model_discovery_endpoint_matches(
    profile: &ProviderProfile,
    requested_base_url: Option<&str>,
) -> Result<(), String> {
    let requested = requested_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/').to_string());
    let Some(requested) = requested else {
        return Ok(());
    };
    let saved = profile
        .config
        .base_url
        .as_deref()
        .or_else(|| match profile.config.provider.as_str() {
            "anthropic" => Some(ANTHROPIC_DEFAULT_BASE_URL),
            "google" => Some(GOOGLE_DEFAULT_BASE_URL),
            _ => None,
        })
        .map(|value| value.trim_end_matches('/').to_string());
    if saved.as_deref() != Some(requested.as_str()) {
        return Err(
            "Base URL 已更改。为避免把原 API Key 发往新地址，请重新输入该档案的 API Key。"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_provider_base_url(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw).map_err(|_| "请填写合法的端点 base URL".to_string())?;
    if parsed.scheme() == "https" {
        return Ok(());
    }
    let loopback = match parsed.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(address)) => address == std::net::Ipv4Addr::new(127, 0, 0, 1),
        Some(url::Host::Ipv6(address)) => address == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    };
    if parsed.scheme() == "http" && loopback {
        return Ok(());
    }
    Err("base URL 必须使用 https；仅本机回环服务允许 http".to_string())
}

fn engine_config_content(config: &ProviderConfig) -> Result<String, String> {
    let config = normalize_provider_config(config.clone())?;
    let mut value = json!({ "model": config.model });
    if let Some(small_model) = config.small_model {
        value["small_model"] = Value::String(small_model);
    }
    if config.provider == "custom" {
        value["provider"] = json!({
            "custom": {
                "name": "OpenAI-compatible",
                "api": config.base_url,
                "options": { "baseURL": config.base_url },
                "models": { config.model.strip_prefix("custom/").unwrap_or(&config.model): { "id": config.model.strip_prefix("custom/").unwrap_or(&config.model), "provider": { "npm": OPENAI_COMPATIBLE_NPM } } }
            }
        });
    } else if matches!(config.provider.as_str(), "anthropic" | "google") {
        let model_id = config
            .model
            .strip_prefix(&format!("{}/", config.provider))
            .unwrap_or(&config.model);
        let api_key_env = provider_api_key_env(&config.provider)?;
        let (name, default_base_url, provider_npm) = if config.provider == "anthropic" {
            ("Anthropic", ANTHROPIC_DEFAULT_BASE_URL, ANTHROPIC_NPM)
        } else {
            ("Google Gemini", GOOGLE_DEFAULT_BASE_URL, GOOGLE_NPM)
        };
        let base_url = config.base_url.as_deref().unwrap_or(default_base_url);
        let mut provider = json!({
            "name": name,
            "api": base_url,
            "env": [api_key_env],
            "models": {
                model_id: {
                    "id": model_id,
                    "name": model_id,
                    "provider": { "npm": provider_npm }
                }
            }
        });
        if config.base_url.is_some() {
            provider["options"] = json!({ "baseURL": base_url });
        }
        value["provider"] = json!({ config.provider.clone(): provider });
    }
    serde_json::to_string(&value).map_err(|_| "无法生成本地引擎配置".to_string())
}

fn provider_api_key_env(provider: &str) -> Result<&'static str, String> {
    match provider {
        "deepseek" => Ok("DEEPSEEK_API_KEY"),
        "custom" => Ok("KILLSTATA_CUSTOM_API_KEY"),
        "anthropic" => Ok(ANTHROPIC_API_KEY_ENV),
        "google" => Ok(GOOGLE_API_KEY_ENV),
        _ => Err("不支持的模型提供商".to_string()),
    }
}

fn normalize_api_key(api_key: &str) -> Result<String, String> {
    let normalized = api_key.trim();
    if normalized.is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    Ok(normalized.to_string())
}

fn workspace_contains_file(workspace: &Path, candidate: &Path) -> bool {
    candidate
        .strip_prefix(workspace)
        .is_ok_and(|relative| !relative.as_os_str().is_empty())
}

/// 在同一个受限文件描述符上完成类型、大小与内容读取，避免校验后再按路径跟随链接。
#[cfg(unix)]
fn read_selected_workspace_file(workspace: &Path, candidate: &Path) -> Result<Vec<u8>, String> {
    use std::{
        ffi::CString,
        fs::{File, OpenOptions},
        io::Read,
        os::unix::{
            ffi::OsStrExt,
            fs::OpenOptionsExt,
            io::{AsRawFd, FromRawFd},
        },
        path::Component,
    };

    fn open_descendant(parent: &File, name: &std::ffi::OsStr, flags: i32) -> Result<File, String> {
        let name = CString::new(name.as_bytes()).map_err(|_| "无法读取所选数据文件".to_string())?;
        let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor < 0 {
            return Err("无法读取所选数据文件".to_string());
        }
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    let relative = candidate
        .strip_prefix(workspace)
        .map_err(|_| "请选择当前工作区中的数据文件".to_string())?;
    let mut components = relative.components().peekable();
    if components.peek().is_none() {
        return Err("请选择一个数据文件".to_string());
    }
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(workspace)
        .map_err(|_| "无法读取所选数据文件".to_string())?;
    let mut file = None;
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err("请选择当前工作区中的数据文件".to_string());
        };
        let flags = libc::O_RDONLY | libc::O_NOFOLLOW;
        let opened = if components.peek().is_some() {
            open_descendant(&directory, name, flags | libc::O_DIRECTORY)?
        } else {
            // 文件筛选并不能阻止同名 FIFO；非阻塞打开后会由 metadata 的 regular-file
            // 检查拒绝它，避免系统对话框返回异常节点时卡住桌面应用。
            open_descendant(&directory, name, flags | libc::O_NONBLOCK)?
        };
        if components.peek().is_some() {
            directory = opened;
        } else {
            file = Some(opened);
        }
    }
    let mut file = file.ok_or("请选择一个数据文件")?;
    let metadata = file
        .metadata()
        .map_err(|_| "无法读取所选数据文件".to_string())?;
    if !metadata.is_file() {
        return Err("请选择一个数据文件".to_string());
    }
    if metadata.len() > MAXIMUM_WORKSPACE_FILE_BYTES {
        return Err("所选数据文件超过本地预览大小上限".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(MAXIMUM_WORKSPACE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取所选数据文件".to_string())?;
    if bytes.len() as u64 > MAXIMUM_WORKSPACE_FILE_BYTES {
        return Err("所选数据文件超过本地预览大小上限".to_string());
    }
    Ok(bytes)
}

#[cfg(not(unix))]
fn read_selected_workspace_file(_: &Path, _: &Path) -> Result<Vec<u8>, String> {
    Err("当前系统暂不支持从工作区引用文件".to_string())
}

fn api_key_entry_for(provider: &str) -> Result<keyring::Entry, String> {
    let account = match provider {
        "deepseek" => KEYRING_ACCOUNT,
        "custom" => CUSTOM_KEYRING_ACCOUNT,
        _ => return Err("不支持的模型提供商".to_string()),
    };
    keyring::Entry::new(keyring_service(), account)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn provider_config_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(keyring_service(), PROVIDER_CONFIG_KEYRING_ACCOUNT)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn provider_settings_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(keyring_service(), PROVIDER_SETTINGS_KEYRING_ACCOUNT)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn legacy_provider_settings_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(keyring_service(), LEGACY_PROVIDER_SETTINGS_KEYRING_ACCOUNT)
        .map_err(|error| format!("无法访问旧版系统凭据：{error}"))
}

/// Keychain API 在 macOS 上可能等待 securityd 或用户授权而不返回；把它放在
/// blocking worker 之外再加有界超时，避免 Tauri 命令和 Desktop 提交永久悬挂。
/// 超时后底层 worker 可能仍由系统 Keychain 持有，但上层不会再无限等待；新请求
/// 会快速失败并提示用户解锁或重新保存配置。
async fn bounded_keychain_operation<T, F>(
    operation: F,
    timeout_message: &'static str,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let task = tauri::async_runtime::spawn_blocking(operation);
    let joined = tokio::time::timeout(KEYCHAIN_OPERATION_TIMEOUT, task)
        .await
        .map_err(|_| timeout_message.to_string())?
        .map_err(|_| "系统凭据库后台任务异常退出".to_string())?;
    joined
}

fn read_provider_profiles_store() -> Result<Option<ProviderProfilesStore>, String> {
    match provider_settings_entry()?.get_password() {
        Ok(raw) => {
            let store: ProviderProfilesStore = serde_json::from_str(&raw)
                .map_err(|_| "系统凭据库中的模型档案库无效；旧配置未修改。".to_string())?;
            Ok(Some(validate_provider_profiles(store)?))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取系统凭据库：{error}")),
    }
}

fn write_provider_profiles_store(store: &ProviderProfilesStore) -> Result<(), String> {
    let store = validate_provider_profiles(store.clone())?;
    let raw = serde_json::to_string(&store).map_err(|_| "无法序列化模型档案库".to_string())?;
    provider_settings_entry()?
        .set_password(&raw)
        .map_err(|error| format!("无法保存模型档案：{error}"))
}

fn read_v3_provider_settings() -> Result<Option<StoredProviderSettings>, String> {
    match legacy_provider_settings_entry()?.get_password() {
        Ok(raw) => {
            let stored: StoredProviderSettings = serde_json::from_str(&raw)
                .map_err(|_| "旧版模型配置无效；原始凭据已保留。".to_string())?;
            Ok(Some(StoredProviderSettings {
                config: normalize_provider_config(stored.config)?,
                api_key: normalize_api_key(&stored.api_key)?,
            }))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取旧版模型配置：{error}")),
    }
}

/// 升级路径：旧版把 provider 配置与 API Key 分开保存。缺少旧 Key 时仍保存一个
/// `configured=false` 的档案，使模型管理 UI 能让用户补录密钥，而不丢失 endpoint/model。
fn migrate_legacy_provider_settings() -> Result<Option<ProviderProfilesStore>, String> {
    let config = legacy_provider_config_if_present()?;
    let provider = config
        .as_ref()
        .map(|config| config.provider.as_str())
        .unwrap_or("deepseek");
    let api_key = configured_api_key_for_legacy(provider)?;
    let Some(store) =
        migrate_optional_legacy_provider_config(config, api_key, MIGRATED_LEGACY_PROFILE_ID)?
    else {
        return Ok(None);
    };
    write_provider_profiles_store(&store)?;
    Ok(Some(store))
}

fn configured_provider_profiles_unlocked() -> Result<Option<ProviderProfilesStore>, String> {
    if let Some(store) = read_provider_profiles_store()? {
        return Ok(Some(store));
    }
    if let Some(v3) = read_v3_provider_settings()? {
        let store = migrate_v3_provider_settings(v3, MIGRATED_V3_PROFILE_ID)?;
        write_provider_profiles_store(&store)?;
        return Ok(Some(store));
    }
    migrate_legacy_provider_settings()
}

fn configured_provider_profiles() -> Result<Option<ProviderProfilesStore>, String> {
    let _guard = PROVIDER_PROFILE_STORE_LOCK
        .lock()
        .map_err(|_| "模型档案状态不可用".to_string())?;
    configured_provider_profiles_unlocked()
}

fn with_profile_store_lock<T>(
    cancelled: Option<&AtomicBool>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = PROVIDER_PROFILE_STORE_LOCK
        .lock()
        .map_err(|_| "模型档案状态不可用".to_string())?;
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("模型档案操作已超时，未开始写入；请刷新档案列表核对状态。".to_string());
    }
    operation()
}

fn mutate_provider_profiles<T>(
    cancelled: &AtomicBool,
    operation: impl FnOnce(&mut ProviderProfilesStore) -> Result<(T, bool), String>,
) -> Result<T, String> {
    with_profile_store_lock(Some(cancelled), || {
        let mut store =
            configured_provider_profiles_unlocked()?.unwrap_or_else(empty_provider_profiles);
        let (result, should_write) = operation(&mut store)?;
        if should_write {
            write_provider_profiles_store(&store)?;
        }
        Ok(result)
    })
}

async fn bounded_profile_mutation<T, F>(
    operation: F,
    timeout_message: &'static str,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut ProviderProfilesStore) -> Result<(T, bool), String> + Send + 'static,
{
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let task = tauri::async_runtime::spawn_blocking(move || {
        mutate_provider_profiles(&worker_cancelled, operation)
    });
    let joined = match tokio::time::timeout(KEYCHAIN_OPERATION_TIMEOUT, task).await {
        Ok(joined) => joined.map_err(|_| "模型档案后台任务异常退出".to_string())?,
        Err(_) => {
            cancelled.store(true, Ordering::Release);
            return Err(timeout_message.to_string());
        }
    };
    joined
}

fn configured_provider_settings() -> Result<Option<StoredProviderSettings>, String> {
    let Some(store) = configured_provider_profiles()? else {
        return Ok(None);
    };
    let Some(profile_id) = store.default_profile_id else {
        return Ok(None);
    };
    let Some(profile) = store
        .profiles
        .into_iter()
        .find(|profile| profile.id == profile_id)
    else {
        return Err("默认模型档案不存在；已阻止加载不一致配置。".to_string());
    };
    let Some(api_key) = profile.api_key else {
        return Ok(None);
    };
    Ok(Some(StoredProviderSettings {
        config: profile.config,
        api_key,
    }))
}

fn default_provider_config() -> ProviderConfig {
    ProviderConfig {
        provider: "deepseek".to_string(),
        model: "deepseek/deepseek-v4-flash".to_string(),
        base_url: None,
        small_model: None,
    }
}

fn configured_provider_config_legacy() -> Result<ProviderConfig, String> {
    let entry = provider_config_entry()?;
    match entry.get_password() {
        Ok(raw) => {
            let config = serde_json::from_str(&raw)
                .map_err(|_| "系统凭据库中的模型配置无效，请重新保存。".to_string())?;
            normalize_provider_config(config)
        }
        Err(keyring::Error::NoEntry) => Ok(default_provider_config()),
        Err(error) => Err(format!("无法读取系统凭据库：{error}")),
    }
}

fn legacy_provider_config_if_present() -> Result<Option<ProviderConfig>, String> {
    match provider_config_entry()?.get_password() {
        Ok(raw) => {
            let config = serde_json::from_str(&raw)
                .map_err(|_| "系统凭据库中的模型配置无效，请重新保存。".to_string())?;
            normalize_provider_config(config).map(Some)
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取系统凭据库：{error}")),
    }
}

fn configured_api_key_for_legacy(provider: &str) -> Result<Option<String>, String> {
    match api_key_entry_for(provider)?.get_password() {
        Ok(api_key) => normalize_api_key(&api_key)
            .map(Some)
            .map_err(|_| "系统凭据库中的 API Key 无效，请重新保存。".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取系统凭据库：{error}")),
    }
}

#[cfg(test)]
fn configured_api_key() -> Result<Option<String>, String> {
    configured_api_key_for_legacy("deepseek")
}

#[tauri::command]
fn core_connection(
    app: AppHandle,
    supervisor: State<'_, EngineSupervisor>,
) -> Result<EngineConnection, String> {
    supervisor.connection_without_credentials(&app)
}

#[tauri::command]
async fn activate_core_credentials(
    app: AppHandle,
    supervisor: State<'_, EngineSupervisor>,
) -> Result<(), String> {
    let stored = bounded_keychain_operation(
        || configured_provider_settings(),
        "读取模型凭据超时，请解锁钥匙串或重新保存模型配置",
    )
    .await?
    .ok_or("尚未配置当前模型提供商的 API Key，请先在设置中保存")?;
    supervisor.restart_with_config(&app, stored.config, Some(stored.api_key))
}

#[tauri::command]
async fn refresh_core_credentials(
    app: AppHandle,
    supervisor: State<'_, EngineSupervisor>,
) -> Result<(), String> {
    let stored = bounded_keychain_operation(
        || configured_provider_settings(),
        "读取模型凭据超时，请解锁钥匙串或重新保存模型配置",
    )
    .await?;
    let (config, api_key) = match stored {
        Some(stored) => (stored.config, Some(stored.api_key)),
        None => (default_provider_config(), None),
    };
    supervisor.restart_with_config(&app, config, api_key)
}

#[tauri::command]
fn exit_desktop(app: AppHandle) {
    app.exit(0);
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
struct ModelOption {
    id: String,
    label: String,
}

struct ModelCatalogRequest {
    url: String,
    headers: Vec<(String, String)>,
}

struct ModelCatalogPage {
    models: Vec<ModelOption>,
    next_cursor: Option<String>,
    has_more: bool,
}

fn default_provider_base_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "anthropic" => Ok(ANTHROPIC_DEFAULT_BASE_URL),
        "google" => Ok(GOOGLE_DEFAULT_BASE_URL),
        _ => Err("该服务商必须填写 Base URL".to_string()),
    }
}

fn model_catalog_request(
    provider: &str,
    base_url: Option<&str>,
    api_key: &str,
    cursor: Option<&str>,
) -> Result<ModelCatalogRequest, String> {
    let default_base = if provider == "anthropic" || provider == "google" {
        Some(default_provider_base_url(provider)?)
    } else {
        None
    };
    let raw_base = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(default_base)
        .ok_or_else(|| "请填写当前服务商的 Base URL".to_string())?;
    validate_provider_base_url(raw_base)?;
    let mut url = url::Url::parse(raw_base).map_err(|_| "请填写合法的 Base URL".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Base URL 不能包含用户名、密码、查询参数或片段".to_string());
    }

    let path = url.path().trim_end_matches('/');
    let endpoint_path = match provider {
        "custom" | "anthropic" | "google" => format!("{path}/models"),
        _ => return Err("该服务商不支持动态模型目录".to_string()),
    };
    url.set_path(&endpoint_path);
    match provider {
        "anthropic" => {
            if let Some(cursor) = cursor {
                url.query_pairs_mut().append_pair("limit", "1000");
                url.query_pairs_mut().append_pair("after_id", cursor);
            }
        }
        "google" => {
            url.query_pairs_mut().append_pair("pageSize", "1000");
            if let Some(cursor) = cursor {
                url.query_pairs_mut().append_pair("pageToken", cursor);
            }
        }
        _ => {}
    }

    let mut headers = vec![("Accept".to_string(), "application/json".to_string())];
    match provider {
        "custom" => headers.push(("Authorization".to_string(), format!("Bearer {}", api_key))),
        "anthropic" => {
            headers.push(("x-api-key".to_string(), api_key.to_string()));
            headers.push(("anthropic-version".to_string(), "2023-06-01".to_string()));
        }
        "google" => headers.push(("x-goog-api-key".to_string(), api_key.to_string())),
        _ => return Err("该服务商不支持动态模型目录".to_string()),
    }
    Ok(ModelCatalogRequest {
        url: url.to_string(),
        headers,
    })
}

fn model_catalog_http_error(status: u16) -> String {
    match status {
        401 | 403 => {
            "API Key 无效或没有读取模型目录的权限，请检查密钥与服务商账户权限。".to_string()
        }
        404 => "服务商未提供对应协议的模型目录接口；请检查服务商类型和 Base URL。".to_string(),
        429 => "服务商正在限流，稍后再加载模型目录。".to_string(),
        500..=599 => "服务商暂时不可用，模型目录没有加载；现有配置未更改。".to_string(),
        _ => format!("读取模型目录失败，服务商返回 HTTP {status}。"),
    }
}

fn model_catalog_curl_error(code: Option<i32>) -> Option<&'static str> {
    match code {
        Some(28) => Some("连接模型服务超时，请检查网络后重试。"),
        Some(63) => Some("模型目录响应超过 2 MB 安全上限，已停止读取。"),
        _ => None,
    }
}

fn read_bounded_model_catalog_stdout(reader: impl Read) -> Result<Vec<u8>, String> {
    let max_bytes = (MAX_MODEL_CATALOG_RESPONSE_BYTES + 64) as u64;
    let mut output = Vec::with_capacity(max_bytes as usize);
    reader
        .take(max_bytes + 1)
        .read_to_end(&mut output)
        .map_err(|_| "读取模型目录响应失败，请重试。".to_string())?;
    if output.len() as u64 > max_bytes {
        return Err("模型目录响应过大，超过 2 MB 安全上限，已停止读取。".to_string());
    }
    Ok(output)
}

fn parse_provider_model_catalog_page(
    provider: &str,
    status: u16,
    body: &str,
) -> Result<ModelCatalogPage, String> {
    if !(200..300).contains(&status) {
        return Err(model_catalog_http_error(status));
    }
    if body.len() > MAX_MODEL_CATALOG_RESPONSE_BYTES {
        return Err("模型目录响应过大，已停止读取。".to_string());
    }
    let json: Value = serde_json::from_str(body)
        .map_err(|_| "模型目录格式无法识别；请检查服务商类型和 Base URL。".to_string())?;
    let mut models = Vec::new();
    let mut next_cursor = None;
    let mut has_more = false;
    let entries = match provider {
        "custom" | "anthropic" => json
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| "模型目录格式错误：响应中缺少 data 数组。".to_string())?,
        "google" => {
            next_cursor = json
                .get("nextPageToken")
                .and_then(Value::as_str)
                .map(str::to_string);
            json.get("models")
                .and_then(Value::as_array)
                .ok_or_else(|| "Gemini 模型目录格式错误：响应中缺少 models 数组。".to_string())?
        }
        _ => return Err("该服务商不支持动态模型目录".to_string()),
    };
    if provider == "anthropic" {
        has_more = json
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        next_cursor = json
            .get("last_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        if has_more && next_cursor.is_none() {
            return Err("Anthropic 模型目录缺少分页游标，无法完整导入模型。".to_string());
        }
    }
    for item in entries {
        let (raw_id, label) = if provider == "google" {
            let methods = item
                .get("supportedGenerationMethods")
                .and_then(Value::as_array);
            let supports_chat = methods.is_some_and(|methods| {
                methods
                    .iter()
                    .any(|method| method.as_str() == Some("generateContent"))
            });
            if !supports_chat {
                continue;
            }
            let raw_id = item.get("baseModelId").and_then(Value::as_str).or_else(|| {
                item.get("name")
                    .and_then(Value::as_str)
                    .map(|name| name.strip_prefix("models/").unwrap_or(name))
            });
            let label = item.get("displayName").and_then(Value::as_str);
            (raw_id, label)
        } else {
            (
                item.get("id").and_then(Value::as_str),
                item.get("display_name").and_then(Value::as_str),
            )
        };
        let Some(raw_id) = raw_id.map(str::trim).filter(|value| !value.is_empty()) else {
            continue;
        };
        let id = format!("{provider}/{raw_id}");
        if models.iter().any(|model: &ModelOption| model.id == id) {
            continue;
        }
        models.push(ModelOption {
            id,
            label: label
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(raw_id)
                .to_string(),
        });
    }
    if provider == "google" {
        has_more = next_cursor.is_some();
    }
    Ok(ModelCatalogPage {
        models,
        next_cursor,
        has_more,
    })
}

#[cfg(test)]
fn parse_provider_model_catalog(
    provider: &str,
    status: u16,
    body: &str,
) -> Result<Vec<ModelOption>, String> {
    let page = parse_provider_model_catalog_page(provider, status, body)?;
    if page.models.is_empty() {
        return Err(
            "该 API Key 没有返回可用于对话的模型。请检查服务商权限或模型目录。".to_string(),
        );
    }
    Ok(page.models)
}

fn request_provider_model_catalog_page(
    request: &ModelCatalogRequest,
) -> Result<(u16, String), String> {
    let header_path = std::env::temp_dir().join(format!("killstata-headers-{}", Uuid::new_v4()));
    let header_content = request
        .headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect::<Vec<_>>()
        .join("\n");
    let write_result = (|| {
        #[cfg(unix)]
        {
            use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&header_path)
                .map_err(|_| "无法创建临时凭据文件".to_string())?;
            file.write_all(header_content.as_bytes())
                .map_err(|_| "无法写入临时凭据文件".to_string())?;
        }
        #[cfg(not(unix))]
        std::fs::write(&header_path, header_content.as_bytes())
            .map_err(|_| "无法创建临时凭据文件".to_string())?;

        let mut child = Command::new("curl")
            .args([
                "-sS",
                "--max-time",
                MODEL_CATALOG_REQUEST_TIMEOUT_SECONDS,
                "--max-filesize",
                "2097152",
                "-H",
                &format!("@{}", header_path.display()),
                "-w",
                "\nKILLSTATA_HTTP_STATUS:%{http_code}",
                &request.url,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法连接模型服务，请检查网络和 Base URL。".to_string())?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("无法读取模型服务响应。".to_string());
        };
        let stdout = match read_bounded_model_catalog_stdout(stdout) {
            Ok(stdout) => stdout,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let exit_status = child
            .wait()
            .map_err(|_| "无法读取模型服务的请求状态。".to_string())?;
        if let Some(message) = model_catalog_curl_error(exit_status.code()) {
            return Err(message.to_string());
        }
        let stdout = String::from_utf8_lossy(&stdout).to_string();
        let (body, status) = stdout
            .rsplit_once("\nKILLSTATA_HTTP_STATUS:")
            .ok_or_else(|| "模型服务没有返回有效的 HTTP 响应。".to_string())?;
        let http_status = status
            .parse::<u16>()
            .map_err(|_| "模型服务返回了无效的 HTTP 状态。".to_string())?;
        if !exit_status.success() && body.trim().is_empty() {
            return Err("无法连接模型服务，请检查网络和 Base URL。".to_string());
        }
        Ok((http_status, body.to_string()))
    })();
    let _ = std::fs::remove_file(&header_path);
    write_result
}

fn query_provider_model_catalog(
    provider: &str,
    base_url: Option<&str>,
    api_key: &str,
) -> Result<Vec<ModelOption>, String> {
    let mut options = Vec::new();
    let mut cursor: Option<String> = None;
    for page_number in 0..MAX_MODEL_CATALOG_PAGES {
        let request = model_catalog_request(provider, base_url, api_key, cursor.as_deref())?;
        let (status, body) = request_provider_model_catalog_page(&request)?;
        let page = parse_provider_model_catalog_page(provider, status, &body)?;
        for model in page.models {
            if !options
                .iter()
                .any(|existing: &ModelOption| existing.id == model.id)
            {
                options.push(model);
            }
        }
        if options.len() > MAX_MODEL_CATALOG_ITEMS {
            return Err(
                "服务商返回的模型过多，超过安全上限；请限制 API Key 可见的模型。".to_string(),
            );
        }
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
        if cursor.is_none() || page_number + 1 == MAX_MODEL_CATALOG_PAGES {
            return Err(
                "模型目录分页超过安全上限，未能完整导入；请联系服务商或限制可见模型。".to_string(),
            );
        }
    }
    if options.is_empty() {
        return Err(
            "该 API Key 没有返回可用于对话的模型。请检查服务商权限或模型目录。".to_string(),
        );
    }
    Ok(options)
}

#[tauri::command]
async fn list_provider_models() -> Result<Vec<ModelOption>, String> {
    let (stored, profile_id) = bounded_keychain_operation(
        || {
            let store = configured_provider_profiles()?;
            let profile_id = store
                .as_ref()
                .and_then(|store| store.default_profile_id.clone());
            let stored = store
                .as_ref()
                .and_then(|store| {
                    default_api_key_for_store(store).map(|api_key| {
                        (
                            default_provider_config_for_store(store),
                            api_key.to_string(),
                        )
                    })
                })
                .map(|(config, api_key)| StoredProviderSettings { config, api_key });
            Ok((stored, profile_id))
        },
        "读取模型配置超时，请解锁钥匙串或重新保存模型配置",
    )
    .await?;
    let Some(stored) = stored else {
        return Err("请先配置模型提供商与 API Key".to_string());
    };
    discover_provider_models(
        stored.config.provider,
        stored.config.base_url,
        Some(stored.api_key),
        profile_id,
    )
    .await
}

#[tauri::command]
async fn list_provider_profiles() -> Result<ProviderProfilesSnapshot, String> {
    let store = bounded_keychain_operation(
        || configured_provider_profiles(),
        "读取模型档案超时，请解锁钥匙串后重试",
    )
    .await?;
    Ok(provider_profiles_snapshot(
        &store.unwrap_or_else(empty_provider_profiles),
    ))
}

#[tauri::command]
async fn discover_provider_models(
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
    profile_id: Option<String>,
) -> Result<Vec<ModelOption>, String> {
    let provider = provider.trim().to_lowercase();
    if provider == "deepseek" {
        return Ok(vec![
            ModelOption {
                id: "deepseek/deepseek-v4-flash".to_string(),
                label: "DeepSeek V4 Flash（默认）".to_string(),
            },
            ModelOption {
                id: "deepseek/deepseek-v4-pro".to_string(),
                label: "DeepSeek V4 Pro".to_string(),
            },
        ]);
    }
    let api_key = match api_key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(api_key) => api_key,
        None => {
            let provider_for_lookup = provider.clone();
            let base_url_for_lookup = base_url.clone();
            let stored = bounded_keychain_operation(
                move || {
                    let profiles =
                        configured_provider_profiles()?.unwrap_or_else(empty_provider_profiles);
                    let profile = profile_for_model_discovery(
                        &profiles,
                        profile_id.as_deref(),
                        &provider_for_lookup,
                    );
                    let Some(profile) = profile else {
                        return Ok(None);
                    };
                    profile_model_discovery_endpoint_matches(
                        profile,
                        base_url_for_lookup.as_deref(),
                    )?;
                    Ok(profile
                        .api_key
                        .clone()
                        .map(|api_key| StoredProviderSettings {
                            config: profile.config.clone(),
                            api_key,
                        }))
                },
                "读取模型配置超时，请解锁钥匙串或重新保存模型配置",
            )
            .await?;
            let Some(stored) = stored else {
                return Err("请输入该服务商的 API Key，再读取模型目录。".to_string());
            };
            return query_provider_models_blocking(
                provider,
                base_url.or(stored.config.base_url),
                stored.api_key,
            )
            .await;
        }
    };
    query_provider_models_blocking(provider, base_url, api_key).await
}

#[tauri::command]
async fn save_provider_profile(
    config: ProviderConfig,
    profile_id: Option<String>,
    create_if_missing: bool,
    api_key: Option<String>,
    make_default: bool,
    display_name: Option<String>,
) -> Result<ProviderProfileMutation, String> {
    let config = normalize_provider_config(config)?;
    bounded_profile_mutation(
        move |store| {
            let (profile_id, active_changed) = upsert_provider_profile_named(
                store,
                profile_id.as_deref(),
                create_if_missing,
                config,
                api_key,
                make_default,
                display_name,
            )?;
            Ok((
                ProviderProfileMutation {
                    profile_id,
                    snapshot: provider_profiles_snapshot(&store),
                    active_changed,
                },
                true,
            ))
        },
        "写入模型档案超时，请解锁钥匙串后重试",
    )
    .await
}

#[tauri::command]
async fn set_default_provider_profile(
    profile_id: Option<String>,
) -> Result<ProviderProfileMutation, String> {
    bounded_profile_mutation(
        move |store| {
            let active_changed = set_default_profile_in_store(store, profile_id.as_deref())?;
            Ok((
                ProviderProfileMutation {
                    profile_id: store.default_profile_id.clone().unwrap_or_default(),
                    snapshot: provider_profiles_snapshot(&store),
                    active_changed,
                },
                active_changed,
            ))
        },
        "切换默认模型超时，请解锁钥匙串后重试",
    )
    .await
}

#[tauri::command]
async fn delete_provider_profile(profile_id: String) -> Result<ProviderProfileMutation, String> {
    bounded_profile_mutation(
        move |store| {
            let active_changed = delete_profile_from_store(store, &profile_id)?;
            Ok((
                ProviderProfileMutation {
                    profile_id,
                    snapshot: provider_profiles_snapshot(&store),
                    active_changed,
                },
                true,
            ))
        },
        "移除模型档案超时，请解锁钥匙串后重试",
    )
    .await
}

async fn query_provider_models_blocking(
    provider: String,
    base_url: Option<String>,
    api_key: String,
) -> Result<Vec<ModelOption>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        query_provider_model_catalog(&provider, base_url.as_deref(), &api_key)
    })
    .await
    .map_err(|_| "读取模型目录的后台任务失败，请重试。".to_string())?
}

#[tauri::command]
async fn credential_status() -> Result<CredentialStatus, String> {
    bounded_keychain_operation(
        || {
            if let Some(store) = configured_provider_profiles()? {
                if let Some(profile_id) = store.default_profile_id.as_ref() {
                    let profile = store
                        .profiles
                        .iter()
                        .find(|profile| &profile.id == profile_id)
                        .ok_or("默认模型档案不存在；已阻止加载不一致配置。".to_string())?;
                    return Ok(CredentialStatus {
                        configured: profile.api_key.is_some(),
                        profile_id: Some(profile.id.clone()),
                        provider: profile.config.provider.clone(),
                        model: profile.config.model.clone(),
                        base_url: profile.config.base_url.clone(),
                        small_model: profile.config.small_model.clone(),
                    });
                }
                let config = default_provider_config();
                return Ok(CredentialStatus {
                    configured: false,
                    profile_id: None,
                    provider: config.provider,
                    model: config.model,
                    base_url: None,
                    small_model: None,
                });
            }
            let config = configured_provider_config_legacy()?;
            let configured = configured_api_key_for_legacy(&config.provider)?.is_some();
            Ok(CredentialStatus {
                configured,
                profile_id: None,
                provider: config.provider,
                model: config.model,
                base_url: config.base_url,
                small_model: config.small_model,
            })
        },
        "读取模型档案超时，请解锁钥匙串或重新保存模型配置",
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSelectionRequest {
    id: String,
}

#[tauri::command]
fn activate_workspace(
    selection: State<'_, WorkspaceSelection>,
    request: WorkspaceSelectionRequest,
) -> Result<(), String> {
    if request.id.is_empty() || request.id.len() > 128 || !request.id.starts_with("workspace-") {
        return Err("本地工作区标识无效".to_string());
    }
    let directory = selection
        .directory
        .lock()
        .map_err(|_| "本地工作区状态不可用".to_string())?;
    match directory.as_ref() {
        Some((id, _)) if id == &request.id => Ok(()),
        Some(_) => Err("当前工作区尚未在本应用中重新选择，不能读取其中的文件".to_string()),
        None => Err("请先在当前应用中选择本地工作区".to_string()),
    }
}

fn workspace_history_enabled_at(directory: &Path) -> Result<bool, String> {
    let path = directory.join(WORKSPACE_HISTORY_ENABLED_FILENAME);
    Ok(fs::read_to_string(path)
        .map(|value| value.trim() == "true")
        .unwrap_or(false))
}

fn set_workspace_history_enabled_at(directory: &Path, enabled: bool) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|_| "无法创建应用数据目录".to_string())?;
    let preference = directory.join(WORKSPACE_HISTORY_ENABLED_FILENAME);
    write_private_file(&preference, if enabled { b"true" } else { b"false" })
        .map_err(|_| "无法保存历史设置".to_string())?;
    if !enabled {
        let _ = fs::remove_file(directory.join(WORKSPACE_SNAPSHOT_FILENAME));
    }
    Ok(())
}

fn clear_workspace_snapshot_at(directory: &Path) -> Result<(), String> {
    match fs::remove_file(directory.join(WORKSPACE_SNAPSHOT_FILENAME)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法清除研究历史".to_string()),
    }
}

fn load_workspace_snapshot_at(directory: &Path) -> Result<Option<String>, String> {
    if !workspace_history_enabled_at(directory)? {
        return Ok(None);
    }
    let path = directory.join(WORKSPACE_SNAPSHOT_FILENAME);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取研究历史".to_string()),
    };
    if metadata.len() > MAXIMUM_WORKSPACE_SNAPSHOT_BYTES {
        return Err("研究历史超过本地保存上限".to_string());
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|_| "无法读取研究历史".to_string())
}

fn save_workspace_snapshot_at(directory: &Path, snapshot: String) -> Result<(), String> {
    if !workspace_history_enabled_at(directory)? {
        return Ok(());
    }
    if snapshot.as_bytes().len() as u64 > MAXIMUM_WORKSPACE_SNAPSHOT_BYTES {
        return Err("研究历史超过本地保存上限".to_string());
    }
    fs::create_dir_all(directory).map_err(|_| "无法创建应用数据目录".to_string())?;
    let temporary = directory.join(format!(
        "{WORKSPACE_SNAPSHOT_FILENAME}.tmp-{}",
        Uuid::new_v4()
    ));
    let target = directory.join(WORKSPACE_SNAPSHOT_FILENAME);
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    use std::{fs::OpenOptions, io::Write};
    let mut file_options = OpenOptions::new();
    file_options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    file_options.mode(0o600);
    let mut file = file_options
        .open(&temporary)
        .map_err(|_| "无法保存研究历史".to_string())?;
    file.write_all(snapshot.as_bytes())
        .map_err(|_| "无法保存研究历史".to_string())?;
    drop(file);
    fs::rename(temporary, target).map_err(|_| "无法替换研究历史".to_string())
}

fn workspace_history_enabled(app: &AppHandle) -> Result<bool, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录".to_string())?;
    workspace_history_enabled_at(&directory)
}

#[tauri::command]
fn workspace_history_enabled_command(app: AppHandle) -> Result<bool, String> {
    workspace_history_enabled(&app)
}
#[tauri::command]
fn set_workspace_history_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录".to_string())?;
    set_workspace_history_enabled_at(&directory, enabled)
}

#[tauri::command]
fn clear_workspace_snapshot(app: AppHandle) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录".to_string())?;
    clear_workspace_snapshot_at(&directory)
}
#[tauri::command]
fn load_workspace_snapshot(app: AppHandle) -> Result<Option<String>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录".to_string())?;
    load_workspace_snapshot_at(&directory)
}

#[tauri::command]
fn save_workspace_snapshot(app: AppHandle, snapshot: String) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录".to_string())?;
    save_workspace_snapshot_at(&directory, snapshot)
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiPreferencesSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
}

#[derive(Serialize)]
struct UiPreferenceSaveResult {
    saved: bool,
}

fn ui_preference_filename(key: &str) -> Result<&'static str, String> {
    match key {
        "theme" => Ok("theme"),
        "reasoningEffort" => Ok("reasoning-effort"),
        "permissionMode" => Ok("permission-mode"),
        _ => Err("不支持此共享界面偏好".to_string()),
    }
}

fn validate_ui_preference(key: &str, value: &str) -> Result<(), String> {
    let valid = match key {
        "theme" => matches!(value, "system" | "light" | "dark"),
        "reasoningEffort" => matches!(value, "default" | "low" | "medium" | "high"),
        "permissionMode" => matches!(value, "read_only" | "workspace_write" | "full_access"),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("界面偏好键或值无效".to_string())
    }
}

fn read_ui_preference_from(directory: &Path, key: &str) -> Result<Option<String>, String> {
    let path = directory.join(ui_preference_filename(key)?);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取界面偏好".to_string()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 {
        return Err("界面偏好文件无效".to_string());
    }
    let value = fs::read_to_string(path)
        .map_err(|_| "无法读取界面偏好".to_string())?
        .trim()
        .to_string();
    validate_ui_preference(key, &value)?;
    Ok(Some(value))
}

fn load_ui_preferences_from(directory: &Path) -> Result<UiPreferencesSnapshot, String> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err("界面偏好目录无效".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(UiPreferencesSnapshot::default())
        }
        Err(_) => return Err("无法读取界面偏好".to_string()),
    }
    Ok(UiPreferencesSnapshot {
        theme: read_ui_preference_from(directory, "theme")?,
        reasoning_effort: read_ui_preference_from(directory, "reasoningEffort")?,
        permission_mode: read_ui_preference_from(directory, "permissionMode")?,
    })
}

fn save_ui_preference_to(
    directory: &Path,
    key: &str,
    value: &str,
    only_if_absent: bool,
) -> Result<bool, String> {
    let filename = ui_preference_filename(key)?;
    validate_ui_preference(key, value)?;
    fs::create_dir_all(directory).map_err(|_| "无法创建界面偏好目录".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护界面偏好目录".to_string())?;
    }
    let metadata = fs::symlink_metadata(directory).map_err(|_| "界面偏好目录无效".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("界面偏好目录无效".to_string());
    }
    let target = directory.join(filename);
    if only_if_absent {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(target) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
            Err(_) => return Err("无法保存界面偏好".to_string()),
        };
        file.write_all(value.as_bytes())
            .map_err(|_| "无法保存界面偏好".to_string())?;
        file.sync_all()
            .map_err(|_| "无法保存界面偏好".to_string())?;
        return Ok(true);
    }

    use std::io::Write;
    let temporary = directory.join(format!(".{filename}.tmp-{}", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|_| "无法保存界面偏好".to_string())?;
        file.write_all(value.as_bytes())
            .map_err(|_| "无法保存界面偏好".to_string())?;
        file.sync_all().map_err(|_| "无法保存界面偏好".to_string())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, &target).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        "无法替换界面偏好".to_string()
    })?;
    Ok(true)
}

fn ensure_ui_preferences_home_root(directory: &Path, create: bool) -> Result<bool, String> {
    let root = directory.parent().ok_or("界面偏好目录无效")?;
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(root) {
                Ok(()) => fs::symlink_metadata(root)
                    .map_err(|_| "无法创建共享界面偏好目录".to_string())?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    fs::symlink_metadata(root)
                        .map_err(|_| "无法读取共享界面偏好目录".to_string())?
                }
                Err(_) => return Err("无法创建共享界面偏好目录".to_string()),
            }
        }
        Err(_) => return Err("无法读取共享界面偏好目录".to_string()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("共享界面偏好根目录无效".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护共享界面偏好目录".to_string())?;
    }
    Ok(true)
}

fn ui_preferences_directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .home_dir()
        .map_err(|_| "无法定位用户目录".to_string())?
        .join(".killstata")
        .join("ui-preferences"))
}

#[tauri::command]
fn load_ui_preferences(app: AppHandle) -> Result<UiPreferencesSnapshot, String> {
    let directory = ui_preferences_directory(&app)?;
    if !ensure_ui_preferences_home_root(&directory, false)? {
        return Ok(UiPreferencesSnapshot::default());
    }
    load_ui_preferences_from(&directory)
}

#[tauri::command]
fn save_ui_preference(
    app: AppHandle,
    key: String,
    value: String,
    only_if_absent: bool,
) -> Result<UiPreferenceSaveResult, String> {
    let directory = ui_preferences_directory(&app)?;
    ensure_ui_preferences_home_root(&directory, true)?;
    let saved = save_ui_preference_to(&directory, &key, &value, only_if_absent)?;
    Ok(UiPreferenceSaveResult { saved })
}

/// 只请求用户选中的目录并把 canonical 路径留在原生内存中；UI 只收到 ID 与名称。
#[tauri::command]
async fn select_workspace_directory(
    selection: State<'_, WorkspaceSelection>,
) -> Result<Option<WorkspaceDescriptor>, String> {
    let selected = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择 KillStata 本地工作区")
            .pick_folder()
    })
    .await
    .map_err(|error| format!("无法打开本地目录选择器：{error}"))?;
    let Some(path) = selected else {
        return Ok(None);
    };
    let canonical = path
        .canonicalize()
        .map_err(|_| "无法使用所选本地工作区".to_string())?;
    let descriptor = workspace_descriptor(&canonical)?;
    *selection
        .directory
        .lock()
        .map_err(|_| "本地工作区状态不可用".to_string())? =
        Some((descriptor.id.clone(), canonical));
    Ok(Some(descriptor))
}

#[tauri::command]
async fn select_workspace_file(
    selection: State<'_, WorkspaceSelection>,
) -> Result<Response, String> {
    let directory = selection
        .directory
        .lock()
        .map_err(|_| "本地工作区状态不可用".to_string())?
        .clone()
        .ok_or("请先选择本地工作区")?
        .1;
    let current_workspace = directory
        .canonicalize()
        .map_err(|_| "当前本地工作区已不可用，请重新选择".to_string())?;
    if current_workspace != directory {
        return Err("当前本地工作区已发生变化，请重新选择".to_string());
    }
    let selected = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("从当前工作区选择数据文件")
            .set_directory(directory)
            .add_filter("数据文件", &["csv", "xlsx", "xls", "dta", "parquet"])
            .pick_file()
    })
    .await
    .map_err(|error| format!("无法打开工作区文件选择器：{error}"))?;
    let Some(path) = selected else {
        return Ok(Response::new(b"{\"name\":null,\"bytes\":0}\n".to_vec()));
    };
    let workspace = selection
        .directory
        .lock()
        .map_err(|_| "本地工作区状态不可用".to_string())?
        .clone()
        .ok_or("请先选择本地工作区")?
        .1;
    let current_workspace = workspace
        .canonicalize()
        .map_err(|_| "当前本地工作区已不可用，请重新选择".to_string())?;
    if current_workspace != workspace {
        return Err("当前本地工作区已发生变化，请重新选择".to_string());
    }
    let candidate = path.canonicalize().map_err(|_| "无法读取所选数据文件")?;
    if !workspace_contains_file(&workspace, &candidate) {
        return Err("请选择当前工作区中的数据文件".to_string());
    }
    let name = safe_workspace_filename(&candidate)?;
    let bytes = read_selected_workspace_file(&workspace, &candidate)?;
    let metadata = serde_json::to_vec(&WorkspaceFileMetadata {
        name: Some(name),
        bytes: bytes.len() as u64,
    })
    .map_err(|_| "无法生成所选数据文件元数据".to_string())?;
    let mut response = metadata;
    response.push(b'\n');
    response.extend(bytes);
    Ok(Response::new(response))
}

/// 二进制响应用换行分隔元数据与文件内容，因此文件名必须先排除换行与控制字符；
/// 同时限制长度，避免异常长的名称撑坏前端的定长解析与后续上传。
fn safe_workspace_filename(candidate: &Path) -> Result<String, String> {
    let name = candidate
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("无法读取所选数据文件名称")?;
    if name.len() > 255 || name.chars().any(char::is_control) {
        return Err("所选数据文件名称无效".to_string());
    }
    Ok(name.to_string())
}

fn contains_eager_engine_test_argument(mut arguments: impl Iterator<Item = String>) -> bool {
    arguments.any(|argument| argument == "--killstata-eager-engine-test")
}

fn main() {
    let startup_arguments = std::env::args().collect::<Vec<_>>();
    let eager_engine_test = contains_eager_engine_test_argument(startup_arguments.into_iter());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(EngineSupervisor::new())
        .manage(WorkspaceSelection::new())
        .invoke_handler(tauri::generate_handler![
            core_connection,
            activate_core_credentials,
            credential_status,
            list_provider_models,
            list_provider_profiles,
            discover_provider_models,
            save_provider_profile,
            set_default_provider_profile,
            delete_provider_profile,
            refresh_core_credentials,
            activate_workspace,
            load_workspace_snapshot,
            save_workspace_snapshot,
            set_workspace_history_enabled,
            workspace_history_enabled_command,
            clear_workspace_snapshot,
            load_ui_preferences,
            save_ui_preference,
            select_workspace_directory,
            select_workspace_file,
            exit_desktop,
        ])
        .build(tauri::generate_context!())
        .expect("创建 KillStata Desktop 失败");

    // 同一 Debug 二进制绝不能以正式 Bundle ID 启动，否则窗口绑定和应用数据隔离失效。
    let expected_identifier = if cfg!(debug_assertions) {
        "com.killstata.desktop.dev"
    } else {
        "com.killstata.desktop"
    };
    assert_eq!(
        app.config().identifier,
        expected_identifier,
        "Desktop 构建身份与运行配置不一致"
    );

    // 生命周期验收不能依赖窗口 Ready：无窗口的 LaunchServices 环境可能永远不发出该事件。
    // 正常用户不会带测试参数，仍按需从 Keychain 读取凭据并启动引擎。
    if eager_engine_test {
        let handle = app.handle();
        app.state::<EngineSupervisor>()
            .connection_without_credentials(&handle)
            .expect("启动生命周期验收 sidecar 失败");
    }

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit { .. }) {
            app.state::<EngineSupervisor>().stop()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::future::Future;

    fn workspace_history_test_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("killstata-history-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("history test directory should be created");
        path
    }

    #[test]
    fn workspace_history_storage_is_opt_in_and_disable_clears_the_snapshot() {
        let directory = workspace_history_test_directory();
        assert!(!workspace_history_enabled_at(&directory).unwrap());
        assert!(load_workspace_snapshot_at(&directory).unwrap().is_none());

        save_workspace_snapshot_at(&directory, "must-not-be-written".to_string()).unwrap();
        assert!(!directory.join(WORKSPACE_SNAPSHOT_FILENAME).exists());

        set_workspace_history_enabled_at(&directory, true).unwrap();
        assert!(workspace_history_enabled_at(&directory).unwrap());
        let snapshot = r#"{"version":1,"workspaces":[]}"#.to_string();
        save_workspace_snapshot_at(&directory, snapshot.clone()).unwrap();
        assert_eq!(
            load_workspace_snapshot_at(&directory).unwrap(),
            Some(snapshot)
        );

        clear_workspace_snapshot_at(&directory).unwrap();
        clear_workspace_snapshot_at(&directory).unwrap();
        set_workspace_history_enabled_at(&directory, false).unwrap();
        assert!(!workspace_history_enabled_at(&directory).unwrap());
        assert!(load_workspace_snapshot_at(&directory).unwrap().is_none());
        assert!(!directory.join(WORKSPACE_SNAPSHOT_FILENAME).exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn workspace_history_storage_rejects_snapshots_above_the_size_limit() {
        let directory = workspace_history_test_directory();
        set_workspace_history_enabled_at(&directory, true).unwrap();
        let oversized = "x".repeat(MAXIMUM_WORKSPACE_SNAPSHOT_BYTES as usize + 1);

        assert_eq!(
            save_workspace_snapshot_at(&directory, oversized).unwrap_err(),
            "研究历史超过本地保存上限"
        );
        assert!(load_workspace_snapshot_at(&directory).unwrap().is_none());
        let _ = fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_history_snapshot_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let directory = workspace_history_test_directory();
        set_workspace_history_enabled_at(&directory, true).unwrap();
        save_workspace_snapshot_at(&directory, "{}".to_string()).unwrap();
        let mode = fs::metadata(directory.join(WORKSPACE_SNAPSHOT_FILENAME))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(directory);
    }

    fn assert_credential_status_is_async<F>(_future: F)
    where
        F: Future<Output = Result<CredentialStatus, String>>,
    {
    }

    #[test]
    fn reads_credential_status_off_the_tauri_event_loop() {
        assert_credential_status_is_async(credential_status());
    }

    #[test]
    fn shared_ui_preferences_accept_only_fixed_theme_reasoning_and_permission_modes() {
        let root =
            std::env::temp_dir().join(format!("killstata-ui-preferences-{}", Uuid::new_v4()));
        let theme_saved = save_ui_preference_to(&root, "theme", "dark", false).unwrap();
        let effort_saved = save_ui_preference_to(&root, "reasoningEffort", "high", false).unwrap();
        for permission_mode in ["read_only", "workspace_write", "full_access"] {
            assert!(
                save_ui_preference_to(&root, "permissionMode", permission_mode, false).unwrap()
            );
            let snapshot = load_ui_preferences_from(&root).unwrap();
            assert_eq!(
                serde_json::to_value(snapshot).unwrap()["permissionMode"],
                permission_mode
            );
        }

        let snapshot = load_ui_preferences_from(&root).unwrap();
        assert!(theme_saved && effort_saved);
        assert_eq!(snapshot.theme.as_deref(), Some("dark"));
        assert_eq!(snapshot.reasoning_effort.as_deref(), Some("high"));
        assert!(
            save_ui_preference_to(&root, "reasoningEffort", "default", true)
                .is_ok_and(|saved| !saved)
        );
        assert!(save_ui_preference_to(&root, "permissionMode", "admin", false).is_err());
        assert!(save_ui_preference_to(&root, "theme", "contrast", false).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_shared_preferences_serialize_as_an_empty_snapshot() {
        let root =
            std::env::temp_dir().join(format!("killstata-ui-preferences-empty-{}", Uuid::new_v4()));
        let snapshot = load_ui_preferences_from(&root).unwrap();
        assert_eq!(serde_json::to_value(snapshot).unwrap(), json!({}));
    }

    #[cfg(unix)]
    #[test]
    fn shared_ui_preferences_reject_a_symlinked_killstata_home() {
        let root = std::env::temp_dir().join(format!(
            "killstata-ui-preferences-home-link-{}",
            Uuid::new_v4()
        ));
        let external = root.join("external");
        let home = root.join("home");
        fs::create_dir_all(&external).unwrap();
        fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&external, home.join(".killstata")).unwrap();
        let directory = home.join(".killstata").join("ui-preferences");

        assert!(ensure_ui_preferences_home_root(&directory, true).is_err());
        assert_eq!(fs::read_dir(&external).unwrap().count(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn shared_ui_preferences_use_private_directory_and_file_modes() {
        use std::os::unix::fs::PermissionsExt;

        let root =
            std::env::temp_dir().join(format!("killstata-ui-preferences-mode-{}", Uuid::new_v4()));
        save_ui_preference_to(&root, "theme", "light", false).unwrap();
        save_ui_preference_to(&root, "permissionMode", "full_access", false).unwrap();
        let directory_mode = fs::metadata(&root).unwrap().permissions().mode() & 0o777;
        let file_mode = fs::metadata(root.join("theme"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let permission_file_mode = fs::metadata(root.join("permission-mode"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(directory_mode, 0o700);
        assert_eq!(file_mode, 0o600);
        assert_eq!(permission_file_mode, 0o600);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolves_bun_for_gui_launches_without_a_shell_path() {
        let resolved = resolve_bun_executable_from(
            None,
            None,
            Some(std::ffi::OsStr::new("/Users/researcher")),
            |path| path == Path::new("/Users/researcher/.bun/bin/bun"),
        );
        assert_eq!(resolved, PathBuf::from("/Users/researcher/.bun/bin/bun"));
    }

    #[test]
    fn recognizes_a_listening_loopback_port() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let port = listener
            .local_addr()
            .expect("test listener should have an address")
            .port();

        assert!(wait_for_listener(port, Duration::from_secs(1)));
    }

    #[test]
    fn waits_beyond_the_previous_twenty_listener_checks() {
        let mut checks = 0;
        let ready = wait_for_listener_with(Duration::from_secs(5), Duration::ZERO, || {
            checks += 1;
            checks > 20
        });

        assert!(ready);
        assert_eq!(checks, 21);
    }

    #[test]
    fn rejects_blank_api_keys_before_writing_to_the_system_credential_store() {
        assert!(normalize_api_key("   ").is_err());
        assert_eq!(
            normalize_api_key("sk-test-key").expect("a non-empty key should be accepted"),
            "sk-test-key"
        );
    }

    #[test]
    #[ignore = "requires interactive macOS Keychain authorization in a signed app"]
    fn can_check_the_system_credential_store_without_creating_a_secret() {
        assert!(configured_api_key().is_ok());
    }

    #[test]
    fn detects_the_lifecycle_test_argument_without_enabling_it_for_normal_launches() {
        assert!(contains_eager_engine_test_argument(
            [
                "killstata-desktop".to_string(),
                "--killstata-eager-engine-test".to_string(),
            ]
            .into_iter()
        ));
        assert!(!contains_eager_engine_test_argument(
            ["killstata-desktop".to_string()].into_iter()
        ));
    }

    #[test]
    fn debug_and_release_keyring_services_are_isolated() {
        assert_eq!(
            keyring_service_for("com.killstata.desktop"),
            "KillStata Desktop"
        );
        assert_eq!(
            keyring_service_for("com.killstata.desktop.dev"),
            "KillStata Desktop Dev"
        );
    }

    #[test]
    fn provider_settings_use_a_recoverable_keychain_account_version() {
        assert_eq!(PROVIDER_SETTINGS_KEYRING_ACCOUNT, "provider-settings-v4");
        assert_eq!(
            LEGACY_PROVIDER_SETTINGS_KEYRING_ACCOUNT,
            "provider-settings-v3"
        );
    }

    #[test]
    fn provider_profile_store_supports_multiple_endpoints_and_defaults() {
        let mut store = empty_provider_profiles();
        let (first_id, first_changed) = upsert_provider_profile(
            &mut store,
            None,
            true,
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/one".into(),
                base_url: Some("https://one.example/v1".into()),
                small_model: None,
            },
            Some("key-one".into()),
            false,
        )
        .expect("first profile should save");
        assert!(
            !first_changed,
            "adding a non-default profile does not restart the current Core"
        );

        let (second_id, second_changed) = upsert_provider_profile(
            &mut store,
            None,
            true,
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/two".into(),
                base_url: Some("https://two.example/v1".into()),
                small_model: None,
            },
            Some("key-two".into()),
            false,
        )
        .expect("same provider can have another independent endpoint");
        assert!(!second_changed);
        assert_eq!(store.profiles.len(), 2);
        assert_ne!(store.profiles[0].api_key, store.profiles[1].api_key);

        assert!(set_default_profile_in_store(&mut store, Some(&second_id))
            .expect("default should change"));
        assert_eq!(
            store.default_profile_id.as_deref(),
            Some(second_id.as_str())
        );
        assert!(!set_default_profile_in_store(&mut store, Some(&second_id))
            .expect("same default is a no-op"));
        assert!(delete_profile_from_store(&mut store, &second_id)
            .expect("default profile should delete"));
        assert_eq!(store.default_profile_id.as_deref(), Some(first_id.as_str()));

        let default_before_edit = store.default_profile_id.clone();
        let (first_id_after_edit, active_changed) = upsert_provider_profile(
            &mut store,
            Some(&first_id),
            false,
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/updated".into(),
                base_url: Some("https://one.example/v1".into()),
                small_model: None,
            },
            None,
            false,
        )
        .expect("blank API Key while editing should preserve the profile's existing key");
        assert_eq!(first_id_after_edit, first_id);
        assert!(active_changed);
        assert!(
            store.default_profile_id.is_none(),
            "unchecking default restores implicit DeepSeek"
        );
        assert_ne!(default_before_edit, store.default_profile_id);
        assert_eq!(store.profiles[0].api_key.as_deref(), Some("key-one"));
    }

    #[test]
    fn provider_model_discovery_reuses_only_the_requested_profile_key() {
        let mut store = empty_provider_profiles();
        let (first, _) = upsert_provider_profile(
            &mut store,
            None,
            true,
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/one".into(),
                base_url: Some("https://one.example/v1".into()),
                small_model: None,
            },
            Some("key-one".into()),
            true,
        )
        .expect("first custom profile should save");
        let (second, _) = upsert_provider_profile(
            &mut store,
            None,
            true,
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/two".into(),
                base_url: Some("https://two.example/v1".into()),
                small_model: None,
            },
            Some("key-two".into()),
            false,
        )
        .expect("second custom profile should save");

        assert_eq!(
            profile_for_model_discovery(&store, Some(&second), "custom")
                .and_then(|profile| profile.api_key.as_deref()),
            Some("key-two")
        );
        assert!(profile_for_model_discovery(&store, Some("missing"), "custom").is_none());
        assert!(profile_for_model_discovery(&store, Some(&first), "anthropic").is_none());
        assert_eq!(
            profile_for_model_discovery(&store, None, "custom").map(|profile| profile.id.as_str()),
            Some(first.as_str())
        );
        let profile = profile_for_model_discovery(&store, Some(&first), "custom")
            .expect("saved configured profile should resolve");
        assert!(profile_model_discovery_endpoint_matches(
            profile,
            Some("https://different.example/v1")
        )
        .is_err());
        assert!(
            profile_model_discovery_endpoint_matches(profile, Some("https://one.example/v1/"))
                .is_ok()
        );
    }

    #[test]
    fn provider_profile_v3_migration_preserves_the_old_profile_and_key() {
        let legacy = StoredProviderSettings {
            config: ProviderConfig {
                provider: "anthropic".into(),
                model: "anthropic/claude-test".into(),
                base_url: Some("https://api.anthropic.com/v1".into()),
                small_model: None,
            },
            api_key: "legacy-secret".into(),
        };
        let migrated = migrate_v3_provider_settings(legacy, "migrated-profile")
            .expect("v3 settings should migrate");
        assert_eq!(
            migrated.default_profile_id.as_deref(),
            Some("migrated-profile")
        );
        assert_eq!(
            migrated.profiles[0].api_key.as_deref(),
            Some("legacy-secret")
        );
        assert_eq!(migrated.profiles[0].config.model, "anthropic/claude-test");
    }

    #[test]
    fn legacy_configuration_without_a_key_is_preserved_as_an_unconfigured_profile() {
        let migrated = migrate_legacy_provider_config(
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/old-model".into(),
                base_url: Some("https://old.example/v1".into()),
                small_model: None,
            },
            None,
            "pending-key-profile",
        )
        .expect("configuration without a key should be preserved");
        assert!(migrated.default_profile_id.is_none());
        assert_eq!(migrated.profiles[0].config.model, "custom/old-model");
        assert!(migrated.profiles[0].api_key.is_none());
        assert!(!provider_profiles_snapshot(&migrated).profiles[0].configured);
        let mut without_default = migrated.clone();
        set_default_profile_in_store(&mut without_default, None)
            .expect("implicit default should be selectable");
        assert!(
            set_default_profile_in_store(&mut without_default, Some("pending-key-profile"))
                .is_err()
        );
        let pending_config = without_default.profiles[0].config.clone();
        assert!(upsert_provider_profile(
            &mut without_default,
            Some("pending-key-profile"),
            false,
            pending_config,
            None,
            true,
        )
        .is_err());
    }

    #[test]
    fn clean_install_without_legacy_configuration_or_key_does_not_create_a_profile() {
        assert!(
            migrate_optional_legacy_provider_config(None, None, MIGRATED_LEGACY_PROFILE_ID)
                .expect("clean install migration should succeed")
                .is_none()
        );
    }

    #[test]
    fn legacy_deepseek_key_without_saved_config_migrates_as_the_default_profile() {
        let migrated = migrate_optional_legacy_provider_config(
            None,
            Some("legacy-deepseek-key".into()),
            MIGRATED_LEGACY_PROFILE_ID,
        )
        .expect("legacy DeepSeek key should migrate")
        .expect("configured legacy key should create a profile");
        assert_eq!(
            migrated.default_profile_id.as_deref(),
            Some(MIGRATED_LEGACY_PROFILE_ID)
        );
        assert_eq!(migrated.profiles[0].config.provider, "deepseek");
        assert_eq!(
            migrated.profiles[0].api_key.as_deref(),
            Some("legacy-deepseek-key")
        );
    }

    #[test]
    fn deleting_a_default_profile_does_not_promote_an_unconfigured_legacy_profile() {
        let mut store = migrate_legacy_provider_config(
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/old".into(),
                base_url: Some("https://old.example/v1".into()),
                small_model: None,
            },
            None,
            "legacy-pending",
        )
        .expect("legacy config should remain visible");
        let (configured_id, _) = upsert_provider_profile(
            &mut store,
            None,
            true,
            ProviderConfig {
                provider: "anthropic".into(),
                model: "anthropic/claude-test".into(),
                base_url: None,
                small_model: None,
            },
            Some("configured-key".into()),
            true,
        )
        .expect("configured profile should save");
        delete_profile_from_store(&mut store, &configured_id)
            .expect("configured default should delete");
        assert!(store.default_profile_id.is_none());
    }

    #[test]
    fn provider_profile_summaries_never_contain_api_keys() {
        let mut store = empty_provider_profiles();
        upsert_provider_profile(
            &mut store,
            None,
            true,
            ProviderConfig {
                provider: "google".into(),
                model: "google/gemini-test".into(),
                base_url: None,
                small_model: None,
            },
            Some("must-not-leak".into()),
            true,
        )
        .expect("profile should save");
        let summary = provider_profiles_snapshot(&store);
        let json = serde_json::to_string(&summary).expect("summary should serialize");
        assert!(!json.contains("must-not-leak"));
        assert_eq!(summary.profiles.len(), 1);
        assert!(summary.profiles[0].is_default);
    }

    #[test]
    fn provider_profile_mutation_uses_the_desktop_ipc_camel_case_response() {
        let mutation = ProviderProfileMutation {
            profile_id: "profile-default".into(),
            snapshot: provider_profiles_snapshot(&empty_provider_profiles()),
            active_changed: true,
        };
        let value = serde_json::to_value(mutation).expect("mutation should serialize");
        assert_eq!(value["profileId"], "profile-default");
        assert_eq!(value["activeChanged"], true);
        assert!(value.get("profile_id").is_none());
        assert!(value.get("active_changed").is_none());
        assert_eq!(
            value["snapshot"]["defaultProfileId"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn named_provider_profiles_keep_a_trimmed_non_secret_label() {
        let mut store = empty_provider_profiles();
        let (id, _) = upsert_provider_profile_named(
            &mut store,
            Some("account-work"),
            true,
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/model".into(),
                base_url: Some("https://example.test/v1".into()),
                small_model: None,
            },
            Some("secret-key".into()),
            true,
            Some("  工作账户  ".into()),
        )
        .expect("named profile should save");
        let summary = provider_profiles_snapshot(&store);
        assert_eq!(summary.profiles[0].id, id);
        assert_eq!(
            summary.profiles[0].display_name.as_deref(),
            Some("工作账户")
        );
        let json = serde_json::to_string(&summary).expect("summary should serialize");
        assert!(!json.contains("secret-key"));
    }

    #[test]
    fn saving_a_changed_credential_target_requires_a_new_key() {
        let mut store = empty_provider_profiles();
        upsert_provider_profile_named(
            &mut store,
            Some("profile-one"),
            true,
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/model".into(),
                base_url: Some("https://old.example/v1".into()),
                small_model: None,
            },
            Some("old-secret".into()),
            true,
            None,
        )
        .expect("initial profile should save");

        let changed_endpoint = upsert_provider_profile_named(
            &mut store,
            Some("profile-one"),
            false,
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/model".into(),
                base_url: Some("https://new.example/v1".into()),
                small_model: None,
            },
            None,
            true,
            None,
        );
        assert!(changed_endpoint.is_err());
        assert_eq!(
            store.profiles[0].config.base_url.as_deref(),
            Some("https://old.example/v1")
        );
        assert_eq!(store.profiles[0].api_key.as_deref(), Some("old-secret"));

        let changed_provider = ProviderConfig {
            provider: "anthropic".into(),
            model: "anthropic/model".into(),
            base_url: None,
            small_model: None,
        };
        assert!(!profile_credential_target_matches(
            &store.profiles[0].config,
            &changed_provider
        ));
    }

    #[test]
    fn provider_profile_store_rejects_unknown_versions_duplicate_ids_and_missing_defaults() {
        let mut unknown_version = empty_provider_profiles();
        unknown_version.schema_version = PROVIDER_PROFILES_SCHEMA_VERSION + 1;
        assert!(validate_provider_profiles(unknown_version).is_err());

        let mut missing_default = empty_provider_profiles();
        missing_default.default_profile_id = Some("not-present".into());
        assert!(validate_provider_profiles(missing_default).is_err());

        let mut unconfigured_default = migrate_legacy_provider_config(
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/pending".into(),
                base_url: Some("https://pending.example/v1".into()),
                small_model: None,
            },
            None,
            "pending-key",
        )
        .expect("unconfigured legacy profile should remain in the catalog");
        unconfigured_default.default_profile_id = Some("pending-key".into());
        assert!(validate_provider_profiles(unconfigured_default).is_err());

        let duplicate = ProviderProfile {
            id: "duplicate".into(),
            display_name: None,
            config: ProviderConfig {
                provider: "deepseek".into(),
                model: "deepseek/deepseek-v4-flash".into(),
                base_url: None,
                small_model: None,
            },
            api_key: Some("secret".into()),
        };
        let mut duplicate_ids = empty_provider_profiles();
        duplicate_ids.profiles = vec![duplicate.clone(), duplicate];
        assert!(validate_provider_profiles(duplicate_ids).is_err());
    }

    #[test]
    fn retrying_profile_creation_with_same_client_id_is_idempotent() {
        let mut store = empty_provider_profiles();
        let config = ProviderConfig {
            provider: "custom".into(),
            model: "custom/retry-model".into(),
            base_url: Some("https://retry.example/v1".into()),
            small_model: None,
        };
        let (id, first_active_change) = upsert_provider_profile(
            &mut store,
            Some("stable-draft-id"),
            true,
            config.clone(),
            Some("retry-key".into()),
            true,
        )
        .expect("first save should create the client-addressed profile");
        let (retry_id, retry_active_change) = upsert_provider_profile(
            &mut store,
            Some("stable-draft-id"),
            true,
            config,
            Some("retry-key".into()),
            true,
        )
        .expect("retry should update the same profile");
        assert_eq!(id, retry_id);
        assert_eq!(store.profiles.len(), 1);
        assert!(first_active_change);
        assert!(!retry_active_change);
        assert!(upsert_provider_profile(
            &mut store,
            Some("missing-edit-id"),
            false,
            ProviderConfig {
                provider: "custom".into(),
                model: "custom/other".into(),
                base_url: Some("https://other.example/v1".into()),
                small_model: None
            },
            Some("other-key".into()),
            false,
        )
        .is_err());
    }

    #[test]
    fn cancelled_profile_mutation_does_not_write_after_waiting_for_the_store_lock() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        };

        let guard = PROVIDER_PROFILE_STORE_LOCK.lock().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let executed = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker_cancelled = Arc::clone(&cancelled);
        let worker_executed = Arc::clone(&executed);
        let worker = thread::spawn(move || {
            ready_tx.send(()).unwrap();
            with_profile_store_lock(Some(&worker_cancelled), || {
                worker_executed.store(true, Ordering::SeqCst);
                Ok(())
            })
        });
        ready_rx.recv().unwrap();
        cancelled.store(true, Ordering::SeqCst);
        drop(guard);

        assert!(worker.join().unwrap().is_err());
        assert!(!executed.load(Ordering::SeqCst));
    }

    #[test]
    fn empty_provider_profile_store_uses_the_implicit_deepseek_default() {
        let store = empty_provider_profiles();
        let config = default_provider_config_for_store(&store);
        assert_eq!(config.provider, "deepseek");
        assert_eq!(config.model, "deepseek/deepseek-v4-flash");
        assert!(default_api_key_for_store(&store).is_none());
    }

    #[test]
    fn validates_provider_config_and_builds_non_secret_engine_config() {
        let custom = ProviderConfig {
            provider: "custom".to_string(),
            model: "custom/qwen-max".to_string(),
            base_url: Some("https://example.com/v1/".to_string()),
            small_model: Some("custom/qwen-mini".to_string()),
        };
        let content = engine_config_content(&custom).expect("custom config should be valid");
        assert!(content.contains("custom/qwen-max"));
        assert!(content.contains("https://example.com/v1"));
        assert!(!content.contains("api-key"));
        assert!(validate_provider_base_url("http://127.0.0.1:8000/v1").is_ok());
        assert!(validate_provider_base_url("http://example.com/v1").is_err());
    }

    #[test]
    fn validates_native_anthropic_and_gemini_configs_with_protocol_adapters() {
        let anthropic = normalize_provider_config(ProviderConfig {
            provider: "anthropic".to_string(),
            model: "anthropic/claude-test".to_string(),
            base_url: Some("https://api.anthropic.com/v1".to_string()),
            small_model: None,
        })
        .expect("Anthropic config should be valid");
        let anthropic_json: Value = serde_json::from_str(
            &engine_config_content(&anthropic).expect("Anthropic config should serialize"),
        )
        .expect("Anthropic config should be JSON");
        assert_eq!(
            anthropic_json["provider"]["anthropic"]["models"]["claude-test"]["provider"]["npm"],
            "@ai-sdk/anthropic"
        );

        let google = normalize_provider_config(ProviderConfig {
            provider: "google".to_string(),
            model: "google/gemini-test".to_string(),
            base_url: Some("https://generativelanguage.googleapis.com/v1beta".to_string()),
            small_model: None,
        })
        .expect("Gemini config should be valid");
        let google_json: Value = serde_json::from_str(
            &engine_config_content(&google).expect("Gemini config should serialize"),
        )
        .expect("Gemini config should be JSON");
        assert_eq!(
            google_json["provider"]["google"]["models"]["gemini-test"]["provider"]["npm"],
            "@ai-sdk/google"
        );
    }

    #[test]
    fn native_model_catalog_uses_provider_specific_urls_and_auth_headers() {
        let anthropic = model_catalog_request("anthropic", None, "test-key", None)
            .expect("Anthropic catalog request should be constructible");
        assert_eq!(anthropic.url, "https://api.anthropic.com/v1/models");
        assert!(anthropic
            .headers
            .contains(&("x-api-key".to_string(), "test-key".to_string())));
        assert!(anthropic
            .headers
            .iter()
            .any(|(name, value)| name == "anthropic-version" && value == "2023-06-01"));

        let google = model_catalog_request("google", None, "test-key", Some("next page"))
            .expect("Gemini catalog request should be constructible");
        assert_eq!(google.url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=next+page");
        assert!(google
            .headers
            .contains(&("x-goog-api-key".to_string(), "test-key".to_string())));
    }

    #[test]
    fn model_catalog_network_failures_have_actionable_chinese_messages() {
        assert_eq!(
            model_catalog_curl_error(Some(28)),
            Some("连接模型服务超时，请检查网络后重试。")
        );
        assert_eq!(
            model_catalog_curl_error(Some(63)),
            Some("模型目录响应超过 2 MB 安全上限，已停止读取。")
        );
        assert_eq!(model_catalog_curl_error(Some(7)), None);
        assert!(model_catalog_http_error(401).contains("API Key 无效"));
        assert!(model_catalog_http_error(404).contains("Base URL"));
        assert!(model_catalog_http_error(429).contains("限流"));
    }

    #[test]
    fn custom_catalog_uses_the_same_base_path_as_inference() {
        let config = ProviderConfig {
            provider: "custom".to_string(),
            model: "custom/test-model".to_string(),
            base_url: Some("https://gateway.example/openai".to_string()),
            small_model: None,
        };
        let inference: Value =
            serde_json::from_str(&engine_config_content(&config).unwrap()).unwrap();
        assert_eq!(
            inference["provider"]["custom"]["options"]["baseURL"],
            "https://gateway.example/openai"
        );
        let catalog =
            model_catalog_request("custom", config.base_url.as_deref(), "test-key", None).unwrap();
        assert_eq!(catalog.url, "https://gateway.example/openai/models");

        let anthropic = model_catalog_request(
            "anthropic",
            Some("https://gateway.example/anthropic"),
            "test-key",
            None,
        )
        .unwrap();
        assert_eq!(anthropic.url, "https://gateway.example/anthropic/models");

        let google = model_catalog_request(
            "google",
            Some("https://gateway.example/gemini"),
            "test-key",
            None,
        )
        .unwrap();
        assert_eq!(
            google.url,
            "https://gateway.example/gemini/models?pageSize=1000"
        );
    }

    #[test]
    fn model_catalog_rejects_empty_malformed_and_oversized_responses() {
        assert!(
            parse_provider_model_catalog("anthropic", 200, r#"{"data":[]}"#)
                .unwrap_err()
                .contains("没有返回可用于对话的模型")
        );
        assert!(parse_provider_model_catalog("google", 200, "not-json")
            .unwrap_err()
            .contains("无法识别"));
        let oversized = " ".repeat(MAX_MODEL_CATALOG_RESPONSE_BYTES + 1);
        assert!(parse_provider_model_catalog("google", 200, &oversized)
            .unwrap_err()
            .contains("响应过大"));

        let duplicate = parse_provider_model_catalog(
            "anthropic",
            200,
            r#"{"data":[{"id":"claude-a"},{"id":"claude-a"}]}"#,
        )
        .expect("duplicate model IDs should be collapsed");
        assert_eq!(duplicate.len(), 1);
    }

    #[test]
    fn model_catalog_stdout_reader_stops_at_the_bounded_size() {
        let output = std::io::Cursor::new(vec![b'x'; MAX_MODEL_CATALOG_RESPONSE_BYTES + 1024]);
        assert!(read_bounded_model_catalog_stdout(output)
            .unwrap_err()
            .contains("响应过大"));
    }

    #[test]
    fn parses_native_catalogs_and_only_lists_gemini_chat_models() {
        let anthropic = parse_provider_model_catalog(
            "anthropic",
            200,
            r#"{"data":[{"id":"claude-a","display_name":"Claude A"},{"id":"claude-b"}]}"#,
        )
        .expect("Anthropic response should parse");
        assert_eq!(
            anthropic
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["anthropic/claude-a", "anthropic/claude-b"]
        );

        let google = parse_provider_model_catalog(
            "google",
            200,
            r#"{"models":[{"name":"models/gemini-chat","baseModelId":"gemini-chat","displayName":"Gemini Chat","supportedGenerationMethods":["generateContent"]},{"name":"models/gemini-embed","supportedGenerationMethods":["embedContent"]}]}"#,
        )
        .expect("Gemini response should parse");
        assert_eq!(google.len(), 1);
        assert_eq!(google[0].id, "google/gemini-chat");
        assert_eq!(google[0].label, "Gemini Chat");

        let anthropic_page = parse_provider_model_catalog_page(
            "anthropic",
            200,
            r#"{"data":[{"id":"claude-page-1"}],"has_more":true,"last_id":"claude-page-1"}"#,
        )
        .expect("Anthropic pagination metadata should parse");
        assert!(anthropic_page.has_more);
        assert_eq!(anthropic_page.next_cursor.as_deref(), Some("claude-page-1"));

        let google_page = parse_provider_model_catalog_page(
            "google",
            200,
            r#"{"models":[{"name":"models/gemini-page-1","supportedGenerationMethods":["generateContent"]}],"nextPageToken":"next page"}"#,
        )
        .expect("Gemini pagination metadata should parse");
        assert!(google_page.has_more);
        assert_eq!(google_page.next_cursor.as_deref(), Some("next page"));
    }

    #[test]
    fn upgrades_the_previous_default_model_without_accepting_unknown_models() {
        let upgraded = normalize_provider_config(ProviderConfig {
            provider: "deepseek".to_string(),
            model: "deepseek/deepseek-v4-flash".to_string(),
            base_url: None,
            small_model: None,
        })
        .expect("the previous default should be upgraded");
        assert_eq!(upgraded.model, "deepseek/deepseek-v4-flash");
        let expired = normalize_provider_config(ProviderConfig {
            provider: "deepseek".to_string(),
            model: "deepseek/deepseek-v4.1-flash-expires-on-0910".to_string(),
            base_url: None,
            small_model: None,
        })
        .expect("the expired desktop default should be upgraded");
        assert_eq!(expired.model, "deepseek/deepseek-v4-flash");
        let expired_small = normalize_provider_config(ProviderConfig {
            provider: "deepseek".to_string(),
            model: "deepseek/deepseek-v4-pro".to_string(),
            base_url: None,
            small_model: Some("deepseek/deepseek-v4.1-flash-expires-on-0910".to_string()),
        })
        .expect("the expired small model should be upgraded");
        assert_eq!(
            expired_small.small_model.as_deref(),
            Some("deepseek/deepseek-v4-flash")
        );
        assert!(normalize_provider_config(ProviderConfig {
            provider: "deepseek".to_string(),
            model: "deepseek/unknown".to_string(),
            base_url: None,
            small_model: None,
        })
        .is_err());
    }

    #[test]
    fn passes_only_allowlisted_environment_variables_to_the_managed_sidecar() {
        let inherited = inherited_sidecar_environment(
            [
                ("PATH".to_string(), "/usr/bin".to_string()),
                ("HOME".to_string(), "/Users/research".to_string()),
                ("DEEPSEEK_API_KEY".to_string(), "sk-secret".to_string()),
                (
                    "KILLSTATA_CUSTOM_API_KEY".to_string(),
                    "sk-custom".to_string(),
                ),
                ("HTTPS_PROXY".to_string(), "http://attacker".to_string()),
                (
                    "NODE_OPTIONS".to_string(),
                    "--require /tmp/evil.js".to_string(),
                ),
                (
                    "KILLSTATA_CONFIG_CONTENT".to_string(),
                    "{\"model\":\"attacker/model\"}".to_string(),
                ),
            ]
            .into_iter(),
        );

        let names = inherited
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["PATH", "HOME"]);
    }

    #[test]
    fn rejects_workspace_filenames_that_would_break_the_binary_response_framing() {
        assert_eq!(
            safe_workspace_filename(std::path::Path::new("/tmp/policy.csv"))
                .expect("a normal filename should be accepted"),
            "policy.csv"
        );
        assert!(safe_workspace_filename(std::path::Path::new("/tmp/pol\nicy.csv")).is_err());
        assert!(safe_workspace_filename(std::path::Path::new(&format!(
            "/tmp/{}.csv",
            "n".repeat(300)
        )))
        .is_err());
    }

    #[test]
    fn accepts_only_real_descendants_of_the_selected_workspace() {
        let workspace = std::path::Path::new("/Users/research/policy-lab");

        assert!(workspace_contains_file(
            workspace,
            std::path::Path::new("/Users/research/policy-lab/policy.csv")
        ));
        assert!(workspace_contains_file(
            workspace,
            std::path::Path::new("/Users/research/policy-lab/input/policy.csv")
        ));
        assert!(!workspace_contains_file(
            workspace,
            std::path::Path::new("/Users/research/policy-lab-copy/policy.csv")
        ));
        assert!(!workspace_contains_file(
            workspace,
            std::path::Path::new("/Users/research/other/policy.csv")
        ));
        assert!(!workspace_contains_file(workspace, workspace));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_selected_file_replaced_by_an_external_symlink() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("killstata-workspace-test-{}", Uuid::new_v4()));
        let workspace = root.join("workspace");
        let external = root.join("outside.csv");
        let selected = workspace.join("selected.csv");
        fs::create_dir_all(&workspace).expect("test workspace should exist");
        fs::write(&external, "secret,outside\n1,2").expect("external fixture should exist");
        fs::write(&selected, "id,value\n1,2").expect("selected fixture should exist");

        fs::remove_file(&selected).expect("test fixture should be replaceable");
        symlink(&external, &selected).expect("test symlink should be creatable");

        assert_eq!(
            read_selected_workspace_file(&workspace, &selected)
                .expect_err("a replacement symlink must not be read"),
            "无法读取所选数据文件"
        );

        fs::remove_dir_all(root).expect("test files should be removable");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_an_intermediate_workspace_directory_replaced_by_an_external_symlink() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("killstata-workspace-test-{}", Uuid::new_v4()));
        let workspace = root.join("workspace");
        let nested = workspace.join("input");
        let selected = nested.join("policy.csv");
        let external = root.join("outside");
        fs::create_dir_all(&nested).expect("nested workspace fixture should exist");
        fs::create_dir_all(&external).expect("external fixture should exist");
        fs::write(&selected, "id,value\n1,2").expect("selected fixture should exist");
        fs::write(external.join("policy.csv"), "secret,outside\n3,4")
            .expect("external fixture should exist");

        fs::remove_file(&selected).expect("nested fixture should be replaceable");
        fs::remove_dir(&nested).expect("nested fixture directory should be replaceable");
        symlink(&external, &nested).expect("test symlink should be creatable");

        assert_eq!(
            read_selected_workspace_file(&workspace, &selected)
                .expect_err("an intermediate replacement symlink must not be read"),
            "无法读取所选数据文件"
        );

        fs::remove_dir_all(root).expect("test files should be removable");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_named_pipe_without_blocking_the_desktop_process() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};

        let root =
            std::env::temp_dir().join(format!("killstata-workspace-test-{}", Uuid::new_v4()));
        let workspace = root.join("workspace");
        let selected = workspace.join("stream.csv");
        fs::create_dir_all(&workspace).expect("test workspace should exist");
        let selected_c = CString::new(selected.as_os_str().as_bytes())
            .expect("temporary path must not contain a NUL byte");
        assert_eq!(unsafe { libc::mkfifo(selected_c.as_ptr(), 0o600) }, 0);

        assert_eq!(
            read_selected_workspace_file(&workspace, &selected)
                .expect_err("a named pipe must not be read as data"),
            "请选择一个数据文件"
        );

        fs::remove_dir_all(root).expect("test files should be removable");
    }
}
