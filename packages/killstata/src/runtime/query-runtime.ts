import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { ContextPreflightError } from "./context-preflight"
import { Session } from "@/session"
import { Config } from "@/config/config"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { ContextService } from "@/runtime/services/context-service"
import { AgentEngine } from "@/runtime/engine"
import { ToolUseLoopFailureError, type ToolCallBatchContext, type ToolUseLoopFailureStage } from "./engine/types"
import { Provider } from "@/provider/provider"
import { ModelStreamAdapter } from "./model-stream-adapter"
import { RuntimeHooks } from "./hooks"
import type { QueryEvent, QueryRuntimeResult, QueryCorrelation } from "./types"
import { classifyToolFailure, persistToolReflection } from "@/runtime/failure-reflection"
import { buildFailureDiagnosis } from "@/runtime/failure-diagnosis"
import { ManagedProcessError } from "@/runtime/managed-process"
import { ToolExecutionAbortedError } from "@/runtime/tool-orchestrator"
import { relativeWithinProject } from "@/tool/analysis-path"
import { prepareToolMetadata, summarizeToolError } from "./tool-result-policy"
import { isWorkflowDiagnosticTool, isWorkflowEstimateTool, isWorkflowAnalysisTool } from "./tool-catalog"
import { Log } from "@/util/log"
import { ulid } from "ulid"
import { RuntimeTaskLedger } from "./task-ledger"
import { EconometricsEngineError } from "./services/econometrics-engine-client"
import { ContextManager } from "./context-manager"
import { WorkflowResultContractError } from "./analysis-contract"
import { TOOL_MANIFEST } from "@/runtime/tool-manifest"
import { toolExecutionTraits } from "./tool-policy"
import { Tool } from "@/tool/tool"
import { ToolResultProjection } from "./tool-result-projection"
import { methodSchemaIDsVisibleToModel } from "./tool-schema-provenance"
import { classifyCacheBreak, fingerprintFromHashes, type PromptFingerprint } from "./prompt-fingerprint"
import {
  contextBudget,
  contextUsageFromActual,
  type ContextUsageSnapshot,
  type ContextUsageTokens,
} from "./context-budget"
import type { ModelMessage } from "ai"

const log = Log.create({ service: "runtime.query" })

export const REPEATED_TOOL_CALL_THRESHOLD = 3

type RuntimeToolOutput = Extract<QueryEvent, { type: "tool-result" }>["output"] & {
  modelOutput: string
  modelProjection: ToolResultProjection.Info
  outputReference?: string
  modelAttachments?: unknown[]
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input)
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {}
    return { _raw: input, _parseError: "Invalid JSON" }
  }
  return { _raw: String(input), _parseError: "Unexpected input type" }
}

/**
 * 把会改变执行语义的默认值纳入幂等签名。
 *
 * Panel FE 的工具 Schema 中，clusterVar 省略时等价于按 entityVar 聚类；
 * 模型有时一轮显式传“地区”，下一轮省略该字段。两种 JSON 写法不能导致
 * 两次 Python 估计、两份产物和两条互相干扰的进度。
 */
function normalizeToolSignatureInput(toolName: string, input: unknown) {
  const normalized = normalizeToolInput(input)
  if (toolName !== "panel_fe_regression") return normalized

  const result = { ...normalized }
  if (result.clusterVar === undefined || result.clusterVar === "") {
    if (typeof result.entityVar === "string" && result.entityVar.trim()) result.clusterVar = result.entityVar
  }
  return result
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

export function toolCallSignature(toolName: string, input: unknown) {
  return `${toolName}\u0000${canonicalJson(normalizeToolSignatureInput(toolName, input))}`
}

function canonicalRepairToolName(toolName: string) {
  const lower = toolName.toLowerCase()
  return isWorkflowAnalysisTool(lower) || lower === "data_import" ? lower : toolName
}

/**
 * OpenAI-compatible Provider 只认识稳定的 econometrics_execute；失败治理、workflow
 * repair 和审计仍必须认识真正的计量方法。这里只在治理边界解包，不改变发给 Provider
 * 的 tool-call/tool-result 名称，避免历史消息与当前稳定工具面失配。
 */
export function delegatedToolCall(toolName: string, input: unknown) {
  if (toolName !== "econometrics_execute" || !input || typeof input !== "object" || Array.isArray(input)) {
    return { toolName, input }
  }
  const methodID = (input as Record<string, unknown>).methodID
  const argumentsValue = (input as Record<string, unknown>).arguments
  if (typeof methodID !== "string" || methodID.trim().length === 0) return { toolName, input }
  return {
    toolName: methodID.trim(),
    input: argumentsValue,
  }
}

export function isRepeatedToolCall(
  parts: MessageV2.Part[],
  event: Pick<Extract<QueryEvent, { type: "tool-call" }>, "toolCallId" | "toolName" | "input">,
) {
  return repeatedToolCallCount(parts, event) >= REPEATED_TOOL_CALL_THRESHOLD
}

export function repeatedToolCallCount(
  parts: MessageV2.Part[],
  event: Pick<Extract<QueryEvent, { type: "tool-call" }>, "toolCallId" | "toolName" | "input">,
) {
  const previous = parts.filter(
    (part): part is MessageV2.ToolPart =>
      part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
  )
  const expected = toolCallSignature(event.toolName, event.input)
  let count = 0
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const part = previous[index]
    if (toolCallSignature(part.tool, part.state.input) !== expected) break
    count += 1
    if (count === REPEATED_TOOL_CALL_THRESHOLD) break
  }
  return count
}

export class QueryRuntime {
  private blocked = false
  private textOnlyNextRequest = false
  private stopAfterToolResult = false
  private attempt = 0
  private step = 0
  private requestID = ulid()
  private needsCompaction = false
  /** 上一轮 step-finish 的 token 用量，用于缓存断裂检测。 */
  private previousTokens: MessageV2.Assistant["tokens"] | undefined
  private previousFingerprint: PromptFingerprint | undefined
  private latestContextUsage: ContextUsageSnapshot | undefined
  private repair: Extract<QueryRuntimeResult, { type: "repair" }> | undefined
  private schemaSentMethodIDs = new Set<string>()
  /** 当前生效的模型；fallback 切换后与 input.model 分离。 */
  private currentModel: Provider.Model

