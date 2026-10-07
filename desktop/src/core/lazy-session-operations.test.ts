import { describe, expect, test, vi } from "vitest"
import { createLazySessionOperations } from "./lazy-session-operations"
import type { EngineClient, EngineVerificationUpdate } from "../engine/client"

describe("Tauri 懒加载 Engine 的 Core 会话命令转发", () => {
  test("等待 Core adapter 就绪后转发所有 Desktop 会话斜杠命令", async () => {
    const calls: unknown[][] = []
    const target = {
      context: vi.fn(async (...args: unknown[]) => { calls.push(["context", ...args]); return { usage: { usedTokens: 4 } } }),
      summarize: vi.fn(async (...args: unknown[]) => { calls.push(["summarize", ...args]) }),
      updateTitle: vi.fn(async (...args: unknown[]) => { calls.push(["updateTitle", ...args]) }),
      revertLatest: vi.fn(async (...args: unknown[]) => { calls.push(["revertLatest", ...args]) }),
      unrevert: vi.fn(async (...args: unknown[]) => { calls.push(["unrevert", ...args]) }),
    } as unknown as EngineClient
    let resolveTarget!: (engine: EngineClient) => void
    const pendingTarget = new Promise<EngineClient>((done) => { resolveTarget = done })
    const resolve = vi.fn(() => pendingTarget)
    const operations = createLazySessionOperations(resolve)

    const context = operations.context!("ses_1")
    expect(resolve).toHaveBeenCalledOnce()
    resolveTarget(target)
    await expect(context).resolves.toEqual({ usage: { usedTokens: 4 } })
    await operations.summarize!("ses_1", { providerID: "deepseek", modelID: "deepseek-v4-flash" }, "保留重点")
    await operations.updateTitle!("ses_1", "新标题")
    await operations.revertLatest!("ses_1")
    await operations.unrevert!("ses_1")

    expect(calls).toEqual([
      ["context", "ses_1"],
      ["summarize", "ses_1", { providerID: "deepseek", modelID: "deepseek-v4-flash" }, "保留重点"],
      ["updateTitle", "ses_1", "新标题"],
      ["revertLatest", "ses_1"],
      ["unrevert", "ses_1"],
    ])
  })

  test("底层 adapter 缺少会话操作时给出明确错误，不伪装成功", async () => {
    const operations = createLazySessionOperations(async () => ({} as EngineClient))

    await expect(operations.context!("ses_1")).rejects.toThrow("当前引擎不支持读取上下文状态")
    await expect(operations.summarize!("ses_1", { providerID: "deepseek", modelID: "deepseek-v4-flash" })).rejects.toThrow("当前引擎不支持会话压缩")
  })

  test("懒加载 facade 转发主 Turn 结束后的会话级 verifier 更新", async () => {
    const update: EngineVerificationUpdate = {
      sessionID: "ses_1", messageID: "msg_1", callID: "call_ols", status: "pass", message: "独立核验通过。",
    }
    let deliver!: (event: EngineVerificationUpdate) => void
    const unsubscribe = vi.fn()
    const target = {
      subscribeVerification: vi.fn((listener: (event: EngineVerificationUpdate) => void) => {
        deliver = listener
        return unsubscribe
      }),
    } as unknown as EngineClient
    let resolveTarget!: (engine: EngineClient) => void
    const pendingTarget = new Promise<EngineClient>((done) => { resolveTarget = done })
    const resolve = vi.fn(() => pendingTarget)
    const operations = createLazySessionOperations(resolve)
    const subscribeVerification = Reflect.get(operations, "subscribeVerification")
    expect(subscribeVerification).toBeTypeOf("function")
    if (typeof subscribeVerification !== "function") return

    const listener = vi.fn()
    const stop = subscribeVerification(listener)
    expect(resolve).toHaveBeenCalledOnce()
    resolveTarget(target)
    await vi.waitFor(() => expect(target.subscribeVerification).toHaveBeenCalledOnce())
    deliver(update)
    expect(listener).toHaveBeenCalledWith(update)
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  test("Core 尚未连接时订阅解析失败不会产生未处理的拒绝", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      const operations = createLazySessionOperations(async () => {
        throw new Error("Core 尚未启动")
      })
      operations.subscribeVerification?.(() => {})
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})
