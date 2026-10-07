import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import fs from "fs"
import path from "path"
import type { MessageV2 as MessageType } from "@/session/message-v2"
import { Truncate } from "@/tool/truncation"

function toolMessage(
  tool: string,
  id: string,
  output: string,
  outputReference?: string,
): MessageType.WithParts {
  return {
    info: {
      id: `message-${id}`,
      sessionID: "ses_summary_input",
      role: "assistant",
      parentID: "user",
      mode: "analyst",
      agent: "analyst",
      path: { cwd: ".", root: "." },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "test",
      time: { created: 1, completed: 2 },
      finish: "tool-calls",
    },
    parts: [{
      id: `part-${id}`,
      messageID: `message-${id}`,
      sessionID: "ses_summary_input",
      type: "tool",
      tool,
      callID: `call-${id}`,
      state: {
        status: "completed",
        input: {},
        output,
        modelOutput: output,
        outputReference,
        title: tool,
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }],
  } as MessageType.WithParts
}

describe("手动与自动压缩请求协议", () => {
  test("手动允许关注指令，自动模式拒绝权限蔓延", () => {
    expect(SessionCompaction.CreateInput.safeParse({
      sessionID: "ses_manual",
      agent: "analyst",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      auto: false,
      instructions: "重点保留 DID 平行趋势诊断",
    }).success).toBe(true)
    expect(SessionCompaction.CreateInput.safeParse({
      sessionID: "ses_auto",
      agent: "analyst",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      auto: true,
      instructions: "偷偷加入新要求",
    }).success).toBe(false)
  })

  test("边界 part 记录触发原因、压缩前规模和最后消息 ID", () => {
    const parsed = MessageV2.CompactionPart.parse({
      id: "part_compact",
      messageID: "message_boundary",
      sessionID: "ses_1",
      type: "compaction",
      auto: true,
      reason: "threshold",
      preCompactTokens: 187_001,
      lastMessageID: "message_before_boundary",
    })
    expect(parsed).toMatchObject({
      auto: true,
      reason: "threshold",
      preCompactTokens: 187_001,
      lastMessageID: "message_before_boundary",
    })
  })

  test("旧 Session 只有 auto 字段时仍可读取", () => {
    expect(MessageV2.CompactionPart.safeParse({
      id: "part_old",
      messageID: "message_old",
      sessionID: "ses_old",
      type: "compaction",
      auto: false,
    }).success).toBe(true)
  })

  test("压缩强制复用当前会话模型、空工具集，并防止递归 compact", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "session", "compaction.ts"), "utf-8")
    expect(source).not.toContain("agent.model\n      ?")
    expect(source).not.toContain('Agent.get("compaction")')
    expect(source).toContain("Agent.get(userMessage.agent)")
    expect(source).toContain("Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)")
    expect(source).toContain("tools: emptyToolSet()")
    expect(source).toContain("SystemPrompt.environment(")
    expect(source).toContain("SystemPrompt.custom()")
    expect(source).toContain('result === "compact"')
    expect(source).toContain("await Promise.all([")
    expect(source).not.toContain(".slice(-5)")
    const dispatch = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "dispatch.ts"), "utf-8")
    const gateway = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "services", "model-gateway.ts"), "utf-8")
    expect(dispatch).toContain("SystemPrompt.custom()")
    expect(gateway).toContain("refreshToolPool()")
    expect(gateway).toContain('input.contextPolicy !== "compaction"')
    expect(gateway).toContain("compactionRequest ? [] : await staticToolInventory()")
    expect(gateway).toContain("if (!compactionRequest && !input.textOnly) await input.tools.refreshToolPool()")
    expect(gateway).not.toContain("conversationOnly || compactionRequest ? emptyToolSet()")
  })

  test("摘要输入保留全部历史，只清安全可重取结果", async () => {
    const big = "x".repeat(5_000)
    const estimatorReference = await Truncate.persist("完整 DID 结果")
    const messages = [
      ...Array.from({ length: 7 }, (_, index) => toolMessage("read", `read-${index}`, big)),
      toolMessage("did_static", "did", big, estimatorReference),
    ]
    const prepared = SessionCompaction.prepareSummaryInput(messages)
    expect(prepared).toHaveLength(messages.length)
    expect(messages[0].parts[0]).toMatchObject({
      type: "tool",
      state: { status: "completed", modelOutput: big },
    })
    const firstRead = prepared[0].parts[0] as MessageType.ToolPart
    const did = prepared.at(-1)!.parts[0] as MessageType.ToolPart
    expect(firstRead.state.status === "completed" && firstRead.state.modelOutput).toContain("已清理")
    expect(did.state.status === "completed" && did.state.modelOutput).toBe(big)
    expect(did.state.status === "completed" && did.state.outputReference).toBe(estimatorReference)
  })

  test("摘要输入排除本次压缩控制边界，不把它冒充真实用户消息", () => {
    const history = [toolMessage("read", "history", "历史结果")]
    const boundary = {
      info: { id: "boundary", role: "user" },
      parts: [{ type: "compaction", auto: true, reason: "threshold" }],
    } as never
    const prepared = SessionCompaction.prepareSummaryInput([...history, boundary])
    expect(prepared).toHaveLength(1)
    expect(prepared[0].info.id).toBe("message-history")
  })

  test("边界 metadata 来自压缩前真实历史", () => {
    const messages = [
      {
        info: { id: "message_before", role: "user" },
        parts: [{ type: "text", text: "旧任务" }],
      },
      {
        info: { id: "message_boundary", role: "user" },
        parts: [{ type: "compaction", auto: false, customInstructions: "保留错误根因" }],
      },
    ] as never
    const metadata = SessionCompaction.boundaryMetadata({
      messages,
      parentID: "message_boundary",
      auto: false,
      reason: "manual",
      customInstructions: "保留错误根因",
    })
    expect(metadata.lastMessageID).toBe("message_before")
    expect(metadata.preCompactTokens).toBeGreaterThan(0)
    expect(metadata.customInstructions).toBe("保留错误根因")
  })
})
