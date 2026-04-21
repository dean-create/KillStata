import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { spawn, exec } from "child_process"
import DESCRIPTION from "./data-import.txt"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Tool } from "./tool"
import { Question } from "../question"
import {
  appendArtifact,
  appendStage,
  buildFileStamp,
  createDatasetId,
  createDatasetManifest,
  finalOutputsPath,
  findDatasetForSource,
  fingerprintSourceFile,
  inferRunId,
  latestImportStageForFingerprint,
  nextStageId,
  getStage,
  projectErrorsRoot,
  projectHealthRoot,
  projectTempRoot,
  readDatasetManifest,
  reportOutputPath,
  resolveArtifactInput,
  stageInspectionPaths,
  stageMetaPaths,
  stageOutputPath,
  upsertDatasetIndexEntry,
} from "./analysis-state"
import { checkRetryBudget, classifyToolFailure, evaluateQaGate, persistToolReflection } from "./analysis-reflection"
import { AnalysisIntent } from "./analysis-intent"
import {
  createCorrelationNumericSnapshot,
  createDescribeNumericSnapshot,
  type NumericSnapshotDocument,
} from "./analysis-grounding"
import { relativeWithinProject, resolveToolPath } from "./analysis-path"
import {
  artifactGroup,
  createPresentation,
  derivePresentationStatus,
  presentationArtifact,
  presentationMetric,
  type ToolPresentation,
} from "./analysis-presentation"
import { numericSnapshotPreview } from "./analysis-tool-metadata"
import { createToolDisplay } from "./analysis-display"
import {
  analysisArtifact,
  analysisInputFile,
  analysisMetric,
  createToolAnalysisView,
} from "./analysis-user-view"
import { formatRuntimePythonSetupError, getRuntimePythonStatus } from "@/killstata/runtime-config"
import { ensureAnalysisPlan, formatAnalysisChecklist, setAnalysisPlanApproval } from "@/runtime/workflow"
import {
  workflowAnalysisPlanHeader,
  workflowChecklistApprovalPrompt,
  workflowChecklistIntro,
  workflowChecklistOptions,
} from "@/runtime/workflow-locale"

const log = Log.create({ service: "data-import-tool" })

// Python环境路径配置
const ECONOMETRICS_DIR = path.join(__dirname, "../../python/econometrics")
const PYTHON_RESULT_PREFIX = "__KILLSTATA_JSON__"

const DATA_ACTIONS = [
  "import",
  "export",
  "preprocess",
  "filter",
  "describe",
  "correlation",
  "qa",
  "healthcheck",
  "rollback",
] as const

type DataAction = (typeof DATA_ACTIONS)[number]

const ANALYST_PRE_APPROVAL_ACTIONS = new Set<DataAction>(["healthcheck", "describe", "correlation", "qa"])

export const PreprocessOperationSchema = z.object({
  type: z.enum([
    "dropna",
    "drop_missing",
    "fillna",
    "fill_constant",
    "fill_mean",
    "fill_median",
    "forward_fill",
    "backward_fill",
    "linear_interpolate",
    "group_linear_interpolate",
    "regression_impute",
    "log_transform",
    "standardize",
    "winsorize",
    "create_dummies",
  ]),
  variables: z.array(z.string()).optional(),
  params: z.object({}).passthrough().optional(),
})

export const FilterRuleSchema = z.object({
  column: z.string(),
  operator: z.enum(["in", "not_in", "eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  caseSensitive: z.boolean().default(false),
})

export const SheetPolicySchema = z
  .object({
    mode: z.enum(["first_sheet", "named_sheet"]).default("first_sheet"),
    sheetName: z.string().optional(),
    headerRow: z.number().int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "named_sheet" && !value.sheetName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sheetName is required when sheetPolicy.mode is named_sheet",
        path: ["sheetName"],
      })
    }
  })

type PythonResult = {
  success: boolean
  action?: DataAction
  error?: string
  traceback?: string
  error_log_path?: string
  resolved_python_executable?: string
  status?: string
  input_path?: string
  output_path?: string
  summary_path?: string
  log_path?: string
  workbook_path?: string
  numeric_snapshot_path?: string
  inspection_path?: string
  inspection_workbook_path?: string
  dataset_id?: string
  stage_id?: string
  parent_stage_id?: string
  branch?: string
  schema_path?: string
  labels_path?: string
  run_id?: string
  rows_before?: number
  rows_after?: number
  columns_before?: number
  columns_after?: number
  column_info?: Record<string, string[]>
  metadata_saved?: boolean
  operations_count?: number
  filters_count?: number
  variables?: string[]
  warnings?: string[]
  blocking_errors?: string[]
  suggested_repairs?: string[]
  module_status?: Record<string, boolean>
  install_command?: string
  missing_before?: Record<string, number>
  missing_after?: Record<string, number>
  import_errors?: string[]
}

const CJK_MOJIBAKE_MARKERS = [
  "鏁版嵁",
  "鍥炲綊",
  "缁撴灉",
  "褰撳墠",
  "鎻愮ず",
  "绛夊緟",
  "涓嬩竴姝",
  "鍙橀噺",
  "妫€鏌",
  "鍥哄畾",
  "鏍囬",
  "璁烘枃",
  "瀛︽湳",
  "鏁堝簲",
  "闃舵",
  "缁堢",
  "杈撳嚭",
] as const

export function looksLikeMojibake(value?: string) {
  if (!value) return false
  return (
    value.includes("�") ||
    /(?:Ã.|Â.|æ.|ç.|é.|è.)/.test(value) ||
    CJK_MOJIBAKE_MARKERS.some((marker) => value.includes(marker))
  )
}

export function schemaLooksLikeMojibake(schemaPath?: string) {
  if (!schemaPath || !fs.existsSync(schemaPath)) return false
  try {
    const raw = fs.readFileSync(schemaPath, "utf-8")
    const parsed = JSON.parse(raw) as {
      columns?: Array<{ name?: string; label?: string }>
    }
    const columns = Array.isArray(parsed.columns) ? parsed.columns : []
    return columns.some((column) => looksLikeMojibake(column.name) || looksLikeMojibake(column.label))
  } catch {
    return false
  }
}

export function shouldReuseImportStage(input: { sourcePath?: string; schemaPath?: string }) {
  return !looksLikeMojibake(input.sourcePath) && !schemaLooksLikeMojibake(input.schemaPath)
}

function buildDataImportWarnings(input: {
  result: PythonResult
  qaGate: {
    qaGateStatus?: string
    qaGateReason?: string
  }
}) {
  return [
    ...(input.result.warnings ?? []),
    ...(input.result.blocking_errors ?? []),
    input.qaGate.qaGateStatus === "warn" || input.qaGate.qaGateStatus === "block" ? input.qaGate.qaGateReason : undefined,
  ].filter((item): item is string => Boolean(item))
}

