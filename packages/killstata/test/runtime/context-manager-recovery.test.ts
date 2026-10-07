import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { ContextManager } from "@/runtime/context-manager"
import { Instance } from "@/project/instance"
import type { ContextUsageSnapshot } from "@/runtime/context-budget"

function usage(): ContextUsageSnapshot {
  return {
    providerID: "provider",
    modelID: "model",
    contextLimit: 10_000,
    inputBudget: 9_000,
    reserveTokens: 1_000,
    estimatedPromptTokens: 100,
    estimatedSystemTokens: 10,
    estimatedToolTokens: 20,
    estimatedMessageTokens: 70,
    usedTokens: 100,
    remainingTokens: 8_900,
    percentage: 1,
    source: "estimated",
    compactionState: "none",
    updatedAt: "2026-08-20T00:00:00.000Z",
  }
}

describe("ContextManager corrupt-ledger isolation", () => {
  test("still publishes usage when the persisted ledger is corrupt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-context-corrupt-"))
    try {
      await Instance.provide({
        directory: root,
        fn: () => {
          const sessionID = "session-context-corrupt"
          const ledgerPath = path.join(root, ".killstata", "runtime", "tasks", `${sessionID}.json`)
          fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
          fs.writeFileSync(ledgerPath, '{"version":1', "utf8")

          expect(() => ContextManager.publishUsage({ sessionID, usage: usage() })).not.toThrow()
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
