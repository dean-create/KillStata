import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import z from "zod"
import { Tool } from "./tool"
import {
  DataImportTool,
  FilterRuleSchema,
  PreprocessOperationSchema,
  SheetPolicySchema,
} from "./data-import"
import { buildFileStamp, projectHealthRoot, projectTempRoot } from "./analysis-state"
import { relativeWithinProject, resolveToolPath } from "./analysis-path"
import { createToolDisplay } from "./analysis-display"
import { createToolAnalysisView, analysisArtifact, analysisMetric } from "./analysis-user-view"
import { formatRuntimePythonSetupError, getRuntimePythonStatus } from "@/killstata/runtime-config"
import { Instance } from "../project/instance"

const DEFAULT_EXPORT_FORMAT = "xlsx" as const
const SUPPORTED_BATCH_EXTENSIONS = ["xlsx", "xls", "csv", "dta", "parquet"] as const
type SupportedBatchExtension = (typeof SUPPORTED_BATCH_EXTENSIONS)[number]
type ColumnAliases = Record<string, string[]>
const ColumnAliasesSchema: z.ZodType<ColumnAliases> = z.record(z.string(), z.array(z.string()))

const DataBatchParameters = z
  .object({
    inputPaths: z.array(z.string()).min(1).optional(),
    inputDirectory: z.string().optional(),
    recursive: z.boolean().default(false),
    includeExtensions: z.array(z.enum(SUPPORTED_BATCH_EXTENSIONS)).optional(),
    runId: z.string().optional(),
    branch: z.string().optional(),
    filters: z.array(FilterRuleSchema).optional(),
    operations: z.array(PreprocessOperationSchema).optional(),
    columnAliases: ColumnAliasesSchema.optional(),
    sheetPolicy: SheetPolicySchema.optional(),
    continueOnError: z.boolean().default(true),
    exportFormat: z.enum(["xlsx", "csv", "dta", "parquet"]).optional(),
    entityVar: z.string().optional(),
    timeVar: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.inputPaths?.length ?? 0) === 0 && !value.inputDirectory?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "data_batch requires inputPaths or inputDirectory",
        path: ["inputPaths"],
      })
    }
  })

type DataBatchParams = z.infer<typeof DataBatchParameters>

type DataImportInvocationResult = {
  output: string
  metadata: {
    result?: {
      success?: boolean
      action?: string
      input_path?: string
      output_path?: string
      workbook_path?: string
      dataset_id?: string
      stage_id?: string
      rows_before?: number
      rows_after?: number
      qa_status?: string
      status?: string
      warnings?: string[]
      blocking_errors?: string[]
      column_info?: Record<string, unknown>
    }
    qaGateStatus?: string
    qaGateReason?: string
  }
}

type ExcelLayoutDetection = {
  sheetName: string
  headerRow: number
  matchedColumns: string[]
}

export type DataBatchFileResult = {
  inputPath: string
  datasetId?: string
  stageId?: string
  status: "success" | "failed"
  rows_before?: number
  rows_after?: number
  deleted_rows?: number
  qa_status?: string
  warnings: string[]
  blocking_errors: string[]
  error?: string
  export_path?: string
  available_columns?: string[]
  alias_matches?: Record<string, string>
  detected_layout?: {
    sheet_name: string
    header_row: number
  }
  schema_diff?: {
    missing_from_baseline: string[]
    extra_vs_baseline: string[]
  }
}

export type DataBatchSummary = {
  files_total: number
  files_success: number
  files_failed: number
  continue_on_error: boolean
  run_id?: string
  branch: string
  export_format: "xlsx" | "csv" | "dta" | "parquet"
  input_directory?: string
  recursive: boolean
  include_extensions: SupportedBatchExtension[]
  discovered_input_paths: string[]
  batch_summary_path: string
  batch_report_path: string
  per_file_results: DataBatchFileResult[]
}

