import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

async function runMatcher(input: {
  outcome: number[]
  treatment: number[]
  propensityScore: number[]
  covariates: Record<string, number[]>
}) {
  // 数值准入测试必须真正调用受管 Python；这里不依赖项目 Instance，避免测试被配置上下文掩盖。
  const python = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  const moduleDir = path.resolve(import.meta.dir, "../../python/econometrics")
  const script = [
    "import json, sys",
    "import pandas as pd",
    "sys.path.insert(0, sys.argv[1])",
    "from econometric_algorithm import propensity_score_nearest_neighbor_att",
    "payload = json.loads(sys.stdin.read())",
    "result = propensity_score_nearest_neighbor_att(pd.Series(payload['outcome']), pd.Series(payload['treatment']), pd.Series(payload['propensityScore']), pd.DataFrame(payload['covariates']))",
    "print(json.dumps(result, sort_keys=True))",
  ].join("; ")
  return JSON.parse(
    execFileSync(python, ["-c", script, moduleDir], {
      encoding: "utf-8",
      input: JSON.stringify(input),
    }),
  ) as {
    att: number
    caliper: number
    matched_treated_count: number
    unmatched_treated_count: number
    treated_count: number
    control_count: number
    reused_control_count: number
    max_match_distance: number
    pre_match_max_abs_smd: number
    post_match_max_abs_smd: number
    pre_match_smd: Record<string, number>
    post_match_smd: Record<string, number>
  }
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-psm-matching-"))
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
  return tools.find((tool) => tool.id === "psm_matching")
}

