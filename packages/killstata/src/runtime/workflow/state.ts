import fs from "fs"
import path from "path"
import type { AnalysisChecklistItem, RestoreTarget, StageNode, WorkflowRun, WorkflowStageKind } from "../types"
import { Bus } from "@/bus"
import { RuntimeEvents } from "../events"
import { RuntimeProtocol } from "../protocol"
import { RuntimeTaskLedger } from "../task-ledger"
import { getStage, projectStateRoot, readDatasetManifest } from "@/runtime/dataset-state"
import { workflowChecklistLabel, workflowChecklistStatusLabel, workflowLocaleLabel } from "../workflow-locale"

/**
 * 工作流会话状态：读写落盘的 workflow run，以及基于它的只读查询。
 *
 * 这是最底层：其余四个模块都可以依赖它，它不依赖任何一个（由拆分脚本的不动点
 * 算法保证，改动时请维持这个方向，否则会出现模块环）。
 */

export type WorkflowSessionState = {
  version: 1
  sessionID: string
  activeRunId?: string
  runs: WorkflowRun[]
}

export const DEFAULT_STAGE_SEQUENCE: WorkflowStageKind[] = [
  "healthcheck",
  "import",
  "profile_or_schema_check",
  "validate",
  "preprocess_or_filter",
  "profile_or_diagnostics",
  "baseline_estimate",
  "verifier",
  "report",
]

export const ANALYSIS_CHECKLIST_TEMPLATE = [
  { id: "data_readiness" },
  { id: "identification" },
  { id: "baseline_model" },
  { id: "diagnostics" },
  { id: "reporting" },
] as const satisfies ReadonlyArray<Pick<AnalysisChecklistItem, "id">>

export const AUTO_VERIFY_STAGES = new Set<WorkflowStageKind>([
  "import",
  "validate",
  "preprocess_or_filter",
  "baseline_estimate",
])

