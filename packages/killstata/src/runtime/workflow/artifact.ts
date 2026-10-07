import fs from "fs"
import path from "path"
import { Instance } from "@/project/instance"
import { normalizeArtifactCandidate } from "./state"

/**
 * 产物引用的识别、过滤与脱敏。
 *
 * 判断一个字符串是不是真实产物路径（而非解释器路径、命令行、目录），
 * 以及哪些产物可以直接交给 verifier 阅读。
 */

const WORKFLOW_ARTIFACT_EXTENSIONS = new Set([
  ".csv",
  ".docx",
  ".dta",
  ".json",
  ".log",
  ".md",
  ".parquet",
  ".png",
  ".tex",
  ".txt",
  ".xls",
  ".xlsx",
])

const VERIFIER_READABLE_ARTIFACT_EXTENSIONS = new Set([".csv", ".json", ".log", ".md", ".tex", ".txt"])

const NON_ARTIFACT_PATH_KEYS = [
  "install_command",
  "installcommand",
  "python_command",
  "pythoncommand",
  "python_executable",
  "pythonexecutable",
  "resolved_python_executable",
  "resolvedpythonexecutable",
  "interpreter",
  "executable",
]

const NON_ARTIFACT_EXTENSIONS = new Set([
  ".bat",
  ".bin",
  ".cmd",
  ".dll",
  ".exe",
  ".msi",
  ".node",
  ".pyc",
  ".so",
  ".wasm",
])

function hasCommandSyntax(value: string) {
  return /\s-(?:m|c|I|u)\b/i.test(value) || /\s+(?:pip|conda|uv|bun|npm|pnpm|yarn)\s+/i.test(value)
}

function artifactKeyIsRuntimeOnly(key?: string) {
  const normalized = key?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? ""
  if (!normalized) return false
  return NON_ARTIFACT_PATH_KEYS.some((item) => normalized.includes(item.replace(/[^a-z0-9]/gi, "")))
}

function existingPathIsDirectory(value: string) {
  try {
    return fs.existsSync(value) && fs.statSync(value).isDirectory()
  } catch {
    return false
  }
}

export function isWorkflowArtifactRef(value: string, key?: string) {
  const candidate = normalizeArtifactCandidate(value)
  if (!candidate) return false

  const normalized = candidate.replace(/\\/g, "/").toLowerCase()
  const ext = path.extname(candidate).toLowerCase()
  const nestedKey = key?.toLowerCase() ?? ""

  if (artifactKeyIsRuntimeOnly(key)) return false
  if (nestedKey.includes("reflection")) return false
  if (normalized.includes("/.killstata/runtime/health/")) return false
  if (normalized.includes("/inspection/") && /\.(xlsx|xls|csv)$/i.test(candidate)) return false
  if (hasCommandSyntax(candidate)) return false
  if (NON_ARTIFACT_EXTENSIONS.has(ext)) return false
  if (!WORKFLOW_ARTIFACT_EXTENSIONS.has(ext)) return false
  if (existingPathIsDirectory(candidate)) return false
  return true
}

