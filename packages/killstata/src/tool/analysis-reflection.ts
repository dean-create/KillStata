import fs from "fs"
import path from "path"
import { projectReflectionRoot } from "./analysis-state"

export type FailureType =
  | "file_not_found"
  | "path_resolution_error"
  | "column_not_found"
  | "encoding_or_locale_error"
  | "python_missing"
  | "dependency_broken"
  | "schema_mismatch"
  | "panel_integrity_failure"
  | "estimation_failure"
  | "qa_gate_blocked"
  | "tool_contract_failure"
  | "planning_failure"
  | "unknown_failure"

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

type FailurePattern = {
  pattern: string
  fix: string
}

export type ToolReflection = {
  toolName: string
  failureType: FailureType
  rootCause: string
  blocking: boolean
  retryStage: string
  repairAction: string
  userVisibleExplanation: string
  createdAt: string
  input?: Record<string, unknown>
  error: string
  qaGateStatus?: QaGateStatus
  qaGateReason?: string
  qaSource?: string
  reflectionPath?: string
  sessionId?: string
}

const DEFAULT_RETRY_MAX = 3

const DEFAULT_FAILURE_PATTERNS: FailurePattern[] = [
  {
    pattern: "missing columns in dataset",
    fix: "Inspect the imported schema and rewrite the tool call with exact column names before retrying.",
  },
  {
    pattern: "panel identifiers not found",
    fix: "Run QA on the working dataset, confirm entity/time identifiers, then retry the estimation stage only.",
  },
  {
    pattern: "no usable rows remain",
    fix: "Review missingness and filters, repair the data-prep stage, then rerun the model.",
  },
  {
    pattern: "failed to import econometric_algorithm",
    fix: "Run healthcheck, verify the Python environment, and repair dependencies before another attempt.",
  },
  {
    pattern: "weak instrument",
    fix: "Replace the instrument or redesign identification before reporting IV results.",
  },
  {
    pattern: "parallel trends",
    fix: "Repair the DID design or choose another identification strategy before reporting effects.",
  },
]

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
      if (numeric !== undefined) {
        found = numeric
        return
      }
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
  if (block) {
    return findNestedNumber(block, ["lm_pvalue", "f_pvalue", "breusch_pagan_pvalue", "p_value", "pvalue", "white_pvalue"])
  }
  return findNestedNumber(diagnostics, ["breusch_pagan_pvalue"])
}

function extractMaxVif(diagnostics: Record<string, unknown>) {
  const vifBlock = findNestedBlock(diagnostics, ["vif", "multicollinearity"])
  if (!vifBlock) return undefined
  const rows = Array.isArray(vifBlock.rows)
    ? vifBlock.rows
    : Array.isArray(vifBlock.values)
      ? vifBlock.values
      : undefined
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
  const weakIv = identification
    ? findNestedBlock(identification, ["weak_iv", "weak_instrument"])
    : findNestedBlock(diagnostics, ["weak_iv", "weak_instrument"])
  if (!weakIv) return undefined
  return findNestedNumber(weakIv, ["f_stat", "first_stage_f_stat", "first_stage_f", "kp_f_stat"])
}

function extractParallelTrendsFailure(diagnostics: Record<string, unknown>) {
  const block = findNestedBlock(diagnostics, ["parallel_trends", "parallel_trend", "pretrend_test", "pre_trends"])
  if (!block) return undefined

  const passed = typeof block.passed === "boolean"
    ? block.passed
    : typeof block.parallel_trends_passed === "boolean"
      ? block.parallel_trends_passed
      : undefined
  if (passed !== undefined) {
    return {
      failed: !passed,
      diagnosticValue: findNestedNumber(block, ["min_lead_p_value", "p_value", "pvalue"]),
      threshold: 0.05,
    }
  }

  const significantLeadCount = findNestedNumber(block, ["significant_lead_count"])
  if (significantLeadCount !== undefined) {
    return {
      failed: significantLeadCount > 0,
      diagnosticValue: significantLeadCount,
      threshold: 0,
    }
  }

  const minLeadPValue = findNestedNumber(block, ["min_lead_p_value", "p_value", "pvalue"])
  if (minLeadPValue !== undefined) {
    return {
      failed: minLeadPValue < 0.05,
      diagnosticValue: minLeadPValue,
      threshold: 0.05,
    }
  }

  return undefined
}

