import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { runCompositeEvaluationBackend, validateCompositeEvaluationBackendResponse } from "../../src/tool/composite-evaluation-backend"
import { dataFingerprintForTest } from "../helpers/analysis-diagnosis"

const PYTHON = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")

describe("composite_evaluation Python Harness contract", () => {
  test("runs entropy weighting through the managed process and preserves bounded output paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-mcda-backend-"))
    try {
      const source = path.join(root, "input.csv")
      fs.writeFileSync(source, "id,benefit,cost\nA,1,4\nB,2,3\nC,3,2\nD,4,1\n", "utf-8")
      const outputDir = path.join(root, "output")
      const result = await Instance.provide({
        directory: root,
        fn: async () => runCompositeEvaluationBackend({
          pythonCommand: PYTHON,
          cwd: root,
          sessionID: "ses_mcda_backend",
          payload: {
            datasetId: "dataset_mcda_backend",
            stageId: "stage_000",
            expectedDataFingerprint: await dataFingerprintForTest({
              sessionID: "ses_mcda_backend",
              dataPath: source,
              dependentVar: "benefit",
              treatmentVar: "cost",
              pythonCommand: PYTHON,
            }),
            method: "entropy_weight",
            dataPath: source,
            outputDir,
            idColumns: ["id"],
            indicators: [{ column: "benefit", direction: "benefit" }, { column: "cost", direction: "cost" }],
            scope: "global",
          },
        }),
      })
      expect(result.method).toBe("entropy_weight")
      expect(result.weightSource).toBe("entropy")
      expect(result.weights.reduce((sum, item) => sum + item.weight, 0)).toBeCloseTo(1, 12)
      expect(fs.existsSync(result.scoresPath)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("rejects a forged method, path escape, and non-finite score before publication", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-mcda-forged-"))
    try {
      const outputDir = path.join(root, "output")
      fs.mkdirSync(outputDir, { recursive: true })
      for (const name of ["scores.parquet", "weights.csv", "results.json"]) fs.writeFileSync(path.join(outputDir, name), "placeholder")
      const payload = {
        datasetId: "dataset_mcda_forged",
        stageId: "stage_000",
        expectedDataFingerprint: `sha256:${"a".repeat(64)}`,
        method: "topsis" as const,
        dataPath: path.join(root, "matrix.csv"),
        outputDir,
        idColumns: ["id"],
        indicators: [{ column: "income", direction: "benefit" as const }, { column: "cost", direction: "cost" as const }],
        scope: "global" as const,
      }
      const result = {
        success: true,
        protocolVersion: 1,
        method: "topsis",
        backend: "numpy-pandas",
        rowsInput: 3,
        rowsUsed: 3,
        scope: "global",
        groupCount: 1,
        weightSource: "equal",
        weights: [{ column: "income", weight: 0.5 }, { column: "cost", weight: 0.5 }],
        groupWeights: null,
        scoreColumn: "ks_topsis_score",
        rankColumn: "ks_topsis_rank",
        diagnostics: [{ scope: "global", rows: 3 }],
        top: [],
        bottom: [],
        topByGroup: null,
        warnings: [],
        scoresPath: path.join(root, "..", "escaped.parquet"),
        weightsPath: path.join(outputDir, "weights.csv"),
        resultPath: path.join(outputDir, "results.json"),
      }
      expect(() => validateCompositeEvaluationBackendResponse({ payload, stdout: JSON.stringify(result) })).toThrow(/不可信的 scoresPath/)
      expect(() => validateCompositeEvaluationBackendResponse({ payload, stdout: JSON.stringify({ ...result, scoresPath: path.join(outputDir, "scores.parquet"), method: "entropy_weight", weightSource: "entropy" }) })).toThrow(/方法与请求不一致/)
      expect(() => validateCompositeEvaluationBackendResponse({ payload, stdout: JSON.stringify({ ...result, scoresPath: path.join(outputDir, "scores.parquet"), rowsUsed: 2 }) })).toThrow(/不应静默丢弃样本/)
      expect(() => validateCompositeEvaluationBackendResponse({ payload, stdout: "{\"success\":true,\"rowsInput\":Infinity}" })).toThrow(/可解析的 JSON/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