function buildDataImportPresentation(input: {
  action: DataAction
  result: PythonResult
  qaGate: {
    qaGateStatus?: string
    qaGateReason?: string
  }
  publishedFiles: Array<{ label: string; relativePath: string }>
  deliveryBundlePath?: string
}): ToolPresentation {
  const { action, result, qaGate, publishedFiles, deliveryBundlePath } = input
  const rowsAfter = result.rows_after
  const columnsAfter = result.columns_after
  const rowsBefore = result.rows_before
  const rowDelta =
    rowsBefore !== undefined && rowsAfter !== undefined ? Math.abs(rowsBefore - rowsAfter) : undefined
  const status = derivePresentationStatus({
    success: result.success,
    qaGateStatus: qaGate.qaGateStatus,
    warnings: result.warnings,
    blockingErrors: result.blocking_errors,
  })

  let title = "数据处理结果"
  let headline = "这一步已经完成。"
  let summary: string[] = []
  let highlights: string[] = []
  let nextActions: string[] = []

  if (action === "import") {
    title = "数据导入"
    headline =
      rowsAfter !== undefined && columnsAfter !== undefined
        ? `已导入 ${rowsAfter} 行、${columnsAfter} 列数据，并转成可继续处理的工作格式。`
        : "原始数据已导入，并转成后续可直接处理的工作格式。"
    summary = [
      "我已经保留了原始数据的结构信息，并生成了可核对的检查表。",
      "接下来可以先做质量检查、描述统计或开始清洗。",
    ]
    highlights = [result.stage_id ? `当前工作阶段：${result.stage_id}` : undefined].filter(Boolean) as string[]
    nextActions = ["先查看检查表，确认变量名、缺失值和异常值。", "如果数据无误，再进入筛选、清洗或描述统计。"]
  } else if (action === "filter") {
    title = "数据筛选"
    headline =
      rowsAfter !== undefined && rowDelta !== undefined
        ? `筛选已完成，当前保留 ${rowsAfter} 行记录，本次共移除了 ${rowDelta} 行。`
        : "筛选已完成，数据已经更新到新的阶段。"
    summary = ["我已经把筛选后的结果单独保存，原阶段仍可回溯。", "建议先看检查表，确认删掉的是你真正想删的样本。"]
    nextActions = ["先打开筛选检查表确认结果。", "确认无误后再做描述统计或回归。"]
  } else if (action === "describe") {
    title = "描述统计"
    headline = `描述统计已完成，${(result.variables ?? []).length} 个变量的概览已经准备好。`
    summary = ["这一步更适合先帮助你判断变量分布是否合理。", "如果均值、极值或缺失情况异常，建议先回到清洗阶段。"]
    nextActions = ["先看描述统计表。", "确认变量分布合理后，再进入回归或因果分析。"]
  } else if (action === "qa") {
    title = "数据质量检查"
    headline =
      status === "success"
        ? "数据质量检查已通过，可以进入下一步分析。"
        : status === "warn"
          ? "数据质量检查已完成，但有提醒项，建议先确认再建模。"
          : "数据质量检查发现阻塞问题，建议先修数据再继续。"
    summary = ["我已经把缺失、异常和结构性问题整理成了检查结果。"]
    nextActions =
      status === "blocked"
        ? ["先修复阻塞问题，再重新运行质量检查。", "不要直接跳过 QA 进入建模。"]
        : ["查看提醒项，确认是否会影响后续建模。", "确认可接受后再继续分析。"]
  } else if (action === "healthcheck") {
    title = "环境检查"
    headline = result.status === "ready" ? "分析环境已就绪。" : "分析环境还没有完全准备好。"
    summary = ["我已经检查了当前数据处理所需的 Python 依赖和解释器状态。"]
    nextActions = result.install_command
      ? ["先补齐缺失依赖，再重新运行工具。"]
      : ["环境已就绪，可以继续下一步数据处理。"]
  } else {
    title = "数据处理"
    headline =
      rowsAfter !== undefined && columnsAfter !== undefined
        ? `这一步处理后，当前数据为 ${rowsAfter} 行、${columnsAfter} 列。`
        : "这一步数据处理已经完成。"
    summary = ["我已经生成了对应阶段的数据与检查文件。"]
    nextActions = ["先看检查结果，再决定是否进入下一步分析。"]
  }

  const risks = [
    ...(result.warnings ?? []),
    ...(result.blocking_errors ?? []),
    qaGate.qaGateStatus === "warn" ? qaGate.qaGateReason : undefined,
    qaGate.qaGateStatus === "block" ? qaGate.qaGateReason : undefined,
  ]

  return createPresentation({
    kind: "data_prep",
    title,
    headline,
    status,
    summary,
    keyMetrics: [
      presentationMetric("当前行数", rowsAfter),
      presentationMetric("当前列数", columnsAfter),
      presentationMetric(
        action === "filter" ? "移除行数" : "变动行数",
        rowDelta,
        rowDelta && rowDelta > 0 ? { tone: "caution" } : undefined,
      ),
      presentationMetric("变量数", result.variables?.length),
      presentationMetric("QA 状态", result.status ?? qaGate.qaGateStatus),
    ],
    highlights,
    risks,
    nextActions,
    artifactGroups: [
      artifactGroup("核心数据", [
        presentationArtifact("当前阶段数据", result.output_path),
        presentationArtifact("工作簿", result.workbook_path),
      ]),
      artifactGroup("检查表", [
        presentationArtifact("检查 CSV", result.inspection_path),
        presentationArtifact("检查工作簿", result.inspection_workbook_path),
        presentationArtifact("数值快照", result.numeric_snapshot_path),
      ]),
      artifactGroup("审计与日志", [
        presentationArtifact("摘要 JSON", result.summary_path),
        presentationArtifact("审计日志", result.log_path),
      ]),
      artifactGroup("交付文件", [
        ...publishedFiles.map((item) => presentationArtifact(item.label, item.relativePath)),
        presentationArtifact("交付包目录", deliveryBundlePath),
      ]),
    ],
  })
}

function encodePythonPayload(payload: unknown) {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64")
}

function parsePythonResult<T>(stdout: string, prefix = PYTHON_RESULT_PREFIX): T {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx]
    if (!line.startsWith(prefix)) continue
    return JSON.parse(line.slice(prefix.length)) as T
  }

  const trimmed = stdout.trim()
  if (trimmed) return JSON.parse(trimmed) as T
  throw new Error("Python produced no parseable output")
}

async function runInlinePython(input: { command: string; script: string; cwd: string }) {
  const tempDir = projectTempRoot()
  fs.mkdirSync(tempDir, { recursive: true })
  const tempScriptPath = path.join(tempDir, `data_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`)
  fs.writeFileSync(tempScriptPath, input.script, "utf-8")

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
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
    proc.on("error", (error) => {
      fs.rmSync(tempScriptPath, { force: true })
      reject(error)
    })
    proc.on("close", (code) => {
      fs.rmSync(tempScriptPath, { force: true })
      resolve({ code, stdout, stderr })
    })
  })
}

function requireResolvableInput(action: DataAction, input: { inputPath?: string; datasetId?: string; stageId?: string }) {
  if (action === "healthcheck" || action === "rollback") return
  if (input.inputPath) return
  if (input.datasetId && input.stageId) return
  throw new Error(`Action ${action} requires inputPath or datasetId + stageId`)
}

function isDestructiveDataAction(params: {
  action: DataAction
  filters?: Array<{ operator: string }>
  operations?: Array<{ type: string }>
}) {
  if (params.action === "filter") return (params.filters?.length ?? 0) > 0
  if (params.action !== "preprocess") return false
  const destructiveOps = new Set(["dropna", "drop_missing"])
  return (params.operations ?? []).some((item) => destructiveOps.has(item.type))
}

function defaultOutputPath(
  inputPath: string | undefined,
  params: { action: DataAction; format?: "csv" | "xlsx" | "dta" | "parquet" },
) {
  const stamp = buildFileStamp()
  if (params.action === "healthcheck") {
    fs.mkdirSync(projectHealthRoot(), { recursive: true })
    return path.join(projectHealthRoot(), `python-environment_${stamp}.json`)
  }

  if (!inputPath) throw new Error(`Action ${params.action} requires inputPath`)

  const ext = path.extname(inputPath)
  const basename = path.basename(inputPath, ext)
  const dirname = path.dirname(inputPath)

  if (params.action === "import") {
    const cleanedDir = path.join(Instance.directory, "data", "cleaned")
    fs.mkdirSync(cleanedDir, { recursive: true })
    return path.join(cleanedDir, `${basename}.parquet`)
  }

  if (params.action === "export") {
    const targetExt =
      params.format === "xlsx" ? ".xlsx" : params.format === "dta" ? ".dta" : params.format === "parquet" ? ".parquet" : ".csv"
    return path.join(dirname, `${basename}${targetExt}`)
  }

  if (params.action === "preprocess") return path.join(dirname, `${basename}_processed.parquet`)
  if (params.action === "filter") return path.join(dirname, `${basename}_filtered.parquet`)
  if (params.action === "describe") return path.join(projectHealthRoot(), `${basename}_summary_${stamp}.xlsx`)
  if (params.action === "correlation") return path.join(projectHealthRoot(), `${basename}_correlation_${stamp}.xlsx`)
  if (params.action === "qa") return path.join(projectHealthRoot(), `${basename}_qa_${stamp}.json`)
  if (params.action === "rollback") return path.join(dirname, `${basename}_restored.parquet`)

  return path.join(dirname, `${basename}_output.parquet`)
}

function isStageProducingAction(action: DataAction) {
  return action === "import" || action === "filter" || action === "preprocess" || action === "rollback"
}

function effectiveOutputFormat(params: { action: DataAction; format?: "csv" | "xlsx" | "dta" | "parquet" }) {
  if (isStageProducingAction(params.action)) return "parquet" as const
  if (params.action === "describe" || params.action === "correlation") return "xlsx" as const
  if (params.action === "qa" || params.action === "healthcheck") return "json" as const
  return params.format ?? "csv"
}

function sanitizeDeliveryFilePart(value: string) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
}

function filterValueText(value: string | number | boolean | undefined) {
  if (value === undefined) return "目标值"
  return String(value).trim() || "目标值"
}

function summarizeFilterRule(rule: z.infer<typeof FilterRuleSchema>) {
  const value = filterValueText(rule.value)
  const values = (rule.values ?? []).map((item) => filterValueText(item))
  if ((rule.operator === "neq" || rule.operator === "not_in") && (value.includes("黑龙江") || values.some((item) => item.includes("黑龙江")))) {
    return "删除黑龙江省份"
  }
  switch (rule.operator) {
    case "not_in":
      return values.length === 1 ? `删除${values[0]}` : `删除指定取值`
    case "neq":
      return `删除${value}`
    case "in":
      return values.length === 1 ? `保留${values[0]}` : "保留指定取值"
    case "eq":
      return `保留${value}`
    case "contains":
      return `筛选包含${value}`
    case "not_contains":
      return `删除包含${value}`
    case "gt":
      return `${rule.column}大于${value}`
    case "gte":
      return `${rule.column}大于等于${value}`
    case "lt":
      return `${rule.column}小于${value}`
    case "lte":
      return `${rule.column}小于等于${value}`
    default:
      return `筛选${rule.column}`
  }
}

function summarizePreprocessOperation(operation: z.infer<typeof PreprocessOperationSchema>) {
  const variables = (operation.variables ?? []).join("、")
  const varSuffix = variables || "变量"
  switch (operation.type) {
    case "dropna":
    case "drop_missing":
      return "删除缺失值行"
    case "fillna":
    case "fill_constant":
      return `常数填补${varSuffix}`
    case "fill_mean":
      return `均值填补${varSuffix}`
    case "fill_median":
      return `中位数填补${varSuffix}`
    case "forward_fill":
      return `前向填补${varSuffix}`
    case "backward_fill":
      return `后向填补${varSuffix}`
    case "linear_interpolate":
      return `线性插值${varSuffix}`
    case "group_linear_interpolate":
      return `分组线性插值${varSuffix}`
    case "regression_impute":
      return `回归插补${varSuffix}`
    case "log_transform":
      return `对数化${varSuffix}`
    case "standardize":
      return `标准化${varSuffix}`
    case "winsorize":
      return `缩尾处理${varSuffix}`
    case "create_dummies":
      return `生成虚拟变量${varSuffix}`
    default:
      return `处理${varSuffix}`
  }
}

