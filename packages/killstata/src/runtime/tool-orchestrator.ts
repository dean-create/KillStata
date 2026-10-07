import { Bus } from "@/bus"
import { RuntimeEvents } from "./events"
import type { ToolBatchPlan, ToolExecutionTraits, QueryCorrelation } from "./types"

type ScheduledTask<T> = {
  plan: ToolBatchPlan
  promise: Promise<T>
}

export type ToolCancellationCode = "TOOL_ABORTED_BEFORE_DISPATCH" | "TOOL_ABORTED"

export class ToolExecutionAbortedError extends Error {
  constructor(public readonly code: ToolCancellationCode, message: string) {
    super(message)
    this.name = "ToolExecutionAbortedError"
  }
}

function cancellationError(beforeDispatch: boolean) {
  return beforeDispatch
    ? new ToolExecutionAbortedError("TOOL_ABORTED_BEFORE_DISPATCH", "工具调用在执行前已取消")
    : new ToolExecutionAbortedError("TOOL_ABORTED", "工具调用执行期间已取消")
}

/** 等待串行屏障时也必须响应取消，不能等前一个不合作的工具自行结束。 */
function waitForDispatch<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(cancellationError(true))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(cancellationError(true))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

type LifecyclePhase = "queued" | "running" | "completed" | "failed" | "cancelled"
type CancellationReason = "cancelled_before_dispatch" | "cancelled_during_execution"

type ExecuteInput<T> = {
  callID: string
  toolName: string
  traits: ToolExecutionTraits
  correlation?: QueryCorrelation
  signal?: AbortSignal
  run: () => Promise<T>
}

export class ToolOrchestrator {
  private serialTail: Promise<void> = Promise.resolve()
  private currentReadBatch:
    | {
        plan: ToolBatchPlan
        tasks: Promise<unknown>[]
      }
    | undefined
  private batchCounter = 0

  constructor(private readonly sessionID: string) {}

  async execute<T>(input: ExecuteInput<T>): Promise<T> {
    if (input.signal?.aborted) {
      const batchId = `batch-${++this.batchCounter}`
      Bus.publish(RuntimeEvents.ToolBatch, {
        sessionID: this.sessionID,
        batchId,
        parallel: false,
        toolCalls: [{ toolName: input.toolName, callID: input.callID }],
      })
      this.publishPhase(input, batchId, "queued")
      this.publishPhase(input, batchId, "cancelled", "cancelled_before_dispatch")
      return Promise.reject(cancellationError(true))
    }

    const scheduled = input.traits.concurrencySafe ? this.scheduleParallel(input) : this.scheduleSerial(input)
    this.publishPhase(input, scheduled.plan.batchId, "queued")
    return scheduled.promise
  }

  private publishPhase(
    input: { callID: string; toolName: string; correlation?: QueryCorrelation },
    batchId: string,
    phase: LifecyclePhase,
    reason?: CancellationReason,
  ) {
    Bus.publish(RuntimeEvents.ToolLifecycle, {
      sessionID: this.sessionID,
      callID: input.callID,
      toolName: input.toolName,
      phase,
      batchId,
      correlation: input.correlation,
      reason,
    })
  }

  /** 三条调度路径共用的执行段：派发前后各检查一次取消信号，并把阶段变化广播出去。 */
  private async runWithLifecycle<T>(input: ExecuteInput<T>, batchId: string): Promise<T> {
    if (input.signal?.aborted) {
      this.publishPhase(input, batchId, "cancelled", "cancelled_before_dispatch")
      throw cancellationError(true)
    }
    this.publishPhase(input, batchId, "running")
    try {
      const result = await input.run()
      if (input.signal?.aborted) throw cancellationError(false)
      this.publishPhase(input, batchId, "completed")
      return result
    } catch (error) {
      const cancelled = error instanceof ToolExecutionAbortedError || input.signal?.aborted
      const finalError = cancelled && !(error instanceof ToolExecutionAbortedError) ? cancellationError(false) : error
      this.publishPhase(
        input,
        batchId,
        cancelled ? "cancelled" : "failed",
        cancelled ? "cancelled_during_execution" : undefined,
      )
      throw finalError
    }
  }

  private scheduleParallel<T>(input: ExecuteInput<T>): ScheduledTask<T> {
    if (!this.currentReadBatch) {
      const plan: ToolBatchPlan = {
        batchId: `batch-${++this.batchCounter}`,
        parallel: true,
        toolCalls: [],
      }
      this.currentReadBatch = {
        plan,
        tasks: [],
      }
    }

    const batch = this.currentReadBatch
    batch.plan.toolCalls.push({
      toolName: input.toolName,
      callID: input.callID,
    })
    Bus.publish(RuntimeEvents.ToolBatch, {
      sessionID: this.sessionID,
      batchId: batch.plan.batchId,
      parallel: true,
      toolCalls: [...batch.plan.toolCalls],
    })
    const batchId = batch.plan.batchId

    const promise = waitForDispatch(this.serialTail, input.signal)
      .then(() => this.runWithLifecycle(input, batchId))
      .catch((error) => {
        if (error instanceof ToolExecutionAbortedError && error.code === "TOOL_ABORTED_BEFORE_DISPATCH") {
          this.publishPhase(input, batchId, "cancelled", "cancelled_before_dispatch")
        }
        throw error
      })
    batch.tasks.push(promise)
    return {
      plan: batch.plan,
      promise,
    }
  }

  private scheduleSerial<T>(input: ExecuteInput<T>): ScheduledTask<T> {
    const readBatch = this.currentReadBatch
    this.currentReadBatch = undefined
    const waitForReads = readBatch ? Promise.allSettled(readBatch.tasks).then(() => undefined) : Promise.resolve()
    const plan: ToolBatchPlan = {
      batchId: `batch-${++this.batchCounter}`,
      parallel: false,
      toolCalls: [{ toolName: input.toolName, callID: input.callID }],
    }

    Bus.publish(RuntimeEvents.ToolBatch, {
      sessionID: this.sessionID,
      batchId: plan.batchId,
      parallel: false,
      toolCalls: plan.toolCalls,
    })

    const promise = Promise.all([
      waitForDispatch(this.serialTail, input.signal),
      waitForDispatch(waitForReads, input.signal),
    ])
      .then(() => this.runWithLifecycle(input, plan.batchId))
      .catch((error) => {
        if (error instanceof ToolExecutionAbortedError && error.code === "TOOL_ABORTED_BEFORE_DISPATCH") {
          this.publishPhase(input, plan.batchId, "cancelled", "cancelled_before_dispatch")
        }
        throw error
      })

    this.serialTail = promise.then(
      () => undefined,
      () => undefined,
    )

    return { plan, promise }
  }
}
