import fs from "fs"
import path from "path"
import crypto from "crypto"
import { Instance } from "../project/instance"

// ── 只读查询、路径与布局管理已下沉到 runtime/dataset-state（消除 runtime → tool 反依赖）──
import {
  projectRoot,
  projectInternalRoot,
  projectStateRoot,
  projectReflectionRoot,
  projectPlansRoot,
  projectTempRoot,
  projectErrorsRoot,
  projectHealthRoot,
  deliveryStateRoot,
  datasetsRoot,
  datasetRoot,
  datasetManifestPath,
  datasetIndexPath,
  sourcesRoot,
  sourceAssetRoot,
  sourceAssetMetadataPath,
  ensureSourceAsset,
  resolveManagedDatasetPath,
  writeImportReceipt,
  inferSourceFormat,
  getStage,
  readDatasetManifest,
  readDatasetIndex,
  writeDatasetIndex,
  ensureInternalLayout,
} from "../runtime/dataset-state"

import type {
  DatasetManifest,
  DatasetStageRecord,
  DatasetArtifactRecord,
  FinalOutputRecord,
  DatasetConversationOrigin,
  SourceAsset,
  ImportReceipt,
  SourceFingerprint,
  DatasetIndex,
  DatasetIndexEntry,
} from "../runtime/dataset-state"

// ── Re-export 给 tool/ 下游使用，保持既有 import 路径不变 ──
export {
  projectRoot,
  projectInternalRoot,
  projectStateRoot,
  projectReflectionRoot,
  projectPlansRoot,
  projectTempRoot,
  projectErrorsRoot,
  projectHealthRoot,
  deliveryStateRoot,
  datasetsRoot,
  datasetRoot,
  datasetManifestPath,
  datasetIndexPath,
  sourcesRoot,
  sourceAssetRoot,
  sourceAssetMetadataPath,
  ensureSourceAsset,
  writeImportReceipt,
  inferSourceFormat,
  getStage,
  readDatasetManifest,
  readDatasetIndex,
  writeDatasetIndex,
  ensureInternalLayout,
}

export type {
  DatasetStageRecord,
  DatasetArtifactRecord,
  FinalOutputRecord,
  DatasetConversationOrigin,
  SourceAsset,
  ImportReceipt,
  DatasetManifest,
  SourceFingerprint,
  DatasetIndex,
  DatasetIndexEntry,
} from "../runtime/dataset-state"

type DeliveryRunManifest = {
  version: 1
  runId: string
  bundleName?: string
  bundleDir?: string
  datasetId?: string
  sourcePath?: string
  generatedAt: string
  outputs: FinalOutputRecord[]
}

function nowIso() {
  return new Date().toISOString()
}

function stableHash(value: string) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 8)
}

function fileStamp(input = new Date()) {
  const pad = (value: number) => value.toString().padStart(2, "0")
  return [
    input.getFullYear().toString(),
    pad(input.getMonth() + 1),
    pad(input.getDate()),
    "-",
    pad(input.getHours()),
    pad(input.getMinutes()),
    pad(input.getSeconds()),
    input.getMilliseconds().toString().padStart(3, "0"),
  ].join("")
}

function sanitizeSegment(value: string) {
  return (
    value
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "item"
  )
}

function sanitizeBranchPath(value: string) {
  const parts = value
    .split(/[\\/]+/)
    .map((part) => sanitizeSegment(part))
    .filter(Boolean)
  return parts.length ? path.join(...parts) : "main"
}

function sanitizeUserSegment(value: string) {
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
  return cleaned || "dataset"
}

export function createDatasetId(inputPath: string, fingerprintKey?: string, sessionID?: string) {
  const basename = sanitizeSegment(path.basename(inputPath, path.extname(inputPath)))
  // 同一源文件可被多个会话独立导入。dataset 目录是可写状态，不能只按文件指纹共享，
  // 否则后一个会话的 stage/abort 清理会覆盖或删除前一个会话的数据。
  const identity = sessionID ? `${fingerprintKey ?? inputPath}::session::${sessionID}` : (fingerprintKey ?? inputPath)
  const suffix = stableHash(identity)
  return `${basename}_${suffix}`
}

export function normalizeRunId(value: string) {
  const normalized = sanitizeSegment(value)
  if (normalized.startsWith("run_")) return normalized
  return `run_${normalized}`
}

export function createRunId(input = new Date()) {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `run_${fileStamp(input)}_${suffix}`
}

