import fs from "fs"
import path from "path"
import { createHash } from "node:crypto"
import DESCRIPTION from "./heterogeneity-runner.txt"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import { Instance } from "../project/instance"
import { createEconometricsNumericSnapshot } from "./analysis-grounding"
import { loadResultBundle, generatedArtifactRoot } from "./analysis-artifacts"
import {
  finalOutputsPath,
  inferBranch,
  inferRunId,
  publishVisibleOutput,
  projectInternalRoot,
  projectStateRoot,
  resolveArtifactInput,
} from "./analysis-state"
import { relativeWithinProject, resolveDatasetStagePath, resolveManagedProjectPath, resolveToolPath } from "./analysis-path"
import { createToolDisplay } from "./analysis-display"
import { analysisArtifact, analysisMetric, createToolAnalysisView } from "./analysis-user-view"
import { runEngineMethodBackend } from "@/runtime/services/econometrics-engine-backend"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { pythonCapabilityInput } from "./python-capability-schema"
import { activeOrLatestStage, canonicalDataStageForWorkflow, getActiveWorkflowRun } from "@/runtime/workflow/state"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import type { AnalysisToolRunRecord, RuntimeTaskRecord } from "@/runtime/types"

export type HeterogeneityRunnerInput = Record<string, any>
export const HeterogeneityRunnerInputSchema = pythonCapabilityInput<HeterogeneityRunnerInput>()

type HeterogeneitySpecResult = {
  spec_id: string
  spec_type: "heterogeneity" | "mechanism" | "placebo" | "alternative_spec"
  status: "success" | "failed" | "skipped"
  result_dir?: string
  result_path?: string
  diagnostics_path?: string
  metadata_path?: string
  coefficients_path?: string
  narrative_path?: string
  changed_specification: string
  grounded_numbers?: { coefficient?: number; std_error?: number; p_value?: number; r_squared?: number; rows_used?: number }
  key_effect_direction?: "positive" | "negative" | "zeroish"
  key_effect_significance?: "p<0.01" | "p<0.05" | "p<0.1" | "not_significant" | "unavailable"
  diagnostic_flags: string[]
  primary_term?: string
  raw_primary_term?: string
  title?: string
  warning?: string
  error?: string
}

type PythonRunnerResult = {
  success: boolean
  output_dir: string
  warnings?: string[]
  specs: HeterogeneitySpecResult[]
}

const SAFE_SPEC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const SPEC_ARTIFACTS = {
  result_path: "results.json",
  diagnostics_path: "diagnostics.json",
  metadata_path: "model_metadata.json",
  coefficients_path: "coefficient_table.csv",
  narrative_path: "narrative.md",
} as const

async function sha256File(filePath: string) {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.once("error", reject)
    stream.once("end", resolve)
  })
  return `sha256:${hash.digest("hex")}`
}

