import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { Instance } from "@/project/instance"
import { appendStage, createDatasetManifest, readDatasetManifest } from "@/tool/analysis-state"
import { econometricsEngineRoot } from "@/killstata/runtime-config"
import { sessionEconometricsEngine } from "@/runtime/services/econometrics-engine-client"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import type { AnalysisToolOperationIdentity, AnalysisToolRunRecord } from "@/runtime/types"
import { CompositeEvaluationTool } from "../../src/tool/composite-evaluation"
import { recordAnalysisStageDiagnosisForTest } from "../helpers/analysis-diagnosis"

const MANAGED_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
const pythonCommand = () => process.env.KILLSTATA_PYTHON ?? (fs.existsSync(MANAGED_PYTHON) ? MANAGED_PYTHON : undefined)

function context(sessionID: string) {
  const command = pythonCommand()
  const extra = command ? { pythonCommand: command } : undefined
  return { sessionID, messageID: "msg_mcda", callID: "call_mcda", agent: "econometrics", abort: new AbortController().signal, metadata: async () => undefined, ask: async () => undefined, extra }
}

describe("composite_evaluation child-stage lineage", () => {
  test("cancelling a started model run persists unconfirmed and never publishes a child stage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-mcda-cancelled-run-"))
    const command = pythonCommand()
    if (!command) throw new Error("该生命周期回放需要显式配置 managed Python")
    const controller = new AbortController()
    let cancellationIssued = false
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const source = path.join(root, "matrix.csv")
        const rows = ["id,benefit,cost"]
        for (let index = 0; index < 12_000; index++) rows.push(`row_${index},${(index * 17) % 997 + 1},${(index * 31) % 991 + 1}`)
        fs.writeFileSync(source, `${rows.join("\n")}\n`, "utf-8")
        const datasetId = "mcda_cancelled_run"
        const sessionID = "ses_mcda_cancelled_run"
        const sourceMessageId = "message_mcda_cancelled_run"
        const taskId = "task_mcda_cancelled_run"
        const manifest = createDatasetManifest({ datasetId, sourcePath: source, sourceFormat: "csv" })
        appendStage(manifest, { stageId: "stage_000", branch: "main", action: "import", workingPath: source, workingFormat: "parquet", createdAt: new Date().toISOString() })
        recordWorkflowStageSuccess({ sessionID, toolName: "econometrics_recommend", args: { datasetId, stageId: "stage_000" }, metadata: { datasetId, stageId: "stage_000" } })
        RuntimeTaskLedger.recordQueued({
          id: taskId,
          sessionID,
          type: "prompt",
          priority: 10,
          createdAt: Date.now(),
          metadata: { messageID: sourceMessageId, requiredToolIDs: ["composite_evaluation"] },
        })
        const request = RuntimeTaskLedger.recordAnalysisRequest({
          sessionID,
          taskId,
          sourceMessageId,
          kind: "estimate",
          researchGoal: "运行综合评价并验证取消状态",
          constraints: [],
        })
        await recordAnalysisStageDiagnosisForTest({
          sessionID,
          taskId,
          datasetId,
          stageId: "stage_000",
          dataPath: source,
          dependentVar: "benefit",
          treatmentVar: "cost",
          pythonCommand: command,
          manifest,
        })
        sessionEconometricsEngine(sessionID, {
          command,
          cwd: root,
          pythonPath: path.join(econometricsEngineRoot(), "src"),
          methodRoot: path.join(econometricsEngineRoot(), "python"),
          onProgress: ({ event }) => {
            if (!cancellationIssued && event.label_zh === "正在执行 composite_evaluation") {
              cancellationIssued = true
              controller.abort()
            }
          },
        })
        const analysisContext = {
          model: {},
          sourceUserMessageId: sourceMessageId,
          pythonCommand: command,
          beginAnalysisToolRun(operation: AnalysisToolOperationIdentity) {
            RuntimeTaskLedger.transitionAnalysis({
              sessionID,
              taskId,
              event: { type: "tool_run_started", operation },
            })
            RuntimeTaskLedger.watchAnalysisToolRunAbort({
              sessionID,
              taskId,
              requestId: request.requestId,
              operationId: operation.operationId,
              signal: controller.signal,
            })
          },
          completeAnalysisToolRun(operation: AnalysisToolRunRecord) {
            RuntimeTaskLedger.transitionAnalysis({
              sessionID,
              taskId,
              event: { type: "tool_run_recorded", operation },
            })
          },
        }
        const tool = await CompositeEvaluationTool.init()
        await expect(tool.execute({
          datasetId,
          stageId: "stage_000",
          method: "entropy_weight",
          idColumns: ["id"],
          indicators: [{ column: "benefit", direction: "benefit" }, { column: "cost", direction: "cost" }],
          scope: "global",
          weightSource: "entropy",
        }, {
          sessionID,
          messageID: sourceMessageId,
          callID: "call_mcda_cancelled_run",
          agent: "analyst",
          abort: controller.signal,
          extra: analysisContext,
          ask: async () => undefined,
          metadata: async () => undefined,
        } as never)).rejects.toThrow()

        const task = RuntimeTaskLedger.listTasks(sessionID).tasks.find((item) => item.taskId === taskId)
        const updated = readDatasetManifest(datasetId)
        expect(cancellationIssued).toBe(true)
        expect(task?.analysisLifecycle?.status).toBe("unconfirmed")
        expect(task?.analysisLifecycle?.toolRuns).toMatchObject([{
          operationId: "call_mcda_cancelled_run",
          status: "unconfirmed",
          failureCode: "TOOL_ABORTED_UNCONFIRMED",
        }])
        expect(updated.stages).toHaveLength(1)
        expect(updated.artifacts).toHaveLength(0)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("分组评价只展示组内排名，不把不同组的分数混排", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-mcda-group-preview-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const source = path.join(root, "matrix.csv")
        fs.writeFileSync(source, [
          "group,id,benefit,cost",
          "east,A,1,4",
          "east,B,2,3",
          "east,C,3,2",
          "east,D,4,1",
          "west,E,4,1",
          "west,F,3,2",
          "west,G,2,3",
          "west,H,1,4",
          "",
        ].join("\n"), "utf-8")
        const datasetId = "mcda_group_preview"
        const sessionID = "ses_mcda_group_preview"
        const manifest = createDatasetManifest({ datasetId, sourcePath: source, sourceFormat: "csv" })
        appendStage(manifest, { stageId: "stage_000", branch: "main", action: "import", workingPath: source, workingFormat: "parquet", createdAt: new Date().toISOString() })
        recordWorkflowStageSuccess({ sessionID, toolName: "econometrics_recommend", args: { datasetId, stageId: "stage_000" }, metadata: { datasetId, stageId: "stage_000" } })
        await recordAnalysisStageDiagnosisForTest({ sessionID, datasetId, stageId: "stage_000", dataPath: source, dependentVar: "benefit", treatmentVar: "cost", pythonCommand: pythonCommand(), manifest })
        const tool = await CompositeEvaluationTool.init()
        const result = await tool.execute({
          datasetId,
          stageId: "stage_000",
          method: "topsis",
          idColumns: ["id"],
          indicators: [{ column: "benefit", direction: "benefit" }, { column: "cost", direction: "cost" }],
          scope: "by_group",
          groupColumns: ["group"],
          weightSource: "equal",
        }, context(sessionID) as never)

        const metadata = result.metadata as Record<string, unknown>
        const payload = metadata.result as Record<string, unknown>
        expect(result.output).toContain("各组内排名")
        expect(result.output).toContain("group=east")
        expect(result.output).toContain("group=west")
        expect(result.output).not.toContain("全局前五名")
        expect(payload.top).toEqual([])
        expect(payload.bottom).toEqual([])
        expect(Object.keys(payload.topByGroup as Record<string, unknown>)).toEqual(["group=east", "group=west"])
        const updated = readDatasetManifest(datasetId)
        const summaryPath = updated.stages[1]?.summaryPath
        expect(summaryPath).toBeDefined()
        const summary = JSON.parse(fs.readFileSync(String(summaryPath), "utf-8")) as Record<string, unknown>
        expect(Object.keys(summary.topByGroup as Record<string, unknown>)).toEqual(["group=east", "group=west"])
        expect(Object.keys(summary.groupWeights as Record<string, unknown>)).toEqual(["group=east", "group=west"])
        const artifact = updated.artifacts.find((item) => item.action === "mcda_topsis")
        expect(artifact?.metadata?.topByGroup).toEqual(summary.topByGroup)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("creates one child stage containing score and rank columns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-mcda-stage-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const source = path.join(root, "matrix.csv")
        fs.writeFileSync(source, "id,income,unemployment,education\nA,30,8,10\nB,45,6,12\nC,60,4,16\nD,75,3,18\n", "utf-8")
        const datasetId = "mcda_stage"
        const sessionID = "ses_mcda_stage"
        const manifest = createDatasetManifest({ datasetId, sourcePath: source, sourceFormat: "csv" })
        appendStage(manifest, { stageId: "stage_000", branch: "main", action: "import", workingPath: source, workingFormat: "parquet", createdAt: new Date().toISOString() })
        recordWorkflowStageSuccess({ sessionID, toolName: "econometrics_recommend", args: { datasetId, stageId: "stage_000" }, metadata: { datasetId, stageId: "stage_000" } })
        await recordAnalysisStageDiagnosisForTest({ sessionID, datasetId, stageId: "stage_000", dataPath: source, dependentVar: "income", treatmentVar: "unemployment", pythonCommand: pythonCommand(), manifest })
        const tool = await CompositeEvaluationTool.init()
        const result = await tool.execute({ datasetId, stageId: "stage_000", method: "entropy_weight", idColumns: ["id"], indicators: [{ column: "income", direction: "benefit" }, { column: "unemployment", direction: "cost" }, { column: "education", direction: "benefit" }], scope: "global" }, context(sessionID) as never)
        const updated = readDatasetManifest(datasetId)
        expect(updated.stages).toHaveLength(2)
        expect(updated.stages[1]!.parentStageId).toBe("stage_000")
        expect(fs.existsSync(updated.stages[1]!.workingPath)).toBe(true)
        const columns = JSON.parse(execFileSync(process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python"), ["-c", "import json,pandas as pd,sys; print(json.dumps(list(pd.read_parquet(sys.argv[1]).columns)))", updated.stages[1]!.workingPath], { encoding: "utf-8" })) as string[]
        expect(columns).toContain("ks_entropy_weight_score")
        expect(columns).toContain("ks_entropy_weight_rank")
        expect(result.metadata.stageId).toBe(updated.stages[1]!.stageId)
        expect(result.metadata.requiresUserDecision).toBe(true)
        expect(result.output).toContain("前五名")
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("a rejected pathological matrix leaves no half-created child stage or artifact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-mcda-stage-reject-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const source = path.join(root, "constant.csv")
        fs.writeFileSync(source, "id,income,unemployment\nA,30,1\nB,45,1\nC,60,1\n", "utf-8")
        const datasetId = "mcda_stage_reject"
        const sessionID = "ses_mcda_stage_reject"
        const manifest = createDatasetManifest({ datasetId, sourcePath: source, sourceFormat: "csv" })
        appendStage(manifest, { stageId: "stage_000", branch: "main", action: "import", workingPath: source, workingFormat: "parquet", createdAt: new Date().toISOString() })
        recordWorkflowStageSuccess({ sessionID, toolName: "econometrics_recommend", args: { datasetId, stageId: "stage_000" }, metadata: { datasetId, stageId: "stage_000" } })
        await recordAnalysisStageDiagnosisForTest({ sessionID, datasetId, stageId: "stage_000", dataPath: source, dependentVar: "income", treatmentVar: "unemployment", pythonCommand: pythonCommand(), manifest })
        const tool = await CompositeEvaluationTool.init()
        await expect(tool.execute({
          datasetId,
          stageId: "stage_000",
          method: "entropy_weight",
          idColumns: ["id"],
          indicators: [{ column: "income", direction: "benefit" }, { column: "unemployment", direction: "cost" }],
          scope: "global",
        }, context(sessionID) as never)).rejects.toThrow(/常数指标|constant/i)
        const updated = readDatasetManifest(datasetId)
        expect(updated.stages).toHaveLength(1)
        expect(updated.artifacts).toHaveLength(0)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
