import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { SessionCompaction } from "@/session/compaction"
import { Session } from "@/session"
import { Config } from "@/config/config"
import { LLM } from "@/session/llm"
import type { Provider } from "@/provider/provider"
import { ModelStreamAdapter } from "./model-stream-adapter"
import { RuntimeHooks } from "./hooks"
import type { QueryEvent, QueryRuntimeResult } from "./types"
import { classifyToolFailure, persistToolReflection } from "@/tool/analysis-reflection"
import { Instance } from "@/project/instance"
import { prepareToolMetadata, summarizeToolError } from "./tool-result-policy"
import { isWorkflowAnalysisTool } from "./tool-catalog"

export const REPEATED_TOOL_CALL_THRESHOLD = 3

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
  return `${toolName}\u0000${canonicalJson(normalizeToolInput(input))}`
}

function canonicalRepairToolName(toolName: string) {
  const lower = toolName.toLowerCase()
  return isWorkflowAnalysisTool(lower) || lower === "data_import" ? lower : toolName
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
  const previous = parts
    .filter(
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
  private attempt = 0
  private needsCompaction = false
  private repair: Extract<QueryRuntimeResult, { type: "repair" }> | undefined

  constructor(
    private readonly input: {
      assistantMessage: MessageV2.Assistant
      sessionID: string
      model: Provider.Model
      abort: AbortSignal
      partFromToolCall(toolCallID: string): MessageV2.ToolPart | undefined
    },
  ) {}

  async *run(streamInput: LLM.StreamInput): AsyncGenerator<QueryEvent> {
    const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true

    while (true) {
      try {
        const stream = await LLM.stream(streamInput)
        yield { type: "status", status: { type: "busy" } }

        for await (const event of ModelStreamAdapter.normalize(stream.fullStream)) {
          this.input.abort.throwIfAborted()

          if (event.type === "tool-error") {
            await this.handleToolFailure(event, shouldBreak)
          }

          if (event.type === "step-finish") {
            const usage = Session.getUsage({
              model: this.input.model,
              usage: event.usage,
              metadata: event.providerMetadata,
            })
            if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: this.input.model })) {
              this.needsCompaction = true
            }
          }

          yield event

          if (this.needsCompaction) break
        }
      } catch (error) {
        const formatted = MessageV2.fromError(error, { providerID: this.input.model.providerID })
        const retry = SessionRetry.retryable(formatted)
        if (retry !== undefined) {
          this.attempt += 1
          const delay = SessionRetry.delay(this.attempt, formatted.name === "APIError" ? formatted : undefined)
          yield {
            type: "status",
            status: {
              type: "retry",
              attempt: this.attempt,
              message: retry,
              next: Date.now() + delay,
            },
          }
          await SessionRetry.sleep(delay, this.input.abort).catch(() => {})
          continue
        }
        yield { type: "turn-finish", result: "stop", error }
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

  private async handleToolFailure(event: Extract<QueryEvent, { type: "tool-error" }>, shouldBreak: boolean) {
    const rawError = event.error
    const { PermissionNext } = await import("@/permission/next")
    const { Question } = await import("@/question")
    if (
      rawError instanceof PermissionNext.RejectedError ||
      rawError instanceof PermissionNext.DeniedError ||
      rawError instanceof Question.RejectedError
    ) {
      event.error = rawError instanceof PermissionNext.DeniedError
        ? "当前权限规则不允许执行本次工具。"
        : "用户已取消本次工具执行。"
      this.blocked = shouldBreak
      event.blocked = shouldBreak
      return
    }
    if (rawError instanceof PermissionNext.CorrectedError) {
      event.error = summarizeToolError(rawError)
      return
    }

    event.toolName = canonicalRepairToolName(event.toolName)
    const safeError = summarizeToolError(rawError)
    event.error = safeError
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
        providerID: this.input.model.providerID,
        modelID: this.input.model.id,
      },
      toolName: event.toolName,
      args: event.input,
      error: safeError,
    })

    const hookReflection = hookResult.metadata?.reflection
    let reflectionMetadata = existingReflection ?? (
      hookReflection && typeof hookReflection === "object" ? hookReflection as Record<string, unknown> : undefined
    )
    if (!reflectionMetadata) {
      const reflection = classifyToolFailure({
        toolName: event.toolName,
        error: safeError,
        input: event.input ? normalizeToolInput(event.input) : match?.state.input,
      })
      const reflectionPath = persistToolReflection(reflection)
      reflectionMetadata = {
        ...reflection,
        reflectionPath: reflectionPath.startsWith(Instance.directory)
          ? reflectionPath.slice(Instance.directory.length + 1)
          : reflectionPath,
      }
    }

    event.metadata = prepareToolMetadata({
      ...(event.metadata ?? {}),
      ...(hookResult.metadata ?? {}),
      ...(reflectionMetadata ? { reflection: reflectionMetadata } : {}),
    })

    const repairCandidate = hookResult.repair ?? {
      toolName: event.toolName,
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
    }
    if (!this.repair) {
      this.repair = {
        type: "repair",
        ...repair,
        lockTool:
          repair.lockTool ?? (isWorkflowAnalysisTool(event.toolName) || event.toolName === "data_import"),
        failedInputSignature:
          repair.failedInputSignature ?? toolCallSignature(repair.toolName, event.input),
      }
      event.repair = this.repair
    }

  }

  private normalizeToolInput(input: unknown): Record<string, unknown> {
    return normalizeToolInput(input)
  }
}
