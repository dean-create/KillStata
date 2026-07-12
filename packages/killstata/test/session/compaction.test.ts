import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"

describe("session.compaction", () => {
  test("builds a fallback summary from recent session context", () => {
    const summary = SessionCompaction.buildFallbackSummary({
      error: "stream disconnected before completion",
      messages: [
        {
          info: { id: "u1", sessionID: "s1", role: "user", time: { created: 1 }, agent: "default", model: { providerID: "openai", modelID: "gpt-5.2" } },
          parts: [{ id: "p1", sessionID: "s1", messageID: "u1", type: "text", text: "Fix compact failures in session summarize.", time: { start: 1, end: 1 } }],
        },
        {
          info: {
            id: "a1",
            sessionID: "s1",
            role: "assistant",
            parentID: "u1",
            mode: "default",
            agent: "default",
            path: { cwd: "d:/repo", root: "d:/repo" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "gpt-5.2",
            providerID: "openai",
            time: { created: 2 },
          },
          parts: [
            { id: "p2", sessionID: "s1", messageID: "a1", type: "text", text: "I traced the issue to compaction using the same streaming path as normal chat.", time: { start: 2, end: 2 } },
            {
              id: "p3",
              sessionID: "s1",
              messageID: "a1",
              type: "tool",
              tool: "grep",
              callID: "call1",
              state: {
                status: "completed",
                input: { pattern: "compact" },
                output: "session/compaction.ts and session/processor.ts are involved.",
                time: { start: 2, end: 2 },
              },
            },
          ],
        },
      ] as any,
    })

    expect(summary).toContain("Generated locally because AI compaction failed")
    expect(summary).toContain("Fix compact failures in session summarize")
    expect(summary).toContain("session/compaction.ts")
    expect(summary).toContain("## Next steps")
  })
})
