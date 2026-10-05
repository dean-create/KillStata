import { describe, expect, test } from "bun:test"
import { reduceContextCapsule, renderContextCapsule, type ContextCapsuleInput } from "@/runtime/context-capsule"
import { buildContextCapsule, diagnosisForStage } from "@/runtime/context-capsule-adapter"
import type { DatasetStageRecord } from "@/runtime/dataset-state"
import { writeWorkflowSession } from "@/runtime/workflow/state"
import { Instance } from "@/project/instance"
import fs from "fs"
import os from "os"
import path from "path"

function base(): ContextCapsuleInput {
  return {
    dataset: {
      datasetId: "ds_a",
      sourceFormat: "xlsx",
      sourcePath: "/tmp/data.xlsx",
      updatedAt: "2026-08-21T00:00:00.000Z",
      panelIdentifiers: { entityVar: "province", timeVar: "year" },
    },
    workflow: {
      workflowRunId: "workflow_a",
      datasetId: "ds_a",
      runId: "run_a",
      branch: "main",
      activeStageKind: "baseline_estimate",
      activeNode: {
        nodeId: "main:stage_001",
        stageId: "stage_001",
        branch: "main",
        kind: "baseline_estimate",
        status: "completed",
        runId: "run_a",
      },
      latestVerifierStatus: "pass",
      trustedArtifacts: [".killstata/results.json"],
      checklist: ["data readiness: completed"],
    },
    datasetStage: {
      stageId: "stage_001",
      parentStageId: "stage_000",
      branch: "main",
      action: "preprocess",
      workingPath: ".killstata/stage.parquet",
      workingFormat: "parquet",
      rowCount: 800,
      columnCount: 12,
      createdAt: "2026-08-21T00:00:00.000Z",
    },
    diagnosis: {
      stageId: "stage_001",
      recommendedMethodIds: ["panel_fe_regression"],
      compatibleMethodIds: ["panel_fe_regression", "ols_regression"],
      blockingIssueCount: 0,
      warningIssueCount: 1,
    },
    attempts: [
      {
        index: 1,
        createdAt: "2026-08-21T00:00:00.000Z",
        method: "panel_fe_regression",
        stageId: "stage_001",
        rowCount: 800,
        rowsUsed: 742,
        dependentVar: "y",
        treatmentVar: "did",
        covariates: ["x2", "x1"],
        entityVar: "province",
        timeVar: "year",
        pValue: 0.2,
      },
    ],
    evidence: [
      { kind: "validate", ref: ".killstata/validate.json", datasetId: "ds_a", stageId: "stage_001", scope: "full_stage", rows: 800 },
      { kind: "numeric", ref: ".killstata/numeric_snapshot.json", datasetId: "ds_a", stageId: "stage_001", scope: "analysis_sample", rowsUsed: 742 },
    ],
    sideEffectReceipts: ["estimate:stage_001:spec_a"],
    capturedAt: "2026-08-21T00:00:00.000Z",
  }
}

