/**
 * KillStata 桌面前端（Codex 风格对话流）。
 *
 * 界面 = 顶部品牌/引擎状态 + 消息流（问题/进度/结果/系统提示）+ 底部输入区。
 * 分析所需的变量等研究信息直接在问题里描述，由引擎自主理解；数据文件作为附件
 * 随请求发送。工作台形态（数据预览/研究设计/蓝图/进度卡片）已移除。
 */
import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import packageDefinition from "../package.json"
import { createDemoEngine, type EngineClient } from "./engine/client"
import type { EngineCommand, EngineInteraction, EngineRunEvent, EngineVerificationUpdate } from "./engine/client"
import { createMarkdownReport } from "./export/report"
import { createDemoCredentialStore, type CredentialStore, type ModelProfilesSnapshot } from "./credentials"
import { parseWorkbook } from "./data-preview"
import { createDemoRuntimeDiagnostics, type RuntimeDiagnostics, type RuntimeDiagnosticsReport } from "./runtime-diagnostics"
import { createTurnCoordinator, type TurnSnapshot, type TurnStatus } from "./core/turn-coordinator"
import { Composer, type SlashCommand } from "./components/Composer"
import { desktopSlashCommandCatalog, normalizeSlashCommand, parseSlashInvocation } from "./slash-commands"
import { Icon } from "./components/Icon"
import { MessageThread } from "./components/MessageThread"
import { InteractionPanel } from "./components/InteractionPanel"
import { ModelManagement } from "./components/ModelManagement"
import { isUiTheme, type SharedUiPreferenceKey, type SharedUiPreferences, type UiPreferencesStore, type UiTheme } from "./ui-preferences"
import { DEEPSEEK_DEFAULT_PROVIDER_MODEL, DEEPSEEK_MODELS, PYTHON_RUNTIME_PACKAGES, isDeepSeekProvider, type ProviderSettings } from "./provider-config"
import { createLocalWorkspaceStore, emptyWorkspaceSnapshot, UNASSIGNED_WORKSPACE_ID, workspaceIDFromPath, type PersistedResearchSession, type WorkspaceRecord as PersistedWorkspaceRecord, type WorkspaceSnapshot, type WorkspaceStore } from "./workspace-store"
import { type NewThreadMessage, type ProgressStep, type ResultDocumentBlock, type RunProgressSnapshot, type RunStatus, type ThreadMessage } from "./thread"
import { DEFAULT_PERMISSION_MODE, DEFAULT_REASONING_EFFORT, isPermissionMode, isReasoningEffort, modelDisplayName, permissionModeInfo, permissionRuleset, PERMISSION_MODES, REASONING_EFFORTS, type PermissionMode, type ReasoningEffort } from "./session-policy"

type Dataset = {
  name: string
  format: string
  bytes: number
  file: File
}

/**
 * 侧栏的“最近研究”只保存当前应用内存中的上下文。
 * 不把数据文件、问题或结果写进用户选择的工作区，更不会越过 Desktop 的协议边界。
 */
type ResearchSession = Omit<PersistedResearchSession, "dataset"> & {
  workspaceID: string
  dataset?: Dataset
}

type WorkspaceRecord = Omit<PersistedWorkspaceRecord, "researches"> & {
  researches: ResearchSession[]
}

type ResearchSessionSummary = {
  datasetLabel: string
  statusLabel: string
  tone: "quiet" | "running" | "warning" | "ready"
}

type Theme = UiTheme
type SettingsCategory = "general" | "model" | "runtime"
type LocalFeedback = {
  tone: "info" | "warning" | "error"
  title: string
  reason: string
  action: string
}
type RevertedTurnSnapshot = {
  messages: ThreadMessage[]
  resultDocument: string
  resultExportable: boolean
  runStatus: RunStatus
  submittedPrompt?: string
}

/** 仅由桌面壳提供的原生目录选择；前端不会枚举或读取目录内的文件。 */
export type WorkspacePicker = () => Promise<string | { id: string; name: string } | undefined>
export type WorkspaceRebinder = (workspace: { id: string; name: string }) => Promise<void>
/** 仅在已有工作区且研究者主动点名一个文件时提供；不返回或展示路径。 */
export type WorkspaceFilePicker = (workspaceID?: string) => Promise<File | undefined>

const themeStorageKey = "killstata-desktop-theme"
const permissionModeStorageKey = "killstata-desktop-permission-mode"
const reasoningEffortStorageKey = "killstata-desktop-reasoning-effort"
const supportedDatasetFormats = ["CSV", "XLSX", "XLS", "DTA", "PARQUET"]
const maximumLocalPreviewBytes = 64 * 1024 * 1024
const frontendResearchReceipt = "## 研究信息已记录\n\n当前未执行统计分析，也未调用外部模型。"
export const CREDENTIAL_OPERATION_TIMEOUT_MS = 15_000
// Activation can serialize a bounded Keychain read (10s) and the native Core
// listener wait (15s); keep enough headroom so the UI doesn't report a false failure.
export const CORE_ACTIVATION_TIMEOUT_MS = CREDENTIAL_OPERATION_TIMEOUT_MS + 15_000

/** 系统凭据库属于应用外部依赖，不能让它无限期占住发送入口。 */
export function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMilliseconds)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

const themes: Array<{ value: Theme; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
  { value: "dark", label: "深色" },
]

function selectedEngineCommand(input: string, catalogue: EngineCommand[]) {
  const invocation = parseSlashInvocation(input)
  const name = invocation?.name
  if (!name || !invocation) return {}
  const registered = catalogue.find((command) => command.name.replace(/^\/+/, "") === name)
  if (registered?.blockedReason) return { error: registered.blockedReason }
  if (registered?.advanced) return { error: `/${name} 当前仅在高级命令中开放。` }
  if (registered) return { command: { name, arguments: invocation.arguments } }
  return {}
}

function savedTheme(): Theme {
  const stored = globalThis.localStorage?.getItem(themeStorageKey)
  return isUiTheme(stored) ? stored : "system"
}

function savedPermissionMode(): PermissionMode {
  const stored = globalThis.localStorage?.getItem(permissionModeStorageKey)
  return isPermissionMode(stored) ? stored : DEFAULT_PERMISSION_MODE
}

function savedReasoningEffort(): ReasoningEffort {
  const stored = globalThis.localStorage?.getItem(reasoningEffortStorageKey)
  return isReasoningEffort(stored) ? stored : DEFAULT_REASONING_EFFORT
}

function selectedCoreModel(providerID: string, configuredModelID: string) {
  const modelID = configuredModelID.trim()
  if (!modelID) return undefined
  const prefix = `${providerID}/`
  return { providerID, modelID: modelID.startsWith(prefix) ? modelID.slice(prefix.length) : modelID }
}

function datasetFormat(fileName: string) {
  const extension = fileName.split(".").pop()?.toLocaleUpperCase() ?? ""
  if (extension === "DTA") return "STATA"
  return extension
}

function supportsDatasetFile(file: File) {
  const name = file.name.toLocaleLowerCase()
  return supportedDatasetFormats.some((format) => name.endsWith(`.${format.toLocaleLowerCase()}`))
}

function researchSessionSummary(session: ResearchSession): ResearchSessionSummary {
  if (session.resultExportable && session.runStatus === "completed") {
    return { datasetLabel: session.dataset?.name ?? "未选择数据", statusLabel: "结果已就绪", tone: "ready" }
  }
  if (session.runStatus === "preparing" || session.runStatus === "running") {
    return { datasetLabel: session.dataset?.name ?? "未选择数据", statusLabel: "正在分析", tone: "running" }
  }
  if (session.runStatus === "failed" || session.runStatus === "cancelled" || session.runStatus === "interrupted") {
    return { datasetLabel: session.dataset?.name ?? "未选择数据", statusLabel: "需要处理", tone: "warning" }
  }
  return { datasetLabel: session.dataset?.name ?? "未选择数据", statusLabel: "研究信息已记录", tone: "quiet" }
}

function pipeTableCells(line: string) {
  const source = line.trim()
  if (!source.startsWith("|") || !source.endsWith("|")) return undefined
  return source.slice(1, -1).split("|").map((cell) => cell.trim())
}

function tableSeparatorMatches(cells: string[], columnCount: number) {
  return cells.length === columnCount && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

/** 结果文档 → 安全阅读块：只读成标题、段落与严格管道表格（单元格只回显引擎原文）。 */
function resultDocumentBlocks(document: string): ResultDocumentBlock[] {
  const blocks: ResultDocumentBlock[] = []
  const paragraph: string[] = []
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim()
    if (text) blocks.push({ kind: "paragraph", text })
    paragraph.length = 0
  }

  const lines = document.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2] })
      continue
    }

    const headers = pipeTableCells(line)
    const separator = pipeTableCells(lines[index + 1] ?? "")
    const firstRow = pipeTableCells(lines[index + 2] ?? "")
    if (headers && separator && firstRow && tableSeparatorMatches(separator, headers.length) && firstRow.length === headers.length) {
      flushParagraph()
      const rows = [firstRow]
      index += 2
      while (index + 1 < lines.length) {
        const nextRow = pipeTableCells(lines[index + 1])
        if (!nextRow || nextRow.length !== headers.length) break
        rows.push(nextRow)
        index += 1
      }
      blocks.push({ kind: "table", headers, rows })
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  return blocks
}

