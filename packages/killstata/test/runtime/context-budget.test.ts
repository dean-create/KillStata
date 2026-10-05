import { describe, expect, test } from "bun:test"
import { contextBudget, contextPercentage, contextTokens, contextUsageFromActual, contextUsageFromEstimate, serializeForTokenEstimate } from "../../src/runtime/context-budget"

const model = {
  providerID: "test",
  id: "windowed",
  limit: { context: 128_000, output: 8_000 },
} as any

describe("runtime context budget", () => {
  test("uses one input budget and output reserve", () => {
    expect(contextBudget(model)).toEqual({
      contextLimit: 128_000,
      inputBudget: 120_000,
      reserveTokens: 8_000,
    })
    expect(contextBudget(model, 32_000)).toEqual({
      contextLimit: 128_000,
      inputBudget: 96_000,
      reserveTokens: 32_000,
    })
  })

  test("does not invent a percentage when the model window is unknown", () => {
    const unknown = { ...model, limit: { context: 0, output: 8_000 } }
    expect(contextBudget(unknown).inputBudget).toBeNull()
    expect(contextPercentage(10_000, null)).toBeNull()
  })

  test("counts cache and generated tokens as occupied context", () => {
    expect(contextTokens({ input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } })).toEqual({
      promptTokens: 100,
      usedTokens: 150,
    })
  })

  test("estimation keeps system/tools/history breakdown", () => {
    const snapshot = contextUsageFromEstimate({
      model,
      budget: contextBudget(model),
      estimatedPromptTokens: 100,
      estimatedSystemTokens: 20,
      estimatedToolTokens: 30,
      estimatedMessageTokens: 50,
    })
    expect(snapshot.source).toBe("estimated")
    expect(snapshot.remainingTokens).toBe(119_900)
    expect(snapshot.percentage).toBe(0)
  })

  test("actual usage becomes the displayed source", () => {
    const snapshot = contextUsageFromActual({
      model,
      budget: contextBudget(model),
      tokens: { input: 100, output: 20, reasoning: 30, cache: { read: 40, write: 50 } },
    })
    expect(snapshot.source).toBe("actual")
    expect(snapshot.usedTokens).toBe(240)
    expect(snapshot.actual?.promptTokens).toBe(190)
  })

  test("tool serialization is stable and keeps schema content", () => {
    expect(serializeForTokenEstimate({ b: 2, a: { description: "tool", execute: () => {} } })).toBe(
      '{"a":{"description":"tool","execute":[function]},"b":2}',
    )
  })
})