function stageDeliveryDescription(params: {
  action: DataAction
  stageLabel?: string
  filters?: Array<z.infer<typeof FilterRuleSchema>>
  operations?: Array<z.infer<typeof PreprocessOperationSchema>>
  rollbackStageId?: string
}) {
  if (params.stageLabel?.trim()) {
    return sanitizeDeliveryFilePart(params.stageLabel)
  }
  if (params.action === "filter") {
    const parts = (params.filters ?? []).map(summarizeFilterRule).filter(Boolean)
    return parts.length ? sanitizeDeliveryFilePart(parts.join("_")) : "筛选结果"
  }
  if (params.action === "preprocess") {
    const parts = (params.operations ?? []).map(summarizePreprocessOperation).filter(Boolean)
    return parts.length ? sanitizeDeliveryFilePart(parts.join("_")) : "数据预处理"
  }
  if (params.action === "rollback") {
    return sanitizeDeliveryFilePart(`回滚到${params.rollbackStageId ?? "上一版本"}`)
  }
  return sanitizeDeliveryFilePart(params.action)
}

async function writeDeliveryWorkbook(input: {
  sourcePath: string
  outputPath: string
  pythonCommand: string
}) {
  const payloadB64 = encodePythonPayload({
    source_path: input.sourcePath,
    output_path: input.outputPath,
  })
  const script = `
import base64
import json
from pathlib import Path

import pandas as pd

payload = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))
source_path = payload["source_path"]
output_path = payload["output_path"]

df = pd.read_parquet(source_path)
Path(output_path).parent.mkdir(parents=True, exist_ok=True)
with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
    df.to_excel(writer, sheet_name="data", index=False)
`
  const { code, stdout, stderr } = await runInlinePython({
    command: input.pythonCommand,
    script,
    cwd: Instance.directory,
  })
  if (code !== 0) {
    throw new Error(`Failed to generate delivery workbook: ${stderr || stdout}`)
  }
}

