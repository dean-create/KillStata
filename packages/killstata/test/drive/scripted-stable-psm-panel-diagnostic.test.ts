import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { RuntimeHooks } from "@/runtime/hooks"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { readDatasetManifest } from "@/tool/analysis-state"
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
    yield { type: "text-start", id: "psm-diagnostic-summary" }
    yield { type: "text-delta", id: "psm-diagnostic-summary", text }
    yield { type: "text-end", id: "psm-diagnostic-summary" }
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

describe("did.xlsx 面板数据上的 PSM 诊断门禁", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("倾向得分诊断必须先确认唯一分析单位，不能把地区—年份当独立观测", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据 AgentLoop 回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python 执行")
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-psm-panel-diagnostic-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    const requestedTools: string[] = []
    const recoveryTools: string[] = []
    let mainRound = 0
    let recoveryTurn = false
    let loadedPsmSchema = ""
    let psmToolPart: MessageV2.ToolPart | undefined

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
        const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute")
        spies.push(executeSpy)

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
if (request.small) return { fullStream: completeTextStream("本地会话摘要") } as never
          if (request.textOnly === true) return { fullStream: completeTextStream("当前回合只返回文字，不调用工具。") } as never

          mainRound += 1
          if (recoveryTurn) {
            if (mainRound === 1) {
              recoveryTools.push("data_preprocess:filter-year-2021")
              return { fullStream: completeToolStream("data_preprocess", "call_psm_panel_confirmed_filter", {
                method: "filter",
                columns: [],
                options: { rules: [{ column: "year", operator: "eq", value: 2021 }] },
              }) } as never
            }
            if (mainRound === 2) {
              recoveryTools.push("tool_search:psm_matching-scope-check-after-confirmation")
              return { fullStream: completeToolStream("tool_search", "call_psm_panel_confirmed_scope_search", {
                query: "psm_matching",
                limit: 1,
              }) } as never
            }
            if (mainRound === 3) {
              recoveryTools.push("data_import:profile-filtered-stage")
              return { fullStream: completeToolStream("data_import", "call_psm_panel_profile_filtered", { action: "profile" }) } as never
            }
            if (mainRound === 4) {
              recoveryTools.push("data_import:validate-filtered-stage")
              return { fullStream: completeToolStream("data_import", "call_psm_panel_validate_filtered", { action: "validate" }) } as never
            }
            if (mainRound === 5) {
              recoveryTools.push("tool_search:psm_construction")
              return { fullStream: completeToolStream("tool_search", "call_psm_panel_construction_search_filtered", {
                query: "psm_construction",
                limit: 1,
              }) } as never
            }
            if (mainRound === 6) {
              recoveryTools.push("analysis_prepare:psm_construction")
              const task = activeEstimateTask()
              if (!task?.analysisRequest) throw new Error("过滤后 PSM 诊断缺少当前 AnalysisRequest")
              return { fullStream: completeToolStream("analysis_prepare", "call_psm_panel_construction_prepare_filtered", {
                requestId: task.analysisRequest.requestId,
                methodID: "psm_construction",
                arguments: { treatmentVar: "did", analysisUnitVar: "地区", covariates: ["人口规模"] },
              }) } as never
            }
            if (mainRound === 7) {
              recoveryTools.push("econometrics_execute:psm_construction")
              const prepared = activeEstimateTask()?.preparedSpec
              if (!prepared || prepared.methodID !== "psm_construction") throw new Error("过滤后 PSM 构造没有生成 PreparedSpec")
              return { fullStream: completeToolStream("econometrics_execute", "call_psm_panel_construction_filtered", { specId: prepared.specId }) } as never
            }
            if (mainRound === 8) {
              recoveryTools.push("tool_search:psm_visualize")
              return { fullStream: completeToolStream("tool_search", "call_psm_panel_visualize_search_filtered", {
                query: "psm_visualize",
                limit: 1,
              }) } as never
            }
            if (mainRound === 9) {
              recoveryTools.push("analysis_prepare:psm_visualize")
              const task = activeEstimateTask()
              if (!task?.analysisRequest) throw new Error("过滤后 PSM 可视化缺少当前 AnalysisRequest")
              return { fullStream: completeToolStream("analysis_prepare", "call_psm_panel_visualize_prepare_filtered", {
                requestId: task.analysisRequest.requestId,
                methodID: "psm_visualize",
                arguments: { treatmentVar: "did", analysisUnitVar: "地区", covariates: ["人口规模"] },
              }) } as never
            }
            if (mainRound === 10) {
              recoveryTools.push("econometrics_execute:psm_visualize")
              const prepared = activeEstimateTask()?.preparedSpec
              if (!prepared || prepared.methodID !== "psm_visualize") throw new Error("过滤后 PSM 可视化没有生成 PreparedSpec")
              return { fullStream: completeToolStream("econometrics_execute", "call_psm_panel_visualize_filtered", { specId: prepared.specId }) } as never
            }
            if (mainRound === 11) {
              return { fullStream: completeTextStream("已按用户确认的 2021 年横截面完成 PSM 分布诊断；未执行 ATT/ATE 估计，也不作因果解释。") } as never
            }
            return { fullStream: completeTextStream("仍需明确横截面时期或聚合规则。") } as never
          }
          if (mainRound === 1) {
            requestedTools.push("data_import:import")
            return { fullStream: completeToolStream("data_import", "call_psm_panel_import", {
              action: "import",
              inputPath: source,
              preserveLabels: true,
              sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
            }) } as never
          }
          if (mainRound === 2) {
            requestedTools.push("data_import:profile")
            return { fullStream: completeToolStream("data_import", "call_psm_panel_profile", { action: "profile" }) } as never
          }
          if (mainRound === 3) {
            requestedTools.push("data_import:validate")
            return { fullStream: completeToolStream("data_import", "call_psm_panel_validate", { action: "validate" }) } as never
          }
          if (mainRound === 4) {
            requestedTools.push("tool_search:psm_construction")
            return { fullStream: completeToolStream("tool_search", "call_psm_diagnostic_search", {
              query: "psm_construction",
              limit: 1,
            }) } as never
          }
          if (mainRound === 5) {
            requestedTools.push("analysis_prepare:psm_construction")
            loadedPsmSchema = modelVisibleText(request.messages)
            const task = activeEstimateTask()
            if (!task?.analysisRequest) throw new Error("PSM 面板诊断准备缺少 AnalysisRequest")
            return { fullStream: completeToolStream("analysis_prepare", "call_psm_panel_construction_prepare", {
              requestId: task.analysisRequest.requestId,
              methodID: "psm_construction",
              arguments: {
                treatmentVar: "did",
                analysisUnitVar: "地区",
                covariates: ["人口规模"],
              },
            }) } as never
          }

          return { fullStream: completeTextStream("我已暂停 PSM 诊断，等待你确认分析单位和样本时期。") } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{
            type: "text",
            text: `导入 ${source} 的 Data_可读 页。这是地区—年份面板。只做 PSM 倾向得分诊断，处理变量=did，协变量=人口规模；暂不估计处理效应。如果需要每个地区一行或确认协变量时点，请先告诉我，不要替我筛选年份、聚合或构造新列。`,
          }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const messages = await Session.messages({ sessionID: session.id })
        psmToolPart = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" &&
            part.tool === "analysis_prepare" && part.state.input?.methodID === "psm_construction")

        const toolParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const importPart = toolParts.find((part) => part.tool === "data_import" &&
          part.state.input?.action === "import" && part.state.status === "completed")
        if (!importPart || importPart.state.status !== "completed") throw new Error("真实 did.xlsx 未完成导入")
        const datasetId = importPart.state.metadata.datasetId
        const manifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined

        expect(psmToolPart).toBeDefined()
        expect(loadedPsmSchema).toContain("analysisUnitVar")
        expect(loadedPsmSchema).toContain("分析单位唯一标识列")
        expect(psmToolPart?.state.status).toBe("completed")
        if (psmToolPart?.state.status === "completed") {
          expect(psmToolPart.state.metadata.requiresUserDecision).toBe(true)
          expect(psmToolPart.state.output).toContain("4432")
          expect(psmToolPart.state.output).toMatch(/每个分析单位仅一行|分析时期|聚合规则/)
          expect(psmToolPart.state.metadata.result).toBeUndefined()
        }
        const executedMethodIDs = executeSpy.mock.calls.map(([request]) => request.method_id)
        expect(executedMethodIDs).not.toContain("psm_construction")
        expect(executedMethodIDs).not.toContain("psm_visualize")
        expect(executedMethodIDs).not.toContain("psm_matching")
        expect(manifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])
        expect(requestedTools).toEqual([
          "data_import:import",
          "data_import:profile",
          "data_import:validate",
          "tool_search:psm_construction",
          "analysis_prepare:psm_construction",
        ])
        expect(assistantText(messages)).toContain("本轮已暂停")

        recoveryTurn = true
        mainRound = 0
        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{
            type: "text",
            text: "我确认按 year=2021 筛选，每个地区一行；人口规模是政策实施后的描述性协变量，不估计 ATT/ATE，也不作因果解释。继续做倾向得分构造诊断，并生成倾向得分分布图。",
          }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const continuedMessages = await Session.messages({ sessionID: session.id })
        const continuationEstimatorAttempt = continuedMessages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" &&
            part.tool === "econometrics_execute" && part.state.input?.specId === "spec_unprepared_psm_matching")
        const continuationForbiddenSearch = continuedMessages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" &&
            part.tool === "tool_search" && part.state.input?.query === "psm_matching")
        const confirmedFilterPart = continuedMessages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" &&
            part.tool === "data_preprocess" && part.state.input?.method === "filter")
        const directEstimatorAfterConfirmation = continuedMessages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "psm_matching")
        const recoveryTask = activeEstimateTask()
        const continuedDiagnosticSpecs = recoveryTask?.analysisSpecs?.filter((spec) =>
          ["psm_construction", "psm_visualize"].includes(spec.methodID) && spec.status === "ready",
        ) ?? []
        const continuedDiagnosticParts = continuedMessages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool" &&
            part.tool === "econometrics_execute" &&
            continuedDiagnosticSpecs.some((spec) => spec.specId === part.state.input?.specId))
        const continuedByMethod = Object.fromEntries(continuedDiagnosticSpecs.map((spec) => [
          spec.methodID,
          continuedDiagnosticParts.find((part) => part.state.input?.specId === spec.specId),
        ]))
        const continuedConstruction = continuedByMethod.psm_construction as MessageV2.ToolPart | undefined
        const continuedVisualization = continuedByMethod.psm_visualize as MessageV2.ToolPart | undefined
        expect(recoveryTools).toEqual([
          "data_preprocess:filter-year-2021",
          "tool_search:psm_matching-scope-check-after-confirmation",
          "data_import:profile-filtered-stage",
          "data_import:validate-filtered-stage",
          "tool_search:psm_construction",
          "analysis_prepare:psm_construction",
          "econometrics_execute:psm_construction",
          "tool_search:psm_visualize",
          "analysis_prepare:psm_visualize",
          "econometrics_execute:psm_visualize",
        ])
        expect(confirmedFilterPart?.state.status).toBe("completed")
        if (confirmedFilterPart?.state.status === "completed") {
          expect(confirmedFilterPart.state.output).toContain("行数：4709 → 277")
          expect(confirmedFilterPart.state.input?.options).toEqual({
            rules: [{ column: "year", operator: "eq", value: 2021 }],
          })
        }
        const continuedManifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined
        expect(continuedManifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000", "stage_001"])
        expect(continuedManifest?.stages.at(-1)?.parentStageId).toBe("stage_000")
        const filteredStage = continuedManifest?.stages.at(-1)
        expect(filteredStage?.rowCount).toBe(277)
        const filteredData = JSON.parse(execFileSync(process.env.KILLSTATA_PYTHON!, [
          "-c",
          "import json,pandas as pd,sys; d=pd.read_parquet(sys.argv[1]); print(json.dumps({'rows':len(d),'years':sorted(d['year'].dropna().unique().tolist())}))",
          filteredStage!.workingPath,
        ], { encoding: "utf-8" })) as { rows: number; years: number[] }
        expect(filteredData).toEqual({ rows: 277, years: [2021] })
        expect(continuationForbiddenSearch?.state.status).toBe("completed")
        if (continuationForbiddenSearch?.state.status === "completed") {
          expect(continuationForbiddenSearch.state.metadata.matchCount).toBe(0)
          expect(continuationForbiddenSearch.state.metadata.availableCount).toBe(2)
        }
        expect(continuationEstimatorAttempt).toBeUndefined()
        expect(directEstimatorAfterConfirmation).toBeUndefined()
        expect(continuedConstruction?.state.status).toBe("completed")
        expect(continuedVisualization?.state.status).toBe("completed")
        if (continuedConstruction?.state.status === "completed") {
          expect((continuedConstruction.state.metadata.result as Record<string, unknown>)?.rowsUsed).toBe(277)
        }
        if (continuedVisualization?.state.status === "completed") {
          expect((continuedVisualization.state.metadata.result as Record<string, unknown>)?.rowsUsed).toBe(277)
        }
        const continuedExecutedMethods = executeSpy.mock.calls.map(([request]) => request.method_id)
        expect(continuedExecutedMethods).toContain("data_preprocess")
        expect(continuedExecutedMethods).toContain("psm_construction")
        expect(continuedExecutedMethods).toContain("psm_visualize")
        expect(continuedExecutedMethods).not.toContain("psm_matching")
      } })
    } finally {
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("NSW 横截面数据上的 PSM 诊断正向 AgentLoop", () => {
  const nswSource = path.resolve(import.meta.dir, "../../../killstata-econometrics-engine/tests/fixtures/nsw_dw_analysis.csv")
  const treatmentVar = "treat"
  const analysisUnitVar = "unit_id"
  const covariates = ["age", "age_squared", "education", "black", "hispanic", "nodegree"]

  test.skipIf(!fs.existsSync(nswSource))("构造和可视化诊断经稳定路由完成，产物进入模型上下文且不触发效应估计", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据 AgentLoop 回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python 执行")
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-psm-diagnostic-nsw-"))
    const source = path.join(root, path.basename(nswSource))
    fs.copyFileSync(nswSource, source)
    const requestedTools: string[] = []
    const modelRequestModes: Array<{ textOnly: boolean; completedToolRounds: number }> = []
    const importPostHookSignals: Array<{ deferred: boolean; verifierPending: boolean }> = []
    let mainRound = 0
    let modelInputBeforeConstruction = ""
    let modelInputBeforeVisualization = ""
    let finalModelInputText = ""

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
        const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute")
        spies.push(executeSpy)
        const originalPostTool = RuntimeHooks.postTool.bind(RuntimeHooks)
        spies.push(spyOn(RuntimeHooks, "postTool").mockImplementation(async (input) => {
          const result = await originalPostTool(input)
          if (input.toolName === "data_import" &&
            Boolean(input.args && typeof input.args === "object" && !Array.isArray(input.args) &&
              (input.args as Record<string, unknown>).action === "import")) {
            importPostHookSignals.push({
              deferred: input.deferVerification === true,
              verifierPending: result.metadata?.verifierPending === true,
            })
          }
          return result
        }))

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
const agentName = String((request.agent as { name?: unknown } | undefined)?.name ?? "").toLowerCase()
          if (agentName === "verifier") {
            const envelope = {
              status: "pass",
              checks: [{ key: "psm-diagnostics", label: "PSM 诊断产物", status: "pass", message: "仅核对诊断产物，不将其解释为处理效应。" }],
              blockingFindings: [],
              repairHints: [],
              trustedArtifacts: [],
              summary: "本地诊断产物核验完成。",
              findings: [],
            }
            return { fullStream: completeTextStream(`<verifier_result>${JSON.stringify(envelope)}</verifier_result>`) } as never
          }
          if (request.small) return { fullStream: completeTextStream("本地会话摘要") } as never
          modelRequestModes.push({ textOnly: request.textOnly === true, completedToolRounds: mainRound })
          if (request.textOnly === true) return { fullStream: completeTextStream("当前回合只返回文字，不调用工具。") } as never

          mainRound += 1
          if (mainRound === 1) {
            requestedTools.push("data_import:import")
            return { fullStream: completeToolStream("data_import", "call_psm_nsw_import", {
              action: "import",
              inputPath: source,
              preserveLabels: true,
            }) } as never
          }
          if (mainRound === 2) {
            requestedTools.push("tool_search:psm_matching-scope-check")
            return { fullStream: completeToolStream("tool_search", "call_psm_nsw_forbidden_search", {
              query: "psm_matching",
              limit: 1,
            }) } as never
          }
          if (mainRound === 3) {
            requestedTools.push("econometrics_execute:psm_matching")
            return { fullStream: completeToolStream("econometrics_execute", "call_psm_nsw_forbidden_matching", {
              methodID: "psm_matching",
              arguments: {
                dependentVar: "re78",
                treatmentVar,
                analysisUnitVar,
                preTreatmentAggregation: "not_applicable",
                covariates,
              },
            }) } as never
          }
          if (mainRound === 4) {
            requestedTools.push("psm_matching:direct-forbidden")
            return { fullStream: completeToolStream("psm_matching", "call_psm_nsw_direct_forbidden_matching", {
              dependentVar: "re78",
              treatmentVar,
              analysisUnitVar,
              preTreatmentAggregation: "not_applicable",
              covariates,
            }) } as never
          }
          if (mainRound === 5) {
            requestedTools.push("data_import:profile")
            return { fullStream: completeToolStream("data_import", "call_psm_nsw_profile", { action: "profile" }) } as never
          }
          if (mainRound === 6) {
            requestedTools.push("data_import:validate")
            return { fullStream: completeToolStream("data_import", "call_psm_nsw_validate", { action: "validate" }) } as never
          }
          if (mainRound === 7) {
            requestedTools.push("tool_search:psm_construction")
            return { fullStream: completeToolStream("tool_search", "call_psm_nsw_construction_search", {
              query: "psm_construction",
              limit: 1,
            }) } as never
          }
          if (mainRound === 8) {
            requestedTools.push("analysis_prepare:psm_construction")
            modelInputBeforeConstruction = modelVisibleText(request.messages)
            const task = activeEstimateTask()
            if (!task?.analysisRequest) throw new Error("NSW PSM 构造缺少当前 AnalysisRequest")
            return { fullStream: completeToolStream("analysis_prepare", "call_psm_nsw_construction_prepare", {
              requestId: task.analysisRequest.requestId,
              methodID: "psm_construction",
              arguments: { treatmentVar, analysisUnitVar, covariates },
            }) } as never
          }
          if (mainRound === 9) {
            requestedTools.push("econometrics_execute:psm_construction")
            const prepared = activeEstimateTask()?.preparedSpec
            if (!prepared || prepared.methodID !== "psm_construction") throw new Error("NSW PSM 构造没有生成 PreparedSpec")
            return { fullStream: completeToolStream("econometrics_execute", "call_psm_nsw_construction", { specId: prepared.specId }) } as never
          }
          if (mainRound === 10) {
            requestedTools.push("tool_search:psm_visualize")
            return { fullStream: completeToolStream("tool_search", "call_psm_nsw_visualize_search", {
              query: "psm_visualize",
              limit: 1,
            }) } as never
          }
          if (mainRound === 11) {
            requestedTools.push("analysis_prepare:psm_visualize")
            modelInputBeforeVisualization = modelVisibleText(request.messages)
            const task = activeEstimateTask()
            if (!task?.analysisRequest) throw new Error("NSW PSM 可视化缺少当前 AnalysisRequest")
            return { fullStream: completeToolStream("analysis_prepare", "call_psm_nsw_visualize_prepare", {
              requestId: task.analysisRequest.requestId,
              methodID: "psm_visualize",
              arguments: { treatmentVar, analysisUnitVar, covariates },
            }) } as never
          }
          if (mainRound === 12) {
            requestedTools.push("econometrics_execute:psm_visualize")
            const prepared = activeEstimateTask()?.preparedSpec
            if (!prepared || prepared.methodID !== "psm_visualize") throw new Error("NSW PSM 可视化没有生成 PreparedSpec")
            return { fullStream: completeToolStream("econometrics_execute", "call_psm_nsw_visualize", { specId: prepared.specId }) } as never
          }
          if (mainRound === 13) {
            finalModelInputText = modelVisibleText(request.messages)
            return { fullStream: completeTextStream("PSM 倾向得分诊断和分布图已完成。N=445；共同支撑覆盖率约99.3%。这不是处理效应估计，协变量处理前时点仍需研究设计确认。") } as never
          }
          throw new Error(`unexpected PSM model round ${mainRound}`)
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{
            type: "text",
            text: `导入 ${source}。这是 NSW 一人一行实验样本；treat 是 0/1 处理分配，unit_id 是分析单位，age、age_squared、education、black、hispanic、nodegree 均为处理前特征。请只做倾向得分构造诊断和分布可视化，检查共同支撑，不估计 ATT/ATE 或作因果结论。`,
          }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const messages = await Session.messages({ sessionID: session.id })
        const currentTask = activeEstimateTask()
        const preparedDiagnosticSpecs = currentTask?.analysisSpecs?.filter((spec) =>
          ["psm_construction", "psm_visualize"].includes(spec.methodID) && spec.status === "ready",
        ) ?? []
        const methodParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool" &&
            part.tool === "econometrics_execute" &&
            preparedDiagnosticSpecs.some((spec) => spec.specId === part.state.input?.specId))
        const forbiddenEstimatorPart = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" &&
            part.tool === "econometrics_execute" && part.state.input?.methodID === "psm_matching")
        const forbiddenSearchPart = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" &&
            part.tool === "tool_search" && part.state.input?.query === "psm_matching")
        const forbiddenDirectEstimatorPart = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "psm_matching")
        const byMethod = Object.fromEntries(preparedDiagnosticSpecs.map((spec) => [
          spec.methodID,
          methodParts.find((part) => part.state.input?.specId === spec.specId),
        ]))
        const constructionPart = byMethod.psm_construction as MessageV2.ToolPart | undefined
        const visualizationPart = byMethod.psm_visualize as MessageV2.ToolPart | undefined
        const importPart = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" &&
            part.tool === "data_import" && part.state.input?.action === "import" && part.state.status === "completed")
        if (!importPart || importPart.state.status !== "completed") throw new Error("NSW 真实样本未完成导入")
        const datasetId = importPart.state.metadata.datasetId
        const manifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined
        const executedMethodIDs = executeSpy.mock.calls.map(([request]) => request.method_id)
        const constructionPayload = constructionPart?.state.status === "completed"
          ? constructionPart.state.metadata.result as Record<string, unknown>
          : undefined
        const visualizationPayload = visualizationPart?.state.status === "completed"
          ? visualizationPart.state.metadata.result as Record<string, unknown>
          : undefined
        const constructionView = constructionPart?.state.status === "completed"
          ? constructionPart.state.metadata.analysisView as Record<string, unknown>
          : undefined
        const visualizationView = visualizationPart?.state.status === "completed"
          ? visualizationPart.state.metadata.analysisView as Record<string, unknown>
          : undefined
        const artifactsFor = (view: Record<string, unknown> | undefined) =>
          Array.isArray(view?.artifacts)
            ? view.artifacts.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
            : []
        const constructionArtifacts = artifactsFor(constructionView)
        const visualizationArtifacts = artifactsFor(visualizationView)
        const projectFileExists = (value: unknown) =>
          typeof value === "string" && fs.existsSync(path.resolve(root, value))

        expect(requestedTools).toEqual([
          "data_import:import",
          "tool_search:psm_matching-scope-check",
          "econometrics_execute:psm_matching",
          "psm_matching:direct-forbidden",
          "data_import:profile",
          "data_import:validate",
          "tool_search:psm_construction",
          "analysis_prepare:psm_construction",
          "econometrics_execute:psm_construction",
          "tool_search:psm_visualize",
          "analysis_prepare:psm_visualize",
          "econometrics_execute:psm_visualize",
        ])
        expect(modelRequestModes[0]).toEqual({ textOnly: false, completedToolRounds: 0 })
        expect(modelRequestModes).toContainEqual({ textOnly: true, completedToolRounds: 1 })
        expect(importPostHookSignals).toContainEqual({ deferred: true, verifierPending: true })
        expect(modelRequestModes.some((mode, index) =>
          mode.textOnly && modelRequestModes.slice(index + 1).some((next) => !next.textOnly),
        )).toBe(true)
        expect(mainRound).toBe(13)
        expect(forbiddenSearchPart?.state.status).toBe("completed")
        if (forbiddenSearchPart?.state.status === "completed") {
          expect(forbiddenSearchPart.state.metadata.matchCount).toBe(0)
          expect(forbiddenSearchPart.state.metadata.availableCount).toBe(2)
          expect(forbiddenSearchPart.state.output).toContain("psm_construction")
          expect(forbiddenSearchPart.state.output).toContain("psm_visualize")
          expect(forbiddenSearchPart.state.output).not.toMatch(/^-\s+psm_matching：/m)
          expect(forbiddenSearchPart.state.output).not.toMatch(/^-\s+psm_ipw：/m)
        }
        expect(forbiddenEstimatorPart?.state.status).toBe("error")
        if (forbiddenEstimatorPart?.state.status === "error") {
          expect(forbiddenEstimatorPart.state.error).toMatch(/specId|参数不合法/)
        }
        expect(forbiddenDirectEstimatorPart?.state.status).toBe("completed")
        if (forbiddenDirectEstimatorPart?.state.status === "completed") {
          expect(forbiddenDirectEstimatorPart.state.metadata.psmToolScopeBlocked).toBe(true)
          expect(forbiddenDirectEstimatorPart.state.metadata.result).toBeUndefined()
        }
        expect(constructionPart?.state.status).toBe("completed")
        expect(visualizationPart?.state.status).toBe("completed")
        if (constructionPart?.state.status === "completed") {
          expect(constructionPart.state.metadata.verifierPending).not.toBe(true)
          expect(constructionPart.state.output).not.toContain("状态：待核验")
        }
        if (visualizationPart?.state.status === "completed") {
          expect(visualizationPart.state.metadata.verifierPending).not.toBe(true)
          expect(visualizationPart.state.output).not.toContain("状态：待核验")
        }
        expect(constructionPayload?.rowsUsed).toBe(445)
        expect(visualizationPayload?.rowsUsed).toBe(445)
        expect(Number(constructionPayload?.shareInSupport)).toBeCloseTo(0.993258427, 7)
        expect(Number(visualizationPayload?.shareInSupport)).toBeCloseTo(0.993258427, 7)
        expect(projectFileExists(constructionPayload?.propensityScoresPath)).toBe(true)
        expect(projectFileExists(constructionPayload?.resultPath)).toBe(true)
        expect(projectFileExists(visualizationPayload?.plotPath)).toBe(true)
        expect(projectFileExists(visualizationPayload?.resultPath)).toBe(true)
        expect(constructionArtifacts.map((item) => item.label)).toContain("倾向得分明细")
        expect(visualizationArtifacts.map((item) => item.label)).toContain("倾向得分分布图")
        expect(constructionArtifacts.every((item) => projectFileExists(item.path))).toBe(true)
        expect(visualizationArtifacts.every((item) => projectFileExists(item.path))).toBe(true)
        expect(constructionPart?.state.status === "completed" ? constructionPart.state.output : "").toContain("共同支撑覆盖率：99.3%")
        expect(constructionPart?.state.status === "completed" ? constructionPart.state.output : "").not.toContain("psm_construction")
        expect(visualizationPart?.state.status === "completed" ? visualizationPart.state.output : "").toContain("倾向得分分布图已生成")
        expect(visualizationPart?.state.status === "completed" ? visualizationPart.state.output : "").not.toContain("psm_visualize")
        expect(modelInputBeforeConstruction).toContain("analysisUnitVar")
        expect(modelInputBeforeConstruction).toContain("本轮只允许倾向得分构造诊断和分布可视化")
        expect(modelInputBeforeVisualization).toContain("倾向得分构造诊断已完成")
        expect(finalModelInputText).toContain("倾向得分分布图已生成")
        expect(assistantText(messages)).not.toContain("datasetId")
        expect(assistantText(messages)).not.toContain("stageId")
        expect(executedMethodIDs).not.toContain("psm_matching")
        expect(executedMethodIDs.filter((id) => id === "psm_construction")).toHaveLength(1)
        expect(executedMethodIDs.filter((id) => id === "psm_visualize")).toHaveLength(1)
        for (const methodID of ["psm_matching", "psm_ipw", "psm_regression", "psm_double_robust"]) {
          expect(executedMethodIDs).not.toContain(methodID)
        }
        expect(manifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])
      } })
    } finally {
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
