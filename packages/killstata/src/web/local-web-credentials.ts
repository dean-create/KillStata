import { randomUUID } from "node:crypto"
import { open, mkdir, chmod, readFile, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Global } from "../global"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PRO_MODEL_ID } from "../provider/deepseek-policy"

const MAX_PROFILE_FILE_BYTES = 1024 * 1024
const MAX_API_KEY_BYTES = 16 * 1024
const MAX_REQUEST_BYTES = 32 * 1024
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_DISCOVERY_PAGES = 5
const MAX_DISCOVERED_MODELS = 500
const PROVIDER_DEFAULT_BASE_URL: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
}
const PROVIDER_IDS = new Set(["deepseek", "custom", "anthropic", "google"])

type LocalWebProviderID = "deepseek" | "custom" | "anthropic" | "google"
type LocalWebProviderSettings = { provider: LocalWebProviderID; model: string; baseURL?: string; smallModel?: string }
type LocalWebStoredProfile = LocalWebProviderSettings & {
  id: string
  displayName: string | null
  apiKey: string
}
type LocalWebProfileDocument = { version: 1; profiles: LocalWebStoredProfile[]; defaultProfileId: string | null }
type ModelOption = { id: string; label: string }
type ProfileSummary = Omit<LocalWebStoredProfile, "apiKey"> & { configured: boolean; isDefault: boolean }
type ProfilesSnapshot = { profiles: ProfileSummary[]; defaultProfileId: string | null }
type ProfileMutation = { profileId: string; snapshot: ProfilesSnapshot; activeChanged: boolean }
export type LocalWebCredentialStoreOptions = {
  storagePath?: string
  fetcher?: typeof fetch
  activate?: (profile: LocalWebStoredProfile | undefined) => Promise<void>
}

class CredentialRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function errorResponse(error: unknown) {
  const typed = error instanceof CredentialRequestError ? error : undefined
  return Response.json({
    protocolVersion: "v2",
    code: typed?.code ?? "credential_store_failure",
    message: typed?.message ?? "本机模型配置暂时无法处理，请刷新列表后重试。",
    retryable: false,
  }, { status: typed?.status ?? 500 })
}

function invalidRequest(message: string): never {
  throw new CredentialRequestError(400, "invalid_credential_request", message)
}