type BatchExecutionDeps = {
  invokeDataImport: (
    params: Record<string, unknown>,
    ctx: Tool.Context,
  ) => Promise<DataImportInvocationResult>
  detectExcelLayout: (input: {
    inputPath: string
    requestedColumns: string[]
    columnAliases?: ColumnAliases
  }) => Promise<ExcelLayoutDetection | undefined>
}

function sanitizePart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "file"
}

function normalizeMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function extractDataImportResult(step: DataImportInvocationResult) {
  return step.metadata.result ?? {}
}

function availableColumns(result: ReturnType<typeof extractDataImportResult>) {
  return Object.keys(result.column_info ?? {})
}

function caseInsensitiveMatches(target: string, available: string[]) {
  return available.filter((column) => column.toLowerCase() === target.toLowerCase())
}

function resolveColumnName(input: {
  requested: string
  availableColumns: string[]
  columnAliases?: ColumnAliases
}) {
  const direct = caseInsensitiveMatches(input.requested, input.availableColumns)
  if (direct.length === 1) {
    return { column: direct[0]!, via: "direct" as const }
  }

  const aliases = input.columnAliases?.[input.requested] ?? []
  const aliasMatches = aliases.flatMap((alias) => caseInsensitiveMatches(alias, input.availableColumns))
  const uniqueAliasMatches = [...new Set(aliasMatches)]
  if (uniqueAliasMatches.length === 1) {
    return { column: uniqueAliasMatches[0]!, via: "alias" as const }
  }
  if (direct.length > 1 || uniqueAliasMatches.length > 1) {
    throw new Error(`Column mapping for "${input.requested}" is ambiguous in this workbook.`)
  }
  throw new Error(
    `Column "${input.requested}" was not found in this workbook. Available columns: ${input.availableColumns.join(", ") || "none"}. If this is a multi-sheet or dirty-header workbook, specify sheetName/headerRow explicitly.`,
  )
}

function resolveFilterRules(
  filters: NonNullable<DataBatchParams["filters"]>,
  availableCols: string[],
  columnAliases?: ColumnAliases,
) {
  const aliasMatches: Record<string, string> = {}
  const resolved = filters.map((rule) => {
    const match = resolveColumnName({
      requested: rule.column,
      availableColumns: availableCols,
      columnAliases,
    })
    aliasMatches[rule.column] = match.column
    return {
      ...rule,
      column: match.column,
    }
  })
  return { filters: resolved, aliasMatches }
}

function resolveOperationColumns(
  operations: NonNullable<DataBatchParams["operations"]>,
  availableCols: string[],
  columnAliases?: ColumnAliases,
) {
  const aliasMatches: Record<string, string> = {}
  const resolveMany = (columns: string[] | undefined) =>
    columns?.map((column) => {
      const match = resolveColumnName({
        requested: column,
        availableColumns: availableCols,
        columnAliases,
      })
      aliasMatches[column] = match.column
      return match.column
    })

  const resolved = operations.map((operation) => {
    const params = operation.params ? { ...operation.params } : undefined
    if (params && Array.isArray(params.group_by)) {
      params.group_by = resolveMany(params.group_by)
    }
    if (params && typeof params.time_var === "string") {
      const match = resolveColumnName({
        requested: params.time_var,
        availableColumns: availableCols,
        columnAliases,
      })
      aliasMatches[params.time_var] = match.column
      params.time_var = match.column
    }
    if (params && Array.isArray(params.predictors)) {
      params.predictors = resolveMany(params.predictors)
    }
    return {
      ...operation,
      variables: resolveMany(operation.variables),
      ...(params ? { params } : {}),
    }
  })
  return { operations: resolved, aliasMatches }
}

function resolveOptionalColumn(
  value: string | undefined,
  availableCols: string[],
  columnAliases?: ColumnAliases,
  aliasMatches?: Record<string, string>,
) {
  if (!value) return undefined
  const match = resolveColumnName({
    requested: value,
    availableColumns: availableCols,
    columnAliases,
  })
  if (aliasMatches) aliasMatches[value] = match.column
  return match.column
}

