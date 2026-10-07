import type { WorkflowInputIntent, WorkflowStageKind } from "./types"
import { toolIDsByFamily } from "./tool-manifest"

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
export const WORKFLOW_FILESYSTEM_ACTIONS = new Set(["rerun", "export_artifact"])

// 以下清单全部从 tool-manifest 派生。此前它们是手写数组，与 manifest、提示词、
// workflow bundle 各持一份，工具改名需同步五六处；现在真相只有 tool-manifest 一处。
export const WORKFLOW_READ_CORE_TOOL_IDS = toolIDsByFamily("read_core", "system").filter(
  (id) => id !== "task",
) as readonly string[]

export const WORKFLOW_IMPORT_TOOL_IDS = toolIDsByFamily("import") as readonly string[]
export const WORKFLOW_RECOMMEND_TOOL_IDS = toolIDsByFamily("recommend") as readonly string[]
// 模型可见列表只能从准入结论派生。未准入实现仍保留在 ToolRegistry，供历史
// workflow replay 使用，但不会进入模型的 JSON Schema。
export const WORKFLOW_DIAGNOSTIC_TOOL_IDS = toolIDsByFamily("diagnostic") as readonly string[]
export const WORKFLOW_ESTIMATE_TOOL_IDS = toolIDsByFamily("estimator") as readonly string[]
export const WORKFLOW_ANALYSIS_TOOL_IDS = [
  ...WORKFLOW_RECOMMEND_TOOL_IDS,
  ...WORKFLOW_DIAGNOSTIC_TOOL_IDS,
  ...WORKFLOW_ESTIMATE_TOOL_IDS,
] as const
export const WORKFLOW_DATA_METHOD_TOOL_IDS = toolIDsByFamily("data_method") as readonly string[]
export const WORKFLOW_ANALYSIS_CONTROL_TOOL_IDS = toolIDsByFamily("analysis_control") as readonly string[]
export const WORKFLOW_REPORT_TOOL_IDS = toolIDsByFamily("report") as readonly string[]
// 派生分析执行器（异质性）：在基准结果之后使用，且需要 analyst 显式批准（见 exposure）。
export const WORKFLOW_RUNNER_TOOL_IDS = toolIDsByFamily("runner") as readonly string[]

export const WORKFLOW_KNOWN_TOOL_IDS = [
  ...WORKFLOW_READ_CORE_TOOL_IDS,
  ...WORKFLOW_IMPORT_TOOL_IDS,
  ...WORKFLOW_ANALYSIS_TOOL_IDS,
  ...WORKFLOW_ANALYSIS_CONTROL_TOOL_IDS,
  ...WORKFLOW_DATA_METHOD_TOOL_IDS,
  "task",
  ...toolIDsByFamily("runner"),
] as readonly string[]