export function inferRunId(input: {
  requestedRunId?: string
  stage?: Pick<DatasetStageRecord, "runId" | "metadata">
  source?: "workflow" | "model"
}) {
  const fromStage = typeof input.stage?.runId === "string" ? input.stage.runId : undefined
  const fromMetadata = typeof input.stage?.metadata?.runId === "string" ? input.stage.metadata.runId : undefined
  const canonical = fromStage ?? fromMetadata
  if (
    canonical &&
    input.requestedRunId &&
    normalizeRunId(input.requestedRunId) !== normalizeRunId(canonical) &&
    input.source !== "model"
  ) {
    throw new Error("runId 与当前规范化数据阶段不一致；不得由模型创建新的运行身份。")
  }
  return normalizeRunId(canonical ?? input.requestedRunId ?? createRunId())
}

export function inferBranch(input: {
  requestedBranch?: string
  stage?: Pick<DatasetStageRecord, "branch">
  source?: "workflow" | "model"
}) {
  const canonical = input.stage?.branch ?? "main"
  if (input.requestedBranch && input.requestedBranch !== canonical && input.source !== "model") {
    throw new Error("branch 与当前规范化数据阶段不一致；新分支必须通过显式工作流动作创建。")
  }
  return canonical
}

export function buildStageId(index: number) {
  return `stage_${index.toString().padStart(3, "0")}`
}

export function stageIndex(stageId: string) {
  const match = /stage_(\d+)/.exec(stageId)
  return match ? Number.parseInt(match[1], 10) : 0
}

export function sourceOutputsRoot(sourcePath: string) {
  const datasetName = sanitizeUserSegment(path.basename(sourcePath, path.extname(sourcePath)))
  return path.join(projectStateRoot(), "delivery", "published", datasetName)
}

function legacySourceOutputsRoot(sourcePath: string) {
  const sourceDir = path.dirname(sourcePath)
  const datasetName = sanitizeUserSegment(path.basename(sourcePath, path.extname(sourcePath)))
  return path.join(sourceDir, "killstata_outputs", datasetName)
}

export function runOutputsRoot(sourcePath: string, runId: string) {
  return path.join(sourceOutputsRoot(sourcePath), normalizeRunId(runId))
}

function runIdDeliveryStamp(runId: string) {
  const normalized = normalizeRunId(runId)
  const match = /^run_(\d{8})-(\d{6})/.exec(normalized)
  if (match) {
    return `${match[1]}_${match[2].slice(0, 4)}`
  }
  const now = new Date()
  return (
    [
      now.getFullYear().toString(),
      (now.getMonth() + 1).toString().padStart(2, "0"),
      now.getDate().toString().padStart(2, "0"),
    ].join("") +
    "_" +
    [now.getHours().toString().padStart(2, "0"), now.getMinutes().toString().padStart(2, "0")].join("")
  )
}

const DELIVERY_BUNDLE_PREFIX = "killstata_output_"
const LEGACY_DELIVERY_BUNDLE_PREFIX = "killstata_ouput_"

function baseDeliveryBundleName(runId: string) {
  return `${DELIVERY_BUNDLE_PREFIX}${runIdDeliveryStamp(runId)}`
}

function legacyDeliveryBundleNames(runId: string) {
  const stamp = runIdDeliveryStamp(runId)
  const compactStamp = stamp.replace("_", "")
  return [`${DELIVERY_BUNDLE_PREFIX}${compactStamp}`, `${LEGACY_DELIVERY_BUNDLE_PREFIX}${compactStamp}`]
}

export function deliveryBundleName(runId: string) {
  return baseDeliveryBundleName(runId)
}

export function deliveryBundleDir(runId: string) {
  const existing = readDeliveryRunManifest(runId)
  return existing?.bundleDir ?? path.join(projectRoot(), existing?.bundleName ?? deliveryBundleName(runId))
}

function deliveryManifestRoot(runId: string) {
  return path.join(deliveryStateRoot(), "manifests", normalizeRunId(runId))
}

function deliveryManifestPath(runId: string) {
  return path.join(deliveryManifestRoot(runId), "final_outputs.json")
}

function legacyDeliveryManifestPaths(runId: string) {
  return legacyDeliveryBundleNames(runId).map((name) =>
    path.join(deliveryStateRoot(), "manifests", name, "final_outputs.json"),
  )
}

