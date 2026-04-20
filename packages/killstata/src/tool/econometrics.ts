import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { spawn, exec } from "child_process"
import DESCRIPTION from "./econometrics.txt"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Tool } from "./tool"
import { Question } from "../question"
import {
  buildFileStamp,
  appendArtifact,
  finalOutputsPath,
  inferRunId,
  projectErrorsRoot,
  projectTempRoot,
  publishDeliveryOutput,
  publishVisibleOutput,
  reportOutputPath,
  resolveArtifactInput,
} from "./analysis-state"
import {
  checkRetryBudget,
  classifyToolFailure,
  evaluateQaGate,
  persistToolReflection,
  runPostEstimationGates,
} from "./analysis-reflection"
import { AnalysisIntent } from "./analysis-intent"
import {
  createEconometricsNumericSnapshot,
  type NumericSnapshotDocument,
} from "./analysis-grounding"
import { generateRegressionTable } from "./regression-table"
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
import { analysisArtifact, analysisMetric, createToolAnalysisView } from "./analysis-user-view"
import { formatRuntimePythonSetupError, getRuntimePythonStatus } from "@/killstata/runtime-config"
import { ensureAnalysisPlan, formatAnalysisChecklist, setAnalysisPlanApproval } from "@/runtime/workflow"
import {
  buildSmartDatasetProfile,
  recommendEconometricsPlan,
  type SmartColumnProfile,
  type SmartDatasetProfile,
  type SmartRecommendation,
} from "./econometrics-smart"

const log = Log.create({ service: "econometrics-tool" })

// Python环境路径配置
const ECONOMETRICS_DIR = path.join(__dirname, "../../python/econometrics")
const PYTHON_RESULT_PREFIX = "__KILLSTATA_JSON__"

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

type InlinePythonExecution = {
  code: number | null
  stdout: string
  stderr: string
  scriptPath: string
  cleanup: () => void
}

function persistPythonFailureArtifacts(input: {
  label: string
  command: string
  cwd: string
  execution: InlinePythonExecution
  context?: Record<string, unknown>
}) {
  const errorsDir = projectErrorsRoot()
  fs.mkdirSync(errorsDir, { recursive: true })

  const stamp = buildFileStamp()
  const base = path.join(errorsDir, `econometrics_${input.label}_${stamp}`)
  const scriptCopyPath = `${base}.py`
  const stdoutPath = `${base}.stdout.log`
  const stderrPath = `${base}.stderr.log`
  const contextPath = `${base}.context.json`

  fs.copyFileSync(input.execution.scriptPath, scriptCopyPath)
  fs.writeFileSync(stdoutPath, input.execution.stdout, "utf-8")
  fs.writeFileSync(stderrPath, input.execution.stderr, "utf-8")
  fs.writeFileSync(
    contextPath,
    JSON.stringify(
      {
        label: input.label,
        command: input.command,
        cwd: input.cwd,
        exitCode: input.execution.code,
        originalScriptPath: input.execution.scriptPath,
        preservedScriptPath: scriptCopyPath,
        stdoutPath,
        stderrPath,
        ...input.context,
      },
      null,
      2,
    ),
    "utf-8",
  )

  input.execution.cleanup()

  return {
    scriptCopyPath,
    stdoutPath,
    stderrPath,
    contextPath,
  }
}

async function runInlinePython(input: { command: string; script: string; cwd: string }) {
  const tempDir = projectTempRoot()
  fs.mkdirSync(tempDir, { recursive: true })
  const tempScriptPath = path.join(tempDir, `econometrics_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`)
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
    proc.on("error", (error) => {
      reject(error)
    })
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

const SUPPORTED_METHODS = [
  "auto_recommend",
  "smart_baseline",
  "ols_regression",
  "panel_fe_regression",
  "baseline_regression",
  "psm_construction",
  "psm_matching",
  "psm_ipw",
  "psm_regression",
  "psm_double_robust",
  "psm_dr_ipw_ra",
  "psm_visualize",
  "iv_2sls",
  "iv_test",
  "did_static",
  "did_staggered",
  "did_event_study",
  "did_event_study_viz",
  "rdd_sharp",
  "rdd_fuzzy",
  "rdd_fuzzy_global",
] as const

type MethodName = (typeof SUPPORTED_METHODS)[number]

const MethodSchema = z.enum(SUPPORTED_METHODS)

const METHOD_REQUIRED_OPTIONS: Partial<Record<MethodName, string[]>> = {
  iv_2sls: ["iv_variable"],
  iv_test: ["iv_variable"],
  did_static: ["treatment_entity_dummy", "treatment_finished_dummy"],
  did_staggered: ["treatment_entity_dummy", "treatment_finished_dummy"],
  did_event_study: ["treatment_entity_dummy", "treatment_finished_dummy"],
  did_event_study_viz: ["treatment_entity_dummy", "treatment_finished_dummy"],
  rdd_sharp: ["running_variable"],
  rdd_fuzzy: ["running_variable"],
  rdd_fuzzy_global: ["running_variable"],
}

const METHOD_NEEDS_PANEL_KEYS = new Set<MethodName>([
  "panel_fe_regression",
  "baseline_regression",
  "did_static",
  "did_staggered",
  "did_event_study",
  "did_event_study_viz",
])

const METHOD_NEEDS_TREATMENT = new Set<MethodName>([
  "smart_baseline",
  "ols_regression",
  "panel_fe_regression",
  "baseline_regression",
  "psm_construction",
  "psm_matching",
  "psm_ipw",
  "psm_regression",
  "psm_double_robust",
  "psm_dr_ipw_ra",
  "psm_visualize",
  "iv_2sls",
  "iv_test",
  "rdd_sharp",
  "rdd_fuzzy",
  "rdd_fuzzy_global",
])

type PythonResult = {
  success: boolean
  error?: string
  traceback?: string
  error_log_path?: string
  resolved_python_executable?: string
  method?: string
  coefficient?: number
  std_error?: number
  p_value?: number
  r_squared?: number
  ate?: number
  att?: number
  late?: number
  plot_path?: string
  output_path?: string
  coefficients_path?: string
  workbook_path?: string
  diagnostics_path?: string
  metadata_path?: string
  narrative_path?: string
  summary_path?: string
  numeric_snapshot_path?: string
  qa_status?: string
  warnings?: string[]
  blocking_errors?: string[]
  suggested_repairs?: string[]
  backend?: string
  dropped_rows?: number
  rows_used?: number
  cluster_var?: string
  test_results?: unknown
  dataset_id?: string
  stage_id?: string
  run_id?: string
  branch?: string
  table_variables?: string[]
  academic_table_markdown_path?: string
  academic_table_latex_path?: string
  academic_table_workbook_path?: string
  academic_table_docx_path?: string
  delivery_report_docx_path?: string
  final_analysis_workbook_path?: string
  journal_paper_docx_path?: string
  profile_path?: string
  recommendation_path?: string
  effective_method?: string
  effective_covariance?: string
  degraded_from?: string
  decision_trace?: Array<{ kind: string; message: string }>
  post_estimation_gates?: Array<{
    gate: string
    passed: boolean
    severity: "info" | "warning" | "blocking"
    autoFix?: string
    userMessage: string
    diagnosticValue?: number
    threshold?: number
  }>
  principle_checks?: PrincipleChecks
}

type EconometricsPublishedFile = {
  label: string
  relativePath: string
}

type EconometricsToolMetadata = {
  method: MethodName
  result?: PythonResult
  principleChecks?: PrincipleChecks
  profile?: SmartDatasetProfile
  recommendation?: SmartRecommendation
  datasetId?: string
  stageId?: string
  runId?: string
  numericSnapshotPath?: string
  numericSnapshotPreview?: ReturnType<typeof numericSnapshotPreview>
  groundingScope?: string
  qaGateStatus?: string
  qaGateReason?: string
  qaSource?: string
  outputDir?: string
  deliveryBundleDir?: string
  publishedFiles?: EconometricsPublishedFile[]
  finalOutputsPath?: string
  internalFinalOutputsPath?: string
  presentation?: ToolPresentation
  display?: ReturnType<typeof createToolDisplay>
  analysisView?: ReturnType<typeof createToolAnalysisView>
}

export type PrincipleCheckStatus = "pass" | "warn" | "block"
export type ClaimCeiling = "full" | "restricted" | "blocked"

export type PrincipleChecks = {
  method: MethodName
  prereq_status: PrincipleCheckStatus
  diagnostics_status: PrincipleCheckStatus
  claim_ceiling: ClaimCeiling
  findings: string[]
}

function validateMethodOptions(params: {
  methodName: MethodName
  dependentVar?: string
  treatmentVar?: string
  options?: Record<string, unknown>
  entityVar?: string
  timeVar?: string
}) {
  if (params.methodName !== "auto_recommend" && !params.dependentVar) {
    throw new Error(`Method ${params.methodName} requires dependentVar`)
  }

  if (METHOD_NEEDS_TREATMENT.has(params.methodName) && !params.treatmentVar) {
    throw new Error(`Method ${params.methodName} requires treatmentVar`)
  }

  if (METHOD_NEEDS_PANEL_KEYS.has(params.methodName) && (!params.entityVar || !params.timeVar)) {
    throw new Error(`Method ${params.methodName} requires entityVar and timeVar`)
  }

  const required = METHOD_REQUIRED_OPTIONS[params.methodName] ?? []
  const missing = required.filter((key) => params.options?.[key] === undefined)
  if (missing.length) {
    throw new Error(`Method ${params.methodName} requires options: ${missing.join(", ")}`)
  }
}

function significanceStars(pValue: number | undefined) {
  if (pValue === undefined) return ""
  if (pValue < 0.01) return "***"
  if (pValue < 0.05) return "**"
  if (pValue < 0.1) return "*"
  return ""
}

function groupCount(result: PythonResult) {
  return result.post_estimation_gates?.find((gate) => gate.gate === "cluster_count" && gate.diagnosticValue !== undefined)
    ?.diagnosticValue
}

function safeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function walkRecord(value: unknown, visitor: (node: Record<string, unknown>) => void) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkRecord(item, visitor))
    return
  }
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  visitor(record)
  Object.values(record).forEach((item) => walkRecord(item, visitor))
}

function findNestedBlock(value: unknown, keys: string[]) {
  const candidates = new Set(keys)
  let found: Record<string, unknown> | undefined
  walkRecord(value, (node) => {
    if (found) return
    for (const [key, raw] of Object.entries(node)) {
      if (!candidates.has(key)) continue
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        found = raw as Record<string, unknown>
        return
      }
    }
  })
  return found
}

function findNestedNumber(value: unknown, keys: string[]) {
  const candidates = new Set(keys)
  let found: number | undefined
  walkRecord(value, (node) => {
    if (found !== undefined) return
    for (const [key, raw] of Object.entries(node)) {
      if (!candidates.has(key)) continue
      const numeric = safeNumber(raw)
      if (numeric !== undefined) {
        found = numeric
        return
      }
    }
  })
  return found
}

function extractParallelTrendsStatus(diagnostics: Record<string, unknown>) {
  const block = findNestedBlock(diagnostics, ["parallel_trends", "parallel_trend", "pretrend_test", "pre_trends"])
  if (!block) return undefined
  if (typeof block.passed === "boolean") return block.passed
  if (typeof block.parallel_trends_passed === "boolean") return block.parallel_trends_passed
  const significantLeadCount = findNestedNumber(block, ["significant_lead_count"])
  if (significantLeadCount !== undefined) return significantLeadCount <= 0
  const minLeadPValue = findNestedNumber(block, ["min_lead_p_value", "p_value", "pvalue"])
  if (minLeadPValue !== undefined) return minLeadPValue >= 0.05
  return undefined
}

function extractWeakIvFStat(diagnostics: Record<string, unknown>) {
  const identification = findNestedBlock(diagnostics, ["identification"])
  const weakIv = identification
    ? findNestedBlock(identification, ["weak_iv", "weak_instrument"])
    : findNestedBlock(diagnostics, ["weak_iv", "weak_instrument"])
  if (!weakIv) return undefined
  return findNestedNumber(weakIv, ["f_stat", "first_stage_f_stat", "first_stage_f", "kp_f_stat"])
}

function extractCommonSupportStatus(diagnostics: Record<string, unknown>) {
  const scope = findNestedBlock(diagnostics, ["matching", "psm"]) ?? diagnostics
  const commonSupport = findNestedBlock(scope, ["common_support"])
  if (!commonSupport) return undefined
  if (typeof commonSupport.passed === "boolean") return commonSupport.passed
  if (typeof commonSupport.support_ok === "boolean") return commonSupport.support_ok
  const overlapShare = findNestedNumber(commonSupport, ["overlap_share", "matched_share", "support_share"])
  if (overlapShare !== undefined) return overlapShare > 0
  return undefined
}

function extractPanelDuplicateStatus(diagnostics: Record<string, unknown>) {
  const panel = findNestedBlock(diagnostics, ["panel"])
  if (!panel) return undefined
  const duplicateCount = findNestedNumber(panel, ["duplicate_entity_time", "duplicate_panel_keys", "duplicate_count"])
  if (duplicateCount !== undefined) return duplicateCount === 0
  return undefined
}

function mergePrincipleStatus(current: PrincipleCheckStatus, next: PrincipleCheckStatus): PrincipleCheckStatus {
  if (current === "block" || next === "block") return "block"
  if (current === "warn" || next === "warn") return "warn"
  return "pass"
}

function principleClaimCeiling(prereqStatus: PrincipleCheckStatus, diagnosticsStatus: PrincipleCheckStatus): ClaimCeiling {
  if (prereqStatus === "block" || diagnosticsStatus === "block") return "blocked"
  if (prereqStatus === "warn" || diagnosticsStatus === "warn") return "restricted"
  return "full"
}

export function evaluatePrincipleChecks(input: {
  methodName: MethodName
  entityVar?: string
  timeVar?: string
  options?: Record<string, unknown>
  result: PythonResult
  diagnosticsPayload?: Record<string, unknown>
  hasNumericSnapshot: boolean
}): PrincipleChecks {
  let prereqStatus: PrincipleCheckStatus = "pass"
  let diagnosticsStatus: PrincipleCheckStatus = "pass"
  const findings: string[] = []
  const diagnostics = input.diagnosticsPayload ?? {}
  const addFinding = (status: PrincipleCheckStatus, message: string, scope: "prereq" | "diagnostics") => {
    if (!findings.includes(message)) findings.push(message)
    if (scope === "prereq") prereqStatus = mergePrincipleStatus(prereqStatus, status)
    else diagnosticsStatus = mergePrincipleStatus(diagnosticsStatus, status)
  }

  if (!input.hasNumericSnapshot) {
    addFinding("block", "缺少 numeric_snapshot，当前结果不能输出系数、p 值或显著性结论。", "prereq")
  }

  if ((input.result.blocking_errors?.length ?? 0) > 0 || input.result.qa_status === "fail") {
    addFinding("block", "当前估计存在 blocking_errors，不能据此给出经验结论。", "diagnostics")
  }

  if (input.methodName === "panel_fe_regression") {
    if (!input.entityVar || !input.timeVar) {
      addFinding("block", "panel_fe_regression 缺少 entityVar 或 timeVar，不满足面板固定效应前提。", "prereq")
    }
    const panelDuplicateStatus = extractPanelDuplicateStatus(diagnostics)
    const duplicateText = [...(input.result.blocking_errors ?? []), ...(input.result.warnings ?? [])].join(" ")
    if (panelDuplicateStatus === false || /duplicate.*panel|duplicate.*entity|panel key/i.test(duplicateText)) {
      addFinding("block", "面板主键存在重复或未修复痕迹，固定效应结果应阻断。", "diagnostics")
    }
  }

  if (input.methodName.startsWith("did_")) {
    if (!input.entityVar || !input.timeVar) {
      addFinding("block", "DID 缺少 entityVar 或 timeVar，不满足基础识别结构。", "prereq")
    }
    if (!input.options?.treatment_entity_dummy || !input.options?.treatment_finished_dummy) {
      addFinding("block", "DID 缺少处理组或处理后时点定义，不能建立 DID 识别。", "prereq")
    }
    const parallelTrendsStatus = extractParallelTrendsStatus(diagnostics)
    if (parallelTrendsStatus === undefined) {
      addFinding("warn", "DID 没有可核验的 parallel trends / lead-lag 诊断，结论只能降级为受限证据。", "diagnostics")
    } else if (parallelTrendsStatus === false) {
      addFinding("block", "Parallel trends 诊断未通过，DID 因果结论应阻断。", "diagnostics")
    }
  }

  if (input.methodName === "iv_2sls") {
    if (!input.options?.iv_variable) {
      addFinding("block", "IV-2SLS 缺少 instrument 变量，不能输出 IV 结论。", "prereq")
    }
    const weakIvFStat = extractWeakIvFStat(diagnostics)
    if (weakIvFStat === undefined) {
      addFinding("warn", "IV 结果缺少弱工具变量诊断，结论只能降级为受限证据。", "diagnostics")
    } else if (weakIvFStat < 10) {
      addFinding("block", `弱工具变量诊断未通过，first-stage F=${weakIvFStat.toFixed(2)}。`, "diagnostics")
    }
  }

  if (input.methodName.startsWith("rdd_")) {
    if (!input.options?.running_variable) {
      addFinding("block", "RDD 缺少 running variable，不能建立断点设计。", "prereq")
    }
    if (safeNumber(input.options?.cutoff) === undefined) {
      addFinding("block", "RDD 缺少明确 cutoff，当前实现不会默认替你猜断点。", "prereq")
    }
    if (typeof input.result.rows_used === "number" && input.result.rows_used < 30) {
      addFinding("block", "RDD 有效样本过少，当前结果不支持因果解释。", "diagnostics")
    }
  }

  if (input.methodName.startsWith("psm_")) {
    const commonSupportStatus = extractCommonSupportStatus(diagnostics)
    if (commonSupportStatus === undefined) {
      addFinding("warn", "PSM 缺少共同支撑/匹配质量诊断，结论只能降级为受限证据。", "diagnostics")
    } else if (commonSupportStatus === false) {
      addFinding("block", "PSM 共同支撑诊断未通过，当前结果不能作为可靠因果证据。", "diagnostics")
    }
  }

  return {
    method: input.methodName,
    prereq_status: prereqStatus,
    diagnostics_status: diagnosticsStatus,
    claim_ceiling: principleClaimCeiling(prereqStatus, diagnosticsStatus),
    findings,
  }
}

function buildEconometricsConclusion(input: {
  treatmentVar?: string
  coefficient?: number
  pValue?: number
  principleChecks?: PrincipleChecks
}) {
  const treatment = input.treatmentVar ?? "核心解释变量"
  if (input.principleChecks?.claim_ceiling === "blocked") {
    return input.principleChecks.findings[0] ?? "当前结果不支持得出因果判断。"
  }
  if (input.principleChecks?.claim_ceiling === "restricted") {
    if (input.coefficient === undefined || input.pValue === undefined) {
      return `${treatment} 的经验结果仍需补充诊断，目前只能做受限解释。`
    }
    const direction = input.coefficient > 0 ? "为正" : input.coefficient < 0 ? "为负" : "接近于零"
    return `${treatment} 系数${direction}，但识别前提或诊断不完整，只能作为受限证据。`
  }
  if (input.coefficient === undefined || input.pValue === undefined) {
    return "模型已完成，但核心统计结果还不完整。"
  }
  const direction = input.coefficient > 0 ? "为正" : input.coefficient < 0 ? "为负" : "接近于零"
  if (input.pValue < 0.05) return `${treatment} 系数${direction}，且统计上显著。`
  if (input.pValue < 0.1) return `${treatment} 系数${direction}，但统计证据偏弱。`
  return `${treatment} 系数${direction}，但统计上不显著。`
}

function buildEconometricsWarnings(input: {
  result: PythonResult
  qaGate: {
    qaGateStatus?: string
    qaGateReason?: string
  }
  principleChecks?: PrincipleChecks
}) {
  return [
    ...(input.result.warnings ?? []),
    ...(input.result.blocking_errors ?? []),
    ...(input.result.post_estimation_gates ?? [])
      .filter((gate) => !gate.passed)
      .map((gate) => `${gate.gate}: ${gate.userMessage}`),
    input.qaGate.qaGateStatus === "warn" || input.qaGate.qaGateStatus === "block"
      ? input.qaGate.qaGateReason
      : undefined,
    input.result.degraded_from ? `模型已从 ${input.result.degraded_from} 调整为 ${input.result.effective_method ?? "当前方法"}` : undefined,
    ...(input.principleChecks?.findings ?? []),
  ].filter((item): item is string => Boolean(item))
}

