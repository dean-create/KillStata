import { createDemoCredentialStore } from "./credentials"
import { createDemoEngine } from "./engine/client"
import { createDemoRuntimeDiagnostics } from "./runtime-diagnostics"
import type { SharedUiPreferenceKey, SharedUiPreferences, UiPreferencesStore } from "./ui-preferences"
import { createMemoryWorkspaceStore } from "./workspace-store"

export type TauriParityFixtureEnvironment = {
  isTauri: boolean
  isFixtureBuild: boolean
  flag: string | undefined
}

export function shouldUseTauriParityFixture(environment: TauriParityFixtureEnvironment) {
  return environment.isTauri && environment.isFixtureBuild && environment.flag === "1"
}

export function createTauriParityFixtureAdapters() {
  let preferences: SharedUiPreferences = {
    theme: "dark",
    reasoningEffort: "high",
    permissionMode: "read_only",
  }
  const uiPreferences: UiPreferencesStore = {
    load: async () => ({ ...preferences }),
    save: async (key: SharedUiPreferenceKey, value, options) => {
      if (options?.onlyIfAbsent && preferences[key] !== undefined) return false
      preferences = { ...preferences, [key]: value }
      return true
    },
  }
  return {
    engine: createDemoEngine(),
    credentials: createDemoCredentialStore(),
    runtimeDiagnostics: createDemoRuntimeDiagnostics(),
    uiPreferences,
    workspaceStore: createMemoryWorkspaceStore(),
  }
}
