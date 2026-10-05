import { describe, expect, test } from "bun:test"
import { Identifier } from "@/id/id"
import {
  estimateContextMessages,
  projectContextWindow,
  projectModelMessageWindow,
} from "@/session/context-projection"
import type { MessageV2 } from "@/session/message-v2"
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  autoCompactThreshold,
} from "@/runtime/context-budget"

function message(
  sessionID: string,
  turn: number,
  role: "user" | "assistant",
  text: string,
): MessageV2.WithParts {
  const id = Identifier.ascending("message")
  return {
    info: role === "user"
      ? {
          id,
          sessionID,
          role,
          time: { created: turn * 1_000 },
          agent: "analyst",
          model: { providerID: "test", modelID: "test" },
        }
      : {
          id,
          sessionID,
          role,
          parentID: "parent",
          mode: "analyst",
          agent: "analyst",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
          time: { created: turn * 1_000, completed: turn * 1_000 },
          finish: "stop",
        },
    parts: [{
      id: Identifier.ascending("part"),
      messageID: id,
      sessionID,
      type: "text",
      text,
    }],
  } as MessageV2.WithParts
}

function turns(count: number, size = 4_000) {
  return Array.from({ length: count }, (_, index) => [
    message("ses-context-window", index * 2, "user", `请求 ${index} ${"用".repeat(size)}`),
    message("ses-context-window", index * 2 + 1, "assistant", `回答 ${index} ${"答".repeat(size)}`),
  ]).flat()
}

function userTurnCount(messages: MessageV2.WithParts[]) {
  return messages.filter((item) => item.info.role === "user" && !item.parts.some((part) =>
    part.type === "text" && part.synthetic === true
  )).length
}

