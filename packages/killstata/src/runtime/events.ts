import { BusEvent } from "@/bus/bus-event"
import z from "zod"

export namespace RuntimeEvents {
  export const QueryState = BusEvent.define(
    "runtime.query.state",
    z.object({
      sessionID: z.string(),
      phase: z.enum(["idle", "accepted", "dispatching", "running"]),
      generation: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      action: z.string().optional(),
    }),
  )

  export const QueueUpdated = BusEvent.define(
    "runtime.queue.updated",
    z.object({
      sessionID: z.string(),
      pending: z.number().int().nonnegative(),
      actions: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          priority: z.number(),
          createdAt: z.number(),
        }),
      ),
    }),
  )

  export const ToolBatch = BusEvent.define(
    "runtime.tool.batch",
    z.object({
      sessionID: z.string(),
      batchId: z.string(),
      parallel: z.boolean(),
      toolCalls: z.array(
        z.object({
          toolName: z.string(),
          callID: z.string(),
        }),
      ),
    }),
  )

  export const ToolLifecycle = BusEvent.define(
    "runtime.tool.lifecycle",
    z.object({
      sessionID: z.string(),
      callID: z.string(),
      toolName: z.string(),
      phase: z.enum(["queued", "running", "completed", "failed"]),
      batchId: z.string().optional(),
    }),
  )

  export const Compaction = BusEvent.define(
    "runtime.compaction",
    z.object({
      sessionID: z.string(),
      phase: z.enum(["snapshot", "trim", "collapse", "autocompact"]),
      details: z.record(z.string(), z.any()).optional(),
    }),
  )

  export const SubagentLifecycle = BusEvent.define(
    "runtime.subagent.lifecycle",
    z.object({
      sessionID: z.string(),
      subagentSessionID: z.string(),
      agent: z.string(),
      phase: z.enum(["queued", "running", "completed", "failed"]),
      }),
  )

  export const WorkflowState = BusEvent.define(
    "runtime.workflow.state",
    z.object({
      sessionID: z.string(),
      workflowRunId: z.string().optional(),
      branch: z.string().optional(),
      activeStage: z.string().optional(),
      activeStageId: z.string().optional(),
      repairOnly: z.boolean().optional(),
      latestFailureCode: z.string().optional(),
      verifierStatus: z.enum(["pass", "warn", "block"]).optional(),
      trustedArtifacts: z.array(z.string()).default([]),
      rerunTargetStageId: z.string().optional(),
    }),
  )
}
