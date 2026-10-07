import fs from "fs"
import path from "path"
import crypto from "crypto"
import { projectReflectionRoot } from "@/runtime/dataset-state"
import { projectStateRoot } from "@/runtime/dataset-state"
import type { ToolReflection } from "@/tool/analysis-reflection"

/**
 * 统一的记忆 API。
 *
 * 项目现有的"记忆"分散在几个位置，各用各的格式写入后**没有任何模块把它们读回来**：
 *
 *   - `.killstata/runtime/reflection/`（272 文件）— ToolReflection，只写不读
 *   - `.killstata/runtime/tasks/`（59 文件）— 任务台账，RuntimeTaskLedger 维护
 *   - `.killstata/runtime/workflows/`（11 文件）— workflow run 持久化
 *   - `context-manager.ts` — 只读会话快照，不持久化跨会话
 *
 * Memory 不做两件事：① 不迁移现有数据（格式不变，加一层门面）；② 不做向量搜索 /
 * 复杂存储（先让 put/get/search 跑通，用文件系统作为第一个 back-end）。
 *
 * 用法：
 *   const prior = await Memory.search({ kind: "reflection", toolName: "panel_fe_regression" })
 *   await Memory.put({ kind: "reflection", scope: "session", ... })
 *   const entry = await Memory.get("reflection_xxx")
 */

export type MemoryKind = "reflection" | "task" | "workflow" | "pipeline" | "snapshot" | "rule"
export type MemoryScope = "session" | "project" | "global"

export interface MemoryEntry {
  id: string
  kind: MemoryKind
  scope: MemoryScope
  sessionID?: string
  createdAt: string
  content: unknown
}

export interface MemorySearchFilter {
  kind?: MemoryKind | MemoryKind[]
  /**
   * 限定到某个会话的 reflection/task/workflow。"新窗口干净"诉求下，**调用方必须显式传**，
   * 否则默认行为在下面的 priorReflections/search 都会拦截——见 A 修复的注释。
   */
  sessionID?: string
  /**
   * 显式跨会话查询。传 "session"（默认）或 "project"。**只在调用方确认要跨会话复用时
   * 才传 "project"**，例如诊断某个反复出现的工具缺陷；日常工具失败注入反思历史时
   * 必须用 "session"（= 仅本会话）。未传则按 "session" 处理——即 search 不会跨会话。
   */
  scope?: MemoryScope
  toolName?: string
  limit?: number
  offset?: number
}

/**
 * 文件系统适配器的根路径。原则上所有记忆都挂在同一个 root 下，
 * 但现成数据已经在 `.killstata/runtime/{reflection,tasks,workflows}` 里了，
 * 先通过 search adapter 读它们，不搬文件。
 */
const RUNTIME_ROOT = () => path.join(projectStateRoot())

/** 生成稳定 ID */
function stableID(kind: MemoryKind, seed: string) {
  return `${kind}_${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16)}`
}

// ── 文件系统 path 解析 ───────────────────────────────────────

function reflectionDir() {
  return projectReflectionRoot()
}

function tasksDir() {
  return path.join(RUNTIME_ROOT(), "tasks")
}

function workflowsDir() {
  return path.join(RUNTIME_ROOT(), "workflows")
}

// ── 核心接口 ──────────────────────────────────────────────────

