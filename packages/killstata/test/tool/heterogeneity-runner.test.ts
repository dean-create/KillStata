import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  HeterogeneityRunnerInputSchema,
  HeterogeneityRunnerTool,
  validateHeterogeneityRunnerOutputPaths,
} from "../../src/tool/heterogeneity-runner"
import { appendStage, createDatasetManifest, publishVisibleOutput, writeDatasetManifest } from "@/tool/analysis-state"
import { Instance } from "@/project/instance"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import type { AnalysisToolOperationIdentity, AnalysisToolRunRecord } from "@/runtime/types"
import { recordAnalysisStageDiagnosisForTest } from "../helpers/analysis-diagnosis"

let requestSequence = 0

function modelEstimateContext(sessionID: string) {
  const suffix = `${Date.now()}_${++requestSequence}`
  const taskId = `task_heterogeneity_test_${suffix}`
  const sourceUserMessageId = `message_heterogeneity_test_${suffix}`
  RuntimeTaskLedger.recordQueued({
    id: taskId,
    sessionID,
    type: "prompt",
    priority: 10,
    createdAt: Date.now(),
    metadata: { messageID: sourceUserMessageId, requiredToolIDs: ["heterogeneity_runner"] },
  })
  const analysisRequest = RuntimeTaskLedger.recordAnalysisRequest({
    sessionID,
    taskId,
    sourceMessageId: sourceUserMessageId,
    kind: "estimate",
    researchGoal: "测试异质性扩展",
    constraints: [],
  })
  return {
    model: {},
    sourceUserMessageId,
    taskId,
    beginAnalysisToolRun(operation: AnalysisToolOperationIdentity) {
      RuntimeTaskLedger.transitionAnalysis({
        sessionID,
        taskId,
        event: { type: "tool_run_started", operation },
      })
    },
    completeAnalysisToolRun(operation: AnalysisToolRunRecord) {
      RuntimeTaskLedger.transitionAnalysis({
        sessionID,
        taskId,
        event: { type: "tool_run_recorded", operation },
      })
    },
    requestId: analysisRequest.requestId,
  }
}

function seedActiveWorkflowStage(sessionID: string, datasetId: string, stageId: string, branch = "main") {
  const now = new Date().toISOString()
  const state = readWorkflowSession(sessionID)
  const workflowRunId = `workflow_${sessionID}`
  const run = {
    workflowRunId,
    sessionID,
    workflowMode: "econometrics",
    workflowLocale: "zh-CN",
    datasetId,
    branch,
    activeStage: "validate",
    activeNodeId: `${branch}:validate`,
    stageSequence: [],
    edges: [],
    trustedArtifacts: [],
    analysisChecklist: [],
    stages: [{
      nodeId: `${branch}:validate`,
      stageId,
      kind: "validate",
      status: "completed",
      branch,
      toolName: "data_import",
      replayInput: {},
      artifactRefs: [],
      trustedArtifacts: [],
      createdAt: now,
      updatedAt: now,
    }],
    createdAt: now,
    updatedAt: now,
  } as never
  const existing = state.runs.findIndex((item) => item.workflowRunId === workflowRunId)
  if (existing >= 0) state.runs[existing] = run
  else state.runs.push(run)
  state.activeRunId = workflowRunId
  writeWorkflowSession(state)
}

