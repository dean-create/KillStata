import fs from "fs"
import path from "path"
import crypto from "crypto"
import { Instance } from "@/project/instance"

const LEGACY_DELIVERY_BUNDLE_PREFIX = "killstata_ouput_"
const DELIVERY_BUNDLE_PREFIX = "killstata_output_"

// ── Types ──────────────────────────────────────────────────────────

export type DatasetStageRecord = {
  stageId: string
  runId?: string
  parentStageId?: string
  branch: string
  action: string
  label?: string
  workingPath: string
  workingFormat: "parquet"
  rowCount?: number
  columnCount?: number
  schemaPath?: string
  labelsPath?: string
  summaryPath?: string
  logPath?: string
  inspectionPath?: string
  inspectionWorkbookPath?: string
  importReceiptPath?: string
  createdAt: string
  metadata?: Record<string, unknown>
}

export type DatasetArtifactRecord = {
  artifactId: string
  runId?: string
  stageId?: string
  branch: string
  action: string
  outputPath: string
  workbookPath?: string
  summaryPath?: string
  logPath?: string
  createdAt: string
  metadata?: Record<string, unknown>
}

export type FinalOutputRecord = {
  key: string
  label: string
  path: string
  runId?: string
  stageId?: string
  branch: string
  sourcePath: string
  createdAt: string
  metadata?: Record<string, unknown>
}

/**
 * 原始工作簿在会话历史中的位置。数据集文件仍只保存一份 canonical 副本；
 * 该记录只提供从分析产物回到用户上传消息的稳定索引，供恢复上下文和复现使用。
 */
export type DatasetConversationOrigin = {
  sessionID: string
  messageID?: string
  attachmentPartID?: string
  importedAt: string
}

/**
 * 项目内不可变原件快照。sourceId 是文件内容 SHA-256，不是文件名或会话 ID：
 * 同一份 Excel 被多个会话导入时只存一份，数据集/工作流仍由各自 session 隔离。
 */
export type SourceAsset = {
  sourceId: string
  managedPath: string
  originalFilename: string
  sourceFormat: DatasetManifest["sourceFormat"]
  sizeBytes: number
  createdAt: string
}

/** 导入收据记录 source → canonical stage 的可复现决策，不替代原始文件或 schema。 */
export type ImportReceipt = {
  version: 1
  sourceId: string
  sourceFormat: DatasetManifest["sourceFormat"]
  sheetPolicy: { mode: "first_sheet" | "named_sheet"; sheetName?: string; headerRow?: number }
  readerPolicy: "conservative_schema_normalization_v1"
  canonicalStagePath: string
  schemaPath?: string
  normalization: Record<string, unknown>
  createdAt: string
}

export type DatasetManifest = {
  datasetId: string
  sourcePath: string
  sourceFormat: "csv" | "xlsx" | "xls" | "dta" | "parquet" | "unknown"
  workingFormat: "parquet"
  createdAt: string
  updatedAt: string
  stages: DatasetStageRecord[]
  artifacts: DatasetArtifactRecord[]
  finalOutputs: FinalOutputRecord[]
  origin?: DatasetConversationOrigin
  sourceAsset?: SourceAsset
  /** 数据质量检查阶段确立的面板身份，持久化后供 filter/preprocess 自动回填 */
  panelIdentifiers?: { entityVar?: string; timeVar?: string }
}

export type SourceFingerprint = {
  realPath: string
  sizeBytes: number
  mtimeMs: number
  key: string
}

export type DatasetIndexEntry = {
  datasetId: string
  sourcePath: string
  fingerprint: SourceFingerprint
  updatedAt: string
  /**
   * 创建该条目（导入该数据集）的会话 ID。**跨会话隔离的关键**：
   * dataset index 是项目级共享的，同一源文件在会话 A 导入过，会话 B 再导入同一文件时
   * 若按指纹直接复用，B 会继承 A 的全部 stages/artifacts/工作流状态——"干净的新窗口"
   * 就名存实亡（2026-08-08 用户诉求：新会话必须与上一窗口的数据完全隔离）。
   * 复用判定：指纹命中 **且** createdBySessionID === 当前会话。历史条目没有此字段
   * （旧版本写入），一律视为"别会话创建"，不复用，保证新会话首次导入总是新建数据集。
   */
  createdBySessionID?: string
}

