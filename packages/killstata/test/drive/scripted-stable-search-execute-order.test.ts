import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"
import { Question } from "@/question"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { readDatasetManifest } from "@/tool/analysis-state"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  await Instance.disposeAll()
})

function completeTextStream(text: string) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "text-start", id: "search-execute-recovery" }
    yield { type: "text-delta", id: "search-execute-recovery", text }
    yield { type: "text-end", id: "search-execute-recovery" }
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

type ScriptedToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

function completeToolBatchStream(calls: ScriptedToolCall[]) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    for (const call of calls) {
      yield { type: "tool-input-start", id: call.toolCallId, toolName: call.toolName }
      yield { type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }
    }
    yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
    yield { type: "finish" }
  })()
}

function modelVisibleText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(modelVisibleText).join("\n")
  if (value && typeof value === "object") return Object.values(value).map(modelVisibleText).join("\n")
  return ""
}

function assistantText(messages: MessageV2.WithParts[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
}

function activeAnalysisRequestID(sessionID: string) {
  const ledger = RuntimeTaskLedger.listTasks(sessionID)
  const requestId = ledger.tasks.find((task) => task.taskId === ledger.activeTaskId)?.analysisRequest?.requestId
  if (!requestId) throw new Error("脚本模型未找到当前 AnalysisRequest")
  return requestId
}

function activePreparedSpecID(sessionID: string) {
  const ledger = RuntimeTaskLedger.listTasks(sessionID)
  const specId = ledger.tasks.find((task) => task.taskId === ledger.activeTaskId)?.preparedSpec?.specId
  if (!specId) throw new Error("脚本模型未找到当前已准备规格")
  return specId
}

describe("真实 did.xlsx 工具搜索与稳定路由的同响应续错", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("同响应的 OLS 参数失败会短路后续搜索，但错误和动态 Schema 支持同会话修正", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据 AgentLoop 回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python 执行")
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-search-execute-order-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    const requestedCalls: string[] = []
    const verifierSessions = new Set<string>()
    const idleVerifiers = new Set<string>()
    let mainRound = 0
    let textOnlyRounds = 0
    let modelToolsBeforeCombinedCall: string[] = []
    let repairTurnSawOriginalError = false
    let repairTurnSawSkippedSearch = false
    let correctionTurnSawSearchSchema = false
    let activeSessionID = ""
    let unsubscribeCreated = () => {}
    let unsubscribeStatus = () => {}
    let unsubscribeQuestion = () => {}
    const questions: string[] = []
    const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute")
    spies.push(executeSpy)

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        activeSessionID = session.id
        unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
          const info = event.properties.info
          if (info.parentID === activeSessionID && info.title.startsWith("工作流核验 - ")) verifierSessions.add(info.id)
        })
        unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (verifierSessions.has(event.properties.sessionID) && event.properties.status.type === "idle") {
            idleVerifiers.add(event.properties.sessionID)
          }
        })
        unsubscribeQuestion = Bus.subscribe(Question.Event.Asked, (event) => {
          const item = event.properties.questions[0]
          questions.push(String(item?.question ?? ""))
          const labels = item?.options?.map((option) => String(option.label ?? "")) ?? []
          const answer = labels.find((label) => label.includes("保持 HC1")) ?? labels[0] ?? "停止本次分析"
          Question.reply({ requestID: event.properties.id, answers: [[answer]] }).catch(() => {})
        })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
