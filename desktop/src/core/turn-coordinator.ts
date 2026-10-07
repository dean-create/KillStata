import type { EngineClient, EngineInteractionAnswer, EngineRunEvent, EngineRunRequest } from "../engine/client"

export type TurnStatus = "idle" | "queued" | "starting" | "running" | "waiting_for_user" | "completed" | "failed" | "cancelled"

export type TurnSnapshot = {
  turnId?: string
  runId?: string
  status: TurnStatus
  /** 单调递增，用于 UI 只消费本次通知中新到达的事件。 */
  eventSequence: number
  events: readonly EngineRunEvent[]
  lastEvent?: EngineRunEvent
  pendingRequestId?: string
  error?: string
}

export type TurnListener = (snapshot: TurnSnapshot) => void

export type TurnCoordinator = {
  submit(input: EngineRunRequest): Promise<{ turnId: string; runId: string }>
  cancel(): Promise<void>
  answer(requestId: string, answer: EngineInteractionAnswer): Promise<void>
  deny(requestId: string, reason?: string): Promise<void>
  subscribe(listener: TurnListener): () => void
  snapshot(): TurnSnapshot
  dispose(): Promise<void>
}

const MAX_TURN_EVENTS = 256

function terminal(status: TurnStatus) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function requestId(event: EngineRunEvent) {
  if (event.type === "question") return event.question.requestId
  if (event.type === "permission") return event.permission.requestId
  if (event.type === "waiting") return event.requestId
  return undefined
}

function terminalStatus(event: EngineRunEvent): TurnStatus | undefined {
  if (event.type === "completed") return "completed"
  if (event.type === "failed") return "failed"
  if (event.type === "cancelled") return "cancelled"
  return undefined
}

function clone(snapshot: TurnSnapshot): TurnSnapshot {
  return { ...snapshot, events: [...snapshot.events] }
}

/**
 * Desktop 侧的轻量 Turn 投影。它不运行模型、工具或分析，只把已经由 Core 负责的
 * EngineClient 调用与事件流整理为一个可订阅、可取消且幂等的客户端状态。
 */
