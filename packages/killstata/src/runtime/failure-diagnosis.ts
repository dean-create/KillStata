import type { FailureType } from "./failure-reflection"

export type RepairOption = {
  repair_id: string
  label_zh: string
  description_zh: string
  affected_columns: string[]
  row_impact: Record<string, unknown>
  semantic_impact: "none" | "measurement" | "sample" | "identification"
  requires_confirmation: boolean
  resulting_method_ids: string[]
}

export type FailureDiagnosis = {
  failureCode: string
  stage: "input" | "diagnosis" | "estimate" | "result" | "runtime"
  methodID?: string
  summary_zh: string
  evidence: Record<string, unknown>
  repairOptions: RepairOption[]
  safeToRetry: boolean
  user_fallback_zh: string
}

function failureCode(input: { failureType: FailureType; error: string }) {
  const lower = input.error.toLowerCase()
  if (input.failureType === "data_snapshot_failure") {
    return lower.includes("在创建执行快照时发生变化") ? "DATA_SNAPSHOT_UNSTABLE" : "DATA_SNAPSHOT_FAILED"
  }
  if (lower.includes("当前活动方法窗口") || lower.includes("active method window")) return "METHOD_NOT_LOADED"
  if (
    lower.includes("unavailable tool") ||
    lower.includes("no such tool") ||
    lower.includes("tool is not available") ||
    (lower.includes("tool ") && lower.includes("not available in this request"))
  ) return "TOOL_NOT_FOUND"
  if (input.failureType === "column_not_found") return "DATA_COLUMN_MISSING"
  if (input.failureType === "panel_integrity_failure") return "DATA_PANEL_KEY_NOT_UNIQUE"
  if (input.failureType === "validate_blocked") return "DATA_VALIDATION_BLOCKED"
  if (input.failureType === "tool_contract_failure") return "INVALID_ARGUMENT"
  if (input.failureType === "result_contract_failure") return "RESULT_CONTRACT_INVALID"
  if (input.failureType === "process_timeout") return "PROCESS_TIMEOUT"
  if (input.failureType === "estimation_failure" && /秩亏|共线|rank deficient|full column rank/i.test(input.error)) {
    return "DESIGN_MATRIX_RANK_DEFICIENT"
  }
  if (input.failureType === "estimation_failure") return "METHOD_EXECUTION_FAILED"
  return "UNKNOWN_TOOL_FAILURE"
}

function safeError(error: string) {
  return error
    .replace(/(?:\/Users|\/private|[A-Za-z]:\\)[^\s，。；;]+/g, "[受控路径]")
    .replace(/dataset(?:Id|_id)\s*[=:：]\s*[^\s，。；;]+/gi, "数据集引用已隐藏")
    .replace(/stage(?:Id|_id)\s*[=:：]\s*[^\s，。；;]+/gi, "数据阶段引用已隐藏")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 600)
}

function rankRepair(methodID?: string): RepairOption[] {
  return [
    {
      repair_id: "rank_keep_core",
      label_zh: "保留核心解释变量，移除部分共线控制变量",
      description_zh: "只修改模型变量组合；会改变控制变量集合，需要确认研究含义。",
      affected_columns: [],
      row_impact: { rows_dropped: 0 },
      semantic_impact: "identification",
      requires_confirmation: true,
      resulting_method_ids: methodID ? [methodID] : [],
    },
    {
      repair_id: "rank_change_design",
      label_zh: "改用指数构造或贡献分析",
      description_zh: "如果变量是同一指数的组成项，不把构成恒等式当作因果回归。",
      affected_columns: [],
      row_impact: { rows_dropped: 0 },
      semantic_impact: "identification",
      requires_confirmation: true,
      resulting_method_ids: [],
    },
  ]
}

