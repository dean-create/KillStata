import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { readWorkflowSession, recordWorkflowStageSuccess, writeWorkflowSession } from "@/runtime/workflow"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"
import { WorkflowTool } from "@/tool/pipeline"

describe("workflow status model output", () => {
  test("separates the canonical dataset stage from internal workflow state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-workflow-status-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const sessionID = "session-workflow-status"
          const datasetId = "dataset-workflow-status"
          const sourcePath = path.join(root, "source.csv")
          fs.writeFileSync(sourcePath, "province,city,year\nA,X,2020\n", "utf-8")
          const manifest = createDatasetManifest({ datasetId, sourcePath, sourceFormat: "csv" })
          appendStage(manifest, {
            stageId: "stage_000",
            branch: "main",
            action: "import",
            workingPath: sourcePath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          appendStage(manifest, {
            stageId: "stage_002",
            parentStageId: "stage_001",
            branch: "robustness",
            action: "preprocess_winsorize",
            workingPath: sourcePath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          appendStage(manifest, {
            stageId: "stage_001",
            parentStageId: "stage_000",
            branch: "main",
            action: "preprocess_combine_columns",
            workingPath: sourcePath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_import",
            args: { action: "import" },
            metadata: { datasetId, stageId: "stage_000" },
          })
          recordWorkflowStageSuccess({
            sessionID,
            toolName: "data_preprocess",
            args: { datasetId, stageId: "stage_000", method: "combine_columns" },
            metadata: { datasetId, stageId: "stage_001", parentStageId: "stage_000" },
          })
          const state = readWorkflowSession(sessionID)
          const active = state.runs.find((run) => run.workflowRunId === state.activeRunId)!
          active.latestVerifier = {
            status: "warn",
            checks: [],
            blockingFindings: ["阻断".repeat(2_000)],
            repairHints: ["披露异常值警告", "修复".repeat(2_000)],
            trustedArtifacts: ["result.json"],
            createdAt: new Date().toISOString(),
          }
          writeWorkflowSession(state)

          const tool = await WorkflowTool.init()
          const result = await tool.execute({ action: "status" }, {
            sessionID,
            messageID: "message-workflow-status",
            callID: "call-workflow-status",
            agent: "analyst",
            abort: new AbortController().signal,
            metadata: async () => undefined,
            ask: async () => undefined,
          } as never)

          const output = JSON.parse(result.output)
          expect(output.canonicalDataStage).toEqual({
            datasetId,
            stageId: "stage_001",
            usage: "传给 data_import、data_preprocess 和计量估计工具",
          })
          expect(output.workflowState).toMatchObject({ activeStage: "verifier" })
          expect(output.workflowState.verifier).toEqual({
            status: "warn",
            blockingFindings: [expect.any(String)],
            repairHints: ["披露异常值警告", expect.any(String)],
            trustedArtifactCount: 1,
          })
          expect(output.workflowState.verifier.blockingFindings[0].length).toBeLessThanOrEqual(321)
          expect(result.output).not.toContain("trustedArtifacts")
          expect(result.output.length).toBeLessThan(4_000)

          const artifactState = readWorkflowSession(sessionID)
          const artifactRun = artifactState.runs.find((run) => run.workflowRunId === artifactState.activeRunId)!
          const artifactStage = artifactRun.stages.find((stage) => stage.nodeId === artifactRun.activeNodeId)!
          const coefficientPath = ".killstata/datasets/example/reports/ols/coefficients.csv"
          fs.mkdirSync(path.dirname(path.join(root, coefficientPath)), { recursive: true })
          fs.writeFileSync(path.join(root, coefficientPath), "variable,coefficient\nx,1\n", "utf-8")
          artifactStage.artifactRefs = [coefficientPath, coefficientPath]
          writeWorkflowSession(artifactState)
          const artifactsResult = await tool.execute({ action: "artifacts" }, {
            sessionID,
            messageID: "message-workflow-artifacts",
            callID: "call-workflow-artifacts",
            agent: "analyst",
            abort: new AbortController().signal,
            metadata: async () => undefined,
            ask: async () => undefined,
          } as never)
          const artifactsOutput = JSON.parse(artifactsResult.output)
          expect(artifactsOutput.artifacts).toEqual([coefficientPath])
          expect(artifactsOutput).not.toHaveProperty("workflow")
          expect(artifactsResult.output.length).toBeLessThan(4_000)
          expect(artifactsOutput.guidance).toContain("回归结果")

          const exportResult = await tool.execute({ action: "export_artifact", stageId: artifactStage.stageId, artifactPath: coefficientPath, outputPath: "回归结果.csv" }, {
            sessionID,
            messageID: "message-workflow-export-artifact",
            callID: "call-workflow-export-artifact",
            agent: "analyst",
            abort: new AbortController().signal,
            metadata: async () => undefined,
            ask: async () => undefined,
          } as never)
          expect(exportResult.output).toContain("回归结果.csv")
          expect(await Bun.file(path.join(root, "回归结果.csv")).text()).toContain("variable,coefficient")

          await expect(tool.execute({ action: "export_artifact", stageId: artifactStage.stageId, artifactPath: ".killstata/forged.csv", outputPath: "错误结果.csv" }, {
            sessionID,
            messageID: "message-workflow-export-forged",
            callID: "call-workflow-export-forged",
            agent: "analyst",
            abort: new AbortController().signal,
            metadata: async () => undefined,
            ask: async () => undefined,
          } as never)).rejects.toThrow("可信产物")

          const toolsResult = await tool.execute({ action: "tools" }, {
            sessionID,
            messageID: "message-workflow-tools",
            callID: "call-workflow-tools",
            agent: "analyst",
            extra: { inputIntent: "status" },
            abort: new AbortController().signal,
            metadata: async () => undefined,
            ask: async () => undefined,
          } as never)
          const toolsOutput = JSON.parse(toolsResult.output)
          expect(toolsOutput.directToolIDs).toBeArray()
          expect(toolsOutput.deferredToolIDs).toBeArray()
          expect(toolsOutput.deferredToolIDs).not.toContain("ols_regression")
          expect(toolsOutput.deferredToolIDs).not.toContain("panel_fe_regression")
          expect(toolsOutput.guidance).toContain("tool_search")
          expect(toolsResult.output).not.toContain("registeredToolIDs")
          expect(toolsResult.output).not.toContain("explanations")
          expect(toolsResult.output.length).toBeLessThan(4_000)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
