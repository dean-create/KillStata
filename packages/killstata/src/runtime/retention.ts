import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import type { DatasetManifest } from "./dataset-state"
import { readDatasetManifest } from "./dataset-state"
import { writeDatasetManifest } from "../tool/analysis-state"
import { SessionRunCoordinator } from "../session/run-state"
import { Global } from "../global"

const log = Log.create({ service: "retention" })

/**
 * 产物保留策略：会话/restore/反思/任务台账/数据集产物的"做减法"统一入口。
 *
 * 设计取舍：磁盘常驻会话 + 历史产物堆到几十 M 属于"测试残留 + 临时审计泄漏"。
 * 自动保留少量最近 + 活跃引用，手动 /cleanup 可一键做减法；自动钩子只清"用完就无价值"的
 * 子会话，不激进删顶层会话（保留用户恢复能力）。
 */

export type CleanupReport = {
  sessionsRemoved: number
  childSessionsRemoved: number
  reflectionRemoved: number
  workflowsRemoved: number
  tasksRemoved: number
  datasetsTrimmed: number
  bytesFreed: number
  /** 每项删除的会话 datasetId 列表（用于审计/展示） */
  removedSessionIds?: string[]
}

export type CleanupOptions = {
  /** 顶层会话保留数量（按 time.updated 倒序）。默认 30。 */
  keepTopSessions?: number
  /** 失败反思日志保留数量（按文件名 ISO 时间戳倒序）。默认 50。 */
  keepReflection?: number
  /** 视为"活跃"的最近窗口（毫秒）。活跃会话及其子会话、永不被删。默认 24h。 */
  activeWindowMs?: number
  /** 干跑：只统计不删 */
  dryRun?: boolean
  /** 仅清子会话（verifier/task 完成后的临时会话）——可作为高频自动钩子 */
  childSessionsOnly?: boolean
  /**
   * 会话隔离（2026-08-08）：只清理"以该会话为父"的子会话，绝不动别的会话的 child。
   * dispatch 的 defer 钩子必须传——否则新窗口一条消息退出就会全项目扫，把 25h 前
   * 别的会话遗留的 verifier 子会话误删（父会话还在 keepTopSessions 里，但 child
   * updated 超窗）。
   */
  scopeSessionID?: string
}

const DEFAULTS = {
  keepTopSessions: 30,
  keepReflection: 50,
  activeWindowMs: 24 * 60 * 60 * 1000,
}

/**
 * 删会话：Session.remove 已递归删 message/part/permission/session_share，运行时产物
 * （workflows/reflection/tasks）由 cleanupWorkflowsForSession 单独清。
 * dryRun=true 时跳过 Session.remove（不可逆操作），只统计文件尺寸——调用方先 dryRun 预览，
 * 确认无误后再 dryRun=false 真正删。
 */
type SessionRemovalDependencies = {
  remove: (sessionID: string) => Promise<unknown>
  exists: (sessionID: string) => Promise<boolean>
  cleanupWorkflows: (sessionID: string, dryRun: boolean) => void
}

const defaultSessionRemovalDependencies: SessionRemovalDependencies = {
  remove: (sessionID) => Session.remove(sessionID),
  exists: async (sessionID) => {
    try {
      await Session.get(sessionID)
      return true
    } catch {
      return false
    }
  },
  cleanupWorkflows: cleanupWorkflowsForSession,
}

export async function removeSessionFully(
  sessionID: string,
  opts: { dryRun: boolean },
  dependencies: SessionRemovalDependencies = defaultSessionRemovalDependencies,
): Promise<boolean> {
  try {
    if (opts.dryRun) {
      dependencies.cleanupWorkflows(sessionID, true)
      return true
    }
    await dependencies.remove(sessionID)
    // Session.remove 为兼容 UI 会吞掉内部异常，因此不能把 Promise resolve 当成删除成功。
    // 只有存储中确实查不到 session，才允许计数并清理同名 workflow/task。
    if (await dependencies.exists(sessionID)) {
      log.warn("Session.remove completed but session still exists", { sessionID })
      return false
    }
    dependencies.cleanupWorkflows(sessionID, false)
    return true
  } catch (error) {
    log.warn("Session.remove failed", { sessionID, error: String(error) })
    return false
  }
}