export type DatasetIndex = {
  version: 1
  entries: Record<string, DatasetIndexEntry>
}

// ── Internal path helpers ──────────────────────────────────────────
// 同时被 runtime/ 的只读查询和 tool/analysis-state 的写操作使用

export function projectRoot() {
  return Instance.worktree
}

export function projectInternalRoot() {
  return path.join(projectRoot(), ".killstata")
}

export function projectStateRoot() {
  return path.join(projectInternalRoot(), "runtime")
}

export function projectReflectionRoot() {
  return path.join(projectStateRoot(), "reflection")
}

export function datasetsRoot() {
  return path.join(projectInternalRoot(), "datasets")
}

export function sourcesRoot() {
  return path.join(projectInternalRoot(), "sources")
}

export function sourceAssetRoot(sourceId: string) {
  return path.join(sourcesRoot(), sourceId)
}

export function sourceAssetMetadataPath(sourceId: string) {
  return path.join(sourceAssetRoot(sourceId), "source.json")
}

export function datasetRoot(datasetId: string) {
  return path.join(datasetsRoot(), datasetId)
}

export function datasetManifestPath(datasetId: string) {
  return path.join(datasetRoot(datasetId), "manifest.json")
}

function resolvePathThroughRealExistingAncestor(target: string) {
  const suffix: string[] = []
  let current = path.resolve(target)
  for (;;) {
    try {
      fs.lstatSync(current)
      return path.resolve(fs.realpathSync(current), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const parent = path.dirname(current)
    if (parent === current) throw new Error("无法核验受管源文件路径。")
    suffix.unshift(path.basename(current))
    current = parent
  }
}

function isWithinPath(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function rejectSymlinkPathSegments(target: string, root: string) {
  const absoluteTarget = path.resolve(target)
  const absoluteRoot = path.resolve(root)
  const relative = path.relative(absoluteRoot, absoluteTarget)
  if (!isWithinPath(absoluteRoot, absoluteTarget)) return
  let current = absoluteRoot
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error("受管数据路径包含符号链接，已拒绝写入。")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break
      throw error
    }
  }
}

export function resolveManagedInternalPath(target: string) {
  const canonicalProjectRoot = resolvePathThroughRealExistingAncestor(projectRoot())
  const canonicalInternalRoot = resolvePathThroughRealExistingAncestor(projectInternalRoot())
  const canonicalTarget = resolvePathThroughRealExistingAncestor(target)
  if (!isWithinPath(canonicalProjectRoot, canonicalInternalRoot) || !isWithinPath(canonicalInternalRoot, canonicalTarget)) {
    throw new Error("受管状态路径指向项目之外，已拒绝访问。")
  }
  const internalRoots = new Set([path.resolve(projectInternalRoot()), canonicalInternalRoot])
  for (const root of internalRoots) rejectSymlinkPathSegments(target, root)
  return canonicalTarget
}

export function resolveManagedDatasetPath(input: { datasetId: string; filePath: string }) {
  const canonicalInternalRoot = resolvePathThroughRealExistingAncestor(projectInternalRoot())
  const canonicalDatasetsRoot = path.join(canonicalInternalRoot, "datasets")
  const canonicalDatasetRoot = resolvePathThroughRealExistingAncestor(datasetRoot(input.datasetId))
  const expectedDatasetRoot = path.join(canonicalDatasetsRoot, input.datasetId)
  if (!isWithinPath(canonicalDatasetsRoot, expectedDatasetRoot) || canonicalDatasetRoot !== expectedDatasetRoot) {
    throw new Error("数据集目录与其规范 ID 不一致，已拒绝写入。")
  }
  const canonicalTarget = resolveManagedInternalPath(input.filePath)
  if (!isWithinPath(canonicalDatasetRoot, canonicalTarget)) {
    throw new Error("数据产物路径指向当前数据集之外，已拒绝写入。")
  }
  return canonicalTarget
}

function resolveManagedSourcePath(target: string) {
  return resolveManagedInternalPath(target)
}

export function datasetIndexPath() {
  return path.join(datasetsRoot(), "index.json")
}

export function inferSourceFormat(filePath: string): DatasetManifest["sourceFormat"] {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".csv") return "csv"
  if (ext === ".xlsx") return "xlsx"
  if (ext === ".xls") return "xls"
  if (ext === ".dta") return "dta"
  if (ext === ".parquet") return "parquet"
  return "unknown"
}

