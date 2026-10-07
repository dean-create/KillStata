import { isPermissionMode, isReasoningEffort } from "../session-policy"
import { isSharedUiPreferenceKey, isUiTheme, parseSharedUiPreferences, type SharedUiPreferenceKey, type UiPreferencesStore } from "../ui-preferences"

function errorMessage(body: unknown) {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message.slice(0, 500)
  return "本机界面偏好服务暂时无法处理请求。"
}

export function createWebUiPreferencesStore(fetcher: typeof fetch = fetch): UiPreferencesStore {
  const request = async (method: "GET" | "PUT", body?: Record<string, unknown>) => {
    const response = await fetcher("/api/v2/ui-preferences", {
      method,
      credentials: "same-origin",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    })
    const payload: unknown = await response.json().catch(() => undefined)
    if (!response.ok) throw new Error(errorMessage(payload))
    return payload
  }

  return {
    async load() {
      return parseSharedUiPreferences(await request("GET"))
    },
    async save(key: SharedUiPreferenceKey, value, options = {}) {
      if (!isSharedUiPreferenceKey(key)
        || !(key === "theme" ? isUiTheme(value) : key === "reasoningEffort" ? isReasoningEffort(value) : isPermissionMode(value))) {
        throw new Error("界面偏好键或值无效。")
      }
      const result = await request("PUT", { key, value, ...(options.onlyIfAbsent ? { onlyIfAbsent: true } : {}) })
      if (!result || typeof result !== "object" || !("saved" in result) || typeof result.saved !== "boolean") {
        throw new Error("界面偏好保存响应无效。")
      }
      return result.saved
    },
  }
}
