import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"
import { assertDatasetStageReadyForEstimation, recordWorkflowStageSuccess } from "@/runtime/workflow"

/**
 * 血缘继承回归（2026-07-18 真实会话复现）：
 *   导入 stage_000 → profile(stage_000) → QA(stage_000) ✅
 *   → filter 去重 → 产生新 stage_001（parentStageId=stage_000）
 *   → QA(stage_001) ✅
 *   → 跑 panel_fe_regression(stage_001)
 *      ↳ 当前门禁要求"profile 与 QA 都在 stage_001 上"
 *      ↳ 但 profile 实际只在 stage_000；filter 没改 schema，
 *        父 stage 的画像方法学上仍完全适用
 *      ↳ 错误被报为"请先分析数据结构"，模型烧光 2 次修复预算
 *        才悟出要重跑画像
 *
 * 修复后：profile 沿 parentStageId 血缘回溯到最近的可用祖先；QA
 * 仍要求当前 stage（去重/筛选改变样本语义，不允许代际继承）。
 */

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-lineage-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

const csv = "y,x,t\n1,2,0\n3,4,1\n5,6,0\n7,8,1\n9,10,0\n11,12,1\n"

function makeDatasetAndStage(datasetId: string, stageId: string, parentStageId?: string) {
  const dataPath = path.join(tempDir, `${stageId}.csv`)
  fs.writeFileSync(dataPath, csv, "utf-8")
  const manifest = createDatasetManifest({
    datasetId,
    sourcePath: dataPath,
    sourceFormat: "csv",
  })
  appendStage(manifest, {
    stageId,
    branch: "main",
    action: "import",
    workingPath: dataPath,
    workingFormat: "parquet",
    parentStageId,
    createdAt: new Date().toISOString(),
  })
  return { dataPath, datasetId, stageId, parentStageId }
}

function recordProfile(sessionID: string, datasetId: string, stageId: string) {
  recordWorkflowStageSuccess({
    sessionID,
    toolName: "econometrics_recommend",
    args: { datasetId, stageId },
    metadata: { datasetId, stageId },
  })
}

function recordQA(sessionID: string, datasetId: string, stageId: string) {
  recordWorkflowStageSuccess({
    sessionID,
    toolName: "data_import",
    args: { action: "validate", datasetId, stageId },
    metadata: { action: "validate", datasetId, stageId, qaGateStatus: "pass" },
  })
}

describe("assertDatasetStageReadyForEstimation lineage inheritance", () => {
  test("profile is inherited from the parent stage when the current stage only differs by row deletion (filter/QA lineage)", async () => {
    await Instance.provide({
      directory: tempDir,
      fn: async () => {
        const sessionID = "ses_lineage_inherit"
        // stage_000：profile + QA 都在这里
        const parent = makeDatasetAndStage("ds_lineage", "stage_000")
        recordProfile(sessionID, parent.datasetId, parent.stageId)
        recordQA(sessionID, parent.datasetId, parent.stageId)
        // stage_001 是 filter 子 stage，父=stage_000。只有 QA，没有 profile。
        const child = makeDatasetAndStage("ds_lineage", "stage_001", "stage_000")
        recordQA(sessionID, child.datasetId, child.stageId)
        // 估计器要跑在 stage_001 上：profile 应通过血缘继承，QA 已在 stage_001
        const ok = assertDatasetStageReadyForEstimation({
          sessionID,
          datasetId: child.datasetId,
          stageId: child.stageId,
        })
        expect(ok.profileStage.kind).toBe("profile_or_schema_check")
        expect(ok.qaStage.kind).toBe("validate")
        expect(ok.stage.stageId).toBe("stage_001")
      },
    })
  })

  test("missing both profile and QA on a brand-new stage still fails closed", async () => {
    await Instance.provide({
      directory: tempDir,
      fn: async () => {
        const sessionID = "ses_lineage_both_missing"
        const stage = makeDatasetAndStage("ds_no_profile", "stage_000")
        expect(() =>
          assertDatasetStageReadyForEstimation({
            sessionID,
            datasetId: stage.datasetId,
            stageId: stage.stageId,
          }),
        ).toThrow(/画像|profile|数据结构/)
      },
    })
  })

  test("filter child with NO parent profile still fails (no fake inheritance from nowhere)", async () => {
    await Instance.provide({
      directory: tempDir,
      fn: async () => {
        const sessionID = "ses_lineage_no_parent_profile"
        // stage_000 完全空白（只有 import，无 profile、无 QA）
        makeDatasetAndStage("ds_naked_child", "stage_000")
        // stage_001 是子 stage，父 stage 没画像
        const child = makeDatasetAndStage("ds_naked_child", "stage_001", "stage_000")
        recordQA(sessionID, child.datasetId, child.stageId)
        expect(() =>
          assertDatasetStageReadyForEstimation({
            sessionID,
            datasetId: child.datasetId,
            stageId: child.stageId,
          }),
        ).toThrow(/画像|profile|数据结构/)
      },
    })
  })
})
