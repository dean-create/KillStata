import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { Provider } from "@/provider/provider"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { Bus } from "@/bus"
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

function localVerifierStream() {
  return completeTextStream([
    "<verifier_result>",
    JSON.stringify({
      status: "pass",
      checks: [{ key: "real-did-iv", label: "did.xlsx 工具变量结果与诊断产物", status: "pass", message: "仅核对当前阶段产物与规格一致；不把样本诊断视为排除限制证明。" }],
      blockingFindings: [],
      repairHints: [],
      trustedArtifacts: [],
      summary: "本地脚本化 IV 阶段核验完成。",
      findings: [],
    }),
    "</verifier_result>",
  ].join("\n"))
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
  if (!datasetId || !stageId) throw new Error("本地脚本化模型未从真实导入结果恢复数据阶段")
  return { datasetId, stageId }
}

function completedResult(part: MessageV2.ToolPart) {
  if (part.state.status !== "completed") throw new Error("计量工具没有成功完成")
  const metadata = part.state.metadata as Record<string, unknown>
  const result = metadata.result
  if (!result || typeof result !== "object") {
    throw new Error(`工具结果缺少 Python Registry payload：tool=${part.tool} input=${JSON.stringify(part.state.input)} metadataKeys=${Object.keys(metadata).join(",")} output=${JSON.stringify(part.state.output).slice(0, 1200)}`)
  }
  return result as Record<string, unknown>
}

