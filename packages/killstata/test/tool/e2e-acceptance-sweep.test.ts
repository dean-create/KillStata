/**
 * E2E 全量验收：data/ 上的真实 Excel 数据 + golden fixtures → 受管 Python → 中文结果。
 *
 * 只测当前能独立调用的 backend（不依赖旧 econometric_algorithm.py）。
 * OLS/panel_fe/IV/PSM 通过旧路径（econometrics-method-tools.ts -> econometric_algorithm.py），
 * 另有专门 wiring/smoke 测试，这里不重复。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

const HOME = os.homedir()
const PYTHON = process.env.KILLSTATA_PYTHON ?? path.join(HOME, ".killstata", "venv", "bin", "python")
const ROOT = path.join(import.meta.dir, "..", "..", "..", "..")
const DATA_DIR = path.join(ROOT, "data")
const FIXTURES_DIR = path.join(ROOT, "packages", "killstata", "test", "fixtures", "golden")
const SPECTOR = path.join(FIXTURES_DIR, "spector.csv")
const COUNT_SIM = path.join(FIXTURES_DIR, "count_sim.csv")
const QUANTILE_SIM = path.join(FIXTURES_DIR, "quantile_sim.csv")
const PANEL_RE = path.join(FIXTURES_DIR, "panel_re_sim.csv")
const PANEL_FE_FIX = path.join(FIXTURES_DIR, "panel_re_fe_dgp.csv")
// Historical filename only: provenance is unverified, so this is not a Card–Krueger benchmark.
const DID_CSV = path.join(FIXTURES_DIR, "card_krueger_did.csv")
const GF_XLSX = path.join(DATA_DIR, "gf.xlsx")

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sweep-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function ok(r: any) {
  expect(r.success).toBe(true)
}

describe("① 二元结果 — Logit/Probit (Spector 文献值数据)", () => {
  test("logit_regression", async () => {
    const { runGlmBackend } = await import("../../../../trash/killstata-legacy-econometrics/tool/glm-backend")
    const r = await runGlmBackend({
      pythonCommand: PYTHON,
      cwd: ROOT,
      payload: {
        method: "logit_regression",
        dataPath: SPECTOR,
        outputDir: path.join(tempDir, "l"),
        dependentVar: "GRADE",
        treatmentVar: "PSI",
        covariates: ["GPA", "TUCE"],
        covariance: "nonrobust",
      },
      abort: new AbortController().signal,
    })
    ok(r)
    expect(r.primary?.estimate).toBeCloseTo(2.379, 1)
    expect(r.primaryMarginalEffect?.estimate).toBeCloseTo(0.305, 1)
  })

  test("probit_regression", async () => {
    const { runGlmBackend } = await import("../../../../trash/killstata-legacy-econometrics/tool/glm-backend")
    const r = await runGlmBackend({
      pythonCommand: PYTHON,
      cwd: ROOT,
      payload: {
        method: "probit_regression",
        dataPath: SPECTOR,
        outputDir: path.join(tempDir, "p"),
        dependentVar: "GRADE",
        treatmentVar: "PSI",
        covariates: ["GPA", "TUCE"],
        covariance: "nonrobust",
      },
      abort: new AbortController().signal,
    })
    ok(r)
    expect(r.primary?.estimate).toBeCloseTo(1.426, 1)
  })
})

describe("② 计数结果 — Poisson (合成计数数据, 400 obs)", () => {
  test("poisson_regression", async () => {
    const { runCountBackend } = await import("../../../../trash/killstata-legacy-econometrics/tool/count-backend")
    const r = await runCountBackend({
      pythonCommand: PYTHON,
      cwd: ROOT,
      payload: {
        method: "poisson_regression",
        dataPath: COUNT_SIM,
        outputDir: path.join(tempDir, "ps"),
        dependentVar: "count",
        treatmentVar: "treat",
        covariates: ["x", "z"],
        covariance: "nonrobust",
      },
      abort: new AbortController().signal,
    })
    ok(r)
    expect(r.primary?.estimate).toBeCloseTo(0.449241, 3)
  })
})

describe("③ 分位数回归 (异方差合成数据, 400 obs)", () => {
  test("quantile_regression with 3 quantiles", async () => {
    const { runQuantileBackend } = await import("../../../../trash/killstata-legacy-econometrics/tool/quantile-backend")
    const r = await runQuantileBackend({
      pythonCommand: PYTHON,
      cwd: ROOT,
      payload: {
        method: "quantile_regression",
        dataPath: QUANTILE_SIM,
        outputDir: path.join(tempDir, "q"),
        dependentVar: "y",
        treatmentVar: "treat",
        covariates: ["x"],
        quantiles: [0.25, 0.5, 0.75],
        covariance: "robust",
      },
      abort: new AbortController().signal,
    })
    ok(r)
    expect(r.fits?.length).toBe(3)
    expect(r.treatmentPath?.[0].estimate).toBeLessThan(r.treatmentPath?.[2].estimate!)
  })
})

describe("④ 面板随机效应 + Hausman (两个 fixture)", () => {
  test("RE-DGP → recommend RE", async () => {
    const { runPanelBackend } = await import("../../../../trash/killstata-legacy-econometrics/tool/panel-backend")
    const r = await runPanelBackend({
      pythonCommand: PYTHON,
      cwd: ROOT,
      payload: {
        method: "panel_random_effects",
        dataPath: PANEL_RE,
        outputDir: path.join(tempDir, "rr"),
        dependentVar: "y",
        treatmentVar: "X1",
        covariates: ["X2"],
        entityVar: "unit",
        timeVar: "time",
        covariance: "robust",
      },
      abort: new AbortController().signal,
    })
    ok(r)
    expect(r.recommendation?.preferred).toBe("random_effects")
  })
  test("FE-DGP → recommend FE", async () => {
    const { runPanelBackend } = await import("../../../../trash/killstata-legacy-econometrics/tool/panel-backend")
    const r = await runPanelBackend({
      pythonCommand: PYTHON,
      cwd: ROOT,
      payload: {
        method: "panel_random_effects",
        dataPath: PANEL_FE_FIX,
        outputDir: path.join(tempDir, "rf"),
        dependentVar: "y",
        treatmentVar: "X1",
        covariates: ["X2"],
        entityVar: "unit",
        timeVar: "time",
        covariance: "robust",
      },
      abort: new AbortController().signal,
    })
    ok(r)
    expect(r.recommendation?.preferred).toBe("fixed_effects")
  })
})

describe("⑤ 面板 FE + DID (pyfixest backends)", () => {
  test("legacy did_static backend smoke test with source-unverified fixture", async () => {
    const { runPyfixestBackend } = await import("../../../../trash/killstata-legacy-econometrics/tool/pyfixest-backend")
    const r = await runPyfixestBackend({
      pythonCommand: PYTHON,
      cwd: ROOT,
      payload: {
        method: "did_static",
        dataPath: DID_CSV,
        outputDir: path.join(tempDir, "dd"),
        dependentVar: "fte",
        treatmentVar: "treated",
        groupVar: "treated",
        postVar: "t",
        covariates: ["kfc", "roys", "wendys"],
        covariance: "HC1",
      },
      abort: new AbortController().signal,
    })
    ok(r)
    // This only checks legacy backend execution and row count; it does not validate a literature DID estimate.
    expect(r.rowsUsed).toBe(801)
  }, 90_000)
})

describe("⑥ 断点回归 RDD (Lee 2008 via rdrobust; 复用 quantile_sim 的 y/x 列)", () => {
  test("rdd_sharp on quantile_sim (mock data, tests backend wiring)", async () => {
    const { runRddBackend } = await import("../../../../trash/killstata-legacy-econometrics/tool/rdd-backend")
    const r = await runRddBackend({
      pythonCommand: PYTHON,
      cwd: ROOT,
      payload: {
        method: "rdd_sharp",
        dataPath: QUANTILE_SIM,
        outputDir: path.join(tempDir, "rd"),
        dependentVar: "y",
        runningVar: "x",
        cutoff: 0,
      },
      abort: new AbortController().signal,
    })
    ok(r)
  }, 90_000)
})

describe("⑦ 多分类 Logit — multinomial_sim (3 类合成数据, 400 obs)", () => {
  test("multinomial_logit on multinomial_sim", async () => {
    const { runMultinomialBackend } = await import("../../../../trash/killstata-legacy-econometrics/tool/multinomial-backend")
    const r = await runMultinomialBackend({
      pythonCommand: PYTHON,
      cwd: ROOT,
      payload: {
        method: "multinomial_logit",
        dataPath: path.join(FIXTURES_DIR, "multinomial_sim.csv"),
        outputDir: path.join(tempDir, "mn"),
        dependentVar: "y",
        treatmentVar: "treat",
        covariates: ["x"],
        covariance: "nonrobust",
      },
      abort: new AbortController().signal,
    })
    ok(r)
    expect(r.nCategories).toBe(3)
    expect(r.baselineCategory).toBe(0)
    console.log(`  MNLogit: N=${r.rowsUsed}, categories=${r.nCategories}, pseudoR²=${r.pseudoRSquared?.toFixed(4)}`)
  }, 60_000)
})