function buildEconometricsHeadline(input: {
  treatmentVar?: string
  dependentVar?: string
  coefficient?: number
  pValue?: number
  principleChecks?: PrincipleChecks
}) {
  const treatment = input.treatmentVar ?? "核心解释变量"
  const dependent = input.dependentVar ?? "结果变量"
  if (input.principleChecks?.claim_ceiling === "blocked") {
    return "识别前提未通过，当前结果不支持直接报告为实证结论。"
  }
  if (input.principleChecks?.claim_ceiling === "restricted") {
    return `当前模型给出了 ${treatment} 对 ${dependent} 的方向性线索，但结论只能受限表述。`
  }
  if (input.coefficient === undefined || input.pValue === undefined) {
    return "模型已经完成，但还没有足够的结果可直接转述。"
  }
  const direction = input.coefficient > 0 ? "正向" : input.coefficient < 0 ? "负向" : "接近于零"
  if (input.pValue < 0.05) {
    return `在当前模型下，${treatment} 对 ${dependent} 呈${direction}影响，而且统计上较稳。`
  }
  if (input.pValue < 0.1) {
    return `在当前模型下，${treatment} 对 ${dependent} 呈${direction}影响，但统计证据还不够强。`
  }
  return `在当前模型下，${treatment} 对 ${dependent} 的方向是${direction}，但目前统计显著性不足，不能下强结论。`
}

export function buildEconometricsConclusionLegacy(input: {
  treatmentVar?: string
  coefficient?: number
  pValue?: number
}) {
  const treatment = input.treatmentVar ?? "核心解释变量"
  if (input.coefficient === undefined || input.pValue === undefined) {
    return "模型已完成，但核心统计结果还不完整。"
  }
  const direction = input.coefficient > 0 ? "为正" : input.coefficient < 0 ? "为负" : "接近于零"
  if (input.pValue < 0.05) return `${treatment} 系数${direction}，且统计上显著。`
  if (input.pValue < 0.1) return `${treatment} 系数${direction}，但统计证据较弱。`
  return `${treatment} 系数${direction}，但统计上不显著。`
}

export function buildEconometricsWarningsLegacy(input: {
  result: PythonResult
  qaGate: {
    qaGateStatus?: string
    qaGateReason?: string
  }
}) {
  return [
    ...(input.result.warnings ?? []),
    ...(input.result.blocking_errors ?? []),
    ...(input.result.post_estimation_gates ?? [])
      .filter((gate) => !gate.passed)
      .map((gate) => `${gate.gate}: ${gate.userMessage}`),
    input.qaGate.qaGateStatus === "warn" || input.qaGate.qaGateStatus === "block"
      ? input.qaGate.qaGateReason
      : undefined,
    input.result.degraded_from
      ? `模型已从 ${input.result.degraded_from} 调整为 ${input.result.effective_method ?? "当前方法"}`
      : undefined,
  ].filter((item): item is string => Boolean(item))
}

export function buildEconometricsHeadlineLegacy(input: {
  treatmentVar?: string
  dependentVar?: string
  coefficient?: number
  pValue?: number
}) {
  const treatment = input.treatmentVar ?? "核心解释变量"
  const dependent = input.dependentVar ?? "结果变量"
  if (input.coefficient === undefined || input.pValue === undefined) {
    return "模型已经完成，但还没有足够的结果可直接转述。"
  }
  const direction = input.coefficient > 0 ? "正向" : input.coefficient < 0 ? "负向" : "接近于零"
  if (input.pValue < 0.05) {
    return `在当前模型下，${treatment}对${dependent}呈${direction}影响，而且统计上较稳。`
  }
  if (input.pValue < 0.1) {
    return `在当前模型下，${treatment}对${dependent}呈${direction}影响，但统计证据还不算强。`
  }
  return `在当前模型下，${treatment}对${dependent}的方向是${direction}，但目前统计显著性不足，不能下强结论。`
}

function buildEconometricsPresentation(input: {
  params: {
    methodName: MethodName
    dependentVar?: string
    treatmentVar?: string
    entityVar?: string
    timeVar?: string
    clusterVar?: string
    covariates?: string[]
  }
  result: PythonResult
  qaGate: {
    qaGateStatus?: string
    qaGateReason?: string
  }
  principleChecks?: PrincipleChecks
  conciseResultPath: string
  deliveryBundlePath?: string
  publishedFiles: EconometricsPublishedFile[]
}): ToolPresentation {
  const { params, result, qaGate, principleChecks, conciseResultPath, deliveryBundlePath, publishedFiles } = input
  const warnings = [
    ...(result.warnings ?? []),
    ...(result.blocking_errors ?? []),
    ...(result.post_estimation_gates ?? [])
      .filter((gate) => !gate.passed)
      .map((gate) => `${gate.gate}: ${gate.userMessage}`),
    qaGate.qaGateStatus === "warn" ? qaGate.qaGateReason : undefined,
    qaGate.qaGateStatus === "block" ? qaGate.qaGateReason : undefined,
    ...(principleChecks?.findings ?? []),
    result.degraded_from ? `模型已从 ${result.degraded_from} 调整为 ${result.effective_method ?? params.methodName}` : undefined,
  ].filter((item): item is string => Boolean(item))
  const status = derivePresentationStatus({
    success: result.success,
    qaGateStatus: qaGate.qaGateStatus,
    warnings,
    blockingErrors: result.blocking_errors,
  })

  return createPresentation({
    kind: "econometrics",
    title: "实证分析结果",
    headline: buildEconometricsHeadline({
      treatmentVar: params.treatmentVar,
      dependentVar: params.dependentVar,
      coefficient: result.coefficient,
      pValue: result.p_value,
      principleChecks,
    }),
    status,
    summary: [
      `本次采用 ${result.effective_method ?? params.methodName} 进行估计。`,
      params.entityVar && params.timeVar ? `模型包含 ${params.entityVar} 和 ${params.timeVar} 固定效应。` : undefined,
      result.rows_used !== undefined ? `本次实际用于估计的样本量为 ${result.rows_used}。` : undefined,
    ],
    keyMetrics: [
      presentationMetric(
        "系数",
        result.coefficient !== undefined ? result.coefficient.toFixed(4) : undefined,
        result.coefficient !== undefined
          ? { tone: result.coefficient >= 0 ? "positive" : "caution", explain: params.treatmentVar }
          : undefined,
      ),
      presentationMetric("标准误", result.std_error !== undefined ? result.std_error.toFixed(4) : undefined),
      presentationMetric(
        "P 值",
        result.p_value !== undefined ? result.p_value.toFixed(4) : undefined,
        result.p_value !== undefined
          ? { tone: result.p_value < 0.05 ? "positive" : result.p_value < 0.1 ? "caution" : "critical" }
          : undefined,
      ),
      presentationMetric("调整后 R²", result.r_squared !== undefined ? result.r_squared.toFixed(4) : undefined),
      presentationMetric("样本量", result.rows_used),
    ],
    highlights: [
      params.dependentVar ? `被解释变量：${params.dependentVar}` : undefined,
      params.treatmentVar ? `核心解释变量：${params.treatmentVar}` : undefined,
      params.clusterVar ?? result.cluster_var ? `标准误聚类：${params.clusterVar ?? result.cluster_var}` : undefined,
      params.covariates?.length ? `控制变量：${params.covariates.join("、")}` : "当前未加入控制变量。",
    ],
    risks: warnings,
    nextActions:
      result.p_value !== undefined && result.p_value < 0.05
        ? ["可以继续做稳健性检验，确认这个结果是否稳定。", "如果要写报告，优先查看结果摘要和三线表。"]
        : ["建议先查看诊断文件，确认模型设定和数据质量是否可靠。", "如果要增强说服力，可加入控制变量或继续做稳健性检验。"],
    artifactGroups: [
      artifactGroup("核心结论", [
        presentationArtifact("结果摘要", conciseResultPath),
        presentationArtifact("结果汇报 Word", result.delivery_report_docx_path),
        presentationArtifact("结果 JSON", result.output_path),
        presentationArtifact("叙述总结", result.narrative_path),
      ]),
      artifactGroup("可引用表格", [
        presentationArtifact("系数表 CSV", result.coefficients_path),
        presentationArtifact("系数表工作簿", result.workbook_path),
        presentationArtifact("三线表 Markdown", result.academic_table_markdown_path),
        presentationArtifact("三线表 LaTeX", result.academic_table_latex_path),
        presentationArtifact("三线表 Excel", result.academic_table_workbook_path),
        presentationArtifact("三线表 Word", result.academic_table_docx_path),
      ]),
      artifactGroup("诊断与风险", [
        presentationArtifact("诊断文件", result.diagnostics_path),
        presentationArtifact("模型元数据", result.metadata_path),
        presentationArtifact("模型摘要", result.summary_path),
        presentationArtifact("数值快照", result.numeric_snapshot_path),
      ]),
      artifactGroup("交付文件", [
        ...publishedFiles.map((item) => presentationArtifact(item.label, item.relativePath)),
        presentationArtifact("交付包目录", deliveryBundlePath),
      ]),
    ],
  })
}

function sanitizeDeliveryFilePart(value: string) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
}

function readPanelClusterCount(diagnosticsPath?: string) {
  if (!diagnosticsPath || !fs.existsSync(diagnosticsPath)) return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(diagnosticsPath, "utf-8")) as {
      panel?: { cluster_count?: number }
    }
    return typeof parsed.panel?.cluster_count === "number" ? parsed.panel.cluster_count : undefined
  } catch {
    return undefined
  }
}

export function buildConciseResultMarkdown(params: {
  methodName: MethodName
  result: PythonResult
  treatmentLabel?: string
  principleChecks?: PrincipleChecks
}) {
  const lines = ["回归结果"]
  if (params.principleChecks?.claim_ceiling === "blocked") {
    lines.push("- 经验结论状态：blocked")
    lines.push(`- 原因：${params.principleChecks.findings[0] ?? "识别前提未通过"}`)
    return lines.join("\n") + "\n"
  }

  if (!params.result.numeric_snapshot_path) {
    lines.push("- 数值状态：missing numeric_snapshot")
    lines.push("- 当前不展示系数、标准误、p 值或显著性判断。")
    if (params.principleChecks?.findings.length) {
      lines.push(`- 说明：${params.principleChecks.findings[0]}`)
    }
    return lines.join("\n") + "\n"
  }

  if (params.principleChecks?.claim_ceiling === "restricted") {
    lines.push("- 经验结论状态：restricted")
  }

  const coefficientLabel = params.treatmentLabel ? `${params.treatmentLabel} 系数` : "核心系数"
  if (params.result.coefficient !== undefined) lines.push(`- ${coefficientLabel}：${params.result.coefficient.toFixed(4)}`)
  if (params.result.std_error !== undefined) lines.push(`- 标准误：${params.result.std_error.toFixed(4)}`)
  if (params.result.p_value !== undefined) lines.push(`- p 值：${params.result.p_value.toFixed(4)}`)
  if (params.result.rows_used !== undefined) lines.push(`- N：${params.result.rows_used}`)
  const clusterCount = params.methodName === "panel_fe_regression" ? readPanelClusterCount(params.result.diagnostics_path) : undefined
  if (clusterCount !== undefined) lines.push(`- 组数：${clusterCount}`)
  if (params.result.r_squared !== undefined) {
    const r2Label = params.methodName === "panel_fe_regression" ? "within R²" : "Adj. R²"
    lines.push(`- ${r2Label}：${params.result.r_squared.toFixed(4)}`)
  }
  if (params.principleChecks?.findings.length) {
    lines.push(`- 说明：${params.principleChecks.findings[0]}`)
  }
  return lines.join("\n") + "\n"
}

export function buildConciseResultMarkdownLegacy(params: {
  methodName: MethodName
  result: PythonResult
  treatmentLabel?: string
}) {
  const lines = ["回归结果"]
  const coefficientLabel = params.treatmentLabel ? `${params.treatmentLabel} 系数` : "核心系数"
  if (params.result.coefficient !== undefined) lines.push(`- ${coefficientLabel}：${params.result.coefficient.toFixed(4)}`)
  if (params.result.std_error !== undefined) lines.push(`- 标准误：${params.result.std_error.toFixed(4)}`)
  if (params.result.p_value !== undefined) lines.push(`- p 值：${params.result.p_value.toFixed(4)}`)
  if (params.result.rows_used !== undefined) lines.push(`- N：${params.result.rows_used}`)
  const clusterCount = params.methodName === "panel_fe_regression" ? readPanelClusterCount(params.result.diagnostics_path) : undefined
  if (clusterCount !== undefined) lines.push(`- 组数：${clusterCount}`)
  if (params.result.r_squared !== undefined) {
    const r2Label = params.methodName === "panel_fe_regression" ? "within R²" : "Adj. R²"
    lines.push(`- ${r2Label}：${params.result.r_squared.toFixed(4)}`)
  }
  return lines.join("\n") + "\n"
}

type BaselineReportSection = {
  heading: string
  body: string
}

type BaselineReportDocxPayload = {
  title: string
  output_path: string
  sections: BaselineReportSection[]
  closing_note: string
}

type BaselineReportDocxResult = {
  success: boolean
  output_path?: string
  error?: string
  traceback?: string
  error_log_path?: string
}

type WorkbookExportResult = {
  success: boolean
  output_path?: string
  rows?: number
  columns?: number
  error?: string
  traceback?: string
  error_log_path?: string
}

function readClusterCountFromResult(result: PythonResult) {
  const gateCount = result.post_estimation_gates?.find(
    (gate) => gate.gate === "cluster_count" && typeof gate.diagnosticValue === "number",
  )?.diagnosticValue
  if (typeof gateCount === "number") return gateCount
  return readPanelClusterCount(result.diagnostics_path)
}

function significanceDescription(pValue?: number) {
  if (pValue === undefined) return "统计显著性暂不可判定"
  if (pValue < 0.01) return "1% 水平上显著"
  if (pValue < 0.05) return "5% 水平上显著"
  if (pValue < 0.1) return "10% 水平上显著"
  return "常用统计水平上不显著"
}

function coefficientDirection(coefficient?: number) {
  if (coefficient === undefined) return "接近于零"
  if (coefficient > 0) return "正向"
  if (coefficient < 0) return "负向"
  return "接近于零"
}

function hasSignificantRegressionResult(result: PythonResult) {
  return typeof result.p_value === "number" && result.p_value < 0.1
}

function buildBaselineReportDocxPayload(input: {
  methodName: MethodName
  outputPath: string
  result: PythonResult
  dependentVar?: string
  treatmentVar?: string
  covariates?: string[]
  entityVar?: string
  timeVar?: string
  clusterVar?: string
  tableDocxFileName?: string
  qaGateReason?: string
}) {
  if (input.methodName !== "panel_fe_regression") return undefined
  if (
    input.result.coefficient === undefined ||
    input.result.std_error === undefined ||
    input.result.p_value === undefined ||
    input.result.r_squared === undefined ||
    input.result.rows_used === undefined
  ) {
    return undefined
  }

  const dependentVar = input.dependentVar ?? "被解释变量"
  const treatmentVar = input.treatmentVar ?? "核心解释变量"
  const entityVar = input.entityVar ?? "个体"
  const timeVar = input.timeVar ?? "时间"
  const clusterVar = input.clusterVar ?? input.result.cluster_var ?? entityVar
  const controlText =
    input.covariates?.length && input.covariates.length > 0
      ? `并控制${input.covariates.join("、")}等变量`
      : "不额外加入控制变量"
  const groupCount = readClusterCountFromResult(input.result)
  const groupText = groupCount !== undefined ? `，覆盖 ${groupCount} 个${entityVar}组别` : ""
  const significanceText = significanceDescription(input.result.p_value)
  const direction = coefficientDirection(input.result.coefficient)
  const directionMeaning =
    direction === "正向"
      ? `呈现正向联动`
      : direction === "负向"
        ? `呈现负向联动`
        : "影响方向接近于零"

  const setupSection: BaselineReportSection = {
    heading: "模型设定",
    body:
      `本文采用双向固定效应模型对基准关系进行估计，以${dependentVar}为被解释变量，以${treatmentVar}为核心解释变量，` +
      `${controlText}，同时控制${entityVar}固定效应和${timeVar}固定效应，并按${clusterVar}聚类计算稳健标准误。` +
      `本次基准回归共使用 ${input.result.rows_used} 个观测值${groupText}。`,
  }

  const resultsSection: BaselineReportSection = {
    heading: "结果汇报",
    body:
      `基准回归结果显示，${treatmentVar}的估计系数为 ${input.result.coefficient.toFixed(4)}，标准误为 ${input.result.std_error.toFixed(4)}，` +
      `p 值为 ${input.result.p_value.toFixed(4)}，在${significanceText}。从符号和数量级看，${treatmentVar}与${dependentVar}${directionMeaning}。` +
      `模型的 within R² 为 ${input.result.r_squared.toFixed(4)}，说明在当前设定下模型对样本内变异具有较好的解释力。`,
  }

  const implicationSection: BaselineReportSection = {
    heading: "经济含义",
    body:
      `就经济含义而言，在控制地区异质性、年份共同冲击及一系列可观测特征后，核心解释变量的边际变化与${dependentVar}之间表现出${direction}关系。` +
      (input.result.p_value < 0.1
        ? `这一结果为研究假说提供了初步支持，但其解释仍应结合后续稳健性检验与替代设定进一步确认。`
        : `这一结果提示基准关系的方向已经显现，但统计证据仍然偏弱，因此更适合作为论文中的基准证据而非单独支撑强因果结论。`),
  }

  const warnings = [...(input.result.warnings ?? [])]
  if (input.qaGateReason && !warnings.includes(input.qaGateReason)) warnings.push(input.qaGateReason)
  const sections = [setupSection, resultsSection, implicationSection]
  if (warnings.length) {
    sections.push({
      heading: "稳健提示",
      body:
        `需要说明的是，本次估计存在以下非阻塞提示：${warnings.join("；")}。` +
        `上述问题不改变基准回归结果的可报告性，但在正式写作中宜如实披露，并在后续稳健性检验中进一步核验。`,
    })
  }

  return {
    title: "基准回归结果汇报",
    output_path: input.outputPath,
    sections,
    closing_note: `详见随附三线表《${input.tableDocxFileName ?? "三线表_panel_fe_regression.docx"}》。`,
  } satisfies BaselineReportDocxPayload
}

function buildBaselineReportDocxPythonScript(payloadB64: string) {
  return `
import base64
import json
import traceback
from pathlib import Path

from docx import Document
from docx.enum.text import WD_PARAGRAPH_ALIGNMENT
from docx.oxml.ns import qn
from docx.shared import Inches, Pt

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"
ERRORS_DIR = r"${projectErrorsRoot().replace(/\\/g, "\\\\")}"

def emit(result):
    print(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=False)}")

def save_json(file_path, payload):
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

def safe_error_path():
    error_dir = Path(ERRORS_DIR)
    error_dir.mkdir(parents=True, exist_ok=True)
    from datetime import datetime
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return str(error_dir / f"econometrics_report_docx_{stamp}_error.json")

def apply_font(run, size=12, bold=False):
    run.font.name = "Times New Roman"
    run._element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
    run.font.size = Pt(size)
    run.bold = bold

payload = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))

try:
    output_path = Path(payload["output_path"])
    output_path.parent.mkdir(parents=True, exist_ok=True)

    document = Document()
    section = document.sections[0]
    section.top_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1)

    normal_style = document.styles["Normal"]
    normal_style.font.name = "Times New Roman"
    normal_style.font.size = Pt(12)

    title = document.add_paragraph()
    title.alignment = WD_PARAGRAPH_ALIGNMENT.CENTER
    title_run = title.add_run(payload["title"])
    apply_font(title_run, size=16, bold=True)
    title.paragraph_format.space_after = Pt(18)

    for section_payload in payload.get("sections", []):
        heading = document.add_paragraph()
        heading_run = heading.add_run(section_payload["heading"])
        apply_font(heading_run, size=13, bold=True)
        heading.paragraph_format.space_before = Pt(6)
        heading.paragraph_format.space_after = Pt(6)

        body = document.add_paragraph()
        body_run = body.add_run(section_payload["body"])
        apply_font(body_run, size=12)
        body.paragraph_format.first_line_indent = Inches(0.28)
        body.paragraph_format.line_spacing = 1.5
        body.paragraph_format.space_after = Pt(10)

    closing = document.add_paragraph()
    closing_run = closing.add_run(payload["closing_note"])
    apply_font(closing_run, size=12)
    closing.paragraph_format.space_before = Pt(6)
    closing.paragraph_format.line_spacing = 1.5

    document.save(output_path)
    emit({
        "success": True,
        "output_path": str(output_path),
    })
except Exception as exc:
    result = {
        "success": False,
        "error": str(exc),
        "traceback": traceback.format_exc(),
    }
    error_path = safe_error_path()
    result["error_log_path"] = error_path
    save_json(error_path, result)
    emit(result)
`
}

