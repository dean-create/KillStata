import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { EconometricsEngineClient, EconometricsEngineError } from "@/runtime/services/econometrics-engine-client"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { readDatasetManifest } from "@/tool/analysis-state"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  await Instance.disposeAll()
})

type ScriptedToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

function completeTextStream(text: string) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "text-start", id: "method-execution-failure" }
    yield { type: "text-delta", id: "method-execution-failure", text }
    yield { type: "text-end", id: "method-execution-failure" }
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function completeToolCall(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return completeToolBatchStream([{ toolName, toolCallId, input }])
}

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

function lineageFromMessages(messages: unknown) {
  const text = JSON.stringify(messages)
  const datasetId = text.match(/datasetId[=:]([A-Za-z0-9_]+)/)?.[1]
  const stageId = text.match(/stageId[=:]([A-Za-z0-9_]+)/)?.[1]
  if (!datasetId || !stageId) throw new Error("脚本模型未从真实工具结果恢复 datasetId/stageId")
  return { datasetId, stageId }
}

type FailureScenarioOptions = {
  questionAnswer: "reject" | "confirm_proposed_covariance" | "negated_proposed_covariance"
  failEveryOlsCall: boolean
}

async function runMethodExecutionFailureScenario(
  retryCovariance: "HC1" | "nonrobust",
  options: FailureScenarioOptions = { questionAnswer: "reject", failEveryOlsCall: true },
) {
  if (!process.env.KILLSTATA_PYTHON) {
    throw new Error("该真实数据失败恢复回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python Registry 执行")
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-method-execution-failure-"))
  const source = path.join(root, "did.xlsx")
  fs.copyFileSync(localRealDataPath("did.xlsx"), source)
  const modelToolCalls: string[] = []
  const engineMethodCalls: string[] = []
  const olsExecutionArguments: Array<Record<string, unknown>> = []
  const olsOutputDirs: string[] = []
  const olsPreflightStatuses: string[] = []
  const questions: string[] = []
  const verifierSessionIDs = new Set<string>()
  const idleVerifierSessionIDs = new Set<string>()
  let verifierModelRequests = 0
  let unsubscribeCreated = () => {}
  let unsubscribeStatus = () => {}
  let sessionID = ""
  let mainRound = 0
  let textOnlyRounds = 0
  let repairContext = ""
  let completionContext = ""
  let schemaReloadedAfterNotSent = false
  let injectedOlsFailures = 0

  try {
    await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      sessionID = session.id
      AnalysisIntent.markAnalystPlanApproval(session.id, true)
      const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
      const activeEstimateTask = () => {
        const ledger = RuntimeTaskLedger.listTasks(session.id)
        return ledger.tasks.find((item) => item.taskId === ledger.activeTaskId && item.analysisRequest?.kind === "estimate")
      }
      unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
        const info = event.properties.info
        if (info.parentID === sessionID && info.title.startsWith("工作流核验 - ")) {
          verifierSessionIDs.add(info.id)
        }
      })
      unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
        if (verifierSessionIDs.has(event.properties.sessionID) && event.properties.status.type === "idle") {
          idleVerifierSessionIDs.add(event.properties.sessionID)
        }
      })

      const execute = EconometricsEngineClient.prototype.execute
      const preflight = EconometricsEngineClient.prototype.preflight
      spies.push(spyOn(EconometricsEngineClient.prototype, "preflight").mockImplementation(async function (
        this: EconometricsEngineClient,
        payload,
        signal,
      ) {
        const result = await preflight.call(this, payload, signal)
        if (payload.method_id === "ols_regression") olsPreflightStatuses.push(result.status)
        return result
      }))
      spies.push(spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(function (
        this: EconometricsEngineClient,
        payload,
        signal,
      ) {
        engineMethodCalls.push(payload.method_id)
        if (payload.method_id === "ols_regression") {
          olsExecutionArguments.push(payload.arguments)
          olsOutputDirs.push(payload.output_dir)
          if (options.failEveryOlsCall || injectedOlsFailures === 0) {
            injectedOlsFailures += 1
            throw new EconometricsEngineError(
              "METHOD_EXECUTION_FAILED",
              "故障注入：估计阶段数值分解失败；本次没有返回结果或系数产物。",
            )
          }
        }
        return execute.call(this, payload, signal)
      }))

      spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
        const registration = await scriptedAnalysisRequestResponse(request)
        if (registration) return registration as never
