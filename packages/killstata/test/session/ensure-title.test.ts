import { describe, expect, spyOn, test } from "bun:test"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ensureTitle, shouldGenerateTitle, TITLE_REGENERATE_INTERVAL } from "@/session/prompt/message"
import { SessionSummary } from "@/session/summary"
import { Session } from "@/session"
import type { MessageV2 } from "@/session/message-v2"

function userMessage(id: string, synthetic = false): MessageV2.WithParts {
  return {
    info: { id, role: "user" } as never,
    parts: [{ type: "text", text: `question ${id}`, synthetic } as never],
  }
}

function assistantMessage(id: string): MessageV2.WithParts {
  return {
    info: { id, role: "assistant" } as never,
    parts: [{ type: "text", text: `answer ${id}` } as never],
  }
}

describe("shouldGenerateTitle", () => {
  test("generates on the very first real user question", () => {
    const decision = shouldGenerateTitle({
      session: { parentID: undefined, titleSource: undefined, titleGeneratedAtCount: undefined },
      history: [userMessage("u1")],
    })
    expect(decision).toEqual({ generate: true, targetUserIdx: 0, questionCount: 1 })
  })

  test("does not generate for question counts between 1 and the interval", () => {
    const history = Array.from({ length: 5 }, (_, i) => userMessage(`u${i + 1}`))
    const decision = shouldGenerateTitle({
      session: { parentID: undefined, titleSource: undefined, titleGeneratedAtCount: 1 },
      history,
    })
    expect(decision.generate).toBe(false)
  })

  test(`regenerates exactly on the ${TITLE_REGENERATE_INTERVAL}th real question`, () => {
    const history = Array.from({ length: TITLE_REGENERATE_INTERVAL }, (_, i) => userMessage(`u${i + 1}`))
    const decision = shouldGenerateTitle({
      session: { parentID: undefined, titleSource: undefined, titleGeneratedAtCount: 1 },
      history,
    })
    expect(decision).toEqual({
      generate: true,
      targetUserIdx: TITLE_REGENERATE_INTERVAL - 1,
      questionCount: TITLE_REGENERATE_INTERVAL,
    })
  })

  test("does not regenerate again for the same question count (idempotent under retry)", () => {
    const history = Array.from({ length: TITLE_REGENERATE_INTERVAL }, (_, i) => userMessage(`u${i + 1}`))
    const decision = shouldGenerateTitle({
      session: { parentID: undefined, titleSource: undefined, titleGeneratedAtCount: TITLE_REGENERATE_INTERVAL },
      history,
    })
    expect(decision.generate).toBe(false)
  })

  test("manual rename permanently disables auto-regeneration even at the periodic boundary", () => {
    const history = Array.from({ length: TITLE_REGENERATE_INTERVAL }, (_, i) => userMessage(`u${i + 1}`))
    const decision = shouldGenerateTitle({
      session: { parentID: undefined, titleSource: "manual", titleGeneratedAtCount: 1 },
      history,
    })
    expect(decision.generate).toBe(false)
  })

  test("child sessions never auto-generate a title", () => {
    const decision = shouldGenerateTitle({
      session: { parentID: "ses_parent", titleSource: undefined, titleGeneratedAtCount: undefined },
      history: [userMessage("u1")],
    })
    expect(decision.generate).toBe(false)
  })

  test("synthetic user messages don't count toward the question tally", () => {
    const history = [userMessage("u1"), userMessage("synthetic1", true), assistantMessage("a1")]
    const decision = shouldGenerateTitle({
      session: { parentID: undefined, titleSource: undefined, titleGeneratedAtCount: undefined },
      history,
    })
    expect(decision).toEqual({ generate: true, targetUserIdx: 0, questionCount: 1 })
  })

  test("targets the latest real user message at the periodic boundary, not the first one", () => {
    const history = [
      ...Array.from({ length: TITLE_REGENERATE_INTERVAL - 1 }, (_, i) => userMessage(`u${i + 1}`)),
      assistantMessage("a_last"),
      userMessage(`u${TITLE_REGENERATE_INTERVAL}`),
    ]
    const decision = shouldGenerateTitle({
      session: { parentID: undefined, titleSource: undefined, titleGeneratedAtCount: 1 },
      history,
    })
    expect(decision.generate).toBe(true)
    if (decision.generate) {
      expect(history[decision.targetUserIdx].info.id).toBe(`u${TITLE_REGENERATE_INTERVAL}`)
    }
  })
})

describe("ensureTitle", () => {
  test("标题后台请求失败时不应让前台分析会话失败", async () => {
    const agent = spyOn(Agent, "get").mockResolvedValue({ name: "title" } as never)
    const smallModel = spyOn(Provider, "getSmallModel").mockRejectedValue(new Error("Unauthorized"))
    try {
      await expect(ensureTitle({
        session: { id: "ses_title_failure", parentID: undefined, titleSource: undefined, titleGeneratedAtCount: undefined } as never,
        history: [userMessage("u_title")],
        providerID: "custom",
        modelID: "DeepSeek-V4-Flash-0731",
      })).resolves.toBeUndefined()
    } finally {
      agent.mockRestore()
      smallModel.mockRestore()
    }
  })

  test("摘要后台请求失败时不应让前台分析会话失败", async () => {
    const agent = spyOn(Agent, "get").mockResolvedValue({ name: "title" } as never)
    const smallModel = spyOn(Provider, "getSmallModel").mockRejectedValue(new Error("Unauthorized"))
    const messages = spyOn(Session, "messages").mockResolvedValue([{
      info: {
        id: "msg_summary_failure",
        role: "user",
        sessionID: "ses_summary_failure",
        model: { providerID: "custom", modelID: "DeepSeek-V4-Flash-0731" },
      } as never,
      parts: [{ type: "text", text: "请分析数据" } as never],
    }])
    try {
      await expect(SessionSummary.summarize({
        sessionID: "ses_summary_failure",
        messageID: "msg_summary_failure",
      })).resolves.toBeUndefined()
    } finally {
      agent.mockRestore()
      smallModel.mockRestore()
      messages.mockRestore()
    }
  })
})
