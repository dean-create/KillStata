import { Provider } from "@/provider/provider"

import { fn } from "@killstata/util/fn"
import z from "zod"
import { Session } from "."

import { MessageV2 } from "./message-v2"
import { Identifier } from "@/id/id"

import { Log } from "@/util/log"

import { ModelGateway } from "@/runtime/services/model-gateway"
import { emptyToolSet } from "./prompt/tools"
import { Agent } from "@/agent/agent"
import { SessionRetry } from "./retry"

export namespace SessionSummary {
  const log = Log.create({ service: "session.summary" })

  export const summarize = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
    }),
    async (input) => {
      try {
        const all = await Session.messages({ sessionID: input.sessionID })
        await summarizeMessage({ messageID: input.messageID, messages: all })
      } catch (error) {
        // 摘要是后台装饰信息；provider、凭证或摘要内容失败时不能影响前台分析会话。
        log.error("failed to generate summary", { error })
      }
    },
  )

  async function summarizeMessage(input: { messageID: string; messages: MessageV2.WithParts[] }) {
    const messages = input.messages.filter(
      (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
    )
    const msgWithParts = messages.find((m) => m.info.id === input.messageID)!
    const userMsg = msgWithParts.info as MessageV2.User

    const textPart = msgWithParts.parts.find((p) => p.type === "text" && !p.synthetic) as MessageV2.TextPart
    if (textPart && !userMsg.summary?.title) {
      const agent = await Agent.get("title")
      if (!agent) return
      const stream = await ModelGateway.stream({
        agent,
        user: userMsg,
        tools: emptyToolSet(),
        model: agent.model
          ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
          : ((await Provider.getSmallModel(userMsg.model.providerID, userMsg.model.modelID)) ??
            (await Provider.getModel(userMsg.model.providerID, userMsg.model.modelID))),
        small: true,
        messages: [
          {
            role: "user" as const,
            content: `
              请只为以下用户消息生成中文会话标题：
              <text>
              ${textPart?.text ?? ""}
              </text>
            `,
          },
        ],
        abort: new AbortController().signal,
        sessionID: userMsg.sessionID,
        system: [],
        // 标题生成是后台任务：没有标题只是少个显示名，用户不在等它。provider 过载时
        // 反复重试会跟用户正在等的请求抢配额，所以只试一次，失败就保留默认标题。
        requestSource: "background",
        retries: SessionRetry.BACKGROUND_MAX_RETRIES,
      })
      const result = await stream.text
      log.info("title", { title: result })
      userMsg.summary = { ...userMsg.summary, title: result }
      await Session.updateMessage(userMsg)
    }
  }
}
