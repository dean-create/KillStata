import { readDatasetManifest, type DatasetManifest, type DatasetStageRecord } from "./dataset-state"
import { buildExperimentEntries } from "@/tool/analysis-experiment-log"
import { activeOrLatestStage, getActiveWorkflowRun } from "./workflow/state"
import { reduceContextCapsule, type ContextCapsule, type ContextCapsuleInput, type ContextEvidenceRef } from "./context-capsule"

function sourceFingerprint(manifest: DatasetManifest) {
  const importStage = manifest.stages.find((stage) => stage.action === "import")
  const value = importStage?.metadata?.sourceFingerprint
  return typeof value === "string" ? value : undefined
}

/**
 * 数据质量产物自带的结论：data_import 把 blocking_errors / warnings 写进 artifact metadata。
 * 只有这两个字段能证明质检结果，缺失时返回 undefined 让胶囊保持 unknown，不猜 pass。
 */
function qaStatusFromArtifact(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return undefined
  const blocking = metadata.blocking_errors
  const warnings = metadata.warnings
  if (Array.isArray(blocking) && blocking.length > 0) return "block" as const
  if (Array.isArray(warnings) && warnings.length > 0) return "warn" as const
  if (Array.isArray(blocking) || Array.isArray(warnings)) return "pass" as const
  return undefined
}

export function diagnosisForStage(stage: DatasetStageRecord | undefined) {
  const raw = stage?.metadata?.dataDiagnosis
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (
    value.version !== 1 ||
    value.stage_id !== stage?.stageId ||
    typeof value.data_fingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.data_fingerprint)
  ) return undefined
  const issues = Array.isArray(value.issues) ? value.issues : []
  const compatibility = Array.isArray(value.method_compatibility) ? value.method_compatibility : []
  const recommended = Array.isArray(value.recommended_method_ids)
    ? value.recommended_method_ids.filter((item): item is string => typeof item === "string").slice(0, 3)
    : []
  const compatible = compatibility
    .filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).status === "compatible")
    .map((item) => (item as Record<string, unknown>).method_id)
    .filter((item): item is string => typeof item === "string")
    .slice(0, 10)
  return {
    stageId: stage!.stageId,
    dataFingerprint: value.data_fingerprint,
    recommendedMethodIds: recommended,
    compatibleMethodIds: compatible,
    blockingIssueCount: issues.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).severity === "blocking").length,
    warningIssueCount: issues.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).severity === "warning").length,
  }
}

function evidenceForStage(input: {
  manifest: DatasetManifest
  datasetId: string
  stageId?: string
  runId?: string
  branch?: string
}): ContextEvidenceRef[] {
  const stage = input.stageId
    ? input.manifest.stages.find(
        (item) =>
          item.stageId === input.stageId &&
          (!input.branch || item.branch === input.branch) &&
          (!input.runId || !item.runId || item.runId === input.runId),
      )
    : undefined
  const evidence: Array<ContextEvidenceRef | undefined> = [
    stage?.schemaPath
      ? {
          kind: "schema",
          ref: stage.schemaPath,
          datasetId: input.datasetId,
          stageId: stage.stageId,
          runId: stage.runId,
          scope: "full_stage",
          rows: stage.rowCount,
        }
      : undefined,
    stage?.summaryPath
      ? {
          kind: "profile",
          ref: stage.summaryPath,
          datasetId: input.datasetId,
          stageId: stage.stageId,
          runId: stage.runId,
          scope: "full_stage",
          rows: stage.rowCount,
        }
      : undefined,
    stage?.logPath
      ? {
          kind: "diagnostics",
          ref: stage.logPath,
          datasetId: input.datasetId,
          stageId: stage.stageId,
          runId: stage.runId,
          scope: "full_stage",
          rows: stage.rowCount,
        }
      : undefined,
    ...input.manifest.artifacts
      .filter(
        (artifact) =>
          artifact.stageId === input.stageId &&
          (!input.branch || artifact.branch === input.branch) &&
          (!input.runId || !artifact.runId || artifact.runId === input.runId),
      )
      .slice(-12)
      .map((artifact): ContextEvidenceRef => ({
        kind: artifact.action === "validate" ? "validate" : "estimate",
        ref: artifact.outputPath,
        datasetId: input.datasetId,
        stageId: artifact.stageId,
        runId: artifact.runId,
        branch: artifact.branch,
        scope: "full_stage",
        qualityStatus: artifact.action === "validate" ? qaStatusFromArtifact(artifact.metadata) : undefined,
      })),
  ]
  return evidence.filter((item): item is ContextEvidenceRef => Boolean(item))
}

