import crypto from "node:crypto"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { dataDiagnosisFingerprintMismatch } from "@/runtime/data-readiness"
import type {
  AnalysisSpecPreflight,
  AnalysisSpecRecord,
  AnalysisSpecStatus,
  PreparedSpecRecord,
} from "@/runtime/types"
import type {
  EconometricsEngineClient,
  EnginePreflightResult,
  EngineValidationResult,
} from "./econometrics-engine-client"
import { EconometricsEngineError } from "./econometrics-engine-client"

export type AnalysisSpecEngine = Pick<EconometricsEngineClient, "health" | "describe" | "validate" | "preflight">

export type AnalysisSpecCurrentData = {
  datasetId: string
  stageId: string
  dataPath: string
  stageMetadata?: Record<string, unknown>
}

export type AnalysisSpecPreparationResult = {
  status: AnalysisSpecStatus
  message: string
  issueCode?: string
  issues?: Array<Record<string, unknown>>
  userSpecifiedCorrections?: Array<{ field: string; modelValue: string; userValue: string }>
  authorizedRepair?: { method: "combine_columns"; columns: string[] }
  missingFields?: string[]
  spec?: AnalysisSpecRecord
  preparedSpec?: PreparedSpecRecord
}

export type PreparedSpecResolution =
  | { status: "ready"; preparedSpec: PreparedSpecRecord }
  | { status: "authorization_required"; message: string }
  | { status: "invalidated"; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

export function analysisSpecHash(value: Record<string, unknown>) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`
}

export function analysisSpecArgumentsEqual(left: Record<string, unknown>, right: Record<string, unknown>) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
}

function missingFields(error: unknown) {
  if (!isRecord(error) || !isRecord(error.details) || !Array.isArray(error.details.validation_errors)) return []
  const issues = error.details.validation_errors.filter(isRecord)
  if (issues.length === 0 || issues.some((issue) => issue.type !== "missing")) return []
  return [...new Set(issues.map((issue) =>
    Array.isArray(issue.loc) ? issue.loc.map(String).join(".") : "参数",
  ))]
}

function projectPreflight(result: EnginePreflightResult): AnalysisSpecPreflight {
  return {
    executable: result.executable,
    status: result.status,
    dataFingerprint: result.data_fingerprint,
    issues: result.issues.slice(0, 100),
    repairPlan: result.repair_plan.slice(0, 20),
  }
}

function preflightMessage(result: EnginePreflightResult) {
  const issues = result.issues.slice(0, 5).map((issue) =>
    typeof issue.summary_zh === "string" ? issue.summary_zh : "方法前置条件尚未满足。",
  )
  const repairs = result.repair_plan.slice(0, 3).map((option) => {
    const label = typeof option.label_zh === "string" ? option.label_zh : "候选处理"
    const description = typeof option.description_zh === "string" ? option.description_zh : ""
    return description ? `${label}：${description}` : label
  })
  return [
    `当前规格未达到可执行状态（${result.status}），估计器没有运行。`,
    ...issues,
    ...repairs,
    "若修复会改变样本、变量含义、估计量或推断口径，须先由用户确认；修复后重新诊断并准备新规格。",
  ].join("\n")
}

/**
 * 将模型提出的参数交给 Python Registry 校验，再对当前受管 stage 做只读 preflight。
 * 此服务从不调用 execute；只有诊断指纹与 stage 一致时才生成 PreparedSpec。
 */
export async function prepareAnalysisSpec(input: {
  sessionID: string
  taskId: string
  sourceMessageId: string
  requestId: string
  methodID: string
  arguments: Record<string, unknown>
  userSpecifiedFields?: string[]
  currentData: AnalysisSpecCurrentData
  engine: AnalysisSpecEngine
  signal?: AbortSignal
}): Promise<AnalysisSpecPreparationResult> {
  const task = RuntimeTaskLedger.listTasks(input.sessionID).tasks.find(
    (item) => item.taskId === input.taskId && item.sessionID === input.sessionID,
  )
  if (!task || task.messageID !== input.sourceMessageId) {
    throw new Error("当前任务与用户消息不匹配，未准备计量规格。请由 Harness 恢复当前请求，不要复用其他轮次。")
  }
  const request = task.analysisRequest
  if (!request || request.requestId !== input.requestId || request.sourceMessageId !== input.sourceMessageId) {
    throw new Error("requestId 与当前用户消息登记不匹配，未准备计量规格。请读取当前任务账本，不要猜测或复用旧请求。")
  }
  if (request.kind !== "estimate" && request.kind !== "inspect") {
    RuntimeTaskLedger.transitionAnalysis({
      sessionID: input.sessionID,
      taskId: input.taskId,
      event: { type: "decision_required", requestId: request.requestId, issueCode: "REQUEST_KIND_NOT_ESTIMABLE" },
    })
    return {
      status: "clarification_required",
      message: `当前请求类型为“${request.kind}”，不能在本轮准备计量方法规格；本次没有运行估计。若要估计，请由用户明确提出后登记新的请求。`,
    }
  }
  if (!input.currentData.datasetId || !input.currentData.stageId || !input.currentData.dataPath) {
    throw new Error("当前会话没有可用于方法预检的规范化数据阶段；请先完成数据导入和诊断。")
  }
  const ledger = RuntimeTaskLedger.listTasks(input.sessionID)
  const activeTask = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
  if (activeTask?.taskId !== task.taskId) {
    throw new Error("分析请求已不再是当前活动任务，拒绝将规格绑定到其他轮次。")
  }

  const [description, health] = await Promise.all([
    input.engine.describe(input.methodID, input.signal),
    input.engine.health(input.signal),
  ])
  if (description.method_id !== input.methodID) {
    throw new Error("Python Registry 返回的方法 ID 与请求不一致，未保存规格。")
  }
  const schemaVersion = description.schema_version
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion !== health.registry_version) {
    throw new Error("方法 Schema 与 Python Registry 版本不一致；请刷新方法定义后重试准备，不要执行估计。")
  }
  const runtimeFields = Array.isArray(description.runtime_injected_fields)
    ? description.runtime_injected_fields.filter((field): field is string => typeof field === "string")
    : []
  const trustedRuntime: Record<string, unknown> = {}
  for (const field of runtimeFields) {
    if (field === "datasetId") trustedRuntime.datasetId = input.currentData.datasetId
    else if (field === "stageId") trustedRuntime.stageId = input.currentData.stageId
    else throw new Error(`Harness 暂无“${field}”的可信规格来源，未准备该方法。`)
  }

  let validated: EngineValidationResult
  try {
    validated = await input.engine.validate(input.methodID, input.arguments, {
      runtime: trustedRuntime,
      signal: input.signal,
    })
  } catch (error) {
    const missing = missingFields(error)
    if (missing.length) {
      RuntimeTaskLedger.transitionAnalysis({
        sessionID: input.sessionID,
        taskId: input.taskId,
        event: { type: "decision_required", requestId: request.requestId, issueCode: "RESEARCH_ROLES_REQUIRED" },
      })
      return {
        status: "clarification_required",
        missingFields: missing,
        message: `还缺少 ${missing.join("、")} 等必需研究参数；当前没有准备可执行规格，也没有运行估计。请回到用户原始请求核对，缺少变量角色或研究设定时先询问用户。`,
      }
    }
    throw error
  }
  if (validated.method_id !== input.methodID || validated.registry_version !== health.registry_version) {
    throw new Error("Python 参数校验返回了不同方法或 Registry 版本，未保存规格。")
  }

  let preflight: EnginePreflightResult
  try {
    preflight = await input.engine.preflight({
      method_id: input.methodID,
      data_path: input.currentData.dataPath,
      arguments: validated.arguments,
      ...(Object.keys(trustedRuntime).length ? { runtime: trustedRuntime } : {}),
    }, input.signal)
  } catch (error) {
    if (!(error instanceof EconometricsEngineError) || error.code !== "DATA_COLUMN_MISSING") throw error
    const issue = {
      code: error.code,
      severity: "blocking",
      summary_zh: error.message,
      evidence: error.details ?? {},
    }
    RuntimeTaskLedger.transitionAnalysis({
      sessionID: input.sessionID,
      taskId: input.taskId,
      event: { type: "decision_required", requestId: request.requestId, issueCode: error.code },
    })
    return {
      status: "requires_user_decision",
      issueCode: error.code,
      issues: [issue],
      message: [
        `当前数据阶段不包含方法“${input.methodID}”所需的变量。`,
        error.message,
        "尚未保存可执行规格，也没有运行估计。请依据本轮已核验的真实列名向用户澄清；若要替换列名，必须得到用户确认后重新准备规格。",
      ].join("\n"),
    }
  }
  if (preflight.method_id !== input.methodID || !/^sha256:[0-9a-f]{64}$/.test(preflight.data_fingerprint)) {
    throw new Error("Python preflight 的方法标识或数据指纹无效，未保存规格。")
  }

  const mismatch = dataDiagnosisFingerprintMismatch(
    input.currentData.stageMetadata?.dataDiagnosis,
    input.currentData.stageId,
    preflight.data_fingerprint,
  )
  const status: AnalysisSpecStatus = mismatch
    ? "diagnosis_refresh_required"
    : preflight.status === "ready" && preflight.executable
      ? request.kind === "estimate" ? "ready" : "preflight_ready"
      : preflight.status
  const normalizedArguments = preflight.normalized_arguments
  const fingerprint = preflight.data_fingerprint
  const preflightRecord = projectPreflight(preflight)
  const hash = analysisSpecHash({
    requestId: request.requestId,
    methodID: input.methodID,
    arguments: normalizedArguments,
    datasetId: input.currentData.datasetId,
    stageId: input.currentData.stageId,
    stageFingerprint: fingerprint,
    registryVersion: health.registry_version,
    schemaVersion,
  })
  const userSpecifiedFields = new Set(input.userSpecifiedFields ?? [])
  const argumentSources = Object.fromEntries(Object.keys(normalizedArguments).map((field) => [
    field,
    userSpecifiedFields.has(field)
      ? { kind: "user_explicit" as const, sourceMessageId: input.sourceMessageId }
      : Object.hasOwn(input.arguments, field)
        ? { kind: "model_interpretation" as const, sourceMessageId: input.sourceMessageId }
        : {
            kind: "registry_default_or_normalization" as const,
            registryVersion: health.registry_version,
            schemaVersion,
          },
  ]))
  const stored = RuntimeTaskLedger.recordAnalysisSpec({
    sessionID: input.sessionID,
    taskId: input.taskId,
    requestId: request.requestId,
    sourceMessageId: input.sourceMessageId,
    methodID: input.methodID,
    arguments: normalizedArguments,
    argumentSources,
    datasetId: input.currentData.datasetId,
    stageId: input.currentData.stageId,
    stageFingerprint: fingerprint,
    registryVersion: health.registry_version,
    schemaVersion,
    specHash: hash,
    status,
    preflight: preflightRecord,
  })

  if (status === "diagnosis_refresh_required") {
    return {
      status,
      message: `已校验方法参数，但当前数据阶段的质量诊断缺失、过期或指纹不匹配（${mismatch}）；估计器没有运行。请先刷新当前数据阶段的 profile/validate，再重新准备规格。`,
      spec: stored.spec,
    }
  }
  if (status === "preflight_ready") {
    return {
      status,
      message: `Python Registry 已确认该方法与当前数据阶段满足技术前提，候选规格 ${stored.spec.specId} 已记录；本轮是 inspect 请求，没有生成可执行 PreparedSpec，也没有运行估计。若要估计，请由用户另行明确确认目标和研究设定。`,
      spec: stored.spec,
    }
  }
  if (status !== "ready") {
    return {
      status,
      message: preflightMessage(preflight),
      spec: stored.spec,
    }
  }
  if (!stored.preparedSpec) {
    throw new Error("规格记录未生成与之匹配的 PreparedSpec；估计器没有运行。")
  }
  return {
    status: "ready",
    message: `方法参数和当前数据阶段已通过 Python Registry 校验，规格 ${stored.spec.specId} 已准备；本工具没有运行估计器，也不代表用户授权了未明确提出的研究设定变化。`,
    spec: stored.spec,
    preparedSpec: stored.preparedSpec,
  }
}

/** Resolve an execute-time specId without trusting IDs or arguments supplied by the model. */
export function resolvePreparedSpecForExecution(input: {
  sessionID: string
  taskId: string
  sourceMessageId: string
  requestId: string
  specId: string
  currentData: AnalysisSpecCurrentData
  authorizedMethodIDs: string[]
}): PreparedSpecResolution {
  const ledger = RuntimeTaskLedger.listTasks(input.sessionID)
  const task = ledger.tasks.find((item) => item.taskId === input.taskId && item.sessionID === input.sessionID)
  if (!task || ledger.activeTaskId !== input.taskId || task.messageID !== input.sourceMessageId) {
    return { status: "invalidated", message: "PreparedSpec 所属任务不是当前活动用户请求，拒绝执行。请重新准备当前请求的规格。" }
  }
  const request = task.analysisRequest
  if (!request || request.kind !== "estimate" || request.requestId !== input.requestId || request.sourceMessageId !== input.sourceMessageId) {
    return { status: "invalidated", message: "PreparedSpec 与当前 estimate 请求不匹配，拒绝执行。请重新登记请求并准备规格。" }
  }
  const preparedSpec = task.preparedSpec
  if (!preparedSpec || preparedSpec.specId !== input.specId) {
    return { status: "invalidated", message: "specId 不存在、已被新规格替代或未通过 preflight；估计器没有运行。请按当前方法 Schema 重新准备规格。" }
  }
  const taskAuthorizedIDs = [
    ...(Array.isArray(task.metadata?.requiredToolIDs) ? task.metadata.requiredToolIDs.filter((id): id is string => typeof id === "string") : []),
    ...(Array.isArray(task.metadata?.confirmedToolIDs) ? task.metadata.confirmedToolIDs.filter((id): id is string => typeof id === "string") : []),
  ]
  if (!input.authorizedMethodIDs.includes(preparedSpec.methodID) && !taskAuthorizedIDs.includes(preparedSpec.methodID)) {
    return {
      status: "authorization_required",
      message: `当前 estimate 请求尚未明确选择或确认方法“${preparedSpec.methodID}”。PreparedSpec 只证明技术条件满足，不构成方法授权；未运行估计。请向用户说明候选方法并取得明确选择后，登记新请求或记录确认，再准备规格。`,
    }
  }
  const latestSpec = task.analysisSpecs?.at(-1)
  const expectedHash = analysisSpecHash({
    requestId: preparedSpec.requestId,
    methodID: preparedSpec.methodID,
    arguments: preparedSpec.arguments,
    datasetId: preparedSpec.datasetId,
    stageId: preparedSpec.stageId,
    stageFingerprint: preparedSpec.stageFingerprint,
    registryVersion: preparedSpec.registryVersion,
    schemaVersion: preparedSpec.schemaVersion,
  })
  if (
    latestSpec?.specId !== preparedSpec.specId ||
    latestSpec.revision !== preparedSpec.revision ||
    latestSpec.status !== "ready" ||
    latestSpec.specHash !== preparedSpec.specHash ||
    latestSpec.methodID !== preparedSpec.methodID ||
    latestSpec.requestId !== preparedSpec.requestId ||
    !analysisSpecArgumentsEqual(latestSpec.arguments, preparedSpec.arguments) ||
    preparedSpec.specHash !== expectedHash ||
    preparedSpec.requestId !== request.requestId ||
    preparedSpec.sourceMessageId !== input.sourceMessageId
  ) {
    return { status: "invalidated", message: "PreparedSpec 不是当前请求的最新 ready 规格，拒绝执行。请重新准备规格。" }
  }
  if (
    preparedSpec.datasetId !== input.currentData.datasetId ||
    preparedSpec.stageId !== input.currentData.stageId
  ) {
    return { status: "invalidated", message: "PreparedSpec 绑定的数据阶段已不是当前阶段；估计器没有运行。请对当前阶段重新准备规格。" }
  }
  if (
    !preparedSpec.preflight.executable ||
    preparedSpec.preflight.status !== "ready" ||
    preparedSpec.preflight.dataFingerprint !== preparedSpec.stageFingerprint
  ) {
    return { status: "invalidated", message: "PreparedSpec 的 preflight 状态或数据指纹无效，拒绝执行。请刷新诊断并重新准备规格。" }
  }
  const mismatch = dataDiagnosisFingerprintMismatch(
    input.currentData.stageMetadata?.dataDiagnosis,
    input.currentData.stageId,
    preparedSpec.stageFingerprint,
  )
  if (mismatch) {
    return { status: "invalidated", message: `当前数据诊断已失效（${mismatch}）；估计器没有运行。请先刷新当前阶段诊断，再重新准备规格。` }
  }
  return { status: "ready", preparedSpec }
}
