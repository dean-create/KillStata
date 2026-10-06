import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { runQuantileBackend } from "../fixtures/legacy/tool/quantile-backend"

/**
 * B 级数值对标（独立实现）：分位数回归。
 *
 * quantile 没有跨库同款可对（pyfixest/linearmodels/scipy 都不做分位数回归），所以
 * 下面钉死的期望系数不是"自己对自己"——它们由一条**完全独立的线性规划（LP）求解器**
 * 交叉验证过：把分位数回归写成
 *   min_β  Σ ρ_τ(y - Xβ),  ρ_τ(u) = u·(τ - 1{u<0})
 * 的 LP（min tau·Σu⁺ + (1-tau)·Σu⁻ s.t. Xβ + u⁺ - u⁻ = y），用 scipy.optimize.linprog
 * (method="highs") 求解，与 statsmodels QuantReg 的迭代重加权最小二乘是两条独立代码路径，
 * 在 quantile_sim.csv 上三个分位点全部吻合到 ~1e-6。因此是独立实现对标（B 级）。
 *
 * 复现 LP oracle（另一半）：
 *   from scipy.optimize import linprog; c=[0]*2k+[tau]*n+[1-tau]*n; A_eq=[X,-X,I,-I]; b_eq=y
 *
 * LP 交叉验证过的期望值（quantile_sim.csv，异方差 DGP，treat 效应随分位点上升）：
 *   tau=0.25: Intercept=1.15438, treat=0.91109, x=0.76296
 *   tau=0.50: Intercept=1.88185, treat=1.06163, x=0.71902
 *   tau=0.75: Intercept=2.72560, treat=1.52680, x=0.55048
 */

const PYTHON = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")
const QUANTILE_SIM = path.join(import.meta.dir, "..", "fixtures", "golden", "quantile_sim.csv")

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-quantile-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function coefAt(result: Awaited<ReturnType<typeof runQuantileBackend>>, tau: number, term: string) {
  const fit = result.fits?.find((f) => f.tau === tau)
  if (!fit) throw new Error(`结果里没有分位点 ${tau}`)
  const found = fit.coefficients.find((c) => c.term === term)
  if (!found) throw new Error(`分位点 ${tau} 里没有系数项 ${term}`)
  return found
}

describe("quantile-regression golden (independent LP cross-check, B 级)", () => {
  test("quantile_regression matches the independent LP solver across quantiles", async () => {
    const result = await runQuantileBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "quantile_regression",
        dataPath: QUANTILE_SIM,
        outputDir: path.join(tempDir, "qr"),
        dependentVar: "y",
        treatmentVar: "treat",
        covariates: ["x"],
        quantiles: [0.25, 0.5, 0.75],
        covariance: "robust",
      },
    })

    expect(result.success).toBe(true)
    expect(result.rowsUsed).toBe(400)
    expect(result.fits?.length).toBe(3)

    // 独立 LP 交叉验证的系数（三个分位点）
    expect(coefAt(result, 0.25, "const").estimate!).toBeCloseTo(1.15438, 2)
    expect(coefAt(result, 0.25, "treat").estimate!).toBeCloseTo(0.91109, 2)
    expect(coefAt(result, 0.25, "x").estimate!).toBeCloseTo(0.76296, 2)
    expect(coefAt(result, 0.5, "const").estimate!).toBeCloseTo(1.88185, 2)
    expect(coefAt(result, 0.5, "treat").estimate!).toBeCloseTo(1.06163, 2)
    expect(coefAt(result, 0.75, "treat").estimate!).toBeCloseTo(1.5268, 2)

    // 主报告分位点是最接近中位数的 0.5
    expect(result.primaryTau).toBe(0.5)
    expect(result.primary?.term).toBe("treat")
    expect(result.primary?.estimate!).toBeCloseTo(1.06163, 2)

    // 分布异质性：treat 效应随分位点单调上升（这正是 OLS 均值效应看不见的）
    const path25 = result.treatmentPath?.find((p) => p.tau === 0.25)!.estimate!
    const path50 = result.treatmentPath?.find((p) => p.tau === 0.5)!.estimate!
    const path75 = result.treatmentPath?.find((p) => p.tau === 0.75)!.estimate!
    expect(path25).toBeLessThan(path50)
    expect(path50).toBeLessThan(path75)
    // 异质性告警应当触发
    expect((result.warnings ?? []).some((w) => w.includes("分布异质性"))).toBe(true)
  }, 60_000)

  test("single median quantile behaves like LAD (tau=0.5) and reports one fit", async () => {
    const result = await runQuantileBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "quantile_regression",
        dataPath: QUANTILE_SIM,
        outputDir: path.join(tempDir, "median"),
        dependentVar: "y",
        treatmentVar: "treat",
        covariates: ["x"],
        quantiles: [0.5],
        covariance: "robust",
      },
    })
    expect(result.success).toBe(true)
    expect(result.fits?.length).toBe(1)
    expect(result.primaryTau).toBe(0.5)
    expect(coefAt(result, 0.5, "treat").estimate!).toBeCloseTo(1.06163, 2)
  }, 60_000)

  test("fails closed when the outcome has almost no variation", async () => {
    // treat 是 0/1（只有 2 个不同取值 < 5）——分位数回归无法稳定估计，应 fail-closed
    await expect(
      runQuantileBackend({
        pythonCommand: PYTHON,
        cwd: process.cwd(),
        payload: {
          method: "quantile_regression",
          dataPath: QUANTILE_SIM,
          outputDir: path.join(tempDir, "novar"),
          dependentVar: "treat",
          treatmentVar: "x",
          covariates: [],
          quantiles: [0.5],
          covariance: "robust",
        },
      }),
    ).rejects.toThrow(/取值过于集中|变异/)
  }, 30_000)
})
