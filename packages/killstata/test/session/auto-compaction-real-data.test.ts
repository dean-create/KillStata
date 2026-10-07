import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionCompaction } from "@/session/compaction"
import { Provider } from "@/provider/provider"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { AnalysisIntent } from "@/tool/analysis-intent"
import type { MessageV2 } from "@/session/message-v2"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const spies: Array<{ mockRestore(): void }> = []

afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore()
})

function completeTextStream(text: string) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "text-start" }
    yield { type: "text-delta", text }
    yield { type: "text-end" }
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function completeToolStream(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "tool-input-start", id: toolCallId, toolName }
    yield { type: "tool-call", toolCallId, toolName, input }
    yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function summaryXml() {
  return `<analysis>只用于整理，不进入恢复上下文</analysis>
<summary>
1. 主要请求和意图：导入 did.xlsx 并继续检查 DID 识别条件
2. 关键技术与计量概念：面板数据、传统 DID 四格结构、相对时期
3. 文件、数据与代码位置：did.xlsx 已导入，规范化数据阶段仍有效
4. 错误、根因与修复：历史中没有不可恢复的工具错误
5. 问题解决过程：已完成数据导入和基础画像
6. 所有真实用户消息：导入 did.xlsx 并继续检查 DID 识别条件
7. 待完成任务：根据数据事实确认传统 DID 或两阶段 DID 的适用性
8. 当前工作：自动压缩后继续当前 DID 识别检查，不重新导入数据
9. 可选下一步：询问是否提供相对时期变量
</summary>`
}

function assistantTexts(messages: MessageV2.WithParts[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
}

describe("真实数据自动压缩回放", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("导入 did.xlsx 后触发自动压缩，摘要无工具且恢复后继续当前任务", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-auto-compaction-real-data-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const actualModel = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const compactModel = {
          ...actualModel,
          limit: { ...actualModel.limit, context: 16_000, output: 2_000 },
        }
        spies.push(spyOn(Provider, "getModel").mockResolvedValue(compactModel as never))

        let normalCalls = 0
        let compactCalls = 0
        let compactToolCount: number | undefined
        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          if (request.contextPolicy === "compaction") {
            compactCalls += 1
            compactToolCount = Object.keys(request.tools?.definitions ?? {}).length
            return { fullStream: completeTextStream(summaryXml()) } as never
          }
          if (request.small) return { fullStream: completeTextStream("后台摘要") } as never
          normalCalls += 1
          if (normalCalls === 1) {
            return { fullStream: completeToolStream("data_import", "call_auto_compact_import", { action: "import", inputPath: source }) } as never
          }
          return { fullStream: completeTextStream("已从当前数据状态继续检查 DID 识别条件。") } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `导入 ${source}，先完成数据导入。` }],
          model: { providerID: actualModel.providerID, modelID: actualModel.id },
          agent: "analyst",
        })

        // 模拟用户在一次长会话中持续追问；这些消息只增加历史，不改变数据阶段。
        for (let index = 0; index < 8; index += 1) {
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() + index },
            agent: "analyst",
            model: { providerID: actualModel.providerID, modelID: actualModel.id },
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: `历史用户问题 ${index}：请保留 did.xlsx 的数据目标、变量角色和待确认的 DID 识别条件。${"历史约束".repeat(2_000)}`,
          } as never)
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: user.id,
            sessionID: session.id,
            mode: "analyst",
            agent: "analyst",
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: actualModel.id,
            providerID: actualModel.providerID,
            time: { created: Date.now() + index, completed: Date.now() + index },
            finish: "stop",
          } as never)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "text",
            text: `已记录第 ${index} 轮 DID 研究约束。${"历史结论".repeat(2_000)}`,
          } as never)
        }

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: "继续检查 DID 识别条件，保留刚才的数据和研究目标。" }],
          model: { providerID: actualModel.providerID, modelID: actualModel.id },
          agent: "analyst",
        })

        const messages = await Session.messages({ sessionID: session.id })
        const compacted = messages.find((message) => message.info.role === "assistant" && message.info.summary === true)
        const compactSummary = compacted?.parts
          .filter((part): part is MessageV2.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n") ?? ""
        const visible = assistantTexts(messages)

        expect(compactCalls).toBeGreaterThan(0)
        expect(compactToolCount).toBe(0)
        expect(compactSummary).toContain("导入 did.xlsx")
        expect(compactSummary).toContain("继续检查 DID 识别条件")
        expect(compactSummary).not.toContain("只用于整理，不进入恢复上下文")
        expect(messages.some((message) => message.parts.some((part) => part.type === "compaction-restore"))).toBe(true)
        expect(visible).toContain("继续检查 DID 识别条件")
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
