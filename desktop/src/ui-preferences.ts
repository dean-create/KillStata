import { isPermissionMode, isReasoningEffort, type PermissionMode, type ReasoningEffort } from "./session-policy"

export type UiTheme = "system" | "light" | "dark"
export type SharedUiPreferenceKey = "theme" | "reasoningEffort" | "permissionMode"
export type SharedUiPreferences = Partial<{ theme: UiTheme; reasoningEffort: ReasoningEffort; permissionMode: PermissionMode }>

export interface UiPreferencesStore {
  load(): Promise<SharedUiPreferences>
  save(key: SharedUiPreferenceKey, value: UiTheme | ReasoningEffort | PermissionMode, options?: { onlyIfAbsent?: boolean }): Promise<boolean>
}

export function isUiTheme(value: unknown): value is UiTheme {
  return value === "system" || value === "light" || value === "dark"
}

export function isSharedUiPreferenceKey(value: unknown): value is SharedUiPreferenceKey {
  return value === "theme" || value === "reasoningEffort" || value === "permissionMode"
}

export function parseSharedUiPreferences(value: unknown): SharedUiPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("界面偏好响应格式无效。")
  const record = value as Record<string, unknown>
  const preferences = record.preferences
  if (record.protocolVersion !== "v2" || !preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
    throw new Error("界面偏好响应格式无效。")
  }
  const input = preferences as Record<string, unknown>
  const output: SharedUiPreferences = {}
  for (const [key, item] of Object.entries(input)) {
    if (key === "theme" && isUiTheme(item)) output.theme = item
    else if (key === "reasoningEffort" && isReasoningEffort(item)) output.reasoningEffort = item
    else if (key === "permissionMode" && isPermissionMode(item)) output.permissionMode = item
    else throw new Error("界面偏好响应含有无效键或值。")
  }
  return output
}