function buildSchemaDiff(perFileResults: DataBatchFileResult[]) {
  const baseline = perFileResults.find((item) => item.available_columns?.length)?.available_columns ?? []
  for (const item of perFileResults) {
    const current = item.available_columns ?? []
    item.schema_diff = {
      missing_from_baseline: baseline.filter((column) => !current.includes(column)),
      extra_vs_baseline: current.filter((column) => !baseline.includes(column)),
    }
  }
}

function buildBatchReport(summary: Omit<DataBatchSummary, "batch_report_path" | "batch_summary_path">) {
  const lines = [
    "# Data Batch Report",
    "",
    `- Total files: ${summary.files_total}`,
    `- Successful: ${summary.files_success}`,
    `- Failed: ${summary.files_failed}`,
    `- Continue on error: ${summary.continue_on_error}`,
    `- Export format: ${summary.export_format}`,
    summary.input_directory ? `- Input directory: ${summary.input_directory}` : undefined,
    `- Recursive: ${summary.recursive}`,
    `- Extensions: ${summary.include_extensions.join(", ")}`,
    summary.run_id ? `- Run ID: ${summary.run_id}` : undefined,
    `- Branch: ${summary.branch}`,
    "",
    "## Discovered inputs",
    ...summary.discovered_input_paths.map((item) => `- ${item}`),
    "",
    "## Per-file results",
  ].filter((line): line is string => Boolean(line))

  for (const item of summary.per_file_results) {
    lines.push(`### ${item.inputPath}`)
    lines.push(`- Status: ${item.status}`)
    if (item.datasetId) lines.push(`- Dataset ID: ${item.datasetId}`)
    if (item.stageId) lines.push(`- Stage ID: ${item.stageId}`)
    if (item.rows_before !== undefined && item.rows_after !== undefined) {
      lines.push(`- Rows: ${item.rows_before} -> ${item.rows_after}`)
    }
    if (item.deleted_rows !== undefined) lines.push(`- Deleted rows: ${item.deleted_rows}`)
    if (item.qa_status) lines.push(`- QA status: ${item.qa_status}`)
    if (item.blocking_errors.length) lines.push(`- Blocking errors: ${item.blocking_errors.join(" | ")}`)
    if (item.export_path) lines.push(`- Export path: ${item.export_path}`)
    if (item.alias_matches && Object.keys(item.alias_matches).length) {
      lines.push(`- Alias matches: ${JSON.stringify(item.alias_matches, null, 0)}`)
    }
    if (item.detected_layout) {
      lines.push(`- Detected layout: sheet=${item.detected_layout.sheet_name}, header_row=${item.detected_layout.header_row}`)
    }
    if (item.schema_diff && (item.schema_diff.missing_from_baseline.length || item.schema_diff.extra_vs_baseline.length)) {
      lines.push(
        `- Schema diff: missing_from_baseline=[${item.schema_diff.missing_from_baseline.join(", ")}], extra_vs_baseline=[${item.schema_diff.extra_vs_baseline.join(", ")}]`,
      )
    }
    if (item.warnings.length) lines.push(`- Warnings: ${item.warnings.join(" | ")}`)
    if (item.error) lines.push(`- Error: ${item.error}`)
    lines.push("")
  }

  return lines.join("\n").trimEnd() + "\n"
}

