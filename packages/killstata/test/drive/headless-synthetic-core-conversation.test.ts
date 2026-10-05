import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { Provider } from "@/provider/provider"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { Bus } from "@/bus"
import { AnalysisIntent } from "@/tool/analysis-intent"

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

function lineageFromMessages(messages: unknown) {
  const text = JSON.stringify(messages)
  const datasetId = text.match(/datasetId[=:]([A-Za-z0-9_]+)/)?.[1]
  const stageId = text.match(/stageId[=:]([A-Za-z0-9_]+)/)?.[1]
  if (!datasetId || !stageId) throw new Error("脚本化模型未从真实工具结果恢复 datasetId/stageId")
  return { datasetId, stageId }
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

function verifierResponse() {
  return completeTextStream([
    "<verifier_result>",
    JSON.stringify({
      status: "pass",
      checks: [{ key: "synthetic-ols", label: "合成 OLS 产物", status: "pass", message: "本地合成样本和结果产物一致。" }],
      blockingFindings: [],
      repairHints: [],
      trustedArtifacts: [],
      summary: "本地合成 OLS 结果已核验。",
      findings: [],
    }),
    "</verifier_result>",
  ].join("\n"))
}

test("headless Core：合成 CSV 经真实工具路由、Schema 搜索、参数恢复和 Python OLS 后返回中文结果", async () => {
  if (!process.env.KILLSTATA_PYTHON) {
    throw new Error("该集成场景要求显式设置 KILLSTATA_PYTHON，禁止静默跳过真实 Python 执行路径")
  }

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "killstata-headless-synthetic-")))
  const source = path.join(root, "synthetic.csv")
  const rows = ["outcome,treatment,control"]
  for (let index = 0; index < 72; index++) {
    const treatment = index % 2
    const control = (index % 7) + index * 0.013
    const outcome = 1.5 + 0.85 * treatment + 0.32 * control + Math.sin(index * 1.17) * 0.2
    rows.push(`${outcome.toFixed(8)},${treatment},${control.toFixed(8)}`)
  }
  fs.writeFileSync(source, `${rows.join("\n")}\n`, "utf8")

  let mainRound = 0
  let verifierSessionID: string | undefined
  let verifierCompleted!: () => void
  const verifierCompletedPromise = new Promise<void>((resolve) => { verifierCompleted = resolve })
  const requestedTools: string[] = []
  const modelCalls: string[] = []
  let schemaVisibleBeforeEstimate = false
  let repairContextContainsValidationError = false
  let correctionTurnSawSearchSchema = false
  let inputValidationFailed = false
  let estimateCompleted = false

  try {
    await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      AnalysisIntent.markAnalystPlanApproval(session.id, true)
      const model = await Provider.getModel("deepseek", "deepseek-v4-flash")

      spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
        const registration = await scriptedAnalysisRequestResponse(request)
        if (registration) return registration as never
modelCalls.push(`${request.agent.name}:${request.small ? "small" : "main"}`)
        if (request.agent.name === "verifier") {
          return { fullStream: verifierResponse() } as never
        }
        if (request.small) return { fullStream: completeTextStream("本地后台标题摘要") } as never

        mainRound += 1
        const messagesText = modelVisibleText(request.messages)
        const lineage = mainRound > 1 ? lineageFromMessages(request.messages) : undefined

        if (mainRound === 1) {
          requestedTools.push("data_import:import")
          return { fullStream: completeToolStream("data_import", "call_synthetic_import", { action: "import", inputPath: source }) } as never
        }
        if (mainRound === 2) {
          requestedTools.push("data_import:profile")
          return { fullStream: completeToolStream("data_import", "call_synthetic_profile", { action: "profile", ...lineage }) } as never
        }
        if (mainRound === 3) {
          requestedTools.push("data_import:validate")
          return { fullStream: completeToolStream("data_import", "call_synthetic_validate", { action: "validate", ...lineage }) } as never
        }
        if (mainRound === 4) {
          requestedTools.push("tool_search:ols_regression")
          return { fullStream: completeToolStream("tool_search", "call_synthetic_search", { query: "ols_regression", limit: 1 }) } as never
        }
        if (mainRound === 5) {
          requestedTools.push("analysis_prepare:invalid-covariance")
          schemaVisibleBeforeEstimate = messagesText.includes("参数 Schema：") &&
            messagesText.includes('"dependentVar"') && messagesText.includes('"covariance"')
          return {
            fullStream: completeToolStream("analysis_prepare", "call_synthetic_ols_invalid", {
              requestId: activeAnalysisRequestID(request.sessionID),
              methodID: "ols_regression",
              arguments: {
                dependentVar: "outcome",
                treatmentVar: "treatment",
                covariates: ["control"],
                covariance: "not-a-covariance",
              },
            }),
          } as never
        }
        if (mainRound === 6) {
          requestedTools.push("tool_search:retry-after-parameter-error")
          repairContextContainsValidationError = messagesText.includes("not-a-covariance") &&
            /covariance|协方差/i.test(messagesText)
          return { fullStream: completeToolStream("tool_search", "call_synthetic_search_retry", { query: "ols_regression", limit: 1 }) } as never
        }
        if (mainRound === 7) {
          requestedTools.push("analysis_prepare:corrected-covariance")
          correctionTurnSawSearchSchema = messagesText.includes("参数 Schema：") && messagesText.includes('"covariance"')
          return {
            fullStream: completeToolStream("analysis_prepare", "call_synthetic_ols_fixed", {
              requestId: activeAnalysisRequestID(request.sessionID),
              methodID: "ols_regression",
              arguments: {
                dependentVar: "outcome",
                treatmentVar: "treatment",
                covariates: ["control"],
                covariance: "HC1",
              },
            }),
          } as never
        }
        if (mainRound === 8) {
          requestedTools.push("econometrics_execute:prepared-spec")
          return {
            fullStream: completeToolStream("econometrics_execute", "call_synthetic_ols_execute", {
              specId: activePreparedSpecID(request.sessionID),
            }),
          } as never
        }
        return { fullStream: completeTextStream("合成数据的 OLS 已完成，参数错误已依据工具反馈修正。") } as never
      }))

      const unsubscribeSessionCreated = Bus.subscribe(Session.Event.Created, (event) => {
        const info = event.properties.info
        if (info.parentID === session.id && info.title.startsWith("工作流核验 - ")) verifierSessionID = info.id
      })
      const unsubscribeSessionStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
        if (event.properties.sessionID === verifierSessionID && event.properties.status.type === "idle") {
          verifierCompleted()
        }
      })
      let verifierTimeout: ReturnType<typeof setTimeout> | undefined
      try {
        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `请导入 ${source}，完成画像和质量检查后，用 OLS 估计 outcome 对 treatment 的关系，并控制 control。` }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })
        await Promise.race([
          verifierCompletedPromise,
          new Promise<never>((_, reject) => {
            verifierTimeout = setTimeout(() => {
              void Session.messages({ sessionID: session.id }).then((messages) => {
                const toolSummary = messages
                  .filter((message) => message.info.role === "assistant")
                  .flatMap((message) => message.parts)
                  .filter((part): part is MessageV2.ToolPart => part.type === "tool")
                  .map((part) => `${part.tool}:${part.state.status}:${part.state.status === "error" ? part.state.error : part.state.status === "completed" ? part.state.output.slice(0, 120) : ""}`)
                  .join(" | ")
                reject(new Error(
                  `本地脚本化 verifier Session 未收尾；子会话=${verifierSessionID ?? "未创建"}；模型调用=${modelCalls.join(",")}；工具=${toolSummary}；助手=${assistantText(messages).slice(-800)}`,
                ))
              }).catch(reject)
            }, 10_000)
          }),
        ])
      } finally {
        if (verifierTimeout) clearTimeout(verifierTimeout)
        unsubscribeSessionCreated()
        unsubscribeSessionStatus()
      }

      const messages = await Session.messages({ sessionID: session.id })
      const visible = assistantText(messages)
      const toolParts = messages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.ToolPart => part.type === "tool")
      const preparationParts = toolParts.filter((part) => part.tool === "analysis_prepare")
      const estimateParts = toolParts.filter((part) => part.tool === "econometrics_execute")
      const failedEstimate = preparationParts.find((part) => part.state.status === "error")
      const completedEstimate = estimateParts.find((part) => part.state.status === "completed")
      inputValidationFailed = failedEstimate?.state.status === "error"
      estimateCompleted = completedEstimate?.state.status === "completed"
      if (!failedEstimate || failedEstimate.state.status !== "error") throw new Error("预期的无效 covariance 调用没有保留失败状态")
      if (!completedEstimate || completedEstimate.state.status !== "completed") throw new Error("修正后的 OLS 调用没有成功完成")
      const result = completedEstimate.state.metadata.result as {
        method?: string
        rowsUsed?: number
        resultPath?: string
        coefficientsPath?: string
      } | undefined

      expect(requestedTools).toEqual([
        "data_import:import",
        "data_import:profile",
        "data_import:validate",
        "tool_search:ols_regression",
        "analysis_prepare:invalid-covariance",
        "tool_search:retry-after-parameter-error",
        "analysis_prepare:corrected-covariance",
        "econometrics_execute:prepared-spec",
      ])
      expect(schemaVisibleBeforeEstimate).toBe(true)
      expect(repairContextContainsValidationError).toBe(true)
      expect(correctionTurnSawSearchSchema).toBe(true)
      expect(inputValidationFailed).toBe(true)
      expect(estimateCompleted).toBe(true)
      expect(failedEstimate.state.error).toMatch(/covariance|协方差/i)
      expect(result).toMatchObject({ method: "ols_regression", rowsUsed: 72 })
      expect(typeof result?.resultPath).toBe("string")
      expect(typeof result?.coefficientsPath).toBe("string")
      // Session metadata intentionally stores project-relative `.killstata` paths;
      // resolve them against this test's temporary project, not Bun's package cwd.
      expect(path.isAbsolute(result!.resultPath!)).toBe(false)
      expect(path.isAbsolute(result!.coefficientsPath!)).toBe(false)
      const resultFile = path.resolve(root, result!.resultPath!)
      const coefficientsFile = path.resolve(root, result!.coefficientsPath!)
      expect(path.relative(root, resultFile).startsWith("..")).toBe(false)
      expect(path.relative(root, coefficientsFile).startsWith("..")).toBe(false)
      expect(fs.existsSync(resultFile)).toBe(true)
      expect(fs.existsSync(coefficientsFile)).toBe(true)
      expect(visible).toContain("合成数据的 OLS 已完成")
      expect(visible).not.toContain("datasetId")
      expect(visible).not.toContain("stageId")
      expect(preparationParts.map((part) => part.state.status)).toEqual(["error", "completed"])
      expect(estimateParts.map((part) => part.state.status)).toEqual(["completed"])
      expect(fs.existsSync(path.join(root, ".killstata"))).toBe(true)
    } })
  } finally {
    await Instance.disposeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
