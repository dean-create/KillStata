import { describe, expect, test } from "bun:test"
import {
  WorkflowResultContractError,
  validateWorkflowResultContract,
} from "@/runtime/analysis-contract"
import { Instance } from "@/project/instance"
import { readWorkflowSession, recordWorkflowStageSuccess } from "@/runtime/workflow"
import fs from "fs"
import os from "os"
import path from "path"

describe("workflow result contract", () => {
  test("accepts a finite result whose lineage matches the declared stage", () => {
    const result = validateWorkflowResultContract({
      toolName: "ols_regression",
      args: { datasetId: "dataset_1", stageId: "stage_001" },
      metadata: {
        datasetId: "dataset_1",
        stageId: "stage_001",
        result: {
          success: true,
          dataset_id: "dataset_1",
          stage_id: "stage_001",
          rows_used: 120,
          coefficient: 0.42,
          result_path: ".killstata/datasets/dataset_1/reports/result.json",
        },
      },
    })

    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  test("rejects a result that reports a different dataset or stage", () => {
    const result = validateWorkflowResultContract({
      toolName: "ols_regression",
      args: { datasetId: "dataset_1", stageId: "stage_001" },
      metadata: {
        datasetId: "dataset_1",
        stageId: "stage_001",
        result: {
          success: true,
          dataset_id: "dataset_2",
          stage_id: "stage_999",
        },
      },
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "RESULT_LINEAGE_MISMATCH",
      "RESULT_LINEAGE_MISMATCH",
      "RESULT_PATH_MISSING",
    ])
  })

  test("rejects non-finite numbers and empty artifact paths", () => {
    const result = validateWorkflowResultContract({
      toolName: "ols_regression",
      args: { datasetId: "dataset_1", stageId: "stage_001" },
      metadata: {
        datasetId: "dataset_1",
        stageId: "stage_001",
        result: {
          success: true,
          coefficient: Number.NaN,
          result_path: "",
        },
      },
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "RESULT_NONFINITE",
      "RESULT_PATH_INVALID",
      "RESULT_PATH_MISSING",
    ])
  })

  test("rejects a nested failed result instead of recording it as success", () => {
    const result = validateWorkflowResultContract({
      toolName: "data_import",
      args: { action: "validate", datasetId: "dataset_1", stageId: "stage_001" },
      metadata: {
        datasetId: "dataset_1",
        stageId: "stage_001",
        result: { success: false, error: "QA failed" },
      },
    })

    expect(result.ok).toBe(false)
    expect(result.issues[0]?.code).toBe("RESULT_CONTRACT_INVALID")
  })

  test("blocks a result whose claim ceiling is blocked", () => {
    const result = validateWorkflowResultContract({
      toolName: "did_static",
      args: { datasetId: "dataset_1", stageId: "stage_001" },
      metadata: {
        datasetId: "dataset_1",
        stageId: "stage_001",
        result: {
          success: true,
          resultPath: ".killstata/results.json",
          principle_checks: {
            claim_ceiling: "blocked",
            findings: ["parallel trends failed"],
          },
        },
      },
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("CLAIM_CEILING_BLOCKED")
  })

  test("keeps legacy workflow bookkeeping calls without a nested backend result", () => {
    const result = validateWorkflowResultContract({
      toolName: "econometrics_recommend",
      args: { datasetId: "dataset_1", stageId: "stage_001" },
      metadata: { datasetId: "dataset_1", stageId: "stage_001" },
    })

    expect(result).toEqual({ ok: true, checked: false, issues: [] })
  })

  test("accepts rollback output with a newly created child stage", () => {
    const result = validateWorkflowResultContract({
      toolName: "data_import",
      args: { action: "rollback", datasetId: "dataset_1", stageId: "stage_001" },
      metadata: {
        datasetId: "dataset_1",
        stageId: "stage_002",
        result: {
          success: true,
          dataset_id: "dataset_1",
          stage_id: "stage_002",
          output_path: ".killstata/datasets/dataset_1/stages/stage_002.parquet",
        },
      },
    })

    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  test("accepts fresh import output when the model supplied stale routing hints", () => {
    const result = validateWorkflowResultContract({
      toolName: "data_import",
      args: { action: "import", inputPath: "did.xlsx", datasetId: "did_dataset", stageId: "did_stage_1" },
      metadata: {
        datasetId: "did_actual",
        stageId: "stage_000",
        result: {
          success: true,
          dataset_id: "did_actual",
          stage_id: "stage_000",
          output_path: ".killstata/datasets/did_actual/stages/stage_000.parquet",
        },
      },
    })

    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })
})

describe("workflow result contract integration", () => {
  test("does not create a completed stage for a mismatched backend result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-result-contract-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          expect(() =>
            recordWorkflowStageSuccess({
              sessionID: "ses_result_contract",
              toolName: "ols_regression",
              args: { datasetId: "dataset_1", stageId: "stage_001" },
              metadata: {
                datasetId: "dataset_1",
                stageId: "stage_001",
                result: { success: true, dataset_id: "dataset_other" },
              },
            }),
          ).toThrow(WorkflowResultContractError)

          expect(readWorkflowSession("ses_result_contract").runs).toHaveLength(0)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
