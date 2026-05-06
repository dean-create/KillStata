import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { RuntimeEvents } from "./events"
import type { RuntimeEventEnvelope } from "./types"

function nowIso() {
  return new Date().toISOString()
}

export namespace RuntimeProtocol {
  const sequenceState = Instance.state(() => ({ sequence: 0 }))

  export function publish(input: {
    sessionID: string
    source: RuntimeEventEnvelope["source"]
    type: string
    payload?: Record<string, unknown>
    compatibility?: Record<string, unknown>
  }) {
    const state = sequenceState()
    state.sequence += 1
    const envelope: RuntimeEventEnvelope = {
      version: 1,
      sequence: state.sequence,
      sessionID: input.sessionID,
      source: input.source,
      event: {
        type: input.type,
        sessionID: input.sessionID,
        payload: input.payload ?? {},
      },
      createdAt: nowIso(),
      compatibility: input.compatibility,
    }
    Bus.publish(RuntimeEvents.ProtocolEvent, { envelope })
    return envelope
  }
}