if (String(request.agent.name).toLowerCase() === "verifier") {
          verifierModelRequests += 1
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
          return { fullStream: completeTextStream("导入后的后台核验仍在进行，本轮只作文字收尾。") } as never
        }

        mainRound += 1
        if (mainRound === 1) {
          modelToolCalls.push("data_import:import")
          return { fullStream: completeToolCall("data_import", "call_method_failure_import", {
            action: "import",
            inputPath: source,
            preserveLabels: true,
            sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
          }) } as never
        }
        const lineage = lineageFromMessages(request.messages)
        if (mainRound === 2) {
          modelToolCalls.push("data_import:profile")
          return { fullStream: completeToolCall("data_import", "call_method_failure_profile", { ...lineage, action: "profile" }) } as never
        }
        if (mainRound === 3) {
          modelToolCalls.push("data_import:validate")
          return { fullStream: completeToolCall("data_import", "call_method_failure_validate", { ...lineage, action: "validate" }) } as never
        }
        if (mainRound === 4) {
          modelToolCalls.push("tool_search:ols_regression")
          return { fullStream: completeToolCall("tool_search", "call_method_failure_search", {
            query: "ols_regression",
            limit: 1,
          }) } as never
        }
        if (mainRound === 5) {
          modelToolCalls.push("analysis_prepare:ols-first")
          const task = activeEstimateTask()
          if (!task?.analysisRequest) throw new Error("OLS 首次准备缺少当前 AnalysisRequest")
          return { fullStream: completeToolCall("analysis_prepare", "call_method_failure_first_prepare", {
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
        if (mainRound === 6) {
          modelToolCalls.push("econometrics_execute:ols-first")
          const prepared = activeEstimateTask()?.preparedSpec
          if (!prepared || prepared.methodID !== "ols_regression") throw new Error("OLS 首次估计没有 PreparedSpec")
          return { fullStream: completeToolCall("econometrics_execute", "call_method_failure_first_ols", { specId: prepared.specId }) } as never
        }
        if (mainRound === 7) {
          repairContext = modelVisibleText(request.messages)
          modelToolCalls.push(`analysis_prepare:ols-retry-${retryCovariance}`)
          const task = activeEstimateTask()
          if (!task?.analysisRequest) throw new Error("OLS 失败恢复缺少当前 AnalysisRequest")
          return { fullStream: completeToolCall("analysis_prepare", "call_method_failure_repeat_prepare", {
            requestId: task.analysisRequest.requestId,
            methodID: "ols_regression",
            arguments: {
              dependentVar: "高质量发展指数",
              treatmentVar: "did",
              covariates: ["人口规模", "人均GDP", "金融发展程度"],
              covariance: retryCovariance,
            },
          }) } as never
        }
        if (mainRound === 8) {
          schemaReloadedAfterNotSent = /完整.*Schema|tool_search|重新搜索/i.test(modelVisibleText(request.messages))
          modelToolCalls.push("tool_search:ols_regression-recovery")
          return { fullStream: completeToolCall("tool_search", "call_method_failure_search_recovery", {
            query: "ols_regression",
            limit: 1,
          }) } as never
        }
        if (mainRound === 9) {
          modelToolCalls.push(`analysis_prepare:ols-retry-${retryCovariance}-after-search`)
          const task = activeEstimateTask()
          if (!task?.analysisRequest) throw new Error("OLS Schema 恢复后缺少 AnalysisRequest")
          return { fullStream: completeToolCall("analysis_prepare", "call_method_failure_repeat_prepare_after_search", {
            requestId: task.analysisRequest.requestId,
            methodID: "ols_regression",
            arguments: {
              dependentVar: "高质量发展指数",
              treatmentVar: "did",
              covariates: ["人口规模", "人均GDP", "金融发展程度"],
              covariance: retryCovariance,
            },
          }) } as never
        }
        if (mainRound === 10) {
          modelToolCalls.push(`econometrics_execute:ols-retry-${retryCovariance}`)
          const prepared = activeEstimateTask()?.preparedSpec
          if (!prepared || prepared.methodID !== "ols_regression") throw new Error("OLS 重试没有当前 PreparedSpec")
          return { fullStream: completeToolCall("econometrics_execute", "call_method_failure_repeat_ols", { specId: prepared.specId }) } as never
        }
        completionContext = modelVisibleText(request.messages)
        return { fullStream: completeTextStream(options.questionAnswer === "confirm_proposed_covariance"
          ? "已按你确认的 nonrobust 协方差口径完成 OLS；请结合本轮结果和诊断解释。"
          : "OLS 执行失败，不能报告系数。请先根据具体错误检查当前规格与数据，再决定是否继续。") } as never
      }))

      const unsubscribeQuestion = Bus.subscribe(Question.Event.Asked, (event) => {
        questions.push(String(event.properties.questions[0]?.question ?? ""))
        const answer = options.questionAnswer === "confirm_proposed_covariance"
          ? `确认改为 ${retryCovariance}`
          : options.questionAnswer === "negated_proposed_covariance"
            ? `不要确认改为 ${retryCovariance}`
            : "保持 HC1 并停止本次估计"
        Question.reply({ requestID: event.properties.id, answers: [[answer]] }).catch(() => {})
      })
      try {
        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{
            type: "text",
            text: `导入 ${source} 的 Data_可读 页；用 OLS 估计高质量发展指数对 did 的关系，控制人口规模、人均GDP、金融发展程度，采用 HC1。只解释样本内统计关系。`,
          }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })
      } finally {
        unsubscribeQuestion()
      }

      if (options.questionAnswer === "confirm_proposed_covariance" || verifierSessionIDs.size > 0) {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline && (verifierSessionIDs.size === 0 || verifierSessionIDs.size !== idleVerifierSessionIDs.size)) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      const messages = await Session.messages({ sessionID: session.id })
      const visible = assistantText(messages)
      const toolParts = messages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.ToolPart => part.type === "tool")
      const importPart = toolParts.find((part) => part.tool === "data_import" && part.state.input?.action === "import")
      const validatePart = toolParts.find((part) => part.tool === "data_import" && part.state.input?.action === "validate")
      const preparedOlsSpecIDs = new Set(activeEstimateTask()?.analysisSpecs
        ?.filter((spec) => spec.methodID === "ols_regression")
        .map((spec) => spec.specId) ?? [])
      const estimates = toolParts.filter((part) => part.tool === "econometrics_execute" &&
        typeof part.state.input?.specId === "string" && preparedOlsSpecIDs.has(part.state.input.specId))
      const approvedCovarianceChange = options.questionAnswer === "confirm_proposed_covariance"
      const failedEstimate = estimates.find((part) => part.state.status === "error")
      const repeatedEstimate = [...estimates].reverse().find((part) => part.state.status === "error" &&
        /已经失败过一次/.test(part.state.error))
      const successfulEstimate = estimates.find((part) => part.state.status === "completed" &&
        (part.state.metadata?.result as { success?: unknown } | undefined)?.success === true)
      const successfulResult = successfulEstimate?.state.status === "completed"
        ? successfulEstimate.state.metadata.result as Record<string, unknown>
        : undefined

      expect(modelToolCalls).toEqual([
        "data_import:import",
        "data_import:profile",
        "data_import:validate",
        "tool_search:ols_regression",
        "analysis_prepare:ols-first",
        "econometrics_execute:ols-first",
        `analysis_prepare:ols-retry-${retryCovariance}`,
        "tool_search:ols_regression-recovery",
        `analysis_prepare:ols-retry-${retryCovariance}-after-search`,
        `econometrics_execute:ols-retry-${retryCovariance}`,
      ])
      expect(textOnlyRounds).toBeGreaterThan(0)
      expect(engineMethodCalls.filter((methodID) => methodID === "data_import").length).toBeGreaterThan(0)
      expect(olsPreflightStatuses).toContain("ready")
      const expectedOlsExecutions = options.questionAnswer === "confirm_proposed_covariance" ? 2 : 1
      expect(engineMethodCalls.filter((methodID) => methodID === "ols_regression")).toHaveLength(expectedOlsExecutions)
      expect(olsExecutionArguments.map((arguments_) => arguments_.covariance)).toEqual(
        options.questionAnswer === "confirm_proposed_covariance" ? ["HC1", "nonrobust"] : ["HC1"],
      )
      expect(olsOutputDirs).toHaveLength(expectedOlsExecutions)
      expect(new Set(olsOutputDirs).size).toBe(expectedOlsExecutions)
      expect(fs.existsSync(olsOutputDirs[0]!)).toBe(false)
      expect(repairContext).toContain("结构化故障代码：METHOD_EXECUTION_FAILED")
      expect(repairContext).toContain("是否可安全原样重试：否")
      expect(repairContext).toContain("可选处理：先检查当前数据阶段和方法前置条件")
      expect(repairContext).toContain("执行前需要用户确认")
      expect(repairContext).not.toContain("估计结果已生成，状态：待核验")
      expect(repairContext).toContain("当前步骤已完成，独立核验待完成；这不表示计量估计已完成。")
      expect(schemaReloadedAfterNotSent).toBe(true)
      expect(failedEstimate?.state.status).toBe("error")
      if (failedEstimate?.state.status === "error") {
        expect(failedEstimate.state.metadata?.failureDiagnosis).toMatchObject({
          failureCode: "METHOD_EXECUTION_FAILED",
          safeToRetry: false,
        })
        expect(failedEstimate.state.metadata?.failureDecision).toMatchObject({
          category: "estimation_failure",
          disposition: "repair",
        })
      }
      if (retryCovariance === "HC1") {
        expect(questions).toEqual([])
        expect(repeatedEstimate?.state.status).toBe("error")
        if (repeatedEstimate?.state.status === "error") {
          expect(repeatedEstimate.state.error).toContain("已经失败过一次")
          expect(repeatedEstimate.state.metadata?.failureDecision).toMatchObject({
            category: "attempt_budget_exhausted",
            disposition: "stop",
          })
        }
      } else {
        const covarianceQuestion = questions.find((question) => /HC1/.test(question) && /nonrobust/i.test(question))
        const covarianceDecision = [...estimates].reverse().find((part) =>
          part.state.status === "completed" && part.state.metadata.requiresUserDecision === true,
        )
        expect(questions).toHaveLength(1)
        expect(covarianceQuestion).toBeDefined()
        if (!approvedCovarianceChange) {
          expect(covarianceDecision?.state.status).toBe("completed")
          if (covarianceDecision?.state.status === "completed") {
            expect(covarianceDecision.state.output).toContain("尚未执行")
            expect(covarianceDecision.state.metadata?.requiresUserDecision).toBe(true)
          }
        } else {
          expect(covarianceDecision).toBeUndefined()
          expect(successfulEstimate?.state.status).toBe("completed")
          expect(successfulResult?.success).toBe(true)
          expect(successfulResult?.covariance).toBe("nonrobust")
          expect(successfulResult?.rowsUsed).toBeGreaterThan(4_000)
          expect(olsExecutionArguments[1]).toMatchObject({
            dependentVar: "高质量发展指数",
            treatmentVar: "did",
            covariates: ["人口规模", "人均GDP", "金融发展程度"],
            covariance: "nonrobust",
          })
          expect(fs.existsSync(olsOutputDirs[1]!)).toBe(true)
          const resultPath = path.resolve(root, String(successfulResult?.resultPath))
          const coefficientsPath = path.resolve(root, String(successfulResult?.coefficientsPath))
          expect(fs.existsSync(resultPath)).toBe(true)
          expect(fs.existsSync(coefficientsPath)).toBe(true)
          const persistedResult = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>
          expect(persistedResult.covariance).toBe("nonrobust")
          const primary = successfulResult?.primary as Record<string, unknown> | undefined
          const persistedPrimary = persistedResult.primary as Record<string, unknown> | undefined
          expect(typeof primary?.estimate).toBe("number")
          expect(Number.isFinite(primary?.estimate)).toBe(true)
          expect(typeof primary?.stdError).toBe("number")
          expect(Number.isFinite(primary?.stdError)).toBe(true)
          expect(persistedPrimary?.estimate).toBe(primary?.estimate)
          expect(persistedPrimary?.stdError).toBe(primary?.stdError)
          expect(completionContext).toContain("nonrobust")
          expect(completionContext).toContain(String(successfulResult?.rowsUsed))
          if (successfulEstimate?.state.status === "completed") {
            expect(successfulEstimate.state.metadata?.verifierPending).toBeUndefined()
            expect(successfulEstimate.state.metadata?.verifierStatus).toBe("warn")
            expect(successfulEstimate.state.output).toContain("独立核验完成，存在诊断提醒")
          }
          expect(visible).toContain("已按你确认的 nonrobust 协方差口径完成 OLS")
          expect(visible).not.toContain("HC1")
          expect(visible).not.toContain("datasetId")
          expect(visible).not.toContain("stageId")
          expect(verifierModelRequests).toBeGreaterThan(0)
          expect(verifierSessionIDs.size).toBeGreaterThan(0)
          expect(verifierSessionIDs.size).toBe(idleVerifierSessionIDs.size)
        }
      }
      const datasetId = importPart?.state.status === "completed" ? importPart.state.metadata.datasetId : undefined
      const manifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined
      expect(manifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])
      const olsArtifacts = manifest?.artifacts.filter((artifact) =>
        /ols_regression/i.test(`${artifact.action} ${artifact.branch} ${artifact.outputPath}`),
      ) ?? []
      const olsFinalOutputs = manifest?.finalOutputs.filter((output) =>
        /ols_regression/i.test(`${output.key} ${output.branch} ${output.path}`),
      ) ?? []
      if (approvedCovarianceChange) {
        expect(olsArtifacts.map((artifact) => path.basename(artifact.outputPath)).sort()).toEqual([
          "coefficients.csv",
          "results.json",
        ])
      } else {
        expect(olsArtifacts).toEqual([])
        expect(olsFinalOutputs).toEqual([])
      }
      expect(validatePart?.state.status).toBe("completed")
      if (validatePart?.state.status === "completed") {
        expect(validatePart.state.output).not.toContain("当前步骤已完成，独立核验待完成")
        expect(validatePart.state.output).not.toContain("估计结果已生成，状态：待核验")
      }
      if (!approvedCovarianceChange) {
        expect(visible).not.toContain("OLS 已完成")
        expect(visible).not.toMatch(/系数.{0,20}(?:显著|p\s*[=<])/i)
      }
      if (retryCovariance === "HC1") {
        expect(visible).toContain("同一数据阶段、计量方法和参数已经失败过一次")
        expect(visible).toContain("未将未完成的分析写成成功结果")
      } else if (!approvedCovarianceChange) {
        expect(visible).toContain("本轮已暂停")
      }
  } })
  } finally {
    unsubscribeCreated()
    unsubscribeStatus()
    await Instance.disposeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test.skipIf(!hasLocalRealData("did.xlsx"))("真实 did.xlsx：运行失败后阻止同签名 OLS 再试", async () => {
  await runMethodExecutionFailureScenario("HC1")
}, 120_000)

test.skipIf(!hasLocalRealData("did.xlsx"))("真实 did.xlsx：运行失败后模型改协方差必须先询问用户", async () => {
  await runMethodExecutionFailureScenario("nonrobust")
}, 120_000)

test.skipIf(!hasLocalRealData("did.xlsx"))("真实 did.xlsx：用户确认协方差变化后，同会话仅按新口径重估", async () => {
  await runMethodExecutionFailureScenario("nonrobust", {
    questionAnswer: "confirm_proposed_covariance",
    failEveryOlsCall: false,
  })
}, 120_000)

test.skipIf(!hasLocalRealData("did.xlsx"))("真实 did.xlsx：否定句提及新协方差不能视作确认", async () => {
  await runMethodExecutionFailureScenario("nonrobust", {
    questionAnswer: "negated_proposed_covariance",
    failEveryOlsCall: false,
  })
}, 120_000)
