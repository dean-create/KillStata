import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Bus } from "@/bus"
import { projectStateRoot } from "@/tool/analysis-state"
import { RuntimeEvents } from "./events"
import type {
  InputGraphNode,
  QueuedSessionAction,
  RestoreTarget,
  RuntimeCheckpoint,
  ContextManagerSnapshot,
  ExecPolicyDecision,
  RuntimeTaskRecord,
  RuntimeTaskStatus,
  TaskTimelineEvent,
  TaskTimelineEventKind,
} from "./types"

type LedgerFile = {
  version: 1
  sessionID: string
  activeTaskId?: string
  tasks: RuntimeTaskRecord[]
  checkpoints: RuntimeCheckpoint[]
}

function nowIso() {
  return new Date().toISOString()
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${crypto.createHash("sha1").update(value).digest("hex").slice(0, 12)}`
}

function ledgerRoot() {
  const root = path.join(projectStateRoot(), "tasks")
  fs.mkdirSync(root, { recursive: true })
  return root
}

function ledgerPath(sessionID: string) {
  return path.join(ledgerRoot(), `${sessionID}.json`)
}

function readLedger(sessionID: string): LedgerFile {
  const file = ledgerPath(sessionID)
  if (!fs.existsSync(file)) {
    return {
      version: 1,
      sessionID,
      tasks: [],
      checkpoints: [],
    }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LedgerFile>
    return {
      version: 1,
      sessionID,
      activeTaskId: parsed.activeTaskId,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
    }
  } catch {
    return {
      version: 1,
      sessionID,
      tasks: [],
      checkpoints: [],
    }
  }
}

function writeLedger(ledger: LedgerFile) {
  fs.writeFileSync(ledgerPath(ledger.sessionID), JSON.stringify(ledger, null, 2))
}

function publishTask(task: RuntimeTaskRecord) {
  Bus.publish(RuntimeEvents.TaskUpdated, {
    sessionID: task.sessionID,
    task,
  })
}

function publishTimeline(event: TaskTimelineEvent) {
  Bus.publish(RuntimeEvents.TimelineEvent, {
    sessionID: event.sessionID,
    event,
  })
}

function updateTask(
  sessionID: string,
  taskId: string,
  updater: (task: RuntimeTaskRecord, ledger: LedgerFile) => void,
) {
  const ledger = readLedger(sessionID)
  const task = ledger.tasks.find((item) => item.taskId === taskId)
  if (!task) return undefined
  updater(task, ledger)
  task.updatedAt = nowIso()
  writeLedger(ledger)
  publishTask(task)
  return task
}

function inputGraphFromMetadata(action: QueuedSessionAction): InputGraphNode[] {
  const graph = Array.isArray(action.metadata?.inputGraph) ? action.metadata.inputGraph : []
  return graph.filter((item): item is InputGraphNode => {
    if (!item || typeof item !== "object") return false
    const record = item as Record<string, unknown>
    return typeof record.id === "string" && typeof record.type === "string"
  })
}

export namespace RuntimeTaskLedger {
  export function recordQueued(action: QueuedSessionAction) {
    const ledger = readLedger(action.sessionID)
    const createdAt = nowIso()
    const task: RuntimeTaskRecord = {
      taskId: action.id,
      sessionID: action.sessionID,
      actionType: action.type,
      status: "queued",
      priority: action.priority,
      messageID: typeof action.metadata?.messageID === "string" ? action.metadata.messageID : undefined,
      inputGraph: inputGraphFromMetadata(action),
      timeline: [],
      metadata: action.metadata,
      createdAt,
      updatedAt: createdAt,
    }
    ledger.tasks = [...ledger.tasks.filter((item) => item.taskId !== action.id), task].slice(-100)
    ledger.activeTaskId = action.id
    writeLedger(ledger)
    publishTask(task)
    appendEvent({
      sessionID: action.sessionID,
      taskId: action.id,
      kind: "input.accepted",
      message: `${action.type} accepted`,
      metadata: action.metadata,
    })
    return task
  }

  export function markStatus(input: {
    sessionID: string
    taskId?: string
    status: RuntimeTaskStatus
    message?: string
    metadata?: Record<string, unknown>
  }) {
    const taskId = input.taskId ?? readLedger(input.sessionID).activeTaskId
    if (!taskId) return undefined
    const task = updateTask(input.sessionID, taskId, (draft, ledger) => {
      draft.status = input.status
      if (input.metadata) draft.metadata = { ...(draft.metadata ?? {}), ...input.metadata }
      if (["dispatching", "running", "queued"].includes(input.status)) ledger.activeTaskId = taskId
    })
    if (task) {
      appendEvent({
        sessionID: input.sessionID,
        taskId,
        kind: input.status === "completed" ? "completed" : "query.state",
        message: input.message ?? input.status,
        metadata: input.metadata,
      })
    }
    return task
  }

  export function appendEvent(input: {
    sessionID: string
    taskId?: string
    kind: TaskTimelineEventKind
    stageId?: string
    workflowRunId?: string
    message?: string
    metadata?: Record<string, unknown>
  }) {
    const ledger = readLedger(input.sessionID)
    const taskId = input.taskId ?? ledger.activeTaskId
    if (!taskId) return undefined
    const event: TaskTimelineEvent = {
      id: stableId("tle", `${taskId}:${input.kind}:${input.message ?? ""}:${Date.now()}:${Math.random()}`),
      taskId,
      sessionID: input.sessionID,
      kind: input.kind,
      stageId: input.stageId,
      workflowRunId: input.workflowRunId,
      message: input.message,
      metadata: input.metadata,
      createdAt: nowIso(),
    }
    const task = ledger.tasks.find((item) => item.taskId === taskId)
    if (task) {
      task.timeline = [...task.timeline, event].slice(-200)
      task.stageId = input.stageId ?? task.stageId
      task.workflowRunId = input.workflowRunId ?? task.workflowRunId
      task.updatedAt = event.createdAt
    }
    writeLedger(ledger)
    publishTimeline(event)
    if (task) publishTask(task)
    return event
  }

  export function recordPolicyDecision(sessionID: string, decision: ExecPolicyDecision) {
    const ledger = readLedger(sessionID)
    const taskId = ledger.activeTaskId
    if (taskId) {
      const task = ledger.tasks.find((item) => item.taskId === taskId)
      if (task) {
        task.policyDecisions = [...(task.policyDecisions ?? []), decision].slice(-50)
        task.audit = [
          ...(task.audit ?? []),
          {
            kind: "exec_policy",
            decisionId: decision.decisionId,
            action: decision.action,
            reason: decision.reason,
            createdAt: decision.createdAt,
          },
        ].slice(-100)
        task.updatedAt = nowIso()
      }
      writeLedger(ledger)
      if (task) publishTask(task)
    }
    appendEvent({
      sessionID,
      taskId,
      kind: "policy.decision",
      message: `${decision.toolName}: ${decision.action}`,
      metadata: { decision },
    })
  }

  export function recordContextSnapshot(sessionID: string, snapshot: ContextManagerSnapshot) {
    const ledger = readLedger(sessionID)
    const taskId = ledger.activeTaskId
    if (taskId) {
      const task = ledger.tasks.find((item) => item.taskId === taskId)
      if (task) {
        task.contextVersion = snapshot.historyVersion
        task.metadata = {
          ...(task.metadata ?? {}),
          latestContextSnapshot: snapshot,
        }
        task.updatedAt = nowIso()
      }
      writeLedger(ledger)
      if (task) publishTask(task)
    }
    appendEvent({
      sessionID,
      taskId,
      kind: "context.snapshot",
      message: `context v${snapshot.historyVersion}`,
      metadata: { snapshot },
    })
  }

  export function createCheckpoint(input: Omit<RuntimeCheckpoint, "checkpointId" | "createdAt">) {
    const ledger = readLedger(input.sessionID)
    const createdAt = nowIso()
    const checkpoint: RuntimeCheckpoint = {
      ...input,
      checkpointId: stableId(
        "chk",
        `${input.sessionID}:${input.workflowRunId ?? ""}:${input.stageId ?? ""}:${createdAt}`,
      ),
      createdAt,
    }
    ledger.checkpoints = [...ledger.checkpoints, checkpoint].slice(-50)
    if (input.taskId) {
      const task = ledger.tasks.find((item) => item.taskId === input.taskId)
      if (task) {
        task.latestCheckpointId = checkpoint.checkpointId
        task.updatedAt = createdAt
      }
    }
    ledger.activeTaskId = input.taskId ?? ledger.activeTaskId
    writeLedger(ledger)
    Bus.publish(RuntimeEvents.CheckpointCreated, {
      sessionID: input.sessionID,
      checkpoint,
    })
    appendEvent({
      sessionID: input.sessionID,
      taskId: input.taskId,
      kind: "checkpoint",
      stageId: input.stageId,
      workflowRunId: input.workflowRunId,
      message: "workflow checkpoint created",
    })
    return checkpoint
  }

  export function resolveRestoreTarget(sessionID: string, target: RestoreTarget = {}) {
    const ledger = readLedger(sessionID)
    const checkpoint = [...ledger.checkpoints]
      .reverse()
      .find((item) => {
        if (target.checkpointId) return item.checkpointId === target.checkpointId
        if (target.stageId) return item.stageId === target.stageId
        return item.verifierStatus !== "block"
      })
    return {
      ledger,
      checkpoint,
    }
  }

  export function recordRestore(sessionID: string, checkpoint: RuntimeCheckpoint, taskId?: string) {
    const ledger = readLedger(sessionID)
    const activeTaskId = taskId ?? ledger.activeTaskId
    if (activeTaskId) {
      const task = ledger.tasks.find((item) => item.taskId === activeTaskId)
      if (task) {
        task.status = "restored"
        task.latestCheckpointId = checkpoint.checkpointId
        task.stageId = checkpoint.stageId ?? task.stageId
        task.workflowRunId = checkpoint.workflowRunId ?? task.workflowRunId
        task.updatedAt = nowIso()
      }
    }
    writeLedger(ledger)
    Bus.publish(RuntimeEvents.RestoreCompleted, {
      sessionID,
      checkpoint,
      restoredTaskId: activeTaskId,
    })
    appendEvent({
      sessionID,
      taskId: activeTaskId,
      kind: "restore",
      stageId: checkpoint.stageId,
      workflowRunId: checkpoint.workflowRunId,
      message: "workflow restored from checkpoint",
      metadata: { checkpointId: checkpoint.checkpointId },
    })
  }

  export function listTasks(sessionID: string) {
    return readLedger(sessionID)
  }
}
