import { describe, expect, test } from "bun:test"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { Instance } from "@/project/instance"
import fs from "fs"
import os from "os"
import path from "path"

describe("persistent compaction circuit", () => {
  test("从 ledger completed lifecycle 计数，不受尾部 user/start 事件影响；模型成功后清零", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-compaction-ledger-"))
    try {
      await Instance.provide({
        directory: root,
        fn: () => {
          const sessionID = "session-compaction-ledger"
          RuntimeTaskLedger.recordQueued({ id: "task-compaction-ledger", sessionID, type: "compaction", priority: 1, createdAt: Date.now() })
          const lifecycle = (
            summarySource: "fallback" | "model",
            index: number,
            reason: "manual" | "overflow" = "overflow",
          ) => ({
            operationId: `cmp_${index}`,
            sessionID,
            parentID: `message_${index}`,
            reason,
            status: "completed" as const,
            inputMessageCount: 10,
            summarySource,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          for (let i = 0; i < 3; i++) {
            RuntimeTaskLedger.appendEvent({ sessionID, kind: "compaction", compaction: lifecycle("fallback", i) })
            RuntimeTaskLedger.appendEvent({ sessionID, kind: "compaction", compaction: lifecycle("fallback", 100 + i, "manual") })
            RuntimeTaskLedger.appendEvent({ sessionID, kind: "model.request", message: "next compaction started" })
          }
          expect(RuntimeTaskLedger.consecutiveCompactionFallbacks(sessionID)).toBe(3)
          RuntimeTaskLedger.appendEvent({ sessionID, kind: "compaction", compaction: lifecycle("model", 200, "manual") })
          expect(RuntimeTaskLedger.consecutiveCompactionFallbacks(sessionID)).toBe(3)
          RuntimeTaskLedger.appendEvent({ sessionID, kind: "compaction", compaction: lifecycle("model", 4) })
          expect(RuntimeTaskLedger.consecutiveCompactionFallbacks(sessionID)).toBe(0)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
