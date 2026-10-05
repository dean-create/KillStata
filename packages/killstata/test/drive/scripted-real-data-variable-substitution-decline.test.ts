import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { AnalysisIntent } from "@/tool/analysis-intent"
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
    yield { type: "text-start", id: "variable-substitution-decline-text" }
    yield { type: "text-delta", id: "variable-substitution-decline-text", text }
    yield { type: "text-end", id: "variable-substitution-decline-text" }
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function completeToolCall(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "tool-input-start", id: toolCallId, toolName }
    yield { type: "tool-call", toolCallId, toolName, input }
    yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
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

function lineageFromMessages(messages: unknown) {
  const text = JSON.stringify(messages)
  const datasetId = text.match(/datasetId[=:]([A-Za-z0-9_]+)/)?.[1]
  const stageId = text.match(/stageId[=:]([A-Za-z0-9_]+)/)?.[1]
  if (!datasetId || !stageId) throw new Error("脚本化模型未从真实工具结果恢复 datasetId/stageId")
  return { datasetId, stageId }
}

function analysisRequestIdFromSession(sessionID: string) {
  const ledger = RuntimeTaskLedger.listTasks(sessionID)
  const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
  const requestId = task?.analysisRequest?.requestId
  if (!requestId) throw new Error("脚本化模型未从活动任务账本恢复 requestId")
  return requestId
}

test.skipIf(!hasLocalRealData("gf.xlsx"))("真实 gf.xlsx：拒绝替换不存在的用户时间列后不得调用 Panel FE", async () => {
  if (!process.env.KILLSTATA_PYTHON) {
    throw new Error("该真实数据决策回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python Registry 执行")
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-real-variable-decline-"))
  const source = path.join(root, "gf.xlsx")
  fs.copyFileSync(localRealDataPath("gf.xlsx"), source)
  const requestedTools: string[] = []
  const questions: string[] = []
  const executedMethods: string[] = []
  let mainRound = 0

  try {
    await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      AnalysisIntent.markAnalystPlanApproval(session.id, true)
      const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
      const execute = EconometricsEngineClient.prototype.execute
      spies.push(spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(function (
        this: EconometricsEngineClient,
        payload,
        signal,
      ) {
        executedMethods.push(payload.method_id)
        return execute.call(this, payload, signal)
      }))

      spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
        const registration = await scriptedAnalysisRequestResponse(request)
        if (registration) return registration as never
if (request.small) return { fullStream: completeTextStream("本地摘要") } as never
        mainRound += 1
        if (mainRound === 1) {
          requestedTools.push("data_import:import")
          return { fullStream: completeToolCall("data_import", "call_decline_import", {
            action: "import",
            inputPath: source,
            preserveLabels: true,
          }) } as never
        }
        const lineage = lineageFromMessages(request.messages)
        if (mainRound === 2) {
          requestedTools.push("econometrics_recommend:panel-spec")
          return { fullStream: completeToolCall("econometrics_recommend", "call_decline_recommend", {
            ...lineage,
            dependentVar: "绿色金融指数",
            treatmentVar: "绿色信贷",
            entityVar: "地区",
            timeVar: "年份",
          }) } as never
        }
        if (mainRound === 3) {
          requestedTools.push("tool_search:panel_fe_regression")
          return { fullStream: completeToolCall("tool_search", "call_decline_panel_search", {
            query: "panel_fe_regression",
            limit: 1,
          }) } as never
        }
        if (mainRound === 4) {
          requestedTools.push("analysis_prepare:panel_fe_regression-year")
          return { fullStream: completeToolCall("analysis_prepare", "call_decline_panel_prepare", {
            requestId: analysisRequestIdFromSession(request.sessionID),
            methodID: "panel_fe_regression",
            arguments: {
              dependentVar: "绿色金融指数",
              treatmentVar: "绿色信贷",
              covariates: [],
              entityVar: "地区",
              timeVar: "year",
              covariance: "clustered",
            },
          }) } as never
        }
        if (mainRound === 5) {
          requestedTools.push("question:confirm-time-column")
          return { fullStream: completeToolCall("question", "call_declined_time_question", {
            questions: [{
              header: "确认时间列",
              question: "用户指定的时间列 year 不存在；当前数据中有候选列“年份”。是否确认用“年份”替代？",
              options: [
                { label: "使用“年份”", description: "仅确认本次时间列，不改变估计方法或其他变量角色。" },
                { label: "停止本次分析", description: "保留原规格，不执行 Panel FE。" },
              ],
              custom: false,
            }],
          }) } as never
        }
        return { fullStream: completeTextStream("我已停止本次估计。请提供数据中真实的时间列名后再继续。") } as never
      }))

      const unsubscribeQuestion = Bus.subscribe(Question.Event.Asked, (event) => {
        questions.push(String(event.properties.questions[0]?.question ?? ""))
        Question.reply({ requestID: event.properties.id, answers: [["停止本次分析"]] }).catch(() => {})
      })
      try {
        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{
            type: "text",
            text: `导入 ${source}，做双向固定效应面板回归：实体=地区，时间=year，被解释变量=绿色金融指数，核心解释变量=绿色信贷。`,
          }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })
      } finally {
        unsubscribeQuestion()
      }

      const messages = await Session.messages({ sessionID: session.id })
      const visible = assistantText(messages)
      const observedTools = messages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state.status, input: part.state.input, output: part.state.status === "completed" ? part.state.output : undefined, error: part.state.status === "error" ? part.state.error : undefined }))
      const methodParts = messages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.ToolPart =>
          part.type === "tool" && part.tool === "analysis_prepare" && part.state.input?.methodID === "panel_fe_regression",
        )
      const panelDecision = methodParts.find((part) => part.state.status === "completed")
      const panelMetadata = panelDecision?.state.status === "completed"
        ? panelDecision.state.metadata as Record<string, unknown>
        : undefined

      expect(requestedTools, `${visible.slice(-1200)}\n${JSON.stringify(observedTools)}`).toEqual([
        "data_import:import",
        "econometrics_recommend:panel-spec",
        "tool_search:panel_fe_regression",
        "analysis_prepare:panel_fe_regression-year",
        "question:confirm-time-column",
      ])
      expect(questions).toHaveLength(1)
      expect(questions[0]).toContain("year")
      expect(questions[0]).toContain("年份")
      expect(panelDecision?.state.status).toBe("completed")
      expect(panelDecision?.state.status === "completed" ? panelDecision.state.output : "").toContain("估计器没有运行")
      expect(panelMetadata).toMatchObject({ requiresUserDecision: true })
      expect(executedMethods).toContain("data_import")
      expect(executedMethods).not.toContain("panel_fe_regression")
      const taskLedger = RuntimeTaskLedger.listTasks(session.id)
      expect(taskLedger.tasks.find((task) => task.taskId === taskLedger.activeTaskId)?.analysisLifecycle?.status).toBe("cancelled")
      expect(visible).toContain("本轮已暂停")
      expect(mainRound).toBe(6)
      expect(visible).not.toContain("Panel FE 已完成")
      expect(visible).not.toContain("datasetId")
      expect(visible).not.toContain("stageId")
    } })
  } finally {
    await Instance.disposeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
