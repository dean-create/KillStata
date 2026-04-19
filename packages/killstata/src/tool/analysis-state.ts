import fs from "fs"
import path from "path"
import crypto from "crypto"
import { Instance } from "../project/instance"

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
}

export type SourceFingerprint = {
  realPath: string
  sizeBytes: number
  mtimeMs: number
  key: string
}

type DatasetIndexEntry = {
  datasetId: string
  sourcePath: string
  fingerprint: SourceFingerprint
  updatedAt: string
}

type DatasetIndex = {
  version: 1
  entries: Record<string, DatasetIndexEntry>
}

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

function inferSourceFormat(filePath: string): DatasetManifest["sourceFormat"] {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".csv") return "csv"
  if (ext === ".xlsx") return "xlsx"
  if (ext === ".xls") return "xls"
  if (ext === ".dta") return "dta"
  if (ext === ".parquet") return "parquet"
  return "unknown"
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
  ].join("")
}

function projectRoot() {
  return Instance.project.vcs ? Instance.worktree : Instance.directory
}

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "item"
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

export function createDatasetId(inputPath: string, fingerprintKey?: string) {
  const basename = sanitizeSegment(path.basename(inputPath, path.extname(inputPath)))
  const suffix = stableHash(fingerprintKey ?? inputPath)
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
}) {
  if (input.requestedRunId) return normalizeRunId(input.requestedRunId)
  const fromStage = typeof input.stage?.runId === "string" ? input.stage.runId : undefined
  const fromMetadata = typeof input.stage?.metadata?.runId === "string" ? input.stage.metadata.runId : undefined
  return normalizeRunId(fromStage ?? fromMetadata ?? createRunId())
}

export function buildStageId(index: number) {
  return `stage_${index.toString().padStart(3, "0")}`
}

export function stageIndex(stageId: string) {
  const match = /stage_(\d+)/.exec(stageId)
  return match ? Number.parseInt(match[1], 10) : 0
}

export function datasetsRoot() {
  return path.join(projectInternalRoot(), "datasets")
}

export function datasetIndexPath() {
  return path.join(datasetsRoot(), "index.json")
}

export function projectInternalRoot() {
  return path.join(projectRoot(), ".killstata")
}

export function projectStateRoot() {
  return path.join(projectInternalRoot(), "runtime")
}

