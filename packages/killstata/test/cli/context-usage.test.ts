import { describe, expect, test } from "bun:test"
import { contextUsageFromRuntime, formatContextUsage, formatUpdatedAt } from "../../src/cli/cmd/tui/routes/session/context-usage"

describe("TUI context usage", () => {
  test("formats estimated usage without pretending it is exact", () => {
    const usage = contextUsageFromRuntime({
      historyVersion: 1,
      tokenEstimate: 7_000,
      createdAt: "2026-08-19T00:00:00.000Z",
      usage: {
        providerID: "test",
        modelID: "windowed",
        contextLimit: 128_000,
        inputBudget: 120_000,
        reserveTokens: 8_000,
        estimatedPromptTokens: 7_000,
        estimatedSystemTokens: 1_000,
        estimatedToolTokens: 2_000,
        estimatedMessageTokens: 4_000,
        usedTokens: 7_000,
        remainingTokens: 113_000,
        percentage: 6,
        source: "estimated",
        compactionState: "none",
        updatedAt: "2026-08-19T00:00:00.000Z",
      },
    })
    expect(usage).toBeDefined()
    expect(formatContextUsage(usage!)).toContain("估算")
    expect(formatContextUsage(usage!)).toContain("7,000/120,000")
  })

  test("formats the runtime update time for people instead of exposing ISO punctuation", () => {
    expect(formatUpdatedAt("2026-08-24T15:15:17.471Z")).toMatch(
      /^2026-08-24 \d{2}:\d{2}:\d{2}$/,
    )
    expect(formatUpdatedAt("not-a-date")).toBe("not-a-date")
  })

  test("returns no usage before the first runtime snapshot", () => {
    expect(contextUsageFromRuntime(undefined)).toBeUndefined()
  })
})