export function nowIso() {
  return new Date().toISOString()
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

export function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function latestStageByKinds(run: WorkflowRun | undefined, kinds: WorkflowStageKind[]) {
  if (!run) return undefined
  const wanted = new Set(kinds)
  return [...run.stages].reverse().find((stage) => wanted.has(stage.kind))
}

/** 最近一个 kind 不在排除集里的 stage。exposure 的多轮"继续分析"锚点用它排除
 * 收尾类（verifier/report），避免与 activeOrLatestStage 各自维护"哪些是收尾"的
 * 集合漂移（2026-08-12 simplify）。 */
export function latestStageExcludingKinds(run: WorkflowRun | undefined, excluded: WorkflowStageKind[]) {
  if (!run) return undefined
  const skip = new Set(excluded)
  return [...run.stages].reverse().find((stage) => !skip.has(stage.kind))
}

function latestStageForChecklist(
  run: WorkflowRun | undefined,
  itemID: AnalysisChecklistItem["id"],
): StageNode | undefined {
  switch (itemID) {
    case "data_readiness":
      return latestStageByKinds(run, [
        "healthcheck",
        "import",
        "profile_or_schema_check",
        "validate",
        "preprocess_or_filter",
        "profile_or_diagnostics",
      ])
    case "identification":
      return latestStageByKinds(run, ["baseline_estimate", "verifier", "report"])
    case "baseline_model":
      return latestStageByKinds(run, ["baseline_estimate", "verifier", "report"])
    case "diagnostics":
      return latestStageByKinds(run, ["verifier", "report"])
    case "reporting":
      return latestStageByKinds(run, ["report"])
  }
}

function checklistStatusForDataReadiness(run: WorkflowRun): AnalysisChecklistItem["status"] {
  const prepStages = run.stages.filter((stage) =>
    [
      "healthcheck",
      "import",
      "profile_or_schema_check",
      "validate",
      "preprocess_or_filter",
      "profile_or_diagnostics",
    ].includes(stage.kind),
  )
  // 只有**仍未被修好**的失败才算阻断。此前这里扫描全历史、任一 blocked/failed 即永久
  // 返回 blocked：真实会话（2026-08-28 did.xlsx）里早期 profile 被判阻断、一次
  // preprocess 失败，之后 validate 已经成功，checklist 仍永久停在 blocked，模型每轮
  // 被告知“数据未就绪”，重跑多少次画像都翻不了案。
  // 判定改为按 kind 分组取**最新**状态：同一环节后来成功了，就不该被历史失败钉住。
  const latestStatusByKind = new Map<string, StageNode["status"]>()
  for (const stage of prepStages) latestStatusByKind.set(stage.kind, stage.status)
  if ([...latestStatusByKind.values()].some((status) => status === "blocked" || status === "failed")) return "blocked"
  if (
    prepStages.some((stage) => stage.kind === "profile_or_diagnostics" && stage.status === "completed") ||
    run.stages.some((stage) => ["baseline_estimate", "verifier", "report"].includes(stage.kind))
  ) {
    return "completed"
  }
  if (
    prepStages.some((stage) => stage.status === "completed" || stage.status === "running") ||
    [
      "healthcheck",
      "import",
      "profile_or_schema_check",
      "validate",
      "preprocess_or_filter",
      "profile_or_diagnostics",
    ].includes(run.activeStage ?? "")
  ) {
    return "in_progress"
  }
  return "pending"
}

function checklistSummary(run: WorkflowRun, itemID: AnalysisChecklistItem["id"]) {
  const locale = run.workflowLocale
  const stage = latestStageForChecklist(run, itemID)
  if (itemID === "data_readiness") {
    if (run.datasetId && stage?.stageId) {
      return locale === "zh-CN"
        ? `复用 ${run.datasetId} / ${stage.stageId}`
        : `Reusing ${run.datasetId} / ${stage.stageId}`
    }
    if (run.datasetId) return locale === "zh-CN" ? `当前数据集：${run.datasetId}` : `Current dataset: ${run.datasetId}`
    return stage
      ? locale === "zh-CN"
        ? `最近准备阶段：${stage.stageId}`
        : `Latest prep stage: ${stage.stageId}`
      : locale === "zh-CN"
        ? "等待导入与 数据质量检查"
        : "Waiting for import and 数据质量检查"
  }
  if (itemID === "identification") {
    const baselineStage = latestStageByKinds(run, ["baseline_estimate"])
    if (baselineStage?.replayInput) {
      const dependentVar =
        typeof baselineStage.replayInput["dependentVar"] === "string"
          ? baselineStage.replayInput["dependentVar"]
          : undefined
      const treatmentVar =
        typeof baselineStage.replayInput["treatmentVar"] === "string"
          ? baselineStage.replayInput["treatmentVar"]
          : undefined
      if (dependentVar || treatmentVar) {
        return [dependentVar ? `Y=${dependentVar}` : undefined, treatmentVar ? `T=${treatmentVar}` : undefined]
          .filter(Boolean)
          .join(", ")
      }
    }
    return run.approvalStatus === "required"
      ? locale === "zh-CN"
        ? "等待执行审批"
        : "Waiting for execution approval"
      : locale === "zh-CN"
        ? "需要明确核心变量与识别策略"
        : "Need core variables and identification strategy"
  }
  if (itemID === "baseline_model") {
    return stage
      ? `${stage.stageId} (${workflowChecklistStatusLabel(locale, stage.status === "running" ? "in_progress" : stage.status === "completed" ? "completed" : stage.status === "blocked" || stage.status === "failed" ? "blocked" : "pending")})`
      : locale === "zh-CN"
        ? "基准模型尚未运行"
        : "Baseline model has not run yet"
  }
  if (itemID === "diagnostics") {
    if (run.latestVerifier?.status) {
      return locale === "zh-CN"
        ? `核验器=${workflowLocaleLabel(locale, {
            en: run.latestVerifier.status,
            zh: run.latestVerifier.status === "pass" ? "通过" : run.latestVerifier.status === "warn" ? "警告" : "阻塞",
          })}`
        : `verifier=${run.latestVerifier.status}`
    }
    return stage
      ? `${stage.stageId} (${workflowChecklistStatusLabel(locale, stage.status === "running" ? "in_progress" : stage.status === "completed" ? "completed" : stage.status === "blocked" || stage.status === "failed" ? "blocked" : "pending")})`
      : locale === "zh-CN"
        ? "诊断与稳健性检查尚未运行"
        : "Diagnostics and robustness checks have not run yet"
  }
  return stage
    ? `${stage.stageId} (${workflowChecklistStatusLabel(locale, stage.status === "running" ? "in_progress" : stage.status === "completed" ? "completed" : stage.status === "blocked" || stage.status === "failed" ? "blocked" : "pending")})`
    : locale === "zh-CN"
      ? "带依据的结果报告尚未生成"
      : "Grounded report has not been generated yet"
}

function workflowChecklistSummary(run: WorkflowRun, itemID: AnalysisChecklistItem["id"]) {
  const locale = run.workflowLocale
  const stage = latestStageForChecklist(run, itemID)
  if (itemID === "data_readiness") {
    if (run.datasetId && stage?.stageId) {
      return locale === "zh-CN"
        ? `复用 ${run.datasetId} / ${stage.stageId}`
        : `Reusing ${run.datasetId} / ${stage.stageId}`
    }
    if (run.datasetId) return locale === "zh-CN" ? `当前数据集：${run.datasetId}` : `Current dataset: ${run.datasetId}`
    return stage
      ? locale === "zh-CN"
        ? `最近准备阶段：${stage.stageId}`
        : `Latest prep stage: ${stage.stageId}`
      : locale === "zh-CN"
        ? "等待导入与 数据质量检查"
        : "Waiting for import and 数据质量检查"
  }
  if (itemID === "identification") {
    const baselineStage = latestStageByKinds(run, ["baseline_estimate"])
    if (baselineStage?.replayInput) {
      const dependentVar =
        typeof baselineStage.replayInput["dependentVar"] === "string"
          ? baselineStage.replayInput["dependentVar"]
          : undefined
      const treatmentVar =
        typeof baselineStage.replayInput["treatmentVar"] === "string"
          ? baselineStage.replayInput["treatmentVar"]
          : undefined
      if (dependentVar || treatmentVar) {
        return [dependentVar ? `Y=${dependentVar}` : undefined, treatmentVar ? `T=${treatmentVar}` : undefined]
          .filter(Boolean)
          .join(", ")
      }
    }
    return run.approvalStatus === "required"
      ? locale === "zh-CN"
        ? "等待执行审批"
        : "Waiting for execution approval"
      : locale === "zh-CN"
        ? "需要明确核心变量与识别策略"
        : "Need core variables and identification strategy"
  }
  if (itemID === "baseline_model") {
    return stage
      ? `${stage.stageId} (${workflowChecklistStatusLabel(
          locale,
          stage.status === "running"
            ? "in_progress"
            : stage.status === "completed"
              ? "completed"
              : stage.status === "blocked" || stage.status === "failed"
                ? "blocked"
                : "pending",
        )})`
      : locale === "zh-CN"
        ? "基准模型尚未运行"
        : "Baseline model has not run yet"
  }
  if (itemID === "diagnostics") {
    if (run.latestVerifier?.status) {
      return locale === "zh-CN"
        ? `校验器=${workflowLocaleLabel(locale, {
            en: run.latestVerifier.status,
            zh: run.latestVerifier.status === "pass" ? "通过" : run.latestVerifier.status === "warn" ? "警告" : "阻塞",
          })}`
        : `verifier=${run.latestVerifier.status}`
    }
    return stage
      ? `${stage.stageId} (${workflowChecklistStatusLabel(
          locale,
          stage.status === "running"
            ? "in_progress"
            : stage.status === "completed"
              ? "completed"
              : stage.status === "blocked" || stage.status === "failed"
                ? "blocked"
                : "pending",
        )})`
      : locale === "zh-CN"
        ? "诊断与稳健性检查尚未运行"
        : "Diagnostics and robustness checks have not run yet"
  }
  return stage
    ? `${stage.stageId} (${workflowChecklistStatusLabel(
        locale,
        stage.status === "running"
          ? "in_progress"
          : stage.status === "completed"
            ? "completed"
            : stage.status === "blocked" || stage.status === "failed"
              ? "blocked"
              : "pending",
      )})`
    : locale === "zh-CN"
      ? "带依据的结果报告尚未生成"
      : "Grounded report has not been generated yet"
}

function refreshAnalysisChecklist(run: WorkflowRun) {
  const dataReadiness = checklistStatusForDataReadiness(run)
  const baselineStage = latestStageByKinds(run, ["baseline_estimate"])
  const verifierStage = latestStageByKinds(run, ["verifier"])
  const reportStage = latestStageByKinds(run, ["report"])

  const identificationStatus: AnalysisChecklistItem["status"] =
    dataReadiness === "blocked"
      ? "blocked"
      : reportStage || verifierStage || baselineStage
        ? "completed"
        : run.planGeneratedAt
          ? "in_progress"
          : "pending"

  const baselineStatus: AnalysisChecklistItem["status"] =
    baselineStage?.status === "blocked" || baselineStage?.status === "failed"
      ? "blocked"
      : reportStage || verifierStage || (baselineStage && baselineStage.status === "completed")
        ? "completed"
        : run.activeStage === "baseline_estimate"
          ? "in_progress"
          : "pending"

  const diagnosticsStatus: AnalysisChecklistItem["status"] =
    run.latestVerifier?.status === "block" || verifierStage?.status === "blocked" || verifierStage?.status === "failed"
      ? "blocked"
      : reportStage || run.latestVerifier?.status === "pass" || run.latestVerifier?.status === "warn"
        ? "completed"
        : run.activeStage === "verifier"
          ? "in_progress"
          : "pending"

  const reportingStatus: AnalysisChecklistItem["status"] =
    reportStage?.status === "blocked" || reportStage?.status === "failed"
      ? "blocked"
      : reportStage?.status === "completed"
        ? "completed"
        : run.activeStage === "report"
          ? "in_progress"
          : "pending"

  const statusMap: Record<AnalysisChecklistItem["id"], AnalysisChecklistItem["status"]> = {
    data_readiness: dataReadiness,
    identification: identificationStatus,
    baseline_model: baselineStatus,
    diagnostics: diagnosticsStatus,
    reporting: reportingStatus,
  }

  run.analysisChecklist = ANALYSIS_CHECKLIST_TEMPLATE.map((item) => {
    const linkedStage = latestStageForChecklist(run, item.id)
    return {
      id: item.id,
      label: workflowChecklistLabel(run.workflowLocale, item.id),
      status: statusMap[item.id],
      linkedStageId: linkedStage?.stageId,
      summary: workflowChecklistSummary(run, item.id),
    }
  })
}

function currentChecklistItem(run?: WorkflowRun) {
  if (!run) return undefined
  return (
    run.analysisChecklist.find((item) => item.status === "blocked") ??
    run.analysisChecklist.find((item) => item.status === "in_progress") ??
    run.analysisChecklist.find((item) => item.status === "pending")
  )
}

export function refreshWorkflowRunDerivedState(run: WorkflowRun) {
  // 历史运行记录可能保存了英文 locale；刷新时统一迁移为中文界面。
  run.workflowLocale = "zh-CN"
  refreshWorkflowRunGraph(run)
  refreshAnalysisChecklist(run)
  return run
}

function workflowRoot() {
  return path.join(projectStateRoot(), "workflows")
}

function workflowSessionPath(sessionID: string) {
  return path.join(workflowRoot(), `${sessionID}.json`)
}

function ensureWorkflowRoot() {
  fs.mkdirSync(workflowRoot(), { recursive: true })
}

function emptySessionState(sessionID: string): WorkflowSessionState {
  return {
    version: 1,
    sessionID,
    runs: [],
  }
}

export function readWorkflowSession(sessionID: string): WorkflowSessionState {
  ensureWorkflowRoot()
  const filePath = workflowSessionPath(sessionID)
  if (!fs.existsSync(filePath)) return emptySessionState(sessionID)
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<WorkflowSessionState>
  const state: WorkflowSessionState = {
    version: 1,
    sessionID,
    activeRunId: parsed.activeRunId,
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
  }
  state.runs.forEach((run) => refreshWorkflowRunDerivedState(run))
  return state
}

let workflowWriteSequence = 0

export function writeWorkflowSession(state: WorkflowSessionState) {
  ensureWorkflowRoot()
  const target = workflowSessionPath(state.sessionID)
  const temporary = `${target}.tmp-${process.pid}-${++workflowWriteSequence}`
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 })
    fs.renameSync(temporary, target)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* Preserve the original error. */ }
    throw error
  }
}

