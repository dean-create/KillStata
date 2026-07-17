import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

async function runIpw(input: {
  outcome: number[]
  treatment: number[]
  propensityScore: number[]
  covariates: Record<string, number[]>
}) {
  const python = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  const moduleDir = path.resolve(import.meta.dir, "../../python/econometrics")
  const script = [
    "import json, sys",
    "import pandas as pd",
    "sys.path.insert(0, sys.argv[1])",
    "from econometric_algorithm import propensity_score_hajek_ipw_ate",
    "payload = json.loads(sys.stdin.read())",
    "result = propensity_score_hajek_ipw_ate(pd.Series(payload['outcome']), pd.Series(payload['treatment']), pd.Series(payload['propensityScore']), pd.DataFrame(payload['covariates']))",
    "print(json.dumps(result, sort_keys=True))",
  ].join("; ")
  return JSON.parse(
    execFileSync(python, ["-c", script, moduleDir], {
      encoding: "utf-8",
      input: JSON.stringify(input),
    }),
  ) as {
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
}

function balancedFixture() {
  const outcome: number[] = []
  const treatment: number[] = []
  const propensityScore: number[] = []
  const x: number[] = []
  for (let index = 0; index < 20; index += 1) {
    outcome.push(5)
    treatment.push(1)
    propensityScore.push(0.5)
    x.push(index % 2)
  }
  for (let index = 0; index < 20; index += 1) {
    outcome.push(1)
    treatment.push(0)
    propensityScore.push(0.5)
    x.push(index % 2)
  }
  return { outcome, treatment, propensityScore, covariates: { x } }
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

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-psm-ipw-"))
  const previousPython = process.env.KILLSTATA_PYTHON
  if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
    else process.env.KILLSTATA_PYTHON = previousPython
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function modelVisibleTool() {
  const tools = await ToolRegistry.tools(
    { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    undefined,
    {
      inputIntent: "analysis",
      currentStage: "preprocess_or_filter",
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: false },
    },
  )
  return tools.find((tool) => tool.id === "psm_ipw")
}

describe("strict propensity-score IPW", () => {
  test("runs through the model-visible tool with a fixed Hájek ATE and no inference", async () => {
    await withInstance(async (root) => {
      const sessionID = "psm_ipw_tool"
      const sourcePath = path.join(root, "ipw.csv")
      const rows = ["outcome,treated,x,x_squared"]
      for (const [x, controlCount, treatedCount] of [
        [-2, 15, 2],
        [-1, 12, 4],
        [0, 10, 8],
        [1, 4, 12],
        [2, 2, 15],
      ] as const) {
        for (let index = 0; index < controlCount; index += 1) rows.push(`${x},0,${x},${x * x}`)
        for (let index = 0; index < treatedCount; index += 1) rows.push(`${x + 3},1,${x},${x * x}`)
      }
      fs.writeFileSync(sourcePath, rows.join("\n"), "utf-8")
      const source = registerCanonicalDataset({ sessionID, sourcePath, datasetId: "dataset_psm_ipw" })
      const tool = await modelVisibleTool()
      expect(tool).toBeDefined()
      if (!tool) throw new Error("psm_ipw is not model-visible")

      const execution = await tool.execute(
        { ...source, dependentVar: "outcome", treatmentVar: "treated", covariates: ["x", "x_squared"] },
        context(sessionID) as never,
      )
      const result = execution.metadata.result as
        | {
            ate?: number
            treatment_ess?: number
            control_ess?: number
            weighted_max_abs_smd?: number
            numeric_snapshot_path?: string
          }
        | undefined

      // The fitted logit has two covariates and this finite synthetic table, so its
      // Hájek estimate is a stable wiring benchmark rather than the data-generating 3.0.
      expect(result?.ate).toBeCloseTo(2.974849912, 8)
      expect(result?.treatment_ess).toBeGreaterThanOrEqual(20)
      expect(result?.control_ess).toBeGreaterThanOrEqual(20)
      expect(result?.weighted_max_abs_smd).toBeLessThanOrEqual(0.1)
      expect(result?.numeric_snapshot_path).toBeUndefined()
      expect(execution.output).toContain("固定为 Hájek 归一化 ATE")
      expect(execution.output).toContain("加权后最大绝对 SMD")
      expect(execution.output).toContain("未输出标准误、p 值、置信区间或显著性结论")
      expect(execution.metadata.groundingScope).toBe("weighting")
      expect(execution.metadata.presentation).toBeUndefined()
      expect(execution.metadata.analysisView?.conclusion).toContain("不包含显著性推断")
    })
  }, 40_000)

  test("replays the published Card dataset through the full IPW tool chain as a real-data wiring baseline", async () => {
    await withInstance(async (root) => {
      const sessionID = "psm_ipw_card"
      const sourcePath = path.join(root, "card1995.csv")
      fs.copyFileSync(path.join(import.meta.dir, "../fixtures/golden/card1995.csv"), sourcePath)
      const source = registerCanonicalDataset({ sessionID, sourcePath, datasetId: "dataset_card1995_psm_ipw" })
      const tool = await modelVisibleTool()
      expect(tool).toBeDefined()
      if (!tool) throw new Error("psm_ipw is not model-visible")

      const execution = await tool.execute(
        {
          ...source,
          dependentVar: "lwage",
          treatmentVar: "nearc4",
          covariates: ["exper", "expersq", "black", "south", "smsa"],
        },
        context(sessionID) as never,
      )
      const result = execution.metadata.result as
        | { ate?: number; treatment_ess?: number; control_ess?: number; weighted_max_abs_smd?: number }
        | undefined

      expect(result?.ate).toBeCloseTo(0.041535826, 8)
      expect(result?.treatment_ess).toBeGreaterThanOrEqual(20)
      expect(result?.control_ess).toBeGreaterThanOrEqual(20)
      expect(result?.weighted_max_abs_smd).toBeLessThanOrEqual(0.1)
      expect(execution.output).toContain("逆概率加权（IPW）")
      expect(execution.output).not.toContain("P-value")
    })
  }, 40_000)

  test("fails closed and removes its isolated run directory when score construction is invalid", async () => {
    await withInstance(async (root) => {
      const sessionID = "psm_ipw_separation"
      const sourcePath = path.join(root, "separation.csv")
      fs.writeFileSync(
        sourcePath,
        ["outcome,treated,x", "0,0,0", "0,0,0.1", "0,0,0.2", "4,1,1", "4,1,1.1", "4,1,1.2"].join("\n"),
        "utf-8",
      )
      const source = registerCanonicalDataset({ sessionID, sourcePath })
      const tool = await modelVisibleTool()
      expect(tool).toBeDefined()
      if (!tool) throw new Error("psm_ipw is not model-visible")

      await expect(
        tool.execute(
          { ...source, dependentVar: "outcome", treatmentVar: "treated", covariates: ["x"] },
          context(sessionID) as never,
        ),
      ).rejects.toThrow(/separation|分离|converg|收敛|boundary|边界/i)
      expect(fs.existsSync(path.join(root, "analysis", "psm_ipw"))).toBe(false)
    })
  }, 30_000)

  test("returns a normalized Hájek ATE with group effective sample sizes and weighted balance", async () => {
    const result = await runIpw(balancedFixture())

    expect(result.ate).toBeCloseTo(4, 12)
    expect(result.treated_count).toBe(20)
    expect(result.control_count).toBe(20)
    expect(result.treatment_ess).toBeCloseTo(20, 12)
    expect(result.control_ess).toBeCloseTo(20, 12)
    expect(result.min_propensity_score).toBeCloseTo(0.5, 12)
    expect(result.max_propensity_score).toBeCloseTo(0.5, 12)
    expect(result.max_weight).toBeCloseTo(2, 12)
    expect(result.weighted_smd.x).toBeCloseTo(0, 12)
    expect(result.weighted_max_abs_smd).toBeCloseTo(0, 12)
  })

  test("rejects extreme propensity scores instead of silently clipping weights", async () => {
    const input = balancedFixture()
    input.propensityScore[0] = 0.02

    await expect(runIpw(input)).rejects.toThrow(/overlap|propensity|极端|重叠/i)
  })

  test("rejects low effective sample size even when propensity scores remain inside the fixed overlap range", async () => {
    const input = balancedFixture()
    for (let index = 0; index < 20; index += 1) input.propensityScore[index] = index === 0 ? 0.05 : 0.94

    await expect(runIpw(input)).rejects.toThrow(/effective sample|ESS|有效样本/i)
  })

  test("rejects a weighted result that leaves any supplied covariate imbalanced", async () => {
    const input = balancedFixture()
    input.covariates.x = [...Array(20).fill(10), ...Array.from({ length: 20 }, (_, index) => index % 2)]

    await expect(runIpw(input)).rejects.toThrow(/balance|SMD|平衡/i)
  })
})
