import { describe, expect, test } from "bun:test"
import { sortQueuedSessionActions } from "@/session/prompt/queue-policy"
import { actionMessageID } from "@/session/prompt/queue"

const action = (id: string, priority: number, createdAt: number, metadata?: Record<string, unknown>) => ({
  id,
  sessionID: "ses-test",
  type: "prompt" as const,
  priority,
  createdAt,
  metadata,
})

describe("session queue delivery policy", () => {
  test("活动动作固定使用自己的用户消息，不被队列中更新的消息抢走", () => {
    const active = action("second", 10, 2, { messageID: "user-second" })
    expect(actionMessageID(active)).toBe("user-second")
    expect(actionMessageID(undefined)).toBeUndefined()
  })

  test("steering actions take priority while equal-priority messages stay FIFO", () => {
    const actions = [action("later", 10, 2), action("steer", 30, 3, { delivery: "steer" }), action("first", 10, 1)]
    expect(sortQueuedSessionActions(actions).map((item) => item.id)).toEqual(["steer", "first", "later"])
    expect(actions[1]!.metadata?.delivery).toBe("steer")
    expect(actions[0]!.metadata?.delivery).toBeUndefined()
  })

  test("same-priority user messages remain FIFO", () => {
    const actions = [action("second", 10, 2), action("first", 10, 1)]
    expect(sortQueuedSessionActions(actions).map((item) => item.id)).toEqual(["first", "second"])
  })
})
