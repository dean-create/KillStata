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

type WorkflowUiLocale = NonNullable<WorkflowTuiState["workflowLocale"]>

const WORKFLOW_STATUS_DISPLAY: Record<string, { en: string; zh: string }> = {
  "repair-only": { en: "repair-only", zh: "仅修复模式" },
  "verifier-block": { en: "verifier block", zh: "校验器阻塞" },
  "verifier-warn": { en: "verifier warn", zh: "校验器警告" },
  "verifier-pass": { en: "verifier pass", zh: "校验器通过" },
}

const WORKFLOW_AGENT_DISPLAY: Record<string, { en: string; zh: string }> = {
  explore: { en: "Explorer", zh: "探索器" },
  explorer: { en: "Explorer", zh: "探索器" },
  general: { en: "Analyst", zh: "分析器" },
  analyst: { en: "Analyst", zh: "分析器" },
  verifier: { en: "Verifier", zh: "校验器" },
  subagent: { en: "Subagent", zh: "子智能体" },
  coordinator: { en: "Coordinator", zh: "协调器" },
  agent: { en: "Agent", zh: "智能体" },
}

export function workflowStatusDisplayLabel(
  workflow?: Pick<WorkflowTuiState, "repairOnly" | "verifierStatus">,
  locale: WorkflowUiLocale = "en",
) {
  const label = workflowStatusLabel(workflow)
  if (!label) return undefined
  const display = WORKFLOW_STATUS_DISPLAY[label]
  if (!display) return label
  return locale === "zh-CN" ? display.zh : display.en
}

export function workflowAgentDisplayLabel(agent?: string, locale: WorkflowUiLocale = "en") {
  if (!agent) return undefined
  const display = WORKFLOW_AGENT_DISPLAY[agent]
  if (!display) return agent
  return locale === "zh-CN" ? display.zh : display.en
}
