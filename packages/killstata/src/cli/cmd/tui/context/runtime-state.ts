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
  }[]
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

export function workflowStatusLabel(workflow?: Pick<WorkflowTuiState, "repairOnly" | "verifierStatus">) {
  if (!workflow) return undefined
  if (workflow.repairOnly) return "repair-only"
  if (workflow.verifierStatus === "block") return "verifier-block"
  if (workflow.verifierStatus === "warn") return "verifier-warn"
  if (workflow.verifierStatus === "pass") return "verifier-pass"
  return undefined
}