if (String(request.agent.name).toLowerCase() === "verifier") {
            return { fullStream: completeTextStream([
              "<verifier_result>",
              JSON.stringify({
                status: "warn",
                checks: [{
                  key: "scripted_verifier_boundary",
                  label: "脚本化核验边界",
                  status: "warn",
                  message: "本地固定响应只验证 Harness 核验调度，不代表独立复核了估计内容。",
                }],
                blockingFindings: [],
                repairHints: [],
                trustedArtifacts: [],
                summary: "本地脚本化核验回包完成；估计内容未由真实模型独立复核。",
                findings: [],
              }),
              "</verifier_result>",
            ].join("\n")) } as never
          }
          if (request.small) return { fullStream: completeTextStream("本地会话摘要") } as never
          if (request.textOnly === true) {
            textOnlyRounds += 1
            return { fullStream: completeTextStream(mainRound >= 8
              ? "已根据 Schema 修正协方差参数，真实 OLS 估计完成。"
              : "本轮仅完成导入后的文字收尾，我会继续执行用户指定的 OLS。") } as never
          }

          mainRound += 1
          const modelInput = modelVisibleText(request.messages)
          if (mainRound === 1) {
            requestedCalls.push("data_import:import")
            return { fullStream: completeToolBatchStream([{
              toolName: "data_import",
              toolCallId: "call_search_order_import",
              input: {
                action: "import",
                inputPath: source,
                preserveLabels: true,
                sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
              },
            }]) } as never
          }
          if (mainRound === 2) {
            requestedCalls.push("data_import:profile")
            return { fullStream: completeToolBatchStream([{ toolName: "data_import", toolCallId: "call_search_order_profile", input: { action: "profile" } }]) } as never
          }
          if (mainRound === 3) {
            requestedCalls.push("data_import:validate")
            return { fullStream: completeToolBatchStream([{ toolName: "data_import", toolCallId: "call_search_order_validate", input: { action: "validate" } }]) } as never
          }
          if (mainRound === 4) {
            modelToolsBeforeCombinedCall = Object.keys(request.tools?.definitions ?? {})
            requestedCalls.push("tool_search:ols_regression")
            return { fullStream: completeToolBatchStream([{
              toolName: "tool_search",
              toolCallId: "call_search_order_initial_ols_schema",
              input: { query: "ols_regression", limit: 1 },
            }]) } as never
          }
          if (mainRound === 5) {
            requestedCalls.push("analysis_prepare:invalid-covariance-before-search", "tool_search:ols_regression-same-batch")
            return { fullStream: completeToolBatchStream([
              {
                toolName: "analysis_prepare",
                toolCallId: "call_search_order_invalid_ols_spec",
                input: {
                  requestId: activeAnalysisRequestID(request.sessionID),
                  methodID: "ols_regression",
                  arguments: {
                    dependentVar: "高质量发展指数",
                    treatmentVar: "did",
                    covariates: ["人口规模", "人均GDP", "金融发展程度"],
                    covariance: "clustered",
                  },
                },
              },
              {
                toolName: "tool_search",
                toolCallId: "call_search_order_ols_schema",
                input: { query: "ols_regression", limit: 1 },
              },
            ]) } as never
          }
          if (mainRound === 6) {
            repairTurnSawSkippedSearch = modelInput.includes("ToolCallSkippedError")
            repairTurnSawOriginalError = modelInput.includes("clustered") && /covariance|协方差/i.test(modelInput)
            requestedCalls.push("tool_search:retry-after-tool-batch-failure")
            return { fullStream: completeToolBatchStream([{
              toolName: "tool_search",
              toolCallId: "call_search_order_retry_schema",
              input: { query: "ols_regression", limit: 1 },
            }]) } as never
          }
          if (mainRound === 7) {
            correctionTurnSawSearchSchema = modelInput.includes("参数 Schema：") && modelInput.includes("covariance")
            requestedCalls.push("analysis_prepare:corrected-covariance")
            return { fullStream: completeToolBatchStream([{
              toolName: "analysis_prepare",
              toolCallId: "call_search_order_repaired_ols_spec",
              input: {
                requestId: activeAnalysisRequestID(request.sessionID),
                methodID: "ols_regression",
                arguments: {
                  dependentVar: "高质量发展指数",
                  treatmentVar: "did",
                  covariates: ["人口规模", "人均GDP", "金融发展程度"],
                  covariance: "HC1",
                },
              },
            }]) } as never
          }
          if (mainRound === 8) {
            requestedCalls.push("econometrics_execute:corrected-covariance")
            return { fullStream: completeToolBatchStream([{
              toolName: "econometrics_execute",
              toolCallId: "call_search_order_repaired_ols",
              input: { specId: activePreparedSpecID(request.sessionID) },
            }]) } as never
          }
          return { fullStream: completeTextStream("did.xlsx 的 OLS 已完成。") } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `导入 ${source} 的 Data_可读 页；用 OLS 估计高质量发展指数对 did 的关系，控制人口规模、人均GDP、金融发展程度，采用 HC1。只解释样本内统计关系。` }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const deadline = Date.now() + 15_000
        while (Date.now() < deadline && (verifierSessions.size === 0 || verifierSessions.size !== idleVerifiers.size)) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        const messages = await Session.messages({ sessionID: session.id })
        const toolParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const methodParts = toolParts.filter((part) =>
          (part.tool === "analysis_prepare" && part.state.input?.methodID === "ols_regression") ||
          (part.tool === "econometrics_execute" &&
            part.state.status === "completed" &&
            part.state.metadata.method === "ols_regression"),
        )
        const searchParts = toolParts.filter((part) => part.tool === "tool_search" && part.state.input?.query === "ols_regression")
        const importPart = toolParts.find((part) => part.tool === "data_import" && part.state.input?.action === "import")
        const failedPart = methodParts.find((part) => part.tool === "analysis_prepare" && part.state.status === "error")
        const successfulPart = [...methodParts].reverse().find((part) => part.state.status === "completed" &&
          (part.state.metadata?.result as { success?: unknown } | undefined)?.success === true)
        const combinedResponse = messages.find((message) =>
          message.info.role === "assistant" &&
          message.parts.some((part) => part.type === "tool" && part.tool === "analysis_prepare") &&
          message.parts.some((part) => part.type === "tool" && part.tool === "tool_search"),
        )

        expect(questions).toEqual([])
        expect(requestedCalls).toEqual([
          "data_import:import",
          "data_import:profile",
          "data_import:validate",
          "tool_search:ols_regression",
          "analysis_prepare:invalid-covariance-before-search",
          "tool_search:ols_regression-same-batch",
          "tool_search:retry-after-tool-batch-failure",
          "analysis_prepare:corrected-covariance",
          "econometrics_execute:corrected-covariance",
        ])
        expect(modelToolsBeforeCombinedCall).toContain("econometrics_execute")
        expect(modelToolsBeforeCombinedCall).toContain("tool_search")
        expect(modelToolsBeforeCombinedCall).not.toContain("ols_regression")
        expect(combinedResponse).toBeDefined()
        expect(searchParts.map((part) => part.state.status)).toEqual(["completed", "error", "completed"])
        const skippedSearch = searchParts[1]
        const recoveredSearch = searchParts[2]
        expect(skippedSearch?.state.status).toBe("error")
        if (skippedSearch?.state.status === "error") expect(skippedSearch.state.error).toMatch(/ToolCallSkippedError|未执行|未调度/i)
        expect(recoveredSearch?.state.status).toBe("completed")
        if (recoveredSearch?.state.status === "completed") {
          expect(recoveredSearch.state.metadata.matchCount).toBe(1)
          expect(recoveredSearch.state.output).toContain("参数 Schema")
          expect(recoveredSearch.state.output).toContain("covariance")
        }
        expect(failedPart?.state.status).toBe("error")
        if (failedPart?.state.status === "error") expect(failedPart.state.error).toMatch(/covariance|协方差/i)
        expect(repairTurnSawOriginalError).toBe(true)
        expect(repairTurnSawSkippedSearch).toBe(true)
        expect(correctionTurnSawSearchSchema).toBe(true)
        expect(successfulPart?.state.status).toBe("completed")
        if (successfulPart?.state.status === "completed") {
          expect((successfulPart.state.metadata.result as Record<string, unknown>)?.rowsUsed).toBeGreaterThan(4_000)
        }
        const result = successfulPart?.state.status === "completed"
          ? successfulPart.state.metadata.result as Record<string, unknown>
          : undefined
        expect(typeof result?.resultPath).toBe("string")
        expect(typeof result?.coefficientsPath).toBe("string")
        expect(fs.existsSync(path.resolve(root, String(result?.resultPath)))).toBe(true)
        expect(fs.existsSync(path.resolve(root, String(result?.coefficientsPath)))).toBe(true)
        expect(textOnlyRounds).toBeGreaterThan(0)
        expect(importPart?.state.status).toBe("completed")
        const datasetId = importPart?.state.status === "completed" ? importPart.state.metadata.datasetId : undefined
        const manifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined
        expect(manifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])
        expect(executeSpy.mock.calls.map(([request]) => request.method_id).filter((methodID) => methodID === "ols_regression")).toHaveLength(1)
        expect(verifierSessions.size).toBeGreaterThan(0)
        expect(verifierSessions.size).toBe(idleVerifiers.size)
        expect(assistantText(messages)).toContain("did.xlsx 的 OLS 已完成")
        expect(assistantText(messages)).not.toContain("datasetId")
        expect(assistantText(messages)).not.toContain("stageId")
      } })
    } finally {
      unsubscribeCreated()
      unsubscribeStatus()
      unsubscribeQuestion()
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 40_000)
})