function sourceAssetHash(filePath: string) {
  const hash = crypto.createHash("sha256")
  const descriptor = fs.openSync(filePath, "r")
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest("hex")
}

function sourceAssetFilename(sourcePath: string) {
  const ext = path.extname(sourcePath).toLowerCase()
  return `original${ext || ".bin"}`
}

/**
 * 将导入原件固定为项目内按内容寻址的只读快照。不能只依赖用户桌面上的路径：原文件被移动、
 * 改写或删除后，stage_000 必须仍能重新导入。metadata 不保存外部绝对路径，避免把本机
 * 路径扩散到 manifest/模型上下文；原文件名和 hash 已足以解释来源与去重关系。
 */
export function ensureSourceAsset(input: { sourcePath: string }): SourceAsset {
  const sourcePath = fs.realpathSync.native(input.sourcePath)
  const stats = fs.statSync(sourcePath)
  if (!stats.isFile()) throw new Error(`Source asset must be a regular file: ${sourcePath}`)

  const sourceId = sourceAssetHash(sourcePath)
  const root = resolveManagedSourcePath(sourceAssetRoot(sourceId))
  const metadataPath = resolveManagedSourcePath(sourceAssetMetadataPath(sourceId))
  const proposedManagedPath = resolveManagedSourcePath(path.join(root, sourceAssetFilename(sourcePath)))
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })

  if (fs.existsSync(metadataPath)) {
    const existing = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as SourceAsset
    const managedPath = resolveManagedSourcePath(path.join(root, path.basename(existing.managedPath)))
    if (!fs.existsSync(managedPath)) {
      throw new Error(`Source asset metadata exists but its immutable copy is missing: ${existing.sourceId}`)
    }
    fs.chmodSync(managedPath, 0o444)
    return { ...existing, managedPath }
  }

  const managedPath = proposedManagedPath

  if (!fs.existsSync(managedPath)) {
    try {
      fs.copyFileSync(sourcePath, managedPath, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
    }
  }
  fs.chmodSync(managedPath, 0o444)

  const asset: SourceAsset = {
    sourceId,
    managedPath,
    originalFilename: path.basename(sourcePath),
    sourceFormat: inferSourceFormat(sourcePath),
    sizeBytes: stats.size,
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(metadataPath, JSON.stringify(asset, null, 2), { encoding: "utf-8", mode: 0o600 })
  fs.chmodSync(metadataPath, 0o600)
  return asset
}

export function writeImportReceipt(input: {
  datasetId: string
  receiptPath: string
  receipt: Omit<ImportReceipt, "version" | "createdAt"> & Partial<Pick<ImportReceipt, "version" | "createdAt">>
}) {
  const receipt: ImportReceipt = {
    version: 1,
    createdAt: new Date().toISOString(),
    ...input.receipt,
  }
  let safePath = resolveManagedDatasetPath({ datasetId: input.datasetId, filePath: input.receiptPath })
  fs.mkdirSync(path.dirname(safePath), { recursive: true, mode: 0o700 })
  safePath = resolveManagedDatasetPath({ datasetId: input.datasetId, filePath: safePath })
  fs.writeFileSync(safePath, JSON.stringify(receipt, null, 2), { encoding: "utf-8", mode: 0o600 })
  fs.chmodSync(safePath, 0o600)
  return receipt
}

export function projectPlansRoot() {
  return path.join(projectInternalRoot(), "plans")
}

export function projectTempRoot() {
  return path.join(projectStateRoot(), "tmp")
}

export function projectErrorsRoot() {
  return path.join(projectStateRoot(), "errors")
}

export function projectHealthRoot() {
  return path.join(projectStateRoot(), "health")
}

export function deliveryStateRoot() {
  return path.join(projectStateRoot(), "delivery")
}

// ── 目录布局与 legacy 迁移 ─────────────────────────────────────────
// 纯目录管理，无业务逻辑。放在 runtime/ 是因为只读查询也依赖它——
// 留在 tool/ 会让 readDatasetManifest 无法在读之前保证目录存在。

function replaceRoot(value: unknown, fromRoot: string, toRoot: string): unknown {
  if (typeof value === "string") {
    return value.startsWith(fromRoot) ? path.join(toRoot, value.slice(fromRoot.length)) : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceRoot(item, fromRoot, toRoot))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRoot(item, fromRoot, toRoot)]))
  }
  return value
}

