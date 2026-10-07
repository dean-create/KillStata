import * as fs from "fs"
import * as path from "path"
import DESCRIPTION from "../data-import.txt"
import { Instance } from "../../project/instance"
import { Log } from "../../util/log"
import { Tool } from "../tool"
import { ToolModel } from "../model-contracts"
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
  inferBranch,
  latestImportStageForFingerprint,
  projectInternalRoot,
  sheetSelectionKey,
  nextStageId,
  getStage,
  projectHealthRoot,
  readDatasetManifest,
  reportOutputPath,
  resolveArtifactInput,
  stageMetaPaths,
  stageOutputPath,
  upsertDatasetIndexEntry,
  datasetRoot,
  readDatasetIndex,
  writeDatasetIndex,
  writeDatasetManifest,
  ensureSourceAsset,
  writeImportReceipt,
} from "../analysis-state"
import { classifyToolFailure, evaluateQaGate, persistToolReflection } from "../analysis-reflection"
import {
  createCorrelationNumericSnapshot,
  createDescribeNumericSnapshot,
  type NumericSnapshotDocument,
} from "../analysis-grounding"
import { relativeWithinProject, resolveDatasetStagePath, resolveManagedProjectPath, resolveToolPath } from "../analysis-path"
import {
  artifactGroup,
  createPresentation,
  derivePresentationStatus,
  presentationArtifact,
  presentationMetric,
  type ToolPresentation,
} from "../analysis-presentation"
import { numericSnapshotPreview } from "../analysis-tool-metadata"
import { createToolDisplay } from "../analysis-display"
import { analysisArtifact, analysisMetric, createToolAnalysisView, importDisplayFile } from "../analysis-user-view"
import { ensureRuntimePythonReady, econometricsEngineRoot, formatRuntimePythonSetupError } from "@/killstata/runtime-config"
import { sessionEconometricsEngine } from "@/runtime/services/econometrics-engine-client"
import { linkDatasetToConversation } from "@/session/dataset-origin"
import { DataContext } from "@/session/data-context"
import { formatDataReadinessForModel, type DataReadinessReport } from "@/runtime/data-readiness"
import { pythonCapabilityInput } from "../python-capability-schema"

// ── 拆自本 God Module 的独立子模块 ──
import {
  looksLikeMojibake,
  schemaLooksLikeMojibake,
  shouldReuseImportStage,
  buildDataImportWarnings,
  requireResolvableInput,
  isStageProducingAction,
  effectiveOutputFormat,
} from "./import-runner"
import {
  type DataAction,
  type PythonResult,
} from "./schema"

// ── 向下游保持兼容的 re-export ──
export { isStageProducingAction } from "./import-runner"
export type { DataAction } from "./schema"
export { schemaLooksLikeMojibake } from "./import-runner"

const log = Log.create({ service: "data-import-tool" })
const DataImportInputSchema = pythonCapabilityInput<Record<string, any>>()

function assertEnginePathMatches(input: {
  actual: unknown
  expected: string
  label: string
  managedRoot?: string
}) {
  if (input.actual === undefined || input.actual === null) return undefined
  if (typeof input.actual !== "string" || !input.actual.trim()) {
    throw new Tool.InputValidationError(`Python 引擎返回的${input.label}路径格式无效。`)
  }
  const actual = input.managedRoot
    ? resolveManagedProjectPath({ filePath: input.actual, managedRoot: input.managedRoot })
    : path.resolve(input.actual)
  const expected = input.managedRoot
    ? resolveManagedProjectPath({ filePath: input.expected, managedRoot: input.managedRoot })
    : path.resolve(input.expected)
  if (actual !== expected) throw new Tool.InputValidationError(`Python 引擎返回的${input.label}路径与 Harness 预定目标不一致。`)
  return actual
}

function requireEnginePath(payload: Record<string, unknown>, fields: readonly string[], label: string, context = "导入") {
  for (const field of fields) {
    const value = payload[field]
    if (typeof value === "string" && value.trim()) return value
  }
  throw new Tool.InputValidationError(`Python 引擎${context}响应缺少${label}路径。`)
}

function requireRegularFile(filePath: string, label: string) {
  try {
    if (fs.statSync(filePath).isFile()) return
  } catch {
    // 用统一的中文契约错误呈现缺文件或不可访问路径。
  }
  throw new Tool.InputValidationError(`Python 引擎导入结果文件不存在或不可读取：${label}。`)
}

export function validateImportEngineResponse(input: {
  payload: Record<string, unknown>
  expectedInputPath: string
  expectedDataPath: string
  expectedSchemaPath: string
  expectedResultPath: string
  managedRoot: string
}) {
  if (input.payload.success !== true) {
    throw new Tool.InputValidationError("Python 引擎没有确认数据导入成功；当前未登记数据阶段。")
  }
  const inputPath = requireEnginePath(input.payload, ["input_path", "inputPath"], "导入源数据")
  const dataPath = requireEnginePath(input.payload, ["dataPath", "outputPath", "output_path"], "规范化数据")
  const schemaPath = requireEnginePath(input.payload, ["schemaPath", "schema_path"], "数据 Schema")
  const resultPath = requireEnginePath(input.payload, ["resultPath", "result_path"], "导入结果")
  const verifiedInputPath = assertEnginePathMatches({
    actual: inputPath,
    expected: input.expectedInputPath,
    managedRoot: projectInternalRoot(),
    label: "导入源数据",
  })!
  const verifiedDataPath = assertEnginePathMatches({ actual: dataPath, expected: input.expectedDataPath, managedRoot: input.managedRoot, label: "规范化数据" })!
  const verifiedSchemaPath = assertEnginePathMatches({ actual: schemaPath, expected: input.expectedSchemaPath, managedRoot: input.managedRoot, label: "数据 Schema" })!
  const verifiedResultPath = assertEnginePathMatches({ actual: resultPath, expected: input.expectedResultPath, managedRoot: input.managedRoot, label: "导入摘要" })!
  requireRegularFile(verifiedInputPath, "导入源数据")
  requireRegularFile(verifiedDataPath, "规范化数据")
  requireRegularFile(verifiedSchemaPath, "数据 Schema")
  requireRegularFile(verifiedResultPath, "导入摘要")
  return { inputPath: verifiedInputPath, dataPath: verifiedDataPath, schemaPath: verifiedSchemaPath, resultPath: verifiedResultPath }
}

export function validateDataActionEngineResponse(input: {
  action: string
  payload: Record<string, unknown>
  expectedOutputPath: string
  expectedResultPath: string
  managedRoot?: string
}) {
  if (input.payload.success !== true) {
    throw new Tool.InputValidationError(`Python 引擎没有确认数据${input.action}成功；没有登记结果产物。`)
  }
  const outputPath = requireEnginePath(
    input.payload,
    ["output_path", "outputPath", "dataPath"],
    `${input.action}输出`,
    input.action,
  )
  const resultPath = requireEnginePath(
    input.payload,
    ["resultPath", "result_path"],
    "结果记录",
    input.action,
  )
  const verifiedOutputPath = assertEnginePathMatches({
    actual: outputPath,
    expected: input.expectedOutputPath,
    managedRoot: input.managedRoot,
    label: `${input.action} 输出`,
  })!
  const verifiedResultPath = assertEnginePathMatches({
    actual: resultPath,
    expected: input.expectedResultPath,
    managedRoot: input.managedRoot,
    label: `${input.action} 结果记录`,
  })!
  for (const [filePath, label] of new Map([
    [verifiedOutputPath, `${input.action}输出`],
    [verifiedResultPath, `${input.action}结果记录`],
  ])) requireRegularFile(filePath, label)
  return { outputPath: verifiedOutputPath, resultPath: verifiedResultPath }
}

export function validateEngineAncillaryPaths(input: {
  payload: Record<string, unknown>
  expectedPaths: Record<string, string | undefined>
  managedRoot?: string
}) {
  const labels: Record<string, string> = {
    schemaPath: "数据 Schema",
    schema_path: "数据 Schema",
    labelsPath: "变量标签",
    labels_path: "变量标签",
    summaryPath: "数据摘要",
    summary_path: "数据摘要",
    logPath: "数据操作日志",
    log_path: "数据操作日志",
    inspectionPath: "数据检查报告",
    inspection_path: "数据检查报告",
    inspectionWorkbookPath: "数据检查工作簿",
    inspection_workbook_path: "数据检查工作簿",
  }
  for (const [field, label] of Object.entries(labels)) {
    const actual = input.payload[field]
    if (actual === undefined || actual === null) continue
    const expected = input.expectedPaths[field]
    if (!expected) throw new Tool.InputValidationError(`Python 引擎返回了没有 Harness 预定目标的${label}路径。`)
    assertEnginePathMatches({ actual, expected, managedRoot: input.managedRoot, label })
  }
}