export function buildFailureDiagnosis(input: {
  toolName: string
  failureType: FailureType
  error: string
  input?: Record<string, unknown>
  safeToRetryOverride?: boolean
}) : FailureDiagnosis {
  const code = failureCode(input)
  const resolvedMethodID = typeof input.input?.methodID === "string" ? input.input.methodID : input.toolName
  const methodID = code === "TOOL_NOT_FOUND" ? undefined : resolvedMethodID
  const text = safeError(input.error)
  const options = code === "DATA_SNAPSHOT_FAILED" || code === "DATA_SNAPSHOT_UNSTABLE"
    ? []
    : code === "TOOL_NOT_FOUND" || code === "METHOD_NOT_LOADED"
    ? [{
        repair_id: code === "TOOL_NOT_FOUND" ? "select_registered_tool" : "load_admitted_method",
        label_zh: code === "TOOL_NOT_FOUND" ? "从当前工具目录重新选择" : "加载已准入的计量方法",
        description_zh: code === "TOOL_NOT_FOUND"
          ? "刚才的工具名未注册，本次调用没有执行。保持用户原目标，从当前可用工具中选择等价能力；没有等价工具时说明限制或询问用户，不得替换计量方法。"
          : `该方法已准入但尚未加载。本次调用没有执行；通过 tool_search 加载“${methodID ?? "目标方法"}”的 Schema 后再通过 econometrics_execute 调用。`,
        affected_columns: [],
        row_impact: { rows_dropped: 0 },
        semantic_impact: "none" as const,
        requires_confirmation: false,
        resulting_method_ids: code === "METHOD_NOT_LOADED" && methodID ? [methodID] : [],
      }]
    : code === "DESIGN_MATRIX_RANK_DEFICIENT"
    ? rankRepair(methodID)
    : code === "DATA_COLUMN_MISSING"
      ? [{
          repair_id: "confirm_real_column",
          label_zh: "核对并确认真实列名",
          description_zh: "先读取当前阶段的结构化字段，再确认变量角色；不自动替换研究变量。",
          affected_columns: [],
          row_impact: { rows_dropped: 0 },
          semantic_impact: "identification" as const,
          requires_confirmation: true,
          resulting_method_ids: [resolvedMethodID],
        }]
      : [{
          repair_id: "inspect_and_confirm",
          label_zh: "先检查当前数据阶段和方法前置条件",
          description_zh: "读取结构化诊断，确认是否修复数据、调整参数或改变研究设计。",
          affected_columns: [],
          row_impact: { rows_dropped: 0 },
          semantic_impact: "sample" as const,
          requires_confirmation: true,
          resulting_method_ids: [resolvedMethodID],
        }]
  const safeToRetry = input.safeToRetryOverride ?? (
    input.failureType === "process_timeout" || code === "TOOL_NOT_FOUND" || code === "METHOD_NOT_LOADED"
  )
  const summary = code === "DATA_SNAPSHOT_UNSTABLE"
    ? "执行前数据文件发生变化，系统未使用不稳定的数据快照运行估计器。"
    : code === "DATA_SNAPSHOT_FAILED"
      ? "计量引擎无法创建安全的数据快照，估计器没有运行。"
      : code === "DESIGN_MATRIX_RANK_DEFICIENT"
    ? "当前模型的解释变量存在完全共线关系，设计矩阵无法唯一识别。"
    : code === "DATA_COLUMN_MISSING"
      ? "当前计量设定引用了数据中不存在的变量列。"
      : code === "TOOL_NOT_FOUND"
        ? `模型请求的工具“${input.toolName}”未在当前注册目录中，本次调用没有执行。`
        : code === "METHOD_NOT_LOADED"
          ? `计量方法“${methodID ?? input.toolName}”已准入但尚未加载到当前引用窗口，本次调用没有执行。`
      : input.failureType === "unknown_failure"
        ? "工具返回了无法安全归类的失败，系统不能据此假装分析完成。"
        : `计量工具 ${methodID} 未完成：${text}`
  const userFallback = code === "DATA_SNAPSHOT_UNSTABLE" || code === "DATA_SNAPSHOT_FAILED"
    ? `本次没有运行估计器。${text}请确认源文件已停止写入、读取权限和磁盘空间可用，然后刷新数据诊断并重新准备规格；旧 PreparedSpec 不会自动复用。`
    : code === "TOOL_NOT_FOUND"
    ? "本次工具选择错误，任何操作都没有执行。请从当前已注册工具中选择能完成原目标的工具；如果没有等价能力，说明限制并询问用户，不要伪报完成或替换研究方法。"
    : code === "METHOD_NOT_LOADED"
      ? `本次计量调用没有执行。请先用 tool_search 加载“${methodID ?? input.toolName}”的完整 Schema，再按原研究设定调用；不要换方法。`
      : `本次估计没有完成，数据和已有结果均未被删除。原因：${summary} 系统不会在未获得确认时删除观测、填补缺失或改变研究方法。`
  return {
    failureCode: code,
    stage: code === "DATA_SNAPSHOT_FAILED" || code === "DATA_SNAPSHOT_UNSTABLE"
      ? "runtime"
      : input.failureType === "result_contract_failure"
      ? "result"
      : input.failureType === "process_timeout"
        ? "runtime"
        : code === "TOOL_NOT_FOUND" || code === "METHOD_NOT_LOADED"
          ? "input"
          : "estimate",
    methodID,
    summary_zh: summary,
    evidence: { failureType: input.failureType, message: text },
    repairOptions: options,
    safeToRetry,
    user_fallback_zh: userFallback,
  }
}
