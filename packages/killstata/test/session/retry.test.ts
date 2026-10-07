import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"
import { FailurePolicy } from "../../src/runtime/failure-policy"

describe("session.retry", () => {
  test("treats compact stream disconnects as retryable", () => {
    const error = new MessageV2.APIError({
      message:
        "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)",
      isRetryable: false,
      metadata: {
        url: "https://chatgpt.com/backend-api/codex/responses/compact",
      },
    }).toObject()

    // 断言稳定的分类契约，而不是 `retryable()` 顺带返回的内部英文原因文案。
    // 该文案随失败策略重构变过一次（"Provider stream disconnected" → "Transient
    // network failure"），把它写进断言会让测试在纯重命名时就变红，掩盖真正的语义：
    // 压缩流断开必须被判为可重试的瞬时网络故障。
    const decision = FailurePolicy.classifyModel(error, "foreground")
    expect(decision.category).toBe("transient_network")
    expect(decision.disposition).toBe("retry")
    // retryable() 是上层便捷封装：可重试时返回原因字符串（非空），不可重试时返回 undefined。
    expect(SessionRetry.retryable(error)).toBeTruthy()
  })

  test("does not retry insufficient_quota provider errors", () => {
    const error = new MessageV2.APIError({
      message: "insufficient_quota: current account quota exceeded",
      isRetryable: true,
    }).toObject()

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })
  test("does not retry provider balance exhaustion even when SDK marks it retryable", () => {
    const error = new APICallError({
      message: "Insufficient Balance",
      url: "https://api.deepseek.com/chat/completions",
      requestBodyValues: {},
      statusCode: 402,
      responseHeaders: {},
      responseBody: JSON.stringify({ message: "Insufficient Balance" }),
      isRetryable: true,
    })
    const formatted = MessageV2.fromError(error, { providerID: "deepseek" })

    expect(formatted.data.message).toContain("额度不足")
    expect(SessionRetry.retryable(formatted)).toBeUndefined()
  })
})