// artifactRefs 记录的是相对 workspace 根（Instance.directory）的路径。校验产物是否存在
// 必须基于 workspace 根解析，而不是 process.cwd()——killstata 进程的 cwd 是启动目录
// （如 packages/killstata），不是数据 workspace。用错基准会把真实存在的产物判为不存在，
// 使 verifier 的 artifacts_present 检查假阳性 block → run.repairOnly 锁死工具目录为
// [readCore, data_import] → estimator 全程不可见，造成“工具调用中途消失”死锁
// （2026-07-18，5/5 真实会话复现）。无 instance context（测试/边界）时退回原路径，保持既有行为。
//
// 2026-08-05 补强：上面的 try/catch 原本在拿不到 instance context 时**静默退回相对路径**，
// 于是 existsSync 改用 process.cwd() 作基准。killstata 的 cwd 是启动目录，不是 workspace 根，
// 所以真实存在的 数据质量报告被判为"不存在" → verifier 的 artifacts_present 假阳性 block →
// 估计门禁认定"没通过 数据质量检查" → 模型重跑 数据质量检查 → 再次被 block，**无限死循环**（用户真实测试命中：
// panel_fe_regression 连续两次"必须先完成数据质检"，而 readableArtifactRefs 被持久化成 []）。
// 只有 postTool 之后的异步续体（verifier 合流）会丢 ALS 上下文，import/estimate 主路径不会，
// 这解释了为什么历史上存绝对路径的 stage 一直正常、改存相对路径后才崩。
//
// 2026-08-06 补强：解析基准不能只看 Instance.directory——TUI dev 启动时 directory 是
// packages/killstata，而数据集根（projectRoot()）是 Instance.worktree（项目根，.killstata
// 挂在项目根下）。此前 filterVerifierReadableArtifactRefs 对 `.killstata/datasets/...` 相对
// 路径用 directory/cwd 解析全失败 → readableArtifactRefs 每次都是 [] → verifier 报
// ARTIFACT_MISSING 死循环（did_7f1335de 连续 3 个会话复现）。修法：候选基准同时包含
// worktree（项目根）、directory、cwd，三个基准都试过才敢说"不存在"。
function currentWorkspaceRoots(): string[] {
  const roots: string[] = []
  try {
    roots.push(Instance.worktree)
  } catch {
    // 无 instance context 时不复用其他项目留下的进程级根目录。
  }
  try {
    roots.push(Instance.directory)
  } catch {
    // 同上。
  }
  return [...new Set(roots.filter((root): root is string => typeof root === "string" && root.length > 0))]
}

function resolveArtifactPath(candidate: string) {
  if (path.isAbsolute(candidate)) return candidate
  const roots = currentWorkspaceRoots()
  return roots.length > 0 ? path.resolve(roots[0]!, candidate) : path.resolve(candidate)
}

/** 相对引用可能相对 workspace 根、worktree 根或 cwd；所有基准都试过才敢说"不存在"。 */
function artifactPathCandidates(candidate: string) {
  if (path.isAbsolute(candidate)) return [candidate]
  const workspaceCandidates = currentWorkspaceRoots().map((root) => path.resolve(root, candidate))
  // cwd candidate 已经是完整文件路径，不能再把 candidate 拼一次成 candidate/candidate。
  return [...new Set([...workspaceCandidates, path.resolve(candidate)])]
}

export function isVerifierReadableArtifactRef(value: string) {
  const candidate = normalizeArtifactCandidate(value)
  if (!candidate) return false
  const ext = path.extname(candidate).toLowerCase()
  if (!VERIFIER_READABLE_ARTIFACT_EXTENSIONS.has(ext)) return false
  return artifactPathCandidates(candidate).some(
    (resolved) => !existingPathIsDirectory(resolved) && fs.existsSync(resolved),
  )
}

/** 只判断格式是否应作为 verifier 文本证据，不把“文件不存在”静默当成不可读格式。 */
export function isVerifierReadableArtifactCandidate(value: string) {
  const candidate = normalizeArtifactCandidate(value)
  return Boolean(candidate && VERIFIER_READABLE_ARTIFACT_EXTENSIONS.has(path.extname(candidate).toLowerCase()))
}

export function filterVerifierReadableArtifactRefs(values: string[]) {
  return [...new Set(values.filter(isVerifierReadableArtifactRef))]
}

export interface ArtifactDiagnostic {
  ref: string
  resolvedCandidates: string[]
  /** 真实存在于磁盘上的解析路径（isVerifierReadableArtifactRef 同标准）。 */
  existsOnDisk: string[]
  /** 用于诊断的解析基准（worktree/directory/cwd），让模型/用户立刻看到根因。 */
  resolvedByWorktree?: string
  resolvedByDirectory?: string
  resolvedByCwd: string
}

