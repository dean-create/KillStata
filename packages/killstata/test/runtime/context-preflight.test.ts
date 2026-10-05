import { describe, expect, test } from "bun:test"
import { contextPreflight } from "../../src/runtime/context-preflight"

const model = {
  providerID: "test",
  id: "windowed",
  limit: { context: 128_000, output: 8_000 },
} as any

describe("context preflight", () => {
  test("bounds repeated compaction attempts", async () => {
    const { MAX_CONTEXT_COMPACTION_ATTEMPTS, shouldStopContextCompaction } = await import(
      "../../src/runtime/context-preflight",
    )
    expect(shouldStopContextCompaction(MAX_CONTEXT_COMPACTION_ATTEMPTS - 1)).toBe(false)
    expect(shouldStopContextCompaction(MAX_CONTEXT_COMPACTION_ATTEMPTS)).toBe(true)
  })

  test("includes full tool descriptor text instead of only tool names", () => {
    const short = contextPreflight({
      model,
      system: ["system"],
      messages: [{ role: "user", content: "hello" }],
      toolSchemaText: "tool",
      reserveTokens: 8_000,
    })
    const long = contextPreflight({
      model,
      system: ["system"],
      messages: [{ role: "user", content: "hello" }],
      toolSchemaText: "tool description and JSON schema ".repeat(100),
      reserveTokens: 8_000,
    })
    expect(long.estimatedToolTokens).toBeGreaterThan(short.estimatedToolTokens)
    expect(long.estimatedTokens).toBeGreaterThan(short.estimatedTokens)
    expect(long.inputBudget).toBe(120_000)
  })

  test("媒体按保守代理计费，不把 Base64 当普通文本撑爆预检", () => {
    const oneMiBBase64 = "A".repeat(4 * Math.ceil((1024 * 1024) / 3))
    const preflight = contextPreflight({
      model: {
        ...model,
        capabilities: { input: { image: true, pdf: true } },
      },
      system: ["system"],
      messages: [{
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "image-1",
          toolName: "read",
          output: {
            type: "content",
            value: [
              { type: "text", text: "图片读取成功" },
              { type: "media", mediaType: "image/png", data: oneMiBBase64 },
            ],
          },
        }],
      } as any],
      reserveTokens: 8_000,
    })

    expect(preflight.overBudget).toBe(false)
    expect(preflight.estimatedMessageTokens).toBeLessThan(10_000)
  })
})
