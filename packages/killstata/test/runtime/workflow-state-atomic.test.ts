import { expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"

test("工作流状态落盘中断时保留上一份有效状态，避免待核验断点损坏", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-workflow-write-"))
  try {
    await Instance.provide({ directory: root, fn: async () => {
      const sessionID = "atomic_verifier"
      const first = readWorkflowSession(sessionID)
      first.activeRunId = "first"
      writeWorkflowSession(first)

      const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("simulated interrupted write") })
      try {
        expect(() => writeWorkflowSession({ ...first, activeRunId: "second" })).toThrow("simulated interrupted write")
      } finally {
        rename.mockRestore()
      }
      expect(readWorkflowSession(sessionID).activeRunId).toBe("first")
    } })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
