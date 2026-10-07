import { describe, expect, test } from "bun:test"
import { Identifier } from "@/id/id"
import { snipHistory } from "@/session/context-projection"
import type { MessageV2 } from "@/session/message-v2"
import { Truncate } from "@/tool/truncation"

function user(sessionID: string, text: string): MessageV2.WithParts {
  const id = Identifier.ascending("message")
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "analyst",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [
      {
        id: Identifier.ascending("part"),
        messageID: id,
        sessionID,
        type: "text",
        text,
        time: { start: Date.now(), end: Date.now() },
      },
    ],
  } as MessageV2.WithParts
}

function assistant(sessionID: string, output: string, outputPath?: string): MessageV2.WithParts {
  const id = Identifier.ascending("message")
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: "parent",
      mode: "analyst",
      agent: "analyst",
      path: { cwd: ".", root: "." },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "test",
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: Identifier.ascending("part"),
        messageID: id,
        sessionID,
        type: "tool",
        tool: "read",
        callID: "call",
        state: {
          status: "completed",
          input: {},
          output,
          title: "read",
          metadata: outputPath ? { outputPath } : {},
          time: { start: 0, end: 1 },
        },
      },
    ],
  } as MessageV2.WithParts
}

describe("read-time history snip", () => {
  test("removes old complete turns and preserves disk input", async () => {
    const outputReference = await Truncate.persist("old complete output")
    const messages = [
      user("ses", "old request"),
      assistant("ses", "x".repeat(1_000), outputReference),
      user("ses", "middle request"),
      assistant("ses", "y".repeat(1_000)),
      user("ses", "latest request"),
      assistant("ses", "z".repeat(1_000)),
    ]
    const result = snipHistory({ messages, targetTokens: 300, minRecentTurns: 1 })
    expect(result.changed).toBe(true)
    expect(result.removedTurns).toBeGreaterThan(0)
    expect(result.recoveryReferences).toContain(outputReference)
    expect(result.beforeEstimate).toBeGreaterThan(result.afterEstimate)
    expect(result.afterEstimate).toBe(result.beforeEstimate - result.savedEstimate)
    expect(result.messages.some((message) => message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.text.includes("较早对话")))).toBe(true)
    expect(messages).toHaveLength(6)
    expect(messages[0].parts[0]).toMatchObject({ type: "text", text: "old request" })
  })

  test("does not snip when the target is already satisfied", () => {
    const messages = [user("ses", "small"), assistant("ses", "small")]
    const result = snipHistory({ messages, targetTokens: 10_000 })
    expect(result.changed).toBe(false)
    expect(result.messages).toBe(messages)
  })
})