  private latestCheckpointId() {
    try {
      const ledger = RuntimeTaskLedger.listTasks(this.input.sessionID)
      const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
      return task?.latestCheckpointId
    } catch {
      return undefined
    }
  }

  private toolResultInputBudget() {
    try {
      const outputLimit = this.currentModel.limit?.output
      if (typeof outputLimit !== "number") return undefined
      return contextBudget(this.currentModel, outputLimit).inputBudget ?? undefined
    } catch {
      return undefined
    }
  }

  private recordFailureDecision(
    decision: ReturnType<typeof SessionRetry.classifyModel> | ReturnType<typeof SessionRetry.classifyTool>,
    input: {
      kind: "model.retry" | "tool.failure" | "failure"
      correlation: QueryCorrelation
      toolName?: string
      errorCode?: string
      attempt?: number
      delayMs?: number
    },
  ) {
    const failureDecision = {
      ...decision,
      reason: summarizeToolError(decision.reason),
      attempt: input.attempt,
      delayMs: input.delayMs,
      toolName: input.toolName,
      errorCode: input.errorCode,
      checkpointId: this.latestCheckpointId(),
    }
    const event = {
      sessionID: this.input.sessionID,
      kind: input.kind,
      correlation: input.correlation,
      message: `${decision.scope} failure ${decision.disposition}: ${decision.category}`,
      failureDecision,
    } as const
    if (decision.disposition === "stop") {
      try {
        RuntimeTaskLedger.appendEvent(event)
        return true
      } catch {
        return false
      }
    }
    RuntimeTaskLedger.appendEventBestEffort(event)
    return true
  }

  private correlation(stepID = `step-${this.step}`, toolCallID?: string): QueryCorrelation {
    return {
      sessionID: this.input.sessionID,
      turnID: this.input.assistantMessage.id,
      requestID: this.requestID,
      stepID,
      attempt: this.attempt,
      providerID: this.currentModel.providerID,
      modelID: this.currentModel.id,
      ...(toolCallID ? { toolCallID } : {}),
    }
  }

  constructor(
    private readonly input: {
      assistantMessage: MessageV2.Assistant
      sessionID: string
      model: Provider.Model
      abort: AbortSignal
      partFromToolCall(toolCallID: string): MessageV2.ToolPart | undefined
    },
  ) {
    this.currentModel = input.model
    try {
      const previous = RuntimeTaskLedger.latestCacheObservation(input.sessionID)
      if (!previous) return
      this.previousFingerprint = fingerprintFromHashes({
        modelID: String(previous.fingerprint.modelID ?? input.model.id),
        providerID: String(previous.fingerprint.providerID ?? input.model.providerID),
        effort: typeof previous.fingerprint.effort === "string" ? previous.fingerprint.effort : undefined,
        variant: typeof previous.fingerprint.variant === "string" ? previous.fingerprint.variant : undefined,
        systemHash: String(previous.fingerprint.systemHash ?? ""),
        stableSystemHash: typeof previous.fingerprint.stableSystemHash === "string"
          ? previous.fingerprint.stableSystemHash
          : undefined,
        dynamicSystemTailHash: typeof previous.fingerprint.dynamicSystemTailHash === "string"
          ? previous.fingerprint.dynamicSystemTailHash
          : undefined,
        toolSchemaHash: String(previous.fingerprint.toolSchemaHash ?? ""),
        stableToolSchemaHash: typeof previous.fingerprint.stableToolSchemaHash === "string"
          ? previous.fingerprint.stableToolSchemaHash
          : undefined,
        dynamicMethodTailHash: typeof previous.fingerprint.dynamicMethodTailHash === "string"
          ? previous.fingerprint.dynamicMethodTailHash
          : undefined,
        providerOptionsHash: String(previous.fingerprint.providerOptionsHash ?? ""),
        promptHash: String(previous.fingerprint.promptHash ?? ""),
      })
      this.previousTokens = previous.tokens
    } catch {
      // Cache observation is diagnostic only; an isolated runtime/test without a project instance
      // must still be able to execute the agent loop.
    }
  }