function readDeliveryRunManifest(runId: string): DeliveryRunManifest | undefined {
  const normalizedRunId = normalizeRunId(runId)
  const primaryPath = deliveryManifestPath(normalizedRunId)
  for (const manifestPath of [primaryPath, ...legacyDeliveryManifestPaths(normalizedRunId)]) {
    if (!fs.existsSync(manifestPath)) continue
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Partial<DeliveryRunManifest> & {
      outputs?: FinalOutputRecord[]
    }
    const bundleName =
      parsed.bundleName ??
      (manifestPath === primaryPath
        ? baseDeliveryBundleName(normalizedRunId)
        : path.basename(path.dirname(manifestPath)))
    return {
      version: 1,
      runId: normalizedRunId,
      bundleName,
      bundleDir: parsed.bundleDir ?? path.join(projectRoot(), bundleName),
      datasetId: parsed.datasetId,
      sourcePath: parsed.sourcePath,
      generatedAt: parsed.generatedAt ?? nowIso(),
      outputs: parsed.outputs ?? [],
    }
  }
  return undefined
}

function writeDeliveryRunManifest(manifest: DeliveryRunManifest) {
  const outputPath = deliveryManifestPath(manifest.runId)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2), "utf-8")
}

function deliveryBundleParentDir(sourcePath?: string) {
  if (!sourcePath) return projectRoot()
  const resolved = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(projectRoot(), sourcePath)
  return path.dirname(resolved)
}

function ensureDeliveryBundleAllocation(runId: string, parentDir: string) {
  const normalizedRunId = normalizeRunId(runId)
  const existing = readDeliveryRunManifest(normalizedRunId)
  if (existing?.bundleName) {
    return {
      bundleName: existing.bundleName,
      bundleDir: existing.bundleDir ?? path.join(parentDir, existing.bundleName),
    }
  }

  const baseName = baseDeliveryBundleName(normalizedRunId)
  let candidate = baseName
  let index = 2
  while (fs.existsSync(path.join(parentDir, candidate))) {
    candidate = `${baseName}_${index.toString().padStart(2, "0")}`
    index += 1
  }
  return {
    bundleName: candidate,
    bundleDir: path.join(parentDir, candidate),
  }
}

