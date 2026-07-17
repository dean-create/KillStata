import z from "zod"
import * as fs from "fs"
import * as path from "path"
import crypto from "crypto"
import { exec } from "child_process"
import DESCRIPTION from "./econometrics.txt"
import { PY_READ_CSV_FALLBACK } from "./python-snippets"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Tool } from "./tool"
import { Question } from "../question"
import {
  buildFileStamp,
  appendArtifact,
  inferRunId,
  projectErrorsRoot,
  projectTempRoot,
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
import { refreshExperimentLog } from "./analysis-experiment-log"
import {
  createEconometricsNumericSnapshot,
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
import { analysisArtifact, analysisMetric, createToolAnalysisView } from "./analysis-user-view"
import { ensureRuntimePythonReady, formatRuntimePythonSetupError } from "@/killstata/runtime-config"
import { runManagedProcess } from "@/runtime/managed-process"
import { prepareToolMetadata, prepareToolOutput, summarizeToolError } from "@/runtime/tool-result-policy"
import { ensureAnalysisPlan, formatAnalysisChecklist, setAnalysisPlanApproval } from "@/runtime/workflow"
import {
  workflowAnalysisPlanHeader,
  workflowChecklistApprovalPrompt,
  workflowChecklistIntro,
  workflowChecklistOptions,
} from "@/runtime/workflow-locale"
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

export function persistPythonFailureArtifacts(input: {
  label: string
  command: string
  cwd: string
  execution: InlinePythonExecution
  context?: Record<string, unknown>
}) {
  const errorsDir = projectErrorsRoot()
  fs.mkdirSync(errorsDir, { recursive: true })

  const stamp = `${buildFileStamp()}_${process.pid}_${crypto.randomUUID()}`
  const safeLabel = input.label.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "failure"
  const bundleDir = path.join(errorsDir, `econometrics_${safeLabel}_${stamp}`)
  fs.mkdirSync(bundleDir, { mode: 0o700 })
  const stdoutPath = path.join(bundleDir, "stdout.log")
  const stderrPath = path.join(bundleDir, "stderr.log")
  const contextPath = path.join(bundleDir, "context.json")

  const safeContext = prepareToolMetadata(input.context ?? {})
  const privateTextFile = { encoding: "utf-8", mode: 0o600 } as const

  fs.writeFileSync(stdoutPath, summarizeToolError(input.execution.stdout, 64 * 1024), privateTextFile)
  fs.writeFileSync(stderrPath, summarizeToolError(input.execution.stderr, 64 * 1024), privateTextFile)
  fs.writeFileSync(
    contextPath,
    JSON.stringify(
      {
        label: input.label,
        command: summarizeToolError(input.command),
        cwd: summarizeToolError(input.cwd),
        exitCode: input.execution.code,
        stdoutFile: path.basename(stdoutPath),
        stderrFile: path.basename(stderrPath),
        ...safeContext,
      },
      null,
      2,
    ),
    privateTextFile,
  )

  input.execution.cleanup()

  return {
    stdoutPath,
    stderrPath,
    contextPath,
  }
}

async function runInlinePython(input: { command: string; script: string; cwd: string; abort?: AbortSignal }) {
  const tempDir = projectTempRoot()
  fs.mkdirSync(tempDir, { recursive: true })
  const tempScriptPath = path.join(tempDir, `econometrics_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`)
  fs.writeFileSync(tempScriptPath, input.script, { encoding: "utf-8", mode: 0o600 })

  try {
    const execution = await runManagedProcess({
      command: input.command,
      allowedCommands: [input.command],
      args: [tempScriptPath],
      cwd: input.cwd,
      allowedCwdRoot: input.cwd,
      env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      abort: input.abort,
      timeoutMs: 10 * 60 * 1_000,
      maxOutputBytes: 16 * 1024 * 1024,
    })
    return {
      code: execution.code,
      stdout: execution.stdout,
      stderr: execution.stderr,
      scriptPath: tempScriptPath,
      cleanup: () => {},
    }
  } finally {
    fs.rmSync(tempScriptPath, { force: true })
  }
}

const SUPPORTED_METHODS = [
  "auto_recommend",
  "ols_regression",
  "panel_fe_regression",
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
  "rdd_sharp",
  "rdd_fuzzy",
] as const

type MethodName = (typeof SUPPORTED_METHODS)[number]

const PROPENSITY_SCORE_DIAGNOSTIC_METHODS = new Set<MethodName>(["psm_construction", "psm_visualize"])
const PROPENSITY_SCORE_TRANSACTIONAL_METHODS = new Set<MethodName>([
  ...PROPENSITY_SCORE_DIAGNOSTIC_METHODS,
  "psm_matching",
  "psm_ipw",
])
const PROPENSITY_SCORE_NO_INFERENCE_METHODS = new Set<MethodName>([
  ...PROPENSITY_SCORE_DIAGNOSTIC_METHODS,
  "psm_matching",
  "psm_ipw",
])

const MethodSchema = z.enum(SUPPORTED_METHODS)

const METHOD_REQUIRED_OPTIONS: Partial<Record<MethodName, string[]>> = {
  iv_2sls: ["iv_variable"],
  iv_test: ["iv_variable"],
  did_static: ["treatment_entity_dummy", "treatment_finished_dummy"],
  rdd_sharp: ["running_variable"],
  rdd_fuzzy: ["running_variable"],
  psm_matching: ["analysis_unit_var", "pre_treatment_aggregation"],
  psm_ipw: ["analysis_unit_var", "pre_treatment_aggregation"],
}

const METHOD_NEEDS_PANEL_KEYS = new Set<MethodName>([
  "panel_fe_regression",
  "did_static",
])

const METHOD_NEEDS_TREATMENT = new Set<MethodName>([
  "ols_regression",
  "panel_fe_regression",
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
])

type PythonResult = {
  success: boolean
  error?: string
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
  experiment_log_path?: string
  qa_status?: string
  warnings?: string[]
  blocking_errors?: string[]
  suggested_repairs?: string[]
  backend?: string
  dropped_rows?: number
  rows_used?: number
  propensity_scores_path?: string
  score_min?: number
  score_max?: number
  mean_treated?: number
  mean_control?: number
  extreme_score_share?: number
  support_lower?: number
  support_upper?: number
  share_in_support?: number
  treated_count?: number
  control_count?: number
  matched_treated_count?: number
  unmatched_treated_count?: number
  reused_control_count?: number
  caliper?: number
  max_match_distance?: number
  pre_match_max_abs_smd?: number
  post_match_max_abs_smd?: number
  pre_match_smd?: Record<string, number>
  post_match_smd?: Record<string, number>
  treatment_ess?: number
  control_ess?: number
  min_propensity_score?: number
  max_propensity_score?: number
  max_weight?: number
  weighted_smd?: Record<string, number>
  weighted_max_abs_smd?: number
  cluster_var?: string
  test_results?: unknown
  dataset_id?: string
  stage_id?: string
  run_id?: string
  branch?: string
  table_variables?: string[]
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

function isPathInside(parentDir: string, childPath: string) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function cleanupFailedPropensityScoreRun(outputDir: string) {
  fs.rmSync(outputDir, { recursive: true, force: true })
}

function validatePropensityScoreConstructionResult(result: PythonResult, outputDir: string) {
  const requiredProbabilities = [
    ["score_min", result.score_min],
    ["score_max", result.score_max],
    ["mean_treated", result.mean_treated],
    ["mean_control", result.mean_control],
    ["support_lower", result.support_lower],
    ["support_upper", result.support_upper],
  ] as const
  for (const [name, value] of requiredProbabilities) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new Error(`倾向得分后端返回无效的 ${name}，未发布诊断结果`)
    }
  }
  for (const [name, value] of [
    ["share_in_support", result.share_in_support],
    ["extreme_score_share", result.extreme_score_share],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`倾向得分后端返回无效的 ${name}，未发布诊断结果`)
    }
  }
  if (!Number.isInteger(result.rows_used) || (result.rows_used ?? 0) <= 0) {
    throw new Error("倾向得分后端返回无效的样本量，未发布诊断结果")
  }
  if (result.score_min! > result.score_max!) {
    throw new Error("倾向得分后端返回的得分范围顺序错误，未发布诊断结果")
  }

  const scorePath = result.propensity_scores_path
  if (
    typeof scorePath !== "string" ||
    path.basename(scorePath) !== "propensity_scores.csv" ||
    !isPathInside(outputDir, scorePath) ||
    !fs.existsSync(scorePath) ||
    !fs.statSync(scorePath).isFile() ||
    fs.statSync(scorePath).size <= "row_index,treatment,propensity_score\n".length
  ) {
    throw new Error("倾向得分逐行产物缺失或路径越界，未发布诊断结果")
  }
  const descriptor = fs.openSync(scorePath, "r")
  try {
    const headerBuffer = Buffer.alloc(128)
    const bytesRead = fs.readSync(descriptor, headerBuffer, 0, headerBuffer.length, 0)
    if (!headerBuffer.subarray(0, bytesRead).toString("utf-8").startsWith("row_index,treatment,propensity_score\n")) {
      throw new Error("倾向得分逐行产物表头不合法，未发布诊断结果")
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function validatePropensityScoreVisualizationResult(result: PythonResult, outputDir: string) {
  for (const [name, value] of [
    ["score_min", result.score_min],
    ["score_max", result.score_max],
    ["mean_treated", result.mean_treated],
    ["mean_control", result.mean_control],
    ["support_lower", result.support_lower],
    ["support_upper", result.support_upper],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new Error(`倾向得分分布后端返回无效的 ${name}，未发布诊断图`)
    }
  }
  if (
    typeof result.share_in_support !== "number" ||
    !Number.isFinite(result.share_in_support) ||
    result.share_in_support < 0 ||
    result.share_in_support > 1
  ) {
    throw new Error("倾向得分分布后端返回无效的共同支撑占比，未发布诊断图")
  }
  if (
    typeof result.extreme_score_share !== "number" ||
    !Number.isFinite(result.extreme_score_share) ||
    result.extreme_score_share < 0 ||
    result.extreme_score_share > 1 ||
    result.score_min! > result.score_max!
  ) {
    throw new Error("倾向得分分布后端返回无效的得分摘要，未发布诊断图")
  }
  if (
    !Number.isInteger(result.rows_used) ||
    !Number.isInteger(result.treated_count) ||
    !Number.isInteger(result.control_count) ||
    (result.treated_count ?? 0) <= 0 ||
    (result.control_count ?? 0) <= 0 ||
    result.treated_count! + result.control_count! !== result.rows_used
  ) {
    throw new Error("倾向得分分布后端返回无效的分组样本量，未发布诊断图")
  }

  const plotPath = result.plot_path
  if (
    typeof plotPath !== "string" ||
    path.basename(plotPath) !== "ps_distribution.png" ||
    !isPathInside(outputDir, plotPath) ||
    !fs.existsSync(plotPath) ||
    !fs.statSync(plotPath).isFile()
  ) {
    throw new Error("倾向得分分布图缺失或路径越界，未发布诊断图")
  }
  const descriptor = fs.openSync(plotPath, "r")
  try {
    const header = Buffer.alloc(24)
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0)
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    if (
      bytesRead < 24 ||
      !header.subarray(0, 8).equals(signature) ||
      header.readUInt32BE(16) <= 0 ||
      header.readUInt32BE(20) <= 0
    ) {
      throw new Error("倾向得分分布图不是有效的 PNG，未发布诊断图")
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function validatePropensityScoreMatchingResult(result: PythonResult) {
  for (const [name, value] of [
    ["att", result.att],
    ["caliper", result.caliper],
    ["max_match_distance", result.max_match_distance],
    ["pre_match_max_abs_smd", result.pre_match_max_abs_smd],
    ["post_match_max_abs_smd", result.post_match_max_abs_smd],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || (name === "caliper" && value <= 0)) {
      throw new Error(`倾向得分匹配后端返回无效的 ${name}，未发布匹配结果`)
    }
  }
  for (const [name, value] of [
    ["treated_count", result.treated_count],
    ["control_count", result.control_count],
    ["matched_treated_count", result.matched_treated_count],
    ["unmatched_treated_count", result.unmatched_treated_count],
    ["reused_control_count", result.reused_control_count],
  ] as const) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`倾向得分匹配后端返回无效的 ${name}，未发布匹配结果`)
    }
  }
  if (
    (result.treated_count ?? 0) <= 0 ||
    (result.control_count ?? 0) <= 0 ||
    (result.matched_treated_count ?? 0) <= 0 ||
    result.treated_count !== (result.matched_treated_count ?? 0) + (result.unmatched_treated_count ?? 0) ||
    (result.max_match_distance ?? 0) > (result.caliper ?? 0) + 1e-12 ||
    (result.post_match_max_abs_smd ?? Infinity) > 0.1 + 1e-12 ||
    !result.pre_match_smd ||
    !result.post_match_smd ||
    Object.keys(result.pre_match_smd).length === 0 ||
    Object.keys(result.pre_match_smd).length !== Object.keys(result.post_match_smd).length
  ) {
    throw new Error("倾向得分匹配诊断不完整或未达到固定平衡阈值，未发布匹配结果")
  }
  const preKeys = Object.keys(result.pre_match_smd).sort()
  const postKeys = Object.keys(result.post_match_smd).sort()
  if (
    preKeys.some((key, index) => key !== postKeys[index]) ||
    [...Object.values(result.pre_match_smd), ...Object.values(result.post_match_smd)].some(
      (value) => !Number.isFinite(value),
    ) ||
    Math.abs(Math.max(...Object.values(result.pre_match_smd).map(Math.abs)) - result.pre_match_max_abs_smd!) > 1e-12 ||
    Math.abs(Math.max(...Object.values(result.post_match_smd).map(Math.abs)) - result.post_match_max_abs_smd!) > 1e-12
  ) {
    throw new Error("倾向得分匹配 SMD 诊断不一致，未发布匹配结果")
  }
}

function validatePropensityScoreIpwResult(result: PythonResult) {
  for (const [name, value] of [
    ["ate", result.ate],
    ["treatment_ess", result.treatment_ess],
    ["control_ess", result.control_ess],
    ["min_propensity_score", result.min_propensity_score],
    ["max_propensity_score", result.max_propensity_score],
    ["max_weight", result.max_weight],
    ["weighted_max_abs_smd", result.weighted_max_abs_smd],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || (name === "max_weight" && value <= 0)) {
      throw new Error(`逆概率加权后端返回无效的 ${name}，未发布加权结果`)
    }
  }
  for (const [name, value] of [
    ["treated_count", result.treated_count],
    ["control_count", result.control_count],
  ] as const) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`逆概率加权后端返回无效的 ${name}，未发布加权结果`)
    }
  }
  if (
    (result.treatment_ess ?? 0) < 20 ||
    (result.control_ess ?? 0) < 20 ||
    (result.min_propensity_score ?? 0) < 0.05 - 1e-12 ||
    (result.max_propensity_score ?? 1) > 0.95 + 1e-12 ||
    result.min_propensity_score! > result.max_propensity_score! ||
    (result.weighted_max_abs_smd ?? Infinity) > 0.1 + 1e-12 ||
    !result.weighted_smd ||
    Object.keys(result.weighted_smd).length === 0
  ) {
    throw new Error("逆概率加权诊断不完整或未达到固定重叠、有效样本量与平衡阈值，未发布加权结果")
  }
  const smdValues = Object.values(result.weighted_smd)
  if (
    smdValues.some((value) => !Number.isFinite(value)) ||
    Math.abs(Math.max(...smdValues.map(Math.abs)) - result.weighted_max_abs_smd!) > 1e-12
  ) {
    throw new Error("逆概率加权 SMD 诊断不一致，未发布加权结果")
  }
}

