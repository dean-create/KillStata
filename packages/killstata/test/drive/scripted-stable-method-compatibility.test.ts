import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { methodSchemaIDsVisibleToModel } from "@/runtime/tool-schema-provenance"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { readDatasetManifest } from "@/tool/analysis-state"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  await Instance.disposeAll()
})

type ToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

let scriptedTextSequence = 0

function completeTextStream(text: string) {
  const textID = `scripted-text-${++scriptedTextSequence}`
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "text-start", id: textID }
    yield { type: "text-delta", id: textID, text }
    yield { type: "text-end", id: textID }
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function completeToolStream(call: ToolCall) {
  return completeToolBatchStream([call])
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

function modelVisibleText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(modelVisibleText).join("\n")
  if (value && typeof value === "object") return Object.values(value).map(modelVisibleText).join("\n")
  return ""
}

function localVerifierStream(methodID: string) {
  return completeTextStream([
    "<verifier_result>",
    JSON.stringify({
      status: "pass",
      checks: [{ key: "real-data-" + methodID, label: "真实数据 " + methodID + " 结果产物", status: "pass", message: "只核对结果与当前数据阶段及工具参数一致，不替代研究设计判断。" }],
      blockingFindings: [],
      repairHints: [],
      trustedArtifacts: [],
      summary: "本地脚本化结果核验完成。",
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
  const payload = (part.state.metadata as Record<string, unknown>).result
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined
}

function methodIDFromToolPart(part: MessageV2.ToolPart): string | undefined {
  const input = part.state.input && typeof part.state.input === "object"
    ? part.state.input as Record<string, unknown>
    : {}
  const metadata = part.state.status === "completed" ? part.state.metadata as Record<string, unknown> : {}
  const payload = metadata.result && typeof metadata.result === "object"
    ? metadata.result as Record<string, unknown>
    : {}
  const methodID = input.methodID ?? metadata.method ?? payload.method ?? payload.method_id
  return typeof methodID === "string" ? methodID : undefined
}

async function waitForMethodVerification(input: {
  sessionID: string
  methodID: string
  verifierSessionIDs: Set<string>
  idleVerifierSessionIDs: Set<string>
}) {
  const deadline = Date.now() + 10_000
  const readTarget = async () => {
    const messages = await Session.messages({ sessionID: input.sessionID })
    const parts = messages
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part): part is MessageV2.ToolPart =>
        part.type === "tool" && part.tool === "econometrics_execute" && methodIDFromToolPart(part) === input.methodID,
      )
    const part = [...parts].reverse().find((candidate) => completedPayload(candidate)?.success === true) ?? parts.at(-1)
    const metadata = part?.state.status === "completed"
      ? part.state.metadata as Record<string, unknown>
      : undefined
    const pending = !part || part.state.status !== "completed" || metadata?.verifierPending === true ||
      (part.state.status === "completed" && /状态：待核验/.test(part.state.output))
    return { part, pending }
  }

  while (Date.now() < deadline) {
    const { part, pending } = await readTarget()
    const allVerifiersIdle = input.verifierSessionIDs.size > 0 &&
      [...input.verifierSessionIDs].every((sessionID) => input.idleVerifierSessionIDs.has(sessionID))
    if (!pending && allVerifiersIdle) {
      const verifierIDs = [...input.verifierSessionIDs].sort().join("|")
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      const latest = await readTarget()
      const latestVerifierIDs = [...input.verifierSessionIDs].sort().join("|")
      if (!latest.pending && verifierIDs === latestVerifierIDs) return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }

  const { part } = await readTarget()
  const state = part?.state.status === "completed" ? part.state.output : part?.state.status
  const metadata = part?.state.status === "completed" ? part.state.metadata as Record<string, unknown> : undefined
  const messages = await Session.messages({ sessionID: input.sessionID })
  const observedTools = messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((candidate): candidate is MessageV2.ToolPart => candidate.type === "tool")
    .map((candidate) => {
      const key = methodIDFromToolPart(candidate) ?? candidate.state.input?.action ?? candidate.state.input?.specId ?? ""
      const error = candidate.state.status === "error" ? `:${String(candidate.state.error).slice(0, 160)}` : ""
      return `${candidate.tool}[${String(key)}]:${candidate.state.status}${error}`
    })
    .join(" | ")
  const verifierReplies = await Promise.all([...input.verifierSessionIDs].map(async (sessionID) => {
    const verifierMessages = await Session.messages({ sessionID })
    const verifierState = verifierMessages
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .map((part) => JSON.stringify({ text: part.text.slice(-400), metadata: part.metadata }))
      .join(" | ")
    return `${sessionID}:${verifierState.slice(-1600)}`
  }))
  throw new Error(`${input.methodID} 的 verifier 状态未收尾：${String(state)}；pending=${String(metadata?.verifierPending)}；failure=${String(metadata?.verifierFailure)}；sessions=${input.verifierSessionIDs.size}，idle=${input.idleVerifierSessionIDs.size}；tools=${observedTools || "none"}；assistant=${assistantText(messages).slice(-500)}；verifier=${verifierReplies.join(" | ")}`)
}

async function runRealMethodScenario(input: {
  methodID: "ols_regression" | "did_static" | "logit_regression" | "probit_regression" | "poisson_regression" | "negbin_regression" | "multinomial_logit" | "wls_regression" | "psm_matching" | "psm_ipw" | "psm_regression" | "psm_double_robust" | "did2s" | "panel_random_effects" | "hdfe_regression" | "quantile_regression" | "robust_regression" | "rdd_sharp" | "rdd_fuzzy"
  dependentVar: string
  userText: string
  arguments: Record<string, unknown>
  repairArguments?: Record<string, unknown>
  addSilentOlsAlternative: boolean
  expectEstimate: boolean
  finalAssistantText?: string
  filterYear?: number
  filterRule?: { column: string; operator: "eq"; value: string | number }
  dataFileName?: "did.xlsx" | "gf.xlsx"
  sheetName?: string
  sourceFilePath?: string
  followupMethodID?: "ols_regression" | "did_static" | "logit_regression" | "probit_regression" | "poisson_regression" | "negbin_regression" | "wls_regression" | "psm_matching" | "psm_ipw" | "psm_regression" | "psm_double_robust" | "did2s" | "panel_random_effects" | "quantile_regression" | "robust_regression" | "rdd_sharp"
  followupArguments?: Record<string, unknown>
  /** Some canonical CSV imports already publish profile/QA; avoid a duplicate read-only cycle. */
  skipPostImportDiagnostics?: boolean
  followupUserMessage?: string
  preprocessAfterUserResponse?: { method: string; columns: string[]; options: Record<string, unknown> }
}) {
  if (!process.env.KILLSTATA_PYTHON) {
    throw new Error("该真实数据 AgentLoop 回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python Registry 执行")
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-method-compatibility-"))
  const dataFileName = input.dataFileName ?? "did.xlsx"
  const sourceFilePath = input.sourceFilePath ?? localRealDataPath(dataFileName)
  const source = path.join(root, path.basename(sourceFilePath))
  fs.copyFileSync(sourceFilePath, source)
  const sheetName = input.sheetName ?? (path.extname(source).toLowerCase() === ".xlsx" ? "Data_可读" : undefined)
  const requestedTools: string[] = []
  const preflightMethodIDs: string[] = []
  const verifierSessionIDs = new Set<string>()
  const idleVerifierSessionIDs = new Set<string>()

  try {
    return await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      AnalysisIntent.markAnalystPlanApproval(session.id, true)
      const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
      const engineExecute = spyOn(EconometricsEngineClient.prototype, "execute")
      spies.push(engineExecute)
      const runEnginePreflight = EconometricsEngineClient.prototype.preflight
      const enginePreflight = spyOn(EconometricsEngineClient.prototype, "preflight").mockImplementation(function (
        this: EconometricsEngineClient,
        payload,
        signal,
      ) {
        preflightMethodIDs.push(payload.method_id)
        return runEnginePreflight.call(this, payload, signal)
      })
      spies.push(enginePreflight)
      const unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
        const info = event.properties.info
        if (info.parentID === session.id && info.title.startsWith("工作流核验 - ")) verifierSessionIDs.add(info.id)
      })
      const unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
        if (verifierSessionIDs.has(event.properties.sessionID) && event.properties.status.type === "idle") {
          idleVerifierSessionIDs.add(event.properties.sessionID)
        }
      })
      let mainRound = 0
      let textOnlyRounds = 0
      const textOnlyAtRounds: number[] = []
      let stableTools: string[] = []
      let finalModelInputText = ""
      let modelInputBeforeMethodExecute = ""
      let repairTurnInputText = ""
      let repairSchemaIDs: string[] = []
      const followupMethodID = input.followupMethodID ?? input.methodID
      const followupArguments = input.followupArguments ?? input.arguments
      const targetMethodID = input.expectEstimate && input.followupUserMessage && input.followupMethodID
        ? input.followupMethodID
        : input.methodID

      spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
        const registration = await scriptedAnalysisRequestResponse(request)
        if (registration) return registration as never
const agentName = String(request.agent.name).trim().toLowerCase()
        if (agentName === "verifier") {
          return { fullStream: localVerifierStream(targetMethodID) } as never
        }
        if (request.small) return { fullStream: completeTextStream("本地会话摘要") } as never

        const hasSampleFilter = input.filterYear !== undefined || input.filterRule !== undefined
        const preprocessStartRound = hasSampleFilter ? 7 : input.skipPostImportDiagnostics ? 2 : 4
        const methodSearchRound = preprocessStartRound
        const methodPrepareRound = methodSearchRound + 1
        const repairSearchRound = input.repairArguments ? methodPrepareRound + 1 : undefined
        const repairPrepareRound = repairSearchRound === undefined ? undefined : repairSearchRound + 1
        const methodExecuteRound = repairPrepareRound === undefined ? methodPrepareRound + 1 : repairPrepareRound + 1
        const followupUserStartRound = input.followupUserMessage ? methodExecuteRound + 1 : undefined
        const followupPreprocessStartRound = input.preprocessAfterUserResponse ? followupUserStartRound : undefined
        const followupMethodSearchRound = followupUserStartRound === undefined
          ? undefined
          : input.preprocessAfterUserResponse
            ? followupUserStartRound + 3
            : followupUserStartRound
        const followupMethodPrepareRound = followupMethodSearchRound === undefined ? undefined : followupMethodSearchRound + 1
        const followupMethodExecuteRound = followupMethodSearchRound === undefined ? undefined : followupMethodSearchRound + 2
        const finalAssistantText = input.finalAssistantText ?? (input.expectEstimate
          ? "Poisson/PPML 已完成，模型估计按连续非负结果解释。"
          : "当前方法与数据存在前提冲突；我没有切换方法或构造新列，等待你确认下一步。")
        finalModelInputText = modelVisibleText(request.messages)
        if (request.textOnly === true) {
          textOnlyRounds += 1
          textOnlyAtRounds.push(mainRound)
          if (input.repairArguments && /entityVar[^\n]{0,30}类型错误/.test(finalModelInputText)) {
            return { fullStream: completeTextStream("我已看到 entityVar 的字段类型错误；本轮只整理错误，不将估计说成完成，下一轮会按 Schema 修正。") } as never
          }
          const history = await Session.messages({ sessionID: session.id })
          const methodAlreadyExecuted = history
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .some((part): part is MessageV2.ToolPart =>
              part.type === "tool" &&
              part.tool === "econometrics_execute" &&
              methodIDFromToolPart(part) === targetMethodID &&
              completedPayload(part)?.success === true,
            )
          return {
            fullStream: completeTextStream(methodAlreadyExecuted
              ? finalAssistantText
              : "当前数据准备步骤已返回，我会继续按本轮明确指定的方法处理。"),
          } as never
        }

        mainRound += 1
        if (mainRound === 1) {
          requestedTools.push("data_import:import")
          return { fullStream: completeToolStream({ toolName: "data_import", toolCallId: "call_compat_import", input: {
            action: "import",
            inputPath: source,
            preserveLabels: true,
            ...(sheetName ? { sheetPolicy: { mode: "named_sheet", sheetName } } : {}),
          } }) } as never
        }
        if (!input.skipPostImportDiagnostics && mainRound === 2) {
          requestedTools.push("data_import:profile")
          return { fullStream: completeToolStream({ toolName: "data_import", toolCallId: "call_compat_profile", input: { action: "profile" } }) } as never
        }
        if (!input.skipPostImportDiagnostics && mainRound === 3) {
          requestedTools.push("data_import:validate")
          return { fullStream: completeToolStream({ toolName: "data_import", toolCallId: "call_compat_validate", input: { action: "validate" } }) } as never
        }
        if (hasSampleFilter && mainRound === 4) {
          const filterRule = input.filterRule ?? { column: "year", operator: "eq" as const, value: input.filterYear! }
          requestedTools.push(`data_preprocess:filter-${filterRule.column}-${filterRule.value}`)
          return { fullStream: completeToolStream({ toolName: "data_preprocess", toolCallId: "call_compat_filter_year", input: {
            method: "filter",
            columns: [],
            options: { rules: [filterRule] },
          } }) } as never
        }
        if (hasSampleFilter && mainRound === 5) {
          requestedTools.push("data_import:profile-filtered-stage")
          return { fullStream: completeToolStream({ toolName: "data_import", toolCallId: "call_compat_profile_filtered", input: { action: "profile" } }) } as never
        }
        if (hasSampleFilter && mainRound === 6) {
          requestedTools.push("data_import:validate-filtered-stage")
          return { fullStream: completeToolStream({ toolName: "data_import", toolCallId: "call_compat_validate_filtered", input: { action: "validate" } }) } as never
        }
        if (input.preprocessAfterUserResponse && followupPreprocessStartRound !== undefined && mainRound === followupPreprocessStartRound) {
          requestedTools.push(`data_preprocess:${input.preprocessAfterUserResponse.method}`)
          return { fullStream: completeToolStream({ toolName: "data_preprocess", toolCallId: "call_compat_followup_preprocess", input: {
            method: input.preprocessAfterUserResponse.method,
            columns: input.preprocessAfterUserResponse.columns,
            options: input.preprocessAfterUserResponse.options,
          } }) } as never
        }
        if (input.preprocessAfterUserResponse && followupPreprocessStartRound !== undefined && mainRound === followupPreprocessStartRound + 1) {
          requestedTools.push("data_import:profile-followup-preprocessed-stage")
          return { fullStream: completeToolStream({ toolName: "data_import", toolCallId: "call_compat_followup_profile", input: { action: "profile" } }) } as never
        }
        if (input.preprocessAfterUserResponse && followupPreprocessStartRound !== undefined && mainRound === followupPreprocessStartRound + 2) {
          requestedTools.push("data_import:validate-followup-preprocessed-stage")
          return { fullStream: completeToolStream({ toolName: "data_import", toolCallId: "call_compat_followup_validate", input: { action: "validate" } }) } as never
        }
        if (mainRound === methodSearchRound || mainRound === repairSearchRound || mainRound === followupMethodSearchRound) {
          const searchMethodID = mainRound === followupMethodSearchRound ? followupMethodID : input.methodID
          requestedTools.push("tool_search:" + searchMethodID)
          if (mainRound === repairSearchRound) repairTurnInputText = modelVisibleText(request.messages)
          stableTools = Object.keys(request.tools?.definitions ?? {})
          return { fullStream: completeToolStream({ toolName: "tool_search", toolCallId: `call_compat_method_search_${mainRound}`, input: { query: searchMethodID, limit: 1 } }) } as never
        }
        if (
          mainRound === methodPrepareRound ||
          mainRound === repairPrepareRound ||
          mainRound === followupMethodPrepareRound
        ) {
          const isFollowup = mainRound === followupMethodPrepareRound
          const isRepair = mainRound === repairPrepareRound
          const methodID = isFollowup ? followupMethodID : input.methodID
          const argumentsToPrepare = isFollowup
            ? followupArguments
            : isRepair
              ? input.repairArguments!
              : input.arguments
          if (isRepair) {
            repairTurnInputText = modelVisibleText(request.messages)
            repairSchemaIDs = [...methodSchemaIDsVisibleToModel(request.messages)]
          }
          const ledger = RuntimeTaskLedger.listTasks(session.id)
          const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
          if (!task?.analysisRequest) throw new Error(`analysis_prepare ${methodID} 缺少当前 AnalysisRequest`)
          modelInputBeforeMethodExecute = finalModelInputText
          requestedTools.push(`analysis_prepare:${methodID}${isRepair ? ":schema-repair" : ""}`)
          const calls: ToolCall[] = [{
            toolName: "analysis_prepare",
            toolCallId: `call_compat_prepare_${mainRound}`,
            input: {
              requestId: task.analysisRequest.requestId,
              methodID,
              arguments: argumentsToPrepare,
            },
          }]
          if (input.addSilentOlsAlternative && !isFollowup && !isRepair) {
            requestedTools.push("econometrics_execute:ols_regression-silent-alternative")
            calls.push({
              toolName: "econometrics_execute",
              toolCallId: `call_compat_silent_ols_${mainRound}`,
              input: { specId: "spec_unprepared_silent_ols" },
            })
          }
          return { fullStream: completeToolBatchStream(calls) } as never
        }
        if (mainRound === methodExecuteRound || mainRound === followupMethodExecuteRound) {
          const isFollowup = mainRound === followupMethodExecuteRound
          const methodID = isFollowup ? followupMethodID : input.methodID
          const ledger = RuntimeTaskLedger.listTasks(session.id)
          const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
          const preparedSpec = task?.preparedSpec
          if (!input.expectEstimate && !isFollowup) return { fullStream: completeTextStream(finalAssistantText) } as never
          if (!preparedSpec && input.followupUserMessage && !isFollowup) {
            return { fullStream: completeTextStream(finalAssistantText) } as never
          }
          if (!preparedSpec || preparedSpec.methodID !== methodID) {
            throw new Error(`${methodID} 进入稳定执行轮次时没有匹配的 PreparedSpec；请先确认 analysis_prepare 是否通过。`)
          }
          modelInputBeforeMethodExecute = finalModelInputText
          requestedTools.push("econometrics_execute:" + methodID)
          return { fullStream: completeToolStream({
            toolName: "econometrics_execute",
            toolCallId: `call_compat_execute_${mainRound}`,
            input: { specId: preparedSpec.specId },
          }) } as never
        }
        return { fullStream: completeTextStream(finalAssistantText) } as never
      }))

      try {
        const promptInput: Parameters<typeof SessionPrompt.prompt>[0] = {
          sessionID: session.id,
          parts: [{ type: "text", text: "导入 " + source + "。" + input.userText }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        }
        await SessionPrompt.prompt(promptInput)
        if (input.followupUserMessage) {
          await SessionPrompt.prompt({
            ...promptInput,
            parts: [{ type: "text", text: input.followupUserMessage }],
          })
        }
        if (input.expectEstimate) {
          const currentMessages = await Session.messages({ sessionID: session.id })
          const methodAttempts = currentMessages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part): part is MessageV2.ToolPart =>
              part.type === "tool" &&
              part.tool === "econometrics_execute" &&
              methodIDFromToolPart(part) === targetMethodID,
            )
          const requestedMethod = [...methodAttempts].reverse().find((part) => completedPayload(part)?.success === true)
            ?? methodAttempts.at(-1)
          if (!requestedMethod) {
           const currentLedger = RuntimeTaskLedger.listTasks(session.id)
           const currentTask = currentLedger.tasks.find((item) => item.taskId === currentLedger.activeTaskId)
            const taskSummary = currentTask ? {
              taskId: currentTask.taskId,
              messageID: currentTask.messageID,
              intent: currentTask.metadata?.intent,
              requiredToolIDs: currentTask.metadata?.requiredToolIDs,
              confirmedToolIDs: currentTask.metadata?.confirmedToolIDs,
              analysisRequest: currentTask.analysisRequest && {
                kind: currentTask.analysisRequest.kind,
                sourceMessageId: currentTask.analysisRequest.sourceMessageId,
              },
            } : undefined
            const methodTrace = currentMessages
              .filter((message) => message.info.role === "assistant")
              .flatMap((message) => message.parts)
              .filter((part): part is MessageV2.ToolPart =>
                part.type === "tool" && (part.tool === "analysis_prepare" || part.tool === "econometrics_execute"),
              )
              .map((part) => {
                const state = part.state
                const metadata = state.status === "completed" ? state.metadata as Record<string, unknown> : {}
                return {
                  tool: part.tool,
                  methodID: methodIDFromToolPart(part),
                  status: state.status,
                  decision: metadata.requiresUserDecision,
                  specStatus: metadata.analysisSpecStatus,
                  preflightStatus: metadata.preflightStatus,
                  output: state.status === "completed" ? state.output.slice(0, 180) : undefined,
                  error: state.status === "error" ? String(state.error).slice(0, 180) : undefined,
                }
              })
            throw new Error(
              `${targetMethodID} 未进入工具执行；mainRound=${mainRound}，textOnlyRounds=${textOnlyRounds}，` +
              `textOnlyAt=${textOnlyAtRounds.join(",")}，requested=${requestedTools.join(",")}；` +
              `activeTask=${JSON.stringify(taskSummary)}，prepared=${JSON.stringify(currentTask?.preparedSpec ? { methodID: currentTask.preparedSpec.methodID } : undefined)}；` +
              `methodTrace=${JSON.stringify(methodTrace)}，repairSchemaIDs=${JSON.stringify(repairSchemaIDs)}；` +
              `assistant=${assistantText(currentMessages).slice(-500)}`,
            )
          }
          if (completedPayload(requestedMethod)?.success !== true) {
            throw new Error(
              `${targetMethodID} 本轮未生成成功估计结果；工具状态=${requestedMethod.state.status}，` +
              `决策=${String(requestedMethod.state.status === "completed" ? requestedMethod.state.metadata.requiresUserDecision : false)}，` +
              `错误=${requestedMethod.state.status === "error" ? requestedMethod.state.error : requestedMethod.state.status === "completed" ? requestedMethod.state.output : requestedMethod.state.status}；` +
              `mainRound=${mainRound}，textOnlyRounds=${textOnlyRounds}，textOnlyAt=${textOnlyAtRounds.join(",")}，` +
              `requested=${requestedTools.join(",")}，repairInput=${repairTurnInputText.slice(-700)}；` +
              `assistant=${assistantText(currentMessages).slice(-500)}`,
            )
          }
          await waitForMethodVerification({
            sessionID: session.id,
            methodID: targetMethodID,
            verifierSessionIDs,
            idleVerifierSessionIDs,
          })
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
      const executionParts = toolParts.filter((part) => part.tool === "econometrics_execute")
      const preparationParts = toolParts.filter((part) => part.tool === "analysis_prepare")
      const methodParts = [...preparationParts, ...executionParts]
      const targetMethodParts = methodParts.filter((part) => methodIDFromToolPart(part) === targetMethodID)
      const initialMethodParts = methodParts.filter((part) => methodIDFromToolPart(part) === input.methodID)
      const targetExecutions = executionParts.filter((part) => methodIDFromToolPart(part) === targetMethodID)
      const targetPreparations = preparationParts.filter((part) => methodIDFromToolPart(part) === targetMethodID)
      const targetPart = input.expectEstimate
        ? [...targetExecutions].reverse().find((part) => completedPayload(part)?.success === true) ??
          targetExecutions.at(-1) ?? targetPreparations.at(-1)
        : [...targetPreparations].reverse().find((part) =>
            part.state.status === "completed" && part.state.metadata.requiresUserDecision === true,
          ) ?? targetPreparations.at(-1) ?? targetExecutions.at(-1)
      const decisionPart = initialMethodParts.find((part) => part.state.status === "completed" && part.state.metadata.requiresUserDecision === true)
      const alternativePart = methodParts.find((part) =>
        part !== targetPart && (methodIDFromToolPart(part) === "ols_regression" || part.state.input?.specId === "spec_unprepared_silent_ols"),
      )
      const expectedPreprocess = input.preprocessAfterUserResponse
      const preprocessPart = toolParts.find((part) => part.tool === "data_preprocess" && part.state.input?.method === expectedPreprocess?.method)
      const preprocessPayload = preprocessPart ? completedPayload(preprocessPart) : undefined
      if (!targetPart) {
        const observed = toolParts.map((part) => {
          const state = part.state
          const output = state.status === "completed"
            ? state.output.slice(0, 240)
            : state.status === "error"
              ? String(state.error).slice(0, 240)
              : ""
          return `${part.tool}[${String(methodIDFromToolPart(part) ?? state.input?.action ?? state.input?.specId ?? "")}]:${state.status}:decision=${String(state.status === "completed" ? state.metadata.requiresUserDecision : false)}:${output}`
        }).join(" | ")
        throw new Error(`没有记录目标方法 ${targetMethodID} 调用；textOnlyRounds=${textOnlyRounds}；requested=${requestedTools.join(",")}; tools=${observed || "none"}; assistant=${assistantText(messages).slice(-500)}`)
      }
      const targetPayload = completedPayload(targetPart)
      const failedMethodPart = methodParts.find((part) => part.state.status === "error")
      const artifactPaths = targetMethodID === "psm_matching" || targetMethodID === "psm_ipw"
        ? [targetPayload?.resultPath]
        : targetMethodID === "psm_regression" || targetMethodID === "psm_double_robust"
          ? [targetPayload?.resultPath, targetPayload?.diagnostics_path, targetPayload?.output_path]
          : [targetPayload?.resultPath, targetPayload?.coefficientsPath]
      const existingArtifactPaths = artifactPaths
        .filter((value): value is string => typeof value === "string")
      const importPart = toolParts.find((part) => part.tool === "data_import" && part.state.input?.action === "import" && part.state.status === "completed")
      if (!importPart || importPart.state.status !== "completed") throw new Error("真实 did.xlsx 未完成导入")
      const datasetId = importPart.state.metadata.datasetId
      const manifest = typeof datasetId === "string" ? readDatasetManifest(datasetId) : undefined

      return {
        requestedTools,
        preflightMethodIDs,
        requiredMethodReminderCount: messages
          .filter((message) => message.info.role === "user")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.TextPart =>
            part.type === "text" && part.synthetic === true && part.text.includes("用户本轮明确要求逐一执行"),
          )
          .length,
        stableTools,
        targetMethodID,
        targetPart,
        targetPayload,
        analysisLifecycle: RuntimeTaskLedger.listTasks(session.id).tasks
          .find((item) => item.taskId === RuntimeTaskLedger.listTasks(session.id).activeTaskId)?.analysisLifecycle,
        analysisLifecycleEvents: RuntimeTaskLedger.listTasks(session.id).tasks
          .find((item) => item.taskId === RuntimeTaskLedger.listTasks(session.id).activeTaskId)?.timeline
          .filter((event) => event.kind === "analysis.lifecycle")
          .map((event) => event.metadata?.eventType),
        alternativePart,
        decisionPart,
        preprocessPart,
        preprocessPayload,
        methodPartCount: methodParts.length,
        mainModelRounds: mainRound,
        textOnlyRounds,
        textOnlyAtRounds,
        finalModelInputText,
        modelInputBeforeMethodExecute,
        repairTurnInputText,
        failedMethodPart,
        verifierSessionCount: verifierSessionIDs.size,
        executedMethodIDs: engineExecute.mock.calls.map(([request]) => request.method_id),
        artifactsExist: existingArtifactPaths.length === artifactPaths.length &&
          existingArtifactPaths.every((artifact) => fs.existsSync(path.resolve(root, artifact))),
        visibleText: assistantText(messages),
        fallbackReasons: messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.TextPart => part.type === "text")
          .map((part) => part.metadata?.fallbackReason)
          .filter((reason): reason is string => typeof reason === "string"),
        manifestStages: manifest?.stages.map((stage) => stage.stageId),
      }
    } })
  } finally {
    await Instance.disposeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("真实数据的方法与数据兼容决策", () => {
  const bcgWlsCsvSource = path.resolve(import.meta.dir, "../../../killstata-econometrics-engine/tests/fixtures/metafor_bcg_wls.csv")
  const cardKruegerCsvSource = process.env.KILLSTATA_TEST_CARD_KRUEGER_CSV?.trim()
    ?? path.resolve(import.meta.dir, "../../../killstata-econometrics-engine/tests/fixtures/card_krueger_public_long.csv")
  const nswPsmCsvSource = path.resolve(import.meta.dir, "../../../killstata-econometrics-engine/tests/fixtures/nsw_dw_analysis.csv")
  const fuzzyRddSource = process.env.KILLSTATA_TEST_ANGRIST_LAVY_FINAL4_DTA?.trim()
    ?? path.resolve(import.meta.dir, "../../../../test/data/angrist-lavy-final4.dta")

  test.skipIf(!hasLocalRealData("did.xlsx"))("真实交错处理面板误用传统 DID 时先要求研究者决策，不执行估计或同批 OLS", async () => {
    const result = await runRealMethodScenario({
      methodID: "did_static",
      dependentVar: "创新指数",
      userText: "我确认 did.xlsx 中 time 是各地区首次处理年份，缺失代表从未处理，did 表示该地区在该年份已经受处理。请用传统两组两期 DID，按 groupVar=time、postVar=did 估计创新指数。请勿自动把时间 cohort 转成 treated/post、选择政策切点、筛年份或换成其他估计量；若该设计不匹配，请给出数据依据并等我决定。",
      arguments: {
        dependentVar: "创新指数",
        groupVar: "time",
        postVar: "did",
        covariates: [],
        covariance: "HC1",
      },
      addSilentOlsAlternative: true,
      expectEstimate: false,
      dataFileName: "did.xlsx",
      sheetName: "Data_可读",
    })

    expect(result.requestedTools).toContain("data_import:import")
    expect(result.requestedTools).toContain("data_import:profile")
    expect(result.requestedTools).toContain("data_import:validate")
    expect(result.requestedTools).toContain("tool_search:did_static")
    expect(result.requestedTools).toContain("analysis_prepare:did_static")
    expect(result.requestedTools).not.toContain("econometrics_execute:did_static")
    expect(result.requestedTools).toContain("econometrics_execute:ols_regression-silent-alternative")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("did_static")
    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.targetPart.state.metadata.result).toBeUndefined()
      expect(result.targetPart.state.output).toContain("time")
      expect(result.targetPart.state.output).toContain("did")
      expect(result.targetPart.state.output).toMatch(/二元|0 和 1|四格|两组两期/)
      expect(result.targetPart.state.output).not.toContain("独立核验未通过")
      expect(result.targetPart.state.output).not.toContain("估计结果保留")
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierStatus).toBeUndefined()
      expect(result.targetPart.state.metadata.verifierRequired).not.toBe(true)
      expect(result.targetPart.state.metadata.repairOnly).toBe(true)
      expect(result.targetPart.state.output).toContain("若“time”表示各单位首次处理时期")
      expect(result.targetPart.state.output).toContain("统一的政策前/后列")
      expect(result.targetPart.state.metadata.preflightStatus).toBe("requires_user_decision")
      expect(result.targetPart.state.metadata.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "DID_GROUP_NOT_BINARY",
          evidence: expect.objectContaining({ column: "time", missingRows: 3043, observedValueCount: 3 }),
        }),
      ]))
    }
    expect(result.methodPartCount).toBe(2)
    expect(result.mainModelRounds).toBe(6)
    expect(result.verifierSessionCount).toBe(0)
    expect(result.alternativePart?.state.status).not.toBe("completed")
    expect(result.executedMethodIDs).not.toContain("did_static")
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(false)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).toContain("本轮已暂停")
    expect(result.visibleText).toContain("time")
    expect(result.visibleText).toContain("did")
    expect(result.visibleText).toMatch(/确认|选择|不能自动|不会自动/)
    expect(result.visibleText).not.toContain("独立核验未通过")
    expect(result.visibleText).not.toContain("估计结果保留")
    expect(result.visibleText).not.toContain("did_static 已完成")
    expect(result.visibleText).not.toContain("ols_regression 已完成")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  test("官方 Card-Krueger 数据的 2×2 DID 计算经稳定工具链完整完成", async () => {
    const result = await runRealMethodScenario({
      methodID: "did_static",
      dependentVar: "fte",
      userText: "请对这份来自 David Card 官方数据页的两波快餐店调查派生数据，按 treated 与波次 t 做传统 2×2 DID：因变量 fte，控制变量 kfc、roys、wendys，使用 HC1。fte 按公开 SAS 程序的就业公式派生，保留各波可用观测（N=794）。这只验证所给样本上的 2×2 计算链路，不是论文 Table 4 原样复现，也不验证平行趋势、组内相关或因果识别；原始 sheet 号有重复，不要把它当成唯一单位。",
      arguments: {
        dependentVar: "fte",
        groupVar: "treated",
        postVar: "t",
        covariates: ["kfc", "roys", "wendys"],
        covariance: "HC1",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      sourceFilePath: cardKruegerCsvSource,
      finalAssistantText: "本次估计不验证政策前趋势、店铺内误差相关或因果识别，也不等同于论文原表复现。",
    })

    expect(result.requestedTools).toContain("data_import:import")
    expect(result.requestedTools).toContain("data_import:profile")
    expect(result.requestedTools).toContain("data_import:validate")
    expect(result.requestedTools).toContain("tool_search:did_static")
    expect(result.requestedTools).toContain("analysis_prepare:did_static")
    expect(result.requestedTools).toContain("econometrics_execute:did_static")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("did_static")
    expect(result.targetPart.state.status).toBe("completed")
    expect(result.analysisLifecycle).toMatchObject({
      status: "completed",
      requestKind: "estimate",
      methodID: "did_static",
      resultContractStatus: "pass",
    })
    expect(result.analysisLifecycle?.verifierStatus).toBe("warn")
    expect(result.analysisLifecycle?.specId).toMatch(/^spec_/)
    expect(result.analysisLifecycleEvents).toContain("diagnosis_started")
    expect(result.analysisLifecycleEvents).toContain("diagnosis_completed")
    if (result.targetPart.state.status === "completed") {
      expect((result.targetPart.state.input as Record<string, unknown>)?.specId).toMatch(/^spec_/)
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.output).not.toContain("状态：待核验")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.rowsUsed).toBe(794)
    const primary = result.targetPayload?.primary as Record<string, unknown> | undefined
    expect(Number(primary?.estimate)).toBeCloseTo(2.813975, 4)
    expect(Number(primary?.stdError)).toBeCloseTo(1.577855, 4)
    expect(result.executedMethodIDs.filter((methodID) => methodID === "did_static")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.verifierSessionCount).toBe(1)
    expect(result.mainModelRounds).toBe(6)
    expect(result.textOnlyRounds).toBeGreaterThan(0)
    expect(result.visibleText).toContain("本次估计不验证政策前趋势、店铺内误差相关或因果识别")
    expect(result.visibleText).toContain("不等同于论文原表复现")
    expect(result.visibleText).toContain("N=794")
    expect(result.visibleText).not.toContain("did_static")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 30_000)

  test.skipIf(!hasLocalRealData("gf.xlsx"))("真实 gf.xlsx 的完全共线 OLS 停在可解释的用户决策点，不执行估计或静默 OLS", async () => {
    const result = await runRealMethodScenario({
      methodID: "ols_regression",
      dependentVar: "绿色金融指数",
      userText: "请用 OLS 做描述性回归，因变量=绿色金融指数，核心解释变量=绿色信贷，控制变量=绿色投资、绿色保险、绿色债券、绿色支持、绿色基金、绿色权益。只报告统计关系，不作因果解释；如果变量之间有完全线性依赖，先说明问题并让我决定，不要自动删列、换变量或改做其他分析。",
      arguments: {
        dependentVar: "绿色金融指数",
        treatmentVar: "绿色信贷",
        covariates: ["绿色投资", "绿色保险", "绿色债券", "绿色支持", "绿色基金", "绿色权益"],
        covariance: "HC1",
      },
      addSilentOlsAlternative: true,
      expectEstimate: false,
      dataFileName: "gf.xlsx",
      sheetName: "Sheet1",
    })

    expect(result.requestedTools).toContain("data_import:import")
    expect(result.requestedTools).toContain("data_import:profile")
    expect(result.requestedTools).toContain("data_import:validate")
    expect(result.requestedTools).toContain("tool_search:ols_regression")
    expect(result.requestedTools).toContain("analysis_prepare:ols_regression")
    expect(result.requestedTools).not.toContain("econometrics_execute:ols_regression")
    expect(result.requestedTools).toContain("econometrics_execute:ols_regression-silent-alternative")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("ols_regression")
    expect(result.targetPart.state.status).toBe("completed")
    expect(result.analysisLifecycle).toMatchObject({
      status: "waiting_user",
      requestKind: "estimate",
      methodID: "ols_regression",
    })
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.targetPart.state.metadata.result).toBeUndefined()
      expect(result.targetPart.state.output).toContain("绿色信贷 = 绿色投资 + 绿色保险 + 绿色债券 + 绿色支持")
      expect(result.targetPart.state.output).toContain("设计矩阵秩亏，无法唯一识别系数")
      expect(result.targetPart.state.output).toMatch(/确认|需要你确认/)
    }
    expect(result.methodPartCount).toBe(2)
    expect(result.mainModelRounds).toBe(6)
    expect(result.alternativePart?.state.status).not.toBe("completed")
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(false)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).toContain("本轮已暂停")
    expect(result.targetPart.state.status === "completed" ? result.targetPart.state.output : "")
      .toContain("保留核心变量并移除共线控制变量：会改变控制变量集合，必须确认研究含义")
    expect(result.visibleText).toContain("本轮已暂停")
    expect(result.visibleText).toContain("请根据上方的具体诊断选择下一步")
    expect(result.visibleText).not.toContain("OLS 回归已完成")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("二元因变量满足条件时完成真实 Logit 并交付概率尺度平均边际效应", async () => {
    const result = await runRealMethodScenario({
      methodID: "logit_regression",
      dependentVar: "did",
      userText: "请仅保留 year=2021 的横截面。用 Logit 分析地区是否属于曾处理组，因变量=did，核心解释变量=创新指数，控制变量=人口规模、人口密度、城镇化水平。只描述样本内关联，不把 2021 年特征称作处理前变量，也不作因果解释。",
      arguments: {
        dependentVar: "did",
        treatmentVar: "创新指数",
        covariates: ["人口规模", "人口密度", "城镇化水平"],
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      filterYear: 2021,
      finalAssistantText: "已完成 2021 年地区是否属于曾处理组的 Logit 描述性分析。结果只作样本内关联，不作因果解释。",
    })

    expect(result.requestedTools).toContain("data_preprocess:filter-year-2021")
    expect(result.requestedTools).toContain("tool_search:logit_regression")
    expect(result.requestedTools).toContain("analysis_prepare:logit_regression")
    expect(result.requestedTools).toContain("econometrics_execute:logit_regression")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("logit_regression")
    expect(result.targetPart.state.status).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.metadata.stageId).toBe("stage_001")
      expect(result.targetPart.state.output).toContain("平均边际效应（概率尺度）")
      expect(result.targetPart.state.output).toContain("对数几率尺度")
      expect(result.targetPart.state.output).toContain("McFadden 伪 R²")
      expect(result.targetPart.state.metadata.analysisView?.conclusion).toContain("统计关联")
      expect(result.targetPart.state.metadata.analysisView?.conclusion).toContain("不自动构成因果效应")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.method).toBe("logit_regression")
    expect(result.targetPayload?.rowsUsed).toBe(277)
    const pseudoRSquared = result.targetPayload?.pseudoRSquared
    expect(typeof pseudoRSquared).toBe("number")
    if (typeof pseudoRSquared === "number") {
      expect(Number.isFinite(pseudoRSquared)).toBe(true)
      expect(result.visibleText).toContain(`McFadden 伪 R²=${pseudoRSquared.toFixed(4)}`)
    }
    const primary = result.targetPayload?.primary as Record<string, unknown> | undefined
    const primaryMarginalEffect = result.targetPayload?.primaryMarginalEffect as Record<string, unknown> | undefined
    expect(Number(primary?.estimate)).toBeCloseTo(-2.382415, 5)
    expect(Number(primaryMarginalEffect?.estimate)).toBeCloseTo(-0.535699, 5)
    const metrics = result.targetPart.state.status === "completed"
      ? result.targetPart.state.metadata.analysisView?.results
      : undefined
    expect(metrics).toContainEqual({ label: "核心解释变量平均边际效应（概率尺度）", value: "-0.5357", visibility: undefined })
    expect(result.executedMethodIDs.filter((methodID) => methodID === "logit_regression")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000", "stage_001"])
    expect(result.visibleText).toContain("平均边际效应")
    expect(result.visibleText).toContain("核心解释变量平均边际效应（概率尺度）=-0.5357")
    expect(result.visibleText).toContain("控制变量平均边际效应（概率尺度）")
    expect(result.visibleText).toContain("N=277")
    expect(result.visibleText).toContain("McFadden 伪 R²")
    expect(result.visibleText).not.toContain("logit_regression")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("真实 Logit 只留下进度提示时，TurnAssembler 用结构化摘要兜底", async () => {
    const result = await runRealMethodScenario({
      methodID: "logit_regression",
      dependentVar: "did",
      userText: "请仅保留 year=2021 的横截面。用 Logit 描述地区是否属于曾处理组与创新指数、人口规模、人口密度、城镇化水平之间的关联。因变量=did，核心解释变量=创新指数，控制变量=人口规模、人口密度、城镇化水平。不作因果解释。",
      arguments: {
        dependentVar: "did",
        treatmentVar: "创新指数",
        covariates: ["人口规模", "人口密度", "城镇化水平"],
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      filterYear: 2021,
      finalAssistantText: "Logit 已估计完成，正在整理分析结果。",
    })

    expect(result.targetPart.state.status).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.metadata.stageId).toBe("stage_001")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.rowsUsed).toBe(277)
    const pseudoRSquared = result.targetPayload?.pseudoRSquared
    expect(typeof pseudoRSquared).toBe("number")
    if (typeof pseudoRSquared === "number") {
      expect(result.visibleText).toContain(`McFadden 伪 R²=${pseudoRSquared.toFixed(4)}`)
    }
    expect(result.fallbackReasons).toContain("incomplete_visible_analysis_result_text")
    expect(result.visibleText).toContain("结果：")
    expect(result.visibleText).toContain("核心解释变量平均边际效应（概率尺度） -0.5357")
    expect(result.visibleText).toContain("控制变量平均边际效应（概率尺度）")
    expect(result.visibleText).toContain("N=277")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("真实二元结果用 Probit 完成动态搜索、估计与潜变量尺度交付", async () => {
    const result = await runRealMethodScenario({
      methodID: "probit_regression",
      dependentVar: "did",
      userText: "请仅保留 year=2021 的横截面。用 Probit 描述地区是否属于曾处理组与创新指数、人口规模、人口密度、城镇化水平之间的关联。因变量=did，核心解释变量=创新指数，控制变量=人口规模、人口密度、城镇化水平。2021 特征位于处理之后，只作描述性关联，不作因果解释。",
      arguments: {
        dependentVar: "did",
        treatmentVar: "创新指数",
        covariates: ["人口规模", "人口密度", "城镇化水平"],
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      filterYear: 2021,
      finalAssistantText: "已完成 2021 年 Probit 描述性分析。结果只作样本内关联，不作因果推断。",
    })

    expect(result.requestedTools).toContain("data_preprocess:filter-year-2021")
    expect(result.requestedTools).toContain("tool_search:probit_regression")
    expect(result.requestedTools).toContain("analysis_prepare:probit_regression")
    expect(result.requestedTools).toContain("econometrics_execute:probit_regression")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("probit_regression")
    expect(result.targetPart.state.status).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.metadata.stageId).toBe("stage_001")
      expect(result.targetPart.state.output).toContain("潜变量尺度")
      expect(result.targetPart.state.output).toContain("平均边际效应（概率尺度）")
      expect(result.targetPart.state.metadata.analysisView?.conclusion).toContain("不自动构成因果效应")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.method).toBe("probit_regression")
    expect(result.targetPayload?.rowsUsed).toBe(277)
    expect(result.targetPayload?.covariance).toBe("HC1")
    const primary = result.targetPayload?.primary as Record<string, unknown> | undefined
    const primaryMarginalEffect = result.targetPayload?.primaryMarginalEffect as Record<string, unknown> | undefined
    expect(Number(primary?.estimate)).toBeCloseTo(-1.461087, 5)
    expect(Number(primaryMarginalEffect?.estimate)).toBeCloseTo(-0.536122, 5)
    expect(Number(result.targetPayload?.pseudoRSquared)).toBeCloseTo(0.01246, 4)
    const metrics = result.targetPart.state.status === "completed"
      ? result.targetPart.state.metadata.analysisView?.results
      : undefined
    expect(metrics).toContainEqual({ label: "创新指数 潜变量系数", value: "-1.4611", visibility: undefined })
    expect(metrics).toContainEqual({ label: "核心解释变量平均边际效应（概率尺度）", value: "-0.5361", visibility: undefined })
    expect(result.executedMethodIDs.filter((methodID) => methodID === "probit_regression")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("logit_regression")
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000", "stage_001"])
    expect(result.visibleText).toContain("潜变量系数")
    expect(result.visibleText).toContain("平均边际效应")
    expect(result.visibleText).not.toContain("对数几率系数")
    expect(result.visibleText).not.toContain("probit_regression")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("连续因变量不能直接用于 Logit，阻断同批静默切换为 OLS", async () => {
    const result = await runRealMethodScenario({
      methodID: "logit_regression",
      dependentVar: "创新指数",
      userText: "我明确要求 Logit，因变量=创新指数，核心解释变量=did。",
      arguments: { dependentVar: "创新指数", treatmentVar: "did", covariates: [], covariance: "robust" },
      addSilentOlsAlternative: true,
      expectEstimate: false,
    })

    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision, JSON.stringify(result.targetPart.state)).toBe(true)
      expect(result.targetPart.state.output).toContain("不是已验证的 0/1 二元变量")
      expect(result.targetPart.state.metadata.result).toBeUndefined()
    }
    expect(result.alternativePart?.state.status).not.toBe("completed")
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).toContain("本轮已暂停")
    expect(result.visibleText).not.toContain("面板回归")
    expect(result.visibleText).not.toContain("Logit 回归已完成")
    expect(result.visibleText).not.toContain("ols_regression 已完成")
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("负值连续结果不能用于 Poisson/PPML，阻断同批静默切换", async () => {
    const result = await runRealMethodScenario({
      methodID: "poisson_regression",
      dependentVar: "产业结构合理化",
      userText: "我明确要求 Poisson 回归，因变量=产业结构合理化，核心解释变量=did。",
      arguments: { dependentVar: "产业结构合理化", treatmentVar: "did", covariates: [], covariance: "robust" },
      addSilentOlsAlternative: true,
      expectEstimate: false,
    })

    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.targetPart.state.output).toMatch(/非负|Poisson|PPML/)
      expect(result.targetPart.state.metadata.result).toBeUndefined()
    }
    expect(result.alternativePart?.state.status).not.toBe("completed")
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).toContain("本轮已暂停")
    expect(result.visibleText).not.toContain("面板回归")
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("连续非负结果按 PPML 兼容 Poisson，而不被误判为必须整数计数", async () => {
    const result = await runRealMethodScenario({
      methodID: "poisson_regression",
      dependentVar: "创新指数",
      userText: "请用 Poisson/PPML 估计连续非负的创新指数对 did 的条件均值关系。",
      arguments: { dependentVar: "创新指数", treatmentVar: "did", covariates: [], covariance: "robust" },
      addSilentOlsAlternative: false,
      expectEstimate: true,
    })

    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
    }
    expect(result.targetPayload?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("PPML")]))
    expect(result.targetPayload?.rowsUsed).toBeGreaterThan(4_000)
    expect(result.visibleText).toContain("Poisson/PPML")
    expect(result.manifestStages).toEqual(["stage_000"])
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("WLS 找不到真实权重列时作为用户决策停止，不自动构造权重或换 OLS", async () => {
    const result = await runRealMethodScenario({
      methodID: "wls_regression",
      dependentVar: "创新指数",
      userText: "我明确要求 WLS，因变量=创新指数，核心解释变量=did；我没有指定过任何观测权重。",
      arguments: { dependentVar: "创新指数", treatmentVar: "did", covariates: [], weightsVar: "权重", covariance: "robust" },
      addSilentOlsAlternative: true,
      expectEstimate: false,
    })

    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.targetPart.state.output).toContain("权重")
      expect(result.targetPart.state.output).toMatch(/不存在|找不到|确认/)
      expect(result.targetPart.state.metadata.result).toBeUndefined()
    }
    expect(result.alternativePart?.state.status).not.toBe("completed")
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).toContain("本轮已暂停")
    expect(result.visibleText).not.toContain("面板回归")
    expect(result.visibleText).not.toContain("ols_regression 已完成")
  }, 20_000)

  test("metafor BCG 研究的逆方差权重经稳定 WLS AgentLoop 完成", async () => {
    const result = await runRealMethodScenario({
      methodID: "wls_regression",
      dependentVar: "yi",
      sourceFilePath: bcgWlsCsvSource,
      userText: "请先检查随文件提供的 metafor BCG 13 项研究数据是否有缺失和异常值，不要自动清洗；检查后运行 WLS 做固定效应加权线性 meta-regression：yi 是每项研究的 log risk ratio，ablat 是研究地点绝对纬度，precision_weight 已按 1/vi 构造且 vi 是对应的研究内采样方差。请用 robust（HC1）协方差，报告纬度系数、N、权重范围和协方差口径。只描述纳入研究内的加权关联，不估计随机效应 tau²，不作因果解释。",
      arguments: {
        dependentVar: "yi",
        treatmentVar: "ablat",
        covariates: [],
        weightsVar: "precision_weight",
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      finalAssistantText: "已完成基于研究内采样方差倒数的加权最小二乘（WLS）meta-regression，并报告 HC1 结果；这不是随机效应模型，也不作因果解释。",
    })

    const primary = result.targetPayload?.primary as Record<string, unknown> | undefined
    const weightSummary = result.targetPayload?.weightSummary as Record<string, unknown> | undefined
    expect(result.requestedTools).toEqual([
      "data_import:import",
      "data_import:profile",
      "data_import:validate",
      "tool_search:wls_regression",
      "analysis_prepare:wls_regression",
      "econometrics_execute:wls_regression",
    ])
    expect(result.modelInputBeforeMethodExecute).toContain("逆误差方差")
    expect(result.modelInputBeforeMethodExecute).toContain("抽样权重")
    expect(result.modelInputBeforeMethodExecute).toContain("covariance")
    expect(result.executedMethodIDs.filter((methodID) => methodID === "wls_regression")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.targetPart.state.status).toBe("completed")
    expect(result.targetPayload?.rowsUsed).toBe(13)
    expect(primary?.term).toBe("ablat")
    expect(Number(primary?.estimate)).toBeCloseTo(-0.0292369342595, 10)
    expect(Number(primary?.stdError)).toBeCloseTo(0.00440722210737, 10)
    expect(result.targetPayload?.covariance).toBe("HC1")
    expect(Number(weightSummary?.minWeight)).toBeCloseTo(1.877913658627, 10)
    expect(Number(weightSummary?.maxWeight)).toBeCloseTo(252.424582426220, 10)
    expect(result.artifactsExist).toBe(true)
    expect(result.verifierSessionCount).toBeGreaterThan(0)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.finalModelInputText).toContain("-0.029236934")
    expect(result.finalModelInputText).toContain("13")
    expect(result.finalModelInputText).toContain("HC1")
    expect(result.visibleText).toContain("加权最小二乘")
    expect(result.visibleText).toContain("HC1")
    expect(result.visibleText).not.toContain("wls_regression")
  }, 30_000)

  test("WLS 权重列误传后经用户确认在同一会话恢复真实估计", async () => {
    const result = await runRealMethodScenario({
      methodID: "wls_regression",
      dependentVar: "yi",
      sourceFilePath: bcgWlsCsvSource,
      userText: "请对随文件提供的 metafor BCG 13 项研究数据做 WLS meta-regression：yi 对 ablat，权重列 precision_weight 已按 1/vi 构造，vi 是研究内采样方差，使用 robust（HC1）。保留 13 项研究，不作因果解释。",
      arguments: {
        dependentVar: "yi",
        treatmentVar: "ablat",
        covariates: [],
        weightsVar: "weight",
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      followupMethodID: "wls_regression",
      followupArguments: {
        dependentVar: "yi",
        treatmentVar: "ablat",
        covariates: [],
        weightsVar: "precision_weight",
        covariance: "robust",
      },
      followupUserMessage: "我确认当前数据中的 precision_weight 是 vi 的倒数，按此真实列继续同一 WLS 规格；不要改样本或估计量。",
      finalAssistantText: "已按你确认的精度权重列完成 WLS meta-regression，保留全部 13 项研究并使用 HC1；结果只描述样本内加权关联。",
    })

    expect(result.requestedTools).toEqual([
      "data_import:import",
      "data_import:profile",
      "data_import:validate",
      "tool_search:wls_regression",
      "analysis_prepare:wls_regression",
      "tool_search:wls_regression",
      "analysis_prepare:wls_regression",
      "econometrics_execute:wls_regression",
    ])
    expect(result.decisionPart?.state.status).toBe("completed")
    if (result.decisionPart?.state.status === "completed") {
      expect(result.decisionPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.decisionPart.state.output).toContain("weight")
      expect(result.decisionPart.state.metadata.result).toBeUndefined()
    }
    expect(result.methodPartCount).toBe(3)
    expect(result.targetPart.state.status).toBe("completed")
    expect(result.analysisLifecycle).toMatchObject({
      status: "completed",
      requestKind: "estimate",
      methodID: "wls_regression",
      resultContractStatus: "pass",
    })
    expect(result.analysisLifecycle?.verifierStatus).toBe("warn")
    expect(result.targetPayload?.rowsUsed).toBe(13)
    expect(Number((result.targetPayload?.primary as Record<string, unknown> | undefined)?.estimate))
      .toBeCloseTo(-0.0292369342595, 10)
    expect(result.targetPayload?.covariance).toBe("HC1")
    expect(result.executedMethodIDs.filter((methodID) => methodID === "wls_regression")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.verifierSessionCount).toBeGreaterThan(0)
    expect(result.finalModelInputText).toContain("precision_weight")
    expect(result.finalModelInputText).toContain("-0.029236934")
    expect(result.visibleText).toContain("本轮已暂停")
    expect(result.visibleText).toContain("已按你确认的精度权重列完成 WLS")
  }, 30_000)

  test("BCG 样本的零 WLS 权重在估计前要求用户决定并阻断同批 OLS", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-wls-zero-weight-"))
    const invalidSource = path.join(temporaryRoot, "metafor_bcg_zero_weight.csv")
    try {
      const original = fs.readFileSync(bcgWlsCsvSource, "utf8")
      const invalid = original.replace(
        "44,-0.889311333920,0.325584765004,3.071396783531",
        "44,-0.889311333920,0.325584765004,0",
      )
      if (invalid === original) throw new Error("没有找到预期的 BCG 研究权重行")
      fs.writeFileSync(invalidSource, invalid, "utf8")

      const result = await runRealMethodScenario({
        methodID: "wls_regression",
        dependentVar: "yi",
        sourceFilePath: invalidSource,
        userText: "对这份 BCG 研究数据执行 WLS，yi 对 ablat，precision_weight 是已确认的 1/vi。若权重列不满足 WLS 前提，请说明并等待我决定；不要替我删除观测或改跑 OLS。",
        arguments: {
          dependentVar: "yi",
          treatmentVar: "ablat",
          covariates: [],
          weightsVar: "precision_weight",
          covariance: "robust",
        },
        addSilentOlsAlternative: true,
        expectEstimate: false,
      })

      expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
      if (result.targetPart.state.status === "completed") {
        expect(result.targetPart.state.metadata.requiresUserDecision).toBe(true)
        expect(result.targetPart.state.metadata.result).toBeUndefined()
        expect(result.targetPart.state.output).toContain("权重")
        expect(result.targetPart.state.output).toContain("严格为正")
      }
      expect(result.executedMethodIDs).not.toContain("wls_regression")
      expect(result.executedMethodIDs).not.toContain("ols_regression")
      expect(result.alternativePart?.state.status).not.toBe("completed")
      expect(result.artifactsExist).toBe(false)
      expect(result.manifestStages).toEqual(["stage_000"])
      expect(result.visibleText).toContain("本轮已暂停")
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }, 30_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("面板重复地区不能直接当成 PSM 独立单位，停在用户决策点", async () => {
    const result = await runRealMethodScenario({
      methodID: "psm_matching",
      dependentVar: "创新指数",
      userText: "我希望使用整个 2005—2021 面板按地区做倾向得分最近邻匹配（PSM matching），结果变量=创新指数，处理变量=did，协变量=人口规模；不要替我选择年份或做聚合，若面板结构不适配请先说明需要我决定什么。",
      arguments: {
        dependentVar: "创新指数",
        treatmentVar: "did",
        analysisUnitVar: "地区",
        preTreatmentAggregation: "not_applicable",
        covariates: ["人口规模"],
      },
      addSilentOlsAlternative: true,
      expectEstimate: false,
    })

    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.targetPart.state.metadata.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "DATA_ANALYSIS_UNIT_NOT_UNIQUE" }),
      ]))
      expect(result.targetPart.state.output).toMatch(/分析单位|重复|一行/)
      expect(result.targetPart.state.metadata.result).toBeUndefined()
    }
    expect(result.alternativePart?.state.status).not.toBe("completed")
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).toContain("本轮已暂停")
    expect(result.visibleText).not.toContain("psm_matching 已完成")
    expect(result.visibleText).not.toContain("ols_regression 已完成")
  }, 20_000)

  test.skipIf(!fs.existsSync(nswPsmCsvSource))("官方 NSW Dehejia-Wahba 样本经完整 AgentLoop 成功完成 PSM matching ATT", async () => {
    const result = await runRealMethodScenario({
      methodID: "psm_matching",
      dependentVar: "re78",
      userText: "请用这份官方 Dehejia-Wahba NSW 实验样本复现倾向得分最近邻匹配 ATT：结果=re78（1978 年收入），处理=treat，分析单位=unit_id。协变量 age、age_squared（age 的平方）、education、black、hispanic、nodegree 都是处理前特征；这是一人一行，不需要面板聚合。请报告匹配数、未匹配数和匹配后最大绝对 SMD，不要报告显著性推断。只把它作为这个实验样本上的 PSM 数值/工具链基准，不推广为观察性样本的因果结论。",
      arguments: {
        dependentVar: "re78",
        treatmentVar: "treat",
        analysisUnitVar: "unit_id",
        preTreatmentAggregation: "not_applicable",
        covariates: ["age", "age_squared", "education", "black", "hispanic", "nodegree"],
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      sourceFilePath: nswPsmCsvSource,
      finalAssistantText: "已完成 NSW 样本的最近邻 PSM：ATT=2195.2183；185/185 名处理组均匹配，未匹配 0；匹配后最大绝对 SMD=0.0474（阈值 0.10）。本工具不提供标准误、p 值或置信区间；此结果仅为该实验样本上的工具与匹配基准。",
    })

    expect(result.requestedTools).toContain("data_import:import")
    expect(result.requestedTools).toContain("data_import:profile")
    expect(result.requestedTools).toContain("data_import:validate")
    expect(result.requestedTools).toContain("tool_search:psm_matching")
    expect(result.requestedTools).toContain("analysis_prepare:psm_matching")
    expect(result.requestedTools).toContain("econometrics_execute:psm_matching")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.targetPart.state.status).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.output).not.toContain("状态：待核验")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.rowsUsed).toBe(445)
    expect(Number(result.targetPayload?.att)).toBeCloseTo(2195.21827556, 5)
    expect(result.targetPayload?.treatedCount).toBe(185)
    expect(result.targetPayload?.controlCount).toBe(260)
    expect(result.targetPayload?.matchedTreatedCount).toBe(185)
    expect(result.targetPayload?.unmatchedTreatedCount).toBe(0)
    expect(result.targetPayload?.reusedControlCount).toBe(35)
    expect(Number(result.targetPayload?.caliper)).toBeCloseTo(0.0732441217, 8)
    expect(Number(result.targetPayload?.preMatchMaxAbsSmd)).toBeCloseTo(0.3039864391, 8)
    expect(Number(result.targetPayload?.postMatchMaxAbsSmd)).toBeCloseTo(0.0474343524, 6)
    expect(result.targetPayload?.standardError).toBeUndefined()
    expect(result.executedMethodIDs.filter((methodID) => methodID === "psm_matching")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.verifierSessionCount).toBe(1)
    expect(result.mainModelRounds).toBe(6)
    expect(result.textOnlyRounds).toBeGreaterThan(0)
    expect(result.finalModelInputText).toContain("ATT（已匹配处理组）：2195.2183")
    expect(result.finalModelInputText).toContain("未输出标准误、p 值、置信区间或显著性结论")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.output).toContain("ATT（已匹配处理组）：2195.2183")
      expect(result.targetPart.state.output).toContain("匹配后最大绝对 SMD：0.047434")
      expect(result.targetPart.state.output).toContain("未输出标准误、p 值、置信区间或显著性结论")
      const analysisView = result.targetPart.state.metadata.analysisView as Record<string, unknown>
      expect(analysisView.conclusion).toContain("不包含显著性推断")
    }
    expect(result.visibleText).not.toContain("psm_matching 已完成")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  test.skipIf(!fs.existsSync(nswPsmCsvSource))("官方 NSW 样本经完整 AgentLoop 成功完成 PSM IPW Hájek ATE", async () => {
    const result = await runRealMethodScenario({
      methodID: "psm_ipw",
      dependentVar: "re78",
      userText: "请基于这份 NSW 随机就业培训样本估计 PSM IPW 的 Hájek ATE：结果=re78（1978年收入），处理=treat，分析单位=unit_id。age、age_squared（age平方）、education、black、hispanic、nodegree 均为处理前基线协变量；数据已是一人一行，不需要聚合。请报告处理/对照组数、有效样本量、共同支撑和加权后最大绝对 SMD；不报告显著性推断。此结果只作为 NSW 实验样本上的 ATE 工具基准。",
      arguments: {
        dependentVar: "re78",
        treatmentVar: "treat",
        analysisUnitVar: "unit_id",
        preTreatmentAggregation: "not_applicable",
        covariates: ["age", "age_squared", "education", "black", "hispanic", "nodegree"],
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      sourceFilePath: nswPsmCsvSource,
      finalAssistantText: "NSW 样本的固定 Hájek IPW ATE=1630.8240，处理组/对照组 185/260；两组有效样本量约 177.39/253.06，最小/最大 propensity score 约 0.23537/0.63797，加权后最大绝对 SMD=0.00235。未输出标准误、p 值或置信区间。",
    })

    expect(result.requestedTools).toContain("data_import:import")
    expect(result.requestedTools).toContain("tool_search:psm_ipw")
    expect(result.requestedTools).toContain("analysis_prepare:psm_ipw")
    expect(result.requestedTools).toContain("econometrics_execute:psm_ipw")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.targetPart.state.status).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.output).not.toContain("状态：待核验")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.rowsUsed).toBe(445)
    expect(Number(result.targetPayload?.ate)).toBeCloseTo(1630.8240419, 4)
    expect(result.targetPayload?.treatedCount).toBe(185)
    expect(result.targetPayload?.controlCount).toBe(260)
    expect(Number(result.targetPayload?.treatmentEss)).toBeCloseTo(177.3875921, 4)
    expect(Number(result.targetPayload?.controlEss)).toBeCloseTo(253.0581972, 4)
    expect(Number(result.targetPayload?.minPropensityScore)).toBeCloseTo(0.2353724925, 5)
    expect(Number(result.targetPayload?.maxPropensityScore)).toBeCloseTo(0.6379746575, 5)
    expect(Number(result.targetPayload?.maxWeight)).toBeCloseTo(4.2485848286, 4)
    expect(Number(result.targetPayload?.weightedMaxAbsSmd)).toBeCloseTo(0.0023479892, 6)
    expect(result.targetPayload?.standardError).toBeUndefined()
    expect(result.executedMethodIDs.filter((methodID) => methodID === "psm_ipw")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.verifierSessionCount).toBe(1)
    expect(result.mainModelRounds).toBe(6)
    expect(result.textOnlyRounds).toBeGreaterThan(0)
    expect(result.finalModelInputText).toContain("ATE：1630.8240")
    expect(result.finalModelInputText).toContain("未输出标准误、p 值、置信区间或显著性结论")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.output).toContain("ATE：1630.8240")
      expect(result.targetPart.state.output).toContain("有效样本量")
      expect(result.targetPart.state.output).toContain("未输出标准误、p 值、置信区间或显著性结论")
    }
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  for (const scenario of [
    { methodID: "psm_regression" as const, label: "倾向得分回归调整", expectedATE: 1670.7325479778087 },
    { methodID: "psm_double_robust" as const, label: "AIPW 双重稳健", expectedATE: 1612.7369896866358 },
  ]) {
    test.skipIf(!fs.existsSync(nswPsmCsvSource))(`官方 NSW 样本经完整 AgentLoop 成功完成 ${scenario.label} ATE`, async () => {
      const result = await runRealMethodScenario({
        methodID: scenario.methodID,
        dependentVar: "re78",
        userText: `请用这份 NSW 随机就业培训样本执行${scenario.label}并估计 ATE：结果=re78（1978年收入），处理=treat，分析单位=unit_id。age、age_squared（age平方）、education、black、hispanic、nodegree 均为处理前基线协变量；数据是一人一行，不需要聚合。报告 ATE、有效样本量、共同支撑和加权后最大绝对 SMD；不要报告显著性推断。只把本次结果作为 NSW 实验样本上的${scenario.label}工具基准。`,
        arguments: {
          dependentVar: "re78",
          treatmentVar: "treat",
          analysisUnitVar: "unit_id",
          preTreatmentAggregation: "not_applicable",
          covariates: ["age", "age_squared", "education", "black", "hispanic", "nodegree"],
        },
        addSilentOlsAlternative: false,
        expectEstimate: true,
        sourceFilePath: nswPsmCsvSource,
        finalAssistantText: `${scenario.label} ATE=${scenario.expectedATE.toFixed(3)}；处理组/对照组 185/260；有效样本量约 177.39/253.06；加权后 max |SMD|=0.00235。不提供标准误、p 值或置信区间。`,
      })
      const displayedAte = Number(result.targetPayload?.ate).toFixed(4)

      expect(result.requestedTools).toContain(`tool_search:${scenario.methodID}`)
      expect(result.requestedTools).toContain(`analysis_prepare:${scenario.methodID}`)
      expect(result.requestedTools).toContain(`econometrics_execute:${scenario.methodID}`)
      expect(result.stableTools).toContain("econometrics_execute")
      expect(result.targetPart.state.status).toBe("completed")
      if (result.targetPart.state.status === "completed") {
        expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
        expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
        expect(result.targetPart.state.output).not.toContain("状态：待核验")
        expect(result.targetPart.state.output).toContain(`ATE：${displayedAte}`)
        expect(result.targetPart.state.output).toContain("未输出标准误、p 值、置信区间或显著性结论")
      }
      expect(result.targetPayload?.success).toBe(true)
      expect(result.targetPayload?.rowsUsed).toBe(445)
      expect(Number(result.targetPayload?.ate)).toBeCloseTo(scenario.expectedATE, 4)
      expect(result.targetPayload?.treatedCount).toBe(185)
      expect(result.targetPayload?.controlCount).toBe(260)
      expect(Number(result.targetPayload?.treatmentEss)).toBeCloseTo(177.3875921, 4)
      expect(Number(result.targetPayload?.controlEss)).toBeCloseTo(253.0581972, 4)
      expect(Number(result.targetPayload?.weightedMaxAbsSmd)).toBeCloseTo(0.0023479892, 6)
      expect(result.executedMethodIDs.filter((methodID) => methodID === scenario.methodID)).toHaveLength(1)
      expect(result.executedMethodIDs).not.toContain("ols_regression")
      expect(result.artifactsExist).toBe(true)
      expect(result.manifestStages).toEqual(["stage_000"])
      expect(result.verifierSessionCount).toBe(1)
      expect(result.mainModelRounds).toBe(6)
      expect(result.textOnlyRounds).toBeGreaterThan(0)
      expect(result.finalModelInputText).toContain(`ATE：${displayedAte}`)
      expect(result.finalModelInputText).toContain("未输出标准误、p 值、置信区间或显著性结论")
      expect(result.visibleText).not.toContain("datasetId")
      expect(result.visibleText).not.toContain("stageId")
    }, 20_000)
  }

  const rdSenateCsvSource = path.resolve(import.meta.dir, "../../../killstata-econometrics-engine/tests/fixtures/rdrobust_senate.csv")
  test.skipIf(!fuzzyRddSource || !fs.existsSync(fuzzyRddSource))("Angrist–Lavy 真实班级规模非完全服从规则时经模糊 RDD 稳定路由完成", async () => {
    const result = await runRealMethodScenario({
      methodID: "rdd_fuzzy",
      dependentVar: "avgmath",
      userText: "请用 Angrist–Lavy 四年级 Maimonides 规则数据做模糊断点回归：c_size 是年级总注册人数，规则在 40 人处触发增班；实际 classize 可能偏离规则，作为模糊处理变量；结果是 avgmath，cutoff=40，并按学校 schlcode 聚类。请使用 rdrobust 的数据驱动带宽，只报告该阈值附近的局部处理效应与第一阶段跳变，明确聚类范围；这次是可复现的局部基准，不据此声称识别假设已被验证。",
      arguments: {
        dependentVar: "avgmath",
        runningVar: "c_size",
        fuzzyVar: "classize",
        cutoff: 40,
        covariates: [],
        clusterVar: "schlcode",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      sourceFilePath: fuzzyRddSource,
      finalAssistantText: "模糊断点回归已完成：在年级总注册人数 40 人阈值附近，实际班级规模在阈值处并未完全由规则决定；结果为局部处理效应，按学校聚类。该基准复现不验证连续性、排除限制或单调性等识别假设。",
    })

    expect(result.requestedTools).toContain("data_import:import")
    expect(result.requestedTools).toContain("data_import:profile")
    expect(result.requestedTools).toContain("data_import:validate")
    expect(result.requestedTools).toContain("tool_search:rdd_fuzzy")
    expect(result.requestedTools).toContain("analysis_prepare:rdd_fuzzy")
    expect(result.requestedTools).toContain("econometrics_execute:rdd_fuzzy")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("rdd_fuzzy")
    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.output).toContain("模糊断点回归（Fuzzy RDD）已完成")
      expect(result.targetPart.state.output).toContain("第一阶段")
      expect(result.targetPart.state.output).toContain("聚类变量：schlcode")
      expect(result.targetPart.state.output).not.toContain("rdd_fuzzy")
      expect(result.targetPart.state.metadata.analysisView?.conclusion).toContain("单调性")
      expect(result.targetPart.state.metadata.analysisView?.results).toEqual(expect.arrayContaining([
        { label: "局部处理效应", value: "-0.5642" },
        { label: "第一阶段处理跳变", value: "-8.4478" },
        { label: "聚类变量", value: "schlcode" },
        { label: "带宽内聚类簇数", value: "366" },
      ]))
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.method).toBe("rdd_fuzzy")
    expect(result.targetPayload?.rowsInput).toBe(2059)
    expect(result.targetPayload?.rowsUsed).toBe(2055)
    expect(result.targetPayload?.fuzzyVar).toBe("classize")
    expect(result.targetPayload?.clusterVar).toBe("schlcode")
    expect(result.targetPayload?.nClusters).toBe(366)
    expect(Number((result.targetPayload?.bandwidth as Record<string, unknown>)?.h)).toBeCloseTo(9.371987, 4)
    const primary = result.targetPayload?.primary as Record<string, unknown> | undefined
    const firstStage = result.targetPayload?.firstStage as Record<string, unknown> | undefined
    const firstStageRobust = firstStage?.robust as Record<string, unknown> | undefined
    expect(Number(primary?.estimate)).toBeCloseTo(-0.5641996, 5)
    expect(Number(firstStageRobust?.estimate)).toBeCloseTo(-8.447835, 4)
    expect(Number(firstStageRobust?.pValue)).toBeCloseTo(0.036088, 4)
    expect(result.executedMethodIDs.filter((methodID) => methodID === "rdd_fuzzy")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("rdd_sharp")
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.verifierSessionCount).toBe(1)
    expect(result.visibleText).toContain("局部处理效应")
    expect(result.visibleText).toContain("协方差 CR1")
    expect(result.visibleText).toContain("第一阶段处理跳变")
    expect(result.visibleText).not.toContain("识别假设已验证")
    expect(result.visibleText).not.toContain("rdd_fuzzy")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 30_000)

  test("官方 rdrobust Senate CSV 的歧义数值列在估计前形成明确用户决策", async () => {
    const result = await runRealMethodScenario({
      methodID: "rdd_sharp",
      dependentVar: "vote",
      userText: "请执行公开 rdrobust Senate 示例的锐性断点回归（Sharp RDD）：结果变量=vote，运行变量=margin，断点=0，不加控制变量。若 vote 不是数值型，先说明具体数据问题和可逆修复方案；没有我确认缺失标记的语义之前不要转换。",
      arguments: { dependentVar: "vote", runningVar: "margin", cutoff: 0, covariates: [] },
      addSilentOlsAlternative: false,
      expectEstimate: false,
      sourceFilePath: rdSenateCsvSource,
      skipPostImportDiagnostics: true,
      finalAssistantText: "当前数据把 vote 列识别为文本，而 RDD 要求结果变量是数值型。若该列是数字文本，请确认是否转为数值，并明确哪些文本标记代表缺失；系统不会替你猜或删除原始观测。",
    })

    expect(result.requestedTools).toContain("data_import:import")
    expect(result.requestedTools).not.toContain("data_import:profile")
    expect(result.requestedTools).not.toContain("data_import:validate")
    expect(result.requestedTools).toContain("tool_search:rdd_sharp")
    expect(result.requestedTools).toContain("analysis_prepare:rdd_sharp")
    expect(result.requestedTools).not.toContain("econometrics_execute:rdd_sharp")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("rdd_sharp")
    expect(result.targetPart.state.status).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.targetPart.state.metadata.result).toBeUndefined()
      expect(result.targetPart.state.output).toContain("vote")
      expect(result.targetPart.state.output).toContain("数值")
    }
    expect(result.executedMethodIDs).not.toContain("rdd_sharp")
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(false)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.verifierSessionCount).toBe(0)
    expect(result.methodPartCount).toBe(1)
    expect(result.mainModelRounds).toBe(4)
    expect(result.visibleText).toContain("vote")
    expect(result.visibleText).toContain("数值型")
    expect(result.visibleText).toContain("请确认是否转为数值")
    expect(result.visibleText).toContain("确认")
    expect(result.visibleText).not.toContain("RDD 已完成")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  test("用户明确授权数值化 NA 缺失标记后，真实 RDD 经派生阶段恢复并完成", async () => {
    const result = await runRealMethodScenario({
      methodID: "rdd_sharp",
      dependentVar: "vote",
      userText: "请执行公开 rdrobust Senate 示例的锐性断点回归（Sharp RDD）：结果变量=vote，运行变量=margin，断点=0，不加控制变量，按州 state 聚类。若结果列类型与方法要求冲突，请先说明，不要自行重编码。",
      arguments: { dependentVar: "vote", runningVar: "margin", cutoff: 0, covariates: [], clusterVar: "state" },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      sourceFilePath: rdSenateCsvSource,
      followupUserMessage: "我已核对官方数据说明，vote 是后续选举得票率，精确的 NA 表示缺失。请仅将 vote 中的 NA 转为缺失、其他值转为数值，在保留原阶段和全部行的派生阶段继续；不要插补、删除观测或改变其他列，并保留按州 state 聚类。",
      preprocessAfterUserResponse: { method: "coerce_numeric", columns: ["vote"], options: { missing_tokens: ["NA"] } },
      finalAssistantText: "锐性 RDD 基准复现：按 state 聚类的 CR1 推断下，常规点估计 7.3948；稳健偏差校正点估计 7.5050，95% CI=[3.9850, 11.0249]；h=18.0843，断点附近有效样本 366/325，完整样本 N=1297，带宽内聚类数50。该复现不验证识别假设。",
    })

    expect(result.requestedTools).toContain("data_preprocess:coerce_numeric")
    expect(result.requestedTools.filter((name) => name === "analysis_prepare:rdd_sharp")).toHaveLength(2)
    expect(result.requestedTools.filter((name) => name === "econometrics_execute:rdd_sharp")).toHaveLength(1)
    expect(result.requestedTools).toContain("data_import:profile-followup-preprocessed-stage")
    expect(result.requestedTools).toContain("data_import:validate-followup-preprocessed-stage")
    expect(result.requestedTools).toContain("tool_search:rdd_sharp")
    expect(result.requestedTools).toContain("econometrics_execute:rdd_sharp")
    expect(result.targetPart.state.status).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.output).toContain("锐性断点回归（Sharp RDD）完成")
      expect(result.targetPart.state.output).toContain("稳健偏差校正推断：点估计=7.5050")
      expect(result.targetPart.state.output).toContain("聚类变量：state")
      expect(result.targetPart.state.output).toContain("带宽内聚类簇数：50")
    }
    expect(result.decisionPart?.state.status).toBe("completed")
    if (result.decisionPart?.state.status === "completed") {
      expect(result.decisionPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.decisionPart.state.metadata.result).toBeUndefined()
      expect(result.decisionPart.state.metadata.preflightStatus).toBe("requires_user_decision")
      expect(result.decisionPart.state.metadata.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "DATA_NUMERIC_REQUIRED", evidence: expect.objectContaining({ columns: ["vote"] }) }),
      ]))
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.preprocessPart?.state.status).toBe("completed")
    expect(result.preprocessPayload?.convertedNumeric).toEqual(["vote"])
    expect(result.preprocessPayload?.missingTokensApplied).toEqual(["NA"])
    expect(result.preprocessPayload?.missingTokensConverted).toEqual({ vote: 93 })
    expect(result.preprocessPayload?.rowsRetained).toBe(1390)
    if (result.preprocessPart?.state.status === "completed") {
      expect(result.preprocessPart.state.output).toContain("vote 中的 NA 共 93 个")
    }
    expect(result.targetPayload?.rowsInput).toBe(1390)
    expect(result.targetPayload?.rowsUsed).toBe(1297)
    expect(Number((result.targetPayload?.conventional as Record<string, unknown>)?.estimate)).toBeCloseTo(7.394838, 4)
    expect(Number((result.targetPayload?.robust as Record<string, unknown>)?.estimate)).toBeCloseTo(7.504956, 4)
    expect(Number((result.targetPayload?.robust as Record<string, unknown>)?.stdError)).toBeCloseTo(1.795945, 4)
    expect(result.targetPayload?.clusterVar).toBe("state")
    expect(result.targetPayload?.nClusters).toBe(50)
    expect(result.targetPayload?.varianceMethod).toBe("CR1")
    expect(result.targetPayload?.primary).toEqual(result.targetPayload?.robust)
    expect(result.targetPayload?.nEffective).toEqual({ left: 366, right: 325 })
    expect(Number((result.targetPayload?.bandwidth as Record<string, unknown>)?.h)).toBeCloseTo(18.084288, 4)
    expect(result.executedMethodIDs.filter((methodID) => methodID === "rdd_sharp")).toHaveLength(1)
    expect(result.executedMethodIDs.filter((methodID) => methodID === "data_preprocess")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000", "stage_001"])
    expect(result.verifierSessionCount).toBe(1)
    expect(result.mainModelRounds).toBe(12)
    expect(result.textOnlyRounds).toBeGreaterThan(0)
    expect(result.finalModelInputText).toContain("不得猜测 cutoff")
    expect(result.finalModelInputText).toContain("robust 推断区间以偏差校正点估计为中心")
    expect(result.finalModelInputText).toContain("稳健偏差校正推断")
    expect(result.finalModelInputText).toContain("锐性断点回归（Sharp RDD）完成")
    expect(result.finalModelInputText).toContain("本次公开基准复现未验证这些假设")
    expect(result.finalModelInputText).toContain("vote 中的 NA 共 93 个")
    expect(result.visibleText).not.toContain("rdd_sharp")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 30_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("交错 DID 缺少相对时期列时不按数值模式自动构造", async () => {
    const result = await runRealMethodScenario({
      methodID: "did2s",
      dependentVar: "创新指数",
      userText: "我确认 time 是各地区首次处理年份，缺失表示从未处理；请用 did2s 分析创新指数。year 是时期、地区是分析单位；relative_time 列还不存在，如果需要构造请先告诉我规则并等我确认，不要从数据模式自行生成。",
      arguments: {
        dependentVar: "创新指数",
        treatmentVar: "did",
        entityVar: "地区",
        timeVar: "year",
        cohortVar: "time",
        relativeTimeVar: "relative_time",
        referencePeriod: -1,
        covariates: [],
      },
      addSilentOlsAlternative: true,
      expectEstimate: false,
    })

    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.targetPart.state.metadata.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "DATA_COLUMN_MISSING", evidence: expect.objectContaining({ columns: ["relative_time"] }) }),
      ]))
      expect(result.targetPart.state.output).toContain("relative_time")
      expect(result.targetPart.state.metadata.result).toBeUndefined()
    }
    expect(result.alternativePart?.state.status).not.toBe("completed")
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).toContain("本轮已暂停")
    expect(result.visibleText).not.toContain("did2s 已完成")
    expect(result.visibleText).not.toContain("ols_regression 已完成")
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("用户指定随机效应时完成真实估计并呈现 Hausman 建议，但不静默切换模型", async () => {
    const result = await runRealMethodScenario({
      methodID: "panel_random_effects",
      dependentVar: "创新指数",
      userText: "请用地区×year 面板做随机效应回归，因变量=创新指数，核心解释变量=did，控制变量=人口规模、人口密度、城镇化水平；只解释条件相关性，不作因果结论。即使 Hausman 建议固定效应，也先按我指定的随机效应完成并同时报告诊断，不要静默换成固定效应。",
      arguments: {
        dependentVar: "创新指数",
        treatmentVar: "did",
        covariates: ["人口规模", "人口密度", "城镇化水平"],
        entityVar: "地区",
        timeVar: "year",
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      finalAssistantText: "已按你指定的随机效应规格完成估计，并报告 Hausman 比较；诊断建议固定效应，但我没有自动换模型。结果只作条件相关性描述，不作因果解释。",
    })

    expect(result.textOnlyRounds).toBeGreaterThan(0)
    expect(result.requestedTools).toContain("tool_search:panel_random_effects")
    expect(result.requestedTools).toContain("analysis_prepare:panel_random_effects")
    expect(result.requestedTools).toContain("econometrics_execute:panel_random_effects")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("panel_random_effects")
    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.output).toContain("面板随机效应（RE）估计完成")
      expect(result.targetPart.state.output).toContain("Hausman 检验")
      expect(result.targetPart.state.output).toContain("Hausman 建议：固定效应")
      expect(result.targetPart.state.output).toContain("未自动切换估计量")
      expect(result.targetPart.state.output).toContain("RE p 值：<0.001")
      expect(result.targetPart.state.output).toContain("p=<0.001")
      expect(result.targetPart.state.metadata.analysisView?.conclusion).toContain("不能单独作为因果证据")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.method).toBe("panel_random_effects")
    expect(result.targetPayload?.rowsUsed).toBeGreaterThan(4_000)
    expect(result.targetPayload?.nEntities).toBeGreaterThan(100)
    expect(result.targetPayload?.nPeriods).toBeGreaterThan(10)
    expect((result.targetPayload?.hausman as Record<string, unknown> | undefined)?.df).toBeGreaterThan(0)
    expect((result.targetPayload?.recommendation as Record<string, unknown> | undefined)?.preferred).toBe("fixed_effects")
    expect(result.executedMethodIDs.filter((methodID) => methodID === "panel_random_effects")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("panel_fe_regression")
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).toContain("诊断建议固定效应，但我没有自动换模型")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("面板方法的 entityVar 类型错误先返回字段 Schema 错误，模型修正后同会话恢复", async () => {
    const sharedArguments = {
      dependentVar: "创新指数",
      treatmentVar: "did",
      covariates: ["人口规模", "人口密度", "城镇化水平"],
      timeVar: "year",
      covariance: "robust",
    }
    const result = await runRealMethodScenario({
      methodID: "panel_random_effects",
      dependentVar: "创新指数",
      userText: "请用地区×year面板做随机效应回归，因变量=创新指数，核心解释变量=did，控制变量=人口规模、人口密度、城镇化水平，实体列=地区、时间列=year；只解释条件相关性，不作因果结论。",
      arguments: { ...sharedArguments, entityVar: 2021 },
      repairArguments: { ...sharedArguments, entityVar: "地区" },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      finalAssistantText: "已按用户指定的面板随机效应规格完成估计，结果只作条件相关性解释。",
      dataFileName: "did.xlsx",
      sheetName: "Data_可读",
    })

    expect(result.requestedTools).toEqual([
      "data_import:import",
      "data_import:profile",
      "data_import:validate",
      "tool_search:panel_random_effects",
      "analysis_prepare:panel_random_effects",
      "tool_search:panel_random_effects",
      "analysis_prepare:panel_random_effects:schema-repair",
      "econometrics_execute:panel_random_effects",
    ])
    expect(result.targetPart.state.status).toBe("completed")
    expect(result.analysisLifecycle).toMatchObject({
      status: "completed",
      requestKind: "estimate",
      methodID: "panel_random_effects",
      resultContractStatus: "pass",
      verifierStatus: "warn",
    })
    expect(result.analysisLifecycleEvents).toContain("assessment_failed")
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.rowsUsed).toBeGreaterThan(4_000)
    expect(result.targetPayload?.entityVar).toBe("地区")
    expect(result.methodPartCount).toBe(3)
    expect(result.failedMethodPart?.state.status).toBe("error")
    if (result.failedMethodPart?.state.status === "error") {
      expect(result.failedMethodPart.state.error).toContain("entityVar")
      expect(result.failedMethodPart.state.metadata?.requiresUserDecision).not.toBe(true)
    }
    expect(result.repairTurnInputText).toContain("参数 entityVar 类型错误")
    expect(result.decisionPart).toBeUndefined()
    expect(result.preflightMethodIDs.filter((methodID) => methodID === "panel_random_effects")).toHaveLength(2)
    expect(result.executedMethodIDs.filter((methodID) => methodID === "panel_random_effects")).toHaveLength(1)
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).toContain("已按用户指定的面板随机效应规格完成估计")
    expect(result.visibleText).not.toContain("本轮已暂停")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 30_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("面板随机效应缺少实体列时仍交由研究者指定，不让模型猜键", async () => {
    const result = await runRealMethodScenario({
      methodID: "panel_random_effects",
      dependentVar: "创新指数",
      userText: "请用面板随机效应分析创新指数与 did 的关系，时间列=year，控制变量=人口规模、人口密度、城镇化水平；只解释条件相关性，不作因果结论。",
      arguments: {
        dependentVar: "创新指数",
        treatmentVar: "did",
        covariates: ["人口规模", "人口密度", "城镇化水平"],
        timeVar: "year",
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: false,
      dataFileName: "did.xlsx",
      sheetName: "Data_可读",
    })

    expect(result.targetPart.state.status).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.targetPart.state.output).toContain("entityVar")
      expect(result.targetPart.state.metadata.preflightStatus).toBe("requires_user_decision")
    }
    expect(result.decisionPart?.state.status).toBe("completed")
    expect(result.preflightMethodIDs).toContain("panel_random_effects")
    expect(result.executedMethodIDs).not.toContain("panel_random_effects")
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(false)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).not.toContain("随机效应回归已完成")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("真实 did.xlsx 经 HDFE 稳定路由完成双向固定效应与地区聚类", async () => {
    const result = await runRealMethodScenario({
      methodID: "hdfe_regression",
      dependentVar: "创新指数",
      userText: "请对 did.xlsx 的地区年度面板做高维固定效应回归：因变量=创新指数，核心解释变量=财政分权度，控制变量=经济发展水平、财政投资力度，吸收地区和 year 固定效应，并按地区聚类。只解释在这些固定效应下的条件关联，不称为因果效应，也不要换成其他方法。",
      arguments: {
        dependentVar: "创新指数",
        treatmentVar: "财政分权度",
        covariates: ["经济发展水平", "财政投资力度"],
        fixedEffects: ["地区", "year"],
        clusterVars: ["地区"],
        covariance: "CRV1",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      dataFileName: "did.xlsx",
      sheetName: "Data_可读",
      finalAssistantText: "高维固定效应回归已完成：在吸收地区和年份固定效应、按地区聚类后，财政分权度系数约为 -0.01088（CRV1 标准误约 0.00822，N=4709）。这只表示当前模型设定下的条件关联，不是因果效应。",
    })

    expect(result.requestedTools).toContain("data_import:import")
    expect(result.requestedTools).toContain("data_import:profile")
    expect(result.requestedTools).toContain("data_import:validate")
    expect(result.requestedTools).toContain("tool_search:hdfe_regression")
    expect(result.requestedTools).toContain("analysis_prepare:hdfe_regression")
    expect(result.requestedTools).toContain("econometrics_execute:hdfe_regression")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("hdfe_regression")
    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.analysisView?.step).toBe("hdfe_regression")
      expect(result.targetPart.state.metadata.analysisView?.results).toEqual(expect.arrayContaining([
        { label: "固定效应", value: "地区、year" },
      ]))
      expect(result.targetPart.state.metadata.analysisView?.conclusion).toContain("已吸收地区、year固定效应")
      expect(result.targetPart.state.output).toContain("高维固定效应回归已完成")
      expect(result.targetPart.state.output).not.toContain("hdfe_regression")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.method).toBe("hdfe_regression")
    expect(result.targetPayload?.rowsUsed).toBe(4709)
    expect(result.targetPayload?.fixedEffects).toEqual(["地区", "year"])
    expect(result.targetPayload?.clusterVars).toEqual(["地区"])
    expect(result.targetPayload?.clusterCounts).toEqual({ "地区": 277 })
    expect(result.targetPayload?.covariance).toBe("CRV1")
    const primary = result.targetPayload?.primary as Record<string, unknown> | undefined
    expect(Number(primary?.estimate)).toBeCloseTo(-0.01088204027, 6)
    expect(Number(primary?.stdError)).toBeCloseTo(0.0082220828, 6)
    expect(result.executedMethodIDs.filter((methodID) => methodID === "hdfe_regression")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("panel_fe_regression")
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.verifierSessionCount).toBe(1)
    expect(result.visibleText).toContain("高维固定效应回归已完成")
    expect(result.visibleText).toContain("条件关联，不是因果效应")
    expect(result.visibleText).not.toContain("hdfe_regression")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 30_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("先按用户指定筛选 2021 横截面，再用稳定工具链交付分位数路径", async () => {
    const result = await runRealMethodScenario({
      methodID: "quantile_regression",
      dependentVar: "创新指数",
      userText: "请先仅保留 year=2021 的横截面，再做创新指数的 0.25、0.5、0.75 分位数回归。核心解释变量=did，控制变量=人口规模、人口密度、城镇化水平。结果只描述这一年地区间的条件分布关联，不作因果解释。",
      arguments: {
        dependentVar: "创新指数",
        treatmentVar: "did",
        covariates: ["人口规模", "人口密度", "城镇化水平"],
        quantiles: [0.25, 0.5, 0.75],
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      filterYear: 2021,
      finalAssistantText: "已按你指定的 2021 横截面完成 0.25、0.5、0.75 分位数回归。下方系数表示控制变量条件下的分布关联，不作因果解释。",
    })

    expect(result.requestedTools).toContain("data_preprocess:filter-year-2021")
    expect(result.requestedTools).toContain("data_import:profile-filtered-stage")
    expect(result.requestedTools).toContain("data_import:validate-filtered-stage")
    expect(result.requestedTools).toContain("tool_search:quantile_regression")
    expect(result.requestedTools).toContain("analysis_prepare:quantile_regression")
    expect(result.requestedTools).toContain("econometrics_execute:quantile_regression")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("quantile_regression")
    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.output).not.toContain("状态：待核验")
      expect(result.targetPart.state.metadata.stageId).toBe("stage_001")
      expect(result.targetPart.state.output).toContain("τ=0.25")
      expect(result.targetPart.state.output).toContain("τ=0.5")
      expect(result.targetPart.state.output).toContain("τ=0.75")
      expect(result.targetPart.state.output).toContain("不能直接解读为因果效应")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.method).toBe("quantile_regression")
    expect(result.targetPayload?.rowsUsed).toBe(277)
    expect(result.targetPayload?.quantiles).toEqual([0.25, 0.5, 0.75])
    const path = result.targetPayload?.treatmentPath as Array<Record<string, unknown>> | undefined
    expect(path?.map((item) => item.tau)).toEqual([0.25, 0.5, 0.75])
    expect(Number(path?.[0]?.estimate)).toBeCloseTo(-0.024456, 3)
    expect(Number(path?.[1]?.estimate)).toBeCloseTo(-0.024180, 3)
    expect(Number(path?.[2]?.estimate)).toBeCloseTo(-0.009392, 3)
    const metrics = result.targetPart.state.status === "completed"
      ? result.targetPart.state.metadata.analysisView?.results
      : undefined
    expect(metrics).toContainEqual({ label: "did τ=0.25 系数", value: "-0.0245", visibility: undefined })
    expect(metrics).toContainEqual({ label: "did τ=0.5 系数", value: "-0.0242", visibility: undefined })
    expect(metrics).toContainEqual({ label: "did τ=0.75 系数", value: "-0.0094", visibility: undefined })
    expect(result.executedMethodIDs.filter((methodID) => methodID === "quantile_regression")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000", "stage_001"])
    expect(result.visibleText).toContain("did τ=0.25 系数=-0.0245")
    expect(result.visibleText).toContain("did τ=0.25 p 值=0.145")
    expect(result.visibleText).toContain("did τ=0.5 系数=-0.0242")
    expect(result.visibleText).toContain("did τ=0.5 p 值=0.071")
    expect(result.visibleText).toContain("did τ=0.75 系数=-0.0094")
    expect(result.visibleText).toContain("did τ=0.75 p 值=0.337")
    expect(result.visibleText).toContain("N=277")
    expect(result.visibleText).not.toContain("quantile_regression")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("先按用户指定筛选 2021 横截面，再通过 RLM 交付 Huber 降权诊断", async () => {
    const result = await runRealMethodScenario({
      methodID: "robust_regression",
      dependentVar: "创新指数",
      userText: "请先仅保留 year=2021 的横截面，对创新指数使用 Huber M 估计稳健回归，核心解释变量=did，控制变量=人口规模、人口密度、城镇化水平。报告低权重观测诊断；只解释条件相关性，不作因果结论。",
      arguments: {
        dependentVar: "创新指数",
        treatmentVar: "did",
        covariates: ["人口规模", "人口密度", "城镇化水平"],
        psi: "huber",
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      filterYear: 2021,
      finalAssistantText: "已按 2021 横截面完成 Huber M 估计稳健回归。该结果仅反映控制变量条件下的统计相关性，不作因果解释。",
    })

    expect(result.requestedTools).toContain("data_preprocess:filter-year-2021")
    expect(result.requestedTools).toContain("tool_search:robust_regression")
    expect(result.requestedTools).toContain("analysis_prepare:robust_regression")
    expect(result.requestedTools).toContain("econometrics_execute:robust_regression")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("robust_regression")
    expect(result.targetPart.state.status, JSON.stringify(result.targetPart.state)).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.output).not.toContain("状态：待核验")
      expect(result.targetPart.state.metadata.stageId).toBe("stage_001")
      expect(result.targetPart.state.output).toContain("Huber M 估计")
      expect(result.targetPart.state.output).toContain("低权重观测：6（2.2%）")
      expect(result.targetPart.state.output).toContain("稳健 M 估计不等于因果识别")
      expect(result.targetPart.state.metadata.analysisView?.conclusion).toContain("统计相关性")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.method).toBe("robust_regression")
    expect(result.targetPayload?.rowsUsed).toBe(277)
    expect(result.targetPayload?.psi).toBe("huber")
    const primary = result.targetPayload?.primary as Record<string, unknown> | undefined
    expect(Number(primary?.estimate)).toBeCloseTo(-0.0202335, 5)
    expect(Number(primary?.stdError)).toBeCloseTo(0.0113398, 5)
    expect(result.targetPayload?.downWeightedCount).toBe(6)
    expect(result.targetPayload?.downWeightedPct).toBe(2.2)
    expect(result.requiredMethodReminderCount).toBe(0)
    expect(result.executedMethodIDs.filter((methodID) => methodID === "robust_regression")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000", "stage_001"])
    expect(result.visibleText).toContain("M 估计函数=Huber")
    expect(result.visibleText).toContain("低权重观测=6（2.2%）")
    expect(result.visibleText).toContain("N=277")
    expect(result.visibleText).not.toContain("robust_regression")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  const badHealthCsvSource = process.env.KILLSTATA_TEST_BADHEALTH_CSV
  test.skipIf(!badHealthCsvSource || !fs.existsSync(badHealthCsvSource))("官方 COUNT::badhealth 样本经稳定工具链完成负二项就诊次数分析", async () => {
    const result = await runRealMethodScenario({
      methodID: "negbin_regression",
      dependentVar: "numvisit",
      userText: "请用负二项回归分析 1998 年就诊次数 numvisit 与自报健康不佳 badh、年龄 age 的统计关联，使用稳健标准误。只作描述性关联，不作因果解释。",
      arguments: {
        dependentVar: "numvisit",
        treatmentVar: "badh",
        covariates: ["age"],
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      sourceFilePath: badHealthCsvSource!,
      finalAssistantText: "COUNT::badhealth 负二项估计完成：N=1127；badh 发生率比约 3.0263（95% CI [2.4280, 3.7720]，p<0.001）；过度离散参数 alpha≈1.0025。仅描述数据中的关联，不作因果解释。",
    })

    expect(result.requestedTools).toContain("data_import:import")
    expect(result.requestedTools).toContain("data_import:profile")
    expect(result.requestedTools).toContain("data_import:validate")
    expect(result.requestedTools).toContain("tool_search:negbin_regression")
    expect(result.requestedTools).toContain("analysis_prepare:negbin_regression")
    expect(result.requestedTools).toContain("econometrics_execute:negbin_regression")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("negbin_regression")
    expect(result.targetPart.state.status).toBe("completed")
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.method).toBe("negbin_regression")
    expect(result.targetPayload?.rowsUsed).toBe(1127)
    expect(result.targetPayload?.isPureCount).toBe(true)
    expect(Number(result.targetPayload?.alpha)).toBeCloseTo(1.002524, 5)
    expect(Number((result.targetPayload?.primaryIrr as Record<string, unknown>)?.irr)).toBeCloseTo(3.026278, 5)
    expect(result.executedMethodIDs.filter((methodID) => methodID === "negbin_regression")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.targetPart.state.status === "completed" ? result.targetPart.state.output : "").toContain("发生率比")
    expect(result.targetPart.state.status === "completed" ? result.targetPart.state.output : "").toContain("α=")
    const metrics = result.targetPart.state.status === "completed"
      ? result.targetPart.state.metadata.analysisView?.results
      : undefined
    expect(metrics).toContainEqual({ label: "badh 发生率比（IRR）", value: "3.0263", visibility: undefined })
    expect(metrics).toContainEqual({ label: "负二项过度离散参数 α", value: "1.0025", visibility: undefined })
    expect(result.finalModelInputText).toContain("发生率比（IRR）")
    expect(result.finalModelInputText).toContain("α=1.0025")
    expect(result.finalModelInputText).toContain("非负整数计数")
    expect(result.finalModelInputText).toContain("连续非负结果")
    expect(result.visibleText).not.toContain("negbin_regression")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 20_000)

  const fairAffairsCsvSource = process.env.KILLSTATA_TEST_FAIR_AFFAIRS_CSV
  test.skipIf(!fairAffairsCsvSource || !fs.existsSync(fairAffairsCsvSource))("负二项误用于真实连续结果时先询问，用户确认后同会话改走 PPML", async () => {
    const negbinArguments = {
      dependentVar: "affairs",
      treatmentVar: "age",
      covariates: ["yrs_married"],
      covariance: "robust",
    }
    const result = await runRealMethodScenario({
      methodID: "negbin_regression",
      dependentVar: "affairs",
      userText: "请用负二项回归分析 affairs 与 age、yrs_married 的关系。如果 affairs 不是非负整数次数，请先说明并停下来问我，不要改数据或自动换方法。",
      arguments: negbinArguments,
      addSilentOlsAlternative: false,
      expectEstimate: true,
      sourceFilePath: fairAffairsCsvSource!,
      followupUserMessage: "我已核对，affairs 是非负连续时间指标，不是整数次数。我确认改用 Poisson 伪极大似然（PPML），保持 affairs、age、yrs_married 和全样本不变，使用 HC1 稳健协方差，只解释条件均值关联，不作因果结论。",
      followupMethodID: "poisson_regression",
      followupArguments: negbinArguments,
      finalAssistantText: "已按你确认的相同变量和全样本改用 Poisson/PPML：N=6366；age 的 IRR≈0.9732（HC1 95% CI [0.9474, 0.9998]，p≈0.0481）；当前 Pearson 离散度≈5.7948，使用 HC1 稳健协方差。结果描述条件均值关联，不作因果解释。",
    })

    expect(result.requestedTools).toEqual([
      "data_import:import",
      "data_import:profile",
      "data_import:validate",
      "tool_search:negbin_regression",
      "analysis_prepare:negbin_regression",
      "tool_search:poisson_regression",
      "analysis_prepare:poisson_regression",
      "econometrics_execute:poisson_regression",
    ])
    expect(result.decisionPart?.state.status).toBe("completed")
    if (result.decisionPart?.state.status === "completed") {
      expect(result.decisionPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.decisionPart.state.output).toContain("非负整数")
    }
    expect(result.targetMethodID).toBe("poisson_regression")
    expect(result.targetPart.state.status).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.output).toContain("Poisson/PPML")
      expect(result.targetPart.state.output).toContain("HC1")
      expect(result.targetPart.state.output).toContain("不构成改用负二项计数模型的依据")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.method).toBe("poisson_regression")
    expect(result.targetPayload?.rowsUsed).toBe(6366)
    expect(result.targetPayload?.isPureCount).toBe(false)
    expect(result.targetPayload?.dispersion).toBeCloseTo(5.794759, 5)
    expect(Number((result.targetPayload?.primaryIrr as Record<string, unknown>)?.irr)).toBeCloseTo(0.973242, 5)
    expect(result.executedMethodIDs.filter((methodID) => methodID === "negbin_regression" || methodID === "poisson_regression"))
      .toEqual(["poisson_regression"])
    expect(result.methodPartCount).toBe(2)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.artifactsExist).toBe(true)
    expect(result.visibleText).not.toContain("negbin_regression")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 30_000)

  const modeChoiceCsvSource = process.env.KILLSTATA_TEST_MODECHOICE_CSV
  test.skipIf(!modeChoiceCsvSource || !fs.existsSync(modeChoiceCsvSource))("真实四模式出行选择按已选 alternative 构造一人一行后完成 MNL", async () => {
    const result = await runRealMethodScenario({
      methodID: "multinomial_logit",
      dependentVar: "mode",
      userText: "这是 statsmodels 官方 Travel Mode Choice 长表，每位 individual 有 plane/train/bus/car 四行，choice=1 是本人选中的方式，mode 编码为 1=air、2=train、3=bus、4=car。请先只保留 choice=1，确认后得到一人一行和四个类别，再估计 mode ~ hinc 的多项 Logit，baseline=1。这个样本是 choice-based 抽样，不用它推断总体方式份额；只解释条件关联，不作因果结论。",
      arguments: {
        dependentVar: "mode",
        treatmentVar: "hinc",
        covariates: [],
        covariance: "robust",
      },
      addSilentOlsAlternative: false,
      expectEstimate: true,
      sourceFilePath: modeChoiceCsvSource!,
      filterRule: { column: "choice", operator: "eq", value: 1 },
      finalAssistantText: "已按 choice=1 保留每位出行者选中的一种方式，共 210 人。以 air（mode=1）为基准，hinc 对 train/bus/car 的相对风险比分别约 0.9427、0.9653、1.0014。样本有 choice-based 抽样，对总体方式份额不作推断；结果仅为条件关联。",
    })

    expect(result.requestedTools).toContain("data_preprocess:filter-choice-1")
    expect(result.requestedTools).toContain("data_import:profile-filtered-stage")
    expect(result.requestedTools).toContain("data_import:validate-filtered-stage")
    expect(result.requestedTools).toContain("tool_search:multinomial_logit")
    expect(result.requestedTools).toContain("analysis_prepare:multinomial_logit")
    expect(result.requestedTools).toContain("econometrics_execute:multinomial_logit")
    expect(result.stableTools).toContain("econometrics_execute")
    expect(result.stableTools).not.toContain("multinomial_logit")
    expect(result.targetPart.state.status).toBe("completed")
    if (result.targetPart.state.status === "completed") {
      expect(result.targetPart.state.metadata.stageId).toBe("stage_001")
      expect(result.targetPart.state.metadata.requiresUserDecision).not.toBe(true)
      expect(result.targetPart.state.metadata.verifierPending).not.toBe(true)
      expect(result.targetPart.state.output).toContain("多项 Logit")
      expect(result.targetPart.state.output).toContain("mode=1")
      expect(result.targetPart.state.output).toContain("RRR")
      expect(result.targetPart.state.output).toContain("RRR 95% CI")
    }
    expect(result.targetPayload?.success).toBe(true)
    expect(result.targetPayload?.method).toBe("multinomial_logit")
    expect(result.targetPayload?.rowsUsed).toBe(210)
    expect(result.targetPayload?.categories).toEqual([1, 2, 3, 4])
    expect(result.targetPayload?.baselineCategory).toBe(1)
    const path = result.targetPayload?.treatmentPath as Array<Record<string, unknown>> | undefined
    expect(path?.map((item) => item.category)).toEqual([2, 3, 4])
    expect(path?.map((item) => Number(item.rrr))).toEqual(expect.arrayContaining([
      expect.closeTo(0.942651, 5),
      expect.closeTo(0.965265, 5),
      expect.closeTo(1.001421, 5),
    ]))
    const metrics = result.targetPart.state.status === "completed"
      ? result.targetPart.state.metadata.analysisView?.results
      : undefined
    expect(metrics).toContainEqual({ label: "hinc 相对类别 2/基准 1 的 RRR", value: "0.9427", visibility: undefined })
    expect(metrics).toContainEqual({ label: "hinc 相对类别 3/基准 1 的 RRR", value: "0.9653", visibility: undefined })
    expect(metrics).toContainEqual({ label: "hinc 相对类别 4/基准 1 的 RRR", value: "1.0014", visibility: undefined })
    expect((metrics as Array<{ label: string }> | undefined)?.some((item) => item.label.includes("RRR 95% CI"))).toBe(true)
    expect(result.finalModelInputText).toContain("长格式")
    expect(result.finalModelInputText).toContain("离散整数类别编码")
    expect(result.finalModelInputText).toContain("RRR=0.9427")
    expect(result.executedMethodIDs.filter((methodID) => methodID === "multinomial_logit")).toHaveLength(1)
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(true)
    expect(result.manifestStages).toEqual(["stage_000", "stage_001"])
    expect(result.finalModelInputText).toContain("0.9427")
    expect(result.visibleText).not.toContain("multinomial_logit")
    expect(result.visibleText).toContain("choice-based 抽样")
    expect(result.visibleText).not.toContain("datasetId")
    expect(result.visibleText).not.toContain("stageId")
  }, 30_000)

  test.skipIf(!fairAffairsCsvSource || !fs.existsSync(fairAffairsCsvSource))("连续 Fair 结果误选 MNL 时请求决策并阻断同批静默 OLS", async () => {
    const result = await runRealMethodScenario({
      methodID: "multinomial_logit",
      dependentVar: "affairs",
      userText: "请用多项 Logit 分析 affairs 与 age、yrs_married 的关系。如果 affairs 不是离散类别，请说明并询问我，不要自动分箱或换方法。",
      arguments: {
        dependentVar: "affairs",
        treatmentVar: "age",
        covariates: ["yrs_married"],
        covariance: "robust",
      },
      addSilentOlsAlternative: true,
      expectEstimate: false,
      sourceFilePath: fairAffairsCsvSource!,
      finalAssistantText: "affairs 是非负连续时间指标，不是离散类别，不能直接用于多项 Logit。请确认是否改用适合连续非负结果的 Poisson/PPML，或提供有研究含义的类别编码；我没有自动分箱、切换估计器或运行同批 OLS。",
    })

    expect(result.requestedTools).toContain("tool_search:multinomial_logit")
    expect(result.requestedTools).toContain("analysis_prepare:multinomial_logit")
    expect(result.requestedTools).toContain("econometrics_execute:multinomial_logit")
    expect(result.decisionPart?.state.status).toBe("completed")
    if (result.decisionPart?.state.status === "completed") {
      expect(result.decisionPart.state.metadata.requiresUserDecision).toBe(true)
      expect(result.decisionPart.state.output).toContain("离散整数类别编码")
    }
    expect(result.executedMethodIDs).not.toContain("multinomial_logit")
    expect(result.executedMethodIDs).not.toContain("ols_regression")
    expect(result.artifactsExist).toBe(false)
    expect(result.manifestStages).toEqual(["stage_000"])
    expect(result.visibleText).toContain("不会截断、分箱")
    expect(result.visibleText).toContain("需要你确认")
    expect(result.visibleText).not.toContain("多项 Logit 回归完成")
  }, 30_000)
})
