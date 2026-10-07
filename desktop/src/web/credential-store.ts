import type {
  CredentialStatus,
  CredentialStore,
  ModelProfileMutation,
  ModelProfilesSnapshot,
  ProviderModelOption,
} from "../credentials"
import type { ProviderID, ProviderSettings } from "../provider-config"

type WebCredentialFetch = typeof fetch

export function createWebCredentialStore(fetcher: WebCredentialFetch = fetch): CredentialStore {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(path, {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...init?.headers },
    })
    const body = await response.json().catch(() => undefined) as { message?: unknown } | T | undefined
    if (!response.ok) {
      const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : "本机模型服务暂时无法处理请求。"
      throw new Error(message.slice(0, 500))
    }
    return body as T
  }

  let mutationInFlight = false
  let requiresReconciliation = false
  let coreRefreshPending = false
  let lastKnownSnapshot: ModelProfilesSnapshot | undefined
  const activeProfile = (value: ModelProfilesSnapshot | undefined) => {
    const profile = value?.profiles.find((item) => item.id === value.defaultProfileId)
    return profile
      ? JSON.stringify([profile.id, profile.provider, profile.model, profile.baseURL, profile.smallModel, profile.configured])
      : ""
  }
  const refreshCoreCredentials = async () => {
    await request<{ activated: boolean }>("/api/v2/credentials/activate", { method: "POST" })
  }
  const listProfiles = async () => {
    const snapshot = await request<ModelProfilesSnapshot>("/api/v2/credentials/profiles")
    if (requiresReconciliation && (
      coreRefreshPending || (lastKnownSnapshot !== undefined && activeProfile(snapshot) !== activeProfile(lastKnownSnapshot))
    )) {
      await refreshCoreCredentials()
    }
    lastKnownSnapshot = snapshot
    coreRefreshPending = false
    requiresReconciliation = false
    return snapshot
  }
  const mutate = async (operation: () => Promise<ModelProfileMutation>, mayAffectActive = false) => {
    if (mutationInFlight) throw new Error("模型档案操作正在进行中，请等待完成。")
    if (requiresReconciliation) throw new Error("模型档案保存状态尚未核对，请先刷新档案列表。")
    mutationInFlight = true
    try {
      const mutation = await operation()
      if (mutation.activeChanged) {
        coreRefreshPending = true
        await refreshCoreCredentials()
        coreRefreshPending = false
      }
      lastKnownSnapshot = mutation.snapshot
      return mutation
    } catch (error) {
      coreRefreshPending ||= mayAffectActive
      requiresReconciliation = true
      throw error
    } finally {
      mutationInFlight = false
    }
  }

  return {
    async hasApiKey() {
      const snapshot = await request<ModelProfilesSnapshot>("/api/v2/credentials/profiles")
      return snapshot.profiles.find((profile) => profile.id === snapshot.defaultProfileId)?.configured ?? false
    },
    getStatus: () => request<CredentialStatus>("/api/v2/credentials/status"),
    discoverModels: (provider: ProviderID, baseURL, apiKey, profileID) => request<ProviderModelOption[]>(
      "/api/v2/credentials/discover",
      {
        method: "POST",
        body: JSON.stringify({ provider, baseUrl: baseURL ?? null, apiKey: apiKey?.trim() || null, profileId: profileID ?? null }),
      },
    ),
    listProfiles,
    saveProfile: (
      settings: ProviderSettings,
      apiKey,
      profileID,
      makeDefault = false,
      createIfMissing = profileID === undefined,
      displayName,
    ) => mutate(() => request<ModelProfileMutation>("/api/v2/credentials/profiles", {
      method: "POST",
      body: JSON.stringify({
        config: {
          provider: settings.provider,
          model: settings.model,
          baseUrl: settings.baseURL ?? null,
          smallModel: settings.smallModel ?? null,
        },
        profileId: profileID ?? null,
        createIfMissing,
        apiKey: apiKey?.trim() || null,
        makeDefault,
        displayName: displayName?.trim() || null,
      }),
    }), makeDefault || lastKnownSnapshot === undefined || profileID === lastKnownSnapshot.defaultProfileId),
    setDefaultProfile: (profileID) => mutate(() => request<ModelProfileMutation>("/api/v2/credentials/default", {
      method: "POST",
      body: JSON.stringify({ profileId: profileID ?? null }),
    }), true),
    deleteProfile: (profileID) => mutate(() => request<ModelProfileMutation>(
      `/api/v2/credentials/profiles/${encodeURIComponent(profileID)}`,
      { method: "DELETE" },
    ), lastKnownSnapshot === undefined || profileID === lastKnownSnapshot.defaultProfileId),
    prepareEngineForAnalysis: refreshCoreCredentials,
  }
}

/** Share visitors can use the host's configured model, but cannot read or change its API Key. */
export function createSharedWebCredentialStore(fetcher: WebCredentialFetch = fetch): CredentialStore {
  const store = createWebCredentialStore(fetcher)
  const sharedStatus = async (): Promise<CredentialStatus> => {
    const status = await store.getStatus!()
    return {
      configured: status.configured,
      provider: status.provider,
      model: status.model,
      ...(status.configured ? { profileId: "shared-host-profile" } : {}),
    }
  }
  return {
    hasApiKey: async () => (await sharedStatus()).configured,
    getStatus: sharedStatus,
    listProfiles: async () => {
      const status = await sharedStatus()
      if (!status.configured) return { profiles: [], defaultProfileId: null }
      const profileId = status.profileId!
      return {
        profiles: [{
          id: profileId,
          displayName: "分享主机模型",
          provider: status.provider,
          model: status.model,
          configured: true,
          isDefault: true,
        }],
        defaultProfileId: profileId,
      }
    },
    prepareEngineForAnalysis: () => store.prepareEngineForAnalysis!(),
  }
}
