/**
 * principle_checks 方法级诊断的契约测试。
 *
 * 全部测试纯函数（standardDiagnosticStatus / mergePrincipleStatus / buildPrincipleChecks /
 * extractWeakIvFStat 等），不依赖 Python 后端，< 10ms 跑完。
 */

import { describe, expect, test } from "bun:test"
import {
  type PrincipleChecks,
  buildPrincipleChecks,
  mergePrincipleStatus,
  standardDiagnosticStatus,
  computeClaimCeiling,
  extractWeakIvFStat,
  extractCommonSupportStatus,
  extractPanelDuplicateStatus,
  extractParallelTrendsStatus,
} from "@/runtime/principle-checks"

// ── standardDiagnosticStatus ──

describe("standardDiagnosticStatus", () => {
  test("warnings/blocking_errors 都没有 → pass", () => {
    const s = standardDiagnosticStatus({ warnings: [], blocking_errors: [] })
    expect(s.status).toBe("pass")
    expect(s.findings).toEqual([])
  })

  test("warnings 有 → warn", () => {
    const s = standardDiagnosticStatus({ warnings: ["收敛警告"], blocking_errors: [] })
    expect(s.status).toBe("warn")
    expect(s.findings).toContain("收敛警告")
  })

  test("blocking_errors 有 → block（即使 warnings 也有）", () => {
    const s = standardDiagnosticStatus({
      warnings: ["收敛警告"],
      blocking_errors: ["奇异矩阵"],
    })
    expect(s.status).toBe("block")
    expect(s.findings).toContain("奇异矩阵")
    // block 优先，warnings 不追加
    expect(s.findings).not.toContain("收敛警告")
  })

  test("非数组字段安全处理", () => {
    const s = standardDiagnosticStatus({})
    expect(s.status).toBe("pass")
  })
})

// ── mergePrincipleStatus ──

describe("mergePrincipleStatus", () => {
  test("block 优先于 warn", () => {
    expect(mergePrincipleStatus("warn", "block")).toBe("block")
    expect(mergePrincipleStatus("block", "warn")).toBe("block")
  })
  test("warn 优先于 pass", () => {
    expect(mergePrincipleStatus("pass", "warn")).toBe("warn")
  })
  test("pass + pass = pass", () => {
    expect(mergePrincipleStatus("pass", "pass")).toBe("pass")
  })
})

// ── computeClaimCeiling ──

describe("computeClaimCeiling", () => {
  test("pass + pass → full", () => {
    expect(computeClaimCeiling("pass", "pass")).toBe("full")
  })
  test("warn + pass → restricted", () => {
    expect(computeClaimCeiling("warn", "pass")).toBe("restricted")
  })
  test("pass + warn → restricted", () => {
    expect(computeClaimCeiling("pass", "warn")).toBe("restricted")
  })
  test("block + anything → blocked", () => {
    expect(computeClaimCeiling("block", "pass")).toBe("blocked")
    expect(computeClaimCeiling("block", "warn")).toBe("blocked")
    expect(computeClaimCeiling("block", "block")).toBe("blocked")
  })
})

// ── buildPrincipleChecks（实际注入的最终形状）──

