import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import { assertDatasetStageReadyForEstimation } from "@/runtime/workflow"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"

describe("上传后的自动就绪证据", () => {
  test("导入阶段的就绪报告和非阻断自动 QA 可直接满足估计前置条件", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-auto-readiness-gate-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const sessionID = "ses_auto_readiness_gate"
        const datasetId = "dataset_auto_readiness_gate"
        const manifest = createDatasetManifest({ datasetId, sourcePath: path.join(root, "data.xlsx"), sourceFormat: "xlsx" })
        appendStage(manifest, {
          stageId: "stage_000",
          branch: "main",
          action: "import",
          workingPath: path.join(root, "data.parquet"),
          workingFormat: "parquet",
          createdAt: new Date().toISOString(),
          metadata: {
            dataReadiness: {
              version: 1,
              generatedAt: new Date().toISOString(),
              rowCount: 100,
              columnCount: 3,
              columns: [],
              panelCandidates: [],
              exactLinearDependencies: [],
              candidateMethods: [{ methodID: "ols_regression", status: "candidate", reason: "数值列", repairSuggestions: [] }],
              warnings: [],
            },
            autoQa: { status: "pass", warnings: [], blockingErrors: [] },
          },
        })
        const state = readWorkflowSession(sessionID)
        const workflowRunId = "workflow_auto_readiness_gate"
        state.runs.push({
          workflowRunId,
          sessionID,
          workflowMode: "econometrics",
          workflowLocale: "zh-CN",
          datasetId,
          runId: "run_auto_readiness_gate",
          branch: "main",
          activeStage: "baseline_estimate",
          activeNodeId: "main:estimate",
          stageSequence: [],
          edges: [],
          trustedArtifacts: [],
          analysisChecklist: [],
          approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate",
            stageId: "stage_000",
            kind: "baseline_estimate",
            status: "running",
            branch: "main",
            datasetId,
            runId: "run_auto_readiness_gate",
            toolName: "ols_regression",
            replayInput: {},
            artifactRefs: [],
            trustedArtifacts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = workflowRunId
        writeWorkflowSession(state)

        const ready = assertDatasetStageReadyForEstimation({ sessionID, datasetId, stageId: "stage_000" })
        expect(ready.profileStage.kind).toBe("profile_or_schema_check")
        expect(ready.qaStage.kind).toBe("validate")
        expect(ready.profileInherited).toBe(true)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
