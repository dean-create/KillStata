import type { LanguageModelUsage, ProviderMetadata } from "ai"

export type QueuedSessionActionType =
  | "prompt"
  | "command"
  | "shell"
  | "continue"
  | "retry"
  | "repair"
  | "compaction"

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
}

export type WorkflowStageKind =
  | "healthcheck"
  | "import"
  | "profile_or_schema_check"
  | "qa_gate"
  | "preprocess_or_filter"
  | "describe_or_diagnostics"
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
  | "QA_BLOCKED"
  | "MODEL_SPEC_INVALID"
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
  datasetId?: string
  runId?: string
  branch: string
  activeNodeId?: string
  activeStage?: WorkflowStageKind
  stageSequence: WorkflowStageKind[]
  edges: StageEdge[]
  stages: StageNode[]
  trustedArtifacts: string[]
  repairOnly?: boolean
  blockedStageId?: string
  activeCoordinatorAgent?: "explore" | "general" | "verifier"
  lastRerunPlan?: Record<string, unknown>
  lastRerunExecution?: Record<string, unknown>
  latestFailure?: StageFailureRecord
  latestVerifier?: VerifierReport
  createdAt: string
  updatedAt: string
}

export type WorkflowInputIntent = "status" | "repair" | "verify" | "report" | "analysis"

export interface ToolAvailabilityPolicy {
  sessionID?: string
  agent?: string
  currentStage?: WorkflowStageKind
  currentStageStatus?: StageStatus
  workflowMode?: "econometrics"
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
  repairOnly?: boolean
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
  bundle: string[]
}

export interface CommandCapability {
  availability?: string[]
  queueBehavior?: "queued" | "immediate"
  workflowAware?: boolean
  immediate?: boolean
  remoteSafe?: boolean
}

export interface LifecycleHookResult {
  block?: string
  appendSystem?: string[]
  metadata?: Record<string, unknown>
  updatedInput?: unknown
  preventContinuation?: boolean
  repair?: {
    toolName: string
    retryStage: string
    repairAction: string
    reflectionPath?: string
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
    }

export type QueryEvent =
  | {
      type: "status"
      status:
        | { type: "busy" }
        | { type: "retry"; attempt: number; message: string; next: number }
        | { type: "repair"; tool: string; retryStage: string; message: string }
    }
  | { type: "stream-start" }
  | { type: "reasoning-start"; id: string; providerMetadata?: ProviderMetadata }
  | { type: "reasoning-delta"; id: string; text: string; providerMetadata?: ProviderMetadata }
  | { type: "reasoning-end"; id: string; providerMetadata?: ProviderMetadata }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown; providerMetadata?: ProviderMetadata }
  | {
      type: "tool-result"
      toolCallId: string
      toolName: string
      input?: unknown
      output: {
        title: string
        metadata: Record<string, unknown>
        output: string
        attachments?: unknown[]
      }
    }
  | {
      type: "tool-error"
      toolCallId: string
      toolName: string
      input?: unknown
      error: unknown
      metadata?: Record<string, unknown>
      blocked?: boolean
      repair?: QueryRuntimeResult extends infer T ? Extract<T, { type: "repair" }> : never
    }
  | { type: "step-start" }
  | {
      type: "step-finish"
      finishReason: string
      usage: LanguageModelUsage
      providerMetadata?: ProviderMetadata
    }
  | { type: "text-start"; providerMetadata?: ProviderMetadata }
  | { type: "text-delta"; text: string; providerMetadata?: ProviderMetadata }
  | { type: "text-end"; providerMetadata?: ProviderMetadata }
  | { type: "finish" }
  | { type: "turn-finish"; result: QueryRuntimeResult; error?: unknown }
