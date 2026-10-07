import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"
import { Provider } from "@/provider/provider"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { readDatasetManifest } from "@/tool/analysis-state"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { Bus } from "@/bus"
import { Question } from "@/question"
import { SessionCompaction } from "@/session/compaction"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  // 每个脚本场景使用独立临时项目；显式销毁 Instance，避免后台摘要、引擎客户端
  // 或缓存跨场景污染后续消息持久化。正式运行时 Session 生命周期仍由应用持有。
  await Instance.disposeAll()
})

function textStream(text: string) {
  return (async function* () {
    yield { type: "text-start" }
    yield { type: "text-delta", text }
    yield { type: "text-end" }
    yield { type: "finish" }
  })()
}

function toolStream(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool-call", toolCallId, toolName, input }
    yield { type: "finish" }
  })()
}

// AgentEngine 的真实 Provider 流在 finish 前会发送 finish-step；replan 回放必须
// 保留这个协议，否则 dispatch 会把助手消息当成未完成而继续创建空回合。
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

function lineageFromMessages(messages: unknown) {
  const text = JSON.stringify(messages)
  const datasetId = text.match(/datasetId[=:]([A-Za-z0-9_]+)/)?.[1]
  const stageId = text.match(/stageId[=:]([A-Za-z0-9_]+)/)?.[1]
  if (!datasetId || !stageId) throw new Error("脚本化模型未从真实工具结果恢复 datasetId/stageId")
  return { datasetId, stageId }
}

function assistantText(messages: MessageV2.WithParts[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
}

function modelVisibleText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(modelVisibleText).join("\n")
  if (value && typeof value === "object") return Object.values(value).map(modelVisibleText).join("\n")
  return ""
}

function namedToolResultText(messages: unknown, toolName: string) {
  if (!Array.isArray(messages)) return ""
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "tool") return []
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return []
    return content
      .filter((part) => part && typeof part === "object" &&
        (part as { type?: unknown }).type === "tool-result" &&
        (part as { toolName?: unknown }).toolName === toolName)
      .map((part) => modelVisibleText((part as { output?: unknown }).output))
  }).join("\n")
}

function latestNamedToolResultText(messages: unknown, toolName: string) {
  if (!Array.isArray(messages)) return ""
  const results = messages.flatMap((message) => {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "tool") return []
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return []
    return content
      .filter((part) => part && typeof part === "object" &&
        (part as { type?: unknown }).type === "tool-result" &&
        (part as { toolName?: unknown }).toolName === toolName)
      .map((part) => modelVisibleText((part as { output?: unknown }).output))
  })
  return results.at(-1) ?? ""
}

function localVerifierTextStream() {
  return completeTextStream([
    "<verifier_result>",
    JSON.stringify({
      status: "pass",
      checks: [{ key: "real-did-ols", label: "did.xlsx OLS 产物", status: "pass", message: "结果使用当前 did.xlsx 阶段和已确认规格生成。" }],
      blockingFindings: [], repairHints: [], trustedArtifacts: [],
      summary: "本地脚本化 OLS 阶段核验完成。", findings: [],
    }),
    "</verifier_result>",
  ].join("\n"))
}

