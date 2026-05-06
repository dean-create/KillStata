import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { RuntimeEvents } from "./events"
import { RuntimeProtocol } from "./protocol"
import { RuntimeTaskLedger } from "./task-ledger"
import type { AgentControlState, InterAgentMessage, WorkflowCoordinatorDecision } from "./types"

function nowIso() {
  return new Date().toISOString()
}

function localId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export namespace AgentControl {
  const state = Instance.state(() => ({} as Record<string, AgentControlState>))

  function ensure(sessionID: string) {
    const current = state()
    current[sessionID] ??= {
      sessionID,
      decisions: [],
      messages: [],
      updatedAt: nowIso(),
    }
    return current[sessionID]
  }

  function publish(item: AgentControlState) {
    Bus.publish(RuntimeEvents.AgentControlState, {
      sessionID: item.sessionID,
      state: item,
    })
    RuntimeProtocol.publish({
      sessionID: item.sessionID,
      source: "agent-control",
      type: "agent_control.state",
      payload: { state: item },
    })
    RuntimeTaskLedger.appendEvent({
      sessionID: item.sessionID,
      kind: "agent.control",
      message: item.activeAgent ? `active agent: ${item.activeAgent}` : "agent control updated",
      metadata: {
        activeAgent: item.activeAgent,
        forkMode: item.forkMode,
        decisionCount: item.decisions.length,
      },
    })
  }

  export function recordDecision(input: {
    sessionID: string
    decision: WorkflowCoordinatorDecision
    forkMode?: AgentControlState["forkMode"]
  }) {
    const item = ensure(input.sessionID)
    item.activeAgent = input.decision.agent
    item.forkMode = input.forkMode ?? item.forkMode ?? "workflow_slice"
    item.decisions = [...item.decisions, input.decision].slice(-20)
    item.updatedAt = nowIso()
    publish(item)
    return item
  }

  export function recordMessage(input: Omit<InterAgentMessage, "messageId" | "createdAt">) {
    const item = ensure(input.sessionID)
    const message: InterAgentMessage = {
      ...input,
      messageId: localId("agentmsg"),
      createdAt: nowIso(),
    }
    item.messages = [...item.messages, message].slice(-40)
    item.updatedAt = nowIso()
    publish(item)
    return message
  }

  export function current(sessionID: string) {
    return ensure(sessionID)
  }
}