function migrateDirectoryIfNeeded(fromDir: string, toDir: string) {
  if (!fs.existsSync(fromDir) || fs.existsSync(toDir)) return
  fs.mkdirSync(path.dirname(toDir), { recursive: true })
  fs.renameSync(fromDir, toDir)
}

function rewriteFileTokensIfNeeded(filePath: string, replacements: Array<{ from: string; to: string }>) {
  if (!fs.existsSync(filePath)) return
  const safePath = resolveManagedInternalPath(filePath)
  const original = fs.readFileSync(safePath, "utf-8")
  const updated = replacements.reduce((text, replacement) => text.split(replacement.from).join(replacement.to), original)
  if (updated !== original) fs.writeFileSync(resolveManagedInternalPath(safePath), updated, "utf-8")
}

function normalizeLegacyDeliveryBundleName(name: string) {
  if (!name.startsWith(LEGACY_DELIVERY_BUNDLE_PREFIX)) return name
  const suffix = name.slice(LEGACY_DELIVERY_BUNDLE_PREFIX.length)
  if (/^\d{12}$/.test(suffix)) {
    return `${DELIVERY_BUNDLE_PREFIX}${suffix.slice(0, 8)}_${suffix.slice(8)}`
  }
  return `${DELIVERY_BUNDLE_PREFIX}${suffix}`
}