describe("五级上下文读时投影", () => {
  test("第五层自动摘要线固定为有效输入预算减 13K", () => {
    expect(AUTOCOMPACT_BUFFER_TOKENS).toBe(13_000)
    expect(autoCompactThreshold(200_000)).toBe(187_000)
    expect(autoCompactThreshold(1_000_000)).toBe(987_000)
    expect(autoCompactThreshold(10_000)).toBe(0)
    expect(autoCompactThreshold(null)).toBeNull()
  })

  test("小于大窗口的输入预算按比例缩小压缩缓冲，避免系统前缀永远越线", () => {
    expect(autoCompactThreshold(16_000)).toBe(12_800)
    // 预算已经小于13K时没有足够空间同时容纳完整压缩缓冲，保留原有硬边界。
    expect(autoCompactThreshold(10_000)).toBe(0)
  })

  test("低于 75% 时完全不改消息视图", () => {
    const messages = turns(3, 200)
    const before = estimateContextMessages(messages)
    const result = projectContextWindow({
      messages,
      inputBudget: Math.max(20_000, Math.ceil(before / 0.5)),
      now: 20_000,
    })

    expect(result.messages).toBe(messages)
    expect(result.actions).toEqual([])
    expect(result.summaryRequired).toBe(false)
    expect(result.beforeEstimate).toBe(result.afterEstimate)
  })

  test("75% 压力先砍远古完整轮次，原始 Session 历史保持不变", () => {
    const messages = turns(12)
    const originalFirst = messages[0].parts[0]
    const before = estimateContextMessages(messages)
    const result = projectContextWindow({
      messages,
      inputBudget: Math.ceil(before / 0.8),
      now: 30_000,
    })

    expect(result.actions[0]?.action).toBe("history-snip")
    expect(result.afterEstimate).toBeLessThan(result.beforeEstimate)
    expect(result.messages.some((item) => item.parts.some((part) =>
      part.type === "text" && part.synthetic === true && part.text.includes("较早对话")
    ))).toBe(true)
    expect(messages).toHaveLength(24)
    expect(messages[0].parts[0]).toBe(originalFirst)
  })

  test("90% 使用普通读时折叠并至少保留最近 4 个完整轮次", () => {
    const messages = turns(6)
    const before = estimateContextMessages(messages)
    const result = projectContextWindow({
      messages,
      inputBudget: Math.ceil(before / 0.92),
      now: 30_000,
    })

    expect(result.actions.some((item) => item.action === "collapse")).toBe(true)
    expect(userTurnCount(result.messages)).toBeGreaterThanOrEqual(4)
    expect(result.messages.some((item) => item.parts.some((part) =>
      part.type === "text" && part.synthetic === true && part.text.includes("读时折叠")
    ))).toBe(true)
    expect(messages).toHaveLength(12)
  })

  test("95% 且普通折叠仍不足时进入紧急折叠并保留最近 2 轮", () => {
    const messages = turns(3, 10_000)
    const before = estimateContextMessages(messages)
    const result = projectContextWindow({
      messages,
      inputBudget: Math.ceil(before / 0.98),
      now: 30_000,
    })

    expect(result.actions.some((item) => item.action === "collapse" && item.emergency === true)).toBe(true)
    expect(userTurnCount(result.messages)).toBe(2)
    expect(messages).toHaveLength(6)
  })

  test("前四层仍不能留出响应缓冲时才要求全量摘要", () => {
    const messages = turns(2, 20_000)
    const before = estimateContextMessages(messages)
    const result = projectContextWindow({
      messages,
      inputBudget: Math.ceil(before / 0.99),
      now: 30_000,
    })

    expect(result.summaryRequired).toBe(true)
    expect(result.actions.at(-1)?.action).toBe("summary")
  })

  test("第五层在大窗口保留13K缓冲，在小窗口按比例缩放", () => {
    expect(autoCompactThreshold(100_000)).toBe(87_000)
    expect(autoCompactThreshold(16_000)).toBe(12_800)
  })

  test("模型窗口未知时不根据猜测主动压缩", () => {
    const messages = turns(12)
    const result = projectContextWindow({ messages, inputBudget: null })
    expect(result.messages).toBe(messages)
    expect(result.actions).toEqual([])
    expect(result.summaryRequired).toBe(false)
  })

  test("关闭 prune 配置时不执行时间型 microcompact", () => {
    const big = "x".repeat(5_000)
    const messages = Array.from({ length: 7 }, (_, index) => ({
      ...message("ses-context-window", index, index % 2 === 0 ? "user" : "assistant", `轮次 ${index}`),
      parts: [{
        id: `tool-${index}`,
        messageID: `message-${index}`,
        sessionID: "ses-context-window",
        type: "tool",
        tool: "read",
        callID: `call-${index}`,
        state: {
          status: "completed",
          input: {},
          output: big,
          modelOutput: big,
          title: "read",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      }],
    })) as MessageV2.WithParts[]
    const before = estimateContextMessages(messages)
    const result = projectContextWindow({
      messages,
      inputBudget: Math.ceil(before / 0.5),
      now: 61 * 60_000,
      enableMicrocompact: false,
    })

    expect(result.actions.some((item) => item.action === "microcompact")).toBe(false)
    const first = result.messages[0].parts[0] as MessageV2.ToolPart
    expect(first.state.status === "completed" && first.state.modelOutput).toBe(big)
  })

  test("最终请求投影按完整 user turn 裁剪并保留可恢复引用", () => {
    const messages = Array.from({ length: 6 }, (_, index) => [
      { role: "user", content: `用户 ${index} ${"问".repeat(1_000)}` },
      {
        role: "assistant",
        content: `助手 ${index} ${"答".repeat(1_000)} ${index === 0 ? "tool-output:tool_abc" : ""}`,
      },
    ]).flat() as never
    const result = projectModelMessageWindow({
      messages,
      targetTokens: 2_500,
      minRecentTurns: 4,
      emergency: false,
    })

    expect(result.changed).toBe(true)
    expect(result.removedTurns).toBe(2)
    expect(result.messages.filter((item) => item.role === "user")).toHaveLength(5)
    expect(JSON.stringify(result.messages[0])).toContain("最终读时投影")
    expect(JSON.stringify(result.messages[0])).toContain("tool-output:tool_abc")
    expect(messages).toHaveLength(12)
  })

  test("最终请求投影不会拆开真实 tool-call 与 tool-result", () => {
    const firstTurn = [
      { role: "user", content: "读取旧数据" },
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_old",
          toolName: "read",
          input: { filePath: "old.txt" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_old",
          toolName: "read",
          output: { type: "text", value: "tool-output:tool_old " + "旧".repeat(2_000) },
        }],
      },
    ]
    const recent = Array.from({ length: 4 }, (_, index) => [
      { role: "user", content: `近期用户 ${index} ${"问".repeat(500)}` },
      { role: "assistant", content: `近期助手 ${index} ${"答".repeat(500)}` },
    ]).flat()
    const messages = [...firstTurn, ...recent] as never
    const result = projectModelMessageWindow({
      messages,
      targetTokens: 1_500,
      minRecentTurns: 4,
      emergency: false,
    })
    const serialized = JSON.stringify(result.messages)

    expect(result.changed).toBe(true)
    expect(serialized).not.toContain("call_old")
    expect(serialized).toContain("tool-output:tool_old")
    expect(messages).toHaveLength(11)
  })
})
