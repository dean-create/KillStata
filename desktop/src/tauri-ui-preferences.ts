import { isPermissionMode, isReasoningEffort } from "./session-policy"
import { isSharedUiPreferenceKey, isUiTheme, type SharedUiPreferenceKey, type SharedUiPreferences, type UiPreferencesStore } from "./ui-preferences"

export type UiPreferenceInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

function parseNativePreferences(value: unknown): SharedUiPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("界面偏好响应格式无效。")
  const record = value as Record<string, unknown>
  const output: SharedUiPreferences = {}
  for (const [key, preference] of Object.entries(record)) {
    if (key === "theme" && isUiTheme(preference)) output.theme = preference
    else if (key === "reasoningEffort" && isReasoningEffort(preference)) output.reasoningEffort = preference
    else if (key === "permissionMode" && isPermissionMode(preference)) output.permissionMode = preference
    else throw new Error("界面偏好响应含有无效键或值。")
  }
  return output
}

export function createTauriUiPreferencesStore(invoke: UiPreferenceInvoke): UiPreferencesStore {
  return {
    async load() {
      return parseNativePreferences(await invoke("load_ui_preferences"))
    },
    async save(key: SharedUiPreferenceKey, value, options = {}) {
      if (!isSharedUiPreferenceKey(key)
        || !(key === "theme" ? isUiTheme(value) : key === "reasoningEffort" ? isReasoningEffort(value) : isPermissionMode(value))) {
        throw new Error("界面偏好键或值无效。")
      }
      const result = await invoke("save_ui_preference", {
        key,
        value,
        onlyIfAbsent: options.onlyIfAbsent ?? false,
      })
      if (!result || typeof result !== "object" || !("saved" in result) || typeof result.saved !== "boolean") {
        throw new Error("界面偏好保存响应无效。")
      }
      return result.saved
    },
  }
}
