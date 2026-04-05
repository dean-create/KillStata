import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { SessionCompaction } from "@/session/compaction"
import { Session } from "@/session"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { LLM } from "@/session/llm"
import type { Provider } from "@/provider/provider"
import { ModelStreamAdapter } from "./model-stream-adapter"
import { RuntimeHooks } from "./hooks"
import type { QueryEvent, QueryRuntimeResult } from "./types"
import { classifyToolFailure, persistToolReflection } from "@/tool/analysis-reflection"
import { Instance } from "@/project/instance"

const DOOM_LOOP_THRESHOLD = 3

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

          if (event.type === "tool-call") {
            const parts = await MessageV2.parts(this.input.assistantMessage.id)
            const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)
            if (
              lastThree.length === DOOM_LOOP_THRESHOLD &&
              lastThree.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === event.toolName &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(this.normalizeToolInput(event.input)),
              )
            ) {
              const agent = await Agent.get(this.input.assistantMessage.agent)
              await RuntimeHooks.preTool({
                sessionID: this.input.sessionID,
                toolName: event.toolName,
                args: event.input,
              })
              if (agent) {
                await import("@/permission/next").then(({ PermissionNext }) =>
                  PermissionNext.ask({
                    permission: "doom_loop",
                    patterns: [event.toolName],
                    sessionID: this.input.assistantMessage.sessionID,
                    metadata: {
                      tool: event.toolName,
                      input: event.input,
                    },
                    always: [event.toolName],
                    ruleset: agent.permission,
                  }),
                )
              }
            }
          }

          if (event.type === "tool-error") {
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
              error: event.error,
            })

            let reflectionMetadata = existingReflection
            if (!reflectionMetadata) {
              const reflection = classifyToolFailure({
                toolName: event.toolName,
                error: String(event.error),
                input: event.input ? this.normalizeToolInput(event.input) : match?.state.input,
              })
              const reflectionPath = persistToolReflection(reflection)
              reflectionMetadata = {
                ...reflection,
                reflectionPath: reflectionPath.startsWith(Instance.directory)
                  ? reflectionPath.slice(Instance.directory.length + 1)
                  : reflectionPath,
              }
            }

            event.metadata = {
              ...(event.metadata ?? {}),
              ...(hookResult.metadata ?? {}),
              ...(reflectionMetadata ? { reflection: reflectionMetadata } : {}),
            }

            if (!this.repair && hookResult.repair) {
              this.repair = {
                type: "repair",
                ...hookResult.repair,
              }
              event.repair = this.repair
            }

            const { PermissionNext } = await import("@/permission/next")
            const { Question } = await import("@/question")
            if (event.error instanceof PermissionNext.RejectedError || event.error instanceof Question.RejectedError) {
              this.blocked = shouldBreak
              event.blocked = shouldBreak
            }
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

  private normalizeToolInput(input: unknown): Record<string, unknown> {
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
}
