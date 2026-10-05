import { describe, expect, test } from "bun:test"
import { SessionRetry } from "@/session/retry"

/**
 * 529 按来源白名单：后台任务（标题/摘要）在 provider 过载时不该重试，
 * 免得跟用户正在等的请求抢配额。
 */

function providerError(payload: unknown) {
  return { data: { message: JSON.stringify(payload) } } as never
}

describe("重试来源白名单", () => {
  test("provider 过载：前台重试，后台放弃", () => {
    const overloaded = providerError({ code: "resource_exhausted" })

    // 用户在等 → 值得重试
    expect(SessionRetry.retryable(overloaded, "foreground")).toBeDefined()
    // 后台任务 → 直接放弃，把配额留给前台
    expect(SessionRetry.retryable(overloaded, "background")).toBeUndefined()
  })

  test("限流同样按来源区分", () => {
    const rateLimited = providerError({ type: "error", error: { type: "too_many_requests" } })
    expect(SessionRetry.retryable(rateLimited, "foreground")).toBeDefined()
    expect(SessionRetry.retryable(rateLimited, "background")).toBeUndefined()
  })

  test("非容量类的瞬时故障：后台也该重试（不是抢配额问题）", () => {
    const disconnect = { data: { message: "stream disconnected before completion" } } as never
    expect(SessionRetry.retryable(disconnect, "foreground")).toBeDefined()
    // TLS/断流是网络抖动，重试一次通常就好，不加剧 provider 拥塞
    expect(SessionRetry.retryable(disconnect, "background")).toBeDefined()
  })

  test("默认来源是前台（不传参时行为不变）", () => {
    const overloaded = providerError({ code: "unavailable" })
    expect(SessionRetry.retryable(overloaded)).toBe(SessionRetry.retryable(overloaded, "foreground"))
  })

  test("不可重试的错误：任何来源都不重试", () => {
    const bad = { data: { message: "not json at all, plain failure" } } as never
    expect(SessionRetry.retryable(bad, "foreground")).toBeUndefined()
    expect(SessionRetry.retryable(bad, "background")).toBeUndefined()
  })

  test("后台任务的 SDK 重试次数为 0", () => {
    expect(SessionRetry.BACKGROUND_MAX_RETRIES).toBe(0)
  })
})