function ensureUniqueFilePath(dir: string, fileName: string) {
  const parsed = path.parse(fileName)
  let candidate = path.join(dir, fileName)
  let index = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}_${index}${parsed.ext}`)
    index += 1
  }
  return candidate
}

export function ensureDatasetDirs(datasetId: string) {
  ensureInternalLayout()
  const root = datasetRoot(datasetId)
  for (const dir of [
    root,
    path.join(root, "stages"),
    path.join(root, "reports"),
    path.join(root, "meta"),
    path.join(root, "audit"),
  ]) {
    fs.mkdirSync(resolveManagedDatasetPath({ datasetId, filePath: dir }), { recursive: true })
  }
}

export function createDatasetManifest(input: {
  datasetId: string
  sourcePath: string
  sourceFormat?: DatasetManifest["sourceFormat"]
  workingFormat?: "parquet"
  origin?: DatasetConversationOrigin
  sourceAsset?: SourceAsset
}): DatasetManifest {
  ensureDatasetDirs(input.datasetId)
  return {
    datasetId: input.datasetId,
    sourcePath: input.sourcePath,
    sourceFormat: input.sourceFormat ?? inferSourceFormat(input.sourcePath),
    workingFormat: input.workingFormat ?? "parquet",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    stages: [],
    artifacts: [],
    finalOutputs: [],
    origin: input.origin,
    sourceAsset: input.sourceAsset,
  }
}

export function writeDatasetManifest(manifest: DatasetManifest) {
  ensureDatasetDirs(manifest.datasetId)
  // 运行期校验：保证 readDatasetManifest 之后的工作格式查询不会撒谎。
  // 读侧无条件改写为 "parquet"，所以写也必须匹配；否则读路径会把磁盘上的
  // csv/csv 静默改写成 parquet，下游按 stage.workingFormat === "parquet"
  // 去读 workingPath 就崩。
  if (manifest.workingFormat !== "parquet") {
    throw new Error(
      `DatasetManifest.workingFormat 必须是 "parquet"，收到 "${manifest.workingFormat}"（datasetId=${manifest.datasetId}）`,
    )
  }
  for (const stage of manifest.stages) {
    if (stage.workingFormat !== "parquet") {
      throw new Error(
        `DatasetStageRecord.workingFormat 必须是 "parquet"，stageId=${stage.stageId} 收到 "${stage.workingFormat}"`,
      )
    }
  }
  manifest.updatedAt = nowIso()
  const safeManifestPath = resolveManagedDatasetPath({
    datasetId: manifest.datasetId,
    filePath: datasetManifestPath(manifest.datasetId),
  })
  fs.writeFileSync(safeManifestPath, JSON.stringify(manifest, null, 2), "utf-8")
}

export function fingerprintSourceFile(sourcePath: string): SourceFingerprint {
  const realPath = fs.realpathSync.native(sourcePath)
  const stats = fs.statSync(realPath)
  const normalizedRealPath = path.normalize(realPath)
  return {
    realPath: normalizedRealPath,
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    key: `${normalizedRealPath}::${stats.size}::${stats.mtimeMs}`,
  }
}

export function findDatasetForSource(sourcePath: string, sessionID?: string) {
  const fingerprint = fingerprintSourceFile(sourcePath)
  const index = readDatasetIndex()
  const candidates = Object.entries(index.entries)
    .filter(([key, entry]) => key === fingerprint.key || entry.fingerprint.key === fingerprint.key)
    .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
  const match = sessionID
    ? candidates.find(([, entry]) => entry.createdBySessionID === sessionID)
    : candidates[0]
  const entry = match?.[1]
  if (!entry) {
    return { fingerprint }
  }
  // 跨会话隔离：指纹命中的数据集必须属于**当前会话**才允许复用。同一源文件在别的会话
  // 导入过时，这里返回"无 manifest"，让 data_import 新建独立数据集——新窗口不应继承
  // 上一窗口的 stages/artifacts。历史条目没有 createdBySessionID（旧版本写入）也视为
  // 不属于本会话。本会话内重复导入同一文件仍正常复用（entry 带 createdBySessionID）。
  const manifestPath = datasetManifestPath(entry.datasetId)
  if (!fs.existsSync(manifestPath)) {
    delete index.entries[match![0]]
    writeDatasetIndex(index)
    return { fingerprint }
  }
  return {
    fingerprint,
    manifest: readDatasetManifest(entry.datasetId),
  }
}

export function upsertDatasetIndexEntry(input: {
  datasetId: string
  sourcePath: string
  fingerprint: SourceFingerprint
  sessionID?: string
}) {
  const index = readDatasetIndex()
  // 新条目按会话分键，避免 B 覆盖 A 的 fingerprint 索引；旧版无 session 条目仍保留
  // 原始 fingerprint key，findDatasetForSource 会兼容读取但不会在 session scope 复用。
  const storageKey = input.sessionID
    ? `${input.fingerprint.key}::session::${stableHash(input.sessionID)}`
    : input.fingerprint.key
  index.entries[storageKey] = {
    datasetId: input.datasetId,
    sourcePath: input.sourcePath,
    fingerprint: input.fingerprint,
    updatedAt: nowIso(),
    createdBySessionID: input.sessionID,
  }
  writeDatasetIndex(index)
}

/**
 * 工作表选择的稳定标识。同一个 xlsx 的不同 sheet 是不同的数据表，
 * 文件指纹（路径+大小+mtime）对它们完全相同，因此复用判定必须再带上这一维，
 * 否则导入 Sheet2 会静默复用 Sheet1 的 stage 并返回错的数据。
 */
export function sheetSelectionKey(policy?: { mode?: string; sheetName?: string; headerRow?: number }) {
  const mode = policy?.mode ?? "first_sheet"
  const name = policy?.sheetName ?? ""
  const headerRow = policy?.headerRow ?? 0
  return `${mode}::${name}::${headerRow}`
}

export function latestImportStageForFingerprint(
  manifest: DatasetManifest,
  fingerprintKey: string,
  sheetKey?: string,
) {
  return [...manifest.stages]
    .reverse()
    .find(
      (stage) =>
        stage.action === "import" &&
        stage.metadata?.sourceFingerprint === fingerprintKey &&
        // 历史 stage 没有记录 sheet，按“首表”处理以保持向后兼容。
        (sheetKey === undefined ||
          (typeof stage.metadata?.sourceSheet === "string" ? stage.metadata.sourceSheet : sheetSelectionKey()) ===
            sheetKey) &&
        typeof stage.workingPath === "string" &&
        fs.existsSync(stage.workingPath),
    )
}

export function nextStageId(manifest: DatasetManifest) {
  const nextIndex =
    manifest.stages.length === 0 ? 0 : Math.max(...manifest.stages.map((item) => stageIndex(item.stageId))) + 1
  return buildStageId(nextIndex)
}

export function stageOutputPath(input: {
  datasetId: string
  stageId: string
  action: string
  format?: "parquet"
  stamp?: string
}) {
  const ext = input.format ?? "parquet"
  const suffix = input.stamp ? `_${input.stamp}` : ""
  return path.join(
    datasetRoot(input.datasetId),
    "stages",
    `${input.stageId}_${sanitizeSegment(input.action)}${suffix}.${ext}`,
  )
}

export function stageInspectionPaths(input: { datasetId: string; stageId: string; action: string; stamp?: string }) {
  const suffix = input.stamp ? `_${input.stamp}` : ""
  const base = path.join(
    datasetRoot(input.datasetId),
    "inspection",
    `${input.stageId}_${sanitizeSegment(input.action)}${suffix}`,
  )
  return {
    csvPath: `${base}.csv`,
    workbookPath: `${base}.xlsx`,
  }
}

export function stageMetaPaths(input: { datasetId: string; stageId: string; action: string; stamp?: string }) {
  const suffix = `${input.stageId}_${sanitizeSegment(input.action)}${input.stamp ? `_${input.stamp}` : ""}`
  const root = datasetRoot(input.datasetId)
  return {
    schemaPath: path.join(root, "meta", `${suffix}_schema.json`),
    labelsPath: path.join(root, "meta", `${suffix}_labels.json`),
    importReceiptPath: path.join(root, "meta", `${suffix}_import_receipt.json`),
    summaryPath: path.join(root, "audit", `${suffix}_summary.json`),
    logPath: path.join(root, "audit", `${suffix}_log.md`),
  }
}

export function reportOutputPath(input: {
  datasetId: string
  action: string
  stageId?: string
  branch?: string
  format: "json" | "csv" | "xlsx" | "dta" | "parquet"
  stamp?: string
}) {
  const branch = sanitizeSegment(input.branch ?? "main")
  const prefix = [input.stageId, sanitizeSegment(input.action), input.stamp].filter(Boolean).join("_")
  return path.join(datasetRoot(input.datasetId), "reports", branch, `${prefix}.${input.format}`)
}

export function visibleOutputPath(input: {
  sourcePath: string
  runId: string
  branch?: string
  stageId?: string
  label: string
  ext: string
  stamp?: string
}) {
  const branch = sanitizeBranchPath(input.branch ?? "main")
  const label = sanitizeSegment(input.label)
  const stamp = input.stamp ?? fileStamp()
  const prefix = [input.stageId, label, stamp].filter(Boolean).join("_")
  const dir = path.join(runOutputsRoot(input.sourcePath, input.runId), branch, label)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${prefix}.${input.ext}`)
}

