import path from "path"
import fs from "fs"
import { Instance } from "../project/instance"
import { datasetRoot, projectInternalRoot } from "../runtime/dataset-state"
import { Tool } from "./tool"

type AccessMode = "read" | "write"

type SessionPathConfirmationState = {
  confirmed: Record<string, true>
}

function normalizeAbsolute(filePath: string) {
  return path.normalize(path.resolve(filePath))
}

function workspaceRoot() {
  return Instance.directory
}

const INTERNAL_WORKSPACE_RE = /(?:^|[\\/])\.killstata(?:[\\/]|$)/

/**
 * 是否是内部工作区路径。唯一真相源——TUI、权限提示等所有判定点都必须复用它，
 * 各处自带一份正则会立刻漂移（曾出现过缺 `$` 分支导致目录名照样泄漏）。
 *
 * 定义放在本模块而非 analysis-display：路径解析（resolveWorkspacePath）要用它来判定
 * 该用哪个根，而 analysis-display 反过来依赖本模块的 relativeWithinProject——定义留在
 * display 侧会形成导入环。display 侧重新导出以保持既有调用点不变。
 */
export function isInternalWorkspacePath(filePath: string) {
  return INTERNAL_WORKSPACE_RE.test(path.normalize(filePath))
}

/**
 * 把相对路径解析为绝对路径。
 *
 * killstata 有两个根且常常不同：`Instance.directory`（启动目录，TUI dev 下是
 * packages/killstata）与 `Instance.worktree`（项目根）。**内部工作区 `.killstata/` 永远
 * 挂在 worktree 下**——`runtime/dataset-state.ts` 的 projectRoot() 就是这么写的，
 * `relativeWithinProject()` 也优先按 worktree 剥前缀。所以产物引用一旦以 `.killstata/`
 * 开头，它的基准**确定**是 worktree，不需要猜。
 *
 * 此前这里按 directory 拼、失败再试 worktree，且用 `existsSync(dirname(...))` 当判据：
 * 写侧按 worktree 剥、读侧按 directory 拼，同一个引用两次解析出不同结果，模型拿到
 * ENOENT 后只能满文件系统找自己刚生成的产物（2026-08-12 gf.xlsx 会话：describe 产物
 * 明明存在，read 却报 scandir 'packages/killstata/.killstata/datasets/…'）。
 * 现在按引用形态直接判定基准，不再依赖文件是否恰好存在——这样"文件不存在"报的就是
 * 真的不存在，而不是基准选错。
 */
export function resolveWorkspacePath(filePath: string, root?: string) {
  if (path.isAbsolute(filePath)) return normalizeAbsolute(filePath)
  // root 的默认值必须惰性求值：`root = workspaceRoot()` 这种默认参数在 JS 里函数一调用
  // 就会立即执行，不管 filePath 是不是绝对路径——绝对路径分支根本用不到 root，却也会
  // 因 workspaceRoot() 抛错（无 Instance 上下文）而崩溃。2026-08-14 排查同类问题时
  // analysis-grounding.ts 改用本函数处理快照路径，测试里传入绝对路径但没有
  // Instance.provide 包裹，当场复现："instance: No context found for instance"。
  const effectiveRoot = root ?? workspaceRoot()
  const normalized = path.normalize(filePath)
  // 相对路径若向上回溯（`../` 开头），说明模型是拿绝对路径自己换算成了相对它的 cwd
  // 的路径（2026-08-14 实测：模型从 workflow 记忆的绝对产物路径算出
  // `../../.killstata/datasets/…` 传给 read）。这种路径必须按**工具的 cwd**
  // （Instance.directory）语义解析，不能按 projectRoot join——否则 `../../` 会被叠到
  // 项目根之上变成错路径。拿不到 instance 上下文时退回 process.cwd()。
  if (normalized.startsWith("..")) {
    try {
      return normalizeAbsolute(path.resolve(Instance.directory, normalized))
    } catch {
      return normalizeAbsolute(path.resolve(normalized))
    }
  }
  if (isInternalWorkspacePath(normalized)) {
    try {
      return normalizeAbsolute(path.join(projectRoot(), normalized))
    } catch {
      // 无 instance context：退回 directory，与下方普通路径同一行为
    }
  }
  return normalizeAbsolute(path.join(effectiveRoot, normalized))
}