function parseQaBlockingErrors(error: unknown) {
  const message = normalizeMessage(error)
  const marker = "Data operation blocked by QA gate:"
  if (message.includes(marker)) {
    return message
      .split(marker)
      .slice(1)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function dedupeStrings(values: string[]) {
  return [...new Set(values)]
}

function matchesExtension(filePath: string, includeExtensions: SupportedBatchExtension[]) {
  const extension = path.extname(filePath).replace(/^\./, "").toLowerCase()
  return includeExtensions.includes(extension as SupportedBatchExtension)
}

function collectDirectoryInputs(input: {
  directoryPath: string
  recursive: boolean
  includeExtensions: SupportedBatchExtension[]
}) {
  if (!fs.existsSync(input.directoryPath)) {
    throw new Error(`Input directory not found: ${input.directoryPath}`)
  }
  if (!fs.statSync(input.directoryPath).isDirectory()) {
    throw new Error(`Input directory is not a directory: ${input.directoryPath}`)
  }

  const discovered: string[] = []
  const scan = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (input.recursive) scan(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      if (matchesExtension(fullPath, input.includeExtensions)) discovered.push(fullPath)
    }
  }

  scan(input.directoryPath)
  return discovered.sort((left, right) => left.localeCompare(right))
}

function resolveBatchInputPaths(params: DataBatchParams) {
  const includeExtensions = params.includeExtensions ?? [...SUPPORTED_BATCH_EXTENSIONS]
  const explicitPaths = params.inputPaths ?? []
  const discoveredPaths = params.inputDirectory
    ? collectDirectoryInputs({
        directoryPath: params.inputDirectory,
        recursive: params.recursive ?? false,
        includeExtensions,
      })
    : []
  const inputPaths = dedupeStrings([...explicitPaths, ...discoveredPaths])
  if (inputPaths.length === 0) {
    const sourceLabel = params.inputDirectory
      ? `No supported input files were found in directory: ${params.inputDirectory}`
      : "data_batch requires at least one input file"
    throw new Error(sourceLabel)
  }
  return {
    inputPaths,
    includeExtensions,
  }
}

function isExcelWorkbook(inputPath: string) {
  const extension = path.extname(inputPath).toLowerCase()
  return extension === ".xlsx" || extension === ".xls"
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
}

function collectRequestedColumns(params: DataBatchParams) {
  return uniqueStrings([
    ...(params.filters?.map((rule) => rule.column) ?? []),
    ...(params.operations?.flatMap((operation) => [
      ...(operation.variables ?? []),
      ...(Array.isArray(operation.params?.group_by) ? operation.params.group_by : []),
      typeof operation.params?.time_var === "string" ? operation.params.time_var : undefined,
      ...(Array.isArray(operation.params?.predictors) ? operation.params.predictors : []),
    ]) ?? []),
    params.entityVar,
    params.timeVar,
  ])
}

function shouldAttemptLayoutDetection(input: {
  error: unknown
  inputPath: string
  params: DataBatchParams
  detectedLayout?: ExcelLayoutDetection
}) {
  if (input.detectedLayout) return false
  if (input.params.sheetPolicy) return false
  if (!isExcelWorkbook(input.inputPath)) return false
  if (collectRequestedColumns(input.params).length === 0) return false
  const message = normalizeMessage(input.error)
  return message.includes('Column "') && message.includes("specify sheetName/headerRow explicitly")
}

type InlinePythonExecution = {
  code: number | null
  stdout: string
  stderr: string
  scriptPath: string
  cleanup: () => void
}

async function runInlinePython(input: { command: string; script: string; cwd: string }) {
  const tempDir = projectTempRoot()
  fs.mkdirSync(tempDir, { recursive: true })
  const tempScriptPath = path.join(tempDir, `data_batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`)
  fs.writeFileSync(tempScriptPath, input.script, "utf-8")

  return new Promise<InlinePythonExecution>((resolve, reject) => {
    const proc = spawn(input.command, [tempScriptPath], {
      cwd: input.cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    })

    let stdout = ""
    let stderr = ""
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    proc.on("error", (error) => reject(error))
    proc.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
        scriptPath: tempScriptPath,
        cleanup: () => {
          fs.rmSync(tempScriptPath, { force: true })
        },
      })
    })
  })
}

