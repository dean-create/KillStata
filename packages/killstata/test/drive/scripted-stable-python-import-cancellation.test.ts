import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { RuntimeEvents } from "@/runtime/events"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { readDatasetIndex, readDatasetManifest } from "@/tool/analysis-state"
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
    yield { type: "text-start", id: "cancel-import-text" }
    yield { type: "text-delta", id: "cancel-import-text", text }
    yield { type: "text-end", id: "cancel-import-text" }
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function assistantText(messages: MessageV2.WithParts[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
}

function completeImportRequest(inputPath: string) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "tool-input-start", id: "call_cancel_real_import", toolName: "data_import" }
    yield {
      type: "tool-call",
      toolCallId: "call_cancel_real_import",
      toolName: "data_import",
      input: {
        action: "import",
        inputPath,
        preserveLabels: true,
        sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
      },
    }
    yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
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

describe("真实 did.xlsx 导入执行中的用户取消", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("Python 引擎已开始导入后取消会终止该轮并清理新数据集", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据取消回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python 执行")
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-real-import-cancel-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    let sessionID = ""
    let modelRequests = 0
    let verifierRequests = 0
    let engineStarted = false
    let cancelIssued = false
    let cancelled = false
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribeProgress = () => {}
    let unsubscribeLifecycle = () => {}
    const importLifecycle: string[] = []

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        sessionID = session.id
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        unsubscribeProgress = Bus.subscribe(RuntimeEvents.ToolProgress, (event) => {
          const progress = event.properties
          if (
            progress.sessionID !== session.id ||
            progress.toolName !== "econometrics_engine" ||
            progress.message !== "正在执行 data_import" ||
            cancelIssued
          ) return
          engineStarted = true
          cancelIssued = true
          // Engine 已接受 execute 并发出 Python progress 帧；稍等其进入 handler，再模拟用户按停止。
          abortTimer = setTimeout(() => {
            SessionPrompt.cancel(session.id)
            cancelled = true
          }, 10)
        })
        unsubscribeLifecycle = Bus.subscribe(RuntimeEvents.ToolLifecycle, (event) => {
          if (event.properties.sessionID === session.id && event.properties.toolName === "data_import") {
            importLifecycle.push(event.properties.phase)
          }
        })

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
if (request.small) return { fullStream: completeTextStream("本地摘要") } as never
          if (String(request.agent.name).toLowerCase() === "verifier") {
            verifierRequests += 1
            return { fullStream: completeTextStream("不应在未完成导入时启动核验") } as never
          }
          modelRequests += 1
          if (request.textOnly === true) return { fullStream: completeTextStream("导入尚未完成") } as never
          if (modelRequests > 1) throw new Error("用户取消导入后不应重新请求模型或自动重试")
          return { fullStream: completeImportRequest(source) } as never
        }))

        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: `导入 ${source} 的 Data_可读 页。` }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })
        } catch {
          // SessionPrompt may resolve the stop state or reject its queued action; both are valid cancel surfaces.
        }

        const messages = await Session.messages({ sessionID: session.id })
        const importPart = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" &&
            part.tool === "data_import" && part.state.input?.action === "import")
        expect(engineStarted).toBe(true)
        expect(cancelIssued).toBe(true)
        expect(cancelled).toBe(true)
        expect(modelRequests).toBe(1)
        expect(verifierRequests).toBe(0)
        expect(importPart).toBeDefined()
        expect(importPart?.state.status, importPart?.state.status === "error" ? String(importPart.state.error) : "").toBe("error")
        if (importPart?.state.status === "error") expect(importPart.state.error).toMatch(/取消|停止|abort|ENGINE_ABORTED/i)
        expect(importLifecycle).toContain("cancelled")
        const createdDatasets = Object.values(readDatasetIndex().entries)
          .filter((entry) => entry.createdBySessionID === session.id)
        expect(createdDatasets).toEqual([])
        const datasetsDirectory = path.join(root, ".killstata", "datasets")
        const persistedDatasetDirectories = fs.existsSync(datasetsDirectory)
          ? fs.readdirSync(datasetsDirectory).filter((entry) => entry !== "index.json")
          : []
        expect(persistedDatasetDirectories).toEqual([])
        expect(messages.flatMap((message) => message.parts).some((part) =>
          part.type === "tool" && part.tool === "data_import" && part.state.status === "completed",
        )).toBe(false)
      } })
    } finally {
      if (abortTimer) clearTimeout(abortTimer)
      unsubscribeProgress()
      unsubscribeLifecycle()
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("OLS 已进入真实 Python 执行后取消不会发布估计结果或自动重试", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据取消回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python 执行")
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-real-ols-cancel-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    let analysisRequests = 0
    let toolRounds = 0
    let requestsAtCancel = -1
    let engineRunning = false
    let cancelIssued = false
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribeProgress = () => {}
    let unsubscribeLifecycle = () => {}
    const olsLifecycle: string[] = []
    const engineExecuteSpy = spyOn(EconometricsEngineClient.prototype, "execute")
    spies.push(engineExecuteSpy)

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const activeEstimateTask = () => {
          const ledger = RuntimeTaskLedger.listTasks(session.id)
          return ledger.tasks.find((item) => item.taskId === ledger.activeTaskId && item.analysisRequest?.kind === "estimate")
        }
        unsubscribeProgress = Bus.subscribe(RuntimeEvents.ToolProgress, (event) => {
          const progress = event.properties
          if (
            progress.sessionID !== session.id ||
            progress.toolName !== "econometrics_engine" ||
            progress.message !== "正在执行 ols_regression" ||
            cancelIssued
          ) return
          engineRunning = true
          abortTimer = setTimeout(() => {
            cancelIssued = true
            requestsAtCancel = analysisRequests
            SessionPrompt.cancel(session.id)
          }, 2)
        })
        unsubscribeLifecycle = Bus.subscribe(RuntimeEvents.ToolLifecycle, (event) => {
          if (event.properties.sessionID === session.id && event.properties.toolName === "ols_regression") {
            olsLifecycle.push(event.properties.phase)
          }
        })

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
if (request.small) return { fullStream: completeTextStream("本地摘要") } as never
          if (String(request.agent.name).toLowerCase() === "verifier") {
            return { fullStream: completeTextStream("取消的 OLS 不应进入独立核验") } as never
          }
          analysisRequests += 1
          if (request.textOnly === true) return { fullStream: completeTextStream("导入后的核验文字已收尾；继续 OLS。") } as never
          toolRounds += 1
          if (toolRounds === 1) return { fullStream: completeImportRequest(source) } as never
          if (toolRounds === 2) return { fullStream: completeToolCall("data_import", "call_ols_cancel_profile", { action: "profile" }) } as never
          if (toolRounds === 3) return { fullStream: completeToolCall("data_import", "call_ols_cancel_validate", { action: "validate" }) } as never
          if (toolRounds === 4) return { fullStream: completeToolCall("tool_search", "call_ols_cancel_search", { query: "ols_regression", limit: 1 }) } as never
          if (toolRounds === 5) {
            const task = activeEstimateTask()
            if (!task?.analysisRequest) throw new Error("取消 OLS 回放缺少当前 AnalysisRequest")
            return { fullStream: completeToolCall("analysis_prepare", "call_ols_cancel_prepare", {
              requestId: task.analysisRequest.requestId,
              methodID: "ols_regression",
              arguments: {
                dependentVar: "高质量发展指数",
                treatmentVar: "did",
                covariates: ["人口规模", "人均GDP", "金融发展程度"],
                covariance: "HC1",
              },
            }) } as never
          }
          if (toolRounds === 6) {
            const prepared = activeEstimateTask()?.preparedSpec
            if (!prepared || prepared.methodID !== "ols_regression") throw new Error("取消 OLS 回放没有 PreparedSpec")
            return { fullStream: completeToolCall("econometrics_execute", "call_ols_cancel_estimate", { specId: prepared.specId }) } as never
          }
          throw new Error("取消 OLS 后不应自动发出新的分析请求")
        }))

        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: `导入 ${source} 的 Data_可读 页，用 OLS 估计高质量发展指数对 did 的关系，控制人口规模、人均GDP、金融发展程度，使用 HC1。` }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })
        } catch {
          // 用户停止可能正常收束本轮，也可能拒绝等待中的 action。
        }

        const messages = await Session.messages({ sessionID: session.id })
        const toolParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const importPart = toolParts.find((part) => part.tool === "data_import" && part.state.input?.action === "import")
        const olsSpecIDs = new Set(activeEstimateTask()?.analysisSpecs
          ?.filter((spec) => spec.methodID === "ols_regression")
          .map((spec) => spec.specId) ?? [])
        const olsPart = toolParts.find((part) => part.tool === "econometrics_execute" &&
          typeof part.state.input?.specId === "string" && olsSpecIDs.has(part.state.input.specId))
        expect(engineRunning).toBe(true)
        expect(cancelIssued).toBe(true)
        expect(requestsAtCancel).toBe(analysisRequests)
        expect(analysisRequests).toBeGreaterThanOrEqual(5)
        expect(olsPart?.state.status, olsPart?.state.status === "error" ? String(olsPart.state.error) : "").toBe("error")
        if (olsPart?.state.status === "error") expect(olsPart.state.error).toMatch(/取消|停止|abort|ENGINE_ABORTED/i)
        expect(olsLifecycle).toContain("cancelled")
        expect(importPart?.state.status).toBe("completed")
        const datasetId = importPart?.state.status === "completed" ? importPart.state.metadata.datasetId : undefined
        const manifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined
        expect(manifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])
        expect(manifest?.artifacts.some((artifact) => artifact.action === "ols_regression")).toBe(false)
        expect(manifest?.finalOutputs).toEqual([])
        expect(engineExecuteSpy.mock.calls.map(([request]) => request.method_id)
          .filter((methodID) => methodID === "ols_regression")).toHaveLength(1)
        expect(olsPart?.state.status === "completed" ? olsPart.state.metadata.result : undefined).toBeUndefined()
        expect(assistantText(messages)).not.toMatch(/OLS.{0,8}(?:已完成|估计成功)/)
      } })
    } finally {
      if (abortTimer) clearTimeout(abortTimer)
      unsubscribeProgress()
      unsubscribeLifecycle()
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("Python 完成 OLS 写盘后、JSONL 终态到达前取消会回收未登记结果", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据取消回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python 执行")
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-real-ols-late-cancel-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    let analysisRequests = 0
    let toolRounds = 0
    let requestsAtCancel = -1
    let completedProgressSeen = false
    let cancelIssued = false
    let outputDirectory = ""
    let resultFilesPresentAtProgress = false
    let unsubscribeProgress = () => {}
    const engineExecuteSpy = spyOn(EconometricsEngineClient.prototype, "execute")
    spies.push(engineExecuteSpy)

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const activeEstimateTask = () => {
          const ledger = RuntimeTaskLedger.listTasks(session.id)
          return ledger.tasks.find((item) => item.taskId === ledger.activeTaskId && item.analysisRequest?.kind === "estimate")
        }
        unsubscribeProgress = Bus.subscribe(RuntimeEvents.ToolProgress, (event) => {
          const progress = event.properties
          if (
            progress.sessionID !== session.id ||
            progress.toolName !== "econometrics_engine" ||
            progress.message !== "已完成 ols_regression" ||
            cancelIssued
          ) return

          completedProgressSeen = true
          requestsAtCancel = analysisRequests
          const request = engineExecuteSpy.mock.calls
            .map(([candidate]) => candidate)
            .find((candidate) => candidate.method_id === "ols_regression")
          outputDirectory = typeof request?.output_dir === "string" ? request.output_dir : ""
          resultFilesPresentAtProgress = Boolean(outputDirectory) &&
            fs.existsSync(path.join(outputDirectory, "results.json")) &&
            fs.existsSync(path.join(outputDirectory, "coefficients.csv"))
          cancelIssued = true
          // Python persisted the files and emitted completed progress, but the terminal JSONL result is pending.
          SessionPrompt.cancel(session.id)
        })

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
if (request.small) return { fullStream: completeTextStream("本地摘要") } as never
          if (String(request.agent.name).toLowerCase() === "verifier") {
            return { fullStream: completeTextStream("取消的 OLS 不应进入独立核验") } as never
          }
          analysisRequests += 1
          if (request.textOnly === true) return { fullStream: completeTextStream("导入核验已收尾；继续 OLS。") } as never
          toolRounds += 1
          if (toolRounds === 1) return { fullStream: completeImportRequest(source) } as never
          if (toolRounds === 2) return { fullStream: completeToolCall("data_import", "call_ols_late_profile", { action: "profile" }) } as never
          if (toolRounds === 3) return { fullStream: completeToolCall("data_import", "call_ols_late_validate", { action: "validate" }) } as never
          if (toolRounds === 4) return { fullStream: completeToolCall("tool_search", "call_ols_late_search", { query: "ols_regression", limit: 1 }) } as never
          if (toolRounds === 5) {
            const task = activeEstimateTask()
            if (!task?.analysisRequest) throw new Error("晚取消 OLS 回放缺少当前 AnalysisRequest")
            return { fullStream: completeToolCall("analysis_prepare", "call_ols_late_prepare", {
              requestId: task.analysisRequest.requestId,
              methodID: "ols_regression",
              arguments: {
                dependentVar: "高质量发展指数",
                treatmentVar: "did",
                covariates: ["人口规模", "人均GDP", "金融发展程度"],
                covariance: "HC1",
              },
            }) } as never
          }
          if (toolRounds === 6) {
            const prepared = activeEstimateTask()?.preparedSpec
            if (!prepared || prepared.methodID !== "ols_regression") throw new Error("晚取消 OLS 回放没有 PreparedSpec")
            return { fullStream: completeToolCall("econometrics_execute", "call_ols_late_execute", { specId: prepared.specId }) } as never
          }
          throw new Error("OLS completed progress 后取消不应触发新的分析请求")
        }))

        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: `导入 ${source} 的 Data_可读 页，用 OLS 估计高质量发展指数对 did 的关系，控制人口规模、人均GDP、金融发展程度，使用 HC1。` }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })
        } catch {
          // The stop can resolve the cancelled action or reject its pending prompt.
        }

        const messages = await Session.messages({ sessionID: session.id })
        const toolParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const importPart = toolParts.find((part) => part.tool === "data_import" && part.state.input?.action === "import")
        const olsSpecIDs = new Set(activeEstimateTask()?.analysisSpecs
          ?.filter((spec) => spec.methodID === "ols_regression")
          .map((spec) => spec.specId) ?? [])
        const olsPart = toolParts.find((part) => part.tool === "econometrics_execute" &&
          typeof part.state.input?.specId === "string" && olsSpecIDs.has(part.state.input.specId))
        expect(completedProgressSeen).toBe(true)
        expect(resultFilesPresentAtProgress).toBe(true)
        expect(cancelIssued).toBe(true)
        expect(requestsAtCancel).toBe(analysisRequests)
        expect(outputDirectory).toBeTruthy()
        expect(olsPart?.state.status, olsPart?.state.status === "error" ? String(olsPart.state.error) : "").toBe("error")
        if (olsPart?.state.status === "error") expect(olsPart.state.error).toMatch(/取消|停止|abort|ENGINE_ABORTED/i)
        expect(importPart?.state.status).toBe("completed")
        const datasetId = importPart?.state.status === "completed" ? importPart.state.metadata.datasetId : undefined
        const manifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined
        expect(manifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])
        expect(manifest?.artifacts.some((artifact) => artifact.action === "ols_regression")).toBe(false)
        expect(manifest?.finalOutputs).toEqual([])
        const orphanResultFiles = ["results.json", "coefficients.csv"]
          .filter((filename) => fs.existsSync(path.join(outputDirectory, filename)))
        expect(orphanResultFiles).toEqual([])
        expect(assistantText(messages)).not.toMatch(/OLS.{0,8}(?:已完成|估计成功)/)
      } })
    } finally {
      unsubscribeProgress()
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

})
