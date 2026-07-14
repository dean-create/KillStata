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
  "invalid",
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

export const WORKFLOW_ANALYSIS_SHELL_TOOL_IDS = ["bash", "shell"] as const
export const WORKFLOW_IMPORT_TOOL_IDS = ["data_import"] as const
export const WORKFLOW_ESTIMATE_TOOL_IDS = ["econometrics"] as const
export const WORKFLOW_REPORT_TOOL_IDS = ["experiment_log"] as const

export const WORKFLOW_KNOWN_TOOL_IDS = [
  ...WORKFLOW_READ_CORE_TOOL_IDS,
  ...WORKFLOW_ANALYSIS_SHELL_TOOL_IDS,
  "edit",
  "write",
  ...WORKFLOW_IMPORT_TOOL_IDS,
  ...WORKFLOW_ESTIMATE_TOOL_IDS,
  "task",
  "heterogeneity_runner",
  "batch",
  "lsp",
  "plan_enter",
  "plan_exit",
] as const

export const WORKFLOW_INPUT_INTENT_TOOL_BUNDLES = {
  conversation: [],
  ingest: [...WORKFLOW_READ_CORE_TOOL_IDS, ...WORKFLOW_IMPORT_TOOL_IDS],
  status: [...WORKFLOW_READ_CORE_TOOL_IDS],
  verify: [...WORKFLOW_READ_CORE_TOOL_IDS],
  repair: [
    ...WORKFLOW_READ_CORE_TOOL_IDS,
    ...WORKFLOW_ANALYSIS_SHELL_TOOL_IDS,
    ...WORKFLOW_IMPORT_TOOL_IDS,
    ...WORKFLOW_ESTIMATE_TOOL_IDS,
  ],
  report: [...WORKFLOW_READ_CORE_TOOL_IDS, ...WORKFLOW_REPORT_TOOL_IDS],
  analysis: [
    ...WORKFLOW_READ_CORE_TOOL_IDS,
    ...WORKFLOW_ANALYSIS_SHELL_TOOL_IDS,
    ...WORKFLOW_IMPORT_TOOL_IDS,
    ...WORKFLOW_ESTIMATE_TOOL_IDS,
  ],
} as const satisfies Record<WorkflowInputIntent, readonly string[]>

export const WORKFLOW_REPAIR_ONLY_BUNDLES = {
  healthcheck: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  import: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  profile_or_schema_check: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  qa_gate: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  preprocess_or_filter: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  describe_or_diagnostics: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS],
  baseline_estimate: ["workflow", "read", "glob", "grep", "skill", ...WORKFLOW_IMPORT_TOOL_IDS, ...WORKFLOW_ESTIMATE_TOOL_IDS],
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
  "lsp",
])

const SESSION_TOOL_IDS = new Set(["todowrite", "question", "skill", "plan_enter", "plan_exit"])

const FILESYSTEM_TOOL_IDS = new Set([
  "bash",
  "shell",
  "edit",
  "write",
  "data_import",
  "econometrics",
  "heterogeneity_runner",
])

export function uniqueToolIDs(tools: readonly string[]) {
  return [...new Set(tools)]
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
