import type {
  AnalysisLifecycleRecord,
  AnalysisLifecycleStatus,
  AnalysisToolOperationIdentity,
  AnalysisToolRunRecord,
  AnalysisRequestKind,
  AnalysisSpecLifecycleRecord,
  AnalysisSpecStatus,
} from "./types"

export type AnalysisLifecycleEvent =
  | { type: "request_registered"; requestId: string; kind: AnalysisRequestKind; sourceMessageId?: string }
  | { type: "diagnosis_started"; requestId: string }
  | {
      type: "diagnosis_completed"
      requestId: string
      datasetId: string
      stageId: string
      stageFingerprint: string
      blockingIssueCode?: string
    }
  | { type: "decision_required"; requestId: string; issueCode: string; pendingMethodIDs?: string[] }
  | {
      type: "decision_approved"
      requestId: string
      issueCode: string
      resumeAs: "spec_pending" | "repairing"
      choice: string
      decisionMessageId: string
    }
  | { type: "spec_assessment_started"; requestId: string; methodID: string }
  | {
      type: "assessment_failed"
      requestId: string
      failureCode: string
      recovery: "model_correction" | "stop"
    }
  | {
      type: "spec_assessed"
      requestId: string
      specId: string
      revision: number
      methodID: string
      stageFingerprint: string
      status: AnalysisSpecStatus
      issueCode?: string
    }
  | {
      type: "user_decision"
      requestId: string
      specId: string
      revision: number
      stageFingerprint: string
      decision: "approve" | "reject"
      decisionMessageId: string
    }
  | { type: "authorization_requested"; requestId: string; specId: string; revision: number; stageFingerprint: string }
  | { type: "repair_started"; requestId: string; issueCode?: string }
  | { type: "repair_stage_created"; requestId: string; stageFingerprint: string }
  | { type: "execution_started"; requestId: string; specId: string; stageFingerprint: string }
  | { type: "execution_result"; requestId: string; specId: string; resultId: string; artifactRefs: string[] }
  | { type: "result_contract_verified"; requestId: string; specId: string; resultId: string; status: "pass" | "block" }
  | {
      type: "verification_completed"
      requestId: string
      specId: string
      resultId: string
      status: "pass" | "warn" | "block"
  }
  | { type: "tool_run_started"; operation: AnalysisToolOperationIdentity }
  | { type: "tool_run_recorded"; operation: AnalysisToolRunRecord }
  | {
      type: "tool_run_terminated"
      requestId: string
      operationId: string
      outcome: "failed" | "cancelled" | "unconfirmed"
      failureCode: string
    }
  | { type: "execution_failed"; requestId: string; specId: string; failureCode: string; retryable: boolean }
  | { type: "execution_unconfirmed"; requestId: string; specId: string; failureCode: string }
  | { type: "cancelled"; requestId: string; outcomeConfirmed: boolean; failureCode?: string }

export class AnalysisLifecycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AnalysisLifecycleError"
  }
}

export function createAnalysisLifecycle(): AnalysisLifecycleRecord {
  return { version: 1, status: "idle", specRuns: [], updatedAt: new Date().toISOString() }
}

export function missingRequiredEstimateMethodIDs(
  requiredMethodIDs: readonly string[],
  lifecycle: AnalysisLifecycleRecord | undefined,
  requestId: string,
) {
  const completed = new Set(
    lifecycle?.requestId === requestId
      ? [
          ...lifecycle.specRuns
            .filter((run) =>
              run.requestId === requestId &&
              run.status === "completed" &&
              run.resultContractStatus === "pass",
            )
            .map((run) => run.methodID),
          ...(lifecycle.toolRuns ?? [])
            .filter((run) =>
              run.requestId === requestId &&
              run.status === "completed" &&
              run.resultContractStatus === "pass" &&
              (run.toolID !== "heterogeneity_runner" || heterogeneityBatchSucceeded(lifecycle.toolRuns ?? [], requestId)),
            )
            .map((run) => run.toolID),
        ]
      : [],
  )
  return [...new Set(requiredMethodIDs)].filter((methodID) => !completed.has(methodID))
}

