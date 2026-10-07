/**
 * 声明上限类型系统——模型对计量结果能下多强的因果结论。
 *
 * 每种方法在返回前都要经过一道原则检查（prereq/diagnostics），输出一个
 * claim_ceiling，作为 metadata.result.principle_checks 的一部分返回给模型。
 *
 *   "full"       → 前提齐全、诊断通过，可完整表述
 *   "restricted" → 诊断缺项或警告，只能说"参考性/受限证据"
 *   "blocked"    → 前提不满足或诊断失败，不应做出因果判断
 *
 * **消费方**：`tool-result-policy.ts` 的 `extractClaimCeilingAdvisory()` 读取
 * `principle_checks.claim_ceiling` 生成 `_claimAdvisory` 软提示（唯一消费方）；模型"自觉"遵守，
 * 无硬拦截。如需硬拦截，必须补消费方。
 *
 * 每个工具各自调 buildPrincipleChecks() 传入自己的检查结果。
 *
 * 实际接入 method-specific 检查的工具（按 src/tool/ 真实注入情况）：
 *   - iv       : 弱工具变量 F 检验（first-stage F<10 → warn，Staiger-Stock 经验阈值；模型根据样本量与设计判断）
 *   - rdd      : 样本量门槛（rowsUsed<30 → warn，任意参考阈值；模型结合带宽与断点附近样本判断）
 *   - pyfixest : did_static 平行趋势（无诊断→warn，不通过→block）
 *   - psm      : 共同支撑/加权平衡/ESS（由统一引擎结果投影注入）
 *   - psm (via psm-backend.ts) : SMD/ESS/共同支撑多维检查
 *
 * 下面这十类**只有 standardDiagnosticStatus 通用检查**（prereqStatus 硬编码 pass）：
 *   - ols, quantile, multinomial, rlm, wls, glm, count, panel, panel-fe, iv-test
 *   - Panel-FE 的"主键重复"在 python runner.py:39 已被硬阻断（duplicate
 *     永远到不了这里），extractor 永远返回 undefined = 死代码，故未接入。
 *     其它工具（OLS/GLM/Count 等）原本应有但拆分时丢失的方法特定检查
 *     （VIF/过离散/IIA/收敛等）暂未补——按需接入，不阻塞当前验收。
 */

export type PrincipleCheckStatus = "pass" | "warn" | "block"
export type ClaimCeiling = "full" | "restricted" | "blocked"

export type PrincipleChecks = {
  method: string
  prereq_status: PrincipleCheckStatus
  diagnostics_status: PrincipleCheckStatus
  claim_ceiling: ClaimCeiling
  findings: string[]
}

/** 取两路状态中较严重者。 */
export function mergePrincipleStatus(
  current: PrincipleCheckStatus,
  next: PrincipleCheckStatus,
): PrincipleCheckStatus {
  if (current === "block" || next === "block") return "block"
  if (current === "warn" || next === "warn") return "warn"
  return "pass"
}

/** 根据前检和诊断的合成状态计算声明上限。 */
export function computeClaimCeiling(
  prereq: PrincipleCheckStatus,
  diagnostics: PrincipleCheckStatus,
): ClaimCeiling {
  if (prereq === "block" || diagnostics === "block") return "blocked"
  if (prereq === "warn" || diagnostics === "warn") return "restricted"
  return "full"
}

/** 通用检查：从后端返回的 result 上扫 warnings/blocking_errors。 */
export function standardDiagnosticStatus(result: {
  warnings?: unknown
  blocking_errors?: unknown
}): { status: PrincipleCheckStatus; findings: string[] } {
  const findings: string[] = []
  if (Array.isArray(result.blocking_errors) && result.blocking_errors.length > 0) {
    return {
      status: "block",
      findings: [...(result.blocking_errors as string[])],
    }
  }
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    return {
      status: "warn",
      findings: [...(result.warnings as string[])],
    }
  }
  return { status: "pass", findings: [] }
}

/**
 * 构造最终的 PrincipleChecks。
 * 工具传入：方法名、prereq & diagnostics 各自的状态（含 method-specific 检查结果）、findings 数组。
 */