function buildContextCapsuleInput(sessionID: string): ContextCapsuleInput | undefined {
  const run = getActiveWorkflowRun(sessionID)
  if (!run?.datasetId) return undefined

  // 压缩可能发生在导入中断、清理或测试会话收尾之后；工作流断点是辅助恢复信息，
  // 找不到对应 manifest 时不能让整个对话/压缩流程崩溃。下一轮仍会从新的数据导入
  // 或有效 checkpoint 重新建立胶囊。
  let manifest: DatasetManifest
  try {
    manifest = readDatasetManifest(run.datasetId)
  } catch {
    return undefined
  }
  const activeStage = activeOrLatestStage(run)
  const branch = activeStage?.branch ?? run.branch
  const stage = activeStage
    ? manifest.stages.find(
        (item) =>
          item.stageId === activeStage.stageId &&
          item.branch === activeStage.branch &&
          (!activeStage.runId || !item.runId || item.runId === activeStage.runId),
      )
    : undefined
  const attempts = buildExperimentEntries(manifest).filter(
    (entry) =>
      entry.stageId === stage?.stageId &&
      (!stage?.branch || !entry.branch || entry.branch === stage.branch) &&
      (!run.runId || !entry.runId || entry.runId === run.runId),
  )
  const evidence = evidenceForStage({
    manifest,
    datasetId: run.datasetId,
    stageId: stage?.stageId,
    runId: run.runId,
    branch,
  })

  return {
    dataset: {
      datasetId: run.datasetId,
      sourceFormat: manifest.sourceFormat,
      sourcePath: manifest.sourcePath,
      sourceFingerprint: sourceFingerprint(manifest),
      updatedAt: manifest.updatedAt,
      panelIdentifiers: manifest.panelIdentifiers,
      origin: manifest.origin?.sessionID === sessionID ? manifest.origin : undefined,
    },
    workflow: {
      workflowRunId: run.workflowRunId,
      datasetId: run.datasetId,
      runId: run.runId,
      branch: run.branch,
      activeStageKind: run.activeStage,
      activeNode: activeStage
        ? {
            nodeId: activeStage.nodeId,
            stageId: activeStage.stageId,
            branch: activeStage.branch,
            kind: activeStage.kind,
            status: activeStage.status,
            runId: activeStage.runId,
          }
        : undefined,
      repairOnly: run.repairOnly,
      latestFailureCode: run.latestFailure?.code,
      latestVerifierStatus: run.latestVerifier?.status,
      trustedArtifacts: run.trustedArtifacts,
      checklist: run.analysisChecklist.map((item) => `${item.label}: ${item.status}`),
    },
    datasetStage: stage,
    diagnosis: diagnosisForStage(stage),
    attempts,
    evidence,
    sideEffectReceipts: run.stages
      .filter((item) => item.branch === branch && item.executionMode === "reuse")
      .map((item) => `${item.kind}:${item.stageId}:reused`),
    capturedAt: new Date().toISOString(),
  }
}

export function buildContextCapsule(sessionID: string): ContextCapsule | undefined {
  const input = buildContextCapsuleInput(sessionID)
  return input ? reduceContextCapsule(input) : undefined
}
