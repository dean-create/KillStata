import { describe, expect, test, vi } from "vitest"
import type { ModelProfilesSnapshot, ProviderModelOption } from "./credentials"
import { createTauriCredentialStore, type TauriInvoke } from "./tauri-credentials"

const snapshot: ModelProfilesSnapshot = {
  profiles: [
    { id: "profile-a", provider: "custom", model: "custom/model-a", baseURL: "https://api.example/v1", configured: true, isDefault: true },
    { id: "profile-b", provider: "anthropic", model: "anthropic/model-b", configured: true, isDefault: false },
  ],
  defaultProfileId: "profile-a",
}

function invokeStub(responses: Record<string, unknown>) {
  return vi.fn<TauriInvoke>(async <T>(command: string, _args?: Record<string, unknown>): Promise<T> => {
    if (!(command in responses)) throw new Error(`unexpected Tauri command: ${command}`)
    return responses[command] as T
  })
}

describe("Tauri model-profile IPC contract", () => {
  test("lists profiles and derives API-key status only from the configured default", async () => {
    const invoke = invokeStub({
      list_provider_profiles: snapshot,
      credential_status: { configured: true, profileId: "profile-a", provider: "custom", model: "custom/model-a" },
    })
    const store = createTauriCredentialStore(invoke)

    expect(await store.listProfiles?.()).toEqual(snapshot)
    expect(await store.hasApiKey()).toBe(true)
    expect(await store.getStatus?.()).toEqual({ configured: true, profileId: "profile-a", provider: "custom", model: "custom/model-a" })
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "list_provider_profiles",
      "list_provider_profiles",
      "credential_status",
    ])
  })

  test("sends the saved-profile fields using the Rust IPC camelCase contract and restarts only when active changed", async () => {
    const mutation = { profileId: "profile-b", snapshot, activeChanged: true }
    const invoke = invokeStub({ save_provider_profile: mutation, refresh_core_credentials: undefined })
    const invalidateEvents = vi.fn()
    const store = createTauriCredentialStore(invoke, invalidateEvents)

    const result = await store.saveProfile?.(
      { provider: "custom", model: "custom/model-b", baseURL: "https://api.example/v1", smallModel: "custom/small" },
      "  secret-key  ",
      "profile-b",
      true,
      false,
      "  工作中转  ",
    )

    expect(invoke).toHaveBeenNthCalledWith(1, "save_provider_profile", {
        config: { provider: "custom", model: "custom/model-b", baseUrl: "https://api.example/v1", smallModel: "custom/small" },
        profileId: "profile-b",
        createIfMissing: false,
        apiKey: "secret-key",
        makeDefault: true,
        displayName: "工作中转",
    })
    expect(invoke).toHaveBeenNthCalledWith(2, "refresh_core_credentials", undefined)
    expect(result).toEqual(mutation)
    expect(JSON.stringify(result)).not.toContain("secret-key")
    expect(invalidateEvents).toHaveBeenCalledOnce()
  })

  test("does not restart Core after saving a non-default profile", async () => {
    const mutation = { profileId: "profile-b", snapshot, activeChanged: false }
    const invoke = invokeStub({ save_provider_profile: mutation })
    const store = createTauriCredentialStore(invoke)

    await store.saveProfile?.(
      { provider: "anthropic", model: "anthropic/model-b" },
      "draft-key",
      "profile-b",
      false,
      false,
      "备用",
    )

    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["save_provider_profile"])
  })

  test("switches default and deletes profiles with Core restart gated by activeChanged", async () => {
    const changed = { profileId: "profile-b", snapshot, activeChanged: true }
    const unchanged = { profileId: "profile-b", snapshot, activeChanged: false }
    const invoke = invokeStub({
      set_default_provider_profile: changed,
      delete_provider_profile: unchanged,
      refresh_core_credentials: undefined,
    })
    const store = createTauriCredentialStore(invoke)

    expect(await store.setDefaultProfile?.("profile-b")).toEqual(changed)
    expect(await store.deleteProfile?.("profile-b")).toEqual(unchanged)
    expect(invoke).toHaveBeenNthCalledWith(1, "set_default_provider_profile", { profileId: "profile-b" })
    expect(invoke).toHaveBeenNthCalledWith(2, "refresh_core_credentials", undefined)
    expect(invoke).toHaveBeenNthCalledWith(3, "delete_provider_profile", { profileId: "profile-b" })
  })

  test("discovers models using only the selected profile reference and explicit draft credential", async () => {
    const models: ProviderModelOption[] = [{ id: "anthropic/model-b", label: "Model B" }]
    const invoke = invokeStub({ discover_provider_models: models })
    const store = createTauriCredentialStore(invoke)

    expect(await store.discoverModels?.("anthropic", "https://api.anthropic.com/v1", "draft-secret", "profile-b")).toEqual(models)
    expect(invoke.mock.calls).toEqual([[
      "discover_provider_models",
      { provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "draft-secret", profileId: "profile-b" },
    ]])
  })

  test("activates saved credentials only through the explicit analysis action", async () => {
    const invoke = invokeStub({ activate_core_credentials: undefined })
    const store = createTauriCredentialStore(invoke)

    await store.prepareEngineForAnalysis?.()

    expect(invoke).toHaveBeenCalledWith("activate_core_credentials", undefined)
  })

  test("does not invalidate the Core event bus if credential restart fails", async () => {
    const invoke = vi.fn<TauriInvoke>(async <T>(command: string): Promise<T> => {
      if (command === "set_default_provider_profile") return { profileId: "profile-b", snapshot, activeChanged: true } as T
      if (command === "refresh_core_credentials") throw new Error("Core restart failed")
      throw new Error(`unexpected Tauri command: ${command}`)
    }) as ReturnType<typeof vi.fn<TauriInvoke>>
    const invalidateEvents = vi.fn()
    const store = createTauriCredentialStore(invoke, invalidateEvents)

    await expect(store.setDefaultProfile?.("profile-b")).rejects.toThrow("Core restart failed")

    expect(invalidateEvents).not.toHaveBeenCalled()
  })

  test("a timed-out mutation blocks later writes until the saved state is read again", async () => {
    const mutation = { profileId: "profile-b", snapshot, activeChanged: false }
    const invoke = vi.fn<TauriInvoke>(async <T>(command: string): Promise<T> => {
      if (command === "save_provider_profile") throw new Error("写入模型档案超时")
      if (command === "list_provider_profiles") return snapshot as T
      if (command === "set_default_provider_profile") return mutation as T
      throw new Error(`unexpected Tauri command: ${command}`)
    })
    const store = createTauriCredentialStore(invoke)

    await store.listProfiles?.()
    await expect(store.saveProfile?.({ provider: "custom", model: "custom/model-b", baseURL: "https://api.example/v1" }, "key")).rejects.toThrow("超时")
    await expect(store.setDefaultProfile?.("profile-b")).rejects.toThrow(/刷新|核对/)
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["list_provider_profiles", "save_provider_profile"])
    await store.listProfiles?.()
    await expect(store.setDefaultProfile?.("profile-b")).resolves.toEqual(mutation)
  })

  test("does not start a second profile mutation while the first is unresolved", async () => {
    let finishFirst!: (value: unknown) => void
    const first = new Promise<unknown>((resolve) => { finishFirst = resolve })
    const mutation = { profileId: "profile-b", snapshot, activeChanged: false }
    const invoke = vi.fn<TauriInvoke>(async (command: string) => {
      if (command === "set_default_provider_profile") return first
      throw new Error(`unexpected Tauri command: ${command}`)
    })
    const store = createTauriCredentialStore(invoke)

    const pending = store.setDefaultProfile?.("profile-b")
    await expect(store.setDefaultProfile?.("profile-a")).rejects.toThrow(/进行中/)
    expect(invoke).toHaveBeenCalledTimes(1)
    finishFirst(mutation)
    await expect(pending).resolves.toEqual(mutation)
  })

  test("reconciles a default changed by a late write before unlocking profile mutations", async () => {
    const changedSnapshot: ModelProfilesSnapshot = {
      ...snapshot,
      profiles: snapshot.profiles.map((profile) => ({ ...profile, isDefault: profile.id === "profile-b" })),
      defaultProfileId: "profile-b",
    }
    let reads = 0
    const invoke = vi.fn<TauriInvoke>(async (command: string) => {
      if (command === "list_provider_profiles") return ++reads === 1 ? snapshot : changedSnapshot
      if (command === "set_default_provider_profile") throw new Error("切换默认模型超时")
      if (command === "refresh_core_credentials") return undefined
      throw new Error(`unexpected Tauri command: ${command}`)
    })
    const store = createTauriCredentialStore(invoke)
    await store.listProfiles?.()
    await expect(store.setDefaultProfile?.("profile-b")).rejects.toThrow("超时")
    expect(await store.listProfiles?.()).toEqual(changedSnapshot)
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "list_provider_profiles", "set_default_provider_profile", "list_provider_profiles", "refresh_core_credentials",
    ])
  })

  test("keeps mutation state uncertain when Core refresh fails after the Keychain write", async () => {
    const changed = { profileId: "profile-b", snapshot, activeChanged: true }
    let refreshAttempts = 0
    const invoke = vi.fn<TauriInvoke>(async (command: string) => {
      if (command === "set_default_provider_profile") return changed
      if (command === "refresh_core_credentials" && ++refreshAttempts === 1) throw new Error("Core failed to start")
      if (command === "refresh_core_credentials") return undefined
      if (command === "list_provider_profiles") return snapshot
      throw new Error(`unexpected Tauri command: ${command}`)
    })
    const store = createTauriCredentialStore(invoke)
    await expect(store.setDefaultProfile?.("profile-b")).rejects.toThrow("Core failed to start")
    await store.listProfiles?.()
    expect(refreshAttempts).toBe(2)
  })
})
