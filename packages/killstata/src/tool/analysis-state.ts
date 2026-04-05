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
  return path.join(projectRoot(), "killstata_outputs", datasetName)
}

function legacySourceOutputsRoot(sourcePath: string) {
  const sourceDir = path.dirname(sourcePath)
  const datasetName = sanitizeUserSegment(path.basename(sourcePath, path.extname(sourcePath)))
  return path.join(sourceDir, "killstata_outputs", datasetName)
}

export function runOutputsRoot(sourcePath: string, runId: string) {
  return path.join(sourceOutputsRoot(sourcePath), normalizeRunId(runId))
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

  for (const dir of [projectStateRoot(), projectPlansRoot(), projectReflectionRoot(), projectTempRoot(), projectErrorsRoot(), projectHealthRoot(), datasetsRoot()]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(datasetIndexPath())) {
    writeDatasetIndex({ version: 1, entries: {} })
  }
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
  return path.join(runOutputsRoot(sourcePath, runId), "final_outputs.json")
}

export function resolveFinalOutputsPath(sourcePath: string, runId?: string): string | undefined {
  const normalizedRunId = runId ? normalizeRunId(runId) : undefined
  if (normalizedRunId) {
    const currentPath = finalOutputsPath(sourcePath, normalizedRunId)
    if (fs.existsSync(currentPath)) return currentPath
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
        datasetId: manifest.datasetId,
        runId: normalizedRunId,
        sourcePath: manifest.sourcePath,
        generatedAt: nowIso(),
        outputs: runOutputs,
      },
      null,
      2,
    ),
    "utf-8",
  )
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
  const ext = path.extname(input.sourcePath).replace(/^\./, "") || "txt"
  const fingerprint = fingerprintSourceFile(input.sourcePath)
  const existing = input.manifest.finalOutputs.find((item) => item.key === input.key && item.runId === runId)
  const outputPath =
    existing && path.extname(existing.path).replace(/^\./, "") === ext
      ? existing.path
      : visibleOutputPath({
          sourcePath: input.manifest.sourcePath,
          runId,
          branch: input.branch,
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
    existing.branch === (input.branch ?? "main") &&
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
    branch: input.branch ?? "main",
    sourcePath: input.sourcePath,
    createdAt: nowIso(),
    metadata,
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
