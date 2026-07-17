import { describe, expect, test } from "bun:test"
import { runNswPsmEvidence } from "./src/psm-nsw"

describe("NSW 真实数据 PSM 验收", () => {
  test("construction 与 visualize 在真实 NSW 上同时取得 Harness 和独立数值证据", async () => {
    const report = await runNswPsmEvidence(["psm_construction", "psm_visualize"])
    expect(report.psm_construction.grade).toBe("B")
    expect(report.psm_construction.harness.lifecycle).toEqual(["queued", "running", "completed"])
    expect(report.psm_construction.numericOracle?.matched).toBe(true)
    expect(report.psm_visualize.grade).toBe("B")
    expect(report.psm_visualize.plotIsPng).toBe(true)
    expect(report.psm_visualize.numericOracle?.matched).toBe(true)
  }, 90_000)

  test("matching 与 IPW 对 NSW 的不合格设计必须安全拒绝，合格时才允许通过", async () => {
    const report = await runNswPsmEvidence(["psm_matching", "psm_ipw"])
    for (const item of [report.psm_matching, report.psm_ipw]) {
      expect(["B", "S"]).toContain(item.grade)
      if (item.grade === "S") expect(item.status).toBe("SAFE_REJECTION")
      else expect(item.numericOracle?.matched).toBe(true)
    }
    expect(report.psm_matching.error).not.toContain("Python interpreter")
    expect(report.psm_matching.error).not.toContain("Reflection log")
    expect(Object.keys(report.psm_ipw.diagnostic?.actual ?? {}).sort()).toEqual([
      "ate",
      "control_ess",
      "max_propensity_score",
      "max_weight",
      "min_propensity_score",
      "treatment_ess",
      "weighted_max_abs_smd",
    ])
  }, 90_000)
})
