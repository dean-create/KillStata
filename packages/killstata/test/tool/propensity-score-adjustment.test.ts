import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import os from "os"
import path from "path"

type AdjustmentResult = {
  ate: number
  treated_count: number
  control_count: number
  treatment_ess: number
  control_ess: number
  min_propensity_score: number
  max_propensity_score: number
  max_weight: number
  weighted_smd: Record<string, number>
  weighted_max_abs_smd: number
}

function runAdjustment(
  functionName: "propensity_score_regression_adjustment_ate" | "propensity_score_aipw_ate",
  input: { outcome: number[]; treatment: number[]; score: number[]; covariates: Record<string, number[]> },
) {
  const python = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  const moduleDir = path.resolve(import.meta.dir, "../../../killstata-econometrics-engine/python/econometrics")
  const script = [
    "import json, sys",
    "import pandas as pd",
    "sys.path.insert(0, sys.argv[1])",
    "from econometric_algorithm import propensity_score_regression_adjustment_ate, propensity_score_aipw_ate",
    "payload = json.loads(sys.stdin.read())",
    "outcome = pd.Series(payload['outcome'], name='outcome')",
    "treatment = pd.Series(payload['treatment'], name='treated')",
    "score = pd.Series(payload['score'], name='propensity_score')",
    "result = globals()[sys.argv[2]](outcome, treatment, score, pd.DataFrame(payload['covariates']))",
    "print(json.dumps(result, sort_keys=True))",
  ].join("; ")
  return JSON.parse(
    execFileSync(python, ["-c", script, moduleDir, functionName], {
      encoding: "utf-8",
      input: JSON.stringify(input),
    }),
  ) as AdjustmentResult
}

function balancedLinearFixture(): {
  outcome: number[]
  treatment: number[]
  score: number[]
  covariates: Record<string, number[]>
} {
  const outcome: number[] = []
  const treatment: number[] = []
  const score: number[] = []
  const x: number[] = []
  for (const [value, controlCount, treatedCount] of [
    [-1, 60, 40],
    [1, 40, 60],
  ] as const) {
    // 处理概率为 0.4/0.6，原始样本数与它一致；Hájek 权重后两个组的 x 分布相同。
    for (let index = 0; index < controlCount; index += 1) {
      x.push(value)
      treatment.push(0)
      score.push(value < 0 ? 0.4 : 0.6)
      outcome.push(2 + 1.5 * value)
    }
    for (let index = 0; index < treatedCount; index += 1) {
      x.push(value)
      treatment.push(1)
      score.push(value < 0 ? 0.4 : 0.6)
      outcome.push(2 + 3 + 1.5 * value)
    }
  }
  return { outcome, treatment, score, covariates: { x } }
}

function collinearAdjustmentFixture(): {
  outcome: number[]
  treatment: number[]
  score: number[]
  covariates: Record<string, number[]>
} {
  const outcome: number[] = []
  const treatment: number[] = []
  const score: number[] = []
  const x: number[] = []
  for (const treated of [0, 1] as const) {
    for (const value of [-1, 1]) {
      for (let index = 0; index < 50; index += 1) {
        x.push(value)
        treatment.push(treated)
        // e(X) 与 T 完全共线，但它仍位于重叠区间且协变量加权平衡，
        // 因此必须由回归设计矩阵门而不是别的偶然检查拒绝。
        score.push(treated === 1 ? 0.6 : 0.4)
        outcome.push(2 + 3 * treated + 1.5 * value)
      }
    }
  }
  return { outcome, treatment, score, covariates: { x } }
}

describe("strict propensity-score outcome adjustment primitives", () => {
  test("linear propensity-score adjustment recovers a homogeneous ATE and keeps IPW diagnostics", () => {
    const result = runAdjustment("propensity_score_regression_adjustment_ate", balancedLinearFixture())

    expect(result.ate).toBeCloseTo(3, 12)
    expect(result.treated_count).toBe(100)
    expect(result.control_count).toBe(100)
    expect(result.treatment_ess).toBeGreaterThanOrEqual(20)
    expect(result.control_ess).toBeGreaterThanOrEqual(20)
    expect(result.weighted_max_abs_smd).toBeLessThanOrEqual(0.1)
  }, 30_000)

  test("AIPW recovers a homogeneous ATE with separate outcome models", () => {
    const result = runAdjustment("propensity_score_aipw_ate", balancedLinearFixture())

    expect(result.ate).toBeCloseTo(3, 12)
    expect(result.min_propensity_score).toBe(0.4)
    expect(result.max_propensity_score).toBe(0.6)
    expect(result.weighted_smd.x).toBeCloseTo(0, 12)
  }, 30_000)

  test("both adjustment estimators reject scores outside the fixed overlap interval", () => {
    const unsafe = balancedLinearFixture()
    unsafe.score[0] = 0.04

    for (const method of ["propensity_score_regression_adjustment_ate", "propensity_score_aipw_ate"] as const) {
      expect(() => runAdjustment(method, unsafe)).toThrow(/overlap failure|\[0.05, 0.95\]/i)
    }
  }, 30_000)

  test("AIPW rejects an outcome model with a rank-deficient within-group design", () => {
    const unsafe = balancedLinearFixture()
    unsafe.covariates = { constant: unsafe.outcome.map(() => 1) }

    expect(() => runAdjustment("propensity_score_aipw_ate", unsafe)).toThrow(/rank|full column rank/i)
  }, 30_000)

  test("regression adjustment rejects a collinear treatment and propensity-score design", () => {
    expect(() => runAdjustment("propensity_score_regression_adjustment_ate", collinearAdjustmentFixture())).toThrow(
      /rank|full column rank/i,
    )
  }, 30_000)
})
