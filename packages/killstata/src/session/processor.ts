import { Bus } from "@/bus"
import { registerDefaultRuntimeHooks } from "@/runtime/default-hooks"
import { RuntimeHooks } from "@/runtime/hooks"
import { QueryRuntime } from "@/runtime/query-runtime"
import { toolExecutionTraits } from "@/runtime/tool-policy"
import { ToolOrchestrator } from "@/runtime/tool-orchestrator"
import { TurnAssembler } from "@/runtime/turn-assembler"
import type { QueryRuntimeResult } from "@/runtime/types"
import { Log } from "@/util/log"
import type { MessageV2 } from "./message-v2"
import type { Provider } from "@/provider/provider"
import { Session } from "."
import { LLM } from "./llm"

export namespace SessionProcessor {
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    registerDefaultRuntimeHooks()

    const assembler = new TurnAssembler({
      assistantMessage: input.assistantMessage,
      sessionID: input.sessionID,
      model: input.model,
    })
    const orchestrator = new ToolOrchestrator(input.sessionID)
    let forcedStop = false

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return assembler.partFromToolCall(toolCallID)
      },
      async executeTool<M extends Record<string, unknown>>(
        toolName: string,
        args: unknown,
        meta: {
          callID?: string
          run: () => Promise<{
            title: string
            metadata: M
            output: string
            attachments?: MessageV2.FilePart[]
          } & Record<string, unknown>>
        },
      ) {
        const pre = await RuntimeHooks.preTool({
          sessionID: input.sessionID,
          toolName,
          args,
        })
        if (pre.block) throw new Error(pre.block)
        const finalArgs = pre.updatedInput ?? args
        const traits = toolExecutionTraits(toolName)

        return orchestrator.execute({
          callID: meta.callID ?? "",
          toolName,
          traits,
          run: async () => {
            const executionResult = await meta.run()
            const post = await RuntimeHooks.postTool({
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              agent: input.assistantMessage.agent,
              model: {
                providerID: input.model.providerID,
                modelID: input.model.id,
              },
              toolName,
              args: finalArgs,
              result: executionResult,
            })
            if (post.preventContinuation) forcedStop = true
            return {
              ...executionResult,
              metadata: {
                ...executionResult.metadata,
                ...(post.metadata ?? {}),
              },
            }
          },
        })
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        const runtime = new QueryRuntime({
          assistantMessage: input.assistantMessage,
          sessionID: input.sessionID,
          model: input.model,
          abort: input.abort,
          partFromToolCall(toolCallID) {
            return assembler.partFromToolCall(toolCallID)
          },
        })

        let finalResult: QueryRuntimeResult = "continue"
        let finalError: unknown

        for await (const event of runtime.run(streamInput)) {
          if (event.type === "turn-finish") {
            finalResult = forcedStop && event.result === "continue" ? "stop" : event.result
            finalError = event.error
            continue
          }
          await assembler.consume(event)
        }

        await assembler.finalize(finalResult, finalError)
        if (input.assistantMessage.error) {
          Bus.publish(Session.Event.Error, {
            sessionID: input.assistantMessage.sessionID,
            error: input.assistantMessage.error,
          })
          return "stop"
        }
        return finalResult
      },
    }
    return result
  }
}