function cleanupWorkflowsForSession(sessionID: string, dryRun: boolean) {
  const root = path.join(Instance.worktree, ".killstata", "runtime")
  const targets = [
    path.join(root, "workflows", `${sessionID}.json`),
    path.join(root, "tasks", `${sessionID}.json`),
  ]
  for (const file of targets) {
    try {
      if (fs.existsSync(file)) {
        if (dryRun) continue
        fs.rmSync(file)
      }
    } catch (error) {
      log.warn("failed to remove runtime file", { file, error: String(error) })
    }
  }
}

async function listAllSessions(): Promise<Array<{ id: string; parentID?: string; updated: number; projectID: string }>> {
  const result: Array<{ id: string; parentID?: string; updated: number; projectID: string }> = []
  const projectsRoot = path.join(Global.Path.data, "storage", "session")
  if (!fs.existsSync(projectsRoot)) return result
  for (const projectDir of fs.readdirSync(projectsRoot)) {
    const projectPath = path.join(projectsRoot, projectDir)
    if (!fs.statSync(projectPath).isDirectory()) continue
    for (const file of fs.readdirSync(projectPath)) {
      if (!file.endsWith(".json")) continue
      try {
        const info = JSON.parse(fs.readFileSync(path.join(projectPath, file), "utf-8"))
        if (!info.id) continue
        result.push({
          id: info.id,
          parentID: info.parentID,
          updated: info.time?.updated ?? 0,
          projectID: projectDir,
        })
      } catch {
        // 忽略损坏文件
      }
    }
  }
  return result
}

export function selectSessionsForProject<T extends { projectID: string }>(sessions: T[], projectID: string): T[] {
  return sessions.filter((session) => session.projectID === projectID)
}

/**
 * 决定哪些子会话可删。
 *
 * - 不传 scopeSessionID：旧语义——父会话不在 keepIds 里、或子会话本身超活跃窗口，都可删。
 * - 传 scopeSessionID：**只考虑以该会话为父的 child**（verifier/task 子会话），其余会话的
 *   child 一律不动。dispatch defer 钩子必须走这条，否则新窗口一条消息退出就会全项目扫，
 *   误删别的会话遗留的 child（2026-08-08 会话隔离修复）。
 * 纯函数，便于单测。
 */
export function selectRemovableChildren(input: {
  children: Array<{ id: string; parentID?: string; updated: number }>
  keepIds: Set<string>
  activeCutoff: number
  scopeSessionID?: string
  activeChildIds?: Set<string>
}): string[] {
  const { children, keepIds, activeCutoff, scopeSessionID, activeChildIds = new Set<string>() } = input
  const removable: string[] = []
  for (const child of children) {
    if (activeChildIds.has(child.id)) continue
    if (scopeSessionID) {
      if (child.parentID === scopeSessionID) removable.push(child.id)
      continue
    }
    if (!keepIds.has(child.parentID!)) removable.push(child.id)
    else if (child.updated < activeCutoff) removable.push(child.id)
  }
  return removable
}

/**
 * Session.remove(parent) 会递归删除全部 child；因此只从 removableChildren 排除活跃 child
 * 还不够，必须把它的整条祖先链加入 keepIds，先阻止顶层 parent 被选中。
 */
export function protectActiveChildAncestors(input: {
  sessions: Array<{ id: string; parentID?: string }>
  activeChildIds: Set<string>
  keepIds: Set<string>
}): Set<string> {
  const keepIds = new Set(input.keepIds)
  const byID = new Map(input.sessions.map((session) => [session.id, session]))
  for (const activeChildID of input.activeChildIds) {
    let current = byID.get(activeChildID)
    while (current?.parentID) {
      keepIds.add(current.parentID)
      current = byID.get(current.parentID)
    }
  }
  return keepIds
}

