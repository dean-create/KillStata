import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ContextManager } from "@/runtime/context-manager"
import type { ContextUsageSnapshot } from "@/runtime/context-budget"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("ContextManager snapshot", () => {
  test("keeps the latest model token usage in a fresh session context response", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-context-snapshot-"))
    directories.push(directory)
    const sessionID = "ses_context_snapshot"
    const usage: ContextUsageSnapshot = {
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      contextLimit: 1_000_000,
      inputBudget: 968_000,
      reserveTokens: 32_000,
      estimatedPromptTokens: 12_500,
      estimatedSystemTokens: 3_000,
      estimatedToolTokens: 5_000,
      estimatedMessageTokens: 4_500,
      usedTokens: 12_700,
      remainingTokens: 955_300,
      percentage: 1,
      source: "actual",
      compactionState: "none",
      updatedAt: new Date().toISOString(),
    }

    await Instance.provide({
      directory,
      fn: async () => {
        RuntimeTaskLedger.recordQueued({
          id: "task_context_snapshot",
          sessionID,
          type: "prompt",
          priority: 1,
          createdAt: Date.now(),
        })
        ContextManager.publishUsage({ sessionID, usage })

        const snapshot = ContextManager.snapshot({ sessionID })
        expect(snapshot.usage).toMatchObject({
          usedTokens: 12_700,
          inputBudget: 968_000,
          percentage: 1,
          compactionState: "none",
        })
      },
    })
  })
})