export function finalOutputsPath(sourcePath: string, runId: string) {
  return deliveryManifestPath(runId)
}

function userFacingRunIndexPath(sourcePath: string, runId: string) {
  return path.join(runOutputsRoot(sourcePath, runId), "result_index.json")
}

function userFacingRunGuidePath(sourcePath: string, runId: string) {
  return path.join(runOutputsRoot(sourcePath, runId), "00_READ_ME_FIRST.md")
}

function portableRelativePath(root: string, targetPath: string) {
  const relative = path.relative(root, targetPath)
  if (!relative || relative.startsWith("..")) return targetPath
  return relative.replace(/\\/g, "/")
}

function classifyFinalOutputSection(output: FinalOutputRecord) {
  const signature = [
    output.key,
    output.label,
    output.branch,
    output.path,
    output.metadata?.deliveryKind,
    output.metadata?.action,
    output.metadata?.method,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

  if (signature.includes("diagnostics") || signature.includes("metadata") || signature.includes("numeric_snapshot")) {
    return "diagnostics"
  }
  if (signature.includes("table") || signature.includes("coefficients") || signature.endsWith(".docx")) {
    return "tables"
  }
  if (
    signature.includes("import") ||
    signature.includes("filter") ||
    signature.includes("preprocess") ||
    signature.includes("profile") ||
    signature.includes("correlation") ||
    signature.includes("cleaned_workbook") ||
    signature.includes("prep")
  ) {
    return "prep"
  }
  if (
    signature.includes("econometrics") ||
    signature.includes("regression") ||
    signature.includes("results") ||
    signature.includes("summary") ||
    signature.includes("narrative")
  ) {
    return "core_results"
  }
  return "other"
}

function recommendedOutputScore(output: FinalOutputRecord) {
  const signature = [output.key, output.label, output.path].filter(Boolean).join(" ").toLowerCase()
  if (signature.includes("delivery_summary")) return 100
  if (signature.includes("results")) return 90
  if (signature.includes("profile")) return 80
  if (signature.includes("diagnostics")) return 70
  if (signature.includes("table_docx") || signature.includes("table_latex") || signature.includes("coefficients"))
    return 60
  return 10
}

function buildUserFacingRunArtifacts(sourcePath: string, runId: string, outputs: FinalOutputRecord[]) {
  const runRoot = runOutputsRoot(sourcePath, runId)
  const sections = [
    {
      id: "prep",
      title: "01_Data_Preparation",
      description: "导入、筛选、清洗和描述统计产物。",
    },
    {
      id: "core_results",
      title: "02_Core_Results",
      description: "回归输出、摘要和结果说明文件。",
    },
    {
      id: "diagnostics",
      title: "03_Diagnostics_And_Risks",
      description: "数据质量检查、诊断、稳健性检验和数字快照。",
    },
    {
      id: "tables",
      title: "04_Citable_Tables",
      description: "可用于论文或汇报的三线表和系数表。",
    },
    { id: "other", title: "05_Other_Outputs", description: "主交付路径外的补充文件。" },
  ].map((section) => ({
    ...section,
    items: outputs
      .filter((output) => classifyFinalOutputSection(output) === section.id)
      .map((output) => ({
        key: output.key,
        label: output.label,
        path: portableRelativePath(runRoot, output.path),
        absolutePath: output.path,
        branch: output.branch,
        stageId: output.stageId,
      })),
  }))

  const recommended = [...outputs]
    .sort((a, b) => recommendedOutputScore(b) - recommendedOutputScore(a))
    .slice(0, 6)
    .map((output) => ({
      key: output.key,
      label: output.label,
      path: portableRelativePath(runRoot, output.path),
      absolutePath: output.path,
    }))

  return {
    sections,
    recommended,
  }
}

function writeUserFacingRunGuide(sourcePath: string, runId: string, outputs: FinalOutputRecord[]) {
  const runRoot = runOutputsRoot(sourcePath, runId)
  fs.mkdirSync(runRoot, { recursive: true })

  const datasetName = sanitizeUserSegment(path.basename(sourcePath, path.extname(sourcePath)))
  const { sections, recommended } = buildUserFacingRunArtifacts(sourcePath, runId, outputs)
  const generatedAt = nowIso()

  const indexPayload = {
    datasetName,
    runId,
    sourcePath,
    generatedAt,
    recommended,
    sections,
  }

  fs.writeFileSync(userFacingRunIndexPath(sourcePath, runId), JSON.stringify(indexPayload, null, 2), "utf-8")

  const lines = [
    `# Killstata Results Guide`,
    ``,
    `Dataset: ${datasetName}`,
    `Run ID: ${runId}`,
    `Generated At: ${generatedAt}`,
    ``,
    `## Start Here`,
  ]

  if (recommended.length === 0) {
    lines.push(`No delivery files are available yet.`)
  } else {
    for (const [index, item] of recommended.entries()) {
      lines.push(`${index + 1}. ${item.label}: ${item.path}`)
    }
  }

  lines.push(``, `## How To Read This Run`)
  lines.push(`- If you only want the takeaway first, open the summary or results file in Core Results.`)
  lines.push(`- If you want to audit cleaning decisions, open the stage summary or profile files in Data Preparation.`)
  lines.push(`- If you care about reliability, read diagnostics and numeric snapshots in Diagnostics And Risks.`)
  lines.push(`- If you are preparing a paper or deck, start with the citable tables.`)
  lines.push(``, `## File Groups`)

  for (const section of sections) {
    lines.push(`### ${section.title}`)
    lines.push(section.description)
    if (section.items.length === 0) {
      lines.push(`- No files yet`)
      lines.push(``)
      continue
    }
    for (const item of section.items) {
      lines.push(`- ${item.label}: ${item.path}`)
    }
    lines.push(``)
  }

  fs.writeFileSync(userFacingRunGuidePath(sourcePath, runId), lines.join("\n").trim() + "\n", "utf-8")
}

export function resolveFinalOutputsPath(sourcePath: string, runId?: string): string | undefined {
  const normalizedRunId = runId ? normalizeRunId(runId) : undefined
  if (normalizedRunId) {
    const currentPath = finalOutputsPath(sourcePath, normalizedRunId)
    if (fs.existsSync(currentPath)) return currentPath
    for (const legacyPath of legacyDeliveryManifestPaths(normalizedRunId)) {
      if (fs.existsSync(legacyPath)) return legacyPath
    }
  }

  const legacyPath = path.join(legacySourceOutputsRoot(sourcePath), "final_outputs.json")
  if (fs.existsSync(legacyPath)) return legacyPath

  return normalizedRunId ? finalOutputsPath(sourcePath, normalizedRunId) : undefined
}

export function buildFileStamp(input?: Date) {
  return fileStamp(input)
}

export function appendStage(manifest: DatasetManifest, stage: DatasetStageRecord) {
  manifest.stages.push(stage)
  writeDatasetManifest(manifest)
}

export function appendArtifact(manifest: DatasetManifest, artifact: DatasetArtifactRecord) {
  manifest.artifacts.push(artifact)
  writeDatasetManifest(manifest)
}

export function upsertFinalOutput(manifest: DatasetManifest, output: FinalOutputRecord) {
  const normalizedRunId = normalizeRunId(output.runId ?? createRunId())
  const normalized = { ...output, runId: normalizedRunId }
  const idx = manifest.finalOutputs.findIndex((item) => item.key === normalized.key && item.runId === normalizedRunId)
  if (idx >= 0) manifest.finalOutputs.splice(idx, 1, normalized)
  else manifest.finalOutputs.push(normalized)
  writeDatasetManifest(manifest)

  const outputPath = finalOutputsPath(manifest.sourcePath, normalizedRunId)
  const runOutputs = manifest.finalOutputs.filter((item) => item.runId === normalizedRunId)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        version: 1,
        datasetId: manifest.datasetId,
        runId: normalizedRunId,
        sourcePath: manifest.sourcePath,
        bundleName: readDeliveryRunManifest(normalizedRunId)?.bundleName,
        bundleDir: readDeliveryRunManifest(normalizedRunId)?.bundleDir,
        generatedAt: nowIso(),
        outputs: runOutputs,
      },
      null,
      2,
    ),
    "utf-8",
  )
  writeUserFacingRunGuide(manifest.sourcePath, normalizedRunId, runOutputs)
}

