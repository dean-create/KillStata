/**
 * 模型提供商与运行环境配置（KillStata Desktop 前端与 Tauri 适配器的共享事实来源）。
 *
 * Desktop 与 Core 共用 provider ID：deepseek、custom、anthropic、google。
 * 外部提供方的模型目录由 Tauri 按对应原生协议查询，不在前端猜测或手填模型 ID。
 *
 * 本模块只负责前端侧的展示与校验；API Key 永不写入 localStorage、研究消息或普通配置文件，
 * 仍由 macOS Keychain 保存，浏览器 demo 只用内存布尔值示例。
 */

/** CLI config 的 provider/model 字段形如 "provider/model"；对应模型保持 CLI 字符串值。 */
export type ProviderID = "deepseek" | "custom" | "anthropic" | "google"

export type ProviderSettings = {
  provider: ProviderID
  /** CLI 的 model 字段；外部提供方模型必须来自其成功返回的模型目录。 */
  model: string
  /** 可选的 small_model（只用会话标题/摘要，不改变计量工具主模型）。与 model 同样为 "provider/model"。 */
  smallModel?: string
  /** custom/Anthropic/Gemini 服务端点；原生协议可使用官方默认值。 */
  baseURL?: string
}

// 内置 DeepSeek 目录；其他服务商按 API Key 实时发现。
export const DEEPSEEK_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash（默认）" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
]

export const DEEPSEEK_DEFAULT_PROVIDER_MODEL = "deepseek/deepseek-v4-flash"

/** 自定义模型必须保留 provider/model 形状；CLI 会用前缀确定 provider。 */
export const defaultCustomModel = "custom/custom-model"

const PROVIDER_DEFAULT_BASE_URL: Partial<Record<ProviderID, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
}

export function defaultProviderBaseURL(provider: ProviderID): string | undefined {
  return PROVIDER_DEFAULT_BASE_URL[provider]
}

export function providerLabel(provider: ProviderID): string {
  switch (provider) {
    case "deepseek": return "DeepSeek"
    case "custom": return "OpenAI-compatible"
    case "anthropic": return "Anthropic"
    case "google": return "Google Gemini"
  }
}

export function isDeepSeekProvider(provider: ProviderID): boolean {
  return provider === "deepseek"
}

/** DeepSeek 使用内置目录；其他服务商模型必须通过协议查询获得。 */
export function modelChoices(provider: ProviderID): ReadonlyArray<{ id: string; label: string }> {
  return provider === "deepseek" ? DEEPSEEK_MODELS : []
}

/** 校验 provider 配置：返回标准化后的 settings 或明确的中文错误。 */
export function validateProviderSettings(input: ProviderSettings): { ok: true; value: ProviderSettings } | { ok: false; error: string } {
  const provider = input.provider
  const model = provider === "deepseek" ? input.model.trim() : normalizeProviderModel(provider, input.model)
  if (!model) {
    return { ok: false, error: "请填写当前提供商使用的模型 ID。" }
  }
  if (provider === "deepseek") {
    if (!DEEPSEEK_MODELS.some((item) => item.id === model)) {
      return { ok: false, error: "DeepSeek 只支持内置的 deepseek-v4-flash 与 deepseek-v4-pro 模型。" }
    }
    const smallModel = normalizeSmallModel(input.smallModel)
    if (smallModel && !DEEPSEEK_MODELS.some((item) => item.id === smallModel)) {
      return { ok: false, error: "DeepSeek 小模型也必须使用内置的 deepseek-v4-flash 或 deepseek-v4-pro。" }
    }
    return { ok: true, value: { provider, model, smallModel } }
  }
  const rawBaseURL = (input.baseURL ?? defaultProviderBaseURL(provider) ?? "").trim().replace(/\/+$/, "")
  const baseURLError = validateBaseURL(rawBaseURL)
  if (baseURLError) return { ok: false, error: baseURLError }
  const smallModel = input.smallModel ? normalizeProviderModel(provider, input.smallModel) : undefined
  if (smallModel && !smallModel.startsWith(`${provider}/`)) {
    return { ok: false, error: "小模型必须来自当前服务商的模型目录。" }
  }
  return { ok: true, value: { provider, model, smallModel, baseURL: rawBaseURL } }
}

/** UI 使用目录返回的模型 ID；Harness 保留 provider/model 内部格式。 */
function normalizeProviderModel(provider: ProviderID, value: string) {
  const normalized = value.trim()
  if (!normalized || normalized === `${provider}/`) return ""
  if (["deepseek", "custom", "anthropic", "google"].some((other) => other !== provider && normalized.startsWith(`${other}/`))) return ""
  return normalized.startsWith(`${provider}/`) ? normalized : `${provider}/${normalized}`
}

