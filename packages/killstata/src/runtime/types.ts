import type { LanguageModelUsage, ProviderMetadata } from "ai"
import type { WorkflowLocale } from "./workflow-locale"
import type { ContextUsageSnapshot } from "./context-budget"
import type { ContextCapsule } from "./context-capsule"
import type { FailureDiagnosis } from "./failure-diagnosis"

export type QueuedSessionActionType = "prompt" | "command" | "shell" | "continue" | "retry" | "repair" | "compaction"

export interface QueuedSessionAction {
  id: string
  sessionID: string
  type: QueuedSessionActionType
  priority: number
  createdAt: number
  metadata?: Record<string, unknown>
}

export type QueryLifecyclePhase = "idle" | "accepted" | "dispatching" | "running"

export interface SessionRunState {
  phase: QueryLifecyclePhase
  generation: number
  pending: number
  action?: QueuedSessionActionType
}

export type ToolSideEffectLevel = "none" | "session" | "filesystem" | "external"
export type ToolInterruptBehavior = "continue" | "cancel"

export interface ToolExecutionTraits {
  concurrencySafe: boolean
  approval: "automatic" | "confirm" | "blocked"
  confirmation?: "dispatcher" | "tool"
  requiresConfirmation: boolean
  sideEffectLevel: ToolSideEffectLevel
  interruptBehavior: ToolInterruptBehavior
  resultBudget?: number
}

export interface ToolBatchPlan {
  batchId: string
  parallel: boolean
  toolCalls: Array<{
    toolName: string
    callID: string
  }>
}

export type SubagentWriteIntent = "read_only" | "analysis" | "mutating"

export interface SubagentContract {
  description: string
  writeIntent: SubagentWriteIntent
  summary: string
  findings: string[]
  producedArtifacts: string[]
  nextStepRecommendation: string
  sessionID: string
  agent: string
}

export interface CompactionSnapshot {
  latestGoal?: string
  activeTodos: string[]
  unresolvedQuestions: string[]
  trustedArtifactPaths: string[]
  childSessionSummaries: string[]
  numericGroundingState: string[]
  activeTaskId?: string
  latestCheckpointId?: string
  activeStageId?: string
  activeStageKind?: WorkflowStageKind
  latestFailureCode?: StageFailureCode
  latestVerifierStatus?: "pass" | "warn" | "block"
  inputGraphRefs?: string[]
  latestContextSnapshot?: ContextManagerSnapshot
}

export type RuntimeTaskStatus = "queued" | "dispatching" | "running" | "completed" | "failed" | "cancelled" | "restored"

export type TaskTimelineEventKind =
  | "input.accepted"
  | "queue.updated"
  | "query.state"
  | "model.request"
  | "model.retry"
  | "workflow.state"
  | "tool.lifecycle"
  | "tool.result"
  | "tool.pool"
  | "tool.failure"
  | "analysis.lifecycle"
  | "verifier"
  | "checkpoint"
  | "restore"
  | "policy.decision"
  | "context.snapshot"
  | "compaction"
  | "agent.control"
  | "protocol.event"
  | "failure"
  | "completed"

export interface InputGraphNode {
  id: string
  type: "text" | "file" | "image" | "dataset" | "artifact" | "stage" | "command"
  label?: string
  ref?: string
  mime?: string
  metadata?: Record<string, unknown>
}