function pathIsWithinRoot(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * 频数诊断允许极少数无歧义的自然语言列名对齐，但只在 profile 同时返回对应
 * 的真实列名时生效。例如模型把 `年份` 作为分组列，而当前 schema 明确有
 * `year`，就使用真实列名执行；不做任意模糊匹配，避免把相近列名静默换错。
 */
export function resolveFrequencyGroupBy(groupBy: readonly string[] | undefined, variables: readonly string[] | undefined): string[] {
  const available = new Set(variables ?? [])
  const aliases: Record<string, string> = {
    "年份": "year",
    "时间": "year",
    "省份": "province",
    "地区": "region",
  }
  return (groupBy ?? []).map((column) => {
    const canonical = aliases[column]
    return canonical && available.has(canonical) ? canonical : column
  })
}

/**
 * 将模型常见的展示名称对齐到当前 stage 的真实列名。
 *
 * 只处理产品明确维护、且目标列在 readiness 中唯一存在的别名；未知列仍原样交给
 * 后端报错。这样可以自动修复“年份”→“year”这类无损输入错误，但不会把相近变量
 * 静默替换成另一个研究变量。
 */
export function resolveKnownColumnNames(
  names: readonly string[] | undefined,
  availableColumns: readonly string[] | undefined,
) {
  const available = new Set(availableColumns ?? [])
  const aliases: Record<string, string> = {
    "年份": "year",
    "时间": "time",
  }
  const corrections: Array<{ from: string; to: string }> = []
  const resolved = (names ?? []).map((name) => {
    if (available.has(name)) return name
    const alias = aliases[name]
    if (!alias || !available.has(alias)) return name
    corrections.push({ from: name, to: alias })
    return alias
  })
  return { names: resolved, corrections }
}

/**
 * 将模型误写/遗漏的数据集 ID 对齐到当前会话唯一的数据集。
 * 会话有多个数据集时保持原值，交给严格血缘校验和用户选择，绝不猜测切换对象。
 */
export function resolveSessionDatasetID(requested: string | undefined, sessionDatasetIDs: readonly string[]) {
  const available = [...new Set(sessionDatasetIDs.filter((id) => id.trim()))]
  if (requested && available.includes(requested)) return { datasetID: requested }
  if (available.length !== 1) return { datasetID: requested }
  return requested ? { datasetID: available[0]!, correctedFrom: requested } : { datasetID: available[0]! }
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
  const 列After = result.columns_after
  const rowsBefore = result.rows_before
  const rowDelta = rowsBefore !== undefined && rowsAfter !== undefined ? Math.abs(rowsBefore - rowsAfter) : undefined
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
      rowsAfter !== undefined && 列After !== undefined
        ? `已导入 ${rowsAfter} 行、${列After} 列数据，并转成可继续处理的工作格式。`
        : "原始数据已导入，并转成后续可直接处理的工作格式。"
    summary = [
      "我已经保留了原始数据的结构信息，并生成了可核对的检查表。",
      "接下来可以先做质量检查、描述统计或开始清洗。",
    ]
    highlights = ["数据已就绪，可直接进入下一步分析。"].filter(Boolean) as string[]
    nextActions = ["先查看检查表，确认变量名、缺失值和异常值。", "如果数据无误，再进入筛选、清洗或描述统计。"]
    if (result.autoQa?.status === "block") {
      highlights = ["文件已保存，但自动检查发现阻断项；当前暂不能估计。"]
      nextActions = ["先查看自动 数据质量检查 的阻断原因并修复数据。", "修复后重新执行当前阶段的画像/数据质量检查，再继续计量分析。"]
    } else if (result.autoQa?.status === "warn") {
      highlights = ["文件已保存，自动检查有提醒项；是否影响估计需要结合模型规格确认。"]
      nextActions = ["先查看提醒项，再决定是否进入清洗或计量分析。"]
    }
  } else if (action === "profile") {
    title = "描述统计"
    headline = `描述统计已完成，${(result.variables ?? []).length} 个变量的概览已经准备好。`
    summary = ["这一步更适合先帮助你判断变量分布是否合理。", "如果均值、极值或缺失情况异常，建议先回到清洗阶段。"]
    nextActions = ["先看描述统计表。", "确认变量分布合理后，再进入回归或因果分析。"]
  } else if (action === "validate") {
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
        ? ["先修复阻塞问题，再重新运行质量检查。", "不要直接跳过 数据质量检查 进入建模。"]
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
      rowsAfter !== undefined && 列After !== undefined
        ? `这一步处理后，当前数据为 ${rowsAfter} 行、${列After} 列。`
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
      presentationMetric("当前列数", 列After),
      presentationMetric(
        "变动行数",
        rowDelta,
        rowDelta && rowDelta > 0 ? { tone: "caution" } : undefined,
      ),
      presentationMetric("变量数", result.variables?.length),
      presentationMetric("数据质量状态", result.status ?? qaGate.qaGateStatus),
    ],
    highlights,
    risks,
    nextActions,
    artifactGroups: [
      artifactGroup("核心数据", [
        presentationArtifact("当前阶段数据", result.output_path),
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

/** 超过这个列数就按类型截断，避免宽表把变量名铺满模型上下文。 */
const IMPORT_COLUMN_INVENTORY_THRESHOLD = 80
const IMPORT_COLUMN_INVENTORY_PER_TYPE = 30

const READINESS_TYPE_LABEL: Record<string, string> = {
  numeric: "数值型",
  categorical: "类别型",
  datetime: "时间型",
  other: "其他",
}

/**
 * 导入后直接给出变量名清单，让模型一次就能判断可用的计量方法，不必再补一次 profile。
 *
 * 数据源是 readiness.columns 而不是 result.column_info：后者在 JSON 超 2000 字符时会把
 * Numeric 截成 5 个再塞一个假列名 "Too many cols, omission here..."（python/econometrics/
 * data_preprocess.py:99），直接印出去会让模型把这句话当成真实列名。
 */
function formatImportColumnInventory(report: DataReadinessReport | undefined): string {
  const columns = report?.columns
  if (!columns?.length) return ""
  const grouped = new Map<string, string[]>()
  for (const column of columns) {
    const label = READINESS_TYPE_LABEL[column.type] ?? "其他"
    grouped.set(label, [...(grouped.get(label) ?? []), column.name])
  }
  const truncate = columns.length > IMPORT_COLUMN_INVENTORY_THRESHOLD
  const lines = [`变量（共 ${columns.length} 个）：`]
  for (const label of ["数值型", "类别型", "时间型", "其他"]) {
    const names = grouped.get(label)
    if (!names?.length) continue
    const shown = truncate ? names.slice(0, IMPORT_COLUMN_INVENTORY_PER_TYPE) : names
    const omitted = names.length - shown.length
    lines.push(`- ${label}(${names.length})：${shown.join(", ")}${omitted > 0 ? ` …其余 ${omitted} 个` : ""}`)
  }
  if (truncate) lines.push("变量较多已按类型截断；需要完整清单时对当前 stage 执行 profile。")
  return lines.join("\n")
}

/**
 * 导入结果的前部质量快照：工具结果可能被模型侧按 2K 预览，质量体检仍必须能在
 * 预览中得到有界结论，不能逼模型读取外部化元数据或把 zscore_detect 当成必经清洗。
 */
function formatQualitySnapshot(
  report: DataReadinessReport | undefined,
  autoQa: PythonResult["autoQa"] | undefined,
) {
  if (!report && !autoQa) return ""
  const lines = ["质量体检摘要（有界事实，可直接用于回答质量问题）："]
  if (autoQa?.status) {
    lines.push(`- 自动质量状态：${autoQa.status === "block" ? "阻断" : autoQa.status === "warn" ? "警告（不阻断）" : "通过"}`)
  }
  if (report?.columns.length) {
    const shownColumns = report.columns.slice(0, 40).map((column) => column.name)
    const omitted = report.columns.length - shownColumns.length
    lines.push(`- 变量：${shownColumns.join("、")}${omitted > 0 ? `；其余${omitted}个变量可在明确要求画像时查看` : ""}`)
  }
  const missing = report?.columns
    .filter((column) => column.missingCount > 0)
    .slice(0, 8)
    .map((column) => `${column.name}缺失${column.missingCount}行`)
  lines.push(`- 缺失：${missing?.length ? missing.join("、") : "未发现缺失"}`)
  const uniquePanel = report?.panelCandidates
    .filter((candidate) => candidate.unique && candidate.entityMissingCount === 0 && candidate.timeMissingCount === 0)
    .slice(0, 3)
    .map((candidate) => `${candidate.entityVars.join("+")}×${candidate.timeVar}`)
  lines.push(`- 面板键重复：${uniquePanel?.length ? `已验证${uniquePanel.join("、")}唯一` : "当前没有完整唯一面板键证据"}`)
  const outlierWarning = autoQa?.warnings?.find((warning) => /异常值|极端值/.test(warning))
  if (outlierWarning) lines.push(`- 异常值：${outlierWarning.slice(0, 420)}`)
  lines.push("- 以上摘要已足够支持有界质量结论；用户未要求清洗时不要自动进入数据预处理。")
  return lines.join("\n")
}

/**
 * 给展示层的单行质量事实：质量体检的模型收尾可能为空，结构化兜底仍要一次性
 * 交付缺失、重复键和异常值三类结论。这里不推断数据来源，也不把“没有完整面板键
 * 证据”误写成“没有重复”。
 */
function formatQualityFacts(
  report: DataReadinessReport | undefined,
  autoQa: PythonResult["autoQa"] | undefined,
) {
  const facts: string[] = []
  if (report) {
    const missing = report.columns
      .filter((column) => column.missingCount > 0)
      .slice(0, 6)
      .map((column) => `${column.name}缺失${column.missingCount}行`)
    facts.push(`缺失：${missing.length ? missing.join("、") : "未发现缺失"}`)

    const duplicateCandidates = report.panelCandidates.filter((candidate) => candidate.duplicateRows > 0)
    const verified = report.panelCandidates
      .filter((candidate) => candidate.unique && candidate.entityMissingCount === 0 && candidate.timeMissingCount === 0)
      .slice(0, 3)
      .map((candidate) => `${candidate.entityVars.join("+")}×${candidate.timeVar}`)
    if (verified.length) {
      const duplicateNote = duplicateCandidates.length
        ? `；其他候选键有重复（${duplicateCandidates.slice(0, 3).map((candidate) => `${candidate.entityVars.join("+")}×${candidate.timeVar}：${candidate.duplicateRows}行`).join("、")}），这不等于整行重复`
        : ""
      facts.push(`重复检查：已验证${verified.join("、")}唯一${duplicateNote}`)
    } else if (duplicateCandidates.length) {
      facts.push(`重复键候选：${duplicateCandidates.slice(0, 3).map((candidate) => `${candidate.entityVars.join("+")}×${candidate.timeVar}有${candidate.duplicateRows}行`).join("、")}；这不等于整行重复`)
    } else if (report.panelCandidates.length) {
      facts.push("重复检查：暂未发现完整唯一面板键证据，不能据此断言没有重复")
    } else {
      facts.push("重复键检查：暂无完整面板键证据，不能据此断言没有重复")
    }
  }

  const outlier = autoQa?.warnings?.find((warning) => /异常值|极端值/.test(warning))
  const outlierColumns = outlier
    ? [...outlier.matchAll(/['“”]([^'“”]+)['“”]/g)].map((match) => match[1]).filter(Boolean)
    : []
  const outlierFact = outlierColumns.length
    ? `检测到潜在异常值列：${outlierColumns.slice(0, 8).join("、")}${outlierColumns.length > 8 ? `等${outlierColumns.length}列` : ""}`
    : outlier?.slice(0, 180) ?? "未发现自动异常值提醒"
  facts.push(`异常值：${outlierFact}`)
  return facts.length ? `质量检查事实：${facts.join("；")}` : undefined
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

  if (!inputPath) throw new Error(`数据动作 ${params.action} 必须提供 inputPath。`)

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
      params.format === "xlsx"
        ? ".xlsx"
        : params.format === "dta"
          ? ".dta"
          : params.format === "parquet"
            ? ".parquet"
            : ".csv"
    return path.join(dirname, `${basename}${targetExt}`)
  }

  if (params.action === "profile") return path.join(projectHealthRoot(), `${basename}_summary_${stamp}.xlsx`)
  if (params.action === "correlation" || params.action === "frequency") return path.join(projectHealthRoot(), `${basename}_${params.action}_${stamp}.xlsx`)
  if (params.action === "validate") return path.join(projectHealthRoot(), `${basename}_validate_${stamp}.json`)
  if (params.action === "rollback") return path.join(dirname, `${basename}_restored.parquet`)

  return path.join(dirname, `${basename}_output.parquet`)
}

/**
 * 元数据只给后续编排复用的有界就绪摘要；完整报告已经写入 stage metadata/summary 文件。
 * 不把候选方法的重复修复说明复制进 metadata，否则一个大工作簿会挤掉既有的 result 行列数。
 */
function compactDataReadinessForMetadata(report: DataReadinessReport | undefined) {
  if (!report) return undefined
  return {
    ...report,
    // 详细列画像已经保存在 stage metadata/summary；模型侧只需要保留方法判断所需的
    // 关系、面板候选和候选方法，避免 data_import 的既有 result 字段被大报告挤掉。
    columns: [],
    panelCandidates: report.panelCandidates.slice(0, 12),
    exactLinearDependencies: report.exactLinearDependencies.slice(0, 4),
    candidateMethods: report.candidateMethods.slice(0, 32).map((method) => ({
      ...method,
      repairSuggestions: [],
    })),
    warnings: report.warnings.slice(0, 12),
  } satisfies DataReadinessReport
}

function sanitizeDeliveryFilePart(value: string) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
}

function stageDeliveryDescription(params: {
  action: DataAction
  stageLabel?: string
  rollbackStageId?: string
}) {
  if (params.stageLabel?.trim()) {
    return sanitizeDeliveryFilePart(params.stageLabel)
  }
  if (params.action === "rollback") {
    return sanitizeDeliveryFilePart(`回滚到${params.rollbackStageId ?? "上一版本"}`)
  }
  return sanitizeDeliveryFilePart(params.action)
}

export const DataImportTool = Tool.define("data_import", Tool.Execution.managedFilesystem, ToolModel.forTool("data_import"), {
  description: DESCRIPTION,
  parameters: DataImportInputSchema,
  async execute(params, ctx) {
    // 统一 attempt ledger 在 SessionProcessor 执行入口计数；工具层不再按 reflection 文件数量
    // 重复扣减预算，避免同一次调用被记成两次失败。
    // 参数校验必须先于任何审批弹窗。否则一个根本无法执行的调用（模型对着"你好"或误触的
    // "1" 瞎调工具、连数据路径都没给）会先弹出执行计划让用户签字，用户点了同意之后才
    // 发现参数缺失——白白打扰一次。先在这里拒绝，模型拿到错误自己重来，用户全程无感。
    requireResolvableInput(params.action, {
      inputPath: params.inputPath,
      datasetId: params.datasetId,
      stageId: params.stageId,
    })

    const pythonStatus = await ensureRuntimePythonReady()
    if (!pythonStatus.ok || pythonStatus.missing.length) {
      throw new Error(formatRuntimePythonSetupError("data_import", pythonStatus))
    }
    const pythonCommand = pythonStatus.executable
    const installCommand = pythonStatus.installCommand

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
    const sessionDatasetResolution = resolveSessionDatasetID(params.datasetId, DataContext.datasetIDs(ctx.sessionID))
    const datasetCorrectionWarning = sessionDatasetResolution.correctedFrom
      ? `已将不属于当前会话的数据集标识 ${sessionDatasetResolution.correctedFrom} 对齐到当前唯一数据集；未改变研究数据。`
      : undefined
    const artifactInput = resolveArtifactInput({
      // import 的事实来源是 inputPath；模型可能把文件名或旧会话 ID 误当成 datasetId，
      // 不应让这个提示触发不存在的 manifest。后续 profile/validate 等动作仍严格要求
      // datasetId/stageId 来自当前会话的工具结果。
      datasetId: params.action === "import" ? undefined : sessionDatasetResolution.datasetID,
      stageId: params.action === "import" ? undefined : params.stageId,
      inputPath: directInputPath,
    })
    let inputPath = artifactInput.resolvedInputPath
    if (inputPath && artifactInput.manifest && params.action !== "import") {
      inputPath = await resolveDatasetStagePath({
        datasetId: artifactInput.manifest.datasetId,
        filePath: inputPath,
        toolName: "data_import",
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        ask: ctx.ask,
      })
    }
    if (inputPath && !fs.existsSync(inputPath)) {
      throw new Error(`找不到输入文件：${inputPath}`)
    }

    let datasetManifest = artifactInput.manifest
    let sourceStage = artifactInput.stage
    let datasetId = params.action === "import" ? undefined : sessionDatasetResolution.datasetID
    let stageId = params.action === "import" ? undefined : params.stageId
    let parentStageId = sourceStage?.stageId
    // 与 runId 同理：分支不一致时以当前阶段的规范分支为准，不把导入直接判失败。
    // 需要新分支必须走显式工作流动作，模型请求里的 branch 在这里只是被忽略。
    const branch = sourceStage
      ? inferBranch({ requestedBranch: undefined, stage: sourceStage })
      : "main"
    // data_import 是数据入口：已有规范阶段时一律以阶段的 runId 为准，忽略请求里的
    // runId，而不是抛“runId 与当前规范化数据阶段不一致”让整次导入失败。守卫的本意是
    // 不让模型创建新运行身份——直接采用规范值同样满足，且不会把用户流程打断。
    const runId = inferRunId({
      requestedRunId: sourceStage ? undefined : params.runId,
      stage: sourceStage,
    })
    let inspectionPath: string | undefined
    let inspectionWorkbookPath: string | undefined
    let schemaPath: string | undefined
    let labelsPath: string | undefined
    let summaryPath: string | undefined
    let logPath: string | undefined
    let importReceiptPath: string | undefined
    let sourceAsset: ReturnType<typeof ensureSourceAsset> | undefined
    // 首次导入时仍需要用上传原路径定位 FilePart；之后由 origin 内的 message/part ID
    // 接管，sourcePath 可以稳定指向 immutable snapshot。
    let conversationSourcePath: string | undefined
    const actionStamp = buildFileStamp()
    let sourceFingerprint =
      directInputPath && params.action === "import" ? fingerprintSourceFile(directInputPath) : undefined
    let reusedImportStage = false
    // 提到外层作用域:跨过 appendArtifact 之后还要 deregister,避免误删成功产物。
    let orphanCleanup: (() => void) | undefined

    if (params.action === "import") {
      const originalSourcePath = inputPath!
      conversationSourcePath = originalSourcePath
      sourceAsset = ensureSourceAsset({ sourcePath: originalSourcePath })
      const reused = findDatasetForSource(originalSourcePath, ctx.sessionID)
      sourceFingerprint = reused.fingerprint
      datasetManifest ??= reused.manifest
      datasetId ??= datasetManifest?.datasetId ?? createDatasetId(originalSourcePath, sourceFingerprint.key, ctx.sessionID)
      // 真实判断"本轮是否新建"：capture createDatasetManifest 之前 datasetManifest 的状态。
      // 仅看 reused.manifest 不够——params.datasetId 可能从更早的 resolveArtifactInput 拉到了
      // 已存在 manifest，那种情形 abort 不该删别人的数据集。
      const manifestExistedBeforeCreate = !!datasetManifest
      datasetManifest ??= createDatasetManifest({
        datasetId,
        sourcePath: sourceAsset.managedPath,
        sourceFormat: sourceAsset.sourceFormat,
        workingFormat: "parquet",
        origin: {
          sessionID: ctx.sessionID,
          importedAt: new Date().toISOString(),
        },
        sourceAsset,
      })
      datasetManifest.sourcePath = sourceAsset.managedPath
      datasetManifest.sourceFormat = sourceAsset.sourceFormat
      datasetManifest.sourceAsset = sourceAsset
      // 后端只能从受管快照读。这样原始桌面文件被移动、覆盖或删除后，导入与 rollback
      // 仍复用同一份不可变字节；findDatasetForSource 仍用 originalSourcePath 的指纹做会话内复用。
      inputPath = sourceAsset.managedPath
      const isFreshImport = !manifestExistedBeforeCreate

      // 中断清理：本轮新建 manifest 时，挂一个 abort 监听——如果用户/系统在
      // appendArtifact 完成前取消，rm 掉本轮创建的 dataset 目录和索引条目，
      // 避免下次会话 verifier 撞 ARTIFACT_MISSING 死循环。复用旧 manifest 的情形
      // 不挂——半成品只属于本 stage，不应清掉已有数据集。
      orphanCleanup = () => {
        try {
          fs.rmSync(datasetRoot(datasetId!), { recursive: true, force: true })
          if (sourceFingerprint) {
            const index = readDatasetIndex()
            let removed = false
            for (const [key, entry] of Object.entries(index.entries)) {
              if (
                entry.datasetId === datasetId &&
                entry.fingerprint.key === sourceFingerprint.key &&
                entry.createdBySessionID === ctx.sessionID
              ) {
                delete index.entries[key]
                removed = true
              }
            }
            if (removed) writeDatasetIndex(index)
          }
        } catch (error) {
          log.warn("failed to clean up orphan import manifest on abort", {
            datasetId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (isFreshImport) {
        // AbortSignal 不重放事件：进入路径时已经 abort 的情况下 addEventListener 永远不会触发，
        // 必须同步跑一次清理并立即放弃本次导入（signal 已触发 → 用户/系统本意就是放弃）。
        if (ctx.abort?.aborted) {
          orphanCleanup()
          throw new Error("数据导入在启动时已被取消")
        }
        if (ctx.abort) {
          ctx.abort.addEventListener("abort", orphanCleanup, { once: true })
        }
      }
      const matchingImportStage = latestImportStageForFingerprint(
        datasetManifest,
        sourceFingerprint.key,
        sheetSelectionKey(params.sheetPolicy),
      )
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
      const stagePaths = stageMetaPaths({
        datasetId: ensuredDatasetId,
        stageId: ensuredStageId,
        action: params.action,
        stamp: actionStamp,
      })
      schemaPath = stagePaths.schemaPath
      labelsPath = stagePaths.labelsPath
      importReceiptPath = stagePaths.importReceiptPath
      summaryPath = stagePaths.summaryPath
      logPath = stagePaths.logPath
    }

    if (params.action === "rollback") {
      if (!datasetManifest) {
        throw new Error("rollback 必须提供 datasetId。")
      }
      if (!params.stageId) {
        throw new Error("rollback 必须提供 stageId。")
      }
      sourceStage = getStage(datasetManifest, params.stageId)
      parentStageId = sourceStage.stageId
      stageId = nextStageId(datasetManifest)
      const stagePaths = stageMetaPaths({
        datasetId: datasetManifest.datasetId,
        stageId,
        action: params.action,
        stamp: actionStamp,
      })
      schemaPath = stagePaths.schemaPath
      labelsPath = stagePaths.labelsPath
      summaryPath = stagePaths.summaryPath
      logPath = stagePaths.logPath
    }

    let outputPath = params.outputPath
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
          : datasetManifest && params.action === "profile"
            ? reportOutputPath({
                datasetId: datasetManifest.datasetId,
                action: "profile",
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
            : datasetManifest && params.action === "validate"
                ? reportOutputPath({
                    datasetId: datasetManifest.datasetId,
                    action: "validate",
                    stageId: params.stageId ?? sourceStage?.stageId,
                    branch,
                    format: "json",
                    stamp: actionStamp,
                  })
                : defaultOutputPath(inputPath, { action: params.action, format: params.format })
    if (!params.outputPath && reusedImportStage && datasetManifest && sourceStage) {
      outputPath = await resolveDatasetStagePath({
        datasetId: datasetManifest.datasetId,
        filePath: sourceStage.workingPath,
        toolName: "data_import",
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        ask: ctx.ask,
      })
    } else if (!params.outputPath && datasetManifest && pathIsWithinRoot(datasetRoot(datasetManifest.datasetId), outputPath)) {
      outputPath = resolveManagedProjectPath({
        filePath: outputPath,
        managedRoot: datasetRoot(datasetManifest.datasetId),
      })
    } else if (!params.outputPath) {
      outputPath = await resolveToolPath({
        filePath: outputPath,
        mode: "write",
        toolName: "data_import",
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        ask: ctx.ask,
      })
    }
    if (params.action === "import" && datasetManifest) {
      const importRoot = datasetRoot(datasetManifest.datasetId)
      for (const output of [
        outputPath,
        path.join(path.dirname(outputPath), "schema.json"),
        path.join(path.dirname(outputPath), "results.json"),
      ]) {
        resolveManagedProjectPath({ filePath: output, managedRoot: importRoot })
      }
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true })

    const readiness = sourceStage?.metadata?.dataReadiness as DataReadinessReport | undefined
    const availableColumns = readiness?.columns?.map((column) => column.name)
    const variableResolution = resolveKnownColumnNames(params.variables, availableColumns)
    const groupResolution = resolveKnownColumnNames(params.groupBy, availableColumns)
    const entityResolution = resolveKnownColumnNames(params.entityVar ? [params.entityVar] : undefined, availableColumns)
    const timeResolution = resolveKnownColumnNames(params.timeVar ? [params.timeVar] : undefined, availableColumns)
    const columnCorrections = [
      ...variableResolution.corrections,
      ...groupResolution.corrections,
      ...entityResolution.corrections,
      ...timeResolution.corrections,
    ].filter(
      (correction, index, all) =>
        all.findIndex((item) => item.from === correction.from && item.to === correction.to) === index,
    )
    const correctionWarning = columnCorrections.length
      ? `已按当前数据字段自动对齐列名：${columnCorrections.map((item) => `${item.from}→${item.to}`).join("、")}；未改变研究变量含义。`
      : undefined

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
        sheet_info: sourceStage.metadata?.sheetInfo as PythonResult["sheet_info"],
        warnings: ["Reused existing import stage because the source file fingerprint is unchanged."],
          readiness: sourceStage.metadata?.dataReadiness as DataReadinessReport | undefined,
          autoQa: sourceStage.metadata?.autoQa as PythonResult["autoQa"],
          diagnosis: sourceStage.metadata?.dataDiagnosis as PythonResult["diagnosis"],
        }
    } else {
      ctx.progress?.({
        message: `正在准备数据${params.action}任务`,
        metadata: { action: params.action, datasetId: datasetManifest?.datasetId ?? datasetId },
      })
      await ctx.ask({
        permission: "bash",
        patterns: [`${pythonCommand} *data*`],
        always: [`${pythonCommand} *data*`],
        metadata: {
          description: `数据处理动作：${params.action}`,
          managedRuntime: true,
        },
      })

      if (params.action === "import" && datasetManifest) {
        const importRoot = datasetRoot(datasetManifest.datasetId)
        if (!inputPath) throw new Tool.InputValidationError("导入阶段缺少受管源文件路径。")
        const sourceAfterConfirmation = resolveManagedProjectPath({ filePath: inputPath, managedRoot: projectInternalRoot() })
        if (sourceAfterConfirmation !== inputPath) {
          throw new Tool.InputValidationError("等待确认期间导入源文件路径发生变化；为避免读取不同文件，操作已取消。")
        }
        for (const managedPath of [outputPath, schemaPath, labelsPath, summaryPath, logPath, importReceiptPath, inspectionPath, inspectionWorkbookPath]) {
          if (managedPath) resolveManagedProjectPath({ filePath: managedPath, managedRoot: importRoot })
        }
      } else {
        if (inputPath) {
          const inputAfterConfirmation = datasetManifest
            ? await resolveDatasetStagePath({
                datasetId: datasetManifest.datasetId,
                filePath: inputPath,
                toolName: "data_import",
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                callID: ctx.callID,
                ask: ctx.ask,
              })
            : await resolveToolPath({
                filePath: inputPath,
                mode: "read",
                toolName: "data_import",
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                callID: ctx.callID,
                ask: ctx.ask,
              })
          if (inputAfterConfirmation !== inputPath) {
            throw new Tool.InputValidationError("等待确认期间数据输入路径发生变化；为避免读取不同文件，操作已取消。")
          }
        }
        if (params.action === "export") {
          const outputAfterConfirmation = await resolveToolPath({
            filePath: outputPath,
            mode: "write",
            toolName: "data_import",
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            ask: ctx.ask,
          })
          if (outputAfterConfirmation !== outputPath) {
            throw new Tool.InputValidationError("等待确认期间导出目标路径发生变化；为避免写入不同位置，操作已取消。")
          }
        } else {
          const managedRoot = datasetManifest && pathIsWithinRoot(datasetRoot(datasetManifest.datasetId), outputPath)
            ? datasetRoot(datasetManifest.datasetId)
            : projectInternalRoot()
          resolveManagedProjectPath({ filePath: outputPath, managedRoot })
        }
      }

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
        variables: variableResolution.names,
        group_by: params.action === "frequency"
          ? resolveFrequencyGroupBy(groupResolution.names, variableResolution.names)
          : groupResolution.names,
        max_distinct: params.options?.maxDistinct ?? 20,
        // 模型未显式传面板身份时，回填 数据质量检查阶段已确立并持久化到 manifest 的 entity/time，
        // 让插值/前向填充等清洗算子拿到分组依据，避免缺参断链与跨个体污染。
        entity_var: entityResolution.names[0] ?? datasetManifest?.panelIdentifiers?.entityVar ?? null,
        time_var: timeResolution.names[0] ?? datasetManifest?.panelIdentifiers?.timeVar ?? null,
        sheet_policy: params.sheetPolicy ?? null,
        options: params.options ?? {},
        install_command: installCommand,
      }

      if (params.action === "import") {
        ctx.progress?.({ message: "正在通过独立计量引擎规范化并导入数据", metadata: { action: params.action } })
        const engine = sessionEconometricsEngine(ctx.sessionID, {
          command: pythonCommand,
          cwd: Instance.directory,
          pythonPath: path.join(econometricsEngineRoot(), "src"),
          methodRoot: path.join(econometricsEngineRoot(), "python"),
        })
        const engineResult = await engine.execute({
          method_id: "data_import",
          data_path: inputPath!,
          output_dir: path.dirname(outputPath),
          arguments: {
            action: "import",
            sheetPolicy: params.sheetPolicy,
          },
          runtime: {
            inputPath,
            outputPath,
            datasetId: datasetManifest?.datasetId ?? datasetId,
            stageId,
            runId,
            branch,
          },
        }, ctx.abort)
        const imported = engineResult.payload as Record<string, any>
        const importRoot = datasetRoot(datasetManifest!.datasetId)
        const expectedSchemaPath = path.join(path.dirname(outputPath), "schema.json")
        const expectedResultPath = path.join(path.dirname(outputPath), "results.json")
        const verifiedPaths = validateImportEngineResponse({
          payload: imported,
          expectedInputPath: inputPath!,
          expectedDataPath: outputPath,
          expectedSchemaPath,
          expectedResultPath,
          managedRoot: importRoot,
        })
        const sourceAfterExecution = resolveManagedProjectPath({
          filePath: verifiedPaths.inputPath,
          managedRoot: projectInternalRoot(),
        })
        if (sourceAfterExecution !== verifiedPaths.inputPath || !fs.statSync(sourceAfterExecution).isFile()) {
          throw new Tool.InputValidationError("数据导入执行期间受管源文件发生变化；当前未登记数据阶段。")
        }
        validateEngineAncillaryPaths({
          payload: imported,
          expectedPaths: {
            schemaPath: expectedSchemaPath,
            schema_path: expectedSchemaPath,
            labelsPath,
            labels_path: labelsPath,
            summaryPath: expectedResultPath,
            summary_path: expectedResultPath,
            logPath,
            log_path: logPath,
            inspectionPath: inspectionPath,
            inspection_path: inspectionPath,
            inspectionWorkbookPath,
            inspection_workbook_path: inspectionWorkbookPath,
          },
          managedRoot: importRoot,
        })
        result = {
          success: true,
          action: "import",
          input_path: verifiedPaths.inputPath,
          output_path: verifiedPaths.dataPath,
          schema_path: verifiedPaths.schemaPath,
          summary_path: verifiedPaths.resultPath,
          rows_before: imported.rows,
          rows_after: imported.rows,
          columns_before: imported.columns,
          columns_after: imported.columns,
          variables: imported.variables ?? [],
          sheet_info: imported.sheet_info,
          readiness: imported.readiness,
          diagnosis: imported.diagnosis,
          schema_normalization: imported.receipt ?? imported.normalization,
          autoQa: imported.autoQa,
          warnings: imported.warnings ?? [],
          run_id: runId,
          dataset_id: datasetId,
          stage_id: stageId,
        }
        ctx.progress?.({ message: "独立计量引擎已返回导入结果，正在校验数据血缘", metadata: { action: params.action } })
      } else {
        // 除了首次 import，画像、frequency、correlation、validate、export 和 rollback
        // 也必须复用同一个长驻引擎。否则“导入已解耦、画像仍在 TS 内嵌脚本”会让
        // 同一数据阶段拥有两套 Python 行为和两套错误分类。
        ctx.progress?.({
          message: `正在通过独立计量引擎执行数据${params.action}`,
          metadata: { action: params.action },
        })
        const engine = sessionEconometricsEngine(ctx.sessionID, {
          command: pythonCommand,
          cwd: Instance.directory,
          pythonPath: path.join(econometricsEngineRoot(), "src"),
          methodRoot: path.join(econometricsEngineRoot(), "python"),
        })
        const engineResult = await engine.execute({
          method_id: "data_import",
          // healthcheck不读取数据，但协议需要一个受控路径字段；引擎会在该动作
          // 的分支先返回，不访问这个占位路径。
          data_path: inputPath ?? outputPath,
          output_dir: path.dirname(outputPath),
          arguments: {
            action: params.action,
            ...(params.action === "export"
              ? { format: effectiveOutputFormat({ action: params.action, format: params.format }) }
              : {}),
            variables: variableResolution.names,
            groupBy: params.action === "frequency"
              ? resolveFrequencyGroupBy(groupResolution.names, variableResolution.names)
              : groupResolution.names,
            maxDistinct: params.options?.maxDistinct ?? 20,
            entityVar: entityResolution.names[0] ?? datasetManifest?.panelIdentifiers?.entityVar,
            timeVar: timeResolution.names[0] ?? datasetManifest?.panelIdentifiers?.timeVar,
            options: params.options ?? {},
          },
          runtime: {
            inputPath,
            outputPath,
            datasetId: datasetManifest?.datasetId ?? datasetId,
            stageId: sourceStage?.stageId ?? stageId,
            runId,
            branch,
          },
        }, ctx.abort)
        const enginePayload = engineResult.payload && typeof engineResult.payload === "object" && !Array.isArray(engineResult.payload)
          ? engineResult.payload as Record<string, any>
          : {}
        let verifiedActionPaths: ReturnType<typeof validateDataActionEngineResponse> | undefined
        if (params.action !== "healthcheck") {
          const outputDirectory = path.dirname(outputPath)
          const expectedOutputPath = params.action === "profile" || params.action === "correlation"
            ? path.join(outputDirectory, `${path.basename(outputPath, path.extname(outputPath))}.csv`)
            : params.action === "frequency"
              ? path.join(outputDirectory, "results.json")
              : outputPath
          const expectedResultPath = params.action === "export"
            ? outputPath
            : path.join(outputDirectory, "results.json")
          // 数据动作的 Harness 预定输出既可能在 datasetRoot，也可能在
          // projectHealthRoot（例如 profile/frequency/validate 报告）。仍要求
          // Python 返回值与上面的精确预定文件一致，并限制在项目内部状态目录。
          const managedOutputRoot = params.action !== "export" ? projectInternalRoot() : undefined
          verifiedActionPaths = validateDataActionEngineResponse({
            action: params.action,
            payload: enginePayload,
            expectedOutputPath,
            expectedResultPath,
            managedRoot: managedOutputRoot,
          })
          if (params.action === "rollback" && enginePayload.dataPath !== undefined) {
            assertEnginePathMatches({
              actual: enginePayload.dataPath,
              expected: outputPath,
              managedRoot: managedOutputRoot,
              label: "回滚数据",
            })
          }
          if (params.action !== "healthcheck") {
            if (!inputPath) throw new Tool.InputValidationError("Python 数据动作缺少 Harness 解析的输入阶段。")
            const returnedInputPath = requireEnginePath(enginePayload, ["input_path", "inputPath"], "输入数据", params.action)
            assertEnginePathMatches({
              actual: returnedInputPath,
              expected: inputPath,
              label: "输入数据",
            })
            const latestInput = datasetManifest && sourceStage
              ? resolveArtifactInput({ datasetId: datasetManifest.datasetId, stageId: sourceStage.stageId }).resolvedInputPath
              : inputPath
            if (!latestInput) throw new Tool.InputValidationError("数据动作执行期间当前阶段已不可用；没有登记结果产物。")
            const inputAfterExecution = datasetManifest && sourceStage
              ? await resolveDatasetStagePath({
                  datasetId: datasetManifest.datasetId,
                  filePath: latestInput,
                  toolName: "data_import",
                  sessionID: ctx.sessionID,
                  messageID: ctx.messageID,
                  callID: ctx.callID,
                  ask: ctx.ask,
                })
              : await resolveToolPath({
                  filePath: latestInput,
                  mode: "read",
                  toolName: "data_import",
                  sessionID: ctx.sessionID,
                  messageID: ctx.messageID,
                  callID: ctx.callID,
                  ask: ctx.ask,
                })
            if (inputAfterExecution !== inputPath) {
              throw new Tool.InputValidationError("数据动作执行期间当前数据阶段发生变化；拒绝把结果登记到旧血缘。")
            }
          }
          validateEngineAncillaryPaths({
            payload: enginePayload,
            expectedPaths: {
              schemaPath,
              schema_path: schemaPath,
              labelsPath,
              labels_path: labelsPath,
              summaryPath: expectedResultPath,
              summary_path: expectedResultPath,
              logPath,
              log_path: logPath,
              inspectionPath,
              inspection_path: inspectionPath,
              inspectionWorkbookPath,
              inspection_workbook_path: inspectionWorkbookPath,
            },
            managedRoot: projectInternalRoot(),
          })
        }
        result = {
          success: true,
          action: params.action,
          input_path: enginePayload.input_path ?? inputPath,
          output_path: params.action === "healthcheck"
            ? undefined
            : verifiedActionPaths?.outputPath ?? enginePayload.output_path ?? enginePayload.dataPath ?? outputPath,
          summary_path: params.action === "healthcheck"
            ? undefined
            : enginePayload.summary_path ?? verifiedActionPaths?.resultPath ?? enginePayload.resultPath,
          rows_before: enginePayload.rows_before ?? enginePayload.rows,
          rows_after: enginePayload.rows_after ?? enginePayload.rows,
          columns_before: enginePayload.columns_before ?? enginePayload.columns,
          columns_after: enginePayload.columns_after ?? enginePayload.columns,
          variables: enginePayload.variables ?? [],
          sheet_info: enginePayload.sheet_info,
          warnings: enginePayload.warnings ?? [],
          blocking_errors: enginePayload.blocking_errors ?? [],
          suggested_repairs: enginePayload.suggested_repairs ?? [],
          notes: enginePayload.notes ?? [],
          status: enginePayload.status,
          profile: enginePayload.profile,
          frequency: enginePayload.frequency,
          distributions: enginePayload.distributions,
          distribution_meta: enginePayload.distribution_meta,
          cross_tab: enginePayload.cross_tab,
          group_by: enginePayload.group_by,
          max_distinct: enginePayload.max_distinct,
          correlation: enginePayload.correlation,
          readiness: enginePayload.readiness,
          autoQa: enginePayload.autoQa,
          diagnosis: enginePayload.diagnosis,
          schema_normalization: enginePayload.schema_normalization ?? enginePayload.receipt,
          resolved_python_executable: pythonCommand,
        }
        ctx.progress?.({
          message: `独立计量引擎已完成数据${params.action}，正在校验结果`,
          metadata: { action: params.action },
        })
      }
      result.resolved_python_executable = pythonCommand
    }
    if (correctionWarning || datasetCorrectionWarning) {
      result.warnings = [
        ...new Set(
          [...(result.warnings ?? []), correctionWarning, datasetCorrectionWarning]
            .filter((item): item is string => Boolean(item)),
        ),
      ]
    }
    const effectiveRunId = inferRunId({
      requestedRunId: sourceStage ? undefined : (result.run_id ?? runId),
      stage: sourceStage,
    })
    result.run_id = effectiveRunId
    if (
      (params.action === "profile" || params.action === "validate") &&
      result.readiness &&
      datasetManifest &&
      (params.stageId ?? sourceStage?.stageId)
    ) {
      const refreshedStageId = params.stageId ?? sourceStage?.stageId
      const refreshedStage = refreshedStageId ? getStage(datasetManifest, refreshedStageId) : undefined
      if (refreshedStage) {
        refreshedStage.metadata = {
          ...(refreshedStage.metadata ?? {}),
          dataReadiness: {
            ...result.readiness,
            sourceStageId: refreshedStage.stageId,
          },
          ...(result.autoQa ? { autoQa: result.autoQa } : {}),
        }
        writeDatasetManifest(datasetManifest)
        sourceStage = refreshedStage
      }
    }
    if (params.action === "import" && result.autoQa) {
      // import 已经在同一个受管 Python 进程内完成轻量 数据质量检查；把结果映射回既有 数据质量检查
      // 字段，保证 warning 可继续、blockingErrors 仍然 fail-closed。
      result.warnings = [...new Set([...(result.warnings ?? []), ...result.autoQa.warnings])]
      result.blocking_errors = [...new Set([...(result.blocking_errors ?? []), ...result.autoQa.blockingErrors])]
      result.suggested_repairs = [...new Set([...(result.suggested_repairs ?? []), ...(result.autoQa.suggestedRepairs ?? [])])]
    }
    if (sourceFingerprint && result.action === "import" && datasetManifest) {
      upsertDatasetIndexEntry({
        datasetId: datasetManifest.datasetId,
        sourcePath: datasetManifest.sourcePath,
        fingerprint: sourceFingerprint,
        sessionID: ctx.sessionID,
      })
    }
    const formatIgnoredForStage =
      isStageProducingAction(params.action) && params.format !== undefined && params.format !== "parquet"
        ? `已忽略 format=${params.format}；规范化数据阶段固定使用 Parquet。`
        : undefined

    if (!result.success) {
      const reflection = classifyToolFailure({
        toolName: "data_import",
        error: result.error ?? "数据后端未返回具体原因",
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
      let message = `数据动作失败：${result.error ?? "数据后端没有返回具体原因；请确认文件可读、工作表名称正确，或换一张工作表重试。"}`
      if (result.resolved_python_executable) message += `\nPython 解释器：${result.resolved_python_executable}`
      message += `\n诊断记录：${relativeWithinProject(reflectionPath)}`
      if (result.install_command) message += `\n安装命令： ${result.install_command}`
      throw new Error(message)
    }

    const autoQaBlockingErrors = new Set(result.autoQa?.blockingErrors ?? [])
    // 上传动作的职责是把可读的原始数据保存为 canonical stage；自动 数据质量检查 的 block
    // 应保留在 stage metadata，并阻止下游估计，但不能把“文件已成功导入”伪装成
    // “导入动作失败”。否则用户连同一个空表/坏规格的可操作诊断都拿不到。
    const gateBlockingErrors =
      params.action === "import"
        ? (result.blocking_errors ?? []).filter((error) => !autoQaBlockingErrors.has(error))
        : result.blocking_errors
    const qaGate = evaluateQaGate({
      toolName: "data_import",
      qaSource: params.action === "validate" ? "qa_report" : "data_import_result",
      warnings: result.warnings,
      blockingErrors: gateBlockingErrors,
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
        `数据动作被 数据质量检查阻断：${qaGate.qaGateReason}\n诊断记录：${relativeWithinProject(reflectionPath)}`,
      )
    }

    let numericSnapshot: NumericSnapshotDocument | undefined
    if (params.action === "profile" && result.output_path) {
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

    if (datasetManifest && params.action !== "healthcheck") {
      // manifest 写入可能抛（writeDatasetManifest 新增了 workingFormat 校验、fs 权限问题、
      // JSON.stringify 失败等）。try/finally 保证即便 appendStage / appendArtifact 抛错，
      // orphanCleanup 监听器也一定解绑——避免下次的 cancel 误删成功产物或他人数据集。
      try {
        // 数据质量检查通过（未被 数据质量检查 门阻断才会走到这里）后，把模型此次确认的面板身份持久化到 manifest，
      // 供后续 filter/preprocess 自动回填，不再依赖模型每个 action 重传 entity/time。
      if (params.action === "validate" && (params.entityVar || params.timeVar)) {
        datasetManifest.panelIdentifiers = {
          ...(params.entityVar ? { entityVar: params.entityVar } : {}),
          ...(params.timeVar ? { timeVar: params.timeVar } : {}),
        }
      }
      if (params.action === "import" && !reusedImportStage && sourceAsset && importReceiptPath) {
        const resolvedSchemaPath = result.schema_path ?? schemaPath
        writeImportReceipt({
          datasetId: datasetManifest.datasetId,
          receiptPath: importReceiptPath,
          receipt: {
            sourceId: sourceAsset.sourceId,
            sourceFormat: sourceAsset.sourceFormat,
            sheetPolicy: {
              mode: params.sheetPolicy?.mode ?? "first_sheet",
              ...(params.sheetPolicy?.sheetName ? { sheetName: params.sheetPolicy.sheetName } : {}),
              ...(params.sheetPolicy?.headerRow !== undefined ? { headerRow: params.sheetPolicy.headerRow } : {}),
            },
            readerPolicy: "conservative_schema_normalization_v1",
            canonicalStagePath: relativeWithinProject(result.output_path ?? outputPath),
            schemaPath: resolvedSchemaPath ? relativeWithinProject(resolvedSchemaPath) : undefined,
            normalization: result.schema_normalization ?? { columns: [], warnings: ["normalization receipt unavailable"] },
          },
        })
      }
      if (
        params.action === "import" ||
        params.action === "rollback"
      ) {
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
            // Python 已明确只生成 inspection CSV；预分配的 xlsx 路径只是 payload 输入，
            // 不能在文件从未落盘时把它登记成可用产物。
            inspectionWorkbookPath: result.inspection_workbook_path ?? undefined,
            importReceiptPath: params.action === "import" ? importReceiptPath : undefined,
            createdAt: new Date().toISOString(),
            metadata: {
              runId: effectiveRunId,
              sourceFormat: datasetManifest.sourceFormat,
              ...(sourceFingerprint ? { sourceFingerprint: sourceFingerprint.key } : {}),
              ...(params.action === "import" ? { sourceSheet: sheetSelectionKey(params.sheetPolicy) } : {}),
              ...(params.action === "import" && result.sheet_info ? { sheetInfo: result.sheet_info } : {}),
              ...(formatIgnoredForStage ? { format_note: formatIgnoredForStage } : {}),
              ...(result.readiness
                ? {
                    dataReadiness: {
                      ...result.readiness,
                      sourceStageId: result.stage_id ?? stageId ?? "stage_000",
                    },
                  }
                : {}),
              ...(result.autoQa ? { autoQa: result.autoQa } : {}),
              ...(result.diagnosis ? { dataDiagnosis: result.diagnosis } : {}),
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
        const refreshedStageId = result.stage_id ?? params.stageId ?? sourceStage?.stageId
        const refreshedStage = refreshedStageId
          ? datasetManifest.stages.find((stage) => stage.stageId === refreshedStageId && stage.branch === branch)
          : undefined
        if (refreshedStage && result.diagnosis?.stage_id === refreshedStage.stageId) {
          refreshedStage.metadata = {
            ...refreshedStage.metadata,
            dataDiagnosis: result.diagnosis,
            ...(result.readiness
              ? { dataReadiness: { ...result.readiness, sourceStageId: refreshedStage.stageId } }
              : {}),
            ...(result.autoQa ? { autoQa: result.autoQa } : {}),
          }
        }
      }
      // 每个数据操作都刷新原上传消息的记录：用户回到这条会话时可从同一条消息看到
      // canonical manifest 和最新阶段/证据，而不需再次上传或靠模型猜测路径。跨会话
      // manifest 不允许被当前窗口接管，保持既有 dataset index 的会话隔离语义。
      if (!datasetManifest.origin || datasetManifest.origin.sessionID === ctx.sessionID) {
        datasetManifest.origin ??= {
          sessionID: ctx.sessionID,
          importedAt: new Date().toISOString(),
        }
        try {
          const artifactPaths = [
            ...datasetManifest.stages.flatMap((stage) => [
              stage.workingPath,
              stage.schemaPath,
              stage.labelsPath,
              stage.summaryPath,
              stage.logPath,
              stage.inspectionPath,
              stage.inspectionWorkbookPath,
            ]),
            ...datasetManifest.artifacts.flatMap((artifact) => [
              artifact.outputPath,
              artifact.workbookPath,
              artifact.summaryPath,
              artifact.logPath,
            ]),
          ].filter((artifactPath): artifactPath is string => Boolean(artifactPath))
          const linked = await linkDatasetToConversation({
            sessionID: ctx.sessionID,
            sourcePath: conversationSourcePath ?? datasetManifest.sourcePath,
            messageID: datasetManifest.origin.messageID,
            attachmentPartID: datasetManifest.origin.attachmentPartID,
            datasetId: datasetManifest.datasetId,
            stageId: result.stage_id ?? stageId ?? sourceStage?.stageId,
            artifactPaths,
          })
          datasetManifest.origin = {
            ...datasetManifest.origin,
            ...(linked ?? {}),
          }
          writeDatasetManifest(datasetManifest)
        } catch (error) {
          // 记录消息失败不能否定已经通过 数据质量检查 并已落盘的分析结果；manifest/产物仍可
          // 正常使用，下一次同会话操作会再次尝试回写这条可恢复的会话索引。
          log.warn("failed to link dataset artifacts to upload message", {
            datasetId: datasetManifest.datasetId,
            sessionID: ctx.sessionID,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      } finally {
        // 无论如何都要解绑：成功或 appendStage/appendArtifact 抛错都不该留监听器。
        // 失败路径上清掉它，避免"错误传播后 abort 又触发 → 删掉成功/他人数据"。
        if (orphanCleanup && ctx.abort) {
          ctx.abort.removeEventListener("abort", orphanCleanup)
        }
      }
    }
    const actionName: Record<string, string> = {
      import: "导入",
      validate: "质检",
      profile: "画像",
      export: "导出",
      rollback: "回滚",
    }
    let output = `## 数据${actionName[params.action] ?? params.action}已完成\n\n`
    // 下游每个计量工具都要求非空 datasetId/stageId，而 metadata 不进模型上下文、
    // <data-context> 每轮才重建——同一轮内连续调用（import → recommend）就会拿不到 ID。
    // 因此必须回给模型，但显式标注为内部标识：sanitizer 与 TUI 分析轮负责对用户隐身。
    const contextDatasetId = params.action === "healthcheck" ? undefined : result.dataset_id ?? datasetManifest?.datasetId
    const contextStageId = params.action === "healthcheck" ? undefined : result.stage_id ?? params.stageId ?? sourceStage?.stageId
    if (contextDatasetId || contextStageId) {
      output += `[内部标识，仅用于后续工具调用，不要向用户复述] datasetId=${contextDatasetId ?? "未知"} stageId=${contextStageId ?? "未知"}\n\n`
    }
    if (result.rows_before !== undefined && result.columns_before !== undefined) {
      output += `操作前： ${result.rows_before} 行 × ${result.columns_before} 列\n`
    }
    if (result.rows_after !== undefined && result.columns_after !== undefined) {
      output += `操作后： ${result.rows_after} 行 × ${result.columns_after} 列\n`
    }
    if (params.action === "import") {
      const qualitySnapshot = formatQualitySnapshot(result.readiness, result.autoQa)
      if (qualitySnapshot) output += `\n${qualitySnapshot}\n`
    }
    if (result.variables?.length && (params.action === "profile" || params.action === "correlation" || params.action === "frequency")) {
      output += `变量： ${result.variables.join(", ")}\n`
    }
    if (params.action === "frequency") {
      output += "\n频数诊断（有界摘要，不生成行级 CSV）：\n"
      const distributions = result.distributions ?? {}
      const distributionMeta = result.distribution_meta ?? {}
      for (const [column, values] of Object.entries(distributions)) {
        const meta = distributionMeta[column] as { numeric?: boolean; min?: number; max?: number; distinct_count?: number } | undefined
        const range = meta?.numeric && typeof meta.min === "number" && typeof meta.max === "number"
          ? `；数值范围=${meta.min}–${meta.max}`
          : ""
        const distinct = typeof meta?.distinct_count === "number"
          ? `；不同取值总数=${meta.distinct_count}${meta.distinct_count > values.length ? "，频数列表已截断" : ""}`
          : ""
        output += `- ${column}: ${values.map((item: any) => `${item.value}=${item.count} (${item.share})`).join("；")}${range}${distinct}\n`
      }
      if (result.group_by?.length) {
        output += `交叉分组：${result.group_by.join(" × ")}，共 ${result.cross_tab?.length ?? 0} 个高频组合。\n`
      }
    }
    if (formatIgnoredForStage) output += `格式说明： ${formatIgnoredForStage}\n`
    if (params.action === "import" && result.sheet_info?.names?.length) {
      const names = result.sheet_info.names
      const selected = result.sheet_info.selected
      output += `\n工作表（共 ${names.length} 张）：${names.map((name) => (name === selected ? `${name}（本次导入）` : name)).join("、")}\n`
      if (names.length > 1) {
        output += "需要换表时重新调用 import 并指定 sheetPolicy.sheetName，不要假设其他表已导入。\n"
      }
    }
    if (params.action === "import") {
      const inventory = formatImportColumnInventory(result.readiness)
      if (inventory) output += `\n${inventory}\n`
      else if (result.column_info) {
        // readiness 构建失败时的兜底：只报类型数量，不印 column_info 里的列名
        // （它可能已被上游截断成假列名）。
        output += `\n变量类型：\n`
        if (result.column_info.Numeric?.length) output += `- 数值型 ${result.column_info.Numeric.length} 个\n`
        if (result.column_info.Category?.length) output += `- 类别型 ${result.column_info.Category.length} 个\n`
        if (result.column_info.Datetime?.length) output += `- 时间型 ${result.column_info.Datetime.length} 个\n`
      }
    }
    if (params.action === "import" && result.readiness) {
      output += `\n${formatDataReadinessForModel(result.readiness)}\n`
    }
    if (params.action === "import" && result.diagnosis) {
      const diagnosis = result.diagnosis
      const blocking = diagnosis.issues.filter((issue) => issue.severity === "blocking").length
      const warnings = diagnosis.issues.filter((issue) => issue.severity === "warning").length
      output += `\n上传后数据诊断已完成：${diagnosis.rows} 行、${diagnosis.columns.length} 列；阻断问题 ${blocking} 项，提醒 ${warnings} 项。\n`
      if (diagnosis.recommended_method_ids.length) {
        output += `当前结构上优先可适配的方法（最多三项）：${diagnosis.recommended_method_ids.join("、")}。这只是数据兼容性建议，不替代研究设计。\n`
      }
      const semantic = diagnosis.method_compatibility
        .filter((item) => item.status === "requires_semantic_input")
        .map((item) => item.method_id)
      if (semantic.length) output += `需要用户确认研究设计后才能使用：${semantic.slice(0, 8).join("、")}。\n`
    }
    if (params.action === "import" && result.autoQa) {
      output += `\n上传后自动 数据质量检查：${result.autoQa.status === "block" ? "发现阻断项（数据已导入，但暂不能估计）" : result.autoQa.status === "warn" ? "有提醒项（不阻断估计）" : "通过"}。\n`
      if (result.autoQa.blockingErrors.length) output += `- 估计前必须处理：${result.autoQa.blockingErrors.join("；")}\n`
      if (result.autoQa.warnings.length) output += `- 需要关注：${result.autoQa.warnings.join("；")}\n`
    }

    if (params.action === "validate") {
      output += `\n数据质量状态： ${result.status ?? "unknown"}\n`
      if (result.warnings?.length) output += `警告： ${result.warnings.join(" | ")}\n`
      if (result.blocking_errors?.length) output += `阻塞错误： ${result.blocking_errors.join(" | ")}\n`
      if (result.suggested_repairs?.length) output += `建议修复： ${result.suggested_repairs.join(" | ")}\n`
      if (result.notes?.length) output += `备注： ${result.notes.join(" | ")}\n`
    }
    if (qaGate.qaGateStatus === "warn") {
      output += `数据质量检查：警告\n`
      if (qaGate.qaGateReason) output += `数据质量检查原因： ${qaGate.qaGateReason}\n`
    }

    if (params.action === "healthcheck") {
      output += `\n环境状态： ${result.status ?? "unknown"}\n`
      if (result.module_status) {
        output += `模块：\n`
        for (const [name, ok] of Object.entries(result.module_status)) {
          output += `- ${name}: ${ok ? "ok" : "missing"}\n`
        }
      }
      if (result.install_command) output += `安装命令： ${result.install_command}\n`
    }

    const qualityFacts = params.action === "import" ? formatQualityFacts(result.readiness, result.autoQa) : undefined
    const metadataReadiness = params.action === "import" ? compactDataReadinessForMetadata(result.readiness) : undefined
    // 完整诊断已保存到 manifest 的当前 stage，模型通过上面的有界中文摘要获取结论；
    // 不要再把整份方法兼容矩阵塞进 ToolPart 的 result 和 diagnosis 两个字段重复序列化。
    const modelResult = { ...result }
    delete modelResult.diagnosis
    const metadataResult = metadataReadiness ? { ...modelResult, readiness: metadataReadiness } : modelResult
    const standaloneQualityInspection =
      ctx.extra?.qualityInspectionOnly === true && ctx.extra?.recommendationOnly !== true
    const qualityInspectionFinalize =
      standaloneQualityInspection &&
      ["profile", "validate", "frequency", "correlation"].includes(params.action) &&
      !(params.action === "validate" && Boolean(result.blocking_errors?.length))

    return {
      title: `Data ${params.action}`,
      output,
        metadata: {
          action: params.action,
          // 纯质量体检的导入结果已包含变量、缺失、面板键和异常值摘要；允许模型再生成一轮
          // 中文收尾，但不再重复画像/质检。若用户同时要求方法推荐，则继续到只读推荐工具。
          finalizeTextOnly: params.action === "import" && standaloneQualityInspection
            && ctx.extra?.requiresPostImportProfile !== true
            ? true
            : qualityInspectionFinalize
              ? true
              : undefined,
          finalizeAfterResult: qualityInspectionFinalize ? true : undefined,
          // 面板键是后续用户可见事实；放在顶层短字符串中，避免大型导入元数据
          // 触发 prepareToolMetadata 的深层折叠后，展示层无法核对真实时间列名。
          verifiedPanelKeys: params.action === "import"
            ? result.readiness?.panelCandidates?.filter((candidate) => candidate.unique && candidate.entityMissingCount === 0 && candidate.timeMissingCount === 0).slice(0, 12).map((candidate) =>
                `${candidate.entityVars.join("+")}×${candidate.timeVar}`,
              ).join("；")
            : undefined,
          result: metadataResult,
          readiness: metadataReadiness,
        datasetId: result.dataset_id ?? datasetManifest?.datasetId,
        stageId: result.stage_id ?? params.stageId ?? sourceStage?.stageId,
        runId: effectiveRunId,
        numericSnapshotPath: result.numeric_snapshot_path
          ? relativeWithinProject(result.numeric_snapshot_path)
          : undefined,
        numericSnapshotPreview: numericSnapshotPreview(numericSnapshot),
        groundingScope:
          params.action === "profile" ? "descriptive" : params.action === "correlation" ? "correlation" : params.action === "frequency" ? "diagnostics" : undefined,
        qaGateStatus: qaGate.qaGateStatus,
        qaGateReason: qaGate.qaGateReason,
        qaSource: qaGate.qaSource,
        deliveryBundleDir: deliveryBundlePath ? relativeWithinProject(deliveryBundlePath) : undefined,
        publishedFiles,
        finalOutputsPath: publishedFiles.length
          ? relativeWithinProject(finalOutputsPath(result.input_path ?? params.inputPath ?? outputPath, effectiveRunId))
          : undefined,
        internalFinalOutputsPath: publishedFiles.length
          ? relativeWithinProject(finalOutputsPath(result.input_path ?? params.inputPath ?? outputPath, effectiveRunId))
          : undefined,
        presentation: buildDataImportPresentation({
          action: params.action,
          result,
          qaGate,
          publishedFiles,
          deliveryBundlePath,
        }),
        analysisView: createToolAnalysisView({
          kind: "data_import",
          // result.input_path 指向受管原件快照（文件名固定为 original.*），不能把这个
          // 内部存储名展示给用户；导入时优先使用用户实际提交的源文件名。
          foundInputFile: params.action === "import"
            ? importDisplayFile({
                originalFilename: datasetManifest?.sourceAsset?.originalFilename,
                sourcePath: conversationSourcePath,
                fallbackPath: result.input_path,
              })
            : undefined,
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
            analysisMetric("数据质量状态", params.action === "validate" ? (qaGate.qaGateStatus ?? result.status) : undefined),
          ],
          artifacts: [
            ...publishedFiles.map((item) =>
              analysisArtifact(item.relativePath, {
                label: item.label,
                visibility: "user_collapsed",
              }),
            ),
            analysisArtifact(
              result.numeric_snapshot_path ? relativeWithinProject(result.numeric_snapshot_path) : undefined,
              {
                visibility: "user_default",
              },
            ),
          ],
          warnings: [qualityFacts, ...buildDataImportWarnings({ result, qaGate })],
          conclusion: params.action === "import" && ctx.extra?.qualityInspectionOnly === true
            ? "自动质量检查已完成；系统没有自动删除、缩尾或修改任何观测，是否清洗由你决定。"
            : undefined,
          variables: params.action === "import"
            ? result.readiness?.columns.slice(0, 80).map((column) => column.name)
            : undefined,
          qualityFacts: params.action === "import" ? qualityFacts : undefined,
          panelCandidates: params.action === "import"
            ? result.readiness?.panelCandidates?.filter((candidate) => candidate.unique && candidate.entityMissingCount === 0 && candidate.timeMissingCount === 0).slice(0, 12).map((candidate) => ({
                entityVars: candidate.entityVars,
                timeVar: candidate.timeVar,
              }))
            : undefined,
        }),
        display: createToolDisplay({
          summary:
            params.action === "validate"
              ? `data_import(validate) completed with status ${result.status ?? qaGate.qaGateStatus ?? "unknown"}`
              : params.action === "profile" || params.action === "correlation" || params.action === "frequency"
                ? `data_import(${params.action}) completed for ${(result.variables ?? []).length} variables`
                : result.rows_after !== undefined
                  ? `data_import(${params.action}) completed: ${result.rows_after} rows after processing`
                  : `data_import(${params.action}) completed`,
          details: [
            result.rows_before !== undefined && result.rows_after !== undefined
              ? `Rows: ${result.rows_before} -> ${result.rows_after}`
              : undefined,
            result.columns_before !== undefined && result.columns_after !== undefined
              ? `Columns: ${result.columns_before} -> ${result.columns_after}`
              : undefined,
            params.action === "validate" ? `数据质量检查: ${qaGate.qaGateStatus}` : undefined,
            params.action === "frequency" && result.group_by?.length ? `交叉分组: ${result.group_by.join(" × ")}` : undefined,
            result.warnings?.length ? `警告： ${result.warnings.join(" | ")}` : undefined,
            result.blocking_errors?.length ? `阻塞错误： ${result.blocking_errors.join(" | ")}` : undefined,
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
