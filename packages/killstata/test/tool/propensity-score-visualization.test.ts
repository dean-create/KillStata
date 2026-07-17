import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { Instance } from "@/project/instance"
import { executeRerunPlan, recordWorkflowStageFailure } from "@/runtime/workflow"
import { classifyToolFailure } from "@/tool/analysis-reflection"
import { ToolRegistry } from "@/tool/registry"
import { readDatasetManifest } from "@/tool/analysis-state"
import { EconometricsTool } from "@/tool/econometrics"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

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

function findFilesNamed(root: string, fileName: string): string[] {
  const matches: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) matches.push(...findFilesNamed(entryPath, fileName))
    if (entry.isFile() && entry.name === fileName) matches.push(entryPath)
  }
  return matches
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-psm-visualize-"))
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
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
  return tools.find((tool) => tool.id === "psm_visualize")
}

describe("propensity-score visualization tool", () => {
  test("runs on a real dataset and publishes only a bounded diagnostic plot", async () => {
    await withInstance(async (root) => {
      const sessionID = "psm_visualize_card"
      const sourcePath = path.join(root, "card1995.csv")
      fs.copyFileSync(path.join(import.meta.dir, "../fixtures/golden/card1995.csv"), sourcePath)
      const source = registerCanonicalDataset({ sessionID, sourcePath, datasetId: "dataset_card1995_ps_plot" })
      const tool = await modelVisibleTool()

      expect(tool).toBeDefined()
      if (!tool) throw new Error("psm_visualize is not model-visible")
      const args = {
        ...source,
        treatmentVar: "nearc4",
        covariates: ["exper", "expersq", "black", "south", "smsa"],
      }
      expect(tool.parameters.safeParse(args).success).toBe(true)
      expect(tool.parameters.safeParse({ ...args, dependentVar: "lwage" }).success).toBe(false)
      expect(tool.parameters.safeParse({ ...args, bins: 200 }).success).toBe(false)

      const execution = await tool.execute(args, context(sessionID) as never)
      const result = execution.metadata.result as
        | {
            plot_path?: string
            rows_used?: number
            score_min?: number
            score_max?: number
            share_in_support?: number
            treated_count?: number
            control_count?: number
            coefficients_path?: string
            workbook_path?: string
          }
        | undefined

      expect(result?.rows_used).toBe(3010)
      expect(result?.treated_count).toBe(2053)
      expect(result?.control_count).toBe(957)
      expect((result?.treated_count ?? 0) + (result?.control_count ?? 0)).toBe(result?.rows_used ?? 0)
      expect(result?.score_min).toBeCloseTo(0.3302758, 6)
      expect(result?.score_max).toBeCloseTo(0.8378642, 6)
      expect(result?.share_in_support).toBeCloseTo(0.99833887, 6)
      expect(result?.coefficients_path).toBeUndefined()
      expect(result?.workbook_path).toBeUndefined()
      expect(result?.plot_path).toBeString()

      const plotPath = path.isAbsolute(result!.plot_path!) ? result!.plot_path! : path.join(root, result!.plot_path!)
      const png = fs.readFileSync(plotPath)
      expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true)
      expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(1000)
      expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(600)

      expect(execution.output).toContain("倾向得分分布诊断")
      expect(execution.output).toContain("不是因果效应估计")
      expect(execution.output).not.toContain("ps_distribution.png")
      expect(execution.output).not.toMatch(/\.killstata|\/Users\//)
      expect(execution.output).not.toContain("### Estimates")
      expect(execution.output).not.toMatch(/P-value|Coefficient|统计显著/i)
      expect(execution.metadata.groundingScope).toBe("diagnostic")
      expect(execution.metadata.presentation).toBeUndefined()
      expect(execution.metadata.analysisView?.step).toBe("psm_visualize")
      expect(execution.metadata.analysisView?.conclusion).toContain("不是因果效应估计")
      expect(execution.metadata.analysisView?.artifacts).toContainEqual(
        expect.objectContaining({ label: "倾向得分分布图", visibility: "user_default" }),
      )

      const artifacts = readDatasetManifest(source.datasetId).artifacts.filter(
        (artifact) => artifact.action === "psm_visualize",
      )
      expect(artifacts).toHaveLength(1)
    })
  }, 40_000)

  test("uses common bins and normalizes each treatment group independently", async () => {
    const python = await resolveRuntimePythonCommand()
    const moduleDir = path.resolve(import.meta.dir, "../../python/econometrics")
    const diagnostic = JSON.parse(
      execFileSync(
        python,
        [
          "-c",
          [
            "import json, sys",
            "import pandas as pd",
            "sys.path.insert(0, sys.argv[1])",
            "from econometric_algorithm import propensity_score_visualize_propensity_score_distribution",
            "treatment = pd.Series([0, 0, 0, 1, 1])",
            "scores = pd.Series([0.15, 0.25, 0.35, 0.65, 0.85])",
            "figure = propensity_score_visualize_propensity_score_distribution(treatment, scores)",
            "patches = figure.axes[0].patches",
            "control, treated = patches[:20], patches[20:]",
            "result = {'patch_count': len(patches), 'control_sum': sum(p.get_height() for p in control), 'treated_sum': sum(p.get_height() for p in treated), 'same_bins': [(p.get_x(), p.get_width()) for p in control] == [(p.get_x(), p.get_width()) for p in treated]}",
            "print(json.dumps(result))",
          ].join("; "),
          moduleDir,
        ],
        { encoding: "utf-8" },
      ),
    ) as { patch_count: number; control_sum: number; treated_sum: number; same_bins: boolean }

    expect(diagnostic.patch_count).toBe(40)
    expect(diagnostic.control_sum).toBeCloseTo(1, 12)
    expect(diagnostic.treated_sum).toBeCloseTo(1, 12)
    expect(diagnostic.same_bins).toBe(true)
  })

  test("rejects perfect separation without publishing a partial plot", async () => {
    await withInstance(async (root) => {
      const sessionID = "psm_visualize_separation"
      const sourcePath = path.join(root, "separation.csv")
      fs.writeFileSync(
        sourcePath,
        ["treated,x", "0,0", "0,0.1", "0,0.2", "1,1", "1,1.1", "1,1.2"].join("\n"),
        "utf-8",
      )
      const source = registerCanonicalDataset({ sessionID, sourcePath })
      const tool = await modelVisibleTool()
      expect(tool).toBeDefined()
      if (!tool) throw new Error("psm_visualize is not model-visible")

      await expect(
        tool.execute({ ...source, treatmentVar: "treated", covariates: ["x"] }, context(sessionID) as never),
      ).rejects.toThrow(/separation|分离|converg|收敛|boundary|边界/i)
      expect(findFilesNamed(root, "ps_distribution.png")).toHaveLength(0)
      expect(
        readDatasetManifest(source.datasetId).artifacts.filter((artifact) => artifact.action === "psm_visualize"),
      ).toHaveLength(0)
    })
  }, 20_000)

  test("can replay the recorded diagnostic with the same typed arguments", async () => {
    await withInstance(async (root) => {
      const sessionID = "psm_visualize_replay"
      const sourcePath = path.join(root, "replay.csv")
      const rows = ["treated,age,income"]
      for (let index = 0; index < 80; index += 1) {
        rows.push(`${(index * 7) % 10 < 4 ? 1 : 0},${20 + (index % 13)},${30 + ((index * 3) % 17)}`)
      }
      fs.writeFileSync(sourcePath, rows.join("\n"), "utf-8")
      const source = registerCanonicalDataset({ sessionID, sourcePath })
      const args = { ...source, treatmentVar: "treated", covariates: ["age", "income"] }
      const failed = recordWorkflowStageFailure({
        sessionID,
        toolName: "psm_visualize",
        args,
        reflection: classifyToolFailure({
          toolName: "psm_visualize",
          error: "transient estimation failure",
          input: args,
          sessionId: sessionID,
        }),
      })

      const replay = await executeRerunPlan({
        sessionID,
        stageId: failed.stage.stageId,
        ctx: context(sessionID),
      })
      expect(replay.blocked).toBe(false)
      expect("execution" in replay ? replay.execution.executedStageIds : []).toContain(failed.stage.stageId)
      expect(findFilesNamed(root, "ps_distribution.png")).toHaveLength(1)
    })
  }, 30_000)

  test("rejects caller-owned output directories before execution", async () => {
    await withInstance(async (root) => {
      const outputDir = path.join(root, "caller-owned")
      fs.mkdirSync(outputDir)
      fs.writeFileSync(path.join(outputDir, "keep.txt"), "existing", "utf-8")
      const dataPath = path.join(root, "input.csv")
      fs.writeFileSync(
        dataPath,
        ["treated,age", "0,20", "1,30", "0,40", "1,50", "0,60", "1,70"].join("\n"),
        "utf-8",
      )
      const tool = await EconometricsTool.init()

      await expect(
        tool.execute(
          { methodName: "psm_visualize", dataPath, treatmentVar: "treated", covariates: ["age"], outputDir },
          context("psm_visualize_caller_output") as never,
        ),
      ).rejects.toThrow(/outputDir|输出目录/i)
      expect(fs.readdirSync(outputDir)).toEqual(["keep.txt"])
    })
  })

  test("removes its isolated output directory when execution permission is rejected", async () => {
    await withInstance(async (root) => {
      const dataPath = path.join(root, "permission.csv")
      fs.writeFileSync(dataPath, ["treated,age", "0,20", "1,30", "0,40", "1,50"].join("\n"), "utf-8")
      const tool = await EconometricsTool.init()
      const rejectedContext = {
        ...context("psm_visualize_permission_rejected"),
        ask: async () => {
          throw new Error("User rejected execution")
        },
      }

      await expect(
        tool.execute(
          { methodName: "psm_visualize", dataPath, treatmentVar: "treated", covariates: ["age"] },
          rejectedContext as never,
        ),
      ).rejects.toThrow(/rejected/i)
      expect(fs.existsSync(path.join(root, "analysis", "psm_visualize"))).toBe(false)
    })
  })

  test("removes all outputs when post-processing fails after the PNG was created", async () => {
    await withInstance(async (root) => {
      const dataPath = path.join(root, "post-processing.csv")
      const rows = ["treated,age,income"]
      for (let index = 0; index < 80; index += 1) {
        rows.push(`${(index * 7) % 10 < 4 ? 1 : 0},${20 + (index % 13)},${30 + ((index * 3) % 17)}`)
      }
      fs.writeFileSync(dataPath, rows.join("\n"), "utf-8")
      const outputDir = path.join(root, "analysis", "psm_visualize")
      fs.mkdirSync(path.join(outputDir, "delivery_result_summary.md"), { recursive: true })
      const tool = await EconometricsTool.init()

      await expect(
        tool.execute(
          {
            methodName: "psm_visualize",
            dataPath,
            treatmentVar: "treated",
            covariates: ["age", "income"],
          },
          context("psm_visualize_postprocess_failure") as never,
        ),
      ).rejects.toThrow()
      expect(fs.existsSync(outputDir)).toBe(false)
    })
  }, 20_000)
})
