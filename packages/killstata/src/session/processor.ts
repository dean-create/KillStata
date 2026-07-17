import { Bus } from "@/bus"
import { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import { registerDefaultRuntimeHooks } from "@/runtime/default-hooks"
import { RuntimeHooks } from "@/runtime/hooks"
import {
  QueryRuntime,
  REPEATED_TOOL_CALL_THRESHOLD,
  repeatedToolCallCount,
  toolCallSignature,
} from "@/runtime/query-runtime"
import { toolExecutionTraits } from "@/runtime/tool-policy"
import { isWorkflowAnalysisTool, isWorkflowReadOnlyAction } from "@/runtime/tool-catalog"
import { ToolOrchestrator } from "@/runtime/tool-orchestrator"
import { TurnAssembler } from "@/runtime/turn-assembler"
import type { QueryRuntimeResult } from "@/runtime/types"
import { Log } from "@/util/log"
import type { MessageV2 } from "./message-v2"
import type { Provider } from "@/provider/provider"
import { Session } from "."
import { LLM } from "./llm"
import { prepareToolMetadata } from "@/runtime/tool-result-policy"

export namespace SessionProcessor {
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
    repairToolName?: string
    repairInputSignature?: string
    onRepairToolSucceeded?: () => void
  }) {
    registerDefaultRuntimeHooks()

    const assembler = new TurnAssembler({
      assistantMessage: input.assistantMessage,
      sessionID: input.sessionID,
      model: input.model,
    })
    const orchestrator = new ToolOrchestrator(input.sessionID)
    const activeToolCalls = new Map<string, number>()
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
          run: (args: unknown) => Promise<{
            title: string
            metadata: M
            output: string
            attachments?: MessageV2.FilePart[]
          } & Record<string, unknown>>
        },
      ) {
        if (
          input.repairToolName &&
          toolName === input.repairToolName &&
          input.repairInputSignature === toolCallSignature(toolName, args)
        ) {
          throw new Error(
            `REPAIR_INPUT_UNCHANGED：自动修复 ${input.repairToolName} 时拒绝原样重复上次失败参数。`,
          )
        }
        if (input.repairToolName && toolName !== input.repairToolName && isWorkflowAnalysisTool(toolName)) {
          throw new Error(
            `REPAIR_TOOL_MISMATCH：自动修复只能重试 ${input.repairToolName}，拒绝切换到 ${toolName}。`,
          )
        }
        if (input.repairToolName && toolName === "workflow" && !isWorkflowReadOnlyAction(args)) {
          throw new Error(
            `REPAIR_WORKFLOW_MUTATION_DENIED：自动修复 ${input.repairToolName} 期间只允许查看工作流状态。`,
          )
        }

        // AI SDK 会并发启动同一响应里的多个 tool-call，因此必须在第一次 await 之前原子登记。
        const signature = toolCallSignature(toolName, args)
        const activeDuplicates = activeToolCalls.get(signature) ?? 0
        activeToolCalls.set(signature, activeDuplicates + 1)

        try {
          // 必须在 orchestrator/meta.run 之前检查；等 fullStream 发出 tool-call 时，原生工具可能已经执行。
          const recentMessages = await Session.messages({ sessionID: input.sessionID, limit: 20 })
          const historicalDuplicates = repeatedToolCallCount(
            recentMessages.flatMap((message) => message.parts),
            {
              toolCallId: meta.callID ?? "",
              toolName,
              input: args,
            },
          )
          const repeated = historicalDuplicates + activeDuplicates >= REPEATED_TOOL_CALL_THRESHOLD
          if (repeated) {
            const agent = await Agent.get(input.assistantMessage.agent)
            if (agent) {
              await PermissionNext.ask({
                permission: "doom_loop",
                patterns: [toolName],
                sessionID: input.sessionID,
                metadata: { tool: toolName, input: args },
                always: [toolName],
                ruleset: agent.permission,
              })
            }
          }

          const pre = await RuntimeHooks.preTool({
            sessionID: input.sessionID,
            toolName,
            args,
          })
          if (pre.block) throw new Error(pre.block)
          const finalArgs = pre.updatedInput ?? args
          const traits = toolExecutionTraits(toolName, finalArgs)

          return await orchestrator.execute({
            callID: meta.callID ?? "",
            toolName,
            traits,
            run: async () => {
              const executionResult = await meta.run(finalArgs)
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
              if (toolName === input.repairToolName) input.onRepairToolSucceeded?.()
              return {
                ...executionResult,
                metadata: prepareToolMetadata({
                  ...executionResult.metadata,
                  ...(post.metadata ?? {}),
                }) as M,
              }
            },
          })
        } finally {
          const remaining = (activeToolCalls.get(signature) ?? 1) - 1
          if (remaining === 0) activeToolCalls.delete(signature)
          else activeToolCalls.set(signature, remaining)
        }
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
