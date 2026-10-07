import { BusEvent } from "@/bus/bus-event"
import z from "zod"

/** 与 types.ts 的 CompactionLifecycle 对应；任务记录和时间线事件共用同一份定义。 */
const CompactionLifecycleSchema = z.object({
  operationId: z.string(),
  sessionID: z.string(),
  parentID: z.string(),
  reason: z.enum(["manual", "threshold", "overflow"]),
  status: z.enum(["started", "completed", "failed", "cancelled"]),
  inputMessageCount: z.number().int().nonnegative(),
  inputHistoryVersion: z.number().int().nonnegative().optional(),
  summarySource: z.enum(["model", "fallback"]).optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const RuntimeTaskRecord = z.object({
  taskId: z.string(),
  sessionID: z.string(),
  actionType: z.string(),
  status: z.enum(["queued", "dispatching", "running", "completed", "failed", "cancelled", "restored"]),
  priority: z.number(),
  messageID: z.string().optional(),
  workflowRunId: z.string().optional(),
  stageId: z.string().optional(),
  activeStage: z.string().optional(),
  inputGraph: z.array(z.record(z.string(), z.any())).default([]),
  timeline: z.array(z.record(z.string(), z.any())).default([]),
  latestCheckpointId: z.string().optional(),
  latestFailureCode: z.string().optional(),
  verifierStatus: z.enum(["pass", "warn", "block"]).optional(),
  repairOnly: z.boolean().optional(),
  policyDecisions: z.array(z.record(z.string(), z.any())).optional(),
  audit: z.array(z.record(z.string(), z.any())).optional(),
  contextVersion: z.number().optional(),
  compaction: CompactionLifecycleSchema.optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const TaskTimelineEvent = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative().optional(),
  taskId: z.string(),
  sessionID: z.string(),
  kind: z.string(),
  correlation: z.record(z.string(), z.any()).optional(),
  stageId: z.string().optional(),
  workflowRunId: z.string().optional(),
  compaction: CompactionLifecycleSchema.optional(),
  message: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  createdAt: z.string(),
})

const RuntimeCheckpoint = z.object({
  checkpointId: z.string(),
  taskId: z.string().optional(),
  sessionID: z.string(),
  workflowRunId: z.string().optional(),
  stageId: z.string().optional(),
  branch: z.string().optional(),
  activeStage: z.string().optional(),
  trustedArtifacts: z.array(z.string()).default([]),
  verifierStatus: z.enum(["pass", "warn", "block"]).optional(),
  repairOnly: z.boolean().optional(),
  replayInput: z.record(z.string(), z.any()).optional(),
  createdAt: z.string(),
})

const RuntimeProtocolEnvelope = z.object({
  version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  sessionID: z.string(),
  source: z.enum(["runtime", "workflow", "tool", "verifier", "task-ledger", "agent-control", "context"]),
  event: z.object({
    type: z.string(),
    sessionID: z.string(),
    payload: z.record(z.string(), z.any()),
  }),
  createdAt: z.string(),
  compatibility: z.record(z.string(), z.any()).optional(),
})

const ExecPolicyDecisionSchema = z.object({
  decisionId: z.string(),
  sessionID: z.string(),
  toolName: z.string(),
  command: z.string(),
  action: z.enum(["allow", "ask", "deny"]),
  reason: z.string(),
  matchedRule: z.string().optional(),
  networkAccess: z.boolean().optional(),
  filesystemRisk: z.enum(["none", "external_write", "destructive", "trusted_artifact_overwrite"]).optional(),
  createdAt: z.string(),
})

const ContextUsageSnapshotSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  contextLimit: z.number().nullable(),
  inputBudget: z.number().nullable(),
  reserveTokens: z.number().nonnegative(),
  estimatedPromptTokens: z.number().int().nonnegative(),
  estimatedSystemTokens: z.number().int().nonnegative(),
  estimatedToolTokens: z.number().int().nonnegative(),
  estimatedMessageTokens: z.number().int().nonnegative(),
  actual: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      reasoningTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative(),
      cacheWriteTokens: z.number().int().nonnegative(),
      promptTokens: z.number().int().nonnegative(),
      usedTokens: z.number().int().nonnegative(),
    })
    .optional(),
  usedTokens: z.number().int().nonnegative(),
  remainingTokens: z.number().nullable(),
  percentage: z.number().nullable(),
  source: z.enum(["estimated", "actual"]),
  compactionState: z.enum(["none", "pending", "microcompact", "summary"]),
  updatedAt: z.string(),
  cache: z
    .object({
      observationCount: z.number().int().nonnegative(),
      truncated: z.boolean(),
      uncachedInputTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative(),
      cacheWriteTokens: z.number().int().nonnegative(),
      promptTokens: z.number().int().nonnegative(),
      hitRatio: z.number().nonnegative(),
      breakCount: z.number().int().nonnegative(),
      breakReasons: z.record(z.string(), z.number().int().nonnegative()),
      lastBreakReason: z.string().optional(),
      updatedAt: z.string(),
    })
    .optional(),
  lastAction: z
    .object({
      action: z.enum(["offload", "read-bound", "history-snip", "progressive", "microcompact", "collapse", "prune", "summary", "restoring", "failed"]),
      operationId: z.string().optional(),
      beforeTokens: z.number().int().nonnegative().optional(),
      afterTokens: z.number().int().nonnegative().optional(),
      savedEstimate: z.number().int().nonnegative().optional(),
      restoredReferences: z.number().int().nonnegative().optional(),
      removedTurns: z.number().int().nonnegative().optional(),
      clearedParts: z.number().int().nonnegative().optional(),
      emergency: z.boolean().optional(),
      reason: z.enum(["pressure", "time-gap"]).optional(),
      summarySource: z.enum(["model", "fallback"]).optional(),
      failureStreak: z.number().int().nonnegative().optional(),
      updatedAt: z.string(),
    })
    .optional(),
})