export function publishVisibleOutput(input: {
  manifest: DatasetManifest
  key: string
  label: string
  sourcePath: string
  runId?: string
  branch?: string
  stageId?: string
  publishLevel?: "key_only" | "all"
  metadata?: Record<string, unknown>
}) {
  if (!fs.existsSync(input.sourcePath)) {
    throw new Error(`Visible output source not found: ${input.sourcePath}`)
  }
  const runId = normalizeRunId(input.runId ?? createRunId())
  const branch = input.branch ?? "main"
  const ext = path.extname(input.sourcePath).replace(/^\./, "") || "txt"
  const fingerprint = fingerprintSourceFile(input.sourcePath)
  const existing = input.manifest.finalOutputs.find((item) => item.key === input.key && item.runId === runId)
  const outputPath =
    existing &&
    existing.stageId === input.stageId &&
    existing.branch === branch &&
    path.extname(existing.path).replace(/^\./, "") === ext
      ? existing.path
      : visibleOutputPath({
          sourcePath: input.manifest.sourcePath,
          runId,
          branch,
          stageId: input.stageId,
          label: input.label,
          ext,
        })
  const metadata = {
    ...(input.metadata ?? {}),
    sourceFingerprint: fingerprint.key,
  }

  const unchanged =
    existing &&
    existing.path === outputPath &&
    existing.sourcePath === input.sourcePath &&
    existing.stageId === input.stageId &&
    existing.branch === branch &&
    JSON.stringify(existing.metadata ?? {}) === JSON.stringify(metadata) &&
    fs.existsSync(existing.path)

  if (!unchanged) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.copyFileSync(input.sourcePath, outputPath)
  }

  if (unchanged) {
    return outputPath
  }

  upsertFinalOutput(input.manifest, {
    key: input.key,
    label: input.label,
    path: outputPath,
    runId,
    stageId: input.stageId,
    branch,
    sourcePath: input.sourcePath,
    createdAt: nowIso(),
    metadata,
  })
  return outputPath
}

