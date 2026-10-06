import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { readDatasetManifest } from "@/tool/analysis-state"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  await Instance.disposeAll()
})

function completeText(text: string) {
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

function completeTool(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "tool-input-start", id: toolCallId, toolName }
    yield { type: "tool-call", toolCallId, toolName, input }
    yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

describe("data-bearing turn analysis request gate", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("registers against the user message, then rebuilds the tool pool before import", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-analysis-request-flow-"))
    const source = localRealDataPath("did.xlsx")
    fs.copyFileSync(source, path.join(root, "did.xlsx"))
    const stagedSource = path.join(root, "did.xlsx")

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const visibleByRound: string[][] = []
        const systemByRound: string[] = []
        let mainRound = 0

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          if (request.small) return { fullStream: completeText("会话标题") } as never
          if (request.sessionID !== session.id || request.agent?.name !== "analyst") {
            return { fullStream: completeText("后台请求已收束；不属于当前数据导入主循环。") } as never
          }
          mainRound += 1
          visibleByRound.push(Object.keys(request.tools?.definitions ?? {}).sort())
          systemByRound.push(request.system.join("\n"))
          if (mainRound === 1) {
            return {
              fullStream: completeTool("analysis_request", "call_register_analysis_request", {
                kind: "inspect",
                researchGoal: "导入工作簿并诊断数据结构",
                constraints: ["先报告数据事实，不运行估计"],
              }),
            } as never
          }
          if (mainRound === 2) {
            return {
              fullStream: completeTool("data_import", "call_import_after_registration", {
                action: "import",
                inputPath: stagedSource,
                preserveLabels: true,
              }),
            } as never
          }
          return { fullStream: completeText("数据导入和诊断已完成；本轮没有运行估计。") } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `请导入 ${stagedSource}，先检查数据结构，不运行估计。` }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const history = await Session.messages({ sessionID: session.id })
        expect(visibleByRound.length).toBeGreaterThanOrEqual(3)
        expect(visibleByRound[0]).toEqual(["analysis_request"])
        expect(visibleByRound[1]).toContain("data_import")
        expect(visibleByRound[1]).not.toContain("analysis_request")
        const ledger = RuntimeTaskLedger.listTasks(session.id)
        const userMessage = history.findLast((message) => message.info.role === "user")
        const task = ledger.tasks.find((item) => item.messageID === userMessage?.info.id)
        expect(task?.analysisRequest).toMatchObject({
          sourceMessageId: userMessage?.info.id,
          kind: "inspect",
          researchGoal: "导入工作簿并诊断数据结构",
          constraints: ["先报告数据事实，不运行估计"],
        })
        expect(systemByRound[0]).not.toContain(task?.analysisRequest?.requestId ?? "missing-request-id")
        expect(systemByRound[1]).toContain(`当前 AnalysisRequest requestId=${task?.analysisRequest?.requestId}`)
        const imported = history.flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart =>
            part.type === "tool" && part.tool === "data_import" && part.state.status === "completed",
          )
        expect(imported?.state.status).toBe("completed")
        if (imported?.state.status !== "completed") throw new Error("登记后的数据导入未完成")
        const datasetId = imported.state.metadata.datasetId
        const stageId = imported.state.metadata.stageId
        expect(typeof datasetId).toBe("string")
        expect(typeof stageId).toBe("string")
        if (typeof datasetId !== "string" || typeof stageId !== "string") throw new Error("导入结果缺少数据阶段绑定")
        const stage = readDatasetManifest(datasetId).stages.find((item) => item.stageId === stageId)
        expect(stage?.metadata?.dataDiagnosis).toMatchObject({ version: 1, stage_id: stageId })
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
