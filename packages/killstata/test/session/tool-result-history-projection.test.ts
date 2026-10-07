import { describe, expect, test } from "bun:test"
import { MessageV2 } from "@/session/message-v2"
import { ToolResultProjection } from "@/runtime/tool-result-projection"

const model = { providerID: "deepseek", id: "deepseek-chat" } as never

function completedToolHistory(state: { output: string; modelOutput?: string }): MessageV2.WithParts[] {
  return [{
    info: {
      id: "message_helper", role: "assistant", sessionID: "session_helper", parentID: "user_helper",
      agent: "analyst", providerID: "deepseek", modelID: "deepseek-chat", summary: false,
      path: { cwd: ".", root: "." }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1 },
    },
    parts: [{
      id: "part_helper", messageID: "message_helper", sessionID: "session_helper", type: "tool",
      callID: "call_helper", tool: "pipeline",
      state: { status: "completed", input: {}, ...state, title: "工作流", metadata: {}, time: { start: 1, end: 2 } },
    }],
  } as unknown as MessageV2.WithParts]
}

describe("历史工具结果模型投影", () => {
  test("Session 保留完整 output，但后续 toModelMessages 只发送 modelOutput", () => {
    const fullOutput = `FULL-${"noise".repeat(10_000)}`
    const modelOutput = "## 工作流摘要\nactiveStage: baseline_estimate\n完整引用：tool-output:tool_abc123"
    const message = {
      info: {
        id: "message_tool_projection",
        role: "assistant",
        sessionID: "session_tool_projection",
        parentID: "message_user",
        agent: "analyst",
        providerID: "deepseek",
        modelID: "deepseek-chat",
        summary: false,
        path: { cwd: ".", root: "." },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      },
      parts: [{
        id: "part_tool_projection",
        messageID: "message_tool_projection",
        sessionID: "session_tool_projection",
        type: "tool",
        callID: "call_projection",
        tool: "pipeline",
        state: {
          status: "completed",
          input: { action: "status" },
          output: fullOutput,
          modelOutput,
          title: "工作流状态",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }],
    } as unknown as MessageV2.WithParts

    expect((message.parts[0] as MessageV2.ToolPart).state.status).toBe("completed")
    expect(JSON.stringify(message)).toContain("FULL-")
    const projected = JSON.stringify(MessageV2.toModelMessages([message], {
      providerID: "deepseek",
      id: "deepseek-chat",
    } as never))
    expect(projected).toContain("baseline_estimate")
    expect(projected).toContain("tool-output:tool_abc123")
    expect(projected).not.toContain("FULL-")
  })

  test("旧 Session 缺少 modelOutput 时也不会把长全文重新注入上下文", () => {
    const fullOutput = `activeStage: baseline_estimate\n${"历史噪音".repeat(8_000)}`
    const message = {
      info: {
        id: "message_legacy", role: "assistant", sessionID: "session_legacy", parentID: "user_legacy",
        agent: "analyst", providerID: "deepseek", modelID: "deepseek-chat", summary: false,
        path: { cwd: ".", root: "." }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1 },
      },
      parts: [{
        id: "part_legacy", messageID: "message_legacy", sessionID: "session_legacy", type: "tool",
        callID: "call_legacy", tool: "pipeline",
        state: { status: "completed", input: {}, output: fullOutput, title: "工作流", metadata: {}, time: { start: 1, end: 2 } },
      }],
    } as unknown as MessageV2.WithParts
    const projected = JSON.stringify(MessageV2.toModelMessages([message], { providerID: "deepseek", id: "deepseek-chat" } as never))
    expect(projected).toContain("baseline_estimate")
    expect(projected.length).toBeLessThan(10_000)
    expect(projected).not.toContain("历史噪音历史噪音历史噪音历史噪音历史噪音历史噪音历史噪音历史噪音历史噪音历史噪音")
  })

  test("历史记录中异常超长的 modelOutput 也必须重新收口", () => {
    const oversized = "高熵历史内容".repeat(4_000)
    const messages = completedToolHistory({ output: "Session output", modelOutput: oversized })
    const serialized = JSON.stringify(MessageV2.toModelMessages(messages, model))
    expect(serialized).not.toContain(oversized)
    expect(ToolResultProjection.estimateTokens(serialized)).toBeLessThan(ToolResultProjection.estimateTokens(oversized))
  })

  test("compacted 结果保留统一顶层 outputReference", () => {
    const message = {
      info: {
        id: "message_compacted", role: "assistant", sessionID: "session_compacted", parentID: "user_compacted",
        agent: "analyst", providerID: "deepseek", modelID: "deepseek-chat", summary: false,
        path: { cwd: ".", root: "." }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1 },
      },
      parts: [{
        id: "part_compacted", messageID: "message_compacted", sessionID: "session_compacted", type: "tool",
        callID: "call_compacted", tool: "pipeline",
        state: {
          status: "completed", input: {}, output: "preview", modelOutput: "summary",
          outputReference: "tool-output:tool_abc123", title: "工作流", metadata: {},
          time: { start: 1, end: 2, compacted: 3 },
        },
      }],
    } as unknown as MessageV2.WithParts
    const projected = JSON.stringify(MessageV2.toModelMessages([message], { providerID: "deepseek", id: "deepseek-chat" } as never))
    expect(projected).toContain("tool-output:tool_abc123")
    expect(projected).toContain("已失效")
  })
})