describe("ContextCapsule reducer", () => {
  test("rejects diagnosis metadata from a different stage or without a content fingerprint", () => {
    const diagnosis: Record<string, unknown> = {
      version: 1,
      stage_id: "stage_999",
      data_fingerprint: `sha256:${"a".repeat(64)}`,
      issues: [],
      method_compatibility: [],
      recommended_method_ids: ["ols_regression"],
    }
    const stage = {
      stageId: "stage_001",
      metadata: { dataDiagnosis: diagnosis },
    } as unknown as DatasetStageRecord

    expect(diagnosisForStage(stage)).toBeUndefined()
    diagnosis.stage_id = "stage_001"
    delete diagnosis.data_fingerprint
    expect(diagnosisForStage(stage)).toBeUndefined()
    diagnosis.data_fingerprint = `sha256:${"a".repeat(64)}`
    expect(diagnosisForStage(stage)).toMatchObject({ stageId: "stage_001", dataFingerprint: `sha256:${"a".repeat(64)}` })
  })

  test("stale workflow dataset does not crash a compaction snapshot", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-context-stale-"))
    const sessionID = "ses_stale_dataset"
    await Instance.provide({
      directory,
      fn: () => {
        writeWorkflowSession({
          version: 1,
          sessionID,
          activeRunId: "workflow_stale",
          runs: [{
            workflowRunId: "workflow_stale",
            sessionID,
            workflowMode: "econometrics",
            workflowLocale: "zh-CN",
            datasetId: "dataset_missing",
            branch: "main",
            stageSequence: [],
            edges: [],
            stages: [],
            trustedArtifacts: [],
            analysisChecklist: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
        })

        expect(buildContextCapsule(sessionID)).toBeUndefined()
      },
    })
  })

  test("preserves stage scope separately from rows used and does not invent identification", () => {
    const capsule = reduceContextCapsule(base())
    const rendered = renderContextCapsule(capsule)
    expect(capsule.population).toMatchObject({
      datasetId: "ds_a",
      stageId: "stage_001",
      scope: "analysis_sample",
      rowCount: 800,
      rowsUsed: 742,
    })
    expect(capsule.panel).toMatchObject({ entityVar: "province", timeVar: "year", status: "declared" })
    expect(capsule.identification.status).toBe("unknown")
    expect(capsule.experiment.latestRowsUsed).toBe(742)
    expect(capsule.trustedEvidence).toHaveLength(2)
    expect(rendered).toContain("analysis_sample")
    expect(capsule.diagnosis).toMatchObject({ stageId: "stage_001", recommendedMethodIds: ["panel_fe_regression"], warningIssueCount: 1 })
    expect(rendered).toContain("上传诊断")
    expect(rendered).toContain("推荐=panel_fe_regression")
    for (const internalValue of ["ds_a", "stage_001", "stage_000", "workflow_a", "run_a", "/tmp/data.xlsx", ".killstata/"]) {
      expect(rendered).not.toContain(internalValue)
    }
  })

  test("keeps the uploaded workbook's conversation record after history compaction", () => {
    const input = base()
    input.dataset!.origin = {
      sessionID: "ses_a",
      messageID: "msg_upload",
      attachmentPartID: "prt_workbook",
      importedAt: "2026-08-22T00:00:00.000Z",
    }

    const rendered = renderContextCapsule(reduceContextCapsule(input))
    expect(rendered).toContain("来源：本会话上传的工作簿")
    expect(rendered).not.toContain("msg_upload")
    expect(rendered).not.toContain("prt_workbook")
    expect(rendered).not.toContain("manifest=")
    expect(rendered).not.toContain("ds_a")
  })

  test("reports dataset and active stage conflicts instead of silently selecting another stage", () => {
    const input = base()
    input.workflow!.datasetId = "ds_b"
    input.workflow!.activeNode!.stageId = "stage_999"
    const capsule = reduceContextCapsule(input)
    expect(capsule.conflicts).toEqual(expect.arrayContaining(["dataset_mismatch:ds_b:ds_a"]))
    expect(capsule.conflicts.some((item) => item.startsWith("stage_mismatch:"))).toBe(true)
  })

  test("does not inherit a parent stage QA when the child has no QA evidence", () => {
    const input = base()
    input.evidence = input.evidence.filter((entry) => entry.kind !== "validate")
    const capsule = reduceContextCapsule(input)
    expect(capsule.qualityGate.status).toBe("unknown")
    expect(capsule.population.stageId).toBe("stage_001")
  })

  // QA 产物存在但没有明确结论时，不能替模型断言"通过"——这是计量分析的门禁字段。
  test("does not claim a QA pass when the evidence carries no status", () => {
    const capsule = reduceContextCapsule(base())
    expect(capsule.qualityGate.status).toBe("unknown")
  })

  test("uses the explicit QA status carried by evidence", () => {
    const input = base()
    input.evidence = input.evidence.map((entry) =>
      entry.kind === "validate" ? { ...entry, qualityStatus: "block" as const } : entry,
    )
    const capsule = reduceContextCapsule(input)
    expect(capsule.qualityGate.status).toBe("block")
  })

  test("does not mix evidence from a different branch", () => {
    const input = base()
    input.evidence.push({
      kind: "validate",
      ref: ".killstata/other-branch-validate.json",
      datasetId: "ds_a",
      stageId: "stage_001",
      branch: "robustness",
      scope: "full_stage",
      rows: 999,
    })
    const capsule = reduceContextCapsule(input)
    expect(capsule.trustedEvidence.map((entry) => entry.ref)).not.toContain(".killstata/other-branch-validate.json")
  })

  test("keeps identification unknown even when an observed specification exists", () => {
    const capsule = reduceContextCapsule(base())
    expect(capsule.identification).toMatchObject({ status: "unknown", reason: "no_persisted_contract" })
    expect(capsule.identification.observedSpecifications[0]).toMatchObject({
      dependentVar: "y",
      treatmentVar: "did",
      rowsUsed: 742,
    })
  })

  test("reduction is deterministic and does not mutate the input", () => {
    const input = base()
    const before = JSON.stringify(input)
    const first = reduceContextCapsule(input)
    const second = reduceContextCapsule(input)
    expect(first).toEqual(second)
    expect(JSON.stringify(input)).toBe(before)
  })
})