  async *run(streamInput: ModelGateway.StreamInput): AsyncGenerator<QueryEvent> {
    const engine = AgentEngine.runToolUse<
      ModelGateway.StreamInput,
      QueryEvent,
      Extract<QueryEvent, { type: "tool-call" }>,
      RuntimeToolOutput,
      QueryRuntimeResult
    >({
      request: streamInput,
      adapter: {
        stream: (request) => this.runModelRound(request),
        callFromEvent: (event) => (event.type === "tool-call" ? event : undefined),
        decisionFromEvent: (event) => (event.type === "turn-finish" ? event.result : undefined),
        canExecuteInParallel: (call) =>
          streamInput.tools.definitions?.[call.toolName]?.execution?.concurrency === "parallel",
        execute: async (call, batchContext?: ToolCallBatchContext) => {
          const output = await streamInput.tools.port.execute({
            id: call.toolCallId,
            name: call.toolName,
            input: call.input,
            abort: this.input.abort,
            schemaSentToolIDs: [...this.schemaSentMethodIDs],
            ...batchContext,
          }) as Extract<QueryEvent, { type: "tool-result" }>["output"]
          // 用户的补充消息有时被识别成 ingest（例如“把实体和时间改过来重新跑”），
          // 但模型仍会在修复轮成功执行估计器。结果一旦已经带有可信 analysisView，
          // 就不应再让模型回头读取原始 Excel 或重复探查；下一轮只保留文字收尾。
          // 明确的 analysis 轮可能还要求执行第二个模型，因此不能在该轮提前关闭工具。
          const executedToolName = delegatedToolCall(call.toolName, call.input).toolName
          if (
            streamInput.inputIntent !== "analysis" &&
            isWorkflowEstimateTool(executedToolName) &&
            output.metadata?.analysisView
          ) {
            this.textOnlyNextRequest = true
          }
          // 数据/规格预检返回 requiresUserDecision 时，当前模型轮必须停在这里，把
          // 决策交还用户；否则模型可能在同一轮继续删变量、改方法或直接重试原规格。
          // analysis_prepare 的用户决策结果需要回到模型，由模型把结构化障碍整理成
          // 清晰问题/停点；同一工具响应中的后续调用仍由 ToolPort 短路。其他需要决策
          // 的执行结果继续直接终止本轮，避免模型绕过已有审批边界。
          if (output.metadata?.requiresUserDecision === true && call.toolName !== "analysis_prepare") {
            this.blocked = true
          }
          if (output.metadata?.verifierPending === true) this.textOnlyNextRequest = true
          if (output.metadata?.finalizeTextOnly === true) this.textOnlyNextRequest = true
          if (output.metadata?.noNewInformation === true) this.textOnlyNextRequest = true
          if (output.metadata?.finalizeAfterResult === true) this.stopAfterToolResult = true
          const budget = this.toolResultInputBudget()
          let projection
          try {
            projection = await ToolResultProjection.project({
              toolName: call.toolName,
              title: output.title,
              output: output.output,
              metadata: output.metadata,
              inputBudgetTokens: call.toolName === "tool_search" ? undefined : budget,
              ...(call.toolName === "tool_search"
                ? { maxInlineTokens: ToolResultProjection.TOOL_SEARCH_SCHEMA_MAX_INLINE_TOKENS }
                : {}),
            })
          } catch {
            projection = ToolResultProjection.emergency({
              toolName: call.toolName,
              title: output.title,
              output: output.output,
              maxTokens: budget === undefined ? undefined : Math.max(256, Math.floor(budget * 0.05)),
            })
          }
          return {
            ...output,
            metadata: prepareToolMetadata({ ...output.metadata, modelProjection: projection.info }),
            modelOutput: projection.content,
            modelProjection: projection.info,
            outputReference: projection.info.outputReference,
          }
        },
        resultEvent: (call, output) => ({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          output,
          correlation: this.correlation(`step-${this.step}`, call.toolCallId),
        }),
        errorEvent: (call, error) => ({
          type: "tool-error",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          error,
          correlation: this.correlation(`step-${this.step}`, call.toolCallId),
        }),
        skippedEvent: (call, error) => ({
          type: "tool-error",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          error,
          blocked: true,
          skipped: true,
          metadata: { skipped: true },
          correlation: this.correlation(`step-${this.step}`, call.toolCallId),
        }),
        loopFailureEvent: ({ stage, error, callIDs }) => {
          log.error("agent tool-use loop failed", {
            sessionID: this.input.sessionID,
            stage,
            toolCallIDs: callIDs,
            error,
          })
          RuntimeTaskLedger.appendEventBestEffort({
            sessionID: this.input.sessionID,
            kind: "failure",
            correlation: this.correlation(),
            message: `工具执行循环在 ${stage} 阶段异常终止`,
            metadata: { failureStage: stage, toolCallIDs: callIDs },
          })
          const stageLabels: Record<ToolUseLoopFailureStage, string> = {
            stream: "模型流处理",
            schedule: "工具调度",
            prepare_results: "结果整理",
            result_event: "结果交付",
            tool_error_handler: "失败恢复",
            after_results: "结果后处理",
            append_results: "上下文续接",
            result_decision: "继续/停止决策",
            unhandled_tool_failure: "工具失败收敛",
          }
          const stageMessage =
            `工具执行循环在${stageLabels[stage]}阶段发生框架错误，已停止本轮，避免重复执行。` +
            "已完成的结果会保留；未确认的工具状态请先核对，再决定是否继续。"
          return {
            type: "turn-finish",
            result: "stop",
            error: new ToolUseLoopFailureError({ stage, callIDs, message: stageMessage }),
            correlation: this.correlation(),
          }
        },
        mergeToolErrorDecisions: (current, next) => {
          // 同批次里只要有一个终止决定，就不能被另一个可修复决定覆盖；
          // 具体的“stop/repair”语义属于 QueryRuntime 适配层，不下沉到通用引擎。
          if (current === "stop" || next === "stop") return "stop"
          return current ?? next
        },
        prepareToolResults: async (results, failureCount = 0) => {
          await streamInput.tools.commitDeferredTools?.()
          const inputBudget = this.toolResultInputBudget()
          const batchBudget = ToolResultProjection.batchBudget(inputBudget)
          const outcomeCount = results.length + failureCount
          const resultBudget = failureCount > 0 && outcomeCount > 0
            ? Math.floor(batchBudget * results.length / outcomeCount)
            : batchBudget
          const mediaBudget = ToolResultProjection.createMediaBudget()
          const media = results.map(({ output }) => ToolResultProjection.projectMediaAttachments(
            output.attachments as MessageV2.FilePart[] | undefined,
            {
              image: this.currentModel.capabilities?.input.image === true,
              pdf: this.currentModel.capabilities?.input.pdf === true,
            },
            mediaBudget,
          ))
          const candidates = results.map(({ call, output }, index) => ({
            toolName: call.toolName,
            content: media[index].notices.length > 0
              ? `${output.modelOutput}\n\n[媒体上下文保护]\n${media[index].notices.map((notice) => `- ${notice}`).join("\n")}`
              : output.modelOutput,
            fullOutput: output.output,
            outputReference: output.modelProjection.outputReference,
          }))
          let fitted
          try {
            fitted = await ToolResultProjection.fitBatch(candidates, resultBudget)
          } catch {
            fitted = ToolResultProjection.emergencyBatch(candidates, resultBudget)
          }
          return results.map((item, index) => {
            const modelOutput = fitted[index].content
            const modelProjection = {
              ...item.output.modelProjection,
              mode: fitted[index].outputReference ? "externalized" as const : item.output.modelProjection.mode,
              outputReference: fitted[index].outputReference ?? item.output.modelProjection.outputReference,
              projectedTokens: ToolResultProjection.estimateTokens(modelOutput),
              omittedTokens: Math.max(0, item.output.modelProjection.originalTokens - ToolResultProjection.estimateTokens(modelOutput)),
            }
            return {
              ...item,
              output: {
                ...item.output,
                modelOutput,
                modelProjection,
                outputReference: modelProjection.outputReference,
                modelAttachments: media[index].attachments,
                metadata: prepareToolMetadata({ ...item.output.metadata, modelProjection }),
              },
            }
          })
        },
        afterToolResults: () => {
          // Tool-result events have already been persisted by TurnAssembler.
          // This also runs when a later call in the same batch fails terminally.
          streamInput.tools.flushDeferredVerifiers?.(this.input.abort)
        },
        appendToolResults: async (request, results, failures = [], callOrder = []) => {
          const successfulByCall = new Map(results.map((item) => [item.call, item.output]))
          const failedByCall = new Map(failures.map((item) => [item.call, item]))
          const failureText = (failure: (typeof failures)[number]) => {
            if (failure.event.type !== "tool-error") return summarizeToolError(failure.error, 4_000)
            const decision = failure.event.metadata?.failureDecision as { userVisibleMessage?: unknown } | undefined
            const diagnosis = failure.event.metadata?.failureDiagnosis as {
              summary_zh?: unknown
              user_fallback_zh?: unknown
            } | undefined
            const repair = failure.event.repair as { repairAction?: unknown } | undefined
            const details = [
              String(failure.event.error),
              typeof decision?.userVisibleMessage === "string" ? decision.userVisibleMessage : undefined,
              typeof diagnosis?.summary_zh === "string" ? diagnosis.summary_zh : undefined,
              typeof repair?.repairAction === "string" ? repair.repairAction : undefined,
            ].filter((value): value is string => Boolean(value?.trim()))
            return summarizeToolError([...new Set(details)].join("\n"), 4_000)
          }
          const orderedCalls = (callOrder.length ? callOrder : [
            ...results.map((item) => item.call),
            ...failures.map((item) => item.call),
          ]).filter((call) => successfulByCall.has(call) || failedByCall.has(call))
          const assistantContent = orderedCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          }))
          const failureBudget = Math.max(
            0,
            ToolResultProjection.batchBudget(this.toolResultInputBudget()) -
              ToolResultProjection.estimateBatch(results.map((item) => ({ content: item.output.modelOutput }))),
          )
          const perFailureBudget = failures.length > 0 ? Math.floor(failureBudget / failures.length) : 0
          const toolContent = orderedCalls.map((call) => {
            const output = successfulByCall.get(call)
            if (output) {
              return {
                type: "tool-result" as const,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: MessageV2.toolOutputForModel(
                  output.modelAttachments?.length
                    ? { text: output.modelOutput, attachments: output.modelAttachments as MessageV2.FilePart[] }
                    : output.modelOutput,
                  this.currentModel,
                ),
              }
            }
            const failure = failedByCall.get(call)!
            const errorText = ToolResultProjection.boundModelOutput(failureText(failure), perFailureBudget)
            return {
              type: "tool-result" as const,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: { type: "error-text" as const, value: errorText },
            }
          })
          const nextRequest = {
            ...request,
            ...(this.textOnlyNextRequest ? { textOnly: true } : {}),
            messages: [
              ...request.messages,
              { role: "assistant", content: assistantContent } as ModelMessage,
              { role: "tool", content: toolContent } as ModelMessage,
            ],
          }
          this.schemaSentMethodIDs = methodSchemaIDsVisibleToModel(nextRequest.messages)
          return nextRequest
        },
        shouldContinueAfterResults: (results) =>
          !this.stopAfterToolResult && results.every(({ call, output }) =>
            output.metadata?.requiresUserDecision !== true || call.toolName === "analysis_prepare",
          ),
        shouldStopAfterResult: (output) =>
          output.metadata?.requiresUserDecision === true ||
          output.metadata?.finalizeAfterResult === true ||
          output.metadata?.noNewInformation === true,
        decisionAfterResults: (results) =>
          this.stopAfterToolResult || results.some(({ call, output }) =>
            output.metadata?.requiresUserDecision === true && call.toolName !== "analysis_prepare",
          )
            ? "stop"
            : undefined,
        onToolError: async (event) => {
          if (event.type !== "tool-error") return undefined
          await this.handleToolFailure(event, streamInput.tools?.definitions?.[event.toolName]?.execution)
          if (this.blocked) return "stop"
          return this.repair
        },
        continueAfterMixedToolFailure: ({ decision }) =>
          typeof decision === "object" && decision.type === "repair",
        continues: (result) => result === "continue",
        terminalEvent: (result) => ({ type: "turn-finish", result }),
      },
    })
    yield* engine
  }

  private async *runModelRound(
    streamInput: ModelGateway.StreamInput,
  ): AsyncGenerator<QueryEvent> {

    while (true) {
      this.step += 1
      const correlation = this.correlation()
      streamInput.correlation = correlation
      RuntimeTaskLedger.appendEventBestEffort({
        sessionID: this.input.sessionID,
        kind: "model.request",
        correlation,
        message: "model request started",
      })
      let streamTextObserved = false
      try {
        const stream = await ModelGateway.stream(streamInput)
        // ModelGateway may apply the final context-collapse projection and replace messages
        // before sending the request. Only those final messages count as Schema disclosure.
        this.schemaSentMethodIDs = methodSchemaIDsVisibleToModel(streamInput.messages)
        yield { type: "status", status: { type: "busy" }, correlation }

        // 空流/假死防护（对齐 claude-code 的 idle watchdog）：
        // - 首 token 60s / 事件间隔 120s 无事件 → withStreamIdleWatchdog abort + 抛可重试错误
        // - 流正常结束但 0 个事件（纯空流，代理无声失败）→ 这里补抛错误走重试
        let streamEventCount = 0
        // Tool call 必须等本次模型流完整结束后才对 AgentEngine 可见。若流在 tool-call 后断线，
        // pending 数组随本次 try 丢弃，透明重试不会累计并执行失败尝试里的副作用调用。
        const pendingToolCalls: Array<Extract<QueryEvent, { type: "tool-call" }>> = []
        let pendingCallsFlushed = false
        let sawExplicitFinish = false
        const flushPendingCalls = async function* () {
          for (const call of pendingToolCalls) yield call
          pendingToolCalls.length = 0
          pendingCallsFlushed = true
        }
        // AI SDK v5 的 StreamTextResult 只保证 fullStream；abort() 并不存在（曾误以为
        // 运行时有而类型没暴露），故声明为可选，由 watchdog 走迭代器 return() 释放。
        const watchable = stream as unknown as { fullStream: AsyncIterable<any>; abort?: () => void }
        for await (const event of ModelStreamAdapter.normalize(
          ModelStreamAdapter.withStreamIdleWatchdog(watchable),
        )) {
          this.input.abort.throwIfAborted()
          streamEventCount++
          if (event.type === "text-start" || event.type === "text-delta") {
            streamTextObserved = true
          }

          if (event.type === "tool-error") {
            await this.handleToolFailure(event, streamInput.tools?.definitions?.[event.toolName]?.execution)
          }
          if (event.type === "step-finish") {
            const usage = Session.getUsage({
              model: this.currentModel,
              usage: event.usage,
              metadata: event.providerMetadata,
            })
            // 只有 provider token 计数确认缓存从命中掉到 0 时才记录断裂原因；
            // 正常追加一轮消息会改变 prompt fingerprint，但不代表缓存真的断了。
            const cacheBreak = ContextService.detectCacheBreak({
              previous: this.previousTokens,
              current: usage.tokens,
            })
            if (cacheBreak) {
              log.warn("prompt cache break detected", {
                sessionID: this.input.sessionID,
                modelID: this.currentModel.id,
                previousCacheRead: this.previousTokens?.cache.read,
                currentInput: usage.tokens.input,
              })
            }
            this.previousTokens = usage.tokens
            this.latestContextUsage = contextUsageFromActual({
              model: this.currentModel,
              budget: contextBudget(this.currentModel, this.input.model.limit.output),
              tokens: usage.tokens as ContextUsageTokens,
              estimated: streamInput.contextUsage,
              compactionState: "none",
            })
            if (streamInput.promptFingerprint) {
              const breakReason = cacheBreak
                ? classifyCacheBreak(this.previousFingerprint, streamInput.promptFingerprint)
                : undefined
              RuntimeTaskLedger.recordCacheObservation({
                sessionID: this.input.sessionID,
                correlation,
                fingerprint: {
                  modelID: streamInput.promptFingerprint.modelID,
                  providerID: streamInput.promptFingerprint.providerID,
                  effort: streamInput.promptFingerprint.effort,
                  variant: streamInput.promptFingerprint.variant,
                  contextVersion: streamInput.promptFingerprint.contextVersion,
                  systemHash: streamInput.promptFingerprint.systemHash,
                  stableSystemHash: streamInput.promptFingerprint.stableSystemHash,
                  dynamicSystemTailHash: streamInput.promptFingerprint.dynamicSystemTailHash,
                  stableToolSchemaHash: streamInput.promptFingerprint.stableToolSchemaHash,
                  dynamicMethodTailHash: streamInput.promptFingerprint.dynamicMethodTailHash,
                  toolSchemaHash: streamInput.promptFingerprint.toolSchemaHash,
                  providerOptionsHash: streamInput.promptFingerprint.providerOptionsHash,
                  promptHash: streamInput.promptFingerprint.promptHash,
                },
                tokens: usage.tokens,
                breakReason,
              })
              this.previousFingerprint = streamInput.promptFingerprint
            }
            ContextManager.publishUsage({
              sessionID: this.input.sessionID,
              historyVersion: streamInput.messages.length,
              usage: this.latestContextUsage,
            })
          }

          if (event.type === "tool-call") {
            pendingToolCalls.push(event)
            continue
          }

          if (event.type === "finish" && pendingToolCalls.length > 0) {
            sawExplicitFinish = true
            yield* flushPendingCalls()
          } else if (event.type === "finish") {
            sawExplicitFinish = true
          }

          yield event

          if (this.needsCompaction) break
        }

        if (!this.needsCompaction && pendingToolCalls.length > 0 && !sawExplicitFinish) {
          throw new Error("provider stream ended without an explicit finish after emitting tool calls")
        }
        if (!this.needsCompaction && sawExplicitFinish && !pendingCallsFlushed && pendingToolCalls.length > 0) {
          yield* flushPendingCalls()
        }

        if (streamEventCount === 0 && !this.needsCompaction) {
          // 纯空流：流式代理返回 200 但没有任何事件。注意：这类错误**不能**走重试路径——
          // 重试只会再次拿到空流（且 fallback 测试等 mock 以空流表示"成功"），会无限循环。
          // 作为不可重试错误结束本轮，用户看到明确提示而非静默空回复。
          throw new Error("empty stream with no events (provider returned no content)")
        }
        // 只有真正完成一个模型流才清零；重试上限计算的是连续失败，不是本轮累计失败。
        this.attempt = 0
      } catch (error) {
        if (streamTextObserved) {
          // 已经展示给用户的半截模型文本不能静默消失；它也不能被误认为完成结论。
          // 通过独立文本片段写入标记，下一次重试的正文会从新的片段开始，且标记
          // 不会进入下一次 API 请求的 messages。
          yield { type: "text-start", correlation: this.correlation() }
          yield {
            type: "text-delta",
            text: "\n\n[本次模型输出中途断开，以上片段仅作过程记录，不作为最终结论。]\n\n",
            correlation: this.correlation(),
          }
          yield { type: "text-end", correlation: this.correlation() }
        }
        const formatted = MessageV2.fromError(error, { providerID: this.currentModel.providerID })
        if (error instanceof ContextPreflightError) {
          this.needsCompaction = true
          RuntimeTaskLedger.appendEventBestEffort({
            sessionID: this.input.sessionID,
            kind: "model.request",
            correlation: this.correlation(),
            message: "context preflight requested compaction",
            metadata: error.preflight,
          })
          yield { type: "turn-finish", result: "compact", error, correlation: this.correlation() }
          return
        }
        const failureDecision = SessionRetry.classifyModel(formatted, streamInput.requestSource ?? "foreground")
        if (failureDecision.disposition === "compact") {
          this.needsCompaction = true
          this.recordFailureDecision(failureDecision, {
            kind: "failure",
            correlation: this.correlation(),
            attempt: this.attempt,
          })
          yield { type: "turn-finish", result: "compact", error, correlation: this.correlation() }
          return
        }
        if (failureDecision.disposition === "retry") {
          this.attempt += 1
          // 上限按失败类别取：纯网络/连接类瞬时故障放宽到 MAX_TRANSIENT_NETWORK_RETRIES(10)，
          // 限流/5xx 等仍用默认 MAX_CONSECUTIVE_MODEL_FAILURES(3)。
          const maxAttempts = failureDecision.maxConsecutiveFailures ?? SessionRetry.MAX_CONSECUTIVE_MODEL_FAILURES
          // 连续临时失败达到安全上限时，只允许切换一次已配置 fallback；没有 fallback 或
          // fallback 自身同样耗尽时立即熔断，不能无限请求同一个 Provider。
          if (this.attempt >= maxAttempts) {
            const switched = await this.tryFallback(streamInput)
            if (switched.ok) {
              this.recordFailureDecision(
                { ...failureDecision, disposition: "fallback" },
                { kind: "model.retry", correlation: this.correlation(), attempt: this.attempt },
              )
              this.attempt = 0
              yield {
                type: "status",
                status: { type: "model-switch", from: switched.from, to: switched.to },
              }
              continue
            }
            const circuitError = new Error(
              `${failureDecision.userVisibleMessage}\n连续失败已达到 ${maxAttempts} 次，已停止自动重试；可从最新checkpoint继续。`,
            )
            const persisted = this.recordFailureDecision(failureDecision, {
              kind: "failure",
              correlation: this.correlation(),
              attempt: this.attempt,
            })
            if (!persisted) circuitError.message += "\n注意：本地断点记录写入失败，请保留当前会话。"
            yield { type: "turn-finish", result: "stop", error: circuitError, correlation: this.correlation() }
            return
          }
          const delay = SessionRetry.delay(this.attempt, formatted.name === "APIError" ? formatted : undefined)
          this.recordFailureDecision(failureDecision, {
            kind: "model.retry",
            correlation: this.correlation(),
            attempt: this.attempt,
            delayMs: delay,
          })
          yield {
            type: "status",
            status: {
              type: "retry",
              attempt: this.attempt,
              message: failureDecision.userVisibleMessage,
              next: Date.now() + delay,
            },
          }
          await SessionRetry.sleep(delay, this.input.abort).catch(() => {})
          continue
        }
        const persisted = this.recordFailureDecision(failureDecision, {
          kind: "failure",
          correlation: this.correlation(),
          attempt: this.attempt,
        })
        yield {
          type: "turn-finish",
          result: "stop",
          error: new Error(`${failureDecision.userVisibleMessage}\n错误分类：${failureDecision.category}${persisted ? "" : "\n注意：本地断点记录写入失败，请保留当前会话。"}`),
          correlation: this.correlation(),
        }
        return
      }

      let result: QueryRuntimeResult = "continue"
      if (this.needsCompaction) result = "compact"
      else if (this.blocked) result = "stop"
      else if (this.repair) result = this.repair

      const hookResult = await RuntimeHooks.turnFinished({
        sessionID: this.input.sessionID,
        result: typeof result === "string" ? result : result.type,
      })
      if (hookResult.preventContinuation) {
        result = "stop"
      }

      yield { type: "turn-finish", result }
      return
    }
  }

  /**
   * 连续可重试失败后尝试切换 fallbackModel（experimental.fallbackModel，格式 providerID/modelID）。
   * 成功切换：更新 currentModel、重置 attempt、把 streamInput.model 同步为 fallback（下次 ModelGateway.stream 生效）、
   * 返回 { ok: true, from, to }，由调用方 yield model-switch 状态。
   * 失败（未配置/解析不到模型/已是 fallback）：返回 { ok: false }，保持原重试路径。
   */
  private async tryFallback(
    streamInput: ModelGateway.StreamInput,
  ): Promise<{ ok: true; from: string; to: string } | { ok: false }> {
    const cfg = await Config.get()
    const fallbackSpec = cfg.experimental?.fallbackModel
    if (!fallbackSpec) return { ok: false }

    const currentSpec = `${this.currentModel.providerID}/${this.currentModel.id}`
    if (fallbackSpec === currentSpec) return { ok: false }

    const parsed = Provider.parseModel(fallbackSpec)
    if (!parsed) return { ok: false }

    const fallbackModel = await Provider.getModel(parsed.providerID, parsed.modelID).catch(() => undefined)
    if (!fallbackModel) return { ok: false }

    this.currentModel = fallbackModel
    streamInput.model = fallbackModel
    return { ok: true, from: currentSpec, to: fallbackSpec }
  }

  private async handleToolFailure(
    event: Extract<QueryEvent, { type: "tool-error" }>,
    execution?: Tool.ExecutionPolicy,
  ) {
    const rawError = event.error
    const delegated = delegatedToolCall(event.toolName, event.input)
    const effectiveToolName = canonicalRepairToolName(delegated.toolName)
    const effectiveInput = delegated.input
    if (effectiveToolName !== event.toolName) {
      event.metadata = {
        ...(event.metadata ?? {}),
        delegatedToolID: effectiveToolName,
      }
    }
    const { PermissionNext } = await import("@/permission/next")
    const { Question } = await import("@/question")
    if (
      rawError instanceof PermissionNext.RejectedError ||
      rawError instanceof PermissionNext.DeniedError ||
      rawError instanceof Question.RejectedError
    ) {
      event.error =
        rawError instanceof PermissionNext.DeniedError ? "当前权限规则不允许执行本次工具。" : "用户已取消本次工具执行。"
      const decision = SessionRetry.classifyTool({
        toolName: effectiveToolName,
        message: String(event.error),
        control: rawError instanceof PermissionNext.DeniedError ? "permission_denied" : "user_cancelled",
      })
      event.metadata = prepareToolMetadata({ failureDecision: decision })
      const persisted = this.recordFailureDecision(decision, {
        kind: "failure",
        correlation: this.correlation(`step-${this.step}`, event.toolCallId),
        toolName: effectiveToolName,
      })
      if (!persisted && decision.category !== "user_cancelled") {
        event.error += " 本地断点记录写入失败，请保留当前会话。"
      }
      this.blocked = true
      event.blocked = true
      return
    }
    if (rawError instanceof PermissionNext.CorrectedError) {
      event.error = `用户拒绝了本次工具执行。反馈：${summarizeToolError(rawError.feedback)}`
      const decision = SessionRetry.classifyTool({
        toolName: effectiveToolName,
        message: String(event.error),
        control: "permission_denied",
      })
      event.metadata = prepareToolMetadata({ failureDecision: decision })
      const persisted = this.recordFailureDecision(decision, {
        kind: "failure",
        correlation: this.correlation(`step-${this.step}`, event.toolCallId),
        toolName: effectiveToolName,
      })
      if (!persisted && decision.category !== "user_cancelled") {
        event.error += " 本地断点记录写入失败，请保留当前会话。"
      }
      this.blocked = true
      event.blocked = true
      return
    }

    // 用户主动停止不是工具故障：不得生成 reflection、触发失败 Hook 或安排自动修复，
    // 否则系统会违背用户的停止意图，重新执行刚刚取消的长任务。
    if (
      rawError instanceof ToolExecutionAbortedError ||
      (rawError instanceof ManagedProcessError && rawError.code === "PROCESS_ABORTED")
    ) {
      event.error = "已停止本次工具执行。"
      const decision = SessionRetry.classifyTool({
        toolName: effectiveToolName,
        message: String(event.error),
        control: "user_cancelled",
      })
      event.metadata = prepareToolMetadata({ failureDecision: decision })
      const persisted = this.recordFailureDecision(decision, {
        kind: "failure",
        correlation: this.correlation(`step-${this.step}`, event.toolCallId),
        toolName: effectiveToolName,
      })
      if (!persisted && decision.category !== "user_cancelled") {
        event.error += " 本地断点记录写入失败，请保留当前会话。"
      }
      event.blocked = true
      this.blocked = true
      return
    }

    const safeError = summarizeToolError(rawError)
    event.error = safeError
    // 结构化错误码优先于文案匹配：文案改动不影响失败分类（见 failure-reflection）。
    const errorCode = rawError instanceof EconometricsEngineError
      ? rawError.code
      : rawError instanceof ManagedProcessError || rawError instanceof ToolExecutionAbortedError ||
        rawError instanceof Tool.InputValidationError || rawError instanceof Tool.OutputValidationError ||
        rawError instanceof Tool.ExecutionTimeoutError || rawError instanceof Tool.SchemaNotSentError
      ? rawError.code
      : rawError instanceof WorkflowResultContractError
        ? rawError.code
        : undefined
    const match = this.input.partFromToolCall(event.toolCallId)
    const existingReflection =
      match?.state.status === "running" && match.state.metadata && typeof match.state.metadata === "object"
        ? (match.state.metadata["reflection"] as Record<string, unknown> | undefined)
        : undefined

    const hookResult = await RuntimeHooks.postToolFailure({
      sessionID: this.input.sessionID,
      messageID: this.input.assistantMessage.id,
      agent: this.input.assistantMessage.agent,
      model: {
        providerID: this.currentModel.providerID,
        modelID: this.currentModel.id,
      },
      toolName: effectiveToolName,
      args: effectiveInput,
      callID: event.toolCallId,
      error: safeError,
      errorCode,
      correlation: this.correlation(`step-${this.step}`, event.toolCallId),
    })

    const hookReflection = hookResult.metadata?.reflection
    let reflectionMetadata =
      existingReflection ??
      (hookReflection && typeof hookReflection === "object" ? (hookReflection as Record<string, unknown>) : undefined)
    if (!reflectionMetadata) {
      const reflection = classifyToolFailure({
        toolName: effectiveToolName,
        error: safeError,
        errorCode,
        input: effectiveInput ? normalizeToolInput(effectiveInput) : match?.state.input,
      })
      const reflectionPath = persistToolReflection(reflection)
      // reflection 实际落盘在 projectReflectionRoot()（= Instance.worktree/.killstata/...），
      // 而这里此前按 Instance.directory 剥前缀——directory !== worktree 时（TUI dev）该分支
      // 恒假，绝对路径原样进了模型可见的 metadata。relativeWithinProject 是已验证过的
      // worktree 优先基准，与产物真正的落盘位置一致（2026-08-14 排查同类问题时发现）。
      reflectionMetadata = {
        ...reflection,
        reflectionPath: relativeWithinProject(reflectionPath),
      }
    }

    event.metadata = prepareToolMetadata({
      ...(event.metadata ?? {}),
      ...(hookResult.metadata ?? {}),
      ...(reflectionMetadata ? { reflection: reflectionMetadata } : {}),
    })

    const failureType =
      typeof reflectionMetadata?.failureType === "string"
        ? (reflectionMetadata.failureType as Parameters<typeof SessionRetry.classifyTool>[0]["failureType"])
        : undefined
    const sideEffectLevel = execution ? toolExecutionTraits(execution, effectiveInput).sideEffectLevel : undefined
    const timeoutOutcomeUnconfirmed = failureType === "process_timeout" && sideEffectLevel !== "none"
    const failureDiagnosis = buildFailureDiagnosis({
      toolName: effectiveToolName,
      failureType: failureType ?? "unknown_failure",
      error: safeError,
      input: effectiveInput && typeof effectiveInput === "object" && !Array.isArray(effectiveInput)
        ? effectiveInput as Record<string, unknown>
        : undefined,
      ...(timeoutOutcomeUnconfirmed ? { safeToRetryOverride: false } : {}),
    })
    event.metadata = prepareToolMetadata({
      ...(event.metadata ?? {}),
      failureDiagnosis,
      ...(timeoutOutcomeUnconfirmed ? { unconfirmed: true, sideEffectMayContinue: rawError instanceof Tool.ExecutionTimeoutError } : {}),
    })
    const admittedTool = TOOL_MANIFEST.some((entry) => entry.id === effectiveToolName)
    const methodToolAvailabilityFailure =
      admittedTool &&
      isWorkflowAnalysisTool(effectiveToolName) &&
      (safeError.toLowerCase().includes("unavailable tool") ||
        safeError.toLowerCase().includes("tool is not available") ||
        (safeError.toLowerCase().includes("tool ") && safeError.toLowerCase().includes("not available in this request")))
    // 相对时期是 DID2S 的研究设计输入，不是普通列名错误。缺失或与首次处理时点不一致时，
    // 允许模型报告原因，但不允许它用 fill_constant/猜测公式继续改造数据；这类决定必须
    // 交还用户，避免把“能跑”误当成“识别设计正确”。
    const did2sDesignFailure =
      effectiveToolName === "did2s" &&
      !/(?:参数不合法|未知字段|未定义字段|unrecognized key|invalid (?:argument|input)|schema|\brequired\b)/i.test(safeError) &&
      (safeError.toLowerCase().includes("relative_time") ||
        safeError.includes("相对时期") ||
        safeError.includes("从未处理组") ||
        safeError.includes("实际首次处理时点"))
    const failureDecision = SessionRetry.classifyTool({
      toolName: effectiveToolName,
      message: safeError,
      failureType,
      errorCode,
      preventContinuation: hookResult.preventContinuation || did2sDesignFailure,
      hookSuggestedRepair: hookResult.repair !== undefined,
      sideEffectLevel,
      readOnlyTool: sideEffectLevel === "none",
      // 已准入方法未加载 ≠ 工具不存在：前者要告诉模型怎么加载，后者才终结整轮。
      admittedTool: methodToolAvailabilityFailure,
    })
    event.metadata = prepareToolMetadata({
      ...(event.metadata ?? {}),
      failureDecision,
      ...(timeoutOutcomeUnconfirmed ? { unconfirmed: true, sideEffectMayContinue: rawError instanceof Tool.ExecutionTimeoutError } : {}),
    })
    const failurePersisted = this.recordFailureDecision(failureDecision, {
      kind: failureDecision.disposition === "repair" ? "tool.failure" : "failure",
      correlation: this.correlation(`step-${this.step}`, event.toolCallId),
      toolName: effectiveToolName,
      errorCode,
    })

    if (failureDecision.disposition === "stop") {
      // 结果契约失败代表适配器/产物边界不可信，不是模型可通过改参数解决的普通工具错误。
      // 先保留 tool-error 与 workflow failure 诊断，再安全停止本轮，避免把伪成功结果
      // 送入下一次模型请求或消耗自动修复额度。
      this.blocked = true
      event.blocked = true
      event.error = `${failureDecision.userVisibleMessage}${failurePersisted ? "" : " 本地断点记录写入失败，请保留当前会话。"}`
      return
    }

    // 已准入方法未加载是工具可见性问题，不是参数问题。Hook 可能复用通用的
    // `repairAction`，但这里必须以本轮失败分类为准，否则模型会凭空改写已正确的
    // 估计规格（真实 DeepSeek 回放曾把“延迟加载”误报成补 clusterVar）。
    const repairCandidate = methodToolAvailabilityFailure || failureDecision.category === "tool_not_found"
      ? {
          ...(hookResult.repair ?? {}),
          toolName: effectiveToolName,
          retryStage: failureDecision.category === "tool_not_found"
            ? "tool_search"
            : hookResult.repair?.retryStage ??
              (typeof reflectionMetadata?.retryStage === "string" ? reflectionMetadata.retryStage : "estimate"),
          repairAction: failureDecision.userVisibleMessage,
          reflectionPath:
            hookResult.repair?.reflectionPath ??
            (typeof reflectionMetadata?.reflectionPath === "string" ? reflectionMetadata.reflectionPath : undefined),
        }
      : hookResult.repair ?? {
          toolName: effectiveToolName,
          retryStage: typeof reflectionMetadata?.retryStage === "string" ? reflectionMetadata.retryStage : "estimate",
          repairAction:
            typeof reflectionMetadata?.repairAction === "string"
              ? reflectionMetadata.repairAction
              : "根据工具描述修正失败调用后重试。",
          reflectionPath:
            typeof reflectionMetadata?.reflectionPath === "string" ? reflectionMetadata.reflectionPath : undefined,
        }
    const repair = {
      ...repairCandidate,
      toolName: canonicalRepairToolName(repairCandidate.toolName),
      failureDiagnosis,
    } as typeof repairCandidate & { confirmedToolIDs?: string[]; failureDiagnosis: typeof failureDiagnosis }
    // confirmedToolIDs 由 default-hooks 在顶层返回（与 repair 平级），不能从 repairCandidate 里读
    const hookConfirmedToolIDs = Array.isArray((hookResult as { confirmedToolIDs?: unknown }).confirmedToolIDs)
      ? (hookResult as { confirmedToolIDs?: string[] }).confirmedToolIDs!
      : undefined
    if (!this.repair) {
      // 只有"参数本身非法"的失败才锁定参数签名（REPAIR_INPUT_UNCHANGED 阻止原样重试）。
      // 前置条件缺失类失败（planning_failure 等）修复前置后原样重试估计器是正确行为，
      // 锁参数会让"先画像/数据质量检查 再重试估计器"的修复路径死锁（2026-08-05 真实数据测试）。
      const lockParameters = (() => {
        // 已准入方法只是尚未进入本轮动态工具目录；加载器会用原始调用重试，
        // 不能把这种可修复的可见性问题误当成参数错误而触发 unchanged guard。
        if (methodToolAvailabilityFailure) return false
        if (failureType === undefined) return true
        return (
          failureType === "tool_contract_failure" ||
          failureType === "column_not_found" ||
          failureType === "schema_mismatch" ||
          failureType === "file_not_found" ||
          failureType === "path_resolution_error"
        )
      })()
      // 数据准备工具（recommend/data_import/data_preprocess）失败不应锁工具面：
      // 锁定的语义是"不换估计方法"，而修复前置条件需要这些工具可见。
      const lockTool =
        repair.lockTool ?? (isWorkflowEstimateTool(effectiveToolName) || isWorkflowDiagnosticTool(effectiveToolName))
      const confirmedToolIDs = hookConfirmedToolIDs
      const repairWithCanonical: typeof repair = {
        ...repair,
        toolName: canonicalRepairToolName(repair.toolName),
      }
      this.repair = {
        type: "repair",
        ...repairWithCanonical,
        lockTool,
        failedInputSignature:
          repairWithCanonical.failedInputSignature ??
          (lockParameters ? toolCallSignature(repairWithCanonical.toolName, effectiveInput) : undefined),
        ...(confirmedToolIDs?.length ? { confirmedToolIDs } : {}),
      }
      event.repair = this.repair
    }
  }
}