function sha256Value(value: unknown) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Tool.InputValidationError("异质性参数无法规范化，未生成生命周期记录。")
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`
}

function isWithinDirectory(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function rejectOutputSymlinkComponents(outputRoot: string, target: string) {
  const absoluteTarget = path.resolve(target)
  if (!isWithinDirectory(outputRoot, absoluteTarget)) {
    throw new Tool.InputValidationError("Python 异质性规格路径超出 Harness 输出目录。")
  }
  let current = outputRoot
  for (const segment of path.relative(outputRoot, absoluteTarget).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Tool.InputValidationError("Python 异质性规格路径不能包含符号链接。")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break
      throw error
    }
  }
}

function writeHeterogeneityOutputFile(outputRoot: string, target: string, content: string) {
  const absoluteTarget = path.resolve(target)
  rejectOutputSymlinkComponents(outputRoot, absoluteTarget)
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0)
  let descriptor: number
  try {
    descriptor = fs.openSync(absoluteTarget, flags, 0o600)
  } catch (error) {
    if (fs.existsSync(absoluteTarget) && fs.lstatSync(absoluteTarget).isSymbolicLink()) {
      throw new Tool.InputValidationError("异质性产物路径不能是符号链接。", { cause: error })
    }
    throw error
  }
  try {
    fs.writeFileSync(descriptor, content, "utf-8")
  } finally {
    fs.closeSync(descriptor)
  }
}

function requireHeterogeneityPath(actual: unknown, expected: string, outputRoot: string, label: string) {
  if (typeof actual !== "string" || !actual.trim()) {
    throw new Tool.InputValidationError(`Python 异质性结果缺少${label}路径。`)
  }
  if (path.resolve(actual) !== path.resolve(expected)) {
    throw new Tool.InputValidationError(`Python 异质性${label}路径与 Harness 预定规格产物不一致。`)
  }
  rejectOutputSymlinkComponents(outputRoot, expected)
  let canonicalActual: string
  let canonicalExpected: string
  try {
    canonicalActual = fs.realpathSync(actual)
    canonicalExpected = fs.realpathSync(expected)
  } catch {
    throw new Tool.InputValidationError(`Python 异质性${label}文件不存在或不可读取。`)
  }
  if (!isWithinDirectory(outputRoot, canonicalActual) || canonicalActual !== canonicalExpected) {
    throw new Tool.InputValidationError(`Python 异质性${label}路径与 Harness 预定规格产物不一致。`)
  }
  return canonicalActual
}

export function validateHeterogeneityRunnerOutputPaths(
  result: PythonRunnerResult,
  expectedOutputDir: string,
  expectedCanonicalOutputDir?: string,
): PythonRunnerResult {
  const validSpecTypes = new Set(["heterogeneity", "mechanism", "placebo", "alternative_spec"])
  const validStatuses = new Set(["success", "failed", "skipped"])
  if (result.success !== true || !Array.isArray(result.specs) ||
      result.warnings !== undefined && (!Array.isArray(result.warnings) || result.warnings.some((warning) => typeof warning !== "string"))) {
    throw new Tool.InputValidationError("Python 异质性结果没有通过批次输出契约校验。")
  }
  let outputRoot: string
  let returnedOutputRoot: string
  try {
    outputRoot = fs.realpathSync(expectedOutputDir)
    returnedOutputRoot = fs.realpathSync(result.output_dir)
  } catch {
    throw new Tool.InputValidationError("Python 异质性输出目录不存在或不可读取。")
  }
  if (returnedOutputRoot !== outputRoot || (expectedCanonicalOutputDir && outputRoot !== expectedCanonicalOutputDir)) {
    throw new Tool.InputValidationError("Python 异质性输出目录与 Harness 预定目录不一致。")
  }
  const seen = new Set<string>()
  const specs = result.specs.map((spec) => {
    if (typeof spec.spec_id !== "string" || !SAFE_SPEC_ID.test(spec.spec_id) || seen.has(spec.spec_id)) {
      throw new Tool.InputValidationError("Python 异质性规格标识无效或重复。")
    }
    if (!validSpecTypes.has(spec.spec_type)) throw new Tool.InputValidationError("Python 异质性规格类型无效。")
    if (!validStatuses.has(spec.status)) throw new Tool.InputValidationError("Python 异质性规格状态无效。")
    if (typeof spec.changed_specification !== "string" || !Array.isArray(spec.diagnostic_flags) ||
        spec.diagnostic_flags.some((flag) => typeof flag !== "string")) {
      throw new Tool.InputValidationError("Python 异质性规格的变更说明或诊断结果字段无效。")
    }
    seen.add(spec.spec_id)
    const expectedDir = path.join(outputRoot, "specs", spec.spec_id)
    if (spec.status !== "success") {
      if (spec.result_dir || spec.result_path || spec.diagnostics_path || spec.metadata_path || spec.coefficients_path || spec.narrative_path) {
        throw new Tool.InputValidationError("未成功的异质性规格不能声明可读取的结果路径。")
      }
      return spec
    }
    const resultDir = requireHeterogeneityPath(spec.result_dir, expectedDir, outputRoot, "规格目录")
    const normalized: HeterogeneitySpecResult = { ...spec, result_dir: resultDir }
    for (const [field, filename] of Object.entries(SPEC_ARTIFACTS) as Array<[keyof typeof SPEC_ARTIFACTS, string]>) {
      const actual = spec[field]
      const expected = path.join(expectedDir, filename)
      const canonical = requireHeterogeneityPath(actual, expected, outputRoot, filename)
      if (!fs.statSync(canonical).isFile()) throw new Tool.InputValidationError(`Python 异质性产物不是普通文件：${filename}。`)
      normalized[field] = canonical
    }
    return normalized
  })
  return { ...result, output_dir: outputRoot, specs }
}

function significanceLabel(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return "unavailable" as const
  if (value < 0.01) return "p<0.01" as const
  if (value < 0.05) return "p<0.05" as const
  if (value < 0.1) return "p<0.1" as const
  return "not_significant" as const
}

function effectDirection(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return undefined
  if (Math.abs(value) < 1e-10) return "zeroish" as const
  return value > 0 ? "positive" as const : "negative" as const
}

function assertBaselineHealthy(bundle: ReturnType<typeof loadResultBundle>) {
  const blocking = Array.isArray(bundle.results.blocking_errors) ? bundle.results.blocking_errors : []
  if (bundle.results.qa_status === "fail" || blocking.length > 0) {
    throw new Error(`基准结果存在阻断性数据质量问题：${blocking.join("；") || "质量检查未通过"}`)
  }
  const gates = [
    ...(Array.isArray(bundle.diagnostics?.post_estimation_gates) ? bundle.diagnostics.post_estimation_gates : []),
    ...(Array.isArray(bundle.results.post_estimation_gates) ? bundle.results.post_estimation_gates : []),
  ]
  if (gates.some((gate: any) => gate?.passed === false && gate?.severity === "blocking")) {
    throw new Error("基准结果未通过估计后门禁；不能在不可信基准上生成扩展结果。")
  }
}

type HeterogeneityBaselineSpecification = {
  methodID: string
  arguments: Record<string, unknown>
}

type HeterogeneityRunnerSpecification = {
  entityVar?: string
  timeVar?: string
  clusterVar?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
}

function dataDiagnosisFingerprint(stage: unknown, stageId: string) {
  if (!isRecord(stage) || stage.stageId !== stageId || !isRecord(stage.metadata)) return undefined
  const diagnosis = stage.metadata.dataDiagnosis
  if (!isRecord(diagnosis) || diagnosis.stage_id !== stageId) return undefined
  return typeof diagnosis.data_fingerprint === "string" && /^sha256:[0-9a-f]{64}$/.test(diagnosis.data_fingerprint)
    ? diagnosis.data_fingerprint
    : undefined
}

function sortedEqual(left: string[], right: string[]) {
  return [...left].sort().join("\0") === [...right].sort().join("\0")
}

function validateBaselineSpecification(input: {
  output: { key: string; metadata?: Record<string, unknown> }
  methodFamily: "fe" | "did"
  dependentVar: string
  treatmentVar: string
  entityVar?: string
  timeVar?: string
  clusterVar?: string
  covariates: string[]
}):
  | { ok: true; methodSpecification: HeterogeneityBaselineSpecification; runnerSpecification: HeterogeneityRunnerSpecification }
  | { ok: false; message: string } {
  const methodKey = input.output.key.slice(0, -"_result".length)
  const rawSpecification = input.output.metadata?.methodSpecification
  if (!isRecord(rawSpecification) || typeof rawSpecification.methodID !== "string" || !isRecord(rawSpecification.arguments)) {
    return {
      ok: false,
      message: "当前基准结果缺少 Harness 保存的原始方法规格，无法核对变量、固定效应和聚类设置。尚未运行异质性扩展；请先通过当前 Harness 重新执行并保存基准规格。",
    }
  }
  const methodSpecification = { methodID: rawSpecification.methodID, arguments: rawSpecification.arguments }
  if (methodSpecification.methodID !== methodKey) {
    return { ok: false, message: "基准结果记录中的方法规格与结果输出键不一致，无法确认应扩展的估计量。尚未运行异质性扩展。" }
  }

  const methodNames: Record<string, string> = {
    panel_fe_regression: "面板固定效应",
    hdfe_regression: "高维固定效应",
    did_static: "传统双重差分",
    did2s: "DID2S 两阶段估计",
    did_event_study_saturated: "饱和事件研究",
  }
  const methodName = methodNames[methodSpecification.methodID] ?? methodSpecification.methodID
  if (input.methodFamily !== "fe" || !["panel_fe_regression", "hdfe_regression"].includes(methodSpecification.methodID)) {
    return {
      ok: false,
      message: `选中的基准是“${methodName}”，但当前异质性执行器实际使用 OLS + 虚拟变量固定效应；这与该基准的估计量不一致，不能静默替换成 LSDV。尚未运行任何扩展规格。请保留当前基准，或先确认是否需要实现与该方法一致的扩展。`,
    }
  }

  const args = methodSpecification.arguments
  const mismatches: string[] = []
  if (args.dependentVar !== input.dependentVar) mismatches.push(`因变量（基准=${String(args.dependentVar)}，本次=${input.dependentVar}）`)
  if (args.treatmentVar !== input.treatmentVar) mismatches.push(`核心解释变量（基准=${String(args.treatmentVar)}，本次=${input.treatmentVar}）`)
  const baselineCovariates = stringList(args.covariates)
  if (!baselineCovariates || !sortedEqual(baselineCovariates, input.covariates)) {
    mismatches.push(`控制变量（基准=${JSON.stringify(baselineCovariates ?? "无法核验")}，本次=${JSON.stringify(input.covariates)}）`)
  }

  let entityVar: string | undefined
  let timeVar: string | undefined
  let clusterVar: string | undefined
  let covarianceSupported = false
  if (methodSpecification.methodID === "panel_fe_regression") {
    entityVar = typeof args.entityVar === "string" ? args.entityVar : undefined
    timeVar = typeof args.timeVar === "string" ? args.timeVar : undefined
    const covariance = args.covariance ?? "robust"
    if (covariance === "robust") covarianceSupported = true
    if (covariance === "clustered" && (typeof args.clusterVar === "string" || entityVar)) {
      covarianceSupported = true
      // panel_fe/runner.py defaults clusterVar to entityVar when clustered covariance is selected.
      clusterVar = typeof args.clusterVar === "string" ? args.clusterVar : entityVar
    }
  } else {
    const fixedEffects = stringList(args.fixedEffects)
    const clusterVars = args.clusterVars === undefined ? [] : stringList(args.clusterVars)
    const covariance = args.covariance ?? "HC1"
    if (fixedEffects && fixedEffects.length === 2 && typeof input.entityVar === "string" && typeof input.timeVar === "string" && sortedEqual(fixedEffects, [input.entityVar, input.timeVar])) {
      entityVar = input.entityVar
      timeVar = input.timeVar
    } else {
      mismatches.push(`实体/时间固定效应（基准=${JSON.stringify(fixedEffects ?? "无法核验")}，本次=${JSON.stringify([input.entityVar, input.timeVar])}）`)
    }
    if (clusterVars && covariance === "HC1" && clusterVars.length === 0) covarianceSupported = true
    if (clusterVars && covariance === "CRV1" && clusterVars.length === 1) {
      covarianceSupported = true
      clusterVar = clusterVars[0]
    }
  }

  if (!entityVar || input.entityVar && input.entityVar !== entityVar) mismatches.push(`实体固定效应（基准=${entityVar ?? "无法核验"}，本次=${input.entityVar ?? "未提供"}）`)
  if (!timeVar || input.timeVar && input.timeVar !== timeVar) mismatches.push(`时间固定效应（基准=${timeVar ?? "无法核验"}，本次=${input.timeVar ?? "未提供"}）`)
  if (!covarianceSupported) mismatches.push("协方差/聚类口径")
  if (input.clusterVar && input.clusterVar !== clusterVar) mismatches.push(`聚类变量（基准=${clusterVar ?? "未使用聚类"}，本次=${input.clusterVar}）`)
  if (mismatches.length > 0) {
    return {
      ok: false,
      message: `异质性参数与“${methodName}”基准规格不一致或无法一一映射：${[...new Set(mismatches)].join("、")}。尚未运行扩展；请恢复基准中的原变量、固定效应和可支持的聚类口径，或先向用户确认是否要改变研究规格。`,
    }
  }
  return { ok: true, methodSpecification, runnerSpecification: { entityVar, timeVar, clusterVar } }
}

function trustedBaselineBundle(input: {
  datasetId: string
  stageId: string
  methodFamily: "fe" | "did"
  baselineOutputKey?: string
  dependentVar: string
  treatmentVar: string
  entityVar?: string
  timeVar?: string
  clusterVar?: string
  covariates: string[]
}) {
  const artifactInput = resolveArtifactInput({ datasetId: input.datasetId, stageId: input.stageId })
  if (!artifactInput.manifest || !artifactInput.stage) {
    throw new Tool.InputValidationError("当前数据阶段不可用；请重新完成数据检查后再运行异质性分析。")
  }
  const supportedMethodIDs = input.methodFamily === "fe"
    ? new Set(["panel_fe_regression", "hdfe_regression"])
    : new Set(["did_static", "did2s", "did_event_study_saturated"])
  const candidates = artifactInput.manifest.finalOutputs.filter((output) => {
    if (
      output.stageId !== artifactInput.stage!.stageId ||
      !output.key.endsWith("_result")
    ) return false
    // finalOutputs.branch 是交付物目录的命名空间（如 econometrics/panel_fe_regression），
    // 而 stage.branch 是规范化数据分支（通常为 main）；数据血缘应由同一 manifest + stageId 绑定。
    return supportedMethodIDs.has(output.key.slice(0, -"_result".length))
  })
  const duplicateKeyCounts = new Map<string, number>()
  for (const output of candidates) duplicateKeyCounts.set(output.key, (duplicateKeyCounts.get(output.key) ?? 0) + 1)
  const choices = candidates.map((output, index) => ({
    output,
    selector: (duplicateKeyCounts.get(output.key) ?? 0) > 1
      ? `${output.key}@${output.runId ?? output.createdAt}#${index + 1}`
      : output.key,
  }))
  const requestedKey = input.baselineOutputKey?.trim()
  const selectedChoice = requestedKey
    ? choices.find((choice) => choice.selector === requestedKey)
    : choices.length === 1 ? choices[0] : undefined
  if (!selectedChoice) {
    const available = choices.map((choice) => choice.selector)
    const reason = available.length === 0
      ? "当前数据阶段没有已发布的可用 FE/DID 基准结果。"
      : requestedKey
        ? `输出键“${requestedKey}”不是当前数据阶段中唯一有效的基准结果标识。`
        : "当前数据阶段有多个基准结果，不能替你选择分析对象。"
    const guidance = available.length
      ? `可选基准输出键：${available.join("、")}。请询问用户要基于哪一个结果继续。`
      : "请先完成并核验一个 FE/DID 基准估计，再决定是否运行扩展分析。"
    return {
      requiresUserDecision: true as const,
      decisionKind: "baseline_selection" as const,
      message: `${reason} ${guidance}`,
      availableOutputKeys: available,
    }
  }

  const selected = selectedChoice.output
  if (selected.stageId !== artifactInput.stage.stageId) {
    throw new Tool.InputValidationError("选中的基准结果与当前规范化数据阶段不一致。")
  }
  const specification = validateBaselineSpecification({
    output: selected,
    methodFamily: input.methodFamily,
    dependentVar: input.dependentVar,
    treatmentVar: input.treatmentVar,
    entityVar: input.entityVar,
    timeVar: input.timeVar,
    clusterVar: input.clusterVar,
    covariates: input.covariates,
  })
  if (!specification.ok) {
    return {
      requiresUserDecision: true as const,
      decisionKind: "baseline_compatibility" as const,
      message: specification.message,
      availableOutputKeys: [selectedChoice.selector],
    }
  }
  let resultPath: string
  try {
    const stateRoot = resolveManagedProjectPath({ filePath: projectStateRoot(), managedRoot: projectInternalRoot() })
    resultPath = resolveManagedProjectPath({ filePath: selected.path, managedRoot: stateRoot })
  } catch (error) {
    if (!(error instanceof Tool.InputValidationError)) throw error
    const detail = error instanceof Error ? error.message : "路径无法核验"
    throw new Tool.InputValidationError(`基准结果不在 KillStata 受管产物目录中，已拒绝读取。${detail}`, { cause: error })
  }

  const loaded = loadResultBundle({ directResultPath: resultPath })
  if (loaded.stageId && loaded.stageId !== artifactInput.stage.stageId) {
    throw new Tool.InputValidationError("基准结果文件中的 stageId 与受管产物记录不一致。")
  }
  if (loaded.branch && loaded.branch !== selected.branch) {
    throw new Tool.InputValidationError("基准结果文件中的分支与受管产物记录不一致。")
  }
  const bundle = {
    ...loaded,
    manifest: artifactInput.manifest,
    datasetId: input.datasetId,
    stageId: artifactInput.stage.stageId,
    runId: selected.runId,
    branch: selected.branch,
  }
  if (bundle.stageId !== artifactInput.stage.stageId) {
    throw new Tool.InputValidationError("基准结果文件中的 stageId 与受管产物记录不一致。")
  }
  const resultMethod = bundle.results.method ?? bundle.results.method_id
  if (typeof resultMethod === "string" && resultMethod !== selected.key.slice(0, -"_result".length)) {
    throw new Tool.InputValidationError("基准结果文件中的方法 ID 与受管产物输出键不一致。")
  }
  return {
    requiresUserDecision: false as const,
    bundle,
    manifest: artifactInput.manifest,
    stage: artifactInput.stage,
    methodSpecification: specification.methodSpecification,
    runnerSpecification: specification.runnerSpecification,
  }
}

