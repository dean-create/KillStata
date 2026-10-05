/**
 * `runtime/workflow` 的公开门面。
 *
 * 原先是一个 3190 行、35 个导出的单文件，同时是状态机 + 策略引擎 + 工具映射表。
 * 拆分后这里逐一重新导出**完全相同的公开符号**，所以下游 import 路径与写法都不用改。
 * 新代码请直接从具体子模块导入，别再往这个门面加东西。
 */

export {
  canonicalDataStageForWorkflow,
  datasetStageSnapshot,
  getActiveWorkflowRun,
  isAnalysisWorkflowActive,
  latestFailedStage,
  readWorkflowSession,
  restoreWorkflowCheckpoint,
  workflowArtifactList,
  workflowStageDetails,
  workflowStatusSummary,
  workflowTaskLedger,
  writeWorkflowSession,
} from "./state"

export {
  filterVerifierReadableArtifactRefs,
  isVerifierReadableArtifactRef,
  isWorkflowArtifactRef,
  resolveArtifactPathForRead,
  sanitizeVerifierPromptMetadata,
} from "./artifact"

export {
  applyRepairHandler,
  assertDatasetStageReadyForEstimation,
  assertDatasetStageReadyForPreprocess,
  ensureAnalysisPlan,
  formatAnalysisChecklist,
  recommendedSkillBundle,
  recordWorkflowStageFailure,
  recordWorkflowStageSuccess,
  setAnalysisPlanApproval,
  workflowPromptSummary,
} from "./stage"

export {
  buildRerunPlan,
  buildVerifierReport,
  deferAutomaticVerifier,
  executeRerunPlan,
  flushDeferredAutomaticVerifiers,
  resumePendingAutomaticVerifiers,
  runAutomaticVerifier,
  runVerifierGate,
} from "./rerun"

export { stageNeedsVerifier } from "./state"

export {
  allowMcpToolForWorkflow,
  explainMcpToolForWorkflow,
  filterToolsForWorkflow,
  resolveToolAvailability,
  workflowToolPolicy,
} from "./exposure"