function inferFailureType(error: string): FailureType {
  const message = error.toLowerCase()
  if (message.includes("input file not found") || message.includes("data file not found")) return "file_not_found"
  if (message.includes("manifest not found") || message.includes("stage not found")) return "path_resolution_error"
  if (message.includes("variables not found") || message.includes("column not found") || message.includes("not in df.columns")) {
    return "column_not_found"
  }
  if (message.includes("unicode") || message.includes("encoding") || message.includes("gbk") || message.includes("utf-8")) {
    return "encoding_or_locale_error"
  }
  if (message.includes("failed to launch python") || message.includes("python was not found")) return "python_missing"
  if (message.includes("no module named") || message.includes("failed to import")) return "dependency_broken"
  if (message.includes("qa gate") || message.includes("blocking_errors")) return "qa_gate_blocked"
  if (message.includes("requires inputpath") || message.includes("invalid arguments") || message.includes("requires entityvar")) {
    return "tool_contract_failure"
  }
  if (message.includes("duplicate entity-time") || message.includes("panel identifiers not found")) return "panel_integrity_failure"
  if (message.includes("singular") || message.includes("estimation") || message.includes("regression") || message.includes("std. error")) {
    return "estimation_failure"
  }
  if (message.includes("schema")) return "schema_mismatch"
  if (message.includes("plan") || message.includes("workflow")) return "planning_failure"
  return "unknown_failure"
}

function defaultRepairAction(failureType: FailureType, toolName: string) {
  switch (failureType) {
    case "file_not_found":
      return "Search for the file again and pass the resolved absolute path."
    case "path_resolution_error":
      return "Resolve datasetId/stageId from the latest manifest and retry only the failed stage."
    case "column_not_found":
      return "Run profile/qa first, inspect exact column names, then rewrite the tool call with explicit names."
    case "encoding_or_locale_error":
      return "Preserve Unicode paths/column names, avoid lossy shell interpolation, and retry with structured arguments."
    case "python_missing":
      return "Point KILLSTATA_PYTHON to a valid interpreter and rerun healthcheck before analysis."
    case "dependency_broken":
      return "Run healthcheck, install missing Python dependencies, and retry from the failed stage."
    case "schema_mismatch":
      return "Normalize the dataset through import/profile before downstream actions."
    case "panel_integrity_failure":
      return "Run qa, inspect entity/time integrity, and deduplicate or repair panel keys before regression."
    case "estimation_failure":
      return "Recheck model inputs, missingness, and panel identifiers, then rerun only the estimation stage."
    case "qa_gate_blocked":
      return "Repair blocking QA issues, rerun the QA/clean stage, and only then continue the workflow."
    case "tool_contract_failure":
      return `Rewrite the ${toolName} tool call to satisfy the expected schema.`
    case "planning_failure":
      return "Insert a planning/profile/qa step before the failed analysis step."
    default:
      return "Inspect the structured error log and retry only the failed stage with the smallest repair."
  }
}

function retryStage(toolName: string, failureType: FailureType) {
  if (toolName === "data_import") {
    if (failureType === "file_not_found" || failureType === "path_resolution_error") return "ingest"
    if (failureType === "column_not_found" || failureType === "schema_mismatch") return "profile"
    if (failureType === "qa_gate_blocked") return "clean"
    return "clean"
  }
  if (toolName === "econometrics") {
    if (failureType === "qa_gate_blocked") return "qa"
    if (failureType === "panel_integrity_failure" || failureType === "column_not_found") return "qa"
    return "estimate"
  }
  return "verify"
}

function deriveRepairAction(error: string, fallback: string) {
  const normalized = error.toLowerCase()
  const match = loadFailurePatterns().find((item) => normalized.includes(item.pattern.toLowerCase()))
  return match?.fix ?? fallback
}