describe("真实 did.xlsx 的稳定 IV 工具旅程", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("错误参数可恢复，2SLS 与 IV 诊断通过稳定工具链返回完整数值和边界", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据工具回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python Registry 执行")
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-stable-iv-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)

    const requestedTools: string[] = []
    let mainRound = 0
    let providerVisibleToolIDs: string[] = []
    let ivSchemaVisible = false
    let ivSchemaNotSentReachedReSearch = false
    let ivEstimatorSearchOutput = ""
    let ivDiagnosticGuidanceVisible = false
    let invalidParameterReachedRepairTurn = false
    let estimateToolOutput = ""
    let ivRepeatedSearchOutput = ""
    let diagnosticToolOutput = ""
    const verifierSessionIDs = new Set<string>()
    let resolveVerifier!: () => void
    const verifierCompleted = new Promise<void>((resolve) => { resolveVerifier = resolve })

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
          const info = event.properties.info
          if (info.parentID === session.id && info.title.startsWith("工作流核验 - ")) verifierSessionIDs.add(info.id)
        })
        const unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (verifierSessionIDs.has(event.properties.sessionID) && event.properties.status.type === "idle") resolveVerifier()
        })
        let verifierTimeout: ReturnType<typeof setTimeout> | undefined

        const ivArguments = {
          dependentVar: "创新指数",
          treatmentVar: "did",
          covariates: [],
          instrumentJustification: "研究者暂定财政分权度会影响 did，并仅通过 did 影响创新指数；该排除限制与外生性尚未独立验证。",
        }

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
if (request.agent.name === "verifier") return { fullStream: localVerifierStream() } as never
          if (request.small) return { fullStream: completeTextStream("本地后台摘要") } as never
          if (request.textOnly === true) return { fullStream: completeTextStream("当前回合只返回文字，不调用工具。") } as never

          mainRound += 1
          const messagesText = modelVisibleText(request.messages)
          const lineage = mainRound > 1 ? lineageFromMessages(request.messages) : undefined

          if (mainRound === 1) {
            requestedTools.push("data_import:import")
            return { fullStream: completeToolStream("data_import", "call_iv_import", {
              action: "import",
              inputPath: source,
              preserveLabels: true,
              sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
            }) } as never
          }
          if (mainRound === 2) {
            requestedTools.push("data_import:profile")
            return { fullStream: completeToolStream("data_import", "call_iv_profile", { action: "profile", ...lineage }) } as never
          }
          if (mainRound === 3) {
            requestedTools.push("data_import:validate")
            return { fullStream: completeToolStream("data_import", "call_iv_validate", { action: "validate", ...lineage }) } as never
          }
          if (mainRound === 4) {
            requestedTools.push("tool_search:iv_2sls")
            providerVisibleToolIDs = Object.keys(request.tools?.definitions ?? {})
            return { fullStream: completeToolStream("tool_search", "call_iv_2sls_search", { query: "iv_2sls", limit: 1 }) } as never
          }
          if (mainRound === 5) {
            requestedTools.push("analysis_prepare:empty-instrumentVars")
            ivEstimatorSearchOutput = namedToolResultText(request.messages, "tool_search")
            ivSchemaVisible = messagesText.includes("参数 Schema：") &&
              messagesText.includes("instrumentVars") && messagesText.includes("instrumentJustification")
            const task = RuntimeTaskLedger.listTasks(request.sessionID).tasks.find((item) => item.analysisRequest?.kind === "estimate")
            if (!task?.analysisRequest) throw new Error("IV 规格准备缺少 AnalysisRequest")
            return { fullStream: completeToolStream("analysis_prepare", "call_iv_empty_instruments", {
              requestId: task.analysisRequest.requestId,
              methodID: "iv_2sls",
              arguments: { ...ivArguments, instrumentVars: [] },
            }) } as never
          }
          if (mainRound === 6) {
            requestedTools.push("analysis_prepare:corrected-instrumentVars")
            const failure = namedToolResultText(request.messages, "analysis_prepare")
            invalidParameterReachedRepairTurn = /instrumentVars|工具变量/.test(namedToolResultText(request.messages, "analysis_prepare"))
            const task = RuntimeTaskLedger.listTasks(request.sessionID).tasks.find((item) => item.analysisRequest?.kind === "estimate")
            if (!task?.analysisRequest) throw new Error("IV 参数修正缺少 AnalysisRequest")
            return { fullStream: completeToolStream("analysis_prepare", "call_iv_2sls_prepare", {
              requestId: task.analysisRequest.requestId,
              methodID: "iv_2sls",
              arguments: { ...ivArguments, instrumentVars: ["财政分权度"], covariance: "robust" },
            }) } as never
          }
          if (mainRound === 7) {
            ivSchemaNotSentReachedReSearch = /完整.*Schema|tool_search|重新搜索/i.test(
              namedToolResultText(request.messages, "analysis_prepare"),
            )
            requestedTools.push("tool_search:iv_2sls:recovery")
            return { fullStream: completeToolStream("tool_search", "call_iv_2sls_recovery_search", { query: "iv_2sls", limit: 1 }) } as never
          }
          if (mainRound === 8) {
            requestedTools.push("analysis_prepare:corrected-instrumentVars-after-search")
            const task = RuntimeTaskLedger.listTasks(request.sessionID).tasks.find((item) => item.analysisRequest?.kind === "estimate")
            if (!task?.analysisRequest) throw new Error("IV Schema 恢复后缺少 AnalysisRequest")
            ivSchemaVisible = modelVisibleText(request.messages).includes("参数 Schema：") &&
              modelVisibleText(request.messages).includes("instrumentVars") &&
              modelVisibleText(request.messages).includes("instrumentJustification")
            return { fullStream: completeToolStream("analysis_prepare", "call_iv_2sls_prepare_after_search", {
              requestId: task.analysisRequest.requestId,
              methodID: "iv_2sls",
              arguments: { ...ivArguments, instrumentVars: ["财政分权度"], covariance: "robust" },
            }) } as never
          }
          if (mainRound === 9) {
            requestedTools.push("econometrics_execute:iv_2sls")
            const task = RuntimeTaskLedger.listTasks(request.sessionID).tasks.find((item) => item.analysisRequest?.kind === "estimate")
            const prepared = task?.preparedSpec
            if (!prepared || prepared.methodID !== "iv_2sls") throw new Error("修正参数后没有生成 2SLS PreparedSpec")
            return { fullStream: completeToolStream("econometrics_execute", "call_iv_2sls_estimate", { specId: prepared.specId }) } as never
          }
          if (mainRound === 10) {
            requestedTools.push("tool_search:iv_test")
            estimateToolOutput = namedToolResultText(request.messages, "econometrics_execute")
            return { fullStream: completeToolStream("tool_search", "call_iv_test_search", { query: "iv_test", limit: 1 }) } as never
          }
          if (mainRound === 11) {
            requestedTools.push("tool_search:iv_test:repeat")
            return { fullStream: completeToolStream("tool_search", "call_iv_test_search_again", { query: "iv_test", limit: 1 }) } as never
          }
          if (mainRound === 12) {
            requestedTools.push("analysis_prepare:iv_test")
            ivRepeatedSearchOutput = latestNamedToolResultText(request.messages, "tool_search")
            ivDiagnosticGuidanceVisible = ivRepeatedSearchOutput.includes("Wald χ²") &&
              ivRepeatedSearchOutput.includes("F<10") && ivRepeatedSearchOutput.includes("排除限制")
            const task = RuntimeTaskLedger.listTasks(request.sessionID).tasks.find((item) => item.analysisRequest?.kind === "estimate")
            if (!task?.analysisRequest) throw new Error("IV 诊断规格准备缺少 AnalysisRequest")
            return { fullStream: completeToolStream("analysis_prepare", "call_iv_test_prepare", {
              requestId: task.analysisRequest.requestId,
              methodID: "iv_test",
              arguments: {
                dependentVar: ivArguments.dependentVar,
                treatmentVar: ivArguments.treatmentVar,
                covariates: [],
                instrumentVars: ["财政分权度"],
                covariance: "robust",
              },
            }) } as never
          }
          if (mainRound === 13) {
            requestedTools.push("econometrics_execute:iv_test")
            const task = RuntimeTaskLedger.listTasks(request.sessionID).tasks.find((item) => item.analysisRequest?.kind === "estimate")
            const prepared = task?.preparedSpec
            if (!prepared || prepared.methodID !== "iv_test") throw new Error("IV 诊断准备后没有生成 iv_test PreparedSpec")
            return { fullStream: completeToolStream("econometrics_execute", "call_iv_test_diagnostics", { specId: prepared.specId }) } as never
          }
          if (mainRound >= 14) {
            diagnosticToolOutput = namedToolResultText(request.messages, "econometrics_execute")
            return { fullStream: completeTextStream("稳健第一阶段 Wald χ²=1.432（p≈0.23），相关性证据有限；F<10 经验阈值不适用于该 χ²。本次恰好识别，无法进行过度识别检验验证排除限制。用户提供的识别假设仍未被数据证明。") } as never
          }
          throw new Error("稳定 IV 旅程收到意外的工具调用轮次：" + mainRound)
        }))

        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{
              type: "text",
              text: "导入 " + source + "。以创新指数为结果变量、did 为内生解释变量、财政分权度为工具变量。暂定财政分权度会影响 did，但不直接影响创新指数且与结构误差项无关；该识别假设尚待独立验证，不是数据证据。请先做 2SLS，再报告工具变量强度、内生性和过度识别诊断；不要把诊断说成排除限制已获证明。",
            }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })
          try {
            await Promise.race([
              verifierCompleted,
              new Promise<never>((_, reject) => {
                verifierTimeout = setTimeout(() => reject(new Error("did.xlsx IV 本地脚本化 verifier Session 未收尾")), 10_000)
              }),
            ])
          } catch (error) {
            const failedMessages = await Session.messages({ sessionID: session.id })
            const toolStates = failedMessages
              .filter((message) => message.info.role === "assistant")
              .flatMap((message) => message.parts)
              .filter((part): part is MessageV2.ToolPart => part.type === "tool")
              .map((part) => ({
                tool: part.tool,
                input: part.state.input,
                status: part.state.status,
                error: part.state.status === "error" ? part.state.error : undefined,
                output: part.state.status === "completed" ? String(part.state.output).slice(0, 220) : undefined,
              }))
            const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.analysisRequest?.kind === "estimate")
            throw new Error(`${String(error)}; mainRound=${mainRound}; requestedTools=${JSON.stringify(requestedTools)}; lifecycle=${JSON.stringify(task?.analysisLifecycle)}; tools=${JSON.stringify(toolStates)}; assistant=${assistantText(failedMessages)}`)
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
        const preparations = toolParts.filter((part) => part.tool === "analysis_prepare")
        const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.analysisRequest?.kind === "estimate")
        const preparedEstimate = task?.analysisSpecs?.filter((spec) => spec.methodID === "iv_2sls" && spec.status === "ready").at(-1)
        const preparedDiagnostic = task?.analysisSpecs?.filter((spec) => spec.methodID === "iv_test" && spec.status === "ready").at(-1)
        const failedPreparation = preparations.find((part) => part.state.status === "error" && part.state.input?.methodID === "iv_2sls")
        const completedEstimate = toolParts.find((part) => part.tool === "econometrics_execute" &&
          part.state.status === "completed" && part.state.input?.specId === preparedEstimate?.specId)
        const diagnosticPart = toolParts.find((part) => part.tool === "econometrics_execute" &&
          part.state.status === "completed" && part.state.input?.specId === preparedDiagnostic?.specId)
        if (!failedPreparation) throw new Error("空 instrumentVars 未被分析规格校验拒绝")
        if (!completedEstimate) throw new Error("修正参数后的真实 did.xlsx 2SLS 没有完成")
        if (!diagnosticPart || diagnosticPart.state.status !== "completed") throw new Error("稳定 iv_test 工具没有完成")

        const estimate = completedResult(completedEstimate)
        const diagnostic = completedResult(diagnosticPart)
        const weakInstrument = diagnostic.weakInstrument as Record<string, unknown>
        const overIdentification = diagnostic.overIdentification as Record<string, unknown>
        const endogeneity = diagnostic.endogeneity as Record<string, unknown>
        const estimateResultPath = typeof estimate.resultPath === "string" ? path.resolve(root, estimate.resultPath) : ""
        const estimateCoefficientsPath = typeof estimate.coefficientsPath === "string" ? path.resolve(root, estimate.coefficientsPath) : ""
        const diagnosticResultPath = typeof diagnostic.resultPath === "string" ? path.resolve(root, diagnostic.resultPath) : ""
        const diagnosticTestsPath = typeof diagnostic.testsPath === "string" ? path.resolve(root, diagnostic.testsPath) : ""

        expect(requestedTools).toEqual([
          "data_import:import",
          "data_import:profile",
          "data_import:validate",
          "tool_search:iv_2sls",
          "analysis_prepare:empty-instrumentVars",
          "analysis_prepare:corrected-instrumentVars",
          "tool_search:iv_2sls:recovery",
          "analysis_prepare:corrected-instrumentVars-after-search",
          "econometrics_execute:iv_2sls",
          "tool_search:iv_test",
          "tool_search:iv_test:repeat",
          "analysis_prepare:iv_test",
          "econometrics_execute:iv_test",
        ])
        expect(providerVisibleToolIDs).toContain("tool_search")
        expect(providerVisibleToolIDs).toContain("econometrics_execute")
        expect(providerVisibleToolIDs).not.toContain("iv_2sls")
        expect(providerVisibleToolIDs).not.toContain("iv_test")
        expect(ivSchemaVisible).toBe(true)
        expect(ivSchemaNotSentReachedReSearch).toBe(true)
        expect(ivEstimatorSearchOutput).toContain("不能用于：")
        expect(ivEstimatorSearchOutput).not.toContain("不适用：")
        expect(ivEstimatorSearchOutput).toContain("诊断要求：")
        expect(ivEstimatorSearchOutput).toContain("iv_test")
        expect(ivDiagnosticGuidanceVisible).toBe(true)
        expect(ivRepeatedSearchOutput).toContain("诊断要求：")
        expect(invalidParameterReachedRepairTurn).toBe(true)
        if (failedPreparation.state.status !== "error") throw new Error("空 instrumentVars 必须以可修正的 Schema 错误返回")
        expect(failedPreparation.state.error).toMatch(/instrumentVars|工具变量/i)

        expect(estimate.rowsUsed).toBe(4709)
        expect(estimate.firstStageStatistic).toBeCloseTo(1.431506, 4)
        expect(estimate.firstStageStatisticDistribution).toBe("chi2(1)")
        expect(estimateToolOutput).toContain("有效样本：4709")
        expect(estimateToolOutput).toContain("did：系数=1.868853638188284")
        expect(estimateToolOutput).toContain("内生性与过度识别诊断尚未运行")
        expect(estimateToolOutput).toContain("iv_test")
        expect(fs.existsSync(estimateResultPath)).toBe(true)
        expect(fs.existsSync(estimateCoefficientsPath)).toBe(true)
        expect(diagnostic.rowsUsed).toBe(4709)
        expect(weakInstrument.firstStageStatistic).toBeCloseTo(1.431506, 4)
        expect(weakInstrument.firstStageStatisticDistribution).toBe("chi2(1)")
        expect(weakInstrument.firstStageStatistic).toBeCloseTo(Number(estimate.firstStageStatistic), 6)
        expect(weakInstrument.weak).toBeNull()
        expect(overIdentification.applicable).toBe(false)
        expect(String(overIdentification.reason)).toContain("恰好识别")
        expect((overIdentification.sargan as Record<string, unknown>).stat).toBeNull()
        expect(typeof endogeneity.primaryTest).toBe("string")
        expect(fs.existsSync(diagnosticResultPath)).toBe(true)
        expect(fs.existsSync(diagnosticTestsPath)).toBe(true)

        // 结果需在 tool-result.output 中足够完整，后续推理不应靠猜测内部路径或重跑诊断。
        expect(estimateToolOutput).toContain("Wald χ²")
        expect(diagnosticToolOutput).toContain("Wald χ²")
        expect(diagnosticToolOutput).toContain("恰好识别")
        expect(diagnosticToolOutput).toContain("F<10")
        expect(diagnosticToolOutput).toContain("相关性证据有限")
        expect(diagnosticToolOutput).toContain("部分 R²=0.000281615")
        expect(diagnosticToolOutput).toContain("不能证明工具变量外生性或排除限制成立")
        expect(diagnosticToolOutput).toMatch(/内生性|Wooldridge|Durbin/i)
        expect(diagnosticToolOutput).not.toMatch(/Sargan\s*=\s*[-\d.]+|Hansen\s*J\s*=\s*[-\d.]+/i)
        expect(visible).toContain("仍未被数据证明")
        expect(visible).not.toContain("datasetId")
        expect(visible).not.toContain("stageId")
      } })
    } finally {
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
