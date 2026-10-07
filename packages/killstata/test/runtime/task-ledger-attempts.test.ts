import { describe, expect, test } from "bun:test"
import { Instance } from "@/project/instance"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import fs from "fs"
import os from "os"
import path from "path"

async function withInstance<T>(fn: (root: string) => T | Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-attempt-ledger-"))
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function seedTask(sessionID: string) {
  RuntimeTaskLedger.recordQueued({
    id: "task-attempts",
    sessionID,
    type: "prompt",
    priority: 1,
    createdAt: Date.now(),
    metadata: {},
  })
}

describe("RuntimeTaskLedger tool attempts", () => {
  test("blocks a signature only after repeated failures", async () => {
    await withInstance(() => {
      const sessionID = "session-attempts"
      seedTask(sessionID)
      const input = {
        sessionID,
        toolName: "ols_regression",
        signature: "ols {datasetId:ds}",
        maxAttempts: 3,
      } as const

      for (let attempt = 0; attempt < 3; attempt++) {
        expect(RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "started" })).toMatchObject({
          allowed: true,
          count: attempt,
        })
        RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "failed", errorCode: "ESTIMATION_FAILED" })
      }

      expect(RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "started" })).toMatchObject({
        allowed: false,
        count: 3,
        max: 3,
      })
    })
  })

  test("a successful execution clears the failure budget for that signature", async () => {
    await withInstance(() => {
      const sessionID = "session-attempts-recovered"
      seedTask(sessionID)
      const input = {
        sessionID,
        toolName: "ols_regression",
        signature: "ols {datasetId:ds}",
        maxAttempts: 3,
      } as const

      RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "started" })
      RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "failed", errorCode: "ESTIMATION_FAILED" })
      RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "started" })
      RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "completed" })

      expect(RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "started" })).toMatchObject({
        allowed: true,
        count: 0,
      })
    })
  })

  test("deterministic estimator failures block the same signature after one attempt", async () => {
    await withInstance(() => {
      const sessionID = "session-attempts-deterministic"
      seedTask(sessionID)
      const input = {
        sessionID,
        toolName: "ols_regression",
        signature: "ols {datasetId:ds,stageId:stage_1}",
        maxAttempts: 3,
      } as const

      expect(RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "started" })).toMatchObject({ allowed: true })
      RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "failed", errorCode: "DESIGN_MATRIX_RANK_DEFICIENT" })
      expect(RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "started" })).toMatchObject({
        allowed: false,
        count: 1,
        max: 1,
      })
    })
  })

  // 幂等只读调用（同一文件的 read、todoread、workflow status）在长任务里会重复很多次，
  // 每次都成功时不能被当成"同一失败签名"耗尽额度。
  test("repeated successful calls with the same signature stay allowed", async () => {
    await withInstance(() => {
      const sessionID = "session-attempts-idempotent"
      seedTask(sessionID)
      const input = {
        sessionID,
        toolName: "read",
        signature: "read {filePath:/tmp/a.csv}",
        maxAttempts: 3,
      } as const

      for (let call = 0; call < 6; call++) {
        expect(RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "started" })).toMatchObject({ allowed: true })
        RuntimeTaskLedger.recordToolAttempt({ ...input, kind: "completed" })
      }
    })
  })

  test("failures of a different signature do not consume this signature's budget", async () => {
    await withInstance(() => {
      const sessionID = "session-attempts-scoped"
      seedTask(sessionID)
      const target = { sessionID, toolName: "ols_regression", signature: "ols {a}", maxAttempts: 3 } as const
      const other = { sessionID, toolName: "ols_regression", signature: "ols {b}", maxAttempts: 3 } as const

      for (let attempt = 0; attempt < 3; attempt++) {
        RuntimeTaskLedger.recordToolAttempt({ ...other, kind: "started" })
        RuntimeTaskLedger.recordToolAttempt({ ...other, kind: "failed" })
      }

      expect(RuntimeTaskLedger.recordToolAttempt({ ...target, kind: "started" })).toMatchObject({
        allowed: true,
        count: 0,
      })
    })
  })
})