async function generateBaselineReportDocx(input: {
  methodName: MethodName
  outputDir: string
  pythonCommand: string
  result: PythonResult
  dependentVar?: string
  treatmentVar?: string
  covariates?: string[]
  entityVar?: string
  timeVar?: string
  clusterVar?: string
  qaGateReason?: string
}) {
  const outputPath = path.join(input.outputDir, "result_report.docx")
  const payload = buildBaselineReportDocxPayload({
    methodName: input.methodName,
    outputPath,
    result: input.result,
    dependentVar: input.dependentVar,
    treatmentVar: input.treatmentVar,
    covariates: input.covariates,
    entityVar: input.entityVar,
    timeVar: input.timeVar,
    clusterVar: input.clusterVar,
    tableDocxFileName: "三线表_panel_fe_regression.docx",
    qaGateReason: input.qaGateReason,
  })
  if (!payload) return undefined

  const execution = await runInlinePython({
    command: input.pythonCommand,
    script: buildBaselineReportDocxPythonScript(encodePythonPayload(payload)),
    cwd: Instance.directory,
  })
  const { code, stdout, stderr } = execution
  if (code !== 0) {
    const failureArtifacts = persistPythonFailureArtifacts({
      label: `${input.methodName}_report_docx_nonzero_exit`,
      command: input.pythonCommand,
      cwd: Instance.directory,
      execution,
      context: {
        methodName: input.methodName,
        outputDir: input.outputDir,
      },
    })
    throw new Error(
      `Failed to build report docx with Python ${input.pythonCommand} (exit code ${code})` +
        `\nCrash script: ${relativeWithinProject(failureArtifacts.scriptCopyPath)}` +
        `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
        `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
        `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
    )
  }

  const result = parsePythonResult<BaselineReportDocxResult>(stdout)
  execution.cleanup()
  if (!result.success || !result.output_path) {
    throw new Error(`Failed to build report docx: ${result.error ?? "unknown error"}\n${result.traceback ?? ""}`)
  }
  return result.output_path
}

function buildJournalPaperDocxPayload(input: {
  methodName: MethodName
  outputPath: string
  result: PythonResult
  dependentVar?: string
  treatmentVar?: string
  covariates?: string[]
  entityVar?: string
  timeVar?: string
  clusterVar?: string
  qaGateReason?: string
}) {
  const dependentVar = input.dependentVar ?? "被解释变量"
  const treatmentVar = input.treatmentVar ?? "核心解释变量"
  const entityVar = input.entityVar ?? "个体"
  const timeVar = input.timeVar ?? "时间"
  const clusterVar = input.clusterVar ?? input.result.cluster_var ?? entityVar
  const methodLabel = input.methodName === "panel_fe_regression" ? "双向固定效应模型" : input.methodName
  const controls =
    input.covariates?.length && input.covariates.length > 0
      ? `控制变量包括${input.covariates.join("、")}。`
      : "本次设定未额外加入控制变量。"
  const sampleText = input.result.rows_used !== undefined ? `估计样本量为 ${input.result.rows_used}。` : "估计样本量见随附审计材料。"
  const coefficientText =
    input.result.coefficient !== undefined
      ? `核心估计系数为 ${input.result.coefficient.toFixed(4)}`
      : "核心估计系数见随附回归结果"
  const stdErrorText = input.result.std_error !== undefined ? `，标准误为 ${input.result.std_error.toFixed(4)}` : ""
  const pValueText = input.result.p_value !== undefined ? `，p 值为 ${input.result.p_value.toFixed(4)}` : ""
  const r2Text = input.result.r_squared !== undefined ? `，模型 R2 为 ${input.result.r_squared.toFixed(4)}` : ""
  const significanceText = input.result.p_value !== undefined ? `，统计显著性为${significanceDescription(input.result.p_value)}` : ""
  const warnings = [...(input.result.warnings ?? [])]
  if (input.qaGateReason && !warnings.includes(input.qaGateReason)) warnings.push(input.qaGateReason)

  const sections: BaselineReportSection[] = [
    {
      heading: "摘要",
      body:
        `本文基于当前清洗后的分析样本，考察${treatmentVar}对${dependentVar}的影响。` +
        `研究采用${methodLabel}进行估计，${sampleText}结果显示，${coefficientText}${stdErrorText}${pValueText}${r2Text}${significanceText}。`,
    },
    {
      heading: "模型设定",
      body:
        `本文以${dependentVar}作为被解释变量，以${treatmentVar}作为核心解释变量。${controls}` +
        `在面板设定下，模型控制${entityVar}固定效应和${timeVar}固定效应，并按${clusterVar}聚类计算标准误。`,
    },
    {
      heading: "实证结果",
      body:
        `基准回归结果见随附三线表。${coefficientText}${stdErrorText}${pValueText}。` +
        `该结果用于描述当前模型设定下核心变量与结果变量之间的统计关系，正式论文写作中仍应结合研究设计、识别假设和稳健性检验进行解释。`,
    },
    {
      heading: "结论与讨论",
      body:
        `总体来看，本次估计为研究问题提供了可复核的基准证据。` +
        `后续写作应进一步补充机制检验、异质性分析或稳健性检验，以增强结论的学术说服力。`,
    },
  ]

  if (warnings.length) {
    sections.push({
      heading: "研究限制",
      body: `需要说明的是，本次分析存在以下提示：${warnings.join("；")}。这些信息应在正式论文中如实披露。`,
    })
  }

  return {
    title: `期刊格式实证小论文：${methodLabel}`,
    output_path: input.outputPath,
    sections,
    closing_note: "本文为基于本次回归结果自动生成的期刊格式小论文初稿，具体理论阐释和文献对话仍需人工补充。",
  } satisfies BaselineReportDocxPayload
}

async function generateJournalPaperDocx(input: {
  methodName: MethodName
  outputDir: string
  pythonCommand: string
  result: PythonResult
  dependentVar?: string
  treatmentVar?: string
  covariates?: string[]
  entityVar?: string
  timeVar?: string
  clusterVar?: string
  qaGateReason?: string
}) {
  const outputPath = path.join(input.outputDir, "journal_paper.docx")
  const payload = buildJournalPaperDocxPayload({
    methodName: input.methodName,
    outputPath,
    result: input.result,
    dependentVar: input.dependentVar,
    treatmentVar: input.treatmentVar,
    covariates: input.covariates,
    entityVar: input.entityVar,
    timeVar: input.timeVar,
    clusterVar: input.clusterVar,
    qaGateReason: input.qaGateReason,
  })

  const execution = await runInlinePython({
    command: input.pythonCommand,
    script: buildBaselineReportDocxPythonScript(encodePythonPayload(payload)),
    cwd: Instance.directory,
  })
  const { code, stdout } = execution
  if (code !== 0) {
    const failureArtifacts = persistPythonFailureArtifacts({
      label: `${input.methodName}_journal_paper_docx_nonzero_exit`,
      command: input.pythonCommand,
      cwd: Instance.directory,
      execution,
      context: {
        methodName: input.methodName,
        outputDir: input.outputDir,
      },
    })
    throw new Error(
      `Failed to build journal paper docx with Python ${input.pythonCommand} (exit code ${code})` +
        `\nCrash script: ${relativeWithinProject(failureArtifacts.scriptCopyPath)}` +
        `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
        `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
        `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
    )
  }

  const result = parsePythonResult<BaselineReportDocxResult>(stdout)
  execution.cleanup()
  if (!result.success || !result.output_path) {
    throw new Error(`Failed to build journal paper docx: ${result.error ?? "unknown error"}\n${result.traceback ?? ""}`)
  }
  return result.output_path
}

function buildAnalysisWorkbookPythonScript(payloadB64: string) {
  return `
import base64
import json
import traceback
from pathlib import Path

import pandas as pd

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"
ERRORS_DIR = r"${projectErrorsRoot().replace(/\\/g, "\\\\")}"

def emit(result):
    print(RESULT_PREFIX + json.dumps(result, ensure_ascii=False))

def save_json(path, payload):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

def safe_error_path():
    error_dir = Path(ERRORS_DIR)
    error_dir.mkdir(parents=True, exist_ok=True)
    return str(error_dir / "econometrics_analysis_workbook_error.json")

def read_table(file_path):
    path = Path(file_path)
    suffix = path.suffix.lower()
    if suffix in [".xlsx", ".xls"]:
        return pd.read_excel(path)
    if suffix == ".csv":
        try:
            return pd.read_csv(path, encoding="utf-8-sig")
        except UnicodeDecodeError:
            return pd.read_csv(path, encoding="gbk")
    if suffix == ".dta":
        return pd.read_stata(path, convert_categoricals=False)
    if suffix == ".parquet":
        return pd.read_parquet(path)
    raise ValueError(f"Unsupported analysis data format: {suffix}")

try:
    payload = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))
    input_path = Path(payload["input_path"])
    output_path = Path(payload["output_path"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    df = read_table(input_path)
    with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="analysis_data", index=False)
    emit({
        "success": True,
        "output_path": str(output_path),
        "rows": int(len(df)),
        "columns": int(len(df.columns)),
    })
except Exception as exc:
    result = {
        "success": False,
        "error": str(exc),
        "traceback": traceback.format_exc(),
    }
    error_path = safe_error_path()
    result["error_log_path"] = error_path
    save_json(error_path, result)
    emit(result)
`
}

async function generateFinalAnalysisWorkbook(input: {
  dataPath: string
  outputDir: string
  pythonCommand: string
  methodName: MethodName
}) {
  const outputPath = path.join(input.outputDir, "final_analysis_data.xlsx")
  const execution = await runInlinePython({
    command: input.pythonCommand,
    script: buildAnalysisWorkbookPythonScript(encodePythonPayload({
      input_path: input.dataPath,
      output_path: outputPath,
    })),
    cwd: Instance.directory,
  })
  const { code, stdout } = execution
  if (code !== 0) {
    const failureArtifacts = persistPythonFailureArtifacts({
      label: `${input.methodName}_analysis_workbook_nonzero_exit`,
      command: input.pythonCommand,
      cwd: Instance.directory,
      execution,
      context: {
        methodName: input.methodName,
        dataPath: input.dataPath,
        outputDir: input.outputDir,
      },
    })
    throw new Error(
      `Failed to build final analysis workbook with Python ${input.pythonCommand} (exit code ${code})` +
        `\nCrash script: ${relativeWithinProject(failureArtifacts.scriptCopyPath)}` +
        `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
        `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
        `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
    )
  }

  const result = parsePythonResult<WorkbookExportResult>(stdout)
  execution.cleanup()
  if (!result.success || !result.output_path) {
    throw new Error(`Failed to build final analysis workbook: ${result.error ?? "unknown error"}\n${result.traceback ?? ""}`)
  }
  return result.output_path
}

function hasNonEmptyCoefficientTable(filePath?: string) {
  if (!filePath || !fs.existsSync(filePath)) return false
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter((line) => line.trim().length > 0)
  return lines.length > 1
}

function loadJsonFile<T>(filePath?: string) {
  if (!filePath || !fs.existsSync(filePath)) return undefined
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
}

type SmartProfilePythonResult = {
  success: boolean
  error?: string
  traceback?: string
  row_count: number
  column_count: number
  columns: Array<{
    name: string
    dtype_family: SmartColumnProfile["dtypeFamily"]
    non_null_count: number
    unique_count: number
    binary: boolean
    numeric: boolean
    datetime: boolean
    integer_like: boolean
    nonnegative: boolean
  }>
  entity_count?: number
  time_count?: number
  duplicate_panel_keys?: number
  avg_periods_per_entity?: number
  balanced_ratio?: number
}

type ConcreteMethodName = Exclude<MethodName, "auto_recommend" | "smart_baseline">

type SmartBaselinePlan = {
  methodName: ConcreteMethodName
  dependentVar: string
  treatmentVar: string
  covariates?: string[]
  entityVar?: string
  timeVar?: string
  clusterVar?: string
  options?: Record<string, unknown>
  planningTrace: Array<{ kind: string; message: string }>
}

function covarianceForGeneralRegression(strategy: SmartRecommendation["covariance"]) {
  if (strategy === "robust") return "HC1"
  if (strategy === "hac") return { HAC: 1 }
  return "nonrobust"
}

function covarianceForPanelDid(strategy: SmartRecommendation["covariance"], hasPanelKeys: boolean) {
  if (strategy === "cluster" && hasPanelKeys) return "cluster_entity"
  if (strategy === "robust" || strategy === "hac") return "robust"
  return "unadjusted"
}

function buildSmartBaselinePlan(input: {
  params: {
    dependentVar?: string
    treatmentVar?: string
    covariates?: string[]
    entityVar?: string
    timeVar?: string
    clusterVar?: string
    options?: Record<string, unknown>
  }
  profile: SmartDatasetProfile
  recommendation: SmartRecommendation
}): SmartBaselinePlan {
  if (!input.params.dependentVar || !input.params.treatmentVar) {
    throw new Error("smart_baseline requires dependentVar and treatmentVar")
  }

  const planningTrace: Array<{ kind: string; message: string }> = []
  const options = { ...(input.params.options ?? {}) }
  let methodName: ConcreteMethodName = input.recommendation.recommendedMethod
  let entityVar = input.params.entityVar ?? input.recommendation.preferredEntityVar
  let timeVar = input.params.timeVar ?? input.recommendation.preferredTimeVar
  const clusterVar = input.params.clusterVar ?? input.recommendation.preferredClusterVar ?? entityVar

  if (methodName === "panel_fe_regression") {
    if (!entityVar || !timeVar) {
      methodName = "ols_regression"
      planningTrace.push({
        kind: "fallback",
        message: "Panel FE was recommended, but entity/time identifiers were incomplete, so smart_baseline fell back to OLS.",
      })
    } else {
      options.auto_downgrade = options.auto_downgrade ?? true
    }
  }

  if (methodName === "did_static") {
    const treatmentEntityDummy = typeof options.treatment_entity_dummy === "string" ? options.treatment_entity_dummy : undefined
    const treatmentFinishedDummy = typeof options.treatment_finished_dummy === "string" ? options.treatment_finished_dummy : undefined
    if (!entityVar || !timeVar || !treatmentEntityDummy || !treatmentFinishedDummy) {
      methodName = entityVar && timeVar ? "panel_fe_regression" : "ols_regression"
      planningTrace.push({
        kind: "fallback",
        message:
          "DID was suggested, but smart_baseline could not find the required treatment_entity_dummy/treatment_finished_dummy fields, so it fell back to an executable baseline.",
      })
      options.auto_downgrade = options.auto_downgrade ?? true
    } else {
      options.cov_type = options.cov_type ?? covarianceForPanelDid(input.recommendation.covariance, true)
    }
  }

  if (methodName === "iv_2sls") {
    const ivVariable =
      typeof options.iv_variable === "string" && options.iv_variable.trim()
        ? options.iv_variable
        : input.profile.candidateInstrumentVars[0]
    if (!ivVariable) {
      methodName = entityVar && timeVar ? "panel_fe_regression" : "ols_regression"
      planningTrace.push({
        kind: "fallback",
        message: "IV was suggested, but no usable instrument variable could be resolved, so smart_baseline fell back to a directly estimable baseline.",
      })
      options.auto_downgrade = options.auto_downgrade ?? true
    } else {
      options.iv_variable = ivVariable
      options.cov_type = options.cov_type ?? covarianceForGeneralRegression(input.recommendation.covariance)
      planningTrace.push({
        kind: "selection",
        message: `Smart_baseline selected ${ivVariable} as the instrument variable for IV-2SLS.`,
      })
    }
  }

  if (methodName === "psm_double_robust") {
    if (!input.params.covariates?.length) {
      methodName = "ols_regression"
      planningTrace.push({
        kind: "fallback",
        message: "Double robust PSM was suggested, but no covariates were provided, so smart_baseline fell back to OLS.",
      })
    } else {
      options.cov_type = options.cov_type ?? (input.recommendation.covariance === "robust" ? "HC1" : undefined)
    }
  }

  if (methodName === "ols_regression") {
    options.cov_type = options.cov_type ?? covarianceForGeneralRegression(input.recommendation.covariance)
  }

  if (methodName === "panel_fe_regression") {
    options.auto_downgrade = options.auto_downgrade ?? true
  }

  if (!planningTrace.length) {
    planningTrace.push({
      kind: "selection",
      message: `Smart_baseline selected ${methodName} as the executable baseline implied by the recommendation layer.`,
    })
  }

  return {
    methodName,
    dependentVar: input.params.dependentVar,
    treatmentVar: input.params.treatmentVar,
    covariates: input.params.covariates,
    entityVar,
    timeVar,
    clusterVar,
    options,
    planningTrace,
  }
}

function buildAutoRecommendPythonScript(payloadBase64: string) {
  return `
import base64
import json
import os
import traceback
from pathlib import Path

import pandas as pd
from pandas.api.types import is_bool_dtype, is_datetime64_any_dtype, is_numeric_dtype

PAYLOAD = json.loads(base64.b64decode("${payloadBase64}").decode("utf-8"))
PREFIX = "${PYTHON_RESULT_PREFIX}"

def emit(obj):
    print(PREFIX + json.dumps(obj, ensure_ascii=False))

def load_dataframe(data_path: str):
    suffix = Path(data_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(data_path)
    if suffix in [".xlsx", ".xls"]:
        return pd.read_excel(data_path)
    if suffix == ".dta":
        return pd.read_stata(data_path)
    if suffix == ".parquet":
        return pd.read_parquet(data_path)
    raise ValueError(f"Unsupported econometrics input format: {suffix}")

def infer_dtype_family(series):
    if is_bool_dtype(series):
        return "boolean"
    if is_datetime64_any_dtype(series):
        return "datetime"
    if is_numeric_dtype(series):
        return "numeric"
    return "categorical"

def integer_like(series):
    if not is_numeric_dtype(series):
        return False
    sample = series.dropna()
    if sample.empty:
        return False
    if len(sample) > 5000:
        sample = sample.sample(5000, random_state=0)
    numeric = pd.to_numeric(sample, errors="coerce").dropna()
    if numeric.empty:
        return False
    return bool((((numeric - numeric.round()).abs()) < 1e-9).all())

def profile_column(name, series):
    non_null = series.dropna()
    unique_count = int(non_null.nunique(dropna=True))
    numeric = bool(is_numeric_dtype(series))
    return {
        "name": name,
        "dtype_family": infer_dtype_family(series),
        "non_null_count": int(non_null.shape[0]),
        "unique_count": unique_count,
        "binary": bool(unique_count > 0 and unique_count <= 2),
        "numeric": numeric,
        "datetime": bool(is_datetime64_any_dtype(series)),
        "integer_like": bool(integer_like(series)),
        "nonnegative": bool(numeric and non_null.shape[0] > 0 and pd.to_numeric(non_null, errors="coerce").dropna().ge(0).all()),
    }

try:
    df = load_dataframe(PAYLOAD["data_path"])
    entity_var = PAYLOAD.get("entity_var")
    time_var = PAYLOAD.get("time_var")
    duplicate_panel_keys = None
    entity_count = None
    time_count = None
    avg_periods_per_entity = None
    balanced_ratio = None
    if entity_var and time_var and entity_var in df.columns and time_var in df.columns:
        subset = df[[entity_var, time_var]].dropna()
        entity_count = int(subset[entity_var].nunique(dropna=True))
        time_count = int(subset[time_var].nunique(dropna=True))
        duplicate_panel_keys = int(subset.duplicated([entity_var, time_var]).sum())
        counts = subset.groupby(entity_var)[time_var].nunique(dropna=True)
        if len(counts) > 0:
            avg_periods_per_entity = float(counts.mean())
            if time_count and time_count > 0:
                balanced_ratio = float(counts.mean() / time_count)

    emit({
        "success": True,
        "row_count": int(df.shape[0]),
        "column_count": int(df.shape[1]),
        "columns": [profile_column(name, df[name]) for name in df.columns],
        "entity_count": entity_count,
        "time_count": time_count,
        "duplicate_panel_keys": duplicate_panel_keys,
        "avg_periods_per_entity": avg_periods_per_entity,
        "balanced_ratio": balanced_ratio,
    })
except Exception as exc:
    emit({
        "success": False,
        "error": str(exc),
        "traceback": traceback.format_exc(),
    })
`
}

async function runAutoRecommend(input: {
  dataPath: string
  outputDir: string
  pythonCommand: string
  params: {
    methodName: MethodName
    dependentVar?: string
    treatmentVar?: string
    entityVar?: string
    timeVar?: string
  }
}) {
  const payloadBase64 = encodePythonPayload({
    data_path: input.dataPath,
    dependent_var: input.params.dependentVar ?? null,
    treatment_var: input.params.treatmentVar ?? null,
    entity_var: input.params.entityVar ?? null,
    time_var: input.params.timeVar ?? null,
  })
  const execution = await runInlinePython({
    command: input.pythonCommand,
    script: buildAutoRecommendPythonScript(payloadBase64),
    cwd: Instance.directory,
  })
  const { code, stdout, stderr } = execution

  if (code !== 0) {
    const failureArtifacts = persistPythonFailureArtifacts({
      label: "auto_recommend_nonzero_exit",
      command: input.pythonCommand,
      cwd: Instance.directory,
      execution,
      context: {
        dataPath: input.dataPath,
        params: input.params,
      },
    })
    throw new Error(
      `Auto recommendation failed with Python ${input.pythonCommand} (exit code ${code})` +
        `\nCrash script: ${relativeWithinProject(failureArtifacts.scriptCopyPath)}` +
        `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
        `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
        `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
    )
  }

  const profileResult = parsePythonResult<SmartProfilePythonResult>(stdout)
  execution.cleanup()
  if (!profileResult.success) {
    throw new Error(`Auto recommendation profiling failed: ${profileResult.error ?? "unknown error"}\n${profileResult.traceback ?? ""}`)
  }

  const profile = buildSmartDatasetProfile({
    rowCount: profileResult.row_count,
    columns: profileResult.columns.map((column) => ({
      name: column.name,
      dtypeFamily: column.dtype_family,
      nonNullCount: column.non_null_count,
      uniqueCount: column.unique_count,
      binary: column.binary,
      numeric: column.numeric,
      datetime: column.datetime,
      integerLike: column.integer_like,
      nonnegative: column.nonnegative,
    })),
    entityVar: input.params.entityVar,
    timeVar: input.params.timeVar,
    treatmentVar: input.params.treatmentVar,
    dependentVar: input.params.dependentVar,
    entityCount: profileResult.entity_count,
    timeCount: profileResult.time_count,
    duplicatePanelKeys: profileResult.duplicate_panel_keys,
    avgPeriodsPerEntity: profileResult.avg_periods_per_entity,
    balancedRatio: profileResult.balanced_ratio,
  })
  const recommendation = recommendEconometricsPlan(profile)

  const profilePath = path.join(input.outputDir, "profile.json")
  const recommendationPath = path.join(input.outputDir, "recommendation.json")
  const outputPath = path.join(input.outputDir, "results.json")
  const narrativePath = path.join(input.outputDir, "narrative.md")

  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf-8")
  fs.writeFileSync(recommendationPath, JSON.stringify(recommendation, null, 2), "utf-8")
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        success: true,
        profile,
        recommendation,
        output_path: outputPath,
        profile_path: profilePath,
        recommendation_path: recommendationPath,
        narrative_path: narrativePath,
      },
      null,
      2,
    ),
    "utf-8",
  )

  const narrative = [
    "# Smart Econometrics Recommendation",
    "",
    `- Data structure: ${profile.dataStructure}`,
    `- Recommended method: ${recommendation.recommendedMethod}`,
    `- Suggested covariance: ${recommendation.covariance}`,
    recommendation.preferredEntityVar ? `- Preferred entity variable: ${recommendation.preferredEntityVar}` : "",
    recommendation.preferredTimeVar ? `- Preferred time variable: ${recommendation.preferredTimeVar}` : "",
    recommendation.preferredTreatmentVar ? `- Preferred treatment variable: ${recommendation.preferredTreatmentVar}` : "",
    recommendation.preferredClusterVar ? `- Preferred cluster variable: ${recommendation.preferredClusterVar}` : "",
    `- Confidence: ${recommendation.confidence}`,
    "",
    "## Reasons",
    ...recommendation.reasons.map((item) => `- ${item}`),
    "",
    "## Warnings",
    ...(recommendation.warnings.length ? recommendation.warnings.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Post-estimation rules",
    ...recommendation.postEstimationRules.map((item) => `- ${item}`),
  ]
    .filter(Boolean)
    .join("\n")
  fs.writeFileSync(narrativePath, narrative + "\n", "utf-8")

  return {
    profile,
    recommendation,
    outputPath,
    profilePath,
    recommendationPath,
    narrativePath,
  }
}

