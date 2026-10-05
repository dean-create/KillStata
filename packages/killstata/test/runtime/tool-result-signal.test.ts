import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { SessionProcessor } from "@/session/processor"
import type { MessageV2 } from "@/session/message-v2"

describe("工具结果低信号遥测", () => {
  test("短但产生 stage 的结果不是低信号，短且无进度证据的结果只记录不熔断", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-tool-signal-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = "session-tool-signal"
          RuntimeTaskLedger.recordQueued({
            id: "task-tool-signal",
            sessionID,
            type: "prompt",
            priority: 1,
            createdAt: Date.now(),
            metadata: {},
          })
          const processor = SessionProcessor.create({
            assistantMessage: { id: "message-tool-signal", sessionID, agent: "analyst" } as MessageV2.Assistant,
            sessionID,
            model: { providerID: "deepseek", id: "deepseek-chat" } as never,
            abort: new AbortController().signal,
            runRuntimeHooks: false,
          })

          await processor.executeTool("data_preprocess", {}, {
            callID: "signal-progress",
            run: async () => ({ title: "完成", output: "完成", metadata: { stageId: "stage_2" } }),
          })
          await processor.executeTool("pipeline", { secret: "sk-sensitive-value" }, {
            callID: "signal-low",
            run: async () => ({ title: "状态", output: "暂无变化", metadata: {} }),
          })

          const ledger = RuntimeTaskLedger.listTasks(sessionID)
          const results = ledger.tasks[0]?.timeline.filter((event) => event.kind === "tool.result") ?? []
          expect(results[0]?.metadata?.resultSignal).toMatchObject({
            lowSignal: false,
            progressEvidence: ["stageId"],
          })
          expect(results[1]?.metadata?.resultSignal).toMatchObject({
            lowSignal: true,
            progressEvidence: [],
          })
          expect(ledger.tasks[0]?.status).not.toBe("failed")
          const attempts = ledger.tasks[0]?.metadata?.toolAttempts as Array<{ signature: string }> | undefined
          expect(attempts?.every((attempt) => attempt.signature.startsWith("sha256:"))).toBe(true)
          expect(JSON.stringify(attempts)).not.toContain("sk-sensitive-value")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
