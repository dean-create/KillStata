import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { runPanelBackend } from "../../../../trash/killstata-legacy-econometrics/tool/panel-backend"

/**
 * B 级数值对标（跨库独立实现）：面板随机效应估计。
 *
 * RE 估计无单一"文献值"可对（教科书多以 Card/Card-Krueger 等局部数据演示，
 * 而 linearmodels 的 Swamy-Arora 是 GLS 闭式解，与 statsmodels.MixedLM 的 REML/
 * profile likelihood 是完全不同的代码路径、不同的 sigma 估计）。所以"独立实现
 * 对标"（B 级）证据是：
 *
 *   linearmodels.RandomEffects ↔ statsmodels.regression.mixed_linear_model.MixedLM
 *
 * 在 panel_re_sim.csv（确定性合成面板，RE-DGP：α 与 X 独立、true β₀=1.0/β₁=0.5/β₂=-0.3）
 * 上两个库吻合到小数点后 2-3 位，相对差 ~0.2%。
 *
 * 复现 oracle（跨库那一半）：
 *   import statsmodels.formula.api as smf
 *   mixed = smf.mixedlm('y ~ X1 + X2', data, groups=unit).fit(reml=True)
 *   # X1 ≈ 0.5138, X2 ≈ -0.2786
 *
 * 而 Hausman 检验：linearmodels 7.0 没有公开 Hausman API（compare.Hausman 不存在），
 * 后端用 eigendecomposition + 正特征空间投影的稳健实现，RE-DGP 应得 H≈0（fail to
 * reject RE），FE-DGP（α 与 X 强相关）应得 H≫1（reject RE）。下面 golden 用
 * 这两个 fixture 双侧验证。
 *
 * FE-DGP fixture 用了 100 units × 5 periods + α-X 强相关（系数差 1.5），目的是
 * 让 Hausman 在常规 LM RE 与 linearmodels FE 之间有足够差异；RE-DGP fixture 用了
 * 50 units × 12 periods + α-X 弱相关（Hausman 应接近 0）。
 */

const PYTHON = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")
const PANEL_RE = path.join(import.meta.dir, "..", "fixtures", "golden", "panel_re_sim.csv")
const PANEL_FE = path.join(import.meta.dir, "..", "fixtures", "golden", "panel_re_fe_dgp.csv")

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-panel-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("panel random effects golden (cross-library B 级)", () => {
  test("RE-DGP fixture: RandomEffects aligns with statsmodels MixedLM (independent REML)", async () => {
    // 后端内部 fixture 跑通后, 由 statsmodels.MixedLM 独立验算（在 golden.test 之外做）
    // 这里只验证：LM RE 与 SM MixedLM 数字之间的差不超过 0.5%（容忍小样本 REML vs GLS 偏差）
    const { execSync } = await import("child_process")
    const oracle = execSync(
      `${PYTHON} -c "
import pandas as pd, statsmodels.formula.api as smf
panel = pd.read_csv('${PANEL_RE}')
mixed = smf.mixedlm('y ~ X1 + X2', panel, groups=panel['unit']).fit(reml=True)
print(f\\\"X1={mixed.fe_params['X1']:.6f} X2={mixed.fe_params['X2']:.6f}\\\")"`,
      { encoding: "utf-8" },
    ).trim()
    expect(oracle).toMatch(/X1=0\.5\d{5}\s+X2=-0\.2\d{5}/)

    // 后端实际产出
    const result = await runPanelBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "panel_random_effects",
        dataPath: PANEL_RE,
        outputDir: path.join(tempDir, "re_sim"),
        dependentVar: "y",
        treatmentVar: "X1",
        covariates: ["X2"],
        entityVar: "unit",
        timeVar: "time",
        covariance: "robust",
      },
    })
    expect(result.success).toBe(true)
    expect(result.backend).toBe("linearmodels")
    expect(result.nEntities).toBe(50)
    expect(result.nPeriods).toBe(12)
    // 后端 RE 系数应与 oracle 吻合到 0.5%
    const reX1 = result.randomEffects!.primary!.estimate!
    const oracleMatch = oracle.match(/X1=([\d.-]+)\s+X2=([\d.-]+)/)
    expect(oracleMatch).not.toBeNull()
    const oracleX1 = parseFloat(oracleMatch![1])
    const oracleX2 = parseFloat(oracleMatch![2])
    expect(Math.abs(reX1 - oracleX1) / Math.abs(oracleX1)).toBeLessThan(0.005)
    // X2 不是 primary，这里直接拿 randomEffects.coefficients 取
    const reX2Row = result.randomEffects!.coefficients.find((c) => c.term === "X2")!
    expect(Math.abs(reX2Row.estimate! - oracleX2) / Math.abs(oracleX2)).toBeLessThan(0.005)
  }, 90_000)

  test("RE-DGP fixture: Hausman H is small, recommendation is random_effects", async () => {
    const result = await runPanelBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "panel_random_effects",
        dataPath: PANEL_RE,
        outputDir: path.join(tempDir, "hausman_re"),
        dependentVar: "y",
        treatmentVar: "X1",
        covariates: ["X2"],
        entityVar: "unit",
        timeVar: "time",
        covariance: "robust",
      },
    })
    expect(result.success).toBe(true)
    // RE-DGP：FE/RE 系数应非常接近，Hausman 不显著
    expect(result.hausman!.pValue!).toBeGreaterThan(0.05)
    expect(result.recommendation!.preferred).toBe("random_effects")
    expect(result.hausman!.rejectRe).toBe(false)
  }, 60_000)

  test("FE-DGP fixture: Hausman H is large, recommendation is fixed_effects", async () => {
    const result = await runPanelBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "panel_random_effects",
        dataPath: PANEL_FE,
        outputDir: path.join(tempDir, "hausman_fe"),
        dependentVar: "y",
        treatmentVar: "X1",
        covariates: ["X2"],
        entityVar: "unit",
        timeVar: "time",
        covariance: "robust",
      },
    })
    expect(result.success).toBe(true)
    // FE-DGP：Hausman 显著拒绝 RE，应推荐 FE
    expect(result.hausman!.pValue!).toBeLessThan(0.05)
    expect(result.recommendation!.preferred).toBe("fixed_effects")
    expect(result.hausman!.rejectRe).toBe(true)
  }, 60_000)

  test("fails closed when entityVar and treatmentVar collide", async () => {
    await expect(
      runPanelBackend({
        pythonCommand: PYTHON,
        cwd: process.cwd(),
        payload: {
          method: "panel_random_effects",
          dataPath: PANEL_RE,
          outputDir: path.join(tempDir, "collide"),
          dependentVar: "y",
          treatmentVar: "X1", // 与实体索引冲突（X1 是连续型，这里人为制造重叠）
          covariates: ["X2"],
          entityVar: "X1",
          timeVar: "time",
          covariance: "robust",
        },
      }),
    ).rejects.toThrow(/索引|不能同时/)
  }, 30_000)
})