function migrateLegacyDeliveryBundles() {
  const replacements: Array<{ from: string; to: string }> = []
  const internalManifestRoot = path.join(deliveryStateRoot(), "manifests")
  const roots = [Instance.directory, internalManifestRoot]

  for (const candidateRoot of roots) {
    const root = candidateRoot === internalManifestRoot
      ? resolveManagedInternalPath(candidateRoot)
      : candidateRoot
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(LEGACY_DELIVERY_BUNDLE_PREFIX)) continue
      const legacyName = entry.name
      const currentName = normalizeLegacyDeliveryBundleName(legacyName)
      migrateDirectoryIfNeeded(path.join(root, legacyName), path.join(root, currentName))
      replacements.push({ from: legacyName, to: currentName })
    }
  }

  if (replacements.length === 0) return

  if (fs.existsSync(datasetsRoot())) {
    for (const entry of fs.readdirSync(datasetsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      rewriteFileTokensIfNeeded(path.join(datasetsRoot(), entry.name, "manifest.json"), replacements)
    }
  }

  const manifestRoot = path.join(deliveryStateRoot(), "manifests")
  if (fs.existsSync(manifestRoot)) {
    for (const entry of fs.readdirSync(manifestRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      rewriteFileTokensIfNeeded(path.join(manifestRoot, entry.name, "final_outputs.json"), replacements)
    }
  }
}

export function writeDatasetIndex(index: DatasetIndex) {
  const indexPath = resolveManagedInternalPath(datasetIndexPath())
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  fs.writeFileSync(resolveManagedInternalPath(indexPath), JSON.stringify(index, null, 2), "utf-8")
}

export function ensureInternalLayout() {
  const root = projectInternalRoot()
  for (const target of [
    root,
    projectErrorsRoot(),
    projectHealthRoot(),
    projectReflectionRoot(),
    projectTempRoot(),
    path.join(root, "state", "datasets"),
  ]) resolveManagedInternalPath(target)
  fs.mkdirSync(root, { recursive: true })

  migrateDirectoryIfNeeded(path.join(root, "errors"), projectErrorsRoot())
  migrateDirectoryIfNeeded(path.join(root, "health"), projectHealthRoot())
  migrateDirectoryIfNeeded(path.join(root, "reflection"), projectReflectionRoot())
  migrateDirectoryIfNeeded(path.join(root, "tmp"), projectTempRoot())

  const legacyRoot = path.join(root, "state")
  const legacyDatasets = path.join(legacyRoot, "datasets")
  if (fs.existsSync(legacyDatasets)) {
    const safeLegacyDatasets = resolveManagedInternalPath(legacyDatasets)
    fs.mkdirSync(resolveManagedInternalPath(datasetsRoot()), { recursive: true })
    for (const entry of fs.readdirSync(safeLegacyDatasets, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const fromDir = resolveManagedInternalPath(path.join(safeLegacyDatasets, entry.name))
      const toDir = resolveManagedDatasetPath({ datasetId: entry.name, filePath: datasetRoot(entry.name) })
      if (fs.existsSync(toDir)) continue
      fs.renameSync(fromDir, toDir)
      const manifestPath = resolveManagedDatasetPath({
        datasetId: entry.name,
        filePath: datasetManifestPath(entry.name),
      })
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
        const migrated = replaceRoot(manifest, fromDir, toDir)
        fs.writeFileSync(resolveManagedDatasetPath({ datasetId: entry.name, filePath: manifestPath }), JSON.stringify(migrated, null, 2), "utf-8")
      }
    }
    const remaining = fs.existsSync(legacyDatasets) ? fs.readdirSync(legacyDatasets) : []
    if (remaining.length === 0) fs.rmSync(legacyDatasets, { recursive: true, force: true })
  }

  if (fs.existsSync(legacyRoot)) {
    const remaining = fs.readdirSync(legacyRoot)
    if (remaining.length === 0) fs.rmSync(legacyRoot, { recursive: true, force: true })
  }

  for (const dir of [
    projectStateRoot(),
    projectPlansRoot(),
    projectReflectionRoot(),
    projectTempRoot(),
    projectErrorsRoot(),
    projectHealthRoot(),
    deliveryStateRoot(),
    datasetsRoot(),
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(datasetIndexPath())) {
    writeDatasetIndex({ version: 1, entries: {} })
  }

  migrateLegacyDeliveryBundles()
}

// ── Read-only queries ──────────────────────────────────────────────
// 这些函数从 tool/analysis-state 移出，消除 runtime → tool 反依赖

/**
 * 读取数据集 manifest。
 * 调用方负责确保数据集已创建（createDatasetManifest 会保证目录布局存在）。
 */
export function readDatasetManifest(datasetId: string) {
  ensureInternalLayout()
  const manifestPath = resolveManagedDatasetPath({
    datasetId,
    filePath: datasetManifestPath(datasetId),
  })
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Dataset manifest not found for datasetId=${datasetId}`)
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as DatasetManifest
  return {
    ...parsed,
    sourceFormat: parsed.sourceFormat || inferSourceFormat(parsed.sourcePath),
    workingFormat: "parquet" as const,
    stages: (parsed.stages ?? []).map((stage) => ({
      ...stage,
      workingFormat: "parquet" as const,
    })),
    artifacts: parsed.artifacts ?? [],
    finalOutputs: parsed.finalOutputs ?? [],
  }
}

export function readDatasetIndex(): DatasetIndex {
  ensureInternalLayout()
  const safeIndexPath = resolveManagedInternalPath(datasetIndexPath())
  if (!fs.existsSync(safeIndexPath)) {
    return { version: 1, entries: {} }
  }
  const parsed = JSON.parse(fs.readFileSync(safeIndexPath, "utf-8")) as DatasetIndex
  return {
    version: 1,
    entries: parsed.entries ?? {},
  }
}

/**
 * 从 manifest 中获取指定 stage，不指定 stageId 时返回最后一个 stage。
 */
export function getStage(manifest: DatasetManifest, stageId?: string) {
  if (!manifest.stages.length) {
    throw new Error(`Dataset ${manifest.datasetId} has no stages yet`)
  }
  if (!stageId) return manifest.stages[manifest.stages.length - 1]
  const match = manifest.stages.find((item) => item.stageId === stageId)
  if (!match) {
    throw new Error(`Stage not found: datasetId=${manifest.datasetId}, stageId=${stageId}`)
  }
  return match
}
