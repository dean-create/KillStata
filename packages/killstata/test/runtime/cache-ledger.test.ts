import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { Instance } from "@/project/instance"

async function withInstance<T>(fn: (sessionID: string) => T | Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-cache-report-"))
  try {
    return await Instance.provide({ directory: root, fn: () => fn("session-cache") })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("cache usage accounting", () => {
  test("computes cache hit ratio from raw token counters", () => {
    expect(
      RuntimeTaskLedger.cacheHitRatio({
        input: 100,
        cache: { read: 800, write: 100 },
      }),
    ).toBeCloseTo(0.8)
  })

  test("does not invent a hit when the request has no input tokens", () => {
    expect(
      RuntimeTaskLedger.cacheHitRatio({
        input: 0,
        cache: { read: 0, write: 0 },
      }),
    ).toBe(0)
  })

  test("aggregates observations and reports break reasons", async () => {
    await withInstance((sessionID) => {
      const correlation = {
        sessionID,
        turnID: "turn",
        requestID: "request",
        stepID: "step",
        attempt: 0,
        providerID: "provider",
        modelID: "model",
      }
      RuntimeTaskLedger.recordQueued({
        id: "task-cache",
        sessionID,
        type: "prompt",
        priority: 1,
        createdAt: Date.now(),
        metadata: {},
      })
      RuntimeTaskLedger.recordCacheObservation({
        sessionID,
        correlation,
        fingerprint: { promptHash: "a" },
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 800, write: 100 } },
        breakReason: "first_request",
      })
      RuntimeTaskLedger.recordCacheObservation({
        sessionID,
        correlation: { ...correlation, stepID: "step-2" },
        fingerprint: { promptHash: "b" },
        tokens: { input: 200, output: 10, reasoning: 0, cache: { read: 0, write: 50 } },
        breakReason: "tools_changed",
      })
      const report = RuntimeTaskLedger.cacheReport(sessionID)
      expect(report.observationCount).toBe(2)
      expect(report.truncated).toBe(false)
      expect(report.uncachedInputTokens).toBe(300)
      expect(report.cacheReadTokens).toBe(800)
      expect(report.cacheWriteTokens).toBe(150)
      expect(report.breakCount).toBe(1)
      expect(report.breakReasons.tools_changed).toBe(1)
      expect(report.lastBreakReason).toBe("tools_changed")
      expect(report.breakReasons).toEqual({ tools_changed: 1 })
      expect(report.hitRatio).toBeCloseTo(800 / 1250)
    })
  })
})