describe("真实数据脚本化公开对话回放", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("真实 did.xlsx 画像参数写错后按错误反馈修正同一工具", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-profile-repair-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[scripted-profile-repair] KILLSTATA_PYTHON 未设置，跳过真实后端回放")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        let mainRound = 0
        const requestedActions: string[] = []

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.small) return { fullStream: completeTextStream("后台摘要") } as never
          mainRound += 1
          if (mainRound === 1) {
            requestedActions.push("import")
            return { fullStream: completeToolStream("data_import", "call_profile_repair_import", { action: "import", inputPath: source }) } as never
          }
          const lineage = lineageFromMessages(request.messages)
          if (mainRound === 2) {
            requestedActions.push("profile-invalid")
            return {
              fullStream: completeToolStream("data_import", "call_profile_invalid", {
                action: "profile", ...lineage, variables: ["不存在的年份列"],
              }),
            } as never
          }
          if (mainRound === 3) {
            requestedActions.push("profile-repaired")
            return { fullStream: completeToolStream("data_import", "call_profile_repaired", { action: "profile", ...lineage }) } as never
          }
          return { fullStream: completeTextStream("已根据画像错误反馈修正参数，数据画像完成；没有切换计量方法。") } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `导入 ${source} 并查看数据结构。` }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const messages = await Session.messages({ sessionID: session.id })
        const profileParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "data_import")
        const invalid = profileParts.find((part) => part.state.status === "error")
        const repaired = profileParts.find((part) => part.state.status === "completed" && part.state.input?.action === "profile")
        const visible = assistantText(messages)

        expect(requestedActions).toEqual(["import", "profile-invalid", "profile-repaired"])
        expect(invalid?.state.status).toBe("error")
        expect(repaired?.state.status).toBe("completed")
        expect(visible).toContain("根据画像错误反馈修正参数")
        expect(visible).toContain("没有切换计量方法")
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("真实 did.xlsx 导入后自动压缩使用空工具集并保留任务目标", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-auto-compact-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[scripted-auto-compact] KILLSTATA_PYTHON 未设置，跳过真实后端回放")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        let mainRound = 0
        let compactionToolCount: number | undefined
        const summary = `<analysis>只用于整理，不进入后续上下文</analysis>
<summary>
1. 主要请求和意图：导入 did.xlsx 并继续计量分析
2. 关键技术与计量概念：面板数据、传统 DID 设计检查
3. 文件、数据与代码位置：did.xlsx 已导入并生成规范化数据阶段
4. 错误、根因与修复：尚无不可恢复错误
5. 问题解决过程：已完成数据导入
6. 所有真实用户消息：导入 did.xlsx 并查看数据结构
7. 待完成任务：继续检查 DID 识别条件
8. 当前工作：压缩后从数据导入结果继续，不重新导入文件
9. 可选下一步：确认相对时期变量或由用户决定替代方法
</summary>`

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.contextPolicy === "compaction") {
            compactionToolCount = Object.keys(request.tools?.definitions ?? {}).length
            return { fullStream: completeTextStream(summary) } as never
          }
          mainRound += 1
          if (mainRound === 1) {
            return { fullStream: completeToolStream("data_import", "call_auto_compact_import", { action: "import", inputPath: source }) } as never
          }
          return { fullStream: completeTextStream("已完成 did.xlsx 导入，当前任务是继续检查 DID 识别条件。") } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `导入 ${source} 并查看数据结构，后续继续做 DID 识别检查。` }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "analyst",
          model: { providerID: model.providerID, modelID: model.id },
          auto: true,
          reason: "threshold",
        })
        const messagesBefore = await Session.messages({ sessionID: session.id })
        const boundary = messagesBefore.findLast((message) =>
          message.info.role === "user" && message.parts.some((part) => part.type === "compaction"),
        )
        expect(boundary?.info.role).toBe("user")
        if (!boundary || boundary.info.role !== "user") throw new Error("自动压缩边界未创建")

        await expect(SessionCompaction.process({
          parentID: boundary.info.id,
          messages: messagesBefore,
          sessionID: session.id,
          abort: new AbortController().signal,
          auto: true,
          reason: "threshold",
        })).resolves.toBe("continue")

        const messagesAfter = await Session.messages({ sessionID: session.id })
        const compacted = messagesAfter.find((message) => message.info.role === "assistant" && message.info.summary === true)
        const summaryText = compacted?.parts
          .filter((part): part is MessageV2.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n") ?? ""
        expect(compactionToolCount).toBe(0)
        expect(summaryText).toContain("导入 did.xlsx")
        expect(summaryText).toContain("继续检查 DID 识别条件")
        expect(summaryText).not.toContain("只用于整理")
        expect(messagesAfter.some((message) => message.parts.some((part) => part.type === "compaction-restore"))).toBe(true)
        expect(fs.existsSync(path.join(root, ".killstata"))).toBe(true)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("重复画像后只保留一次无工具文字收尾，不再进入工具空转", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-reuse-finish-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[scripted-reuse-finish] KILLSTATA_PYTHON 未设置，跳过真实后端回放")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const mainTools: string[] = []
        let mainRound = 0
        let textOnlyRound: number | undefined

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.small) return { fullStream: completeTextStream("后台摘要") } as never
          mainRound += 1
          if (mainRound === 1) {
            mainTools.push("data_import")
            return { fullStream: completeToolStream("data_import", "call_reuse_import", { action: "import", inputPath: source }) } as never
          }
          const lineage = lineageFromMessages(request.messages)
          if (mainRound === 2 || mainRound === 3) {
            mainTools.push("data_import")
            return {
              fullStream: completeToolStream("data_import", `call_reuse_profile_${mainRound}`, {
                action: "profile", ...lineage,
              }),
            } as never
          }
          textOnlyRound = mainRound
          return { fullStream: completeTextStream("已完成数据画像。当前没有新的信息，已停止重复查询。") } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `导入 ${source} 并查看数据结构；如果同一画像结果已复用，请直接用中文收尾。` }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const messages = await Session.messages({ sessionID: session.id })
        const visible = assistantText(messages)
        expect(mainTools).toEqual(["data_import", "data_import", "data_import"])
        expect(mainRound).toBe(4)
        expect(textOnlyRound).toBe(4)
        expect(visible).toContain("已完成数据画像")
        expect(visible).not.toContain("不应再次请求相同结果")
        expect(fs.existsSync(path.join(root, ".killstata"))).toBe(true)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("gf.xlsx"))("模型按导入→推荐→Panel FE推进，year冲突先询问用户再交付中文结果", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-conversation-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[scripted-conversation] KILLSTATA_PYTHON 未设置，跳过真实后端回放")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const source = path.join(root, "gf.xlsx")
    fs.copyFileSync(localRealDataPath("gf.xlsx"), source)
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const mainTools: string[] = []
        const questions: string[] = []
        const actualExecutions: string[] = []
        const originalExecute = EconometricsEngineClient.prototype.execute
        spies.push(spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(async function (this: EconometricsEngineClient, payload, signal) {
          actualExecutions.push(payload.method_id)
          return originalExecute.call(this, payload, signal)
        }))
        let mainRound = 0

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.small) return { fullStream: completeTextStream("后台摘要") } as never
          mainRound += 1
          if (mainRound === 1) {
            mainTools.push("data_import")
            return {
              fullStream: completeToolStream("data_import", "call_import", {
                action: "import",
                inputPath: source,
                preserveLabels: true,
              }),
            } as never
          }
          const lineage = lineageFromMessages(request.messages)
          if (mainRound === 2) {
            const importedStage = readDatasetManifest(lineage.datasetId).stages.find((stage) => stage.stageId === lineage.stageId)
            expect(importedStage?.metadata?.dataDiagnosis).toMatchObject({ version: 1, stage_id: lineage.stageId })
            mainTools.push("econometrics_recommend")
            return {
              fullStream: completeToolStream("econometrics_recommend", "call_recommend", {
                ...lineage,
                dependentVar: "绿色金融指数",
                treatmentVar: "绿色信贷",
                entityVar: "地区",
                timeVar: "年份",
              }),
            } as never
          }
          if (mainRound === 3) {
            mainTools.push("tool_search")
            return {
              fullStream: completeToolStream("tool_search", "call_panel_search", {
                query: "panel_fe_regression",
                limit: 1,
              }),
            } as never
          }
          if (mainRound === 4) {
            const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.taskId === RuntimeTaskLedger.listTasks(session.id).activeTaskId)
            if (!task?.analysisRequest) throw new Error("Panel FE 请求没有 AnalysisRequest")
            mainTools.push("analysis_prepare:misspelled-time")
            return {
              fullStream: completeToolStream("analysis_prepare", "call_panel_prepare_invalid_time", {
                requestId: task.analysisRequest.requestId,
                methodID: "panel_fe_regression",
                arguments: {
                  dependentVar: "绿色金融指数",
                  treatmentVar: "绿色信贷",
                  covariates: [],
                  entityVar: "地区",
                  timeVar: "year",
                  covariance: "clustered",
                },
              }),
            } as never
          }
          if (mainRound === 5) {
            const previous = latestNamedToolResultText(request.messages, "analysis_prepare")
            if (!/year|时间|不存在|缺少|前置/.test(previous)) {
              throw new Error(`预检未向模型提供时间列问题：${previous}`)
            }
            mainTools.push("question:confirm-time-column")
            return {
              fullStream: completeToolStream("question", "call_panel_question_time", {
                questions: [{
                  header: "确认时间列",
                  question: "数据中没有 year 列，但有“年份”列。是否使用“年份”作为时间变量？",
                  options: [
                    { label: "用“年份”替代（推荐）", description: "只确认实际时间列名称，不改变面板设定。" },
                    { label: "停止本次分析", description: "暂不替换变量，等待你提供正确列名。" },
                  ],
                }],
              }),
            } as never
          }
          if (mainRound === 6) {
            const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.taskId === RuntimeTaskLedger.listTasks(session.id).activeTaskId)
            if (!task?.analysisRequest) throw new Error("Panel FE 请求没有 AnalysisRequest")
            mainTools.push("analysis_prepare:confirmed-time")
            return {
              fullStream: completeToolStream("analysis_prepare", "call_panel_prepare_confirmed_time", {
                requestId: task.analysisRequest.requestId,
                methodID: "panel_fe_regression",
                arguments: {
                  dependentVar: "绿色金融指数",
                  treatmentVar: "绿色信贷",
                  covariates: [],
                  entityVar: "地区",
                  timeVar: "年份",
                  covariance: "clustered",
                },
              }),
            } as never
          }
          if (mainRound === 7) {
            const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.taskId === RuntimeTaskLedger.listTasks(session.id).activeTaskId)
            if (!task?.preparedSpec) throw new Error("Panel FE 未获得 PreparedSpec")
            mainTools.push("econometrics_execute:prepared-panel-fe")
            return {
              fullStream: completeToolStream("econometrics_execute", "call_panel_execute_prepared", {
                specId: task.preparedSpec.specId,
              }),
            } as never
          }
          return { fullStream: completeTextStream("面板固定效应回归已完成。绿色信贷系数已生成，请结合共线性和研究设计谨慎解读。") } as never
        }))

        const unsubscribe = Bus.subscribe(Question.Event.Asked, (event) => {
          const question = event.properties.questions[0]?.question
          questions.push(String(question ?? ""))
          Question.reply({ requestID: event.properties.id, answers: [["用“年份”替代（推荐）"]] }).catch(() => {})
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
          unsubscribe()
        }

        const messages = await Session.messages({ sessionID: session.id })
        const visible = assistantText(messages)
        const panelToolStates = messages.flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart =>
            part.type === "tool" && part.tool === "econometrics_execute" && part.state.input?.specId,
          )
          .map((part) => part.state)
        expect(mainTools).toEqual([
          "data_import",
          "econometrics_recommend",
          "tool_search",
          "analysis_prepare:misspelled-time",
          "question:confirm-time-column",
          "analysis_prepare:confirmed-time",
          "econometrics_execute:prepared-panel-fe",
        ])
        expect(questions.some((question) => question.includes("year") && question.includes("年份"))).toBe(true)
        expect(visible).toContain("面板固定效应回归已完成")
        expect(panelToolStates.some((state) => state.status === "completed")).toBe(true)
        expect(actualExecutions).toEqual(["data_import", "econometrics_recommend", "panel_fe_regression"])
        expect(visible).not.toContain("datasetId")
        expect(visible).not.toContain("stageId")
        expect(fs.existsSync(path.join(root, ".killstata"))).toBe(true)
        const resultFiles: string[] = []
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(file)
            else if (entry.name === "results.json" || entry.name === "coefficients.csv") resultFiles.push(file)
          }
        }
        walk(path.join(root, ".killstata"))
        expect(resultFiles.some((file) => file.includes("panel_fe_regression"))).toBe(true)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("真实 did.xlsx：tool_search 披露 OLS Schema 后，参数错误返回模型并经 econometrics_execute 修正", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据工具回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python Registry 执行")
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-did-stable-ols-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    let mainRound = 0
    let verifierSessionID: string | undefined
    let verifierCompleted!: () => void
    const verifierCompletedPromise = new Promise<void>((resolve) => { verifierCompleted = resolve })
    const requestedTools: string[] = []
    let providerVisibleToolIDs: string[] = []
    let schemaVisibleBeforeEstimate = false
    let covarianceErrorReachedRepairTurn = false
    let schemaReloadedAfterNotSent = false

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
          const info = event.properties.info
          if (info.parentID === session.id && info.title.startsWith("工作流核验 - ")) verifierSessionID = info.id
        })
        const unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (event.properties.sessionID === verifierSessionID && event.properties.status.type === "idle") {
            verifierCompleted()
          }
        })
        let verifierTimeout: ReturnType<typeof setTimeout> | undefined

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.agent.name === "verifier") return { fullStream: localVerifierTextStream() } as never
          if (request.small) return { fullStream: completeTextStream("本地后台摘要") } as never

          mainRound += 1
          const text = modelVisibleText(request.messages)
          const lineage = mainRound > 1 ? lineageFromMessages(request.messages) : undefined
          if (mainRound === 1) {
            requestedTools.push("data_import:import")
            return {
              fullStream: completeToolStream("data_import", "call_real_did_import", {
                action: "import",
                inputPath: source,
                preserveLabels: true,
                sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
              }),
            } as never
          }
          if (mainRound === 2) {
            requestedTools.push("data_import:profile")
            return { fullStream: completeToolStream("data_import", "call_real_did_profile", { action: "profile", ...lineage }) } as never
          }
          if (mainRound === 3) {
            requestedTools.push("data_import:validate")
            return { fullStream: completeToolStream("data_import", "call_real_did_validate", { action: "validate", ...lineage }) } as never
          }
          if (mainRound === 4) {
            requestedTools.push("tool_search:ols_regression")
            providerVisibleToolIDs = Object.keys(request.tools?.definitions ?? {})
            return { fullStream: completeToolStream("tool_search", "call_real_did_ols_search", { query: "ols_regression", limit: 1 }) } as never
          }
          if (mainRound === 5) {
            requestedTools.push("analysis_prepare:invalid-covariance")
            schemaVisibleBeforeEstimate = text.includes("参数 Schema：") &&
              text.includes('"dependentVar"') && text.includes('"covariance"')
            const taskLedger = RuntimeTaskLedger.listTasks(session.id)
            const task = taskLedger.tasks.find((item) => item.taskId === taskLedger.activeTaskId)
            if (!task?.analysisRequest) throw new Error("OLS 请求没有 AnalysisRequest")
            return {
              fullStream: completeToolStream("analysis_prepare", "call_real_did_ols_invalid", {
                requestId: task.analysisRequest.requestId,
                methodID: "ols_regression",
                arguments: {
                  dependentVar: "高质量发展指数",
                  treatmentVar: "did",
                  covariates: ["人口规模", "人均GDP", "金融发展程度"],
                  covariance: "clustered",
                },
              }),
            } as never
          }
          if (mainRound === 6) {
            requestedTools.push("analysis_prepare:corrected-covariance")
            const failure = namedToolResultText(request.messages, "analysis_prepare")
            covarianceErrorReachedRepairTurn = /covariance|协方差/i.test(failure) && failure.length > 0
            const taskLedger = RuntimeTaskLedger.listTasks(session.id)
            const task = taskLedger.tasks.find((item) => item.taskId === taskLedger.activeTaskId)
            if (!task?.analysisRequest) throw new Error("OLS 请求没有 AnalysisRequest")
            return {
              fullStream: completeToolStream("analysis_prepare", "call_real_did_ols_repaired", {
                requestId: task.analysisRequest.requestId,
                methodID: "ols_regression",
                arguments: {
                  dependentVar: "高质量发展指数",
                  treatmentVar: "did",
                  covariates: ["人口规模", "人均GDP", "金融发展程度"],
                  covariance: "HC1",
                },
              }),
            } as never
          }
          if (mainRound === 7) {
            const priorPreparationError = namedToolResultText(request.messages, "analysis_prepare")
            schemaReloadedAfterNotSent = /完整.*Schema|tool_search|重新搜索/i.test(priorPreparationError)
            requestedTools.push("tool_search:ols_regression-recovery")
            return {
              fullStream: completeToolStream("tool_search", "call_real_did_ols_recovery_search", {
                query: "ols_regression",
                limit: 1,
              }),
            } as never
          }
          if (mainRound === 8) {
            const taskLedger = RuntimeTaskLedger.listTasks(session.id)
            const task = taskLedger.tasks.find((item) => item.taskId === taskLedger.activeTaskId)
            if (!task?.analysisRequest) throw new Error("OLS 请求没有 AnalysisRequest")
            requestedTools.push("analysis_prepare:corrected-covariance-after-search")
            return {
              fullStream: completeToolStream("analysis_prepare", "call_real_did_ols_repaired_after_search", {
                requestId: task.analysisRequest?.requestId,
                methodID: "ols_regression",
                arguments: {
                  dependentVar: "高质量发展指数",
                  treatmentVar: "did",
                  covariates: ["人口规模", "人均GDP", "金融发展程度"],
                  covariance: "HC1",
                },
              }),
            } as never
          }
          if (mainRound === 9) {
            const taskLedger = RuntimeTaskLedger.listTasks(session.id)
            const task = taskLedger.tasks.find((item) => item.taskId === taskLedger.activeTaskId)
            if (!task?.preparedSpec) throw new Error("重新加载 Schema 后未产生 OLS PreparedSpec")
            requestedTools.push("econometrics_execute:ols_regression")
            return {
              fullStream: completeToolStream("econometrics_execute", "call_real_did_ols_execute", {
                specId: task.preparedSpec.specId,
              }),
            } as never
          }
          return { fullStream: completeTextStream("did.xlsx 的 OLS 已完成；无效协方差参数已依据 Schema 错误修正。") } as never
        }))

        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{
              type: "text",
              text: `导入 ${source}，用 OLS 估计高质量发展指数对 did 的关系，控制人口规模、人均GDP、金融发展程度，使用 HC1 稳健标准误。`,
            }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })
          try {
            await Promise.race([
              verifierCompletedPromise,
              new Promise<never>((_, reject) => {
                verifierTimeout = setTimeout(() => reject(new Error("did.xlsx 本地脚本化 verifier Session 未收尾")), 10_000)
              }),
            ])
          } catch (error) {
            const failedMessages = await Session.messages({ sessionID: session.id })
            const failedTools = failedMessages.flatMap((message) => message.parts)
              .filter((part): part is MessageV2.ToolPart => part.type === "tool")
              .map((part) => ({
                tool: part.tool,
                status: part.state.status,
                input: part.state.input,
                error: part.state.status === "error" ? String(part.state.error) : undefined,
                output: part.state.status === "completed" ? part.state.output : undefined,
              }))
            throw new Error(`${String(error)}; modelRound=${mainRound}; tools=${JSON.stringify(failedTools)}; assistant=${assistantText(failedMessages)}`)
          }
        } finally {
          if (verifierTimeout) clearTimeout(verifierTimeout)
          unsubscribeCreated()
          unsubscribeStatus()
        }

        const messages = await Session.messages({ sessionID: session.id })
        const visible = assistantText(messages)
        const toolParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const estimateParts = toolParts.filter((part) => part.tool === "econometrics_execute")
        const prepareParts = toolParts.filter((part) => part.tool === "analysis_prepare")
        const failed = prepareParts.find((part) => part.state.status === "error")
        const completed = estimateParts.find((part) => part.state.status === "completed")
        if (!failed || failed.state.status !== "error") throw new Error("无效 OLS covariance 未被 Python Schema 记录为规格准备失败")
        if (!completed || completed.state.status !== "completed") throw new Error("修正后的真实 did.xlsx OLS 没有完成")
        const result = completed.state.metadata.result as {
          method?: string
          rowsUsed?: number
          resultPath?: string
          coefficientsPath?: string
        } | undefined
        const resultFile = typeof result?.resultPath === "string" ? path.resolve(root, result.resultPath) : ""
        const coefficientsFile = typeof result?.coefficientsPath === "string" ? path.resolve(root, result.coefficientsPath) : ""

        expect(requestedTools).toEqual([
          "data_import:import",
          "data_import:profile",
          "data_import:validate",
          "tool_search:ols_regression",
          "analysis_prepare:invalid-covariance",
          "analysis_prepare:corrected-covariance",
          "tool_search:ols_regression-recovery",
          "analysis_prepare:corrected-covariance-after-search",
          "econometrics_execute:ols_regression",
        ])
        expect(providerVisibleToolIDs).toContain("tool_search")
        expect(providerVisibleToolIDs).toContain("econometrics_execute")
        expect(providerVisibleToolIDs).not.toContain("ols_regression")
        expect(schemaVisibleBeforeEstimate).toBe(true)
        expect(covarianceErrorReachedRepairTurn).toBe(true)
        expect(schemaReloadedAfterNotSent).toBe(true)
        expect(failed.state.error).toMatch(/covariance|协方差/i)
        expect(failed.state.error).not.toContain("未进入本轮模型上下文")
        expect(result).toMatchObject({ method: "ols_regression" })
        expect(result?.rowsUsed).toBeGreaterThan(4_000)
        expect(fs.existsSync(resultFile)).toBe(true)
        expect(fs.existsSync(coefficientsFile)).toBe(true)
        expect(visible).toContain("did.xlsx 的 OLS 已完成")
        expect(visible).not.toContain("datasetId")
        expect(visible).not.toContain("stageId")
        expect(prepareParts.map((part) => part.state.status)).toEqual(["error", "completed", "completed"])
        expect(prepareParts[1]?.state.status === "completed"
          ? prepareParts[1].state.metadata.analysisSpecStatus
          : undefined).toBe("schema_not_sent")
        expect(estimateParts.map((part) => part.state.status)).toEqual(["completed"])
      } })
    } finally {
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("gf.xlsx"))("真实 gf.xlsx：恢复用户明确指定且存在的 timeVar，不询问并继续同一 Panel FE", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据工具回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python Registry 执行")
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-gf-stable-panel-"))
    const source = path.join(root, "gf.xlsx")
    fs.copyFileSync(localRealDataPath("gf.xlsx"), source)
    let mainRound = 0
    let verifierSessionID: string | undefined
    let verifierCompleted!: () => void
    const verifierCompletedPromise = new Promise<void>((resolve) => { verifierCompleted = resolve })
    const requestedTools: string[] = []
    const questions: string[] = []
    let providerVisibleToolIDs: string[] = []
    let schemaVisibleBeforeEstimate = false

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
          const info = event.properties.info
          if (info.parentID === session.id && info.title.startsWith("工作流核验 - ")) verifierSessionID = info.id
        })
        const unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (event.properties.sessionID === verifierSessionID && event.properties.status.type === "idle") {
            verifierCompleted()
          }
        })
        const unsubscribeQuestion = Bus.subscribe(Question.Event.Asked, (event) => {
          const question = event.properties.questions[0]?.question
          questions.push(String(question ?? ""))
          Question.reply({ requestID: event.properties.id, answers: [["用“年份”替代（推荐）"]] }).catch(() => {})
        })
        let verifierTimeout: ReturnType<typeof setTimeout> | undefined

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.agent.name === "verifier") return { fullStream: localVerifierTextStream() } as never
          if (request.small) return { fullStream: completeTextStream("本地后台摘要") } as never

          mainRound += 1
          const text = modelVisibleText(request.messages)
          const lineage = mainRound > 1 ? lineageFromMessages(request.messages) : undefined
          if (mainRound === 1) {
            requestedTools.push("data_import:import")
            return { fullStream: completeToolStream("data_import", "call_real_gf_import", {
              action: "import", inputPath: source, preserveLabels: true,
            }) } as never
          }
          if (mainRound === 2) {
            requestedTools.push("econometrics_recommend:panel-spec")
            return { fullStream: completeToolStream("econometrics_recommend", "call_real_gf_recommend", {
              ...lineage,
              dependentVar: "绿色金融指数",
              treatmentVar: "绿色信贷",
              entityVar: "地区",
              timeVar: "年份",
            }) } as never
          }
          if (mainRound === 3) {
            requestedTools.push("tool_search:panel_fe_regression")
            providerVisibleToolIDs = Object.keys(request.tools?.definitions ?? {})
            return { fullStream: completeToolStream("tool_search", "call_real_gf_panel_search", {
              query: "panel_fe_regression", limit: 1,
            }) } as never
          }
          if (mainRound === 4) {
            requestedTools.push("analysis_prepare:misspelled-year")
            schemaVisibleBeforeEstimate = text.includes("参数 Schema：") &&
              text.includes('"entityVar"') && text.includes('"timeVar"')
            const taskLedger = RuntimeTaskLedger.listTasks(session.id)
            const task = taskLedger.tasks.find((item) => item.taskId === taskLedger.activeTaskId)
            if (!task?.analysisRequest) throw new Error("Panel FE 请求没有 AnalysisRequest")
            return { fullStream: completeToolStream("analysis_prepare", "call_real_gf_panel_invalid_time", {
              requestId: task.analysisRequest.requestId,
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
            const taskLedger = RuntimeTaskLedger.listTasks(session.id)
            const task = taskLedger.tasks.find((item) => item.taskId === taskLedger.activeTaskId)
            if (!task?.preparedSpec) throw new Error("用户明确指定的“年份”未产生 Panel FE PreparedSpec")
            requestedTools.push("econometrics_execute:panel_fe_regression")
            return { fullStream: completeToolStream("econometrics_execute", "call_real_gf_panel_execute", {
              specId: task.preparedSpec.specId,
            }) } as never
          }
          if (mainRound === 6) return { fullStream: completeTextStream("gf.xlsx 的 Panel FE 已完成，按你指定的“年份”作为时间变量。") } as never
          throw new Error(`Unexpected scripted Panel FE round ${mainRound}`)
        }))

        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: `导入 ${source}，做双向固定效应回归：实体=地区，时间=年份，因变量=绿色金融指数，核心解释变量=绿色信贷。` }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })
          let currentMessages = await Session.messages({ sessionID: session.id })
          const currentEstimateParts = currentMessages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "econometrics_execute")
          const completedBeforeVerification = currentEstimateParts.find(
            (part) => part.state.status === "completed",
          )
          if (!completedBeforeVerification) {
            throw new Error(
              `Panel FE 未完成；轮次=${mainRound}；工具=${requestedTools.join(",")}；问题=${questions.join(" | ")}; ` +
                `执行状态=${currentEstimateParts.map((part) => part.state.status === "error" ? part.state.error : part.state.status).join(" / ")}`,
            )
          }
          if (completedBeforeVerification.state.status === "completed" && completedBeforeVerification.state.metadata.verifierPending === true) {
            await Promise.race([
              verifierCompletedPromise,
              new Promise<never>((_, reject) => {
                verifierTimeout = setTimeout(() => reject(new Error("gf.xlsx 本地脚本化 verifier Session 未收尾")), 10_000)
              }),
            ])
            currentMessages = await Session.messages({ sessionID: session.id })
          }
        } finally {
          if (verifierTimeout) clearTimeout(verifierTimeout)
          unsubscribeCreated()
          unsubscribeStatus()
          unsubscribeQuestion()
        }

        const messages = await Session.messages({ sessionID: session.id })
        const visible = assistantText(messages)
        const toolParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const estimateParts = toolParts.filter((part) => part.tool === "econometrics_execute")
        const completed = estimateParts.find((part) => part.state.status === "completed")
        if (!completed || completed.state.status !== "completed") throw new Error("用户确认后的真实 gf.xlsx Panel FE 没有完成")
        const result = completed.state.metadata.result as {
          method?: string
          rowsUsed?: number
          resultPath?: string
          coefficientsPath?: string
        } | undefined
        const resultFile = typeof result?.resultPath === "string" ? path.resolve(root, result.resultPath) : ""
        const coefficientsFile = typeof result?.coefficientsPath === "string" ? path.resolve(root, result.coefficientsPath) : ""

        expect(requestedTools).toEqual([
          "data_import:import",
          "econometrics_recommend:panel-spec",
          "tool_search:panel_fe_regression",
          "analysis_prepare:misspelled-year",
          "econometrics_execute:panel_fe_regression",
        ])
        expect(providerVisibleToolIDs).toContain("tool_search")
        expect(providerVisibleToolIDs).toContain("econometrics_execute")
        expect(providerVisibleToolIDs).not.toContain("panel_fe_regression")
        expect(schemaVisibleBeforeEstimate).toBe(true)
        // “年份” was explicitly supplied by the user and exists in the imported sheet;
        // correcting the scripted model's misspelled `year` must not ask to approve the wrong column.
        expect(questions).toEqual([])
        expect(result).toMatchObject({ method: "panel_fe_regression" })
        expect(result?.rowsUsed).toBeGreaterThan(9_000)
        expect(fs.existsSync(resultFile)).toBe(true)
        expect(fs.existsSync(coefficientsFile)).toBe(true)
        const preparations = toolParts.filter((part) => part.tool === "analysis_prepare")
        expect(preparations).toHaveLength(1)
        const preparation = preparations[0]
        expect(preparation?.state.status).toBe("completed")
        if (preparation?.state.status === "completed") {
          expect(preparation.state.metadata.analysisSpecStatus).toBe("ready")
          expect(preparation.state.metadata.userSpecifiedParameterCorrections).toEqual([
            { field: "timeVar", modelValue: "year", userValue: "年份" },
          ])
        }
        const activeTask = RuntimeTaskLedger.listTasks(session.id).tasks
          .find((task) => task.taskId === RuntimeTaskLedger.listTasks(session.id).activeTaskId)
        const sourceMessageId = activeTask?.analysisRequest?.sourceMessageId
        if (!sourceMessageId) throw new Error("Panel FE AnalysisRequest 没有原始用户消息来源")
        expect(activeTask?.analysisSpecs?.at(-1)?.argumentSources.timeVar).toEqual({
          kind: "user_explicit",
          sourceMessageId,
        })
        expect(visible).toContain("gf.xlsx 的 Panel FE 已完成，按你指定的“年份”作为时间变量。")
        expect(visible).not.toContain("datasetId")
        expect(visible).not.toContain("stageId")
      } })
    } finally {
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("未知工具失败后重新选择已注册数据工具并继续导入", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-replan-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[scripted-replan] KILLSTATA_PYTHON 未设置，跳过真实后端回放")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const modelTools: string[] = []
        let mainRound = 0
        let retrySawUnknownToolFailure = ""
        let retryContextText = ""

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.small) return { fullStream: completeTextStream("后台摘要") } as never
          mainRound += 1
          if (mainRound === 1) {
            modelTools.push("magic_causal_wizard")
            return {
              fullStream: completeToolStream("magic_causal_wizard", "call_unknown", { datasetId: "wrong" }),
            } as never
          }
          if (mainRound === 2) {
            retrySawUnknownToolFailure = namedToolResultText(request.messages, "magic_causal_wizard")
            retryContextText = modelVisibleText(request.messages)
            modelTools.push("data_import")
            return {
              fullStream: completeToolStream("data_import", "call_replanned_import", {
                action: "import",
                inputPath: source,
              }),
            } as never
          }
          return {
            fullStream: completeTextStream("已根据工具反馈改用数据导入工具，数据已成功导入；接下来可以继续做画像或计量分析。"),
          } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `请读取并检查 ${source}，先完成数据导入。` }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const messages = await Session.messages({ sessionID: session.id })
        const visible = assistantText(messages)
        const unknownToolPart = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "magic_causal_wizard")
        expect(modelTools).toEqual(["magic_causal_wizard", "data_import"])
        expect(unknownToolPart?.state.status).toBe("error")
        expect(unknownToolPart?.state.status === "error" ? unknownToolPart.state.metadata?.failureDecision : undefined)
          .toMatchObject({ category: "tool_not_found", disposition: "repair" })
        expect(retrySawUnknownToolFailure).toContain("Tool magic_causal_wizard is not available in this request.")
        expect(retryContextText).toContain("工具 magic_causal_wizard 未注册，本次没有执行任何操作。")
        expect(retryContextText).toContain("请根据当前已注册工具目录重新选择工具")
        expect(retryContextText).not.toContain("无法安全归类的失败")
        expect(retryContextText).not.toContain("只修复阶段 verify")
        expect(visible).toContain("改用数据导入工具")
        expect(visible).not.toContain("magic_causal_wizard")
        expect(visible).not.toContain("datasetId")
        const imported = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .some((part) => part.type === "tool" && part.tool === "data_import" && part.state.status === "completed")
        expect(imported).toBe(true)
        const parquetFiles: string[] = []
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(file)
            else if (entry.name.endsWith(".parquet")) parquetFiles.push(file)
          }
        }
        walk(path.join(root, ".killstata"))
        expect(parquetFiles.length).toBeGreaterThan(0)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("真实 did.xlsx 质量诊断后同批运行只读方法推荐且不估计", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据方法推荐回放要求显式设置 KILLSTATA_PYTHON")
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-quality-recommendation-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const requestedTools: string[] = []
        let recommendationVisible = false
        let finalRequestTextOnly = false
        let mainRound = 0

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.agent.name === "verifier") {
            return { fullStream: localVerifierTextStream() } as never
          }
          if (request.small) return { fullStream: completeTextStream("本地后台摘要") } as never
          mainRound += 1
          if (mainRound === 1) {
            requestedTools.push("data_import:import")
            requestedTools.push("econometrics_recommend")
            const visibleToolIDs = Object.keys(request.tools?.definitions ?? {})
            recommendationVisible = visibleToolIDs.includes("econometrics_recommend")
            if (visibleToolIDs.includes("econometrics_execute") || visibleToolIDs.includes("ols_regression")) {
              throw new Error(`方法推荐轮误暴露估计器：${visibleToolIDs.join(",")}`)
            }
            const calls = [
              {
                toolName: "data_import",
                toolCallId: "call_quality_recommend_import",
                input: {
                  action: "import",
                  inputPath: source,
                  preserveLabels: true,
                  sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
                },
              },
              {
                toolName: "econometrics_recommend",
                toolCallId: "call_quality_recommend",
                input: {},
              },
            ]
            return {
              fullStream: (async function* () {
                yield { type: "start" }
                yield { type: "start-step" }
                for (const call of calls) {
                  yield { type: "tool-input-start", id: call.toolCallId, toolName: call.toolName }
                  yield { type: "tool-call", ...call }
                }
                yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
                yield { type: "finish" }
              })(),
            } as never
          }
          if (mainRound === 2) {
            finalRequestTextOnly = request.textOnly === true
            return { fullStream: completeTextStream("质量检查已完成。数据结构是面板，结构上可先考虑面板固定效应，并以 OLS 为备选。did 列名不能替代处理时点和研究设计，请明确结果变量与研究问题；本轮没有估计。") } as never
          }
          throw new Error(`质量检查与推荐场景出现非预期模型轮次：${mainRound}`)
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `导入 ${source}，检查数据缺失与质量问题，并推荐几个可行的计量方法。` }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const messages = await Session.messages({ sessionID: session.id })
        const toolParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const importPart = toolParts.find((part) => part.tool === "data_import" && part.state.input?.action === "import")
        const recommendationPart = toolParts.find((part) => part.tool === "econometrics_recommend")
        const estimators = toolParts.filter((part) => part.tool === "econometrics_execute" || part.tool.endsWith("_regression"))
        const visible = assistantText(messages)
        const importDatasetId = importPart?.state.status === "completed" ? importPart.state.metadata.datasetId : undefined
        const recommendationDatasetId = recommendationPart?.state.status === "completed"
          ? recommendationPart.state.metadata.datasetId
          : undefined
        const importStageId = importPart?.state.status === "completed" ? importPart.state.metadata.stageId : undefined
        const recommendationStageId = recommendationPart?.state.status === "completed"
          ? recommendationPart.state.metadata.stageId
          : undefined
        const recommendation = recommendationPart?.state.status === "completed"
          ? recommendationPart.state.metadata.recommendation as Record<string, unknown> | undefined
          : undefined

        expect(requestedTools).toEqual(["data_import:import", "econometrics_recommend"])
        expect(recommendationVisible).toBe(true)
        expect(finalRequestTextOnly).toBe(true)
        expect(importPart?.state.status).toBe("completed")
        if (importPart?.state.status === "completed") {
          expect(importPart.state.metadata.finalizeTextOnly).not.toBe(true)
          expect(importPart.state.output).toContain("质量体检摘要")
        }
        expect(recommendationPart?.state.status).toBe("completed")
        if (recommendationPart?.state.status === "completed") {
          expect(recommendationPart.state.metadata.finalizeTextOnly).toBe(true)
          expect(recommendationPart.state.metadata.recommendation).toBeDefined()
        }
        expect(recommendationDatasetId).toBe(importDatasetId)
        expect(recommendationStageId).toBe(importStageId)
        expect(recommendation).toMatchObject({
          dataStructure: "panel",
          recommendedMethod: "panel_fe_regression",
          confidence: "high",
        })
        expect(recommendation?.nextBestMethods).toContain("ols_regression")
        expect((recommendation?.warnings as string[]).some((warning) => /DID-like treatment name/.test(warning))).toBe(true)
        expect(estimators).toEqual([])
        expect(visible).toContain("面板固定效应")
        expect(visible).toContain("did 列名不能替代处理时点和研究设计")
        expect(visible).toContain("本轮没有估计")
        expect(visible).not.toContain("datasetId")
        expect(visible).not.toContain("stageId")
      } })
    } finally {
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("显式单方法 OLS 在导入后的 textOnly verifier 回合后继续执行", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据 OLS AgentLoop 回放要求显式设置 KILLSTATA_PYTHON")
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-textonly-import-resume-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    const requestedTools: string[] = []
    const modelRequests: Array<{ textOnly: boolean; inputIntent?: string }> = []
    let importSent = false
    let searchSent = false
    let prepareSent = false
    let executeSent = false
    let schemaVisibleBeforeExecute = false
    const verifierSessionIDs = new Set<string>()
    const idleVerifierSessionIDs = new Set<string>()

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
          const info = event.properties.info
          if (info.parentID === session.id && info.title.startsWith("工作流核验 - ")) verifierSessionIDs.add(info.id)
        })
        const unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (verifierSessionIDs.has(event.properties.sessionID) && event.properties.status.type === "idle") {
            idleVerifierSessionIDs.add(event.properties.sessionID)
          }
        })

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.agent.name === "verifier") return { fullStream: localVerifierTextStream() } as never
          if (request.small) return { fullStream: completeTextStream("本地后台摘要") } as never
          modelRequests.push({ textOnly: request.textOnly === true, inputIntent: request.inputIntent })

          // 模拟真实 Provider：textOnly 请求只能给文字答复，绝不调用被 SDK 隐藏的工具。
          if (request.textOnly === true) {
            const estimateResult = latestNamedToolResultText(request.messages, "econometrics_execute")
            return { fullStream: completeTextStream(estimateResult
              ? "OLS 已按当前数据阶段完成；仅报告统计关联，不作因果解释。"
              : "数据导入和质量检查已完成，我会继续按你明确指定的 OLS 规格处理。") } as never
          }

          if (!importSent) {
            importSent = true
            requestedTools.push("data_import:import")
            return { fullStream: completeToolStream("data_import", "call_textonly_ols_import", {
              action: "import",
              inputPath: source,
              preserveLabels: true,
              sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
            }) } as never
          }
          if (!searchSent) {
            searchSent = true
            requestedTools.push("tool_search:ols_regression")
            return { fullStream: completeToolStream("tool_search", "call_textonly_ols_search", {
              query: "ols_regression",
              limit: 1,
            }) } as never
          }
          if (!prepareSent) {
            prepareSent = true
            const visibleBeforeExecute = modelVisibleText(request.messages)
            schemaVisibleBeforeExecute = visibleBeforeExecute.includes("参数 Schema：") &&
              visibleBeforeExecute.includes('"dependentVar"') &&
              visibleBeforeExecute.includes('"treatmentVar"')
            const taskLedger = RuntimeTaskLedger.listTasks(session.id)
            const task = taskLedger.tasks.find((item) => item.taskId === taskLedger.activeTaskId)
            if (!task?.analysisRequest) throw new Error("OLS 请求没有 AnalysisRequest")
            requestedTools.push("analysis_prepare:ols_regression")
            return { fullStream: completeToolStream("analysis_prepare", "call_textonly_ols_prepare", {
              requestId: task.analysisRequest.requestId,
              methodID: "ols_regression",
              arguments: {
                dependentVar: "创新指数",
                treatmentVar: "高质量发展指数",
                covariates: [],
                covariance: "HC1",
              },
            }) } as never
          }
          if (!executeSent) {
            executeSent = true
            const taskLedger = RuntimeTaskLedger.listTasks(session.id)
            const task = taskLedger.tasks.find((item) => item.taskId === taskLedger.activeTaskId)
            if (!task?.preparedSpec) throw new Error("OLS analysis_prepare 未产生 PreparedSpec")
            requestedTools.push("econometrics_execute:ols_regression")
            return { fullStream: completeToolStream("econometrics_execute", "call_textonly_ols_execute", {
              specId: task.preparedSpec.specId,
            }) } as never
          }
          return { fullStream: completeTextStream("已按指定规格完成 OLS。") } as never
        }))

        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: `导入 ${source} 的 Data_可读 工作表，做 OLS 回归：因变量=创新指数，核心解释变量=高质量发展指数，HC1；检查数据质量但不自动清洗，只作统计关联、不作因果解释。` }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })

          const verifierDeadline = Date.now() + 10_000
          while (Date.now() < verifierDeadline) {
            const currentMessages = await Session.messages({ sessionID: session.id })
            const currentEstimate = currentMessages
              .filter((message) => message.info.role === "assistant")
              .flatMap((message) => message.parts)
              .find((part): part is MessageV2.ToolPart =>
                part.type === "tool" &&
                part.tool === "econometrics_execute" &&
                part.state.status === "completed" &&
                part.state.metadata.method === "ols_regression",
              )
            const metadata = currentEstimate?.state.status === "completed"
              ? currentEstimate.state.metadata
              : undefined
            const allVerifiersIdle = verifierSessionIDs.size > 0 &&
              [...verifierSessionIDs].every((id) => idleVerifierSessionIDs.has(id))
            if (
              allVerifiersIdle &&
              metadata?.verifierPending !== true &&
              !/状态：待核验/.test(currentEstimate?.state.status === "completed" ? currentEstimate.state.output : "")
            ) break
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
        } finally {
          unsubscribeCreated()
          unsubscribeStatus()
        }

        const messages = await Session.messages({ sessionID: session.id })
        const toolParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const importPart = toolParts.find((part) => part.tool === "data_import" && part.state.input?.action === "import")
        const estimatePart = toolParts.find((part) =>
          part.tool === "econometrics_execute" &&
          part.state.status === "completed" &&
          part.state.metadata.method === "ols_regression",
        )
        const result = estimatePart?.state.status === "completed"
          ? estimatePart.state.metadata.result as Record<string, unknown> | undefined
          : undefined
        const visible = assistantText(messages)

        expect(modelRequests.some((request) => request.textOnly)).toBe(true)
        const textOnlyIndex = modelRequests.findIndex((request) => request.textOnly)
        expect(modelRequests.slice(textOnlyIndex + 1).some((request) => !request.textOnly)).toBe(true)
        expect(requestedTools).toEqual([
          "data_import:import",
          "tool_search:ols_regression",
          "analysis_prepare:ols_regression",
          "econometrics_execute:ols_regression",
        ])
        expect(schemaVisibleBeforeExecute).toBe(true)
        expect(importPart?.state.status).toBe("completed")
        expect(estimatePart?.state.status).toBe("completed")
        expect(result?.success).toBe(true)
        expect(Number(result?.rowsUsed)).toBeGreaterThan(4_000)
        expect(result?.covariance).toBe("HC1")
        expect(visible).toContain("OLS")
        expect(visible).not.toContain("datasetId")
        expect(visible).not.toContain("stageId")
        expect(verifierSessionIDs.size).toBeGreaterThan(0)
        expect([...verifierSessionIDs].every((id) => idleVerifierSessionIDs.has(id))).toBe(true)
      } })
    } finally {
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("方法门禁在无新增工具进展时有界停止且不伪报估计完成", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据方法续跑回放要求显式设置 KILLSTATA_PYTHON")
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-method-no-progress-stop-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    const requestedTools: string[] = []
    const modelRequests: Array<{ textOnly: boolean }> = []
    const verifierSessionIDs = new Set<string>()
    const idleVerifierSessionIDs = new Set<string>()

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
          const info = event.properties.info
          if (info.parentID === session.id && info.title.startsWith("工作流核验 - ")) verifierSessionIDs.add(info.id)
        })
        const unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (verifierSessionIDs.has(event.properties.sessionID) && event.properties.status.type === "idle") {
            idleVerifierSessionIDs.add(event.properties.sessionID)
          }
        })
        let importSent = false

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.agent.name === "verifier") return { fullStream: localVerifierTextStream() } as never
          if (request.small) return { fullStream: completeTextStream("本地后台摘要") } as never
          modelRequests.push({ textOnly: request.textOnly === true })

          // 每个 textOnly 回合都严格只返回文字；工具可见时，这个模型仍选择不采取下一步动作。
          if (request.textOnly === true) {
            return { fullStream: completeTextStream("数据导入步骤已完成，我会先整理当前状态。") } as never
          }
          if (!importSent) {
            importSent = true
            requestedTools.push("data_import:import")
            return { fullStream: completeToolStream("data_import", "call_no_progress_import", {
              action: "import",
              inputPath: source,
              preserveLabels: true,
              sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
            }) } as never
          }
          return { fullStream: completeTextStream("当前没有足够信息继续估计，我先停下来。") } as never
        }))

        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: `导入 ${source} 的 Data_可读 工作表，做 OLS 回归：因变量=创新指数，核心解释变量=高质量发展指数，HC1。` }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })

          const afterPrompt = await Session.messages({ sessionID: session.id })
          const importPart = afterPrompt
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .find((part): part is MessageV2.ToolPart =>
              part.type === "tool" && part.tool === "data_import" && part.state.input?.action === "import",
            )
          if (importPart?.state.status === "completed" && importPart.state.metadata.verifierPending === true) {
            const deadline = Date.now() + 10_000
            while (Date.now() < deadline) {
              if (verifierSessionIDs.size > 0 && [...verifierSessionIDs].every((id) => idleVerifierSessionIDs.has(id))) break
              await new Promise((resolve) => setTimeout(resolve, 20))
            }
          }
        } finally {
          unsubscribeCreated()
          unsubscribeStatus()
        }

        const messages = await Session.messages({ sessionID: session.id })
        const toolParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const requiredReminders = messages
          .filter((message) => message.info.role === "user")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.TextPart =>
            part.type === "text" && part.synthetic === true && part.text.includes("用户本轮明确要求执行"),
          )
        const visible = assistantText(messages)

        expect(modelRequests.some((request) => request.textOnly)).toBe(true)
        expect(requestedTools).toEqual(["data_import:import"])
        expect(toolParts.some((part) => part.tool === "tool_search" || part.tool === "econometrics_execute")).toBe(false)
        expect(requiredReminders).toHaveLength(2)
        expect(visible).toContain("尚未实际执行OLS 回归")
        expect(visible).not.toContain("OLS 已完成")
        expect(visible).not.toContain("datasetId")
        expect(visible).not.toContain("stageId")
        expect([...verifierSessionIDs].every((id) => idleVerifierSessionIDs.has(id))).toBe(true)
      } })
    } finally {
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