export interface TaskTimelineEvent {
  id: string
  sequence?: number
  taskId: string
  sessionID: string
  kind: TaskTimelineEventKind
  correlation?: QueryCorrelation
  stageId?: string
  workflowRunId?: string
  compaction?: CompactionLifecycle
  failureDecision?: RuntimeFailureDecision
  message?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface RuntimeFailureDecision {
  scope: "model" | "tool" | "compaction"
  category: string
  disposition: "retry" | "repair" | "stop" | "compact" | "fallback"
  reason: string
  userVisibleMessage: string
  attempt?: number
  maxConsecutiveFailures?: number
  delayMs?: number
  toolName?: string
  errorCode?: string
  checkpointId?: string
}

export interface RuntimeCheckpoint {
  checkpointId: string
  taskId?: string
  sessionID: string
  workflowRunId?: string
  stageId?: string
  branch?: string
  activeStage?: WorkflowStageKind
  trustedArtifacts: string[]
  verifierStatus?: "pass" | "warn" | "block"
  repairOnly?: boolean
  replayInput?: Record<string, unknown>
  createdAt: string
}

export interface RestoreTarget {
  checkpointId?: string
  stageId?: string
}

export type CompactionLifecycleStatus = "started" | "completed" | "failed" | "cancelled"

export interface CompactionLifecycle {
  operationId: string
  sessionID: string
  parentID: string
  reason: "manual" | "threshold" | "overflow"
  status: CompactionLifecycleStatus
  inputMessageCount: number
  inputHistoryVersion?: number
  summarySource?: "model" | "fallback"
  errorCode?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

export type AnalysisRequestKind = "inspect" | "estimate" | "explain" | "repair"

/** 用户动作到受控分析任务的不可变登记；研究解释仍需根据原始用户消息核验。 */
export interface AnalysisRequestRecord {
  version: 1
  requestId: string
  sourceMessageId: string
  kind: AnalysisRequestKind
  researchGoal: string
  constraints: string[]
  registeredAt: string
}

export type AnalysisSpecStatus =
  | "schema_not_sent"
  | "ready"
  | "preflight_ready"
  | "clarification_required"
  | "requires_user_decision"
  | "repairable"
  | "incompatible"
  | "diagnosis_refresh_required"

export interface AnalysisSpecPreflight {
  executable: boolean
  status: "ready" | "repairable" | "requires_user_decision" | "incompatible"
  dataFingerprint: string
  issues: Record<string, unknown>[]
  repairPlan: Record<string, unknown>[]
}

export type AnalysisArgumentSource =
  | { kind: "model_interpretation"; sourceMessageId: string }
  | { kind: "user_explicit"; sourceMessageId: string }
  | { kind: "registry_default_or_normalization"; registryVersion: number; schemaVersion: number }

/** 模型提出、由 Python Registry 校验的不可变规格版本。参数来源只指向用户消息，不等于授权。 */
export interface AnalysisSpecRecord {
  version: 1
  specId: string
  requestId: string
  sourceMessageId: string
  revision: number
  methodID: string
  arguments: Record<string, unknown>
  argumentSources: Record<string, AnalysisArgumentSource>
  datasetId: string
  stageId: string
  stageFingerprint: string
  registryVersion: number
  schemaVersion: number
  specHash: string
  status: AnalysisSpecStatus
  preflight?: AnalysisSpecPreflight
  createdAt: string
}

/** 只有 Registry preflight ready 且诊断指纹属于同一当前 stage 时才会生成。 */
export interface PreparedSpecRecord {
  version: 1
  specId: string
  requestId: string
  sourceMessageId: string
  revision: number
  methodID: string
  arguments: Record<string, unknown>
  datasetId: string
  stageId: string
  stageFingerprint: string
  registryVersion: number
  schemaVersion: number
  specHash: string
  preflight: AnalysisSpecPreflight
  preparedAt: string
}

export interface AnalysisLifecycleAuthorization {
  requestId: string
  specId: string
  revision: number
  stageFingerprint: string
  decisionMessageId: string
  decidedAt: string
}

export interface AnalysisLifecycleDecisionApproval {
  requestId: string
  issueCode: string
  resumeAs: "spec_pending" | "repairing"
  choice: string
  stageFingerprint?: string
  approvedInputFingerprint?: string
  approvedSubSpecIDs?: string[]
  decisionMessageId: string
  decidedAt: string
}

export type AnalysisLifecycleStatus =
  | "idle"
  | "diagnosing"
  | "spec_pending"
  | "assessing"
  | "ready"
  | "running"
  | "verifying"
  | "completed"
  | "waiting_user"
  | "repairing"
  | "failed"
  | "cancelled"
  | "unconfirmed"

export interface AnalysisSpecLifecycleRecord {
  requestId: string
  specId: string
  revision: number
  methodID: string
  status: AnalysisLifecycleStatus
  stageFingerprint: string
  specStatus: AnalysisSpecStatus
  issueCode?: string
  failureCode?: string
  resultId?: string
  artifactRefs?: string[]
  resultContractStatus?: "pass" | "block"
  verifierStatus?: "pass" | "warn" | "block"
  authorization?: AnalysisLifecycleAuthorization
  updatedAt: string
}

export interface AnalysisToolRunSubResult {
  specId: string
  specType: "heterogeneity" | "mechanism" | "placebo" | "alternative_spec"
  status: "success" | "failed" | "skipped"
}

export interface AnalysisToolOperationIdentity {
  requestId: string
  operationId: string
  toolID: string
  datasetId: string
  stageId: string
  stageFingerprint: string
  inputFingerprint: string
  authorizationMessageId: string
}

export interface AnalysisToolRunRecord extends AnalysisToolOperationIdentity {
  status: "running" | "completed" | "partial" | "failed" | "cancelled" | "unconfirmed"
  resultId?: string
  artifactRefs?: string[]
  resultContractStatus?: "pass"
  subResults?: AnalysisToolRunSubResult[]
  failureCode?: string
  startedAt?: string
  updatedAt: string
}

export interface AnalysisLifecycleRecord {
  version: 1
  status: AnalysisLifecycleStatus
  specRuns: AnalysisSpecLifecycleRecord[]
  toolRuns?: AnalysisToolRunRecord[]
  requestId?: string
  sourceMessageId?: string
  requestKind?: AnalysisRequestKind
  datasetId?: string
  stageId?: string
  specId?: string
  specRevision?: number
  methodID?: string
  stageFingerprint?: string
  issueCode?: string
  specStatus?: AnalysisSpecStatus
  failureCode?: string
  resultId?: string
  artifactRefs?: string[]
  resultContractStatus?: "pass" | "block"
  verifierStatus?: "pass" | "warn" | "block"
  decisionApproval?: AnalysisLifecycleDecisionApproval
  authorization?: AnalysisLifecycleAuthorization
  updatedAt: string
}

export interface RuntimeTaskRecord {
  taskId: string
  sessionID: string
  parentTaskId?: string
  childSessionID?: string
  actionType: QueuedSessionActionType
  status: RuntimeTaskStatus
  priority: number
  messageID?: string
  workflowRunId?: string
  stageId?: string
  activeStage?: WorkflowStageKind
  inputGraph: InputGraphNode[]
  timeline: TaskTimelineEvent[]
  latestCheckpointId?: string
  latestFailureCode?: StageFailureCode
  latestFailureDecision?: RuntimeFailureDecision
  verifierStatus?: "pass" | "warn" | "block"
  repairOnly?: boolean
  policyDecisions?: ExecPolicyDecision[]
  audit?: Record<string, unknown>[]
  contextVersion?: number
  compaction?: CompactionLifecycle
  analysisRequest?: AnalysisRequestRecord
  analysisLifecycle?: AnalysisLifecycleRecord
  analysisSpecs?: AnalysisSpecRecord[]
  preparedSpec?: PreparedSpecRecord
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ToolAvailabilityExplanation {
  toolID: string
  available: boolean
  exposure?: "direct" | "deferred" | "blocked"
  reasons: string[]
}

export interface RuntimeProtocolEvent {
  type: string
  sessionID: string
  payload: Record<string, unknown>
}

export interface RuntimeSubmission {
  submissionId: string
  sessionID: string
  source: "tui" | "cli" | "acp" | "kausal" | "runtime"
  kind: QueuedSessionActionType | "command" | "tool" | "agent"
  payload: Record<string, unknown>
  createdAt: string
}

export interface RuntimeEventEnvelope {
  version: 1
  sequence: number
  sessionID: string
  source: "runtime" | "workflow" | "tool" | "verifier" | "task-ledger" | "agent-control" | "context"
  event: RuntimeProtocolEvent
  createdAt: string
  compatibility?: Record<string, unknown>
}

export type ExecPolicyAction = "allow" | "ask" | "deny"

export interface ExecPolicy {
  profile: "local-default" | "remote-safe" | "verifier-readonly"
  safePrefixes: string[]
  askPrefixes: string[]
  denyPatterns: string[]
  networkRequiresApproval: boolean
  externalWriteRequiresApproval: boolean
}

export interface ExecPolicyDecision {
  decisionId: string
  sessionID: string
  toolName: string
  command: string
  action: ExecPolicyAction
  reason: string
  matchedRule?: string
  networkAccess?: boolean
  filesystemRisk?: "none" | "external_write" | "destructive" | "trusted_artifact_overwrite"
  createdAt: string
}

export interface DeferredToolEntry {
  toolID: string
  reason: string
  enableWhen: string[]
  remoteSafe: boolean
  repairOnlyAllowed: boolean
}

export interface ToolExposurePlan {
  profile: "none" | "focused" | "workflow"
  directTools: string[]
  deferredTools: DeferredToolEntry[]
  blockedTools: ToolAvailabilityExplanation[]
  policy: ToolAvailabilityPolicy
}

export interface ContextActionStatus {
  action: "offload" | "read-bound" | "history-snip" | "progressive" | "microcompact" | "collapse" | "prune" | "summary" | "restoring" | "failed"
  operationId?: string
  beforeTokens?: number
  afterTokens?: number
  savedEstimate?: number
  restoredReferences?: number
  removedTurns?: number
  clearedParts?: number
  emergency?: boolean
  reason?: "pressure" | "time-gap"
  summarySource?: "model" | "fallback"
  failureStreak?: number
  updatedAt: string
}

export interface ContextManagerSnapshot {
  sessionID: string
  historyVersion: number
  referenceContext: {
    activeTaskId?: string
    activeWorkflowRunId?: string
    activeStageId?: string
    latestFailureCode?: StageFailureCode
    latestVerifierStatus?: "pass" | "warn" | "block"
    trustedArtifacts: string[]
    inputGraphRefs: string[]
  }
  tokenEstimate: number
  protectedItems: string[]
  imageInputs: Array<{
    ref: string
    mode: "native" | "text-reference"
  }>
  createdAt: string
  usage?: ContextUsageSnapshot
  capsule?: ContextCapsule
  lastAction?: ContextActionStatus
}

export interface InterAgentMessage {
  messageId: string
  sessionID: string
  fromAgent: "coordinator" | "explore" | "general" | "verifier"
  toAgent: "explore" | "general" | "verifier"
  stageId?: string
  envelope: {
    summary: string
    findings: string[]
    producedArtifacts: string[]
    nextStepRecommendation: string
  }
  createdAt: string
}

export interface AgentControlState {
  sessionID: string
  activeAgent?: "explore" | "general" | "verifier"
  forkMode?: "minimal_context" | "last_n_turns" | "workflow_slice"
  decisions: WorkflowCoordinatorDecision[]
  messages: InterAgentMessage[]
  updatedAt: string
}

export type WorkflowStageKind =
  | "healthcheck"
  | "import"
  | "profile_or_schema_check"
  | "validate"
  | "preprocess_or_filter"
  | "profile_or_diagnostics"
  | "baseline_estimate"
  | "verifier"
  | "report"

export type StageStatus = "pending" | "ready" | "running" | "completed" | "failed" | "blocked" | "skipped"

export type StageFailureCode =
  | "FILE_NOT_FOUND"
  | "STAGE_NOT_RESOLVED"
  | "COLUMN_NOT_FOUND"
  | "PANEL_KEY_DUPLICATED"
  | "DEPENDENCY_MISSING"
  | "VALIDATE_BLOCKED"
  | "MODEL_SPEC_INVALID"
  | "RESULT_CONTRACT_INVALID"
  | "NUMERIC_GROUNDING_FAILED"
  | "ARTIFACT_MISSING"
  | "ESTIMATION_FAILED"

export interface StageFailureRecord {
  code: StageFailureCode
  toolName: string
  message: string
  retryStage: string
  repairAction: string
  autoRepairAllowed: boolean
  requiresVerifier: boolean
  maxRetries: number
  repairMetadata?: Record<string, unknown>
  reflectionPath?: string
  createdAt: string
}

export interface VerifierCheck {
  key: string
  label: string
  status: "pass" | "warn" | "block"
  message: string
  evidence?: Record<string, unknown>
}

export interface VerifierReport {
  status: "pass" | "warn" | "block"
  checks: VerifierCheck[]
  blockingFindings: string[]
  repairHints: string[]
  trustedArtifacts: string[]
  createdAt: string
}

export interface StageEdge {
  from: WorkflowStageKind
  to: WorkflowStageKind
}

export interface AnalysisChecklistItem {
  id: "data_readiness" | "identification" | "baseline_model" | "diagnostics" | "reporting"
  label: string
  status: "pending" | "in_progress" | "completed" | "blocked"
  linkedStageId?: string
  summary?: string
}

export interface StageNode {
  nodeId: string
  stageId: string
  kind: WorkflowStageKind
  status: StageStatus
  branch: string
  datasetId?: string
  runId?: string
  parentStageId?: string
  parentNodeId?: string
  dependsOn?: string[]
  downstream?: string[]
  cacheKey?: string
  replayable?: boolean
  executionMode?: "normal" | "rerun" | "reuse"
  toolName?: string
  replayInput?: Record<string, unknown>
  artifactRefs: string[]
  readableArtifactRefs?: string[]
  trustedArtifacts?: string[]
  reusedArtifacts?: string[]
  reuseSourceStageId?: string
  metadata?: Record<string, unknown>
  failure?: StageFailureRecord
  verifierReport?: VerifierReport
  createdAt: string
  updatedAt: string
}

export interface WorkflowRun {
  workflowRunId: string
  sessionID: string
  workflowMode: "econometrics"
  workflowLocale: WorkflowLocale
  datasetId?: string
  runId?: string
  branch: string
  activeNodeId?: string
  activeStage?: WorkflowStageKind
  stageSequence: WorkflowStageKind[]
  edges: StageEdge[]
  stages: StageNode[]
  trustedArtifacts: string[]
  analysisChecklist: AnalysisChecklistItem[]
  approvalStatus?: "required" | "approved" | "declined"
  planGeneratedAt?: string
  repairOnly?: boolean
  blockedStageId?: string
  activeCoordinatorAgent?: "explore" | "general" | "verifier"
  lastRerunPlan?: Record<string, unknown>
  lastRerunExecution?: Record<string, unknown>
  latestFailure?: StageFailureRecord
  latestVerifier?: VerifierReport
  /** 最近一次数据画像给出的候选方法；仅用于承接“按推荐执行”时防止静默换研究方法。 */
  lastRecommendationMethod?: string
  activeTaskId?: string
  lastCheckpointId?: string
  lastRestore?: Record<string, unknown>
  activePermissionProfile?: ExecPolicy["profile"]
  latestContextSnapshot?: ContextManagerSnapshot
  createdAt: string
  updatedAt: string
}

// Conversation is deliberately separate from empirical work. A normal sentence must
// never inherit the previous import/repair workflow or receive data tools.
export type WorkflowInputIntent = "conversation" | "status" | "repair" | "verify" | "report" | "analysis" | "ingest"

export interface ToolAvailabilityPolicy {
  sessionID?: string
  agent?: string
  currentStage?: WorkflowStageKind
  currentStageStatus?: StageStatus
  workflowMode?: "econometrics"
  approvalStatus?: "required" | "approved" | "declined"
  platformCapabilities?: {
    mcp: boolean
    images: boolean
    remote?: boolean
  }
  modelCapabilities?: {
    supportsTools: boolean
    supportsImages: boolean
  }
  inputIntent?: WorkflowInputIntent
  /** First tool-call round for a data-bearing user message; restrict visibility to request registration. */
  analysisRequestRequired?: boolean
  /** Only estimate requests may prepare an executable method specification. */
  analysisRequestKind?: AnalysisRequestKind
  repairOnly?: boolean
  repairToolName?: string
  /** 真实文件缺失导致的质量检查 repair 轮，仅允许额外搜索候选文件，不暴露读取或写入工具。 */
  allowFileDiscoveryDuringRepair?: boolean
  preferredToolIDs?: string[]
  /** 用户在同一动作中明确要求逐一执行的方法；用于防止模型提前以普通文本收尾。 */
  requiredToolIDs?: string[]
  /** 已由用户/模型确认的方法路线；工具池应优先直接暴露这些方法。 */
  confirmedToolIDs?: string[]
  /** 只读质量体检已由数据工具返回有界摘要，不需要再读取原始或内部文件。 */
  qualityInspectionOnly?: boolean
  /** PSM 方法可见/执行范围：仅诊断；或本轮明确不调用 PSM 方法。 */
  psmToolScope?: "diagnostics_only" | "blocked"
  /** PSM 决策续跑中，用户本轮明确批准的单一等值样本筛选规则。 */
  psmScopeFilter?: { column: string; value: string | number }
  /** 只询问方法建议的本轮：仅允许画像/导入等只读工具，不允许修改数据或估计。 */
  recommendationOnly?: boolean
  allowTask?: boolean
  executionMode?: "auto" | "plan"
}

export interface WorkflowCommandContext {
  command: string
  sessionID?: string
  workflowRunId?: string
  stageId?: string
  branch?: string
  arguments?: string
}

export interface RepairHandlerResult {
  retryStage: string
  repairAction: string
  autoApply: boolean
  requiresVerifier: boolean
  repairMetadata?: Record<string, unknown>
}

export type RepairHandler = (input: {
  failure: StageFailureRecord
  stage?: StageNode
  workflow?: WorkflowRun
}) => RepairHandlerResult

export interface WorkflowExecutionPolicy {
  autoVerifyStages: WorkflowStageKind[]
  freshVerifierAgent: "verifier"
  repairOnlyBundles: Record<WorkflowStageKind, string[]>
}

export interface WorkflowCoordinatorDecision {
  agent: "explore" | "general" | "verifier"
  why: string
  inputSlice: Record<string, unknown>
  expectedOutputContract: string
  linkedStageId?: string
  createdAt: string
}

export interface VerifierTaskEnvelope {
  status: "pass" | "warn" | "block"
  checks: VerifierCheck[]
  blockingFindings: string[]
  repairHints: string[]
  trustedArtifacts: string[]
  summary: string
  findings: string[]
  sessionID?: string
  agent: "verifier"
  mode: "fresh-run" | "runtime-fallback"
  createdAt: string
}

export interface StageReuseRecord {
  stageId: string
  sourceStageId: string
  artifactRefs: string[]
  cacheKey: string
}

export interface ToolAvailabilityResolution {
  policy: ToolAvailabilityPolicy
  allowedToolIDs: string[]
  directToolIDs?: string[]
  deferredToolIDs?: string[]
  blockedToolIDs?: string[]
  bundle: string[]
  explanations?: ToolAvailabilityExplanation[]
  exposurePlan?: ToolExposurePlan
}

export interface CommandCapability {
  availability?: string[]
  queueBehavior?: "queued" | "immediate"
  workflowAware?: boolean
  immediate?: boolean
  remoteSafe?: boolean
  repairOnlyAllowed?: boolean
  requiresTrustedArtifacts?: boolean
  visibleWhen?: string[]
  blockedReason?: string
}

export interface LifecycleHookResult {
  block?: string
  appendSystem?: string[]
  metadata?: Record<string, unknown>
  updatedInput?: unknown
  preventContinuation?: boolean
  /**
   * 询问用户确认后注入 confirmedToolIDs（如 did2s 替代 did_static）；
   * 真实问题在 estimate 阶段被门禁拒绝、用户回答 "切换交错 DID" 时使用。
   */
  confirmedToolIDs?: string[]
  repair?: {
    toolName: string
    retryStage: string
    repairAction: string
    reflectionPath?: string
    lockTool?: boolean
    failedInputSignature?: string
    failureDiagnosis?: FailureDiagnosis
  }
}

export type QueryRuntimeResult =
  | "continue"
  | "stop"
  | "compact"
  | {
      type: "repair"
      toolName: string
      retryStage: string
      repairAction: string
      reflectionPath?: string
      lockTool?: boolean
      failedInputSignature?: string
      failureDiagnosis?: FailureDiagnosis
      /** 自动确认的替代方法（已由门禁/用户回答推断），下一轮 resolveTools 优先加载。 */
      confirmedToolIDs?: string[]
    }

/**
 * 一次模型请求及其工具步骤的可关联身份。
 * turnID 对应持久化 assistant message；requestID 对应一次 provider 请求；
 * stepID 对应该请求内的一个 AI SDK step。所有字段都不承担业务语义，只用于
 * trace/ledger 关联，避免从自然语言错误文案反推调用链。
 */
export type QueryCorrelation = {
  sessionID: string
  turnID: string
  requestID: string
  stepID: string
  attempt: number
  providerID: string
  modelID: string
  toolCallID?: string
}

export type QueryEvent = (
  | {
      type: "status"
      status:
        | { type: "busy" }
        | { type: "retry"; attempt: number; message: string; next: number }
        | { type: "repair"; tool: string; retryStage: string; message: string }
        | { type: "model-switch"; from: string; to: string }
      correlation?: QueryCorrelation
    }
  | { type: "stream-start"; correlation?: QueryCorrelation }
  | { type: "reasoning-start"; id: string; providerMetadata?: ProviderMetadata; correlation?: QueryCorrelation }
  | { type: "reasoning-delta"; id: string; text: string; providerMetadata?: ProviderMetadata; correlation?: QueryCorrelation }
  | { type: "reasoning-end"; id: string; providerMetadata?: ProviderMetadata; correlation?: QueryCorrelation }
  | { type: "tool-input-start"; toolCallId: string; toolName: string; correlation?: QueryCorrelation }
  | {
      type: "tool-call"
      toolCallId: string
      toolName: string
      input: unknown
      providerMetadata?: ProviderMetadata
      correlation?: QueryCorrelation
    }
  | {
      type: "tool-result"
      toolCallId: string
      toolName: string
      input?: unknown
      output: {
        title: string
        metadata: Record<string, unknown>
        output: string
        modelOutput?: string
        outputReference?: string
        attachments?: unknown[]
        modelAttachments?: unknown[]
      }
      correlation?: QueryCorrelation
    }
  | {
      type: "tool-error"
      toolCallId: string
      toolName: string
      input?: unknown
      error: unknown
      metadata?: Record<string, unknown>
      blocked?: boolean
      skipped?: boolean
      repair?: QueryRuntimeResult extends infer T ? Extract<T, { type: "repair" }> : never
      correlation?: QueryCorrelation
    }
  | { type: "step-start"; correlation?: QueryCorrelation }
  | {
      type: "step-finish"
      finishReason: string
      usage: LanguageModelUsage
      providerMetadata?: ProviderMetadata
      correlation?: QueryCorrelation
    }
  | { type: "text-start"; providerMetadata?: ProviderMetadata; correlation?: QueryCorrelation }
  | { type: "text-delta"; text: string; providerMetadata?: ProviderMetadata; correlation?: QueryCorrelation }
  | { type: "text-end"; providerMetadata?: ProviderMetadata; correlation?: QueryCorrelation }
  | { type: "finish"; correlation?: QueryCorrelation }
  | { type: "turn-finish"; result: QueryRuntimeResult; error?: unknown; correlation?: QueryCorrelation }
)