async function detectExcelLayout(input: {
  inputPath: string
  requestedColumns: string[]
  columnAliases?: ColumnAliases
}) {
  const pythonStatus = await getRuntimePythonStatus()
  if (!pythonStatus.ok || pythonStatus.missing.length) {
    throw new Error(formatRuntimePythonSetupError("data_batch", pythonStatus))
  }

  const payload = Buffer.from(
    JSON.stringify({
      input_path: input.inputPath,
      requested_columns: input.requestedColumns,
      column_aliases: input.columnAliases ?? {},
      max_header_scan_rows: 6,
    }),
    "utf-8",
  ).toString("base64")

  const script = `
import base64
import json
from pathlib import Path
import pandas as pd

payload = json.loads(base64.b64decode("${payload}").decode("utf-8"))
input_path = payload["input_path"]
requested_columns = payload["requested_columns"]
column_aliases = payload.get("column_aliases") or {}
max_header_scan_rows = int(payload.get("max_header_scan_rows") or 6)

requested_with_aliases = []
for column in requested_columns:
    aliases = column_aliases.get(column) or []
    variants = [str(column)] + [str(alias) for alias in aliases]
    requested_with_aliases.append((str(column), [variant.strip().lower() for variant in variants if str(variant).strip()]))

workbook = pd.ExcelFile(input_path)
candidates = []

for sheet_name in workbook.sheet_names:
    for header_row in range(max_header_scan_rows):
        try:
            frame = pd.read_excel(input_path, sheet_name=sheet_name, header=header_row, nrows=0)
        except Exception:
            continue
        columns = [str(column).strip() for column in frame.columns if str(column).strip() and not str(column).startswith("Unnamed:")]
        lowered = {column.lower(): column for column in columns}
        matched = []
        for canonical, variants in requested_with_aliases:
            if any(variant in lowered for variant in variants):
                matched.append(canonical)
        candidates.append({
            "sheetName": str(sheet_name),
            "headerRow": int(header_row),
            "matchedColumns": matched,
            "score": len(matched),
        })

required = len(requested_columns)
perfect = [candidate for candidate in candidates if candidate["score"] == required and required > 0]
if len(perfect) == 1:
    print(json.dumps(perfect[0], ensure_ascii=False))
elif len(perfect) == 0:
    print("")
else:
    print(json.dumps({"ambiguous": True, "candidates": perfect[:5]}, ensure_ascii=False))
`

  const execution = await runInlinePython({
    command: pythonStatus.executable,
    script,
    cwd: Instance.directory,
  })
  const stdout = execution.stdout.trim()
  const stderr = execution.stderr.trim()
  execution.cleanup()
  if (execution.code !== 0) {
    throw new Error(`Failed to inspect Excel layout: ${stderr || stdout}`)
  }
  if (!stdout) return undefined
  const parsed = JSON.parse(stdout) as { ambiguous?: boolean; candidates?: unknown[] } & Partial<ExcelLayoutDetection>
  if (parsed.ambiguous) {
    throw new Error("Excel layout detection found multiple plausible sheet/header combinations; specify sheetName/headerRow explicitly.")
  }
  if (typeof parsed.sheetName !== "string" || typeof parsed.headerRow !== "number" || !Array.isArray(parsed.matchedColumns)) {
    return undefined
  }
  return {
    sheetName: parsed.sheetName,
    headerRow: parsed.headerRow,
    matchedColumns: parsed.matchedColumns.map((item) => String(item)),
  }
}