/**
 * 给 verifier 的 artifacts_present check 用：列出每个 ref 的解析基准与磁盘命中情况。
 * block 时把诊断写进 check message/evidence，让模型/用户立刻知道
 * "产物存在但解析错位" vs "产物确实缺失"——不再陷入盲试工具的循环
 * （2026-08-08 did.xlsx 真实测试，助手 5+ 步瞎试 workflow verify/status/restore）。
 */
export function diagnoseArtifactRefs(values: string[]): ArtifactDiagnostic[] {
  return values.map((value) => {
    const candidate = normalizeArtifactCandidate(value)
    const roots = currentWorkspaceRoots()
    const resolvedByCwd = process.cwd()
    if (!candidate) {
      return { ref: value, resolvedCandidates: [], existsOnDisk: [], resolvedByCwd }
    }
    if (path.isAbsolute(candidate)) {
      const exists = !existingPathIsDirectory(candidate) && fs.existsSync(candidate)
      return {
        ref: value,
        resolvedCandidates: [candidate],
        existsOnDisk: exists ? [candidate] : [],
        resolvedByWorktree: roots[0],
        resolvedByDirectory: roots[1],
        resolvedByCwd,
      }
    }
    const candidates = artifactPathCandidates(candidate)
    const existsOnDisk = candidates.filter(
      (resolved) => !existingPathIsDirectory(resolved) && fs.existsSync(resolved),
    )
    return {
      ref: value,
      resolvedCandidates: candidates,
      existsOnDisk,
      resolvedByWorktree: roots[0],
      resolvedByDirectory: roots[1],
      resolvedByCwd,
    }
  })
}

/**
 * 把产物引用解析成**真实存在的绝对路径**，解析不到时返回 undefined。
 *
 * 存量引用是相对 projectRoot() 的，但 verifier 子会话跑在自己的进程上下文里、cwd 是启动
 * 目录（dev 下 `packages/killstata`），拿到相对引用一律读不到。2026-08-08 实测：子 agent
 * 为了找一个明明存在的 数据质量报告，烧掉 ~35 次工具调用满文件系统摸索，最后靠读 killstata
 * 自己的源码才推断出数据挂在 worktree 下——而 `.killstata` 又在 ripgrep 默认忽略清单里，
 * glob 根本搜不到。给它绝对路径就没有这一整段浪费。
 *
 * 与 filterVerifierReadableArtifactRefs 共用同一条候选基准链，两者的存在性判断永远一致。
 */
export function resolveArtifactPathForRead(value: string): string | undefined {
  const candidate = normalizeArtifactCandidate(value)
  if (!candidate) return undefined
  return artifactPathCandidates(candidate).find(
    (resolved) => !existingPathIsDirectory(resolved) && fs.existsSync(resolved),
  )
}

export function sanitizeVerifierPromptMetadata(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (artifactKeyIsRuntimeOnly(key)) return undefined
    if (hasCommandSyntax(value)) return undefined
    if (value.replace(/\\/g, "/").toLowerCase().includes("/.killstata/runtime/health/")) return undefined
    if (isWorkflowArtifactRef(value, key) || isVerifierReadableArtifactRef(value))
      return normalizeArtifactCandidate(value)
    const ext = path.extname(value).toLowerCase()
    if (NON_ARTIFACT_EXTENSIONS.has(ext)) return undefined
    return value
  }
  if (Array.isArray(value)) {
    const filtered = value.map((item) => sanitizeVerifierPromptMetadata(item, key)).filter((item) => item !== undefined)
    return filtered
  }
  if (!value || typeof value !== "object") return value

  const result: Record<string, unknown> = {}
  for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (artifactKeyIsRuntimeOnly(nestedKey) || nestedKey === "reflection") continue
    const sanitized = sanitizeVerifierPromptMetadata(nestedValue, nestedKey)
    if (sanitized !== undefined) result[nestedKey] = sanitized
  }
  return result
}
