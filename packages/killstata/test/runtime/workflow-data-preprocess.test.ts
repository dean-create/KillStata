import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"
import { assertDatasetStageReadyForEstimation, assertDatasetStageReadyForPreprocess, recordWorkflowStageSuccess } from "@/runtime/workflow"

function createStage(root: string, datasetId: string) {
  const sourcePath = path.join(root, `${datasetId}.csv`)
  fs.writeFileSync(sourcePath, "id,x\n1,\n2,3\n", "utf-8")
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

function recordProfile(sessionID: string, datasetId: string, stageId = "stage_000") {
  recordWorkflowStageSuccess({
    sessionID,
    toolName: "econometrics_recommend",
    args: { datasetId, stageId },
    metadata: { datasetId, stageId },
  })
}

describe("assertDatasetStageReadyForPreprocess", () => {
  test("permits a profiled stage whose QA is blocked so cleaning can repair it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-gate-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const datasetId = "ds_preprocess_validate_block"
          const sessionID = "ses_preprocess_validate_block"
          createStage(root, datasetId)
          recordProfile(sessionID, datasetId)
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_import",
            args: { action: "validate", datasetId, stageId: "stage_000" },
            metadata: { action: "validate", datasetId, stageId: "stage_000", qaGateStatus: "block" },
          })

          const ready = assertDatasetStageReadyForPreprocess({ sessionID, datasetId, stageId: "stage_000" })
          expect(ready.stage.stageId).toBe("stage_000")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("accepts the profile_or_diagnostics stage produced by data_import(profile)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-profile-diagnostics-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const datasetId = "ds_preprocess_profile_diagnostics"
          const sessionID = "ses_preprocess_profile_diagnostics"
          createStage(root, datasetId)
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_import",
            args: { action: "profile", datasetId, stageId: "stage_000" },
            metadata: { action: "profile", datasetId, stageId: "stage_000" },
          })

          const ready = assertDatasetStageReadyForPreprocess({ sessionID, datasetId, stageId: "stage_000" })
          expect(ready.stage.stageId).toBe("stage_000")
          expect(ready.profileStage.kind).toBe("profile_or_diagnostics")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects a stage that has never been profiled in this session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-gate-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const datasetId = "ds_preprocess_no_profile"
          createStage(root, datasetId)
          expect(() =>
            assertDatasetStageReadyForPreprocess({
              sessionID: "ses_preprocess_no_profile",
              datasetId,
              stageId: "stage_000",
            }),
          ).toThrow(/画像|profile|数据结构/)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("records data_preprocess as a preprocess stage instead of a report", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-gate-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const datasetId = "ds_preprocess_stage_kind"
          createStage(root, datasetId)
          const { stage } = recordWorkflowStageSuccess({
            sessionID: "ses_preprocess_stage_kind",
            toolName: "data_preprocess",
            args: { datasetId, stageId: "stage_000", method: "winsorize", columns: ["x"] },
            metadata: { datasetId, stageId: "stage_001", parentStageId: "stage_000" },
          })
          expect(stage.kind).toBe("preprocess_or_filter")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a transformed child stage cannot inherit its parent QA before estimation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-fresh-qa-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const datasetId = "ds_preprocess_fresh_qa"
          const sessionID = "ses_preprocess_fresh_qa"
          const manifest = createStage(root, datasetId)
          appendStage(manifest, {
            stageId: "stage_001",
            parentStageId: "stage_000",
            branch: "main",
            action: "preprocess_winsorize",
            workingPath: path.join(root, `${datasetId}.csv`),
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          recordProfile(sessionID, datasetId, "stage_000")
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_preprocess",
            args: { datasetId, stageId: "stage_000", method: "winsorize", columns: ["x"] },
            metadata: { datasetId, stageId: "stage_001", parentStageId: "stage_000" },
          })
          expect(() => assertDatasetStageReadyForEstimation({ sessionID, datasetId, stageId: "stage_001" })).toThrow(/当前 canonical stage 通过 数据质量检查/)

          recordProfile(sessionID, datasetId, "stage_001")
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_import",
            args: { action: "validate", datasetId, stageId: "stage_001" },
            metadata: { action: "validate", datasetId, stageId: "stage_001", qaGateStatus: "pass" },
          })
          const ready = assertDatasetStageReadyForEstimation({ sessionID, datasetId, stageId: "stage_001" })
          expect((ready.qaStage.metadata as { stageId?: string }).stageId).toBe("stage_001")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
