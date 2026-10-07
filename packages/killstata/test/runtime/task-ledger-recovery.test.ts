import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { projectStateRoot } from "@/runtime/dataset-state"
import { LedgerCorruptionError, RuntimeTaskLedger } from "@/runtime/task-ledger"

async function withInstance<T>(fn: (root: string) => T | Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-ledger-recovery-"))
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function queueAction(sessionID: string, id = "task-ledger") {
  return {
    id,
    sessionID,
    type: "prompt" as const,
    priority: 1,
    createdAt: Date.now(),
    metadata: {},
  }
}

function ledgerFile(root: string, sessionID: string) {
  return path.join(root, ".killstata", "runtime", "tasks", `${sessionID}.json`)
}

describe("RuntimeTaskLedger recovery", () => {
  test("a late completion cannot commit after abort even if the watcher missed the signal", async () => {
    await withInstance(() => {
      const sessionID = "session-ledger-tool-abort-write-race"
      const taskId = "task-ledger-tool-abort-write-race"
      RuntimeTaskLedger.recordQueued({
        ...queueAction(sessionID, taskId),
        metadata: { messageID: "message-ledger-tool-abort-write-race" },
      })
      const request = RuntimeTaskLedger.recordAnalysisRequest({
        sessionID,
        taskId,
        sourceMessageId: "message-ledger-tool-abort-write-race",
        kind: "estimate",
        researchGoal: "验证取消写账本失败后的晚到结果",
        constraints: [],
      })
      RuntimeTaskLedger.transitionAnalysis({
        sessionID,
        taskId,
        event: { type: "diagnosis_started", requestId: request.requestId },
      })
      RuntimeTaskLedger.transitionAnalysis({
        sessionID,
        taskId,
        event: {
          type: "diagnosis_completed",
          requestId: request.requestId,
          datasetId: "dataset_abort_write_race",
          stageId: "stage_000",
          stageFingerprint: `sha256:${"a".repeat(64)}`,
        },
      })
      RuntimeTaskLedger.transitionAnalysis({
        sessionID,
        taskId,
        event: {
          type: "tool_run_started",
          operation: {
            requestId: request.requestId,
            operationId: "call_abort_write_race",
            toolID: "composite_evaluation",
            datasetId: "dataset_abort_write_race",
            stageId: "stage_000",
            stageFingerprint: `sha256:${"a".repeat(64)}`,
            inputFingerprint: `sha256:${"b".repeat(64)}`,
            authorizationMessageId: request.sourceMessageId,
          },
        },
      })

      const controller = new AbortController()
      controller.abort()
      expect(RuntimeTaskLedger.listTasks(sessionID).tasks[0]?.analysisLifecycle?.status).toBe("running")
      expect(() => RuntimeTaskLedger.completeAnalysisToolRun({
        sessionID,
        taskId,
        signal: controller.signal,
        operation: {
          requestId: request.requestId,
          operationId: "call_abort_write_race",
          toolID: "composite_evaluation",
          datasetId: "dataset_abort_write_race",
          stageId: "stage_000",
          stageFingerprint: `sha256:${"a".repeat(64)}`,
          inputFingerprint: `sha256:${"b".repeat(64)}`,
          authorizationMessageId: request.sourceMessageId,
          status: "completed",
          resultId: "late_result_after_abort_write_failure",
          artifactRefs: ["artifacts/result.parquet"],
          resultContractStatus: "pass",
          subResults: [],
          updatedAt: new Date().toISOString(),
        },
      })).toThrow("取消")
      expect(RuntimeTaskLedger.listTasks(sessionID).tasks[0]?.analysisLifecycle?.status).toBe("unconfirmed")
      expect(RuntimeTaskLedger.listTasks(sessionID).tasks[0]?.analysisLifecycle?.toolRuns)
        .toMatchObject([{ status: "unconfirmed", failureCode: "TOOL_ABORTED_UNCONFIRMED" }])
    })
  })

  test("an abort watcher persists an unconfirmed tool run and prevents a late result", async () => {
    await withInstance(() => {
      const sessionID = "session-ledger-tool-abort"
      const taskId = "task-ledger-tool-abort"
      RuntimeTaskLedger.recordQueued({
        ...queueAction(sessionID, taskId),
        metadata: { messageID: "message-ledger-tool-abort" },
      })
      const request = RuntimeTaskLedger.recordAnalysisRequest({
        sessionID,
        taskId,
        sourceMessageId: "message-ledger-tool-abort",
        kind: "estimate",
        researchGoal: "验证取消后的工具状态",
        constraints: [],
      })
      RuntimeTaskLedger.transitionAnalysis({
        sessionID,
        taskId,
        event: { type: "diagnosis_started", requestId: request.requestId },
      })
      RuntimeTaskLedger.transitionAnalysis({
        sessionID,
        taskId,
        event: {
          type: "diagnosis_completed",
          requestId: request.requestId,
          datasetId: "dataset_abort_watch",
          stageId: "stage_000",
          stageFingerprint: `sha256:${"a".repeat(64)}`,
        },
      })
      RuntimeTaskLedger.transitionAnalysis({
        sessionID,
        taskId,
        event: {
          type: "tool_run_started",
          operation: {
            requestId: request.requestId,
            operationId: "call_abort_watch",
            toolID: "composite_evaluation",
            datasetId: "dataset_abort_watch",
            stageId: "stage_000",
            stageFingerprint: `sha256:${"a".repeat(64)}`,
            inputFingerprint: `sha256:${"b".repeat(64)}`,
            authorizationMessageId: request.sourceMessageId,
          },
        },
      })

      const controller = new AbortController()
      const dispose = RuntimeTaskLedger.watchAnalysisToolRunAbort({
        sessionID,
        taskId,
        requestId: request.requestId,
        operationId: "call_abort_watch",
        signal: controller.signal,
      })
      controller.abort()
      dispose()

      const lifecycle = RuntimeTaskLedger.listTasks(sessionID).tasks[0]?.analysisLifecycle
      expect(lifecycle?.status).toBe("unconfirmed")
      expect(lifecycle?.toolRuns).toMatchObject([{ operationId: "call_abort_watch", status: "unconfirmed" }])
      expect(() => RuntimeTaskLedger.transitionAnalysis({
        sessionID,
        taskId,
        event: {
          type: "tool_run_recorded",
          operation: {
            requestId: request.requestId,
            operationId: "call_abort_watch",
            toolID: "composite_evaluation",
            datasetId: "dataset_abort_watch",
            stageId: "stage_000",
            stageFingerprint: `sha256:${"a".repeat(64)}`,
            inputFingerprint: `sha256:${"b".repeat(64)}`,
            authorizationMessageId: request.sourceMessageId,
            status: "completed",
            resultId: "late_result",
            artifactRefs: ["artifacts/result.parquet"],
            resultContractStatus: "pass",
            subResults: [],
            updatedAt: new Date().toISOString(),
          },
        },
      })).toThrow("终态")
    })
  })

  test("writes atomically and assigns stable per-session timeline sequences", async () => {
    await withInstance((root) => {
      const sessionID = "session-ledger"
      RuntimeTaskLedger.recordQueued(queueAction(sessionID))
      RuntimeTaskLedger.appendEvent({
        sessionID,
        taskId: "task-ledger",
        kind: "tool.result",
        message: "first result",
      })
      RuntimeTaskLedger.appendEvent({
        sessionID,
        taskId: "task-ledger",
        kind: "tool.result",
        message: "second result",
      })

      const ledger = RuntimeTaskLedger.listTasks(sessionID)
      const timeline = ledger.tasks[0]?.timeline ?? []
      expect(timeline.map((event) => event.sequence)).toEqual([0, 1, 2])
      expect(new Set(timeline.map((event) => event.id)).size).toBe(3)
      expect(fs.existsSync(ledgerFile(root, sessionID))).toBe(true)
      expect(fs.readdirSync(path.dirname(ledgerFile(root, sessionID))).some((name) => name.includes(".tmp-"))).toBe(false)
    })
  })

  test("does not treat a corrupt ledger as an empty ledger", async () => {
    await withInstance((root) => {
      const sessionID = "session-corrupt"
      RuntimeTaskLedger.recordQueued(queueAction(sessionID))
      const file = ledgerFile(root, sessionID)
      fs.writeFileSync(file, "{\"version\":1", "utf8")

      expect(() => RuntimeTaskLedger.listTasks(sessionID)).toThrow(LedgerCorruptionError)
      expect(RuntimeTaskLedger.health(sessionID)).toMatchObject({
        status: "unavailable",
        code: "LEDGER_CORRUPT",
        path: file,
      })
      expect(fs.readFileSync(file, "utf8")).toBe("{\"version\":1")
    })
  })

  test("reports an unsupported ledger version without rewriting it", async () => {
    await withInstance((root) => {
      const sessionID = "session-version"
      RuntimeTaskLedger.recordQueued(queueAction(sessionID))
      const file = ledgerFile(root, sessionID)
      const raw = JSON.stringify({ version: 99, sessionID, tasks: [], checkpoints: [] })
      fs.writeFileSync(file, raw, "utf8")

      expect(() => RuntimeTaskLedger.listTasks(sessionID)).toThrow(LedgerCorruptionError)
      expect(RuntimeTaskLedger.health(sessionID)?.code).toBe("LEDGER_UNSUPPORTED_VERSION")
      expect(fs.readFileSync(file, "utf8")).toBe(raw)
    })
  })
})
