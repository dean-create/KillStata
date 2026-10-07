import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { ModelGateway } from "@/runtime/services/model-gateway"
import type { MessageV2 } from "@/session/message-v2"

const spies: Array<{ mockRestore(): void }> = []

afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore()
})

function textStream(text: string) {
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

function toolStream(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "tool-input-start", id: toolCallId, toolName }
    yield { type: "tool-call", toolCallId, toolName, input }
    yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function visibleText(messages: MessageV2.WithParts[]) {
  return messages
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

describe("repair 后普通文字收尾的真实调度链", () => {
  test("错误 read 后模型先说普通文字，dispatch 仍给它机会改用 glob", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-repair-dispatch-"))
    fs.writeFileSync(path.join(root, "gf.xlsx"), "placeholder")
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        let normalCalls = 0
        const normalRequests: ModelGateway.StreamInput[] = []
        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          if (request.small) return { fullStream: textStream("标题") } as never
          normalRequests.push(request)
          normalCalls += 1
          if (normalCalls === 1) {
            return { fullStream: toolStream("read", "call_bad_read", { filePath: "output/stage_000.csv" }) } as never
          }
          if (normalCalls === 2) {
            return { fullStream: textStream("我先整理一下当前情况。") } as never
          }
          if (normalCalls === 3) {
            return { fullStream: toolStream("glob", "call_replanned_glob", { pattern: "*.xlsx" }) } as never
          }
          return { fullStream: textStream("已根据错误反馈改用文件定位工具，未执行回归。") } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: "请定位当前目录的数据文件，不要做回归。" }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const messages = await Session.messages({ sessionID: session.id })
        const serializedRequests = normalRequests.map((request) => JSON.stringify(request.messages)).join("\n")
        const text = visibleText(messages)
        expect(normalCalls).toBeGreaterThanOrEqual(4)
        expect(serializedRequests).toContain("修复后的重新规划机会")
        expect(text).toContain("改用文件定位工具")
        expect(text).not.toContain("已完成回归")
      }})
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