function resolveAnalysisDataPath(input: { datasetId?: string; stageId?: string; baselineBundle: ReturnType<typeof loadResultBundle> }) {
  const datasetId = input.datasetId ?? input.baselineBundle.datasetId
  if (datasetId) {
    const artifact = resolveArtifactInput({ datasetId, stageId: input.stageId ?? input.baselineBundle.stageId })
    if (artifact.resolvedInputPath) return artifact.resolvedInputPath
  }
  if (input.baselineBundle.sourcePath && fs.existsSync(input.baselineBundle.sourcePath)) return input.baselineBundle.sourcePath
  throw new Error("无法定位规范化分析数据；请提供有效的数据集、阶段或基准结果引用。")
}

function relativeSpec(spec: HeterogeneitySpecResult) {
  return {
    ...spec,
    result_dir: spec.result_dir ? relativeWithinProject(spec.result_dir) : undefined,
    result_path: spec.result_path ? relativeWithinProject(spec.result_path) : undefined,
    diagnostics_path: spec.diagnostics_path ? relativeWithinProject(spec.diagnostics_path) : undefined,
    metadata_path: spec.metadata_path ? relativeWithinProject(spec.metadata_path) : undefined,
    coefficients_path: spec.coefficients_path ? relativeWithinProject(spec.coefficients_path) : undefined,
    narrative_path: spec.narrative_path ? relativeWithinProject(spec.narrative_path) : undefined,
  }
}

