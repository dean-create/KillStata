import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"

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

    expect(SessionRetry.retryable(error)).toBe("Provider stream disconnected")
  })
})