export function findStage(run: WorkflowRun, stageId: string, branch: string) {
  return run.stages.find((stage) => stage.stageId === stageId && stage.branch === branch)
}

export function upsertStage(run: WorkflowRun, stage: StageNode) {
  const existing = findStage(run, stage.stageId, stage.branch)
  if (existing) {
    Object.assign(existing, stage, { createdAt: existing.createdAt, updatedAt: nowIso() })
    refreshBranchDownstream(run, stage.branch)
    return existing
  }
  run.stages.push(stage)
  refreshBranchDownstream(run, stage.branch)
  return stage
}

export function normalizeArtifactCandidate(value: string) {
  const trimmed = value.trim().replace(/^file:\/\//i, "")
  if (!trimmed) return undefined
  if (/[\r\n]/.test(trimmed)) return undefined
  return trimmed
}

function downstreamKinds(kind: WorkflowStageKind) {
  const index = DEFAULT_STAGE_SEQUENCE.indexOf(kind)
  return index === -1 ? [] : DEFAULT_STAGE_SEQUENCE.slice(index + 1)
}

export function computeKindDownstream(run: WorkflowRun, branch: string, kind: WorkflowStageKind) {
  const downstream = new Set<string>()
  for (const stageKind of downstreamKinds(kind)) {
    for (const stage of run.stages) {
      if (stage.branch === branch && stage.kind === stageKind) downstream.add(stage.stageId)
    }
  }
  return [...downstream]
}

function branchHasDependencyGraph(run: WorkflowRun, branch: string) {
  return run.stages.some(
    (stage) =>
      stage.branch === branch && ((stage.dependsOn?.length ?? 0) > 0 || typeof stage.parentStageId === "string"),
  )
}

export function collectDependentStageIds(run: WorkflowRun, target: StageNode) {
  if (!branchHasDependencyGraph(run, target.branch)) {
    return computeKindDownstream(run, target.branch, target.kind)
  }

  const visited = new Set<string>([target.stageId])
  const ordered: string[] = []
  const queue = [target.stageId]

  while (queue.length > 0) {
    const currentStageId = queue.shift()!
    const dependents = run.stages
      .filter((stage) => {
        if (stage.branch !== target.branch) return false
        if (visited.has(stage.stageId)) return false
        if (stage.parentStageId === currentStageId) return true
        return (stage.dependsOn ?? []).includes(currentStageId)
      })
      .sort((left, right) => {
        const leftIndex = DEFAULT_STAGE_SEQUENCE.indexOf(left.kind)
        const rightIndex = DEFAULT_STAGE_SEQUENCE.indexOf(right.kind)
        return leftIndex - rightIndex || left.createdAt.localeCompare(right.createdAt)
      })

    for (const stage of dependents) {
      visited.add(stage.stageId)
      ordered.push(stage.stageId)
      queue.push(stage.stageId)
    }
  }

  return ordered
}

function refreshBranchDownstream(run: WorkflowRun, branch: string) {
  run.stages
    .filter((stage) => stage.branch === branch)
    .forEach((stage) => {
      stage.downstream = collectDependentStageIds(run, stage)
    })
}

function refreshWorkflowRunGraph(run: WorkflowRun) {
  const branches = [...new Set(run.stages.map((stage) => stage.branch))]
  branches.forEach((branch) => refreshBranchDownstream(run, branch))
  return run
}

export function stageNeedsVerifier(kind: WorkflowStageKind) {
  return AUTO_VERIFY_STAGES.has(kind)
}

export function publishWorkflowState(sessionID: string, run?: WorkflowRun, rerunTargetStageId?: string) {
  const workflow = run ? refreshWorkflowRunDerivedState(run) : getActiveWorkflowRun(sessionID)
  const activeStage = workflow?.activeNodeId
    ? workflow.stages.find((stage) => stage.nodeId === workflow.activeNodeId)
    : activeOrLatestStage(workflow)
  const checklistItem = currentChecklistItem(workflow)
  const payload = {
    sessionID,
    workflowRunId: workflow?.workflowRunId,
    workflowLocale: workflow?.workflowLocale,
    branch: workflow?.branch,
    activeStage: workflow?.activeStage,
    activeStageId: activeStage?.stageId,
    activeCoordinatorAgent: workflow?.activeCoordinatorAgent,
    repairOnly: workflow?.repairOnly ?? false,
    latestFailureCode: workflow?.latestFailure?.code,
    verifierStatus: workflow?.latestVerifier?.status,
    trustedArtifacts: workflow?.trustedArtifacts ?? [],
    rerunTargetStageId,
    approvalStatus: workflow?.approvalStatus,
    currentChecklistItem: checklistItem
      ? {
          id: checklistItem.id,
          label: checklistItem.label,
          status: checklistItem.status,
        }
      : undefined,
    analysisChecklist: workflow?.analysisChecklist ?? [],
  }
  Bus.publish(RuntimeEvents.WorkflowState, payload)
  RuntimeProtocol.publish({
    sessionID,
    source: "workflow",
    type: "workflow.state",
    payload,
  })
  RuntimeTaskLedger.appendEvent({
    sessionID,
    taskId: workflow?.activeTaskId,
    kind: "workflow.state",
    stageId: activeStage?.stageId,
    workflowRunId: workflow?.workflowRunId,
    message: workflow?.activeStage ? `active stage: ${workflow.activeStage}` : "workflow state updated",
    metadata: {
      repairOnly: workflow?.repairOnly ?? false,
      verifierStatus: workflow?.latestVerifier?.status,
      activeCoordinatorAgent: workflow?.activeCoordinatorAgent,
      rerunTargetStageId,
    },
  })
}

export function activeRuntimeTaskId(sessionID: string) {
  return RuntimeTaskLedger.listTasks(sessionID).activeTaskId
}

export function createWorkflowCheckpoint(input: { sessionID: string; run: WorkflowRun; stage?: StageNode }) {
  return RuntimeTaskLedger.createCheckpoint({
    taskId: input.run.activeTaskId ?? activeRuntimeTaskId(input.sessionID),
    sessionID: input.sessionID,
    workflowRunId: input.run.workflowRunId,
    stageId: input.stage?.stageId,
    branch: input.stage?.branch ?? input.run.branch,
    activeStage: input.run.activeStage,
    trustedArtifacts: input.run.trustedArtifacts ?? [],
    verifierStatus: input.run.latestVerifier?.status,
    repairOnly: input.run.repairOnly,
    replayInput: input.stage?.replayInput,
  })
}

export function nextStage(kind: WorkflowStageKind) {
  const index = DEFAULT_STAGE_SEQUENCE.indexOf(kind)
  return index >= 0 ? DEFAULT_STAGE_SEQUENCE[index + 1] : undefined
}

export function activeOrLatestStage(run?: WorkflowRun) {
  if (!run) return undefined
  if (run.activeNodeId) {
    const active = run.stages.find((stage) => stage.nodeId === run.activeNodeId)
    if (active) return active
  }
  return [...run.stages].reverse().find((stage) => stage.kind !== "verifier")
}

/**
 * 把工作流节点解析成当前真正可供数据工具和估计器消费的 canonical dataset stage。
 * 模型不应抄写 datasetId/stageId；所有调用方都从这里取得会话权威血缘。
 */
export function canonicalDataStageForWorkflow(run: WorkflowRun, activeStage = activeOrLatestStage(run)) {
  if (!run.datasetId) return null
  const nodes = [
    activeStage,
    activeStage?.parentStageId
      ? run.stages.find((stage) => stage.stageId === activeStage.parentStageId && stage.branch === activeStage.branch)
      : undefined,
    ...[...run.stages].reverse().filter((stage) => stage.branch === run.branch && stage.kind !== "verifier" && stage.kind !== "report"),
  ].filter((stage, index, all): stage is StageNode => Boolean(stage) && all.indexOf(stage) === index)
  for (const node of nodes) {
    const metadata = normalizeRecord(node.metadata)
    const replayInput = normalizeRecord(node.replayInput)
    const candidates = [metadata.targetStageId, metadata.stageId, replayInput.stageId, node.stageId]
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue
      try {
        const { stage } = datasetStageSnapshot(run.datasetId, candidate)
        if (stage.branch !== run.branch) continue
        return {
          datasetId: run.datasetId,
          stageId: stage.stageId,
          usage: "传给 data_import、data_preprocess 和计量估计工具",
        }
      } catch {}
    }
  }
  return null
}