describe("tool.heterogeneity_runner", () => {
  test("Python 规格目录和所有结果文件必须精确位于本轮 outputDir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-output-contract-"))
    const outputDir = path.join(root, "output")
    const foreignDir = path.join(root, "foreign", "specs", "alternative_001")
    try {
      fs.mkdirSync(outputDir, { recursive: true })
      const canonicalOutputDir = fs.realpathSync(outputDir)
      expect(() => validateHeterogeneityRunnerOutputPaths({
        success: true,
        output_dir: outputDir,
        specs: [{
          spec_id: "heter_unknown_status",
          spec_type: "heterogeneity",
          status: "completed",
          changed_specification: "unknown output status",
          diagnostic_flags: [],
        }],
      } as never, outputDir)).toThrow("规格状态无效")
      fs.mkdirSync(path.join(canonicalOutputDir, "specs", "alternative_001"), { recursive: true })
      fs.mkdirSync(foreignDir, { recursive: true })
      const filenames = {
        result_path: "results.json",
        diagnostics_path: "diagnostics.json",
        metadata_path: "model_metadata.json",
        coefficients_path: "coefficient_table.csv",
        narrative_path: "narrative.md",
      } as const
      for (const name of Object.values(filenames)) fs.writeFileSync(path.join(foreignDir, name), "foreign")
      for (const name of Object.values(filenames)) fs.writeFileSync(path.join(outputDir, "specs", "alternative_001", name), "expected")

      const foreignSpec = {
        spec_id: "alternative_001",
        spec_type: "alternative_spec" as const,
        status: "success" as const,
        result_dir: foreignDir,
        ...Object.fromEntries(Object.entries(filenames).map(([field, name]) => [field, path.join(foreignDir, name)])),
        changed_specification: "alternative",
        diagnostic_flags: [],
      }
      expect(() => validateHeterogeneityRunnerOutputPaths({
        success: true,
        output_dir: outputDir,
        specs: [foreignSpec],
      } as never, outputDir)).toThrow(/预定规格产物不一致/)

      const validSpec = {
        ...foreignSpec,
        result_dir: path.join(canonicalOutputDir, "specs", "alternative_001"),
        ...Object.fromEntries(Object.entries(filenames).map(([field, name]) => [field, path.join(canonicalOutputDir, "specs", "alternative_001", name)])),
      }
      expect(validateHeterogeneityRunnerOutputPaths({
        success: true,
        output_dir: outputDir,
        specs: [validSpec],
      } as never, outputDir).specs[0]?.result_dir).toBe(fs.realpathSync(validSpec.result_dir))

      expect(() => validateHeterogeneityRunnerOutputPaths({
        success: true,
        output_dir: outputDir,
        specs: [{ ...validSpec, spec_id: "../../escape" }],
      } as never, outputDir)).toThrow(/规格标识无效/)

      const specsRoot = path.join(canonicalOutputDir, "specs")
      const aliasTargetDir = path.join(specsRoot, "heter_split_001_high")
      const aliasDir = path.join(specsRoot, "heter_split_001_low")
      fs.mkdirSync(aliasTargetDir, { recursive: true })
      for (const name of Object.values(filenames)) fs.writeFileSync(path.join(aliasTargetDir, name), "target")
      fs.symlinkSync(aliasTargetDir, aliasDir, "dir")
      const aliasSpec = {
        ...validSpec,
        spec_id: "heter_split_001_low",
        result_dir: aliasDir,
        ...Object.fromEntries(Object.entries(filenames).map(([field, name]) => [field, path.join(aliasDir, name)])),
      }
      expect(() => validateHeterogeneityRunnerOutputPaths({
        success: true,
        output_dir: outputDir,
        specs: [aliasSpec],
      } as never, outputDir)).toThrow(/不能包含符号链接/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("Python 执行期间 outputDir 被替换为外部 symlink 时失败关闭", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-output-race-"))
    const outputDir = path.join(root, "output")
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-output-race-external-"))
    try {
      fs.mkdirSync(outputDir, { recursive: true })
      const expectedCanonicalOutputDir = fs.realpathSync(outputDir)
      fs.rmSync(outputDir, { recursive: true, force: true })
      fs.symlinkSync(external, outputDir, "dir")
      expect(() => validateHeterogeneityRunnerOutputPaths({
        success: true,
        output_dir: outputDir,
        specs: [],
      }, outputDir, expectedCanonicalOutputDir)).toThrow(/输出目录与 Harness 预定目录不一致/)
      expect(fs.readdirSync(external)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })

  test("rejects model-supplied baseline filesystem paths even if the tool is called outside ToolPort", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const tool = await HeterogeneityRunnerTool.init()
        await expect(tool.execute({
          datasetId: "dataset_current",
          stageId: "stage_000",
          methodFamily: "fe",
          dependentVar: "y",
          treatmentVar: "x",
          baselineResultDir: "/tmp/forged-baseline",
          directResultPath: "/tmp/forged-baseline/results.json",
        }, {
          sessionID: "ses_heterogeneity_path_guard",
          messageID: "msg_heterogeneity_path_guard",
          callID: "call_heterogeneity_path_guard",
          agent: "analyst",
          abort: new AbortController().signal,
          extra: modelEstimateContext("ses_heterogeneity_path_guard"),
          ask: async () => undefined,
          metadata: async () => undefined,
        } as never)).rejects.toThrow("模型不能指定基准结果文件路径")
      },
    })
  })

  test("direct-call without current dataset lineage cannot bypass baseline specification checks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-direct-lineage-"))
    const previousPython = process.env.KILLSTATA_PYTHON
    if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const dataPath = path.join(root, "panel.csv")
          fs.writeFileSync(dataPath, "entity,year,y,x\nA,1,1,0\n", "utf-8")
          const baselinePath = path.join(root, "unverified-did-results.json")
          fs.writeFileSync(baselinePath, JSON.stringify({
            success: true,
            qa_status: "pass",
            blocking_errors: [],
            source_path: dataPath,
            stage_id: "stage_000",
            method: "did2s",
          }), "utf-8")

          await expect((await HeterogeneityRunnerTool.init()).execute({
            directResultPath: baselinePath,
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
            covariates: [],
            heterogeneityVars: [],
          }, {
            sessionID: "ses_heterogeneity_direct_lineage",
            messageID: "msg_heterogeneity_direct_lineage",
            callID: "call_heterogeneity_direct_lineage",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: {},
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)).rejects.toThrow("必须关联当前 Harness 数据集和阶段")
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("direct-call cannot select an older stage than the session's current data stage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-stale-stage-"))
    const previousPython = process.env.KILLSTATA_PYTHON
    if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const stageZeroPath = path.join(root, "stage-zero.csv")
          const stageOnePath = path.join(root, "stage-one.csv")
          fs.writeFileSync(stageZeroPath, "entity,year,y,x\nA,1,1,0\n", "utf-8")
          fs.writeFileSync(stageOnePath, "entity,year,y,x\nA,1,2,1\n", "utf-8")
          const datasetId = `dataset_heterogeneity_stale_${Date.now()}`
          const manifest = createDatasetManifest({ datasetId, sourcePath: stageZeroPath, sourceFormat: "csv" })
          appendStage(manifest, {
            stageId: "stage_000",
            runId: "run_heterogeneity_stale",
            branch: "main",
            action: "import",
            workingPath: stageZeroPath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          appendStage(manifest, {
            stageId: "stage_001",
            runId: "run_heterogeneity_stale",
            parentStageId: "stage_000",
            branch: "main",
            action: "filter",
            workingPath: stageOnePath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          const baselinePath = path.join(root, "stage-zero-results.json")
          fs.writeFileSync(baselinePath, JSON.stringify({
            success: true,
            qa_status: "pass",
            blocking_errors: [],
            source_path: stageZeroPath,
            output_path: baselinePath,
            dataset_id: datasetId,
            stage_id: "stage_000",
            method: "panel_fe_regression",
          }), "utf-8")
          publishVisibleOutput({
            manifest,
            key: "panel_fe_regression_result",
            label: "stage 000 FE baseline",
            sourcePath: baselinePath,
            runId: "run_heterogeneity_stale",
            branch: "econometrics/panel_fe_regression",
            stageId: "stage_000",
            metadata: {
              methodSpecification: {
                methodID: "panel_fe_regression",
                arguments: {
                  dependentVar: "y",
                  treatmentVar: "x",
                  covariates: [],
                  entityVar: "entity",
                  timeVar: "year",
                  covariance: "robust",
                },
              },
            },
          })
          const sessionID = "ses_heterogeneity_stale_stage"
          seedActiveWorkflowStage(sessionID, datasetId, "stage_001")

          await expect((await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "panel_fe_regression_result",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
            entityVar: "entity",
            timeVar: "year",
            covariates: [],
            heterogeneityVars: [],
          }, {
            sessionID,
            messageID: "msg_heterogeneity_stale_stage",
            callID: "call_heterogeneity_stale_stage",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: {},
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)).rejects.toThrow("当前会话的规范化数据阶段")
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("the session stage changing during Python execution prevents result publication", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-stage-race-"))
    const previousPython = process.env.KILLSTATA_PYTHON
    if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const stageZeroPath = path.join(root, "stage-zero.csv")
          const stageOnePath = path.join(root, "stage-one.csv")
          const rows: string[] = []
          for (let entityIndex = 0; entityIndex < 6; entityIndex++) {
            for (let yearIndex = 0; yearIndex < 10; yearIndex++) {
              const x = Number((entityIndex + yearIndex) % 3 === 0)
              const group = entityIndex < 3 ? "north" : "south"
              const y = entityIndex * 0.25 + yearIndex * 0.1 + x * (0.6 + entityIndex * 0.03)
              rows.push(`unit-${entityIndex},${2000 + yearIndex},${group},${x},${y}`)
            }
          }
          const csv = `entity,year,region,x,y\n${rows.join("\n")}\n`
          fs.writeFileSync(stageZeroPath, csv, "utf-8")
          fs.writeFileSync(stageOnePath, csv.replaceAll(",north,", ",north-updated,"), "utf-8")
          const datasetId = `dataset_heterogeneity_stage_race_${Date.now()}`
          const manifest = createDatasetManifest({ datasetId, sourcePath: stageZeroPath, sourceFormat: "csv" })
          for (const [stageId, filePath, action, parentStageId] of [
            ["stage_000", stageZeroPath, "import", undefined],
            ["stage_001", stageOnePath, "filter", "stage_000"],
          ] as const) {
            appendStage(manifest, {
              stageId,
              runId: "run_heterogeneity_stage_race",
              parentStageId,
              branch: "main",
              action,
              workingPath: filePath,
              workingFormat: "parquet",
              createdAt: new Date().toISOString(),
            })
          }
          const sessionID = "ses_heterogeneity_stage_race"
          seedActiveWorkflowStage(sessionID, datasetId, "stage_000")
          const baselinePath = path.join(root, "stage-zero-results.json")
          fs.writeFileSync(baselinePath, JSON.stringify({
            success: true,
            qa_status: "pass",
            blocking_errors: [],
            source_path: stageZeroPath,
            output_path: baselinePath,
            dataset_id: datasetId,
            stage_id: "stage_000",
            method: "panel_fe_regression",
          }), "utf-8")
          publishVisibleOutput({
            manifest,
            key: "panel_fe_regression_result",
            label: "Panel FE baseline",
            sourcePath: baselinePath,
            runId: "run_heterogeneity_stage_race",
            branch: "econometrics/panel_fe_regression",
            stageId: "stage_000",
            metadata: {
              methodSpecification: {
                methodID: "panel_fe_regression",
                arguments: {
                  dependentVar: "y",
                  treatmentVar: "x",
                  covariates: [],
                  entityVar: "entity",
                  timeVar: "year",
                  covariance: "robust",
                },
              },
            },
          })

          const analysisContext = modelEstimateContext(sessionID)
          await recordAnalysisStageDiagnosisForTest({
            sessionID,
            datasetId,
            stageId: "stage_000",
            dataPath: stageZeroPath,
            dependentVar: "y",
            treatmentVar: "x",
            manifest,
            taskId: analysisContext.taskId,
          })

          const execution = (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "panel_fe_regression_result",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
            entityVar: "entity",
            timeVar: "year",
            covariates: [],
            heterogeneityVars: ["region"],
          }, {
            sessionID,
            messageID: "msg_heterogeneity_stage_race",
            callID: "call_heterogeneity_stage_race",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: analysisContext,
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)
          await new Promise((resolve) => setTimeout(resolve, 10))
          seedActiveWorkflowStage(sessionID, datasetId, "stage_001")
          await expect(execution).rejects.toThrow("执行期间当前会话的规范化数据阶段")
          expect(manifest.finalOutputs.some((item) => item.key === "heterogeneity_summary_json")).toBe(false)
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("多个当前 stage 基准结果必须交回用户选择，不由模型自行挑选", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-baseline-choice-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-forged-result-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const dataPath = path.join(root, "panel.csv")
          fs.writeFileSync(dataPath, "entity,year,y,x\nA,1,1,2\n", "utf-8")
          const datasetId = `dataset_heterogeneity_choice_${Date.now()}`
          const manifest = createDatasetManifest({ datasetId, sourcePath: dataPath, sourceFormat: "csv" })
          appendStage(manifest, {
            stageId: "stage_000",
            runId: "run_heterogeneity_choice",
            branch: "main",
            action: "import",
            workingPath: dataPath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          seedActiveWorkflowStage("ses_heterogeneity_baseline_choice", datasetId, "stage_000")
          for (const [methodID, baselineRunId, label] of [
            ["panel_fe_regression", "run_heterogeneity_choice", "面板固定效应"],
            ["hdfe_regression", "run_heterogeneity_choice", "高维固定效应"],
            ["panel_fe_regression", "run_heterogeneity_choice_other", "面板固定效应另一轮"],
            ["did_static", "run_heterogeneity_choice_did_static", "传统双重差分"],
            ["did2s", "run_heterogeneity_choice_did2s", "两阶段 DID"],
            ["did_event_study_saturated", "run_heterogeneity_choice_event_study", "饱和事件研究"],
          ] as const) {
            const resultPath = path.join(root, `${methodID}-${baselineRunId}.json`)
            const methodArguments = methodID === "hdfe_regression"
              ? { dependentVar: "y", treatmentVar: "x", covariates: [], fixedEffects: ["entity", "year"], clusterVars: ["entity"], covariance: "CRV1" }
              : { dependentVar: "y", treatmentVar: "x", covariates: [], entityVar: "entity", timeVar: "year", clusterVar: "entity", covariance: "clustered" }
            fs.writeFileSync(resultPath, JSON.stringify({
              success: true,
              qa_status: "pass",
              blocking_errors: [],
              source_path: dataPath,
              output_path: resultPath,
              dataset_id: datasetId,
              stage_id: "stage_000",
              method: methodID,
            }), "utf-8")
            publishVisibleOutput({
              manifest,
              key: `${methodID}_result`,
              label,
              sourcePath: resultPath,
              runId: baselineRunId,
              branch: "main",
              stageId: "stage_000",
              metadata: { methodSpecification: { methodID, arguments: methodArguments } },
            })
          }

          const result = await (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
          }, {
            sessionID: "ses_heterogeneity_baseline_choice",
            messageID: "msg_heterogeneity_baseline_choice",
            callID: "call_heterogeneity_baseline_choice",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)

          expect(result.metadata.requiresUserDecision).toBe(true)
          expect(result.metadata.baselineOutputChoices).toEqual([
            "panel_fe_regression_result@run_heterogeneity_choice#1",
            "hdfe_regression_result",
            "panel_fe_regression_result@run_heterogeneity_choice_other#3",
          ])
          expect(result.output).toContain("不能替你选择分析对象")

          const ambiguousKey = await (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "panel_fe_regression_result",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
          }, {
            sessionID: "ses_heterogeneity_baseline_choice",
            messageID: "msg_heterogeneity_baseline_choice",
            callID: "call_heterogeneity_baseline_key",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)
          expect(ambiguousKey.metadata.requiresUserDecision).toBe(true)
          expect(ambiguousKey.output).toContain("不是当前数据阶段中唯一有效的基准结果标识")

          const mismatchedSpec = await (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "panel_fe_regression_result@run_heterogeneity_choice#1",
            methodFamily: "fe",
            dependentVar: "different_outcome",
            treatmentVar: "x",
            entityVar: "entity",
            timeVar: "year",
            clusterVar: "entity",
            covariates: [],
          }, {
            sessionID: "ses_heterogeneity_baseline_choice",
            messageID: "msg_heterogeneity_baseline_choice",
            callID: "call_heterogeneity_mismatched_spec",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)
          expect(mismatchedSpec.metadata.requiresUserDecision).toBe(true)
          expect(mismatchedSpec.output).toContain("different_outcome")
          expect(mismatchedSpec.output).toContain("基准")

          const mismatchedFields: Array<[string, unknown, string]> = [
            ["treatmentVar", "different_treatment", "核心解释变量"],
            ["covariates", ["different_control"], "控制变量"],
            ["entityVar", "different_entity", "实体固定效应"],
            ["timeVar", "different_time", "时间固定效应"],
            ["clusterVar", "different_cluster", "聚类变量"],
          ]
          for (const [field, value, label] of mismatchedFields) {
            const mismatch = await (await HeterogeneityRunnerTool.init()).execute({
              datasetId,
              stageId: "stage_000",
              baselineOutputKey: "panel_fe_regression_result@run_heterogeneity_choice#1",
              methodFamily: "fe",
              dependentVar: "y",
              treatmentVar: "x",
              entityVar: "entity",
              timeVar: "year",
              clusterVar: "entity",
              covariates: [],
              [field]: value,
            }, {
              sessionID: "ses_heterogeneity_baseline_choice",
              messageID: "msg_heterogeneity_baseline_choice",
              callID: `call_heterogeneity_mismatch_${field}`,
              agent: "analyst",
              abort: new AbortController().signal,
              extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
              ask: async () => undefined,
              metadata: async () => undefined,
            } as never)
            expect(mismatch.metadata.requiresUserDecision).toBe(true)
            expect(mismatch.output).toContain(label)
          }

          const hdfeOutput = manifest.finalOutputs.find((item) => item.key === "hdfe_regression_result")!
          hdfeOutput.stageId = "stage_previous"
          writeDatasetManifest(manifest)
          const wrongStage = await (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "hdfe_regression_result",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
          }, {
            sessionID: "ses_heterogeneity_baseline_choice",
            messageID: "msg_heterogeneity_baseline_choice",
            callID: "call_heterogeneity_wrong_stage",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)
          expect(wrongStage.metadata.requiresUserDecision).toBe(true)
          expect(wrongStage.metadata.baselineOutputChoices).not.toContain("hdfe_regression_result")

          hdfeOutput.stageId = "stage_000"
          // 计量结果的 delivery branch 是工具/方法命名空间，不是数据 stage.branch。
          hdfeOutput.branch = "econometrics/hdfe_regression"
          writeDatasetManifest(manifest)
          const methodBranchOutput = await (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
          }, {
            sessionID: "ses_heterogeneity_baseline_choice",
            messageID: "msg_heterogeneity_baseline_choice",
            callID: "call_heterogeneity_wrong_branch",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)
          expect(methodBranchOutput.metadata.requiresUserDecision).toBe(true)
          expect(methodBranchOutput.metadata.baselineOutputChoices).toContain("hdfe_regression_result")

          const didBaselines = [
            ["did_static_result", "传统双重差分"],
            ["did2s_result", "DID2S"],
            ["did_event_study_saturated_result", "饱和事件研究"],
          ] as const
          for (const [baselineOutputKey, methodName] of didBaselines) {
            const outputKeysBeforeUnsupportedDid = manifest.finalOutputs.map((item) => item.key)
            const unsupportedDid = await (await HeterogeneityRunnerTool.init()).execute({
              datasetId,
              stageId: "stage_000",
              baselineOutputKey,
              methodFamily: "did",
              dependentVar: "y",
              treatmentVar: "x",
              entityVar: "entity",
              timeVar: "year",
              covariates: [],
            }, {
              sessionID: "ses_heterogeneity_baseline_choice",
              messageID: "msg_heterogeneity_baseline_choice",
              callID: `call_heterogeneity_unsupported_${baselineOutputKey}`,
              agent: "analyst",
              abort: new AbortController().signal,
              extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
              ask: async () => undefined,
              metadata: async () => undefined,
            } as never)
            expect(unsupportedDid.metadata.requiresUserDecision).toBe(true)
            expect(unsupportedDid.output).toContain(methodName)
            expect(unsupportedDid.output).toContain("LSDV")
            expect(manifest.finalOutputs.map((item) => item.key)).toEqual(outputKeysBeforeUnsupportedDid)
          }

          const hdfeMethodSpecification = hdfeOutput.metadata!.methodSpecification as {
            arguments: Record<string, unknown>
          }
          hdfeMethodSpecification.arguments.covariance = "HC1"
          writeDatasetManifest(manifest)
          const incompatibleHdfeCovariance = await (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "hdfe_regression_result",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
            entityVar: "entity",
            timeVar: "year",
            clusterVar: "entity",
            covariates: [],
          }, {
            sessionID: "ses_heterogeneity_baseline_choice",
            messageID: "msg_heterogeneity_baseline_choice",
            callID: "call_heterogeneity_hdfe_hc1_cluster",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)
          expect(incompatibleHdfeCovariance.metadata.requiresUserDecision).toBe(true)
          expect(incompatibleHdfeCovariance.output).toContain("协方差/聚类口径")
          hdfeMethodSpecification.arguments.covariance = "CRV1"
          writeDatasetManifest(manifest)

          hdfeOutput.branch = "main"
          writeDatasetManifest(manifest)

          const forgedPath = path.join(external, "results.json")
          fs.writeFileSync(forgedPath, JSON.stringify({
            success: true,
            qa_status: "pass",
            blocking_errors: [],
            source_path: dataPath,
            output_path: forgedPath,
            dataset_id: datasetId,
            stage_id: "stage_000",
            method: "panel_fe_regression",
          }), "utf-8")
          const selectedManifestOutput = manifest.finalOutputs.find((item) =>
            item.key === "panel_fe_regression_result" && item.runId === "run_heterogeneity_choice",
          )!
          selectedManifestOutput.path = forgedPath
          writeDatasetManifest(manifest)

          await expect((await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "panel_fe_regression_result@run_heterogeneity_choice#1",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
          }, {
            sessionID: "ses_heterogeneity_baseline_choice",
            messageID: "msg_heterogeneity_baseline_choice",
            callID: "call_heterogeneity_external_result",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)).rejects.toThrow("不在 KillStata 受管产物目录")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })

  test("placebo schema no longer declares the unexecuted policyTimes field", () => {
    const parsed = HeterogeneityRunnerInputSchema.safeParse({
      methodFamily: "did",
      dependentVar: "y",
      treatmentVar: "d",
      placebo: { variables: ["placebo_var"] },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.placebo).toEqual({ variables: ["placebo_var"] })
    }
  })

  test("source no longer contains the v1 policyTimes placeholder warning", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "heterogeneity-runner.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")
    expect(source).not.toContain("policyTimes")
  })

  test("source delegates calculation to the managed Python engine", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "heterogeneity-runner.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")
    expect(source).not.toContain("buildPythonScript")
    expect(source).not.toContain("runInlinePython")
    expect(source).toContain("runEngineMethodBackend")
  })

  test("routes a real extension calculation through the Python engine and preserves artifacts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-engine-"))
    const previousPython = process.env.KILLSTATA_PYTHON
    if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const dataPath = path.join(root, "panel.csv")
          const rows = [
            ...Array.from({ length: 20 }, (_, index) => `A,${2000 + (index % 10)},${index + 1},${index + 2},0`),
            ...Array.from({ length: 20 }, (_, index) => `B,${2000 + (index % 10)},${index + 3},${index + 4},1`),
          ]
          fs.writeFileSync(dataPath, `entity,year,y,x,group\n${rows.join("\n")}\n`, "utf-8")
          const datasetId = `dataset_heterogeneity_engine_${Date.now()}`
          const baselinePath = path.join(root, "baseline-results.json")
          fs.writeFileSync(baselinePath, JSON.stringify({
            success: true,
            qa_status: "pass",
            blocking_errors: [],
            source_path: dataPath,
            output_path: baselinePath,
            dataset_id: datasetId,
            stage_id: "stage_000",
            method: "panel_fe_regression",
          }), "utf-8")
          const manifest = createDatasetManifest({ datasetId, sourcePath: dataPath, sourceFormat: "csv" })
          appendStage(manifest, {
            stageId: "stage_000",
            runId: "run_heterogeneity_engine",
            branch: "main",
            action: "import",
            workingPath: dataPath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          seedActiveWorkflowStage("ses_heterogeneity_engine", datasetId, "stage_000")
          publishVisibleOutput({
            manifest,
            key: "panel_fe_regression_result",
            label: "基准估计结果",
            sourcePath: baselinePath,
            runId: "run_heterogeneity_engine",
            branch: "main",
            stageId: "stage_000",
            metadata: {
              methodSpecification: {
                methodID: "panel_fe_regression",
                arguments: {
                  dependentVar: "y",
                  treatmentVar: "x",
                  covariates: [],
                  entityVar: "entity",
                  timeVar: "year",
                  covariance: "robust",
                },
              },
            },
          })
          const tool = await HeterogeneityRunnerTool.init()
          const analysisContext = modelEstimateContext("ses_heterogeneity_engine")
          await recordAnalysisStageDiagnosisForTest({
            sessionID: "ses_heterogeneity_engine",
            datasetId,
            stageId: "stage_000",
            dataPath,
            dependentVar: "y",
            treatmentVar: "x",
            manifest,
            taskId: analysisContext.taskId,
          })
          const extra = analysisContext
          const arguments_ = {
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "panel_fe_regression_result",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
            entityVar: "entity",
            timeVar: "year",
            covariates: [],
            heterogeneityVars: ["group"],
            mechanismVars: [],
            alternativeSpecifications: [],
          }
          const context = {
            sessionID: "ses_heterogeneity_engine",
            messageID: "msg_heterogeneity_engine",
            callID: "call_heterogeneity_engine",
            agent: "analyst",
            abort: new AbortController().signal,
            extra,
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never
          const result = await tool.execute(arguments_, context)

          expect(result.output).toContain("异质性分析完成")
          expect(result.metadata.analysisView).toBeDefined()
          expect(result.metadata.combinedBundlePath).toBeDefined()
          expect(result.metadata.visibleOutputs).toHaveLength(6)
          expect((result.metadata.visibleOutputs as Array<{ label: string }>).some((item) => item.label === "combined_publication_bundle_json")).toBe(true)
          const bundlePath = path.join(root, result.metadata.outputDir as string, "combined_publication_bundle.json")
          expect(fs.existsSync(bundlePath)).toBe(true)
          const task = RuntimeTaskLedger.listTasks("ses_heterogeneity_engine").tasks.find((item) =>
            item.analysisRequest?.sourceMessageId === extra.sourceUserMessageId,
          )
          const toolRuns = (task?.analysisLifecycle as unknown as { toolRuns?: Array<Record<string, unknown>> })?.toolRuns ?? []
          expect(toolRuns).toContainEqual(expect.objectContaining({
            requestId: task?.analysisRequest?.requestId,
            toolID: "heterogeneity_runner",
            stageId: "stage_000",
            status: "completed",
            resultContractStatus: "pass",
          }))
          expect(toolRuns[0]?.subResults).toEqual(expect.arrayContaining([
            expect.objectContaining({ specType: "heterogeneity", status: "success" }),
          ]))

          const outputDir = path.dirname(bundlePath)
          const summaryPath = path.join(outputDir, "heterogeneity_summary.json")
          const externalSummary = path.join(root, "outside-summary.json")
          fs.writeFileSync(externalSummary, "keep external summary", "utf-8")
          fs.unlinkSync(summaryPath)
          fs.symlinkSync(externalSummary, summaryPath)
          const rerunAnalysisContext = modelEstimateContext("ses_heterogeneity_engine")
          await recordAnalysisStageDiagnosisForTest({
            sessionID: "ses_heterogeneity_engine",
            datasetId,
            stageId: "stage_000",
            dataPath,
            dependentVar: "y",
            treatmentVar: "x",
            manifest,
            taskId: rerunAnalysisContext.taskId,
          })
          const rerunError = await tool.execute(arguments_, {
            sessionID: "ses_heterogeneity_engine",
            messageID: "msg_heterogeneity_engine",
            callID: "call_heterogeneity_engine_rerun",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: rerunAnalysisContext,
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never).then(() => undefined, (error) => error)
          expect(rerunError).toBeInstanceOf(Error)
          expect((rerunError as Error).message).toContain("符号链接")
          expect(fs.readFileSync(externalSummary, "utf-8")).toBe("keep external summary")
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("当前 stage 存在多个 FE 基准结果时停止自动选择并交还用户", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-baseline-choice-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const dataPath = path.join(root, "panel.csv")
          fs.writeFileSync(dataPath, "entity,year,y,x\nA,1,1,2\n", "utf-8")
          const datasetId = `dataset_heterogeneity_choice_${Date.now()}`
          const manifest = createDatasetManifest({ datasetId, sourcePath: dataPath, sourceFormat: "csv" })
          appendStage(manifest, {
            stageId: "stage_000",
            runId: "run_heterogeneity_choice",
            branch: "main",
            action: "import",
            workingPath: dataPath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          seedActiveWorkflowStage("ses_heterogeneity_baseline_choice", datasetId, "stage_000")
          for (const methodID of ["panel_fe_regression", "hdfe_regression"]) {
            const resultPath = path.join(root, `${methodID}.json`)
            fs.writeFileSync(resultPath, JSON.stringify({
              success: true,
              qa_status: "pass",
              blocking_errors: [],
              source_path: dataPath,
              output_path: resultPath,
              dataset_id: datasetId,
              stage_id: "stage_000",
              method: methodID,
            }), "utf-8")
            publishVisibleOutput({
              manifest,
              key: `${methodID}_result`,
              label: methodID,
              sourcePath: resultPath,
              runId: "run_heterogeneity_choice",
              branch: "main",
              stageId: "stage_000",
            })
          }

          const result = await (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
          }, {
            sessionID: "ses_heterogeneity_baseline_choice",
            messageID: "msg_heterogeneity_baseline_choice",
            callID: "call_heterogeneity_baseline_choice",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)

          expect(result.metadata.requiresUserDecision).toBe(true)
          expect(result.metadata.baselineOutputChoices).toEqual([
            "panel_fe_regression_result",
            "hdfe_regression_result",
          ])
          expect(result.output).toContain("不能替你选择分析对象")

          const legacyBaseline = await (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "panel_fe_regression_result",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
            entityVar: "entity",
            timeVar: "year",
            clusterVar: "entity",
            covariates: [],
          }, {
            sessionID: "ses_heterogeneity_baseline_choice",
            messageID: "msg_heterogeneity_baseline_choice",
            callID: "call_heterogeneity_legacy_baseline",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: modelEstimateContext("ses_heterogeneity_baseline_choice"),
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)
          expect(legacyBaseline.metadata.requiresUserDecision).toBe(true)
          expect(legacyBaseline.output).toContain("缺少 Harness 保存的原始方法规格")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("permits an exactly mapped HDFE CRV1 baseline to run through the FE/LSDV extension", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-hdfe-baseline-"))
    const previousPython = process.env.KILLSTATA_PYTHON
    if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const dataPath = path.join(root, "panel.csv")
          const rows: string[] = []
          for (let entityIndex = 0; entityIndex < 6; entityIndex++) {
            for (let yearIndex = 0; yearIndex < 10; yearIndex++) {
              const x = Number((entityIndex + yearIndex) % 3 === 0)
              const group = entityIndex < 3 ? "north" : "south"
              const y = entityIndex * 0.25 + yearIndex * 0.1 + x * (0.6 + entityIndex * 0.03)
              rows.push(`unit-${entityIndex},${2000 + yearIndex},${group},${x},${y}`)
            }
          }
          fs.writeFileSync(dataPath, `entity,year,region,x,y\n${rows.join("\n")}\n`, "utf-8")
          const datasetId = `dataset_heterogeneity_hdfe_${Date.now()}`
          const sessionID = "ses_heterogeneity_hdfe_baseline"
          const manifest = createDatasetManifest({ datasetId, sourcePath: dataPath, sourceFormat: "csv" })
          appendStage(manifest, {
            stageId: "stage_000",
            runId: "run_heterogeneity_hdfe_baseline",
            branch: "main",
            action: "import",
            workingPath: dataPath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          seedActiveWorkflowStage(sessionID, datasetId, "stage_000")
          const baselinePath = path.join(root, "hdfe-results.json")
          fs.writeFileSync(baselinePath, JSON.stringify({
            success: true,
            qa_status: "pass",
            blocking_errors: [],
            source_path: dataPath,
            output_path: baselinePath,
            dataset_id: datasetId,
            stage_id: "stage_000",
            method: "hdfe_regression",
          }), "utf-8")
          publishVisibleOutput({
            manifest,
            key: "hdfe_regression_result",
            label: "HDFE baseline",
            sourcePath: baselinePath,
            runId: "run_heterogeneity_hdfe_baseline",
            branch: "econometrics/hdfe_regression",
            stageId: "stage_000",
            metadata: {
              methodSpecification: {
                methodID: "hdfe_regression",
                arguments: {
                  dependentVar: "y",
                  treatmentVar: "x",
                  covariates: [],
                  fixedEffects: ["entity", "year"],
                  clusterVars: ["entity"],
                  covariance: "CRV1",
                },
              },
            },
          })

          const analysisContext = modelEstimateContext(sessionID)
          await recordAnalysisStageDiagnosisForTest({
            sessionID,
            datasetId,
            stageId: "stage_000",
            dataPath,
            dependentVar: "y",
            treatmentVar: "x",
            manifest,
            taskId: analysisContext.taskId,
          })

          const result = await (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "hdfe_regression_result",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
            entityVar: "entity",
            timeVar: "year",
            clusterVar: "entity",
            covariates: [],
            heterogeneityVars: ["region"],
          }, {
            sessionID,
            messageID: "msg_heterogeneity_hdfe_baseline",
            callID: "call_heterogeneity_hdfe_baseline",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: analysisContext,
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)

          expect(result.output).toContain("异质性分析完成")
          const analysisView = result.metadata.analysisView as { results?: Array<{ label?: string; value?: unknown }> }
          expect(Number(analysisView.results?.find((item) => item.label === "成功规格")?.value)).toBeGreaterThan(0)
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("子组聚类数不足时将明确失败原因回传给模型和用户", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-subgroup-cluster-"))
    const previousPython = process.env.KILLSTATA_PYTHON
    if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const dataPath = path.join(root, "panel.csv")
          const rows = []
          for (const region of ["north", "south"]) {
            for (let entityIndex = 0; entityIndex < 3; entityIndex++) {
              for (let yearIndex = 0; yearIndex < 10; yearIndex++) {
                const treatment = Number((entityIndex + yearIndex) % 3 === 0)
                const outcome = entityIndex * 0.4 + yearIndex * 0.2 + treatment * (0.8 + entityIndex * 0.1)
                rows.push(`${region}-${entityIndex},${2000 + yearIndex},${region},${treatment},${outcome}`)
              }
            }
          }
          fs.writeFileSync(dataPath, `entity,year,region,x,y\n${rows.join("\n")}\n`, "utf-8")
          const datasetId = `dataset_heterogeneity_single_cluster_${Date.now()}`
          const manifest = createDatasetManifest({ datasetId, sourcePath: dataPath, sourceFormat: "csv" })
          appendStage(manifest, {
            stageId: "stage_000",
            runId: "run_heterogeneity_single_cluster",
            branch: "main",
            action: "import",
            workingPath: dataPath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          seedActiveWorkflowStage("ses_heterogeneity_single_cluster", datasetId, "stage_000")
          const baselinePath = path.join(root, "baseline-results.json")
          fs.writeFileSync(baselinePath, JSON.stringify({
            success: true,
            qa_status: "pass",
            blocking_errors: [],
            source_path: dataPath,
            output_path: baselinePath,
            dataset_id: datasetId,
            stage_id: "stage_000",
            method: "panel_fe_regression",
          }), "utf-8")
          publishVisibleOutput({
            manifest,
            key: "panel_fe_regression_result",
            label: "Panel FE baseline",
            sourcePath: baselinePath,
            runId: "run_heterogeneity_single_cluster",
            branch: "econometrics/panel_fe_regression",
            stageId: "stage_000",
            metadata: {
              methodSpecification: {
                methodID: "panel_fe_regression",
                arguments: {
                  dependentVar: "y",
                  treatmentVar: "x",
                  covariates: [],
                  entityVar: "entity",
                  timeVar: "year",
                  clusterVar: "region",
                  covariance: "clustered",
                },
              },
            },
          })

          const analysisContext = modelEstimateContext("ses_heterogeneity_single_cluster")
          await recordAnalysisStageDiagnosisForTest({
            sessionID: "ses_heterogeneity_single_cluster",
            datasetId,
            stageId: "stage_000",
            dataPath,
            dependentVar: "y",
            treatmentVar: "x",
            manifest,
            taskId: analysisContext.taskId,
          })

          const result = await (await HeterogeneityRunnerTool.init()).execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "panel_fe_regression_result",
            methodFamily: "fe",
            dependentVar: "y",
            treatmentVar: "x",
            entityVar: "entity",
            timeVar: "year",
            clusterVar: "region",
            covariates: [],
            heterogeneityVars: ["region"],
          }, {
            sessionID: "ses_heterogeneity_single_cluster",
            messageID: "msg_heterogeneity_single_cluster",
            callID: "call_heterogeneity_single_cluster",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: analysisContext,
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)

          expect(result.title).toBe("异质性分析部分完成")
          expect(result.output).toContain("只剩一个聚类")
          const analysisView = result.metadata.analysisView as { warnings?: string[] }
          expect(analysisView.warnings?.some((warning) => warning.includes("只剩一个聚类"))).toBe(true)
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test.skipIf(!hasLocalRealData("did.xlsx", "gf.xlsx"))("runs heterogeneity specs on real did.xlsx and gf.xlsx through the Registry engine", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-real-data-"))
    const previousPython = process.env.KILLSTATA_PYTHON
    if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const cases = [
            { file: "did.xlsx", dependentVar: "经济发展水平", treatmentVar: "did", heterogeneityVar: "人口规模", timeVar: "year" },
            { file: "gf.xlsx", dependentVar: "绿色金融指数", treatmentVar: "绿色信贷", heterogeneityVar: "绿色投资", timeVar: "年份" },
          ]
          for (const item of cases) {
            const dataPath = path.join(root, item.file)
            fs.copyFileSync(localRealDataPath(item.file), dataPath)
            const datasetId = `dataset_heterogeneity_real_${item.file.replace(/\W/g, "_")}`
            const manifest = createDatasetManifest({ datasetId, sourcePath: dataPath, sourceFormat: "xlsx" })
            appendStage(manifest, {
              stageId: "stage_000",
              runId: `run_heterogeneity_real_${item.file}`,
              branch: "main",
              action: "import",
              workingPath: dataPath,
              workingFormat: "parquet",
              createdAt: new Date().toISOString(),
            })
            seedActiveWorkflowStage(`ses_heterogeneity_${item.file}`, datasetId, "stage_000")
            const baselineDir = path.join(root, `baseline-${item.file}`)
            fs.mkdirSync(baselineDir, { recursive: true })
            const baselinePath = path.join(baselineDir, "results.json")
            fs.writeFileSync(baselinePath, JSON.stringify({
              success: true,
              qa_status: "pass",
              blocking_errors: [],
              source_path: dataPath,
              output_path: baselinePath,
              dataset_id: datasetId,
              stage_id: "stage_000",
              method: "panel_fe_regression",
            }), "utf-8")
            publishVisibleOutput({
              manifest,
              key: "panel_fe_regression_result",
              label: "Panel FE baseline",
              sourcePath: baselinePath,
              runId: `run_heterogeneity_real_${item.file}`,
              branch: "econometrics/panel_fe_regression",
              stageId: "stage_000",
              metadata: {
                methodSpecification: {
                  methodID: "panel_fe_regression",
                  arguments: {
                    dependentVar: item.dependentVar,
                    treatmentVar: item.treatmentVar,
                    covariates: [],
                    entityVar: "地区",
                    timeVar: item.timeVar,
                    covariance: "robust",
                  },
                },
              },
            })

            const sessionID = `ses_heterogeneity_${item.file}`
            const analysisContext = modelEstimateContext(sessionID)
            await recordAnalysisStageDiagnosisForTest({
              sessionID,
              datasetId,
              stageId: "stage_000",
              dataPath,
              dependentVar: item.dependentVar,
              treatmentVar: item.treatmentVar,
              manifest,
              taskId: analysisContext.taskId,
            })

            const result = await (await HeterogeneityRunnerTool.init()).execute({
              datasetId,
              stageId: "stage_000",
              baselineOutputKey: "panel_fe_regression_result",
              methodFamily: "fe",
              dependentVar: item.dependentVar,
              treatmentVar: item.treatmentVar,
              entityVar: "地区",
              timeVar: item.timeVar,
              covariates: [],
              heterogeneityVars: [item.heterogeneityVar],
              mechanismVars: [],
              alternativeSpecifications: [],
            }, {
              sessionID: `ses_heterogeneity_${item.file}`,
              messageID: "msg_heterogeneity_real",
              callID: `call_heterogeneity_${item.file}`,
              agent: "analyst",
              abort: new AbortController().signal,
              extra: analysisContext,
              ask: async () => undefined,
              metadata: async () => undefined,
            } as never)

            expect(result.output).toContain("异质性分析完成")
            const analysisView = result.metadata.analysisView as { results?: Array<{ label?: string; value?: unknown }> }
            expect(analysisView).toBeDefined()
            expect(Number(analysisView.results?.find((item) => item.label === "成功规格")?.value)).toBeGreaterThan(0)
            const outputDir = result.metadata.outputDir as string
            expect(outputDir).toBeTruthy()
            const bundlePath = path.isAbsolute(outputDir)
              ? path.join(outputDir, "combined_publication_bundle.json")
              : path.join(root, outputDir, "combined_publication_bundle.json")
            const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf-8")) as { specs?: Array<{ status?: string; result_path?: string }> }
            const successfulSpec = bundle.specs?.find((spec) => spec.status === "success")
            expect(successfulSpec).toBeDefined()
            expect(successfulSpec?.result_path).toBeTruthy()
          }
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("test_datasets.xlsx"))("rejects test_datasets.xlsx extension analysis when the baseline key is still blocked", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-heterogeneity-test-datasets-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const dataPath = path.join(root, "test_datasets.xlsx")
          fs.copyFileSync(localRealDataPath("test_datasets.xlsx"), dataPath)
          const datasetId = `dataset_heterogeneity_blocked_${Date.now()}`
          const manifest = createDatasetManifest({ datasetId, sourcePath: dataPath, sourceFormat: "xlsx" })
          appendStage(manifest, {
            stageId: "stage_000",
            runId: "run_heterogeneity_blocked",
            branch: "main",
            action: "import",
            workingPath: dataPath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
          })
          seedActiveWorkflowStage("ses_heterogeneity_test_datasets", datasetId, "stage_000")
          const baselineDir = path.join(root, "baseline")
          fs.mkdirSync(baselineDir, { recursive: true })
          const baselinePath = path.join(baselineDir, "results.json")
          fs.writeFileSync(baselinePath, JSON.stringify({
            success: false,
            qa_status: "fail",
            blocking_errors: ["地区×年份存在115个重复键，基准面板结果未生成"],
            source_path: dataPath,
            output_path: baselinePath,
            dataset_id: datasetId,
            stage_id: "stage_000",
            method: "panel_fe_regression",
          }), "utf-8")
          publishVisibleOutput({
            manifest,
            key: "panel_fe_regression_result",
            label: "被阻断的 FE baseline",
            sourcePath: baselinePath,
            runId: "run_heterogeneity_blocked",
            branch: "econometrics/panel_fe_regression",
            stageId: "stage_000",
            metadata: {
              methodSpecification: {
                methodID: "panel_fe_regression",
                arguments: {
                  dependentVar: "数字普惠金融指数",
                  treatmentVar: "每百人互联网用户数",
                  covariates: [],
                  entityVar: "地区",
                  timeVar: "年份",
                  covariance: "robust",
                },
              },
            },
          })

          const tool = await HeterogeneityRunnerTool.init()
          await expect(tool.execute({
            datasetId,
            stageId: "stage_000",
            baselineOutputKey: "panel_fe_regression_result",
            methodFamily: "fe",
            dependentVar: "数字普惠金融指数",
            treatmentVar: "每百人互联网用户数",
            entityVar: "地区",
            timeVar: "年份",
            covariates: [],
            heterogeneityVars: ["人均电信业务总量"],
            mechanismVars: [],
            alternativeSpecifications: [],
          }, {
            sessionID: "ses_heterogeneity_test_datasets",
            messageID: "msg_heterogeneity_test_datasets",
            callID: "call_heterogeneity_test_datasets",
            agent: "analyst",
            abort: new AbortController().signal,
            extra: modelEstimateContext("ses_heterogeneity_test_datasets"),
            ask: async () => undefined,
            metadata: async () => undefined,
          } as never)).rejects.toThrow("基准结果存在阻断性数据质量问题")
          expect(fs.existsSync(path.join(root, "analysis"))).toBe(false)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
