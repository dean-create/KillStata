import { describe, expect, test } from "vitest"
import { emptyWorkspaceSnapshot } from "./workspace-store"
import { createTauriWorkspaceStore } from "./tauri-workspace-store"

describe("Tauri workspace history adapter", () => {
  test("maps enable, load, save, and disable operations to the native IPC contract", async () => {
    let enabled = false
    let serializedSnapshot: string | null = null
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const store = createTauriWorkspaceStore(async (command, args) => {
      calls.push({ command, args })
      if (command === "workspace_history_enabled_command") return enabled
      if (command === "set_workspace_history_enabled") {
        enabled = args?.enabled === true
        if (!enabled) serializedSnapshot = null
        return undefined
      }
      if (command === "load_workspace_snapshot") return enabled ? serializedSnapshot : null
      if (command === "save_workspace_snapshot") {
        if (enabled) serializedSnapshot = String(args?.snapshot)
        return undefined
      }
      throw new Error(`unexpected native command ${command}`)
    })

    expect(store.isEnabled?.()).toBe(false)
    await expect(store.loadEnabled?.()).resolves.toBe(false)
    await store.setEnabled?.(true)
    expect(await store.loadEnabled?.()).toBe(true)

    const snapshot = emptyWorkspaceSnapshot()
    await store.save(snapshot)
    await expect(store.load()).resolves.toEqual(snapshot)
    expect(serializedSnapshot).toBe(JSON.stringify(snapshot))

    await store.setEnabled?.(false)
    await expect(store.load()).resolves.toBeUndefined()
    expect(calls.map(({ command }) => command)).toEqual([
      "workspace_history_enabled_command",
      "set_workspace_history_enabled",
      "workspace_history_enabled_command",
      "save_workspace_snapshot",
      "load_workspace_snapshot",
      "set_workspace_history_enabled",
      "load_workspace_snapshot",
    ])
  })

  test("treats malformed native snapshot JSON as missing history", async () => {
    const store = createTauriWorkspaceStore(async (command) => {
      if (command === "load_workspace_snapshot") return "{not-json"
      throw new Error(`unexpected native command ${command}`)
    })

    await expect(store.load()).resolves.toBeUndefined()
  })
})