export async function cleanupSessions(
  opts: CleanupOptions = {},
  // 预取的全局会话列表。遍历一次 storage 约 450ms，cleanupAll 会把同一份传给
  // trimOrphanWorkflows 复用，避免同一趟清理里扫两遍。
  prefetchedSessions?: Awaited<ReturnType<typeof listAllSessions>>,
): Promise<CleanupReport> {
  const cfg = { ...DEFAULTS, ...opts }
  const dryRun = cfg.dryRun ?? false
  // 全局 storage 按 projectID 分目录。保留数量必须在当前项目内计算，否则其他项目的新会话
  // 会挤占本项目的 keepTopSessions 名额，导致本项目历史被过度清理。
  const all = selectSessionsForProject(prefetchedSessions ?? (await listAllSessions()), Instance.project.id)
  const now = Date.now()
  const activeCutoff = now - cfg.activeWindowMs

  const tops = all.filter((s) => !s.parentID)
  const children = all.filter((s) => s.parentID)
  const activeChildIds = new Set(
    children.filter((child) => SessionRunCoordinator.activeIfKnown(child.id)).map((child) => child.id),
  )
  // 按更新时间倒序：保留前 keepTopSessions + 活跃（最近 activeWindowMs 内更新过）
  tops.sort((a, b) => b.updated - a.updated)
  let keepIds = new Set<string>()
  for (const s of tops.slice(0, cfg.keepTopSessions)) keepIds.add(s.id)
  for (const s of tops) {
    if (s.updated >= activeCutoff) keepIds.add(s.id)
  }
  keepIds = protectActiveChildAncestors({ sessions: all, activeChildIds, keepIds })
  // 子会话：只保留"父会话在 keepIds 里"的活跃子会话；其余（含 verifier 完成的）全删。
  // 会话隔离（2026-08-08）：scopeSessionID 指定时只处理"该会话为父"的 child——
  // 自动钩子（dispatch defer）绝不能全项目扫，否则新窗口会误删别的会话的 child verifier。
  const removableChildren = selectRemovableChildren({
    children,
    keepIds,
    activeCutoff,
    scopeSessionID: cfg.scopeSessionID,
    activeChildIds,
  })

  const report: CleanupReport = {
    sessionsRemoved: 0,
    childSessionsRemoved: 0,
    reflectionRemoved: 0,
    workflowsRemoved: 0,
    tasksRemoved: 0,
    datasetsTrimmed: 0,
    bytesFreed: 0,
    removedSessionIds: [],
  }

  if (!cfg.childSessionsOnly) {
    const removableTops = tops.filter((s) => !keepIds.has(s.id))
    for (const s of removableTops) {
      const removed = await removeSessionFully(s.id, { dryRun })
      if (!removed) continue
      report.sessionsRemoved += 1
      report.removedSessionIds!.push(s.id)
      log.info("removed top session", { sessionID: s.id, updated: s.updated, dryRun })
    }
  }

  for (const id of removableChildren) {
    const removed = await removeSessionFully(id, { dryRun })
    if (!removed) continue
    report.childSessionsRemoved += 1
    report.removedSessionIds!.push(id)
    log.info("removed child session", { sessionID: id, dryRun })
  }

  return report
}

