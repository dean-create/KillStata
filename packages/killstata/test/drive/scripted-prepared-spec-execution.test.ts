import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  await Instance.disposeAll()
})

type ScriptedToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

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

function completeTools(calls: ScriptedToolCall[]) {
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

test.skipIf(!hasLocalRealData("did.xlsx"))("real did.xlsx OLS executes only by PreparedSpec specId and current user method authorization", async () => {
  if (!process.env.KILLSTATA_PYTHON) throw new Error("该回放必须使用受管 Python Registry；禁止静默跳过")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-prepared-spec-execution-"))
  const source = path.join(root, "did.xlsx")
  fs.copyFileSync(localRealDataPath("did.xlsx"), source)
  const modelToolsByRound: string[][] = []
  const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute")
  spies.push(executeSpy)

  try {
    await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      AnalysisIntent.markAnalystPlanApproval(session.id, true)
      const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
      let modelRound = 0
      let completedEstimatorCount = 0

      spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
        if (String(request.agent.name).toLowerCase() === "verifier") {
          return { fullStream: completeText([
            "<verifier_result>",
            JSON.stringify({
              status: "warn",
              checks: [{ key: "scripted_verifier", label: "脚本核验边界", status: "warn", message: "仅验证 Harness 交接，不代表独立复核了研究设计。" }],
              blockingFindings: [],
              repairHints: [],
              trustedArtifacts: [],
              summary: "脚本核验回包完成。",
              findings: [],
            }),
            "</verifier_result>",
          ].join("\n")) } as never
        }
        if (request.small) return { fullStream: completeText("会话标题") } as never
        if (request.textOnly === true) return { fullStream: completeText("导入后的独立核验仍在进行，本轮只等待核验，不发起工具调用。") } as never

        modelRound += 1
        modelToolsByRound.push(Object.keys(request.tools?.definitions ?? {}).sort())
        if (modelRound === 1) {
          return { fullStream: completeTools([{
            toolName: "analysis_request",
            toolCallId: "call_register_estimate",
            input: {
              kind: "estimate",
              researchGoal: "OLS 回归：高质量发展指数对 did，控制人口规模、人均GDP和金融发展程度",
              constraints: ["HC1", "仅作统计关联，不作因果解释"],
            },
          }]) } as never
        }
        if (modelRound === 2) {
          return { fullStream: completeTools([{
            toolName: "data_import",
            toolCallId: "call_import_for_prepared_ols",
            input: {
              action: "import",
              inputPath: source,
              preserveLabels: true,
              sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
            },
          }]) } as never
        }
        const ledger = RuntimeTaskLedger.listTasks(session.id)
        const task = ledger.tasks.find((item) => item.analysisRequest?.kind === "estimate")
        if (!task?.analysisRequest) throw new Error("没有当前 estimate AnalysisRequest")
        if (modelRound === 3) {
          return { fullStream: completeTools([{
            toolName: "tool_search",
            toolCallId: "call_search_prepared_ols",
            input: { query: "ols_regression", limit: 1 },
          }]) } as never
        }
        if (modelRound === 4) {
          const currentRequestId = request.system.join("\n")
            .match(/当前 AnalysisRequest requestId=([^；\s]+)/)?.[1]
          if (!currentRequestId) throw new Error("当前模型上下文没有注入 AnalysisRequest requestId")
          expect(currentRequestId).toBe(task.analysisRequest.requestId)
          return { fullStream: completeTools([{
            toolName: "analysis_prepare",
            toolCallId: "call_prepare_executable_ols",
            input: {
              requestId: currentRequestId,
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
        if (modelRound === 5) {
          const preparedSpec = task.preparedSpec
          if (!preparedSpec) throw new Error("analysis_prepare 未产生 PreparedSpec")
          expect(preparedSpec.methodID).toBe("ols_regression")
          expect(Array.isArray(task.metadata?.requiredToolIDs) && task.metadata.requiredToolIDs).toContain("ols_regression")
          return { fullStream: completeTools([{
            toolName: "econometrics_execute",
            toolCallId: "call_execute_prepared_ols",
            input: { specId: preparedSpec.specId },
          }]) } as never
        }
        return { fullStream: completeText("OLS 已执行；请结合实际结果和诊断说明其研究边界。") } as never
      }))

      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: `请导入 ${source} 的 Data_可读 工作表并执行 OLS 回归：因变量=高质量发展指数，核心解释变量=did，控制人口规模、人均GDP、金融发展程度，协方差 HC1；只作统计关联，不作因果解释。` }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })

      const messages = await Session.messages({ sessionID: session.id })
      const parts = messages.flatMap((message) => message.parts)
      const methodCalls = executeSpy.mock.calls
        .map(([payload]) => payload as Record<string, unknown>)
        .filter((payload) => payload.method_id === "ols_regression")
      if (methodCalls.length !== 1) {
        const toolStates = parts.filter((part): part is MessageV2.ToolPart => part.type === "tool").map((part) => ({
          tool: part.tool,
          status: part.state.status,
          error: part.state.status === "error" ? part.state.error : undefined,
          output: part.state.status === "completed" ? part.state.output : undefined,
        }))
        throw new Error(`PreparedSpec execution produced ${methodCalls.length} OLS engine calls; modelRound=${modelRound}; states=${JSON.stringify(toolStates)}`)
      }
      expect(methodCalls).toHaveLength(1)
      const estimate = parts.find((part): part is MessageV2.ToolPart =>
        part.type === "tool" && part.tool === "econometrics_execute" && part.state.status === "completed",
      )
      if (!estimate) {
        const toolStates = parts.filter((part): part is MessageV2.ToolPart => part.type === "tool").map((part) => ({
          tool: part.tool,
          status: part.state.status,
          error: part.state.status === "error" ? part.state.error : undefined,
          output: part.state.status === "completed" ? String(part.state.output).slice(0, 300) : undefined,
        }))
        throw new Error(`OLS 未完成；modelRound=${modelRound}; toolStates=${JSON.stringify(toolStates)}`)
      }
      expect(estimate).toBeDefined()
      if (!estimate || estimate.state.status !== "completed") throw new Error("OLS estimator 没有成功返回结构化结果")
      expect((estimate.state.input as Record<string, unknown>)?.specId).toMatch(/^spec_/)
      expect((estimate.state.metadata.result as Record<string, unknown>)?.success).toBe(true)
      expect((estimate.state.metadata.result as Record<string, unknown>)?.rowsUsed).toBeGreaterThan(4000)
      expect(estimate.state.metadata.analysisView?.results?.length ?? 0).toBeGreaterThan(0)
      const userVisible = parts
        .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join("\n")
      expect(userVisible).not.toContain("datasetId")
      expect(userVisible).not.toContain("stageId")
      expect(modelToolsByRound[0]).toEqual(["analysis_request"])
    } })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

test("an estimate request with a ready PreparedSpec cannot end on assistant prose without an estimate or stop", async () => {
  if (!process.env.KILLSTATA_PYTHON) throw new Error("该回放必须使用受管 Python Registry；禁止静默跳过")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-estimate-outcome-gate-"))
  const source = path.join(root, "linear.csv")
  fs.writeFileSync(source, "y,x\n5,0\n7,1\n9,2\n11,3\n13,4\n", "utf-8")
  const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute")
  spies.push(executeSpy)
  const modelTrace: string[] = []
  let modelRound = 0
  let preparedSpecTextOnlyPrematureAnswer = false

  try {
    await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      AnalysisIntent.markAnalystPlanApproval(session.id, true)
      const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)

      spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
        if (String(request.agent.name).toLowerCase() === "verifier") {
          return { fullStream: completeText([
            "<verifier_result>",
            JSON.stringify({
              status: "warn",
              checks: [{ key: "scripted_verifier", label: "脚本核验", status: "warn", message: "仅用于回放。" }],
              blockingFindings: [], repairHints: [], trustedArtifacts: [], summary: "脚本核验完成。", findings: [],
            }),
            "</verifier_result>",
          ].join("\n")) } as never
        }
        if (request.small) return { fullStream: completeText("会话标题") } as never

        const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.analysisRequest?.kind === "estimate")
        modelTrace.push(JSON.stringify({ textOnly: request.textOnly === true, prepared: Boolean(task?.preparedSpec), definitions: Object.keys(request.tools?.definitions ?? {}).length }))
        if (request.textOnly === true) {
          const text = task?.preparedSpec && !preparedSpecTextOnlyPrematureAnswer
            ? "基准估计已完成，结果显著。"
            : "当前仍在完成用户要求的分析，未声称产生新结果。"
          if (task?.preparedSpec) preparedSpecTextOnlyPrematureAnswer = true
          return { fullStream: completeText(text) } as never
        }

        modelRound += 1
        if (modelRound === 1) {
          return { fullStream: completeTools([{
            toolName: "analysis_request",
            toolCallId: "call_register_generic_estimate",
            input: {
              kind: "estimate",
              researchGoal: "估计结果变量 y 与解释变量 x 的基准关系，并使用当前数据可支持的规格",
              constraints: ["若具体方法选择需要研究者决定，先询问，不作因果解释"],
            },
          }]) } as never
        }
        if (modelRound === 2) {
          return { fullStream: completeTools([{
            toolName: "data_import",
            toolCallId: "call_import_generic_estimate_csv",
            input: { action: "import", inputPath: source, preserveLabels: true },
          }]) } as never
        }
        if (modelRound === 3) {
          return { fullStream: completeTools([{
            toolName: "tool_search",
            toolCallId: "call_search_candidate_ols",
            input: { query: "ols_regression", limit: 1 },
          }]) } as never
        }
        if (modelRound === 4) {
          if (!task?.analysisRequest) throw new Error("缺少已登记的 estimate AnalysisRequest")
          const requestId = request.system.join("\n").match(/当前 AnalysisRequest requestId=([^；\s]+)/)?.[1]
          if (!requestId) throw new Error("本轮模型上下文没有 requestId")
          return { fullStream: completeTools([{
            toolName: "analysis_prepare",
            toolCallId: "call_prepare_candidate_ols",
            input: {
              requestId,
              methodID: "ols_regression",
              arguments: { dependentVar: "y", treatmentVar: "x", covariates: [], covariance: "HC1" },
            },
          }]) } as never
        }
        if (modelRound === 5 || modelRound === 6) {
          const preparedSpec = task?.preparedSpec
          if (!preparedSpec) throw new Error("文字收尾前应已存在 ready PreparedSpec")
          expect(Array.isArray(task.metadata?.requiredToolIDs) ? task.metadata.requiredToolIDs : []).not.toContain("ols_regression")
          if (modelRound === 5) {
            preparedSpecTextOnlyPrematureAnswer = true
            return { fullStream: completeText("基准估计已完成，结果显著。") } as never
          }
          expect(Object.keys(request.tools?.definitions ?? {})).toContain("econometrics_execute")
          return { fullStream: completeTools([{
            toolName: "econometrics_execute",
            toolCallId: "call_execute_unconfirmed_method",
            input: { specId: preparedSpec.specId },
          }]) } as never
        }
        return { fullStream: completeText("本轮等待用户确认具体计量方法。") } as never
      }))

      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{
          type: "text",
          text: `请导入 ${source} 并做基准计量估计，结果变量为 y、解释变量为 x。请根据数据提出可用方法；若选择方法需要我确认，先询问后再估计。`,
        }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })

      const ledger = RuntimeTaskLedger.listTasks(session.id)
      const task = ledger.tasks.find((item) => item.analysisRequest?.kind === "estimate")
      const messages = await Session.messages({ sessionID: session.id })
      const parts = messages.flatMap((message) => message.parts)
      const executionDecision = parts.find((part): part is MessageV2.ToolPart =>
        part.type === "tool" &&
        part.tool === "econometrics_execute" &&
        part.state.status === "completed" &&
        part.state.metadata.requiresUserDecision === true,
      )

      if (!preparedSpecTextOnlyPrematureAnswer) {
        const toolStates = parts.filter((part): part is MessageV2.ToolPart => part.type === "tool").map((part) => ({
          tool: part.tool,
          status: part.state.status,
          output: part.state.status === "completed" ? String(part.state.output).slice(0, 180) : undefined,
          error: part.state.status === "error" ? String(part.state.error).slice(0, 180) : undefined,
        }))
        throw new Error(`模型未在 ready PreparedSpec 后返回文字；rounds=${modelRound}; trace=${modelTrace.join("|")}; lifecycle=${task?.analysisLifecycle?.status}; tools=${JSON.stringify(toolStates)}`)
      }
      expect(modelRound).toBeGreaterThan(5)
      expect(executeSpy.mock.calls.filter(([payload]) =>
        Boolean(payload && typeof payload === "object" && (payload as Record<string, unknown>).method_id === "ols_regression"),
      )).toHaveLength(0)
      expect(task?.analysisLifecycle?.status).toBe("waiting_user")
      expect(executionDecision).toBeDefined()
      const prematureSuccessPart = parts.find((part): part is MessageV2.TextPart =>
        part.type === "text" && part.text.includes("基准估计已完成"),
      )
      expect(prematureSuccessPart?.ignored).toBe(true)
      const visibleText = parts
        .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text)
        .join("\n")
      expect(visibleText).toContain("本轮已暂停")
      expect(visibleText).not.toContain("基准估计已完成")
      expect(visibleText).not.toContain("估计结果已生成")
    } })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