export default function App(props: { engine?: EngineClient; credentials?: CredentialStore; runtimeDiagnostics?: RuntimeDiagnostics; workspacePicker?: WorkspacePicker; workspaceRebinder?: WorkspaceRebinder; workspaceFilePicker?: WorkspaceFilePicker; workspaceStore?: WorkspaceStore; uiPreferences?: UiPreferencesStore; initialUiPreferences?: SharedUiPreferences; initialWorkspaceHistoryEnabled?: boolean; workspaceContextChanged?: (workspaceID: string) => void; requireApiKey?: boolean; connectionAvailable?: boolean; sharedVisitor?: boolean; mode?: "frontend" | "connected"; credentialStorageNotice?: string; credentialStoreLabel?: string }) {
  const [mode, setMode] = createSignal<"frontend" | "connected">(props.mode ?? "frontend")
  const connectionAvailable = props.connectionAvailable === true
  const requireApiKey = () => props.requireApiKey === true && mode() === "connected"
  const engine = props.engine ?? createDemoEngine()
  // Turn Coordinator 只投影客户端生命周期；模型、工具、权限和研究事实仍由 Core 负责。
  const turnCoordinator = createTurnCoordinator(engine)
  const credentials = props.credentials ?? createDemoCredentialStore()
  const runtimeDiagnostics = props.runtimeDiagnostics ?? createDemoRuntimeDiagnostics()
  const workspaceStore = props.workspaceStore ?? createLocalWorkspaceStore()

  const [dataset, setDataset] = createSignal<Dataset>()
  const [isDataDropTarget, setIsDataDropTarget] = createSignal(false)
  const [workspaceName, setWorkspaceName] = createSignal<string>()
  const [activeWorkspaceID, setActiveWorkspaceID] = createSignal(UNASSIGNED_WORKSPACE_ID)
  createEffect(() => props.workspaceContextChanged?.(activeWorkspaceID()))
  const [workspaceRecords, setWorkspaceRecords] = createSignal<WorkspaceRecord[]>(emptyWorkspaceSnapshot().workspaces.map((workspace) => ({ ...workspace, researches: [] })))
  const [workspacePersistenceFeedback, setWorkspacePersistenceFeedback] = createSignal<string>()
  const [workspaceHistoryEnabled, setWorkspaceHistoryEnabled] = createSignal(props.initialWorkspaceHistoryEnabled ?? workspaceStore.isEnabled?.() ?? false)
  const workspacePersistenceMessage = () => workspacePersistenceFeedback()
  const [workspacePanelOpen, setWorkspacePanelOpen] = createSignal(false)
  const researchSessions = () => workspaceRecords().find((workspace) => workspace.id === activeWorkspaceID())?.researches ?? []
  const [researchFilter, setResearchFilter] = createSignal("")
  const [activeResearchID, setActiveResearchID] = createSignal<number>()
  const [datasetSelectionMessage, setDatasetSelectionMessage] = createSignal<LocalFeedback>()
  const [workbookSheetNames, setWorkbookSheetNames] = createSignal<string[]>([])
  const [selectedWorkbookSheet, setSelectedWorkbookSheet] = createSignal<string>()
  const [commands, setCommands] = createSignal<EngineCommand[]>([])
  const [prompt, setPrompt] = createSignal("")
  const [submittedPrompt, setSubmittedPrompt] = createSignal<string>()
  const [threadMessages, setThreadMessages] = createSignal<ThreadMessage[]>([])
  const [engineStatus, setEngineStatus] = createSignal<"checking" | "ready" | "unavailable">("checking")
  const [engineFeedback, setEngineFeedback] = createSignal<LocalFeedback>()
  const [connectionMessage, setConnectionMessage] = createSignal("")
  const [waitingForShareWorkspace, setWaitingForShareWorkspace] = createSignal(false)
  const permissionModeForSurface = (value: PermissionMode) => props.sharedVisitor && value === "full_access"
    ? DEFAULT_PERMISSION_MODE
    : value
  const [permissionMode, setPermissionMode] = createSignal<PermissionMode>(permissionModeForSurface(props.initialUiPreferences?.permissionMode ?? savedPermissionMode()))
  const [reasoningEffort, setReasoningEffort] = createSignal<ReasoningEffort>(props.initialUiPreferences?.reasoningEffort ?? savedReasoningEffort())
  const [showThinking, setShowThinking] = createSignal(false)
  const [showTimestamps, setShowTimestamps] = createSignal(false)
  const [submissionFeedback, setSubmissionFeedback] = createSignal<LocalFeedback>()
  const [cancellationFeedback, setCancellationFeedback] = createSignal<LocalFeedback>()
  const [isCancellingRun, setIsCancellingRun] = createSignal(false)
  const [isPreparingSubmission, setIsPreparingSubmission] = createSignal(false)
  const [resultDocument, setResultDocument] = createSignal("")
  const [runStatus, setRunStatus] = createSignal<RunStatus>("idle")
  const [pendingInteraction, setPendingInteraction] = createSignal<EngineInteraction>()
  const [interactionBusy, setInteractionBusy] = createSignal(false)
  const [interactionError, setInteractionError] = createSignal<string>()
  const [isRunning, setIsRunning] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [settingsCategory, setSettingsCategory] = createSignal<SettingsCategory>("general")
  const [demoResultOpen, setDemoResultOpen] = createSignal(false)
  const [resultTitle, setResultTitle] = createSignal("完整结果")
  const [resultExportable, setResultExportable] = createSignal(false)
  const [resultFeedback, setResultFeedback] = createSignal<LocalFeedback>()
  const [modelProfiles, setModelProfiles] = createSignal<ModelProfilesSnapshot>({ profiles: [], defaultProfileId: null })
  const [profileLoadState, setProfileLoadState] = createSignal<"loading" | "ready" | "error">(mode() === "frontend" ? "ready" : "loading")
  const [profileLoadError, setProfileLoadError] = createSignal("")
  /** 当前默认档案的模型投影；密钥与其他档案详情不离开 Keychain。 */
  const [providerDraft, setProviderDraft] = createSignal<ProviderSettings>({
    provider: "deepseek",
    model: DEEPSEEK_DEFAULT_PROVIDER_MODEL,
  })
  // provider 状态读取可能晚于用户在设置页的编辑返回；版本号用于阻止旧响应覆盖新草稿。
  let providerDraftRevision = 0
  let modelProfilesRevision = 0
  const updateProviderDraftFromUser = (next: Parameters<typeof setProviderDraft>[0]) => {
    providerDraftRevision += 1
    setProviderDraft(next)
  }
  const [availableModels, setAvailableModels] = createSignal<ReadonlyArray<{ id: string; label: string }>>(DEEPSEEK_MODELS as unknown as ReadonlyArray<{ id: string; label: string }>)
  const [runtimeReport, setRuntimeReport] = createSignal<RuntimeDiagnosticsReport>()
  const [runtimeFeedback, setRuntimeFeedback] = createSignal<LocalFeedback>()
  const [expandedRuntimeDependencyGroups, setExpandedRuntimeDependencyGroups] = createSignal<Set<string>>(new Set())
  const [isCheckingRuntime, setIsCheckingRuntime] = createSignal(false)
  const [runtimeInstallConfirmationOpen, setRuntimeInstallConfirmationOpen] = createSignal(false)
  const [isInstallingRuntime, setIsInstallingRuntime] = createSignal(false)
  const [runtimeInstallMessage, setRuntimeInstallMessage] = createSignal("")
  const [sharedUiPreferenceError, setSharedUiPreferenceError] = createSignal(false)
  const [theme, setTheme] = createSignal<Theme>(props.initialUiPreferences?.theme ?? savedTheme())
  let themePreferenceRevision = 0
  let reasoningPreferenceRevision = 0
  let permissionModePreferenceRevision = 0
  let uiPreferenceReadSequence = 0
  const pendingUiPreferenceWrites = new Set<SharedUiPreferenceKey>()
  const [runID, setRunID] = createSignal<string>()
  const [runProgress, setRunProgress] = createSignal<RunProgressSnapshot>()
  const revertedTurns = new Map<string, RevertedTurnSnapshot[]>()

  let runStartedAt: number | undefined
  let runProgressTimer: number | undefined
  let stopVerificationSubscription: (() => void) | undefined
  let fileInput: HTMLInputElement | undefined
  let promptInput: HTMLTextAreaElement | undefined
  let settingsTrigger: HTMLButtonElement | undefined
  let settingsCloseButton: HTMLButtonElement | undefined
  let workspaceToggle: HTMLButtonElement | undefined
  let workspaceCloseButton: HTMLButtonElement | undefined
  let workspaceDrawer: HTMLElement | undefined
  let appliedTurnEventSequence = 0
  let threadMessageID = 0
  let researchSessionID = 0
  let restoringResearch = false
  let engineCheckVersion = 0

  const workspaceDrawerID = "workspace-drawer"

  const updateLoadedIDCounters = (records: WorkspaceRecord[]) => {
    const researchIDs = records.flatMap((workspace) => workspace.researches.map((research) => research.id))
    const messageIDs = records.flatMap((workspace) => workspace.researches.flatMap((research) => research.messages.map((message) => message.id)))
    researchSessionID = Math.max(researchSessionID, ...researchIDs, 0)
    threadMessageID = Math.max(threadMessageID, ...messageIDs, 0)
  }

  const persistedRunStatus = (status: RunStatus): RunStatus => (
    status === "preparing" || status === "running" || status === "waiting_for_user" ? "interrupted" : status
  )

  const persistWorkspaceRecords = (records: WorkspaceRecord[], currentWorkspaceID = activeWorkspaceID()) => {
    if (!workspaceHistoryEnabled()) return
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      activeWorkspaceID: currentWorkspaceID,
      workspaces: records.map(({ researches, ...workspace }) => ({
        ...workspace,
        researches: researches.map(({ workspaceID: _workspaceID, dataset: persistedDataset, ...research }) => ({
          ...research,
          dataset: persistedDataset ? { name: persistedDataset.name, format: persistedDataset.format, bytes: persistedDataset.bytes } : undefined,
          runStatus: persistedRunStatus(research.runStatus),
          runID: undefined,
        })),
      })),
    }
    void workspaceStore.save(snapshot).catch(() => setWorkspacePersistenceFeedback("研究历史暂时未能保存，仅保留在当前应用中。"))
  }

  /**
   * 恢复已保存的研究历史。开关关闭时 store 会返回 undefined，因此这里不需要重复判断；
   * 恢复期间抑制同步 effect，避免把空白内存状态回写覆盖磁盘上的历史。
   */
  const restoreWorkspaceSnapshot = async (isCurrent: () => boolean = () => true) => {
    const snapshot = await workspaceStore.load().catch(() => undefined)
    if (!isCurrent() || !snapshot) return false
    // 空快照不代表"有历史可恢复"：直接套用它会把当前内存中的研究清空。
    const hasStoredContent = snapshot.workspaces.some((workspace) => workspace.researches.length > 0 || workspace.id !== UNASSIGNED_WORKSPACE_ID)
    if (!hasStoredContent) return false
    const records = snapshot.workspaces.map((workspace) => ({
      ...workspace,
      researches: workspace.researches.map((research) => ({ ...research, workspaceID: workspace.id, dataset: undefined })),
    }))
    updateLoadedIDCounters(records)
    const activeWorkspace = records.find((workspace) => workspace.id === snapshot.activeWorkspaceID)
    if (props.sharedVisitor && activeWorkspace && activeWorkspace.id !== UNASSIGNED_WORKSPACE_ID && props.workspaceRebinder) {
      try {
        await props.workspaceRebinder({ id: activeWorkspace.id, name: activeWorkspace.name })
      } catch {
        if (isCurrent()) setWorkspacePersistenceFeedback("无法恢复已保存的访客工作区，请重新选择该目录后重试。")
        return false
      }
    }
    if (!isCurrent()) return false
    restoringResearch = true
    const latest = activeWorkspace?.researches[0]
    // 原始文件不进入历史，只有安全元数据；提示需要用快照里的名称，而非已清空的内存 dataset。
    const latestDataset = snapshot.workspaces.find((workspace) => workspace.id === snapshot.activeWorkspaceID)?.researches[0]?.dataset
    batch(() => {
      setWorkspaceRecords(records)
      setActiveWorkspaceID(snapshot.activeWorkspaceID)
      setWorkspaceName(activeWorkspace && activeWorkspace.id !== UNASSIGNED_WORKSPACE_ID ? activeWorkspace.name : undefined)
      setActiveResearchID(latest?.id)
      setThreadMessages(latest?.messages ?? [])
      setDataset(undefined)
      setDatasetSelectionMessage(latestDataset
        ? { tone: "info", title: "请重新选择数据文件", reason: `历史记录保留了「${latestDataset.name}」的元数据，但没有保存原始文件。`, action: "重新选择原始数据文件后才能继续分析。" }
        : undefined)
      setWorkbookSheetNames(latest?.workbookSheetNames ?? [])
      setSelectedWorkbookSheet(latest?.selectedWorkbookSheet)
      setSubmittedPrompt(latest?.submittedPrompt)
      setResultDocument(latest?.resultDocument ?? "")
      setResultExportable(latest?.resultExportable ?? false)
      setRunStatus(latest ? persistedRunStatus(latest.runStatus) : "idle")
    })
    queueMicrotask(() => { restoringResearch = false; promptInput?.focus() })
    return true
  }

  const setWorkspaceHistory = async (enabled: boolean) => {
    await workspaceStore.setEnabled?.(enabled)
    setWorkspaceHistoryEnabled(enabled)
    if (enabled) {
      // 开启后必须先读回磁盘已有历史，否则随后的自动保存会用空白内存状态覆盖它；
      // 没有历史可恢复时，把当前内存中的研究立即落盘，而不是等下一次状态变化。
      setWorkspacePersistenceFeedback(undefined)
      if (!(await restoreWorkspaceSnapshot())) persistWorkspaceRecords(workspaceRecords())
      return
    }
    restoringResearch = true
    batch(() => {
      setWorkspaceRecords(emptyWorkspaceSnapshot().workspaces.map((workspace) => ({ ...workspace, researches: [] })))
      setActiveWorkspaceID(UNASSIGNED_WORKSPACE_ID)
      setActiveResearchID(undefined)
      setThreadMessages([])
      setDataset(undefined)
      setWorkspaceName(undefined)
    })
    queueMicrotask(() => { restoringResearch = false })
    setWorkspacePersistenceFeedback("研究历史已关闭；现有历史已从本机移除，仅保留当前应用内存。")
  }

  const clearRunProgress = () => {
    if (runProgressTimer !== undefined) window.clearInterval(runProgressTimer)
    runProgressTimer = undefined
    runStartedAt = undefined
    setRunProgress(undefined)
  }

  const startRunProgress = () => {
    clearRunProgress()
    const startedAt = Date.now()
    runStartedAt = startedAt
    setRunProgress({ elapsedMilliseconds: 0, progressUpdates: 0 })
    runProgressTimer = window.setInterval(() => {
      if (runStartedAt !== startedAt) return
      setRunProgress((snapshot) => snapshot
        ? { ...snapshot, elapsedMilliseconds: Date.now() - startedAt }
        : snapshot)
    }, 1000)
  }

  const recordProgressUpdate = () => {
    setRunProgress((snapshot) => snapshot
      ? { ...snapshot, progressUpdates: snapshot.progressUpdates + 1 }
      : snapshot)
  }

  const closeWorkspacePanel = () => {
    setWorkspacePanelOpen(false)
    queueMicrotask(() => workspaceToggle?.focus())
  }

  const openWorkspacePanel = () => {
    setWorkspacePanelOpen(true)
    queueMicrotask(() => workspaceCloseButton?.focus())
  }

  const trapWorkspaceFocus = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      closeWorkspacePanel()
      return
    }
    if (event.key !== "Tab" || !workspacePanelOpen() || !workspaceDrawer) return
    const controls = [...workspaceDrawer.querySelectorAll<HTMLElement>("button:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), input:not([disabled])")]
      .filter((element) => element.offsetParent !== null)
    if (!controls.length) return
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const makeThreadMessage = (message: NewThreadMessage): ThreadMessage => ({ ...message, id: ++threadMessageID, createdAt: new Date().toISOString() })

  const appendThreadMessage = (message: NewThreadMessage) => {
    const nextMessage = makeThreadMessage(message)
    setThreadMessages((messages) => [...messages, nextMessage])
  }

  const pendingVerifications = new Map<string, EngineVerificationUpdate[]>()
  const MAX_PENDING_VERIFICATION_SESSIONS = 64
  const MAX_PENDING_VERIFICATIONS_PER_SESSION = 32

  /**
   * 进度行 upsert：带 step 的进度按 step.id（工具 callID）就地更新同一行，
   * 让一次工具调用从"正在导入数据…"变成"已完成导入数据"，而不是堆成两条。
   * 不带 step 的进度（准备、修复、重试）仍按时间顺序追加。
   */
  const upsertProgress = (message: string, step?: ProgressStep) => {
    if (!step) {
      appendThreadMessage({ kind: "progress", message })
      return
    }
    const existing = untrack(threadMessages).some((item) => item.kind === "progress" && item.step?.id === step.id)
    if (!existing) {
      appendThreadMessage({ kind: "progress", message, step })
      flushPendingVerifications(runID())
      return
    }
    setThreadMessages((messages) => messages.map((item) => (
      item.kind === "progress" && item.step?.id === step.id ? { ...item, message, step } : item
    )))
    flushPendingVerifications(runID())
  }

  const applyVerification = (update: EngineVerificationUpdate) => {
    const step: ProgressStep = {
      id: `verification:${update.callID}`, label: "独立核验", phase: "analysis",
      status: update.status === "pending" ? "pending" : update.status === "block" ? "failed" : "completed",
    }
    const created = makeThreadMessage({ kind: "progress", message: update.message, step })
    const updateMessages = (messages: ThreadMessage[]) => {
      const origin = messages.findIndex((item) => item.kind === "progress" && item.step?.id === update.callID)
      if (origin < 0) return messages
      const previous = messages.findIndex((item) => item.kind === "progress" && item.step?.id === step.id)
      if (previous >= 0) {
        const current = messages[previous]
        if (current?.kind === "progress" && current.message === update.message && current.step?.status === step.status) return messages
        return messages.map((item, index) => index === previous ? { ...item, message: update.message, step } : item)
      }
      const next = [...messages]
      next.splice(origin + 1, 0, created)
      return next
    }
    let applied = false
    batch(() => {
      setWorkspaceRecords((records) => {
        let recordsChanged = false
        const next = records.map((workspace) => {
          let changed = false
          const researches = workspace.researches.map((research) => {
            if (research.runID !== update.sessionID) return research
            const messages = updateMessages(research.messages)
            if (messages === research.messages) return research
            applied = true
            changed = true
            return { ...research, messages }
          })
          if (changed) recordsChanged = true
          return changed ? { ...workspace, researches } : workspace
        })
        return recordsChanged ? next : records
      })
      if (runID() === update.sessionID) {
        setThreadMessages((messages) => {
          const next = updateMessages(messages)
          if (next !== messages) applied = true
          return next
        })
      }
    })
    return applied
  }

  const flushPendingVerifications = (sessionID?: string) => {
    if (!sessionID) return
    const pending = pendingVerifications.get(sessionID)
    if (!pending?.length) return
    const unresolved = pending.filter((update) => !applyVerification(update))
    if (unresolved.length) pendingVerifications.set(sessionID, unresolved)
    else pendingVerifications.delete(sessionID)
  }

  const recordVerification = (update: EngineVerificationUpdate) => {
    if (applyVerification(update)) return
    const pending = pendingVerifications.get(update.sessionID) ?? []
    const duplicate = pending.findIndex((item) => item.callID === update.callID)
    if (duplicate >= 0) pending[duplicate] = update
    else pending.push(update)
    pendingVerifications.set(update.sessionID, pending.slice(-MAX_PENDING_VERIFICATIONS_PER_SESSION))
    if (pendingVerifications.size > MAX_PENDING_VERIFICATION_SESSIONS) {
      const oldest = pendingVerifications.keys().next().value
      if (typeof oldest === "string") pendingVerifications.delete(oldest)
    }
  }

  const subscribeToVerification = () => {
    if (mode() !== "connected" || stopVerificationSubscription) return
    stopVerificationSubscription = engine.subscribeVerification?.(recordVerification)
  }

  // 当前流式回合的助手消息 id。首个 delta 到达时创建一条 streaming assistant 消息，
  // 后续 delta 就地更新同一条；终态（完成/失败/停止/换会话）清空，下一回合重新创建。
  let streamingAssistantID: number | undefined

  const upsertStreamingAssistant = (patch: { document?: string; reasoning?: string }) => {
    const id = streamingAssistantID
    const hasTarget = id !== undefined && untrack(threadMessages).some((message) => message.kind === "assistant" && message.id === id)
    // 目标消息不存在（首个 delta，或换会话已清空线程）——新建一条 streaming assistant。
    if (!hasTarget) {
      const created = makeThreadMessage({ kind: "assistant", document: patch.document ?? "", reasoning: patch.reasoning, streaming: true })
      streamingAssistantID = created.id
      setThreadMessages((messages) => [...messages, created])
      return
    }
    setThreadMessages((messages) => messages.map((message) => (
      message.kind === "assistant" && message.id === id ? { ...message, ...patch, streaming: true } : message
    )))
  }

  // 终态时定稿流式消息：去掉光标、按是否有正文决定可否导出，并把最终正文同步到研究状态
  // （syncActiveResearch effect 负责写回工作区记录，因此这里不再 append 第二条 assistant 气泡）。
  const finalizeStreamingAssistant = () => {
    const id = streamingAssistantID
    streamingAssistantID = undefined
    if (id === undefined) return false
    let finalDocument = ""
    setThreadMessages((messages) => messages.map((message) => {
      if (message.kind !== "assistant" || message.id !== id) return message
      finalDocument = message.document
      return { ...message, streaming: false, resultExportable: Boolean(message.document.trim()) }
    }))
    setResultDocument(finalDocument)
    setResultExportable(Boolean(finalDocument.trim()))
    return true
  }

  /**
   * 结果可能在研究者切换会话后才返回：它必须写回发起它的研究，不能污染当前研究，
   * 也不能因切换而丢失。只有该研究仍在前台时才同步到全局对话状态。
   */
  const recordResearchResult = (researchID: number, requestRunID: string, document: string, exportable: boolean, status: RunStatus, message: NewThreadMessage) => {
    let stored = false
    const nextMessage = makeThreadMessage(message)
    setWorkspaceRecords((records) => records.map((workspace) => workspace.id === activeWorkspaceID()
      ? {
          ...workspace,
          researches: workspace.researches.map((session) => {
            if (session.id !== researchID || session.runID !== requestRunID) return session
            stored = true
            return { ...session, messages: [...session.messages, nextMessage], resultDocument: document, resultExportable: exportable, runStatus: status }
          }),
        }
      : workspace))
    if (stored && activeResearchID() === researchID && runID() === requestRunID) {
      setThreadMessages((messages) => [...messages, nextMessage])
      setResultDocument(document)
      setResultExportable(exportable)
      setRunStatus(status)
    }
    return stored
  }

  const researchTitle = (text: string) => {
    const compact = text.replace(/\s+/g, " ").trim()
    return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact
  }

  /** 研究索引只匹配当前内存中已记录的问题与文件名，不读取所选文件夹的任何内容。 */
  const filteredResearchSessions = () => {
    const query = researchFilter().trim().toLocaleLowerCase()
    if (!query) return researchSessions()
    return researchSessions().filter((session) => {
      const terms = [
        session.title,
        session.dataset?.name,
        session.submittedPrompt,
        ...session.messages.filter((message) => message.kind === "user").map((message) => message.text),
      ]
      return terms.some((term) => term?.toLocaleLowerCase().includes(query))
    })
  }

  const activeResearch = () => researchSessions().find((session) => session.id === activeResearchID())
  const researchHeaderTitle = () => activeResearch()?.title ?? "未命名研究"

  /**
   * 用 Core 生成的会话标题替换本地的"问题前 24 字"占位标题。
   * 只改标题，不动消息与运行状态；研究已被切走时按 id 精确回填，不污染当前研究。
   */
  const renameActiveResearch = (title: string) => {
    const compact = title.replace(/\s+/g, " ").trim()
    const researchID = untrack(activeResearchID)
    if (!compact || researchID === undefined) return
    setWorkspaceRecords((records) => records.map((workspace) => ({
      ...workspace,
      researches: workspace.researches.map((session) => (
        session.id === researchID ? { ...session, title: compact } : session
      )),
    })))
  }

  const syncActiveResearch = () => {
    const activeID = activeResearchID()
    if (!activeID) return
    const nextRecords = untrack(() => workspaceRecords()).map((workspace) => workspace.id === untrack(activeWorkspaceID)
      ? { ...workspace, researches: workspace.researches.map((session) => session.id === untrack(activeResearchID) ? { ...session, messages: untrack(threadMessages), dataset: untrack(dataset), workbookSheetNames: untrack(workbookSheetNames), selectedWorkbookSheet: untrack(selectedWorkbookSheet), submittedPrompt: untrack(submittedPrompt), permissionMode: untrack(permissionMode), resultDocument: untrack(resultDocument), resultExportable: untrack(resultExportable), runStatus: untrack(runStatus), runID: untrack(runID) } : session) }
      : workspace)
    untrack(() => setWorkspaceRecords(nextRecords))
    untrack(() => persistWorkspaceRecords(nextRecords))
  }

  // 已建研究的内容只同步至当前应用内存，便于在侧栏切换时恢复。
  createEffect(() => {
    activeResearchID()
    threadMessages()
    dataset()
    workbookSheetNames()
    selectedWorkbookSheet()
    submittedPrompt()
    resultDocument()
    resultExportable()
    runStatus()
    runID()
    permissionMode()
    if (!restoringResearch) syncActiveResearch()
  })

  const ensureActiveResearch = (initialTitle: string) => {
    const existingID = activeResearchID()
    if (existingID) return existingID
    const session: ResearchSession = {
      id: ++researchSessionID,
      workspaceID: activeWorkspaceID(),
      title: researchTitle(initialTitle),
      messages: threadMessages(),
      dataset: dataset(),
      workbookSheetNames: workbookSheetNames(),
      selectedWorkbookSheet: selectedWorkbookSheet(),
      submittedPrompt: submittedPrompt(),
      permissionMode: permissionMode(),
      resultDocument: resultDocument(),
      resultExportable: resultExportable(),
      runStatus: runStatus(),
      runID: runID(),
    }
    setWorkspaceRecords((records) => records.map((workspace) => workspace.id === activeWorkspaceID()
      ? { ...workspace, researches: [session, ...workspace.researches], lastOpenedAt: Date.now() }
      : workspace))
    setActiveResearchID(session.id)
    return session.id
  }

  const startNewResearch = async () => {
    if (isPreparingSubmission() || (isRunning() && !pendingInteraction())) return
    if (!(await cancelActiveRunBeforeContextChange())) return
    closeWorkspacePanel()
    setResearchFilter("")
    setActiveResearchID(undefined)
    clearRunProgress()
    batch(() => {
      setThreadMessages([])
      setDataset(undefined)
      setWorkbookSheetNames([])
      setSelectedWorkbookSheet(undefined)
      setPrompt("")
      setSubmittedPrompt(undefined)
      setRunID(undefined)
      setResultDocument("")
      setResultExportable(false)
      setRunStatus("idle")
      clearInteraction()
      setIsRunning(false)
      setDemoResultOpen(false)
    })
    void refreshSharedUiPreferences(false)
    queueMicrotask(() => promptInput?.focus())
  }

  const openResearch = async (sessionID: number) => {
    if (isPreparingSubmission() || (isRunning() && !pendingInteraction())) return
    if (!(await cancelActiveRunBeforeContextChange())) return
    const session = researchSessions().find((item) => item.id === sessionID)
    if (!session) return
    closeWorkspacePanel()
    restoringResearch = true
    clearRunProgress()
    batch(() => {
      setActiveResearchID(session.id)
      setThreadMessages(session.messages)
      if (session.dataset) {
        // researchSessions 只保存当前进程内仍持有 File 的研究；磁盘快照恢复时
        // 已在 restoreWorkspaceSnapshot 中主动移除 dataset。因此这里可以安全恢复
        // 原始附件，不能把内存研究误判成只有元数据的历史记录。
        setDataset(session.dataset)
        setDatasetSelectionMessage(undefined)
      } else {
        setDataset(undefined)
        setDatasetSelectionMessage(undefined)
      }
      setWorkbookSheetNames(session.workbookSheetNames)
      setSelectedWorkbookSheet(session.selectedWorkbookSheet)
      if (session.runID && isPermissionMode(session.permissionMode)) setPermissionMode(permissionModeForSurface(session.permissionMode))
      setPrompt("")
      setSubmittedPrompt(session.submittedPrompt)
      setRunID(session.runID)
      setResultDocument(session.resultDocument)
      setResultExportable(session.resultExportable)
      setRunStatus(persistedRunStatus(session.runStatus))
      setIsRunning(false)
      clearInteraction()
      threadMessageID = Math.max(threadMessageID, session.messages.reduce((maximum, message) => Math.max(maximum, message.id), 0))
    })
    if (!session.runID) void refreshSharedUiPreferences(false)
    flushPendingVerifications(session.runID)
    queueMicrotask(() => {
      restoringResearch = false
      promptInput?.focus()
    })
  }

  createEffect(() => {
    const selectedTheme = theme()
    document.documentElement.dataset.theme = selectedTheme
    globalThis.localStorage?.setItem(themeStorageKey, selectedTheme)
  })

  // 授权档位在 Core session 创建时固定；已有 session 的界面会锁定该控件。
  // 推理等级仍作为 variant 随每轮 prompt 发送。
  const selectPermissionMode = (mode: PermissionMode) => {
    const selected = permissionModeForSurface(mode)
    permissionModePreferenceRevision += 1
    setPermissionMode(selected)
    globalThis.localStorage?.setItem(permissionModeStorageKey, selected)
    void saveSharedUiPreference("permissionMode", selected)
  }

  const selectReasoningEffort = (effort: ReasoningEffort) => {
    reasoningPreferenceRevision += 1
    setReasoningEffort(effort)
    globalThis.localStorage?.setItem(reasoningEffortStorageKey, effort)
    void saveSharedUiPreference("reasoningEffort", effort)
  }

  const selectTheme = (nextTheme: Theme) => {
    themePreferenceRevision += 1
    setTheme(nextTheme)
    globalThis.localStorage?.setItem(themeStorageKey, nextTheme)
    void saveSharedUiPreference("theme", nextTheme)
  }

  const saveSharedUiPreference = (
    key: SharedUiPreferenceKey,
    value: UiTheme | ReasoningEffort | PermissionMode,
    onlyIfAbsent = false,
  ): Promise<boolean> => {
    if (!props.uiPreferences) return Promise.resolve(false)
    pendingUiPreferenceWrites.add(key)
    const save = onlyIfAbsent
      ? props.uiPreferences.save(key, value, { onlyIfAbsent: true })
      : props.uiPreferences.save(key, value)
    return save
      .then((saved) => {
        setSharedUiPreferenceError(false)
        return saved
      })
      .catch(() => {
        setSharedUiPreferenceError(true)
        return false
      })
      .finally(() => pendingUiPreferenceWrites.delete(key))
  }

  const refreshSharedUiPreferences = async (seedLegacy: boolean) => {
    const preferencesStore = props.uiPreferences
    if (!preferencesStore) return
    const requestID = ++uiPreferenceReadSequence
    const themeRevision = themePreferenceRevision
    const reasoningRevision = reasoningPreferenceRevision
    const permissionModeRevision = permissionModePreferenceRevision
    const themeWasPending = pendingUiPreferenceWrites.has("theme")
    const reasoningWasPending = pendingUiPreferenceWrites.has("reasoningEffort")
    const permissionModeWasPending = pendingUiPreferenceWrites.has("permissionMode")
    try {
      let shared = await preferencesStore.load()
      if (requestID !== uiPreferenceReadSequence) return
      setSharedUiPreferenceError(false)
      const migrations: Promise<boolean>[] = []
      const legacyTheme = globalThis.localStorage?.getItem(themeStorageKey)
      const legacyEffort = globalThis.localStorage?.getItem(reasoningEffortStorageKey)
      const legacyPermissionMode = globalThis.localStorage?.getItem(permissionModeStorageKey)
      if (seedLegacy && themeRevision === themePreferenceRevision && !themeWasPending && !pendingUiPreferenceWrites.has("theme")
        && !shared.theme && (legacyTheme === "light" || legacyTheme === "dark")) {
        migrations.push(saveSharedUiPreference("theme", legacyTheme, true))
      }
      if (seedLegacy && reasoningRevision === reasoningPreferenceRevision && !reasoningWasPending && !pendingUiPreferenceWrites.has("reasoningEffort")
        && !shared.reasoningEffort && isReasoningEffort(legacyEffort)) {
        migrations.push(saveSharedUiPreference("reasoningEffort", legacyEffort, true))
      }
      if (seedLegacy && permissionModeRevision === permissionModePreferenceRevision && !permissionModeWasPending
        && !pendingUiPreferenceWrites.has("permissionMode") && !shared.permissionMode && isPermissionMode(legacyPermissionMode)) {
        migrations.push(saveSharedUiPreference("permissionMode", legacyPermissionMode, true))
      }
      if (migrations.length > 0) {
        const migrationResults = await Promise.allSettled(migrations)
        if (migrationResults.some((result) => result.status === "rejected")) setSharedUiPreferenceError(true)
        if (requestID !== uiPreferenceReadSequence) return
        shared = await preferencesStore.load()
      }
      if (requestID !== uiPreferenceReadSequence) return
      if (themeRevision === themePreferenceRevision && !themeWasPending && !pendingUiPreferenceWrites.has("theme") && isUiTheme(shared.theme)) {
        setTheme(shared.theme)
        globalThis.localStorage?.setItem(themeStorageKey, shared.theme)
      }
      if (reasoningRevision === reasoningPreferenceRevision && !reasoningWasPending && !pendingUiPreferenceWrites.has("reasoningEffort") && isReasoningEffort(shared.reasoningEffort)) {
        setReasoningEffort(shared.reasoningEffort)
        globalThis.localStorage?.setItem(reasoningEffortStorageKey, shared.reasoningEffort)
      }
      if (!runID() && !isPreparingSubmission() && permissionModeRevision === permissionModePreferenceRevision && !permissionModeWasPending
        && !pendingUiPreferenceWrites.has("permissionMode") && isPermissionMode(shared.permissionMode)) {
        const selected = permissionModeForSurface(shared.permissionMode)
        setPermissionMode(selected)
        globalThis.localStorage?.setItem(permissionModeStorageKey, selected)
      }
    } catch {
      // Shared preferences are best-effort; keep the last valid local choice when storage is unavailable.
      setSharedUiPreferenceError(true)
    }
  }

  const selectModel = (model: string) => {
    updateProviderDraftFromUser((current) => ({ ...current, model }))
  }

  const loadCommands = () => {
    void engine.commands().then(setCommands).catch(() => setCommands([]))
  }

  const applyModelProfilesSnapshot = (snapshot: ModelProfilesSnapshot, applyDefaultProjection = true, refreshCommands = true) => {
    modelProfilesRevision += 1
    setModelProfiles(snapshot)
    setProfileLoadState("ready")
    setProfileLoadError("")
    if (!applyDefaultProjection) return
    const active = snapshot.profiles.find((profile) => profile.id === snapshot.defaultProfileId)
    const next: ProviderSettings = active
      ? { provider: active.provider, model: active.model, baseURL: active.baseURL ?? undefined, smallModel: active.smallModel ?? undefined }
      : { provider: "deepseek", model: DEEPSEEK_DEFAULT_PROVIDER_MODEL }
    updateProviderDraftFromUser(next)
    setAvailableModels(active
      ? [{ id: active.model, label: modelDisplayName(active.model) }]
      : DEEPSEEK_MODELS)
    if (refreshCommands) loadCommands()
  }

  /** 只读取无密钥 profile 摘要；默认档案用于 Core 投影，API Key 不离开 Keychain。 */
  const loadProviderStatus = async (refreshCommands = true) => {
    if (!credentials.listProfiles && !credentials.getStatus) {
      setProfileLoadState("ready")
      return
    }
    const revisionAtRequest = providerDraftRevision
    const profilesRevisionAtRequest = modelProfilesRevision
    setProfileLoadState("loading")
    setProfileLoadError("")
    try {
      if (credentials.listProfiles) {
        const profiles = await withTimeout(credentials.listProfiles(), CREDENTIAL_OPERATION_TIMEOUT_MS, "读取模型档案超时")
        if (modelProfilesRevision !== profilesRevisionAtRequest) return
        applyModelProfilesSnapshot(profiles, revisionAtRequest === providerDraftRevision, refreshCommands)
        return
      }
      const status = await withTimeout(credentials.getStatus!(), CREDENTIAL_OPERATION_TIMEOUT_MS, "读取模型档案超时")
      if (revisionAtRequest !== providerDraftRevision || modelProfilesRevision !== profilesRevisionAtRequest) return
      setProviderDraft({ provider: status.provider, model: status.model, baseURL: status.baseURL ?? undefined, smallModel: status.smallModel ?? undefined })
      setAvailableModels(isDeepSeekProvider(status.provider)
        ? DEEPSEEK_MODELS
        : [{ id: status.model, label: modelDisplayName(status.model) }])
      setProfileLoadState("ready")
    } catch (error) {
      setProfileLoadState("error")
      setProfileLoadError(error instanceof Error ? error.message : "无法读取本机模型档案。")
    }
  }

  // Tauri 启动时 Core host 会在前端之后短暂就绪；有界窗口内重试，避免把
  // 正常启动过程误报成连接失败。
  const checkEngineReady = async () => {
    if (mode() !== "connected") return
    const checkVersion = ++engineCheckVersion
    setEngineStatus("checking")
    setEngineFeedback(undefined)
    // Native Core connection performs its own bounded cold-start wait. Repeating it
    // ten times would multiply the timeout into minutes when the managed sidecar is broken.
    const maximumAttempts = requireApiKey() ? 1 : 10
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      try {
        const health = await engine.health()
        if (checkVersion !== engineCheckVersion) return
        if (health.status === "ready") {
          setEngineStatus("ready")
          return
        }
      } catch {
        // Core host 尚未开始监听时会进入这里；等待后再次检查。
      }
      if (attempt + 1 < maximumAttempts) await new Promise((resolve) => window.setTimeout(resolve, 250))
      if (checkVersion !== engineCheckVersion) return
    }
    setEngineStatus("unavailable")
    setEngineFeedback({
      tone: "error",
      title: "分析核心未能就绪",
      reason: "KillStata 分析核心在启动等待期内没有响应，可能仍在初始化或已异常退出。",
      action: "点击下方重试；若反复失败，请退出并重新打开 KillStata。",
    })
  }

  const openSettings = (category: SettingsCategory = "general") => {
    if (category === "model" && mode() === "frontend" && connectionAvailable) {
      void activateConnectedMode()
      return
    }
    setWorkspacePanelOpen(false)
    setSettingsCategory(category)
    setSettingsOpen(true)
    if (mode() === "connected") {
      void refreshRuntimeDiagnostics()
      void loadProviderStatus(false)
    }
    queueMicrotask(() => settingsCloseButton?.focus())
  }

  const promptForShareWorkspace = () => {
    setConnectionMessage("请先选择一个工作区，才能提交分析。访客提交的文件会上传到主机，并保存在此工作区中。")
    setWaitingForShareWorkspace(true)
    setSettingsOpen(false)
    setWorkspacePanelOpen(true)
  }

  const activateConnectedMode = async () => {
    if (!connectionAvailable || isRunning() || isPreparingSubmission() || pendingInteraction()) return
    if (props.sharedVisitor) {
      if (activeWorkspaceID() === UNASSIGNED_WORKSPACE_ID) {
        promptForShareWorkspace()
        return
      }
      setSettingsCategory("general")
      setSettingsOpen(true)
      setConnectionMessage("")
      await loadProviderStatus(false)
      try {
        const configured = await withTimeout(
          credentials.hasApiKey(),
          CREDENTIAL_OPERATION_TIMEOUT_MS,
          "读取主机模型状态超时",
        )
        if (!configured) {
          setConnectionMessage("主机尚未配置模型。请联系分享页面所有者完成配置后重试。")
          return
        }
        setMode("connected")
        setEngineStatus("checking")
        if (credentials.prepareEngineForAnalysis) {
          await withTimeout(credentials.prepareEngineForAnalysis(), CORE_ACTIVATION_TIMEOUT_MS, "连接主机分析核心超时")
        }
        subscribeToVerification()
        loadCommands()
        await checkEngineReady()
        if (engineStatus() === "ready") setSettingsOpen(false)
      } catch {
        setConnectionMessage("无法连接分享主机的分析核心，请稍后重试或联系分享页面所有者。")
      }
      return
    }
    setMode("connected")
    setEngineStatus("checking")
    setSettingsCategory("model")
    setSettingsOpen(true)
    queueMicrotask(() => settingsCloseButton?.focus())
    await loadProviderStatus(false)
    try {
      const configured = await withTimeout(
        credentials.hasApiKey(),
        CREDENTIAL_OPERATION_TIMEOUT_MS,
        "读取模型凭据超时",
      )
      if (!configured) return
      if (credentials.prepareEngineForAnalysis) {
        await withTimeout(credentials.prepareEngineForAnalysis(), CORE_ACTIVATION_TIMEOUT_MS, "激活模型配置超时")
      }
      subscribeToVerification()
      loadCommands()
      await checkEngineReady()
    } catch (error) {
      setProfileLoadError(error instanceof Error ? error.message : "无法读取本机模型档案。")
      setProfileLoadState("error")
    }
  }

  const closeSettings = () => {
    setSettingsOpen(false)
    queueMicrotask(() => settingsTrigger?.focus())
  }

  onMount(() => {
    let mounted = true
    const refreshPreferencesOnFocus = () => {
      if (document.visibilityState === "visible") void refreshSharedUiPreferences(false)
    }
    void refreshSharedUiPreferences(true)
    window.addEventListener("focus", refreshPreferencesOnFocus)
    document.addEventListener("visibilitychange", refreshPreferencesOnFocus)
    subscribeToVerification()
    void (workspaceStore.loadEnabled?.() ?? Promise.resolve(workspaceStore.isEnabled?.() ?? false)).then((enabled) => {
      setWorkspaceHistoryEnabled(enabled)
      return restoreWorkspaceSnapshot(() => mounted)
    })
    if (mode() === "frontend") {
      // Frontend mode must render without contacting the local analysis engine or credential store.
    } else {
      void checkEngineReady()
      void loadProviderStatus()
      if (credentials.prepareEngineForAnalysis) {
        // 原生窗口启动阶段不触碰 Keychain；实际提交分析时才读取并注入密钥。
        loadCommands()
      } else {
        void credentials.hasApiKey().then((configured) => {
          if (requireApiKey() && !configured) {
            openSettings("model")
            return
          }
          loadCommands()
        }).catch(() => setEngineFeedback({
          tone: "error",
          title: "无法读取密钥状态",
          reason: "未能从本机凭据存储读取当前配置状态。",
          action: "请检查本机凭据存储后重试。",
        }))
      }
    }
    const handleGlobalKeydown = (event: KeyboardEvent) => {
      if (event.metaKey && !event.altKey && !event.ctrlKey && event.key.toLowerCase() === "o") {
        event.preventDefault()
        fileInput?.click()
        return
      }
      if (event.metaKey && !event.altKey && !event.ctrlKey && event.key === ",") {
        event.preventDefault()
        openSettings()
        return
      }
      if (event.key === "Escape") {
        closeSettings()
        setDemoResultOpen(false)
      }
    }
    window.addEventListener("keydown", handleGlobalKeydown)
    onCleanup(() => {
      stopVerificationSubscription?.()
      stopVerificationSubscription = undefined
      mounted = false
      restoringResearch = true
      engineCheckVersion += 1
      uiPreferenceReadSequence += 1
      clearRunProgress()
      window.removeEventListener("keydown", handleGlobalKeydown)
      window.removeEventListener("focus", refreshPreferencesOnFocus)
      document.removeEventListener("visibilitychange", refreshPreferencesOnFocus)
      void turnCoordinator.dispose()
    })
  })

  const refreshRuntimeDiagnostics = async () => {
    setIsCheckingRuntime(true)
    setRuntimeFeedback(undefined)
    try {
      const report = await runtimeDiagnostics.inspect()
      setRuntimeReport(report)
      if (report.python.status === "error") {
        setRuntimeFeedback({
          tone: "error",
          title: "未检测到可用 Python",
          reason: "当前本机未发现可用于分析的 Python 解释器。",
          action: report.python.suggestion || "请安装 Python 3 后重新检查本机环境。",
        })
      }
    } catch {
      setRuntimeReport(undefined)
      setRuntimeFeedback({
        tone: "error",
        title: "无法读取本机运行环境",
        reason: "KillStata 暂时无法从本机读取 Python 与分析依赖状态。",
        action: "请稍后重新检查本机环境。",
      })
    } finally {
      setIsCheckingRuntime(false)
    }
  }

  const missingRuntimePackages = () => runtimeReport()?.packages
    .filter((item) => item.status !== "ready")
    .map((item) => item.label) ?? []

  const dependencyGroups = createMemo(() => {
    const groups = new Map<string, typeof PYTHON_RUNTIME_PACKAGES[number][]>()
    const labels: Record<string, string> = { core: "核心回归", methods: "专用计量方法", prep: "数据预处理", io: "数据读写", cli: "CLI 预置能力" }
    for (const item of PYTHON_RUNTIME_PACKAGES) {
      const list = groups.get(item.group) ?? []
      list.push(item)
      groups.set(item.group, list)
    }
    return [...groups.entries()].map(([id, items]) => ({ id, label: labels[id] ?? id, items }))
  })

  const toggleRuntimeDependencyGroup = (id: string) => {
    setExpandedRuntimeDependencyGroups((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const installMissingRuntimePackages = async () => {
    if (!runtimeDiagnostics.installMissingPackages) return
    setIsInstallingRuntime(true)
    setRuntimeFeedback(undefined)
    setRuntimeInstallMessage("")
    try {
      setRuntimeReport(await runtimeDiagnostics.installMissingPackages())
      setRuntimeInstallMessage("依赖安装完成，已重新检查本机环境。")
      setRuntimeInstallConfirmationOpen(false)
    } catch {
      setRuntimeFeedback({
        tone: "error",
        title: "依赖安装未完成",
        reason: "KillStata 未能完成固定分析依赖的安装。",
        action: "请检查网络连接与 Python 配置后重试。",
      })
    } finally {
      setIsInstallingRuntime(false)
    }
  }

  const selectDatasetFile = async (file?: File) => {
    if (!file) return
    if (!supportsDatasetFile(file)) {
      setDatasetSelectionMessage({
        tone: "warning",
        title: "不支持此文件",
        reason: "当前选择的文件不是可读取的数据格式。",
        action: "请改选 CSV、Excel、Stata 或 Parquet 文件。",
      })
      return undefined
    }
    if (mode() === "connected" && hasActiveRun()) {
      if (!(await cancelActiveRunBeforeContextChange())) return undefined
    } else {
      clearInteraction()
    }
    setDatasetSelectionMessage(undefined)
    clearRunProgress()
    const selected = { name: file.name, format: datasetFormat(file.name), bytes: file.size, file }
    setDataset(selected)
    setSubmittedPrompt(undefined)
    setRunID(undefined)
    // 多工作表 Excel：读取工作表目录供附件菜单选择；超过本地预览上限时不读结构。
    setWorkbookSheetNames([])
    setSelectedWorkbookSheet(undefined)
    if ((selected.format === "XLSX" || selected.format === "XLS") && selected.bytes <= maximumLocalPreviewBytes) {
      try {
        const workbook = parseWorkbook(await selected.file.arrayBuffer())
        setWorkbookSheetNames(workbook?.sheetNames ?? [])
        setSelectedWorkbookSheet(workbook?.selectedSheetName)
      } catch {
        // 工作表目录读取失败不影响选择；分析引擎会自行处理文件。
      }
    }
    queueMicrotask(() => promptInput?.focus())
    return file
  }

  const selectDataset = async (files: FileList | null) => {
    await selectDatasetFile(files?.[0])
  }

  /** 只接受系统文件拖放；文本、链接等拖拽不会改变界面或触发数据读取。 */
  const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files")

  const handleDatasetDragEnter = (event: DragEvent) => {
    if (!isFileDrag(event) || settingsOpen()) return
    event.preventDefault()
    setIsDataDropTarget(true)
  }

  const handleDatasetDragOver = (event: DragEvent) => {
    event.preventDefault()
    if (!isFileDrag(event) || settingsOpen()) return
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
  }

  const handleDatasetDragLeave = (event: DragEvent) => {
    if (!isFileDrag(event)) return
    const currentTarget = event.currentTarget as HTMLElement
    if (!currentTarget.contains(event.relatedTarget as Node | null)) setIsDataDropTarget(false)
  }

  const handleDatasetDrop = (event: DragEvent) => {
    event.preventDefault()
    setIsDataDropTarget(false)
    if (!isFileDrag(event) || settingsOpen()) return
    void selectDataset(event.dataTransfer?.files ?? null)
  }

  const selectWorkspace = async () => {
    if (!(await cancelActiveRunBeforeContextChange())) return
    let picked: Awaited<ReturnType<WorkspacePicker>>
    try {
      picked = await props.workspacePicker?.()
    } catch (error) {
      setWorkspacePersistenceFeedback(error instanceof Error ? error.message : "无法选择或保存工作区，请重试。")
      return
    }
    if (!picked) return
    setWorkspacePersistenceFeedback(undefined)
    const normalizedPath = typeof picked === "string" ? picked.replace(/[\\/]+$/, "") : picked.id
    const folderName = typeof picked === "string" ? normalizedPath.split(/[\\/]/).filter(Boolean).at(-1) : picked.name
    if (!folderName) return
    const id = typeof picked === "string" ? workspaceIDFromPath(normalizedPath) : picked.id
    const existing = workspaceRecords().find((workspace) => workspace.id === id)
    const selectedWorkspace: WorkspaceRecord = existing ?? { id, name: folderName, lastOpenedAt: Date.now(), researches: [] }
    const records = existing
      ? workspaceRecords().map((workspace) => workspace.id === id ? { ...workspace, name: folderName, lastOpenedAt: Date.now() } : workspace)
      : [...workspaceRecords(), selectedWorkspace]
    setWorkspaceRecords(records)
    setActiveWorkspaceID(id)
    setWorkspaceName(folderName)
    setWorkspacePanelOpen(false)
    setConnectionMessage("")
    const savedResearches = selectedWorkspace.researches
    restoringResearch = true
    batch(() => {
      setActiveResearchID(savedResearches[0]?.id)
      setThreadMessages(savedResearches[0]?.messages ?? [])
      setDataset(savedResearches[0]?.dataset)
      setDatasetSelectionMessage(undefined)
      setWorkbookSheetNames(savedResearches[0]?.workbookSheetNames ?? [])
      setSelectedWorkbookSheet(savedResearches[0]?.selectedWorkbookSheet)
      setPrompt("")
      setSubmittedPrompt(savedResearches[0]?.submittedPrompt)
      setRunID(savedResearches[0]?.runID)
      if (savedResearches[0]?.runID && isPermissionMode(savedResearches[0].permissionMode)) {
        setPermissionMode(permissionModeForSurface(savedResearches[0].permissionMode))
      }
      setResultDocument(savedResearches[0]?.resultDocument ?? "")
      setResultExportable(savedResearches[0]?.resultExportable ?? false)
      setRunStatus(savedResearches[0] ? persistedRunStatus(savedResearches[0].runStatus) : "idle")
      clearInteraction()
      setIsRunning(false)
    })
    if (!savedResearches[0]?.runID) void refreshSharedUiPreferences(false)
    persistWorkspaceRecords(records, id)
    queueMicrotask(() => {
      restoringResearch = false
      promptInput?.focus()
      if (props.sharedVisitor && waitingForShareWorkspace()) {
        setWaitingForShareWorkspace(false)
        void activateConnectedMode()
      }
    })
  }

  const switchWorkspace = async (workspace: WorkspaceRecord) => {
    if (workspace.id === activeWorkspaceID()) return
    if (!(await cancelActiveRunBeforeContextChange())) return
    if (props.sharedVisitor && workspace.id !== UNASSIGNED_WORKSPACE_ID && props.workspaceRebinder) {
      try {
        await props.workspaceRebinder({ id: workspace.id, name: workspace.name })
      } catch {
        setWorkspacePersistenceFeedback("无法恢复已保存的访客工作区，请重新选择该目录后重试。")
        return
      }
    }
    const latest = workspace.researches[0]
    setActiveWorkspaceID(workspace.id)
    setWorkspaceName(workspace.id === UNASSIGNED_WORKSPACE_ID ? undefined : workspace.name)
    restoringResearch = true
    batch(() => {
      setActiveResearchID(latest?.id)
      setThreadMessages(latest?.messages ?? [])
      setDataset(latest?.dataset)
      setDatasetSelectionMessage(undefined)
      setWorkbookSheetNames(latest?.workbookSheetNames ?? [])
      setSelectedWorkbookSheet(latest?.selectedWorkbookSheet)
      setSubmittedPrompt(latest?.submittedPrompt)
      setResultDocument(latest?.resultDocument ?? "")
      setResultExportable(latest?.resultExportable ?? false)
      setRunStatus(latest ? persistedRunStatus(latest.runStatus) : "idle")
      setRunID(latest?.runID)
      if (latest?.runID && isPermissionMode(latest.permissionMode)) setPermissionMode(permissionModeForSurface(latest.permissionMode))
      clearInteraction()
      setIsRunning(false)
    })
    if (!latest?.runID) void refreshSharedUiPreferences(false)
    persistWorkspaceRecords(workspaceRecords(), workspace.id)
    queueMicrotask(() => { restoringResearch = false; promptInput?.focus() })
  }

  const selectWorkspaceFile = async () => {
    const file = await props.workspaceFilePicker?.(activeWorkspaceID())
    return selectDatasetFile(file)
  }

  const clearWorkspace = async () => {
    if (isPreparingSubmission() || (isRunning() && !pendingInteraction())) return
    if (!(await cancelActiveRunBeforeContextChange())) return
    const unassigned = workspaceRecords().find((workspace) => workspace.id === UNASSIGNED_WORKSPACE_ID) ?? { id: UNASSIGNED_WORKSPACE_ID, name: "未归档研究", lastOpenedAt: Date.now(), researches: [] }
    const records = workspaceRecords().some((workspace) => workspace.id === UNASSIGNED_WORKSPACE_ID) ? workspaceRecords() : [...workspaceRecords(), unassigned]
    setActiveWorkspaceID(UNASSIGNED_WORKSPACE_ID)
    setWorkspaceName(undefined)
    setActiveResearchID(undefined)
    setThreadMessages([])
    setDataset(undefined)
    setSubmittedPrompt(undefined)
    setRunID(undefined)
    setResultDocument("")
    setResultExportable(false)
    setRunStatus("idle")
    clearInteraction()
    setWorkspaceRecords(records)
    persistWorkspaceRecords(records, UNASSIGNED_WORKSPACE_ID)
  }

  const selectWorkbookSheet = (sheetName: string) => {
    setSelectedWorkbookSheet(sheetName)
    appendThreadMessage({ kind: "system", message: `已切换到工作表「${sheetName}」，新分析将使用该工作表。`, tone: "info" })
  }

  const clearDataset = async () => {
    if (!(await cancelActiveRunBeforeContextChange())) return
    clearRunProgress()
    setDataset(undefined)
    setWorkbookSheetNames([])
    setSelectedWorkbookSheet(undefined)
    setPrompt("")
    setSubmittedPrompt(undefined)
    setRunStatus("idle")
    setRunID(undefined)
    setIsRunning(false)
  }

  const clearInteraction = () => {
    setPendingInteraction(undefined)
    setInteractionError(undefined)
    setInteractionBusy(false)
  }

  const hasActiveRun = () => isRunning() || pendingInteraction() !== undefined || runStatus() === "preparing" || runStatus() === "running" || runStatus() === "waiting_for_user"

  /** 上下文切换前必须先让引擎确认旧任务停止，避免旧 run 继续等待或消费模型资源。 */
  const cancelActiveRunBeforeContextChange = async () => {
    if (!hasActiveRun()) {
      clearInteraction()
      return true
    }
    const id = runID()
    if (!id) {
      setCancellationFeedback({
        tone: "warning",
        title: "暂时无法切换研究上下文",
        reason: "当前分析仍在准备中，尚未获得可取消的任务标识。",
        action: "请稍候，收到分析任务已建立的提示后再切换。",
      })
      return false
    }
    try {
      await turnCoordinator.cancel()
    } catch {
      setCancellationFeedback({
        tone: "error",
        title: "未能安全切换研究上下文",
        reason: "分析核心没有确认旧任务已停止。",
        action: "请先停止当前分析，确认后再切换数据或研究。",
      })
      return false
    }
    clearRunProgress()
    clearInteraction()
    setRunID(undefined)
    setRunStatus("cancelled")
    setIsRunning(false)
    return true
  }

  /** Turn Coordinator 已处理生命周期；这里仅把新事件投影为研究者可见消息。 */
  const projectTurnEvent = (event: EngineRunEvent) => {
    if (event.type === "verification") {
      if (engine.subscribeVerification) return
      upsertProgress(event.message, {
        id: `verification:${event.callID}`, label: "独立核验", phase: "analysis",
        status: event.status === "block" ? "failed" : "completed",
      })
      return
    }
    if (event.type === "progress") {
      recordProgressUpdate()
      if (event.step) upsertProgress(event.message, event.step)
      return
    }
    if (event.type === "assistant_delta") {
      upsertStreamingAssistant({ document: event.text })
      return
    }
    if (event.type === "reasoning_delta") {
      upsertStreamingAssistant({ reasoning: event.text })
      return
    }
    if (event.type === "title") {
      renameActiveResearch(event.title)
      return
    }
    if (event.type === "question") {
      clearRunProgress()
      setPendingInteraction({ kind: "question", question: event.question })
      setInteractionError(undefined)
      return
    }
    if (event.type === "permission") {
      clearRunProgress()
      setPendingInteraction({ kind: "permission", permission: event.permission })
      setInteractionError(undefined)
      return
    }
    if (event.type === "waiting") {
      clearRunProgress()
      return
    }
    if (event.type === "completed") {
      clearRunProgress()
      clearInteraction()
      // 有流式消息就原地定稿；没有（v1 引擎、纯 reasoning、demo fallback）才回退到一次性拉全文。
      if (!finalizeStreamingAssistant()) void loadResultIntoThread()
      return
    }
    if (event.type === "failed") {
      clearRunProgress()
      clearInteraction()
      finalizeStreamingAssistant()
      const message = turnCoordinator.snapshot().runId
        ? event.message
        : submissionFailureFeedback(new Error(event.message)).reason
      appendThreadMessage({ kind: "system", message, tone: "error" })
      return
    }
    clearRunProgress()
    clearInteraction()
    finalizeStreamingAssistant()
    appendThreadMessage({ kind: "system", message: event.message, tone: "warning" })
  }

  const desktopRunStatus = (status: TurnStatus): RunStatus => {
    if (status === "queued" || status === "starting") return "preparing"
    if (status === "waiting_for_user") return "waiting_for_user"
    if (status === "completed" || status === "failed" || status === "cancelled" || status === "idle") return status
    return "running"
  }

  const applyTurnSnapshot = (snapshot: TurnSnapshot) => {
    setRunStatus(desktopRunStatus(snapshot.status))
    setIsRunning(snapshot.status === "starting" || snapshot.status === "running")
    // runId 实际是 Core sessionID。停止一轮只终止当前生成，不应删除整项研究
    // 的历史、数据阶段和工具窗口；真正切换研究/数据时由对应入口显式清空。
    if (snapshot.runId) {
      setRunID(snapshot.runId)
      flushPendingVerifications(snapshot.runId)
    }

    if (snapshot.eventSequence <= appliedTurnEventSequence || !snapshot.lastEvent) return
    appliedTurnEventSequence = snapshot.eventSequence
    projectTurnEvent(snapshot.lastEvent)
  }

  // Coordinator 在组件构造期就订阅，确保 promptAsync accepted 与 UI 订阅之间的
  // 早到事件能通过同一个客户端 Turn 路径投影到消息流。
  turnCoordinator.subscribe(applyTurnSnapshot)

  const submitInteraction = async (answer: import("./engine/client").EngineInteractionAnswer) => {
    const interaction = pendingInteraction()
    const id = runID()
    if (!interaction || !id || !engine.answerInteraction) return
    const requestID = interaction.kind === "question" ? interaction.question.requestId : interaction.permission.requestId
    setInteractionBusy(true)
    setInteractionError(undefined)
    try {
      await turnCoordinator.answer(requestID, answer)
      clearInteraction()
      startRunProgress()
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : "这次回答没有被接受，请重试。")
      setInteractionBusy(false)
    }
  }

  const denyInteraction = async () => {
    const interaction = pendingInteraction()
    const id = runID()
    if (!interaction || !id || !engine.denyInteraction) return
    const requestID = interaction.kind === "question" ? interaction.question.requestId : interaction.permission.requestId
    setInteractionBusy(true)
    setInteractionError(undefined)
    try {
      await turnCoordinator.deny(requestID, "研究者拒绝")
      clearInteraction()
      clearRunProgress()
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : "拒绝操作没有生效，请重试。")
      setInteractionBusy(false)
    }
  }
  const loadResultIntoThread = async () => {
    const id = runID()
    const researchID = activeResearchID()
    if (!id || !researchID) return
    try {
      const result = await engine.getResult(id)
      if (result.status === "completed" && result.document?.trim()) {
        recordResearchResult(researchID, id, result.document, true, "completed", { kind: "assistant", document: result.document, resultExportable: true })
      } else {
        recordResearchResult(researchID, id, result.document ?? "", false, "failed", { kind: "system", message: "分析未生成可阅读的结果文档。", tone: "warning" })
      }
    } catch {
      recordResearchResult(researchID, id, "", false, "failed", { kind: "system", message: "无法读取分析结果；请稍后重试。", tone: "error" })
    }
  }

  const submitPrompt = async () => {
    if (isPreparingSubmission()) return
    const text = prompt().trim()
    const selectedDataset = dataset()
    if (!text) return
    const invocation = parseSlashInvocation(text)
    if (text.startsWith("/") && !invocation) {
      showSystemMessage("斜杠命令格式无效，请使用 /命令名 [参数]。", "warning")
      return
    }
    const slash = normalizeSlashCommand(text)
    const slashDefinition = slash ? desktopSlashCommandCatalog().find((command) => command.name === slash.name) : undefined
    if (slash && slashDefinition && slashDefinition.execution !== "core-command") {
      if (slashDefinition.argumentMode === "none" && slash.arguments.trim()) {
        showSystemMessage(`/${slash.name} 不接受参数，请移除多余内容后重试。`, "warning")
        return
      }
      setPrompt("")
      await handleSlashCommand(slash.name, slash.arguments)
      return
    }
    const commandResolution = selectedEngineCommand(text, commands())
    if (commandResolution.error) {
      showSystemMessage(commandResolution.error, "warning")
      return
    }
    if (invocation && !slashDefinition && !commandResolution.command) {
      showSystemMessage(`/${invocation.name} 不在当前可用命令目录中，未发送请求。`, "warning")
      return
    }
    if (slashDefinition?.execution === "core-command" && !commandResolution.command) {
      showSystemMessage(`/${slashDefinition.name} 当前不在 Core 可执行命令目录中，未发送请求。`, "warning")
      return
    }
    if (props.sharedVisitor && mode() === "connected" && activeWorkspaceID() === UNASSIGNED_WORKSPACE_ID) {
      promptForShareWorkspace()
      return
    }
    if (!runID()) await refreshSharedUiPreferences(false)
    setIsPreparingSubmission(true)
    try {
      if (requireApiKey()) {
        try {
          const configured = await withTimeout(
            credentials.hasApiKey(),
            CREDENTIAL_OPERATION_TIMEOUT_MS,
            "读取模型凭据超时",
          )
          if (!configured) {
            setSettingsOpen(true)
            setSettingsCategory("model")
            void loadProviderStatus()
            return
          }
          if (credentials.prepareEngineForAnalysis) {
            await withTimeout(
              credentials.prepareEngineForAnalysis(),
              CORE_ACTIVATION_TIMEOUT_MS,
              "激活模型配置超时",
            )
          }
          await checkEngineReady()
          if (engineStatus() !== "ready") return
        } catch (error) {
          const message = error instanceof Error ? error.message : ""
          const credentialTimeout = /钥匙串|凭据|keychain|credential/i.test(message)
          const feedback: LocalFeedback = credentialTimeout
            ? {
                tone: "error",
                title: "本机凭据存储没有响应",
                reason: "读取或激活模型凭据超过了等待时间，分析请求尚未发送。",
                action: "请检查本机凭据存储，或打开设置重新保存模型配置后重试。",
              }
            : {
                tone: "error",
                title: "无法读取密钥状态",
                reason: "未能从本机凭据存储读取当前配置状态。",
                action: "请检查本机凭据存储后重试。",
              }
          if (!credentialTimeout) setEngineStatus("unavailable")
          setSubmissionFeedback(feedback)
          return
        }
      }
      ensureActiveResearch(text)
      appendThreadMessage({
        kind: "user",
        text,
        datasetName: selectedDataset?.name,
        worksheetName: selectedDataset ? selectedWorkbookSheet() : undefined,
      })
      setSubmittedPrompt(text)
      setPrompt("")
      setSubmissionFeedback(undefined)
      setCancellationFeedback(undefined)
      if (mode() === "frontend") {
        setRunStatus("completed")
        setIsRunning(false)
        appendThreadMessage({ kind: "system", message: "研究信息已记录，尚未执行统计分析。", tone: "info" })
        appendThreadMessage({ kind: "assistant", document: frontendResearchReceipt, resultExportable: false })
        return
      }
      if (engineStatus() === "unavailable") {
        appendThreadMessage({ kind: "system", message: "分析核心当前不可用，请求未发送。", tone: "error" })
        return
      }
      clearInteraction()
      setRunStatus("preparing")
      setIsRunning(true)

      try {
        const uploadedDataset = selectedDataset ? await engine.uploadDataset(selectedDataset.file) : undefined
        const continuedSessionID = runID()
        streamingAssistantID = undefined
        appliedTurnEventSequence = 0
        await turnCoordinator.submit({
          prompt: text,
          sessionID: runID(),
          dataset: uploadedDataset,
          worksheetName: selectedDataset ? selectedWorkbookSheet() : undefined,
          command: commandResolution.command,
          model: selectedCoreModel(providerDraft().provider, providerDraft().model),
          permission: permissionRuleset(permissionMode()),
          effort: reasoningEffort() === "default" ? undefined : reasoningEffort(),
        })
        if (continuedSessionID) revertedTurns.delete(continuedSessionID)
      } catch (error) {
        clearRunProgress()
        setRunStatus("failed")
        setIsRunning(false)
        const feedback = submissionFailureFeedback(error)
        // Coordinator 在 startRun 失败时已经投影了 failed 事件；提交层只补充
        // 可操作的反馈状态，避免同一错误在消息流中出现两次。
        if (turnCoordinator.snapshot().status !== "failed") {
          appendThreadMessage({ kind: "system", message: feedback.reason, tone: "error" })
        }
        setSubmissionFeedback(feedback)
      }
    } finally {
      setIsPreparingSubmission(false)
    }
  }

  /**
   * 提交失败按真实原因分诊，不把所有失败都说成"引擎连接问题"。
   * 缺少密钥、额度不足、附件超限都是可操作的具体故障，必须指向对应的处理动作。
   */
  const submissionFailureFeedback = (error: unknown): LocalFeedback => {
    const raw = error instanceof Error && error.message ? error.message.trim() : ""
    const lowered = raw.toLowerCase()
    if (/api[ _-]?key|unauthorized|未配置|401/.test(lowered) || lowered.includes("no such provider")) {
      return {
        tone: "error",
        title: "尚未配置 API Key",
        reason: "当前模型提供商还没有可用的 API Key，请求没有发出。",
        action: "打开设置 → 模型，填写并保存 API Key 后重新发送。",
      }
    }
    if (/insufficient balance|quota|余额|额度|402|429/.test(lowered)) {
      return {
        tone: "error",
        title: "模型额度不足",
        reason: "模型服务返回额度或余额不足，本次请求未能执行。",
        action: "请到模型服务商充值或更换可用模型后重试。",
      }
    }
    if (/too large|payload|413|文件过大/.test(lowered)) {
      return {
        tone: "error",
        title: "数据文件过大",
        reason: "所选数据文件超出单次提交上限，未能上传。",
        action: "请改用更小的数据文件，或先在本地裁剪需要的变量与年份。",
      }
    }
    return {
      tone: "error",
      title: "请求未能提交",
      reason: raw || "提交过程中出现未预期的错误，请求没有完成。",
      action: "请重试；若反复出现，请到设置 → 运行环境查看诊断信息。",
    }
  }

  const stopRun = async () => {
    if (isCancellingRun()) return
    const id = runID()
    setCancellationFeedback(undefined)
    if (!id) {
      setCancellationFeedback({
        tone: "warning",
        title: "暂时无法停止分析",
        reason: "分析请求仍在准备中，尚未获得可取消的任务标识。",
        action: "请稍候，收到分析任务已建立的提示后再停止。",
      })
      return
    }
    setIsCancellingRun(true)
    try {
      await turnCoordinator.cancel()
      clearRunProgress()
      clearInteraction()
    } catch {
      setCancellationFeedback({
        tone: "error",
        title: "无法确认分析已停止",
        reason: "分析核心没有确认本次取消请求。",
        action: "请稍后再次点击停止。",
      })
    } finally {
      setIsCancellingRun(false)
    }
  }

  const openResult = async () => {
    if (mode() === "frontend") {
      setResultTitle("完整结果")
      setResultDocument(frontendResearchReceipt)
      setResultExportable(false)
      setResultFeedback(undefined)
      setDemoResultOpen(true)
      return
    }
    const id = runID()
    const researchID = activeResearchID()
    setResultTitle("完整结果")
    if (!id) {
      setResultDocument("尚未生成可阅读的结果文档。")
      setResultExportable(false)
      setResultFeedback(undefined)
      setDemoResultOpen(true)
      return
    }
    setResultDocument("正在读取分析结果…")
    setResultExportable(false)
    setResultFeedback(undefined)
    setDemoResultOpen(true)
    const isCurrentResult = () => runID() === id && activeResearchID() === researchID
    try {
      const result = await engine.getResult(id)
      if (!isCurrentResult()) return
      setResultDocument(result.document ?? "分析尚未生成可阅读的结果文档。")
      setResultExportable(result.status === "completed" && Boolean(result.document?.trim()))
    } catch {
      if (!isCurrentResult()) return
      setResultDocument("")
      setResultFeedback({
        tone: "error",
        title: "无法读取分析结果",
        reason: "本次分析没有产出可阅读的结果文档。",
        action: "请稍后重新打开完整结果。",
      })
    }
  }

  const exportResultDocument = (result: string) => {
    if (!result.trim() || !resultExportable()) return
    const selectedDataset = dataset()
    const analysisPrompt = submittedPrompt()
    if (!selectedDataset || !analysisPrompt) return
    const report = createMarkdownReport({
      datasetName: selectedDataset.name,
      prompt: analysisPrompt,
      document: result.trim(),
      generatedAt: new Date(),
    })
    const url = URL.createObjectURL(new Blob([report], { type: "text/markdown;charset=utf-8" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "killstata-analysis-result.md"
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const exportResult = () => {
    const document = resultDocument().trim()
    if (!resultExportable() || !document) {
      showSystemMessage("当前研究尚未生成可导出的计量结果。", "warning")
      return
    }
    if (!dataset() || !submittedPrompt()?.trim()) {
      showSystemMessage("当前结果缺少数据文件或研究问题关联，未生成导出文件。", "warning")
      return
    }
    exportResultDocument(document)
  }

  const showSystemMessage = (message: string, tone: "info" | "warning" | "error" = "info") => {
    appendThreadMessage({ kind: "system", message, tone })
  }

  const contextSummary = (snapshot: Record<string, unknown>) => {
    const usage = snapshot.usage as Record<string, unknown> | undefined
    const reference = snapshot.referenceContext as Record<string, unknown> | undefined
    const used = typeof usage?.usedTokens === "number" ? usage.usedTokens.toLocaleString() : "未知"
    const budget = typeof usage?.inputBudget === "number" ? usage.inputBudget.toLocaleString() : "未知"
    const remaining = typeof usage?.remainingTokens === "number" ? usage.remainingTokens.toLocaleString() : "未知"
    const percentage = typeof usage?.percentage === "number" ? `${usage.percentage}%` : "未知"
    const compaction = typeof usage?.compactionState === "string" ? usage.compactionState : "无"
    const stage = typeof reference?.activeStageId === "string" ? reference.activeStageId : "未确定"
    return `上下文状态：已用 ${used} / ${budget} tokens，剩余 ${remaining}，占用 ${percentage}；压缩状态：${compaction}；当前数据阶段：${stage}。`
  }

  const writeClipboardText = async (text: string) => {
    try {
      if (typeof navigator.clipboard?.writeText === "function") {
        await navigator.clipboard.writeText(text)
        return
      }
    } catch {
      // Insecure LAN origins do not expose the async Clipboard API; try the browser copy command.
    }
    const fallback = document.createElement("textarea")
    fallback.value = text
    fallback.setAttribute("readonly", "")
    fallback.style.position = "fixed"
    fallback.style.left = "-9999px"
    document.body.append(fallback)
    let copied = false
    try {
      fallback.select()
      copied = document.execCommand?.("copy") === true
    } finally {
      fallback.remove()
    }
    if (!copied) throw new Error("Clipboard access is unavailable")
  }

  const copyThread = async () => {
    const text = threadMessages().map((message) => {
      if (message.kind === "user") return `用户：${message.text}`
      if (message.kind === "assistant") return `KillStata：${message.document}`
      if (message.kind === "progress") return `进度：${message.message}`
      return `系统：${message.message}`
    }).join("\n\n")
    if (!text.trim()) {
      showSystemMessage("当前会话没有可复制的内容。", "warning")
      return
    }
    try {
      await writeClipboardText(text)
      showSystemMessage("当前会话内容已复制到剪贴板。")
    } catch {
      showSystemMessage("复制会话内容失败，请检查应用或浏览器的剪贴板权限。", "error")
    }
  }

  const closeDesktop = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("exit_desktop")
    } catch {
      showSystemMessage("当前运行环境不允许退出 KillStata Desktop。", "warning")
    }
  }

  // —— 斜杠命令 ——
  const handleSlashCommand = async (name: string, args = "") => {
    const normalized = name.toLowerCase()
    const definition = desktopSlashCommandCatalog().find((command) => command.name === normalized || command.aliases?.includes(normalized))
    if (definition?.argumentMode === "none" && args.trim()) {
      showSystemMessage(`/${definition.name} 不接受参数，请移除多余内容后重试。`, "warning")
      return
    }
    if (normalized === "new" || normalized === "clear") return startNewResearch()
    if (normalized === "config" || normalized === "connect" || normalized === "settings") return openSettings("model")
    if (normalized === "themes") return openSettings("general")
    if (normalized === "model" || normalized === "models") return openSettings("model")
    if (normalized === "sessions" || normalized === "resume" || normalized === "continue") {
      openWorkspacePanel()
      if (!researchSessions().length) return showSystemMessage("最近研究列表已打开；当前没有已保存的研究。")
      queueMicrotask(() => workspaceDrawer?.querySelector<HTMLButtonElement>(".research-session")?.focus())
      return
    }
    if (normalized === "help") {
      const names = slashCommands().map((command) => `/${command.name}`).join("、")
      return showSystemMessage(`可用命令：${names}`)
    }
    if (normalized === "export") return exportResult()
    if (normalized === "results") return openResult()
    if (normalized === "exit" || normalized === "quit" || normalized === "q") return closeDesktop()
    if (normalized === "thinking" || normalized === "toggle-thinking") {
      setShowThinking((current) => !current)
      return showSystemMessage(`思考过程默认${showThinking() ? "展开" : "收起"}。`)
    }
    if (normalized === "timestamps" || normalized === "toggle-timestamps") {
      setShowTimestamps((current) => !current)
      return showSystemMessage(`消息时间${showTimestamps() ? "已显示" : "已隐藏"}。`)
    }
    if (normalized === "reasoning") {
      const requested = args.trim().toLowerCase()
      if (!requested || requested === "default" || requested === "off") {
        if (requested) {
          selectReasoningEffort("default")
          return showSystemMessage("已恢复模型默认推理策略，下一轮请求生效。")
        }
        const label = REASONING_EFFORTS.find((item) => item.id === reasoningEffort())?.label ?? "默认"
        return showSystemMessage(`当前推理等级：${label}。可用值：default、low、medium、high。`)
      }
      if (!isReasoningEffort(requested)) return showSystemMessage("推理等级无效，可用值：low、medium、high。", "warning")
      selectReasoningEffort(requested)
      return showSystemMessage(`推理等级已设为 ${requested}，下一轮请求生效。`)
    }
    const sessionID = runID()
    if (!sessionID) return showSystemMessage(`/${normalized} 需要先建立一个 Core 会话。`, "warning")
    const serializesSessionState = normalized === "compact" || normalized === "summarize"
      || normalized === "rename" || normalized === "undo" || normalized === "redo"
    if (serializesSessionState && (isPreparingSubmission() || isRunning() || pendingInteraction())) {
      return showSystemMessage(`当前 Core 会话仍有操作进行中，暂不能执行 /${normalized}。`, "warning")
    }
    if (serializesSessionState) setIsPreparingSubmission(true)
    try {
      if (normalized === "context") {
        if (!engine.context) throw new Error("当前引擎不支持读取上下文状态")
        return showSystemMessage(contextSummary(await engine.context(sessionID)))
      }
      if (normalized === "copy") return copyThread()
      if (normalized === "compact" || normalized === "summarize") {
        if (!engine.summarize) throw new Error("当前引擎不支持会话压缩")
        const model = providerDraft()
        const selectedModel = selectedCoreModel(model.provider, model.model)
        if (!selectedModel) throw new Error("当前没有可用于压缩会话的模型")
        await engine.summarize(sessionID, selectedModel, args)
        return showSystemMessage("上下文压缩已完成，当前会话继续使用最新摘要。")
      }
      if (normalized === "rename") {
        const title = args.trim() || window.prompt("重命名当前研究", researchHeaderTitle())?.trim()
        if (!title) return showSystemMessage("未提供新的研究标题。", "warning")
        if (!engine.updateTitle) throw new Error("当前引擎不支持重命名会话")
        await engine.updateTitle(sessionID, title)
        renameActiveResearch(title)
        return showSystemMessage(`研究标题已修改为“${title}”。`)
      }
      if (normalized === "undo") {
        if (!engine.revertLatest) throw new Error("当前引擎不支持撤销会话")
        const current = threadMessages()
        let userIndex = -1
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (current[index]?.kind === "user") {
            userIndex = index
            break
          }
        }
        const userMessage = userIndex >= 0 ? current[userIndex] : undefined
        if (!userMessage || userMessage.kind !== "user") throw new Error("当前桌面会话没有可撤销的用户消息")
        const remaining = current.slice(0, userIndex)
        const snapshot: RevertedTurnSnapshot = {
          messages: current.slice(userIndex),
          resultDocument: resultDocument(),
          resultExportable: resultExportable(),
          runStatus: runStatus(),
          submittedPrompt: submittedPrompt(),
        }
        await engine.revertLatest(sessionID)
        const history = revertedTurns.get(sessionID) ?? []
        history.push(snapshot)
        revertedTurns.set(sessionID, history)
        setThreadMessages(remaining)
        setPrompt(userMessage.text)
        const previousAssistant = [...remaining].reverse().find((message) => message.kind === "assistant")
        const previousUser = [...remaining].reverse().find((message) => message.kind === "user")
        setResultDocument(previousAssistant?.kind === "assistant" ? previousAssistant.document : "")
        setResultExportable(previousAssistant?.kind === "assistant" && previousAssistant.resultExportable === true)
        setSubmittedPrompt(previousUser?.kind === "user" ? previousUser.text : undefined)
        setRunStatus(previousAssistant ? "completed" : "idle")
        return showSystemMessage("已撤销上一条用户消息及其对应的数据状态；原问题已恢复到输入框。")
      }
      if (normalized === "redo") {
        if (!engine.unrevert) throw new Error("当前引擎不支持重做会话")
        await engine.unrevert(sessionID)
        const history = revertedTurns.get(sessionID) ?? []
        const snapshot = history.pop()
        if (history.length) revertedTurns.set(sessionID, history)
        else revertedTurns.delete(sessionID)
        if (snapshot) {
          setThreadMessages((current) => [...current, ...snapshot.messages])
          setResultDocument(snapshot.resultDocument)
          setResultExportable(snapshot.resultExportable)
          setRunStatus(snapshot.runStatus)
          setSubmittedPrompt(snapshot.submittedPrompt)
          setPrompt("")
        } else {
          const latest = await engine.getResult(sessionID)
          if (latest.status === "completed" && latest.document?.trim()) {
            const current = threadMessages()
            const lastAssistant = [...current].reverse().find((message) => message.kind === "assistant")
            if (lastAssistant?.kind !== "assistant" || lastAssistant.document !== latest.document) {
              appendThreadMessage({ kind: "assistant", document: latest.document, resultExportable: true })
            }
            setResultDocument(latest.document)
            setResultExportable(true)
            setRunStatus("completed")
          } else {
            showSystemMessage("Core 已恢复撤销状态，但桌面没有这条消息的本地副本；请重新打开研究记录核对。", "warning")
          }
        }
        return showSystemMessage("已恢复刚才撤销的消息状态。")
      }
    } catch (error) {
      showSystemMessage(error instanceof Error ? error.message : `/${normalized} 执行失败。`, "error")
    } finally {
      if (serializesSessionState) setIsPreparingSubmission(false)
    }
  }

  const slashCommands = (): SlashCommand[] => {
    const catalogue = commands()
    const localDefinitions = desktopSlashCommandCatalog().filter((command) => command.source === "local")
    const localNames = new Set(localDefinitions.flatMap((command) => [command.name, ...(command.aliases ?? [])]))
    const engineCommands = catalogue
      .filter((command) => !command.blockedReason && command.advanced !== true && !localNames.has(command.name.replace(/^\/+/, "")))
      .map((command) => ({
        name: command.name.replace(/^\/+/, ""),
        description: command.description,
        hints: command.hints,
        source: "engine" as const,
      }))
    const engineNames = new Set(engineCommands.map((command) => command.name))
    const localCommands = localDefinitions
      .filter((command) => !engineNames.has(command.name))
      .flatMap((command) => [command.name, ...(command.aliases ?? [])].map((name) => ({ name, description: command.description, source: "local" as const })))
    return [
      ...localCommands,
      ...engineCommands,
    ]
  }

  const engineStatusLabel = () => {
    if (mode() === "frontend") return "本地体验模式，未连接分析核心"
    if (engineStatus() === "ready") return "分析核心就绪"
    if (engineStatus() === "unavailable") return "分析核心不可用"
    return "正在启动分析核心"
  }

  return (
    <main
      class="app-shell"
      classList={{ "is-data-drop-target": isDataDropTarget() }}
      onDragEnter={handleDatasetDragEnter}
      onDragOver={handleDatasetDragOver}
      onDragLeave={handleDatasetDragLeave}
      onDrop={handleDatasetDrop}
    >
      <Show when={isDataDropTarget()}>
        <div class="data-drop-overlay" role="status" aria-label="松开以选择本地数据">
          <strong>松开以选择本地数据</strong>
          <span>支持 CSV、Excel、Stata 或 Parquet</span>
        </div>
      </Show>
      <Show when={workspacePanelOpen()}>
        <div class="workspace-scrim" aria-hidden="true" onClick={closeWorkspacePanel} />
      </Show>
      <aside
        ref={(element) => { workspaceDrawer = element }}
        id={workspaceDrawerID}
        class="workspace-rail"
        classList={{ "is-compact-open": workspacePanelOpen() }}
        aria-label="研究工作区"
        role={workspacePanelOpen() ? "dialog" : undefined}
        aria-modal={workspacePanelOpen() ? "true" : undefined}
        onKeyDown={trapWorkspaceFocus}
      >
        <div class="workspace-brand"><strong>KillStata</strong></div>
        <button
          ref={(element) => { workspaceCloseButton = element }}
          type="button"
          class="workspace-close"
          aria-label="关闭工作区"
          onClick={closeWorkspacePanel}
        >
          <Icon name="close" size={17} />
        </button>
        <button
          type="button"
          class="workspace-new"
          aria-label="新对话"
          onClick={() => handleSlashCommand("new")}
          disabled={isPreparingSubmission() || (isRunning() && pendingInteraction() === undefined)}
        >
          <Icon name="plus" size={15} />
          <span>新对话</span>
        </button>
        <nav class="workspace-list" aria-label="研究工作区">
          <div class="workspace-list-header">
            <span class="workspace-list-heading">工作区</span>
            <div class="workspace-list-actions">
              <button type="button" class="workspace-icon-button" aria-label="筛选研究" title="筛选研究" onClick={() => document.querySelector<HTMLInputElement>(".research-filter")?.focus()}><Icon name="search" size={13} /></button>
              <button type="button" class="workspace-icon-button" aria-label="添加本地工作区" title="添加本地工作区" onClick={() => void selectWorkspace()}><Icon name="plus" size={13} /></button>
            </div>
          </div>
          <For each={workspaceRecords().filter((workspace) => workspace.id !== UNASSIGNED_WORKSPACE_ID)}>
            {(workspace) => (
              <button
                type="button"
                class="workspace-entry"
                classList={{ "is-active": activeWorkspaceID() === workspace.id }}
                aria-label={`切换工作区：${workspace.name}`}
                aria-current={activeWorkspaceID() === workspace.id ? "page" : undefined}
                disabled={isPreparingSubmission() || (isRunning() && pendingInteraction() === undefined)}
                onClick={() => {
                  if (workspace.id === activeWorkspaceID()) return
                  void switchWorkspace(workspace)
                }}
              >
                <span class="workspace-entry-main">
                  <Icon name="folder" size={13} class="workspace-entry-icon" />
                  <span class="workspace-entry-name">{workspace.name}</span>
                </span>
                <Show when={workspace.researches.length}>
                  <span class="workspace-entry-meta">{workspace.researches.length} 项研究</span>
                </Show>
              </button>
            )}
          </For>
          <Show
            when={workspaceName()}
            fallback={
              <button
                type="button"
                class="workspace-picker"
                aria-label="选择本地工作区"
                onClick={() => void selectWorkspace()}
                disabled={!props.workspacePicker}
                title={props.workspacePicker ? "添加本地工作区；只有你明确选择数据文件后才会读取文件内容。" : "当前预览未连接本机工作区。"}
              >
                <Icon name="workspace" size={15} />
                <span>添加本地工作区</span>
              </button>
            }
          >
            <div class="workspace-current" role="status" aria-label={`当前工作区：${workspaceName()}`}>
              <strong>{workspaceName()}</strong>
              <div class="workspace-current-actions">
                <button type="button" class="workspace-action" aria-label="更换本地工作区" onClick={() => void selectWorkspace()}>更换</button>
                <button type="button" class="workspace-action is-danger" aria-label="清除本地工作区" onClick={clearWorkspace}>清除</button>
              </div>
            </div>
          </Show>
        </nav>
        <section class="research-list" aria-label="最近研究">
          <Show when={researchSessions().length}>
            <div class="workspace-list-heading">最近研究</div>
            <input
              type="search"
              class="research-filter"
              aria-label="筛选最近研究"
              placeholder="筛选研究"
              value={researchFilter()}
              onInput={(event) => setResearchFilter(event.currentTarget.value)}
            />
            <Show when={filteredResearchSessions().length} fallback={<p class="workspace-empty research-filter-empty">未找到匹配的研究</p>}>
              <For each={filteredResearchSessions()}>
                {(session) => {
                  const summary = researchSessionSummary(session)
                  return (
                    <button
                      type="button"
                      class="research-session"
                      classList={{ "is-active": activeResearchID() === session.id }}
                      aria-label={`打开研究：${session.title}`}
                      aria-describedby={`research-session-summary-${session.id}`}
                      aria-current={activeResearchID() === session.id ? "page" : undefined}
                      disabled={isPreparingSubmission() || (isRunning() && pendingInteraction() === undefined)}
                      onClick={() => openResearch(session.id)}
                    >
                      <span class="research-session-title"><Icon name="file" size={12} class="research-session-icon" />{session.title}</span>
                      {/* 状态与数据合并成一行：三行一条目在窄栏里密度太低，读起来全是留白。 */}
                      <span class="research-session-meta">
                        <span class={`research-session-status is-${summary.tone}`}>{summary.statusLabel}</span>
                        <span class="research-session-sep">·</span>
                        <span class="research-session-dataset">{summary.datasetLabel}</span>
                      </span>
                      <span id={`research-session-summary-${session.id}`} class="research-session-description">
                        数据：{summary.datasetLabel}；状态：{summary.statusLabel}
                      </span>
                    </button>
                  )
                }}
              </For>
            </Show>
          </Show>
        </section>
        <button
          ref={(element) => {
            settingsTrigger = element
          }}
          type="button"
          class="workspace-settings"
          onClick={() => openSettings()}
        >
          <Icon name="settings" size={17} class="workspace-settings-icon" />
          <span>设置</span>
        </button>
      </aside>
      <header class="app-header">
        <div
          class="research-header"
          role={mode() === "connected" ? undefined : "status"}
          aria-label={mode() === "connected" ? undefined : `当前研究：${researchHeaderTitle()}`}
        >
          <span
            class={`engine-dot ${mode() === "frontend" ? "is-preview" : `is-${engineStatus()}`}`}
            role="status"
            aria-label={engineStatusLabel()}
            title={engineStatusLabel()}
          />
          {/* 会话标题由 Core 依据问题生成（session.updated），研究尚未建立时不占位。 */}
          <Show when={activeResearchID() !== undefined}>
            <span class="research-header-title" title={researchHeaderTitle()}>{researchHeaderTitle()}</span>
          </Show>
        </div>
        <Show when={workspaceName() || dataset() || datasetSelectionMessage()}>
          <div
            class="research-context"
            role="status"
            aria-label={`当前研究上下文：工作区 ${workspaceName() ?? "未选择"}；数据 ${dataset()?.name ?? "未选择"}`}
          >
            <span class="research-context-item">
              <span class="research-context-label">工作区</span>
              <strong>{workspaceName() ?? "未选择"}</strong>
            </span>
            <span class="research-context-separator" aria-hidden="true">/</span>
            <span class="research-context-item">
              <span class="research-context-label">数据</span>
              <strong>{dataset()?.name ?? "未选择"}</strong>
            </span>
          </div>
        </Show>
        <div class="header-actions">
          <button
            ref={(element) => { workspaceToggle = element }}
            type="button"
            class="header-action workspace-toggle"
            aria-label="打开工作区"
            aria-expanded={workspacePanelOpen()}
            aria-controls={workspaceDrawerID}
            onClick={openWorkspacePanel}
          >
            工作区
          </button>
        </div>
      </header>

      <MessageThread
        messages={threadMessages()}
        showThinking={showThinking()}
        showTimestamps={showTimestamps()}
        progressSnapshot={runProgress()}
        showProgressSnapshot={false}
        datasetName={dataset()?.name}
        renderBlocks={resultDocumentBlocks}
        onStarter={(starter) => {
          setPrompt(starter)
          queueMicrotask(() => promptInput?.focus())
        }}
      />

      <Show when={pendingInteraction()}>
        {(interaction) => (
          <InteractionPanel
            interaction={interaction()}
            busy={interactionBusy()}
            error={interactionError()}
            onSubmit={(answer) => void submitInteraction(answer)}
            onDeny={() => void denyInteraction()}
          />
        )}
      </Show>
      <Composer
        prompt={prompt()}
        onPromptChange={setPrompt}
        inputRef={(element) => { promptInput = element }}
        attachmentName={dataset()?.name}
        workbookSheets={workbookSheetNames()}
        selectedSheet={selectedWorkbookSheet()}
        onSelectSheet={selectWorkbookSheet}
        onSelectFile={() => fileInput?.click()}
        onSend={() => void submitPrompt()}
        onStop={() => void stopRun()}
        onClearAttachment={clearDataset}
        commands={slashCommands()}
        onCommand={handleSlashCommand}
        workspaceName={workspaceName()}
        onSelectWorkspace={props.workspacePicker ? () => void selectWorkspace() : undefined}
        onSelectWorkspaceFile={workspaceName() && props.workspaceFilePicker ? selectWorkspaceFile : undefined}
        canSend={Boolean(prompt().trim())}
        running={isRunning() || pendingInteraction() !== undefined || runStatus() === "waiting_for_user"}
        disabled={isPreparingSubmission() || (isRunning() && pendingInteraction() === undefined)}
        sessionPolicy={{
          permissionMode: permissionMode(),
          permissionLabel: permissionModeInfo(permissionMode()).label,
          permissionDescription: permissionModeInfo(permissionMode()).description,
          permissionLocked: Boolean(runID()),
          permissionOptions: props.sharedVisitor
            ? PERMISSION_MODES.filter((option) => option.id !== "full_access")
            : PERMISSION_MODES,
          onPermissionChange: (next) => { if (isPermissionMode(next)) selectPermissionMode(next) },
          model: providerDraft().model,
          modelName: modelDisplayName(providerDraft().model),
          modelOptions: availableModels(),
          onModelChange: selectModel,
          effort: reasoningEffort(),
          effortLabel: REASONING_EFFORTS.find((item) => item.id === reasoningEffort())?.label ?? reasoningEffort(),
          effortOptions: REASONING_EFFORTS,
          onEffortChange: (next) => { if (isReasoningEffort(next)) selectReasoningEffort(next) },
        }}
      />

      <input
        ref={(element) => { fileInput = element }}
        type="file"
        hidden
        aria-label="数据文件选择器"
        accept=".csv,.xlsx,.xls,.dta,.parquet"
        onChange={(event) => void selectDataset(event.currentTarget.files)}
      />
      <Show when={workspacePersistenceMessage()}>
        <p class="settings-message" role="status">{workspacePersistenceMessage()}</p>
      </Show>
      <Show when={engineFeedback()}>
        <section class={`local-feedback is-${engineFeedback()!.tone} composer-feedback`} role="status" aria-label="分析核心状态提示">
          <strong>{engineFeedback()!.title}</strong>
          <p>原因：{engineFeedback()!.reason}</p>
          <p>建议：{engineFeedback()!.action}</p>
          <Show when={mode() === "connected"}>
            <button type="button" class="settings-button" onClick={() => void checkEngineReady()}>
              {engineStatus() === "checking" ? "检查中…" : "重试"}
            </button>
          </Show>
        </section>
      </Show>

      <Show when={submissionFeedback()}>
        <section class={`local-feedback is-${submissionFeedback()!.tone} composer-feedback`} role="status" aria-label="分析提交提示">
          <strong>{submissionFeedback()!.title}</strong>
          <p>原因：{submissionFeedback()!.reason}</p>
          <p>建议：{submissionFeedback()!.action}</p>
        </section>
      </Show>

      <Show when={datasetSelectionMessage()}>
        <section class="local-feedback is-warning composer-feedback" role="status" aria-label="数据选择提示">
          <strong>{datasetSelectionMessage()!.title}</strong>
          <p>原因：{datasetSelectionMessage()!.reason}</p>
          <p>建议：{datasetSelectionMessage()!.action}</p>
        </section>
      </Show>

      <Show when={cancellationFeedback()}>
        <section class="local-feedback is-error composer-feedback" role="status" aria-label="停止分析提示">
          <strong>{cancellationFeedback()!.title}</strong>
          <p>原因：{cancellationFeedback()!.reason}</p>
          <p>建议：{cancellationFeedback()!.action}</p>
        </section>
      </Show>

      <Show when={connectionMessage() && !settingsOpen()}>
        <p class="settings-message" role="status" aria-label="连接提示">{connectionMessage()}</p>
      </Show>

      <Show when={props.sharedVisitor && mode() === "connected" && !settingsOpen()}>
        <p class="settings-note" role="status" aria-label="分享分析数据说明">
          提交后，所选文件和研究问题会传到分享主机；分析请求会使用主机配置的模型服务。主机 API Key 不会提供给访客。
        </p>
      </Show>

      <Show when={settingsOpen()}>
        <div class="settings-scrim">
          <section class="settings-panel" role="dialog" aria-label="设置" aria-modal="true">
            <header class="settings-header">
              <h2>设置</h2>
              <div class="settings-header-actions">
                <button
                  ref={(element) => { settingsCloseButton = element }}
                  type="button"
                  class="icon-button"
                  aria-label="关闭设置"
                  onClick={closeSettings}
                >
                  <Icon name="close" size={17} />
                </button>
              </div>
            </header>
            <div class="settings-layout">
              <nav class="settings-nav" aria-label="设置分类">
                <button
                  type="button"
                  class="settings-nav-item"
                  aria-label="通用设置"
                  classList={{ "is-active": settingsCategory() === "general" }}
                  aria-current={settingsCategory() === "general" ? "page" : undefined}
                  onClick={() => setSettingsCategory("general")}
                >
                  <Icon name="settings" size={16} />
                  <span>通用设置</span>
                </button>
                <button
                  type="button"
                  class="settings-nav-item"
                  aria-label="模型管理"
                  classList={{ "is-active": settingsCategory() === "model" }}
                  aria-current={settingsCategory() === "model" ? "page" : undefined}
                  onClick={() => {
                    if (mode() === "frontend" && connectionAvailable) void activateConnectedMode()
                    else setSettingsCategory("model")
                  }}
                >
                  <Icon name="database" size={16} />
                  <span>模型管理</span>
                </button>
                <button
                  type="button"
                  class="settings-nav-item"
                  aria-label="运行环境"
                  classList={{ "is-active": settingsCategory() === "runtime" }}
                  aria-current={settingsCategory() === "runtime" ? "page" : undefined}
                  onClick={() => setSettingsCategory("runtime")}
                >
                  <Icon name="puzzle" size={16} />
                  <span>运行环境</span>
                </button>
              </nav>
              <div class="settings-content">
                <Show when={settingsCategory() === "model"}>
                  <ModelManagement
                    snapshot={modelProfiles()}
                    credentials={credentials}
                    storageNotice={props.sharedVisitor
                      ? "模型由分享页面所有者管理。访客不能查看或修改 API Key。"
                      : props.credentialStorageNotice ?? (mode() === "frontend"
                      ? "浏览器预览仅在当前页面展示模型配置；不会保存或发送 API Key。"
                      : "管理已保存的服务商、模型和默认项。API Key 只保存在 KillStata 本机凭据存储中。")}
                    credentialStoreLabel={props.credentialStoreLabel ?? (mode() === "connected" ? "KillStata 本机凭据存储" : undefined)}
                    readOnly={props.sharedVisitor === true}
                    busy={isRunning() || isPreparingSubmission() || isCancellingRun() || pendingInteraction() !== undefined || runStatus() === "waiting_for_user"}
                    loadState={profileLoadState()}
                    loadError={profileLoadError()}
                    onRetryLoad={loadProviderStatus}
                    onSnapshot={(snapshot) => {
                      applyModelProfilesSnapshot(snapshot)
                      const active = snapshot.profiles.find((profile) => profile.id === snapshot.defaultProfileId)
                      if (connectionAvailable && mode() === "connected" && active?.configured) void checkEngineReady()
                    }}
                  />
            </Show>
            <Show when={settingsCategory() === "general"}>
              <h2 class="settings-category-title">通用设置</h2>
            <section class="settings-section" aria-labelledby="analysis-mode-title">
              <h3 id="analysis-mode-title">分析模式</h3>
              <p class="settings-note">{mode() === "connected"
                ? props.sharedVisitor
                  ? "已连接分享主机的分析核心；模型和 API Key 由主机管理员管理。"
                  : "已连接本机分析核心；API Key 只会在你明确开始分析时读取。"
                : props.sharedVisitor
                  ? "连接后会使用分享主机已配置的模型；所选文件只会在访客提交分析后上传。"
                  : "当前只记录研究问题和已选择的数据，不调用模型或执行统计分析。"}</p>
              <Show when={props.sharedVisitor && mode() === "connected"}>
                <p class="settings-note" role="status" aria-label="分享分析数据说明">
                  提交后，所选文件和研究问题会传到分享主机；分析请求会使用主机配置的模型服务。主机 API Key 不会提供给访客。
                </p>
              </Show>
              <Show when={mode() === "frontend" && connectionAvailable}>
                <button type="button" class="settings-button" onClick={() => void activateConnectedMode()}>
                  连接分析核心
                </button>
              </Show>
              <Show when={connectionMessage()}>
                <p class="settings-message" role="status">{connectionMessage()}</p>
              </Show>
            </section>
            <section class="settings-section" aria-labelledby="appearance-title">
              <h3 id="appearance-title">外观</h3>
              <div class="appearance-cards" role="group" aria-label="外观">
                <For each={themes}>
                  {(item) => {
                    const icon = item.value === "light" ? "sun" as const : item.value === "dark" ? "moon" as const : "monitor" as const
                    return (
                      <button
                        type="button"
                        class="appearance-card"
                        classList={{ "is-active": theme() === item.value }}
                        aria-pressed={theme() === item.value}
                        onClick={() => selectTheme(item.value)}
                      >
                        <Icon name={icon} size={20} />
                        <span>{item.label}</span>
                      </button>
                    )
                  }}
                </For>
              </div>
              <Show when={sharedUiPreferenceError()}>
                <p class="settings-note" role="status" aria-label="共享偏好同步失败">无法同步到另一个 KillStata 界面，本地设置已保留。</p>
              </Show>
            </section>
            <section class="settings-section" aria-labelledby="shortcuts-title">
              <h3 id="shortcuts-title">快捷键</h3>
              <ul class="shortcut-list">
                <li><kbd>⌘O</kbd><span>选择数据文件</span></li>
                <li><kbd>⌘,</kbd><span>打开设置</span></li>
                <li><kbd>⌘</kbd>/<kbd>Ctrl</kbd><kbd>Enter</kbd><span>发送</span></li>
                <li><kbd>/</kbd><span>调出命令面板</span></li>
                <Show when={workspaceName()}>
                  <li><kbd>@</kbd><span>从工作区引用文件</span></li>
                </Show>
              </ul>
            </section>
            </Show>
            <Show when={settingsCategory() === "runtime"}>
              <h2 class="settings-category-title">运行环境</h2>
              <section class="settings-section" aria-labelledby="runtime-title">
                <h3 id="runtime-title">运行环境</h3>
                <Show when={runtimeReport()}>
                  <p class="settings-note">{runtimeReport()!.python.detail}</p>
                </Show>
                <button type="button" class="settings-button" onClick={() => void refreshRuntimeDiagnostics()} disabled={isCheckingRuntime()}>
                  {isCheckingRuntime() ? "检查中…" : "检查本机环境"}
                </button>
                <Show when={missingRuntimePackages().length > 0}>
                  <div class="runtime-install">
                    <p>{`有 ${missingRuntimePackages().length} 项分析依赖未安装或无法读取。`}</p>
                    <Show
                      when={runtimeInstallConfirmationOpen()}
                      fallback={
                        <button type="button" class="settings-button" onClick={() => setRuntimeInstallConfirmationOpen(true)}>
                          查看并确认安装
                        </button>
                      }
                    >
                      <p>将按当前配置准备环境：已指定的 Python 接收缺失依赖；未指定时由 KillStata 创建或修复受管 Python 环境（共 {missingRuntimePackages().length} 项）。</p>
                      <button type="button" class="settings-button is-danger" onClick={() => void installMissingRuntimePackages()} disabled={isInstallingRuntime()}>
                        {isInstallingRuntime() ? "安装中…" : "确认安装"}
                      </button>
                      <button type="button" class="settings-button is-ghost" onClick={() => setRuntimeInstallConfirmationOpen(false)}>取消</button>
                    </Show>
                  </div>
                </Show>
                <div class="runtime-package-groups" aria-label="计量分析 Python 依赖">
                  <For each={dependencyGroups()}>
                    {(group) => (
                      <section class="runtime-package-group" aria-labelledby={`runtime-group-${group.id}`}>
                        <h4>
                          <button
                            id={`runtime-group-${group.id}`}
                            type="button"
                            class="runtime-package-group-toggle"
                            aria-expanded={expandedRuntimeDependencyGroups().has(group.id)}
                            aria-controls={`runtime-group-items-${group.id}`}
                            onClick={() => toggleRuntimeDependencyGroup(group.id)}
                          >
                            <span>{group.label}</span>
                            <span class="runtime-package-group-count">{group.items.length} 个包</span>
                            <span class="runtime-package-group-chevron" aria-hidden="true">›</span>
                          </button>
                        </h4>
                        <Show when={expandedRuntimeDependencyGroups().has(group.id)}>
                          <div id={`runtime-group-items-${group.id}`} class="runtime-package-list">
                            <For each={group.items}>
                              {(item) => {
                                const status = () => runtimeReport()?.packages.find((check) => check.label === item.pip)
                                return (
                                  <div class="runtime-package-row">
                                    <div class="runtime-package-heading">
                                      <strong>{item.pip}</strong>
                                      <span class={`runtime-package-status is-${status()?.status ?? "unknown"}`}>
                                        {status()?.detail ?? "尚未检查"}
                                      </span>
                                    </div>
                                    <p>{item.purpose}{item.pinned ? ` · 安装版本 ${item.pinned}` : ""}</p>
                                  </div>
                                )
                              }}
                            </For>
                          </div>
                        </Show>
                      </section>
                    )}
                  </For>
                </div>
                <p class="settings-note">缺少依赖时对应计量方法无法运行。</p>
                <Show when={runtimeInstallMessage()}>
                  <p class="settings-message" role="status">{runtimeInstallMessage()}</p>
                </Show>
                <Show when={runtimeFeedback()}>
                  <section class="local-feedback is-error" role="status" aria-label="运行环境提示">
                    <strong>{runtimeFeedback()!.title}</strong>
                    <p>原因：{runtimeFeedback()!.reason}</p>
                    <p>建议：{runtimeFeedback()!.action}</p>
                  </section>
                </Show>
              </section>
            </Show>
            <Show when={settingsCategory() === "general"}>
            <section class="settings-section" aria-labelledby="history-title">
              <h3 id="history-title">研究历史</h3>
              <label class="settings-toggle">
                <input
                  type="checkbox"
                  aria-label="保存研究历史"
                  checked={workspaceHistoryEnabled()}
                  onChange={(event) => void setWorkspaceHistory(event.currentTarget.checked)}
                />
                <span>保存研究历史到本机</span>
              </label>
              <p class="settings-note">仅保存研究元数据（问题、文件名、状态和授权档位），不保存原始文件。</p>
            </section>
            <section class="settings-section">
              <p class="settings-note">{mode() === "connected"
                ? "数据复制到分析引擎，原始文件不会被修改。"
                : "数据文件仅在此设备读取，不会上传。"}</p>
              <p class="settings-note">KillStata v{packageDefinition.version}</p>
            </section>
            </Show>
            </div>
            </div>
          </section>
        </div>
      </Show>

      <Show when={demoResultOpen()}>
        <div class="result-scrim">
          <section class="result-panel" role="dialog" aria-label={resultTitle()} aria-modal="true">
            <header class="settings-header">
              <div>
                <h2>{resultTitle()}</h2>
              </div>
              <div class="result-actions">
                <button class="icon-button" type="button" aria-label={`关闭${resultTitle()}`} onClick={() => setDemoResultOpen(false)}>
                  <Icon name="close" size={17} />
                </button>
              </div>
            </header>
            <Show
              when={resultFeedback()}
              fallback={
                <section class="result-document" aria-label="结果文档">
                  <For each={resultDocumentBlocks(resultDocument())}>
                    {(block) => {
                      if (block.kind === "paragraph") return <p>{block.text}</p>
                      if (block.kind === "table") {
                        return (
                          <div class="result-table-wrap">
                            <table>
                              <thead>
                                <tr><For each={block.headers}>{(header) => <th scope="col">{header}</th>}</For></tr>
                              </thead>
                              <tbody>
                                <For each={block.rows}>
                                  {(row) => <tr><For each={row}>{(cell) => <td>{cell}</td>}</For></tr>}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        )
                      }
                      if (block.level === 1) return <h1>{block.text}</h1>
                      if (block.level === 2) return <h2>{block.text}</h2>
                      return <h3>{block.text}</h3>
                    }}
                  </For>
                </section>
              }
            >
              {(feedback) => (
                <section class="local-feedback result-feedback is-error" role="status" aria-label="结果读取提示">
                  <strong>{feedback().title}</strong>
                  <p>原因：{feedback().reason}</p>
                  <p>建议：{feedback().action}</p>
                </section>
              )}
            </Show>
          </section>
        </div>
      </Show>
    </main>
  )
}