export function normalizeSmallModel(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  return normalized ? normalized : undefined
}

/** 只接受 https；本机回环 http 用于本地 vLLM / 开发服务，其它明文 HTTP 一律拒绝。 */
export function validateBaseURL(raw: string): string | undefined {
  if (!raw) return "当前服务商要求提供 base URL。"
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return "请填写合法的端点 base URL。"
  }
  if (url.protocol === "https:") return undefined
  const hostname = url.hostname.toLowerCase()
  const loopback = hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost" || hostname.endsWith(".localhost")
  if (url.protocol === "http:" && loopback) return undefined
  return "base URL 必须使用 https；仅本机回环服务（localhost / 127.0.0.1）允许 http。"
}

/** 生成注入到 CLI 核心的 KILLSTATA_CONFIG_CONTENT；只包含非秘密配置。 */
export function engineConfigContent(settings: ProviderSettings, apiKey: string): string | null {
  const validation = validateProviderSettings(settings)
  if (!validation.ok || !apiKey.trim()) return null
  const config: Record<string, unknown> = { model: settings.model }
  if (settings.smallModel) config.small_model = settings.smallModel
  if (settings.provider === "custom") {
    const modelIDs = [settings.model, settings.smallModel]
      .filter((model): model is string => Boolean(model))
      .map((model) => model.slice(settings.provider.length + 1))
    config.provider = {
      custom: {
        options: { baseURL: settings.baseURL },
        models: Object.fromEntries(modelIDs.map((modelID) => [modelID, {}])),
      },
    }
  } else if (settings.provider === "anthropic" || settings.provider === "google") {
    const isAnthropic = settings.provider === "anthropic"
    const modelIDs = [settings.model, settings.smallModel]
      .filter((model): model is string => Boolean(model))
      .map((model) => model.slice(settings.provider.length + 1))
    config.provider = {
      [settings.provider]: {
        name: isAnthropic ? "Anthropic" : "Google Gemini",
        api: settings.baseURL ?? defaultProviderBaseURL(settings.provider),
        env: [isAnthropic ? "ANTHROPIC_API_KEY" : "GOOGLE_GENERATIVE_AI_API_KEY"],
        models: Object.fromEntries(modelIDs.map((modelID) => [modelID, {
            id: modelID,
            name: modelID,
            provider: { npm: isAnthropic ? "@ai-sdk/anthropic" : "@ai-sdk/google" },
          }])),
      },
    }
  }
  return JSON.stringify(config)
}

/** 1.0.0 之前只安装 pandas/linearmodels/statsmodels；本轮扩展为 CLI canonical 清单。 */
export const PYTHON_RUNTIME_PACKAGES: ReadonlyArray<{
  pip: string
  purpose: string
  group: "core" | "methods" | "io" | "prep" | "cli"
  pinned?: string
}> = [
  { pip: "pydantic", purpose: "Python Registry 参数校验与结果契约（核心）", group: "core", pinned: "2.13.2" },
  { pip: "pandas", purpose: "数据读取与表格计算（核心）", group: "core" },
  { pip: "numpy", purpose: "数值数组与统计计算（核心）", group: "core" },
  { pip: "scipy", purpose: "统计分布与推断（核心）", group: "core" },
  { pip: "statsmodels", purpose: "OLS / GLM / 计数 / 分位数等回归（核心）", group: "core" },
  { pip: "linearmodels", purpose: "IV / 面板固定效应与随机效应", group: "methods" },
  { pip: "pyfixest", purpose: "HDFE / DID / 事件研究（pyfixest==0.60.0）", group: "methods", pinned: "0.60.0" },
  { pip: "rdrobust", purpose: "断点回归 RDD（rdrobust==2.0.0）", group: "methods", pinned: "2.0.0" },
  { pip: "matplotlib", purpose: "倾向得分匹配与分布图形", group: "methods" },
  { pip: "scikit-learn", purpose: "KNN 插补 / 缩放 / PowerTransformer 预处理", group: "prep" },
  { pip: "openpyxl", purpose: "Excel 读写引擎（.xlsx）", group: "io" },
  { pip: "pyarrow", purpose: "Parquet 读写引擎", group: "io" },
  { pip: "python-docx", purpose: "CLI 预置文档能力", group: "cli" },
]