/** 失败反思日志：按文件名 ISO 时间戳倒序，删超出 keepReflection 的旧文件 */
export function trimReflection(opts: CleanupOptions = {}): { removed: number; bytesFreed: number } {
  const cfg = { ...DEFAULTS, ...opts }
  const dryRun = cfg.dryRun ?? false
  const root = path.join(Instance.worktree, ".killstata", "runtime", "reflection")
  if (!fs.existsSync(root)) return { removed: 0, bytesFreed: 0 }
  const files = fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f, path: path.join(root, f), mtime: fs.statSync(path.join(root, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  const removable = files.slice(cfg.keepReflection)
  let bytesFreed = 0
  for (const f of removable) {
    bytesFreed += fs.statSync(f.path).size
    if (!dryRun) fs.rmSync(f.path)
  }
  log.info("trimReflection", { kept: cfg.keepReflection, removed: removable.length, dryRun })
  return { removed: removable.length, bytesFreed }
}

/**
 * workflow/task 是会话的可恢复运行态；对应 session 已不存在时，两者已经没有恢复入口。
 * knownSessionIds 仅用于隔离测试，生产路径从全局会话存储读取完整 ID 集合。
 */
export async function trimOrphanWorkflows(
  opts: CleanupOptions = {},
  knownSessionIds?: ReadonlySet<string>,
): Promise<{ workflowsRemoved: number; tasksRemoved: number; bytesFreed: number }> {
  const dryRun = opts.dryRun ?? false
  const runtimeRoot = path.join(Instance.worktree, ".killstata", "runtime")
  const workflowsRoot = path.join(runtimeRoot, "workflows")
  const tasksRoot = path.join(runtimeRoot, "tasks")
  const workflowsExist = fs.existsSync(workflowsRoot)
  const tasksExist = fs.existsSync(tasksRoot)
  if (!workflowsExist && !tasksExist) return { workflowsRemoved: 0, tasksRemoved: 0, bytesFreed: 0 }

  const sessionIds = knownSessionIds ?? new Set((await listAllSessions()).map((session) => session.id))
  const activeCutoff = Date.now() - (opts.activeWindowMs ?? DEFAULTS.activeWindowMs)
  // 删除前的竞态复查：快照一次 canonical session storage 的全部 ID。
  // 之前是每个候选文件都重扫一遍 storage 根（739 个 project 目录 → 单次约 0.9ms），
  // 候选一多就是几百毫秒纯重复 I/O；这里的快照点与逐次读取等价——都取在
  // cleanupSessions 跑完之后，防的是同一个跨进程竞态。
  const sessionStorageRoot = path.join(Global.Path.data, "storage", "session")
  const sessionIdsOnDisk = new Set<string>()
  if (fs.existsSync(sessionStorageRoot)) {
    for (const projectID of fs.readdirSync(sessionStorageRoot)) {
      const projectPath = path.join(sessionStorageRoot, projectID)
      try {
        for (const file of fs.readdirSync(projectPath)) {
          if (file.endsWith(".json")) sessionIdsOnDisk.add(file.slice(0, -".json".length))
        }
      } catch {
        // 非目录或读取失败：跳过，与旧的 existsSync 逐个探测行为一致
      }
    }
  }
  let workflowsRemoved = 0
  let tasksRemoved = 0
  let bytesFreed = 0

  const removeManagedRuntimeFile = (file: string): boolean => {
    const size = fs.statSync(file).size
    try {
      if (!dryRun) fs.rmSync(file)
      bytesFreed += size
      return true
    } catch (error) {
      log.warn("failed to remove orphan runtime file", { file, error: String(error) })
      return false
    }
  }

  const canRemove = (sessionID: string, file: string) => {
    if (sessionIds.has(sessionID)) return false
    if (SessionRunCoordinator.activeIfKnown(sessionID)) return false
    if (fs.statSync(file).mtimeMs >= activeCutoff) return false
    return !sessionIdsOnDisk.has(sessionID)
  }

  if (workflowsExist) {
    for (const entry of fs.readdirSync(workflowsRoot)) {
      if (!entry.endsWith(".json")) continue
      const sessionID = entry.replace(/\.json$/, "")
      const workflowPath = path.join(workflowsRoot, entry)
      const taskPath = path.join(tasksRoot, entry)
      if (!canRemove(sessionID, workflowPath)) continue
      if (removeManagedRuntimeFile(workflowPath)) workflowsRemoved += 1
      if (fs.existsSync(taskPath) && removeManagedRuntimeFile(taskPath)) tasksRemoved += 1
    }
  }

  // 历史 task 可能在 workflow 写入前失败，形成无配套 workflow 的孤儿；沿用同一套
  // session 存在性、活跃状态和 24h 安全窗判断，避免跨进程创建竞态。
  if (tasksExist) {
    for (const entry of fs.readdirSync(tasksRoot)) {
      if (!entry.endsWith(".json")) continue
      const sessionID = entry.replace(/\.json$/, "")
      const taskPath = path.join(tasksRoot, entry)
      if (fs.existsSync(path.join(workflowsRoot, entry))) continue
      if (!canRemove(sessionID, taskPath)) continue
      if (removeManagedRuntimeFile(taskPath)) tasksRemoved += 1
    }
  }
  log.info("trimOrphanWorkflows", { workflowsRemoved, tasksRemoved, dryRun })
  return { workflowsRemoved, tasksRemoved, bytesFreed }
}

/** 数据集产物：只清理无消费者的 inspection 整表副本；数据质量检查、计量结果和 stages 永久不碰。 */
export function trimDatasets(opts: CleanupOptions = {}): { trimmed: number; bytesFreed: number } {
  const dryRun = opts.dryRun ?? false
  const root = path.join(Instance.worktree, ".killstata", "datasets")
  if (!fs.existsSync(root)) return { trimmed: 0, bytesFreed: 0 }
  let trimmed = 0
  let bytesFreed = 0

  function managedFileSize(file: string, datasetDir: string): number | undefined {
    try {
      const candidate = fs.realpathSync.native(file)
      const managedRoot = fs.realpathSync.native(datasetDir)
      const relative = path.relative(managedRoot, candidate)
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
        return fs.statSync(candidate).size
      }
      log.warn("refusing to remove artifact outside managed dataset root", { file, datasetDir })
    } catch (error) {
      log.warn("failed to inspect managed artifact path", { file, error: String(error) })
    }
    return undefined
  }

  for (const datasetDir of fs.readdirSync(root)) {
    const managedDatasetRoot = path.join(root, datasetDir)
    const manifestPath = path.join(managedDatasetRoot, "manifest.json")
    if (!fs.existsSync(manifestPath)) continue
    let manifest: DatasetManifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    } catch {
      continue
    }
    let changed = false

    // 计算与 数据质量检查 都读取 canonical Parquet，用户需要表格副本时走显式 export。
    // inspection 目录因此没有运行时消费者；历史上还可能残留未登记到 manifest 的 xlsx，
    // 直接按受管目录清空，同时移除全部 stage 引用。
    const stages = manifest.stages ?? []
    const inspectionDir = path.join(managedDatasetRoot, "inspection")
    if (fs.existsSync(inspectionDir)) {
      for (const entry of fs.readdirSync(inspectionDir)) {
        const file = path.join(inspectionDir, entry)
        if (![".csv", ".xlsx"].includes(path.extname(entry).toLowerCase())) continue
        try {
          if (!fs.statSync(file).isFile()) continue
          const size = managedFileSize(file, managedDatasetRoot)
          if (size === undefined) continue
          bytesFreed += size
          if (!dryRun) fs.rmSync(file)
          changed = true
        } catch (error) {
          log.warn("failed to remove inspection file", { file, error: String(error) })
        }
      }
    }
    for (const stage of stages) {
      if (!stage.inspectionPath && !stage.inspectionWorkbookPath) continue
      stage.inspectionPath = undefined
      stage.inspectionWorkbookPath = undefined
      changed = true
    }

    if (changed) {
      try {
        manifest.updatedAt = new Date().toISOString()
        if (!dryRun) writeDatasetManifest(manifest)
        trimmed += 1
      } catch (error) {
        log.warn("failed to write trimmed manifest", { datasetId: manifest.datasetId, error: String(error) })
      }
    }
  }
  log.info("trimDatasets", { trimmed, dryRun })
  return { trimmed, bytesFreed }
}

export async function cleanupAll(opts: CleanupOptions = {}): Promise<CleanupReport> {
  // 全量遍历 storage 约 450ms，一趟清理里只做一次，下面两步共用。
  const allSessions = await listAllSessions()
  const sessions = await cleanupSessions(opts, allSessions)
  const reflection = trimReflection(opts)
  // 必须传**全局**（未按项目过滤的）ID 集：runtime/workflows 下可能有别的项目的会话，
  // 按项目过滤会把它们误判成孤儿。
  const workflows = await trimOrphanWorkflows(opts, new Set(allSessions.map((session) => session.id)))
  const datasets = trimDatasets(opts)
  return {
    ...sessions,
    reflectionRemoved: reflection.removed,
    workflowsRemoved: workflows.workflowsRemoved,
    tasksRemoved: workflows.tasksRemoved,
    datasetsTrimmed: datasets.trimmed,
    bytesFreed:
      sessions.bytesFreed + reflection.bytesFreed + workflows.bytesFreed + datasets.bytesFreed,
  }
}
