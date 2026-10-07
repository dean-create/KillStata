import type {
  CredentialStatus,
  CredentialStore,
  ModelProfilesSnapshot,
  ModelProfileMutation,
  ProviderModelOption,
} from "./credentials"
import type { ProviderID, ProviderSettings } from "./provider-config"

export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export function createTauriCredentialStore(
  invokeTauri: TauriInvoke,
  onCoreRestart?: () => void,
): CredentialStore {
  const invoke = async <T>(command: string, args?: Record<string, unknown>) => await invokeTauri(command, args) as T
  const restartCore = async (command: string) => {
    await invoke<void>(command)
    onCoreRestart?.()
  }
  const refreshCoreCredentials = () => restartCore("refresh_core_credentials")
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
  const listProfiles = async () => {
    const snapshot = await invoke<ModelProfilesSnapshot>("list_provider_profiles")
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
  const hasConfiguredDefault = async () => {
    const profiles = await invoke<ModelProfilesSnapshot>("list_provider_profiles")
    return profiles.profiles.find((profile) => profile.id === profiles.defaultProfileId)?.configured ?? false
  }
  const saveProfile: NonNullable<CredentialStore["saveProfile"]> = async (
    settings: ProviderSettings,
    apiKey,
    profileID,
    makeDefault = false,
    createIfMissing = profileID === undefined,
    displayName,
  ) => mutate(() => invoke<ModelProfileMutation>("save_provider_profile", {
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
    }), makeDefault || lastKnownSnapshot === undefined || profileID === lastKnownSnapshot.defaultProfileId)
  const setDefaultProfile: NonNullable<CredentialStore["setDefaultProfile"]> = async (profileID) => mutate(
    () => invoke<ModelProfileMutation>("set_default_provider_profile", {
      profileId: profileID ?? null,
    }),
    true,
  )
  const deleteProfile: NonNullable<CredentialStore["deleteProfile"]> = async (profileID) => mutate(
    () => invoke<ModelProfileMutation>("delete_provider_profile", {
      profileId: profileID,
    }),
    lastKnownSnapshot === undefined || profileID === lastKnownSnapshot.defaultProfileId,
  )

  return {
    hasApiKey: hasConfiguredDefault,
    getStatus: () => invoke<CredentialStatus>("credential_status"),
    discoverModels: (provider: ProviderID, baseURL, apiKey, profileID) => invoke<ProviderModelOption[]>("discover_provider_models", {
      provider,
      baseUrl: baseURL ?? null,
      apiKey: apiKey?.trim() || null,
      profileId: profileID ?? null,
    }),
    listProfiles,
    saveProfile,
    setDefaultProfile,
    deleteProfile,
    prepareEngineForAnalysis: () => restartCore("activate_core_credentials"),
  }
}