describe("strict propensity-score matching", () => {
  test("rejects a repeated entity-time panel even when its analysis unit and aggregation are declared", async () => {
    await withInstance(async (root) => {
      const sessionID = "psm_matching_repeated_panel"
      const sourcePath = path.join(root, "repeated_panel.csv")
      const rows = ["city,year,outcome,treated,x,x_squared"]
      let city = 0
      for (const [x, controlCount, treatedCount] of [
        [-2, 15, 2],
        [-1, 12, 4],
        [0, 10, 8],
        [1, 4, 12],
        [2, 2, 15],
      ] as const) {
        for (const [treated, count] of [
          [0, controlCount],
          [1, treatedCount],
        ] as const) {
          for (let index = 0; index < count; index += 1) {
            city += 1
            for (const year of [2020, 2021]) rows.push(`city_${city},${year},${x + treated * 3},${treated},${x},${x * x}`)
          }
        }
      }
      fs.writeFileSync(sourcePath, rows.join("\n"), "utf-8")
      const source = registerCanonicalDataset({ sessionID, sourcePath })
      const tool = await modelVisibleTool()
      if (!tool) throw new Error("psm_matching is not model-visible")

      await expect(
        tool.execute(
          {
            ...source,
            dependentVar: "outcome",
            treatmentVar: "treated",
            covariates: ["x", "x_squared"],
            analysisUnitVar: "city",
            preTreatmentAggregation: "pre_treatment_mean",
          },
          context(sessionID) as never,
        ),
      ).rejects.toThrow(/分析单位|聚合|analysis unit|aggregation/i)
    })
  }, 40_000)

  test("runs through the model-visible tool and returns a bounded matched-treated ATT without inference", async () => {
    await withInstance(async (root) => {
      const sessionID = "psm_matching_tool"
      const sourcePath = path.join(root, "matched.csv")
      const rows = ["unit,outcome,treated,x,x_squared"]
      let unit = 0
      for (const [x, controlCount, treatedCount] of [
        [-2, 15, 2],
        [-1, 12, 4],
        [0, 10, 8],
        [1, 4, 12],
        [2, 2, 15],
      ] as const) {
        for (let index = 0; index < controlCount; index += 1) rows.push(`${++unit},${x},0,${x},${x * x}`)
        for (let index = 0; index < treatedCount; index += 1) rows.push(`${++unit},${x + 3},1,${x},${x * x}`)
      }
      fs.writeFileSync(sourcePath, rows.join("\n"), "utf-8")
      const source = registerCanonicalDataset({ sessionID, sourcePath, datasetId: "dataset_psm_matching" })
      const tool = await modelVisibleTool()
      expect(tool).toBeDefined()
      if (!tool) throw new Error("psm_matching is not model-visible")

      const args = {
        ...source,
        dependentVar: "outcome",
        treatmentVar: "treated",
        covariates: ["x", "x_squared"],
        analysisUnitVar: "unit",
        preTreatmentAggregation: "not_applicable",
      }
      const execution = await tool.execute(args, context(sessionID) as never)
      const result = execution.metadata.result as
        | {
            att?: number
            treated_count?: number
            matched_treated_count?: number
            unmatched_treated_count?: number
            post_match_max_abs_smd?: number
            numeric_snapshot_path?: string
          }
        | undefined

      expect(result?.att).toBeCloseTo(3, 12)
      expect(result?.treated_count).toBe(41)
      expect(result?.matched_treated_count).toBe(41)
      expect(result?.unmatched_treated_count).toBe(0)
      expect(result?.post_match_max_abs_smd).toBeCloseTo(0, 12)
      expect(result?.numeric_snapshot_path).toBeUndefined()
      expect(execution.output).toContain("ATT（已匹配处理组）：3.0000")
      expect(execution.output).toContain("匹配后最大绝对 SMD")
      expect(execution.output).not.toContain("\n- 标准误：")
      expect(execution.output).not.toContain("\n- p 值：")
      expect(execution.output).toContain("未输出标准误、p 值、置信区间或显著性结论")
      expect(execution.output).not.toMatch(/\.killstata|\/Users\//)
      expect(execution.metadata.groundingScope).toBe("matching")
      expect(execution.metadata.presentation).toBeUndefined()
      expect(execution.metadata.analysisView?.conclusion).toContain("不包含显著性推断")
    })
  }, 40_000)

  test("fails closed and removes the isolated run directory when score construction is invalid", async () => {
    await withInstance(async (root) => {
      const sessionID = "psm_matching_separation"
      const sourcePath = path.join(root, "separation.csv")
      fs.writeFileSync(
        sourcePath,
        ["unit,outcome,treated,x", "1,0,0,0", "2,0,0,0.1", "3,0,0,0.2", "4,4,1,1", "5,4,1,1.1", "6,4,1,1.2"].join("\n"),
        "utf-8",
      )
      const source = registerCanonicalDataset({ sessionID, sourcePath })
      const tool = await modelVisibleTool()
      expect(tool).toBeDefined()
      if (!tool) throw new Error("psm_matching is not model-visible")

      await expect(
        tool.execute(
          {
            ...source,
            dependentVar: "outcome",
            treatmentVar: "treated",
            covariates: ["x"],
            analysisUnitVar: "unit",
            preTreatmentAggregation: "not_applicable",
          },
          context(sessionID) as never,
        ),
      ).rejects.toThrow(/separation|分离|converg|收敛|boundary|边界/i)
      expect(fs.existsSync(path.join(root, "analysis", "psm_matching"))).toBe(false)
    })
  }, 30_000)

  test("replays the published Card dataset through the full tool chain as a real-data wiring baseline", async () => {
    await withInstance(async (root) => {
      const sessionID = "psm_matching_card"
      const sourcePath = path.join(root, "card1995.csv")
      const cardRows = fs.readFileSync(path.join(import.meta.dir, "../fixtures/golden/card1995.csv"), "utf-8").trim().split("\n")
      fs.writeFileSync(sourcePath, ["unit," + cardRows[0], ...cardRows.slice(1).map((row, index) => `${index + 1},${row}`)].join("\n"), "utf-8")
      const source = registerCanonicalDataset({ sessionID, sourcePath, datasetId: "dataset_card1995_psm_matching" })
      const tool = await modelVisibleTool()
      expect(tool).toBeDefined()
      if (!tool) throw new Error("psm_matching is not model-visible")

      const execution = await tool.execute(
        {
          ...source,
          dependentVar: "lwage",
          treatmentVar: "nearc4",
          covariates: ["exper", "expersq", "black", "south", "smsa"],
          analysisUnitVar: "unit",
          preTreatmentAggregation: "not_applicable",
        },
        context(sessionID) as never,
      )
      const result = execution.metadata.result as
        | { att?: number; matched_treated_count?: number; post_match_max_abs_smd?: number }
        | undefined

      expect(result?.att).toBeCloseTo(0.041971098, 8)
      expect(result?.matched_treated_count).toBe(2053)
      expect(result?.post_match_max_abs_smd).toBeCloseTo(0.013219971, 8)
      expect(execution.output).toContain("ATT（已匹配处理组）")
      expect(execution.output).not.toContain("P-value")
    })
  }, 40_000)

  test("uses a fixed 1:1 ATT rule, averages exact-distance ties, and reports matched-treated scope", async () => {
    const result = await runMatcher({
      // 两个处理组样本各自有最近的对照；第一个处理组有两个同距离并列对照，必须取平均而不是按行号任选一个。
      outcome: [10, 1, 5, 30, 20],
      treatment: [1, 0, 0, 1, 0],
      propensityScore: [0.4, 0.4, 0.4, 0.7, 0.7],
      covariates: { x: [0, 0, 0, 1, 1] },
    })

    expect(result.att).toBeCloseTo(8.5, 12)
    expect(result.matched_treated_count).toBe(2)
    expect(result.unmatched_treated_count).toBe(0)
    expect(result.treated_count).toBe(2)
    expect(result.control_count).toBe(3)
    expect(result.reused_control_count).toBe(0)
    expect(result.max_match_distance).toBe(0)
    expect(result.caliper).toBeGreaterThan(0)
    expect(result.pre_match_smd.x).toBeGreaterThan(0)
    expect(result.post_match_smd.x).toBeCloseTo(0, 12)
  })

  test("drops only caliper-ineligible treated rows and names the estimand as matched treated", async () => {
    const result = await runMatcher({
      outcome: [10, 20, 1, 2],
      treatment: [1, 1, 0, 0],
      propensityScore: [0.2, 0.9, 0.2, 0.22],
      covariates: { x: [0, 0, 0, 0] },
    })

    expect(result.matched_treated_count).toBe(1)
    expect(result.unmatched_treated_count).toBe(1)
    expect(result.att).toBeCloseTo(9, 12)
  })

  test("fails closed when matching leaves a covariate imbalanced", async () => {
    await expect(
      runMatcher({
        outcome: [10, 1, 2, 3],
        treatment: [1, 1, 0, 0],
        propensityScore: [0.4, 0.6, 0.4, 0.6],
        covariates: { x: [9, 11, 0, 2] },
      }),
    ).rejects.toThrow(/balance|SMD|平衡/i)
  })
})
