import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { Instance } from "@/project/instance"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { appendStage, createDatasetManifest, readDatasetManifest } from "@/tool/analysis-state"
import { CompositeEvaluationTool } from "@/tool/composite-evaluation"
import { recordAnalysisStageDiagnosisForTest } from "../helpers/analysis-diagnosis"

const MANAGED_PYTHON = process.platform === "win32"
    ? path.join(os.homedir(), ".killstata", "venv", "Scripts", "python.exe")
    : path.join(os.homedir(), ".killstata", "venv", "bin", "python")
const PYTHON = process.env.KILLSTATA_PYTHON ?? MANAGED_PYTHON

function engine() {
  return new EconometricsEngineClient({
    command: PYTHON,
    cwd: path.resolve(process.cwd(), "../.."),
    pythonPath: path.resolve(process.cwd(), "../killstata-econometrics-engine/src"),
  })
}

const runtime = { datasetId: "dataset_mcda_contract", stageId: "stage_000" }
const valid = {
  method: "topsis",
  idColumns: ["id"],
  indicators: [{ column: "income", direction: "benefit" }, { column: "unemployment", direction: "cost" }],
  scope: "global",
  weightSource: "manual",
  manualWeights: { income: 0.5, unemployment: 0.5 },
}

function toolContext(sessionID: string) {
  return {
    sessionID,
    messageID: "msg_composite_audit_symlink",
    callID: "call_composite_audit_symlink",
    agent: "econometrics",
    abort: new AbortController().signal,
    metadata: async () => undefined,
    ask: async () => undefined,
  }
}

describe("composite_evaluation Python Registry contract", () => {
  test("Pydantic rejects ambiguous roles, invalid weights and unsupported methods", async () => {
    const client = engine()
    try {
      await expect(client.validate("composite_evaluation", valid, { runtime })).resolves.toMatchObject({
        method_id: "composite_evaluation",
        arguments: { method: "topsis", idColumns: ["id"], weightSource: "manual" },
      })
      for (const arguments_ of [
        { ...valid, indicators: [{ column: "id", direction: "benefit" }, valid.indicators[1]] },
        { ...valid, manualWeights: { income: 0.7, unemployment: 0.2 } },
        { ...valid, scope: "by_group" },
        { ...valid, method: "critic_weight" },
        { ...valid, extraMethodField: true },
      ]) {
        await expect(client.validate("composite_evaluation", arguments_, { runtime })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
      }
    } finally {
      await client.close()
    }
  })

  test("Python Registry description distinguishes entropy scoring from entropy-weighted TOPSIS", async () => {
    const client = engine()
    try {
      const described = await client.describe("composite_evaluation")
      expect(described.description).toContain("method=topsis")
      expect(described.description).toContain("weightSource=entropy")
      expect(described.description).toContain("分组得分仅在同组内可比较")
      const schema = JSON.stringify(described.input_schema)
      expect(schema).toContain("越大越好用 benefit")
      expect(schema).toContain("global 全样本")
      expect(schema).not.toContain("datasetId")
      expect(schema).not.toContain("stageId")
    } finally {
      await client.close()
    }
  })

  test("外部 audit symlink 存在时拒绝运行并且不写外部目录", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-composite-audit-symlink-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-composite-audit-external-"))
    const datasetId = "composite_audit_symlink"
    const sessionID = "ses_composite_audit_symlink"
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const sourcePath = path.join(root, "input.csv")
        fs.writeFileSync(sourcePath, "id,income,cost\na,1,4\nb,2,3\nc,3,2\nd,4,1\n", "utf-8")
        const manifest = createDatasetManifest({ datasetId, sourcePath, sourceFormat: "csv" })
        appendStage(manifest, {
          stageId: "stage_000",
          branch: "main",
          action: "import",
          workingPath: sourcePath,
          workingFormat: "parquet",
          createdAt: new Date().toISOString(),
        })
        recordWorkflowStageSuccess({
          sessionID,
          toolName: "econometrics_recommend",
          args: { datasetId, stageId: "stage_000" },
          metadata: { datasetId, stageId: "stage_000" },
        })
        await recordAnalysisStageDiagnosisForTest({
          sessionID,
          datasetId,
          stageId: "stage_000",
          dataPath: sourcePath,
          dependentVar: "income",
          treatmentVar: "cost",
          pythonCommand: PYTHON,
          manifest,
        })
        const audit = path.join(root, ".killstata", "datasets", datasetId, "audit")
        fs.rmSync(audit, { recursive: true, force: true })
        fs.symlinkSync(external, audit, "dir")
        const tool = await CompositeEvaluationTool.init()
        await expect(tool.execute({
          ...valid,
          datasetId,
          stageId: "stage_000",
          method: "entropy_weight",
          indicators: [{ column: "income", direction: "benefit" }, { column: "cost", direction: "cost" }],
          weightSource: "entropy",
          manualWeights: undefined,
        }, toolContext(sessionID) as never)).rejects.toThrow(/受管数据目录之外|符号链接/)
        expect(readDatasetManifest(datasetId).stages).toHaveLength(1)
        expect(fs.readdirSync(external)).toEqual([])
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  }, 60_000)
})
