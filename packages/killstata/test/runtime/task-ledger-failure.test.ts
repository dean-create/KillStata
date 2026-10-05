import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"

describe("RuntimeTaskLedger failure decisions", () => {
  test("失败分类与 checkpoint 独立于对话历史持久化", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-failure-ledger-"))
    try {
      await Instance.provide({
        directory: root,
        fn: () => {
          const sessionID = "session-failure-ledger"
          RuntimeTaskLedger.recordQueued({
            id: "task-failure-ledger",
            sessionID,
            type: "prompt",
            priority: 1,
            createdAt: Date.now(),
            metadata: {},
          })
          const event = RuntimeTaskLedger.appendEvent({
            sessionID,
            kind: "failure",
            message: "model retry circuit opened",
            failureDecision: {
              scope: "model",
              category: "provider_unavailable",
              disposition: "stop",
              reason: "Service Unavailable",
              userVisibleMessage: "模型服务暂时不可用。",
              attempt: 3,
              maxConsecutiveFailures: 3,
              checkpointId: "chk_123",
            },
          })

          expect(event?.failureDecision).toMatchObject({
            category: "provider_unavailable",
            disposition: "stop",
            checkpointId: "chk_123",
          })
          const ledger = RuntimeTaskLedger.listTasks(sessionID)
          expect(ledger.tasks[0]?.latestFailureDecision).toEqual(event?.failureDecision)
          expect(ledger.tasks[0]?.status).toBe("failed")

          // dispatch 的 finally 会调用 finishDispatch；terminal failure 不能被尾部 completed 覆盖。
          RuntimeTaskLedger.markStatus({ sessionID, status: "completed", message: "dispatch finished" })
          expect(RuntimeTaskLedger.listTasks(sessionID).tasks[0]?.status).toBe("failed")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
