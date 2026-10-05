import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { runCountBackend } from "../../../../trash/killstata-legacy-econometrics/tool/count-backend"

/**
 * B 级数值对标（跨库独立实现）：Poisson 计数回归。
 *
 * count_sim.csv 是确定性合成计数数据（seed 20260720，真参数 b0=0.8/treat=0.5/x=0.3/z=-0.2）。
 * 下面钉死的期望系数不是"自己对自己"——它们是用 **pyfixest 0.60.0 的 fepois** 独立算出来的
 * （完全不同的代码库、完全不同的实现路径），statsmodels 与 pyfixest 在这份数据上逐位吻合到
 * 6 位小数。因此这是跨库独立实现对标（B 级）：
 *   Intercept/const = 0.831117, treat = 0.449241, x = 0.277917, z = -0.177865
 *   IRR(treat) = exp(0.449241) = 1.567122; AME(treat) = 1.393769; Pearson 离散度 ≈ 0.985
 *
 * 复现 oracle（跨库那一半）：
 *   import pyfixest as pf; pf.fepois("count ~ treat + x + z", data=..., vcov="iid").coef()
 */

const PYTHON = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")
const COUNT_SIM = path.join(import.meta.dir, "..", "fixtures", "golden", "count_sim.csv")
const OVERDISPERSED = path.join(import.meta.dir, "..", "fixtures", "golden", "count_overdispersed.csv")

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-count-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function coef(result: Awaited<ReturnType<typeof runCountBackend>>, term: string) {
  const found = result.coefficients?.find((c) => c.term === term)
  if (!found) throw new Error(`结果里没有系数项 ${term}`)
  return found
}
function irr(result: Awaited<ReturnType<typeof runCountBackend>>, term: string) {
  const found = result.incidenceRateRatios?.find((c) => c.term === term)
  if (!found) throw new Error(`结果里没有发生率比项 ${term}`)
  return found
}

describe("count-data golden (Poisson/NegBin, cross-library B 级)", () => {
  test("poisson_regression matches pyfixest fepois on the synthetic count data", async () => {
    const result = await runCountBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "poisson_regression",
        dataPath: COUNT_SIM,
        outputDir: path.join(tempDir, "poisson"),
        dependentVar: "count",
        treatmentVar: "treat",
        covariates: ["x", "z"],
        covariance: "nonrobust",
      },
    })

    expect(result.success).toBe(true)
    expect(result.rowsUsed).toBe(400)
    expect(result.isPureCount).toBe(true)
    // 跨库对标：与 pyfixest fepois 逐位一致（对数尺度系数）
    expect(coef(result, "const").estimate!).toBeCloseTo(0.831117, 3)
    expect(coef(result, "treat").estimate!).toBeCloseTo(0.449241, 3)
    expect(coef(result, "x").estimate!).toBeCloseTo(0.277917, 3)
    expect(coef(result, "z").estimate!).toBeCloseTo(-0.177865, 3)
    // 发生率比 IRR = exp(系数)
    expect(irr(result, "treat").irr!).toBeCloseTo(1.567122, 2)
    // primary 锁定核心解释变量 treat，而不是常数或第一个协变量
    expect(result.primary?.term).toBe("treat")
    expect(result.primaryIrr?.term).toBe("treat")
    // 平均边际效应是计数尺度、可解读的处理效应
    expect(result.primaryMarginalEffect?.term).toBe("treat")
    expect(result.primaryMarginalEffect?.estimate!).toBeCloseTo(1.393769, 1)
    // 真 Poisson 数据：Pearson 离散度应接近 1，不应误报过度离散
    expect(result.dispersion!).toBeCloseTo(0.985, 1)
    expect(result.warnings ?? []).not.toContain(expect.stringContaining("过度离散"))
    // Poisson 不返回 alpha
    expect(result.alpha).toBeNull()
  }, 60_000)

  test("poisson_regression flags overdispersion and negbin_regression estimates alpha > 0", async () => {
    const pois = await runCountBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "poisson_regression",
        dataPath: OVERDISPERSED,
        outputDir: path.join(tempDir, "pois_od"),
        dependentVar: "count",
        treatmentVar: "treat",
        covariates: ["x"],
        covariance: "nonrobust",
      },
    })
    expect(pois.success).toBe(true)
    // 过度离散数据：Pearson 离散度远大于 1，必须给出改用负二项的告警
    expect(pois.dispersion!).toBeGreaterThan(1.5)
    expect((pois.warnings ?? []).some((w) => w.includes("过度离散"))).toBe(true)

    const nb = await runCountBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "negbin_regression",
        dataPath: OVERDISPERSED,
        outputDir: path.join(tempDir, "nb_od"),
        dependentVar: "count",
        treatmentVar: "treat",
        covariates: ["x"],
        covariance: "nonrobust",
      },
    })
    expect(nb.success).toBe(true)
    // 负二项必须估出正的过度离散参数 alpha（数据确实过度离散）
    expect(nb.alpha!).toBeGreaterThan(0)
    // 两个模型对 treat 的点估计应当接近（负二项主要改的是标准误/离散度）
    expect(nb.primary?.estimate!).toBeCloseTo(pois.primary!.estimate!, 1)
  }, 60_000)

  test("robust (HC1) covariance changes the standard errors but not the point estimate", async () => {
    const base = {
      dataPath: OVERDISPERSED,
      dependentVar: "count",
      treatmentVar: "treat",
      covariates: ["x"] as string[],
    }
    const nonrobust = await runCountBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: { method: "poisson_regression", outputDir: path.join(tempDir, "nr"), covariance: "nonrobust", ...base },
    })
    const robust = await runCountBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: { method: "poisson_regression", outputDir: path.join(tempDir, "hc1"), covariance: "robust", ...base },
    })
    expect(robust.covariance).toBe("HC1")
    // 点估计不随协方差选择改变
    expect(robust.primary?.estimate!).toBeCloseTo(nonrobust.primary!.estimate!, 6)
    // 过度离散数据下，HC1 稳健标准误应当明显大于低估的常规标准误
    expect(robust.primary?.stdError!).toBeGreaterThan(nonrobust.primary!.stdError!)
  }, 60_000)

  test("fails closed when the outcome has negative values (not a count)", async () => {
    await expect(
      runCountBackend({
        pythonCommand: PYTHON,
        cwd: process.cwd(),
        payload: {
          method: "poisson_regression",
          dataPath: COUNT_SIM,
          outputDir: path.join(tempDir, "neg"),
          dependentVar: "x", // 标准正态，含负值
          treatmentVar: "treat",
          covariates: [],
          covariance: "nonrobust",
        },
      }),
    ).rejects.toThrow(/非负|负值/)
  }, 30_000)
})
