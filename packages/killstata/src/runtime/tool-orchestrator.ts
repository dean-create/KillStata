import { Bus } from "@/bus"
import { RuntimeEvents } from "./events"
import type { ToolBatchPlan, ToolExecutionTraits } from "./types"

type ScheduledTask<T> = {
  plan: ToolBatchPlan
  promise: Promise<T>
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

  async execute<T>(input: {
    callID: string
    toolName: string
    traits: ToolExecutionTraits
    run: () => Promise<T>
  }): Promise<T> {
    const scheduled = input.traits.concurrencySafe ? this.scheduleParallel(input) : this.scheduleSerial(input)

    Bus.publish(RuntimeEvents.ToolLifecycle, {
      sessionID: this.sessionID,
      callID: input.callID,
      toolName: input.toolName,
      phase: "queued",
      batchId: scheduled.plan.batchId,
    })

    return scheduled.promise
  }

  private scheduleParallel<T>(input: {
    callID: string
    toolName: string
    traits: ToolExecutionTraits
    run: () => Promise<T>
  }): ScheduledTask<T> {
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

    const promise = this.serialTail.then(async () => {
      Bus.publish(RuntimeEvents.ToolLifecycle, {
        sessionID: this.sessionID,
        callID: input.callID,
        toolName: input.toolName,
        phase: "running",
        batchId,
      })
      try {
        const result = await input.run()
        Bus.publish(RuntimeEvents.ToolLifecycle, {
          sessionID: this.sessionID,
          callID: input.callID,
          toolName: input.toolName,
          phase: "completed",
          batchId,
        })
        return result
      } catch (error) {
        Bus.publish(RuntimeEvents.ToolLifecycle, {
          sessionID: this.sessionID,
          callID: input.callID,
          toolName: input.toolName,
          phase: "failed",
          batchId,
        })
        throw error
      }
    })
    batch.tasks.push(promise)
    return {
      plan: batch.plan,
      promise,
    }
  }

  private scheduleSerial<T>(input: {
    callID: string
    toolName: string
    traits: ToolExecutionTraits
    run: () => Promise<T>
  }): ScheduledTask<T> {
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

    const promise = Promise.all([this.serialTail, waitForReads]).then(async () => {
      Bus.publish(RuntimeEvents.ToolLifecycle, {
        sessionID: this.sessionID,
        callID: input.callID,
        toolName: input.toolName,
        phase: "running",
        batchId: plan.batchId,
      })
      try {
        const result = await input.run()
        Bus.publish(RuntimeEvents.ToolLifecycle, {
          sessionID: this.sessionID,
          callID: input.callID,
          toolName: input.toolName,
          phase: "completed",
          batchId: plan.batchId,
        })
        return result
      } catch (error) {
        Bus.publish(RuntimeEvents.ToolLifecycle, {
          sessionID: this.sessionID,
          callID: input.callID,
          toolName: input.toolName,
          phase: "failed",
          batchId: plan.batchId,
        })
        throw error
      }
    })

    this.serialTail = promise.then(
      () => undefined,
      () => undefined,
    )

    return { plan, promise }
  }
}