function regressionTableTitle(methodName: MethodName) {
  switch (methodName) {
    case "panel_fe_regression":
      return "固定效应回归结果表"
    case "baseline_regression":
      return "回归结果表"
    case "ols_regression":
      return "OLS回归结果表"
    case "iv_2sls":
      return "工具变量回归结果表"
    case "psm_regression":
      return "倾向得分回归结果表"
    case "psm_dr_ipw_ra":
      return "双重稳健回归结果表"
    case "did_static":
      return "静态DID结果表"
    case "did_staggered":
      return "渐进DID结果表"
    case "did_event_study":
      return "事件研究结果表"
    case "rdd_sharp":
      return "Sharp RDD结果表"
    case "rdd_fuzzy_global":
      return "全局多项式RDD结果表"
    default:
      return "回归结果表"
  }
}

function regressionTableSubtitle(methodName: MethodName) {
  switch (methodName) {
    case "panel_fe_regression":
      return "固定效应回归"
    case "baseline_regression":
      return "基准回归"
    case "ols_regression":
      return "OLS"
    case "iv_2sls":
      return "IV-2SLS"
    case "psm_regression":
      return "PSM回归调整"
    case "psm_dr_ipw_ra":
      return "双重稳健IPW-RA"
    case "did_static":
      return "静态DID"
    case "did_staggered":
      return "渐进DID"
    case "did_event_study":
      return "事件研究"
    case "rdd_sharp":
      return "Sharp RDD"
    case "rdd_fuzzy_global":
      return "全局多项式RDD"
    default:
      return "回归"
  }
}

function buildPanelFePythonScript(payloadB64: string) {
  return `
import base64
import json
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"
PROJECT_DIR = r"${Instance.directory.replace(/\\/g, "\\\\")}"
ECONOMETRICS_DIR = r"${ECONOMETRICS_DIR.replace(/\\/g, "\\\\")}"
ERRORS_DIR = r"${projectErrorsRoot().replace(/\\/g, "\\\\")}"

sys.path.insert(0, ECONOMETRICS_DIR)

from econometric_algorithm import run_core_diagnostics, run_robustness_checks

def emit(result):
    print(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=False)}")

def save_json(file_path, payload):
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

def safe_error_path(method_name):
    error_dir = Path(ERRORS_DIR)
    error_dir.mkdir(parents=True, exist_ok=True)
    from datetime import datetime
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return str(error_dir / f"econometrics_{method_name}_{stamp}_error.json")

def read_table(file_path):
    suffix = Path(file_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(file_path)
    if suffix in [".xlsx", ".xls"]:
        return pd.read_excel(file_path)
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
    raise ValueError(f"Unsupported econometrics input format: {suffix}")

def build_model_qa(df, entity_var=None, time_var=None, cluster_var=None):
    warnings = []
    blocking_errors = []
    suggested_repairs = []
    duplicate_rows = 0
    cluster_count = None

    if entity_var and time_var:
        missing_keys = [item for item in [entity_var, time_var] if item not in df.columns]
        if missing_keys:
            blocking_errors.append(f"Panel identifiers not found: {missing_keys}")
        else:
            duplicate_rows = int(df.duplicated(subset=[entity_var, time_var]).sum())
            if duplicate_rows > 0:
                warnings.append(f"Found {duplicate_rows} duplicate entity-time rows")
                suggested_repairs.append("Aggregate or deduplicate entity-time rows before regression")

    if cluster_var and cluster_var in df.columns:
        cluster_count = int(df[cluster_var].nunique(dropna=True))
        if cluster_count < 10:
            warnings.append(f"Cluster count is low ({cluster_count}); clustered standard errors may be unstable")

    return {
        "warnings": warnings,
        "blocking_errors": blocking_errors,
        "suggested_repairs": suggested_repairs,
        "duplicate_entity_time_rows": duplicate_rows,
        "cluster_count": cluster_count,
    }

def vif_report(frame):
    clean = frame.dropna()
    if clean.empty or clean.shape[1] <= 1:
        return []
    matrix = np.column_stack([np.ones(len(clean)), clean.to_numpy(dtype=float)])
    result = []
    for idx, column in enumerate(clean.columns, start=1):
        target = matrix[:, idx]
        others = np.delete(matrix, idx, axis=1)
        beta = np.linalg.pinv(others.T @ others) @ (others.T @ target)
        fitted = others @ beta
        ssr = float(np.sum((target - fitted) ** 2))
        tss = float(np.sum((target - target.mean()) ** 2))
        vif_value = None if tss == 0 else float(1.0 / (1.0 - max(0.0, min(0.999999, 1 - ssr / tss))))
        result.append({"variable": column, "vif": vif_value})
    return result

def breusch_pagan(residuals, design_matrix):
    if design_matrix.shape[1] <= 1:
        return {"breusch_pagan_stat": 0.0, "breusch_pagan_pvalue": 1.0}
    target = residuals ** 2
    beta = np.linalg.pinv(design_matrix.T @ design_matrix) @ (design_matrix.T @ target)
    fitted = design_matrix @ beta
    tss = float(np.sum((target - target.mean()) ** 2))
    rss = float(np.sum((target - fitted) ** 2))
    r_squared = 0.0 if tss == 0 else max(0.0, min(0.999999, 1 - rss / tss))
    lm = len(residuals) * r_squared
    dof = max(design_matrix.shape[1] - 1, 1)
    return {
        "breusch_pagan_stat": float(lm),
        "breusch_pagan_pvalue": float(stats.chi2.sf(lm, dof)),
    }

def cluster_covariance(design_matrix, residuals, groups):
    xtx_inv = np.linalg.pinv(design_matrix.T @ design_matrix)
    meat = np.zeros((design_matrix.shape[1], design_matrix.shape[1]))
    unique_groups = np.unique(groups)
    for group in unique_groups:
        mask = groups == group
        xg = design_matrix[mask]
        ug = residuals[mask]
        score = xg.T @ ug
        meat += np.outer(score, score)
    n = design_matrix.shape[0]
    k = design_matrix.shape[1]
    g = len(unique_groups)
    correction = 1.0 if g <= 1 or n <= k else (g / (g - 1)) * ((n - 1) / (n - k))
    return correction * (xtx_inv @ meat @ xtx_inv)

def hc1_covariance(design_matrix, residuals):
    xtx_inv = np.linalg.pinv(design_matrix.T @ design_matrix)
    xru = design_matrix * residuals[:, None]
    meat = xru.T @ xru
    n = design_matrix.shape[0]
    k = design_matrix.shape[1]
    correction = 1.0 if n <= k else n / max(n - k, 1)
    return correction * (xtx_inv @ meat @ xtx_inv)

def build_coefficient_table(term_names, beta, std_error, p_value, dof):
    critical = float(stats.t.ppf(0.975, dof)) if dof > 0 else 1.96
    rows = []
    for idx, term in enumerate(term_names):
        t_stat = None if std_error[idx] == 0 else float(beta[idx] / std_error[idx])
        rows.append({
            "term": term,
            "coefficient": float(beta[idx]),
            "std_error": float(std_error[idx]),
            "t_stat": t_stat,
            "p_value": float(p_value[idx]),
            "ci_lower": float(beta[idx] - critical * std_error[idx]),
            "ci_upper": float(beta[idx] + critical * std_error[idx]),
        })
    return pd.DataFrame(rows)

def adjusted_r_squared(outcome, residuals, n, k):
    tss = float(np.sum((outcome - outcome.mean()) ** 2))
    rss = float(np.sum(residuals ** 2))
    if tss == 0 or n <= k:
        return 0.0
    return float(1 - (rss / (n - k)) / (tss / (n - 1)))

def empty_coefficient_table():
    return pd.DataFrame(columns=["term", "coefficient", "std_error", "t_stat", "p_value", "ci_lower", "ci_upper"])

def scalar_coefficient_table(term, coefficient=None, std_error=None, p_value=None, ci_lower=None, ci_upper=None):
    t_stat = None
    if coefficient is not None and std_error not in [None, 0]:
        t_stat = float(coefficient / std_error)
    return pd.DataFrame([{
        "term": term,
        "coefficient": None if coefficient is None else float(coefficient),
        "std_error": None if std_error is None else float(std_error),
        "t_stat": t_stat,
        "p_value": None if p_value is None else float(p_value),
        "ci_lower": None if ci_lower is None else float(ci_lower),
        "ci_upper": None if ci_upper is None else float(ci_upper),
    }])

def model_coefficient_table(model):
    if model is None or not hasattr(model, "params"):
        return empty_coefficient_table()
    params = model.params
    std_errors = getattr(model, "std_errors", getattr(model, "bse", None))
    p_values = getattr(model, "pvalues", None)
    conf_int = model.conf_int() if hasattr(model, "conf_int") else None
    rows = []
    for term, coefficient in params.items():
        std_error = None if std_errors is None else std_errors.get(term)
        p_value = None if p_values is None else p_values.get(term)
        ci_lower = None
        ci_upper = None
        if conf_int is not None and term in conf_int.index:
            if "lower" in conf_int.columns and "upper" in conf_int.columns:
                ci_lower = conf_int.loc[term, "lower"]
                ci_upper = conf_int.loc[term, "upper"]
            else:
                ci_lower = conf_int.loc[term].iloc[0]
                ci_upper = conf_int.loc[term].iloc[-1]
        t_stat = None
        if std_error not in [None, 0]:
            t_stat = float(coefficient / std_error)
        rows.append({
            "term": str(term),
            "coefficient": float(coefficient),
            "std_error": None if std_error is None else float(std_error),
            "t_stat": t_stat,
            "p_value": None if p_value is None else float(p_value),
            "ci_lower": None if ci_lower is None else float(ci_lower),
            "ci_upper": None if ci_upper is None else float(ci_upper),
        })
    return pd.DataFrame(rows, columns=["term", "coefficient", "std_error", "t_stat", "p_value", "ci_lower", "ci_upper"])

def first_non_const_term(coefficients):
    if coefficients.empty:
        return None
    for term in coefficients["term"].tolist():
        if term != "const":
            return term
    return coefficients.iloc[0]["term"]

def build_table_variables(method, treatment_name, covariate_names, coefficients, explicit_primary_term=None):
    if method == "did_static":
        return ["treatment_group_treated", *covariate_names]
    if method == "did_staggered":
        return [explicit_primary_term or "treatment_entity_treated", *covariate_names]
    if method == "did_event_study":
        terms = [term for term in coefficients["term"].tolist() if term != "const"]
        return terms
    if method in ["ols_regression", "iv_2sls", "psm_regression", "psm_dr_ipw_ra", "rdd_sharp", "rdd_fuzzy_global"]:
        primary_term = explicit_primary_term or treatment_name or first_non_const_term(coefficients)
        return [item for item in [primary_term, *covariate_names] if item]
    return []

def iv_strength_diagnostic(treatment_series, iv_series, covariate_frame=None):
    try:
        if treatment_series is None or iv_series is None:
            return {"status": "skipped", "reason": "instrument not available"}
        treatment = pd.to_numeric(treatment_series, errors="coerce")
        if isinstance(iv_series, pd.DataFrame):
            instrument_frame = iv_series.apply(pd.to_numeric, errors="coerce")
        else:
            instrument_name = getattr(iv_series, "name", None) or "instrument"
            instrument_frame = pd.DataFrame({instrument_name: pd.to_numeric(iv_series, errors="coerce")})
        pieces = [treatment.rename("treatment"), instrument_frame]
        if covariate_frame is not None and not covariate_frame.empty:
            pieces.append(covariate_frame.apply(pd.to_numeric, errors="coerce"))
        joined = pd.concat(pieces, axis=1).dropna()
        if joined.empty:
            return {"status": "skipped", "reason": "no complete rows"}
        outcome = joined.iloc[:, 0].to_numpy(dtype=float)
        regressors = sm.add_constant(joined.iloc[:, 1:].to_numpy(dtype=float))
        first_stage = sm.OLS(outcome, regressors).fit()
        instrument_count = instrument_frame.shape[1]
        if instrument_count == 1:
            f_stat = float(first_stage.tvalues[1] ** 2) if len(first_stage.tvalues) > 1 else None
        else:
            restriction = np.zeros((instrument_count, regressors.shape[1]))
            restriction[:, 1:1 + instrument_count] = np.eye(instrument_count)
            test = first_stage.f_test(restriction)
            f_stat = float(np.asarray(test.fvalue).item()) if getattr(test, "fvalue", None) is not None else None
        return {
            "status": "pass",
            "f_stat": f_stat,
            "instrument_count": int(instrument_count),
            "n_obs": int(len(joined)),
        }
    except Exception as exc:
        return {"status": "skipped", "reason": str(exc)}

def parallel_trends_diagnostic(coefficients):
    try:
        if coefficients is None or coefficients.empty or "term" not in coefficients.columns:
            return {"status": "skipped", "reason": "coefficient table unavailable"}
        lead_rows = coefficients[coefficients["term"].astype(str).str.startswith("Lead_")].copy()
        if lead_rows.empty:
            return {"status": "skipped", "reason": "no lead terms found"}
        lead_rows["p_value"] = pd.to_numeric(lead_rows["p_value"], errors="coerce")
        significant = lead_rows[lead_rows["p_value"] < 0.05].copy()
        min_lead_p_value = None if lead_rows["p_value"].dropna().empty else float(lead_rows["p_value"].dropna().min())
        return {
            "status": "pass",
            "passed": significant.empty,
            "significant_lead_count": int(len(significant)),
            "min_lead_p_value": min_lead_p_value,
            "significant_leads": significant[["term", "coefficient", "p_value"]].to_dict(orient="records"),
        }
    except Exception as exc:
        return {"status": "skipped", "reason": str(exc)}

def load_matplotlib_pyplot():
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib import pyplot as plt
    return plt

def prepare_panel_inputs(df, payload, covariate_names):
    entity_var = payload.get("entity_var")
    time_var = payload.get("time_var")
    if not entity_var or not time_var:
        raise ValueError(f"Method {method} requires entity_var and time_var")
    required = [entity_var, time_var, payload["dependent_var"], *covariate_names]
    treatment_name = payload.get("treatment_var")
    if treatment_name:
        required.append(treatment_name)
    missing = sorted(set([col for col in required if col not in df.columns]))
    if missing:
        raise ValueError(f"Missing panel columns in dataset: {missing}")
    panel_df = df.set_index([entity_var, time_var]).sort_index()
    dependent_var = panel_df[payload["dependent_var"]]
    treatment_var = panel_df[treatment_name] if treatment_name else None
    covariates = panel_df[covariate_names] if covariate_names else None
    return panel_df, dependent_var, treatment_var, covariates

def persist_common_outputs(payload, result, qa, diagnostics, metadata, coefficients, summary_text, narrative_text):
    output_dir = Path(payload["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    coefficients_path = output_dir / "coefficient_table.csv"
    workbook_path = output_dir / "coefficient_table.xlsx"
    diagnostics_path = output_dir / "diagnostics.json"
    metadata_path = output_dir / "model_metadata.json"
    narrative_path = output_dir / "narrative.md"
    output_path = output_dir / "results.json"
    summary_path = output_dir / "model_summary.txt"

    coefficients = coefficients if coefficients is not None else empty_coefficient_table()
    coefficients.to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
        coefficients.to_excel(writer, sheet_name="coefficients", index=False)

    result["output_path"] = str(output_path)
    result["coefficients_path"] = str(coefficients_path)
    result["workbook_path"] = str(workbook_path)
    result["diagnostics_path"] = str(diagnostics_path)
    result["metadata_path"] = str(metadata_path)
    result["narrative_path"] = str(narrative_path)
    result["summary_path"] = str(summary_path)
    result["qa_status"] = "fail" if qa["blocking_errors"] else "warn" if qa["warnings"] else "pass"
    result["warnings"] = qa["warnings"]
    result["blocking_errors"] = qa["blocking_errors"]
    result["suggested_repairs"] = qa["suggested_repairs"]

    save_json(diagnostics_path, diagnostics)
    save_json(metadata_path, metadata)
    save_json(output_path, result)
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(summary_text)
    with open(narrative_path, "w", encoding="utf-8") as f:
        f.write(narrative_text)

    return result

payload = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))
method = payload["method"]

try:
    df = read_table(payload["data_path"])
    dependent_var = payload["dependent_var"]
    treatment_var = payload["treatment_var"]
    covariates = payload.get("covariates", [])
    entity_var = payload["entity_var"]
    time_var = payload["time_var"]
    cluster_var = payload.get("cluster_var") or entity_var

    required_columns = [dependent_var, treatment_var, entity_var, time_var] + covariates
    missing_columns = sorted(set([col for col in required_columns if col not in df.columns]))
    if missing_columns:
        raise ValueError(f"Missing columns in dataset: {missing_columns}")

    qa = build_model_qa(df, entity_var, time_var, cluster_var)
    model_columns = required_columns + ([cluster_var] if cluster_var not in required_columns else [])
    model_df = df[model_columns].copy()
    for column in [dependent_var, treatment_var, *covariates]:
        model_df[column] = pd.to_numeric(model_df[column], errors="coerce")

    rows_before = len(model_df)
    model_df = model_df.dropna(subset=[dependent_var, treatment_var, entity_var, time_var, *covariates])
    dropped_rows = int(rows_before - len(model_df))
    if dropped_rows > 0:
        qa["warnings"].append(f"Dropped {dropped_rows} rows with missing model variables")
    if model_df.empty:
        raise ValueError("No usable rows remain after dropping missing model variables")

    duplicate_rows = int(model_df.duplicated(subset=[entity_var, time_var]).sum())
    if duplicate_rows > 0:
        aggregations = {}
        for column in model_df.columns:
            if column in [entity_var, time_var]:
                continue
            if pd.api.types.is_numeric_dtype(model_df[column]):
                aggregations[column] = "mean"
            else:
                aggregations[column] = "first"
        model_df = model_df.groupby([entity_var, time_var], as_index=False).agg(aggregations)
        qa["warnings"].append(f"Aggregated {duplicate_rows} duplicate entity-time rows by panel key mean")

    main = model_df[[treatment_var, *covariates]].to_numpy(dtype=float)
    entity_dummies = pd.get_dummies(model_df[entity_var], prefix=entity_var, drop_first=True, dtype=float)
    time_dummies = pd.get_dummies(model_df[time_var], prefix=time_var, drop_first=True, dtype=float)
    term_names = ["const", treatment_var, *covariates, *entity_dummies.columns.tolist(), *time_dummies.columns.tolist()]
    matrix_parts = [np.ones((len(model_df), 1)), main]
    if not entity_dummies.empty:
        matrix_parts.append(entity_dummies.to_numpy(dtype=float))
    if not time_dummies.empty:
        matrix_parts.append(time_dummies.to_numpy(dtype=float))
    design_matrix = np.column_stack(matrix_parts)
    raw_outcome = model_df[dependent_var].to_numpy(dtype=float)
    outcome = raw_outcome
    beta = np.linalg.pinv(design_matrix.T @ design_matrix) @ (design_matrix.T @ outcome)
    fitted = design_matrix @ beta
    residuals = outcome - fitted
    groups = pd.factorize(model_df[cluster_var])[0]
    covariance = cluster_covariance(design_matrix, residuals, groups)
    std_error = np.sqrt(np.clip(np.diag(covariance), a_min=0, a_max=None))
    dof = max(len(outcome) - design_matrix.shape[1], 1)
    t_stats = np.divide(beta, std_error, out=np.zeros_like(beta), where=std_error > 0)
    p_value = 2 * stats.t.sf(np.abs(t_stats), dof)

    coefficients = build_coefficient_table(term_names, beta, std_error, p_value, dof)
    output_dir = Path(payload["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    coefficients_path = output_dir / "coefficient_table.csv"
    workbook_path = output_dir / "coefficient_table.xlsx"
    diagnostics_path = output_dir / "diagnostics.json"
    metadata_path = output_dir / "model_metadata.json"
    narrative_path = output_dir / "narrative.md"
    output_path = output_dir / "results.json"
    summary_path = output_dir / "model_summary.txt"

    coefficients.to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
        coefficients.to_excel(writer, sheet_name="coefficients", index=False)

    diagnostic_model = sm.OLS(outcome, design_matrix).fit()
    panel_info = {
        "entity_var": entity_var,
        "time_var": time_var,
        "cluster_var": cluster_var,
        "entity_count": int(model_df[entity_var].nunique(dropna=True)),
        "time_count": int(model_df[time_var].nunique(dropna=True)),
        "cluster_count": qa["cluster_count"],
        "duplicate_entity_time_rows": qa["duplicate_entity_time_rows"],
        "dropped_rows": dropped_rows,
    }
    diagnostics = {
        "core": run_core_diagnostics(
            diagnostic_model,
            regressors=model_df[[treatment_var, *covariates]],
            treatment_variable=model_df[treatment_var],
            panel_info=panel_info,
        ),
        "robustness": run_robustness_checks(
            diagnostic_model,
            frame=model_df,
            outcome_var=dependent_var,
            treatment_var=treatment_var,
            covariates=covariates,
            cluster_var=cluster_var,
            placebo_var=payload.get("options", {}).get("placebo_var"),
            alternative_sets=payload.get("options", {}).get("alternative_specifications"),
            groups=model_df[cluster_var],
        ),
        "qa": {
            "warnings": qa["warnings"],
            "blocking_errors": qa["blocking_errors"],
            "suggested_repairs": qa["suggested_repairs"],
            **panel_info,
        },
    }
    metadata = {
        "method": method,
        "backend": "numpy_fe_cluster",
        "covariance": "cluster",
        "dependent_var": dependent_var,
        "treatment_var": treatment_var,
        "covariates": covariates,
        "entity_var": entity_var,
        "time_var": time_var,
        "cluster_var": cluster_var,
        "rows_used": int(len(model_df)),
        "rows_dropped": dropped_rows,
        "term_names": term_names,
        "input_encoding": df.attrs.get("_source_encoding", "default"),
        "output_kind": "regression",
    }
    treatment_idx = term_names.index(treatment_var)
    result = {
        "success": True,
        "method": "Panel FE",
        "dataset_id": payload.get("dataset_id"),
        "stage_id": payload.get("stage_id"),
        "branch": payload.get("branch"),
        "coefficient": float(beta[treatment_idx]),
        "std_error": float(std_error[treatment_idx]),
        "p_value": float(p_value[treatment_idx]),
        "r_squared": adjusted_r_squared(outcome, residuals, len(outcome), design_matrix.shape[1]),
        "output_path": str(output_path),
        "coefficients_path": str(coefficients_path),
        "workbook_path": str(workbook_path),
        "diagnostics_path": str(diagnostics_path),
        "metadata_path": str(metadata_path),
        "narrative_path": str(narrative_path),
        "qa_status": "fail" if qa["blocking_errors"] else "warn" if qa["warnings"] else "pass",
        "warnings": qa["warnings"],
        "blocking_errors": qa["blocking_errors"],
        "suggested_repairs": qa["suggested_repairs"],
        "backend": "numpy_fe_cluster",
        "dropped_rows": dropped_rows,
        "rows_used": int(len(model_df)),
        "cluster_var": cluster_var,
    }

    save_json(output_path, result)
    save_json(diagnostics_path, diagnostics)
    save_json(metadata_path, metadata)
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(coefficients.to_string(index=False))
    with open(narrative_path, "w", encoding="utf-8") as f:
        f.write("# Panel FE Regression Summary\\\\n\\\\n")
        f.write(f"- Dependent variable: {dependent_var}\\\\n")
        f.write(f"- Key regressor: {treatment_var}\\\\n")
        f.write(f"- Controls: {covariates}\\\\n")
        f.write(f"- Fixed effects: {entity_var}, {time_var}\\\\n")
        f.write(f"- Clustered SE: {cluster_var}\\\\n")
        f.write(f"- Coefficient: {result['coefficient']:.6f}\\\\n")
        f.write(f"- Std. error: {result['std_error']:.6f}\\\\n")
        f.write(f"- P-value: {result['p_value']:.6f}\\\\n")
        f.write(f"- Adjusted R-squared: {result['r_squared']:.6f}\\\\n")
    emit(result)

except Exception as e:
    result = {
        "success": False,
        "error": str(e),
        "traceback": traceback.format_exc(),
    }
    error_path = safe_error_path(method)
    result["error_log_path"] = error_path
    save_json(error_path, result)
    emit(result)
`
}