function projectRoot() {
  if (Instance.worktree && Instance.worktree !== "/") {
    return normalizeAbsolute(Instance.worktree)
  }
  return workspaceRoot()
}

function isWithinRoot(targetPath: string, rootPath: string) {
  const relative = path.relative(rootPath, targetPath)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function confirmationKey(toolName: string, mode: AccessMode, absolutePath: string) {
  return `${toolName}:${mode}:${absolutePath}`
}

const state = Instance.state(() => {
  const data: Record<string, SessionPathConfirmationState> = {}
  return data
})

function sessionState(sessionID: string) {
  const current = state()[sessionID] ?? { confirmed: {} }
  state()[sessionID] = current
  return current
}

export function analysisWorkspaceRoot() {
  return workspaceRoot()
}

export function isAnalysisPathAutoAllowed(input: { absolutePath: string; workspaceRoot: string; projectRoot: string }) {
  const target = normalizeAbsolute(input.absolutePath)
  const workspace = normalizeAbsolute(input.workspaceRoot)
  const project = normalizeAbsolute(input.projectRoot)

  if (isWithinRoot(target, workspace)) {
    return true
  }

  const whitelistRoots = [
    path.join(project, "test"),
    path.join(project, "modelpctest"),
    path.join(project, "killstata_outputs"),
    path.join(workspace, ".killstata"),
  ].map(normalizeAbsolute)

  return whitelistRoots.some((root) => isWithinRoot(target, root))
}

export function relativeWithinProject(filePath: string) {
  // Python 后端用 Path.resolve() 写回路径，会解开 symlink（macOS 下 /var → /private/var），
  // 与未解开的根路径不同形会被误判为项目外，导致绝对路径原样泄漏到模型可见输出。
  //
  // 两个根都要试：dev/TUI 启动时 Instance.directory 是 packages/killstata，而 .killstata
  // 数据层挂在 projectRoot()（= Instance.worktree）下。只按 directory 剥的话，数据层路径
  // 会走 ".." 分支直接返回**绝对路径**，本机路径就这样漏进模型可见输出。
  // worktree 在前：项目根相对路径唯一，且与 artifactRefs 的存储形式一致（`.killstata/…`）；
  // 先剥 directory 会把 `packages/killstata/src/x` 截成 `src/x`，反而产生歧义。
  const target = realPathOrSelf(filePath)
  for (const root of [projectRoot, workspaceRoot]) {
    let base: string
    try {
      base = realPathOrSelf(root())
    } catch {
      continue
    }
    const relative = path.relative(base, target)
    if (relative === "") return "."
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative
  }
  return path.normalize(filePath)
}

/** 取实路径用于同一性比对；路径不存在时回退到词法路径。 */
export function realPathOrSelf(target: string) {
  const absolute = normalizeAbsolute(target)
  try {
    return fs.realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** Resolve a not-yet-created target through its closest existing parent so ancestor symlinks
 * cannot make a lexical in-workspace destination escape into an external directory. */
function resolveThroughRealExistingAncestor(target: string) {
  const suffix: string[] = []
  let existing = normalizeAbsolute(target)
  while (!fs.existsSync(existing)) {
    try {
      if (fs.lstatSync(existing).isSymbolicLink()) {
        throw new Error("无法确认目标路径的真实位置：路径包含无法解析的符号链接。")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const parent = path.dirname(existing)
    if (parent === existing) return normalizeAbsolute(target)
    suffix.unshift(path.basename(existing))
    existing = parent
  }
  return normalizeAbsolute(path.join(fs.realpathSync(existing), ...suffix))
}

/** Reject symlinks below .killstata even when they point back inside the project. */
function rejectManagedSymlinkComponents(target: string) {
  const absoluteTarget = normalizeAbsolute(target)
  const internalRoots = new Set([
    normalizeAbsolute(projectInternalRoot()),
    resolveThroughRealExistingAncestor(projectInternalRoot()),
  ])
  for (const internalRoot of internalRoots) {
    const relative = path.relative(internalRoot, absoluteTarget)
    if (!isWithinRoot(absoluteTarget, internalRoot)) continue

    let current = internalRoot
    for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) current = path.join(current, segment)
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Tool.InputValidationError("受管数据路径包含符号链接，已拒绝访问。")
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break
        throw error
      }
    }
  }
}

/** Resolve a generated path through real ancestors and require it to remain under project .killstata. */
export function resolveManagedProjectPath(input: { filePath: string; managedRoot: string }) {
  rejectManagedSymlinkComponents(input.managedRoot)
  rejectManagedSymlinkComponents(input.filePath)
  const canonicalProjectRoot = resolveThroughRealExistingAncestor(projectRoot())
  const canonicalInternalRoot = resolveThroughRealExistingAncestor(projectInternalRoot())
  const canonicalManagedRoot = resolveThroughRealExistingAncestor(input.managedRoot)
  const canonicalTarget = resolveThroughRealExistingAncestor(input.filePath)

  if (!isWithinRoot(canonicalInternalRoot, canonicalProjectRoot)) {
    throw new Tool.InputValidationError("KillStata 受管状态目录指向项目之外，已拒绝访问。")
  }
  if (!isWithinRoot(canonicalManagedRoot, canonicalInternalRoot) || !isWithinRoot(canonicalTarget, canonicalManagedRoot)) {
    throw new Tool.InputValidationError("当前规范化数据路径指向受管数据目录之外，已拒绝访问。")
  }
  return canonicalTarget
}

/** Resolve canonical stage files inside the managed dataset root; legacy external stages require normal path approval. */
export async function resolveDatasetStagePath(input: {
  datasetId: string
  filePath: string
  toolName: string
  sessionID: string
  messageID: string
  callID?: string
  ask: Tool.Context["ask"]
}) {
  const managedRoot = datasetRoot(input.datasetId)
  const absoluteFile = normalizeAbsolute(input.filePath)
  const absoluteRoot = normalizeAbsolute(managedRoot)
  const canonicalFile = resolveThroughRealExistingAncestor(absoluteFile)
  const canonicalDatasetRoot = resolveThroughRealExistingAncestor(absoluteRoot)
  if (isWithinRoot(absoluteFile, absoluteRoot) || isWithinRoot(canonicalFile, canonicalDatasetRoot)) {
    return resolveManagedProjectPath({ filePath: absoluteFile, managedRoot })
  }
  const canonicalDatasetsRoot = resolveThroughRealExistingAncestor(path.join(projectInternalRoot(), "datasets"))
  if (isWithinRoot(canonicalFile, canonicalDatasetsRoot)) {
    throw new Tool.InputValidationError("当前数据阶段指向其他数据集的内部文件，已拒绝读取。")
  }
  return resolveToolPath({ ...input, filePath: absoluteFile, mode: "read" })
}

export async function resolveToolPath(input: {
  filePath: string
  mode: AccessMode
  toolName: string
  sessionID: string
  callID?: string
  messageID: string
  ask: Tool.Context["ask"]
}) {
  const root = workspaceRoot()
  const project = projectRoot()
  const absolutePath = resolveThroughRealExistingAncestor(resolveWorkspacePath(input.filePath, root))
  const canonicalWorkspaceRoot = realPathOrSelf(root)
  const canonicalProjectRoot = realPathOrSelf(project)

  if (
    isWithinRoot(absolutePath, canonicalWorkspaceRoot) ||
    isWithinRoot(absolutePath, canonicalProjectRoot) ||
    isAnalysisPathAutoAllowed({
      absolutePath,
      workspaceRoot: canonicalWorkspaceRoot,
      projectRoot: canonicalProjectRoot,
    })
  ) {
    return absolutePath
  }

  const key = confirmationKey(input.toolName, input.mode, absolutePath)
  const current = sessionState(input.sessionID)
  if (current.confirmed[key]) {
    return absolutePath
  }

  const parentDir =
    input.mode === "write"
      ? absolutePath
      : fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()
        ? absolutePath
        : path.dirname(absolutePath)
  const glob = path.join(parentDir, "*")

  await input.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: absolutePath,
      parentDir,
    },
  })

  current.confirmed[key] = true
  return absolutePath
}
