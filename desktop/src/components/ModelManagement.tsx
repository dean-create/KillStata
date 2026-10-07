import { For, Show, createSignal } from "solid-js"
import { createModelProfileID } from "../credentials"
import type { CredentialStore, ModelProfilesSnapshot, ModelProfileSummary } from "../credentials"
import {
  DEEPSEEK_DEFAULT_PROVIDER_MODEL,
  DEEPSEEK_MODELS,
  defaultProviderBaseURL,
  providerLabel,
  validateBaseURL,
  validateProviderSettings,
} from "../provider-config"
import type { ProviderID, ProviderSettings } from "../provider-config"

type ModelManagementProps = {
  snapshot: ModelProfilesSnapshot
  credentials: CredentialStore
  busy?: boolean
  loadState?: "loading" | "ready" | "error"
  loadError?: string
  storageNotice?: string
  credentialStoreLabel?: string
  readOnly?: boolean
  onRetryLoad?: () => void | Promise<void>
  onSnapshot: (snapshot: ModelProfilesSnapshot) => void
}

const PROVIDER_CHOICES: ReadonlyArray<{ id: ProviderID; label: string; description: string }> = [
  { id: "deepseek", label: "DeepSeek", description: "内置 DeepSeek 对话与计量模型" },
  { id: "custom", label: "OpenAI 兼容协议", description: "自定义兼容服务地址和 API Key" },
  { id: "anthropic", label: "Anthropic", description: "Anthropic 原生 Messages 协议" },
  { id: "google", label: "Google Gemini", description: "Gemini 原生 Generative Language 协议" },
]

function modelLabel(model: string, provider: ProviderID) {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model
}

function normalizedEndpoint(value: string | undefined) {
  return (value ?? "").trim().replace(/\/+$/, "")
}

