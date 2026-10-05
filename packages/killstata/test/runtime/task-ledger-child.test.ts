import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"

async function withInstance<T>(fn: () => T | Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-ledger-child-"))
  try {
    return await Instance.provide({ directory: root, fn })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function queueAction(sessionID: string) {
  return {
    id: "task-parent",
    sessionID,
    type: "prompt" as const,
    priority: 1,
    createdAt: Date.now(),
    metadata: {},
  }
}

describe("RuntimeTaskLedger 子代理关联", () => {
  test("子代理结束不会把父任务标成终态", async () => {
    await withInstance(() => {
      const sessionID = "session-child"
      const parent = RuntimeTaskLedger.recordQueued(queueAction(sessionID))
      RuntimeTaskLedger.markStatus({ sessionID, taskId: parent.taskId, status: "running" })

      RuntimeTaskLedger.linkChildTask({ sessionID, childSessionID: "session-sub" })
      RuntimeTaskLedger.recordChildTaskOutcome({
        sessionID,
        childSessionID: "session-sub",
        status: "completed",
        result: { summary: "done" },
      })

      const task = RuntimeTaskLedger.listTasks(sessionID).tasks.find((item) => item.taskId === parent.taskId)
      // 父轮次仍在执行：子代理的成败只进时间线，不改父任务状态，也不把父任务认作自己的父节点。
      expect(task?.status).toBe("running")
      expect(task?.parentTaskId).toBeUndefined()
      expect(task?.childSessionID).toBe("session-sub")
      expect(task?.timeline.some((event) => event.message === "subagent completed")).toBe(true)
    })
  })

  test("子代理失败同样只记录结果", async () => {
    await withInstance(() => {
      const sessionID = "session-child-failed"
      const parent = RuntimeTaskLedger.recordQueued(queueAction(sessionID))
      RuntimeTaskLedger.markStatus({ sessionID, taskId: parent.taskId, status: "running" })

      RuntimeTaskLedger.linkChildTask({ sessionID, childSessionID: "session-sub" })
      RuntimeTaskLedger.recordChildTaskOutcome({
        sessionID,
        childSessionID: "session-sub",
        status: "failed",
        result: { error: "boom" },
      })

      const task = RuntimeTaskLedger.listTasks(sessionID).tasks.find((item) => item.taskId === parent.taskId)
      expect(task?.status).toBe("running")
      const event = task?.timeline.findLast((item) => item.message === "subagent failed")
      expect(event?.metadata).toMatchObject({ childSessionID: "session-sub", status: "failed", error: "boom" })
    })
  })
})
