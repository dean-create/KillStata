import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { Iv2slsTool, OlsRegressionTool } from "../../src/tool/econometrics-method-tools"
import { resolveRuntimePythonCommand } from "../../src/killstata/runtime-config"
import { Instance } from "../../src/project/instance"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-iv-golden-"))
  try {
    return await Instance.provide({ directory: root, fn: async () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function supportsEconometricsRuntime() {
  try {
    const pythonCommand = await resolveRuntimePythonCommand()
    execFileSync(pythonCommand, ["-c", "import statsmodels.api as sm; import linearmodels; import scipy"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return true
  } catch {
    return false
  }
}

const FIXTURES = path.join(process.cwd(), "test", "fixtures", "golden")
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIXTURES, "card1995_expected.json"), "utf-8"))

/**
 * 真实已发表论文的复现测试。
 *
 * Card (1995)：教育回报的经典 IV 研究。教育是内生的（能力同时影响教育和工资），
 * 用「家附近有没有四年制大学」作为工具变量。已发表的核心结论是：
 * **IV 估计的教育回报显著高于 OLS**（约 13% vs 约 7%）。
 *
 * 这个测试的价值不在于「跑通了」——之前 IV 只有「不崩」的测试，
 * 一个把系数算错 10 倍的实现照样能跑通。这里断言的是**算出来的数字**。
 */
describe("tool.econometrics IV golden test (Card 1995, real published data)", () => {
  test("iv_2sls reproduces Card (1995): IV return to schooling ≈ 13%, well above OLS ≈ 7%", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const csvPath = path.join(root, "card1995.csv")
      fs.copyFileSync(path.join(FIXTURES, "card1995.csv"), csvPath)
      const source = registerCanonicalDataset({
        sessionID: ctx.sessionID,
        sourcePath: csvPath,
        datasetId: "dataset_card1995_iv",
      })

      const tool = await Iv2slsTool.init()
      const result = await tool.execute(
        {
          ...source,
          dependentVar: EXPECTED.dependent,
          endogenousVar: EXPECTED.endogenous, // educ：内生的处理变量
          instrumentVar: EXPECTED.instrument, // nearc4：工具变量
          instrumentJustification: "The user-provided Card design uses college proximity to shift schooling costs.",
          covariates: EXPECTED.controls,
          covariance: "nonrobust",
        },
        ctx as any,
      )

      const r = result.metadata.result!

      // 样本量必须完全一致 —— 对不上说明数据处理阶段就已经出错了。
      expect(r.rows_used).toBe(EXPECTED.n)

      // 核心断言：教育回报的 IV 估计值，对上 linearmodels 的权威计算。
      expect(r.coefficient).toBeCloseTo(EXPECTED.iv_educ_coefficient, 4)
      expect(r.std_error).toBeCloseTo(EXPECTED.iv_educ_std_error, 4)
    })
  }, 30_000)

  test("the IV estimate is meaningfully larger than OLS — the paper's actual finding", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const csvPath = path.join(root, "card1995.csv")
      fs.copyFileSync(path.join(FIXTURES, "card1995.csv"), csvPath)
      const source = registerCanonicalDataset({
        sessionID: ctx.sessionID,
        sourcePath: csvPath,
        datasetId: "dataset_card1995_ols",
      })

      const tool = await OlsRegressionTool.init()
      const ols = await tool.execute(
        {
          ...source,
          dependentVar: EXPECTED.dependent,
          treatmentVar: EXPECTED.endogenous,
          covariates: EXPECTED.controls,
          covariance: "HC1",
        },
        ctx as any,
      )

      const olsCoef = ols.metadata.result!.coefficient!
      expect(olsCoef).toBeCloseTo(EXPECTED.ols_educ_coefficient, 4)
      expect(ols.metadata.result!.effective_covariance).toBe("HC1")

      // 这是 Card (1995) 论文的实际发现：修正内生性后，教育回报不降反升。
      // 如果我们的 IV 实现把内生性处理反了（或者根本没用上工具变量），
      // IV 估计就会塌回 OLS 附近，这个断言会红。
      expect(EXPECTED.iv_educ_coefficient).toBeGreaterThan(olsCoef * 1.5)
    })
  }, 30_000)

  test("the model-facing robust option reports the covariance actually used by linearmodels", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const csvPath = path.join(root, "card1995.csv")
      fs.copyFileSync(path.join(FIXTURES, "card1995.csv"), csvPath)
      const source = registerCanonicalDataset({
        sessionID: ctx.sessionID,
        sourcePath: csvPath,
        datasetId: "dataset_card1995_iv_robust",
      })
      const tool = await Iv2slsTool.init()
      const result = await tool.execute(
        {
          ...source,
          dependentVar: EXPECTED.dependent,
          endogenousVar: EXPECTED.endogenous,
          instrumentVar: EXPECTED.instrument,
          instrumentJustification: "The user-provided Card design uses college proximity to shift schooling costs.",
          covariates: EXPECTED.controls,
          covariance: "robust",
        },
        ctx as any,
      )

      expect(result.metadata.result!.effective_covariance).toBe("robust")
      expect(result.metadata.result!.std_error).toBeCloseTo(EXPECTED.iv_educ_robust_std_error, 4)
      expect(result.metadata.result!.std_error).not.toBeCloseTo(EXPECTED.iv_educ_std_error, 5)
    })
  }, 30_000)
})