export function classifyToolFailure(input: {
  toolName: string
  error: string
  input?: Record<string, unknown>
  sessionId?: string
}): ToolReflection {
  const failureType = inferFailureType(input.error)
  return {
    toolName: input.toolName,
    failureType,
    rootCause: input.error.split("\n")[0] || input.error,
    blocking: failureType !== "unknown_failure",
    retryStage: retryStage(input.toolName, failureType),
    repairAction: deriveRepairAction(input.error, defaultRepairAction(failureType, input.toolName)),
    userVisibleExplanation: `The ${input.toolName} step failed with ${failureType}. Repair the failed stage only, then retry.`,
    createdAt: nowIso(),
    input: input.input,
    error: input.error,
    sessionId: input.sessionId,
  }
}

export function runPostEstimationGates(diagnostics: Record<string, unknown>, method: string): QAGateResult[] {
  const gates: QAGateResult[] = []
  const normalizedMethod = method.toLowerCase()

  const breuschPaganPValue = extractBreuschPaganPValue(diagnostics)
  if (breuschPaganPValue !== undefined) {
    const passed = breuschPaganPValue >= 0.05
    gates.push({
      gate: "heteroskedasticity",
      passed,
      severity: passed ? "info" : "warning",
      autoFix: passed ? undefined : "Switch inference to robust or clustered standard errors and rerun the model.",
      userMessage: passed
        ? "Breusch-Pagan did not indicate heteroskedasticity."
        : "Breusch-Pagan is significant; use robust or clustered standard errors before reporting inference.",
      diagnosticValue: breuschPaganPValue,
      threshold: 0.05,
    })
  }

  const maxVif = extractMaxVif(diagnostics)
  if (maxVif !== undefined) {
    const passed = maxVif <= 10
    gates.push({
      gate: "multicollinearity",
      passed,
      severity: passed ? "info" : "warning",
      autoFix: passed ? undefined : "Drop or combine collinear regressors, or respecify the model before interpreting coefficients.",
      userMessage: passed
        ? "VIF is within the acceptable range."
        : "VIF exceeds 10; multicollinearity may make coefficient estimates unstable.",
      diagnosticValue: maxVif,
      threshold: 10,
    })
  }

  const clusterCount = extractClusterCount(diagnostics)
  if (clusterCount !== undefined) {
    const passed = clusterCount >= 10
    gates.push({
      gate: "cluster_count",
      passed,
      severity: passed ? "info" : "warning",
      autoFix: passed ? undefined : "Use caution with clustered inference or switch to a more defensible covariance estimator.",
      userMessage: passed
        ? "Cluster count is adequate for clustered inference."
        : "Cluster count is below 10; clustered standard errors may be unstable.",
      diagnosticValue: clusterCount,
      threshold: 10,
    })
  }

  if (normalizedMethod.startsWith("iv_")) {
    const weakIvFStat = extractWeakIvFStat(diagnostics)
    if (weakIvFStat !== undefined) {
      const passed = weakIvFStat >= 10
      gates.push({
        gate: "weak_iv",
        passed,
        severity: passed ? "info" : "blocking",
        autoFix: passed ? undefined : "Replace the instrument or redesign identification before reporting IV results.",
        userMessage: passed
          ? "Instrument strength clears the weak-IV screen."
          : "Weak instrument detected; do not report IV results as credible with first-stage F below 10.",
        diagnosticValue: weakIvFStat,
        threshold: 10,
      })
    }
  }

  if (normalizedMethod.startsWith("did_")) {
    const parallelTrends = extractParallelTrendsFailure(diagnostics)
    if (parallelTrends) {
      gates.push({
        gate: "parallel_trends",
        passed: !parallelTrends.failed,
        severity: parallelTrends.failed ? "blocking" : "info",
        autoFix: parallelTrends.failed ? "Repair the DID design or switch to another identification strategy." : undefined,
        userMessage: parallelTrends.failed
          ? "Parallel trends may not hold; do not report the DID estimate until pre-trends are repaired."
          : "Parallel trends diagnostic did not flag a pre-trend violation.",
        diagnosticValue: parallelTrends.diagnosticValue,
        threshold: parallelTrends.threshold,
      })
    }
  }

  return gates
}