export async function runDataBatchWorkflow(
  params: DataBatchParams,
  ctx: Tool.Context,
  deps: BatchExecutionDeps,
) {
  const stamp = buildFileStamp()
  const branch = params.branch ?? "batch"
  const exportFormat = params.exportFormat ?? DEFAULT_EXPORT_FORMAT
  const recursive = params.recursive ?? false
  const resolvedInputs = resolveBatchInputPaths(params)
  const outputRoot = path.join(projectHealthRoot(), `data_batch_${stamp}`)
  const exportRoot = path.join(outputRoot, "exports")
  fs.mkdirSync(exportRoot, { recursive: true })

  const perFileResults: DataBatchFileResult[] = []

  for (const inputPath of resolvedInputs.inputPaths) {
    const fileResult: DataBatchFileResult = {
      inputPath,
      status: "failed",
      warnings: [],
      blocking_errors: [],
    }

    try {
      let activeSheetPolicy = params.sheetPolicy
      let detectedLayout: ExcelLayoutDetection | undefined

      while (true) {
        try {
          const importStep = await deps.invokeDataImport(
            {
              action: "import",
              inputPath,
              runId: params.runId,
              branch,
              preserveLabels: true,
              createInspectionArtifacts: true,
              sheetPolicy: activeSheetPolicy,
            },
            ctx,
          )
          const importResult = extractDataImportResult(importStep)
          const cols = availableColumns(importResult)
          fileResult.available_columns = cols
          fileResult.datasetId = importResult.dataset_id
          fileResult.stageId = importResult.stage_id
          fileResult.rows_before = importResult.rows_before
          fileResult.rows_after = importResult.rows_after
          fileResult.warnings.push(...(importResult.warnings ?? []))

          const aliasMatches: Record<string, string> = {}
          let currentDatasetId = importResult.dataset_id
          let currentStageId = importResult.stage_id
          let currentRowsBefore = importResult.rows_before
          let currentRowsAfter = importResult.rows_after

          if (params.filters?.length) {
            const resolvedFilters = resolveFilterRules(params.filters, cols, params.columnAliases)
            Object.assign(aliasMatches, resolvedFilters.aliasMatches)
            const filterStep = await deps.invokeDataImport(
              {
                action: "filter",
                datasetId: currentDatasetId,
                stageId: currentStageId,
                runId: params.runId,
                branch,
                preserveLabels: true,
                createInspectionArtifacts: true,
                filters: resolvedFilters.filters,
              },
              ctx,
            )
            const filterResult = extractDataImportResult(filterStep)
            currentDatasetId = filterResult.dataset_id ?? currentDatasetId
            currentStageId = filterResult.stage_id ?? currentStageId
            currentRowsBefore = filterResult.rows_before ?? currentRowsBefore
            currentRowsAfter = filterResult.rows_after ?? currentRowsAfter
            fileResult.deleted_rows =
              filterResult.rows_before !== undefined && filterResult.rows_after !== undefined
                ? filterResult.rows_before - filterResult.rows_after
                : undefined
            fileResult.warnings.push(...(filterResult.warnings ?? []))
          }

          if (params.operations?.length) {
            const resolvedOperations = resolveOperationColumns(params.operations, cols, params.columnAliases)
            Object.assign(aliasMatches, resolvedOperations.aliasMatches)
            const resolvedEntityVar = resolveOptionalColumn(params.entityVar, cols, params.columnAliases, aliasMatches)
            const resolvedTimeVar = resolveOptionalColumn(params.timeVar, cols, params.columnAliases, aliasMatches)
            const preprocessStep = await deps.invokeDataImport(
              {
                action: "preprocess",
                datasetId: currentDatasetId,
                stageId: currentStageId,
                runId: params.runId,
                branch,
                preserveLabels: true,
                createInspectionArtifacts: true,
                operations: resolvedOperations.operations,
                entityVar: resolvedEntityVar,
                timeVar: resolvedTimeVar,
              },
              ctx,
            )
            const preprocessResult = extractDataImportResult(preprocessStep)
            currentDatasetId = preprocessResult.dataset_id ?? currentDatasetId
            currentStageId = preprocessResult.stage_id ?? currentStageId
            currentRowsBefore = preprocessResult.rows_before ?? currentRowsBefore
            currentRowsAfter = preprocessResult.rows_after ?? currentRowsAfter
            fileResult.warnings.push(...(preprocessResult.warnings ?? []))
          }

          const resolvedEntityVar = resolveOptionalColumn(params.entityVar, cols, params.columnAliases, aliasMatches)
          const resolvedTimeVar = resolveOptionalColumn(params.timeVar, cols, params.columnAliases, aliasMatches)

          let qaStatus: string | undefined
          try {
            const qaStep = await deps.invokeDataImport(
              {
                action: "qa",
                datasetId: currentDatasetId,
                stageId: currentStageId,
                runId: params.runId,
                branch,
                preserveLabels: true,
                entityVar: resolvedEntityVar,
                timeVar: resolvedTimeVar,
              },
              ctx,
            )
            const qaResult = extractDataImportResult(qaStep)
            qaStatus = qaResult.status ?? qaResult.qa_status
            fileResult.warnings.push(...(qaResult.warnings ?? []))
            fileResult.blocking_errors.push(...(qaResult.blocking_errors ?? []))
          } catch (error) {
            const blockingErrors = parseQaBlockingErrors(error)
            if (blockingErrors.length) {
              qaStatus = "block"
              fileResult.qa_status = qaStatus
              fileResult.blocking_errors.push(...blockingErrors)
            }
            throw error
          }

          const baseName = sanitizePart(path.basename(inputPath, path.extname(inputPath)))
          const exportExt = exportFormat === "parquet" ? "parquet" : exportFormat
          const exportPath = path.join(exportRoot, `${baseName}_${stamp}.${exportExt}`)
          const exportStep = await deps.invokeDataImport(
            {
              action: "export",
              datasetId: currentDatasetId,
              stageId: currentStageId,
              runId: params.runId,
              branch,
              preserveLabels: true,
              format: exportFormat,
              outputPath: exportPath,
            },
            ctx,
          )
          const exportResult = extractDataImportResult(exportStep)

          fileResult.datasetId = currentDatasetId
          fileResult.stageId = currentStageId
          fileResult.rows_before = currentRowsBefore
          fileResult.rows_after = currentRowsAfter
          fileResult.qa_status = qaStatus ?? exportResult.qa_status
          fileResult.alias_matches = aliasMatches
          fileResult.export_path = exportResult.output_path ?? exportPath
          if (detectedLayout) {
            fileResult.detected_layout = {
              sheet_name: detectedLayout.sheetName,
              header_row: detectedLayout.headerRow,
            }
          }
          fileResult.warnings = [...new Set(fileResult.warnings)]
          fileResult.status = "success"
          break
        } catch (error) {
          if (
            shouldAttemptLayoutDetection({
              error,
              inputPath,
              params,
              detectedLayout,
            })
          ) {
            detectedLayout = await deps.detectExcelLayout({
              inputPath,
              requestedColumns: collectRequestedColumns(params),
              columnAliases: params.columnAliases,
            })
            if (detectedLayout) {
              activeSheetPolicy = {
                mode: "named_sheet",
                sheetName: detectedLayout.sheetName,
                headerRow: detectedLayout.headerRow,
              }
              fileResult.warnings.push(
                `Auto-detected workbook layout: sheet "${detectedLayout.sheetName}", header row ${detectedLayout.headerRow}.`,
              )
              continue
            }
          }
          throw error
        }
      }
    } catch (error) {
      fileResult.status = "failed"
      fileResult.warnings = [...new Set(fileResult.warnings)]
      fileResult.blocking_errors = [...new Set(fileResult.blocking_errors)]
      fileResult.error = normalizeMessage(error)
    }

    perFileResults.push(fileResult)
    if (fileResult.status === "failed" && params.continueOnError === false) break
  }

  buildSchemaDiff(perFileResults)

  const summaryWithoutPaths = {
    files_total: resolvedInputs.inputPaths.length,
    files_success: perFileResults.filter((item) => item.status === "success").length,
    files_failed: perFileResults.filter((item) => item.status === "failed").length,
    continue_on_error: params.continueOnError,
    run_id: params.runId,
    branch,
    export_format: exportFormat,
    input_directory: params.inputDirectory,
    recursive,
    include_extensions: resolvedInputs.includeExtensions,
    discovered_input_paths: resolvedInputs.inputPaths,
    per_file_results: perFileResults,
  }

  const batchSummaryPath = path.join(outputRoot, "batch_summary.json")
  const batchReportPath = path.join(outputRoot, "batch_report.md")
  const summary: DataBatchSummary = {
    ...summaryWithoutPaths,
    batch_summary_path: batchSummaryPath,
    batch_report_path: batchReportPath,
  }

  fs.writeFileSync(batchSummaryPath, JSON.stringify(summary, null, 2), "utf-8")
  fs.writeFileSync(batchReportPath, buildBatchReport(summaryWithoutPaths), "utf-8")

  return summary
}