export function projectPlansRoot() {
  return path.join(projectInternalRoot(), "plans")
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

export function deliveryStateRoot() {
  return path.join(projectStateRoot(), "delivery")
}

function runIdDeliveryStamp(runId: string) {
  const normalized = normalizeRunId(runId)
  const match = /^run_(\d{8})-(\d{6})/.exec(normalized)
  if (match) {
    return `${match[1]}_${match[2].slice(0, 4)}`
  }
  const now = new Date()
  return [
    now.getFullYear().toString(),
    (now.getMonth() + 1).toString().padStart(2, "0"),
    now.getDate().toString().padStart(2, "0"),
  ].join("") + "_" + [
    now.getHours().toString().padStart(2, "0"),
    now.getMinutes().toString().padStart(2, "0"),
  ].join("")
}

const DELIVERY_BUNDLE_PREFIX = "killstata_output_"
const LEGACY_DELIVERY_BUNDLE_PREFIX = "killstata_ouput_"

function baseDeliveryBundleName(runId: string) {
  return `${DELIVERY_BUNDLE_PREFIX}${runIdDeliveryStamp(runId)}`
}

function legacyDeliveryBundleNames(runId: string) {
  const stamp = runIdDeliveryStamp(runId)
  const compactStamp = stamp.replace("_", "")
  return [
    `${DELIVERY_BUNDLE_PREFIX}${compactStamp}`,
    `${LEGACY_DELIVERY_BUNDLE_PREFIX}${compactStamp}`,
  ]
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
  return legacyDeliveryBundleNames(runId).map((name) => path.join(deliveryStateRoot(), "manifests", name, "final_outputs.json"))
}

function readDeliveryRunManifest(runId: string): DeliveryRunManifest | undefined {
  const normalizedRunId = normalizeRunId(runId)
  const primaryPath = deliveryManifestPath(normalizedRunId)
  for (const manifestPath of [primaryPath, ...legacyDeliveryManifestPaths(normalizedRunId)]) {
    if (!fs.existsSync(manifestPath)) continue
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Partial<DeliveryRunManifest> & { outputs?: FinalOutputRecord[] }
    const bundleName =
      parsed.bundleName ?? (manifestPath === primaryPath ? baseDeliveryBundleName(normalizedRunId) : path.basename(path.dirname(manifestPath)))
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

export function projectReflectionRoot() {
  return path.join(projectStateRoot(), "reflection")
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

export function datasetRoot(datasetId: string) {
  return path.join(datasetsRoot(), datasetId)
}

function legacyDatasetsRoot() {
  return path.join(projectInternalRoot(), "state", "datasets")
}

function legacyDatasetRoot(datasetId: string) {
  return path.join(legacyDatasetsRoot(), datasetId)
}

function replaceRoot(value: unknown, fromRoot: string, toRoot: string): unknown {
  if (typeof value === "string") {
    return value.startsWith(fromRoot) ? path.join(toRoot, value.slice(fromRoot.length)) : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceRoot(item, fromRoot, toRoot))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceRoot(item, fromRoot, toRoot)]),
    )
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
  const original = fs.readFileSync(filePath, "utf-8")
  const updated = replacements.reduce((text, replacement) => text.split(replacement.from).join(replacement.to), original)
  if (updated !== original) fs.writeFileSync(filePath, updated, "utf-8")
}

function migrateLegacyDeliveryBundles() {
  const replacements: Array<{ from: string; to: string }> = []
  const roots = [Instance.directory, path.join(deliveryStateRoot(), "manifests")]

  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(LEGACY_DELIVERY_BUNDLE_PREFIX)) continue
      const suffix = entry.name.slice(LEGACY_DELIVERY_BUNDLE_PREFIX.length)
      const legacyName = entry.name
      const currentName = `${DELIVERY_BUNDLE_PREFIX}${suffix}`
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

export function ensureInternalLayout() {
  const root = projectInternalRoot()
  fs.mkdirSync(root, { recursive: true })

  migrateDirectoryIfNeeded(path.join(root, "errors"), projectErrorsRoot())
  migrateDirectoryIfNeeded(path.join(root, "health"), projectHealthRoot())
  migrateDirectoryIfNeeded(path.join(root, "reflection"), projectReflectionRoot())
  migrateDirectoryIfNeeded(path.join(root, "tmp"), projectTempRoot())

  const legacyRoot = path.join(root, "state")
  const legacyDatasets = path.join(legacyRoot, "datasets")
  if (fs.existsSync(legacyDatasets)) {
    fs.mkdirSync(datasetsRoot(), { recursive: true })
    for (const entry of fs.readdirSync(legacyDatasets, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const fromDir = path.join(legacyDatasets, entry.name)
      const toDir = path.join(datasetsRoot(), entry.name)
      if (fs.existsSync(toDir)) continue
      fs.renameSync(fromDir, toDir)
      const manifestPath = path.join(toDir, "manifest.json")
      if (fs.existsSync(manifestPath)) {
        const oldRoot = fromDir
        const newRoot = toDir
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
        const migrated = replaceRoot(manifest, oldRoot, newRoot)
        fs.writeFileSync(manifestPath, JSON.stringify(migrated, null, 2), "utf-8")
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

export function datasetManifestPath(datasetId: string) {
  return path.join(datasetRoot(datasetId), "manifest.json")
}

export function ensureDatasetDirs(datasetId: string) {
  ensureInternalLayout()
  const root = datasetRoot(datasetId)
  for (const dir of [
    root,
    path.join(root, "stages"),
    path.join(root, "inspection"),
    path.join(root, "reports"),
    path.join(root, "meta"),
    path.join(root, "audit"),
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function createDatasetManifest(input: {
  datasetId: string
  sourcePath: string
  sourceFormat?: DatasetManifest["sourceFormat"]
  workingFormat?: "parquet"
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
  }
}

export function readDatasetManifest(datasetId: string) {
  ensureInternalLayout()
  const manifestPath = datasetManifestPath(datasetId)
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Dataset manifest not found for datasetId=${datasetId}`)
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as DatasetManifest
  return {
    ...parsed,
    sourceFormat: parsed.sourceFormat ?? inferSourceFormat(parsed.sourcePath),
    workingFormat: "parquet" as const,
    stages: (parsed.stages ?? []).map((stage) => ({
      ...stage,
      workingFormat: "parquet" as const,
    })),
    artifacts: parsed.artifacts ?? [],
    finalOutputs: parsed.finalOutputs ?? [],
  }
}

export function writeDatasetManifest(manifest: DatasetManifest) {
  ensureDatasetDirs(manifest.datasetId)
  manifest.updatedAt = nowIso()
  fs.writeFileSync(datasetManifestPath(manifest.datasetId), JSON.stringify(manifest, null, 2), "utf-8")
}

export function readDatasetIndex(): DatasetIndex {
  ensureInternalLayout()
  if (!fs.existsSync(datasetIndexPath())) {
    return { version: 1, entries: {} }
  }
  const parsed = JSON.parse(fs.readFileSync(datasetIndexPath(), "utf-8")) as DatasetIndex
  return {
    version: 1,
    entries: parsed.entries ?? {},
  }
}

export function writeDatasetIndex(index: DatasetIndex) {
  fs.mkdirSync(datasetsRoot(), { recursive: true })
  fs.writeFileSync(datasetIndexPath(), JSON.stringify(index, null, 2), "utf-8")
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

export function findDatasetForSource(sourcePath: string) {
  const fingerprint = fingerprintSourceFile(sourcePath)
  const index = readDatasetIndex()
  const entry = index.entries[fingerprint.key]
  if (!entry) {
    return { fingerprint }
  }
  const manifestPath = datasetManifestPath(entry.datasetId)
  if (!fs.existsSync(manifestPath)) {
    delete index.entries[fingerprint.key]
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
}) {
  const index = readDatasetIndex()
  index.entries[input.fingerprint.key] = {
    datasetId: input.datasetId,
    sourcePath: input.sourcePath,
    fingerprint: input.fingerprint,
    updatedAt: nowIso(),
  }
  writeDatasetIndex(index)
}

export function latestImportStageForFingerprint(manifest: DatasetManifest, fingerprintKey: string) {
  return [...manifest.stages]
    .reverse()
    .find(
      (stage) =>
        stage.action === "import" &&
        stage.metadata?.sourceFingerprint === fingerprintKey &&
        typeof stage.workingPath === "string" &&
        fs.existsSync(stage.workingPath),
    )
}

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
  return path.join(datasetRoot(input.datasetId), "stages", `${input.stageId}_${sanitizeSegment(input.action)}${suffix}.${ext}`)
}

export function stageInspectionPaths(input: { datasetId: string; stageId: string; action: string; stamp?: string }) {
  const suffix = input.stamp ? `_${input.stamp}` : ""
  const base = path.join(datasetRoot(input.datasetId), "inspection", `${input.stageId}_${sanitizeSegment(input.action)}${suffix}`)
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
    signature.includes("describe") ||
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
  if (signature.includes("describe")) return 80
  if (signature.includes("diagnostics")) return 70
  if (signature.includes("table_docx") || signature.includes("table_latex") || signature.includes("coefficients")) return 60
  return 10
}

function buildUserFacingRunArtifacts(sourcePath: string, runId: string, outputs: FinalOutputRecord[]) {
  const runRoot = runOutputsRoot(sourcePath, runId)
  const sections = [
    { id: "prep", title: "01_Data_Preparation", description: "Import, filtering, cleaning, and descriptive-statistics artifacts." },
    { id: "core_results", title: "02_Core_Results", description: "Regression outputs, summaries, and narrative result files." },
    { id: "diagnostics", title: "03_Diagnostics_And_Risks", description: "QA, diagnostics, robustness checks, and numeric snapshots." },
    { id: "tables", title: "04_Citable_Tables", description: "Three-line tables and coefficient tables ready for papers or slides." },
    { id: "other", title: "05_Other_Outputs", description: "Supplementary files outside the main delivery path." },
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
  lines.push(`- If you want to audit cleaning decisions, open the inspection or describe files in Data Preparation.`)
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

  const unchanged =
    finalOutputMatches(existing, nextRecord) && fs.existsSync(nextRecord.path)

  if (!unchanged) {
    fs.copyFileSync(input.sourcePath, outputPath)
  }

  if (input.manifest && !finalOutputMatches(input.manifest.finalOutputs.find((item) => item.key === input.key && item.runId === runId), nextRecord)) {
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

export function resolveArtifactInput(input: {
  datasetId?: string
  stageId?: string
  inputPath?: string
}): {
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
