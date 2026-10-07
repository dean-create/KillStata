import { describe, expect, test } from "bun:test"
import { Session } from "@/session"

describe("会话超时与用户取消的区分", () => {
  test("框架超时是可识别的取消原因，但仍属于取消错误类型", () => {
    const error = new Session.TimeoutError("ses-timeout", 60_000)

    expect(error).toBeInstanceOf(Session.CancelledError)
    expect(error.name).toBe("SessionTimeoutError")
    expect(error.timeoutMs).toBe(60_000)
  })
})