function heterogeneityBatchSucceeded(toolRuns: readonly AnalysisToolRunRecord[], requestId: string) {
  const latestBySpecID = new Map<string, string>()
  for (const run of toolRuns) {
    if (run.requestId !== requestId || run.toolID !== "heterogeneity_runner") continue
    for (const result of run.subResults ?? []) latestBySpecID.set(result.specId, result.status)
  }
  return latestBySpecID.size > 0 && [...latestBySpecID.values()].every((status) => status === "success")
}

export function hasCompletedRequiredEstimateMethods(
  requiredMethodIDs: readonly string[],
  lifecycle: AnalysisLifecycleRecord | undefined,
  requestId: string,
) {
  const required = expectedEstimateMethodIDs(requiredMethodIDs, lifecycle, requestId)
  return required.length > 0 && missingRequiredEstimateMethodIDs(required, lifecycle, requestId).length === 0
}

export function expectedEstimateMethodIDs(
  requiredMethodIDs: readonly string[],
  lifecycle: AnalysisLifecycleRecord | undefined,
  requestId: string,
) {
  const explicit = [...new Set(requiredMethodIDs.filter(Boolean))]
  if (explicit.length > 0) return explicit
  if (lifecycle?.requestId !== requestId) return []
  return [...new Set(lifecycle.specRuns.flatMap((run) => {
    const authorization = run.authorization
    return authorization?.requestId === requestId &&
      authorization.specId === run.specId &&
      authorization.revision === run.revision &&
      authorization.stageFingerprint === run.stageFingerprint
      ? [run.methodID]
      : []
  }).concat((lifecycle.toolRuns ?? [])
    .filter((run) =>
      run.requestId === requestId &&
      lifecycle.sourceMessageId !== undefined &&
      run.authorizationMessageId === lifecycle.sourceMessageId,
    )
    .map((run) => run.toolID)))]
}

function withSpecRun(
  state: AnalysisLifecycleRecord,
  specId: string,
  patch: Partial<AnalysisSpecLifecycleRecord>,
): AnalysisSpecLifecycleRecord[] {
  const runs = state.specRuns ?? []
  return runs.map((run) => run.specId === specId ? { ...run, ...patch, updatedAt: new Date().toISOString() } : run)
}

function upsertSpecRun(
  state: AnalysisLifecycleRecord,
  run: AnalysisSpecLifecycleRecord,
): AnalysisSpecLifecycleRecord[] {
  const runs = state.specRuns ?? []
  const index = runs.findIndex((item) => item.specId === run.specId)
  if (index < 0) return [...runs, run].slice(-50)
  return runs.map((item, current) => current === index ? run : item)
}

function requireRequest(state: AnalysisLifecycleRecord, requestId: string) {
  if (!state.requestId || state.requestId !== requestId) {
    throw new AnalysisLifecycleError("分析生命周期事件与当前 AnalysisRequest 不匹配。")
  }
}

function requireSpec(state: AnalysisLifecycleRecord, specId: string, requestId: string) {
  requireRequest(state, requestId)
  if (state.specId !== specId) throw new AnalysisLifecycleError("分析生命周期事件与当前规格版本不匹配。")
}

function requireFingerprint(state: AnalysisLifecycleRecord, fingerprint: string) {
  if (state.stageFingerprint !== fingerprint) {
    throw new AnalysisLifecycleError("分析生命周期事件的数据指纹已过期或不匹配。")
  }
}

function validateToolRunIdentity(state: AnalysisLifecycleRecord, operation: AnalysisToolOperationIdentity) {
  requireRequest(state, operation.requestId)
  if (state.requestKind !== "estimate") {
    throw new AnalysisLifecycleError("当前分析请求类型不允许登记估计工具运行。")
  }
  if (!new Set(["heterogeneity_runner", "composite_evaluation"]).has(operation.toolID)) {
    throw new AnalysisLifecycleError("该工具不属于受控估计工具，不能登记当前分析请求。")
  }
  if (!state.sourceMessageId || operation.authorizationMessageId !== state.sourceMessageId) {
    throw new AnalysisLifecycleError("工具运行没有绑定当前用户消息授权。")
  }
  if (!operation.operationId.trim() || !operation.datasetId.trim() || !operation.stageId.trim()) {
    throw new AnalysisLifecycleError("工具运行缺少操作或数据阶段标识。")
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(operation.stageFingerprint) ||
      !/^sha256:[0-9a-f]{64}$/.test(operation.inputFingerprint)) {
    throw new AnalysisLifecycleError("工具运行的数据或参数指纹无效。")
  }
  if (state.stageFingerprint !== operation.stageFingerprint) {
    throw new AnalysisLifecycleError("工具运行的数据指纹与当前请求诊断不一致。")
  }
  if (state.datasetId !== operation.datasetId || state.stageId !== operation.stageId) {
    throw new AnalysisLifecycleError("工具运行的数据集或阶段与当前请求诊断不一致。")
  }
}