export function buildPrincipleChecks(input: {
  method: string
  prereqStatus: PrincipleCheckStatus
  diagnosticsStatus: PrincipleCheckStatus
  findings?: string[]
}): PrincipleChecks {
  return {
    method: input.method,
    prereq_status: input.prereqStatus,
    diagnostics_status: input.diagnosticsStatus,
    claim_ceiling: computeClaimCeiling(input.prereqStatus, input.diagnosticsStatus),
    findings: input.findings ?? [],
  }
}

// ── 诊断提取器（从后端结果/diagnostics.json 中提取方法级信号）─────

/**
 * 在嵌套对象中按优先级查找第一个存在的 key。
 * 例：findNestedBlock(d, ["parallel_trends", "parallel_trend", "pretrend_test"])
 *   先查 d.parallel_trends，没有再看 d.parallel_trend，依次类推。
 */
function findNestedBlock(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined
  for (const key of keys) {
    const block = (value as Record<string, unknown>)[key]
    if (block && typeof block === "object" && !Array.isArray(block)) {
      return block as Record<string, unknown>
    }
  }
  // 递归搜一层（diagnostics 顶层常是第一层）
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = findNestedBlock(v, keys)
      if (found) return found
    }
  }
  return undefined
}

/** 在嵌套对象中查找数字字段。 */
function findNestedNumber(
  value: unknown,
  keys: string[],
): number | undefined {
  if (!value || typeof value !== "object") return undefined
  for (const key of keys) {
    const v = (value as Record<string, unknown>)[key]
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  // 递归搜一层
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = findNestedNumber(v, keys)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** 平行趋势状态：true=通过；false=不通过；undefined=无诊断。 */
export function extractParallelTrendsStatus(diagnostics: unknown): boolean | undefined {
  const block = findNestedBlock(diagnostics, ["parallel_trends", "parallel_trend", "pretrend_test", "pre_trends"])
  if (!block) return undefined
  if (typeof block.passed === "boolean") return block.passed
  if (typeof block.parallel_trends_passed === "boolean") return block.parallel_trends_passed
  const significantLeadCount = findNestedNumber(block, ["significant_lead_count"])
  if (significantLeadCount !== undefined) return significantLeadCount <= 0
  const minLeadPValue = findNestedNumber(block, ["min_lead_p_value", "p_value", "pvalue"])
  if (minLeadPValue !== undefined) return minLeadPValue >= 0.05
  return undefined
}

/** 弱工具变量 first-stage F 统计量；undefined=无诊断。 */
export function extractWeakIvFStat(diagnostics: unknown): number | undefined {
  const identification = findNestedBlock(diagnostics, ["identification"])
  const weakIv = identification
    ? findNestedBlock(identification, ["weak_iv", "weak_instrument"])
    : findNestedBlock(diagnostics, ["weak_iv", "weak_instrument"])
  if (!weakIv) return undefined
  return findNestedNumber(weakIv, ["f_stat", "first_stage_f_stat", "first_stage_f", "kp_f_stat"])
}

/** 共同支撑状态：true=通过；false=不通过；undefined=无诊断。 */
export function extractCommonSupportStatus(diagnostics: unknown): boolean | undefined {
  const scope = findNestedBlock(diagnostics, ["matching", "psm"]) ?? diagnostics
  const commonSupport = findNestedBlock(scope as Record<string, unknown>, ["common_support"])
  if (!commonSupport) return undefined
  if (typeof commonSupport.passed === "boolean") return commonSupport.passed
  if (typeof commonSupport.support_ok === "boolean") return commonSupport.support_ok
  const overlapShare = findNestedNumber(commonSupport, ["overlap_share", "matched_share", "support_share", "share_in_support"])
  if (overlapShare !== undefined) return overlapShare > 0
  return undefined
}

/** 面板主键重复状态：true=无重复；false=有重复；undefined=无诊断。 */
export function extractPanelDuplicateStatus(diagnostics: unknown): boolean | undefined {
  const panel = findNestedBlock(diagnostics, ["panel"])
  if (!panel) return undefined
  const duplicateCount = findNestedNumber(panel, [
    "duplicate_entity_time",
    "duplicate_panel_keys",
    "duplicate_count",
  ])
  if (duplicateCount !== undefined) return duplicateCount === 0
  return undefined
}
