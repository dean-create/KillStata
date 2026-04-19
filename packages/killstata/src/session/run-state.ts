import { Bus } from "@/bus"
import { RuntimeEvents } from "@/runtime/events"
import { QueryGuard } from "@/runtime/query-guard"
import type { QueuedSessionAction, QueuedSessionActionType } from "@/runtime/types"
import { Instance } from "@/project/instance"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"

type Callback = {
  actionID?: string
  resolve(input: MessageV2.WithParts): void
  reject(error?: unknown): void
}

type Runtime = {
  guard: QueryGuard
  abort?: AbortController
  queue: QueuedSessionAction[]
  callbacks: Callback[]
}

function publishQueue(sessionID: string, runtime: Runtime) {
  Bus.publish(RuntimeEvents.QueueUpdated, {
    sessionID,
    pending: runtime.queue.length,
    actions: runtime.queue.map((action) => ({
      id: action.id,
      type: action.type,
      priority: action.priority,
      createdAt: action.createdAt,
    })),
  })
}

function publishQueryState(sessionID: string, runtime: Runtime, action?: QueuedSessionActionType) {
  const snapshot = runtime.guard.snapshot(runtime.queue.length, action ?? runtime.queue[0]?.type)
  Bus.publish(RuntimeEvents.QueryState, {
    sessionID,
    phase: !runtime.guard.active && runtime.queue.length > 0 ? "accepted" : snapshot.phase,
    generation: snapshot.generation,
    pending: snapshot.pending,
    action: snapshot.action,
  })
}

export namespace SessionRunCoordinator {
  const state = Instance.state(
    () => {
      const data: Record<string, Runtime> = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        item.abort?.abort()
        for (const callback of item.callbacks) {
          callback.reject(new Error("Session prompt runtime disposed"))
        }
      }
    },
  )

  export function ensure(sessionID: string) {
    const current = state()
    current[sessionID] ??= {
      guard: new QueryGuard(),
      queue: [],
      callbacks: [],
    }
    return current[sessionID]
  }

  export function peek(sessionID: string) {
    return ensure(sessionID).queue[0]
  }

  export function pending(sessionID: string) {
    return ensure(sessionID).queue.length
  }

  export function active(sessionID: string) {
    return ensure(sessionID).guard.active
  }

  export function assertNotBusy(sessionID: string) {
    if (active(sessionID)) throw new Error(`Session is busy: ${sessionID}`)
  }

  export function enqueue(action: QueuedSessionAction) {
    const runtime = ensure(action.sessionID)
    runtime.queue.push(action)
    runtime.queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
    publishQueue(action.sessionID, runtime)
    publishQueryState(action.sessionID, runtime, action.type)
    return action
  }

  export function waitForAction(sessionID: string, actionID?: string) {
    const runtime = ensure(sessionID)
    return new Promise<MessageV2.WithParts>((resolve, reject) => {
      runtime.callbacks.push({ actionID, resolve, reject })
    })
  }

  export function resolveAction(sessionID: string, message: MessageV2.WithParts, actionID?: string) {
    const runtime = ensure(sessionID)
    let genericResolved = false
    runtime.callbacks = runtime.callbacks.filter((callback) => {
      if (actionID && callback.actionID === actionID) {
        callback.resolve(message)
        return false
      }
      if (!callback.actionID && !genericResolved) {
        genericResolved = true
        callback.resolve(message)
        return false
      }
      return true
    })
  }

  export function rejectAll(sessionID: string, error?: unknown) {
    const runtime = ensure(sessionID)
    for (const callback of runtime.callbacks) {
      callback.reject(error)
    }
    runtime.callbacks = []
  }

  export function next(sessionID: string) {
    const runtime = ensure(sessionID)
    const next = runtime.queue.shift()
    publishQueue(sessionID, runtime)
    publishQueryState(sessionID, runtime, next?.type)
    return next
  }

  export function tryBeginDispatch(sessionID: string) {
    const runtime = ensure(sessionID)
    const generation = runtime.guard.tryDispatch()
    if (generation === undefined) return undefined
    runtime.abort ??= new AbortController()
    publishQueryState(sessionID, runtime, runtime.queue[0]?.type)
    return {
      generation,
      abort: runtime.abort.signal,
    }
  }

  export function startDispatch(sessionID: string, generation: number) {
    const runtime = ensure(sessionID)
    const started = runtime.guard.start(generation)
    publishQueryState(sessionID, runtime, runtime.queue[0]?.type)
    return started
  }

  export function cancelDispatch(sessionID: string, generation: number) {
    const runtime = ensure(sessionID)
    const cancelled = runtime.guard.cancelDispatch(generation)
    publishQueryState(sessionID, runtime)
    return cancelled
  }

  export function finishDispatch(sessionID: string, generation: number) {
    const runtime = ensure(sessionID)
    runtime.abort = undefined
    runtime.guard.finish(generation)
    publishQueue(sessionID, runtime)
    publishQueryState(sessionID, runtime)
    SessionStatus.set(sessionID, { type: "idle" })
  }

  export function cancel(sessionID: string, error?: unknown) {
    const runtime = ensure(sessionID)
    runtime.abort?.abort()
    runtime.abort = undefined
    runtime.queue = []
    runtime.guard = new QueryGuard()
    rejectAll(sessionID, error ?? new Error("Session prompt cancelled"))
    publishQueue(sessionID, runtime)
    publishQueryState(sessionID, runtime)
    SessionStatus.set(sessionID, { type: "idle" })
  }

  export function fail(sessionID: string, error?: unknown) {
    const runtime = ensure(sessionID)
    runtime.abort?.abort()
    runtime.abort = undefined
    runtime.queue = []
    runtime.guard = new QueryGuard()
    rejectAll(sessionID, error)
    publishQueue(sessionID, runtime)
    publishQueryState(sessionID, runtime)
    SessionStatus.set(sessionID, { type: "idle" })
  }
}
