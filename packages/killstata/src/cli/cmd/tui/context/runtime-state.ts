export type RuntimeQueryState = {
  phase: "idle" | "accepted" | "dispatching" | "running"
  generation: number
  pending: number
  action?: string
}

export type RuntimeQueueState = {
  pending: number
  actions: {
    id: string
    type: string
    priority: number
    createdAt: number
    delivery?: "queued" | "steer"
  }[]
}

export type RuntimeTaskTuiState = {
  taskId: string
  actionType: string
  status: "queued" | "dispatching" | "running" | "completed" | "failed" | "cancelled" | "restored"
  stageId?: string
  workflowRunId?: string
  latestCheckpointId?: string
  latestFailureCode?: string
  verifierStatus?: "pass" | "warn" | "block"
  repairOnly?: boolean
  updatedAt: string
}

export type RuntimeTimelineTuiEvent = {
  id: string
  taskId: string
  kind: string
  stageId?: string
  workflowRunId?: string
  message?: string
  createdAt: string
}

export type RuntimeProtocolTuiState = {
  sequence: number
  source: string
  type: string
  createdAt: string
}

export type RuntimeExecPolicyTuiState = {
  action: "allow" | "ask" | "deny"
  toolName: string
  reason: string
  createdAt: string
}

export type RuntimeContextCacheTuiState = {
  observationCount: number
  truncated: boolean
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  promptTokens: number
  hitRatio: number
  breakCount: number
  breakReasons: Record<string, number>
  lastBreakReason?: string
  updatedAt: string
}

export type RuntimeContextUsageTuiState = {
  providerID: string
  modelID: string
  contextLimit: number | null
  inputBudget: number | null
  reserveTokens: number
  estimatedPromptTokens: number
  estimatedSystemTokens: number
  estimatedToolTokens: number
  estimatedMessageTokens: number
  actual?: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    promptTokens: number
    usedTokens: number
  }
  usedTokens: number
  remainingTokens: number | null
  percentage: number | null
  source: "estimated" | "actual"
  compactionState: "none" | "pending" | "microcompact" | "summary"
  updatedAt: string
  cache?: RuntimeContextCacheTuiState
}

export type RuntimeContextActionTuiState = {
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

export type RuntimeContextTuiState = {
  historyVersion: number
  tokenEstimate: number
  capsule?: {
    capsuleHash: string
    datasetId?: string
    stageId?: string
    scope: string
    rowCount?: number
    rowsUsed?: number
    qualityGate: string
    panelStatus: string
    observedSpecifications: number
    conflicts: string[]
    tokenEstimate: number
  }
  activeStageId?: string
  latestVerifierStatus?: "pass" | "warn" | "block"
  createdAt: string
  usage?: RuntimeContextUsageTuiState
  lastAction?: RuntimeContextActionTuiState
}

export type RuntimeAgentControlTuiState = {
  activeAgent?: "explore" | "general" | "verifier"
  forkMode?: "minimal_context" | "last_n_turns" | "workflow_slice"
  decisionCount: number
  messageCount: number
  updatedAt: string
}

export type WorkflowTuiState = {
  workflowRunId?: string
  workflowLocale?: "zh-CN" | "en"
  branch?: string
  activeStage?: string
  activeStageId?: string
  activeCoordinatorAgent?: "explore" | "general" | "verifier"
  repairOnly?: boolean
  latestFailureCode?: string
  verifierStatus?: "pass" | "warn" | "block"
  trustedArtifacts?: string[]
  rerunTargetStageId?: string
  approvalStatus?: "required" | "approved" | "declined"
  currentChecklistItem?: {
    id: string
    label: string
    status: "pending" | "in_progress" | "completed" | "blocked"
  }
  analysisChecklist: {
    id: string
    label: string
    status: "pending" | "in_progress" | "completed" | "blocked"
    linkedStageId?: string
    summary?: string
  }[]
}

export function appendPartDelta<T extends { id: string }>(
  parts: T[] | undefined,
  partID: string,
  field: keyof T,
  delta: string,
) {
  if (!parts) return false
  const part = parts.find((item) => item.id === partID)
  if (!part) return false
  const existing = part[field]
  if (existing !== undefined && typeof existing !== "string") return false
  ;(part[field] as string) = (existing ?? "") + delta
  return true
}