export const DataImportTool = Tool.define("data_import", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z.enum(DATA_ACTIONS),
    inputPath: z.string().optional(),
    datasetId: z.string().optional(),
    stageId: z.string().optional(),
    runId: z.string().optional(),
    branch: z.string().optional(),
    stageLabel: z.string().optional(),
    outputPath: z.string().optional(),
    format: z.enum(["csv", "xlsx", "dta", "parquet"]).optional(),
    preserveLabels: z.boolean().default(true),
    createInspectionArtifacts: z.boolean().optional().default(true),
    operations: z.array(PreprocessOperationSchema).optional(),
    filters: z.array(FilterRuleSchema).optional(),
    sheetPolicy: SheetPolicySchema.optional(),
    variables: z.array(z.string()).optional(),
    groupBy: z.array(z.string()).optional(),
    entityVar: z.string().optional(),
    timeVar: z.string().optional(),
    options: z.object({}).passthrough().optional(),
  }),
  async execute(params, ctx) {
    const retryBudget = checkRetryBudget("data_import", ctx.sessionID)
    if (!retryBudget.allowed) {
      throw new Error(
        `Retry budget exhausted for data_import in this session (${retryBudget.count}/${retryBudget.max}). Inspect the reflection logs and repair the failed stage before retrying.`,
      )
    }
    const pythonStatus = await getRuntimePythonStatus()
    if (!pythonStatus.ok || pythonStatus.missing.length) {
      throw new Error(formatRuntimePythonSetupError("data_import", pythonStatus))
    }
    const pythonCommand = pythonStatus.executable
    const installCommand = pythonStatus.installCommand
    if (ctx.agent === "analyst") {
      const branch = params.branch ?? "main"
      if (!ANALYST_PRE_APPROVAL_ACTIONS.has(params.action)) {
        const analystState = AnalysisIntent.getAnalyst(ctx.sessionID)
        if (!analystState.planApproved) {
          const plannedRun = await ensureAnalysisPlan({
            sessionID: ctx.sessionID,
            datasetId: params.datasetId,
            runId: typeof params.options?.["runId"] === "string" ? params.options["runId"] : undefined,
            branch,
          })
          const locale = plannedRun.workflowLocale
          const approvalOptions = workflowChecklistOptions(locale, "analysis")
          AnalysisIntent.markAnalystPlanGenerated(ctx.sessionID)
          const answers = await Question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                header: workflowAnalysisPlanHeader(locale),
                question: [
                  workflowChecklistIntro(locale, "analysis"),
                  ...formatAnalysisChecklist(plannedRun),
                  "",
                  workflowChecklistApprovalPrompt(locale, "analysis"),
                ].join("\n"),
                custom: false,
                options: [
                  approvalOptions.yes,
                  approvalOptions.no,
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] !== approvalOptions.yes.label) {
            setAnalysisPlanApproval({
              sessionID: ctx.sessionID,
              approvalStatus: "declined",
              datasetId: params.datasetId,
              branch,
            })
            AnalysisIntent.markAnalystPlanApproval(ctx.sessionID, false)
            throw new Question.RejectedError()
          }
          setAnalysisPlanApproval({
            sessionID: ctx.sessionID,
            approvalStatus: "approved",
            datasetId: params.datasetId,
            branch,
          })
          AnalysisIntent.markAnalystPlanApproval(ctx.sessionID, true)
        }
      }
    }

    if (ctx.agent === "explorer" && isDestructiveDataAction(params)) {
      const destructiveSignature = JSON.stringify({
        action: params.action,
        filters: params.filters ?? [],
        operations: params.operations ?? [],
        datasetId: params.datasetId,
        stageId: params.stageId,
        inputPath: params.inputPath,
      })
      if (!AnalysisIntent.isExplorerActionConfirmed(ctx.sessionID, destructiveSignature)) {
        const answers = await Question.ask({
          sessionID: ctx.sessionID,
          questions: [
            {
              header: "Confirm Delete",
              question:
                "Explorer is about to run a row-removing or deletion-like data operation. Do you want to continue?",
              custom: false,
              options: [
                { label: "Yes", description: "Proceed with the data-removal step" },
                { label: "No", description: "Stop and keep the current dataset unchanged" },
              ],
            },
          ],
          tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
        })

        if (answers[0]?.[0] !== "Yes") {
          throw new Question.RejectedError()
        }
        AnalysisIntent.confirmExplorerAction(ctx.sessionID, destructiveSignature)
      }
    }

    requireResolvableInput(params.action, {
      inputPath: params.inputPath,
      datasetId: params.datasetId,
      stageId: params.stageId,
    })

    const directInputPath = params.inputPath
      ? await resolveToolPath({
          filePath: params.inputPath,
          mode: "read",
          toolName: "data_import",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
      : undefined
    const artifactInput = resolveArtifactInput({
      datasetId: params.datasetId,
      stageId: params.stageId,
      inputPath: directInputPath,
    })
    const inputPath = artifactInput.resolvedInputPath
    if (inputPath && !fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`)
    }

    let datasetManifest = artifactInput.manifest
    let sourceStage = artifactInput.stage
    let datasetId = params.datasetId
    let stageId = params.stageId
    let parentStageId = sourceStage?.stageId
    const branch = params.branch ?? sourceStage?.branch ?? "main"
    const runId = inferRunId({
      requestedRunId: params.runId,
      stage: sourceStage,
    })
    let inspectionPath: string | undefined
    let inspectionWorkbookPath: string | undefined
    let schemaPath: string | undefined
    let labelsPath: string | undefined
    let summaryPath: string | undefined
    let logPath: string | undefined
    const actionStamp = buildFileStamp()
    let sourceFingerprint = directInputPath && params.action === "import" ? fingerprintSourceFile(directInputPath) : undefined
    let reusedImportStage = false

    if (params.action === "import") {
      const reused = findDatasetForSource(inputPath!)
      sourceFingerprint = reused.fingerprint
      datasetManifest ??= reused.manifest
      datasetId ??= datasetManifest?.datasetId ?? createDatasetId(inputPath!, sourceFingerprint.key)
      datasetManifest ??= createDatasetManifest({
        datasetId,
        sourcePath: inputPath!,
        sourceFormat: path.extname(inputPath!).replace(/^\./, "").toLowerCase() as "csv" | "xlsx" | "xls" | "dta" | "parquet",
        workingFormat: "parquet",
      })
      datasetManifest.sourcePath = inputPath!
      datasetManifest.sourceFormat = path
        .extname(inputPath!)
        .replace(/^\./, "")
        .toLowerCase() as "csv" | "xlsx" | "xls" | "dta" | "parquet"
      const matchingImportStage = latestImportStageForFingerprint(datasetManifest, sourceFingerprint.key)
      if (matchingImportStage) {
        if (
          shouldReuseImportStage({
            sourcePath: datasetManifest.sourcePath,
            schemaPath: matchingImportStage.schemaPath,
          })
        ) {
          reusedImportStage = true
          sourceStage = matchingImportStage
          parentStageId = matchingImportStage.parentStageId
          stageId = matchingImportStage.stageId
          inspectionPath = matchingImportStage.inspectionPath
          inspectionWorkbookPath = matchingImportStage.inspectionWorkbookPath
          schemaPath = matchingImportStage.schemaPath
          labelsPath = matchingImportStage.labelsPath
          summaryPath = matchingImportStage.summaryPath
          logPath = matchingImportStage.logPath
        } else {
          log.warn("Skipping import-stage reuse because cached source/schema text looks mojibake", {
            datasetId: datasetManifest.datasetId,
            stageId: matchingImportStage.stageId,
            sourcePath: datasetManifest.sourcePath,
            schemaPath: matchingImportStage.schemaPath,
          })
          stageId = datasetManifest.stages.length === 0 ? "stage_000" : nextStageId(datasetManifest)
        }
      } else {
        stageId = datasetManifest.stages.length === 0 ? "stage_000" : nextStageId(datasetManifest)
      }
    }

    if (params.action === "import" && !reusedImportStage) {
      const ensuredDatasetId = datasetId!
      const ensuredStageId = stageId!
      const stagePaths = stageMetaPaths({ datasetId: ensuredDatasetId, stageId: ensuredStageId, action: params.action, stamp: actionStamp })
      schemaPath = stagePaths.schemaPath
      labelsPath = stagePaths.labelsPath
      summaryPath = stagePaths.summaryPath
      logPath = stagePaths.logPath
      if (params.createInspectionArtifacts) {
        const inspection = stageInspectionPaths({
          datasetId: ensuredDatasetId,
          stageId: ensuredStageId,
          action: params.action,
          stamp: actionStamp,
        })
        inspectionPath = inspection.csvPath
        inspectionWorkbookPath = inspection.workbookPath
      }
    }

    if ((params.action === "filter" || params.action === "preprocess") && datasetManifest) {
      stageId = nextStageId(datasetManifest)
      const stagePaths = stageMetaPaths({ datasetId: datasetManifest.datasetId, stageId, action: params.action, stamp: actionStamp })
      schemaPath = stagePaths.schemaPath
      labelsPath = stagePaths.labelsPath
      summaryPath = stagePaths.summaryPath
      logPath = stagePaths.logPath
      if (params.createInspectionArtifacts) {
        const inspection = stageInspectionPaths({ datasetId: datasetManifest.datasetId, stageId, action: params.action, stamp: actionStamp })
        inspectionPath = inspection.csvPath
        inspectionWorkbookPath = inspection.workbookPath
      }
    }

    if (params.action === "rollback") {
      if (!datasetManifest) {
        throw new Error("Rollback requires datasetId")
      }
      if (!params.stageId) {
        throw new Error("Rollback requires stageId")
      }
      sourceStage = getStage(datasetManifest, params.stageId)
      parentStageId = sourceStage.stageId
      stageId = nextStageId(datasetManifest)
      const stagePaths = stageMetaPaths({ datasetId: datasetManifest.datasetId, stageId, action: params.action, stamp: actionStamp })
      schemaPath = stagePaths.schemaPath
      labelsPath = stagePaths.labelsPath
      summaryPath = stagePaths.summaryPath
      logPath = stagePaths.logPath
      if (params.createInspectionArtifacts) {
        const inspection = stageInspectionPaths({ datasetId: datasetManifest.datasetId, stageId, action: params.action, stamp: actionStamp })
        inspectionPath = inspection.csvPath
        inspectionWorkbookPath = inspection.workbookPath
      }
    }

    const outputPath = params.outputPath
      ? await resolveToolPath({
          filePath: params.outputPath,
          mode: "write",
          toolName: "data_import",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
      : reusedImportStage && sourceStage?.workingPath
        ? sourceStage.workingPath
      : datasetManifest && stageId && isStageProducingAction(params.action)
        ? stageOutputPath({
          datasetId: datasetManifest.datasetId,
          stageId,
          action: params.action,
          format: "parquet",
          stamp: actionStamp,
        })
        : datasetManifest && params.action === "describe"
          ? reportOutputPath({
            datasetId: datasetManifest.datasetId,
            action: "describe",
            stageId: params.stageId ?? sourceStage?.stageId,
            branch,
            format: "xlsx",
            stamp: actionStamp,
          })
          : datasetManifest && params.action === "correlation"
            ? reportOutputPath({
              datasetId: datasetManifest.datasetId,
              action: "correlation",
              stageId: params.stageId ?? sourceStage?.stageId,
              branch,
              format: "xlsx",
              stamp: actionStamp,
            })
            : datasetManifest && params.action === "qa"
              ? reportOutputPath({
                datasetId: datasetManifest.datasetId,
                action: "qa",
                stageId: params.stageId ?? sourceStage?.stageId,
                branch,
                format: "json",
                stamp: actionStamp,
              })
              : defaultOutputPath(inputPath, { action: params.action, format: params.format })

    fs.mkdirSync(path.dirname(outputPath), { recursive: true })

    let result: PythonResult
    if (reusedImportStage && sourceStage && datasetManifest) {
      result = {
        success: true,
        action: "import",
        dataset_id: datasetManifest.datasetId,
        stage_id: sourceStage.stageId,
        parent_stage_id: sourceStage.parentStageId,
        branch: sourceStage.branch,
        run_id: runId,
        input_path: inputPath,
        output_path: sourceStage.workingPath,
        summary_path: sourceStage.summaryPath,
        log_path: sourceStage.logPath,
        inspection_path: sourceStage.inspectionPath,
        inspection_workbook_path: sourceStage.inspectionWorkbookPath,
        schema_path: sourceStage.schemaPath,
        labels_path: sourceStage.labelsPath,
        rows_before: sourceStage.rowCount,
        rows_after: sourceStage.rowCount,
        columns_before: sourceStage.columnCount,
        columns_after: sourceStage.columnCount,
        warnings: ["Reused existing import stage because the source file fingerprint is unchanged."],
      }
    } else {
      await ctx.ask({
        permission: "bash",
        patterns: [`${pythonCommand} *data*`],
        always: [`${pythonCommand}*`],
        metadata: {
          description: `Data pipeline action: ${params.action}`,
        },
      })

      const payload = {
        action: params.action,
        input_path: inputPath ?? null,
        output_path: outputPath,
        format: effectiveOutputFormat({ action: params.action, format: params.format }),
        preserve_labels: params.preserveLabels,
        dataset_id: datasetManifest?.datasetId ?? datasetId ?? null,
        stage_id: stageId ?? null,
        parent_stage_id: parentStageId ?? null,
        branch,
        run_id: runId,
        stage_label: params.stageLabel ?? null,
        schema_path: schemaPath ?? null,
        labels_path: labelsPath ?? null,
        summary_path: summaryPath ?? null,
        log_path: logPath ?? null,
        inspection_path: inspectionPath ?? null,
        inspection_workbook_path: inspectionWorkbookPath ?? null,
        operations: params.operations ?? [],
        filters: params.filters ?? [],
        variables: params.variables ?? [],
        group_by: params.groupBy ?? [],
        entity_var: params.entityVar ?? null,
        time_var: params.timeVar ?? null,
        sheet_policy: params.sheetPolicy ?? null,
        options: params.options ?? {},
        install_command: installCommand,
      }

      const payloadB64 = encodePythonPayload(payload)

    const pythonScript = `
import base64
import importlib.util
import json
import sys
import traceback
from pathlib import Path

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"
PROJECT_DIR = r"${Instance.directory.replace(/\\/g, "\\\\")}"
ECONOMETRICS_DIR = r"${ECONOMETRICS_DIR.replace(/\\/g, "\\\\")}"
ERRORS_DIR = r"${projectErrorsRoot().replace(/\\/g, "\\\\")}"

sys.path.insert(0, ECONOMETRICS_DIR)

def emit(result):
    print(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=False)}")

def mkdir_for(file_path):
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)

def save_json(file_path, payload):
    mkdir_for(file_path)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

def safe_error_path(action):
    error_dir = Path(ERRORS_DIR)
    error_dir.mkdir(parents=True, exist_ok=True)
    from datetime import datetime
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return str(error_dir / f"data_import_{action}_{stamp}_error.json")

try:
    import numpy as np
    import pandas as pd
except Exception as exc:
    result = {
        "success": False,
        "error": f"Failed to import pandas/numpy: {exc}",
        "install_command": payload.get("install_command") if "payload" in globals() else "${installCommand}",
    }
    error_path = safe_error_path("bootstrap")
    result["error_log_path"] = error_path
    save_json(error_path, result)
    emit(result)
    raise SystemExit(0)

try:
    from data_preprocess import (
        build_quality_report as preprocess_quality_report,
        correlation_matrix,
        describe_dataset,
        drop_missing_rows,
        fill_missing_constant,
        fill_missing_statistics,
        fill_missing_values,
        forward_backward_fill,
        get_column_info,
        group_linear_interpolate,
        linear_interpolate,
        log_transform_columns,
        regression_impute,
        safe_get_dummies,
        standardize_columns,
        winsorize_columns,
    )
except Exception as exc:
    result = {"success": False, "error": f"Failed to import data_preprocess: {exc}"}
    error_path = safe_error_path("bootstrap")
    result["error_log_path"] = error_path
    save_json(error_path, result)
    emit(result)
    raise SystemExit(0)

payload = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))
action = payload["action"]
output_path = payload["output_path"]

def write_labels(file_path, input_path):
    labels = {"variable_labels": {}, "value_labels": {}}
    def normalize_label_mapping(value):
        if isinstance(value, dict):
            return {str(k): normalize_label_mapping(v) for k, v in value.items()}
        if isinstance(value, list):
            return [normalize_label_mapping(item) for item in value]
        return value
    try:
        suffix = Path(input_path).suffix.lower()
        if suffix == ".dta":
            reader = pd.io.stata.StataReader(input_path)
            labels["variable_labels"] = reader.variable_labels()
            try:
                labels["value_labels"] = normalize_label_mapping(reader.value_labels())
            except Exception:
                labels["value_labels"] = {}
    except Exception as exc:
        labels["warning"] = str(exc)
    save_json(file_path, labels)

