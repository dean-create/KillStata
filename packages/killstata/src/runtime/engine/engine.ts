import {
  ToolCallSkippedError,
  type ToolCallFailure,
  type ToolUseLoopAdapter,
  type ToolUseLoopFailureStage,
} from "./types"

export class AgentEngine {
  static async *runToolUse<Request, Event, Call, Output, Decision>(input: {
    request: Request
    adapter: ToolUseLoopAdapter<Request, Event, Call, Output, Decision>
  }): AsyncGenerator<Event> {
    let request = input.request

    const failureEvent = (stage: ToolUseLoopFailureStage, error: unknown, callIDs?: string[]) => {
      const event = input.adapter.loopFailureEvent?.({ stage, error, callIDs })
      if (event !== undefined) return event
      throw error instanceof Error ? error : new Error(String(error))
    }
    const skippedOutcome = (call: Call, reason: string) => {
      const error = new ToolCallSkippedError(reason)
      const event = input.adapter.skippedEvent?.(call, error) ?? input.adapter.errorEvent(call, error)
      return { call, error, event, skipped: true } satisfies ToolCallFailure<Call, Event>
    }

    while (true) {
      const calls: Call[] = []
      let terminal: Decision | undefined
      let streamFailure: { stage: ToolUseLoopFailureStage; error: unknown } | undefined

      try {
        const stream = await input.adapter.stream(request)
        for await (const event of stream) {
          let call: Call | undefined
          let decision: Decision | undefined
          try {
            call = input.adapter.callFromEvent(event)
            if (call !== undefined) calls.push(call)
            decision = input.adapter.decisionFromEvent(event)
            if (decision !== undefined) {
              terminal = decision
              const shouldContinue = input.adapter.continues(decision)
              if (calls.length > 0 && shouldContinue) continue
              if (calls.length > 0) {
                for (const pending of calls) {
                  yield skippedOutcome(pending, "模型已给出终止决策；本响应中的工具调用未执行。").event
                }
                yield event
                return
              }
              yield event
              return
            }
          } catch (error) {
            streamFailure = { stage: decision === undefined ? "stream" : "result_decision", error }
            break
          }
          yield event
        }
      } catch (error) {
        streamFailure ??= { stage: "stream", error }
      }

      if (streamFailure) {
        yield failureEvent(streamFailure.stage, streamFailure.error, calls.map(callID))
        return
      }
      if (calls.length === 0) return

      const executeOne = async (call: Call, batchSize: number, batchIndex: number) => {
        try {
          return { call, output: await input.adapter.execute(call, { batchSize, batchIndex }) } as const
        } catch (error) {
          return { call, error } as const
        }
      }

      // 连续只读调用可并行；副作用调用串行。任一失败或明确收尾后，未调度的调用
      // 会收到独立 skipped 终态，不能留给外层模糊地补成“Tool execution aborted”。
      const executions: Array<Awaited<ReturnType<typeof executeOne>> | undefined> = new Array(calls.length)
      let parallelBatch: Array<{ index: number; call: Call }> = []
      let stopQueuedCalls = false
      let schedulingFailure: unknown
      const flushParallelBatch = async () => {
        if (parallelBatch.length === 0) return
        const batch = parallelBatch
        parallelBatch = []
        const maxParallelCalls = Number.isInteger(input.adapter.maxParallelCalls) && input.adapter.maxParallelCalls! > 0
          ? input.adapter.maxParallelCalls!
          : 10
        for (let offset = 0; offset < batch.length && !stopQueuedCalls; offset += maxParallelCalls) {
          const chunk = batch.slice(offset, offset + maxParallelCalls)
          const results = await Promise.all(chunk.map((item) => executeOne(item.call, calls.length, item.index)))
          results.forEach((result, resultIndex) => {
            executions[chunk[resultIndex].index] = result
          })
          if (
            results.some((result) => "error" in result) ||
            results.some((result) => "output" in result && input.adapter.shouldStopAfterResult?.(result.output as Output) === true)
          ) stopQueuedCalls = true
        }
      }

      try {
        for (const [index, call] of calls.entries()) {
          if (stopQueuedCalls) break
          if (input.adapter.canExecuteInParallel?.(call) ?? true) {
            parallelBatch.push({ index, call })
            continue
          }
          await flushParallelBatch()
          if (stopQueuedCalls) break
          const execution = await executeOne(call, calls.length, index)
          executions[index] = execution
          if (
            "error" in execution ||
            ("output" in execution && input.adapter.shouldStopAfterResult?.(execution.output as Output) === true)
          ) stopQueuedCalls = true
        }
        if (!stopQueuedCalls) await flushParallelBatch()
      } catch (error) {
        schedulingFailure = error
        stopQueuedCalls = true
      }

      const rawSucceeded = executions.filter(
        (execution): execution is Extract<NonNullable<(typeof executions)[number]>, { output: Output }> =>
          execution !== undefined && "output" in execution,
      )
      const toolEvents = new Map<number, Event>()
      const toolFailures: Array<ToolCallFailure<Call, Event>> = []
      let failureDecision: Decision | undefined
      let decisionFailure: { stage: ToolUseLoopFailureStage; error: unknown } | undefined

      for (const [index, execution] of executions.entries()) {
        const call = calls[index]!
        if (!execution) {
          const skipped = skippedOutcome(call, "同一批次中更早的工具失败或要求收尾；本调用未执行。")
          toolEvents.set(index, skipped.event)
          toolFailures.push(skipped)
          continue
        }
        if ("error" in execution) {
          let event: Event
          try {
            event = input.adapter.errorEvent(execution.call, execution.error)
          } catch (error) {
            decisionFailure ??= { stage: "result_event", error }
            continue
          }
          try {
            const nextDecision = await input.adapter.onToolError(event)
            if (nextDecision === undefined) {
              decisionFailure ??= {
                stage: "unhandled_tool_failure",
                error: new Error("工具执行失败，但适配器没有返回继续、修复或停止决策。"),
              }
            } else {
              const mergedDecision = input.adapter.mergeToolErrorDecisions
                ? input.adapter.mergeToolErrorDecisions(failureDecision, nextDecision)
                : failureDecision ?? nextDecision
              if (mergedDecision === undefined) {
                decisionFailure ??= {
                  stage: "unhandled_tool_failure",
                  error: new Error("工具失败决策合并器丢弃了所有停止/修复决定。"),
                }
              } else {
                failureDecision = mergedDecision
              }
            }
          } catch (error) {
            // 保留原始工具错误事件，再以明确的 loop failure 收尾；hook 崩溃绝不能
            // 丢掉真正失败原因，也不能把已执行工具放回下一轮重跑。
            toolEvents.set(index, event)
            toolFailures.push({ call: execution.call, error: execution.error, event, skipped: false })
            decisionFailure ??= { stage: "tool_error_handler", error }
            continue
          }
          toolEvents.set(index, event)
          toolFailures.push({ call: execution.call, error: execution.error, event, skipped: false })
        }
      }

      let prepared: Array<{ call: Call; output: Output }>
      try {
        prepared = input.adapter.prepareToolResults
          ? await input.adapter.prepareToolResults(rawSucceeded, toolFailures.length)
          : rawSucceeded
        if (prepared.length !== rawSucceeded.length) {
          throw new Error("prepareToolResults must preserve the number and order of successful tool calls")
        }
      } catch (error) {
        for (const event of toolEvents.values()) yield event
        yield failureEvent("prepare_results", error, rawSucceeded.map((item) => callID(item.call)))
        return
      }

      for (const [successIndex, execution] of executions.entries()) {
        if (!execution || "error" in execution) continue
        const preparedIndex = rawSucceeded.findIndex((item) => item.call === execution.call)
        try {
          const output = prepared[preparedIndex]?.output ?? execution.output
          toolEvents.set(successIndex, input.adapter.resultEvent(execution.call, output))
        } catch (error) {
          decisionFailure ??= { stage: "result_event", error }
        }
      }

      for (const [, event] of [...toolEvents.entries()].sort(([left], [right]) => left - right)) yield event
      if (decisionFailure) {
        yield failureEvent(decisionFailure.stage, decisionFailure.error, calls.map(callID))
        return
      }
      if (schedulingFailure) {
        yield failureEvent("schedule", schedulingFailure, calls.map(callID))
        return
      }

      const succeeded = rawSucceeded.map((item, index) => ({ call: item.call, output: prepared[index]!.output }))
      try {
        if (succeeded.length > 0) input.adapter.afterToolResults?.(succeeded)
      } catch (error) {
        yield failureEvent("after_results", error, succeeded.map((item) => callID(item.call)))
        return
      }

      if (failureDecision !== undefined) {
        const failed = executions.filter(
          (execution): execution is { call: Call; error: unknown } =>
            execution !== undefined && "error" in execution,
        )
        let canContinueAfterMixedFailure = false
        try {
          canContinueAfterMixedFailure = succeeded.length > 0 && failed.length > 0 &&
            input.adapter.continueAfterMixedToolFailure !== undefined &&
            await input.adapter.continueAfterMixedToolFailure({ succeeded, failed, decision: failureDecision })
        } catch (error) {
          yield failureEvent("result_decision", error, calls.map(callID))
          return
        }
        if (canContinueAfterMixedFailure) {
          try {
            request = await input.adapter.appendToolResults(request, succeeded, toolFailures, calls)
          } catch (error) {
            yield failureEvent("append_results", error, succeeded.map((item) => callID(item.call)))
            return
          }
          continue
        }
        try {
          yield input.adapter.terminalEvent(failureDecision)
        } catch (error) {
          yield failureEvent("result_decision", error, calls.map(callID))
        }
        return
      }

      try {
        request = await input.adapter.appendToolResults(request, succeeded, toolFailures, calls)
      } catch (error) {
        yield failureEvent("append_results", error, succeeded.map((item) => callID(item.call)))
        return
      }
      try {
        if (input.adapter.shouldContinueAfterResults && !input.adapter.shouldContinueAfterResults(succeeded)) {
          const decision = input.adapter.decisionAfterResults?.(succeeded)
          if (decision === undefined) {
            yield failureEvent("result_decision", new Error("工具结果要求停止继续，但适配器没有给出终止决策。"))
            return
          }
          yield input.adapter.terminalEvent(decision)
          return
        }
        if (terminal !== undefined && !input.adapter.continues(terminal)) {
          yield input.adapter.terminalEvent(terminal)
          return
        }
      } catch (error) {
        yield failureEvent("result_decision", error, calls.map(callID))
        return
      }
    }
  }
}

function callID(call: unknown) {
  return String((call as { toolCallId?: unknown; id?: unknown })?.toolCallId ?? (call as { id?: unknown })?.id ?? "")
}
