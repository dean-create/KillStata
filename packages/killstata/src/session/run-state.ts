import { Bus } from "@/bus"
import { RuntimeEvents } from "@/runtime/events"
import { QueryGuard } from "@/runtime/query-guard"
import type { QueuedSessionAction, QueuedSessionActionType } from "@/runtime/types"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { RuntimeProtocol } from "@/runtime/protocol"
import { Instance } from "@/project/instance"
import { SessionStatus } from "./status"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { sortQueuedSessionActions } from "./prompt/queue-policy"

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
  const payload: {
    sessionID: string
    pending: number
    actions: Array<{
      id: string
      type: string
      priority: number
      createdAt: number
      delivery: "queued" | "steer"
    }>
  } = {
    sessionID,
    pending: runtime.queue.length,
    actions: runtime.queue.map((action) => ({
      id: action.id,
      type: action.type,
      priority: action.priority,
      createdAt: action.createdAt,
      delivery: action.metadata?.delivery === "steer" ? "steer" : "queued",
    })),
  }
  Bus.publish(RuntimeEvents.QueueUpdated, payload)
  RuntimeProtocol.publish({
    sessionID,
    source: "runtime",
    type: "queue.updated",
    payload,
  })
}

function publishQueryState(sessionID: string, runtime: Runtime, action?: QueuedSessionActionType) {
  const snapshot = runtime.guard.snapshot(runtime.queue.length, action ?? runtime.queue[0]?.type)
  const payload = {
    sessionID,
    phase: !runtime.guard.active && runtime.queue.length > 0 ? "accepted" : snapshot.phase,
    generation: snapshot.generation,
    pending: snapshot.pending,
    action: snapshot.action,
  }
  Bus.publish(RuntimeEvents.QueryState, payload)
  RuntimeProtocol.publish({
    sessionID,
    source: "runtime",
    type: "query.state",
    payload,
  })
}

export namespace SessionRunCoordinator {
  const state = Instance.state(
    () => {
      const data: Record<string, Runtime> = {}
      return data
    },
    async (current) => {
      // 进程关闭 / HMR / /config 重配 / CLI finally 时的 cleanup。abort 在飞请求，并
      // 用 CancelledError reject 所有待回调——这样 await 它的路由/调度 handler 能拿到
      // 明确的"会话被取消"而优雅收尾，而不是永久挂起。没人 await 的 promise 由
      // waitForAction 里的默认 catch 吞掉，不会冒 unhandledRejection 噪声。
      for (const [sessionID, item] of Object.entries(current)) {
        item.abort?.abort()
        for (const callback of item.callbacks) {
          callback.reject(new Session.CancelledError(sessionID))
        }
        item.callbacks.length = 0
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

  /** retention 等清理路径只查询已知运行态，不能为历史 session 顺手创建 runtime。 */
  export function activeIfKnown(sessionID: string) {
    return state()[sessionID]?.guard.active ?? false
  }

  export function assertNotBusy(sessionID: string) {
    if (active(sessionID)) throw new Error(`Session is busy: ${sessionID}`)
  }

  export function enqueue(action: QueuedSessionAction) {
    const runtime = ensure(action.sessionID)
    runtime.queue.push(action)
    runtime.queue = sortQueuedSessionActions(runtime.queue)
    RuntimeTaskLedger.recordQueued(action)
    publishQueue(action.sessionID, runtime)
    publishQueryState(action.sessionID, runtime, action.type)
    return action
  }

  export function waitForAction(sessionID: string, actionID?: string) {
    const runtime = ensure(sessionID)
    const promise = new Promise<MessageV2.WithParts>((resolve, reject) => {
      runtime.callbacks.push({ actionID, resolve, reject })
    })
    // 挂一个默认 catch，把"进程关闭 / HMR 时 reject 但没人 await"的 promise 吞掉，
    // 避免 bun dev 启动时的 unhandledRejection 噪声。真正在 await 的路由/调度
    // handler 的 catch 仍会正常收到错误（同一个 promise，catch 会各自触发）。
    void promise.catch(() => {})
    return promise
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
    if (next) {
      RuntimeTaskLedger.markStatus({
        sessionID,
        taskId: next.id,
        status: "dispatching",
        message: `${next.type} dispatching`,
      })
    }
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
    if (started) {
      RuntimeTaskLedger.markStatus({
        sessionID,
        status: "running",
        message: "query running",
      })
    }
    publishQueryState(sessionID, runtime, runtime.queue[0]?.type)
    return started
  }

  export function cancelDispatch(sessionID: string, generation: number) {
    const runtime = ensure(sessionID)
    const cancelled = runtime.guard.cancelDispatch(generation)
    if (cancelled) {
      RuntimeTaskLedger.markStatus({
        sessionID,
        status: "cancelled",
        message: "dispatch cancelled",
      })
    }
    publishQueryState(sessionID, runtime)
    return cancelled
  }

  export function finishDispatch(sessionID: string, generation: number) {
    const runtime = ensure(sessionID)
    runtime.abort = undefined
    runtime.guard.finish(generation)
    RuntimeTaskLedger.markStatus({
      sessionID,
      status: "completed",
      message: "query completed",
    })
    publishQueue(sessionID, runtime)
    publishQueryState(sessionID, runtime)
    SessionStatus.set(sessionID, { type: "idle" })
  }

  export function cancel(sessionID: string, error?: unknown) {
    const runtime = ensure(sessionID)
    runtime.abort?.abort(error)
    runtime.abort = undefined
    runtime.queue = []
    runtime.guard = new QueryGuard()
    rejectAll(sessionID, error ?? new Error("Session prompt cancelled"))
    RuntimeTaskLedger.markStatus({
      sessionID,
      status: "cancelled",
      message: error instanceof Error ? error.message : "Session prompt cancelled",
    })
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
    RuntimeTaskLedger.markStatus({
      sessionID,
      status: "failed",
      message: error instanceof Error ? error.message : "Session prompt failed",
    })
    publishQueue(sessionID, runtime)
    publishQueryState(sessionID, runtime)
    SessionStatus.set(sessionID, { type: "idle" })
  }
}