export function requestedStage(run: WorkflowRun | undefined, stageId?: string) {
  if (!run || !stageId) return undefined
  return run.stages.find((stage) => stage.stageId === stageId || stage.nodeId === stageId)
}

export function getActiveWorkflowRun(sessionID: string) {
  const session = readWorkflowSession(sessionID)
  if (!session.activeRunId) return session.runs.at(-1)
  return session.runs.find((run) => run.workflowRunId === session.activeRunId) ?? session.runs.at(-1)
}

// 分析是否已越过数据准备、进入分析链（预处理/诊断/估计/验证/报告）。validate 及更早都还在
// 数据就绪阶段，不算。用于意图分类兜底：分析进行中时，缺少回归关键词的延续性推进消息
// （“怎么不动了”“接着做”“再跑一次”）若被降级到 ingest，estimator 工具会被
// resolveToolAvailability 的 stage∩intent 收窄挡在门外，造成“工具调用中途消失”死锁。
// 此时应保持 analysis 意图，由 stage 决定实际暴露的工具（stage 仍是数据准备阶段就只给
// data_import，进入估计阶段才给 estimator），既不过度暴露也不再死锁。
const ANALYSIS_ACTIVE_STAGES = new Set<WorkflowStageKind>([
  "preprocess_or_filter",
  "profile_or_diagnostics",
  "baseline_estimate",
  "verifier",
  "report",
])