async function invokeDataImport(params: Record<string, unknown>, ctx: Tool.Context) {
  const tool = await DataImportTool.init()
  const result = await tool.execute(params as never, {
    ...ctx,
    metadata: () => {},
  })
  return result as DataImportInvocationResult
}

export const DataBatchTool = Tool.define("data_batch", {
  description:
    "Run a shared clean/filter/QA/export pipeline across multiple files or a directory of Excel/CSV/Stata datasets, then write a batch summary plus report.",
  parameters: DataBatchParameters,
  async execute(params, ctx) {
    const resolvedDirectory = params.inputDirectory
      ? await resolveToolPath({
          filePath: params.inputDirectory,
          mode: "read",
          toolName: "data_batch",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
      : undefined
    const summary = await runDataBatchWorkflow({ ...params, inputDirectory: resolvedDirectory }, ctx, {
      invokeDataImport,
      detectExcelLayout,
    })

    const output = [
      "## Data batch completed",
      "",
      `Files total: ${summary.files_total}`,
      `Successful: ${summary.files_success}`,
      `Failed: ${summary.files_failed}`,
      `Export format: ${summary.export_format}`,
      summary.input_directory ? `Input directory: ${summary.input_directory}` : undefined,
      `Recursive: ${summary.recursive}`,
      `Batch summary: ${relativeWithinProject(summary.batch_summary_path)}`,
      `Batch report: ${relativeWithinProject(summary.batch_report_path)}`,
    ].join("\n")

    return {
      title: "Data batch",
      output,
      metadata: {
        ...summary,
        batchSummaryPath: relativeWithinProject(summary.batch_summary_path),
        batchReportPath: relativeWithinProject(summary.batch_report_path),
        display: createToolDisplay({
          summary: `data_batch completed: ${summary.files_success}/${summary.files_total} files succeeded`,
          details: [
            `Files total: ${summary.files_total}`,
            `Successful: ${summary.files_success}`,
            `Failed: ${summary.files_failed}`,
            `Export format: ${summary.export_format}`,
            summary.input_directory ? `Input directory: ${summary.input_directory}` : undefined,
            `Recursive: ${summary.recursive}`,
          ],
          artifacts: [
            {
              label: "batch_summary",
              path: relativeWithinProject(summary.batch_summary_path),
              visibility: "user_default" as const,
            },
            {
              label: "batch_report",
              path: relativeWithinProject(summary.batch_report_path),
              visibility: "user_default" as const,
            },
          ],
        }),
        analysisView: createToolAnalysisView({
          kind: "data_import",
          step: "data_batch",
          results: [
            analysisMetric("Files total", summary.files_total),
            analysisMetric("Successful", summary.files_success),
            analysisMetric("Failed", summary.files_failed),
          ],
          artifacts: [
            analysisArtifact(relativeWithinProject(summary.batch_summary_path), { visibility: "user_default" }),
            analysisArtifact(relativeWithinProject(summary.batch_report_path), { visibility: "user_default" }),
          ],
          warnings: summary.per_file_results.filter((item) => item.status === "failed").map((item) => item.error!).filter(Boolean),
        }),
      },
    }
  },
})
