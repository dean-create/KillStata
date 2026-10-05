import { describe, expect, test, vi } from "vitest"
import { createTauriUiPreferencesStore, type UiPreferenceInvoke } from "./tauri-ui-preferences"

describe("Tauri shared UI preference IPC", () => {
  test("loads and updates the shared permission mode through the same fixed-key IPC", async () => {
    const invoke = vi.fn<UiPreferenceInvoke>(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === "load_ui_preferences") return { theme: "light", reasoningEffort: "default", permissionMode: "full_access" } as T
      if (command === "save_ui_preference") return { saved: true } as T
      throw new Error(`unexpected command ${command} ${JSON.stringify(args)}`)
    })
    const store = createTauriUiPreferencesStore(invoke)

    await expect(store.load()).resolves.toEqual({ theme: "light", reasoningEffort: "default", permissionMode: "full_access" })
    await expect(store.save("theme", "dark", { onlyIfAbsent: true })).resolves.toBe(true)
    await expect(store.save("permissionMode", "read_only")).resolves.toBe(true)
    expect(invoke.mock.calls).toEqual([
      ["load_ui_preferences"],
      ["save_ui_preference", { key: "theme", value: "dark", onlyIfAbsent: true }],
      ["save_ui_preference", { key: "permissionMode", value: "read_only", onlyIfAbsent: false }],
    ])
  })
})
