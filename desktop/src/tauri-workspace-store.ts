import { normalizeWorkspaceSnapshot } from "./workspace-store"
import type { WorkspaceStore } from "./workspace-store"

export type TauriWorkspaceInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export function createTauriWorkspaceStore(invokeTauri: TauriWorkspaceInvoke): WorkspaceStore {
  const invoke = async <T,>(command: string, args?: Record<string, unknown>) => await invokeTauri(command, args) as T
  return {
    async load() {
      const raw = await invoke<string | null>("load_workspace_snapshot")
      if (!raw) return undefined
      try { return normalizeWorkspaceSnapshot(JSON.parse(raw)) } catch { return undefined }
    },
    async save(snapshot) {
      await invoke<void>("save_workspace_snapshot", { snapshot: JSON.stringify(snapshot) })
    },
    isEnabled: () => false,
    loadEnabled: () => invoke<boolean>("workspace_history_enabled_command"),
    setEnabled: (enabled) => invoke<void>("set_workspace_history_enabled", { enabled }),
  }
}
