import { Bus } from "@/bus"
import { Token } from "@/util/token"
import { RuntimeEvents } from "./events"
import { RuntimeProtocol } from "./protocol"
import { RuntimeTaskLedger, type LedgerFile } from "./task-ledger"
import { workflowStatusSummary } from "./workflow"
import { buildContextCapsule } from "./context-capsule-adapter"
import type { ContextCapsule } from "./context-capsule"
import type { ContextUsageSnapshot } from "./context-budget"
import type { ContextActionStatus, ContextManagerSnapshot } from "./types"

function nowIso() {
  return new Date().toISOString()
}

function emptyLedger(sessionID: string): LedgerFile {
  return {
    version: 1,
    sessionID,
    tasks: [],
    checkpoints: [],
  }
}

function readLedgerForSnapshot(sessionID: string) {
  try {
    return { ledger: RuntimeTaskLedger.listTasks(sessionID), available: true }
  } catch {
    // Context telemetry must remain readable when an old/non-atomic ledger is corrupt;
    // recordContextSnapshot will skip persistence rather than overwrite the evidence.
    return { ledger: emptyLedger(sessionID), available: false }
  }
}

export namespace ContextManager {
  export function snapshot(input: {
    sessionID: string
    text?: string
    modelSupportsImages?: boolean
    /** 已经读到的 ledger；publish* 会把同一份传进来，避免同一次发布重复解析文件。 */
    ledger?: LedgerFile
    capsule?: ContextCapsule
  }): ContextManagerSnapshot {
    const workflow = workflowStatusSummary(input.sessionID)
    const ledger = input.ledger ?? readLedgerForSnapshot(input.sessionID).ledger
    const activeTask = ledger.activeTaskId
      ? ledger.tasks.find((task) => task.taskId === ledger.activeTaskId)
      : undefined
    const previousContext = [...ledger.tasks]
      .reverse()
      .map((task) => task.metadata?.latestContextSnapshot)
      .find((value): value is ContextManagerSnapshot => Boolean(value && typeof value === "object"))
    const inputGraphRefs = (activeTask?.inputGraph ?? [])
      .map((node) => node.ref ?? node.label ?? node.id)
      .filter(Boolean)
      .slice(0, 20)
    const imageInputs = (activeTask?.inputGraph ?? [])
      .filter((node) => node.type === "image")
      .map((node) => ({
        ref: node.ref ?? node.label ?? node.id,
        mode: input.modelSupportsImages === false ? ("text-reference" as const) : ("native" as const),
      }))
    const capsule = input.capsule ?? buildContextCapsule(input.sessionID)
    const capsuleRefs = capsule?.trustedEvidence.map((entry) => entry.ref).slice(0, 20) ?? []
    const capsuleStage = capsule?.population.stageId
    const capsuleFailure = capsule?.workflow.latestFailureCode
    const capsuleText = capsule ? [capsuleStage, capsuleFailure, ...capsuleRefs].filter(Boolean).join("\n") : ""
    const tokenEstimate = Token.estimate(
      [
        input.text ?? "",
        workflow.workflow?.workflowRunId,
        capsuleText,
        inputGraphRefs.join("\n"),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    return {
      sessionID: input.sessionID,
      historyVersion: Math.max(ledger.tasks.length, 0) + Math.max(ledger.checkpoints.length, 0),
      referenceContext: {
        activeTaskId: ledger.activeTaskId,
        activeWorkflowRunId: workflow.workflow?.workflowRunId,
        activeStageId: capsuleStage ?? workflow.activeStage?.stageId,
        latestFailureCode: capsuleFailure ?? workflow.workflow?.latestFailure?.code,
        latestVerifierStatus: workflow.workflow?.latestVerifier?.status,
        trustedArtifacts: workflow.workflow?.trustedArtifacts ?? [],
        inputGraphRefs,
      },
      tokenEstimate: previousContext?.usage?.estimatedPromptTokens ?? tokenEstimate,
      protectedItems: [
        ...(workflow.workflow?.trustedArtifacts ?? []),
        workflow.activeStage?.stageId,
        workflow.workflow?.latestFailure?.code,
      ].filter(Boolean) as string[],
      imageInputs,
      createdAt: nowIso(),
      usage: previousContext?.usage,
      capsule,
      lastAction: previousContext?.lastAction,
    }
  }

  export function publishAction(input: {
    sessionID: string
    action: ContextActionStatus
    usage?: ContextUsageSnapshot
    historyVersion?: number
  }) {
    const { ledger, available } = readLedgerForSnapshot(input.sessionID)
    const capsule = buildContextCapsule(input.sessionID)
    const base = snapshot({ sessionID: input.sessionID, ledger, capsule })
    const withAction: ContextManagerSnapshot = {
      ...base,
      historyVersion: input.historyVersion ?? base.historyVersion,
      capsule: base.capsule,
      createdAt: input.action.updatedAt,
      usage: input.usage,
      lastAction: input.action,
    }
    publish(withAction, { persist: available, ledger })
    return withAction
  }

  export function publishUsage(input: {
    sessionID: string
    usage: ContextUsageSnapshot
    historyVersion?: number
  }) {
    const { ledger, available } = readLedgerForSnapshot(input.sessionID)
    const capsule = buildContextCapsule(input.sessionID)
    const base = snapshot({ sessionID: input.sessionID, ledger, capsule })
    const withUsage: ContextManagerSnapshot = {
      ...base,
      historyVersion: input.historyVersion ?? base.historyVersion,
      tokenEstimate: input.usage.estimatedPromptTokens,
      capsule: base.capsule,
      createdAt: input.usage.updatedAt,
      lastAction: base.lastAction,
      usage: {
        ...input.usage,
        cache: RuntimeTaskLedger.cacheReport(input.sessionID, undefined, available ? ledger : emptyLedger(input.sessionID)),
      },
    }
    publish(withUsage, { persist: available, ledger })
    return withUsage
  }

  export function publish(
    snapshot: ContextManagerSnapshot,
    options: { persist?: boolean; ledger?: LedgerFile } = {},
  ) {
    const persist = options.persist !== false
    Bus.publish(RuntimeEvents.ContextSnapshot, {
      sessionID: snapshot.sessionID,
      snapshot,
    })
    RuntimeProtocol.publish({
      sessionID: snapshot.sessionID,
      source: "context",
      type: "context.snapshot",
      payload: { snapshot },
    })
    if (persist) {
      try {
        RuntimeTaskLedger.recordContextSnapshot(snapshot.sessionID, snapshot, options.ledger)
      } catch {
        // Context telemetry must not turn an otherwise valid compaction/model turn into a failure.
      }
    }
  }
}