export function createTurnCoordinator(engine: EngineClient): TurnCoordinator {
  let sequence = 0
  let eventSequence = 0
  let current: TurnSnapshot = { status: "idle", eventSequence: 0, events: [] }
  let unsubscribeEngine: (() => void) | undefined
  const listeners = new Set<TurnListener>()
  const seenRequestIds = new Set<string>()
  const currentToolCallIDs = new Set<string>()
  let disposed = false
  let cancellationInFlight: Promise<void> | undefined
  const interactionInFlight = new Map<string, Promise<void>>()

  const notify = () => {
    const snapshot = clone(current)
    for (const listener of [...listeners]) listener(snapshot)
  }

  const setSnapshot = (patch: Partial<TurnSnapshot>) => {
    current = { ...current, ...patch }
    notify()
  }

  const appendEvent = (event: EngineRunEvent) => {
    const events = [...current.events, event]
    if (events.length > MAX_TURN_EVENTS) events.splice(0, events.length - MAX_TURN_EVENTS)
    eventSequence += 1
    return { events, eventSequence, lastEvent: event }
  }

  const handleEvent = (turnId: string, runId: string, event: EngineRunEvent) => {
    // 迟到事件必须同时属于当前 Turn 和当前 run；即使后端错误地复用 runId，
    // 上一轮保留下来的回调也不能污染新的消息流。
    if (current.turnId !== turnId || current.runId !== runId) return
    if (event.type === "verification") {
      if (!currentToolCallIDs.has(event.callID)) return
      // 核验可能在主模型轮结束后才完成；补充结论不改变既有终态。
      setSnapshot(appendEvent(event))
      return
    }
    if (terminal(current.status)) {
      // Core 标题可能晚于 idle 到达，属于同一 Turn 的安全展示补充；其余旧事件丢弃。
      if (event.type !== "title") return
      setSnapshot(appendEvent(event))
      return
    }
    if (event.type === "progress" && event.step) currentToolCallIDs.add(event.step.id)

    const pending = requestId(event)
    if (pending) {
      // Core/SSE 重连可能重复发送同一个交互请求；一个 requestId 在一个 Turn
      // 内只允许进入一次，避免 UI 重复提示或在回答后重新打开旧面板。
      if (seenRequestIds.has(pending)) return
      seenRequestIds.add(pending)
    }
    const next = appendEvent(event)
    const nextTerminal = terminalStatus(event)
    if (nextTerminal) {
      setSnapshot({ ...next, status: nextTerminal, pendingRequestId: undefined, error: event.type === "failed" ? event.message : undefined })
      return
    }

    if (pending) {
      setSnapshot({ ...next, status: "waiting_for_user", pendingRequestId: pending })
      return
    }
    setSnapshot({ ...next, status: "running" })
  }

  const active = () => current.status === "queued" || current.status === "starting" || current.status === "running" || current.status === "waiting_for_user"

  return {
    async submit(input) {
      if (disposed) throw new Error("Turn Coordinator 已释放。")
      if (active()) throw new Error("已有分析任务正在进行，请先停止或完成当前任务。")
      unsubscribeEngine?.()
      unsubscribeEngine = undefined
      seenRequestIds.clear()
      currentToolCallIDs.clear()
      interactionInFlight.clear()
      // 上一轮可能已经进入终态但取消请求仍在等待响应；新 Turn 不得复用旧 Promise。
      cancellationInFlight = undefined
      const turnId = `turn-${++sequence}`
      current = { turnId, status: "starting", eventSequence: 0, events: [] }
      notify()
      try {
        const run = await engine.startRun(input)
        // startRun 成功只代表任务被接受。随后事件才决定它是否完成、失败或等待用户。
        if (current.turnId !== turnId) throw new Error("分析任务已被新的任务替代。")
        // 组件可能在 startRun 等待期间卸载；此时不能在已释放的客户端上建立新订阅。
        if (disposed) return { turnId, runId: run.runId }
        current = { ...current, runId: run.runId, status: "running" }
        notify()
        const off = engine.subscribe(run.runId, (event) => handleEvent(turnId, run.runId, event))
        // 即便 pending buffer 在 subscribe 内同步回放 terminal，也要保留订阅。
        // Core 的 session.updated（标题）可能在 idle 后才到；新 Turn 或 dispose 时再释放。
        if (current.runId === run.runId) unsubscribeEngine = off
        else off()
        return { turnId, runId: run.runId }
      } catch (error) {
        if (current.turnId === turnId && !terminal(current.status)) {
          const message = error instanceof Error && error.message ? error.message : "分析请求未能提交。"
          const event: EngineRunEvent = { type: "failed", message }
          setSnapshot({ ...appendEvent(event), status: "failed", error: message })
        }
        throw error
      }
    },

    async cancel() {
      if (terminal(current.status)) return
      if (cancellationInFlight) return cancellationInFlight
      if (!current.runId) throw new Error("尚未获得可取消的任务标识，请稍候。")
      const runId = current.runId
      const operation = (async () => {
        await engine.cancelRun(runId)
        // 取消请求等待期间，Core 可能已经先发出 completed；成功结果优先，
        // 不能再由晚到的取消响应把它改写为 cancelled。
        if (current.runId !== runId || terminal(current.status)) return
        unsubscribeEngine?.()
        unsubscribeEngine = undefined
        const event: EngineRunEvent = { type: "cancelled", message: "已停止分析。" }
        setSnapshot({ ...appendEvent(event), status: "cancelled", pendingRequestId: undefined })
      })()
      cancellationInFlight = operation
      try {
        await operation
      } finally {
        if (cancellationInFlight === operation) cancellationInFlight = undefined
      }
    },

    async answer(id, answer) {
      if (current.status !== "waiting_for_user" || current.pendingRequestId !== id || !current.runId) {
        throw new Error("已不再等待该请求。")
      }
      if (!engine.answerInteraction) throw new Error("当前分析引擎不支持交互式回答。")
      const existing = interactionInFlight.get(id)
      if (existing) return existing
      const runId = current.runId
      const operation = (async () => {
        await engine.answerInteraction!(runId, id, answer)
        if (current.runId === runId && !terminal(current.status)) setSnapshot({ status: "running", pendingRequestId: undefined })
      })()
      interactionInFlight.set(id, operation)
      try {
        await operation
      } finally {
        if (interactionInFlight.get(id) === operation) interactionInFlight.delete(id)
      }
    },

    async deny(id, reason) {
      if (current.status !== "waiting_for_user" || current.pendingRequestId !== id || !current.runId) {
        throw new Error("已不再等待该请求。")
      }
      if (!engine.denyInteraction) throw new Error("当前分析引擎不支持交互式拒绝。")
      const existing = interactionInFlight.get(id)
      if (existing) return existing
      const runId = current.runId
      const operation = (async () => {
        await engine.denyInteraction!(runId, id, reason)
        if (current.runId !== runId || terminal(current.status)) return
        unsubscribeEngine?.()
        unsubscribeEngine = undefined
        const event: EngineRunEvent = { type: "cancelled", message: "已拒绝该请求并停止分析。" }
        setSnapshot({ ...appendEvent(event), status: "cancelled", pendingRequestId: undefined })
      })()
      interactionInFlight.set(id, operation)
      try {
        await operation
      } finally {
        if (interactionInFlight.get(id) === operation) interactionInFlight.delete(id)
      }
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(clone(current))
      return () => listeners.delete(listener)
    },

    snapshot() {
      return clone(current)
    },

    async dispose() {
      disposed = true
      unsubscribeEngine?.()
      unsubscribeEngine = undefined
      listeners.clear()
    },
  }
}
