import crypto from "crypto"
import type { DatasetManifest, DatasetStageRecord } from "./dataset-state"
import type { ExperimentEntry } from "@/tool/analysis-experiment-log"
import type { StageFailureCode, StageStatus, WorkflowStageKind } from "./types"
import { serializeForTokenEstimate } from "./context-budget"
import { Token } from "@/util/token"
import { workflowStageLabel } from "./workflow-locale"

export type PopulationScope = "full_stage" | "analysis_sample" | "window" | "unknown"
export type QualityGateStatus = "pass" | "warn" | "block" | "unknown"

export type ContextEvidenceRef = {
  kind: "schema" | "profile" | "validate" | "numeric" | "diagnostics" | "estimate" | "experiment-log" | "tool-output"
  ref: string
  datasetId?: string
  stageId?: string
  runId?: string
  branch?: string
  scope: PopulationScope
  qualityStatus?: QualityGateStatus
  rows?: number
  rowsUsed?: number
  contentHash?: string
}

export type ObservedSpecification = {
  method: string
  effectiveMethod?: string
  dependentVar?: string
  treatmentVar?: string
  covariates: string[]
  entityVar?: string
  timeVar?: string
  clusterVar?: string
  stageId?: string
  rowsUsed?: number
  source: "manifest-artifact" | "experiment-entry"
}

export type ContextCapsuleInput = {
  // 仅由 adapter 提供的已解析事实；reducer 不负责 I/O 或猜测当前 stage。

  dataset?: {
    datasetId: string
    sourceFormat?: DatasetManifest["sourceFormat"]
    sourcePath?: string
    sourceFingerprint?: string
    updatedAt?: string
    panelIdentifiers?: DatasetManifest["panelIdentifiers"]
    origin?: DatasetManifest["origin"]
  }
  workflow?: {
    workflowRunId: string
    datasetId?: string
    runId?: string
    branch: string
    activeStageKind?: WorkflowStageKind
    activeNode?: {
      nodeId: string
      stageId: string
      branch: string
      kind: WorkflowStageKind
      status: StageStatus
      runId?: string
    }
    repairOnly?: boolean
    latestFailureCode?: StageFailureCode
    latestVerifierStatus?: "pass" | "warn" | "block"
    trustedArtifacts: string[]
    checklist: string[]
  }
  datasetStage?: DatasetStageRecord
  diagnosis?: {
    stageId: string
    dataFingerprint?: string
    recommendedMethodIds: string[]
    compatibleMethodIds: string[]
    blockingIssueCount: number
    warningIssueCount: number
  }
  attempts: ExperimentEntry[]
  evidence: ContextEvidenceRef[]
  sideEffectReceipts: string[]
  capturedAt: string
}

export type ContextCapsule = {
  version: 1
  capsuleHash: string
  capturedAt: string
  dataIdentity?: {
    datasetId: string
    sourceFormat?: DatasetManifest["sourceFormat"]
    sourceFingerprint?: string
    conversation?: {
      messageID: string
      attachmentPartID?: string
    }
  }
  population: {
    scope: PopulationScope
    datasetId?: string
    stageId?: string
    parentStageId?: string
    branch?: string
    rowCount?: number
    rowsUsed?: number
  }
  qualityGate: {
    status: QualityGateStatus
    stageId?: string
    reason?: string
  }
  diagnosis?: {
    stageId: string
    dataFingerprint?: string
    recommendedMethodIds: string[]
    compatibleMethodIds: string[]
    blockingIssueCount: number
    warningIssueCount: number
  }
  panel: {
    entityVar?: string
    timeVar?: string
    status: "declared" | "not_declared" | "unknown"
  }
  identification: {
    status: "unknown"
    reason: "no_persisted_contract"
    observedSpecifications: ObservedSpecification[]
  }
  workflow: {
    workflowRunId?: string
    runId?: string
    branch?: string
    activeStageKind?: WorkflowStageKind
    repairOnly?: boolean
    latestFailureCode?: StageFailureCode
    latestVerifierStatus?: "pass" | "warn" | "block"
    checklist: string[]
  }
  trustedEvidence: ContextEvidenceRef[]
  experiment: {
    totalAttempts: number
    stageAttempts: number
    latestMethod?: string
    latestStageId?: string
    latestRowsUsed?: number
    significantCount: number
  }
  sideEffectReceipts: string[]
  conflicts: string[]
  tokenEstimate: number
}

function digest(serialized: string) {
  return crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 16)
}

function capsuleDigest(value: unknown) {
  return digest(serializeForTokenEstimate(value))
}

function finiteNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function observedSpecification(entry: ExperimentEntry): ObservedSpecification {
  return {
    method: entry.method,
    effectiveMethod: entry.effectiveMethod,
    dependentVar: entry.dependentVar,
    treatmentVar: entry.treatmentVar,
    covariates: [...(entry.covariates ?? [])].sort(),
    entityVar: entry.entityVar,
    timeVar: entry.timeVar,
    clusterVar: entry.clusterVar,
    stageId: entry.stageId,
    rowsUsed: finiteNumber(entry.rowsUsed),
    source: "experiment-entry",
  }
}

export function reduceContextCapsule(input: ContextCapsuleInput): ContextCapsule {
  const conflicts: string[] = []
  const workflowDataset = input.workflow?.datasetId
  const datasetId = input.dataset?.datasetId
  if (workflowDataset && datasetId && workflowDataset !== datasetId) {
    conflicts.push(`dataset_mismatch:${workflowDataset}:${datasetId}`)
  }

  const activeNode = input.workflow?.activeNode
  const stage = input.datasetStage
  if (activeNode && stage && (activeNode.stageId !== stage.stageId || activeNode.branch !== stage.branch)) {
    conflicts.push(`stage_mismatch:${activeNode.stageId}/${activeNode.branch}:${stage.stageId}/${stage.branch}`)
  }
  if (activeNode?.runId && input.workflow?.runId && activeNode.runId !== input.workflow.runId) {
    conflicts.push(`run_mismatch:${activeNode.runId}:${input.workflow.runId}`)
  }

  const stageAttempts = input.attempts.filter(
    (entry) => Boolean(stage?.stageId) && entry.stageId === stage?.stageId,
  )
  const latest = stageAttempts.at(-1) ?? (stage ? undefined : input.attempts.at(-1))
  const stageEvidence = input.evidence.filter((entry) => {
    if (stage?.stageId && entry.stageId && entry.stageId !== stage.stageId) return false
    if (stage?.branch && entry.branch && entry.branch !== stage.branch) return false
    if (input.workflow?.runId && entry.runId && entry.runId !== input.workflow.runId) return false
    return true
  })
  const qualityEvidence = stageEvidence.find((entry) => entry.kind === "validate")
  // 只有证据自己声明结论才采信。存在 数据质量产物不等于 数据质量检查通过：把"有产物"当成 pass
  // 会让阻断级质检在胶囊里显示为已通过，这是计量门禁不能接受的乐观默认。
  const qualityStatus: QualityGateStatus = activeNode?.status === "blocked" || input.workflow?.latestFailureCode === "VALIDATE_BLOCKED"
    ? "block"
    : qualityEvidence?.qualityStatus ?? "unknown"

  const population = {
    scope: latest?.rowsUsed !== undefined && stage?.rowCount !== undefined && latest.rowsUsed !== stage.rowCount
      ? ("analysis_sample" as const)
      : (stage ? ("full_stage" as const) : ("unknown" as const)),
    datasetId: datasetId ?? workflowDataset,
    stageId: stage?.stageId ?? activeNode?.stageId,
    parentStageId: stage?.parentStageId,
    branch: stage?.branch ?? activeNode?.branch ?? input.workflow?.branch,
    rowCount: finiteNumber(stage?.rowCount),
    rowsUsed: finiteNumber(latest?.rowsUsed),
  }

  const observed = input.attempts.slice(-8).map(observedSpecification)
  const experiment = {
    totalAttempts: input.attempts.length,
    stageAttempts: stageAttempts.length,
    latestMethod: latest?.effectiveMethod ?? latest?.method,
    latestStageId: latest?.stageId,
    latestRowsUsed: finiteNumber(latest?.rowsUsed),
    significantCount: input.attempts.filter((entry) => finiteNumber(entry.pValue) !== undefined && entry.pValue! < 0.05).length,
  }

  const capsuleWithoutHash = {
    version: 1 as const,
    capturedAt: input.capturedAt,
    dataIdentity: input.dataset
      ? {
          datasetId: input.dataset.datasetId,
          sourceFormat: input.dataset.sourceFormat,
          sourceFingerprint: input.dataset.sourceFingerprint ?? (input.dataset.sourcePath ? capsuleDigest(input.dataset.sourcePath) : undefined),
          conversation: input.dataset.origin?.messageID
            ? {
                messageID: input.dataset.origin.messageID,
                attachmentPartID: input.dataset.origin.attachmentPartID,
              }
            : undefined,
        }
      : undefined,
    population,
    qualityGate: {
      status: qualityStatus,
      stageId: qualityEvidence?.stageId ?? population.stageId,
      reason: input.workflow?.latestFailureCode,
    },
    diagnosis: input.diagnosis,
    panel: {
      entityVar: input.dataset?.panelIdentifiers?.entityVar,
      timeVar: input.dataset?.panelIdentifiers?.timeVar,
      status: input.dataset?.panelIdentifiers ? ("declared" as const) : ("not_declared" as const),
    },
    identification: {
      status: "unknown" as const,
      reason: "no_persisted_contract" as const,
      observedSpecifications: observed,
    },
    workflow: {
      workflowRunId: input.workflow?.workflowRunId,
      runId: input.workflow?.runId,
      branch: input.workflow?.branch,
      activeStageKind: input.workflow?.activeStageKind,
      repairOnly: input.workflow?.repairOnly,
      latestFailureCode: input.workflow?.latestFailureCode,
      latestVerifierStatus: input.workflow?.latestVerifierStatus,
      checklist: input.workflow?.checklist.slice(0, 8) ?? [],
    },
    trustedEvidence: stageEvidence.slice(-12),
    experiment,
    sideEffectReceipts: input.sideEffectReceipts.slice(-20),
    conflicts,
    tokenEstimate: 0,
  }
  // 捕获时间只用于诊断，不属于模型上下文身份；把它纳入 hash 会让每轮 cache 前缀无条件变化。
  const { capturedAt: _capturedAt, ...hashable } = capsuleWithoutHash
  const serialized = serializeForTokenEstimate(hashable)
  return {
    ...capsuleWithoutHash,
    tokenEstimate: Token.estimate(serialized),
    capsuleHash: digest(serialized),
  }
}