export namespace Memory {
  /**
   * 写入一条记忆。返回其 id。
   *
   * 与 `persistToolReflection` 不同的是这里走统一存储 root，
   * 格式适配今后再做——第一版只提供查询接口来读现有数据。
   */
  export async function put(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string> {
    const id = stableID(entry.kind as MemoryKind, `${entry.sessionID ?? "global"}_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    const full: MemoryEntry = {
      ...entry,
      id,
      createdAt: new Date().toISOString(),
    }
    const dir = memoryStorageRoot()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(full, null, 2))
    return id
  }

  export async function get(id: string): Promise<MemoryEntry | undefined> {
    const dir = memoryStorageRoot()
    const file = path.join(dir, `${id}.json`)
    if (!fs.existsSync(file)) {
      // 回退到现有 reflection/tasks/workflows 目录（只读兼容）
      return readExistingLegacy(id)
    }
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as MemoryEntry
    } catch {
      return undefined
    }
  }

  /**
   * 搜索记忆。默认按 kind + toolName 过滤。
   */
  export async function search(filter: MemorySearchFilter = {}): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = []

    const targetKinds = filter.kind ? (Array.isArray(filter.kind) ? filter.kind : [filter.kind]) : ["reflection", "task", "workflow", "pipeline", "snapshot", "rule"]

    // 先从统一存储 root 搜（Memory.put 写入的）
    results.push(...searchMemoryStore(filter, targetKinds))

    // 再从遗留目录搜（persistToolReflection / TaskLedger 等写入的旧文件）
    if (targetKinds.includes("reflection")) {
      results.push(...searchLegacyReflections(filter))
    }
    if (targetKinds.includes("task")) {
      results.push(...searchLegacyTasks(filter))
    }
    if (targetKinds.includes("workflow") || targetKinds.includes("pipeline")) {
      results.push(...searchLegacyWorkflows(filter))
    }

    // 统一排序：按 createdAt 降序
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    const offset = filter.offset ?? 0
    const limit = filter.limit ?? 20
    return results.slice(offset, offset + limit)
  }

  /**
   * 通过工具名+失败类型查询历史反思。
   *
   * 会话隔离（2026-08-08）：必须传 sessionID——不传 sessionID 且 scope 也未声明为
   * "project" 时**直接 throw**，不让跨会话 reflection 漏到新窗口的工具结果里。
   * 历史行为（旧版）是无 sessionID 就搜全项目，把上一会话的失败历史喂给新会话——
   * 那会把上一会话的"心智模型"塞进新会话。日常工具失败注入必须用 sessionID；想
   * 跨会话复用（例如诊断反复出现的工具缺陷）显式传 `{ sessionID, scope: "project" }`。
   */
  export async function priorReflections(
    toolName: string,
    limit = 5,
    options?: { sessionID?: string; scope?: MemoryScope },
  ): Promise<ToolReflection[]> {
    if (!options?.sessionID && options?.scope !== "project") {
      throw new Error(
        "Memory.priorReflections 必须传 sessionID（会话隔离）；跨会话复用请显式传 scope: 'project'。",
      )
    }
    const filter: MemorySearchFilter = { kind: "reflection", toolName, limit }
    if (options?.sessionID) filter.sessionID = options.sessionID
    if (options?.scope) filter.scope = options.scope
    const entries = await search(filter)
    return entries.map((e) => e.content as ToolReflection).filter(Boolean)
  }
}

// ── 新旧存储的统一 root（新建记忆写入统一目录，旧数据原地读取）──

function memoryStorageRoot() {
  return path.join(RUNTIME_ROOT(), "memory")
}

function readExistingLegacy(id: string): MemoryEntry | undefined {
  // 兼容旧格式 id，形如 reflection_hash 或 task_hash
  for (const dir of [reflectionDir(), tasksDir(), workflowsDir()]) {
    if (!fs.existsSync(dir)) continue
    const files = fs.readdirSync(dir)
    const match = files.find((f) => f.startsWith(id.slice(0, 24)))
    if (match) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(dir, match), "utf-8"))
        return {
          id,
          kind: dir.includes("reflection") ? "reflection" : dir.includes("tasks") ? "task" : "workflow",
          scope: "session",
          sessionID: content.sessionID ?? content.sessionId,
          createdAt: content.createdAt ?? "",
          content,
        }
      } catch { continue }
    }
  }
  return undefined
}

// ── 各 adapter 的搜索实现 ──────────────────────────────────────

/** 搜 Memory.put 写入的统一存储 */
function searchMemoryStore(filter: MemorySearchFilter, kinds: string[]): MemoryEntry[] {
  const dir = memoryStorageRoot()
  if (!fs.existsSync(dir)) return []
  const out: MemoryEntry[] = []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as MemoryEntry
      if (!kinds.includes(entry.kind)) continue
      if (filter.toolName) {
        const c = entry.content as Record<string, unknown> | undefined
        const tn = c?.toolName
        if (typeof tn !== "string" || tn.toLowerCase() !== filter.toolName.toLowerCase()) continue
      }
      if (filter.scope !== "project" && filter.sessionID && entry.sessionID !== filter.sessionID) continue
      // 会话隔离（2026-08-08）：默认 session 级——无 sessionID 或不匹配都过滤掉。
      // 显式 scope: "project" 才跨会话返回。
      if (filter.scope !== "project") {
        if (!filter.sessionID) continue
        if (entry.sessionID !== filter.sessionID) continue
      }
      out.push(entry)
    } catch { continue }
  }
  return out
}

/** 搜遗留的 reflection 目录 */
function searchLegacyReflections(filter: MemorySearchFilter): MemoryEntry[] {
  const dir = reflectionDir()
  if (!fs.existsSync(dir)) return []

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  const out: MemoryEntry[] = []

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"))
      // raw 可能是两种形态之一：
      //   ① Memory.put 写入的 → { content: { toolName, ... }, createdAt, ... }
      //   ② persistToolReflection 写入的 → { toolName, failureType, sessionId, createdAt, ... }
      const content = raw.content ?? raw
      const toolName = (typeof content === "object" && content !== null ? (content as Record<string, unknown>).toolName : undefined) ?? raw.toolName
      const refSessionID = raw.sessionID ?? raw.sessionId ?? (typeof content === "object" ? (content as Record<string, unknown>).sessionId as string : undefined)
      const createdAt = raw.createdAt ?? ""
      if (typeof toolName !== "string") continue
      if (filter.toolName && toolName.toLowerCase() !== filter.toolName.toLowerCase()) continue
      // 会话隔离（2026-08-08）：默认 session 级——必须 filter.sessionID 命中才返回。
      // 显式 scope: "project" 才允许跨会话。空 entry（无归属）也只在 project scope 下返回。
      if (filter.scope !== "project") {
        if (!filter.sessionID) continue
        if (refSessionID !== filter.sessionID) continue
      }
      out.push({
        id: stableID("reflection", file),
        kind: "reflection",
        scope: "session",
        sessionID: refSessionID,
        createdAt,
        content: raw,
      })
    } catch {
      continue
    }
  }
  return out
}

function searchLegacyTasks(filter: MemorySearchFilter): MemoryEntry[] {
  const dir = tasksDir()
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  const out: MemoryEntry[] = []
  for (const file of files) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"))
      // 会话隔离（2026-08-08）：默认 session 级——显式 scope: "project" 才跨会话。
      if (filter.scope !== "project") {
        if (!filter.sessionID) continue
        if (content.sessionID !== filter.sessionID) continue
      }
      out.push({
        id: stableID("task", file),
        kind: "task",
        scope: "session",
        sessionID: content.sessionID,
        createdAt: content.createdAt ?? content.updatedAt ?? "",
        content,
      })
    } catch { continue }
  }
  return out
}

function searchLegacyWorkflows(filter: MemorySearchFilter): MemoryEntry[] {
  const dir = workflowsDir()
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  const out: MemoryEntry[] = []
  for (const file of files) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"))
      // 会话隔离（2026-08-08）：默认 session 级——显式 scope: "project" 才跨会话。
      if (filter.scope !== "project") {
        if (!filter.sessionID) continue
        if (content.sessionID !== filter.sessionID) continue
      }
      out.push({
        id: stableID("workflow", file),
        kind: "workflow",
        scope: "session",
        sessionID: content.sessionID,
        createdAt: content.createdAt ?? content.updatedAt ?? "",
        content,
      })
    } catch { continue }
  }
  return out
}