function finalOutputMatches(existing: FinalOutputRecord | undefined, candidate: FinalOutputRecord) {
  return Boolean(
    existing &&
      existing.path === candidate.path &&
      existing.sourcePath === candidate.sourcePath &&
      existing.stageId === candidate.stageId &&
      existing.branch === candidate.branch &&
      JSON.stringify(existing.metadata ?? {}) === JSON.stringify(candidate.metadata ?? {}),
  )
}

function upsertDeliveryRunOutput(input: {
  runId: string
  bundleName: string
  bundleDir: string
  datasetId?: string
  sourcePath?: string
  output: FinalOutputRecord
}) {
  const existing = readDeliveryRunManifest(input.runId)
  const manifest: DeliveryRunManifest = {
    version: 1,
    runId: input.runId,
    bundleName: input.bundleName,
    bundleDir: input.bundleDir,
    datasetId: input.datasetId ?? existing?.datasetId,
    sourcePath: input.sourcePath ?? existing?.sourcePath,
    generatedAt: nowIso(),
    outputs: existing?.outputs ?? [],
  }
  const idx = manifest.outputs.findIndex((item) => item.key === input.output.key && item.runId === input.output.runId)
  if (idx >= 0) manifest.outputs.splice(idx, 1, input.output)
  else manifest.outputs.push(input.output)
  writeDeliveryRunManifest(manifest)

  if (manifest.sourcePath) {
    writeUserFacingRunGuide(manifest.sourcePath, input.runId, manifest.outputs)
  }
}

