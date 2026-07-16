import type { ToolSideEffectLevel, WorkflowInputIntent, WorkflowStageKind } from "./types"

export const WORKFLOW_READ_ONLY_ACTIONS = new Set([
  "status",
  "stage",
  "artifacts",
  "doctor",
  "rerun_plan",
  "tasks",
  "timeline",
  "tools",
  "skills",
  "diagnostics",
  "agent",
])

export const WORKFLOW_SESSION_ACTIONS = new Set(["restore"])
export const WORKFLOW_EXTERNAL_ACTIONS = new Set(["verify"])
export const WORKFLOW_FILESYSTEM_ACTIONS = new Set(["rerun"])

export const WORKFLOW_READ_CORE_TOOL_IDS = [
  "question",
  "read",
  "list",
  "glob",
  "grep",
  "skill",
  "workflow",
  "webfetch",
  "websearch",
  "todoread",
  "todowrite",
] as const

export const WORKFLOW_IMPORT_TOOL_IDS = ["data_import"] as const
export const WORKFLOW_RECOMMEND_TOOL_IDS = ["econometrics_recommend"] as const
export const WORKFLOW_DIAGNOSTIC_TOOL_IDS = ["psm_construction"] as const
export const WORKFLOW_ESTIMATE_TOOL_IDS = [
  "ols_regression",
  "panel_fe_regression",
  "iv_2sls",
  "hdfe_regression",
  "did_static",
  "did2s",
  "did_event_study_saturated",
] as const
export const WORKFLOW_ANALYSIS_TOOL_IDS = [
  ...WORKFLOW_RECOMMEND_TOOL_IDS,
  ...WORKFLOW_DIAGNOSTIC_TOOL_IDS,
  ...WORKFLOW_ESTIMATE_TOOL_IDS,
] as const
export const WORKFLOW_REPORT_TOOL_IDS = ["experiment_log"] as const

export const WORKFLOW_KNOWN_TOOL_IDS = [
  ...WORKFLOW_READ_CORE_TOOL_IDS,
  ...WORKFLOW_IMPORT_TOOL_IDS,
  ...WORKFLOW_ANALYSIS_TOOL_IDS,
  "task",
  "heterogeneity_runner",
] as const

export const WORKFLOW_INPUT_INTENT_TOOL_BUNDLES = {
  conversation: [],
  ingest: [...WORKFLOW_READ_CORE_TOOL_IDS, ...WORKFLOW_IMPORT_TOOL_IDS],
  status: [...WORKFLOW_READ_CORE_TOOL_IDS],
  verify: [...WORKFLOW_READ_CORE_TOOL_IDS],
  repair: [
    ...WORKFLOW_READ_CORE_TOOL_IDS,
    ...WORKFLOW_IMPORT_TOOL_IDS,
    ...WORKFLOW_ANALYSIS_TOOL_IDS,
  ],
  report: [...WORKFLOW_READ_CORE_TOOL_IDS, ...WORKFLOW_REPORT_TOOL_IDS],
  analysis: [
    ...WORKFLOW_READ_CORE_TOOL_IDS,
    ...WORKFLOW_IMPORT_TOOL_IDS,
    ...WORKFLOW_ANALYSIS_TOOL_IDS,
  ],
} as const satisfies Record<WorkflowInputIntent, readonly string[]>

export const WORKFLOW_REPAIR_ONLY_BUNDLES = {
  healthcheck: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  import: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  profile_or_schema_check: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  qa_gate: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  preprocess_or_filter: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  describe_or_diagnostics: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  baseline_estimate: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS, ...WORKFLOW_ANALYSIS_TOOL_IDS],
  verifier: ["workflow", "read", "glob", "grep", "skill"],
  report: ["workflow", "read", "glob", "grep", "skill"],
} as const satisfies Record<WorkflowStageKind, readonly string[]>

const READ_ONLY_TOOL_IDS = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "todoread",
])

const SESSION_TOOL_IDS = new Set(["todowrite", "question", "skill"])

const FILESYSTEM_TOOL_IDS = new Set([
  "bash",
  "shell",
  "data_import",
  "econometrics",
  "econometrics_recommend",
  "psm_construction",
  "ols_regression",
  "panel_fe_regression",
  "iv_2sls",
  "hdfe_regression",
  "did_static",
  "did2s",
  "did_event_study_saturated",
  "heterogeneity_runner",
])

export function uniqueToolIDs(tools: readonly string[]) {
  return [...new Set(tools)]
}

export function isWorkflowRecommendTool(toolName: string) {
  return (WORKFLOW_RECOMMEND_TOOL_IDS as readonly string[]).includes(toolName)
}

export function isWorkflowDiagnosticTool(toolName: string) {
  return (WORKFLOW_DIAGNOSTIC_TOOL_IDS as readonly string[]).includes(toolName)
}

export function isWorkflowEstimateTool(toolName: string) {
  // 旧入口仅为历史 stage replay 保留，不再向模型直连暴露。
  return toolName === "econometrics" || (WORKFLOW_ESTIMATE_TOOL_IDS as readonly string[]).includes(toolName)
}

export function isWorkflowAnalysisTool(toolName: string) {
  return isWorkflowRecommendTool(toolName) || isWorkflowDiagnosticTool(toolName) || isWorkflowEstimateTool(toolName)
}

function workflowAction(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined
  const action = (args as Record<string, unknown>).action
  return typeof action === "string" ? action : undefined
}

export function isWorkflowReadOnlyAction(args: unknown) {
  const action = workflowAction(args)
  return Boolean(action && WORKFLOW_READ_ONLY_ACTIONS.has(action))
}

export function toolSideEffectLevel(toolName: string, args?: unknown): ToolSideEffectLevel {
  if (toolName === "workflow") {
    const action = workflowAction(args)
    if (action && WORKFLOW_READ_ONLY_ACTIONS.has(action)) return "none"
    if (action && WORKFLOW_SESSION_ACTIONS.has(action)) return "session"
    if (action && WORKFLOW_FILESYSTEM_ACTIONS.has(action)) return "filesystem"
    if (action && WORKFLOW_EXTERNAL_ACTIONS.has(action)) return "external"
    return "session"
  }

  if (READ_ONLY_TOOL_IDS.has(toolName)) return "none"
  if (SESSION_TOOL_IDS.has(toolName)) return "session"
  if (FILESYSTEM_TOOL_IDS.has(toolName)) return "filesystem"
  if (toolName === "task" || toolName.startsWith("mcp_")) return "external"
  return "external"
}