export function buildPropensityScoreDiagnosticOutput(result: PythonResult) {
  if (
    result.rows_used === undefined ||
    result.score_min === undefined ||
    result.score_max === undefined ||
    result.mean_treated === undefined ||
    result.mean_control === undefined ||
    result.share_in_support === undefined
  ) {
    throw new Error("倾向得分后端返回结果不完整，未发布诊断结果")
  }
  const supportDescription =
    result.support_lower !== undefined && result.support_upper !== undefined
      ? result.support_lower <= result.support_upper
        ? `${result.support_lower.toFixed(4)} 至 ${result.support_upper.toFixed(4)}`
        : "处理组与对照组没有经验共同支撑"
      : undefined
  return [
    "## 倾向得分诊断",
    "",
    `- 样本量：${result.rows_used}`,
    `- 得分范围：${result.score_min.toFixed(4)} 至 ${result.score_max.toFixed(4)}`,
    `- 处理组平均得分：${result.mean_treated.toFixed(4)}`,
    `- 对照组平均得分：${result.mean_control.toFixed(4)}`,
    supportDescription ? `- 共同支撑区间：${supportDescription}` : undefined,
    `- 共同支撑样本占比：${(result.share_in_support * 100).toFixed(1)}%`,
    result.extreme_score_share !== undefined
      ? `- 极端得分占比：${(result.extreme_score_share * 100).toFixed(1)}%`
      : undefined,
    "",
    "这只是处理分配与重叠情况的诊断，不是因果效应估计；是否继续匹配或加权，要先根据共同支撑和平衡情况决定。",
    result.warnings?.length ? `注意：${result.warnings.join("；")}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
}

export function buildPropensityScoreVisualizationOutput(result: PythonResult) {
  if (
    result.rows_used === undefined ||
    result.treated_count === undefined ||
    result.control_count === undefined ||
    result.score_min === undefined ||
    result.score_max === undefined ||
    result.share_in_support === undefined
  ) {
    throw new Error("倾向得分分布后端返回结果不完整，未发布诊断图")
  }
  return [
    "## 倾向得分分布诊断",
    "",
    `- 样本量：${result.rows_used}（处理组 ${result.treated_count}，对照组 ${result.control_count}）`,
    `- 得分范围：${result.score_min.toFixed(4)} 至 ${result.score_max.toFixed(4)}`,
    `- 共同支撑样本占比：${(result.share_in_support * 100).toFixed(1)}%`,
    "",
    "分布图用于检查处理组与对照组的重叠情况，不是因果效应估计；是否继续匹配或加权，要结合共同支撑与协变量平衡决定。",
    result.warnings?.length ? `注意：${result.warnings.join("；")}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
}

export function buildPropensityScoreMatchingOutput(result: PythonResult) {
  validatePropensityScoreMatchingResult(result)
  return [
    "## 倾向得分最近邻匹配",
    "",
    `- ATT（已匹配处理组）：${result.att!.toFixed(4)}`,
    `- 处理组：${result.treated_count}；其中已匹配 ${result.matched_treated_count}，因固定 caliper 未匹配 ${result.unmatched_treated_count}`,
    `- 对照组：${result.control_count}；被重复使用的对照组：${result.reused_control_count}`,
    `- 固定 caliper：${result.caliper!.toFixed(4)}（logit 倾向得分标准差的 0.2 倍）`,
    `- 最大匹配距离：${result.max_match_distance!.toFixed(4)}`,
    `- 匹配前最大绝对 SMD：${result.pre_match_max_abs_smd!.toFixed(4)}`,
    `- 匹配后最大绝对 SMD：${result.post_match_max_abs_smd!.toFixed(4)}（阈值 ≤ 0.1000）`,
    "",
    "本结果固定为允许重复使用对照组的 1:1 最近邻匹配，并只描述已匹配处理组的 ATT；未输出标准误、p 值、置信区间或显著性结论。",
    result.warnings?.length ? `注意：${result.warnings.join("；")}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
}

export function buildPropensityScoreIpwOutput(result: PythonResult) {
  validatePropensityScoreIpwResult(result)
  return [
    "## 逆概率加权（IPW）",
    "",
    `- ATE：${result.ate!.toFixed(4)}`,
    `- 样本量：处理组 ${result.treated_count}；对照组 ${result.control_count}`,
    `- 倾向得分范围：${result.min_propensity_score!.toFixed(4)} 至 ${result.max_propensity_score!.toFixed(4)}（固定要求 [0.0500, 0.9500]）`,
    `- 有效样本量：处理组 ${result.treatment_ess!.toFixed(2)}；对照组 ${result.control_ess!.toFixed(2)}（每组阈值 ≥ 20）`,
    `- 最大权重：${result.max_weight!.toFixed(4)}`,
    `- 加权后最大绝对 SMD：${result.weighted_max_abs_smd!.toFixed(4)}（阈值 ≤ 0.1000）`,
    "",
    "本结果固定为 Hájek 归一化 ATE；不会静默截尾或裁剪权重。当前未输出标准误、p 值、置信区间或显著性结论。",
    result.warnings?.length ? `注意：${result.warnings.join("；")}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
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
  if (
    params.methodName !== "auto_recommend" &&
    !PROPENSITY_SCORE_DIAGNOSTIC_METHODS.has(params.methodName) &&
    !params.dependentVar
  ) {
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

  if (params.methodName === "psm_matching" || params.methodName === "psm_ipw") {
    const analysisUnitVar = params.options?.analysis_unit_var
    const aggregation = params.options?.pre_treatment_aggregation
    if (typeof analysisUnitVar !== "string" || analysisUnitVar.trim().length === 0) {
      throw new Error(`${params.methodName} requires a non-empty analysis_unit_var`)
    }
    if (!["not_applicable", "baseline", "pre_treatment_mean"].includes(String(aggregation))) {
      throw new Error(`${params.methodName} requires pre_treatment_aggregation to be not_applicable, baseline, or pre_treatment_mean`)
    }
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
  const overlapShare = findNestedNumber(commonSupport, ["overlap_share", "matched_share", "support_share", "share_in_support"])
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

  if (!input.hasNumericSnapshot && !PROPENSITY_SCORE_NO_INFERENCE_METHODS.has(input.methodName)) {
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

  if (PROPENSITY_SCORE_DIAGNOSTIC_METHODS.has(input.methodName)) {
    addFinding("warn", "倾向得分构造只是处理分配与共同支撑诊断，不是因果效应估计。", "prereq")
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
  if (params.methodName === "psm_matching") {
    return buildPropensityScoreMatchingOutput(params.result) + "\n"
  }
  if (params.methodName === "psm_ipw") {
    return buildPropensityScoreIpwOutput(params.result) + "\n"
  }
  if (PROPENSITY_SCORE_DIAGNOSTIC_METHODS.has(params.methodName)) {
    const lines = [params.methodName === "psm_visualize" ? "倾向得分分布诊断" : "倾向得分诊断"]
    if (params.result.rows_used !== undefined) lines.push(`- N：${params.result.rows_used}`)
    if (params.result.score_min !== undefined && params.result.score_max !== undefined) {
      lines.push(`- 得分范围：${params.result.score_min.toFixed(4)} 至 ${params.result.score_max.toFixed(4)}`)
    }
    if (params.result.mean_treated !== undefined) lines.push(`- 处理组平均得分：${params.result.mean_treated.toFixed(4)}`)
    if (params.result.mean_control !== undefined) lines.push(`- 对照组平均得分：${params.result.mean_control.toFixed(4)}`)
    if (params.result.share_in_support !== undefined) {
      lines.push(`- 共同支撑样本占比：${(params.result.share_in_support * 100).toFixed(1)}%`)
    }
    lines.push("- 说明：本结果只描述处理分配与重叠情况，不是因果效应估计。")
    return lines.join("\n") + "\n"
  }

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
}

type WorkbookExportResult = {
  success: boolean
  output_path?: string
  rows?: number
  columns?: number
  error?: string
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
from pathlib import Path

from docx import Document
from docx.enum.text import WD_PARAGRAPH_ALIGNMENT
from docx.oxml.ns import qn
from docx.shared import Inches, Pt

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"

def emit(result):
    print(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=False)}")

def save_json(file_path, payload):
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

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
    }
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
        `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
        `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
        `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
    )
  }

  const result = parsePythonResult<BaselineReportDocxResult>(stdout)
  execution.cleanup()
  if (!result.success || !result.output_path) {
    throw new Error(`Failed to build report docx: ${result.error ?? "unknown error"}`)
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
        `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
        `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
        `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
    )
  }

  const result = parsePythonResult<BaselineReportDocxResult>(stdout)
  execution.cleanup()
  if (!result.success || !result.output_path) {
    throw new Error(`Failed to build journal paper docx: ${result.error ?? "unknown error"}`)
  }
  return result.output_path
}

function buildAnalysisWorkbookPythonScript(payloadB64: string) {
  return `
import base64
import json
from pathlib import Path

import pandas as pd

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"

def emit(result):
    print(RESULT_PREFIX + json.dumps(result, ensure_ascii=False))

def save_json(path, payload):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

${PY_READ_CSV_FALLBACK}

def read_table(file_path):
    path = Path(file_path)
    suffix = path.suffix.lower()
    if suffix in [".xlsx", ".xls"]:
        return pd.read_excel(path)
    if suffix == ".csv":
        return read_csv_with_fallback(path)
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
    }
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
        `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
        `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
        `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
    )
  }

  const result = parsePythonResult<WorkbookExportResult>(stdout)
  execution.cleanup()
  if (!result.success || !result.output_path) {
    throw new Error(`Failed to build final analysis workbook: ${result.error ?? "unknown error"}`)
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

function buildAutoRecommendPythonScript(payloadBase64: string) {
  return `
import base64
import json
import os
from pathlib import Path

import pandas as pd
from pandas.api.types import is_bool_dtype, is_datetime64_any_dtype, is_numeric_dtype

PAYLOAD = json.loads(base64.b64decode("${payloadBase64}").decode("utf-8"))
PREFIX = "${PYTHON_RESULT_PREFIX}"

def emit(obj):
    print(PREFIX + json.dumps(obj, ensure_ascii=False))

${PY_READ_CSV_FALLBACK}

def load_dataframe(data_path: str):
    suffix = Path(data_path).suffix.lower()
    if suffix == ".csv":
        return read_csv_with_fallback(data_path)
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
    if is_bool_dtype(series):
        return True
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
    })
`
}

async function runAutoRecommend(input: {
  dataPath: string
  outputDir: string
  pythonCommand: string
  abort?: AbortSignal
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
    abort: input.abort,
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
        `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
        `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
        `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
    )
  }

  const profileResult = parsePythonResult<SmartProfilePythonResult>(stdout)
  execution.cleanup()
  if (!profileResult.success) {
    throw new Error(`Auto recommendation profiling failed: ${profileResult.error ?? "unknown error"}`)
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
    case "rdd_sharp":
      return "Sharp RDD结果表"
    default:
      return "回归结果表"
  }
}

function regressionTableSubtitle(methodName: MethodName) {
  switch (methodName) {
    case "panel_fe_regression":
      return "固定效应回归"
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
    case "rdd_sharp":
      return "Sharp RDD"
    default:
      return "回归"
  }
}

function buildLegacyEconometricsPythonScript(payloadB64: string): string {
  return `
import base64
import json
import sys
from pathlib import Path

import warnings

import numpy as np
import pandas as pd
import statsmodels.api as sm
from linearmodels.panel import PanelOLS
from scipy import stats

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"

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
    "rdd_sharp": ["running_variable"],
    "rdd_fuzzy": ["running_variable"],
}

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

def save_json(file_path, payload):
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

${PY_READ_CSV_FALLBACK}

def read_table(file_path):
    suffix = Path(file_path).suffix.lower()
    if suffix == ".csv":
        return read_csv_with_fallback(file_path)
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
        for candidate in ["p_value", "pvalue", "lm_pvalue", "breusch_pagan_pvalue", "white_pvalue"]:
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

def assert_ols_design_full_rank(df, dependent_name, treatment_name, covariate_names):
    required = [dependent_name, treatment_name, *covariate_names]
    sample = df[required].dropna()
    if sample.empty:
        raise ValueError("OLS has no complete observations after applying the final estimation sample")
    try:
        regressors = sample[[treatment_name, *covariate_names]].astype(float)
    except Exception as exc:
        raise ValueError(f"OLS regressors must be numeric: {exc}")
    design = sm.add_constant(regressors, has_constant="add").to_numpy(dtype=float)
    rank = int(np.linalg.matrix_rank(design))
    columns = int(design.shape[1])
    if rank < columns:
        raise ValueError(
            f"OLS design matrix is rank deficient (rank={rank}, columns={columns}); "
            "存在完全共线性，请删除重复、常数或线性组合变量后重试"
        )

def multicollinearity_warnings(core):
    if not isinstance(core, dict):
        return []
    warnings = []
    condition = core.get("condition_number", {})
    condition_value = condition.get("condition_number") if isinstance(condition, dict) else None
    if isinstance(condition_value, (int, float)) and np.isfinite(condition_value) and condition_value >= 30:
        warnings.append(f"Potential multicollinearity: condition number is {condition_value:.2f}")
    vif = core.get("vif", {})
    rows = vif.get("rows", []) if isinstance(vif, dict) else []
    high_vif = [
        row for row in rows
        if isinstance(row, dict) and isinstance(row.get("vif"), (int, float)) and row["vif"] >= 10
    ]
    if high_vif:
        details = ", ".join(f"{row.get('variable')}={row.get('vif'):.2f}" for row in high_vif)
        warnings.append(f"Potential multicollinearity: high VIF ({details})")
    return warnings

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

def model_std_errors(model):
    # statsmodels 叫 bse，linearmodels 叫 std_errors。IV 已迁到 linearmodels 的 IV2SLS，
    # 直接取 model.bse 会 AttributeError。
    errors = getattr(model, "std_errors", None)
    if errors is None:
        errors = getattr(model, "bse", None)
    if errors is None:
        raise AttributeError("model exposes neither std_errors nor bse")
    return errors

def model_coefficient_table(model):
    if model is None or not hasattr(model, "params"):
        return empty_coefficient_table()
    params = model.params
    std_errors = getattr(model, "std_errors", getattr(model, "bse", None))
    p_values = getattr(model, "pvalues", None)
    conf_int = model.conf_int() if hasattr(model, "conf_int") else None
    # statsmodels' get_robustcov_results() (used for the HC1 auto-upgrade path) drops the
    # pandas wrapper: params/bse/pvalues/conf_int come back as bare numpy arrays instead of
    # a Series/DataFrame indexed by term name. Re-wrap them here so the rest of this function
    # can keep assuming pandas semantics (.items(), .get(), .loc).
    if isinstance(params, np.ndarray):
        term_names = list(getattr(getattr(model, "model", None), "exog_names", None) or [f"x{i}" for i in range(len(params))])
        params = pd.Series(params, index=term_names)
        if isinstance(std_errors, np.ndarray):
            std_errors = pd.Series(std_errors, index=term_names)
        if isinstance(p_values, np.ndarray):
            p_values = pd.Series(p_values, index=term_names)
        if isinstance(conf_int, np.ndarray):
            conf_int = pd.DataFrame(conf_int, index=term_names, columns=["lower", "upper"])
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


def run_panel_fe(df, payload):
    dependent_var = payload["dependent_var"]
    treatment_var = payload["treatment_var"]
    covariates = payload.get("covariates", [])
    entity_var = payload["entity_var"]
    time_var = payload["time_var"]
    cluster_var = payload.get("cluster_var") or entity_var
    decision_trace = []

    required_columns = list(dict.fromkeys([dependent_var, treatment_var, entity_var, time_var, *covariates, cluster_var]))
    missing_columns = sorted(set([col for col in required_columns if col not in df.columns]))
    if missing_columns:
        raise ValueError(f"Missing columns in dataset: {missing_columns}")

    model_df = df[required_columns].copy()
    non_numeric_columns = []
    for column in [dependent_var, treatment_var, *covariates]:
        original = model_df[column]
        coerced = pd.to_numeric(original, errors="coerce")
        original_non_null = int(original.notna().sum())
        newly_missing = int((original.notna() & coerced.isna()).sum())
        if original_non_null > 0 and newly_missing / original_non_null > 0.5:
            samples = original[original.notna() & coerced.isna()].astype(str).head(3).tolist()
            non_numeric_columns.append(f"{column} (sample values: {samples})")
        model_df[column] = coerced

    if non_numeric_columns:
        raise ValueError(
            "These columns do not look numeric and cannot be used in panel_fe_regression: " + "; ".join(non_numeric_columns)
        )

    rows_before = len(model_df)
    model_df = model_df.dropna(subset=required_columns)
    dropped_rows = int(rows_before - len(model_df))

    if model_df.empty:
        raise ValueError("No usable rows remain after dropping missing model variables")

    # 面板键与聚类数必须基于最终估计样本检查，不能拿原始表的 QA 结果替代。
    qa = build_model_qa(model_df, entity_var, time_var, cluster_var)
    if dropped_rows > 0:
        qa["warnings"].append(f"Dropped {dropped_rows} rows with missing model variables")
    if qa["duplicate_entity_time_rows"] > 0:
        qa["blocking_errors"].append(
            f"Duplicate entity-time rows remain in the estimation sample: {qa['duplicate_entity_time_rows']}"
        )
    if qa["cluster_count"] is not None and qa["cluster_count"] < 2:
        qa["blocking_errors"].append("Clustered panel inference requires at least two non-empty clusters")
    if qa["blocking_errors"]:
        return {
            "success": False,
            "error": "; ".join(qa["blocking_errors"]),
            "warnings": qa["warnings"],
            "blocking_errors": qa["blocking_errors"],
            "suggested_repairs": qa["suggested_repairs"],
        }

    effective_method = "panel_fe"
    degraded_from = None
    effective_covariance = "cluster"
    if qa["cluster_count"] is not None and qa["cluster_count"] < 10:
        decision_trace.append({
            "kind": "warning",
            "message": f"Cluster count is low ({qa['cluster_count']}); kept clustered standard errors and reported the limitation.",
        })

    absorbed_terms = []
    r_squared_overall = None
    r_squared_between = None
    panel_df = model_df.set_index([entity_var, time_var])
    exog = panel_df[[treatment_var, *covariates]]
    mod = PanelOLS(panel_df[dependent_var], exog, entity_effects=True, time_effects=True, drop_absorbed=True, check_rank=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if cluster_var in panel_df.index.names:
            cluster_series = panel_df.index.get_level_values(cluster_var).to_series(index=panel_df.index)
        else:
            cluster_series = panel_df[cluster_var]
        fit_result = mod.fit(cov_type="clustered", clusters=cluster_series)
    absorbed_terms = sorted(set(exog.columns) - set(fit_result.params.index))
    if absorbed_terms:
        qa["warnings"].append(f"These variables were fully absorbed by fixed effects and dropped from the model: {absorbed_terms}")
    coefficients = model_coefficient_table(fit_result)
    residual_values = fit_result.resids.to_numpy(dtype=float)
    r_squared = float(fit_result.rsquared_within)
    r_squared_overall = float(fit_result.rsquared_overall)
    r_squared_between = float(fit_result.rsquared_between)
    backend = "linearmodels_panelols"

    term_names = coefficients["term"].tolist()
    if treatment_var not in term_names:
        raise ValueError(
            f"Treatment variable '{treatment_var}' was fully absorbed by fixed effects and dropped from the model; "
            "add it as a time-varying regressor or remove entity/time fixed effects."
        )

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
            "mean": float(residual_values.mean()),
            "std": float(residual_values.std()),
            "min": float(residual_values.min()),
            "max": float(residual_values.max()),
        },
        "r_squared_within": r_squared,
        "r_squared_overall": r_squared_overall,
        "r_squared_between": r_squared_between,
        "absorbed_terms": absorbed_terms,
        "qa": {
            "warnings": qa["warnings"],
            "blocking_errors": qa["blocking_errors"],
            "suggested_repairs": qa["suggested_repairs"],
        },
        "decision_trace": decision_trace,
    }
    metadata = {
        "method": method,
        "backend": backend,
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
    treatment_row = coefficients.loc[coefficients["term"] == treatment_var].iloc[0]
    result = {
        "success": True,
        "method": "Panel FE",
        "coefficient": float(treatment_row["coefficient"]),
        "std_error": float(treatment_row["std_error"]),
        "p_value": float(treatment_row["p_value"]),
        "r_squared": r_squared,
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
        "backend": backend,
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
        f.write(f"- Fixed effects: {entity_var}, {time_var}\\n")
        f.write(f"- Covariance: {effective_covariance}\\n")
        f.write(f"- Coefficient: {result['coefficient']:.6f}\\n")
        f.write(f"- Std. error: {result['std_error']:.6f}\\n")
        f.write(f"- P-value: {result['p_value']:.6f}\\n")
        f.write(f"- R-squared: {result['r_squared']:.6f}\\n")
        if decision_trace:
            f.write(f"- Decision trace: {decision_trace}\\n")
    return result

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
    if method in ["ols_regression", "iv_2sls", "psm_regression", "psm_dr_ipw_ra", "rdd_sharp"]:
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

def load_matplotlib_pyplot():
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib import pyplot as plt
    return plt

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

    # 分布诊断没有回归系数，避免生成两个空表冒充可解释产物。
    if payload.get("method") != "psm_visualize":
        coefficients = coefficients if coefficients is not None else empty_coefficient_table()
        coefficients.to_csv(coefficients_path, index=False, encoding="utf-8-sig")
        with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
            coefficients.to_excel(writer, sheet_name="coefficients", index=False)

    result["output_path"] = str(output_path)
    if payload.get("method") != "psm_visualize":
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

try:
    df = read_table(payload["data_path"])

    if method in ["panel_fe_regression"]:
        result = run_panel_fe(df, payload)
        emit(result)
        raise SystemExit(0)

    try:
        from econometric_algorithm import *
    except Exception as e:
        result = {
            "success": False,
            "error": f"Failed to import econometric_algorithm: {str(e)}",
        }
        emit(result)
        raise SystemExit(0)

    required_columns = []
    if payload.get("dependent_var"):
        required_columns.append(payload["dependent_var"])
    if payload.get("treatment_var"):
        required_columns.append(payload["treatment_var"])
    required_columns.extend(payload.get("covariates", []))
    if method in ["did_static"]:
        required_columns.extend([payload.get("entity_var"), payload.get("time_var")])
    if method in ["psm_matching", "psm_ipw"]:
        required_columns.append(options.get("analysis_unit_var"))

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
        emit(result)
        raise SystemExit(0)

    if method in ["psm_matching", "psm_ipw"]:
        analysis_unit_var = options.get("analysis_unit_var")
        aggregation = options.get("pre_treatment_aggregation")
        allowed_aggregations = ["not_applicable", "baseline", "pre_treatment_mean"]
        if not isinstance(analysis_unit_var, str) or not analysis_unit_var.strip():
            raise ValueError(f"{method} requires a declared analysis unit column")
        if aggregation not in allowed_aggregations:
            raise ValueError(
                f"{method} requires pre_treatment_aggregation to be one of {allowed_aggregations}"
            )
        if df[analysis_unit_var].isna().any():
            raise ValueError(f"{method} analysis unit column {analysis_unit_var} contains missing values")
        duplicate_units = int(df[analysis_unit_var].duplicated().sum())
        if duplicate_units:
            raise ValueError(
                f"{method} requires exactly one row per analysis unit after pre-treatment aggregation; "
                f"{analysis_unit_var} has {duplicate_units} duplicate rows. "
                "Create a canonical stage with one baseline or pre-treatment-mean row per unit before PSM."
            )

    dependent_var = df[payload["dependent_var"]] if payload.get("dependent_var") else None
    treatment_name = payload.get("treatment_var")
    treatment_var = df[treatment_name] if treatment_name else None

    covariate_names = payload.get("covariates", [])
    covariates = df[covariate_names] if covariate_names else None
    analysis_row_count = len(dependent_var) if dependent_var is not None else len(treatment_var) if treatment_var is not None else len(df)
    panel_df = None
    if method in ["did_static"]:
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
    matching_diagnostics = None

    if method == "ols_regression":
        assert_ols_design_full_rank(df, payload["dependent_var"], treatment_name, covariate_names)
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
            "std_error": float(model_std_errors(model)[treatment_var.name]),
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
        matching = propensity_score_nearest_neighbor_att(
            dependent_var,
            treatment_var,
            ps,
            covariates,
        )
        matched_share = matching["matched_treated_count"] / matching["treated_count"]
        matching_diagnostics = {
            "common_support": {
                "passed": True,
                "matched_share": float(matched_share),
            },
            "balance": {
                "threshold": 0.10,
                "pre_match_smd": matching["pre_match_smd"],
                "post_match_smd": matching["post_match_smd"],
                "pre_match_max_abs_smd": matching["pre_match_max_abs_smd"],
                "post_match_max_abs_smd": matching["post_match_max_abs_smd"],
            },
        }
        if matching["unmatched_treated_count"] > 0:
            qa["warnings"].append(
                f"固定 caliper 未匹配 {matching['unmatched_treated_count']} 个处理组样本；当前效应仅对应已匹配处理组"
            )
        result = {
            "success": True,
            "att": float(matching["att"]),
            "caliper": float(matching["caliper"]),
            "treated_count": int(matching["treated_count"]),
            "control_count": int(matching["control_count"]),
            "matched_treated_count": int(matching["matched_treated_count"]),
            "unmatched_treated_count": int(matching["unmatched_treated_count"]),
            "reused_control_count": int(matching["reused_control_count"]),
            "max_match_distance": float(matching["max_match_distance"]),
            "pre_match_smd": matching["pre_match_smd"],
            "post_match_smd": matching["post_match_smd"],
            "pre_match_max_abs_smd": float(matching["pre_match_max_abs_smd"]),
            "post_match_max_abs_smd": float(matching["post_match_max_abs_smd"]),
            "method": "PSM nearest-neighbor ATT (matched treated)",
        }
        coefficients = scalar_coefficient_table("ATT_matched_treated", coefficient=matching["att"])
        result["table_variables"] = ["ATT_matched_treated"]
        output_kind = "estimator"
        primary_term = "ATT_matched_treated"

    elif method == "psm_ipw":
        ps = propensity_score_construction(treatment_var, covariates)
        propensity_score_series = ps
        ipw = propensity_score_hajek_ipw_ate(
            dependent_var,
            treatment_var,
            ps,
            covariates,
        )
        matching_diagnostics = {
            "common_support": {
                "passed": True,
                "score_lower_bound": 0.05,
                "score_upper_bound": 0.95,
            },
            "weighting": {
                "estimator": "hajek_ate",
                "treatment_ess": ipw["treatment_ess"],
                "control_ess": ipw["control_ess"],
                "max_weight": ipw["max_weight"],
            },
            "balance": {
                "threshold": 0.10,
                "weighted_smd": ipw["weighted_smd"],
                "weighted_max_abs_smd": ipw["weighted_max_abs_smd"],
            },
        }
        result = {
            "success": True,
            "ate": float(ipw["ate"]),
            "treated_count": int(ipw["treated_count"]),
            "control_count": int(ipw["control_count"]),
            "treatment_ess": float(ipw["treatment_ess"]),
            "control_ess": float(ipw["control_ess"]),
            "min_propensity_score": float(ipw["min_propensity_score"]),
            "max_propensity_score": float(ipw["max_propensity_score"]),
            "max_weight": float(ipw["max_weight"]),
            "weighted_smd": ipw["weighted_smd"],
            "weighted_max_abs_smd": float(ipw["weighted_max_abs_smd"]),
            "method": "Hájek IPW ATE",
        }
        coefficients = scalar_coefficient_table("ATE", coefficient=ipw["ate"])
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
            "std_error": float(model_std_errors(model)[treatment_var.name]),
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
            "std_error": float(model_std_errors(model)[primary_term]),
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
        support = common_support_report(treatment_var, ps)
        scores_path = Path(payload["output_dir"]) / "propensity_scores.csv"
        scores_temp_path = Path(payload["output_dir"]) / "propensity_scores.csv.tmp"
        scores_frame = pd.DataFrame({
            "row_index": ps.index.to_numpy(),
            "treatment": treatment_var.loc[ps.index].astype(int).to_numpy(),
            "propensity_score": ps.to_numpy(dtype=float),
        })
        try:
            scores_frame.to_csv(scores_temp_path, index=False)
            scores_temp_path.replace(scores_path)
        finally:
            scores_temp_path.unlink(missing_ok=True)
        extreme_score_share = float(((ps <= 0.01) | (ps >= 0.99)).mean())
        share_in_support = support.get("share_in_support") if isinstance(support, dict) else None
        if extreme_score_share > 0:
            qa["warnings"].append(
                f"{extreme_score_share:.1%} 的倾向得分落在 [0.01, 0.99] 之外，后续不得直接使用不稳定的逆概率权重"
            )
        if isinstance(share_in_support, (int, float)) and share_in_support < 1:
            qa["warnings"].append(
                f"只有 {share_in_support:.1%} 的样本位于经验共同支撑区间，估计效应前必须先处理重叠问题"
            )
        result = {
            "success": True,
            "propensity_scores_path": str(scores_path),
            "score_min": float(ps.min()),
            "score_max": float(ps.max()),
            "mean_treated": float(ps[treatment_var == 1].mean()),
            "mean_control": float(ps[treatment_var == 0].mean()),
            "extreme_score_share": extreme_score_share,
            "support_lower": support.get("lower_bound") if isinstance(support, dict) else None,
            "support_upper": support.get("upper_bound") if isinstance(support, dict) else None,
            "share_in_support": share_in_support,
            "logit_iterations": int(ps.attrs.get("iterations", 0)),
            "method": "Propensity score construction",
        }
        coefficients = empty_coefficient_table()
        output_kind = "diagnostic"

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
            "std_error": float(model_std_errors(model)[treatment_var.name]),
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
            "std_error": float(model_std_errors(model)[treatment_var.name]),
            "p_value": float(model.pvalues[treatment_var.name]),
            "method": "Double robust IPW-RA",
        }
        coefficients = model_coefficient_table(model)
        output_kind = "regression"

    elif method == "psm_visualize":
        plt = load_matplotlib_pyplot()
        ps = propensity_score_construction(treatment_var, covariates)
        propensity_score_series = ps
        support = common_support_report(treatment_var, ps)
        output_path = Path(payload["output_dir"]) / "ps_distribution.png"
        output_temp_path = Path(payload["output_dir"]) / "ps_distribution.tmp.png"
        figure = propensity_score_visualize_propensity_score_distribution(treatment_var, ps)
        try:
            figure.savefig(output_temp_path, dpi=160, bbox_inches="tight", format="png")
            output_temp_path.replace(output_path)
        finally:
            output_temp_path.unlink(missing_ok=True)
            plt.close(figure)
        share_in_support = support.get("share_in_support") if isinstance(support, dict) else None
        if isinstance(share_in_support, (int, float)) and share_in_support < 1:
            qa["warnings"].append(
                f"只有 {share_in_support:.1%} 的样本位于经验共同支撑区间，估计效应前必须先处理重叠问题"
            )
        result = {
            "success": True,
            "plot_path": str(output_path),
            "score_min": float(ps.min()),
            "score_max": float(ps.max()),
            "mean_treated": float(ps[treatment_var == 1].mean()),
            "mean_control": float(ps[treatment_var == 0].mean()),
            "extreme_score_share": float(((ps <= 0.01) | (ps >= 0.99)).mean()),
            "support_lower": support.get("lower_bound") if isinstance(support, dict) else None,
            "support_upper": support.get("upper_bound") if isinstance(support, dict) else None,
            "share_in_support": share_in_support,
            "treated_count": int((treatment_var == 1).sum()),
            "control_count": int((treatment_var == 0).sum()),
            "method": "PS distribution",
        }
        coefficients = empty_coefficient_table()
        output_kind = "visualization"

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
        multicollinearity_regressors = None
        if treatment_var is not None:
            multicollinearity_regressors = pd.concat(
                [treatment_var.rename(treatment_var.name), covariates] if covariates is not None else [treatment_var.rename(treatment_var.name)],
                axis=1,
            )
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
            if isinstance(diagnostics["core"], dict) and multicollinearity_regressors is not None:
                diagnostics["core"]["vif"] = vif_report(multicollinearity_regressors)
                qa["warnings"] = list(dict.fromkeys([
                    *qa["warnings"],
                    *multicollinearity_warnings(diagnostics["core"]),
                ]))
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

    if matching_diagnostics is not None:
        diagnostics["matching"] = matching_diagnostics

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
        # 样本量此前只写进了 metadata，没写进 result，而 TS 侧读的是 result.rows_used ——
        # 结果是 OLS/DID/IV/PSM/RDD 这些走本后端的方法全都不报 N。N 是论文必报的数字。
        if result.get("rows_used") is None:
            result["rows_used"] = int(getattr(model, "nobs", analysis_row_count))
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
        "rows_used": int(getattr(model, "nobs", analysis_row_count)) if result.get("success") else 0,
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
        "# Propensity Score Diagnostic" if method in ["psm_construction", "psm_visualize"] else "# Econometric Analysis Summary",
        "",
        f"- Method: {result.get('method', method)}",
        f"- Output kind: {output_kind}",
    ]
    if payload.get("dependent_var"):
        narrative_lines.append(f"- Dependent variable: {payload.get('dependent_var')}")
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
    if method in ["psm_construction", "psm_visualize"]:
        narrative_lines.append("- Interpretation boundary: treatment-assignment and overlap diagnostic only; this is not a causal effect estimate.")
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
    }
    emit(result)
`
}

function buildEstimationResultViews(input: {
  params: {
    methodName: MethodName
    datasetId?: string
    stageId?: string
    treatmentVar?: string
    dependentVar?: string
    entityVar?: string
    timeVar?: string
    clusterVar?: string
  }
  result: PythonResult
  datasetManifest: ReturnType<typeof resolveArtifactInput>["manifest"]
  sourceStage: ReturnType<typeof resolveArtifactInput>["stage"]
  qaGate: { qaGateStatus?: string; qaGateReason?: string }
  principleChecks: PrincipleChecks
  publishedFiles: EconometricsPublishedFile[]
  isPropensityScoreDiagnostic: boolean
  isPropensityScoreVisualization: boolean
  isPropensityScoreMatching: boolean
  isPropensityScoreIpw: boolean
}) {
  const {
    params,
    result,
    datasetManifest,
    sourceStage,
    qaGate,
    principleChecks,
    publishedFiles,
    isPropensityScoreDiagnostic,
    isPropensityScoreVisualization,
    isPropensityScoreMatching,
    isPropensityScoreIpw,
  } = input
  return {
      analysisView: isPropensityScoreDiagnostic
        ? createToolAnalysisView({
            kind: "econometrics",
            step: params.methodName,
            datasetId: datasetManifest?.datasetId ?? result.dataset_id ?? params.datasetId,
            stageId: params.stageId ?? sourceStage?.stageId ?? result.stage_id,
            results: [
              analysisMetric("N", result.rows_used),
              analysisMetric("得分范围", `${result.score_min!.toFixed(4)}–${result.score_max!.toFixed(4)}`),
              analysisMetric("共同支撑占比", `${(result.share_in_support! * 100).toFixed(1)}%`),
            ],
            artifacts: isPropensityScoreVisualization
              ? [
                  analysisArtifact(result.plot_path ? relativeWithinProject(result.plot_path) : undefined, {
                    label: "倾向得分分布图",
                    visibility: "user_default",
                  }),
                ]
              : [
                  analysisArtifact(
                    result.propensity_scores_path ? relativeWithinProject(result.propensity_scores_path) : undefined,
                    { label: "逐行倾向得分", visibility: "user_collapsed" },
                  ),
                ],
            warnings: buildEconometricsWarnings({ result, qaGate, principleChecks }),
            conclusion: "已完成处理分配与共同支撑诊断；本步骤不是因果效应估计。",
          })
        : isPropensityScoreMatching
          ? createToolAnalysisView({
              kind: "econometrics",
              step: "psm_matching",
              datasetId: datasetManifest?.datasetId ?? result.dataset_id ?? params.datasetId,
              stageId: params.stageId ?? sourceStage?.stageId ?? result.stage_id,
              results: [
                analysisMetric("ATT（已匹配处理组）", result.att !== undefined ? result.att.toFixed(4) : undefined),
                analysisMetric("已匹配处理组", result.matched_treated_count),
                analysisMetric("未匹配处理组", result.unmatched_treated_count),
                analysisMetric("匹配后最大绝对 SMD", result.post_match_max_abs_smd?.toFixed(4)),
              ],
              artifacts: [
                analysisArtifact(result.output_path ? relativeWithinProject(result.output_path) : undefined, {
                  label: "匹配结果",
                  visibility: "user_collapsed",
                }),
              ],
              warnings: buildEconometricsWarnings({ result, qaGate, principleChecks }),
              conclusion: "固定规则的最近邻匹配已通过协变量平衡阈值；该结果只对应已匹配处理组，且不包含显著性推断。",
            })
        : isPropensityScoreIpw
          ? createToolAnalysisView({
              kind: "econometrics",
              step: "psm_ipw",
              datasetId: datasetManifest?.datasetId ?? result.dataset_id ?? params.datasetId,
              stageId: params.stageId ?? sourceStage?.stageId ?? result.stage_id,
              results: [
                analysisMetric("ATE", result.ate !== undefined ? result.ate.toFixed(4) : undefined),
                analysisMetric("处理组有效样本量", result.treatment_ess?.toFixed(2)),
                analysisMetric("对照组有效样本量", result.control_ess?.toFixed(2)),
                analysisMetric("加权后最大绝对 SMD", result.weighted_max_abs_smd?.toFixed(4)),
              ],
              artifacts: [
                analysisArtifact(result.output_path ? relativeWithinProject(result.output_path) : undefined, {
                  label: "加权结果",
                  visibility: "user_collapsed",
                }),
              ],
              warnings: buildEconometricsWarnings({ result, qaGate, principleChecks }),
              conclusion: "固定 Hájek 逆概率加权已通过重叠、有效样本量与协变量平衡阈值；当前不包含显著性推断。",
            })
        : createToolAnalysisView({
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
      display: isPropensityScoreDiagnostic
        ? createToolDisplay({
            summary: `倾向得分诊断完成：共同支撑样本占比 ${(result.share_in_support! * 100).toFixed(1)}%`,
            details: [
              `样本量：${result.rows_used}`,
              `得分范围：${result.score_min!.toFixed(4)} 至 ${result.score_max!.toFixed(4)}`,
              "本步骤不是因果效应估计。",
            ],
            artifacts: isPropensityScoreVisualization
              ? result.plot_path
                ? [
                    {
                      label: "倾向得分分布图",
                      path: relativeWithinProject(result.plot_path),
                      visibility: "user_default" as const,
                    },
                  ]
                : []
              : result.propensity_scores_path
                ? [
                    {
                      label: "逐行倾向得分",
                      path: relativeWithinProject(result.propensity_scores_path),
                      visibility: "user_collapsed" as const,
                    },
                  ]
                : [],
          })
        : isPropensityScoreMatching
          ? createToolDisplay({
              summary: `倾向得分匹配完成：ATT（已匹配处理组）${result.att!.toFixed(4)}`,
              details: [
                `已匹配处理组：${result.matched_treated_count}/${result.treated_count}`,
                `匹配后最大绝对 SMD：${result.post_match_max_abs_smd!.toFixed(4)}（阈值 ≤ 0.1000）`,
                "未输出标准误、p 值、置信区间或显著性结论。",
              ],
              artifacts: [],
            })
        : isPropensityScoreIpw
          ? createToolDisplay({
              summary: `逆概率加权完成：ATE ${result.ate!.toFixed(4)}`,
              details: [
                `有效样本量：处理组 ${result.treatment_ess!.toFixed(2)}；对照组 ${result.control_ess!.toFixed(2)}（每组阈值 ≥ 20）`,
                `加权后最大绝对 SMD：${result.weighted_max_abs_smd!.toFixed(4)}（阈值 ≤ 0.1000）`,
                "未输出标准误、p 值、置信区间或显著性结论。",
              ],
              artifacts: [],
            })
        : createToolDisplay({
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
}

async function runAutoRecommendMethod(input: {
  params: {
    methodName: MethodName
    dependentVar?: string
    treatmentVar?: string
    entityVar?: string
    timeVar?: string
    datasetId?: string
    stageId?: string
  }
  dataPath: string
  outputDir: string
  pythonCommand: string
  ctx: Tool.Context
  datasetManifest: ReturnType<typeof resolveArtifactInput>["manifest"]
  runId: string
  sourceStage: ReturnType<typeof resolveArtifactInput>["stage"]
  branch: string
}): Promise<{ title: string; output: string; metadata: EconometricsToolMetadata }> {
  const { params, dataPath, outputDir, pythonCommand, ctx, datasetManifest, runId, sourceStage, branch } = input
      const autoResult = await runAutoRecommend({
        dataPath,
        outputDir,
        pythonCommand,
        params,
        abort: ctx.abort,
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
    validateMethodOptions({
      methodName: params.methodName,
      dependentVar: params.dependentVar,
      treatmentVar: params.treatmentVar,
      options: params.options,
      entityVar: params.entityVar,
      timeVar: params.timeVar,
    })
    if (PROPENSITY_SCORE_TRANSACTIONAL_METHODS.has(params.methodName) && params.outputDir !== undefined) {
      throw new Error(`${params.methodName} 不接受调用方指定 outputDir；输出目录由 Harness 隔离管理`)
    }

    // 参数校验必须先于审批弹窗：没有数据来源的调用根本跑不起来（resolveArtifactInput
    // 不会凭空找出一个数据集），不该先弹执行计划打扰用户、等用户点了同意才报错。
    if (!params.dataPath && !params.datasetId) {
      throw new Error("Econometrics requires dataPath or datasetId/stageId")
    }

    const pythonStatus = await ensureRuntimePythonReady()
    if (!pythonStatus.ok || pythonStatus.missing.length) {
      throw new Error(formatRuntimePythonSetupError("econometrics", pythonStatus))
    }
    const pythonCommand = pythonStatus.executable
    const installCommand = pythonStatus.installCommand

    if (ctx.agent === "analyst" && params.methodName !== "auto_recommend") {
      const analystState = AnalysisIntent.getAnalyst(ctx.sessionID)
      if (!analystState.planApproved) {
        const plannedRun = await ensureAnalysisPlan({
          sessionID: ctx.sessionID,
          datasetId: params.datasetId,
          runId: params.runId,
          branch: params.branch ?? "main",
        })
        const locale = plannedRun.workflowLocale
        const approvalOptions = workflowChecklistOptions(locale, "empirical")
        AnalysisIntent.markAnalystPlanGenerated(ctx.sessionID)
        const answers = await Question.ask({
          sessionID: ctx.sessionID,
          questions: [
            {
              header: workflowAnalysisPlanHeader(locale),
              question: [
                workflowChecklistIntro(locale, "empirical"),
                ...formatAnalysisChecklist(plannedRun),
                "",
                workflowChecklistApprovalPrompt(locale, "empirical"),
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
    await ctx.ask({
      permission: "bash",
      patterns: [`${pythonCommand} *econometrics*`],
      always: [`${pythonCommand} *econometrics*`],
      metadata: {
        description: `Run econometric method: ${params.methodName}`,
      },
    })
    fs.mkdirSync(outputDir, { recursive: true })
    let diagnosticOutputPublished = false
    using _diagnosticOutputCleanup = {
      [Symbol.dispose]() {
        if (PROPENSITY_SCORE_TRANSACTIONAL_METHODS.has(params.methodName) && !diagnosticOutputPublished) {
          cleanupFailedPropensityScoreRun(outputDir)
        }
      },
    }

    if (params.methodName === "auto_recommend") {
      return runAutoRecommendMethod({
        params,
        dataPath,
        outputDir,
        pythonCommand,
        ctx,
        datasetManifest,
        runId,
        sourceStage,
        branch,
      })
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

    const pythonScript = buildLegacyEconometricsPythonScript(payloadB64)

    log.info("run econometrics", {
      method: params.methodName,
      dataPath,
      outputDir,
    })

    const execution = await runInlinePython({
      command: pythonCommand,
      script: pythonScript,
      cwd: Instance.directory,
      abort: ctx.abort,
    })
    const { code, stdout, stderr } = execution

    if (code !== 0) {
      if (PROPENSITY_SCORE_TRANSACTIONAL_METHODS.has(params.methodName)) cleanupFailedPropensityScoreRun(outputDir)
      log.error("python failed", { code, stderr: summarizeToolError(stderr) })
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
          `\nStdout log: ${relativeWithinProject(failureArtifacts.stdoutPath)}` +
          `\nStderr log: ${relativeWithinProject(failureArtifacts.stderrPath)}` +
          `\nContext: ${relativeWithinProject(failureArtifacts.contextPath)}`,
      )
    }

    let result: PythonResult
    try {
      result = parsePythonResult<PythonResult>(stdout)
    } catch (error) {
      if (PROPENSITY_SCORE_TRANSACTIONAL_METHODS.has(params.methodName)) cleanupFailedPropensityScoreRun(outputDir)
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
      if (PROPENSITY_SCORE_TRANSACTIONAL_METHODS.has(params.methodName)) cleanupFailedPropensityScoreRun(outputDir)
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
      message += `\nReflection log: ${relativeWithinProject(reflectionPath)}`
      throw new Error(message)
    }

    if (params.methodName === "psm_construction") {
      try {
        validatePropensityScoreConstructionResult(result, outputDir)
      } catch (error) {
        cleanupFailedPropensityScoreRun(outputDir)
        throw error
      }
    }
    if (params.methodName === "psm_visualize") {
      try {
        validatePropensityScoreVisualizationResult(result, outputDir)
      } catch (error) {
        cleanupFailedPropensityScoreRun(outputDir)
        throw error
      }
    }
    if (params.methodName === "psm_matching") {
      try {
        validatePropensityScoreMatchingResult(result)
      } catch (error) {
        cleanupFailedPropensityScoreRun(outputDir)
        throw error
      }
    }
    if (params.methodName === "psm_ipw") {
      try {
        validatePropensityScoreIpwResult(result)
      } catch (error) {
        cleanupFailedPropensityScoreRun(outputDir)
        throw error
      }
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
      if (PROPENSITY_SCORE_TRANSACTIONAL_METHODS.has(params.methodName)) cleanupFailedPropensityScoreRun(outputDir)
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
    const deliveryBundlePath: string | undefined = undefined

    let numericSnapshot: NumericSnapshotDocument | undefined
    if (result.output_path && !PROPENSITY_SCORE_NO_INFERENCE_METHODS.has(params.methodName)) {
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
          // 实验日志要靠它复原"这一次到底是怎么设定的"
          spec: {
            dependentVar: params.dependentVar,
            treatmentVar: params.treatmentVar,
            covariates: params.covariates,
            entityVar: params.entityVar,
            timeVar: params.timeVar,
            clusterVar: params.clusterVar,
          },
        },
      })

      // 每跑完一次回归就把实验日志刷新一遍。做成自动而非"等模型想起来调工具"，
      // 是因为留痕的价值恰恰在于它不依赖任何人记得——包括模型。
      const logPath = refreshExperimentLog(datasetManifest.datasetId)
      if (logPath) result.experiment_log_path = logPath
    }

    if (result.output_path) {
      fs.writeFileSync(result.output_path, JSON.stringify(result, null, 2), "utf-8")
    }

    const isPropensityScoreDiagnostic = PROPENSITY_SCORE_DIAGNOSTIC_METHODS.has(params.methodName)
    const isPropensityScoreVisualization = params.methodName === "psm_visualize"
    const isPropensityScoreMatching = params.methodName === "psm_matching"
    const isPropensityScoreIpw = params.methodName === "psm_ipw"
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
    if (result.delivery_report_docx_path) output += `- Result report Word: ${relativeWithinProject(result.delivery_report_docx_path)}\n`
    output += `- Concise result summary: ${relativeWithinProject(conciseResultPath)}\n`
    if (result.output_path) output += `- Result JSON: ${relativeWithinProject(result.output_path)}\n`
    if (result.resolved_python_executable) output += `- Python interpreter: ${result.resolved_python_executable}\n`
    if (deliveryBundlePath && publishedFiles.length) output += `Delivery bundle: ${relativeWithinProject(deliveryBundlePath)}\n`
    if (publishedFiles.length) {
      output += `Published files:\n`
      for (const item of publishedFiles) output += `- ${item.relativePath}\n`
    }
    output += `\nResults directory: ${relativeWithinProject(outputDir)}/\n`
    if (params.methodName === "psm_construction") output = buildPropensityScoreDiagnosticOutput(result)
    if (isPropensityScoreVisualization) output = buildPropensityScoreVisualizationOutput(result)
    if (isPropensityScoreMatching) output = buildPropensityScoreMatchingOutput(result)
    if (isPropensityScoreIpw) output = buildPropensityScoreIpwOutput(result)

    const metadata: EconometricsToolMetadata = {
      method: params.methodName,
      result,
      principleChecks,
      datasetId: datasetManifest?.datasetId ?? result.dataset_id ?? params.datasetId,
      stageId: params.stageId ?? sourceStage?.stageId ?? result.stage_id,
      runId: effectiveRunId,
      numericSnapshotPath: result.numeric_snapshot_path ? relativeWithinProject(result.numeric_snapshot_path) : undefined,
      numericSnapshotPreview: numericSnapshotPreview(numericSnapshot),
      groundingScope: isPropensityScoreDiagnostic ? "diagnostic" : isPropensityScoreMatching ? "matching" : isPropensityScoreIpw ? "weighting" : "regression",
      qaGateStatus: qaGate.qaGateStatus,
      qaGateReason: qaGate.qaGateReason,
      qaSource: qaGate.qaSource,
      outputDir: relativeWithinProject(outputDir),
      deliveryBundleDir: deliveryBundlePath ? relativeWithinProject(deliveryBundlePath) : undefined,
      publishedFiles,
      presentation: isPropensityScoreDiagnostic || isPropensityScoreMatching || isPropensityScoreIpw
        ? undefined
        : buildEconometricsPresentation({
            params,
            result,
            qaGate,
            principleChecks,
            conciseResultPath,
            deliveryBundlePath,
            publishedFiles,
          }),
      ...buildEstimationResultViews({
        params,
        result,
        datasetManifest,
        sourceStage,
        qaGate,
        principleChecks,
        publishedFiles,
        isPropensityScoreDiagnostic,
        isPropensityScoreVisualization,
        isPropensityScoreMatching,
        isPropensityScoreIpw,
      }),
    }

    diagnosticOutputPublished = true
    return {
      title: `Econometrics: ${params.methodName}`,
      output,
      metadata,
    }
  },
}))