def build_schema(df):
    schema = []
    for col in df.columns:
        schema.append(
            {
                "name": str(col),
                "dtype": str(df[col].dtype),
                "missing_count": int(df[col].isna().sum()),
                "missing_share": float(df[col].isna().mean()),
            }
        )
    return schema

def read_table(file_path):
    suffix = Path(file_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(file_path)
    if suffix in [".xlsx", ".xls"]:
        sheet_policy = payload.get("sheet_policy") or {}
        mode = sheet_policy.get("mode") or "first_sheet"
        header_row = sheet_policy.get("headerRow")
        read_kwargs = {}
        if isinstance(header_row, int):
            read_kwargs["header"] = header_row
        if mode == "named_sheet":
            read_kwargs["sheet_name"] = sheet_policy.get("sheetName")
        else:
            read_kwargs["sheet_name"] = 0
        return pd.read_excel(file_path, **read_kwargs)
    if suffix == ".dta":
        read_error = None
        for encoding in [None, "gbk", "latin1"]:
            try:
                kwargs = {"preserve_dtypes": False}
                if encoding is not None:
                    kwargs["encoding"] = encoding
                df = pd.read_stata(file_path, **kwargs)
                df.attrs["_source_encoding"] = encoding or "default"
                return df
            except Exception as exc:
                read_error = exc
                message = str(exc).lower()
                if encoding is None and not isinstance(exc, UnicodeDecodeError) and "unicode" not in message and "codec" not in message:
                    raise
        raise read_error
    if suffix == ".parquet":
        return pd.read_parquet(file_path)
    raise ValueError(f"Unsupported input format: {suffix}")

def write_table(df, file_path, export_format=None):
    target = Path(file_path)
    mkdir_for(str(target))
    suffix = export_format or target.suffix.lower().lstrip(".")
    if suffix == "csv":
        df.to_csv(target, index=False, encoding="utf-8-sig")
        return str(target)
    if suffix in ["xlsx", "xls"]:
        df.to_excel(target, index=False, engine="openpyxl")
        return str(target)
    if suffix == "dta":
        df.to_stata(target, write_index=False)
        return str(target)
    if suffix == "parquet":
        df.to_parquet(target, index=False)
        return str(target)
    raise ValueError(f"Unsupported output format: {suffix}")

def write_inspection_exports(df):
    csv_path = payload.get("inspection_path")
    workbook_path = payload.get("inspection_workbook_path")
    if csv_path:
        write_table(df, csv_path, "csv")
    if workbook_path:
        write_table(df, workbook_path, "xlsx")
    return csv_path, workbook_path

def persist_stage_metadata(df, input_path=None):
    schema_path = payload.get("schema_path")
    labels_path = payload.get("labels_path")
    if schema_path:
        save_json(schema_path, {"schema": build_schema(df)})
    if labels_path:
        write_labels(labels_path, input_path or payload.get("input_path"))

def missing_counts(df, columns):
    return {col: int(df[col].isna().sum()) for col in columns if col in df.columns}

def selected_columns(df, variables):
    if not variables:
        return list(df.columns)
    missing = [col for col in variables if col not in df.columns]
    if missing:
        raise ValueError(f"Variables not found: {missing}")
    return variables

def build_quality_report(df, entity_var=None, time_var=None):
    _, report = preprocess_quality_report(df, entity_var=entity_var, time_var=time_var)
    return report

def apply_filter(df, rule):
    column = rule["column"]
    if column not in df.columns:
        raise ValueError(f"Filter column not found: {column}")

    operator = rule["operator"]
    case_sensitive = bool(rule.get("caseSensitive", False))
    series = df[column]
    value = rule.get("value")
    values = rule.get("values") or []

    if operator == "in":
        return df[series.isin(values)]
    if operator == "not_in":
        return df[~series.isin(values)]
    if operator == "eq":
        return df[series == value]
    if operator == "neq":
        return df[series != value]
    if operator == "gt":
        return df[pd.to_numeric(series, errors="coerce") > value]
    if operator == "gte":
        return df[pd.to_numeric(series, errors="coerce") >= value]
    if operator == "lt":
        return df[pd.to_numeric(series, errors="coerce") < value]
    if operator == "lte":
        return df[pd.to_numeric(series, errors="coerce") <= value]

    text_series = series.astype(str)
    needle = str(value)
    if not case_sensitive:
        text_series = text_series.str.lower()
        needle = needle.lower()

    if operator == "contains":
        return df[text_series.str.contains(needle, na=False)]
    if operator == "not_contains":
        return df[~text_series.str.contains(needle, na=False)]

    raise ValueError(f"Unsupported filter operator: {operator}")

def summarize_dataframe(df, columns):
    summary, _ = describe_dataset(df, columns=columns)
    summary["non_null_count"] = summary["variable"].map(lambda col: int(df[col].notna().sum()))
    return summary

try:
    if action == "healthcheck":
        modules = ["pandas", "statsmodels", "linearmodels", "openpyxl", "scipy", "matplotlib", "pyarrow", "docx"]
        status = {}
        import_errors = {}
        for name in modules:
            if importlib.util.find_spec(name) is None:
                status[name] = False
                import_errors[name] = "module not found"
                continue
            try:
                __import__(name)
                status[name] = True
            except Exception as exc:
                status[name] = False
                import_errors[name] = str(exc)
        missing = [name for name, ok in status.items() if not ok]
        result = {
            "success": True,
            "action": "healthcheck",
            "status": "pass" if not missing else "warn",
            "module_status": status,
            "import_errors": import_errors,
            "warnings": [] if not missing else [f"Missing or broken modules: {missing}", "pyarrow is required because Parquet is the canonical working format"],
            "suggested_repairs": [] if not missing else [f"Import errors: {import_errors}", "Install or repair pyarrow before running stage-based data processing"],
            "install_command": payload["install_command"],
            "output_path": output_path,
        }
        save_json(output_path, result)
        emit(result)
        raise SystemExit(0)

    input_path = payload["input_path"]
    df = read_table(input_path)
    rows_before = int(len(df))
    columns_before = int(len(df.columns))

    if action == "import":
        write_table(df, output_path, "parquet")
        inspection_csv_path, inspection_workbook_path = write_inspection_exports(df)
        persist_stage_metadata(df, input_path)
        summary_path = payload.get("summary_path") or (str(Path(output_path).with_suffix("")) + "_summary.json")
        log_path = payload.get("log_path") or (str(Path(output_path).with_suffix("")) + "_log.md")
        result = {
            "success": True,
            "action": "import",
            "dataset_id": payload.get("dataset_id"),
            "stage_id": payload.get("stage_id"),
            "parent_stage_id": payload.get("parent_stage_id"),
            "branch": payload.get("branch"),
            "input_path": input_path,
            "output_path": output_path,
            "inspection_path": inspection_csv_path,
            "inspection_workbook_path": inspection_workbook_path,
            "rows_before": rows_before,
            "rows_after": int(len(df)),
            "columns_before": columns_before,
            "columns_after": int(len(df.columns)),
            "column_info": get_column_info(df),
            "metadata_saved": bool(payload.get("preserve_labels", True)),
            "schema_path": payload.get("schema_path"),
            "labels_path": payload.get("labels_path"),
            "summary_path": summary_path,
            "log_path": log_path,
        }
        save_json(summary_path, {"result": result, "quality": build_quality_report(df), "schema": build_schema(df)})
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("# Data Import Log\\n\\n")
            f.write(f"Input: {input_path}\\n")
            f.write(f"Output: {output_path}\\n")
            if inspection_csv_path:
                f.write(f"Inspection CSV: {inspection_csv_path}\\n")
            if inspection_workbook_path:
                f.write(f"Inspection workbook: {inspection_workbook_path}\\n")
            f.write(f"Rows: {rows_before}\\n")
            f.write(f"Columns: {columns_before}\\n")
        emit(result)
        raise SystemExit(0)

    if action == "export":
        export_format = payload.get("format", "csv")
        write_table(df, output_path, export_format)
        result = {
            "success": True,
            "action": "export",
            "input_path": input_path,
            "output_path": output_path,
            "rows_before": rows_before,
            "rows_after": int(len(df)),
            "columns_before": columns_before,
            "columns_after": int(len(df.columns)),
            "column_info": get_column_info(df),
            "summary_path": output_path + ".summary.json",
        }
        save_json(result["summary_path"], result)
        emit(result)
        raise SystemExit(0)

    if action == "preprocess":
        operations = payload.get("operations", [])
        log_entries = []
        operation_warnings = []
        tracked_columns = sorted({item for op in operations for item in (op.get("variables") or [])})
        missing_before_map = missing_counts(df, tracked_columns)
        for op in operations:
            op_type = op.get("type")
            vars_in = op.get("variables") or []
            op_params = op.get("params") or {}

            if op_type in ["dropna", "drop_missing"]:
                subset = selected_columns(df, vars_in) if vars_in else None
                df, audit = drop_missing_rows(df, columns=subset)
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            elif op_type in ["fillna", "fill_constant", "fill_mean", "fill_median"]:
                target_vars = selected_columns(df, vars_in) if vars_in else list(df.columns)
                method = op_params.get("method")
                if op_type == "fill_mean":
                    method = "mean"
                elif op_type == "fill_median":
                    method = "median"
                elif op_type == "fill_constant":
                    method = "constant"
                explicit_value = op_params.get("value", 0)
                if method in ["mean", "median", "mode"]:
                    df, audit = fill_missing_statistics(df, columns=target_vars, strategy=method)
                elif method == "constant" or method is None:
                    df, audit = fill_missing_constant(df, columns=target_vars, value=explicit_value)
                else:
                    df, audit = fill_missing_values(df, columns=target_vars, strategy=method, value=explicit_value)
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            elif op_type == "forward_fill":
                target_vars = selected_columns(df, vars_in) if vars_in else list(df.columns)
                df, audit = forward_backward_fill(df, columns=target_vars, direction="forward")
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            elif op_type == "backward_fill":
                target_vars = selected_columns(df, vars_in) if vars_in else list(df.columns)
                df, audit = forward_backward_fill(df, columns=target_vars, direction="backward")
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            elif op_type == "linear_interpolate":
                target_vars = selected_columns(df, vars_in)
                time_var = op_params.get("time_var") or payload.get("time_var")
                if not time_var:
                    raise ValueError("linear_interpolate requires time_var")
                if time_var not in df.columns:
                    raise ValueError(f"Interpolation time variable not found: {time_var}")
                df, audit = linear_interpolate(df, columns=target_vars, time_var=time_var)
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            elif op_type == "group_linear_interpolate":
                target_vars = selected_columns(df, vars_in)
                time_var = op_params.get("time_var") or payload.get("time_var")
                group_vars = op_params.get("group_by") or payload.get("group_by") or ([payload.get("entity_var")] if payload.get("entity_var") else [])
                if not time_var:
                    raise ValueError("group_linear_interpolate requires time_var")
                if time_var not in df.columns:
                    raise ValueError(f"Interpolation time variable not found: {time_var}")
                if not group_vars:
                    raise ValueError("group_linear_interpolate requires group_by or entity_var")
                missing_groups = [var for var in group_vars if var not in df.columns]
                if missing_groups:
                    raise ValueError(f"Interpolation group variables not found: {missing_groups}")
                df, audit = group_linear_interpolate(df, columns=target_vars, time_var=time_var, group_by=group_vars)
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            elif op_type == "regression_impute":
                target_vars = selected_columns(df, vars_in)
                predictors = op_params.get("predictors") or []
                if not predictors:
                    raise ValueError("regression_impute requires predictors")
                missing_predictors = [col for col in predictors if col not in df.columns]
                if missing_predictors:
                    raise ValueError(f"Regression imputation predictors not found: {missing_predictors}")
                df, audit = regression_impute(df, columns=target_vars, predictors=predictors)
                operation_warnings.extend(audit.get("warnings", []))
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            elif op_type == "log_transform":
                target_vars = selected_columns(df, vars_in)
                df, audit = log_transform_columns(df, columns=target_vars, offset=float(op_params.get("offset", 1.0)))
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            elif op_type == "standardize":
                target_vars = selected_columns(df, vars_in)
                df, audit = standardize_columns(df, columns=target_vars, suffix=op_params.get("suffix", "_std"))
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            elif op_type == "winsorize":
                target_vars = selected_columns(df, vars_in)
                lower = float(op_params.get("lower", 0.01))
                upper = float(op_params.get("upper", 0.01))
                limits = op_params.get("limits")
                if isinstance(limits, list) and len(limits) == 2:
                    lower = float(limits[0])
                    upper = float(limits[1])
                df, audit = winsorize_columns(df, columns=target_vars, lower=lower, upper=upper)
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            elif op_type == "create_dummies":
                target_vars = selected_columns(df, vars_in)
                df, audit = safe_get_dummies(df, columns=target_vars, drop_first=bool(op_params.get("drop_first", True)))
                log_entries.append(json.dumps(audit, ensure_ascii=False))
            else:
                raise ValueError(f"Unsupported preprocess operation: {op_type}")

        write_table(df, output_path, "parquet")
        inspection_csv_path, inspection_workbook_path = write_inspection_exports(df)
        persist_stage_metadata(df, input_path)
        summary_path = payload.get("summary_path") or (str(Path(output_path).with_suffix("")) + "_summary.json")
        log_path = payload.get("log_path") or (str(Path(output_path).with_suffix("")) + "_log.md")
        missing_after_map = missing_counts(df, tracked_columns)
        result = {
            "success": True,
            "action": "preprocess",
            "dataset_id": payload.get("dataset_id"),
            "stage_id": payload.get("stage_id"),
            "parent_stage_id": payload.get("parent_stage_id"),
            "branch": payload.get("branch"),
            "input_path": input_path,
            "output_path": output_path,
            "inspection_path": inspection_csv_path,
            "inspection_workbook_path": inspection_workbook_path,
            "rows_before": rows_before,
            "rows_after": int(len(df)),
            "columns_before": columns_before,
            "columns_after": int(len(df.columns)),
            "column_info": get_column_info(df),
            "operations_count": int(len(operations)),
            "missing_before": missing_before_map,
            "missing_after": missing_after_map,
            "warnings": operation_warnings,
            "schema_path": payload.get("schema_path"),
            "labels_path": payload.get("labels_path"),
            "summary_path": summary_path,
            "log_path": log_path,
        }
        save_json(summary_path, {"result": result, "quality": build_quality_report(df)})
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("# Data Preprocess Log\\n\\n")
            for idx, item in enumerate(log_entries, 1):
                f.write(f"{idx}. {item}\\\\n")
            if operation_warnings:
                f.write("\\n## Warnings\\n")
                for item in operation_warnings:
                    f.write(f"- {item}\\\\n")
        emit(result)
        raise SystemExit(0)

    if action == "filter":
        filters = payload.get("filters", [])
        working = df.copy()
        audit = []
        for rule in filters:
            before = len(working)
            working = apply_filter(working, rule)
            audit.append({
                "rule": rule,
                "rows_before": int(before),
                "rows_after": int(len(working)),
            })
        write_table(working, output_path, "parquet")
        inspection_csv_path, inspection_workbook_path = write_inspection_exports(working)
        persist_stage_metadata(working, input_path)
        summary_path = payload.get("summary_path") or (str(Path(output_path).with_suffix("")) + "_summary.json")
        log_path = payload.get("log_path") or (str(Path(output_path).with_suffix("")) + "_log.md")
        result = {
            "success": True,
            "action": "filter",
            "dataset_id": payload.get("dataset_id"),
            "stage_id": payload.get("stage_id"),
            "parent_stage_id": payload.get("parent_stage_id"),
            "branch": payload.get("branch"),
            "input_path": input_path,
            "output_path": output_path,
            "inspection_path": inspection_csv_path,
            "inspection_workbook_path": inspection_workbook_path,
            "rows_before": rows_before,
            "rows_after": int(len(working)),
            "columns_before": columns_before,
            "columns_after": int(len(working.columns)),
            "column_info": get_column_info(working),
            "filters_count": int(len(filters)),
            "schema_path": payload.get("schema_path"),
            "labels_path": payload.get("labels_path"),
            "summary_path": summary_path,
            "log_path": log_path,
        }
        save_json(summary_path, {"result": result, "filters": audit, "quality": build_quality_report(working)})
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("# Data Filter Log\\n\\n")
            for idx, item in enumerate(audit, 1):
                f.write(f"{idx}. {json.dumps(item, ensure_ascii=False)}\\\\n")
        emit(result)
        raise SystemExit(0)

    if action == "rollback":
        write_table(df, output_path, "parquet")
        inspection_csv_path, inspection_workbook_path = write_inspection_exports(df)
        persist_stage_metadata(df, input_path)
        summary_path = payload.get("summary_path") or (str(Path(output_path).with_suffix("")) + "_summary.json")
        log_path = payload.get("log_path") or (str(Path(output_path).with_suffix("")) + "_log.md")
        result = {
            "success": True,
            "action": "rollback",
            "dataset_id": payload.get("dataset_id"),
            "stage_id": payload.get("stage_id"),
            "parent_stage_id": payload.get("parent_stage_id"),
            "branch": payload.get("branch"),
            "input_path": input_path,
            "output_path": output_path,
            "inspection_path": inspection_csv_path,
            "inspection_workbook_path": inspection_workbook_path,
            "rows_before": rows_before,
            "rows_after": int(len(df)),
            "columns_before": columns_before,
            "columns_after": int(len(df.columns)),
            "column_info": get_column_info(df),
            "schema_path": payload.get("schema_path"),
            "labels_path": payload.get("labels_path"),
            "summary_path": summary_path,
            "log_path": log_path,
            "warnings": [f"Restored from stage {payload.get('parent_stage_id')}"],
        }
        save_json(summary_path, {"result": result, "quality": build_quality_report(df)})
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("# Data Rollback Log\\n\\n")
            f.write(f"Restored from: {input_path}\\n")
            f.write(f"New stage output: {output_path}\\n")
        emit(result)
        raise SystemExit(0)

    if action == "describe":
        columns = selected_columns(df, payload.get("variables") or [])
        summary = summarize_dataframe(df, columns)
        missing = pd.DataFrame([
            {"variable": col, "missing_count": int(df[col].isna().sum()), "missing_share": float(df[col].isna().mean())}
            for col in columns
        ])
        workbook_path = output_path if output_path.endswith(".xlsx") else str(Path(output_path).with_suffix(".xlsx"))
        csv_path = str(Path(workbook_path).with_suffix("")) + ".csv"
        summary_path = str(Path(workbook_path).with_suffix("")) + "_summary.json"
        mkdir_for(workbook_path)
        with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
            summary.to_excel(writer, sheet_name="summary", index=False)
            missing.to_excel(writer, sheet_name="missingness", index=False)
        summary.to_csv(csv_path, index=False, encoding="utf-8-sig")
        result = {
            "success": True,
            "action": "describe",
            "dataset_id": payload.get("dataset_id"),
            "stage_id": payload.get("stage_id"),
            "branch": payload.get("branch"),
            "input_path": input_path,
            "output_path": csv_path,
            "workbook_path": workbook_path,
            "summary_path": summary_path,
            "rows_before": rows_before,
            "rows_after": rows_before,
            "columns_before": columns_before,
            "columns_after": columns_before,
            "variables": columns,
        }
        save_json(summary_path, {"result": result, "quality": build_quality_report(df)})
        emit(result)
        raise SystemExit(0)

    if action == "correlation":
        columns = selected_columns(df, payload.get("variables") or [])
        corr_method = payload.get("options", {}).get("method", "pearson")
        corr, corr_summary = correlation_matrix(df, columns=columns, method=corr_method)
        numeric_cols = corr_summary["variables"]
        workbook_path = output_path if output_path.endswith(".xlsx") else str(Path(output_path).with_suffix(".xlsx"))
        csv_path = str(Path(workbook_path).with_suffix("")) + ".csv"
        summary_path = str(Path(workbook_path).with_suffix("")) + "_summary.json"
        mkdir_for(workbook_path)
        with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
            corr.to_excel(writer, sheet_name="correlation")
        corr.to_csv(csv_path, encoding="utf-8-sig")
        result = {
            "success": True,
            "action": "correlation",
            "dataset_id": payload.get("dataset_id"),
            "stage_id": payload.get("stage_id"),
            "branch": payload.get("branch"),
            "input_path": input_path,
            "output_path": csv_path,
            "workbook_path": workbook_path,
            "summary_path": summary_path,
            "rows_before": rows_before,
            "rows_after": rows_before,
            "columns_before": columns_before,
            "columns_after": columns_before,
            "variables": numeric_cols,
        }
        save_json(summary_path, {"result": result, "method": corr_method, "summary": corr_summary})
        emit(result)
        raise SystemExit(0)

    if action == "qa":
        report = build_quality_report(df, payload.get("entity_var"), payload.get("time_var"))
        result = {
            "success": True,
            "action": "qa",
            "dataset_id": payload.get("dataset_id"),
            "stage_id": payload.get("stage_id"),
            "branch": payload.get("branch"),
            "input_path": input_path,
            "output_path": output_path,
            "rows_before": rows_before,
            "rows_after": rows_before,
            "columns_before": columns_before,
            "columns_after": columns_before,
            "status": report["status"],
            "warnings": report["warnings"],
            "blocking_errors": report["blocking_errors"],
            "suggested_repairs": report["suggested_repairs"],
        }
        save_json(output_path, {"result": result, "report": report, "column_info": get_column_info(df)})
        emit(result)
        raise SystemExit(0)

    raise ValueError(f"Unsupported action: {action}")

except Exception as exc:
    error_path = safe_error_path(action)
    result = {
        "success": False,
        "action": action,
        "error": str(exc),
        "traceback": traceback.format_exc(),
        "error_log_path": error_path,
        "install_command": payload.get("install_command"),
    }
    save_json(error_path, result)
    emit(result)
`

      log.info("run data_import", { action: params.action, inputPath, outputPath })

      let execution: { code: number | null; stdout: string; stderr: string }
      try {
        execution = await runInlinePython({
          command: pythonCommand,
          script: pythonScript,
          cwd: Instance.directory,
        })
      } catch (error) {
        throw new Error(
          `Failed to launch python command "${pythonCommand}". Run \`killstata config\` to set Python if needed.\n${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const { code, stdout, stderr } = execution

      if (code !== 0) {
        log.error("python failed", { code, stderr })
        throw new Error(`Data import failed with Python ${pythonCommand} (exit code ${code})\n${stderr}\n${stdout}`)
      }

      try {
        result = parsePythonResult<PythonResult>(stdout)
      } catch (error) {
        throw new Error(`Failed to parse python result from ${pythonCommand}: ${error}\nRaw output:\n${stdout}\nStderr:\n${stderr}`)
      }
      result.resolved_python_executable = pythonCommand
    }
    const effectiveRunId = inferRunId({
      requestedRunId: result.run_id ?? runId,
      stage: sourceStage,
    })
    result.run_id = effectiveRunId
    if (sourceFingerprint && result.action === "import" && datasetManifest) {
      upsertDatasetIndexEntry({
        datasetId: datasetManifest.datasetId,
        sourcePath: datasetManifest.sourcePath,
        fingerprint: sourceFingerprint,
      })
    }
    const formatIgnoredForStage =
      isStageProducingAction(params.action) && params.format !== undefined && params.format !== "parquet"
        ? `Ignored format=${params.format}. Canonical stage outputs always use parquet.`
        : undefined

    if (!result.success) {
      const reflection = classifyToolFailure({
        toolName: "data_import",
        error: result.error ?? "unknown error",
        input: {
          action: params.action,
          inputPath: params.inputPath,
          datasetId: params.datasetId,
          stageId: params.stageId,
        },
        sessionId: ctx.sessionID,
      })
      const reflectionPath = persistToolReflection(reflection)
      await ctx.metadata({
        metadata: {
          reflection: {
            ...reflection,
            reflectionPath: relativeWithinProject(reflectionPath),
          },
        },
      })
      let message = `Data operation failed: ${result.error ?? "unknown error"}`
      if (result.resolved_python_executable) message += `\nPython interpreter: ${result.resolved_python_executable}`
      if (result.error_log_path) message += `\nError log: ${relativeWithinProject(result.error_log_path)}`
      message += `\nReflection log: ${relativeWithinProject(reflectionPath)}`
      if (result.install_command) message += `\nInstall command: ${result.install_command}`
      if (result.traceback) message += `\n${result.traceback}`
      throw new Error(message)
    }

    const qaGate = evaluateQaGate({
      toolName: "data_import",
      qaSource: params.action === "qa" ? "qa_report" : "data_import_result",
      warnings: result.warnings,
      blockingErrors: result.blocking_errors,
      input: {
        action: params.action,
        inputPath: params.inputPath,
        datasetId: params.datasetId,
        stageId: params.stageId,
      },
      sessionId: ctx.sessionID,
    })

    if (qaGate.reflection) {
      const reflectionPath = persistToolReflection(qaGate.reflection)
      await ctx.metadata({
        metadata: {
          reflection: {
            ...qaGate.reflection,
            reflectionPath: relativeWithinProject(reflectionPath),
          },
        },
      })
      throw new Error(
        `Data operation blocked by QA gate: ${qaGate.qaGateReason}\nReflection log: ${relativeWithinProject(reflectionPath)}`,
      )
    }

    let numericSnapshot: NumericSnapshotDocument | undefined
    if (params.action === "describe" && result.output_path) {
      numericSnapshot = createDescribeNumericSnapshot({
        csvPath: result.output_path,
        datasetId: result.dataset_id ?? datasetManifest?.datasetId,
        stageId: result.stage_id ?? params.stageId ?? sourceStage?.stageId,
        runId: effectiveRunId,
      })
      result.numeric_snapshot_path = numericSnapshot.snapshotPath
    }
    if (params.action === "correlation" && result.output_path) {
      numericSnapshot = createCorrelationNumericSnapshot({
        csvPath: result.output_path,
        datasetId: result.dataset_id ?? datasetManifest?.datasetId,
        stageId: result.stage_id ?? params.stageId ?? sourceStage?.stageId,
        runId: effectiveRunId,
      })
      result.numeric_snapshot_path = numericSnapshot.snapshotPath
    }

    const publishedFiles: Array<{ label: string; relativePath: string }> = []
    const deliveryBundlePath: string | undefined = undefined

    if (datasetManifest) {
      if (params.action === "import" || params.action === "filter" || params.action === "preprocess" || params.action === "rollback") {
        if (params.action === "import" && reusedImportStage) {
          // Reused imports keep the existing canonical stage and only refresh the dataset index.
        } else {
        appendStage(datasetManifest, {
          stageId: result.stage_id ?? stageId ?? "stage_000",
          runId: effectiveRunId,
          parentStageId: result.parent_stage_id ?? parentStageId,
          branch: result.branch ?? branch,
          action: params.action,
          label: params.stageLabel,
          workingPath: result.output_path ?? outputPath,
          workingFormat: "parquet",
          rowCount: result.rows_after,
          columnCount: result.columns_after,
          schemaPath: result.schema_path ?? schemaPath,
          labelsPath: result.labels_path ?? labelsPath,
          summaryPath: result.summary_path ?? summaryPath,
          logPath: result.log_path ?? logPath,
          inspectionPath: result.inspection_path ?? inspectionPath,
          inspectionWorkbookPath: result.inspection_workbook_path ?? inspectionWorkbookPath,
          createdAt: new Date().toISOString(),
          metadata: {
            runId: effectiveRunId,
            sourceFormat: datasetManifest.sourceFormat,
            ...(sourceFingerprint ? { sourceFingerprint: sourceFingerprint.key } : {}),
            ...(formatIgnoredForStage ? { format_note: formatIgnoredForStage } : {}),
          },
        })
        }
      } else {
        appendArtifact(datasetManifest, {
          artifactId: `${params.action}_${Date.now()}`,
          runId: effectiveRunId,
          stageId: params.stageId ?? sourceStage?.stageId,
          branch,
          action: params.action,
          outputPath: result.output_path ?? outputPath,
          workbookPath: result.workbook_path,
          summaryPath: result.summary_path,
          logPath: result.log_path,
          createdAt: new Date().toISOString(),
          metadata: {
            runId: effectiveRunId,
            numeric_snapshot_path: result.numeric_snapshot_path,
            warnings: result.warnings,
            blocking_errors: result.blocking_errors,
            suggested_repairs: result.suggested_repairs,
          },
        })
      }

    }
    let output = `## Data ${params.action} completed\n\n`
    if (result.dataset_id) output += `Dataset: ${result.dataset_id}\n`
    if (datasetManifest || result.dataset_id || params.runId) output += `Run ID: ${effectiveRunId}\n`
    if (result.stage_id) output += `Stage: ${result.stage_id}\n`
    if (result.parent_stage_id) output += `Parent stage: ${result.parent_stage_id}\n`
    if (result.branch) output += `Branch: ${result.branch}\n`
    if (result.input_path) output += `Input: ${relativeWithinProject(result.input_path)}\n`
    if (result.output_path) output += `Output: ${relativeWithinProject(result.output_path)}\n`
    if (result.workbook_path) output += `Workbook: ${relativeWithinProject(result.workbook_path)}\n`
    if (result.inspection_path) output += `Inspection CSV: ${relativeWithinProject(result.inspection_path)}\n`
    if (result.inspection_workbook_path) output += `Inspection workbook: ${relativeWithinProject(result.inspection_workbook_path)}\n`
    if (result.rows_before !== undefined && result.columns_before !== undefined) {
      output += `Before: ${result.rows_before} rows x ${result.columns_before} columns\n`
    }
    if (result.rows_after !== undefined && result.columns_after !== undefined) {
      output += `After: ${result.rows_after} rows x ${result.columns_after} columns\n`
    }
    if (result.summary_path) output += `Summary JSON: ${relativeWithinProject(result.summary_path)}\n`
    if (result.log_path) output += `Audit log: ${relativeWithinProject(result.log_path)}\n`
    if (result.numeric_snapshot_path) output += `Numeric snapshot: ${relativeWithinProject(result.numeric_snapshot_path)}\n`
    if (formatIgnoredForStage) output += `Format note: ${formatIgnoredForStage}\n`
    if (deliveryBundlePath && publishedFiles.length) output += `Delivery bundle: ${relativeWithinProject(deliveryBundlePath)}\n`
    if (publishedFiles.length) {
      output += `Published files:\n`
      for (const item of publishedFiles) output += `- ${item.relativePath}\n`
    }

    if (params.action === "import" && result.column_info) {
      output += `\nColumn types:\n`
      if (result.column_info.Numeric?.length) output += `- Numeric: ${result.column_info.Numeric.length}\n`
      if (result.column_info.Category?.length) output += `- Category: ${result.column_info.Category.length}\n`
      if (result.column_info.Datetime?.length) output += `- Datetime: ${result.column_info.Datetime.length}\n`
    }

    if (params.action === "preprocess") {
      output += `\nPreprocess operations: ${result.operations_count ?? 0}\n`
      if (result.missing_before && result.missing_after) {
        output += `Missingness tracked for ${Object.keys(result.missing_after).length} variables\n`
      }
    }

    if (params.action === "filter") {
      output += `\nFilter rules: ${result.filters_count ?? 0}\n`
    }

    if (params.action === "describe" || params.action === "correlation") {
      output += `\nVariables: ${(result.variables ?? []).join(", ")}\n`
    }

    if (params.action === "qa") {
      output += `\nQA status: ${result.status ?? "unknown"}\n`
      if (result.warnings?.length) output += `Warnings: ${result.warnings.join(" | ")}\n`
      if (result.blocking_errors?.length) output += `Blocking errors: ${result.blocking_errors.join(" | ")}\n`
      if (result.suggested_repairs?.length) output += `Suggested repairs: ${result.suggested_repairs.join(" | ")}\n`
    }
    if (qaGate.qaGateStatus === "warn") {
      output += `QA gate: warn\n`
      if (qaGate.qaGateReason) output += `QA gate reason: ${qaGate.qaGateReason}\n`
    }

    if (params.action === "healthcheck") {
      output += `\nEnvironment status: ${result.status ?? "unknown"}\n`
      if (result.module_status) {
        output += `Modules:\n`
        for (const [name, ok] of Object.entries(result.module_status)) {
          output += `- ${name}: ${ok ? "ok" : "missing"}\n`
        }
      }
      if (result.install_command) output += `Install command: ${result.install_command}\n`
    }

    if (ctx.agent === "explorer" && result.success) {
      AnalysisIntent.markExplorerPrepared(ctx.sessionID, {
        action: params.action,
        datasetId: result.dataset_id ?? datasetManifest?.datasetId,
        stageId: result.stage_id ?? params.stageId ?? sourceStage?.stageId,
        runId: effectiveRunId,
        branch,
      })
    }

    return {
      title: `Data ${params.action}`,
      output,
      metadata: {
        action: params.action,
        result,
        datasetId: result.dataset_id ?? datasetManifest?.datasetId,
        stageId: result.stage_id ?? params.stageId ?? sourceStage?.stageId,
        runId: effectiveRunId,
        numericSnapshotPath: result.numeric_snapshot_path ? relativeWithinProject(result.numeric_snapshot_path) : undefined,
        numericSnapshotPreview: numericSnapshotPreview(numericSnapshot),
        groundingScope:
          params.action === "describe" ? "descriptive" : params.action === "correlation" ? "correlation" : undefined,
        qaGateStatus: qaGate.qaGateStatus,
        qaGateReason: qaGate.qaGateReason,
        qaSource: qaGate.qaSource,
        deliveryBundleDir: deliveryBundlePath ? relativeWithinProject(deliveryBundlePath) : undefined,
        publishedFiles,
        finalOutputsPath:
          publishedFiles.length ? relativeWithinProject(finalOutputsPath(result.input_path ?? params.inputPath ?? outputPath, effectiveRunId)) : undefined,
        internalFinalOutputsPath:
          publishedFiles.length ? relativeWithinProject(finalOutputsPath(result.input_path ?? params.inputPath ?? outputPath, effectiveRunId)) : undefined,
        presentation: buildDataImportPresentation({
          action: params.action,
          result,
          qaGate,
          publishedFiles,
          deliveryBundlePath,
        }),
        analysisView: createToolAnalysisView({
          kind: "data_import",
          foundInputFile: params.action === "import" ? analysisInputFile(result.input_path) : undefined,
          step: `data_import(${params.action})`,
          datasetId: result.dataset_id ?? datasetManifest?.datasetId,
          stageId: result.stage_id ?? params.stageId ?? sourceStage?.stageId,
          results: [
            analysisMetric(
              "行数变化",
              result.rows_before !== undefined && result.rows_after !== undefined
                ? `${result.rows_before} -> ${result.rows_after}`
                : undefined,
            ),
            analysisMetric(
              "列数变化",
              result.columns_before !== undefined && result.columns_after !== undefined
                ? `${result.columns_before} -> ${result.columns_after}`
                : undefined,
            ),
            analysisMetric("QA 状态", params.action === "qa" ? qaGate.qaGateStatus ?? result.status : undefined),
          ],
          artifacts: [
            ...publishedFiles.map((item) =>
              analysisArtifact(item.relativePath, {
                label: item.label,
                visibility: "user_collapsed",
              }),
            ),
            analysisArtifact(result.numeric_snapshot_path ? relativeWithinProject(result.numeric_snapshot_path) : undefined, {
              visibility: "user_default",
            }),
          ],
          warnings: buildDataImportWarnings({ result, qaGate }),
        }),
        display: createToolDisplay({
          summary:
            params.action === "qa"
              ? `data_import(qa) completed with status ${result.status ?? qaGate.qaGateStatus ?? "unknown"}`
              : params.action === "describe" || params.action === "correlation"
                ? `data_import(${params.action}) completed for ${(result.variables ?? []).length} variables`
                : result.rows_after !== undefined
                  ? `data_import(${params.action}) completed: ${result.rows_after} rows after processing`
                  : `data_import(${params.action}) completed`,
          details: [
            result.dataset_id ? `Dataset: ${result.dataset_id}` : undefined,
            result.stage_id ? `Stage: ${result.stage_id}` : undefined,
            result.rows_before !== undefined && result.rows_after !== undefined
              ? `Rows: ${result.rows_before} -> ${result.rows_after}`
              : undefined,
            result.columns_before !== undefined && result.columns_after !== undefined
              ? `Columns: ${result.columns_before} -> ${result.columns_after}`
              : undefined,
            params.action === "qa" ? `QA gate: ${qaGate.qaGateStatus}` : undefined,
            result.warnings?.length ? `Warnings: ${result.warnings.join(" | ")}` : undefined,
            result.blocking_errors?.length ? `Blocking errors: ${result.blocking_errors.join(" | ")}` : undefined,
          ],
          artifacts: [
            ...publishedFiles.map((item) => ({
              label: item.label,
              path: item.relativePath,
              visibility: "user_collapsed" as const,
            })),
            ...(result.numeric_snapshot_path
              ? [
                  {
                    label: "numeric_snapshot",
                    path: relativeWithinProject(result.numeric_snapshot_path),
                    visibility: "user_collapsed" as const,
                  },
                ]
              : []),
          ],
        }),
      },
    }
  },
})


