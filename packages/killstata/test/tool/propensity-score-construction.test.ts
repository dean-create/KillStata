import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { Instance } from "@/project/instance"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { appendStage, createDatasetManifest, readDatasetManifest } from "@/tool/analysis-state"
import { PropensityScoreConstructionTool } from "@/tool/econometrics-method-tools"
import { EconometricsTool } from "@/tool/econometrics"

async function supportsEconometricsRuntime() {
  try {
    const python = await resolveRuntimePythonCommand()
    execFileSync(python, ["-c", "import pandas; import statsmodels.api as sm"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function registerDataset(root: string, sessionID: string, rows: string[], ready: boolean) {
  const datasetId = `dataset_${sessionID}`
  const stageId = "stage_000"
  const csvPath = path.join(root, `${datasetId}.csv`)
  fs.writeFileSync(csvPath, rows.join("\n"), "utf-8")
  const manifest = createDatasetManifest({ datasetId, sourcePath: csvPath, sourceFormat: "csv" })
  appendStage(manifest, {
    stageId,
    branch: "main",
    action: "import",
    workingPath: csvPath,
    workingFormat: "parquet",
    rowCount: rows.length - 1,
    columnCount: rows[0]!.split(",").length,
    createdAt: new Date().toISOString(),
  })

  if (ready) {
    recordWorkflowStageSuccess({
      sessionID,
      toolName: "data_import",
      args: { action: "import", datasetId, stageId },
      metadata: { action: "import", datasetId, stageId },
    })
    recordWorkflowStageSuccess({
      sessionID,
      toolName: "econometrics_recommend",
      args: { datasetId, stageId },
      metadata: { datasetId, stageId },
    })
    recordWorkflowStageSuccess({
      sessionID,
      toolName: "data_import",
      args: { action: "qa", datasetId, stageId },
      metadata: { action: "qa", datasetId, stageId, qaGateStatus: "pass" },
    })
  }
  return { datasetId, stageId }
}

function context(sessionID: string) {
  return {
    sessionID,
    messageID: "message_1",
    callID: "call_1",
    agent: "econometrics",
    abort: new AbortController().signal,
    metadata: async () => undefined,
    ask: async () => undefined,
  }
}

function findFilesNamed(root: string, fileName: string): string[] {
  const matches: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) matches.push(...findFilesNamed(entryPath, fileName))
    if (entry.isFile() && entry.name === fileName) matches.push(entryPath)
  }
  return matches
}

function expectNoPublishedScores(root: string, datasetId: string) {
  expect(readDatasetManifest(datasetId).artifacts.filter((artifact) => artifact.action === "psm_construction")).toHaveLength(0)
  expect(findFilesNamed(root, "propensity_scores.csv")).toHaveLength(0)
  expect(findFilesNamed(root, "propensity_scores.csv.tmp")).toHaveLength(0)
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-psm-construction-"))
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("propensity-score construction tool", () => {
  test("rejects execution until the same canonical stage has completed profile and QA", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const sessionID = "psm_unprepared"
      const source = registerDataset(root, sessionID, ["treated,age", "0,20", "1,30", "0,40", "1,50"], false)
      const tool = await PropensityScoreConstructionTool.init()

      await expect(
        tool.execute({ ...source, treatmentVar: "treated", covariates: ["age"] }, context(sessionID) as never),
      ).rejects.toThrow(/画像.*QA|profile.*QA/i)
    })
  })

  test("rejects non-binary treatment and invalid covariates before publishing scores", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const nonBinarySession = "psm_non_binary"
      const nonBinary = registerDataset(
        root,
        nonBinarySession,
        ["treated,age", "0,20", "1,30", "2,40", "0,50", "1,60"],
        true,
      )
      const tool = await PropensityScoreConstructionTool.init()
      await expect(
        tool.execute(
          { ...nonBinary, treatmentVar: "treated", covariates: ["age"] },
          context(nonBinarySession) as never,
        ),
      ).rejects.toThrow(/0.*1|binary|二元/i)
      expectNoPublishedScores(root, nonBinary.datasetId)

      const missingSession = "psm_missing_covariate"
      const missing = registerDataset(
        root,
        missingSession,
        ["treated,age", "0,20", "1,", "0,40", "1,50", "0,60", "1,70"],
        true,
      )
      await expect(
        tool.execute({ ...missing, treatmentVar: "treated", covariates: ["age"] }, context(missingSession) as never),
      ).rejects.toThrow(/missing|缺失/i)
      expectNoPublishedScores(root, missing.datasetId)
    })
  }, 30_000)

  test("rejects invalid design matrices without publishing partial artifacts", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const cases = [
        {
          sessionID: "psm_non_numeric",
          rows: ["treated,x", "0,low", "1,mid", "0,high", "1,other"],
          covariates: ["x"],
          error: /numeric|数值/i,
        },
        {
          sessionID: "psm_one_group",
          rows: ["treated,x", "0,1", "0,2", "0,3", "0,4"],
          covariates: ["x"],
          error: /both treated and control|0.*1|两组|二元/i,
        },
        {
          sessionID: "psm_non_finite",
          rows: ["treated,x", "0,1", "1,2", "0,inf", "1,4", "0,5", "1,6"],
          covariates: ["x"],
          error: /finite|有限/i,
        },
        {
          sessionID: "psm_constant",
          rows: ["treated,x", "0,1", "1,1", "0,1", "1,1", "0,1", "1,1"],
          covariates: ["x"],
          error: /constant|vary|常数|变化/i,
        },
        {
          sessionID: "psm_rank_deficient",
          rows: ["treated,x,z", "0,1,2", "1,2,4", "0,3,6", "1,4,8", "0,5,10", "1,6,12"],
          covariates: ["x", "z"],
          error: /rank deficient|秩/i,
        },
        {
          sessionID: "psm_too_few",
          rows: ["treated,x,z", "0,1,2", "1,2,5", "0,4,9"],
          covariates: ["x", "z"],
          error: /too few observations|样本.*少/i,
        },
      ]
      const tool = await PropensityScoreConstructionTool.init()

      for (const invalidCase of cases) {
        const source = registerDataset(root, invalidCase.sessionID, invalidCase.rows, true)
        await expect(
          tool.execute(
            { ...source, treatmentVar: "treated", covariates: invalidCase.covariates },
            context(invalidCase.sessionID) as never,
          ),
        ).rejects.toThrow(invalidCase.error)
        expectNoPublishedScores(root, source.datasetId)
      }
    })
  }, 60_000)

  test("rejects non-converged fits and boundary scores at the Python backend boundary", async () => {
    if (!(await supportsEconometricsRuntime())) return
    const python = await resolveRuntimePythonCommand()
    const moduleDir = path.resolve(import.meta.dir, "../../python/econometrics")
    const errors = JSON.parse(
      execFileSync(
        python,
        [
          "-c",
          [
            "import json, sys",
            "import numpy as np",
            "import pandas as pd",
            "sys.path.insert(0, sys.argv[1])",
            "import econometric_algorithm as module",
            "treatment = pd.Series([0, 1, 0, 1, 0, 1], dtype=float)",
            "covariates = pd.DataFrame({'x': [1, 2, 3, 4, 5, 7]}, dtype=float)",
            "errors = []",
            "class FakeFit:",
            "    def __init__(self, converged, scores):",
            "        self.mle_retvals = {'converged': converged, 'iterations': 1}",
            "        self._scores = scores",
            "    def predict(self, design):",
            "        return self._scores",
            "class FakeLogit:",
            "    def __init__(self, target, design):",
            "        self.design = design",
            "    def fit(self, **kwargs):",
            "        return FakeFit(False, np.full(len(self.design), 0.5))",
            "module.sm.Logit = FakeLogit",
            "try:",
            "    module.propensity_score_construction(treatment, covariates)",
            "except Exception as exc:",
            "    errors.append(str(exc))",
            "class BoundaryLogit(FakeLogit):",
            "    def fit(self, **kwargs):",
            "        return FakeFit(True, np.array([0.0, 0.2, 0.4, 0.6, 0.8, 1.0]))",
            "module.sm.Logit = BoundaryLogit",
            "try:",
            "    module.propensity_score_construction(treatment, covariates)",
            "except Exception as exc:",
            "    errors.append(str(exc))",
            "print(json.dumps(errors))",
          ].join("\n"),
          moduleDir,
        ],
        { encoding: "utf-8" },
      ),
    ) as string[]

    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatch(/did not converge|未收敛/i)
    expect(errors[1]).toMatch(/boundary|边界/i)
  })

  test("rejects perfect separation instead of returning boundary scores", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const sessionID = "psm_separation"
      const source = registerDataset(
        root,
        sessionID,
        ["treated,separator", "0,0", "0,0.1", "0,0.2", "1,1", "1,1.1", "1,1.2"],
        true,
      )
      const tool = await PropensityScoreConstructionTool.init()

      await expect(
        tool.execute(
          { ...source, treatmentVar: "treated", covariates: ["separator"] },
          context(sessionID) as never,
        ),
      ).rejects.toThrow(/separation|分离|converg|收敛|boundary|边界/i)
      expectNoPublishedScores(root, source.datasetId)
    })
  }, 20_000)

  test("returns a bounded diagnostic summary and keeps row-level scores in an artifact", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const sessionID = "psm_success"
      const rows = ["treated,age,income"]
      for (let index = 0; index < 80; index += 1) {
        const treated = (index * 7) % 10 < 4 ? 1 : 0
        rows.push(`${treated},${20 + (index % 13)},${30 + ((index * 3) % 17)}`)
      }
      const source = registerDataset(root, sessionID, rows, true)
      const tool = await PropensityScoreConstructionTool.init()
      const result = await tool.execute(
        { ...source, treatmentVar: "treated", covariates: ["age", "income"] },
        context(sessionID) as never,
      )
      const modelResult = result.metadata.result as
        | {
            propensity_scores_path?: string
            rows_used?: number
            score_min?: number
            score_max?: number
            mean_treated?: number
            mean_control?: number
            support_lower?: number
            support_upper?: number
            share_in_support?: number
          }
        | undefined

      expect(modelResult?.rows_used).toBe(80)
      expect(modelResult?.score_min).toBeGreaterThan(0)
      expect(modelResult?.score_max).toBeLessThan(1)
      expect(modelResult?.mean_treated).toBeNumber()
      expect(modelResult?.mean_control).toBeNumber()
      expect(modelResult?.propensity_scores_path).toBeString()
      expect(modelResult).not.toHaveProperty("propensity_scores")
      const scorePath = path.join(root, modelResult!.propensity_scores_path!)
      expect(fs.existsSync(scorePath)).toBe(true)
      const scoreLines = fs.readFileSync(scorePath, "utf-8").trim().split("\n")
      expect(scoreLines[0]).toContain("propensity_score")
      expect(scoreLines).toHaveLength(81)

      // 用 SciPy 独立最大化同一 Logit 似然，不调用 statsmodels，交叉验证常数项、列顺序和逐行预测映射。
      const python = await resolveRuntimePythonCommand()
      const referenceScores = JSON.parse(
        execFileSync(
          python,
          [
            "-c",
            [
              "import json, sys",
              "import numpy as np",
              "import pandas as pd",
              "from scipy.optimize import minimize",
              "df = pd.read_csv(sys.argv[1])",
              "y = df['treated'].to_numpy(dtype=float)",
              "X = np.column_stack([np.ones(len(df)), df[['age', 'income']].to_numpy(dtype=float)])",
              "objective = lambda beta: np.logaddexp(0.0, X @ beta).sum() - y @ (X @ beta)",
              "gradient = lambda beta: X.T @ (1.0 / (1.0 + np.exp(-(X @ beta))) - y)",
              "fit = minimize(objective, np.zeros(X.shape[1]), jac=gradient, method='L-BFGS-B', options={'ftol': 1e-12, 'gtol': 1e-8, 'maxiter': 1000})",
              "assert fit.success, fit.message",
              "scores = 1.0 / (1.0 + np.exp(-(X @ fit.x)))",
              "print(json.dumps(scores.tolist()))",
            ].join("; "),
            path.join(root, `${source.datasetId}.csv`),
          ],
          { encoding: "utf-8" },
        ),
      ) as number[]
      const actualScores = scoreLines.slice(1).map((line) => Number(line.split(",").at(-1)))
      expect(actualScores).toHaveLength(referenceScores.length)
      expect(Math.max(...actualScores.map((value, index) => Math.abs(value - referenceScores[index]!)))).toBeLessThan(1e-6)
      const treatment = rows.slice(1).map((row) => Number(row.split(",")[0]))
      const treatedScores = actualScores.filter((_, index) => treatment[index] === 1)
      const controlScores = actualScores.filter((_, index) => treatment[index] === 0)
      const supportLower = Math.max(Math.min(...treatedScores), Math.min(...controlScores))
      const supportUpper = Math.min(Math.max(...treatedScores), Math.max(...controlScores))
      const shareInSupport = actualScores.filter((score) => score >= supportLower && score <= supportUpper).length / actualScores.length
      expect(modelResult?.support_lower).toBeCloseTo(supportLower, 10)
      expect(modelResult?.support_upper).toBeCloseTo(supportUpper, 10)
      expect(modelResult?.share_in_support).toBeCloseTo(shareInSupport, 10)

      expect(result.output).toContain("倾向得分诊断")
      expect(result.output).toContain("不是因果效应估计")
      expect(result.output).not.toContain("propensity_scores.csv")
      expect(result.output).not.toMatch(/\.killstata|\/Users\//)
      expect(result.output).not.toContain("### Estimates")
      expect(result.output).not.toMatch(/P-value|Coefficient|统计显著/i)
    })
  }, 30_000)

  test("legacy execution serializes propensity construction as a diagnostic", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const rows = ["treated,age,income"]
      for (let index = 0; index < 60; index += 1) {
        rows.push(`${(index * 7) % 10 < 4 ? 1 : 0},${20 + (index % 11)},${30 + ((index * 5) % 17)}`)
      }
      const dataPath = path.join(root, "legacy.csv")
      fs.writeFileSync(dataPath, rows.join("\n"), "utf-8")
      const tool = await EconometricsTool.init()
      const result = await tool.execute(
        { methodName: "psm_construction", dataPath, treatmentVar: "treated", covariates: ["age", "income"] },
        context("psm_legacy") as never,
      )

      expect(result.output).toContain("倾向得分诊断")
      expect(result.output).toContain("不是因果效应估计")
      expect(result.output).not.toContain("### Estimates")
      expect(result.output).not.toContain("Dependent variable: undefined")
      expect(result.output).not.toMatch(/P-value|Coefficient|统计显著/i)
      expect(result.metadata.groundingScope).toBe("diagnostic")
      expect(result.metadata.presentation).toBeUndefined()
      expect(result.metadata.analysisView?.conclusion).toContain("不是因果效应估计")
    })
  }, 30_000)

  test("rejects caller-owned output directories before creating a partial result bundle", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const outputDir = path.join(root, "caller-owned")
      fs.mkdirSync(outputDir)
      fs.writeFileSync(path.join(outputDir, "keep.txt"), "existing", "utf-8")
      const dataPath = path.join(root, "input.csv")
      fs.writeFileSync(
        dataPath,
        ["treated,age", "0,20", "1,30", "0,40", "1,50", "0,60", "1,70"].join("\n"),
        "utf-8",
      )
      const tool = await EconometricsTool.init()

      await expect(
        tool.execute(
          { methodName: "psm_construction", dataPath, treatmentVar: "treated", covariates: ["age"], outputDir },
          context("psm_caller_output") as never,
        ),
      ).rejects.toThrow(/outputDir|输出目录/i)
      expect(fs.readdirSync(outputDir)).toEqual(["keep.txt"])
      expect(fs.readFileSync(path.join(outputDir, "keep.txt"), "utf-8")).toBe("existing")
    })
  })
})