function renderNarrative(title: string, specs: HeterogeneitySpecResult[]) {
  const lines = [`# ${title}`, ""]
  if (specs.length === 0) return `${lines.join("\n")}暂无符合条件的扩展规格。\n`
  for (const spec of specs) {
    lines.push(`## ${spec.title ?? spec.spec_id}`)
    lines.push(`- 状态：${spec.status === "success" ? "完成" : spec.status === "skipped" ? "跳过" : "失败"}`)
    lines.push(`- 变化：${spec.changed_specification}`)
    if (spec.grounded_numbers) {
      lines.push(`- 核心结果：系数=${spec.grounded_numbers.coefficient ?? "不可用"}，p值=${spec.grounded_numbers.p_value ?? "不可用"}，有效样本=${spec.grounded_numbers.rows_used ?? "不可用"}`)
    }
    if (spec.warning) lines.push(`- 提示：${spec.warning}`)
    if (spec.error) lines.push(`- 错误：${spec.error}`)
    lines.push("")
  }
  return lines.join("\n")
}

export const HeterogeneityRunnerTool = Tool.define<typeof HeterogeneityRunnerInputSchema, Record<string, any>>("heterogeneity_runner", Tool.Execution.managedFilesystem, ToolModel.forTool("heterogeneity_runner"), {
  description: DESCRIPTION,
  parameters: HeterogeneityRunnerInputSchema,
  async execute(params, ctx) {
    const extra = ctx.extra as Record<string, unknown> | undefined
    const modelInvocation = Boolean(extra?.model)
    const sourceUserMessageId = typeof extra?.sourceUserMessageId === "string" ? extra.sourceUserMessageId : undefined
    const ledger = RuntimeTaskLedger.listTasks(ctx.sessionID)
    const analysisTask: RuntimeTaskRecord | undefined = sourceUserMessageId
      ? ledger.tasks.find((item) =>
          item.taskId === ledger.activeTaskId &&
          item.messageID === sourceUserMessageId &&
          item.analysisRequest?.sourceMessageId === sourceUserMessageId,
        )
      : undefined
    if (modelInvocation) {
      const requestKind = analysisTask?.analysisRequest?.kind
      const qualityInspectionOnly = extra?.qualityInspectionOnly === true
      const recommendationOnly = extra?.recommendationOnly === true
      const authorizedMethods = [
        ...(Array.isArray(analysisTask?.metadata?.requiredToolIDs)
          ? analysisTask.metadata.requiredToolIDs.filter((id): id is string => typeof id === "string")
          : []),
        ...(Array.isArray(analysisTask?.metadata?.confirmedToolIDs)
          ? analysisTask.metadata.confirmedToolIDs.filter((id): id is string => typeof id === "string")
          : []),
      ]
      if (requestKind !== "estimate" || !authorizedMethods.includes("heterogeneity_runner") || qualityInspectionOnly || recommendationOnly) {
        const scopeReason = qualityInspectionOnly
          ? "本轮明确只做数据质量检查"
          : recommendationOnly
            ? "本轮只请求方法推荐"
            : requestKind === "estimate" && !authorizedMethods.includes("heterogeneity_runner")
              ? "当前用户请求没有明确选择或确认异质性扩展"
            : undefined
        return {
          title: "当前请求不允许运行异质性",
          output: [
            "异质性分析会运行多个独立扩展规格。",
            scopeReason ?? (requestKind
              ? `当前请求登记为“${requestKind}”，不是估计请求。`
              : "当前模型调用没有绑定有效的估计请求。"),
            "本次没有启动 Python，也没有运行任何估计。",
            "如需执行，请由用户明确发起估计请求，并确认要运行的完整扩展规格集合。",
          ].join("\n"),
          metadata: {
            requiresUserDecision: true,
            estimateExecuted: false,
            requestKind,
            ...(qualityInspectionOnly ? { qualityInspectionOnly: true } : {}),
            ...(recommendationOnly ? { recommendationOnly: true } : {}),
          },
        }
      }
    }
    if (!params.datasetId || !params.stageId) {
      throw new Tool.InputValidationError("异质性分析必须关联当前 Harness 数据集和阶段，不能通过基准文件路径直接执行。")
    }
    if (modelInvocation && (params.baselineResultDir || params.directResultPath)) {
      throw new Tool.InputValidationError("模型不能指定基准结果文件路径；请使用当前阶段已发布的基准结果输出键。")
    }
    const workflow = getActiveWorkflowRun(ctx.sessionID)
    const currentData = workflow ? canonicalDataStageForWorkflow(workflow, activeOrLatestStage(workflow)) : null
    if (!currentData || currentData.datasetId !== params.datasetId || currentData.stageId !== params.stageId) {
      throw new Tool.InputValidationError("异质性分析引用与当前会话的规范化数据阶段不一致；请使用当前阶段重新选择基准结果。")
    }
    const trustedBaseline = trustedBaselineBundle({
      datasetId: params.datasetId,
      stageId: params.stageId,
      methodFamily: params.methodFamily,
      baselineOutputKey: params.baselineOutputKey,
      dependentVar: params.dependentVar,
      treatmentVar: params.treatmentVar,
      entityVar: params.entityVar,
      timeVar: params.timeVar,
      clusterVar: params.clusterVar,
      covariates: params.covariates ?? [],
    })
    if (trustedBaseline.requiresUserDecision) {
      return {
        title: trustedBaseline.decisionKind === "baseline_selection" ? "需要选择基准结果" : "基准规格需要确认",
        output: trustedBaseline.message,
        metadata: {
          requiresUserDecision: true,
          decisionKind: trustedBaseline.decisionKind,
          baselineOutputChoices: trustedBaseline.availableOutputKeys,
          datasetId: params.datasetId,
          stageId: params.stageId,
        },
      }
    }
    const selectedBaseline = trustedBaseline
    const baselineBundle = selectedBaseline.bundle
    assertBaselineHealthy(baselineBundle)
    const manifest = selectedBaseline.manifest
    const stage = selectedBaseline.stage
    const stageFingerprint = dataDiagnosisFingerprint(stage, params.stageId)
    if (!stageFingerprint) {
      throw new Tool.InputValidationError("当前数据阶段缺少有效的数据诊断指纹；尚未运行异质性扩展。请先重新检查当前数据阶段，再继续分析。")
    }
    if (modelInvocation && (
      analysisTask?.analysisRequest?.kind !== "estimate" ||
      analysisTask.analysisLifecycle?.requestId !== analysisTask.analysisRequest.requestId ||
      analysisTask.analysisLifecycle.datasetId !== params.datasetId ||
      analysisTask.analysisLifecycle.stageId !== params.stageId ||
      analysisTask.analysisLifecycle.stageFingerprint !== stageFingerprint
    )) {
      throw new Tool.InputValidationError("当前请求的诊断数据集、阶段或内容指纹与异质性分析输入不一致；尚未运行 Python。请先刷新当前阶段诊断或重新提交本次分析请求。")
    }
    const branch = inferBranch({ requestedBranch: params.branch, stage, source: "model" })
    const runId = inferRunId({ requestedRunId: params.runId ?? baselineBundle.runId, stage, source: "model" })
    const pythonCommand = await resolveRuntimePythonCommand()
    const resolvedDataPath = resolveAnalysisDataPath({ datasetId: params.datasetId, stageId: params.stageId, baselineBundle })
    const dataPath = manifest?.datasetId && stage?.stageId
      ? await resolveDatasetStagePath({
          datasetId: manifest.datasetId,
          filePath: resolvedDataPath,
          toolName: "heterogeneity_runner",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
      : await resolveToolPath({
          filePath: resolvedDataPath,
          mode: "read",
          toolName: "heterogeneity_runner",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
    const sourceFileFingerprint = await sha256File(dataPath)
    const inputFingerprint = sha256Value({
      params,
      baselineSpecification: selectedBaseline.runnerSpecification,
      stageFingerprint,
      sourceFileFingerprint,
    })
    const requiredToolIDs = [
      ...(Array.isArray(analysisTask?.metadata?.requiredToolIDs)
        ? analysisTask.metadata.requiredToolIDs.filter((id): id is string => typeof id === "string")
        : []),
      ...(Array.isArray(analysisTask?.metadata?.confirmedToolIDs)
        ? analysisTask.metadata.confirmedToolIDs.filter((id): id is string => typeof id === "string")
        : []),
    ]
    const shouldTrackAnalysisRun = modelInvocation &&
      analysisTask?.analysisRequest?.kind === "estimate" &&
      analysisTask.analysisLifecycle?.requestId === analysisTask.analysisRequest.requestId &&
      analysisTask.analysisRequest.sourceMessageId === sourceUserMessageId &&
      requiredToolIDs.includes("heterogeneity_runner")
    const operationId = typeof ctx.callID === "string" && ctx.callID.trim()
      ? ctx.callID
      : `heterogeneity_${runId}_${inputFingerprint.slice(-12)}`
    const analysisOperationIdentity = shouldTrackAnalysisRun ? {
      requestId: analysisTask!.analysisRequest!.requestId,
      operationId,
      toolID: "heterogeneity_runner",
      datasetId: params.datasetId,
      stageId: params.stageId,
      stageFingerprint,
      inputFingerprint,
      authorizationMessageId: analysisTask!.analysisRequest!.sourceMessageId,
    } : undefined
    const outputDir = await resolveToolPath({
      filePath: params.outputDir ?? generatedArtifactRoot({ module: "heterogeneity_runner", runId, branch }),
      mode: "write",
      toolName: "heterogeneity_runner",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      ask: ctx.ask,
    })
    let canonicalOutputDirBeforeRun: string | undefined

    const runnerResult = await runEngineMethodBackend({
      sessionID: ctx.sessionID,
      pythonCommand,
      cwd: Instance.directory,
      methodID: "heterogeneity_runner",
      payload: {
        dataPath,
        outputDir,
        methodFamily: params.methodFamily,
        dependentVar: params.dependentVar,
        treatmentVar: params.treatmentVar,
        entityVar: params.entityVar ?? (selectedBaseline
          ? selectedBaseline.runnerSpecification.entityVar
          : typeof baselineBundle.metadata?.entity_var === "string" ? baselineBundle.metadata.entity_var : undefined),
        timeVar: params.timeVar ?? (selectedBaseline
          ? selectedBaseline.runnerSpecification.timeVar
          : typeof baselineBundle.metadata?.time_var === "string" ? baselineBundle.metadata.time_var : undefined),
        clusterVar: params.clusterVar ?? (selectedBaseline
          ? selectedBaseline.runnerSpecification.clusterVar
          : typeof baselineBundle.metadata?.cluster_var === "string" ? baselineBundle.metadata.cluster_var : undefined),
        covariates: params.covariates,
        heterogeneityVars: params.heterogeneityVars,
        mechanismVars: params.mechanismVars,
        placebo: params.placebo ?? false,
        alternativeSpecifications: params.alternativeSpecifications,
      },
      runtime: {
        datasetId: manifest?.datasetId ?? baselineBundle.datasetId ?? params.datasetId,
        stageId: params.stageId ?? baselineBundle.stageId,
        runId,
        branch,
        outputDir,
        expectedDataFingerprint: stageFingerprint,
      },
      abort: ctx.abort,
      beforeExecute: () => {
        if (analysisOperationIdentity) {
          const begin = extra?.beginAnalysisToolRun
          if (typeof begin !== "function") {
            throw new Tool.InputValidationError("Harness 没有登记异质性运行状态；为避免未跟踪的估计，已停止执行。")
          }
          ;(begin as (operation: typeof analysisOperationIdentity) => void)(analysisOperationIdentity)
        }
        fs.mkdirSync(outputDir, { recursive: true })
        canonicalOutputDirBeforeRun = fs.realpathSync(outputDir)
      },
    }) as unknown as PythonRunnerResult
    const latestWorkflow = getActiveWorkflowRun(ctx.sessionID)
    const latestCurrentData = latestWorkflow
      ? canonicalDataStageForWorkflow(latestWorkflow, activeOrLatestStage(latestWorkflow))
      : null
    if (!latestCurrentData || latestCurrentData.datasetId !== params.datasetId || latestCurrentData.stageId !== params.stageId) {
      throw new Tool.InputValidationError("异质性执行期间当前会话的规范化数据阶段发生变化；拒绝发布旧阶段结果。")
    }
    if (!canonicalOutputDirBeforeRun) throw new Tool.InputValidationError("异质性计算未完成执行目录初始化；结果没有登记。")
    const result = validateHeterogeneityRunnerOutputPaths(runnerResult, outputDir, canonicalOutputDirBeforeRun)
    if (!result.success || !Array.isArray(result.specs)) throw new Error("异质性 Python 引擎没有返回完整规格结果。")
    const latestStagePath = manifest?.datasetId && stage?.stageId
      ? resolveArtifactInput({ datasetId: manifest.datasetId, stageId: stage.stageId }).resolvedInputPath
      : undefined
    const latestDataPath = manifest?.datasetId && stage?.stageId && latestStagePath
      ? await resolveDatasetStagePath({
          datasetId: manifest.datasetId,
          filePath: latestStagePath,
          toolName: "heterogeneity_runner",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
      : await resolveToolPath({
          filePath: resolvedDataPath,
          mode: "read",
          toolName: "heterogeneity_runner",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
    if (latestDataPath !== dataPath) {
      throw new Tool.InputValidationError("异质性执行期间当前数据阶段发生变化；拒绝将规格结果登记到旧血缘。")
    }
    if (await sha256File(latestDataPath) !== sourceFileFingerprint) {
      throw new Tool.InputValidationError("异质性执行期间当前数据内容发生变化；拒绝将结果登记到旧指纹。")
    }

    const finalizedSpecs: HeterogeneitySpecResult[] = []
    for (const spec of result.specs) {
      if (spec.status !== "success" || !spec.result_dir || !spec.result_path || !spec.coefficients_path || !spec.metadata_path) {
        finalizedSpecs.push(spec)
        continue
      }
      const resultPayload = JSON.parse(fs.readFileSync(spec.result_path, "utf-8")) as Record<string, any>
      const numericSnapshot = createEconometricsNumericSnapshot({
        outputDir: spec.result_dir,
        methodName: `heterogeneity_${spec.spec_type}`,
        result: { ...resultPayload, treatment_var: "primary_term" },
        coefficientsPath: spec.coefficients_path,
        diagnosticsPath: spec.diagnostics_path,
        metadataPath: spec.metadata_path,
        datasetId: manifest?.datasetId ?? baselineBundle.datasetId ?? params.datasetId,
        stageId: params.stageId ?? baselineBundle.stageId,
        runId,
      })
      resultPayload.numeric_snapshot_path = numericSnapshot.snapshotPath
      writeHeterogeneityOutputFile(canonicalOutputDirBeforeRun, spec.result_path, JSON.stringify(resultPayload, null, 2))
      finalizedSpecs.push({
        ...spec,
        grounded_numbers: spec.grounded_numbers ?? { coefficient: resultPayload.coefficient, std_error: resultPayload.std_error, p_value: resultPayload.p_value, r_squared: resultPayload.r_squared, rows_used: resultPayload.rows_used },
        key_effect_direction: spec.key_effect_direction ?? effectDirection(resultPayload.coefficient),
        key_effect_significance: spec.key_effect_significance ?? significanceLabel(resultPayload.p_value),
      })
    }

    const heterogeneitySpecs = finalizedSpecs.filter((item) => item.spec_type === "heterogeneity")
    const mechanismSpecs = finalizedSpecs.filter((item) => item.spec_type === "mechanism")
    const robustnessSpecs = finalizedSpecs.filter((item) => item.spec_type === "placebo" || item.spec_type === "alternative_spec")
    const successful = finalizedSpecs.filter((item) => item.status === "success").length
    const failedOrSkipped = finalizedSpecs.length - successful
    const allSpecsSucceeded = finalizedSpecs.length > 0 && failedOrSkipped === 0
    const completionLabel = allSpecsSucceeded
      ? "异质性分析完成"
      : successful > 0
        ? "异质性分析部分完成"
        : "异质性分析未完成"
    const nonSuccessfulSpecs = finalizedSpecs.filter((item) => item.status !== "success")
    const visibleFailureDetails = nonSuccessfulSpecs.slice(0, 3).map((item) => {
      const state = item.status === "failed" ? "失败" : "跳过"
      const detail = (item.error ?? item.warning ?? "未提供原因").replace(/\s+/g, " ").slice(0, 240)
      return `${item.title ?? item.spec_id}（${state}）：${detail}`
    })
    const omittedFailureCount = nonSuccessfulSpecs.length - visibleFailureDetails.length
    const failureSummary = visibleFailureDetails.length > 0
      ? `\n\n未成功规格说明（展示前 ${visibleFailureDetails.length} 项）：\n${visibleFailureDetails.map((item) => `- ${item}`).join("\n")}${omittedFailureCount > 0 ? `\n- 另有 ${omittedFailureCount} 项，详见结构化扩展结果。` : ""}`
      : ""
    const surfacedWarnings = [
      ...(result.warnings ?? []),
      ...visibleFailureDetails,
      ...(omittedFailureCount > 0 ? [`另有 ${omittedFailureCount} 项失败或跳过，详见结构化扩展结果。`] : []),
    ]
    const outputDirBeforePublish = await resolveToolPath({
      filePath: outputDir,
      mode: "write",
      toolName: "heterogeneity_runner",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      ask: ctx.ask,
    })
    if (outputDirBeforePublish !== canonicalOutputDirBeforeRun) {
      throw new Tool.InputValidationError("异质性输出目录在执行期间发生变化；拒绝写入汇总产物。")
    }
    const heterogeneitySummaryPath = path.join(outputDirBeforePublish, "heterogeneity_summary.json")
    const mechanismSummaryPath = path.join(outputDirBeforePublish, "mechanism_summary.json")
    const robustnessSummaryPath = path.join(outputDirBeforePublish, "robustness_extension_summary.json")
    const heterogeneityNarrativePath = path.join(outputDirBeforePublish, "heterogeneity_narrative.md")
    const mechanismNarrativePath = path.join(outputDirBeforePublish, "mechanism_narrative.md")
    const combinedBundlePath = path.join(outputDirBeforePublish, "combined_publication_bundle.json")
    writeHeterogeneityOutputFile(outputDirBeforePublish, heterogeneitySummaryPath, JSON.stringify({ baseline_result_dir: relativeWithinProject(baselineBundle.resultDir), baseline_result_path: relativeWithinProject(baselineBundle.resultPath), specs: heterogeneitySpecs.map(relativeSpec) }, null, 2))
    writeHeterogeneityOutputFile(outputDirBeforePublish, mechanismSummaryPath, JSON.stringify({ baseline_result_dir: relativeWithinProject(baselineBundle.resultDir), specs: mechanismSpecs.map(relativeSpec) }, null, 2))
    writeHeterogeneityOutputFile(outputDirBeforePublish, robustnessSummaryPath, JSON.stringify({ baseline_result_dir: relativeWithinProject(baselineBundle.resultDir), specs: robustnessSpecs.map(relativeSpec) }, null, 2))
    writeHeterogeneityOutputFile(outputDirBeforePublish, heterogeneityNarrativePath, renderNarrative("异质性与稳健性扩展", [...heterogeneitySpecs, ...robustnessSpecs]))
    writeHeterogeneityOutputFile(outputDirBeforePublish, mechanismNarrativePath, renderNarrative("机制分析", mechanismSpecs))

    const combinedBundle = {
      datasetId: manifest?.datasetId ?? baselineBundle.datasetId ?? params.datasetId,
      stageId: params.stageId ?? baselineBundle.stageId,
      runId,
      branch,
      baseline: { resultDir: relativeWithinProject(baselineBundle.resultDir), resultPath: relativeWithinProject(baselineBundle.resultPath), numericSnapshotPath: baselineBundle.numericSnapshot?.snapshotPath ? relativeWithinProject(baselineBundle.numericSnapshot.snapshotPath) : undefined },
      heterogeneity_summary_path: relativeWithinProject(heterogeneitySummaryPath),
      mechanism_summary_path: relativeWithinProject(mechanismSummaryPath),
      robustness_extension_summary_path: relativeWithinProject(robustnessSummaryPath),
      heterogeneity_narrative_path: relativeWithinProject(heterogeneityNarrativePath),
      mechanism_narrative_path: relativeWithinProject(mechanismNarrativePath),
      specs: finalizedSpecs.map(relativeSpec),
      warnings: surfacedWarnings,
    }
    writeHeterogeneityOutputFile(outputDirBeforePublish, combinedBundlePath, JSON.stringify(combinedBundle, null, 2))

    const visibleOutputs: Array<{ label: string; relativePath: string }> = []
    if (manifest) {
      for (const [key, label, sourcePath] of [
        ["heterogeneity_summary_json", "heterogeneity_summary_json", heterogeneitySummaryPath],
        ["heterogeneity_narrative_md", "heterogeneity_narrative_md", heterogeneityNarrativePath],
        ["mechanism_summary_json", "mechanism_summary_json", mechanismSummaryPath],
        ["mechanism_narrative_md", "mechanism_narrative_md", mechanismNarrativePath],
        ["robustness_extension_summary_json", "robustness_extension_summary_json", robustnessSummaryPath],
        ["combined_publication_bundle_json", "combined_publication_bundle_json", combinedBundlePath],
      ] as const) {
        const visiblePath = publishVisibleOutput({ manifest, key, label, sourcePath, runId, branch: path.join("heterogeneity_runner", branch), stageId: params.stageId ?? baselineBundle.stageId, metadata: { module: "heterogeneity_runner", methodFamily: params.methodFamily } })
        visibleOutputs.push({ label, relativePath: relativeWithinProject(visiblePath) })
      }
    }
    if (analysisOperationIdentity) {
      const complete = extra?.completeAnalysisToolRun
      if (typeof complete !== "function") {
        throw new Tool.InputValidationError("Harness 没有完成异质性运行状态登记；结果将保持未确认。")
      }
      ;(complete as (operation: AnalysisToolRunRecord) => void)({
        ...analysisOperationIdentity,
        status: allSpecsSucceeded ? "completed" : "partial",
        resultId: `heterogeneity:${runId}:${operationId}`,
        artifactRefs: [...new Set([
          relativeWithinProject(combinedBundlePath),
          ...visibleOutputs.map((item) => item.relativePath),
        ])],
        resultContractStatus: "pass",
        subResults: finalizedSpecs.map((spec) => ({
          specId: spec.spec_id,
          specType: spec.spec_type,
          status: spec.status,
        })),
        updatedAt: new Date().toISOString(),
      })
    }
    const finalOutputPath = manifest ? finalOutputsPath(manifest.sourcePath, runId) : undefined
    return {
      title: completionLabel,
      output: `## ${completionLabel}\n\n成功规格：${successful}\n失败或跳过规格：${failedOrSkipped}\n基准结果与组合产物已保存。${failureSummary}`,
      metadata: {
        datasetId: manifest?.datasetId ?? baselineBundle.datasetId ?? params.datasetId,
        stageId: params.stageId ?? baselineBundle.stageId,
        runId,
        outputDir: relativeWithinProject(outputDir),
        combinedBundlePath: relativeWithinProject(combinedBundlePath),
        summaryPaths: { heterogeneity: relativeWithinProject(heterogeneitySummaryPath), mechanism: relativeWithinProject(mechanismSummaryPath), robustness: relativeWithinProject(robustnessSummaryPath) },
        narrativePaths: { heterogeneity: relativeWithinProject(heterogeneityNarrativePath), mechanism: relativeWithinProject(mechanismNarrativePath) },
        visibleOutputs,
        finalOutputsPath: finalOutputPath ? relativeWithinProject(finalOutputPath) : undefined,
        analysisView: createToolAnalysisView({
          kind: "heterogeneity_runner",
          step: "heterogeneity_runner",
          datasetId: manifest?.datasetId ?? baselineBundle.datasetId ?? params.datasetId,
          stageId: params.stageId ?? baselineBundle.stageId,
          results: [analysisMetric("成功规格", successful), analysisMetric("失败或跳过规格", failedOrSkipped), analysisMetric("异质性规格", heterogeneitySpecs.length), analysisMetric("机制规格", mechanismSpecs.length)],
          artifacts: [analysisArtifact(relativeWithinProject(combinedBundlePath), { label: "综合扩展结果", visibility: "user_default" }), analysisArtifact(relativeWithinProject(heterogeneityNarrativePath), { label: "异质性摘要", visibility: "user_collapsed" }), ...visibleOutputs.map((item) => analysisArtifact(item.relativePath, { label: item.label, visibility: "user_collapsed" }))],
          warnings: surfacedWarnings,
          conclusion: allSpecsSucceeded
            ? "所有请求的异质性、机制和稳健性扩展规格均已生成；具体解释服从各自研究设计和诊断。"
            : `扩展批次已保存，但${successful === 0 ? "没有规格成功" : `仅 ${successful} 个规格成功`}；其余规格失败或跳过，不能将本批次视为全部完成。`,
        }),
        display: createToolDisplay({ summary: `${completionLabel}，成功 ${successful} 个规格`, details: [`方法族：${params.methodFamily}`, `成功规格：${successful}`, `失败或跳过规格：${failedOrSkipped}`, ...visibleFailureDetails], artifacts: visibleOutputs.map((item) => ({ label: item.label, path: item.relativePath, visibility: "user_collapsed" as const })) }),
      },
    }
  },
})