function validateModelSettings(value: unknown): LocalWebProviderSettings {
  const input = object(value)
  if (!input || typeof input.provider !== "string" || !PROVIDER_IDS.has(input.provider)
    || typeof input.model !== "string" || !input.model.trim() || input.model.length > 256) {
    return invalidRequest("模型服务商或模型 ID 无效。")
  }
  const provider = input.provider as LocalWebProviderID
  const model = input.model.trim()
  if (!model.startsWith(`${provider}/`) || !model.slice(provider.length + 1).trim()) {
    return invalidRequest("模型 ID 必须属于当前服务商。")
  }
  if (provider === "deepseek" && ![
    `${provider}/${DEEPSEEK_DEFAULT_MODEL_ID}`,
    `${provider}/${DEEPSEEK_PRO_MODEL_ID}`,
  ].includes(model)) {
    return invalidRequest("DeepSeek 只支持内置的 V4 Flash 与 V4 Pro 模型。")
  }

  const base = typeof input.baseUrl === "string" ? input.baseUrl.trim() : ""
  let baseURL: string | undefined
  if (provider !== "deepseek") {
    const raw = base || PROVIDER_DEFAULT_BASE_URL[provider] || ""
    let parsed: URL
    try { parsed = new URL(raw) } catch { return invalidRequest("请填写合法的服务商 Base URL。") }
    const host = parsed.hostname.toLowerCase()
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")
    if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return invalidRequest("Base URL 必须使用 HTTPS；仅本机回环地址允许 HTTP，且不能包含凭据、查询参数或片段。")
    }
    baseURL = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`
  }

  let smallModel: string | undefined
  if (input.smallModel !== undefined && input.smallModel !== null && input.smallModel !== "") {
    if (typeof input.smallModel !== "string" || !input.smallModel.startsWith(`${provider}/`) || input.smallModel.length > 256) {
      return invalidRequest("小模型必须属于当前服务商。")
    }
    smallModel = input.smallModel.trim()
    if (provider === "deepseek" && ![
      `${provider}/${DEEPSEEK_DEFAULT_MODEL_ID}`,
      `${provider}/${DEEPSEEK_PRO_MODEL_ID}`,
    ].includes(smallModel)) return invalidRequest("DeepSeek 小模型必须使用内置 V4 模型。")
  }
  return { provider, model, ...(baseURL ? { baseURL } : {}), ...(smallModel ? { smallModel } : {}) }
}

function emptyDocument(): LocalWebProfileDocument {
  return { version: 1, profiles: [], defaultProfileId: null }
}

function validateDocument(value: unknown): LocalWebProfileDocument {
  const input = object(value)
  if (!input || input.version !== 1 || !Array.isArray(input.profiles) || input.profiles.length > 100
    || (input.defaultProfileId !== null && typeof input.defaultProfileId !== "string")) {
    throw new CredentialRequestError(500, "credential_store_invalid", "本机模型档案文件格式无效。")
  }
  const profiles: LocalWebStoredProfile[] = []
  for (const raw of input.profiles) {
    const profile = object(raw)
    if (!profile || typeof profile.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(profile.id)
      || typeof profile.displayName !== "string" && profile.displayName !== null
      || typeof profile.apiKey !== "string" || Buffer.byteLength(profile.apiKey, "utf8") > MAX_API_KEY_BYTES) {
      throw new CredentialRequestError(500, "credential_store_invalid", "本机模型档案文件格式无效。")
    }
    const settings = validateModelSettings({
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseURL,
      smallModel: profile.smallModel,
    })
    profiles.push({
      id: profile.id,
      displayName: profile.displayName,
      ...settings,
      apiKey: profile.apiKey,
    })
  }
  const defaultProfileId = input.defaultProfileId as string | null
  if (defaultProfileId !== null && !profiles.some((profile) => profile.id === defaultProfileId)) {
    throw new CredentialRequestError(500, "credential_store_invalid", "本机模型档案缺少默认档案。")
  }
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new CredentialRequestError(500, "credential_store_invalid", "本机模型档案包含重复 ID。")
  }
  return { version: 1, profiles, defaultProfileId }
}

async function readDocument(storagePath: string): Promise<LocalWebProfileDocument> {
  try {
    const metadata = await stat(storagePath)
    if (metadata.size > MAX_PROFILE_FILE_BYTES) {
      throw new CredentialRequestError(500, "credential_store_too_large", "本机模型档案文件超过安全上限。")
    }
    return validateDocument(JSON.parse(await readFile(storagePath, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument()
    if (error instanceof CredentialRequestError) throw error
    throw new CredentialRequestError(500, "credential_store_unreadable", "本机模型档案无法读取，请检查配置文件后重试。")
  }
}

async function writeDocument(storagePath: string, document: LocalWebProfileDocument) {
  const directory = path.dirname(storagePath)
  const serialized = JSON.stringify(document, null, 2)
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROFILE_FILE_BYTES) {
    throw new CredentialRequestError(413, "credential_store_too_large", "本机模型档案超过安全上限。")
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporaryPath = `${storagePath}.tmp-${process.pid}-${randomUUID()}`
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(temporaryPath, "wx", 0o600)
    await file.writeFile(serialized, "utf8")
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporaryPath, storagePath)
    await chmod(storagePath, 0o600)
  } catch {
    await file?.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw new CredentialRequestError(500, "credential_store_write_failed", "无法安全保存本机模型档案。")
  }
}

function snapshot(document: LocalWebProfileDocument): ProfilesSnapshot {
  return {
    profiles: document.profiles.map(({ apiKey, ...profile }) => ({
      ...profile,
      configured: Boolean(apiKey),
      isDefault: profile.id === document.defaultProfileId,
    })),
    defaultProfileId: document.defaultProfileId,
  }
}

function activeProfile(document: LocalWebProfileDocument) {
  return document.profiles.find((profile) => profile.id === document.defaultProfileId)
}

function activeChanged(before: LocalWebStoredProfile | undefined, after: LocalWebStoredProfile | undefined) {
  if (!before || !after) return before?.id !== after?.id
  return JSON.stringify([before.id, before.provider, before.model, before.baseURL, before.smallModel, before.apiKey])
    !== JSON.stringify([after.id, after.provider, after.model, after.baseURL, after.smallModel, after.apiKey])
}

function validProfileID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

async function requestJSON(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length"))
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    throw new CredentialRequestError(413, "request_too_large", "模型配置请求超过安全上限。")
  }
  let text: string
  try { text = await request.text() } catch { throw new CredentialRequestError(400, "invalid_request", "模型配置请求格式无效。") }
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
    throw new CredentialRequestError(413, "request_too_large", "模型配置请求超过安全上限。")
  }
  try {
    const parsed = object(JSON.parse(text))
    if (!parsed) throw new Error("invalid")
    return parsed
  } catch {
    throw new CredentialRequestError(400, "invalid_request", "模型配置请求格式无效。")
  }
}

function profileMutation(profileID: string, document: LocalWebProfileDocument, changed: boolean): ProfileMutation {
  return { profileId: profileID, snapshot: snapshot(document), activeChanged: changed }
}

function discoveryEndpoint(provider: string, baseURL: string, cursor?: string) {
  const endpoint = new URL(baseURL)
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/models`
  if (provider === "anthropic") {
    endpoint.searchParams.set("limit", "1000")
    if (cursor) endpoint.searchParams.set("after_id", cursor)
  } else if (provider === "google") {
    endpoint.searchParams.set("pageSize", "1000")
    if (cursor) endpoint.searchParams.set("pageToken", cursor)
  }
  return endpoint.toString()
}

