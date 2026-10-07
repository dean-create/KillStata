import type { ThreadMessage } from "./thread"
import type { RunStatus } from "./thread"
import { isPermissionMode, type PermissionMode } from "./session-policy"

export const UNASSIGNED_WORKSPACE_ID = "__unassigned__"
export const WORKSPACE_SNAPSHOT_VERSION = 1 as const
const WORKSPACE_STORAGE_KEY = "killstata-desktop-workspaces"
const WORKSPACE_HISTORY_ENABLED_KEY = "killstata-desktop-history-enabled"
const MAX_WORKSPACE_SNAPSHOT_BYTES = 5 * 1024 * 1024

export type PersistedDataset = {
  name: string
  format: string
  bytes: number
}

export type PersistedResearchSession = {
  id: number
  title: string
  messages: ThreadMessage[]
  dataset?: PersistedDataset
  workbookSheetNames: string[]
  selectedWorkbookSheet?: string
  submittedPrompt?: string
  permissionMode?: PermissionMode
  resultDocument: string
  resultExportable: boolean
  runStatus: RunStatus
  runID?: string
}

export type WorkspaceRecord = {
  id: string
  name: string
  lastOpenedAt: number
  researches: PersistedResearchSession[]
}

export type WorkspaceSnapshot = {
  version: typeof WORKSPACE_SNAPSHOT_VERSION
  activeWorkspaceID: string
  workspaces: WorkspaceRecord[]
}

export interface WorkspaceStore {
  load(): Promise<WorkspaceSnapshot | undefined>
  save(snapshot: WorkspaceSnapshot): Promise<void>
  isEnabled?(): boolean
  loadEnabled?(): Promise<boolean>
  setEnabled?(enabled: boolean): Promise<void>
}

export function emptyWorkspaceSnapshot(): WorkspaceSnapshot {
  return {
    version: WORKSPACE_SNAPSHOT_VERSION,
    activeWorkspaceID: UNASSIGNED_WORKSPACE_ID,
    workspaces: [{
      id: UNASSIGNED_WORKSPACE_ID,
      name: "未归档研究",
      lastOpenedAt: 0,
      researches: [],
    }],
  }
}

/** 将旧版/损坏快照收敛到前端可安全消费的形状；不恢复运行中的任务。 */
export function normalizeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.version !== WORKSPACE_SNAPSHOT_VERSION || !Array.isArray(input.workspaces)) return undefined
  const workspaces = input.workspaces.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== "string" || !record.id || typeof record.name !== "string" || !Array.isArray(record.researches)) return []
    const researches = record.researches.flatMap((research) => normalizeResearchSession(research))
    return [{
      id: record.id,
      name: record.name.slice(0, 160),
      lastOpenedAt: typeof record.lastOpenedAt === "number" && Number.isFinite(record.lastOpenedAt) ? record.lastOpenedAt : 0,
      researches,
    }]
  })
  const withUnassigned = workspaces.some((workspace) => workspace.id === UNASSIGNED_WORKSPACE_ID)
    ? workspaces
    : [...workspaces, emptyWorkspaceSnapshot().workspaces[0]]
  const activeWorkspaceID = typeof input.activeWorkspaceID === "string" && withUnassigned.some((workspace) => workspace.id === input.activeWorkspaceID)
    ? input.activeWorkspaceID
    : UNASSIGNED_WORKSPACE_ID
  return { version: WORKSPACE_SNAPSHOT_VERSION, activeWorkspaceID, workspaces: withUnassigned }
}

