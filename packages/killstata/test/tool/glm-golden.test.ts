import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { runGlmBackend } from "../fixtures/legacy/tool/glm-backend"

/**
 * A 级数值对标：Spector & Mazzeo (1980) 的 GRE 教学效果数据（statsmodels 自带、
 * Greene《Econometric Analysis》教材经典例）。Logit/Probit 在这份数据上的系数是
 * 公开文献值，每本计量教材都有——因此这是文献值对标（A 级），不是"自己对自己"。
 *
 * 公开值（Greene / statsmodels 文档）：
 *   Logit  : const≈-13.021, GPA≈2.826, TUCE≈0.095, PSI≈2.379, McFadden pseudoR²≈0.374
 *   Probit : const≈ -7.452, GPA≈1.626, TUCE≈0.052, PSI≈1.426
 */

const PYTHON = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")
const SPECTOR = path.join(import.meta.dir, "..", "fixtures", "golden", "spector.csv")

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-glm-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function coef(result: Awaited<ReturnType<typeof runGlmBackend>>, term: string) {
  const found = result.coefficients?.find((c) => c.term === term)
  if (!found) throw new Error(`结果里没有系数项 ${term}`)
  return found
}

describe("GLM golden (Spector, published literature values — A 级)", () => {
  test("logit_regression reproduces Greene's published Spector coefficients and average marginal effects", async () => {
    const result = await runGlmBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "logit_regression",
        dataPath: SPECTOR,
        outputDir: path.join(tempDir, "logit"),
        dependentVar: "GRADE",
        treatmentVar: "PSI",
        covariates: ["GPA", "TUCE"],
        covariance: "nonrobust",
      },
    })

    expect(result.success).toBe(true)
    expect(result.rowsUsed).toBe(32)
    // 文献值对标（对数几率尺度系数）
    expect(coef(result, "const").estimate!).toBeCloseTo(-13.021, 2)
    expect(coef(result, "GPA").estimate!).toBeCloseTo(2.826, 2)
    expect(coef(result, "TUCE").estimate!).toBeCloseTo(0.095, 2)
    expect(coef(result, "PSI").estimate!).toBeCloseTo(2.379, 2)
    expect(result.pseudoRSquared!).toBeCloseTo(0.374, 2)
    // primary 必须锁定核心解释变量 PSI，而不是常数或第一个协变量
    expect(result.primary?.term).toBe("PSI")
    // 平均边际效应是概率尺度、可解读的处理效应；PSI 的 AME 约 0.31
    expect(result.primaryMarginalEffect?.term).toBe("PSI")
    expect(result.primaryMarginalEffect?.estimate!).toBeCloseTo(0.305, 2)
    // 系数尺度 ≠ 边际效应尺度：AME 必须明显小于对数几率系数，否则说明把两者搞混了
    expect(Math.abs(result.primaryMarginalEffect!.estimate!)).toBeLessThan(Math.abs(result.primary!.estimate!))
  }, 60_000)

  test("probit_regression reproduces the published Spector probit coefficients", async () => {
    const result = await runGlmBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "probit_regression",
        dataPath: SPECTOR,
        outputDir: path.join(tempDir, "probit"),
        dependentVar: "GRADE",
        treatmentVar: "PSI",
        covariates: ["GPA", "TUCE"],
        covariance: "nonrobust",
      },
    })
    expect(result.success).toBe(true)
    expect(coef(result, "const").estimate!).toBeCloseTo(-7.452, 2)
    expect(coef(result, "GPA").estimate!).toBeCloseTo(1.626, 2)
    expect(coef(result, "PSI").estimate!).toBeCloseTo(1.426, 2)
  }, 60_000)

  test("fails closed when the outcome is not binary 0/1", async () => {
    await expect(
      runGlmBackend({
        pythonCommand: PYTHON,
        cwd: process.cwd(),
        payload: {
          method: "logit_regression",
          dataPath: SPECTOR,
          outputDir: path.join(tempDir, "nonbinary"),
          dependentVar: "GPA", // 连续变量当因变量
          treatmentVar: "PSI",
          covariates: [],
          covariance: "nonrobust",
        },
      }),
    ).rejects.toThrow(/二元 0\/1/)
  }, 30_000)

  test("fails closed on perfect separation instead of returning boundary probabilities", async () => {
    // 构造完全分离：结果完全由 x 的符号决定
    const sep = path.join(tempDir, "separation.csv")
    const rows = ["y,x"]
    for (let i = 0; i < 20; i += 1) rows.push(`0,${-10 + i * 0.1}`)
    for (let i = 0; i < 20; i += 1) rows.push(`1,${1 + i * 0.1}`)
    fs.writeFileSync(sep, `${rows.join("\n")}\n`, "utf-8")

    await expect(
      runGlmBackend({
        pythonCommand: PYTHON,
        cwd: process.cwd(),
        payload: {
          method: "logit_regression",
          dataPath: sep,
          outputDir: path.join(tempDir, "sep_out"),
          dependentVar: "y",
          treatmentVar: "x",
          covariates: [],
          covariance: "nonrobust",
        },
      }),
    ).rejects.toThrow(/分离|收敛|边界/)
  }, 30_000)
})