export function renderContextCapsule(capsule: ContextCapsule) {
  const sourceFormat = capsule.dataIdentity?.sourceFormat?.toUpperCase()
  const sourceDescription = capsule.dataIdentity
    ? capsule.dataIdentity.conversation
      ? "本会话上传的工作簿"
      : "本会话已关联当前数据集"
    : "未关联数据集"
  const evidenceKinds = [...new Set(capsule.trustedEvidence.map((entry) => entry.kind))]
  const conflictDescriptions = capsule.conflicts.map((conflict) => {
    if (conflict.startsWith("dataset_mismatch:")) return "数据集状态存在冲突"
    if (conflict.startsWith("stage_mismatch:")) return "数据阶段状态存在冲突"
    if (conflict.startsWith("run_mismatch:")) return "运行状态存在冲突"
    return "存在未分类的状态冲突"
  })
  const lines = [
    "<context-capsule>",
    `数据来源：${sourceDescription}${sourceFormat ? `（${sourceFormat}）` : ""}`,
    `样本范围：${capsule.population.scope} / rows=${capsule.population.rowCount ?? "?"} / rowsUsed=${capsule.population.rowsUsed ?? "?"}`,
    `数据质量状态：${capsule.qualityGate.status}`,
    capsule.diagnosis
      ? `上传诊断：推荐=${capsule.diagnosis.recommendedMethodIds.join(",") || "无"}; 可适配=${capsule.diagnosis.compatibleMethodIds.length}; 阻断=${capsule.diagnosis.blockingIssueCount}; 提醒=${capsule.diagnosis.warningIssueCount}`
      : "上传诊断: unknown",
    `面板: ${capsule.panel.status}${capsule.panel.entityVar ? ` entity=${capsule.panel.entityVar}` : ""}${capsule.panel.timeVar ? ` time=${capsule.panel.timeVar}` : ""}`,
    `识别契约: unknown; observed_specs=${capsule.identification.observedSpecifications.length}`,
    `工作流阶段：${workflowStageLabel("zh-CN", capsule.workflow.activeStageKind) ?? "未知"}; 独立核验=${capsule.workflow.latestVerifierStatus ?? "unknown"}`,
    `已试设定: total=${capsule.experiment.totalAttempts} stage=${capsule.experiment.stageAttempts} latest=${capsule.experiment.latestMethod ?? "none"} significant=${capsule.experiment.significantCount}`,
    capsule.trustedEvidence.length ? `可信证据类别：${evidenceKinds.join("、")}（${capsule.trustedEvidence.length} 项）` : "可信证据：无",
    conflictDescriptions.length ? `状态冲突：${[...new Set(conflictDescriptions)].join("、")}` : "状态冲突：无",
    "</context-capsule>",
  ]
  return lines.filter((line): line is string => Boolean(line)).join("\n")
}