export function isAnalysisWorkflowActive(sessionID: string): boolean {
  try {
    const run = getActiveWorkflowRun(sessionID)
    return run?.activeStage != null && ANALYSIS_ACTIVE_STAGES.has(run.activeStage)
  } catch {
    return false
  }
}

export function latestFailedStage(sessionID: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) return undefined
  return [...run.stages].reverse().find((stage) => stage.status === "failed" || stage.status === "blocked")
}

export function workflowStatusSummary(sessionID: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) {
    return {
      sessionID,
      workflow: null,
      activeStage: null,
      failedStage: null,
      currentChecklistItem: null,
    }
  }
  const activeStage =
    (run.activeNodeId ? run.stages.find((stage) => stage.nodeId === run.activeNodeId) : undefined) ??
    activeOrLatestStage(run)
  return {
    sessionID,
    workflow: run,
    activeStage,
    failedStage: latestFailedStage(sessionID),
    currentChecklistItem: currentChecklistItem(run) ?? null,
  }
}

export function workflowStageDetails(sessionID: string, stageId?: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) return { workflow: null, stage: null }
  if (stageId && !requestedStage(run, stageId)) {
    return { workflow: run, stage: null }
  }
  const stage =
    requestedStage(run, stageId) ??
    (run.activeNodeId ? run.stages.find((item) => item.nodeId === run.activeNodeId) : undefined) ??
    activeOrLatestStage(run)
  return { workflow: run, stage }
}