export const EconometricsTool = Tool.define("econometrics", async () => ({
  description: DESCRIPTION,
  parameters: z.object({
    methodName: MethodSchema,
    dataPath: z.string().optional(),
    datasetId: z.string().optional(),
    stageId: z.string().optional(),
    runId: z.string().optional(),
    branch: z.string().optional(),
    dependentVar: z.string().optional(),
    treatmentVar: z.string().optional(),
    covariates: z.array(z.string()).optional(),
    entityVar: z.string().optional(),
    timeVar: z.string().optional(),
    clusterVar: z.string().optional(),
    options: z.object({}).passthrough().optional(),
    outputDir: z.string().optional(),
  }),
  async execute(params, ctx) {
    const retryBudget = checkRetryBudget("econometrics", ctx.sessionID)
    if (!retryBudget.allowed) {
      throw new Error(
        `Retry budget exhausted for econometrics in this session (${retryBudget.count}/${retryBudget.max}). Inspect the reflection logs and repair the failed stage before retrying.`,
      )
    }
    const pythonStatus = await getRuntimePythonStatus()
    if (!pythonStatus.ok || pythonStatus.missing.length) {
      throw new Error(formatRuntimePythonSetupError("econometrics", pythonStatus))
    }
    const pythonCommand = pythonStatus.executable
    const installCommand = pythonStatus.installCommand
    if (ctx.agent === "analyst" && params.methodName !== "auto_recommend") {
      const analystState = AnalysisIntent.getAnalyst(ctx.sessionID)
      if (!analystState.planApproved) {
        const plannedRun = ensureAnalysisPlan({
          sessionID: ctx.sessionID,
          datasetId: params.datasetId,
          runId: params.runId,
          branch: params.branch ?? "main",
        })
        AnalysisIntent.markAnalystPlanGenerated(ctx.sessionID)
        const answers = await Question.ask({
          sessionID: ctx.sessionID,
          questions: [
            {
              header: "Analysis Plan",
              question: [
                "Analyst prepared this empirical execution checklist:",
                ...formatAnalysisChecklist(plannedRun),
                "",
                "Approve it to start the econometric workflow.",
              ].join("\n"),
              custom: false,
              options: [
                { label: "Yes", description: "Approve the plan and start econometric execution" },
                { label: "No", description: "Stay in planning mode and do not run the model yet" },
              ],
            },
          ],
          tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
        })

        if (answers[0]?.[0] !== "Yes") {
          setAnalysisPlanApproval({
            sessionID: ctx.sessionID,
            approvalStatus: "declined",
            datasetId: params.datasetId,
            runId: params.runId,
            branch: params.branch ?? "main",
          })
          AnalysisIntent.markAnalystPlanApproval(ctx.sessionID, false)
          throw new Question.RejectedError()
        }
        setAnalysisPlanApproval({
          sessionID: ctx.sessionID,
          approvalStatus: "approved",
          datasetId: params.datasetId,
          runId: params.runId,
          branch: params.branch ?? "main",
        })
        AnalysisIntent.markAnalystPlanApproval(ctx.sessionID, true)
      }
    }

    validateMethodOptions({
      methodName: params.methodName,
      dependentVar: params.dependentVar,
      treatmentVar: params.treatmentVar,
      options: params.options,
      entityVar: params.entityVar,
      timeVar: params.timeVar,
    })

    const artifactInput = resolveArtifactInput({
      datasetId: params.datasetId,
      stageId: params.stageId,
      inputPath: params.dataPath
        ? await resolveToolPath({
            filePath: params.dataPath,
            mode: "read",
            toolName: "econometrics",
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            ask: ctx.ask,
          })
        : undefined,
    })
    const dataPath = artifactInput.resolvedInputPath
    if (!dataPath) {
      throw new Error("Econometrics requires dataPath or datasetId/stageId")
    }
    if (!fs.existsSync(dataPath)) {
      throw new Error(`Data file not found: ${dataPath}`)
    }

    const datasetManifest = artifactInput.manifest
    const sourceStage = artifactInput.stage
    const branch = params.branch ?? sourceStage?.branch ?? "main"
    const runId = inferRunId({
      requestedRunId: params.runId,
      stage: sourceStage,
    })
    const outputStamp = buildFileStamp()
    const outputDir = params.outputDir
      ? await resolveToolPath({
          filePath: params.outputDir,
          mode: "write",
          toolName: "econometrics",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
      : datasetManifest
        ? reportOutputPath({
          datasetId: datasetManifest.datasetId,
          action: params.methodName,
          stageId: params.stageId ?? sourceStage?.stageId,
          branch,
          format: "json",
          stamp: outputStamp,
        }).replace(/\.json$/, "")
      : path.join(Instance.directory, "analysis", params.methodName)
    fs.mkdirSync(outputDir, { recursive: true })

    await ctx.ask({
      permission: "bash",
      patterns: [`${pythonCommand} *econometrics*`],
      always: [`${pythonCommand}*`],
      metadata: {
        description: `Run econometric method: ${params.methodName}`,
      },
    })

    if (params.methodName === "auto_recommend") {
      const autoResult = await runAutoRecommend({
        dataPath,
        outputDir,
        pythonCommand,
        params,
      })

      const publishedFiles: EconometricsPublishedFile[] = []
      if (datasetManifest) {
        appendArtifact(datasetManifest, {
          artifactId: `${params.methodName}_${Date.now()}`,
          runId,
          stageId: params.stageId ?? sourceStage?.stageId,
          branch,
          action: params.methodName,
          outputPath: autoResult.outputPath,
          summaryPath: autoResult.recommendationPath,
          logPath: autoResult.narrativePath,
          createdAt: new Date().toISOString(),
          metadata: {
            data_structure: autoResult.profile.dataStructure,
            recommended_method: autoResult.recommendation.recommendedMethod,
            covariance: autoResult.recommendation.covariance,
          },
        })

        const publish = (key: string, label: string, sourcePath?: string) => {
          if (!sourcePath) return
          const visiblePath = publishVisibleOutput({
            manifest: datasetManifest,
            key,
            label,
            sourcePath,
            runId,
            branch: path.join("econometrics", params.methodName),
            stageId: params.stageId ?? sourceStage?.stageId,
          })
          publishedFiles.push({
            label,
            relativePath: relativeWithinProject(visiblePath),
          })
        }

        publish("auto_recommend_profile", "auto_recommend_profile", autoResult.profilePath)
        publish("auto_recommend_recommendation", "auto_recommend_recommendation", autoResult.recommendationPath)
        publish("auto_recommend_summary", "auto_recommend_summary", autoResult.narrativePath)
        publish("auto_recommend_results", "auto_recommend_results", autoResult.outputPath)
      }

      let output = `## Econometrics result - ${params.methodName}\n\n`
      output += `Data file: ${relativeWithinProject(dataPath)}\n`
      output += `Data structure: ${autoResult.profile.dataStructure}\n`
      output += `Recommended method: ${autoResult.recommendation.recommendedMethod}\n`
      output += `Suggested covariance: ${autoResult.recommendation.covariance}\n`
      if (autoResult.recommendation.preferredEntityVar) {
        output += `Preferred entity variable: ${autoResult.recommendation.preferredEntityVar}\n`
      }
      if (autoResult.recommendation.preferredTimeVar) {
        output += `Preferred time variable: ${autoResult.recommendation.preferredTimeVar}\n`
      }
      if (autoResult.recommendation.preferredTreatmentVar) {
        output += `Preferred treatment variable: ${autoResult.recommendation.preferredTreatmentVar}\n`
      }
      if (autoResult.recommendation.preferredClusterVar) {
        output += `Preferred cluster variable: ${autoResult.recommendation.preferredClusterVar}\n`
      }
      output += `Confidence: ${autoResult.recommendation.confidence}\n`
      if (autoResult.recommendation.reasons.length) {
        output += `Reasons: ${autoResult.recommendation.reasons.join(" | ")}\n`
      }
      if (autoResult.recommendation.warnings.length) {
        output += `Warnings: ${autoResult.recommendation.warnings.join(" | ")}\n`
      }
      output += `- Profile JSON: ${relativeWithinProject(autoResult.profilePath)}\n`
      output += `- Recommendation JSON: ${relativeWithinProject(autoResult.recommendationPath)}\n`
      output += `- Narrative summary: ${relativeWithinProject(autoResult.narrativePath)}\n`
      output += `- Result JSON: ${relativeWithinProject(autoResult.outputPath)}\n`
      output += `\nResults directory: ${relativeWithinProject(outputDir)}/\n`

      const metadata: EconometricsToolMetadata = {
        method: params.methodName,
        profile: autoResult.profile,
        recommendation: autoResult.recommendation,
        datasetId: datasetManifest?.datasetId ?? params.datasetId,
        stageId: params.stageId ?? sourceStage?.stageId,
        runId,
        outputDir: relativeWithinProject(outputDir),
        publishedFiles,
      }

      return {
        title: `Econometrics: ${params.methodName}`,
        output,
        metadata,
      }
    }

    if (params.methodName === "smart_baseline") {
      const autoResult = await runAutoRecommend({
        dataPath,
        outputDir,
        pythonCommand,
        params,
      })

      const executionPlan = buildSmartBaselinePlan({
        params,
        profile: autoResult.profile,
        recommendation: autoResult.recommendation,
      })

      const nestedTool = await EconometricsTool.init()
      const nestedResult = await nestedTool.execute(
        {
          methodName: executionPlan.methodName,
          dataPath,
          datasetId: params.datasetId,
          stageId: params.stageId,
          runId,
          branch,
          dependentVar: executionPlan.dependentVar,
          treatmentVar: executionPlan.treatmentVar,
          covariates: executionPlan.covariates,
          entityVar: executionPlan.entityVar,
          timeVar: executionPlan.timeVar,
          clusterVar: executionPlan.clusterVar,
          options: executionPlan.options,
          outputDir,
        },
        {
          ...ctx,
          agent: ctx.agent === "analyst" ? "econometrics" : ctx.agent,
        },
      )

      const nestedMetadata = nestedResult.metadata as EconometricsToolMetadata
      const nestedPublishedFiles = [...(nestedMetadata.publishedFiles ?? [])]

      if (datasetManifest) {
        appendArtifact(datasetManifest, {
          artifactId: `${params.methodName}_${Date.now()}`,
          runId,
          stageId: params.stageId ?? sourceStage?.stageId,
          branch,
          action: params.methodName,
          outputPath: (nestedMetadata.result?.output_path ?? autoResult.outputPath) as string,
          summaryPath: autoResult.recommendationPath,
          logPath: autoResult.narrativePath,
          createdAt: new Date().toISOString(),
          metadata: {
            executable_method: executionPlan.methodName,
            data_structure: autoResult.profile.dataStructure,
            recommended_method: autoResult.recommendation.recommendedMethod,
            effective_method: nestedMetadata.result?.effective_method ?? nestedMetadata.result?.method,
            effective_covariance: nestedMetadata.result?.effective_covariance,
          },
        })

        const publish = (key: string, label: string, sourcePath?: string) => {
          if (!sourcePath) return
          const visiblePath = publishVisibleOutput({
            manifest: datasetManifest,
            key,
            label,
            sourcePath,
            runId,
            branch: path.join("econometrics", params.methodName),
            stageId: params.stageId ?? sourceStage?.stageId,
          })
          nestedPublishedFiles.push({
            label,
            relativePath: relativeWithinProject(visiblePath),
          })
        }

        publish("smart_baseline_profile", "smart_baseline_profile", autoResult.profilePath)
        publish("smart_baseline_recommendation", "smart_baseline_recommendation", autoResult.recommendationPath)
        publish("smart_baseline_summary", "smart_baseline_summary", autoResult.narrativePath)
      }

      let output = `## Econometrics result - ${params.methodName}\n\n`
      output += `Data file: ${relativeWithinProject(dataPath)}\n`
      output += `Recommended method: ${autoResult.recommendation.recommendedMethod}\n`
      output += `Executed method: ${executionPlan.methodName}\n`
      output += `Suggested covariance: ${autoResult.recommendation.covariance}\n`
      if (nestedMetadata.result?.effective_method) output += `Effective method: ${nestedMetadata.result.effective_method}\n`
      if (nestedMetadata.result?.effective_covariance) output += `Effective covariance: ${nestedMetadata.result.effective_covariance}\n`
      if (executionPlan.planningTrace.length) {
        output += `Planning trace: ${executionPlan.planningTrace.map((item) => item.message).join(" | ")}\n`
      }
      output += `- Profile JSON: ${relativeWithinProject(autoResult.profilePath)}\n`
      output += `- Recommendation JSON: ${relativeWithinProject(autoResult.recommendationPath)}\n`
      output += `- Recommendation narrative: ${relativeWithinProject(autoResult.narrativePath)}\n`
      output += `\n### Baseline Execution\n`
      output += nestedResult.output

      const mergedMetadata: EconometricsToolMetadata = {
        ...(nestedMetadata ?? {}),
        method: params.methodName,
        profile: autoResult.profile,
        recommendation: autoResult.recommendation,
        datasetId: nestedMetadata.datasetId ?? datasetManifest?.datasetId ?? params.datasetId,
        stageId: nestedMetadata.stageId ?? params.stageId ?? sourceStage?.stageId,
        runId: nestedMetadata.runId ?? runId,
        outputDir: nestedMetadata.outputDir ?? relativeWithinProject(outputDir),
        deliveryBundleDir: nestedMetadata.deliveryBundleDir,
        publishedFiles: nestedPublishedFiles,
        finalOutputsPath: nestedMetadata.finalOutputsPath ?? nestedMetadata.internalFinalOutputsPath,
        internalFinalOutputsPath: nestedMetadata.internalFinalOutputsPath,
      }
      if (mergedMetadata.result) {
        mergedMetadata.result.decision_trace = [
          ...executionPlan.planningTrace,
          ...(mergedMetadata.result.decision_trace ?? []),
        ]
      }

      return {
        title: `Econometrics: ${params.methodName}`,
        output,
        metadata: mergedMetadata,
      }
    }

    const payload = {
      method: params.methodName,
      data_path: dataPath,
      dependent_var: params.dependentVar,
      treatment_var: params.treatmentVar ?? null,
      covariates: params.covariates ?? [],
      entity_var: params.entityVar ?? null,
      time_var: params.timeVar ?? null,
      cluster_var: params.clusterVar ?? params.entityVar ?? null,
      dataset_id: datasetManifest?.datasetId ?? params.datasetId ?? null,
      stage_id: params.stageId ?? sourceStage?.stageId ?? null,
      run_id: runId,
      branch,
      options: params.options ?? {},
      output_dir: outputDir,
      install_command: installCommand,
    }

    const payloadB64 = encodePythonPayload(payload)

    const pythonScript = `
import base64
import json
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"
ERRORS_DIR = r"${projectErrorsRoot().replace(/\\/g, "\\\\")}"

def emit(result):
    print(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=False)}")

sys.path.insert(0, r"${ECONOMETRICS_DIR.replace(/\\/g, "\\\\")}")

try:
    from econometric_algorithm import *
except Exception as e:
    emit({"success": False, "error": f"Failed to import econometric_algorithm: {str(e)}"})
    raise SystemExit(0)

payload = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))
method = payload["method"]
options = payload.get("options", {})

required_option_columns = {
    "iv_2sls": ["iv_variable"],
    "iv_test": ["iv_variable"],
    "did_static": ["treatment_entity_dummy", "treatment_finished_dummy"],
    "did_staggered": ["treatment_entity_dummy", "treatment_finished_dummy"],
    "did_event_study": ["treatment_entity_dummy", "treatment_finished_dummy"],
    "did_event_study_viz": ["treatment_entity_dummy", "treatment_finished_dummy"],
    "rdd_sharp": ["running_variable"],
    "rdd_fuzzy": ["running_variable"],
    "rdd_fuzzy_global": ["running_variable"],
}

def save_json(file_path, payload):
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

def safe_error_path(method_name):
    error_dir = Path(ERRORS_DIR)
    error_dir.mkdir(parents=True, exist_ok=True)
    from datetime import datetime
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return str(error_dir / f"econometrics_{method_name}_{stamp}_error.json")

def read_table(file_path):
    suffix = Path(file_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(file_path)
    if suffix in [".xlsx", ".xls"]:
        return pd.read_excel(file_path)
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
    raise ValueError(f"Unsupported econometrics input format: {suffix}")

def q(name):
    return 'Q("' + str(name).replace('"', '\\"') + '")'

def nested_pvalue(block, key):
    if not isinstance(block, dict):
        return None
    value = block.get(key)
    if isinstance(value, dict):
        for candidate in ["p_value", "pvalue", "breusch_pagan_pvalue", "white_pvalue"]:
            if candidate in value and value[candidate] is not None:
                try:
                    return float(value[candidate])
                except Exception:
                    return None
    return None

def has_severe_heteroskedasticity(core):
    for key in ["breusch_pagan", "white"]:
        pvalue = nested_pvalue(core, key)
        if pvalue is not None and pvalue < 0.05:
            return True
    return False

def build_model_qa(df, entity_var=None, time_var=None, cluster_var=None):
    warnings = []
    blocking_errors = []
    suggested_repairs = []
    duplicate_rows = 0
    cluster_count = None

    if entity_var and time_var:
        missing_keys = [item for item in [entity_var, time_var] if item not in df.columns]
        if missing_keys:
            blocking_errors.append(f"Panel identifiers not found: {missing_keys}")
        else:
            duplicate_rows = int(df.duplicated(subset=[entity_var, time_var]).sum())
            if duplicate_rows > 0:
                blocking_errors.append(f"Found {duplicate_rows} duplicate entity-time rows")
                suggested_repairs.append("Deduplicate entity-time rows before regression")

    if cluster_var and cluster_var in df.columns:
        cluster_count = int(df[cluster_var].nunique(dropna=True))
        if cluster_count < 10:
            warnings.append(f"Cluster count is low ({cluster_count}); clustered standard errors may be unstable")

    return {
        "warnings": warnings,
        "blocking_errors": blocking_errors,
        "suggested_repairs": suggested_repairs,
        "duplicate_entity_time_rows": duplicate_rows,
        "cluster_count": cluster_count,
    }

def vif_report(frame):
    clean = frame.dropna()
    if clean.empty or clean.shape[1] <= 1:
        return []
    matrix = np.column_stack([np.ones(len(clean)), clean.to_numpy(dtype=float)])
    result = []
    for idx, column in enumerate(clean.columns, start=1):
        target = matrix[:, idx]
        others = np.delete(matrix, idx, axis=1)
        beta = np.linalg.pinv(others.T @ others) @ (others.T @ target)
        fitted = others @ beta
        ssr = float(np.sum((target - fitted) ** 2))
        tss = float(np.sum((target - target.mean()) ** 2))
        if tss == 0:
            vif_value = None
        else:
            r_squared = max(0.0, min(0.999999, 1 - ssr / tss))
            vif_value = float(1.0 / (1.0 - r_squared))
        result.append({"variable": column, "vif": vif_value})
    return result

def breusch_pagan(residuals, design_matrix):
    if design_matrix.shape[1] <= 1:
        return {"breusch_pagan_stat": 0.0, "breusch_pagan_pvalue": 1.0}
    target = residuals ** 2
    beta = np.linalg.pinv(design_matrix.T @ design_matrix) @ (design_matrix.T @ target)
    fitted = design_matrix @ beta
    tss = float(np.sum((target - target.mean()) ** 2))
    rss = float(np.sum((target - fitted) ** 2))
    r_squared = 0.0 if tss == 0 else max(0.0, min(0.999999, 1 - rss / tss))
    lm = len(residuals) * r_squared
    dof = max(design_matrix.shape[1] - 1, 1)
    return {
        "breusch_pagan_stat": float(lm),
        "breusch_pagan_pvalue": float(stats.chi2.sf(lm, dof)),
    }

def cluster_covariance(design_matrix, residuals, groups):
    xtx_inv = np.linalg.pinv(design_matrix.T @ design_matrix)
    meat = np.zeros((design_matrix.shape[1], design_matrix.shape[1]))
    unique_groups = np.unique(groups)
    for group in unique_groups:
        mask = groups == group
        xg = design_matrix[mask]
        ug = residuals[mask]
        score = xg.T @ ug
        meat += np.outer(score, score)
    n = design_matrix.shape[0]
    k = design_matrix.shape[1]
    g = len(unique_groups)
    correction = 1.0
    if g > 1 and n > k:
        correction = (g / (g - 1)) * ((n - 1) / (n - k))
    return correction * (xtx_inv @ meat @ xtx_inv)

def hc1_covariance(design_matrix, residuals):
    xtx_inv = np.linalg.pinv(design_matrix.T @ design_matrix)
    xru = design_matrix * residuals[:, None]
    meat = xru.T @ xru
    n = design_matrix.shape[0]
    k = design_matrix.shape[1]
    correction = 1.0 if n <= k else n / max(n - k, 1)
    return correction * (xtx_inv @ meat @ xtx_inv)

def build_coefficient_table(term_names, beta, std_error, p_value, dof):
    critical = float(stats.t.ppf(0.975, dof)) if dof > 0 else 1.96
    rows = []
    for idx, term in enumerate(term_names):
        t_stat = None if std_error[idx] == 0 else float(beta[idx] / std_error[idx])
        rows.append({
            "term": term,
            "coefficient": float(beta[idx]),
            "std_error": float(std_error[idx]),
            "t_stat": t_stat,
            "p_value": float(p_value[idx]),
            "ci_lower": float(beta[idx] - critical * std_error[idx]),
            "ci_upper": float(beta[idx] + critical * std_error[idx]),
        })
    return pd.DataFrame(rows)

def design_matrix_with_fixed_effects(model_df, treatment_var, covariates, entity_var, time_var):
    transformed = model_df[[entity_var, treatment_var, *covariates]].copy()
    for column in [treatment_var, *covariates]:
        transformed[column] = transformed[column] - transformed.groupby(entity_var)[column].transform("mean")

    time_dummies = pd.get_dummies(model_df[time_var], prefix=time_var, drop_first=True, dtype=float)
    if not time_dummies.empty:
        time_dummies = time_dummies - time_dummies.groupby(model_df[entity_var]).transform("mean")

    matrix_parts = [transformed[[treatment_var, *covariates]].to_numpy(dtype=float)]
    term_names = [treatment_var, *covariates]
    if not time_dummies.empty:
        matrix_parts.append(time_dummies.to_numpy(dtype=float))
        term_names.extend(time_dummies.columns.tolist())
    return np.column_stack(matrix_parts), term_names

def adjusted_r_squared(outcome, residuals, n, k):
    tss = float(np.sum((outcome - outcome.mean()) ** 2))
    rss = float(np.sum(residuals ** 2))
    if tss == 0 or n <= k:
        return 0.0
    return float(1 - (rss / (n - k)) / (tss / (n - 1)))

def run_panel_fe(df, payload):
    dependent_var = payload["dependent_var"]
    treatment_var = payload["treatment_var"]
    covariates = payload.get("covariates", [])
    entity_var = payload["entity_var"]
    time_var = payload["time_var"]
    cluster_var = payload.get("cluster_var") or entity_var
    options = payload.get("options", {})
    auto_policy = options.get("auto_downgrade", True)
    decision_trace = []

    required_columns = [dependent_var, treatment_var, entity_var, time_var] + covariates
    missing_columns = sorted(set([col for col in required_columns if col not in df.columns]))
    if missing_columns:
        raise ValueError(f"Missing columns in dataset: {missing_columns}")

    qa = build_model_qa(df, entity_var, time_var, cluster_var)
    if qa["blocking_errors"]:
        return {
            "success": False,
            "error": "; ".join(qa["blocking_errors"]),
            "warnings": qa["warnings"],
            "blocking_errors": qa["blocking_errors"],
            "suggested_repairs": qa["suggested_repairs"],
        }

    model_columns = required_columns + ([cluster_var] if cluster_var not in required_columns else [])
    model_df = df[model_columns].copy()
    for column in [dependent_var, treatment_var, *covariates]:
        model_df[column] = pd.to_numeric(model_df[column], errors="coerce")

    rows_before = len(model_df)
    model_df = model_df.dropna(subset=[dependent_var, treatment_var, entity_var, time_var, *covariates])
    dropped_rows = int(rows_before - len(model_df))
    if dropped_rows > 0:
        qa["warnings"].append(f"Dropped {dropped_rows} rows with missing model variables")

    if model_df.empty:
        raise ValueError("No usable rows remain after dropping missing model variables")

    outcome = model_df[dependent_var].to_numpy(dtype=float)
    effective_method = "panel_fe"
    degraded_from = None
    effective_covariance = "cluster"
    if auto_policy and qa["duplicate_entity_time_rows"] > 0:
        effective_method = "pooled_ols"
        degraded_from = "panel_fe_regression"
        effective_covariance = "HC1"
        decision_trace.append({
            "kind": "downgrade",
            "message": f"Detected duplicate entity-time rows ({qa['duplicate_entity_time_rows']}), so downgraded from panel FE to pooled OLS with HC1 robust SE.",
        })
    elif qa["cluster_count"] is not None and qa["cluster_count"] < 10:
        effective_covariance = "HC1"
        decision_trace.append({
            "kind": "covariance_switch",
            "message": f"Cluster count is low ({qa['cluster_count']}), so switched clustered SE to HC1 robust SE.",
        })

    if effective_method == "panel_fe":
        outcome = (model_df[dependent_var] - model_df.groupby(entity_var)[dependent_var].transform("mean")).to_numpy(dtype=float)
        design_matrix, term_names = design_matrix_with_fixed_effects(model_df, treatment_var, covariates, entity_var, time_var)
    else:
        design_matrix = np.column_stack([
            np.ones((len(model_df), 1)),
            model_df[[treatment_var, *covariates]].to_numpy(dtype=float),
        ])
        term_names = ["const", treatment_var, *covariates]

    beta = np.linalg.pinv(design_matrix.T @ design_matrix) @ (design_matrix.T @ outcome)
    fitted = design_matrix @ beta
    residuals = outcome - fitted
    groups = pd.factorize(model_df[cluster_var])[0] if cluster_var in model_df.columns else None
    if effective_covariance == "cluster" and groups is not None:
        covariance = cluster_covariance(design_matrix, residuals, groups)
    else:
        covariance = hc1_covariance(design_matrix, residuals)
    std_error = np.sqrt(np.clip(np.diag(covariance), a_min=0, a_max=None))
    dof = max(len(np.unique(groups)) - 1, 1) if effective_covariance == "cluster" and groups is not None else max(len(outcome) - design_matrix.shape[1], 1)
    t_stats = np.divide(beta, std_error, out=np.zeros_like(beta), where=std_error > 0)
    p_value = 2 * stats.t.sf(np.abs(t_stats), dof)

    coefficients = build_coefficient_table(term_names, beta, std_error, p_value, dof)
    coefficients_path = Path(payload["output_dir"]) / "coefficient_table.csv"
    workbook_path = Path(payload["output_dir"]) / "coefficient_table.xlsx"
    diagnostics_path = Path(payload["output_dir"]) / "diagnostics.json"
    metadata_path = Path(payload["output_dir"]) / "model_metadata.json"
    narrative_path = Path(payload["output_dir"]) / "narrative.md"
    output_path = Path(payload["output_dir"]) / "results.json"
    summary_path = Path(payload["output_dir"]) / "model_summary.txt"

    coefficients.to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
        coefficients.to_excel(writer, sheet_name="coefficients", index=False)

    diagnostics = {
        "panel": {
            "entity_var": entity_var,
            "time_var": time_var,
            "cluster_var": cluster_var,
            "entity_count": int(model_df[entity_var].nunique(dropna=True)),
            "time_count": int(model_df[time_var].nunique(dropna=True)),
            "cluster_count": qa["cluster_count"],
            "duplicate_entity_time_rows": qa["duplicate_entity_time_rows"],
            "dropped_rows": dropped_rows,
        },
        "heteroskedasticity": {"status": "skipped", "reason": "lightweight panel_fe diagnostics path"},
        "multicollinearity": {"status": "skipped", "reason": "lightweight panel_fe diagnostics path"},
        "residuals": {
            "mean": float(residuals.mean()),
            "std": float(residuals.std()),
            "min": float(residuals.min()),
            "max": float(residuals.max()),
        },
        "qa": {
            "warnings": qa["warnings"],
            "blocking_errors": qa["blocking_errors"],
            "suggested_repairs": qa["suggested_repairs"],
        },
        "decision_trace": decision_trace,
    }
    metadata = {
        "method": method,
        "backend": "numpy_fe_cluster",
        "covariance": effective_covariance,
        "dependent_var": dependent_var,
        "treatment_var": treatment_var,
        "covariates": covariates,
        "entity_var": entity_var,
        "time_var": time_var,
        "cluster_var": cluster_var,
        "rows_used": int(len(model_df)),
        "rows_dropped": dropped_rows,
        "term_names": term_names,
        "effective_method": effective_method,
        "degraded_from": degraded_from,
        "decision_trace": decision_trace,
    }
    treatment_idx = term_names.index(treatment_var)
    result = {
        "success": True,
        "method": "Panel FE" if effective_method == "panel_fe" else "Pooled OLS (auto downgrade from Panel FE)",
        "coefficient": float(beta[treatment_idx]),
        "std_error": float(std_error[treatment_idx]),
        "p_value": float(p_value[treatment_idx]),
        "r_squared": adjusted_r_squared(outcome, residuals, len(outcome), design_matrix.shape[1]),
        "output_path": str(output_path),
        "coefficients_path": str(coefficients_path),
        "workbook_path": str(workbook_path),
        "diagnostics_path": str(diagnostics_path),
        "metadata_path": str(metadata_path),
        "narrative_path": str(narrative_path),
        "summary_path": str(summary_path),
        "qa_status": "warn" if qa["warnings"] else "pass",
        "warnings": qa["warnings"],
        "blocking_errors": qa["blocking_errors"],
        "suggested_repairs": qa["suggested_repairs"],
        "backend": "numpy_fe_cluster",
        "dropped_rows": dropped_rows,
        "rows_used": int(len(model_df)),
        "cluster_var": cluster_var,
        "table_variables": [treatment_var, *covariates],
        "effective_method": effective_method,
        "effective_covariance": effective_covariance,
        "degraded_from": degraded_from,
        "decision_trace": decision_trace,
    }

    save_json(output_path, result)
    save_json(diagnostics_path, diagnostics)
    save_json(metadata_path, metadata)
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(coefficients.to_string(index=False))
    with open(narrative_path, "w", encoding="utf-8") as f:
        f.write("# Panel FE Regression Summary\\n\\n")
        f.write(f"- Effective method: {effective_method}\\n")
        f.write(f"- Dependent variable: {dependent_var}\\n")
        f.write(f"- Key regressor: {treatment_var}\\n")
        f.write(f"- Controls: {covariates}\\n")
        if effective_method == "panel_fe":
            f.write(f"- Fixed effects: {entity_var}, {time_var}\\n")
        else:
            f.write("- Fixed effects: downgraded to pooled OLS\\n")
        f.write(f"- Covariance: {effective_covariance}\\n")
        f.write(f"- Coefficient: {result['coefficient']:.6f}\\n")
        f.write(f"- Std. error: {result['std_error']:.6f}\\n")
        f.write(f"- P-value: {result['p_value']:.6f}\\n")
        f.write(f"- Adjusted R-squared: {result['r_squared']:.6f}\\n")
        if decision_trace:
            f.write(f"- Decision trace: {decision_trace}\\n")
    return result

try:
    df = read_table(payload["data_path"])

    if method in ["panel_fe_regression", "baseline_regression"]:
        result = run_panel_fe(df, payload)
        if not result.get("success"):
            error_path = safe_error_path(method)
            result["error_log_path"] = error_path
            save_json(error_path, result)
        emit(result)
        raise SystemExit(0)

    try:
        from econometric_algorithm import *
    except Exception as e:
        result = {
            "success": False,
            "error": f"Failed to import econometric_algorithm: {str(e)}",
        }
        error_path = safe_error_path(method)
        result["error_log_path"] = error_path
        save_json(error_path, result)
        emit(result)
        raise SystemExit(0)

    required_columns = [payload["dependent_var"]]
    if payload.get("treatment_var"):
        required_columns.append(payload["treatment_var"])
    required_columns.extend(payload.get("covariates", []))
    if method in ["did_static", "did_staggered", "did_event_study", "did_event_study_viz"]:
        required_columns.extend([payload.get("entity_var"), payload.get("time_var")])

    for opt_key in required_option_columns.get(method, []):
        col = options.get(opt_key)
        if isinstance(col, str):
            required_columns.append(col)
    if isinstance(options.get("relative_time_variable"), str):
        required_columns.append(options["relative_time_variable"])

    missing_columns = sorted(set([c for c in required_columns if c not in df.columns]))
    if missing_columns:
        result = {
            "success": False,
            "error": f"Missing columns in dataset: {missing_columns}",
        }
        error_path = safe_error_path(method)
        result["error_log_path"] = error_path
        save_json(error_path, result)
        emit(result)
        raise SystemExit(0)

    dependent_var = df[payload["dependent_var"]]
    treatment_name = payload.get("treatment_var")
    treatment_var = df[treatment_name] if treatment_name else None

    covariate_names = payload.get("covariates", [])
    covariates = df[covariate_names] if covariate_names else None
    panel_df = None
    if method in ["did_static", "did_staggered", "did_event_study", "did_event_study_viz"]:
        panel_df, dependent_var, treatment_var, covariates = prepare_panel_inputs(df, payload, covariate_names)

    result = {}
    model = None
    coefficients = None
    propensity_score_series = None
    output_kind = "analysis"
    primary_term = treatment_name
    qa = build_model_qa(df, payload.get("entity_var"), payload.get("time_var"), payload.get("cluster_var"))
    auto_policy = options.get("auto_downgrade", True)
    decision_trace = []
    effective_covariance = options.get("cov_type")
    effective_method = method
    degraded_from = None
    iv_diagnostic = None
    parallel_trends_report = None

    if method == "ols_regression":
        effective_covariance = options.get("cov_type", "nonrobust")
        model = ordinary_least_square_regression(
            dependent_var,
            treatment_var,
            covariates,
            cov_info=options.get("cov_type", "nonrobust"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "coefficient": float(model.params[treatment_var.name]),
            "std_error": float(model.bse[treatment_var.name]),
            "p_value": float(model.pvalues[treatment_var.name]),
            "r_squared": float(model.rsquared_adj),
            "method": "OLS",
        }
        coefficients = model_coefficient_table(model)
        output_kind = "regression"

    elif method == "did_static":
        effective_covariance = options.get("cov_type", "unadjusted")
        model = Static_Diff_in_Diff_regression(
            dependent_var,
            panel_df[options["treatment_entity_dummy"]],
            panel_df[options["treatment_finished_dummy"]],
            covariates,
            entity_effect=options.get("entity_effect", False),
            time_effect=options.get("time_effect", False),
            cov_type=options.get("cov_type", "unadjusted"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "ate": float(model.params["treatment_group_treated"]),
            "std_error": float(model.std_errors["treatment_group_treated"]),
            "p_value": float(model.pvalues["treatment_group_treated"]),
            "method": "Static DID",
        }
        coefficients = model_coefficient_table(model)
        output_kind = "regression"
        primary_term = "treatment_group_treated"

    elif method == "psm_matching":
        ps = propensity_score_construction(treatment_var, covariates)
        propensity_score_series = ps
        target_type = options.get("target_type", "ATE")
        value = propensity_score_matching(
            dependent_var,
            treatment_var,
            ps,
            matched_num=options.get("matched_num", 1),
            target_type=target_type,
        )
        metric_term = "ATE" if target_type == "ATE" else "ATT"
        result = {
            "success": True,
            "ate": float(value) if target_type == "ATE" else None,
            "att": float(value) if target_type == "ATT" else None,
            "method": "PSM",
        }
        coefficients = scalar_coefficient_table(metric_term, coefficient=value)
        result["table_variables"] = [metric_term]
        output_kind = "estimator"
        primary_term = metric_term

    elif method == "psm_ipw":
        ps = propensity_score_construction(treatment_var, covariates)
        propensity_score_series = ps
        ate = propensity_score_inverse_probability_weighting(
            dependent_var,
            treatment_var,
            ps,
            target_type=options.get("target_type", "ATE"),
        )
        result = {
            "success": True,
            "ate": float(ate),
            "method": "IPW",
        }
        coefficients = scalar_coefficient_table("ATE", coefficient=ate)
        result["table_variables"] = ["ATE"]
        output_kind = "estimator"
        primary_term = "ATE"

    elif method == "psm_double_robust":
        effective_covariance = options.get("cov_type", None)
        ps = propensity_score_construction(treatment_var, covariates)
        propensity_score_series = ps
        ate = propensity_score_double_robust_estimator_augmented_IPW(
            dependent_var,
            treatment_var,
            ps,
            covariates,
            cov_type=options.get("cov_type", None),
        )
        result = {
            "success": True,
            "ate": float(ate),
            "method": "Double Robust AIPW",
        }
        coefficients = scalar_coefficient_table("ATE", coefficient=ate)
        result["table_variables"] = ["ATE"]
        output_kind = "estimator"
        primary_term = "ATE"

    elif method == "iv_2sls":
        effective_covariance = options.get("cov_type", "nonrobust")
        iv_var = df[options["iv_variable"]]
        iv_diagnostic = iv_strength_diagnostic(treatment_var, iv_var, covariates)
        model = IV_2SLS_regression(
            dependent_var,
            treatment_var,
            iv_var,
            covariates,
            cov_info=options.get("cov_type", "nonrobust"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "coefficient": float(model.params[treatment_var.name]),
            "std_error": float(model.bse[treatment_var.name]),
            "p_value": float(model.pvalues[treatment_var.name]),
            "method": "IV-2SLS",
        }
        coefficients = model_coefficient_table(model)
        output_kind = "regression"

    elif method == "iv_test":
        iv_var = df[options["iv_variable"]]
        test_result = IV_2SLS_IV_setting_test(
            dependent_var,
            treatment_var,
            iv_var,
            covariates,
            cov_type=options.get("cov_type", None),
        )
        result = {
            "success": True,
            "test_results": test_result,
            "method": "IV validity test",
        }
        coefficients = empty_coefficient_table()
        output_kind = "test"

    elif method == "did_staggered":
        effective_covariance = options.get("cov_type", "unadjusted")
        model = Staggered_Diff_in_Diff_regression(
            dependent_var,
            covariate_variables=covariates,
            treatment_entity_dummy=panel_df[options["treatment_entity_dummy"]],
            treatment_finished_dummy=panel_df[options["treatment_finished_dummy"]],
            entity_effect=options.get("entity_effect", None),
            time_effect=options.get("time_effect", None),
            cov_type=options.get("cov_type", "unadjusted"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "ate": float(model.params["treatment_entity_treated"]),
            "std_error": float(model.std_errors["treatment_entity_treated"]),
            "p_value": float(model.pvalues["treatment_entity_treated"]),
            "method": "Staggered DID",
        }
        coefficients = model_coefficient_table(model)
        output_kind = "regression"
        primary_term = "treatment_entity_treated"

    elif method == "did_event_study":
        effective_covariance = options.get("cov_type", "unadjusted")
        model = Staggered_Diff_in_Diff_Event_Study_regression(
            dependent_var,
            covariate_variables=covariates,
            relative_time_variable=panel_df[options["relative_time_variable"]] if options.get("relative_time_variable") else None,
            treatment_entity_dummy=panel_df[options["treatment_entity_dummy"]],
            treatment_finished_dummy=panel_df[options["treatment_finished_dummy"]],
            entity_effect=options.get("entity_effect", None),
            time_effect=options.get("time_effect", None),
            cov_type=options.get("cov_type", "unadjusted"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "coefficient": float(model.params["D0"]) if "D0" in model.params else None,
            "std_error": float(model.std_errors["D0"]) if "D0" in model.std_errors else None,
            "p_value": float(model.pvalues["D0"]) if "D0" in model.pvalues else None,
            "coefficients": {k: float(v) for k, v in model.params.items()},
            "std_errors": {k: float(v) for k, v in model.std_errors.items()},
            "p_values": {k: float(v) for k, v in model.pvalues.items()},
            "method": "Event-study DID",
        }
        coefficients = model_coefficient_table(model)
        parallel_trends_report = parallel_trends_diagnostic(coefficients)
        output_kind = "regression"
        primary_term = "D0"

    elif method == "rdd_sharp":
        effective_covariance = options.get("cov_type", "nonrobust")
        running_var = df[options["running_variable"]]
        cutoff = options.get("cutoff", 0)
        model = Sharp_Regression_Discontinuity_Design_regression(
            dependent_var,
            treatment_var,
            running_var,
            covariates,
            running_variable_cutoff=cutoff,
            running_variable_bandwidth=options.get("bandwidth", None),
            cov_info=options.get("cov_type", "nonrobust"),
            target_type="final_model",
            output_tables=True,
        )
        coefficients = model_coefficient_table(model)
        primary_term = treatment_name if treatment_name in coefficients["term"].tolist() else first_non_const_term(coefficients)
        result = {
            "success": True,
            "late": float(model.params[primary_term]),
            "std_error": float(model.bse[primary_term]),
            "p_value": float(model.pvalues[primary_term]),
            "method": "Sharp RDD",
        }
        output_kind = "regression"

    elif method == "rdd_fuzzy":
        running_var = df[options["running_variable"]]
        cutoff = options.get("cutoff", 0)
        late = Fuzzy_Regression_Discontinuity_Design_regression(
            dependent_var,
            treatment_var,
            running_var,
            covariates,
            running_variable_cutoff=cutoff,
            running_variable_bandwidth=options.get("bandwidth", None),
            cov_info=options.get("cov_type", "nonrobust"),
            target_type="estimator",
            output_tables=True,
        )
        result = {
            "success": True,
            "late": float(late),
            "method": "Fuzzy RDD",
        }
        coefficients = scalar_coefficient_table("LATE", coefficient=late)
        result["table_variables"] = ["LATE"]
        output_kind = "estimator"
        primary_term = "LATE"

    elif method == "psm_construction":
        ps = propensity_score_construction(treatment_var, covariates)
        propensity_score_series = ps
        result = {
            "success": True,
            "propensity_scores": ps.to_dict(),
            "mean_treated": float(ps[treatment_var == 1].mean()),
            "mean_control": float(ps[treatment_var == 0].mean()),
            "method": "Propensity score construction",
        }
        coefficients = empty_coefficient_table()
        output_kind = "analysis"

    elif method == "psm_regression":
        effective_covariance = options.get("cov_type", None)
        ps = propensity_score_construction(treatment_var, covariates)
        propensity_score_series = ps
        model = propensity_score_regression(
            dependent_var,
            treatment_var,
            ps,
            cov_type=options.get("cov_type", None),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "coefficient": float(model.params[treatment_var.name]),
            "std_error": float(model.bse[treatment_var.name]),
            "p_value": float(model.pvalues[treatment_var.name]),
            "method": "PS regression adjustment",
        }
        coefficients = model_coefficient_table(model)
        output_kind = "regression"

    elif method == "psm_dr_ipw_ra":
        effective_covariance = options.get("cov_type", None)
        ps = propensity_score_construction(treatment_var, covariates)
        propensity_score_series = ps
        model = propensity_score_double_robust_estimator_IPW_regression_adjustment(
            dependent_var,
            treatment_var,
            covariates,
            ps,
            cov_type=options.get("cov_type", None),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "coefficient": float(model.params[treatment_var.name]),
            "std_error": float(model.bse[treatment_var.name]),
            "p_value": float(model.pvalues[treatment_var.name]),
            "method": "Double robust IPW-RA",
        }
        coefficients = model_coefficient_table(model)
        output_kind = "regression"

    elif method == "psm_visualize":
        plt = load_matplotlib_pyplot()
        ps = propensity_score_construction(treatment_var, covariates)
        propensity_score_series = ps
        output_path = Path(payload["output_dir"]) / "ps_distribution.png"
        propensity_score_visualize_propensity_score_distribution(treatment_var, ps)
        plt.savefig(output_path, dpi=300, bbox_inches="tight")
        plt.close()
        result = {
            "success": True,
            "plot_path": str(output_path),
            "method": "PS distribution",
        }
        coefficients = empty_coefficient_table()
        output_kind = "visualization"

    elif method == "did_event_study_viz":
        effective_covariance = options.get("cov_type", "unadjusted")
        model = Staggered_Diff_in_Diff_Event_Study_regression(
            dependent_var,
            covariate_variables=covariates,
            relative_time_variable=panel_df[options["relative_time_variable"]] if options.get("relative_time_variable") else None,
            treatment_entity_dummy=panel_df[options["treatment_entity_dummy"]],
            treatment_finished_dummy=panel_df[options["treatment_finished_dummy"]],
            entity_effect=options.get("entity_effect", None),
            time_effect=options.get("time_effect", None),
            cov_type=options.get("cov_type", "unadjusted"),
            target_type="final_model",
            output_tables=True,
        )
        parallel_trends_report = parallel_trends_diagnostic(model_coefficient_table(model))
        plt = load_matplotlib_pyplot()
        output_path = Path(payload["output_dir"]) / "event_study.png"
        Staggered_Diff_in_Diff_Event_Study_visualization(
            model,
            see_back_length=options.get("see_back_length", 4),
            see_forward_length=options.get("see_forward_length", 3),
        )
        plt.savefig(output_path, dpi=300, bbox_inches="tight")
        plt.close()
        result = {
            "success": True,
            "plot_path": str(output_path),
            "method": "Event-study visualization",
        }
        coefficients = empty_coefficient_table()
        output_kind = "visualization"

    elif method == "rdd_fuzzy_global":
        effective_covariance = options.get("cov_type", "nonrobust")
        running_var = df[options["running_variable"]]
        cutoff = options.get("cutoff", 0)
        polynomial_degree = options.get("polynomial_degree", 3)
        model = Fuzzy_RDD_Global_Polynomial_Estimator_regression(
            dependent_var,
            treatment_var,
            running_var,
            covariates,
            running_variable_cutoff=cutoff,
            max_order=polynomial_degree,
            cov_info=options.get("cov_type", "nonrobust"),
            target_type="final_model",
            output_tables=True,
        )
        coefficients = model_coefficient_table(model)
        primary_term = treatment_name if treatment_name in coefficients["term"].tolist() else first_non_const_term(coefficients)
        result = {
            "success": True,
            "late": float(model.params[primary_term]),
            "std_error": float(model.bse[primary_term]),
            "p_value": float(model.pvalues[primary_term]),
            "method": "Fuzzy RDD global polynomial",
        }
        output_kind = "regression"

    else:
        result = {
            "success": False,
            "error": f"Unsupported method: {method}",
        }

    diagnostics = {
        "core": {"status": "skipped", "reason": "diagnostics unavailable for this method"},
        "robustness": {"status": "skipped", "reason": "robustness unavailable for this method"},
        "qa": {
            "warnings": qa["warnings"],
            "blocking_errors": qa["blocking_errors"],
            "suggested_repairs": qa["suggested_repairs"],
            "duplicate_entity_time_rows": qa["duplicate_entity_time_rows"],
            "cluster_count": qa["cluster_count"],
        },
    }

    if result.get("success") and model is not None:
        regressors_for_diagnostics = covariates
        if regressors_for_diagnostics is None and treatment_var is not None:
            regressors_for_diagnostics = pd.DataFrame({treatment_var.name: treatment_var})
        panel_info = None
        if payload.get("entity_var") or payload.get("time_var") or payload.get("cluster_var"):
            panel_info = {
                "entity_var": payload.get("entity_var"),
                "time_var": payload.get("time_var"),
                "cluster_var": payload.get("cluster_var"),
                "cluster_count": qa["cluster_count"],
                "duplicate_entity_time_rows": qa["duplicate_entity_time_rows"],
            }
        diagnostic_errors = []
        try:
            diagnostics["core"] = run_core_diagnostics(
                model,
                regressors=regressors_for_diagnostics,
                treatment_variable=treatment_var,
                propensity_score=propensity_score_series,
                panel_info=panel_info,
            )
        except Exception as exc:
            diagnostic_errors.append(f"core diagnostics failed: {exc}")
            diagnostics["core"] = {"status": "skipped", "reason": str(exc)}
        try:
            diagnostics["robustness"] = run_robustness_checks(
                model,
                frame=df,
                outcome_var=payload["dependent_var"],
                treatment_var=treatment_name,
                covariates=covariate_names,
                cluster_var=payload.get("cluster_var"),
                placebo_var=options.get("placebo_var"),
                alternative_sets=options.get("alternative_specifications"),
                groups=df[payload.get("cluster_var")] if payload.get("cluster_var") in df.columns else None,
            )
        except Exception as exc:
            diagnostic_errors.append(f"robustness checks failed: {exc}")
            diagnostics["robustness"] = {"status": "skipped", "reason": str(exc)}
        if diagnostic_errors:
            diagnostics["diagnostic_errors"] = diagnostic_errors
            qa["warnings"] = list(dict.fromkeys([*qa["warnings"], *diagnostic_errors]))
    elif result.get("success") and propensity_score_series is not None and treatment_var is not None and covariates is not None:
        diagnostics["core"] = {
            "balance": balance_test(treatment_var, covariates),
            "common_support": common_support_report(treatment_var, propensity_score_series),
        }
        diagnostics["robustness"] = {
            "alternative_covariance": {"status": "skipped", "reason": "no fitted model available"},
            "leave_one_cluster_out": {"status": "skipped", "reason": "no fitted model available"},
            "placebo": {"status": "skipped", "reason": "no fitted model available"},
            "alternative_specification": {"status": "skipped", "reason": "no fitted model available"},
        }

    if iv_diagnostic is not None:
        diagnostics["identification"] = {"weak_iv": iv_diagnostic}
    if parallel_trends_report is not None:
        diagnostics["parallel_trends"] = parallel_trends_report

    if (
        result.get("success")
        and model is not None
        and auto_policy
        and options.get("cov_type") is None
        and output_kind == "regression"
        and has_severe_heteroskedasticity(diagnostics.get("core"))
        and hasattr(model, "get_robustcov_results")
    ):
        try:
            model = model.get_robustcov_results(cov_type="HC1")
            coefficients = model_coefficient_table(model)
            effective_covariance = "HC1"
            decision_trace.append({
                "kind": "covariance_switch",
                "message": "Detected heteroskedasticity in diagnostics, so switched inference to HC1 robust standard errors.",
            })
        except Exception:
            pass

    diagnostics["decision_trace"] = decision_trace

    if isinstance(result, dict):
        coefficients = coefficients if coefficients is not None else empty_coefficient_table()
        primary_term = primary_term or first_non_const_term(coefficients)
        if primary_term and not coefficients.empty and primary_term in coefficients["term"].tolist():
            coefficient_row = coefficients.loc[coefficients["term"] == primary_term].iloc[0]
            if result.get("coefficient") is None and pd.notna(coefficient_row.get("coefficient")):
                result["coefficient"] = float(coefficient_row["coefficient"])
            if result.get("std_error") is None and pd.notna(coefficient_row.get("std_error")):
                result["std_error"] = float(coefficient_row["std_error"])
            if result.get("p_value") is None and pd.notna(coefficient_row.get("p_value")):
                result["p_value"] = float(coefficient_row["p_value"])
        if not result.get("table_variables"):
            result["table_variables"] = build_table_variables(method, treatment_name, covariate_names, coefficients, primary_term)
        result["dataset_id"] = payload.get("dataset_id")
        result["stage_id"] = payload.get("stage_id")
        result["branch"] = payload.get("branch")
        result["effective_method"] = effective_method
        result["effective_covariance"] = effective_covariance
        result["degraded_from"] = degraded_from
        result["decision_trace"] = decision_trace
    metadata = {
        "method": method,
        "backend": "econometric_algorithm",
        "dependent_var": payload.get("dependent_var"),
        "treatment_var": treatment_name,
        "covariates": covariate_names,
        "entity_var": payload.get("entity_var"),
        "time_var": payload.get("time_var"),
        "cluster_var": payload.get("cluster_var"),
        "options": options,
        "rows_used": int(getattr(model, "nobs", len(dependent_var))) if result.get("success") else 0,
        "input_encoding": df.attrs.get("_source_encoding", "default"),
        "output_kind": output_kind,
        "table_variables": result.get("table_variables"),
        "effective_method": effective_method,
        "effective_covariance": effective_covariance,
        "degraded_from": degraded_from,
        "decision_trace": decision_trace,
    }
    summary_text = coefficients.to_string(index=False) if not coefficients.empty else json.dumps(result, ensure_ascii=False, indent=2)
    narrative_lines = [
        "# Econometric Analysis Summary",
        "",
        f"- Method: {result.get('method', method)}",
        f"- Output kind: {output_kind}",
        f"- Dependent variable: {payload.get('dependent_var')}",
    ]
    if treatment_name:
        narrative_lines.append(f"- Treatment variable: {treatment_name}")
    if covariate_names:
        narrative_lines.append(f"- Covariates: {covariate_names}")
    if primary_term:
        narrative_lines.append(f"- Primary term: {primary_term}")
    if result.get("coefficient") is not None:
        narrative_lines.append(f"- Primary coefficient: {result['coefficient']}")
    if result.get("ate") is not None:
        narrative_lines.append(f"- ATE: {result['ate']}")
    if result.get("att") is not None:
        narrative_lines.append(f"- ATT: {result['att']}")
    if result.get("late") is not None:
        narrative_lines.append(f"- LATE: {result['late']}")
    if effective_covariance:
        narrative_lines.append(f"- Effective covariance: {effective_covariance}")
    if degraded_from:
        narrative_lines.append(f"- Degraded from: {degraded_from}")
    if decision_trace:
        narrative_lines.append(f"- Decision trace: {decision_trace}")
    narrative_lines.append(f"- QA status: {'fail' if qa['blocking_errors'] else 'warn' if qa['warnings'] else 'pass'}")
    if qa["warnings"]:
        narrative_lines.append(f"- QA warnings: {qa['warnings']}")
    if qa["blocking_errors"]:
        narrative_lines.append(f"- QA blocking errors: {qa['blocking_errors']}")
    result = persist_common_outputs(
        payload,
        result,
        qa,
        diagnostics,
        metadata,
        coefficients,
        summary_text,
        "\\n".join(narrative_lines) + "\\n",
    )
    emit(result)

except Exception as e:
    result = {
        "success": False,
        "error": str(e),
        "traceback": traceback.format_exc(),
    }
    error_path = safe_error_path(method)
    result["error_log_path"] = error_path
    save_json(error_path, result)
    emit(result)
`

    log.info("run econometrics", {
      method: params.methodName,
      dataPath,
      outputDir,
    })

    const execution = await runInlinePython({
      command: pythonCommand,
      script: pythonScript,
      cwd: Instance.directory,
    })
    const { code, stdout, stderr } = execution

    if (code !== 0) {
      log.error("python failed", { code, stderr })
      const failureArtifacts = persistPythonFailureArtifacts({
        label: `${params.methodName}_nonzero_exit`,
        command: pythonCommand,
        cwd: Instance.directory,
        execution,
        context: {
          methodName: params.methodName,
          dataPath,
          datasetId: datasetManifest?.datasetId ?? params.datasetId,
          stageId: params.stageId ?? sourceStage?.stageId,
          runId,
          branch,
          outputDir,
        },
      })
      throw new Error(
        `Econometrics failed with Python ${pythonCommand} (exit code ${code})` +
          `\nCrash script: ${relativeWithinProject(failureArtifacts.scriptCopyPath)}` +
          `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
          `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
          `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
      )
    }

    let result: PythonResult
    try {
      result = parsePythonResult<PythonResult>(stdout)
    } catch (error) {
      const failureArtifacts = persistPythonFailureArtifacts({
        label: `${params.methodName}_parse_failure`,
        command: pythonCommand,
        cwd: Instance.directory,
        execution,
        context: {
          methodName: params.methodName,
          dataPath,
          datasetId: datasetManifest?.datasetId ?? params.datasetId,
          stageId: params.stageId ?? sourceStage?.stageId,
          runId,
          branch,
          outputDir,
          parseError: error instanceof Error ? error.message : String(error),
        },
      })
      throw new Error(
        `Failed to parse python result from ${pythonCommand}: ${error}` +
          `\nCrash script: ${relativeWithinProject(failureArtifacts.scriptCopyPath)}` +
          `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
          `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
          `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
      )
    }
    execution.cleanup()
    result.resolved_python_executable = pythonCommand
    const effectiveRunId = inferRunId({
      requestedRunId: result.run_id ?? runId,
      stage: sourceStage,
    })
    result.run_id = effectiveRunId

    if (!result.success) {
      const reflection = classifyToolFailure({
        toolName: "econometrics",
        error: result.error ?? "unknown error",
        input: {
          methodName: params.methodName,
          dataPath: params.dataPath,
          datasetId: params.datasetId,
          stageId: params.stageId,
          dependentVar: params.dependentVar,
          treatmentVar: params.treatmentVar,
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
      let message = `Econometrics analysis failed: ${result.error ?? "unknown error"}`
      message += `\nPython interpreter: ${pythonCommand}`
      if (result.error_log_path) message += `\nError log: ${relativeWithinProject(result.error_log_path)}`
      message += `\nReflection log: ${relativeWithinProject(reflectionPath)}`
      if (result.traceback) message += `\n${result.traceback}`
      throw new Error(message)
    }

    const diagnosticsPayload = loadJsonFile<Record<string, unknown>>(result.diagnostics_path) ?? {}
    const postEstimationGates = runPostEstimationGates(diagnosticsPayload, params.methodName)
    const gateWarnings = postEstimationGates
      .filter((gate) => !gate.passed && gate.severity === "warning")
      .map((gate) => gate.userMessage)
    const gateBlockingErrors = postEstimationGates
      .filter((gate) => !gate.passed && gate.severity === "blocking")
      .map((gate) => gate.userMessage)

    result.warnings = [...new Set([...(result.warnings ?? []), ...gateWarnings])]
    result.blocking_errors = [...new Set([...(result.blocking_errors ?? []), ...gateBlockingErrors])]
    result.qa_status = result.blocking_errors.length > 0 ? "fail" : result.warnings.length > 0 ? "warn" : "pass"
    result.post_estimation_gates = postEstimationGates

    if (result.diagnostics_path) {
      fs.writeFileSync(
        result.diagnostics_path,
        JSON.stringify({ ...diagnosticsPayload, post_estimation_gates: postEstimationGates }, null, 2),
        "utf-8",
      )
    }
    if (result.output_path) {
      fs.writeFileSync(result.output_path, JSON.stringify(result, null, 2), "utf-8")
    }

    const qaGate = evaluateQaGate({
      toolName: "econometrics",
      qaSource: "diagnostics_or_result",
      warnings: result.warnings,
      blockingErrors: result.blocking_errors,
      input: {
        methodName: params.methodName,
        dataPath: params.dataPath,
        datasetId: params.datasetId,
        stageId: params.stageId,
        dependentVar: params.dependentVar,
        treatmentVar: params.treatmentVar,
        diagnosticsPath: result.diagnostics_path,
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
        `Econometrics blocked by QA gate: ${qaGate.qaGateReason}\nReflection log: ${relativeWithinProject(reflectionPath)}`,
      )
    }

    const publishedFiles: EconometricsPublishedFile[] = []
    let deliveryBundlePath: string | undefined

    if (hasNonEmptyCoefficientTable(result.coefficients_path)) {
      try {
        const tableResult = await generateRegressionTable({
          title: regressionTableTitle(params.methodName),
          modelDirs: [outputDir],
          columnLabels: ["(1)"],
          columnSubtitles: [regressionTableSubtitle(params.methodName)],
          variables: result.table_variables,
          notes: undefined,
          formats: ["markdown", "latex", "xlsx", "docx"],
          outputDir,
          branch,
          runId: effectiveRunId,
        }, ctx)
        if (tableResult.success) {
          result.academic_table_markdown_path = tableResult.markdown_path
          result.academic_table_latex_path = tableResult.latex_path
          result.academic_table_workbook_path = tableResult.workbook_path
          result.academic_table_docx_path = tableResult.docx_path
        }
      } catch (error) {
        log.warn("failed to generate academic table", {
          method: params.methodName,
          error: String(error),
        })
      }
    }

    let numericSnapshot: NumericSnapshotDocument | undefined
    if (result.output_path) {
      numericSnapshot = createEconometricsNumericSnapshot({
        outputDir,
        methodName: params.methodName,
        result: {
          ...result,
          treatment_var: params.treatmentVar,
        },
        coefficientsPath: result.coefficients_path,
        diagnosticsPath: result.diagnostics_path,
        metadataPath: result.metadata_path,
        datasetId: datasetManifest?.datasetId ?? result.dataset_id ?? params.datasetId,
        stageId: params.stageId ?? sourceStage?.stageId ?? result.stage_id,
        runId: effectiveRunId,
      })
      result.numeric_snapshot_path = numericSnapshot.snapshotPath
    }

    const principleChecks = evaluatePrincipleChecks({
      methodName: params.methodName,
      entityVar: params.entityVar,
      timeVar: params.timeVar,
      options: params.options,
      result,
      diagnosticsPayload,
      hasNumericSnapshot: Boolean(result.numeric_snapshot_path),
    })
    result.principle_checks = principleChecks

    if (result.diagnostics_path) {
      fs.writeFileSync(
        result.diagnostics_path,
        JSON.stringify({ ...diagnosticsPayload, post_estimation_gates: postEstimationGates, principle_checks: principleChecks }, null, 2),
        "utf-8",
      )
    }
    if (result.output_path) {
      fs.writeFileSync(result.output_path, JSON.stringify(result, null, 2), "utf-8")
    }

    const conciseResultPath = path.join(outputDir, "delivery_result_summary.md")
    fs.writeFileSync(
      conciseResultPath,
      buildConciseResultMarkdown({
        methodName: params.methodName,
        result,
        treatmentLabel: params.treatmentVar,
        principleChecks,
      }),
      "utf-8",
    )

    result.final_analysis_workbook_path = await generateFinalAnalysisWorkbook({
      dataPath,
      outputDir,
      pythonCommand,
      methodName: params.methodName,
    })

    if (params.methodName === "panel_fe_regression") {
      try {
        result.delivery_report_docx_path = await generateBaselineReportDocx({
          methodName: params.methodName,
          outputDir,
          pythonCommand,
          result,
          dependentVar: params.dependentVar,
          treatmentVar: params.treatmentVar,
          covariates: params.covariates,
          entityVar: params.entityVar,
          timeVar: params.timeVar,
          clusterVar: params.clusterVar,
          qaGateReason: qaGate.qaGateReason,
        })
      } catch (error) {
        log.warn("failed to generate baseline report docx", {
          method: params.methodName,
          error: String(error),
        })
      }
    }

    const shouldGenerateJournalPaper =
      (params.options?.["generateJournalPaper"] === true || params.options?.["generate_journal_paper"] === true) &&
      hasSignificantRegressionResult(result)
    if (shouldGenerateJournalPaper) {
      result.journal_paper_docx_path = await generateJournalPaperDocx({
        methodName: params.methodName,
        outputDir,
        pythonCommand,
        result,
        dependentVar: params.dependentVar,
        treatmentVar: params.treatmentVar,
        covariates: params.covariates,
        entityVar: params.entityVar,
        timeVar: params.timeVar,
        clusterVar: params.clusterVar,
        qaGateReason: qaGate.qaGateReason,
      })
    }

    if (datasetManifest) {
      appendArtifact(datasetManifest, {
        artifactId: `${params.methodName}_${Date.now()}`,
        runId: effectiveRunId,
        stageId: params.stageId ?? sourceStage?.stageId,
        branch,
        action: params.methodName,
        outputPath: result.output_path ?? path.join(outputDir, "results.json"),
        workbookPath: result.workbook_path,
        summaryPath: result.summary_path ?? result.metadata_path,
        logPath: result.narrative_path,
        createdAt: new Date().toISOString(),
        metadata: {
          runId: effectiveRunId,
          numeric_snapshot_path: result.numeric_snapshot_path,
          qa_status: result.qa_status,
          principle_checks: principleChecks,
          warnings: result.warnings,
          blocking_errors: result.blocking_errors,
          suggested_repairs: result.suggested_repairs,
        },
      })
    }

    const stageKey = params.stageId ?? sourceStage?.stageId ?? result.stage_id ?? "stage"
    const publish = (key: string, label: string, sourcePath: string | undefined, fileName: string) => {
      if (!sourcePath) return
      const visiblePath = publishDeliveryOutput({
        manifest: datasetManifest,
        contextSourcePath: dataPath,
        datasetId: datasetManifest?.datasetId ?? result.dataset_id ?? params.datasetId,
        key: `${key}_${stageKey}`,
        label,
        sourcePath,
        runId: effectiveRunId,
        branch: "delivery",
        stageId: params.stageId ?? sourceStage?.stageId ?? result.stage_id,
        fileName,
        metadata: {
          method: params.methodName,
          deliveryKind: label,
        },
      })
      deliveryBundlePath ??= path.dirname(visiblePath)
      publishedFiles.push({
        label,
        relativePath: relativeWithinProject(visiblePath),
      })
    }

    publish(
      `${params.methodName}_delivery_summary`,
      `${params.methodName}_delivery_summary`,
      conciseResultPath,
      `回归结果_${sanitizeDeliveryFilePart(params.methodName)}.md`,
    )
    publish(
      `${params.methodName}_analysis_workbook`,
      `${params.methodName}_analysis_workbook`,
      result.final_analysis_workbook_path,
      `计量分析数据_${sanitizeDeliveryFilePart(params.methodName)}.xlsx`,
    )
    publish(
      `${params.methodName}_academic_latex`,
      `${params.methodName}_table_latex`,
      result.academic_table_latex_path,
      `三线表_${sanitizeDeliveryFilePart(params.methodName)}.tex`,
    )
    publish(
      `${params.methodName}_academic_docx`,
      `${params.methodName}_table_docx`,
      result.academic_table_docx_path,
      `三线表_${sanitizeDeliveryFilePart(params.methodName)}.docx`,
    )
    publish(
      `${params.methodName}_journal_paper`,
      `${params.methodName}_journal_paper`,
      result.journal_paper_docx_path,
      `期刊小论文_${sanitizeDeliveryFilePart(params.methodName)}.docx`,
    )

    if (result.output_path) {
      fs.writeFileSync(result.output_path, JSON.stringify(result, null, 2), "utf-8")
    }

    let output = `## Econometrics result - ${params.methodName}\n\n`
    if (datasetManifest?.datasetId ?? result.dataset_id) output += `Dataset: ${datasetManifest?.datasetId ?? result.dataset_id}\n`
    output += `Run ID: ${effectiveRunId}\n`
    if (params.stageId ?? result.stage_id) output += `Stage: ${params.stageId ?? result.stage_id}\n`
    output += `Branch: ${branch}\n`
    output += `Data file: ${relativeWithinProject(dataPath)}\n`
    output += `Dependent variable: ${params.dependentVar}\n`
    if (params.treatmentVar) output += `Treatment variable: ${params.treatmentVar}\n`
    if (params.covariates?.length) output += `Covariates: ${params.covariates.join(", ")}\n`
    if (params.entityVar) output += `Entity FE: ${params.entityVar}\n`
    if (params.timeVar) output += `Time FE: ${params.timeVar}\n`
    if (params.clusterVar ?? result.cluster_var) output += `Clustered SE: ${params.clusterVar ?? result.cluster_var}\n`
    if (result.effective_method) output += `Effective method: ${result.effective_method}\n`
    if (result.effective_covariance) output += `Effective covariance: ${result.effective_covariance}\n`
    if (result.degraded_from) output += `Degraded from: ${result.degraded_from}\n`
    output += `Claim ceiling: ${principleChecks.claim_ceiling}\n`
    if (principleChecks.findings.length) output += `Principle checks: ${principleChecks.findings.join(" | ")}\n`

    output += `\n### Estimates\n`

    if (!result.numeric_snapshot_path) {
      output += `- Numeric snapshot missing: coefficient-level reporting is suppressed.\n`
    } else if (result.coefficient !== undefined) {
      output += `- Coefficient: ${result.coefficient.toFixed(4)}\n`
      if (result.std_error !== undefined) output += `- Std. error: ${result.std_error.toFixed(4)}\n`
      if (result.p_value !== undefined) {
        output += `- P-value: ${result.p_value.toFixed(4)} ${significanceStars(result.p_value)}\n`
      }
    }

    if (result.r_squared !== undefined) {
      output += `- Adj. R2: ${result.r_squared.toFixed(4)}\n`
    }

    if (result.ate !== undefined) output += `- ATE: ${result.ate.toFixed(4)}\n`
    if (result.att !== undefined) output += `- ATT: ${result.att.toFixed(4)}\n`
    if (result.late !== undefined) output += `- LATE: ${result.late.toFixed(4)}\n`
    if (result.backend) output += `- Backend: ${result.backend}\n`
    if (result.rows_used !== undefined) output += `- Sample size: ${result.rows_used}\n`
    if (result.dropped_rows !== undefined) output += `- Rows dropped before estimation: ${result.dropped_rows}\n`
    if (result.qa_status) output += `- QA status: ${result.qa_status}\n`
    if (qaGate.qaGateStatus === "warn") output += `- QA gate: warn\n`
    if (qaGate.qaGateStatus === "warn" && qaGate.qaGateReason) output += `- QA gate reason: ${qaGate.qaGateReason}\n`
    if (result.warnings?.length) output += `- Warnings: ${result.warnings.join(" | ")}\n`
    const triggeredPostEstimationGates = result.post_estimation_gates?.filter((gate) => !gate.passed) ?? []
    if (triggeredPostEstimationGates.length) {
      output += `- Post-estimation gates: ${triggeredPostEstimationGates.map((gate) => `${gate.gate}=${gate.severity}`).join(" | ")}\n`
    }
    if (result.decision_trace?.length) output += `- Decision trace: ${result.decision_trace.map((item) => item.message).join(" | ")}\n`
    if (result.coefficients_path) output += `- Coefficients CSV: ${relativeWithinProject(result.coefficients_path)}\n`
    if (result.workbook_path) output += `- Coefficients workbook: ${relativeWithinProject(result.workbook_path)}\n`
    if (result.diagnostics_path) output += `- Diagnostics JSON: ${relativeWithinProject(result.diagnostics_path)}\n`
    if (result.metadata_path) output += `- Model metadata: ${relativeWithinProject(result.metadata_path)}\n`
    if (result.summary_path) output += `- Model summary: ${relativeWithinProject(result.summary_path)}\n`
    if (result.narrative_path) output += `- Narrative summary: ${relativeWithinProject(result.narrative_path)}\n`
    if (result.numeric_snapshot_path) output += `- Numeric snapshot: ${relativeWithinProject(result.numeric_snapshot_path)}\n`
    if (result.final_analysis_workbook_path) output += `- Final analysis Excel: ${relativeWithinProject(result.final_analysis_workbook_path)}\n`
    if (result.academic_table_markdown_path) output += `- Three-line table Markdown: ${relativeWithinProject(result.academic_table_markdown_path)}\n`
    if (result.academic_table_latex_path) output += `- Three-line table LaTeX: ${relativeWithinProject(result.academic_table_latex_path)}\n`
    if (result.academic_table_workbook_path) output += `- Three-line table Excel: ${relativeWithinProject(result.academic_table_workbook_path)}\n`
    if (result.academic_table_docx_path) output += `- Three-line table Word: ${relativeWithinProject(result.academic_table_docx_path)}\n`
    if (result.delivery_report_docx_path) output += `- Result report Word: ${relativeWithinProject(result.delivery_report_docx_path)}\n`
    output += `- Concise result summary: ${relativeWithinProject(conciseResultPath)}\n`
    if (result.output_path) output += `- Result JSON: ${relativeWithinProject(result.output_path)}\n`
    if (result.resolved_python_executable) output += `- Python interpreter: ${result.resolved_python_executable}\n`
    if (deliveryBundlePath && publishedFiles.length) output += `Delivery bundle: ${relativeWithinProject(deliveryBundlePath)}\n`
    if (publishedFiles.length) {
      output += `Published files:\n`
      for (const item of publishedFiles) output += `- ${item.relativePath}\n`
    }
    if (hasSignificantRegressionResult(result)) {
      if (result.journal_paper_docx_path) {
        output += `\n已按用户确认生成期刊格式小论文 Word。\n`
      } else {
        output += `\n本次回归结果在常用统计水平上显著。是否需要我基于这次结果继续生成期刊格式小论文 Word？\n`
      }
    }

    output += `\nResults directory: ${relativeWithinProject(outputDir)}/\n`

    const metadata: EconometricsToolMetadata = {
      method: params.methodName,
      result,
      principleChecks,
      datasetId: datasetManifest?.datasetId ?? result.dataset_id ?? params.datasetId,
      stageId: params.stageId ?? sourceStage?.stageId ?? result.stage_id,
      runId: effectiveRunId,
      numericSnapshotPath: result.numeric_snapshot_path ? relativeWithinProject(result.numeric_snapshot_path) : undefined,
      numericSnapshotPreview: numericSnapshotPreview(numericSnapshot),
      groundingScope: "regression",
      qaGateStatus: qaGate.qaGateStatus,
      qaGateReason: qaGate.qaGateReason,
      qaSource: qaGate.qaSource,
      outputDir: relativeWithinProject(outputDir),
      deliveryBundleDir: deliveryBundlePath ? relativeWithinProject(deliveryBundlePath) : undefined,
      publishedFiles,
      finalOutputsPath:
        publishedFiles.length ? relativeWithinProject(finalOutputsPath(dataPath, effectiveRunId)) : undefined,
      internalFinalOutputsPath:
        publishedFiles.length ? relativeWithinProject(finalOutputsPath(dataPath, effectiveRunId)) : undefined,
      presentation: buildEconometricsPresentation({
        params,
        result,
        qaGate,
        principleChecks,
        conciseResultPath,
        deliveryBundlePath,
        publishedFiles,
      }),
      analysisView: createToolAnalysisView({
        kind: "econometrics",
        step: `econometrics(${params.methodName})`,
        datasetId: datasetManifest?.datasetId ?? result.dataset_id ?? params.datasetId,
        stageId: params.stageId ?? sourceStage?.stageId ?? result.stage_id,
        results: [
          analysisMetric(
            params.treatmentVar ? `${params.treatmentVar} 系数` : "系数",
            result.numeric_snapshot_path && result.coefficient !== undefined ? result.coefficient.toFixed(4) : undefined,
          ),
          analysisMetric("标准误", result.std_error !== undefined ? result.std_error.toFixed(4) : undefined),
          analysisMetric("p 值", result.p_value !== undefined ? result.p_value.toFixed(4) : undefined),
          analysisMetric("N", result.rows_used),
          analysisMetric("组数", groupCount(result)),
          analysisMetric(
            params.methodName === "panel_fe_regression" ? "within R²" : "R²",
            result.numeric_snapshot_path && result.r_squared !== undefined ? result.r_squared.toFixed(4) : undefined,
          ),
        ],
        artifacts: [
          analysisArtifact(result.output_path ? relativeWithinProject(result.output_path) : undefined, {
            visibility: "user_default",
          }),
          analysisArtifact(result.diagnostics_path ? relativeWithinProject(result.diagnostics_path) : undefined, {
            visibility: "user_default",
          }),
          analysisArtifact(result.numeric_snapshot_path ? relativeWithinProject(result.numeric_snapshot_path) : undefined, {
            visibility: "user_default",
          }),
          analysisArtifact(result.metadata_path ? relativeWithinProject(result.metadata_path) : undefined, {
            visibility: "user_collapsed",
          }),
          ...publishedFiles.map((item) =>
            analysisArtifact(item.relativePath, {
              label: item.label,
              visibility: "user_collapsed",
            }),
          ),
        ],
        warnings: buildEconometricsWarnings({ result, qaGate, principleChecks }),
        conclusion: buildEconometricsConclusion({
          treatmentVar: params.treatmentVar,
          coefficient: result.coefficient,
          pValue: result.p_value,
          principleChecks,
        }),
      }),
      display: createToolDisplay({
        summary:
          result.numeric_snapshot_path && result.coefficient !== undefined && result.p_value !== undefined
            ? `econometrics(${params.methodName}) completed: ${params.treatmentVar ?? "treatment"} coefficient ${result.coefficient.toFixed(4)}, p-value ${result.p_value.toFixed(4)}`
            : `econometrics(${params.methodName}) completed`,
        details: [
          `Dependent variable: ${params.dependentVar}`,
          params.treatmentVar ? `Treatment variable: ${params.treatmentVar}` : undefined,
          params.entityVar ? `Entity FE: ${params.entityVar}` : undefined,
          params.timeVar ? `Time FE: ${params.timeVar}` : undefined,
          params.clusterVar ?? result.cluster_var ? `Clustered SE: ${params.clusterVar ?? result.cluster_var}` : undefined,
          result.numeric_snapshot_path && result.coefficient !== undefined ? `Coefficient: ${result.coefficient.toFixed(4)}` : undefined,
          result.numeric_snapshot_path && result.std_error !== undefined ? `Std. error: ${result.std_error.toFixed(4)}` : undefined,
          result.numeric_snapshot_path && result.p_value !== undefined ? `P-value: ${result.p_value.toFixed(4)}` : undefined,
          result.rows_used !== undefined ? `N: ${result.rows_used}` : undefined,
          result.post_estimation_gates?.find((gate) => gate.gate === "cluster_count" && gate.diagnosticValue !== undefined)
            ?.diagnosticValue !== undefined
            ? `Groups: ${result.post_estimation_gates.find((gate) => gate.gate === "cluster_count" && gate.diagnosticValue !== undefined)?.diagnosticValue}`
            : undefined,
          result.numeric_snapshot_path && result.r_squared !== undefined ? `R-squared: ${result.r_squared.toFixed(4)}` : undefined,
          qaGate.qaGateStatus ? `QA gate: ${qaGate.qaGateStatus}` : undefined,
          result.warnings?.length ? `Warnings: ${result.warnings.join(" | ")}` : undefined,
          principleChecks.findings.length ? `Principle checks: ${principleChecks.findings.join(" | ")}` : undefined,
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
    }

    return {
      title: `Econometrics: ${params.methodName}`,
      output,
      metadata,
    }
  },
}))



