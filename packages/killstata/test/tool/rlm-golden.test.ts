import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { runRlmBackend } from "../../../../trash/killstata-legacy-econometrics/tool/rlm-backend"

/**
 * B 级数值对标：RLM 稳健回归。
 *
 * rlm_outliers.csv 是合成线性数据（真参数 const=2, x1=0.8, x2=0.3），
 * 含 15/300 个离群点（y 被放大 5 倍）。
 *   - OLS 在污染数据上常数项偏差（~2.34 vs 真值 2.0），说明被离群点拉偏
 *   - RLM-Huber 恢复接近真值（~2.07, x1≈0.75），且识别 ~14 个降权点
 *   - 清洁数据上 RLM 与 OLS 一致，且降权 ≈ 0
 * 这是 M-估计对离群点抑制能力的自洽验证（B 级，交叉验证三种 psi 函数）。
 */

const PYTHON = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")
const CLEAN = path.join(import.meta.dir, "..", "fixtures", "golden", "rlm_clean.csv")
const OUTLIERS = path.join(import.meta.dir, "..", "fixtures", "golden", "rlm_outliers.csv")

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-rlm-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function coef(result: Awaited<ReturnType<typeof runRlmBackend>>, term: string) {
  const found = result.coefficients?.find((c) => c.term === term)
  if (!found) throw new Error(`结果里没有系数项 ${term}`)
  return found
}

describe("RLM robust regression golden (cross-validation with outliers, B 级)", () => {
  test("rlm_huber recovers close-to-true coefficients on outlier-contaminated data", async () => {
    const result = await runRlmBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "robust_regression",
        dataPath: OUTLIERS,
        outputDir: path.join(tempDir, "huber"),
        dependentVar: "y",
        treatmentVar: "x1",
        covariates: ["x2"],
        psi: "huber",
        covariance: "robust",
      },
    })

    expect(result.success).toBe(true)
    expect(result.rowsUsed).toBe(300)
    expect(result.psi).toBe("huber")
    // RLM 应恢复接近真值（真 x1=0.8, 污染 OLS ≈0.76, RLM ≈0.75，比 OLS 更接近）
    expect(coef(result, "x1").estimate!).toBeCloseTo(0.747, 1)
    expect(coef(result, "x2").estimate!).toBeCloseTo(0.364, 1)
    // primary 锁定核心解释变量
    expect(result.primary?.term).toBe("x1")
    // 14 个离群点被降权（15 个标记但 1 个可能被容忍）
    expect(result.downWeightedCount).toBeGreaterThan(10)
    expect(result.downWeightedCount).toBeLessThanOrEqual(15)
    // scale > 0
    expect(result.scale!).toBeGreaterThan(0)
  }, 60_000)

  test("hampel and tukey psi give different down-weighting but similar coefficients", async () => {
    const hampel = await runRlmBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "robust_regression",
        dataPath: OUTLIERS,
        outputDir: path.join(tempDir, "hamp"),
        dependentVar: "y",
        treatmentVar: "x1",
        covariates: ["x2"],
        psi: "hampel",
        covariance: "robust",
      },
    })
    expect(hampel.psi).toBe("hampel")
    expect(coef(hampel, "x1").estimate!).toBeCloseTo(0.750, 1)

    const tukey = await runRlmBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "robust_regression",
        dataPath: OUTLIERS,
        outputDir: path.join(tempDir, "tuk"),
        dependentVar: "y",
        treatmentVar: "x1",
        covariates: ["x2"],
        psi: "tukey",
        covariance: "robust",
      },
    })
    expect(tukey.psi).toBe("tukey")
    expect(coef(tukey, "x1").estimate!).toBeCloseTo(0.750, 1)
  }, 60_000)

  test("on clean data, rlm is similar to OLS with zero down-weighting", async () => {
    const result = await runRlmBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "robust_regression",
        dataPath: CLEAN,
        outputDir: path.join(tempDir, "clean"),
        dependentVar: "y",
        treatmentVar: "x1",
        covariates: ["x2"],
        psi: "huber",
        covariance: "robust",
      },
    })

    expect(result.success).toBe(true)
    // 清洁数据上几乎没有降权
    expect(result.downWeightedCount).toBe(0)
    expect(result.downWeightedPct).toBe(0)
    expect(coef(result, "x1").estimate!).toBeCloseTo(0.766, 1)
  }, 60_000)

  test("fails closed when the outcome is binary (should use logit/probit)", async () => {
    const spector = path.join(import.meta.dir, "..", "fixtures", "golden", "spector.csv")
    await expect(
      runRlmBackend({
        pythonCommand: PYTHON,
        cwd: process.cwd(),
        payload: {
          method: "robust_regression",
          dataPath: spector,
          outputDir: path.join(tempDir, "bin"),
          dependentVar: "GRADE",
          treatmentVar: "PSI",
          covariates: [],
          psi: "huber",
          covariance: "robust",
        },
      }),
    ).rejects.toThrow(/二元|连续/)
  }, 30_000)
})