const ContextManagerSnapshotSchema = z.object({
  sessionID: z.string(),
  historyVersion: z.number().int().nonnegative(),
  referenceContext: z.record(z.string(), z.any()),
  tokenEstimate: z.number().int().nonnegative(),
  protectedItems: z.array(z.string()),
  imageInputs: z.array(z.record(z.string(), z.any())),
  createdAt: z.string(),
  usage: ContextUsageSnapshotSchema.optional(),
  capsule: z.record(z.string(), z.any()).optional(),
  lastAction: ContextUsageSnapshotSchema.shape.lastAction,
})

const AgentControlStateSchema = z.object({
  sessionID: z.string(),
  activeAgent: z.enum(["explore", "general", "verifier"]).optional(),
  forkMode: z.enum(["minimal_context", "last_n_turns", "workflow_slice"]).optional(),
  decisions: z.array(z.record(z.string(), z.any())),
  messages: z.array(z.record(z.string(), z.any())),
  updatedAt: z.string(),
})

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
          delivery: z.enum(["queued", "steer"]).optional(),
        }),
      ),
    }),
  )

  export const TaskUpdated = BusEvent.define(
    "runtime.task.updated",
    z.object({
      sessionID: z.string(),
      task: RuntimeTaskRecord,
    }),
  )

  export const TimelineEvent = BusEvent.define(
    "runtime.timeline.event",
    z.object({
      sessionID: z.string(),
      event: TaskTimelineEvent,
    }),
  )

  export const CheckpointCreated = BusEvent.define(
    "runtime.checkpoint.created",
    z.object({
      sessionID: z.string(),
      checkpoint: RuntimeCheckpoint,
    }),
  )

  export const RestoreCompleted = BusEvent.define(
    "runtime.restore.completed",
    z.object({
      sessionID: z.string(),
      checkpoint: RuntimeCheckpoint,
      restoredTaskId: z.string().optional(),
    }),
  )

  export const ProtocolEvent = BusEvent.define(
    "runtime.protocol.event",
    z.object({
      envelope: RuntimeProtocolEnvelope,
    }),
  )

  export const ExecPolicyDecision = BusEvent.define(
    "runtime.exec_policy.decision",
    z.object({
      sessionID: z.string(),
      decision: ExecPolicyDecisionSchema,
    }),
  )

  export const ContextSnapshot = BusEvent.define(
    "runtime.context.snapshot",
    z.object({
      sessionID: z.string(),
      snapshot: ContextManagerSnapshotSchema,
    }),
  )

  export const AgentControlState = BusEvent.define(
    "runtime.agent_control.state",
    z.object({
      sessionID: z.string(),
      state: AgentControlStateSchema,
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
      phase: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
      batchId: z.string().optional(),
      correlation: z.record(z.string(), z.any()).optional(),
      reason: z.enum(["cancelled_before_dispatch", "cancelled_during_execution"]).optional(),
    }),
  )

  export const ToolProgress = BusEvent.define(
    "runtime.tool.progress",
    z.object({
      sessionID: z.string(),
      callID: z.string(),
      toolName: z.string(),
      message: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
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
      workflowLocale: z.enum(["zh-CN", "en"]).optional(),
      branch: z.string().optional(),
      activeStage: z.string().optional(),
      activeStageId: z.string().optional(),
      activeCoordinatorAgent: z.enum(["explore", "general", "verifier"]).optional(),
      repairOnly: z.boolean().optional(),
      latestFailureCode: z.string().optional(),
      verifierStatus: z.enum(["pass", "warn", "block"]).optional(),
      trustedArtifacts: z.array(z.string()).default([]),
      rerunTargetStageId: z.string().optional(),
      approvalStatus: z.enum(["required", "approved", "declined"]).optional(),
      currentChecklistItem: z
        .object({
          id: z.string(),
          label: z.string(),
          status: z.enum(["pending", "in_progress", "completed", "blocked"]),
        })
        .optional(),
      analysisChecklist: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            status: z.enum(["pending", "in_progress", "completed", "blocked"]),
            linkedStageId: z.string().optional(),
            summary: z.string().optional(),
          }),
        )
        .default([]),
    }),
  )
}