export function workflowArtifactList(sessionID: string, stageId?: string) {
  const { workflow, stage } = workflowStageDetails(sessionID, stageId)
  const artifacts = stage ? stage.artifactRefs : stageId ? [] : (workflow?.trustedArtifacts ?? [])
  return {
    workflow,
    stage,
    artifacts,
  }
}

export function workflowTaskLedger(sessionID: string) {
  return RuntimeTaskLedger.listTasks(sessionID)
}

export function restoreWorkflowCheckpoint(sessionID: string, target: RestoreTarget = {}) {
  const resolved = RuntimeTaskLedger.resolveRestoreTarget(sessionID, target)
  if (!resolved.checkpoint) {
    return {
      restored: false,
      reason: target.checkpointId
        ? `Checkpoint not found: ${target.checkpointId}`
        : target.stageId
          ? `No checkpoint found for stage: ${target.stageId}`
          : "No non-blocking checkpoint is available.",
      checkpoint: null,
      workflow: getActiveWorkflowRun(sessionID),
    }
  }

  const sessionState = readWorkflowSession(sessionID)
  const run =
    sessionState.runs.find((item) => item.workflowRunId === resolved.checkpoint?.workflowRunId) ??
    sessionState.runs.at(-1)
  if (!run) {
    return {
      restored: false,
      reason: "Workflow run not found for checkpoint.",
      checkpoint: resolved.checkpoint,
      workflow: null,
    }
  }

  const stage = resolved.checkpoint.stageId
    ? run.stages.find((item) => item.stageId === resolved.checkpoint?.stageId)
    : undefined
  run.activeNodeId = stage?.nodeId ?? run.activeNodeId
  run.activeStage = resolved.checkpoint.activeStage ?? stage?.kind ?? run.activeStage
  run.branch = resolved.checkpoint.branch ?? run.branch
  run.trustedArtifacts = resolved.checkpoint.trustedArtifacts
  run.repairOnly = false
  run.blockedStageId = undefined
  run.activeCoordinatorAgent = "general"
  run.lastRestore = {
    checkpointId: resolved.checkpoint.checkpointId,
    stageId: resolved.checkpoint.stageId,
    restoredAt: nowIso(),
  }
  run.updatedAt = nowIso()
  refreshWorkflowRunDerivedState(run)
  writeWorkflowSession(sessionState)
  RuntimeTaskLedger.recordRestore(sessionID, resolved.checkpoint, run.activeTaskId ?? activeRuntimeTaskId(sessionID))
  publishWorkflowState(sessionID, run)

  return {
    restored: true,
    checkpoint: resolved.checkpoint,
    workflow: run,
    stage,
  }
}

export function datasetStageSnapshot(datasetId: string, stageId?: string) {
  const manifest = readDatasetManifest(datasetId)
  const stage = getStage(manifest, stageId)
  return {
    manifest,
    stage,
  }
}
