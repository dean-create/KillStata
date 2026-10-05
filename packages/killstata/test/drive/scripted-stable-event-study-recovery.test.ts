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
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
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
  const field = (name: "datasetId" | "stageId") =>
    [...serialized.matchAll(new RegExp(`${name}(?:"\\s*:\\s*"|[=:]\\s*"?)([A-Za-z0-9_]+)`, "g"))].at(-1)?.[1]
  const datasetId = field("datasetId")
  const stageId = field("stageId")
  if (!datasetId || !stageId) throw new Error("模型没有从最新工具结果恢复当前数据阶段")
  return { datasetId, stageId }
}

function activeRequestID(sessionID: string) {
  const ledger = RuntimeTaskLedger.listTasks(sessionID)
  const requestId = ledger.tasks.find((task) => task.taskId === ledger.activeTaskId)?.analysisRequest?.requestId
  if (!requestId) throw new Error("当前分析轮没有活动 AnalysisRequest")
  return requestId
}

function activePreparedSpecID(sessionID: string) {
  const ledger = RuntimeTaskLedger.listTasks(sessionID)
  const specId = ledger.tasks.find((task) => task.taskId === ledger.activeTaskId)?.preparedSpec?.specId
  if (!specId) throw new Error("当前估计轮没有可执行 PreparedSpec")
  return specId
}

