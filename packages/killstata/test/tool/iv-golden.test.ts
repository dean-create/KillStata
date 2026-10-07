import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { Iv2slsTool, OlsRegressionTool } from "../fixtures/legacy/tool/econometrics-method-tools"
import { resolveRuntimePythonCommand } from "../../src/killstata/runtime-config"
import { Instance } from "../../src/project/instance"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

// 测试在临时 Instance 目录里跑，那里没有项目级 python 配置，
// resolveRuntimePythonCommand() 会退化到系统 python3（没装 statsmodels/linearmodels）。
// 与 rdd-golden 一致，用 KILLSTATA_PYTHON 环境覆盖指向受管 venv。
process.env.KILLSTATA_PYTHON ??= path.join(os.homedir(), ".killstata", "venv", "bin", "python")

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

/**
 * 运行时探测必须在 Instance 上下文内做。
 *
 * `resolveRuntimePythonCommand()` 读 Instance 状态，在 `Instance.provide` 之外调用会抛
 * "No context found for instance"；旧写法把它放在 provide 之外再 catch 成 false，于是
 * 本文件三条真实数值断言长期静默跳过（跑出来是 4 pass / 3 expect，看着绿其实什么都没验）。
 * 跳过时必须吵一声，否则"验收门"就是摆设。
 */
async function withEconometricsRuntime(fn: (root: string) => Promise<void>) {
  await withInstance(async (root) => {
    if (!(await supportsEconometricsRuntime())) {
      console.warn("[iv-golden] 计量运行时不可用，跳过真实数值断言")
      return
    }
    await fn(root)
  })
}

const FIXTURES = path.join(process.cwd(), "test", "fixtures", "golden")
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIXTURES, "card1995_expected.json"), "utf-8"))
const JUSTIFICATION = "The user-provided Card design uses college proximity to shift schooling costs."

function prepareCard(root: string, datasetId: string) {
  const csvPath = path.join(root, "card1995.csv")
  fs.copyFileSync(path.join(FIXTURES, "card1995.csv"), csvPath)
  return registerCanonicalDataset({ sessionID: ctx.sessionID, sourcePath: csvPath, datasetId })
}

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
    await withEconometricsRuntime(async (root) => {
      const source = prepareCard(root, "dataset_card1995_iv")

      const tool = await Iv2slsTool.init()
      const result = await tool.execute(
        {
          ...source,
          dependentVar: EXPECTED.dependent,
          treatmentVar: EXPECTED.endogenous, // educ：内生的处理变量
          instrumentVars: [EXPECTED.instrument], // nearc4：工具变量
          instrumentJustification: JUSTIFICATION,
          covariates: EXPECTED.controls,
          covariance: "unadjusted",
        },
        ctx as any,
      )

      const r = result.metadata.result!

      // 样本量必须完全一致 —— 对不上说明数据处理阶段就已经出错了。
      expect(r.rowsUsed).toBe(EXPECTED.n)

      // 核心断言：教育回报的 IV 估计值，对上 linearmodels 的权威计算。
      expect(r.primary!.estimate).toBeCloseTo(EXPECTED.iv_educ_coefficient, 4)
      expect(r.primary!.stdError).toBeCloseTo(EXPECTED.iv_educ_std_error, 4)

      // 截距必须在模型里。linearmodels 不自动补常数项，漏加会把回归强制过原点，
      // 系数会从 0.1323 漂到 0.3228 —— 这条断言就是那次回归的哨兵。
      expect(r.coefficients!.some((c) => c.term === "const")).toBe(true)
    })
  }, 30_000)

  test("the IV estimate is meaningfully larger than OLS — the paper's actual finding", async () => {
    await withEconometricsRuntime(async (root) => {
      const source = prepareCard(root, "dataset_card1995_ols")

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

      const olsCoef = ols.metadata.result!.primary!.estimate!
      expect(olsCoef).toBeCloseTo(EXPECTED.ols_educ_coefficient, 4)
      expect(ols.metadata.result!.covariance).toBe("HC1")

      // 这是 Card (1995) 论文的实际发现：修正内生性后，教育回报不降反升。
      // 如果我们的 IV 实现把内生性处理反了（或者根本没用上工具变量），
      // IV 估计就会塌回 OLS 附近，这个断言会红。
      expect(EXPECTED.iv_educ_coefficient).toBeGreaterThan(olsCoef * 1.5)
    })
  }, 30_000)

  test("the model-facing robust option reports the covariance actually used by linearmodels", async () => {
    await withEconometricsRuntime(async (root) => {
      const source = prepareCard(root, "dataset_card1995_iv_robust")
      const tool = await Iv2slsTool.init()
      const result = await tool.execute(
        {
          ...source,
          dependentVar: EXPECTED.dependent,
          treatmentVar: EXPECTED.endogenous,
          instrumentVars: [EXPECTED.instrument],
          instrumentJustification: JUSTIFICATION,
          covariates: EXPECTED.controls,
          covariance: "robust",
        },
        ctx as any,
      )

      const r = result.metadata.result!
      expect(r.covariance).toBe("robust")
      expect(r.primary!.stdError).toBeCloseTo(EXPECTED.iv_educ_robust_std_error, 4)
      expect(r.primary!.stdError).not.toBeCloseTo(EXPECTED.iv_educ_std_error, 5)

      // 历史 wrapper 仍保留 firstStageF 别名；稳定 Registry 的真实旅程另核对分布口径。
      expect(r.firstStageF).toBeCloseTo(17.5541, 3)
    })
  }, 30_000)

  test("rejects an instrument that is the endogenous regressor itself", async () => {
    const tool = await Iv2slsTool.init()
    const base = {
      datasetId: "d",
      stageId: "s",
      dependentVar: EXPECTED.dependent,
      treatmentVar: EXPECTED.endogenous,
      covariates: EXPECTED.controls,
      instrumentJustification: JUSTIFICATION,
      covariance: "robust" as const,
    }
    expect(tool.parameters.safeParse({ ...base, instrumentVars: [EXPECTED.instrument] }).success).toBe(true)
    expect(tool.parameters.safeParse({ ...base, instrumentVars: [EXPECTED.endogenous] }).success).toBe(false)
    // 工具变量有效性依据是准入时固化的安全门，缺了必须拒。
    expect(
      tool.parameters.safeParse({
        ...base,
        instrumentVars: [EXPECTED.instrument],
        instrumentJustification: undefined,
      }).success,
    ).toBe(false)
  })
})
