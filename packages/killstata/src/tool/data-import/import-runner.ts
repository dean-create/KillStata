import fs from "fs"
import {
  type DataAction,
  type PythonResult,
  CJK_MOJIBAKE_MARKERS,
} from "./schema"

// ── Mojiake 检测 ──

export function looksLikeMojibake(value?: string) {
  if (!value) return false
  return (
    value.includes("�") ||
    /(?:Ã.|Â.|æ.|ç.|é.|è.)/.test(value) ||
    CJK_MOJIBAKE_MARKERS.some((marker) => value.includes(marker))
  )
}

export function schemaLooksLikeMojibake(schemaPath?: string) {
  if (!schemaPath || !fs.existsSync(schemaPath)) return false
  try {
    const raw = fs.readFileSync(schemaPath, "utf-8")
    const parsed = JSON.parse(raw) as { schema?: Array<{ name?: string }> }
    const 列 = Array.isArray(parsed.schema) ? parsed.schema : []
    return 列.some((column) => looksLikeMojibake(column.name))
  } catch {
    return false
  }
}

export function shouldReuseImportStage(input: { sourcePath?: string; schemaPath?: string }) {
  return !looksLikeMojibake(input.sourcePath) && !schemaLooksLikeMojibake(input.schemaPath)
}

// ── 警告与展示 ──

export function buildDataImportWarnings(input: {
  result: PythonResult
  qaGate: { qaGateStatus?: string; qaGateReason?: string }
}) {
  return [
    ...(input.result.warnings ?? []),
    ...(input.result.blocking_errors ?? []),
    ...(input.result.readiness?.exactLinearDependencies ?? [])
      .slice(0, 4)
      .map((dependency) => `完全共线提醒：${dependency.relation}。涉及这些变量的回归规格必须先征得用户确认。`),
    input.qaGate.qaGateStatus === "warn" || input.qaGate.qaGateStatus === "block"
      ? input.qaGate.qaGateReason
      : undefined,
  ].filter((item): item is string => Boolean(item))
}

// ── 参数校验 ──

export function requireResolvableInput(
  action: DataAction,
  input: { inputPath?: string; datasetId?: string; stageId?: string },
) {
  if (action === "healthcheck" || action === "rollback") return
  if (input.inputPath) return
  // dataset manifest 的 getStage 在省略 stageId 时会稳定选择该数据集的最新阶段。
  // 这是无歧义的运行时补全，不改变数据或研究规格；允许模型漏传 stageId 后继续
  // 使用当前会话已确认的数据，而不是把一个可修复的引用错误暴露给用户。
  if (input.datasetId) return
  throw new Error(`数据动作 ${action} 需要 inputPath，或提供当前会话的 datasetId。`)
}

export function isStageProducingAction(action: DataAction) {
  return action === "import" || action === "rollback"
}

export function effectiveOutputFormat(params: { action: DataAction; format?: "csv" | "xlsx" | "dta" | "parquet" }) {
  if (isStageProducingAction(params.action)) return "parquet" as const
  if (params.action === "profile" || params.action === "correlation" || params.action === "frequency") return "json" as const
  if (params.action === "validate" || params.action === "healthcheck") return "json" as const
  return params.format ?? "csv"
}
