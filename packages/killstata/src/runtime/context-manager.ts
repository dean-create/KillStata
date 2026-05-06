import { Bus } from "@/bus"
import { Token } from "@/util/token"
import { RuntimeEvents } from "./events"
import { RuntimeProtocol } from "./protocol"
import { RuntimeTaskLedger } from "./task-ledger"
import { workflowStatusSummary } from "./workflow"
import type { ContextManagerSnapshot } from "./types"

function nowIso() {
  return new Date().toISOString()
}

export namespace ContextManager {
  export function snapshot(input: {
    sessionID: string
    text?: string
    modelSupportsImages?: boolean
  }): ContextManagerSnapshot {
    const workflow = workflowStatusSummary(input.sessionID)
    const ledger = RuntimeTaskLedger.listTasks(input.sessionID)
    const activeTask = ledger.activeTaskId ? ledger.tasks.find((task) => task.taskId === ledger.activeTaskId) : undefined
    const inputGraphRefs = (activeTask?.inputGraph ?? [])
      .map((node) => node.ref ?? node.label ?? node.id)
      .filter(Boolean)
      .slice(0, 20)
    const imageInputs = (activeTask?.inputGraph ?? [])
      .filter((node) => node.type === "image")
      .map((node) => ({
        ref: node.ref ?? node.label ?? node.id,
        mode: input.modelSupportsImages === false ? "text-reference" as const : "native" as const,
      }))
    const tokenEstimate = Token.estimate(
      [
        input.text ?? "",
        workflow.workflow?.workflowRunId,
        workflow.activeStage?.stageId,
        workflow.workflow?.latestFailure?.code,
        workflow.workflow?.trustedArtifacts.join("\n"),
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
        activeStageId: workflow.activeStage?.stageId,
        latestFailureCode: workflow.workflow?.latestFailure?.code,
        latestVerifierStatus: workflow.workflow?.latestVerifier?.status,
        trustedArtifacts: workflow.workflow?.trustedArtifacts ?? [],
        inputGraphRefs,
      },
      tokenEstimate,
      protectedItems: [
        ...(workflow.workflow?.trustedArtifacts ?? []),
        workflow.activeStage?.stageId,
        workflow.workflow?.latestFailure?.code,
      ].filter(Boolean) as string[],
      imageInputs,
      createdAt: nowIso(),
    }
  }

  export function publish(snapshot: ContextManagerSnapshot) {
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
    RuntimeTaskLedger.recordContextSnapshot(snapshot.sessionID, snapshot)
  }
}
