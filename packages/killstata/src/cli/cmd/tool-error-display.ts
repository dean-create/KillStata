import { containsEngineInternalData, userFacingAnalysisErrorText } from "../../runtime/analysis-text-sanitizer"
import { displayStepLabel } from "../../runtime/analysis-user-view"
import { Redact } from "../../util/redact"

/**
 * 面向用户的错误标题不得出现内部工具 ID（data_import / econometrics_execute）或
 * “未知错误”这类无信息量标签——用户看到的应是“哪一步没成 + 是什么类型的问题”。
 * 工具中文名复用 displayStepLabel 的既有映射，避免再维护第二张表。
 */
function userFacingToolLabel(tool: string) {
  // data_import 是数据导入/画像/质检的统一入口，没有单一动作时按“数据处理”呈现。
  if (tool === "data_import" || tool === "data_preprocess") return "数据处理"
  if (tool === "econometrics_execute" || tool === "tool_search" || tool === "pipeline") return "这一步"
  const label = displayStepLabel(tool)
  // displayStepLabel 未命中时会原样返回 step，这里必须挡住，避免内部工具 ID 泄露给用户。
  return !label || label === tool ? "这一步" : label
}

export function analysisToolErrorPresentation(input: {
  tool: string
  failureType?: string
  failureLabel: string
}): { tone: "warning" | "error"; title: string; guidanceLabel: string } {
  const isQaFinding = input.failureType === "validate_blocked" || input.failureType === "panel_integrity_failure"
  if (isQaFinding) {
    return {
      tone: "warning",
      title: "数据质检发现待处理项 · 暂未继续分析",
      guidanceLabel: "建议下一步",
    }
  }
  const step = userFacingToolLabel(input.tool)
  // 归因不明时只说“没能完成”，不把 unknown_failure 的占位标签推给用户。
  const hasUsefulLabel = Boolean(input.failureType) && input.failureType !== "unknown_failure"
  return {
    tone: "error",
    title: hasUsefulLabel ? `${step}未完成 · ${input.failureLabel}` : `${step}未完成`,
    guidanceLabel: "修复建议",
  }
}

// P1-A：`killstata run` 一次性命令的流式渲染路径原先直接把工具报错原文印给用户，
// 泄露英文技术错误、内部工具 ID、Python traceback 和本机绝对路径。TUI transcript
// 路径早已有中文脱敏，这里让 CLI 复用同一套映射，保持两条渲染路径行为一致。
//
// 优先级：
// 1. 命中已知分析类错误（数据质量检查 门、重复键、工具不可用、traceback 等）→ 复用现有中文兜底；
// 2. 未命中但仍含内部技术碎片 → 通用中文兜底，绝不泄露原文；
// 3. 其余普通错误（如网络超时）→ 保留脱敏后原文，因为这对用户是有用的诊断信息。
export function friendlyToolErrorForCli(rawError: string): string {
  const friendly = userFacingAnalysisErrorText(rawError)
  if (friendly) return friendly
  if (containsEngineInternalData(rawError)) {
    return "这一步没能完成，系统已跳过内部技术细节；请重试当前任务或调整需求。"
  }
  return Redact.text(rawError, 500)
}
