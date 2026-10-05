import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { getActiveWorkflowRun, recordWorkflowStageFailure, recordWorkflowStageSuccess } from "@/runtime/workflow"
import { inferBranch, inferRunId } from "@/tool/analysis-state"

describe("workflow routing inputs", () => {
  test("cannot replace canonical stage runId or branch with model-invented values", () => {
    const stage = { runId: "run_existing", branch: "main", metadata: {} }
    expect(inferRunId({ stage })).toBe("run_existing")
    expect(() => inferRunId({ requestedRunId: "invented", stage })).toThrow(/runId/)
    expect(inferBranch({ stage })).toBe("main")
    expect(() => inferBranch({ requestedBranch: "baseline", stage })).toThrow(/branch/)
  })

  test("model routing hints cannot split an existing stage", () => {
    const stage = { runId: "run_existing", branch: "main", metadata: {} }
    expect(inferRunId({ requestedRunId: "run_logit", stage, source: "model" })).toBe("run_existing")
    expect(inferBranch({ requestedBranch: "probit_main", stage, source: "model" })).toBe("main")
  })

  test("blank model branch is recorded as main and does not split the workflow run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-workflow-branch-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = "session-blank-branch"
          const datasetId = "dataset-blank-branch"
          const runId = "run_existing"
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_import",
            args: { action: "import" },
            metadata: { datasetId, stageId: "stage_000", runId, branch: "main" },
          })
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "panel_fe_regression",
            args: { datasetId, stageId: "stage_001", branch: "" },
            metadata: { datasetId, stageId: "stage_001", runId },
          })
          const workflow = getActiveWorkflowRun(sessionID)!
          expect(workflow.branch).toBe("main")
          expect(workflow.stages.map((stage) => stage.kind)).toContain("import")
          expect(workflow.stages.map((stage) => stage.kind)).toContain("baseline_estimate")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("failure recording stays on the active canonical run despite forged routing fields", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-workflow-failure-route-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = "session-failure-route"
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_import",
            args: { action: "import" },
            metadata: { datasetId: "dataset_1", stageId: "stage_000", runId: "run_real", branch: "robustness" },
          })
          const before = getActiveWorkflowRun(sessionID)!
          recordWorkflowStageFailure({
            sessionID,
            toolName: "panel_fe_regression",
            args: { datasetId: "dataset_1", stageId: "stage_000", runId: "run_forged", branch: "baseline" },
            reflection: {
              toolName: "panel_fe_regression",
              failureType: "tool_contract_failure",
              retryStage: "estimate",
              repairAction: "修正参数",
              blocking: true,
              autoRetry: false,
              originalError: "invalid",
              summarizedError: "invalid",
              occurredAt: new Date().toISOString(),
            } as never,
          })
          const after = getActiveWorkflowRun(sessionID)!
          expect(after.workflowRunId).toBe(before.workflowRunId)
          expect(after.runId).toBe("run_real")
          expect(after.branch).toBe("robustness")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a first-import failure without datasetId cannot poison the previous dataset run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-workflow-import-failure-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = "session-import-failure"
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_import",
            args: { action: "import" },
            metadata: { datasetId: "old_dataset", stageId: "stage_000", runId: "run_old", branch: "main" },
          })
          const old = getActiveWorkflowRun(sessionID)!
          recordWorkflowStageFailure({
            sessionID,
            toolName: "data_import",
            args: { action: "import", inputPath: "/missing/new.xlsx" },
            reflection: {
              toolName: "data_import",
              failureType: "file_not_found",
              retryStage: "import",
              repairAction: "重新选择文件",
              blocking: true,
              autoRetry: false,
              originalError: "missing",
              summarizedError: "missing",
              occurredAt: new Date().toISOString(),
            } as never,
          })
          const current = getActiveWorkflowRun(sessionID)!
          expect(current.workflowRunId).not.toBe(old.workflowRunId)
          expect(current.datasetId).toBeUndefined()
          expect(old.repairOnly).toBe(false)

          recordWorkflowStageFailure({
            sessionID,
            toolName: "data_import",
            args: { action: "import", inputPath: "/missing/another.xlsx" },
            reflection: {
              toolName: "data_import",
              failureType: "file_not_found",
              retryStage: "import",
              repairAction: "重新选择文件",
              blocking: true,
              autoRetry: false,
              originalError: "missing again",
              summarizedError: "missing again",
              occurredAt: new Date().toISOString(),
            } as never,
          })
          const secondFailure = getActiveWorkflowRun(sessionID)!
          expect(secondFailure.workflowRunId).not.toBe(current.workflowRunId)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
