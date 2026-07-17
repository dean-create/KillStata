import { describe, expect, test } from "bun:test"
import {
  buildGroundedFactLine,
  loadSummaryCases,
  scoreGroundedSummary,
} from "../../script/real-paper-summary-calibration"

describe("real-paper grounded Chinese summary calibration", () => {
  test("loads baseline, mechanism, and repaired-panel summary contracts", () => {
    const cases = loadSummaryCases()
    expect(cases.map((item) => item.id)).toEqual([
      "did-baseline-grounded-summary",
      "did-mechanism-grounded-summary",
      "digital-panel-grounded-summary",
    ])
    expect(cases.every((item) => Object.keys(item.facts).length === 4)).toBe(true)
    expect(buildGroundedFactLine(cases[2]!)).toBe("核心系数：6.9575；聚类标准误：0.2480；p值：<0.0001；样本量：9683。")
  })

  test("accepts a fully grounded restrained baseline summary", () => {
    const summaryCase = loadSummaryCases()[0]!
    const result = scoreGroundedSummary(
      summaryCase,
      "核心系数为0.0225，聚类标准误为0.0227，p值为0.3220，样本量为4709；该结果统计上不显著，不能据此宣称因果效应。",
    )
    expect(result.passed).toBe(true)
    expect(result.inventedNumbers).toEqual([])
  })

  test("rejects invented thresholds, missing facts, and overclaimed mechanism language", () => {
    const summaryCase = loadSummaryCases()[1]!
    const result = scoreGroundedSummary(
      summaryCase,
      "系数为-0.0045，p值为0.0912，在10%水平显著，因此证明了中介机制。",
    )
    expect(result.passed).toBe(false)
    expect(result.inventedNumbers).toContain("10")
    expect(result.missingFacts).toEqual(expect.arrayContaining(["0.0027", "4709"]))
    expect(result.forbiddenFound).toContain("证明了中介")
  })
})