function localVerifierStream() {
  return completeTextStream([
    "<verifier_result>",
    JSON.stringify({
      status: "pass",
      checks: [{ key: "confirmed-event-study", label: "用户确认的 never-treated cohort 编码", status: "pass", message: "结果使用当前 cohort、处理和时期列，并保留所有面板行。" }],
      blockingFindings: [],
      repairHints: [],
      trustedArtifacts: [],
      summary: "本地脚本化事件研究结果核验完成。",
      findings: [],
    }),
    "</verifier_result>",
  ].join("\n"))
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
    if (Date.now() >= deadline) throw new Error("上一轮 Session dispatch 尚未退出，无法安全提交用户确认")
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

describe("真实 did.xlsx 交错事件研究的 never-treated cohort 恢复", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("先确认缺失 cohort 的含义，再保留控制组运行事件研究", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实事件研究回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python Registry 执行")
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-event-study-recovery-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex")
    const requestedTools: string[] = []
    const verifierSessionIDs = new Set<string>()
    let resolveVerifier!: () => void
    const verifierCompleted = new Promise<void>((resolve) => { resolveVerifier = resolve })
    let verifierTimeout: ReturnType<typeof setTimeout> | undefined
    let mainRound = 0
    let confirmedFollowup = false
    let followupRound = 0
    const modelRounds: string[] = []
    let unsubscribeCreated = () => {}
    let unsubscribeStatus = () => {}

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const engineExecute = spyOn(EconometricsEngineClient.prototype, "execute")
        spies.push(engineExecute)
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
modelRounds.push(`${request.agent.name}:small=${Boolean(request.small)}`)
          if (request.agent.name === "verifier") return { fullStream: localVerifierStream() } as never
          if (request.small) return { fullStream: completeTextStream("本地摘要：正在核验交错事件研究。") } as never
          if (request.textOnly === true) {
            const history = await Session.messages({ sessionID: session.id })
            const completed = history.some((message) => message.parts.some((part) =>
              part.type === "tool" &&
              part.tool === "econometrics_execute" &&
              part.state.status === "completed" &&
              completedPayload(part)?.success === true,
            ))
            return { fullStream: completeTextStream(completed
              ? "已在你确认的 never-treated cohort 编码下完成交错事件研究。PyFixest 将该方法标记为 beta，结果需结合平行趋势和研究设计审慎解释。"
              : "当前回合只整理已完成进度，不调用工具。") } as never
          }

          if (confirmedFollowup) {
            followupRound += 1
            if (followupRound === 1) {
              requestedTools.push("tool_search:event-study-confirmed")
              return { fullStream: completeToolBatchStream([{ toolName: "tool_search", toolCallId: "call_event_confirmed_search", input: { query: "did_event_study_saturated", limit: 1 } }]) } as never
            }
            if (followupRound === 2) {
              requestedTools.push("analysis_prepare:event-study-confirmed")
              return { fullStream: completeToolBatchStream([{ toolName: "analysis_prepare", toolCallId: "call_event_confirmed_prepare", input: {
                requestId: activeRequestID(request.sessionID),
                methodID: "did_event_study_saturated",
                arguments: {
                  dependentVar: "创新指数",
                  treatmentVar: "did",
                  entityVar: "地区",
                  timeVar: "year",
                  cohortVar: "time",
                  clusterVar: "地区",
                  neverTreatedCohortValue: 0,
                  covariates: [],
                },
              } }]) } as never
            }
            if (followupRound === 3) {
              requestedTools.push("econometrics_execute:event-study-confirmed")
              return { fullStream: completeToolBatchStream([{ toolName: "econometrics_execute", toolCallId: "call_event_confirmed_execute", input: {
                specId: activePreparedSpecID(request.sessionID),
              } }]) } as never
            }
            if (followupRound === 4) {
              return { fullStream: completeTextStream("已在你确认的 never-treated cohort 编码下完成交错事件研究。PyFixest 将该方法标记为 beta，结果需结合平行趋势和研究设计审慎解释。") } as never
            }
            throw new Error(`Unexpected confirmed event-study round ${followupRound}`)
          }

          mainRound += 1
          const lineage = mainRound > 1 ? latestLineage(request.messages) : undefined
          if (mainRound === 1) {
            requestedTools.push("data_import:import")
            return { fullStream: completeToolBatchStream([{ toolName: "data_import", toolCallId: "call_event_import", input: {
              action: "import",
              inputPath: source,
              preserveLabels: true,
              sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
            } }]) } as never
          }
          if (mainRound === 2) {
            requestedTools.push("data_import:profile")
            return { fullStream: completeToolBatchStream([{ toolName: "data_import", toolCallId: "call_event_profile", input: { action: "profile", ...lineage } }]) } as never
          }
          if (mainRound === 3) {
            requestedTools.push("data_import:validate")
            return { fullStream: completeToolBatchStream([{ toolName: "data_import", toolCallId: "call_event_validate", input: { action: "validate", ...lineage, entityVar: "地区", timeVar: "year" } }]) } as never
          }
          if (mainRound === 4) {
            requestedTools.push("tool_search:did_event_study_saturated")
            return { fullStream: completeToolBatchStream([{ toolName: "tool_search", toolCallId: "call_event_search", input: { query: "交错处理事件研究", limit: 1 } }]) } as never
          }
          if (mainRound === 5) {
            requestedTools.push("analysis_prepare:event-study-unconfirmed", "econometrics_execute:ols-same-batch")
            return { fullStream: completeToolBatchStream([
              {
                toolName: "analysis_prepare",
                toolCallId: "call_event_unconfirmed_prepare",
                input: { requestId: activeRequestID(request.sessionID), methodID: "did_event_study_saturated", arguments: {
                    dependentVar: "创新指数",
                    treatmentVar: "did",
                    entityVar: "地区",
                    timeVar: "year",
                    cohortVar: "time",
                    clusterVar: "地区",
                    covariates: [],
                  } },
              },
              {
                toolName: "econometrics_execute",
                toolCallId: "call_event_silent_ols",
                input: { specId: "spec_unprepared_silent_ols" },
              },
            ]) } as never
          }
          if (mainRound === 6) return { fullStream: completeTextStream("当前规格尚未通过数据前提检查，我会等待你确认从未处理组编码，再准备新的规格。") } as never
          throw new Error(`Unexpected scripted event-study round ${mainRound}`)
        }))

        const send = (text: string) => SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        await send(`导入 ${source}。time 是各地区首次处理年份，缺失代表从未处理；did 必须逐行符合 time>0 且 year>=time。请做交错事件研究，结果变量=创新指数；若工具要求将缺失 cohort 编码为 0，先问我，不要自动转换`)
        const initialMessages = await Session.messages({ sessionID: session.id })
        const initialTools = initialMessages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const importPart = initialTools.find((part) => part.tool === "data_import" && part.state.status === "completed" && part.state.input?.action === "import")
        if (!importPart || importPart.state.status !== "completed") throw new Error("did.xlsx 未成功导入")
        const decisionPart = initialTools.find((part) => part.tool === "analysis_prepare" && part.state.input?.methodID === "did_event_study_saturated")
        if (!decisionPart || decisionPart.state.status !== "completed") {
          const detail = !decisionPart ? "没有 event-study ToolPart" : decisionPart.state.status === "error" ? decisionPart.state.error : decisionPart.state.status
          const toolDetails = initialTools.map((part) => {
            const state = part.state
            const output = state.status === "error" ? state.error : state.status === "completed" ? state.output : ""
            return `${part.tool}:${state.status}:decision=${state.status === "completed" ? state.metadata.requiresUserDecision : "-"}:${output.slice(0, 100)}`
          }).join(" | ")
          const messageTail = initialMessages.slice(-5).map((message) => `${message.info.role}:${message.parts.map((part) => part.type === "text" ? part.text.slice(0, 80) : part.type).join("/")}`).join(" | ")
          throw new Error(`事件研究未返回用户决策结果：${detail}; round=${mainRound}; modelRounds=${modelRounds.join(",")}; tools=${requestedTools.join(",")}; toolParts=${toolDetails}; tail=${messageTail}; assistant=${assistantText(initialMessages).slice(-600)}`)
        }
        expect(decisionPart.state.metadata.requiresUserDecision).toBe(true)
        expect(decisionPart.state.output).toMatch(/从未处理|never-treated|cohort|缺失/i)
        const initialManifest = typeof importPart.state.metadata.datasetId === "string" ? readDatasetManifest(importPart.state.metadata.datasetId) : undefined
        expect(initialManifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])
        const sameBatchOls = initialTools.find((part) => part.tool === "econometrics_execute" && part.state.input?.specId === "spec_unprepared_silent_ols")
        expect(sameBatchOls?.state.status).not.toBe("completed")
        const preConfirmationExecutions = engineExecute.mock.calls.map(([payload]) => payload.method_id)
        expect(preConfirmationExecutions).not.toContain("did_event_study_saturated")
        expect(preConfirmationExecutions).not.toContain("ols_regression")

        await waitForDispatchIdle(session.id)
        confirmedFollowup = true
        await send("我确认仅在 did_event_study_saturated 的计算副本中把 time 的缺失值映射为 0，表示从未处理组；did 必须逐行等于 time>0 且 year>=time，原始数据不修改。继续估计。")
        const messages = await Session.messages({ sessionID: session.id })
        const tools = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const estimate = tools.find((part) =>
          part.tool === "econometrics_execute" &&
          part.state.status === "completed" &&
          part.state.metadata.method === "did_event_study_saturated" &&
          part.state.metadata.result,
        )
        if (!estimate || estimate.state.status !== "completed") {
          const details = tools.filter((part) => part.tool === "econometrics_execute").map((part) => `${part.state.status}:${part.state.status === "error" ? part.state.error : part.state.status === "completed" ? part.state.output : ""}`).join(" | ")
          throw new Error(`用户确认后事件研究未完成：round=${mainRound}; tools=${requestedTools.join(",")}; details=${details}`)
        }
        await Promise.race([
          verifierCompleted,
          new Promise<never>((_, reject) => { verifierTimeout = setTimeout(() => reject(new Error("事件研究本地 verifier 未结束")), 15_000) }),
        ])
        const payload = completedPayload(estimate)
        const datasetId = importPart.state.metadata.datasetId
        const manifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined
        const visible = assistantText(messages)

        expect(payload?.success).toBe(true)
        expect(payload?.method).toBe("did_event_study_saturated")
        expect(payload?.rowsUsed).toBe(4709)
        expect((payload?.warnings as string[] | undefined)?.join(" ")).toMatch(/从未处理|never-treated/)
        expect(estimate.state.metadata.stageId).toBe("stage_000")
        expect(manifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])
        expect(typeof payload?.resultPath).toBe("string")
        expect(typeof payload?.coefficientsPath).toBe("string")
        if (typeof payload?.resultPath === "string") expect(fs.existsSync(path.resolve(root, payload.resultPath))).toBe(true)
        if (typeof payload?.coefficientsPath === "string") expect(fs.existsSync(path.resolve(root, payload.coefficientsPath))).toBe(true)
        expect(requestedTools).toContain("analysis_prepare:event-study-unconfirmed")
        expect(requestedTools).toContain("econometrics_execute:event-study-confirmed")
        const executedMethodIDs = engineExecute.mock.calls.map(([request]) => request.method_id)
        expect(executedMethodIDs.filter((methodID) => methodID === "did_event_study_saturated")).toHaveLength(1)
        expect(executedMethodIDs).not.toContain("ols_regression")
        expect(visible).toContain("已在你确认的 never-treated cohort 编码下完成交错事件研究")
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