// 显式标注而非 `as const satisfies`：清单已改为运行时从 manifest 派生，字面量推断不再
// 可用；标注 Record<WorkflowInputIntent, …> 仍保留"每个意图都必须给出工具包"的穷尽性检查。
export const WORKFLOW_INPUT_INTENT_TOOL_BUNDLES: Record<WorkflowInputIntent, readonly string[]> = {
  conversation: [],
  // ingest 也暴露 data_method：清洗紧跟导入是最常见流程，用户一条消息"导入并筛选/清洗"
  // 时若只给 import 工具，agent 会在导入后卡死（data_import 已不再接受 filter/preprocess）。
  // 同时暴露 recommend：估计前必须先完成画像（assertDatasetStageReadyForEstimation 门禁），
  // 而画像只能由 econometrics_recommend 完成；导入消息的循环里模型会一路推进到 数据质量检查/describe，
  // 若 ingest 阶段看不到 recommend，画像这一步永远做不了，后续估计必然被门禁拒绝
  // （2026-08-05 did.xlsx：ingest 循环缺 profile → panel_fe_regression 被拒 → repair 死锁）。
  ingest: [
    ...WORKFLOW_READ_CORE_TOOL_IDS,
    ...WORKFLOW_IMPORT_TOOL_IDS,
    ...WORKFLOW_DATA_METHOD_TOOL_IDS,
    ...WORKFLOW_RECOMMEND_TOOL_IDS,
    ...WORKFLOW_ANALYSIS_CONTROL_TOOL_IDS,
  ],
  status: [...WORKFLOW_READ_CORE_TOOL_IDS],
  verify: [...WORKFLOW_READ_CORE_TOOL_IDS],
  repair: [...WORKFLOW_READ_CORE_TOOL_IDS, ...WORKFLOW_IMPORT_TOOL_IDS, ...WORKFLOW_ANALYSIS_TOOL_IDS, ...WORKFLOW_DATA_METHOD_TOOL_IDS, ...WORKFLOW_ANALYSIS_CONTROL_TOOL_IDS],
  report: [...WORKFLOW_READ_CORE_TOOL_IDS, ...WORKFLOW_REPORT_TOOL_IDS],
  analysis: [
    ...WORKFLOW_READ_CORE_TOOL_IDS,
    ...WORKFLOW_IMPORT_TOOL_IDS,
    ...WORKFLOW_ANALYSIS_TOOL_IDS,
    ...WORKFLOW_DATA_METHOD_TOOL_IDS,
    ...WORKFLOW_RUNNER_TOOL_IDS,
    ...WORKFLOW_ANALYSIS_CONTROL_TOOL_IDS,
  ],
}

// 修复模式下每个阶段都保底可用的只读工具集，避免在九个阶段里重复同一串字面量。
const REPAIR_BASE_TOOL_IDS = ["pipeline", "read", "glob", "grep", "skill"] as const

export const WORKFLOW_REPAIR_ONLY_BUNDLES: Record<WorkflowStageKind, readonly string[]> = {
  healthcheck: [...REPAIR_BASE_TOOL_IDS, ...WORKFLOW_IMPORT_TOOL_IDS],
  import: [...REPAIR_BASE_TOOL_IDS, ...WORKFLOW_IMPORT_TOOL_IDS],
  profile_or_schema_check: [...REPAIR_BASE_TOOL_IDS, ...WORKFLOW_IMPORT_TOOL_IDS],
  validate: [...REPAIR_BASE_TOOL_IDS, ...WORKFLOW_IMPORT_TOOL_IDS],
  preprocess_or_filter: [...REPAIR_BASE_TOOL_IDS, ...WORKFLOW_DATA_METHOD_TOOL_IDS, ...WORKFLOW_IMPORT_TOOL_IDS],
  profile_or_diagnostics: [...REPAIR_BASE_TOOL_IDS, ...WORKFLOW_IMPORT_TOOL_IDS],
  baseline_estimate: [...REPAIR_BASE_TOOL_IDS, ...WORKFLOW_IMPORT_TOOL_IDS, ...WORKFLOW_ANALYSIS_TOOL_IDS],
  verifier: [...REPAIR_BASE_TOOL_IDS],
  report: [...REPAIR_BASE_TOOL_IDS],
}


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

export function isWorkflowEstimateCompletionTool(toolName: string) {
  return isWorkflowEstimateTool(toolName) || (WORKFLOW_RUNNER_TOOL_IDS as readonly string[]).includes(toolName)
}

export function isWorkflowDataMethodTool(toolName: string) {
  return (WORKFLOW_DATA_METHOD_TOOL_IDS as readonly string[]).includes(toolName)
}

export function isWorkflowAnalysisTool(toolName: string) {
  return isWorkflowRecommendTool(toolName) || isWorkflowDiagnosticTool(toolName) || isWorkflowEstimateTool(toolName)
}

export function workflowAction(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined
  const action = (args as Record<string, unknown>).action
  return typeof action === "string" ? action : undefined
}

export function isWorkflowReadOnlyAction(args: unknown) {
  const action = workflowAction(args)
  return Boolean(action && WORKFLOW_READ_ONLY_ACTIONS.has(action))
}