function sameToolRunIdentity(left: AnalysisToolOperationIdentity, right: AnalysisToolOperationIdentity) {
  return left.requestId === right.requestId &&
    left.operationId === right.operationId &&
    left.toolID === right.toolID &&
    left.datasetId === right.datasetId &&
    left.stageId === right.stageId &&
    left.stageFingerprint === right.stageFingerprint &&
    left.inputFingerprint === right.inputFingerprint &&
    left.authorizationMessageId === right.authorizationMessageId
}

export function reduceAnalysisLifecycle(
  previous: AnalysisLifecycleRecord,
  event: AnalysisLifecycleEvent,
): AnalysisLifecycleRecord {
  const state = structuredClone(previous)
  state.specRuns ??= []
  const next = (patch: Partial<AnalysisLifecycleRecord>): AnalysisLifecycleRecord => ({
    ...state,
    ...patch,
    updatedAt: new Date().toISOString(),
  })

  switch (event.type) {
    case "request_registered": {
      if (state.status !== "idle") throw new AnalysisLifecycleError("当前任务已登记分析请求，不能覆盖原始研究意图。")
      return next({
        status: event.kind === "inspect" || event.kind === "repair" ? "diagnosing" : "spec_pending",
        requestId: event.requestId,
        requestKind: event.kind,
        sourceMessageId: event.sourceMessageId,
      })
    }
    case "diagnosis_started":
      requireRequest(state, event.requestId)
      if (!["spec_pending", "diagnosing", "assessing", "ready", "waiting_user", "repairing"].includes(state.status)) {
        throw new AnalysisLifecycleError("当前分析状态不允许开始数据诊断。")
      }
      return next({
        status: "diagnosing",
        authorization: undefined,
        datasetId: undefined,
        stageId: undefined,
        stageFingerprint: undefined,
        decisionApproval: undefined,
      })
    case "diagnosis_completed":
      requireRequest(state, event.requestId)
      if (state.status !== "diagnosing") throw new AnalysisLifecycleError("数据诊断结果没有匹配的诊断阶段。")
      if (!event.datasetId.trim() || !event.stageId.trim() || !/^sha256:[0-9a-f]{64}$/.test(event.stageFingerprint)) {
        throw new AnalysisLifecycleError("数据诊断没有绑定有效的数据集、阶段和内容指纹。")
      }
      return next({
        status: event.blockingIssueCode ? "waiting_user" : "spec_pending",
        datasetId: event.datasetId,
        stageId: event.stageId,
        stageFingerprint: event.stageFingerprint,
        issueCode: event.blockingIssueCode,
        specId: undefined,
        specRevision: undefined,
        methodID: undefined,
        authorization: undefined,
      })
    case "decision_required":
      requireRequest(state, event.requestId)
      if (["running", "verifying", "cancelled", "unconfirmed"].includes(state.status)) {
        throw new AnalysisLifecycleError("当前分析状态不允许创建新的用户决策停点。")
      }
      if (state.status === "completed") {
        const pendingMethodIDs = [...new Set((event.pendingMethodIDs ?? []).filter(Boolean))]
        if (
          event.issueCode !== "ESTIMATE_REQUEST_INCOMPLETE" ||
          pendingMethodIDs.length === 0 ||
          missingRequiredEstimateMethodIDs(pendingMethodIDs, state, event.requestId).length === 0
        ) {
          throw new AnalysisLifecycleError("已完成的估计请求只能为尚未完成的明确方法创建等待用户停点。")
        }
      }
      return next({ status: "waiting_user", issueCode: event.issueCode, authorization: undefined })
    case "decision_approved":
      requireRequest(state, event.requestId)
      if (state.status !== "waiting_user" || state.issueCode !== event.issueCode) {
        throw new AnalysisLifecycleError("用户确认与当前待决问题不匹配。")
      }
      if (!event.choice.trim() || !event.decisionMessageId.trim()) {
        throw new AnalysisLifecycleError("用户确认缺少选项内容或消息来源。")
      }
      const partialBatch = event.issueCode === "HETEROGENEITY_BATCH_PARTIAL"
        ? [...(state.toolRuns ?? [])].reverse().find((run) =>
            run.requestId === event.requestId && run.toolID === "heterogeneity_runner" && run.status === "partial",
          )
        : undefined
      if (event.issueCode === "HETEROGENEITY_BATCH_PARTIAL" &&
          (!partialBatch?.inputFingerprint || !partialBatch.subResults?.length)) {
        throw new AnalysisLifecycleError("异质性部分完成停点缺少原始批次规格，不能授权重跑。")
      }
      return next({
        status: event.resumeAs,
        issueCode: undefined,
        authorization: undefined,
        decisionApproval: {
          requestId: event.requestId,
          issueCode: event.issueCode,
          resumeAs: event.resumeAs,
          choice: event.choice.trim(),
          stageFingerprint: state.stageFingerprint,
          ...(partialBatch ? {
            approvedInputFingerprint: partialBatch.inputFingerprint,
            approvedSubSpecIDs: [...new Set((partialBatch.subResults ?? []).map((item) => item.specId))].sort(),
          } : {}),
          decisionMessageId: event.decisionMessageId,
          decidedAt: new Date().toISOString(),
        },
      })
    case "spec_assessment_started":
      requireRequest(state, event.requestId)
      if (!["spec_pending", "assessing", "ready", "repairing", "diagnosing", "completed", "failed"].includes(state.status)) {
        throw new AnalysisLifecycleError("当前分析状态不允许开始规格预检。")
      }
      if (state.status === "failed" && state.methodID !== event.methodID) {
        throw new AnalysisLifecycleError("失败后不能静默更换计量方法；请登记新的用户请求或先取得方法变更确认。")
      }
      if (state.specRuns.some((run) => run.methodID === event.methodID && run.status === "completed")) {
        throw new AnalysisLifecycleError("当前请求已完成该计量方法；要重估同一方法，请登记新的用户请求或明确新的规格决策。")
      }
      return next({
        status: "assessing",
        methodID: event.methodID,
        specId: undefined,
        specRevision: undefined,
        specStatus: undefined,
        issueCode: undefined,
        failureCode: undefined,
        resultId: undefined,
        artifactRefs: undefined,
        resultContractStatus: undefined,
        verifierStatus: undefined,
        authorization: undefined,
      })
    case "assessment_failed":
      requireRequest(state, event.requestId)
      if (state.status !== "assessing") throw new AnalysisLifecycleError("规格预检失败事件没有匹配正在进行的规格预检。")
      return next({
        status: event.recovery === "model_correction" ? "spec_pending" : "failed",
        failureCode: event.failureCode,
        authorization: undefined,
      })
    case "spec_assessed": {
      requireRequest(state, event.requestId)
      if (!["spec_pending", "assessing", "ready", "repairing", "diagnosing"].includes(state.status)) {
        throw new AnalysisLifecycleError("当前分析状态不允许登记规格预检结果。")
      }
      const status: AnalysisLifecycleStatus = event.status === "ready" || event.status === "preflight_ready"
        ? "ready"
        : event.status === "diagnosis_refresh_required"
          ? "diagnosing"
          : event.status === "schema_not_sent"
          ? "spec_pending"
            : "waiting_user"
      const specRun: AnalysisSpecLifecycleRecord = {
        requestId: event.requestId,
        specId: event.specId,
        revision: event.revision,
        methodID: event.methodID,
        status,
        stageFingerprint: event.stageFingerprint,
        specStatus: event.status,
        issueCode: event.issueCode,
        updatedAt: new Date().toISOString(),
      }
      return next({
        status,
        specRuns: upsertSpecRun(state, specRun),
        specId: event.specId,
        specRevision: event.revision,
        methodID: event.methodID,
        stageFingerprint: event.stageFingerprint,
        issueCode: event.issueCode,
        specStatus: event.status,
        resultId: undefined,
        artifactRefs: undefined,
        resultContractStatus: undefined,
        verifierStatus: undefined,
        authorization: undefined,
      })
    }
    case "user_decision": {
      requireSpec(state, event.specId, event.requestId)
      if (state.specRevision !== event.revision) throw new AnalysisLifecycleError("用户确认的规格版本已过期。")
      requireFingerprint(state, event.stageFingerprint)
      if (event.decision === "reject") {
        return next({
          status: "cancelled",
          authorization: undefined,
          specRuns: withSpecRun(state, event.specId, { status: "cancelled", authorization: undefined }),
        })
      }
      if (state.status !== "ready" && !(state.status === "waiting_user" && state.specStatus === "ready")) {
        throw new AnalysisLifecycleError("当前规格未通过技术预检，不能将用户确认升级为执行授权。")
      }
      const authorization = {
        requestId: event.requestId,
        specId: event.specId,
        revision: event.revision,
        stageFingerprint: event.stageFingerprint,
        decisionMessageId: event.decisionMessageId,
        decidedAt: new Date().toISOString(),
      }
      return next({
        status: "ready",
        authorization,
        specRuns: withSpecRun(state, event.specId, { status: "ready", authorization }),
      })
    }
    case "authorization_requested":
      requireSpec(state, event.specId, event.requestId)
      if (state.status !== "ready" || state.specRevision !== event.revision) {
        throw new AnalysisLifecycleError("只有当前技术就绪且版本匹配的规格可以等待用户授权。")
      }
      requireFingerprint(state, event.stageFingerprint)
      return next({
        status: "waiting_user",
        specStatus: "ready",
        authorization: undefined,
        specRuns: withSpecRun(state, event.specId, { status: "waiting_user", authorization: undefined }),
      })
    case "repair_started":
      requireRequest(state, event.requestId)
      if (!["waiting_user", "failed", "repairing"].includes(state.status)) {
        throw new AnalysisLifecycleError("当前分析状态不允许开始修复。")
      }
      return next({ status: "repairing", issueCode: event.issueCode ?? state.issueCode, authorization: undefined })
    case "repair_stage_created":
      requireRequest(state, event.requestId)
      if (state.status !== "repairing") throw new AnalysisLifecycleError("新数据阶段没有匹配的修复过程。")
      return next({
        status: "diagnosing",
        stageFingerprint: event.stageFingerprint,
        specId: undefined,
        specRevision: undefined,
        methodID: undefined,
        resultId: undefined,
        artifactRefs: undefined,
        resultContractStatus: undefined,
        verifierStatus: undefined,
        authorization: undefined,
      })
    case "execution_started":
      requireSpec(state, event.specId, event.requestId)
      if (state.status !== "ready") throw new AnalysisLifecycleError("当前规格未就绪，不能开始估计。")
      requireFingerprint(state, event.stageFingerprint)
      if (
        !state.authorization ||
        state.authorization.requestId !== event.requestId ||
        state.authorization.specId !== event.specId ||
        state.authorization.revision !== state.specRevision ||
        state.authorization.stageFingerprint !== event.stageFingerprint
      ) {
        throw new AnalysisLifecycleError("当前规格没有匹配的用户执行授权。")
      }
      return next({
        status: "running",
        resultId: undefined,
        artifactRefs: undefined,
        resultContractStatus: undefined,
        verifierStatus: undefined,
        specRuns: withSpecRun(state, event.specId, {
          status: "running",
          resultId: undefined,
          artifactRefs: undefined,
          resultContractStatus: undefined,
          verifierStatus: undefined,
        }),
      })
    case "execution_result":
      requireSpec(state, event.specId, event.requestId)
      if (state.status !== "running") throw new AnalysisLifecycleError("计量结果没有匹配的运行中执行。")
      if (!event.resultId.trim()) throw new AnalysisLifecycleError("空结果标识不能登记为计算结果。")
      return next({
        status: "verifying",
        resultId: event.resultId,
        artifactRefs: [...new Set(event.artifactRefs)].slice(0, 100),
        specRuns: withSpecRun(state, event.specId, {
          status: "verifying",
          resultId: event.resultId,
          artifactRefs: [...new Set(event.artifactRefs)].slice(0, 100),
        }),
      })
    case "result_contract_verified":
      requireSpec(state, event.specId, event.requestId)
      if (state.status !== "verifying" || state.resultId !== event.resultId) {
        throw new AnalysisLifecycleError("结果契约核验没有匹配当前计量结果。")
      }
      if (event.status === "pass" && !state.artifactRefs?.length) {
        throw new AnalysisLifecycleError("没有已登记的结果文件，不能将计量执行标记为完成。")
      }
      return next({
        status: event.status === "pass" ? "completed" : "failed",
        resultContractStatus: event.status,
        specRuns: withSpecRun(state, event.specId, {
          status: event.status === "pass" ? "completed" : "failed",
          resultContractStatus: event.status,
        }),
      })
    case "verification_completed":
      requireRequest(state, event.requestId)
      const verifiedSpec = state.specRuns.find((run) => run.specId === event.specId && run.requestId === event.requestId)
      if (!verifiedSpec || !["verifying", "completed"].includes(verifiedSpec.status) || verifiedSpec.resultId !== event.resultId) {
        throw new AnalysisLifecycleError("核验结果没有匹配当前计量结果。")
      }
      if (verifiedSpec.resultContractStatus !== "pass") {
        throw new AnalysisLifecycleError("结果契约尚未通过，不能登记独立核验完成。")
      }
      {
        const specRuns = withSpecRun(state, event.specId, {
          status: event.status === "block" ? "failed" : "completed",
          verifierStatus: event.status,
        })
        if (state.specId !== event.specId) return next({ specRuns })
        return next({
          status: event.status === "block" ? "failed" : "completed",
          verifierStatus: event.status,
          specRuns,
        })
      }
    case "tool_run_started": {
      const operation = event.operation
      validateToolRunIdentity(state, operation)
      const terminalRequestStates = ["failed", "cancelled", "unconfirmed", "waiting_user"]
      if (terminalRequestStates.includes(state.status)) {
        throw new AnalysisLifecycleError("当前分析请求处于停点，必须先恢复或取得新的用户决定才能开始工具运行。")
      }
      const existing = (state.toolRuns ?? []).find((item) => item.operationId === operation.operationId)
      if (existing) {
        if (!sameToolRunIdentity(existing, operation)) {
          throw new AnalysisLifecycleError("同一工具运行标识对应不同输入或数据阶段，拒绝复用。")
        }
        if (existing.status === "running") {
          throw new AnalysisLifecycleError("该工具调用已经登记为运行中，拒绝重复启动。")
        }
        throw new AnalysisLifecycleError("该工具运行标识已结束，不能再次启动或覆盖。")
      }
      if ((state.toolRuns ?? []).some((item) => item.status === "running")) {
        throw new AnalysisLifecycleError("当前分析请求已有一个工具运行未结束；拒绝并发写入分析状态。")
      }
      const priorRunsForTool = (state.toolRuns ?? []).filter((item) => item.toolID === operation.toolID)
      if (priorRunsForTool.some((item) => item.status === "completed")) {
        throw new AnalysisLifecycleError("当前请求已完成该估计工具；如需重新估计，请登记新请求并重新确认。")
      }
      const priorPartial = [...priorRunsForTool].reverse().find((item) => item.status === "partial")
      if (priorPartial && !(
        operation.toolID === "heterogeneity_runner" &&
        state.status === "spec_pending" &&
        state.decisionApproval?.requestId === operation.requestId &&
        state.decisionApproval.issueCode === "HETEROGENEITY_BATCH_PARTIAL" &&
        state.decisionApproval.stageFingerprint === operation.stageFingerprint &&
        state.decisionApproval.approvedInputFingerprint === operation.inputFingerprint &&
        priorPartial.inputFingerprint === operation.inputFingerprint
      )) {
        throw new AnalysisLifecycleError("部分完成的估计工具必须先确认在相同数据阶段重跑完整规格集；本次输入不在批准范围内。")
      }
      if (!["spec_pending", "ready", "completed"].includes(state.status)) {
        throw new AnalysisLifecycleError("当前分析状态尚未完成诊断或规格准备，不能启动估计工具。")
      }
      const startedAt = new Date().toISOString()
      const startedRun: AnalysisToolRunRecord = {
        ...structuredClone(operation),
        status: "running",
        startedAt,
        updatedAt: startedAt,
      }
      return next({
        status: "running",
        failureCode: undefined,
        issueCode: undefined,
        resultId: undefined,
        artifactRefs: undefined,
        resultContractStatus: undefined,
        verifierStatus: undefined,
        toolRuns: [...(state.toolRuns ?? []), startedRun].slice(-50),
      })
    }
    case "tool_run_recorded": {
      const operation = event.operation
      validateToolRunIdentity(state, operation)
      if (["failed", "cancelled", "unconfirmed"].includes(state.status)) {
        throw new AnalysisLifecycleError("分析请求已进入失败、取消或结果未确认终态，迟到的工具结果不能覆盖该状态。")
      }
      if (operation.status !== "completed" && operation.status !== "partial") {
        throw new AnalysisLifecycleError("工具结果只能登记为完成或部分完成。")
      }
      if (!operation.resultId?.trim() || operation.resultContractStatus !== "pass" ||
          !Array.isArray(operation.artifactRefs) || operation.artifactRefs.length === 0 ||
          !Array.isArray(operation.subResults)) {
        throw new AnalysisLifecycleError("工具批次结果缺少通过核验的结果标识、结构化规格或产物。")
      }
      if (operation.artifactRefs.length > 100 || operation.subResults.length > 500 ||
          operation.artifactRefs.some((artifact) => typeof artifact !== "string" || !artifact.trim() || artifact.length > 2048) ||
          new Set(operation.subResults.map((item) => item?.specId)).size !== operation.subResults.length ||
          operation.subResults.some((item) =>
            !item || typeof item.specId !== "string" || !item.specId.trim() ||
            !["heterogeneity", "mechanism", "placebo", "alternative_spec"].includes(item.specType) ||
            !["success", "failed", "skipped"].includes(item.status),
      )) {
        throw new AnalysisLifecycleError("工具批次产物或子规格超出账本上限。")
      }
      if (state.decisionApproval?.requestId === operation.requestId &&
          state.decisionApproval.issueCode === "HETEROGENEITY_BATCH_PARTIAL" &&
          operation.toolID === "heterogeneity_runner") {
        const expectedSpecIDs = state.decisionApproval.approvedSubSpecIDs ?? []
        const actualSpecIDs = operation.subResults.map((item) => item.specId).sort()
        if (
          !expectedSpecIDs.length ||
          state.decisionApproval.approvedInputFingerprint !== operation.inputFingerprint ||
          state.decisionApproval.stageFingerprint !== operation.stageFingerprint ||
          JSON.stringify(actualSpecIDs) !== JSON.stringify(expectedSpecIDs)
        ) {
          throw new AnalysisLifecycleError("异质性重跑结果没有覆盖用户批准的完整规格集或其数据/参数指纹已变化。")
        }
      }
      const allSubResultsSucceeded = operation.toolID === "heterogeneity_runner"
        ? operation.subResults.length > 0 && operation.subResults.every((item) => item.status === "success")
        : operation.subResults.length === 0 && operation.status === "completed"
      if ((operation.status === "completed") !== allSubResultsSucceeded) {
        throw new AnalysisLifecycleError("工具批次状态与逐规格执行结果不一致。")
      }
      const existing = (state.toolRuns ?? []).find((item) => item.operationId === operation.operationId)
      if (!existing) {
        throw new AnalysisLifecycleError("工具结果没有匹配的运行开始记录，不能登记为完成。")
      }
      if (!sameToolRunIdentity(existing, operation)) {
        throw new AnalysisLifecycleError("工具结果与运行开始时的请求、数据或参数指纹不匹配。")
      }
      if (existing.status !== "running") {
        const { updatedAt: _existingUpdatedAt, startedAt: _existingStartedAt, ...existingRecord } = existing
        const { updatedAt: _incomingUpdatedAt, startedAt: _incomingStartedAt, ...incomingRecord } = operation
        if (JSON.stringify(existingRecord) !== JSON.stringify(incomingRecord)) {
          throw new AnalysisLifecycleError("已结束的工具运行不能被不同结果覆盖。")
        }
        return state
      }
      if (state.status !== "running") {
        throw new AnalysisLifecycleError("工具结果没有匹配当前运行中的分析状态。")
      }
      const toolRuns = (state.toolRuns ?? []).map((item) => item.operationId === operation.operationId
        ? {
            ...item,
            ...structuredClone(operation),
            artifactRefs: [...new Set(operation.artifactRefs!)].slice(0, 100),
            subResults: operation.subResults!.slice(0, 500).map((result) => ({ ...result })),
            updatedAt: new Date().toISOString(),
          }
        : item)
      return next({
        status: operation.status === "completed" ? "completed" : "waiting_user",
        issueCode: operation.status === "partial" ? "HETEROGENEITY_BATCH_PARTIAL" : undefined,
        decisionApproval: undefined,
        toolRuns,
      })
    }
    case "tool_run_terminated": {
      requireRequest(state, event.requestId)
      const current = (state.toolRuns ?? []).find((item) => item.operationId === event.operationId)
      if (!current) throw new AnalysisLifecycleError("工具终态没有匹配的运行开始记录。")
      if (current.status !== "running") {
        if (current.status === event.outcome && current.failureCode === event.failureCode) return state
        throw new AnalysisLifecycleError("工具运行已经结束，不能覆盖既有终态。")
      }
      const now = new Date().toISOString()
      return next({
        status: event.outcome,
        failureCode: event.failureCode,
        authorization: undefined,
        decisionApproval: undefined,
        toolRuns: (state.toolRuns ?? []).map((item) => item.operationId === event.operationId
          ? { ...item, status: event.outcome, failureCode: event.failureCode, updatedAt: now }
          : item),
      })
    }
    case "execution_failed":
      requireSpec(state, event.specId, event.requestId)
      if (state.status !== "running") throw new AnalysisLifecycleError("执行失败事件没有匹配的运行中执行。")
      return next({
        status: event.retryable ? "repairing" : "failed",
        failureCode: event.failureCode,
        authorization: event.retryable ? state.authorization : undefined,
        specRuns: withSpecRun(state, event.specId, {
          status: event.retryable ? "repairing" : "failed",
          failureCode: event.failureCode,
          authorization: event.retryable ? state.authorization : undefined,
        }),
      })
    case "execution_unconfirmed":
      requireSpec(state, event.specId, event.requestId)
      if (state.status !== "running") throw new AnalysisLifecycleError("未确认结果事件没有匹配的运行中执行。")
      return next({
        status: "unconfirmed",
        failureCode: event.failureCode,
        authorization: undefined,
        specRuns: withSpecRun(state, event.specId, {
          status: "unconfirmed",
          failureCode: event.failureCode,
          authorization: undefined,
        }),
      })
    case "cancelled":
      requireRequest(state, event.requestId)
      if (["completed", "cancelled"].includes(state.status)) {
        throw new AnalysisLifecycleError("已完成或已取消的分析任务不能再次取消。")
      }
      {
        const currentSpecRun = state.specRuns.find((run) =>
          run.specId === state.specId && run.requestId === event.requestId,
        )
        const preserveCompletedResult = currentSpecRun?.status === "completed" &&
          currentSpecRun.resultContractStatus === "pass"
        const toolOutcome: AnalysisLifecycleStatus = event.outcomeConfirmed ? "cancelled" : "unconfirmed"
        const toolFailureCode = event.failureCode ?? (event.outcomeConfirmed ? "USER_CANCELLED" : "CANCEL_OUTCOME_UNKNOWN")
        return next({
          status: event.outcomeConfirmed ? "cancelled" : "unconfirmed",
          failureCode: event.failureCode,
          authorization: undefined,
          toolRuns: (state.toolRuns ?? []).map((run) => run.status === "running"
            ? { ...run, status: toolOutcome, failureCode: toolFailureCode, updatedAt: new Date().toISOString() }
            : run),
          ...(state.specId && !preserveCompletedResult
            ? { specRuns: withSpecRun(state, state.specId, {
                status: event.outcomeConfirmed ? "cancelled" : "unconfirmed",
                failureCode: event.failureCode,
                authorization: undefined,
              }) }
            : {}),
        })
      }
  }
}