async function boundedBody(response: Response) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new CredentialRequestError(413, "provider_response_too_large", "模型目录响应超过 2 MB 安全上限，已停止读取。")
  }
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new CredentialRequestError(413, "provider_response_too_large", "模型目录响应超过 2 MB 安全上限，已停止读取。")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

function providerHTTPError(status: number) {
  if (status === 401 || status === 403) return "API Key 无效或没有读取模型目录的权限，请检查密钥与服务商账户权限。"
  if (status === 404) return "服务商未提供对应协议的模型目录接口；请检查服务商类型和 Base URL。"
  if (status === 429) return "服务商正在限流，稍后再加载模型目录。"
  if (status >= 500) return "服务商暂时不可用，模型目录没有加载；现有配置未更改。"
  return `读取模型目录失败，服务商返回 HTTP ${status}。`
}

function parseDiscoveryPage(provider: string, value: unknown) {
  const root = object(value)
  if (!root) throw new CredentialRequestError(502, "invalid_model_catalog", "模型目录格式无法识别；请检查服务商类型和 Base URL。")
  const entries = provider === "google" ? root.models : root.data
  if (!Array.isArray(entries)) throw new CredentialRequestError(502, "invalid_model_catalog", "模型目录响应中缺少模型列表。")
  const models: ModelOption[] = []
  for (const entryValue of entries) {
    const entry = object(entryValue)
    if (!entry) continue
    let rawID: unknown = entry.id
    let label: unknown = entry.display_name
    if (provider === "google") {
      const methods = entry.supportedGenerationMethods
      if (!Array.isArray(methods) || !methods.includes("generateContent")) continue
      const rawName = typeof entry.name === "string" ? entry.name.replace(/^models\//, "") : undefined
      rawID = typeof entry.baseModelId === "string" ? entry.baseModelId : rawName
      label = entry.displayName
    }
    if (typeof rawID !== "string" || !rawID.trim() || rawID.length > 256) continue
    const id = `${provider}/${rawID.trim()}`
    if (models.some((model) => model.id === id)) continue
    models.push({ id, label: typeof label === "string" && label.trim() ? label.trim().slice(0, 256) : rawID.trim() })
  }
  let cursor: string | undefined
  let hasMore = false
  if (provider === "anthropic") {
    hasMore = root.has_more === true
    if (typeof root.last_id === "string") cursor = root.last_id
    if (hasMore && !cursor) throw new CredentialRequestError(502, "invalid_model_catalog", "Anthropic 模型目录缺少分页游标。")
  } else if (provider === "google" && typeof root.nextPageToken === "string") {
    cursor = root.nextPageToken
    hasMore = true
  }
  return { models, cursor, hasMore }
}

async function discoverProviderModels(input: {
  provider: LocalWebProviderID
  baseURL?: string
  apiKey?: string
}, fetcher: typeof fetch): Promise<ModelOption[]> {
  if (input.provider === "deepseek") return [
    { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash（默认）" },
    { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  ]
  if (!input.baseURL || !input.apiKey) invalidRequest("请输入服务商 Base URL 和 API Key。")
  const headers = new Headers({ Accept: "application/json" })
  if (input.provider === "custom") headers.set("Authorization", `Bearer ${input.apiKey}`)
  else if (input.provider === "anthropic") {
    headers.set("x-api-key", input.apiKey)
    headers.set("anthropic-version", "2023-06-01")
  } else headers.set("x-goog-api-key", input.apiKey)

  const models: ModelOption[] = []
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < MAX_DISCOVERY_PAGES; pageNumber += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    let response: Response
    let body: string
    try {
      response = await fetcher(discoveryEndpoint(input.provider, input.baseURL, cursor), {
        method: "GET", headers, signal: controller.signal, redirect: "error",
      })
      if (!response.ok) throw new CredentialRequestError(502, "provider_catalog_failed", providerHTTPError(response.status))
      body = await boundedBody(response)
    } catch (error) {
      if (error instanceof CredentialRequestError) throw error
      throw new CredentialRequestError(502, "provider_catalog_unavailable", error instanceof Error && error.name === "AbortError"
        ? "连接模型服务超时，请检查网络后重试。"
        : "无法连接模型服务，请检查网络和 Base URL。")
    } finally {
      clearTimeout(timer)
    }
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { throw new CredentialRequestError(502, "invalid_model_catalog", "模型目录格式无法识别；请检查服务商类型和 Base URL。") }
    const page = parseDiscoveryPage(input.provider, parsed)
    for (const model of page.models) if (!models.some((existing) => existing.id === model.id)) models.push(model)
    if (models.length > MAX_DISCOVERED_MODELS) throw new CredentialRequestError(502, "too_many_models", "服务商返回的模型过多，超过安全上限。")
    if (!page.hasMore) break
    if (!page.cursor || pageNumber + 1 === MAX_DISCOVERY_PAGES) throw new CredentialRequestError(502, "too_many_model_pages", "模型目录分页超过安全上限，未能完整导入。")
    cursor = page.cursor
  }
  if (!models.length) throw new CredentialRequestError(422, "empty_model_catalog", "该 API Key 没有返回可用于对话的模型。请检查服务商权限。")
  return models
}

export function createLocalWebCredentialStore(options: LocalWebCredentialStoreOptions = {}) {
  const storagePath = options.storagePath ?? path.join(Global.Path.data, "web-model-profiles.json")
  const fetcher = options.fetcher ?? fetch
  const activate = options.activate ?? (async () => {})
  let mutationQueue = Promise.resolve()
  const serializeMutation = <T>(operation: () => Promise<T>) => {
    const current = mutationQueue.then(operation)
    mutationQueue = current.then(() => undefined, () => undefined)
    return current
  }
  const read = () => readDocument(storagePath)
  const write = (document: LocalWebProfileDocument) => writeDocument(storagePath, document)

  async function saveProfile(input: Record<string, unknown>): Promise<ProfileMutation> {
    return serializeMutation(async () => {
      const document = await read()
      const settings = validateModelSettings(input.config)
      const requestedID = input.profileId
      if (requestedID !== null && requestedID !== undefined && !validProfileID(requestedID)) invalidRequest("模型档案 ID 无效。")
      const existing = requestedID ? document.profiles.find((profile) => profile.id === requestedID) : undefined
      const createIfMissing = input.createIfMissing === true
      if (!existing && requestedID && !createIfMissing) {
        throw new CredentialRequestError(404, "profile_not_found", "要编辑的模型档案已不存在，请刷新模型管理页。")
      }
      const id = existing?.id ?? (validProfileID(requestedID) ? requestedID : randomUUID())
      if (!existing && document.profiles.length >= 100) throw new CredentialRequestError(409, "profile_limit", "模型档案数量已达到上限。")
      const suppliedKey = input.apiKey === null || input.apiKey === undefined ? undefined : input.apiKey
      if (suppliedKey !== undefined && typeof suppliedKey !== "string") invalidRequest("API Key 无效。")
      const apiKey = suppliedKey === undefined ? existing?.apiKey ?? "" : suppliedKey.trim()
      if (Buffer.byteLength(apiKey, "utf8") > MAX_API_KEY_BYTES || /[\u0000-\u001f\u007f]/.test(apiKey)) invalidRequest("API Key 无效。")
      if (!apiKey) throw new CredentialRequestError(400, "api_key_required", "此模型档案尚未配置 API Key，请输入密钥后再保存。")
      const displayName = typeof input.displayName === "string" ? input.displayName.trim().slice(0, 160) : ""
      const profile: LocalWebStoredProfile = { id, displayName: displayName || null, ...settings, apiKey }
      const previousActive = activeProfile(document)
      const previousDefaultID = document.defaultProfileId
      const previousIndex = document.profiles.findIndex((item) => item.id === id)
      if (previousIndex < 0) document.profiles.push(profile)
      else document.profiles[previousIndex] = profile
      if (input.makeDefault === true) document.defaultProfileId = id
      else if (requestedID && previousDefaultID === id) document.defaultProfileId = null
      const changed = activeChanged(previousActive, activeProfile(document))
      await write(document)
      return profileMutation(id, document, changed)
    })
  }

  async function setDefaultProfile(input: Record<string, unknown>): Promise<ProfileMutation> {
    return serializeMutation(async () => {
      const document = await read()
      const requestedID = input.profileId
      if (requestedID !== null && requestedID !== undefined && !validProfileID(requestedID)) invalidRequest("模型档案 ID 无效。")
      if (requestedID && !document.profiles.some((profile) => profile.id === requestedID)) {
        throw new CredentialRequestError(404, "profile_not_found", "模型档案不存在，请刷新档案列表。")
      }
      const before = activeProfile(document)
      const nextID = typeof requestedID === "string" ? requestedID : null
      const changed = document.defaultProfileId !== nextID
      if (!changed) return profileMutation(nextID ?? "", document, false)
      document.defaultProfileId = nextID
      await write(document)
      const after = activeProfile(document)
      return profileMutation(nextID ?? "", document, activeChanged(before, after))
    })
  }

  async function deleteProfile(id: string): Promise<ProfileMutation> {
    return serializeMutation(async () => {
      if (!validProfileID(id)) invalidRequest("模型档案 ID 无效。")
      const document = await read()
      const index = document.profiles.findIndex((profile) => profile.id === id)
      if (index < 0) throw new CredentialRequestError(404, "profile_not_found", "模型档案不存在，请刷新档案列表。")
      const before = activeProfile(document)
      const wasDefault = document.defaultProfileId === id
      document.profiles.splice(index, 1)
      if (wasDefault) document.defaultProfileId = document.profiles[0]?.id ?? null
      const after = activeProfile(document)
      const changed = activeChanged(before, after)
      await write(document)
      return profileMutation(id, document, changed)
    })
  }

  async function discover(input: Record<string, unknown>) {
    if (typeof input.provider !== "string" || !PROVIDER_IDS.has(input.provider)) invalidRequest("模型服务商无效。")
    const provider = input.provider as LocalWebProviderID
    if (provider === "deepseek") return discoverProviderModels({ provider }, fetcher)
    const rawBaseURL = typeof input.baseUrl === "string" ? input.baseUrl.trim() : ""
    const settings = validateModelSettings({
      provider,
      model: `${provider}/catalog-probe`,
      baseUrl: rawBaseURL || PROVIDER_DEFAULT_BASE_URL[provider],
    })
    let apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : ""
    const profileID = input.profileId
    if (profileID !== null && profileID !== undefined && !validProfileID(profileID)) invalidRequest("模型档案 ID 无效。")
    if (!apiKey && profileID) {
      const document = await read()
      const profile = document.profiles.find((item) => item.id === profileID)
      if (!profile || profile.provider !== provider) throw new CredentialRequestError(404, "profile_not_found", "请输入当前服务商的 API Key，再读取模型目录。")
      if ((profile.baseURL ?? "") !== (settings.baseURL ?? "")) {
        throw new CredentialRequestError(400, "endpoint_changed", "Base URL 已更改。为避免把原 API Key 发往新地址，请重新输入该服务商的 API Key。")
      }
      apiKey = profile.apiKey
    }
    if (!apiKey) invalidRequest("请输入该服务商的 API Key，再读取模型目录。")
    return discoverProviderModels({ provider, baseURL: settings.baseURL, apiKey }, fetcher)
  }

  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/api/v2/credentials")) return undefined
    try {
      if (url.pathname === "/api/v2/credentials/profiles" && request.method === "GET") {
        return Response.json(snapshot(await read()))
      }
      if (url.pathname === "/api/v2/credentials/status" && request.method === "GET") {
        const document = await read()
        const active = activeProfile(document)
        return Response.json(active
          ? { configured: Boolean(active.apiKey), provider: active.provider, model: active.model, profileId: active.id, baseURL: active.baseURL ?? null, smallModel: active.smallModel ?? null }
          : { configured: false, provider: "deepseek", model: `deepseek/${DEEPSEEK_DEFAULT_MODEL_ID}` })
      }
      if (url.pathname === "/api/v2/credentials/profiles" && request.method === "POST") {
        return Response.json(await saveProfile(await requestJSON(request)))
      }
      if (url.pathname === "/api/v2/credentials/default" && request.method === "POST") {
        return Response.json(await setDefaultProfile(await requestJSON(request)))
      }
      if (url.pathname === "/api/v2/credentials/discover" && request.method === "POST") {
        return Response.json(await discover(await requestJSON(request)))
      }
      if (url.pathname === "/api/v2/credentials/activate" && request.method === "POST") {
        const document = await read()
        const active = activeProfile(document)
        if (!active?.apiKey) throw new CredentialRequestError(409, "model_profile_required", "请先在模型管理中配置一个默认模型和 API Key。")
        await activate(active)
        return Response.json({ activated: true })
      }
      const deleteMatch = url.pathname.match(/^\/api\/v2\/credentials\/profiles\/([^/]+)$/)
      if (deleteMatch && request.method === "DELETE") {
        let id: string
        try { id = decodeURIComponent(deleteMatch[1]) } catch { invalidRequest("模型档案 ID 无效。") }
        return Response.json(await deleteProfile(id!))
      }
      if (url.pathname.startsWith("/api/v2/credentials/")) return errorResponse(new CredentialRequestError(404, "route_not_found", "本机凭据 API 路径不存在。"))
      return undefined
    } catch (error) {
      return errorResponse(error)
    }
  }

  return {
    handle,
    async activateDefault() {
      const document = await read()
      await activate(activeProfile(document))
    },
  }
}

export type { LocalWebStoredProfile, LocalWebProviderSettings, ProfileSummary as LocalWebProfileSummary, ProfilesSnapshot as LocalWebProfilesSnapshot, ProfileMutation as LocalWebProfileMutation }
