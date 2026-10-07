import { afterEach, describe, expect, spyOn, test } from "bun:test"
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { SessionRunCoordinator } from "@/session/run-state"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
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

type ToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

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

function completeToolBatchStream(calls: ToolCall[]) {
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

function latestLineage(messages: unknown) {
  const serialized = JSON.stringify(messages)
  const readLast = (field: "datasetId" | "stageId") => {
    const pattern = new RegExp(`${field}(?:"\\s*:\\s*"|[=:]\\s*"?)([A-Za-z0-9_]+)`, "g")
    return [...serialized.matchAll(pattern)].at(-1)?.[1]
  }
  const datasetId = readLast("datasetId")
  const stageId = readLast("stageId")
  if (!datasetId || !stageId) throw new Error("模型没有从最新工具结果恢复当前数据阶段")
  return { datasetId, stageId }
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

function completedPayload(part: MessageV2.ToolPart) {
  if (part.state.status !== "completed") return undefined
  const payload = part.state.metadata.result
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined
}

async function waitForDispatchIdle(sessionID: string) {
  const deadline = Date.now() + 10_000
  while (SessionRunCoordinator.active(sessionID)) {
    if (Date.now() >= deadline) throw new Error("上一轮 Session dispatch 尚未退出，无法安全提交下一条用户确认")
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

function localVerifierStream() {
  return completeTextStream([
    "<verifier_result>",
    JSON.stringify({
      status: "pass",
      checks: [{ key: "confirmed-did2s", label: "用户确认的 DID2S 数据阶段", status: "pass", message: "核对估计使用已确认的 cohort/relative-time 阶段与用户指定研究变量。" }],
      blockingFindings: [],
      repairHints: [],
      trustedArtifacts: [],
      summary: "本地脚本化 DID2S 结果核验完成。",
      findings: [],
    }),
    "</verifier_result>",
  ].join("\n"))
}

describe("真实 did.xlsx DID2S 用户确认后恢复", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("先拒绝未授权的相对时期构造，再用用户确认的新 stage 完成 did2s", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实 DID2S 回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python Registry 执行")
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-did2s-recovery-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex")
    const requestedTools: string[] = []
    const verifierSessionIDs = new Set<string>()
    let resolveVerifier!: () => void
    const verifierCompleted = new Promise<void>((resolve) => { resolveVerifier = resolve })
    let mainRound = 0
    const receivedStreamCalls: string[] = []
    let verifierTimeout: ReturnType<typeof setTimeout> | undefined
    let unsubscribeCreated = () => {}
    let unsubscribeStatus = () => {}

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const activeEstimateTask = () => {
          const ledger = RuntimeTaskLedger.listTasks(session.id)
          return ledger.tasks.find((item) => item.taskId === ledger.activeTaskId && item.analysisRequest?.kind === "estimate")
        }
        unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
          const info = event.properties.info
          if (info.parentID === session.id && info.title.startsWith("工作流核验 - ")) verifierSessionIDs.add(info.id)
        })
        unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (verifierSessionIDs.has(event.properties.sessionID) && event.properties.status.type === "idle") resolveVerifier()
        })

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
receivedStreamCalls.push(`${request.agent.name}:small=${Boolean(request.small)}`)
          if (request.agent.name === "verifier") return { fullStream: localVerifierStream() } as never
          if (request.small) return { fullStream: completeTextStream("本地摘要：当前进行用户确认后的 DID2S 恢复测试。") } as never
          if (request.textOnly === true) {
            const history = await Session.messages({ sessionID: session.id })
            const completed = history.some((message) => message.parts.some((part) =>
              part.type === "tool" &&
              part.tool === "econometrics_execute" &&
              part.state.status === "completed" &&
              completedPayload(part)?.success === true,
            ))
            return { fullStream: completeTextStream(completed
              ? "已在你确认的 cohort 和 relative-time 编码下完成 DID2S。结果仅适用于当前样本和识别设定；仍需结合平行趋势与研究设计审慎解释。"
              : "当前回合只整理已完成进度，不调用工具。") } as never
          }

          mainRound += 1
          const lineage = mainRound > 1 ? latestLineage(request.messages) : undefined
          if (mainRound === 1) {
            requestedTools.push("data_import:import")
            return { fullStream: completeToolBatchStream([{ toolName: "data_import", toolCallId: "call_did2s_import", input: {
              action: "import",
              inputPath: source,
              preserveLabels: true,
              sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
            } }]) } as never
          }
          if (mainRound === 2) {
            requestedTools.push("data_import:profile")
            return { fullStream: completeToolBatchStream([{ toolName: "data_import", toolCallId: "call_did2s_profile", input: { action: "profile", ...lineage } }]) } as never
          }
          if (mainRound === 3) {
            requestedTools.push("data_import:validate")
            return { fullStream: completeToolBatchStream([{ toolName: "data_import", toolCallId: "call_did2s_validate", input: { action: "validate", ...lineage, entityVar: "地区", timeVar: "year" } }]) } as never
          }
          if (mainRound === 4) {
            requestedTools.push("tool_search:did2s")
            return { fullStream: completeToolBatchStream([{ toolName: "tool_search", toolCallId: "call_did2s_search", input: { query: "did2s", limit: 1 } }]) } as never
          }
          if (mainRound === 5) {
            requestedTools.push("data_preprocess:create_relative_time-unconfirmed", "analysis_prepare:did2s-same-batch")
            const task = activeEstimateTask()
            if (!task?.analysisRequest) throw new Error("未授权的 DID2S 规格尝试缺少 AnalysisRequest")
            return { fullStream: completeToolBatchStream([
              {
                toolName: "data_preprocess",
                toolCallId: "call_did2s_unconfirmed_transform",
                input: {
                  method: "create_relative_time",
                  columns: [],
                  options: {
                    entity_var: "地区",
                    time_var: "year",
                    cohort_var: "time",
                    treatment_var: "did",
                    output_column: "relative_time",
                  },
                },
              },
              {
                toolName: "analysis_prepare",
                toolCallId: "call_did2s_unconfirmed_estimate",
                input: {
                  requestId: task.analysisRequest.requestId,
                  methodID: "did2s",
                  arguments: {
                    dependentVar: "创新指数",
                    treatmentVar: "did",
                    entityVar: "地区",
                    timeVar: "year",
                    cohortVar: "time",
                    relativeTimeVar: "relative_time",
                    clusterVar: "地区",
                    referencePeriod: -1,
                    covariates: [],
                  },
                },
              },
            ]) } as never
          }
          if (mainRound === 6) {
            requestedTools.push("data_preprocess:create_relative_time-confirmed")
            return { fullStream: completeToolBatchStream([{ toolName: "data_preprocess", toolCallId: "call_did2s_confirmed_transform", input: {
              method: "create_relative_time",
              columns: [],
              options: {
                entity_var: "地区",
                time_var: "year",
                cohort_var: "time",
                treatment_var: "did",
                output_column: "relative_time",
              },
            } }]) } as never
          }
          if (mainRound === 7) {
            requestedTools.push("data_import:profile-derived")
            return { fullStream: completeToolBatchStream([{ toolName: "data_import", toolCallId: "call_did2s_profile_derived", input: { action: "profile", ...lineage } }]) } as never
          }
          if (mainRound === 8) {
            requestedTools.push("data_import:validate-derived")
            return { fullStream: completeToolBatchStream([{ toolName: "data_import", toolCallId: "call_did2s_validate_derived", input: { action: "validate", ...lineage, entityVar: "地区", timeVar: "year" } }]) } as never
          }
          if (mainRound === 9) {
            requestedTools.push("tool_search:did2s-derived")
            return { fullStream: completeToolBatchStream([{ toolName: "tool_search", toolCallId: "call_did2s_search_derived", input: { query: "did2s", limit: 1 } }]) } as never
          }
          if (mainRound === 10) {
            const estimateLineage = latestLineage(request.messages)
            if (lineage?.stageId !== estimateLineage.stageId) throw new Error("did2s 估计请求的血缘没有跟随最新派生 stage")
            requestedTools.push("analysis_prepare:did2s-confirmed")
            const task = activeEstimateTask()
            if (!task?.analysisRequest) throw new Error("用户确认后的 DID2S 准备缺少 AnalysisRequest")
            return { fullStream: completeToolBatchStream([{ toolName: "analysis_prepare", toolCallId: "call_did2s_confirmed_prepare", input: {
              requestId: task.analysisRequest.requestId,
              methodID: "did2s",
              arguments: {
                dependentVar: "创新指数",
                treatmentVar: "did",
                entityVar: "地区",
                timeVar: "year",
                cohortVar: "time",
                relativeTimeVar: "relative_time",
                clusterVar: "地区",
                referencePeriod: -1,
                covariates: [],
              },
            } }]) } as never
          }
          if (mainRound === 11) {
            requestedTools.push("econometrics_execute:did2s-confirmed")
            const task = activeEstimateTask()
            const prepared = task?.preparedSpec
            if (!prepared || prepared.methodID !== "did2s") throw new Error("用户确认后的 DID2S 没有生成 PreparedSpec")
            return { fullStream: completeToolBatchStream([{ toolName: "econometrics_execute", toolCallId: "call_did2s_confirmed_estimate", input: {
              specId: prepared.specId,
            } }]) } as never
          }
          if (mainRound === 12) {
            return { fullStream: completeTextStream("已在你确认的 cohort 和 relative-time 编码下完成 DID2S。结果仅适用于当前样本和识别设定；仍需结合平行趋势与研究设计审慎解释。") } as never
          }
          throw new Error(`Unexpected scripted DID2S recovery model round ${mainRound}`)
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `导入 ${source}，time 表示首次处理年份，缺失表示从未处理。请用 did2s 分析创新指数；若 relative_time 不存在，先问我，不要自动生成。` }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })
        if (!requestedTools.includes("tool_search:did2s")) {
          throw new Error(`第一轮没有推进到 DID2S Schema 搜索：rounds=${mainRound}; streams=${receivedStreamCalls.join(",")}; tools=${requestedTools.join(",")}`)
        }
        const firstMessages = await Session.messages({ sessionID: session.id })
        const firstToolParts = firstMessages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const importPart = firstToolParts.find((part) => part.tool === "data_import" && part.state.status === "completed" && part.state.input?.action === "import")
        if (!importPart || importPart.state.status !== "completed") throw new Error("did.xlsx 未成功导入")
        const dataPreprocessAttempt = firstToolParts.find((part) => part.tool === "data_preprocess" && part.state.input?.method === "create_relative_time")
        const sameBatchEstimate = firstToolParts.find((part) => part.tool === "analysis_prepare" && part.state.input?.methodID === "did2s")
        const datasetId = importPart.state.metadata.datasetId
        const initialManifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined
        if (!dataPreprocessAttempt || dataPreprocessAttempt.state.status !== "completed") throw new Error("未授权的相对时期构造没有形成明确用户决策结果")
        if (dataPreprocessAttempt.state.metadata.requiresUserDecision !== true) throw new Error("未授权的数据变换没有被 requiresUserDecision 门禁拦截")
        expect(sameBatchEstimate?.state.status).not.toBe("completed")
        expect(initialManifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])
        await waitForDispatchIdle(session.id)
        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: "我确认按 year - time 为每个地区构造 relative_time；did 必须和 year>=time 一致，从未处理组设为 -inf。确认后继续 DID2S。" }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })
        if (mainRound <= 6) {
          const snapshot = await Session.messages({ sessionID: session.id })
          const tail = snapshot.slice(-6).map((message) => {
            const parentID = message.info.role === "assistant" ? message.info.parentID : "-"
            return `${message.info.role}:${message.info.id}:parent=${parentID}:${message.parts.map((part) => part.type === "text" ? part.text.slice(0, 60) : part.type).join("/")}`
          }).join(" | ")
          const toolSummary = snapshot.flatMap((message) => message.parts)
            .filter((part): part is MessageV2.ToolPart => part.type === "tool")
            .map((part) => {
              let detail = ""
              if (part.state.status === "error") detail = `${part.state.error} metadata=${JSON.stringify(part.state.metadata)}`
              else if (part.state.status === "completed") detail = part.state.output
              return part.tool + ":" + part.state.status + ":" + detail
            })
            .join(" | ")
          throw new Error(`第二条用户确认没有驱动完整恢复：round=${mainRound} requested=${requestedTools.join(",")} active=${SessionRunCoordinator.active(session.id)} pending=${SessionRunCoordinator.pending(session.id)} messages=${tail} tools=${toolSummary}`)
        }
        const messages = await Session.messages({ sessionID: session.id })
        const allToolParts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const transform = allToolParts.find((part) => part.tool === "data_preprocess" && part.state.status === "completed" && part.state.input?.method === "create_relative_time" && part.state.metadata.requiresUserDecision !== true)
        const task = activeEstimateTask()
        const preparedEstimate = task?.analysisSpecs?.filter((spec) => spec.methodID === "did2s" && spec.status === "ready").at(-1)
        const estimate = allToolParts.find((part) => part.tool === "econometrics_execute" && part.state.input?.specId === preparedEstimate?.specId && part.state.status === "completed" && part.state.metadata.result)
        if (!transform || transform.state.status !== "completed") {
          const details = allToolParts.filter((part) => part.tool === "data_preprocess").map((part) => {
            const decision = part.state.status === "completed" ? part.state.metadata.requiresUserDecision : "-"
            const detail = part.state.status === "error" ? part.state.error : part.state.status === "completed" ? part.state.output : ""
            return `${part.state.status}:decision=${decision}:${detail || part.tool}`
          }).join(" | ")
          throw new Error(`用户确认后没有创建 relative_time 派生 stage：round=${mainRound}; tools=${requestedTools.join(",")}; parts=${details}`)
        }
        if (!estimate || estimate.state.status !== "completed") {
          const did2sParts = allToolParts.filter((part) => part.tool === "econometrics_execute")
            .map((part) => `${part.state.status}:${part.state.status === "error" ? part.state.error : part.state.status === "completed" ? part.state.output : ""}`)
            .join(" | ")
          const preparations = allToolParts.filter((part) => part.tool === "analysis_prepare")
            .map((part) => `${part.state.status}:${part.state.status === "error" ? part.state.error : part.state.status === "completed" ? part.state.output : ""}`)
            .join(" | ")
          const task = activeEstimateTask()
          throw new Error(`DID2S 估计未完成：round=${mainRound}; tools=${requestedTools.join(",")}; lifecycle=${JSON.stringify(task?.analysisLifecycle)}; preparations=${preparations}; executionParts=${did2sParts}`)
        }
        await Promise.race([
          verifierCompleted,
          new Promise<never>((_, reject) => {
            verifierTimeout = setTimeout(() => reject(new Error("本地 DID2S verifier 子会话未完成")), 15_000)
          }),
        ])
        if (estimate.state.status !== "completed") throw new Error("DID2S 估计终态丢失")
        if (!estimate.state.metadata.result) throw new Error("DID2S 没有返回真实估计结果")
        const transformMetadata = transform.state.metadata as Record<string, unknown>
        const estimateMetadata = estimate.state.metadata as Record<string, unknown>
        const transformStageId = transformMetadata.stageId
        if (typeof transformStageId !== "string") throw new Error("相对时期转换未报告派生 stageId")
        const estimatePayload = completedPayload(estimate)
        const manifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined
        const visible = assistantText(messages)

        expect(transform.state.status).toBe("completed")
        expect(estimatePayload?.success).toBe(true)
        expect(estimatePayload?.method).toBe("did2s")
        expect(estimatePayload?.rowsUsed).toBe(4709)
        expect(estimateMetadata.stageId).toBe(transformStageId)
        expect(manifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000", transformStageId])
        expect(typeof estimatePayload?.resultPath).toBe("string")
        expect(typeof estimatePayload?.coefficientsPath).toBe("string")
        if (typeof estimatePayload?.resultPath === "string") expect(fs.existsSync(path.resolve(root, estimatePayload.resultPath))).toBe(true)
        if (typeof estimatePayload?.coefficientsPath === "string") expect(fs.existsSync(path.resolve(root, estimatePayload.coefficientsPath))).toBe(true)
        expect(requestedTools).toContain("data_preprocess:create_relative_time-unconfirmed")
        expect(requestedTools).toContain("data_preprocess:create_relative_time-confirmed")
        expect(requestedTools).toContain("econometrics_execute:did2s-confirmed")
        expect(visible).toMatch(/已在你确认的 cohort 和 relative-time 编码下完成 (?:DID2S|两阶段双重差分)/)
        expect(visible).not.toContain("datasetId")
        expect(visible).not.toContain("stageId")
        expect(crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex")).toBe(sourceHash)
      } })
    } finally {
      if (verifierTimeout) clearTimeout(verifierTimeout)
      unsubscribeCreated()
      unsubscribeStatus()
      await Instance.disposeAll()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})
