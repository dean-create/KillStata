import { DEEPSEEK_DEFAULT_PROVIDER_MODEL, type ProviderID, type ProviderSettings } from "./provider-config"

export type CredentialStatus = {
  /** 当前选中的 provider 对应的 API Key 是否已配置（永不返回 Key 本身）。 */
  configured: boolean
  provider: ProviderID
  model: string
  profileId?: string
  /** custom 提供商才可能返回 baseURL；deepseek 无此字段。 */
  baseURL?: string | null
  smallModel?: string | null
}

export type ProviderModelOption = { id: string; label: string }

export type ModelProfileSummary = {
  id: string
  displayName?: string | null
  provider: ProviderID
  model: string
  baseURL?: string | null
  smallModel?: string | null
  configured: boolean
  isDefault: boolean
}

export type ModelProfilesSnapshot = {
  profiles: ModelProfileSummary[]
  defaultProfileId: string | null
}

export type ModelProfileMutation = {
  profileId: string
  snapshot: ModelProfilesSnapshot
  activeChanged: boolean
}

let profileIDSequence = 0

export function createModelProfileID(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID()
  profileIDSequence += 1
  return `model-${Date.now().toString(36)}-${profileIDSequence.toString(36)}`
}

export interface CredentialStore {
  hasApiKey(): Promise<boolean>
  /** 读取当前 provider 的非秘密配置状态；不会把 Key 返回给 UI。 */
  getStatus?(): Promise<CredentialStatus>
  /** 使用当前草稿凭据读取模型目录；失败不落盘、不改动已保存配置。 */
  discoverModels?(provider: ProviderID, baseURL?: string, apiKey?: string, profileID?: string): Promise<ProviderModelOption[]>
  listProfiles?(): Promise<ModelProfilesSnapshot>
  saveProfile?(settings: ProviderSettings, apiKey?: string, profileID?: string, makeDefault?: boolean, createIfMissing?: boolean, displayName?: string): Promise<ModelProfileMutation>
  setDefaultProfile?(profileID?: string): Promise<ModelProfileMutation>
  deleteProfile?(profileID: string): Promise<ModelProfileMutation>
  /** 桌面端在用户明确开始分析后，才用 Keychain 中的密钥重启受管引擎。 */
  prepareEngineForAnalysis?(): Promise<void>
}

/** 浏览器预览不保存真实密钥，仅维持当前页面的配置状态。 */
export function createDemoCredentialStore(): CredentialStore {
  let configured = false
  let settings: ProviderSettings = { provider: "deepseek", model: DEEPSEEK_DEFAULT_PROVIDER_MODEL }
  let profiles: ModelProfileSummary[] = []
  let defaultProfileId: string | null = null
  const snapshot = (): ModelProfilesSnapshot => ({ profiles: profiles.map((profile) => ({ ...profile })), defaultProfileId })
  return {
    hasApiKey: async () => configured,
    getStatus: async () => ({ configured, ...settings }),
    discoverModels: async (provider) => {
      if (provider === "deepseek") return [
        { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash（默认）" },
        { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      ]
      throw new Error("浏览器预览未连接模型服务，无法读取服务商目录。")
    },
    listProfiles: async () => snapshot(),
    saveProfile: async (nextSettings, apiKey, profileID, makeDefault = false, createIfMissing = profileID === undefined, displayName) => {
      if (apiKey !== undefined && !apiKey.trim()) throw new Error("请输入 API Key")
      const previousDefaultID = defaultProfileId
      const previousActive = profiles.find((profile) => profile.id === defaultProfileId)
      const id = profileID ?? createModelProfileID()
      const index = profiles.findIndex((profile) => profile.id === id)
      if (index < 0 && !createIfMissing) throw new Error("要编辑的模型档案已不存在，请刷新模型管理页。")
      const entry: ModelProfileSummary = {
        id,
        displayName: displayName?.trim() || null,
        ...nextSettings,
        configured: apiKey === undefined ? profiles[index]?.configured ?? false : true,
        isDefault: false,
      }
      if (index < 0) profiles = [...profiles, entry]
      else profiles = profiles.map((profile) => profile.id === id ? entry : profile)
      if (makeDefault) defaultProfileId = id
      else if (profileID && defaultProfileId === id) defaultProfileId = null
      profiles = profiles.map((profile) => ({ ...profile, isDefault: profile.id === defaultProfileId }))
      const nextActive = profiles.find((profile) => profile.id === defaultProfileId)
      const activeChanged = previousDefaultID !== defaultProfileId
        || JSON.stringify(previousActive) !== JSON.stringify(nextActive)
      if (nextActive) {
        settings = { provider: nextActive.provider, model: nextActive.model, baseURL: nextActive.baseURL ?? undefined, smallModel: nextActive.smallModel ?? undefined }
        configured = true
      } else if (activeChanged) {
        settings = { provider: "deepseek", model: DEEPSEEK_DEFAULT_PROVIDER_MODEL }
        configured = false
      }
      return { profileId: id, snapshot: snapshot(), activeChanged }
    },
    setDefaultProfile: async (profileID) => {
      if (profileID && !profiles.some((profile) => profile.id === profileID)) throw new Error("模型档案不存在")
      const activeChanged = defaultProfileId !== (profileID ?? null)
      defaultProfileId = profileID ?? null
      const active = profiles.find((profile) => profile.id === defaultProfileId)
      if (active) {
        settings = { provider: active.provider, model: active.model, baseURL: active.baseURL ?? undefined, smallModel: active.smallModel ?? undefined }
        configured = true
      } else {
        settings = { provider: "deepseek", model: DEEPSEEK_DEFAULT_PROVIDER_MODEL }
        configured = false
      }
      profiles = profiles.map((profile) => ({ ...profile, isDefault: profile.id === defaultProfileId }))
      return { profileId: defaultProfileId ?? "", snapshot: snapshot(), activeChanged }
    },
    deleteProfile: async (profileID) => {
      const wasDefault = defaultProfileId === profileID
      profiles = profiles.filter((profile) => profile.id !== profileID)
      if (wasDefault) defaultProfileId = profiles[0]?.id ?? null
      const active = profiles.find((profile) => profile.id === defaultProfileId)
      if (active) {
        settings = { provider: active.provider, model: active.model, baseURL: active.baseURL ?? undefined, smallModel: active.smallModel ?? undefined }
        configured = true
      } else {
        settings = { provider: "deepseek", model: DEEPSEEK_DEFAULT_PROVIDER_MODEL }
        configured = false
      }
      profiles = profiles.map((profile) => ({ ...profile, isDefault: profile.id === defaultProfileId }))
      return { profileId: profileID, snapshot: snapshot(), activeChanged: wasDefault }
    },
  }
}
