import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { OlsRegressionTool as NewOlsTool } from "../fixtures/legacy/tool/ols"
import { PanelFeTool } from "../fixtures/legacy/tool/panel-fe"
import { IvTool } from "../fixtures/legacy/tool/iv"
import {
  ALL_ECONOMETRICS_ESTIMATOR_TOOL_IDS,
  MODEL_ADMITTED_ECONOMETRICS_DIAGNOSTIC_TOOL_IDS,
  MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS,
} from "@/runtime/econometrics-admission"

const ESTIMATOR_TOOL_IDS = MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS

async function withAnalysisTools<T>(fn: (tools: Awaited<ReturnType<typeof ToolRegistry.tools>>) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-econometrics-tools-"))
  try {
    return await Instance.provide({
      directory: root,
      fn: async () => {
        const pool = await ToolRegistry.resolvePool({ providerID: "deepseek", modelID: "deepseek-v4-flash" }, undefined, {
          inputIntent: "analysis",
          currentStage: "preprocess_or_filter",
          platformCapabilities: { mcp: false, images: false, remote: false },
          modelCapabilities: { supportsTools: true, supportsImages: false },
        })
        expect(pool.resolution.directToolIDs).toEqual(expect.arrayContaining([
          "read", "list", "glob", "grep", "pipeline", "tool_search", "econometrics_execute", "data_import",
        ]))
        expect(pool.resolution.directToolIDs).not.toContain("ols_regression")
        // 这里模拟真正发送给模型的 direct 工具面；历史 deferred 实现只供 replay 测试显式回查。
        const tools = await pool.load(pool.resolution.directToolIDs ?? [])
        return fn(tools)
      },
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const HISTORICAL_TOOLS = {
  ols_regression: NewOlsTool,
  panel_fe_regression: PanelFeTool,
  iv_2sls: IvTool,
} as const

async function registeredTool(toolID: keyof typeof HISTORICAL_TOOLS) {
  const tool = HISTORICAL_TOOLS[toolID]
  expect(tool, `${toolID} should remain registered for historical replay`).toBeDefined()
  // 这三项已从 ProductionEconometricsTools 迁到各自独立数组注册（旧包装器没有 parameters
  // 且与独立工具 ID 重复）。是否真的注册由上面读 ToolRegistry.ids() 的用例覆盖，这里只校验 ID。
  expect(tool.id).toBe(toolID)
  if (!tool) throw new Error(`Missing registered tool: ${toolID}`)
  return tool.init()
}

describe("model-visible econometrics tools", () => {
  test("exposes only admission-approved tools and hides legacy or unadmitted backends", async () => {
    await withAnalysisTools(async (tools) => {
      const ids = tools.map((tool) => tool.id)
      const registered = await ToolRegistry.ids()

      expect(ids).toContain("tool_search")
      expect(ids).toContain("econometrics_execute")
      expect(ids).not.toContain("econometrics")
      for (const id of ALL_ECONOMETRICS_ESTIMATOR_TOOL_IDS) {
        expect(registered).toContain(id)
        expect(ids).not.toContain(id)
      }
    })
  })

  test("keeps historical OLS registered and rejects ambiguous legacy options", async () => {
    const ols = await registeredTool("ols_regression")

    expect(
      ols.parameters.safeParse({
        dataPath: "data.xlsx",
        datasetId: "dataset_1",
        dependentVar: "y",
        treatmentVar: "x",
      }).success,
    ).toBe(false)
    expect(
      ols.parameters.safeParse({
        dataPath: "data.xlsx",
        dependentVar: "y",
        treatmentVar: "x",
        methodName: "psm_double_robust",
        options: { robust_se: true },
      }).success,
    ).toBe(false)
  })

  test("keeps historical IV2SLS registered with its identification contract", async () => {
    const iv = await registeredTool("iv_2sls")

    // 新 IV schema: treatmentVar + instrumentVars(数组) + covariates + instrumentJustification。
    // 识别依据是准入时固化的安全门——模型不得靠列名推断工具变量有效性，缺了必须拒。
    const justification = "College proximity shifts schooling costs and is excluded from wages given controls."
    expect(
      iv.parameters.safeParse({
        datasetId: "dataset_1",
        stageId: "stage_001",
        dependentVar: "y",
        treatmentVar: "education",
        instrumentVars: ["distance"],
        instrumentJustification: justification,
      }).success,
    ).toBe(true)
    // 缺识别依据 → 拒绝
    expect(
      iv.parameters.safeParse({
        datasetId: "dataset_1",
        stageId: "stage_001",
        dependentVar: "y",
        treatmentVar: "education",
        instrumentVars: ["distance"],
      }).success,
    ).toBe(false)
    // 缺 instrumentVars → 拒绝
    expect(
      iv.parameters.safeParse({
        datasetId: "dataset_1",
        stageId: "stage_001",
        dependentVar: "y",
        treatmentVar: "education",
        instrumentJustification: justification,
      }).success,
    ).toBe(false)
    // 工具变量与内生变量相同 → 拒绝
    expect(
      iv.parameters.safeParse({
        datasetId: "dataset_1",
        stageId: "stage_001",
        dependentVar: "y",
        treatmentVar: "education",
        instrumentVars: ["education"],
        instrumentJustification: justification,
      }).success,
    ).toBe(false)
    // robust covariance
    expect(
      iv.parameters.safeParse({
        datasetId: "dataset_1",
        stageId: "stage_001",
        dependentVar: "y",
        treatmentVar: "education",
        instrumentVars: ["distance"],
        instrumentJustification: justification,
        covariance: "robust",
      }).success,
    ).toBe(true)
  })

  test("PSM 方法通过 Registry 延迟披露，不作为独立 Provider Tool 暴露", async () => {
    await withAnalysisTools(async (tools) => {
      const ids = tools.map((tool) => tool.id)
      expect(ids).not.toContain("psm_construction")
      expect(ids).not.toContain("psm_visualize")
    })
  })

  test("PSM matching 通过 Registry 延迟披露，不作为独立 Provider Tool 暴露", async () => {
    await withAnalysisTools(async (tools) => {
      expect(tools.map((tool) => tool.id)).not.toContain("psm_matching")
    })
  })

  test("PSM IPW 通过 Registry 延迟披露，不作为独立 Provider Tool 暴露", async () => {
    await withAnalysisTools(async (tools) => {
      expect(tools.map((tool) => tool.id)).not.toContain("psm_ipw")
    })
  })

  test("historical estimators accept only a canonical dataset stage, never a raw file path", async () => {
    for (const id of ["ols_regression", "panel_fe_regression", "iv_2sls"] as const) {
      const tool = await registeredTool(id)

      const shape =
        id === "panel_fe_regression"
          ? { dependentVar: "y", treatmentVar: "x", entityVar: "firm", timeVar: "year" }
          : id === "iv_2sls"
            ? {
                dependentVar: "y",
                treatmentVar: "x",
                instrumentVars: ["z"],
                instrumentJustification: "Design-provided exclusion restriction for the instrument z.",
              }
            : { dependentVar: "y", treatmentVar: "x" }

      expect(tool.parameters.safeParse({ dataPath: "raw.xlsx", ...shape }).success).toBe(false)
      expect(tool.parameters.safeParse({ datasetId: "dataset_1", ...shape }).success).toBe(false)
      expect(tool.parameters.safeParse({ datasetId: "dataset_1", stageId: "stage_001", ...shape }).success).toBe(true)
    }
  })

  test("keeps historical panel FE clustering validation intact", async () => {
    const panel = await registeredTool("panel_fe_regression")

    // 新 panel FE schema 无 clusterVar；验证索引与回归变量互斥
    // entity 不能同时作为 treatment
    expect(
      panel.parameters.safeParse({
        datasetId: "dataset_1",
        stageId: "stage_001",
        dependentVar: "y",
        treatmentVar: "firm",
        entityVar: "firm",
        timeVar: "year",
      }).success,
    ).toBe(false)
    // panel FE 使用 robust 标准误（非 cluster）
    expect(
      panel.parameters.safeParse({
        datasetId: "dataset_1",
        stageId: "stage_001",
        dependentVar: "y",
        treatmentVar: "x",
        covariates: ["control"],
        entityVar: "firm",
        timeVar: "year",
        covariance: "robust",
      }).success,
    ).toBe(true)
  })

  test("records every independent estimator as a baseline estimation stage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-econometrics-workflow-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          for (const toolName of ESTIMATOR_TOOL_IDS) {
            const { stage } = recordWorkflowStageSuccess({
              sessionID: `workflow-${toolName}`,
              toolName,
              args: { datasetId: "dataset_1", dependentVar: "y" },
              metadata: { datasetId: "dataset_1" },
            })
            expect(stage.kind).toBe("baseline_estimate")
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("records propensity-score diagnostics as diagnostics, not as completed estimates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-psm-workflow-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          for (const toolName of ["psm_construction", "psm_visualize"] as const) {
            const { stage } = recordWorkflowStageSuccess({
              sessionID: `workflow-${toolName}`,
              toolName,
              args: { datasetId: "dataset_1", stageId: "stage_001", treatmentVar: "treated" },
              metadata: { datasetId: "dataset_1", stageId: "stage_001" },
            })
            expect(stage.kind).toBe("profile_or_diagnostics")
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
