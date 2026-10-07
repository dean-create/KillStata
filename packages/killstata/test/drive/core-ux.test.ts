import { describe, expect, test } from "bun:test"
import { coreUxAssertions, type ScenarioAssertionContext } from "./scenarios"

const context = (finalAssistantText: string): ScenarioAssertionContext => ({
  toolCalls: [], toolErrors: [], sessionErrors: [], timedOut: false,
  run: undefined, resultFiles: [], questionCount: 0, questionEvents: [],
  assistantText: finalAssistantText, assistantTexts: [finalAssistantText],
  toolProgress: ["已完成真实数据画像与方法诊断"],
  turnTexts: [[finalAssistantText]], lastTurnAssistantText: finalAssistantText, finalAssistantText,
})

describe("five core journeys have actionable UX coverage", () => {
  const ids = ["data-inspect-only", "ols-basic", "gf-panel", "staggered-did", "psm-matching-basic"] as const

  test("every core journey has common and method-specific UX assertions", () => {
    for (const id of ids) {
      const checks = coreUxAssertions(id, context("已完成数据检查，当前结果有 4709 行。"))
      expect(checks.length).toBeGreaterThanOrEqual(3)
      expect(checks.every((item) => item.category === "ux")).toBe(true)
    }
  })

  test("internal data lineage never appears in a user-facing report", () => {
    const checks = coreUxAssertions("ols-basic", context("OLS 回归 N=4709；datasetId=secret"))
    expect(checks.find((item) => item.label === "不泄漏内部状态")?.pass).toBe(false)
  })

  test("a DID design stop must say which columns the researcher should provide", () => {
    const checks = coreUxAssertions("staggered-did", context("当前无法安全构造动态效应，请提供 cohort 和 relative_time 两列。"))
    expect(checks.find((item) => item.label === "DID 停点说明所需列")?.pass).toBe(true)
  })
})
