import { describe, expect, test } from "bun:test"
import type { ScenarioRunReport } from "./runner"
import { aggregateDriveReports, compareDriveReports, driveOutcome } from "./compare"

function report(overrides: Partial<ScenarioRunReport> = {}): ScenarioRunReport {
  return {
    scenarioID: "ols-basic",
    scenarioLabel: "OLS",
    pass: true,
    timedOut: false,
    questionCount: 0,
    questionEvents: [],
    toolErrors: [],
    toolCalls: [],
    activeStage: "baseline_estimate",
    stageChain: [],
    latestFailure: undefined,
    resultFiles: ["results.json"],
    assertions: [
      { label: "未超时", pass: true, detail: "" },
      { label: "baseline_estimate 完成", pass: true, detail: "" },
      { label: "正确调用 OLS", pass: true, detail: "" },
      { label: "UX 报告质量", pass: true, detail: "", category: "ux" },
    ],
    elapsedMs: 100,
    assistantTexts: [],
    turnTexts: [],
    lastTurnAssistantText: "",
    finalAssistantText: "",
    assistantTail: "",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      estimatedCost: 0.01,
    },
    manifest: {
      schemaVersion: 1,
      scenarioID: "ols-basic",
      modelID: "model-a",
      inputHash: "hash-a",
      runKey: "run-1",
    },
    ...overrides,
  }
}

describe("drive comparison metrics", () => {
  test("restored tool mistakes preserve stability loss without failing the completed task", () => {
    const recovered = { tool: "data_import", error: "找不到输入文件" }
    const outcome = driveOutcome({
      assertions: [{ label: "完成同一规格估计", pass: true, detail: "" }],
      toolErrors: [recovered],
      unrecoveredErrors: [],
      sessionErrors: [],
    })
    expect(outcome).toEqual({
      functionalPass: true,
      stabilityPass: false,
      recoveredErrors: [recovered],
      unrecoveredErrors: [],
    })
    expect(driveOutcome({
      assertions: [{ label: "完成同一规格估计", pass: true, detail: "" }],
      toolErrors: [recovered],
      unrecoveredErrors: [],
      sessionErrors: ["模型服务限流并已熔断"],
    }).functionalPass).toBe(false)
  })

  test("separates contract, behavior, and UX layers and aggregates usage", () => {
    const aggregate = aggregateDriveReports([report(), report({ pass: false, timedOut: true })])
    expect(aggregate.total).toBe(2)
    expect(aggregate.passed).toBe(1)
    expect(aggregate.timedOut).toBe(1)
    expect(aggregate.totalTokens).toBe(250)
    expect(aggregate.cacheReadTokens).toBe(60)
    expect(aggregate.byLayer.contract).toMatchObject({ passed: 4, total: 4 })
    expect(aggregate.byLayer.behavior).toMatchObject({ passed: 2, total: 2 })
    expect(aggregate.byLayer.ux).toMatchObject({ passed: 2, total: 2 })
  })

  test("reports candidate deltas without judging numerical correctness", () => {
    const result = compareDriveReports(
      [report()],
      [report({ elapsedMs: 80, usage: { ...report().usage!, inputTokens: 80 } })],
    )
    expect(result.delta.passRate).toBe(0)
    expect(result.delta.averageElapsedMs).toBe(-20)
    expect(result.delta.totalTokens).toBe(-20)
    expect(result.delta.byLayer.contract).toBe(0)
  })
})
