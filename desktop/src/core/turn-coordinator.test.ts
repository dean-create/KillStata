import { describe, expect, test, vi } from "vitest"
import type { EngineClient, EngineRunEvent } from "../engine/client"
import { createTurnCoordinator } from "./turn-coordinator"

function scriptedEngine(events: EngineRunEvent[]): EngineClient {
  return {
    health: async () => ({ protocolVersion: "v1", engineVersion: "test", status: "ready" }),
    commands: async () => [],
    uploadDataset: async (file) => ({ id: "dataset-1", name: file.name, format: "CSV", bytes: file.size }),
    startRun: async () => ({ runId: "run-1" }),
    cancelRun: async () => {},
    getResult: async () => ({ runId: "run-1", status: "completed", document: "结果" }),
    subscribe: (_runID, listener) => {
      for (const event of events) listener(event)
      return () => {}
    },
  }
}

describe("Desktop Turn Coordinator", () => {
  test("任务接受后保持运行，直到收到终态事件", async () => {
    const coordinator = createTurnCoordinator(scriptedEngine([
      { type: "assistant_delta", text: "结果" },
      { type: "completed", message: "完成" },
    ]))
    const statuses: string[] = []
    coordinator.subscribe((snapshot) => statuses.push(snapshot.status))

    await coordinator.submit({ prompt: "分析数据" })

    expect(statuses).toContain("starting")
    expect(statuses).toContain("running")
    expect(coordinator.snapshot()).toMatchObject({ runId: "run-1", status: "completed" })
  })

  test("活动 Turn 未结束时拒绝第二次提交", async () => {
    let resolveStart: ((value: { runId: string }) => void) | undefined
    const engine = scriptedEngine([])
    engine.startRun = () => new Promise<{ runId: string }>((resolve) => { resolveStart = resolve })
    const coordinator = createTurnCoordinator(engine)

    const first = coordinator.submit({ prompt: "第一项" })
    await expect(coordinator.submit({ prompt: "第二项" })).rejects.toThrow("已有分析任务正在进行")
    resolveStart?.({ runId: "run-1" })
    await first
  })

  test("重复终态和终态后的旧事件不会改写完成状态，但标题仍可抵达", async () => {
    let emit: ((event: EngineRunEvent) => void) | undefined
    const engine = scriptedEngine([])
    engine.subscribe = (_runID, listener) => {
      emit = listener
      return () => {}
    }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "分析数据" })

    emit?.({ type: "completed", message: "完成" })
    emit?.({ type: "completed", message: "重复完成" })
    emit?.({ type: "progress", message: "不应出现" })
    emit?.({ type: "title", title: "政策效果" })

    expect(coordinator.snapshot().status).toBe("completed")
    expect(coordinator.snapshot().events.filter((event) => event.type === "completed")).toHaveLength(1)
    expect(coordinator.snapshot().events.some((event) => event.type === "progress" && event.message === "不应出现")).toBe(false)
    expect(coordinator.snapshot().events.at(-1)).toEqual({ type: "title", title: "政策效果" })
  })

  test("终态后的核验结论可补入同一 Turn，且不会重启运行状态", async () => {
    let emit: ((event: EngineRunEvent) => void) | undefined
    const engine = scriptedEngine([])
    engine.subscribe = (_runID, listener) => { emit = listener; return () => {} }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "运行基准回归" })

    emit?.({ type: "progress", message: "已完成回归", step: { id: "call_ols", label: "回归", phase: "analysis", status: "completed" } })
    emit?.({ type: "completed", message: "估计已完成，待核验" })
    emit?.({ type: "verification", callID: "call_ols", status: "pass", message: "独立核验通过。" } as EngineRunEvent)

    expect(coordinator.snapshot().status).toBe("completed")
    expect(coordinator.snapshot().events.at(-1)).toEqual({
      type: "verification", callID: "call_ols", status: "pass", message: "独立核验通过。",
    })
  })

  test("上一轮的核验结论不会混入同一 session 的下一轮 Turn", async () => {
    let emit: ((event: EngineRunEvent) => void) | undefined
    const engine = scriptedEngine([])
    engine.subscribe = (_runID, listener) => { emit = listener; return () => {} }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "第一轮回归" })
    emit?.({ type: "progress", message: "估计已完成", step: { id: "call_old", label: "回归", phase: "analysis", status: "completed" } })
    emit?.({ type: "completed", message: "第一轮完成" })
    await coordinator.submit({ prompt: "第二轮分析" })
    emit?.({ type: "verification", callID: "call_old", status: "pass", message: "独立核验通过。" })
    expect(coordinator.snapshot().events.some((event) => event.type === "verification")).toBe(false)
  })

  test("即使后端复用 runId，上一轮回调的迟到事件也不能进入新 Turn", async () => {
    const emitters: Array<(event: EngineRunEvent) => void> = []
    const engine = scriptedEngine([])
    engine.subscribe = (_runID, listener) => {
      emitters.push(listener)
      return () => {}
    }
    const coordinator = createTurnCoordinator(engine)

    await coordinator.submit({ prompt: "第一项" })
    emitters[0]?.({ type: "completed", message: "第一项完成" })
    await coordinator.submit({ prompt: "第二项" })
    emitters[0]?.({ type: "progress", message: "第一项迟到进度" })

    expect(coordinator.snapshot().events.some((event) => event.type === "progress" && event.message === "第一项迟到进度")).toBe(false)
  })

  test("同步回放 completed 后仍保留订阅接收迟到标题", async () => {
    let listener: ((event: EngineRunEvent) => void) | undefined
    const off = vi.fn(() => { listener = undefined })
    const engine = scriptedEngine([])
    engine.subscribe = (_runID, nextListener) => {
      listener = nextListener
      listener({ type: "completed", message: "完成" })
      return off
    }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "分析数据" })

    listener?.({ type: "title", title: "迟到标题" })

    expect(off).not.toHaveBeenCalled()
    expect(coordinator.snapshot().events.at(-1)).toEqual({ type: "title", title: "迟到标题" })
  })

  test("问题等待后回答一次恢复运行，同一请求不能重复回答", async () => {
    let emit: ((event: EngineRunEvent) => void) | undefined
    const answerInteraction = vi.fn(async () => {})
    const engine = scriptedEngine([])
    engine.answerInteraction = answerInteraction
    engine.subscribe = (_runID, listener) => {
      emit = listener
      return () => {}
    }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "分析数据" })
    emit?.({
      type: "question",
      message: "请选择结果变量",
      question: { requestId: "question-1", title: "结果变量", prompt: "请选择", mode: "single", options: [{ id: "y", label: "y" }], allowSkip: false },
    })

    await coordinator.answer("question-1", { selected: ["y"] })
    await expect(coordinator.answer("question-1", { selected: ["y"] })).rejects.toThrow("已不再等待该请求")

    expect(answerInteraction).toHaveBeenCalledOnce()
    expect(coordinator.snapshot().status).toBe("running")
  })

  test("同一 requestId 的重复等待事件只保留一次", async () => {
    let emit: ((event: EngineRunEvent) => void) | undefined
    const engine = scriptedEngine([])
    engine.subscribe = (_runID, listener) => {
      emit = listener
      return () => {}
    }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "分析数据" })
    const question: EngineRunEvent = {
      type: "question",
      message: "请选择结果变量",
      question: { requestId: "question-duplicate", title: "结果变量", prompt: "请选择", mode: "single", options: [{ id: "y", label: "y" }], allowSkip: false },
    }

    emit?.(question)
    emit?.(question)

    expect(coordinator.snapshot().events.filter((event) => event.type === "question")).toHaveLength(1)
  })

  test("并发回答同一 requestId 只调用一次引擎回答", async () => {
    let releaseAnswer: (() => void) | undefined
    const answerInteraction = vi.fn(() => new Promise<void>((resolve) => { releaseAnswer = resolve }))
    let emit: ((event: EngineRunEvent) => void) | undefined
    const engine = scriptedEngine([])
    engine.answerInteraction = answerInteraction
    engine.subscribe = (_runID, listener) => {
      emit = listener
      return () => {}
    }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "分析数据" })
    emit?.({
      type: "question",
      message: "请选择结果变量",
      question: { requestId: "question-concurrent", title: "结果变量", prompt: "请选择", mode: "single", options: [{ id: "y", label: "y" }], allowSkip: false },
    })

    const first = coordinator.answer("question-concurrent", { selected: ["y"] })
    const second = coordinator.answer("question-concurrent", { selected: ["y"] })
    releaseAnswer?.()
    await Promise.all([first, second])

    expect(answerInteraction).toHaveBeenCalledOnce()
    expect(coordinator.snapshot().status).toBe("running")
  })

  test("拒绝等待中的授权只提交一次并结束当前 Turn", async () => {
    let emit: ((event: EngineRunEvent) => void) | undefined
    const denyInteraction = vi.fn(async () => {})
    const engine = scriptedEngine([])
    engine.denyInteraction = denyInteraction
    engine.subscribe = (_runID, listener) => {
      emit = listener
      return () => {}
    }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "分析数据" })
    emit?.({
      type: "permission",
      message: "需要授权",
      permission: { requestId: "permission-1", title: "读取数据", action: "读取数据副本", scope: "当前研究" },
    })

    await coordinator.deny("permission-1", "研究者拒绝")
    await expect(coordinator.deny("permission-1", "研究者拒绝")).rejects.toThrow("已不再等待该请求")

    expect(denyInteraction).toHaveBeenCalledWith("run-1", "permission-1", "研究者拒绝")
    expect(coordinator.snapshot().status).toBe("cancelled")
  })

  test("取消只调用当前 run 一次，并忽略之后的旧事件", async () => {
    let emit: ((event: EngineRunEvent) => void) | undefined
    const cancelRun = vi.fn(async () => {})
    const engine = scriptedEngine([])
    engine.cancelRun = cancelRun
    engine.subscribe = (_runID, listener) => {
      emit = listener
      return () => {}
    }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "分析数据" })
    await coordinator.cancel()
    emit?.({ type: "assistant_delta", text: "旧结果" })

    expect(cancelRun).toHaveBeenCalledWith("run-1")
    expect(coordinator.snapshot().status).toBe("cancelled")
    expect(coordinator.snapshot().events.some((event) => event.type === "assistant_delta")).toBe(false)
  })

  test("并发取消请求只调用一次引擎取消", async () => {
    let releaseCancel: (() => void) | undefined
    const cancelRun = vi.fn(() => new Promise<void>((resolve) => { releaseCancel = resolve }))
    const engine = scriptedEngine([])
    engine.cancelRun = cancelRun
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "分析数据" })

    const first = coordinator.cancel()
    const second = coordinator.cancel()
    releaseCancel?.()
    await Promise.all([first, second])

    expect(cancelRun).toHaveBeenCalledOnce()
    expect(coordinator.snapshot().status).toBe("cancelled")
  })

  test("取消等待期间若任务已完成，不得用 cancelled 覆盖 completed", async () => {
    let releaseCancel: (() => void) | undefined
    const cancelRun = vi.fn(() => new Promise<void>((resolve) => { releaseCancel = resolve }))
    let emit: ((event: EngineRunEvent) => void) | undefined
    const engine = scriptedEngine([])
    engine.cancelRun = cancelRun
    engine.subscribe = (_runID, listener) => {
      emit = listener
      return () => {}
    }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "分析数据" })

    const cancelling = coordinator.cancel()
    emit?.({ type: "completed", message: "分析已完成。" })
    releaseCancel?.()
    await cancelling

    expect(coordinator.snapshot().status).toBe("completed")
    expect(coordinator.snapshot().events.filter((event) => event.type === "cancelled")).toHaveLength(0)
  })

  test("旧任务取消确认未返回时，新 Turn 仍可独立取消", async () => {
    let runNumber = 0
    const emitters: Array<(event: EngineRunEvent) => void> = []
    const cancelResolvers: Array<() => void> = []
    const cancelRun = vi.fn(() => new Promise<void>((resolve) => { cancelResolvers.push(resolve) }))
    const engine = scriptedEngine([])
    engine.startRun = async () => ({ runId: `run-${++runNumber}` })
    engine.cancelRun = cancelRun
    engine.subscribe = (_runID, listener) => {
      emitters.push(listener)
      return () => {}
    }
    const coordinator = createTurnCoordinator(engine)
    await coordinator.submit({ prompt: "第一项" })

    const firstCancel = coordinator.cancel()
    emitters[0]?.({ type: "completed", message: "第一项完成" })
    await coordinator.submit({ prompt: "第二项" })
    const secondCancel = coordinator.cancel()
    cancelResolvers.forEach((resolve) => resolve())
    await Promise.all([firstCancel, secondCancel])

    expect(cancelRun).toHaveBeenCalledWith("run-1")
    expect(cancelRun).toHaveBeenCalledWith("run-2")
    expect(cancelRun).toHaveBeenCalledTimes(2)
  })

  test("没有 runId 时取消保持 starting，不伪造已取消", async () => {
    let resolveStart: ((value: { runId: string }) => void) | undefined
    const engine = scriptedEngine([])
    engine.startRun = () => new Promise<{ runId: string }>((resolve) => { resolveStart = resolve })
    const coordinator = createTurnCoordinator(engine)
    const submitted = coordinator.submit({ prompt: "分析数据" })

    await expect(coordinator.cancel()).rejects.toThrow("尚未获得可取消的任务标识")
    expect(coordinator.snapshot().status).toBe("starting")
    resolveStart?.({ runId: "run-1" })
    await submitted
  })

  test("dispose 后释放引擎订阅，迟到事件不再通知 UI", async () => {
    let emit: ((event: EngineRunEvent) => void) | undefined
    const off = vi.fn()
    const engine = scriptedEngine([])
    engine.subscribe = (_runID, listener) => {
      emit = listener
      return off
    }
    const coordinator = createTurnCoordinator(engine)
    const listener = vi.fn()
    coordinator.subscribe(listener)
    await coordinator.submit({ prompt: "分析数据" })
    const callsBeforeDispose = listener.mock.calls.length

    await coordinator.dispose()
    emit?.({ type: "assistant_delta", text: "迟到正文" })

    expect(off).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledTimes(callsBeforeDispose)
  })

  test("启动尚未返回时 dispose 不会在之后建立引擎订阅", async () => {
    let resolveStart: ((value: { runId: string }) => void) | undefined
    const subscribe = vi.fn(() => vi.fn())
    const engine = scriptedEngine([])
    engine.startRun = () => new Promise<{ runId: string }>((resolve) => { resolveStart = resolve })
    engine.subscribe = subscribe
    const coordinator = createTurnCoordinator(engine)
    const submitted = coordinator.submit({ prompt: "分析数据" })

    await coordinator.dispose()
    resolveStart?.({ runId: "run-1" })
    await submitted

    expect(subscribe).not.toHaveBeenCalled()
  })
})
