import { describe, expect, test } from "bun:test"
import { ModelStreamAdapter } from "@/runtime/model-stream-adapter"

// 流式 idle watchdog：首 token 超时 / 事件间隔超长 → abort 底层流并抛可重试错误
// （P0.2，对齐 claude-code 的 Stream idle watchdog）。

function makeStream(chunks: unknown[], options?: { idleBeforeEnd?: number; neverEnd?: boolean }) {
  const controller = new AbortController()
  async function* gen() {
    for (const chunk of chunks) {
      controller.signal.throwIfAborted()
      yield chunk
    }
    if (options?.neverEnd) {
      // 挂起直到 abort：模拟假死流（有连接但不吐数据）
      await new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        )
      })
    }
    if (options?.idleBeforeEnd) await Bun.sleep(options.idleBeforeEnd)
  }
  return {
    fullStream: gen(),
    abort: () => controller.abort(),
    aborted: () => controller.signal.aborted,
  }
}

describe("withStreamIdleWatchdog", () => {
  test("正常流逐块透传，不误杀", async () => {
    const stream = makeStream([{ type: "start" }, { type: "text-delta", text: "hi" }])
    const seen: unknown[] = []
    for await (const chunk of ModelStreamAdapter.withStreamIdleWatchdog(stream, {
      firstByteTimeoutMs: 500,
      idleTimeoutMs: 500,
    })) {
      seen.push(chunk)
    }
    expect(seen).toHaveLength(2)
    expect(stream.aborted()).toBe(false)
  })

  test("首 token 超时（无任何事件）→ 抛可重试错误并 abort 底层流", async () => {
    const stream = makeStream([], { neverEnd: true })
    let error: unknown
    try {
      for await (const _ of ModelStreamAdapter.withStreamIdleWatchdog(stream, {
        firstByteTimeoutMs: 30,
        idleTimeoutMs: 30,
      })) {
        // 不会到这里
      }
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("stream disconnected before first meaningful response")
    expect(stream.aborted()).toBe(true)
  })

  // AI SDK v5 的 StreamTextResult 没有 abort()。此前 watchdog 无条件调用它，
  // 超时路径的 finally 抛 TypeError 顶替掉可重试的 "stream disconnected"，
  // 整轮以 "stream.abort is not a function" 收尾，重试路径实际从未生效
  // （2026-08-05 用户真实测试命中）。
  test("底层流没有 abort() 时，超时仍抛可重试错误而不是 TypeError", async () => {
    const stalled = {
      fullStream: (async function* () {
        yield { type: "start" }
        await new Promise<never>(() => {}) // 永不 settle：假死
      })(),
      // 刻意不提供 abort，还原真实 StreamTextResult 的形状
    }
    let error: unknown
    try {
      for await (const _ of ModelStreamAdapter.withStreamIdleWatchdog(stalled, {
        firstByteTimeoutMs: 30,
        idleTimeoutMs: 30,
      })) {
        // 只消费到第一个事件，之后卡住
      }
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("stream disconnected before first meaningful response")
    expect((error as Error).message).not.toContain("is not a function")
  })

  test("有事件后事件间隔超时（idle）→ 抛错", async () => {
    const stream = makeStream([{ type: "start" }], { idleBeforeEnd: 300 })
    let error: unknown
    try {
      for await (const _ of ModelStreamAdapter.withStreamIdleWatchdog(stream, {
        firstByteTimeoutMs: 30,
        idleTimeoutMs: 50,
      })) {
        // start 后没有更多事件，idle 50ms 触发
      }
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("no events for")
  })

  test("只有结构性 start 事件后仍视为首字节等待，不把握手当作模型响应", async () => {
    const stalled = {
      fullStream: (async function* () {
        yield { type: "start" }
        await new Promise<never>(() => {})
      })(),
    }
    const startedAt = Date.now()
    let error: unknown
    try {
      for await (const _ of ModelStreamAdapter.withStreamIdleWatchdog(stalled, {
        firstByteTimeoutMs: 30,
        idleTimeoutMs: 300,
      })) {
        // 结构性 start 不应把首字节计时器切换为较长的 idle 计时器。
      }
    } catch (caught) {
      error = caught
    }
    expect(Date.now() - startedAt).toBeLessThan(180)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("no events for 30ms")
  })

  test("并行 tool-call：其中一个先完成，剩余仍按工具档位不误杀", async () => {
    // 模型同一步发出两个工具调用（A、B），A 先 result、B 还在跑。用单 bool
    // 跟踪 inFlight 时 A 完成会把 toolInFlight 置 false，B 被切回 120s idle，
    // 若 B 跑超过 120s 会被误杀（审查报告 §2.3）。用 Set 跟踪每个 toolCallId
    // 才能正确处理并行场景。
    const controller = new AbortController()
    async function* gen() {
      yield { type: "start" }
      yield { type: "tool-call", toolCallId: "A", toolName: "data_import" }
      yield { type: "tool-call", toolCallId: "B", toolName: "panel_fe_regression" }
      // A 完成（B 仍在飞）：不能切回普通 idle 档位
      await Bun.sleep(150) // > 普通 idle（50ms），< 工具档位（500ms）
      yield { type: "tool-result", toolCallId: "A" }
      // B 继续执行：仍按工具档位计时
      await Bun.sleep(150)
      yield { type: "tool-result", toolCallId: "B" }
      yield { type: "step-finish" }
    }
    const stream = {
      fullStream: gen(),
      abort: () => controller.abort(),
      aborted: () => controller.signal.aborted,
    }
    const seen: unknown[] = []
    for await (const chunk of ModelStreamAdapter.withStreamIdleWatchdog(stream, {
      firstByteTimeoutMs: 30,
      idleTimeoutMs: 50,
      toolExecutionIdleTimeoutMs: 500,
    })) {
      seen.push(chunk)
    }
    expect(seen).toHaveLength(6)
    expect(stream.aborted()).toBe(false)
  })

  test("工具执行期（tool-call 后无事件）不被普通 idle 误杀，用工具档位超时", async () => {
    // 模型发出工具调用后，工具执行/权限等待/postTool 钩子期间流无事件。
    // 普通 idleTimeout 早已超时，但 toolInFlight 档位（toolExecutionIdleTimeoutMs）
    // 还没到 → 不抛错；工具完成（tool-result）后恢复普通 idle 档位。
    const controller = new AbortController()
    async function* gen() {
      yield { type: "start" }
      yield { type: "tool-call", toolCallId: "c1", toolName: "data_import" }
      // 工具执行中：流暂停 300ms，远超普通 idle 阈值（50ms）
      await Bun.sleep(300)
      yield { type: "tool-result", toolCallId: "c1" }
      yield { type: "step-finish" }
    }
    const stream = {
      fullStream: gen(),
      abort: () => controller.abort(),
      aborted: () => controller.signal.aborted,
    }
    const seen: unknown[] = []
    for await (const chunk of ModelStreamAdapter.withStreamIdleWatchdog(stream, {
      firstByteTimeoutMs: 30,
      idleTimeoutMs: 50, // 普通 idle 50ms，工具执行期 300ms 远超它
      toolExecutionIdleTimeoutMs: 500,
    })) {
      seen.push(chunk)
    }
    expect(seen).toHaveLength(4)
    expect(stream.aborted()).toBe(false)
  })
})