function normalizeResearchSession(value: unknown): PersistedResearchSession[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const input = value as Record<string, unknown>
  if (typeof input.id !== "number" || !Number.isSafeInteger(input.id) || input.id < 1 || typeof input.title !== "string" || !Array.isArray(input.messages)) return []
  const messages = input.messages.filter(isThreadMessage)
  const runStatus = input.runStatus === "preparing" || input.runStatus === "running" || input.runStatus === "waiting_for_user"
    ? "interrupted"
    : isRunStatus(input.runStatus) ? input.runStatus : "idle"
  return [{
    id: input.id,
    title: input.title.slice(0, 160),
    messages,
    dataset: normalizeDataset(input.dataset),
    workbookSheetNames: Array.isArray(input.workbookSheetNames) ? input.workbookSheetNames.filter((name): name is string => typeof name === "string").slice(0, 64) : [],
    selectedWorkbookSheet: typeof input.selectedWorkbookSheet === "string" ? input.selectedWorkbookSheet : undefined,
    submittedPrompt: typeof input.submittedPrompt === "string" ? input.submittedPrompt.slice(0, 20_000) : undefined,
    permissionMode: isPermissionMode(input.permissionMode) ? input.permissionMode : undefined,
    resultDocument: typeof input.resultDocument === "string" ? input.resultDocument.slice(0, 1_000_000) : "",
    resultExportable: input.resultExportable === true,
    runStatus,
    runID: runStatus === "interrupted" ? undefined : typeof input.runID === "string" ? input.runID : undefined,
  }]
}

function normalizeDataset(value: unknown): PersistedDataset | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.name !== "string" || typeof input.format !== "string" || typeof input.bytes !== "number") return undefined
  return { name: input.name.slice(0, 512), format: input.format.slice(0, 32), bytes: Math.max(0, input.bytes) }
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === "idle" || value === "preparing" || value === "running" || value === "waiting_for_user" || value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted"
}

function isThreadMessage(value: unknown): value is ThreadMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  if (typeof message.id !== "number" || !Number.isSafeInteger(message.id) || typeof message.kind !== "string") return false
  if (message.kind === "user") return typeof message.text === "string"
  if (message.kind === "progress") return typeof message.message === "string"
  if (message.kind === "assistant") return typeof message.document === "string"
  return message.kind === "system" && typeof message.message === "string" && (message.tone === "info" || message.tone === "warning" || message.tone === "error")
}

export function workspaceIDFromPath(path: string): string {
  // 仅用于旧的浏览器/mock picker 返回完整路径时生成不透明 ID；真实 Tauri 由 Rust 生成 ID。
  let hash = 2166136261
  for (const character of path) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return `workspace-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

export function createMemoryWorkspaceStore(initial?: WorkspaceSnapshot): WorkspaceStore {
  let snapshot = initial ?? emptyWorkspaceSnapshot()
  let enabled = false
  return {
    load: async () => enabled ? snapshot : undefined,
    save: async (next) => { if (enabled) snapshot = next },
    isEnabled: () => enabled,
    loadEnabled: async () => enabled,
    setEnabled: async (next) => { enabled = next },
  }
}

export function createLocalWorkspaceStore(storage: Storage | undefined = globalThis.localStorage): WorkspaceStore {
  const isEnabled = () => storage?.getItem(WORKSPACE_HISTORY_ENABLED_KEY) === "true"
  return {
    load: async () => {
      if (!isEnabled()) return undefined
      const raw = storage?.getItem(WORKSPACE_STORAGE_KEY)
      if (!raw || new TextEncoder().encode(raw).byteLength > MAX_WORKSPACE_SNAPSHOT_BYTES) return undefined
      try {
        return normalizeWorkspaceSnapshot(JSON.parse(raw))
      } catch {
        return undefined
      }
    },
    save: async (snapshot) => {
      if (!storage || !isEnabled()) return
      const serialized = JSON.stringify(snapshot)
      if (new TextEncoder().encode(serialized).byteLength > MAX_WORKSPACE_SNAPSHOT_BYTES) throw new Error("研究历史超过本地保存上限")
      storage.setItem(WORKSPACE_STORAGE_KEY, serialized)
    },
    isEnabled,
    loadEnabled: async () => isEnabled(),
    setEnabled: async (enabled) => {
      if (!storage) return
      storage.setItem(WORKSPACE_HISTORY_ENABLED_KEY, enabled ? "true" : "false")
      if (!enabled) storage.removeItem(WORKSPACE_STORAGE_KEY)
    },
  }
}
