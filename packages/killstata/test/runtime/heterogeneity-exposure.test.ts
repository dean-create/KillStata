import { describe, expect, test } from "bun:test"
import { resolveToolAvailability } from "@/runtime/workflow/exposure"
import { TOOL_MANIFEST, assertPromptToolNamesRegistered, PROMPT_TOOL_NAMES } from "@/runtime/tool-manifest"
import { WORKFLOW_RUNNER_TOOL_IDS, WORKFLOW_INPUT_INTENT_TOOL_BUNDLES } from "@/runtime/tool-catalog"
import os from "os"
import path from "path"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"

function engine() {
  const managedPython = process.platform === "win32"
    ? path.join(os.homedir(), ".killstata", "venv", "Scripts", "python.exe")
    : path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  return new EconometricsEngineClient({
    command: process.env.KILLSTATA_PYTHON ?? managedPython,
    cwd: path.resolve(process.cwd(), "../.."),
    pythonPath: path.resolve(process.cwd(), "../killstata-econometrics-engine/src"),
  })
}

const allToolIDs = TOOL_MANIFEST.map((entry) => entry.id)

const resolve = (policy: Parameters<typeof resolveToolAvailability>[0]["policy"]) =>
  resolveToolAvailability({ policy, toolIDs: allToolIDs })

describe("heterogeneity_runner 的可达性", () => {
  test("估计阶段 + analysis 意图 + 已批准时进入直接可调用工具面", () => {
    const resolution = resolve({
      currentStage: "baseline_estimate",
      currentStageStatus: "running",
      inputIntent: "analysis",
      agent: "analyst",
      approvalStatus: "approved",
    })

    expect(resolution.directToolIDs).toContain("heterogeneity_runner")
  })

  test("未批准时被挡下——它会按分组批量跑多个规格，需要显式授权", () => {
    const resolution = resolve({
      currentStage: "baseline_estimate",
      currentStageStatus: "running",
      inputIntent: "analysis",
      agent: "analyst",
      approvalStatus: "required",
    })

    expect(resolution.directToolIDs).not.toContain("heterogeneity_runner")
  })

  test("导入阶段拿不到：异质性分析要在基准结果之后", () => {
    const resolution = resolve({
      currentStage: "import",
      currentStageStatus: "running",
      inputIntent: "ingest",
      agent: "analyst",
      approvalStatus: "approved",
    })

    expect(resolution.directToolIDs).not.toContain("heterogeneity_runner")
  })

  test("verifier 只读隔离，拿不到执行器", () => {
    const resolution = resolve({
      currentStage: "baseline_estimate",
      currentStageStatus: "running",
      inputIntent: "analysis",
      agent: "verifier",
      approvalStatus: "approved",
    })

    expect(resolution.directToolIDs).not.toContain("heterogeneity_runner")
  })

  test("manifest 与 analysis 意图包都真正收录了它（回归点：此前 intents 为空）", () => {
    expect(WORKFLOW_RUNNER_TOOL_IDS).toContain("heterogeneity_runner")
    expect(WORKFLOW_INPUT_INTENT_TOOL_BUNDLES.analysis).toContain("heterogeneity_runner")
    expect(TOOL_MANIFEST.find((entry) => entry.id === "heterogeneity_runner")?.intents.length).toBeGreaterThan(0)
  })
})

describe("heterogeneity_runner 的方法族边界", () => {
  test("Python Registry 只接受 fe 与 did，并明确其余方法的执行边界", async () => {
    const client = engine()
    const runtime = {
      datasetId: "dataset_heterogeneity_test",
      stageId: "stage_000",
      runId: "run_000",
      branch: "main",
      outputDir: "/tmp/killstata-heterogeneity-test",
    }
    const base = {
      dependentVar: "y",
      treatmentVar: "x",
      covariates: [],
      heterogeneityVars: ["g"],
    }
    try {
      for (const methodFamily of ["fe", "did"]) {
        await expect(client.validate("heterogeneity_runner", { ...base, methodFamily }, { runtime })).resolves.toMatchObject({
          method_id: "heterogeneity_runner",
          arguments: { ...base, methodFamily },
        })
      }
      for (const methodFamily of ["iv", "psm", "rdd"]) {
        await expect(client.validate("heterogeneity_runner", { ...base, methodFamily }, { runtime })).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        })
      }

      const described = await client.describe("heterogeneity_runner")
      expect(described.description).toContain("IV、PSM、RDD")
      expect(described.description).toContain("OLS+LSDV")
      expect(described.description).toContain("DID2S")
      expect(described.description).toContain("扩展结果的标准误不能直接与基准结果表并列比较")
    } finally {
      await client.close()
    }
  })
})

describe("提示词点名工具的可达性不变量", () => {
  test("PROMPT_TOOL_NAMES 里的工具都在 manifest 且至少一个 intent 可达", () => {
    expect(() => assertPromptToolNamesRegistered()).not.toThrow()
  })

  test("异质性工具仍被提示词点名——现在它真的可达了", () => {
    expect(Object.values(PROMPT_TOOL_NAMES)).toContain("heterogeneity_runner")
  })
})
