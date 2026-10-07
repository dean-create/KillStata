import { expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { resolveTools } from "@/session/prompt/tools"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"

test("数据预处理和综合评价从活动工作流注入权威 dataset/stage", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-runtime-lineage-"))
  try {
    await Instance.provide({
      directory,
      fn: async () => {
        const sessionID = `ses_runtime_lineage_${Date.now()}`
        const datasetId = `dataset_runtime_lineage_${Date.now()}`
        const manifest = createDatasetManifest({ datasetId, sourcePath: path.join(directory, "source.csv"), sourceFormat: "csv" })
        appendStage(manifest, {
          stageId: "stage_000",
          branch: "main",
          action: "import",
          workingPath: path.join(directory, "stage.parquet"),
          workingFormat: "parquet",
          createdAt: new Date().toISOString(),
        })
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_runtime_lineage",
          sessionID,
          workflowMode: "econometrics",
          workflowLocale: "zh-CN",
          datasetId,
          branch: "main",
          activeStage: "baseline_estimate",
          activeNodeId: "main:estimate",
          stageSequence: [],
          edges: [],
          trustedArtifacts: [],
          analysisChecklist: [],
          approvalStatus: "approved",
          stages: [
            {
              nodeId: "main:validate",
              stageId: "stage_000",
              kind: "validate",
              status: "completed",
              branch: "main",
              toolName: "data_import",
              replayInput: {},
              artifactRefs: [],
              trustedArtifacts: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              nodeId: "main:estimate",
              stageId: "stage_000",
              kind: "baseline_estimate",
              status: "running",
              branch: "main",
              toolName: "ols_regression",
              replayInput: {},
              artifactRefs: [],
              trustedArtifacts: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_runtime_lineage"
        writeWorkflowSession(state)

        const calls = new Map<string, Record<string, unknown>>()
        const resolved = await resolveTools({
          agent: await Agent.get("analyst"),
          model: await Provider.getModel("deepseek", "deepseek-v4-flash"),
          session: { id: sessionID, permission: [] } as never,
          processor: {
            message: { id: "message_runtime_lineage" },
            partFromToolCall: () => undefined,
            executeTool: async (name: string, args: unknown) => {
              calls.set(name, args as Record<string, unknown>)
              return { title: "captured", metadata: {}, output: "captured" }
            },
          } as never,
          intent: "analysis",
          userText: "检查当前数据集的质量。",
        })

        await resolved.port.execute({
          id: "preprocess-runtime-lineage",
          name: "data_preprocess",
          input: {
            datasetId: "dataset_stale",
            stageId: "stage_old",
            dataset_id: "dataset_snake_stale",
            stage_id: "stage_snake_old",
            outputPath: "/tmp/model-forged-output.parquet",
            output_path: "/tmp/model-snake-forged-output.parquet",
            data_path: "/tmp/model-forged-input.parquet",
            output_dir: "/tmp/model-forged-output",
            method: "winsorize",
            columns: ["income"],
            options: { lower: 0.01, upper: 0.01 },
          },
          abort: new AbortController().signal,
        })
        const validPreprocessCall = calls.get("data_preprocess")
        await expect(resolved.port.execute({
          id: "preprocess-unknown-field",
          name: "data_preprocess",
          input: {
            method: "winsorize",
            columns: ["income"],
            options: { lower: 0.01, upper: 0.01 },
            action: "profile",
          },
          abort: new AbortController().signal,
        })).rejects.toThrow(/Python Registry 未声明.*action/)
        expect(calls.get("data_preprocess")).toBe(validPreprocessCall)
        await resolved.port.execute({
          id: "composite-runtime-lineage",
          name: "composite_evaluation",
          input: {
            datasetId: "dataset_stale",
            stageId: "stage_old",
            dataset_id: "dataset_snake_stale",
            stage_id: "stage_snake_old",
            output_dir: "/tmp/model-forged-mcda-output",
            data_path: "/tmp/model-forged-mcda-input.parquet",
            method: "entropy_weight",
            idColumns: ["province"],
            indicators: [{ column: "green_finance", direction: "benefit" }, { column: "income", direction: "benefit" }],
            scope: "global",
            weightSource: "entropy",
          },
          abort: new AbortController().signal,
        })
        await resolved.port.execute({
          id: "data-import-runtime-lineage",
          name: "data_import",
          input: {
            action: "profile",
            datasetId: "dataset_stale",
            stageId: "stage_old",
            runId: "run_forged",
            branch: "branch_forged",
            inputPath: "/tmp/model-forged-input.xlsx",
            outputPath: "/tmp/model-forged-profile.xlsx",
            data_path: "/tmp/model-forged-data.parquet",
            output_dir: "/tmp/model-forged-output",
          },
          abort: new AbortController().signal,
        })
        expect(calls.get("data_import")).toMatchObject({ action: "profile", datasetId, stageId: "stage_000" })
        await resolved.port.execute({
          id: "data-export-runtime-lineage",
          name: "data_import",
          input: {
            action: "export",
            datasetId: "dataset_stale",
            stageId: "stage_old",
            outputPath: "/tmp/model-forged-export.csv",
            data_path: "/tmp/model-forged-data.parquet",
            output_dir: "/tmp/model-forged-output",
            format: "csv",
          },
          abort: new AbortController().signal,
        })
        expect(calls.get("data_import")).toMatchObject({ action: "export", datasetId, stageId: "stage_000" })
        expect(calls.get("data_import")).not.toHaveProperty("outputPath")
        await resolved.port.execute({
          id: "data-export-runtime-lineage",
          name: "data_import",
          input: {
            action: "export",
            datasetId: "dataset_stale",
            stageId: "stage_old",
            outputPath: "/tmp/model-forged-export.csv",
            data_path: "/tmp/model-forged-data.parquet",
            output_dir: "/tmp/model-forged-output",
            format: "csv",
          },
          abort: new AbortController().signal,
        })
        expect(calls.get("data_import")).toMatchObject({ action: "export", datasetId, stageId: "stage_000" })
        await resolved.port.execute({
          id: "heterogeneity-runtime-lineage",
          name: "heterogeneity_runner",
          input: {
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
            datasetId: "dataset_forged",
            stageId: "stage_forged",
            runId: "run_forged",
            branch: "branch_forged",
            baselineResultDir: "/tmp/model-forged-baseline",
            directResultPath: "/tmp/model-forged-result.json",
            outputDir: "/tmp/model-forged-output",
            dataPath: "/tmp/model-forged-input.parquet",
          },
          abort: new AbortController().signal,
        })
        const capturedToolCount = calls.size
        const rollback = await resolved.port.execute({
          id: "rollback-without-history",
          name: "data_import",
          input: { action: "rollback", datasetId: "dataset_forged", stageId: "stage_forged" },
          abort: new AbortController().signal,
        }) as { metadata?: { requiresUserDecision?: boolean }; output?: string }

        expect(calls.get("data_preprocess")).toMatchObject({ datasetId, stageId: "stage_000" })
        expect(calls.get("composite_evaluation")).toMatchObject({ datasetId, stageId: "stage_000" })
        expect(calls.get("data_import")).toMatchObject({ action: "export", datasetId, stageId: "stage_000" })
        for (const name of ["data_preprocess", "composite_evaluation", "data_import", "heterogeneity_runner"]) {
          expect(calls.get(name)).not.toHaveProperty("data_path")
          expect(calls.get(name)).not.toHaveProperty("dataPath")
          expect(calls.get(name)).not.toHaveProperty("output_dir")
          expect(calls.get(name)).not.toHaveProperty("outputDir")
          expect(calls.get(name)).not.toHaveProperty("dataset_id")
          expect(calls.get(name)).not.toHaveProperty("stage_id")
        }
        expect(calls.get("data_preprocess")).not.toHaveProperty("outputPath")
        expect(calls.get("data_preprocess")).not.toHaveProperty("output_path")
        expect(calls.get("data_import")).not.toHaveProperty("inputPath")
        expect(calls.get("data_import")).not.toHaveProperty("outputPath")
        expect(calls.get("heterogeneity_runner")).toMatchObject({ datasetId, stageId: "stage_000" })
        expect(calls.get("heterogeneity_runner")).not.toHaveProperty("runId")
        expect(calls.get("heterogeneity_runner")).not.toHaveProperty("branch")
        expect(calls.get("heterogeneity_runner")).not.toHaveProperty("baselineResultDir")
        expect(calls.get("heterogeneity_runner")).not.toHaveProperty("directResultPath")
        expect(rollback.metadata?.requiresUserDecision).toBe(true)
        expect(rollback.output).toContain("没有可回滚的历史数据阶段")
        expect(calls.size).toBe(capturedToolCount)
      },
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("数据导入只采用当前用户原文或附件中的路径，不采用模型伪造路径", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-user-path-injection-"))
  try {
    await Instance.provide({
      directory,
      fn: async () => {
        const sessionID = `ses_user_path_${Date.now()}`
        const captured: Record<string, unknown>[] = []
        const resolved = await resolveTools({
          agent: await Agent.get("analyst"),
          model: await Provider.getModel("deepseek", "deepseek-v4-flash"),
          session: { id: sessionID, permission: [] } as never,
          processor: {
            message: { id: "message_user_path" },
            partFromToolCall: () => undefined,
            executeTool: async (_name: string, args: unknown) => {
              captured.push(args as Record<string, unknown>)
              return { title: "captured", metadata: {}, output: "captured" }
            },
          } as never,
          intent: "analysis",
          userText: "请导入 /Users/cw/Desktop/KillStata-main/data/did.xlsx",
        })

        await resolved.port.execute({
          id: "user-path-import",
          name: "data_import",
          input: { action: "import", inputPath: "/tmp/model-forged.xlsx", outputPath: "/tmp/model-forged-output.parquet" },
          abort: new AbortController().signal,
        })

        expect(captured).toHaveLength(1)
        expect(captured[0]).toMatchObject({
          action: "import",
          inputPath: "/Users/cw/Desktop/KillStata-main/data/did.xlsx",
        })
        expect(captured[0]).not.toHaveProperty("outputPath")

        const ambiguous = await resolveTools({
          agent: await Agent.get("analyst"),
          model: await Provider.getModel("deepseek", "deepseek-v4-flash"),
          session: { id: `${sessionID}_ambiguous`, permission: [] } as never,
          processor: {
            message: { id: "message_ambiguous_export" },
            partFromToolCall: () => undefined,
            executeTool: async () => {
              throw new Error("ambiguous output paths must stop before tool execution")
            },
          } as never,
          intent: "analysis",
          userText: '请把当前结果导出到 "./result/a.csv" 或 "./result/b.csv"。',
        })
        const ambiguousResult = await ambiguous.port.execute({
          id: "ambiguous-export-path",
          name: "data_import",
          input: { action: "export", outputPath: "./result/model-guessed.csv" },
          abort: new AbortController().signal,
        }) as { output?: string; metadata?: { requiresUserDecision?: boolean; exportPathChoices?: string[] } }
        expect(ambiguousResult.metadata?.requiresUserDecision).toBe(true)
        expect(ambiguousResult.metadata?.exportPathChoices).toEqual(["./result/a.csv", "./result/b.csv"])
        expect(ambiguousResult.output).toContain("唯一导出目标")
      },
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("数据导入只采用当前用户原文或附件中的路径，不采用模型伪造路径", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-user-path-injection-"))
  try {
    await Instance.provide({
      directory,
      fn: async () => {
        const sessionID = `ses_user_path_${Date.now()}`
        const captured: Record<string, unknown>[] = []
        const resolved = await resolveTools({
          agent: await Agent.get("analyst"),
          model: await Provider.getModel("deepseek", "deepseek-v4-flash"),
          session: { id: sessionID, permission: [] } as never,
          processor: {
            message: { id: "message_user_path" },
            partFromToolCall: () => undefined,
            executeTool: async (_name: string, args: unknown) => {
              captured.push(args as Record<string, unknown>)
              return { title: "captured", metadata: {}, output: "captured" }
            },
          } as never,
          intent: "analysis",
          userText: "请导入 /Users/cw/Desktop/KillStata-main/data/did.xlsx",
        })

        await resolved.port.execute({
          id: "user-path-import",
          name: "data_import",
          input: { action: "import", inputPath: "/tmp/model-forged.xlsx", outputPath: "/tmp/model-forged-output.parquet" },
          abort: new AbortController().signal,
        })

        expect(captured).toHaveLength(1)
        expect(captured[0]).toMatchObject({
          action: "import",
          inputPath: "/Users/cw/Desktop/KillStata-main/data/did.xlsx",
        })
        expect(captured[0]).not.toHaveProperty("outputPath")
      },
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
