/**
 * 修复模式下"前置动作成功"不得把修复目标顶掉。
 *
 * stage.ts 的注释点名了 data_import / data_preprocess 作为修复前置动作，但这两个工具
 * 落到的 stage kind（import / validate / preprocess_or_filter）全部在 AUTO_VERIFY_STAGES
 * 里，三元表达式中 stageNeedsVerifier(kind) 先短路成 "verifier"，保留分支永远走不到。
 * 结果是 activeStage 被顶成 verifier，同时 repairOnly 仍为 true —— 自相矛盾的状态，
 * 修复目标（baseline_estimate）从 activeStage 上消失。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"
import { getActiveWorkflowRun, readWorkflowSession, recordWorkflowStageFailure, recordWorkflowStageSuccess } from "@/runtime/workflow"

function createStage(root: string, datasetId: string) {
  const sourcePath = path.join(root, `${datasetId}.csv`)
  fs.writeFileSync(sourcePath, "id,t,y,d\n1,1,2,0\n1,2,3,1\n", "utf-8")
  const manifest = createDatasetManifest({ datasetId, sourcePath, sourceFormat: "csv" })
  appendStage(manifest, {
    stageId: "stage_000",
    branch: "main",
    action: "import",
    workingPath: sourcePath,
    workingFormat: "parquet",
    createdAt: new Date().toISOString(),
  })
  return manifest
}

function estimationFailure() {
  return {
    toolName: "did_static",
    failureType: "tool_contract_failure" as const,
    rootCause: "estimation failed",
    blocking: true,
    retryStage: "baseline_estimate",
    repairAction: "先补齐前置数据检查再重试",
    userVisibleExplanation: "这一步分析没能完成",
    createdAt: new Date().toISOString(),
    error: "estimation failed",
  }
}

async function withInstance(fn: (root: string) => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-repair-prereq-"))
  try {
    await Instance.provide({ directory: root, fn: async () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("修复模式下的前置动作", () => {
  test("data_import(qa) 作为修复前置成功后，activeStage 仍是失败的估计阶段", async () => {
    await withInstance((root) => {
      const datasetId = "ds_repair_prereq_qa"
      const sessionID = "ses_repair_prereq_qa"
      createStage(root, datasetId)

      // 估计阶段失败 → 进入 repairOnly
      const failed = recordWorkflowStageFailure({
        sessionID,
        toolName: "did_static",
        args: { datasetId, stageId: "stage_000" },
        reflection: estimationFailure(),
      })
      expect(failed.workflowRun.repairOnly).toBe(true)
      expect(failed.workflowRun.activeStage).toBe("baseline_estimate")

      // 修复前置动作：补 QA。成功后不能把修复目标顶掉
      const after = recordWorkflowStageSuccess({
        sessionID,
        toolName: "data_import",
        args: { action: "validate", datasetId, stageId: "stage_000" },
        metadata: { action: "validate", datasetId, stageId: "stage_000" },
      })

      expect(after.workflowRun.activeStage).toBe("baseline_estimate")
      expect(after.workflowRun.repairOnly).toBe(true)
      // 修复目标尚未成功，失败详情应保留
      expect(after.workflowRun.latestFailure).toBeDefined()
    })
  })

  test("修复目标工具本身成功后，清 repairOnly 并顺延", async () => {
    await withInstance((root) => {
      const datasetId = "ds_repair_target_done"
      const sessionID = "ses_repair_target_done"
      createStage(root, datasetId)

      recordWorkflowStageFailure({
        sessionID,
        toolName: "did_static",
        args: { datasetId, stageId: "stage_000" },
        reflection: estimationFailure(),
      })

      const after = recordWorkflowStageSuccess({
        sessionID,
        toolName: "did_static",
        args: { datasetId, stageId: "stage_000" },
        metadata: { datasetId, stageId: "stage_000" },
      })

      expect(after.workflowRun.repairOnly).toBe(false)
      // baseline_estimate 需要 verifier，成功后应顺延到 verifier
      expect(after.workflowRun.activeStage).toBe("verifier")
      expect(after.workflowRun.latestFailure).toBeUndefined()
    })
  })

  test("已完成估计后晚到的无关导入失败不能劫持活动工作流", async () => {
    await withInstance((root) => {
      const datasetId = "ds_late_import_failure"
      const sessionID = "ses_late_import_failure"
      createStage(root, datasetId)

      recordWorkflowStageSuccess({
        sessionID,
        toolName: "data_import",
        args: { datasetId, stageId: "stage_000", action: "import" },
        metadata: { datasetId, stageId: "stage_000", action: "import" },
      })
      recordWorkflowStageSuccess({
        sessionID,
        toolName: "did_static",
        args: { datasetId, stageId: "stage_000" },
        metadata: { datasetId, stageId: "stage_000" },
      })
      const before = getActiveWorkflowRun(sessionID)
      expect(before?.datasetId).toBe(datasetId)
      expect(before?.stages.some((stage) => stage.kind === "baseline_estimate" && stage.status === "completed")).toBe(true)

      recordWorkflowStageFailure({
        sessionID,
        toolName: "data_import",
        args: { action: "import", inputPath: "another-file.xlsx" },
        reflection: {
          toolName: "data_import",
          failureType: "file_not_found",
          rootCause: "找不到输入文件",
          blocking: true,
          retryStage: "import",
          repairAction: "确认文件名后重试导入",
          userVisibleExplanation: "导入文件不存在",
          createdAt: new Date().toISOString(),
          error: "找不到输入文件",
        },
      })

      const after = getActiveWorkflowRun(sessionID)
      expect(after?.workflowRunId).toBe(before?.workflowRunId)
      expect(after?.datasetId).toBe(datasetId)
      const state = readWorkflowSession(sessionID)
      expect(state.runs.length).toBe(2)
      expect(state.runs.some((run) => run.workflowRunId !== before?.workflowRunId && run.latestFailure !== undefined)).toBe(true)
    })
  })
})