test("partial multi-method estimates remain pending and cannot be reported as a complete comparison", async () => {
  if (!process.env.KILLSTATA_PYTHON) throw new Error("该回放必须使用受管 Python Registry；禁止静默跳过")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-partial-multi-estimate-"))
  const source = path.join(root, "panel.csv")
  const rows = ["y,x,entity,time"]
  for (let entity = 1; entity <= 24; entity++) {
    for (let time = 1; time <= 4; time++) {
      const x = (entity % 7) + time + ((entity * time) % 3)
      const y = 1 + 2 * x + entity * 0.3 + time * 0.5
      rows.push(`${y},${x},${entity},${time}`)
    }
  }
  fs.writeFileSync(source, `${rows.join("\n")}\n`, "utf-8")
  const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute")
  spies.push(executeSpy)
  const modelTrace: string[] = []

  try {
    await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      AnalysisIntent.markAnalystPlanApproval(session.id, true)
      const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
      let modelRound = 0
      let followupRound = 0
      let followupMode = false

      spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
        modelTrace.push(`callback; agent=${String(request.agent.name)}; small=${request.small === true}; textOnly=${request.textOnly === true}; defs=${Object.keys(request.tools?.definitions ?? {}).join(",")}`)
        if (String(request.agent.name).toLowerCase() === "verifier") {
          return { fullStream: completeText("估计结果契约核验完成。") } as never
        }
        if (request.small) return { fullStream: completeText("会话标题") } as never
        const visibleToolIDs = Object.keys(request.tools?.definitions ?? {})
        if (visibleToolIDs.length === 1 && visibleToolIDs[0] === "analysis_request") {
          return { fullStream: completeTools([{
            toolName: "analysis_request",
            toolCallId: followupMode ? "call_register_pending_panel_resume" : "call_register_partial_multi_estimate",
            input: {
              kind: "estimate",
              researchGoal: "分别执行 OLS 回归和面板固定效应回归",
              constraints: ["所有明确请求的方法均完成后，才能报告整组分析完成"],
            },
          }]) } as never
        }
        if (request.textOnly === true) {
          modelTrace.push(`${followupMode ? "followup-" : ""}textOnly`)
          return { fullStream: completeText(followupMode
            ? "面板固定效应回归已完成。"
            : "OLS 与面板固定效应回归均已完成，结果一致。") } as never
        }

        if (followupMode) {
          followupRound += 1
          modelTrace.push(`followup=${followupRound}; tools=${Object.keys(request.tools?.definitions ?? {}).join(",")}`)
          if (followupRound === 1) {
            return { fullStream: completeTools([{
              toolName: "tool_search",
              toolCallId: "call_search_pending_panel_fe",
              input: { query: "panel_fe_regression", limit: 1 },
            }]) } as never
          }
          if (followupRound === 2) {
            const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) =>
              item.taskId === RuntimeTaskLedger.listTasks(session.id).activeTaskId && item.analysisRequest?.kind === "estimate",
            )
            if (!task?.analysisRequest) throw new Error("继续轮没有基于当前用户消息创建新的 estimate 请求")
            return { fullStream: completeTools([{
              toolName: "analysis_prepare",
              toolCallId: "call_prepare_pending_panel_fe",
              input: {
                requestId: task.analysisRequest.requestId,
                methodID: "panel_fe_regression",
                arguments: {
                  dependentVar: "y",
                  treatmentVar: "x",
                  covariates: [],
                  entityVar: "entity",
                  timeVar: "time",
                  covariance: "clustered",
                },
              },
            }]) } as never
          }
          if (followupRound === 3) {
            const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) =>
              item.taskId === RuntimeTaskLedger.listTasks(session.id).activeTaskId && item.preparedSpec?.methodID === "panel_fe_regression",
            )
            if (!task?.preparedSpec) throw new Error("继续轮的 Panel FE PreparedSpec 未就绪")
            return { fullStream: completeTools([{
              toolName: "econometrics_execute",
              toolCallId: "call_execute_pending_panel_fe",
              input: { specId: task.preparedSpec.specId },
            }]) } as never
          }
          return { fullStream: completeText("继续轮所请求的面板固定效应回归已完成。") } as never
        }

        modelRound += 1
        modelTrace.push(`round=${modelRound}; tools=${Object.keys(request.tools?.definitions ?? {}).join(",")}`)
        if (modelRound === 1) {
          return { fullStream: completeTools([{
            toolName: "data_import",
            toolCallId: "call_import_partial_multi_estimate",
            input: { action: "import", inputPath: source, preserveLabels: true },
          }]) } as never
        }
        if (modelRound === 2) {
          return { fullStream: completeTools([{
            toolName: "tool_search",
            toolCallId: "call_search_partial_ols",
            input: { query: "ols_regression", limit: 1 },
          }]) } as never
        }
        if (modelRound === 3) {
          const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.analysisRequest?.kind === "estimate")
          if (!task?.analysisRequest) throw new Error("缺少双方法 estimate AnalysisRequest")
          return { fullStream: completeTools([{
            toolName: "analysis_prepare",
            toolCallId: "call_prepare_partial_ols",
            input: {
              requestId: task.analysisRequest.requestId,
              methodID: "ols_regression",
              arguments: { dependentVar: "y", treatmentVar: "x", covariates: [], covariance: "HC1" },
            },
          }]) } as never
        }
        if (modelRound === 4) {
          const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.analysisRequest?.kind === "estimate")
          if (!task?.preparedSpec) throw new Error("OLS PreparedSpec 未就绪")
          return { fullStream: completeTools([{
            toolName: "econometrics_execute",
            toolCallId: "call_execute_partial_ols",
            input: { specId: task.preparedSpec.specId },
          }]) } as never
        }
        return { fullStream: completeText("OLS 与面板固定效应回归均已完成，两个模型结果一致。") } as never
      }))

      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{
          type: "text",
          text: `请导入 ${source}，分别估计 OLS 回归和双向固定效应面板回归：因变量 y，核心解释变量 x，面板实体 entity，时间 time。`,
        }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })

      const ledger = RuntimeTaskLedger.listTasks(session.id)
      const task = ledger.tasks.find((item) => item.analysisRequest?.kind === "estimate")
      const messages = await Session.messages({ sessionID: session.id })
      const parts = messages.flatMap((message) => message.parts)
      const methodExecutions = executeSpy.mock.calls
        .map(([payload]) => payload as Record<string, unknown>)
        .filter((payload) => ["ols_regression", "panel_fe_regression"].includes(String(payload.method_id)))
      if (methodExecutions.map((payload) => payload.method_id).join(",") !== "ols_regression") {
        const toolStates = parts.filter((part): part is MessageV2.ToolPart => part.type === "tool").map((part) => ({
          tool: part.tool,
          status: part.state.status,
          error: part.state.status === "error" ? String(part.state.error) : undefined,
          result: part.state.status === "completed" ? String(part.state.output).slice(0, 240) : undefined,
        }))
        const assistantStates = messages
          .filter((message) => message.info.role === "assistant")
          .map((message) => ({ info: message.info, parts: message.parts.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "") }))
        throw new Error(`预期只执行一次 OLS；实际=${JSON.stringify(methodExecutions)}；rounds=${modelRound}; trace=${modelTrace.join(" | ")}; tools=${JSON.stringify(toolStates)}; assistants=${JSON.stringify(assistantStates)}`)
      }
      expect(methodExecutions.map((payload) => payload.method_id)).toEqual(["ols_regression"])
      expect(task?.analysisLifecycle?.status).toBe("waiting_user")
      expect(task?.analysisLifecycle?.issueCode).toBe("ESTIMATE_REQUEST_INCOMPLETE")
      expect(task?.analysisLifecycle?.specRuns).toContainEqual(expect.objectContaining({
        methodID: "ols_regression",
        status: "completed",
        resultContractStatus: "pass",
      }))
      expect(task?.analysisLifecycle?.specRuns.some((run) =>
        run.methodID === "panel_fe_regression" && run.status === "completed",
      )).toBe(false)
      const prematureClaim = parts.find((part): part is MessageV2.TextPart =>
        part.type === "text" && part.text.includes("OLS 与面板固定效应回归均已完成，两个模型结果一致。"),
      )
      expect(prematureClaim?.ignored).toBe(true)
      const visibleText = parts
        .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text)
        .join("\n")
      expect(visibleText).toContain("已完成OLS 回归；尚未实际执行面板固定效应回归")
      expect(visibleText).not.toContain("两个模型结果一致")

      followupMode = true
      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "继续" }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })

      const resumedLedger = RuntimeTaskLedger.listTasks(session.id)
      const resumedTask = resumedLedger.tasks.find((item) => item.taskId === resumedLedger.activeTaskId)
      expect(resumedTask?.analysisRequest?.kind).toBe("estimate")
      expect(resumedTask?.metadata?.requiredToolIDs).toContain("panel_fe_regression")
      expect(followupRound).toBe(3)
      const allMethodExecutions = executeSpy.mock.calls
        .map(([payload]) => payload as Record<string, unknown>)
        .filter((payload) => ["ols_regression", "panel_fe_regression"].includes(String(payload.method_id)))
      expect(allMethodExecutions.map((payload) => payload.method_id)).toEqual(["ols_regression", "panel_fe_regression"])
      expect(resumedTask?.analysisLifecycle?.specRuns).toContainEqual(expect.objectContaining({
        methodID: "panel_fe_regression",
        status: "completed",
        resultContractStatus: "pass",
      }))
    } })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
