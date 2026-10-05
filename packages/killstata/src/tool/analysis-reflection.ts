import type { FailureType, ToolReflection } from "../runtime/failure-reflection"
import {
  classifyToolFailure,
  persistToolReflection,
  qaBlockRepairAction,
  retryStageForToolFailure,
} from "../runtime/failure-reflection"

// ── Re-export 给下游工具使用 ──
export type { FailureType, ToolReflection }
export { classifyToolFailure, persistToolReflection, retryStageForToolFailure }

export type QaGateStatus = "pass" | "warn" | "block"
export type QAGateSeverity = "info" | "warning" | "blocking"

export type QAGateResult = {
  gate: string
  passed: boolean
  severity: QAGateSeverity
  autoFix?: string
  userMessage: string
  diagnosticValue?: number
  threshold?: number
}

function nowIso() {
  return new Date().toISOString()
}

function safeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function walk(value: unknown, visitor: (node: Record<string, unknown>) => void) {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visitor))
    return
  }
  if (!value || typeof value !== "object") return
  const node = value as Record<string, unknown>
  visitor(node)
  Object.values(node).forEach((item) => walk(item, visitor))
}

function findNestedNumber(value: unknown, keys: string[]) {
  const candidates = new Set(keys)
  let found: number | undefined
  walk(value, (node) => {
    if (found !== undefined) return
    for (const [key, raw] of Object.entries(node)) {
      if (!candidates.has(key)) continue
      const numeric = safeNumber(raw)
      if (numeric !== undefined) { found = numeric; return }
    }
  })
  return found
}

function findNestedBlock(value: unknown, keys: string[]) {
  const candidates = new Set(keys)
  let found: Record<string, unknown> | undefined
  walk(value, (node) => {
    if (found) return
    for (const [key, raw] of Object.entries(node)) {
      if (!candidates.has(key)) continue
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        found = raw as Record<string, unknown>
        return
      }
    }
  })
  return found
}

function extractBreuschPaganPValue(diagnostics: Record<string, unknown>) {
  const block = findNestedBlock(diagnostics, ["breusch_pagan", "heteroskedasticity"])
  if (block) return findNestedNumber(block, ["lm_pvalue", "f_pvalue", "breusch_pagan_pvalue", "p_value", "pvalue", "white_pvalue"])
  return findNestedNumber(diagnostics, ["breusch_pagan_pvalue"])
}

function extractMaxVif(diagnostics: Record<string, unknown>) {
  const vifBlock = findNestedBlock(diagnostics, ["vif", "multicollinearity"])
  if (!vifBlock) return undefined
  const rows = Array.isArray(vifBlock.rows) ? vifBlock.rows : Array.isArray(vifBlock.values) ? vifBlock.values : undefined
  if (!rows) return undefined
  let maxVif: number | undefined
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const vif = safeNumber((row as Record<string, unknown>).vif)
    if (vif === undefined) continue
    maxVif = maxVif === undefined ? vif : Math.max(maxVif, vif)
  }
  return maxVif
}

function extractClusterCount(diagnostics: Record<string, unknown>) {
  return findNestedNumber(diagnostics, ["cluster_count"])
}

function extractWeakIvFStat(diagnostics: Record<string, unknown>) {
  const identification = findNestedBlock(diagnostics, ["identification"])
  const weakIv = identification ? findNestedBlock(identification, ["weak_iv", "weak_instrument"]) : findNestedBlock(diagnostics, ["weak_iv", "weak_instrument"])
  if (!weakIv) return undefined
  return findNestedNumber(weakIv, ["f_stat", "first_stage_f_stat", "first_stage_f", "kp_f_stat"])
}

function extractParallelTrendsFailure(diagnostics: Record<string, unknown>) {
  const block = findNestedBlock(diagnostics, ["parallel_trends", "parallel_trend", "pretrend_test", "pre_trends"])
  if (!block) return undefined
  const passed = typeof block.passed === "boolean" ? block.passed : typeof block.parallel_trends_passed === "boolean" ? block.parallel_trends_passed : undefined
  if (passed !== undefined) return { failed: !passed, diagnosticValue: findNestedNumber(block, ["min_lead_p_value", "p_value", "pvalue"]), threshold: 0.05 }
  const significantLeadCount = findNestedNumber(block, ["significant_lead_count"])
  if (significantLeadCount !== undefined) return { failed: significantLeadCount > 0, diagnosticValue: significantLeadCount, threshold: 0 }
  const minLeadPValue = findNestedNumber(block, ["min_lead_p_value", "p_value", "pvalue"])
  if (minLeadPValue !== undefined) return { failed: minLeadPValue < 0.05, diagnosticValue: minLeadPValue, threshold: 0.05 }
  return undefined
}

