import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { recordWorkflowStageSuccess, recordWorkflowStageFailure, getActiveWorkflowRun } from "@/runtime/workflow"

/**
 * 2026-08-28 did.xlsx 真实会话：run 里 `stage_000__profile_or_schema_check` = blocked、
 * `stage_001__preprocess_or_filter` = failed，即使随后的 validate 成功，checklist 的
 * data_readiness 仍永久 blocked——它扫描全历史，没有「已被后续成功阶段取代」的概念。
 *
 * 后果：模型每轮都被告知数据未就绪，反复重跑 profile/validate 也翻不了案。
 * 正确语义：同一 kind 上更晚的成功应当取代更早的失败；只有仍未被修好的失败才算阻断。
 */
function checklistStatus(sessionID: string, id: string) {
  return getActiveWorkflowRun(sessionID)?.analysisChecklist.find((item) => item.id === id)?.status
}

describe("data_readiness 的历史失败恢复", () => {
  test("同一阶段稍后成功后，data_readiness 不再永久 blocked", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-readiness-recovery-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = "ses_readiness_recovery"
          const datasetId = "recovery_dataset"

          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_import",
            args: { datasetId, stageId: "stage_000", action: "import" },
            metadata: { datasetId, stageId: "stage_000", action: "import" },
          })

          // 画像一度被判阻断（真实会话里就是这样）
          recordWorkflowStageFailure({
            sessionID,
            toolName: "data_import",
            args: { datasetId, stageId: "stage_000", action: "profile" },
            reflection: {
              toolName: "data_import",
              failureType: "validate_blocked",
              rootCause: "重复键",
              blocking: true,
              retryStage: "validate",
              repairAction: "先修复重复键",
              userVisibleExplanation: "数据质量检查阻断",
              createdAt: new Date().toISOString(),
              error: "duplicate entity-time",
            },
          })
          expect(checklistStatus(sessionID, "data_readiness"), "失败当下应为 blocked").toBe("blocked")

          // 用户按建议修好后，同一阶段重新成功
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_import",
            args: { datasetId, stageId: "stage_000", action: "profile" },
            metadata: { datasetId, stageId: "stage_000", action: "profile" },
          })

          expect(
            checklistStatus(sessionID, "data_readiness"),
            "同一阶段已重新成功，不应再被历史失败永久钉住",
          ).not.toBe("blocked")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