/**
 * 发布一份「数据集级」的单例产物到用户可见的交付目录：**始终覆盖同名文件**。
 *
 * 与 publishDeliveryOutput 的区别：那个是「每次运行留一份」（key/runId/stageId 任一不同就
 * 新开一个文件，于是有了 xxx_2.md、xxx_3.md），适合回归结果这种一次一份的产物。
 * 但实验日志是整个数据集的**累积轨迹**——它每次都被重建成"截至目前的全部实验"，
 * 只该存在最新的一份。用前者会得到一堆过时快照（实验日志.md 只有 1 次实验、
 * 实验日志_2.md 有 2 次……），用户根本分不清哪个是全的。
 */
export function publishDatasetLevelOutput(input: {
  manifest?: DatasetManifest
  contextSourcePath?: string
  runId?: string
  sourcePath: string
  fileName: string
}) {
  if (!fs.existsSync(input.sourcePath)) return undefined
  const runId = normalizeRunId(input.runId ?? createRunId())
  const contextSourcePath = input.manifest?.sourcePath ?? input.contextSourcePath
  const { bundleDir } = ensureDeliveryBundleAllocation(runId, deliveryBundleParentDir(contextSourcePath))
  fs.mkdirSync(bundleDir, { recursive: true })
  const target = path.join(bundleDir, input.fileName)
  fs.copyFileSync(input.sourcePath, target)
  return target
}

export function publishDeliveryOutput(input: {
  manifest?: DatasetManifest
  key: string
  label: string
  sourcePath: string
  contextSourcePath?: string
  datasetId?: string
  runId?: string
  branch?: string
  stageId?: string
  fileName: string
  metadata?: Record<string, unknown>
}) {
  if (!fs.existsSync(input.sourcePath)) {
    throw new Error(`Delivery output source not found: ${input.sourcePath}`)
  }

  const runId = normalizeRunId(input.runId ?? createRunId())
  const contextSourcePath = input.manifest?.sourcePath ?? input.contextSourcePath
  const { bundleName, bundleDir } = ensureDeliveryBundleAllocation(runId, deliveryBundleParentDir(contextSourcePath))
  fs.mkdirSync(bundleDir, { recursive: true })
  const branch = input.branch ?? "delivery"

  const fingerprint = fingerprintSourceFile(input.sourcePath)
  const existing =
    input.manifest?.finalOutputs.find((item) => item.key === input.key && item.runId === runId) ??
    readDeliveryRunManifest(runId)?.outputs.find((item) => item.key === input.key && item.runId === runId)
  const existingPath =
    existing &&
    existing.stageId === input.stageId &&
    existing.branch === branch &&
    path.dirname(existing.path) === bundleDir
      ? existing.path
      : undefined
  const outputPath = existingPath ?? ensureUniqueFilePath(bundleDir, input.fileName)
  const metadata = {
    ...(input.metadata ?? {}),
    sourceFingerprint: fingerprint.key,
    deliveryBundleDir: bundleDir,
  }
  const nextRecord: FinalOutputRecord = {
    key: input.key,
    label: input.label,
    path: outputPath,
    runId,
    stageId: input.stageId,
    branch,
    sourcePath: input.sourcePath,
    createdAt: nowIso(),
    metadata,
  }

  const unchanged = finalOutputMatches(existing, nextRecord) && fs.existsSync(nextRecord.path)

  if (!unchanged) {
    fs.copyFileSync(input.sourcePath, outputPath)
  }

  if (
    input.manifest &&
    !finalOutputMatches(
      input.manifest.finalOutputs.find((item) => item.key === input.key && item.runId === runId),
      nextRecord,
    )
  ) {
    upsertFinalOutput(input.manifest, nextRecord)
  }

  upsertDeliveryRunOutput({
    runId,
    bundleName,
    bundleDir,
    datasetId: input.manifest?.datasetId ?? input.datasetId,
    sourcePath: contextSourcePath,
    output: nextRecord,
  })

  return outputPath
}

export function resolveArtifactInput(input: { datasetId?: string; stageId?: string; inputPath?: string }): {
  manifest?: DatasetManifest
  stage?: DatasetStageRecord
  resolvedInputPath?: string
} {
  if (input.datasetId) {
    const manifest = readDatasetManifest(input.datasetId)
    const stage = getStage(manifest, input.stageId)
    return {
      manifest,
      stage,
      resolvedInputPath: stage.workingPath,
    }
  }
  return {
    resolvedInputPath: input.inputPath,
  }
}
