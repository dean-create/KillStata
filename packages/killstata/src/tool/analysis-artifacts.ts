import fs from "fs"
import path from "path"
import type { NumericSnapshotDocument } from "./analysis-grounding"
import {
  findDatasetForSource,
  type DatasetManifest,
  readDatasetManifest,
} from "./analysis-state"
import { Instance } from "../project/instance"

export type FinalOutputsDocument = {
  datasetId?: string
  runId?: string
  sourcePath?: string
  generatedAt?: string
  outputs?: Array<{
    key: string
    label: string
    path: string
    runId?: string
    stageId?: string
    branch: string
    sourcePath: string
    createdAt: string
    metadata?: Record<string, unknown>
  }>
}

export type ResultBundle = {
  manifest?: DatasetManifest
  resultDir: string
  resultPath: string
  results: Record<string, any>
  diagnostics?: Record<string, any>
  metadata?: Record<string, any>
  numericSnapshot?: NumericSnapshotDocument
  coefficientTablePath?: string
  narrativePath?: string
  sourcePath?: string
  datasetId?: string
  stageId?: string
  runId?: string
  branch?: string
}

function projectRoot() {
  return Instance.directory
}

export function ensureAbsoluteWithinProject(filePath: string) {
  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.join(projectRoot(), filePath)
}

export function readJsonFile<T>(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
}

export function readJsonIfExists<T>(filePath?: string) {
  if (!filePath || !fs.existsSync(filePath)) return undefined
  return readJsonFile<T>(filePath)
}

export function generatedArtifactRoot(input: { module: string; runId?: string; branch?: string }) {
  const pieces = [projectRoot(), "analysis", input.module, input.runId ?? "adhoc"]
  if (input.branch) pieces.push(input.branch)
  const dir = path.join(...pieces)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function maybeDatasetManifestFromSourcePath(sourcePath?: string) {
  if (!sourcePath) return undefined
  if (!fs.existsSync(sourcePath)) return undefined
  return findDatasetForSource(sourcePath).manifest
}

export function resolveFinalOutputRecord(input: {
  datasetId: string
  outputKey: string
  runId?: string
}) {
  const manifest = readDatasetManifest(input.datasetId)
  const candidates = [...manifest.finalOutputs]
    .filter((item) => item.key === input.outputKey || item.label === input.outputKey)
    .filter((item) => !input.runId || item.runId === input.runId)
    .reverse()
  const record = candidates[0]
  if (!record) {
    throw new Error(`Final output not found: datasetId=${input.datasetId}, outputKey=${input.outputKey}`)
  }
  if (!fs.existsSync(record.path)) {
    throw new Error(`Published output path does not exist: ${record.path}`)
  }
  return { manifest, record }
}

export function loadFinalOutputsDocument(filePath: string) {
  const doc = readJsonFile<FinalOutputsDocument>(filePath)
  return {
    ...doc,
    outputs: doc.outputs ?? [],
  }
}

export function resolvePublishedJsonPath(input: {
  datasetId?: string
  outputKey?: string
  directPath?: string
  runId?: string
}) {
  if (input.directPath) {
    const filePath = ensureAbsoluteWithinProject(input.directPath)
    if (!fs.existsSync(filePath)) {
      throw new Error(`Published JSON path not found: ${filePath}`)
    }
    return {
      path: filePath,
      manifest: maybeDatasetManifestFromSourcePath(undefined),
      record: undefined,
    }
  }

  if (!input.datasetId || !input.outputKey) {
    throw new Error("Resolving a published output by key requires datasetId and outputKey")
  }

  const { manifest, record } = resolveFinalOutputRecord({
    datasetId: input.datasetId,
    outputKey: input.outputKey,
    runId: input.runId,
  })
  return { path: record.path, manifest, record }
}

function resolveResultPathFromDirectory(resultDir: string) {
  const resultPath = path.join(resultDir, "results.json")
  if (!fs.existsSync(resultPath)) {
    throw new Error(`results.json not found in ${resultDir}`)
  }
  return resultPath
}

function resultDirectoryFromPayload(result: Record<string, any>, fallbackFilePath: string) {
  if (typeof result.output_path === "string" && result.output_path.trim()) {
    return path.dirname(result.output_path)
  }
  if (typeof result.result_dir === "string" && result.result_dir.trim()) {
    return result.result_dir
  }
  return path.dirname(fallbackFilePath)
}

export function loadResultBundle(input: {
  datasetId?: string
  resultDir?: string
  outputKey?: string
  directResultPath?: string
  runId?: string
}) {
  let resultPath: string
  let manifest: DatasetManifest | undefined

  if (input.resultDir) {
    const resultDir = ensureAbsoluteWithinProject(input.resultDir)
    resultPath = resolveResultPathFromDirectory(resultDir)
  } else if (input.directResultPath) {
    resultPath = ensureAbsoluteWithinProject(input.directResultPath)
    if (!fs.existsSync(resultPath)) {
      throw new Error(`Result JSON path not found: ${resultPath}`)
    }
  } else if (input.datasetId && input.outputKey) {
    const resolved = resolvePublishedJsonPath({
      datasetId: input.datasetId,
      outputKey: input.outputKey,
      runId: input.runId,
    })
    manifest = resolved.manifest
    resultPath = resolved.path
  } else {
    throw new Error("Result bundle requires resultDir, directResultPath, or datasetId + outputKey")
  }

  const results = readJsonFile<Record<string, any>>(resultPath)
  const resultDir = resultDirectoryFromPayload(results, resultPath)
  const diagnosticsPath =
    typeof results.diagnostics_path === "string" ? results.diagnostics_path : path.join(resultDir, "diagnostics.json")
  const metadataPath =
    typeof results.metadata_path === "string" ? results.metadata_path : path.join(resultDir, "model_metadata.json")
  const numericSnapshotPath =
    typeof results.numeric_snapshot_path === "string" ? results.numeric_snapshot_path : path.join(resultDir, "numeric_snapshot.json")
  const coefficientTablePath =
    typeof results.coefficients_path === "string" ? results.coefficients_path : path.join(resultDir, "coefficient_table.csv")
  const narrativePath =
    typeof results.narrative_path === "string" ? results.narrative_path : path.join(resultDir, "narrative.md")

  const discoveredManifest =
    manifest ??
    maybeDatasetManifestFromSourcePath(typeof results.source_path === "string" ? results.source_path : undefined)

  return {
    manifest: discoveredManifest,
    resultDir,
    resultPath,
    results,
    diagnostics: readJsonIfExists<Record<string, any>>(diagnosticsPath),
    metadata: readJsonIfExists<Record<string, any>>(metadataPath),
    numericSnapshot: readJsonIfExists<NumericSnapshotDocument>(numericSnapshotPath),
    coefficientTablePath: fs.existsSync(coefficientTablePath) ? coefficientTablePath : undefined,
    narrativePath: fs.existsSync(narrativePath) ? narrativePath : undefined,
    sourcePath:
      discoveredManifest?.sourcePath ??
      (typeof results.source_path === "string" ? results.source_path : undefined),
    datasetId:
      discoveredManifest?.datasetId ??
      (typeof results.dataset_id === "string" ? results.dataset_id : input.datasetId),
    stageId: typeof results.stage_id === "string" ? results.stage_id : undefined,
    runId: typeof results.run_id === "string" ? results.run_id : input.runId,
    branch: typeof results.branch === "string" ? results.branch : undefined,
  } satisfies ResultBundle
}