export function runPostEstimationGates(diagnostics: Record<string, unknown>, method: string): QAGateResult[] {
  const gates: QAGateResult[] = []
  const normalizedMethod = method.toLowerCase()

  const breuschPaganPValue = extractBreuschPaganPValue(diagnostics)
  if (breuschPaganPValue !== undefined) {
    const passed = breuschPaganPValue >= 0.05
    gates.push({ gate: "heteroskedasticity", passed, severity: passed ? "info" : "warning", autoFix: passed ? undefined : "Switch inference to robust or clustered standard errors and rerun the model.", userMessage: passed ? "Breusch-Pagan did not indicate heteroskedasticity." : "Breusch-Pagan is significant; use robust or clustered standard errors before reporting inference.", diagnosticValue: breuschPaganPValue, threshold: 0.05 })
  }

  const maxVif = extractMaxVif(diagnostics)
  if (maxVif !== undefined) {
    const passed = maxVif <= 10
    gates.push({ gate: "multicollinearity", passed, severity: passed ? "info" : "warning", autoFix: passed ? undefined : "Drop or combine collinear regressors, or respecify the model before interpreting coefficients.", userMessage: passed ? "VIF is within the acceptable range." : "VIF exceeds 10; multicollinearity may make coefficient estimates unstable.", diagnosticValue: maxVif, threshold: 10 })
  }

  const clusterCount = extractClusterCount(diagnostics)
  if (clusterCount !== undefined) {
    const passed = clusterCount >= 10
    gates.push({ gate: "cluster_count", passed, severity: passed ? "info" : "warning", autoFix: passed ? undefined : "Use caution with clustered inference or switch to a more defensible covariance estimator.", userMessage: passed ? "Cluster count is adequate for clustered inference." : "Cluster count is below 10; clustered standard errors may be unstable.", diagnosticValue: clusterCount, threshold: 10 })
  }

  if (normalizedMethod.startsWith("iv_")) {
    const weakIvFStat = extractWeakIvFStat(diagnostics)
    if (weakIvFStat !== undefined) {
      const passed = weakIvFStat >= 10
      gates.push({ gate: "weak_iv", passed, severity: passed ? "info" : "warning", autoFix: passed ? undefined : "Consider Anderson-Rubin 稳健推断，或在报告中明确说明弱工具风险后继续报告 IV 估计。", userMessage: passed ? "Instrument strength clears the weak-IV screen." : "弱工具变量提示 first-stage F<10（Staiger-Stock 经验阈值）；IV 估计只能作为受限证据，是否仍报告、如何措辞由你判断。", diagnosticValue: weakIvFStat, threshold: 10 })
    }
  }

  if (normalizedMethod.startsWith("did_")) {
    const parallelTrends = extractParallelTrendsFailure(diagnostics)
    if (parallelTrends) {
      gates.push({ gate: "parallel_trends", passed: !parallelTrends.failed, severity: parallelTrends.failed ? "blocking" : "info", autoFix: parallelTrends.failed ? "可考虑 PSM-DID / 安慰剂 / 加控制变量 / 报告受限证据等稳健性方案，是否调整识别策略由你判断。" : undefined, userMessage: parallelTrends.failed ? "平行趋势诊断提示不通过，DID 因果解释的稳健性受质疑。" : "Parallel trends diagnostic did not flag a pre-trend violation.", diagnosticValue: parallelTrends.diagnosticValue, threshold: parallelTrends.threshold })
    }
  }

  return gates
}

export function evaluateQaGate(input: {
  toolName: string
  qaSource: string
  warnings?: string[]
  blockingErrors?: string[]
  input?: Record<string, unknown>
  sessionId?: string
  gates?: QAGateResult[]
}) {
  const gateWarnings = (input.gates ?? []).filter((gate) => !gate.passed && gate.severity === "warning").map((gate) => gate.userMessage)
  const gateBlockingErrors = (input.gates ?? []).filter((gate) => !gate.passed && gate.severity === "blocking").map((gate) => gate.userMessage)
  const warnings = [...(input.warnings ?? []), ...gateWarnings].filter(Boolean)
  const blockingErrors = [...(input.blockingErrors ?? []), ...gateBlockingErrors].filter(Boolean)
  let qaGateStatus: string = "pass"
  if (warnings.length > 0) qaGateStatus = "warn"
  if (blockingErrors.length > 0) qaGateStatus = "block"
  const qaGateReason = qaGateStatus === "block" ? `数据质量检查 blocked by ${blockingErrors.length} blocking issue(s): ${blockingErrors.join(" | ")}` : qaGateStatus === "warn" ? `数据质量检查 warning(s): ${warnings.join(" | ")}` : "数据质量检查 passed"
  const reflection = qaGateStatus === "block" ? ({
    toolName: input.toolName,
    failureType: "validate_blocked" as FailureType,
    rootCause: qaGateReason,
    blocking: true,
    retryStage: retryStageForToolFailure(input.toolName, "validate_blocked"),
    repairAction: qaBlockRepairAction(blockingErrors),
    userVisibleExplanation: "数据质检发现待处理项；请只修复当前数据阶段，重新质检后再继续分析。",
    createdAt: nowIso(),
    input: input.input,
    error: qaGateReason,
    qaGateStatus,
    qaGateReason,
    qaSource: input.qaSource,
    sessionId: input.sessionId,
  } satisfies ToolReflection) : undefined
  return { qaGateStatus, qaGateReason, qaSource: input.qaSource, warnings, blockingErrors, gates: input.gates ?? [], reflection }
}