export function ModelManagement(props: ModelManagementProps) {
  const [view, setView] = createSignal<"list" | "providers" | "configure">("list")
  const [provider, setProvider] = createSignal<ProviderID>("deepseek")
  const [displayName, setDisplayName] = createSignal("")
  const [profileID, setProfileID] = createSignal<string>()
  const [draftProfileID, setDraftProfileID] = createSignal("")
  const [baseURL, setBaseURL] = createSignal("")
  const [model, setModel] = createSignal("")
  const [smallModel, setSmallModel] = createSignal<string>()
  const [apiKey, setApiKey] = createSignal("")
  const [availableModels, setAvailableModels] = createSignal<ReadonlyArray<{ id: string; label: string }>>([])
  const [catalogState, setCatalogState] = createSignal<"idle" | "loading" | "loaded">("idle")
  const [makeDefault, setMakeDefault] = createSignal(false)
  const [pendingDeleteID, setPendingDeleteID] = createSignal<string>()
  const [errorMessage, setErrorMessage] = createSignal("")
  const [isSaving, setIsSaving] = createSignal(false)
  const [isMutating, setIsMutating] = createSignal(false)
  const [needsReconciliation, setNeedsReconciliation] = createSignal(false)
  let discoveryGeneration = 0

  const activeProfile = () => props.snapshot.profiles.find((profile) => profile.id === props.snapshot.defaultProfileId)
  const credentialStoreLabel = () => props.credentialStoreLabel ?? "KillStata 本机凭据存储"
  const credentialStoreLabelForRemoval = () => ` ${credentialStoreLabel()}`
  const loadState = () => props.loadState ?? "ready"
  const changesBlocked = () => isMutating() || needsReconciliation()

  const reconcile = async () => {
    if (isMutating() || !props.onRetryLoad) return
    setIsMutating(true)
    try {
      await props.onRetryLoad()
      if (loadState() !== "ready") throw new Error("模型档案仍未读取成功，请稍后重试。")
      setNeedsReconciliation(false)
      setErrorMessage("")
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "模型档案仍未读取成功，请稍后重试。")
    } finally {
      setIsMutating(false)
    }
  }

  const openProviderPicker = () => {
    setErrorMessage("")
    setPendingDeleteID(undefined)
    setView("providers")
  }

  const chooseProvider = (nextProvider: ProviderID) => {
    discoveryGeneration += 1
    setProvider(nextProvider)
    setDisplayName("")
    setProfileID(undefined)
    setDraftProfileID(createModelProfileID())
    setBaseURL(defaultProviderBaseURL(nextProvider) ?? "")
    setModel(nextProvider === "deepseek" ? DEEPSEEK_DEFAULT_PROVIDER_MODEL : "")
    setSmallModel(undefined)
    setApiKey("")
    setAvailableModels(nextProvider === "deepseek" ? DEEPSEEK_MODELS : [])
    setCatalogState(nextProvider === "deepseek" ? "loaded" : "idle")
    setMakeDefault(props.snapshot.defaultProfileId === null && !props.snapshot.profiles.some((profile) => profile.configured))
    setErrorMessage("")
    setView("configure")
  }

  const editProfile = (profile: ModelProfileSummary) => {
    discoveryGeneration += 1
    setProvider(profile.provider)
    setDisplayName(profile.displayName ?? "")
    setProfileID(profile.id)
    setDraftProfileID(profile.id)
    setBaseURL(profile.baseURL ?? defaultProviderBaseURL(profile.provider) ?? "")
    setModel(profile.model)
    setSmallModel(profile.smallModel ?? undefined)
    setApiKey("")
    setAvailableModels(profile.provider === "deepseek"
      ? DEEPSEEK_MODELS
      : [{ id: profile.model, label: modelLabel(profile.model, profile.provider) }])
    setCatalogState("loaded")
    setMakeDefault(profile.isDefault)
    setErrorMessage("")
    setView("configure")
  }

  const invalidateCatalog = () => {
    discoveryGeneration += 1
    setErrorMessage("")
    if (provider() === "deepseek") {
      setAvailableModels(DEEPSEEK_MODELS)
      setCatalogState("loaded")
      setModel(DEEPSEEK_DEFAULT_PROVIDER_MODEL)
      return
    }
    setAvailableModels([])
    setCatalogState("idle")
    setModel("")
  }

  const discoverModels = async () => {
    const currentProvider = provider()
    const currentBaseURL = (baseURL() || defaultProviderBaseURL(currentProvider) || "").trim()
    const savedProfile = profileID()
      ? props.snapshot.profiles.find((profile) => profile.id === profileID())
      : undefined
    const savedEndpoint = normalizedEndpoint(savedProfile?.baseURL ?? defaultProviderBaseURL(currentProvider))
    if (savedProfile?.configured && !apiKey().trim()
      && normalizedEndpoint(currentBaseURL) !== savedEndpoint) {
      setErrorMessage("Base URL 已更改。为避免把原 API Key 发往新地址，请重新输入该服务商的 API Key 后再读取模型。")
      return
    }
    const validationError = validateBaseURL(currentBaseURL)
    if (validationError) {
      setErrorMessage(validationError)
      return
    }
    const generation = ++discoveryGeneration
    setErrorMessage("")
    setCatalogState("loading")
    try {
      if (!props.credentials.discoverModels) throw new Error("当前运行环境不能读取服务商模型目录。")
      const models = await props.credentials.discoverModels(
        currentProvider,
        currentBaseURL,
        apiKey().trim() || undefined,
        profileID(),
      )
      if (generation !== discoveryGeneration) return
      if (models.length === 0) throw new Error("服务商没有返回可用聊天模型，请检查 API Key 和账号权限。")
      setAvailableModels(models)
      setBaseURL(currentBaseURL)
      setModel((current) => models.some((item) => item.id === current) ? current : "")
      setCatalogState("loaded")
    } catch (error) {
      if (generation !== discoveryGeneration) return
      setAvailableModels([])
      setCatalogState("idle")
      setErrorMessage(error instanceof Error ? error.message : "读取模型目录失败，请检查网络与服务商配置。")
    }
  }

  const saveProfile = async () => {
    if (changesBlocked()) return
    setErrorMessage("")
    if (props.busy && (makeDefault() || profileID() === props.snapshot.defaultProfileId)) {
      setErrorMessage("当前分析完成前不能修改正在使用的默认模型；可以先保存为非默认档案。")
      return
    }
    const draft: ProviderSettings = {
      provider: provider(),
      model: model(),
      baseURL: baseURL() || defaultProviderBaseURL(provider()),
      smallModel: smallModel(),
    }
    const validation = validateProviderSettings(draft)
    if (!validation.ok) {
      setErrorMessage(validation.error)
      return
    }
    if (!availableModels().some((item) => item.id === validation.value.model)
      || (provider() !== "deepseek" && catalogState() !== "loaded")) {
      setErrorMessage("请先读取模型目录并选择其中一个模型。")
      return
    }
    const editedProfile = profileID() ? props.snapshot.profiles.find((item) => item.id === profileID()) : undefined
    if (!apiKey().trim() && (!profileID() || !editedProfile?.configured)) {
      setErrorMessage("此档案尚未配置 API Key，请输入密钥后再保存。")
      return
    }
    if (!props.credentials.saveProfile) {
      setErrorMessage("当前运行环境不支持保存多模型配置。")
      return
    }
    setIsSaving(true)
    setIsMutating(true)
    try {
      const result = await props.credentials.saveProfile(
        validation.value,
        apiKey().trim() || undefined,
        draftProfileID(),
        makeDefault(),
        !profileID(),
        displayName().trim(),
      )
      props.onSnapshot(result.snapshot)
      setNeedsReconciliation(false)
      setApiKey("")
      setErrorMessage("")
      setView("list")
    } catch (error) {
      const reason = error instanceof Error ? error.message : "保存模型配置失败。"
      setNeedsReconciliation(true)
      setErrorMessage(`${reason} 保存状态可能未知；请刷新档案列表核对。再次保存会复用同一档案，不会重复添加。`)
    } finally {
      setIsSaving(false)
      setIsMutating(false)
    }
  }

  const setDefault = async (id?: string) => {
    if (changesBlocked()) return
    setErrorMessage("")
    if (!props.credentials.setDefaultProfile) {
      setErrorMessage("当前运行环境不支持切换默认模型。")
      return
    }
    setIsMutating(true)
    try {
      const result = await props.credentials.setDefaultProfile(id)
      props.onSnapshot(result.snapshot)
    } catch (error) {
      setNeedsReconciliation(true)
      setErrorMessage(`${error instanceof Error ? error.message : "切换默认模型失败。"} 状态可能未知，请刷新档案列表核对。`)
    } finally {
      setIsMutating(false)
    }
  }

  const confirmDelete = async (id: string) => {
    if (changesBlocked()) return
    if (props.busy && id === props.snapshot.defaultProfileId) {
      setErrorMessage("当前分析完成前不能移除正在使用的默认模型。")
      return
    }
    if (!props.credentials.deleteProfile) {
      setErrorMessage("当前运行环境不支持移除模型档案。")
      return
    }
    setIsMutating(true)
    try {
      const result = await props.credentials.deleteProfile(id)
      props.onSnapshot(result.snapshot)
      setPendingDeleteID(undefined)
      setErrorMessage("")
    } catch (error) {
      setNeedsReconciliation(true)
      setErrorMessage(`${error instanceof Error ? error.message : "移除模型档案失败。"} 状态可能未知，请刷新档案列表核对。`)
    } finally {
      setIsMutating(false)
    }
  }

  return (
    <section class="model-management" aria-label="模型管理">
      <div class="model-manager-main">
        <div class="model-management-heading">
          <div>
            <h2 class="settings-category-title">模型管理</h2>
            <p class="settings-note">{props.readOnly
              ? "主机模型由分享页面所有者管理。访客不能查看或修改 API Key。"
              : props.storageNotice ?? `管理已保存的服务商、模型和默认项。API Key 只保存在${credentialStoreLabel()}。`}</p>
          </div>
          <Show when={!props.readOnly}>
            <button type="button" class="settings-button model-add-button" disabled={loadState() !== "ready" || changesBlocked()} onClick={openProviderPicker}>＋ 配置模型</button>
          </Show>
        </div>

        <section class="model-default-card" aria-label="当前默认模型">
          <strong>默认模型</strong>
          <Show when={activeProfile()} fallback={<span>DeepSeek · {DEEPSEEK_DEFAULT_PROVIDER_MODEL}</span>}>
            {(profile) => <span>{profile().displayName || providerLabel(profile().provider)} · {modelLabel(profile().model, profile().provider)}</span>}
          </Show>
          <Show when={props.snapshot.defaultProfileId && !props.readOnly}>
            <button type="button" class="settings-button is-ghost" disabled={props.busy || changesBlocked()} onClick={() => void setDefault(undefined)}>恢复内置 DeepSeek 默认</button>
          </Show>
        </section>

        <h3 class="model-section-title">已保存模型</h3>
        <Show when={loadState() === "loading"}><p class="settings-note" role="status">正在读取本机已保存模型…</p></Show>
        <Show when={loadState() === "error"}>
          <div class="local-feedback is-error" role="alert"><strong>无法读取模型列表</strong><p>{props.loadError ?? "本机凭据存储暂时不可用；现有配置没有改动。"}</p><Show when={props.onRetryLoad}><button type="button" class="settings-button" onClick={props.onRetryLoad}>重试</button></Show></div>
        </Show>
        <Show when={loadState() === "ready"}>
          <Show when={props.snapshot.profiles.length > 0} fallback={
            <div class="model-empty-state">
              <span class="model-empty-icon" aria-hidden="true">◇</span>
              <strong>{props.readOnly ? "主机尚未配置模型" : "还没有配置模型"}</strong>
              <span>{props.readOnly ? "请联系分享页面所有者完成模型配置后再连接分析核心。" : "添加服务商模型后，可设为默认并与其他配置并行保留。"}</span>
            </div>
          }>
            <div class="model-profile-list">
              <For each={props.snapshot.profiles}>
                {(profile) => (
                  <article class="model-profile-card" aria-label={`${profile.displayName || providerLabel(profile.provider)} · ${profile.model}`}>
                    <div class="model-profile-main">
                      <strong>{profile.displayName || providerLabel(profile.provider)}</strong>
                      <span>{modelLabel(profile.model, profile.provider)}</span>
                      <Show when={profile.baseURL}><small>{profile.baseURL}</small></Show>
                      <Show when={!profile.configured}><small class="model-profile-warning">尚未配置 API Key</small></Show>
                    </div>
                    <div class="model-profile-actions">
                      <Show when={props.readOnly}>
                        <span class="model-default-badge">{profile.isDefault ? "默认模型" : "主机备用模型"}</span>
                      </Show>
                      <Show when={!props.readOnly}>
                      <Show when={profile.isDefault} fallback={
                        <button type="button" class="settings-button" disabled={props.busy || changesBlocked() || !profile.configured} title={!profile.configured ? "请先编辑档案并保存 API Key" : undefined} aria-label={`将 ${profile.displayName || providerLabel(profile.provider)} · ${profile.model} 设为默认`} onClick={() => void setDefault(profile.id)}>{profile.configured ? "设为默认" : "先配置密钥"}</button>
                      }>
                        <span class="model-default-badge">默认模型</span>
                      </Show>
                      <button type="button" class="settings-button is-ghost" disabled={changesBlocked() || (props.busy && profile.isDefault)} aria-label={`编辑 ${profile.displayName || providerLabel(profile.provider)} · ${profile.model}`} onClick={() => editProfile(profile)}>编辑</button>
                      <Show when={pendingDeleteID() === profile.id} fallback={
                        <button type="button" class="settings-button is-danger" disabled={changesBlocked() || (props.busy && profile.isDefault)} aria-label={`移除 ${profile.displayName || providerLabel(profile.provider)} · ${profile.model}`} onClick={() => setPendingDeleteID(profile.id)}>移除</button>
                      }>
                        <div class="model-delete-confirm" role="group" aria-label="确认移除模型">
                          <span>API Key 也会从{credentialStoreLabelForRemoval()}移除。</span>
                          <button type="button" class="settings-button is-danger" disabled={changesBlocked()} onClick={() => void confirmDelete(profile.id)}>确认移除模型</button>
                          <button type="button" class="settings-button is-ghost" disabled={isMutating()} onClick={() => setPendingDeleteID(undefined)}>取消</button>
                        </div>
                      </Show>
                      </Show>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </Show>
        <Show when={view() === "list" && errorMessage()}><p class="settings-message is-error" role="alert">{errorMessage()}</p></Show>
        <Show when={view() === "list" && needsReconciliation() && props.onRetryLoad}>
          <button type="button" class="settings-button" disabled={isMutating()} onClick={() => void reconcile()}>刷新档案列表</button>
        </Show>
      </div>

      <Show when={view() === "providers"}>
        <div class="model-dialog-scrim">
        <section class="model-dialog" role="dialog" aria-modal="true" aria-labelledby="model-provider-picker-title">
          <header class="model-dialog-heading">
            <button type="button" class="settings-button is-ghost" onClick={() => setView("list")}>返回模型管理</button>
            <h3 id="model-provider-picker-title">选择服务商协议</h3>
            <span>选择接入类型后，再填写 API Key 并读取可用模型。</span>
          </header>
          <div class="provider-choice-grid">
            <For each={PROVIDER_CHOICES}>
              {(choice) => (
                <button type="button" class="provider-choice-card" aria-label={`选择 ${choice.label}`} onClick={() => chooseProvider(choice.id)}>
                  <span class={`provider-choice-mark provider-choice-${choice.id}`} aria-hidden="true">{choice.id === "custom" ? "↔" : choice.label.slice(0, 1)}</span>
                  <span><strong>{choice.label}</strong><small>{choice.description}</small></span>
                </button>
              )}
            </For>
          </div>
        </section>
        </div>
      </Show>

      <Show when={view() === "configure"}>
        <div class="model-dialog-scrim">
        <section class="model-dialog" role="dialog" aria-modal="true" aria-labelledby="model-configure-title">
          <header class="model-dialog-heading">
            <button type="button" class="settings-button is-ghost" onClick={() => setView("providers")}>返回服务商</button>
            <h3 id="model-configure-title">{profileID() ? "编辑模型配置" : `配置 ${providerLabel(provider())}`}</h3>
            <span>模型目录读取成功后，从列表中选择模型；不会手动猜测模型 ID。</span>
          </header>
          <div class="model-config-form">
            <label><span>档案名称（可选）</span><input class="credential-input" aria-label="档案名称" value={displayName()} maxlength="80" placeholder="例如：工作账号、备用中转" onInput={(event) => setDisplayName(event.currentTarget.value)} /></label>
            <Show when={provider() !== "deepseek"}>
              <label><span>Base URL</span><input class="credential-input" aria-label="模型服务 Base URL" value={baseURL()} placeholder={defaultProviderBaseURL(provider()) ?? "https://api.example.com/v1"} onInput={(event) => { setBaseURL(event.currentTarget.value); invalidateCatalog() }} /></label>
            </Show>
            <Show when={provider() === "deepseek"}>
              <label><span>模型</span><select aria-label="DeepSeek 模型" value={model()} onChange={(event) => setModel(event.currentTarget.value)}><For each={DEEPSEEK_MODELS}>{(item) => <option value={item.id}>{item.label}</option>}</For></select></label>
            </Show>
            <Show when={provider() !== "deepseek"}>
              <label><span>API Key</span><input type="password" class="credential-input" aria-label="API Key" value={apiKey()} placeholder={profileID() ? "留空则保留此档案现有密钥" : "请输入 API Key"} onInput={(event) => { setApiKey(event.currentTarget.value); invalidateCatalog() }} /></label>
              <button type="button" class="settings-button" disabled={catalogState() === "loading"} onClick={() => void discoverModels()}>{catalogState() === "loading" ? "正在读取模型…" : "读取可用模型"}</button>
              <Show when={availableModels().length > 0}><label><span>模型</span><select aria-label="可用模型" value={model()} onChange={(event) => setModel(event.currentTarget.value)} disabled={catalogState() !== "loaded"}><option value="">请选择已发现模型</option><For each={availableModels()}>{(item) => <option value={item.id}>{item.label}</option>}</For></select></label></Show>
            </Show>
            <Show when={provider() === "deepseek"}><label><span>API Key</span><input type="password" class="credential-input" aria-label="API Key" value={apiKey()} placeholder={profileID() ? "留空则保留此档案现有密钥" : "请输入 DeepSeek API Key"} onInput={(event) => setApiKey(event.currentTarget.value)} /></label></Show>
            <label class="model-default-toggle"><input type="checkbox" checked={makeDefault()} disabled={props.busy} onChange={(event) => setMakeDefault(event.currentTarget.checked)} /><span>设为默认模型</span></label>
            <Show when={errorMessage()}>
              <div class="model-config-error">
                <p class="settings-message is-error" role="alert">{errorMessage()}</p>
                <Show when={needsReconciliation() && props.onRetryLoad}>
                  <button type="button" class="settings-button is-ghost" disabled={isMutating()} onClick={() => void reconcile()}>刷新档案列表</button>
                </Show>
              </div>
            </Show>
            <div class="credential-actions">
              <button type="button" class="settings-button is-ghost" disabled={isMutating()} onClick={() => setView("list")}>取消</button>
              <button type="button" class="settings-button" disabled={changesBlocked()} onClick={() => void saveProfile()}>{isSaving() ? "保存中…" : "保存模型配置"}</button>
            </div>
          </div>
        </section>
        </div>
      </Show>
    </section>
  )
}