export function checkRetryBudget(toolName: string, sessionId: string): { allowed: boolean; count: number; max: number } {
  const max = DEFAULT_RETRY_MAX
  if (!sessionId) return { allowed: true, count: 0, max }

  const root = projectReflectionRoot()
  if (!fs.existsSync(root)) return { allowed: true, count: 0, max }

  let count = 0
  for (const entry of fs.readdirSync(root)) {
    if (!entry.endsWith(".json")) continue
    const filePath = path.join(root, entry)
    try {
      const reflection = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<ToolReflection>
      if (reflection.toolName === toolName && reflection.sessionId === sessionId) count += 1
    } catch {
      continue
    }
  }

  return { allowed: count < max, count, max }
}

export function loadFailurePatterns(): Array<{ pattern: string; fix: string }> {
  const patternsPath = path.join(projectReflectionRoot(), "patterns.json")
  if (!fs.existsSync(patternsPath)) return [...DEFAULT_FAILURE_PATTERNS]

  try {
    const parsed = JSON.parse(fs.readFileSync(patternsPath, "utf-8"))
    if (!Array.isArray(parsed)) return [...DEFAULT_FAILURE_PATTERNS]
    const valid = parsed.filter(
      (item): item is FailurePattern =>
        !!item &&
        typeof item === "object" &&
        typeof (item as FailurePattern).pattern === "string" &&
        typeof (item as FailurePattern).fix === "string",
    )
    return valid.length > 0 ? valid : [...DEFAULT_FAILURE_PATTERNS]
  } catch {
    return [...DEFAULT_FAILURE_PATTERNS]
  }
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
  const gateWarnings = (input.gates ?? [])
    .filter((gate) => !gate.passed && gate.severity === "warning")
    .map((gate) => gate.userMessage)
  const gateBlockingErrors = (input.gates ?? [])
    .filter((gate) => !gate.passed && gate.severity === "blocking")
    .map((gate) => gate.userMessage)
  const warnings = [...(input.warnings ?? []), ...gateWarnings].filter(Boolean)
  const blockingErrors = [...(input.blockingErrors ?? []), ...gateBlockingErrors].filter(Boolean)

  let qaGateStatus: QaGateStatus = "pass"
  if (warnings.length > 0) qaGateStatus = "warn"
  if (blockingErrors.length > 0) qaGateStatus = "block"

  const qaGateReason =
    qaGateStatus === "block"
      ? `QA gate blocked by ${blockingErrors.length} blocking issue(s): ${blockingErrors.join(" | ")}`
      : qaGateStatus === "warn"
        ? `QA gate warning(s): ${warnings.join(" | ")}`
        : "QA gate passed"

  const reflection =
    qaGateStatus === "block"
      ? ({
          toolName: input.toolName,
          failureType: "qa_gate_blocked",
          rootCause: qaGateReason,
          blocking: true,
          retryStage: retryStage(input.toolName, "qa_gate_blocked"),
          repairAction: defaultRepairAction("qa_gate_blocked", input.toolName),
          userVisibleExplanation: `The ${input.toolName} step is blocked by QA findings. Repair the failed QA stage only, then retry.`,
          createdAt: nowIso(),
          input: input.input,
          error: qaGateReason,
          qaGateStatus,
          qaGateReason,
          qaSource: input.qaSource,
          sessionId: input.sessionId,
        } satisfies ToolReflection)
      : undefined

  return {
    qaGateStatus,
    qaGateReason,
    qaSource: input.qaSource,
    warnings,
    blockingErrors,
    gates: input.gates ?? [],
    reflection,
  }
}

export function persistToolReflection(reflection: ToolReflection) {
  const root = projectReflectionRoot()
  fs.mkdirSync(root, { recursive: true })
  const filename = `${reflection.toolName}_${reflection.createdAt.replace(/[:.]/g, "-")}.json`
  const reflectionPath = path.join(root, filename)
  fs.writeFileSync(reflectionPath, JSON.stringify(reflection, null, 2), "utf-8")
  return reflectionPath
}