describe("buildPrincipleChecks", () => {
  test("返回结构含所有必要字段", () => {
    const pc = buildPrincipleChecks({ method: "ols_regression", prereqStatus: "pass", diagnosticsStatus: "pass", findings: [] })
    expect(pc.method).toBe("ols_regression")
    expect(pc.claim_ceiling).toBe("full")
    expect(pc.prereq_status).toBe("pass")
    expect(pc.diagnostics_status).toBe("pass")
    expect(pc.findings).toEqual([])
  })

  test("method-specific 合并后的最终 shape（IV 弱 F<10 降为 warn/restricted，交给模型判断）", () => {
    // 模拟 IV 弱工具场景：通用检查 pass + 弱 F 分支 → warn（Staiger-Stock 阈值只是参考）
    const std = standardDiagnosticStatus({ warnings: [], blocking_errors: [] })
    const merged = mergePrincipleStatus(std.status, "warn")
    const pc = buildPrincipleChecks({
      method: "iv_2sls",
      prereqStatus: "pass",
      diagnosticsStatus: merged,
      findings: ["弱工具变量诊断提示 first-stage F=3.24（<10 经验阈值）。该 IV 估计只能作为受限证据，是否仍报告、如何措辞由你判断。"],
    })
    expect(pc.claim_ceiling).toBe("restricted")
    expect(pc.findings[0]).toMatch(/F/)
  })

  test("RDD 小样本场景（rowsUsed<30 降为 warn/restricted）", () => {
    const std = standardDiagnosticStatus({ warnings: [], blocking_errors: [] })
    const merged = mergePrincipleStatus(std.status, "warn") // rowsUsed < 30
    const pc = buildPrincipleChecks({
      method: "rdd_sharp",
      prereqStatus: "pass",
      diagnosticsStatus: merged,
      findings: ["RDD 有效样本 25 偏少（<30 经验阈值）。估计精度需要结合带宽、断点附近样本和稳健性检查综合判断，是否仍报告及如何措辞由你决定。"],
    })
    expect(pc.claim_ceiling).toBe("restricted")
  })

  test("PSM 高 SMD 场景", () => {
    const std = standardDiagnosticStatus({ warnings: [], blocking_errors: [] })
    const merged = mergePrincipleStatus(std.status, "block") // weightedMaxAbsSmd > 0.1
    const pc = buildPrincipleChecks({
      method: "psm_regression",
      prereqStatus: "pass",
      diagnosticsStatus: merged,
      findings: ["PSM 加权后最大绝对 SMD=0.2541 超过 0.1。"],
    })
    expect(pc.claim_ceiling).toBe("blocked")
  })

  test("DID 2×2 无平行趋势诊断块 → 降级为 restricted（pyfixest did_static 接入逻辑）", () => {
    // 复刻 pyfixest.ts executePyfixest 里 did_static 分支的接线：
    // runner 只发 warning、无结构化 parallel_trends 块 → extract 返回 undefined →
    // 显式补一条"缺少平行趋势诊断"的 finding 并 warn。
    const result = { warnings: ["数据只有两个时期，无法仅凭本样本检验政策前平行趋势。"] }
    const standard = standardDiagnosticStatus(result)
    let diagnosticsStatus = standard.status
    const findings = [...standard.findings]

    const parallelTrends = extractParallelTrendsStatus(result)
    expect(parallelTrends).toBeUndefined()
    diagnosticsStatus = mergePrincipleStatus(diagnosticsStatus, "warn")
    findings.push("DID 结果缺少平行趋势诊断，因果解释应保持谨慎。")

    const pc = buildPrincipleChecks({ method: "did_static", prereqStatus: "pass", diagnosticsStatus, findings })
    expect(pc.claim_ceiling).toBe("restricted")
    expect(pc.findings.some((f) => f.includes("平行趋势"))).toBe(true)
  })

  test("DID 有结构化平行趋势块且不通过 → 降级为 blocked（未来软诊断形态）", () => {
    const result: { warnings?: unknown; blocking_errors?: unknown; parallel_trends?: { passed: boolean } } = {
      parallel_trends: { passed: false },
    }
    const standard = standardDiagnosticStatus(result)
    let diagnosticsStatus = standard.status
    const findings = [...standard.findings]

    const parallelTrends = extractParallelTrendsStatus(result)
    expect(parallelTrends).toBe(false)
    diagnosticsStatus = mergePrincipleStatus(diagnosticsStatus, "block")
    findings.push("平行趋势诊断未通过，当前结果不支持因果解释。")

    const pc = buildPrincipleChecks({ method: "did_static", prereqStatus: "pass", diagnosticsStatus, findings })
    expect(pc.claim_ceiling).toBe("blocked")
  })
})

// ── 诊断提取器 ──

describe("extractWeakIvFStat", () => {
  test("标准结构", () => {
    expect(extractWeakIvFStat({ identification: { weak_iv: { f_stat: 8.2 } } })).toBeCloseTo(8.2)
  })
  test("别名键（first_stage_f）", () => {
    expect(extractWeakIvFStat({ identification: { weak_iv: { first_stage_f: 5.1 } } })).toBeCloseTo(5.1)
  })
  test("顶层 weak_iv", () => {
    expect(extractWeakIvFStat({ weak_iv: { kp_f_stat: 2.5 } })).toBeCloseTo(2.5)
  })
  test("无诊断字段 → undefined", () => {
    expect(extractWeakIvFStat({})).toBeUndefined()
  })
})

describe("extractCommonSupportStatus", () => {
  test("明确 pass", () => {
    expect(extractCommonSupportStatus({ matching: { common_support: { passed: true } } })).toBe(true)
  })
  test("明确 fail", () => {
    expect(extractCommonSupportStatus({ matching: { common_support: { passed: false } } })).toBe(false)
  })
  test("通过 overlap 比例推断", () => {
    expect(extractCommonSupportStatus({ psm: { common_support: { overlap_share: 0.3 } } })).toBe(true)
  })
  test("无诊断 → undefined", () => {
    expect(extractCommonSupportStatus({})).toBeUndefined()
  })
})

describe("extractPanelDuplicateStatus", () => {
  test("无重复", () => {
    expect(extractPanelDuplicateStatus({ panel: { duplicate_entity_time: 0 } })).toBe(true)
  })
  test("有重复", () => {
    expect(extractPanelDuplicateStatus({ panel: { duplicate_count: 3 } })).toBe(false)
  })
  test("无诊断 → undefined", () => {
    expect(extractPanelDuplicateStatus({})).toBeUndefined()
  })
})

describe("extractParallelTrendsStatus", () => {
  test("通过 passed 字段", () => {
    expect(extractParallelTrendsStatus({ parallel_trends: { passed: true } })).toBe(true)
  })
  test("通过 p 值推断", () => {
    expect(extractParallelTrendsStatus({ pretrend_test: { min_lead_p_value: 0.32 } })).toBe(true)
    expect(extractParallelTrendsStatus({ pretrend_test: { p_value: 0.01 } })).toBe(false)
  })
  test("无诊断 → undefined", () => {
    expect(extractParallelTrendsStatus({})).toBeUndefined()
  })
})
