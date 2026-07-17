import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"

const SAFE_ECONOMETRICS_TOOL_IDS = [
  "econometrics_recommend",
  "psm_construction",
  "psm_visualize",
  "psm_matching",
  "psm_ipw",
  "ols_regression",
  "panel_fe_regression",
  "iv_2sls",
  "hdfe_regression",
  "did_static",
  "did2s",
  "did_event_study_saturated",
] as const

const ESTIMATOR_TOOL_IDS = SAFE_ECONOMETRICS_TOOL_IDS.filter(
  (toolName) => !(["econometrics_recommend", "psm_construction", "psm_visualize"] as string[]).includes(toolName),
)

async function withAnalysisTools<T>(fn: (tools: Awaited<ReturnType<typeof ToolRegistry.tools>>) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-econometrics-tools-"))
  try {
    return await Instance.provide({
      directory: root,
      fn: async () => {
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
        return fn(tools)
      },
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("model-visible econometrics tools", () => {
  test("exposes one strict tool per production method and hides the legacy dispatcher", async () => {
    await withAnalysisTools(async (tools) => {
      const ids = tools.map((tool) => tool.id)

      for (const id of SAFE_ECONOMETRICS_TOOL_IDS) expect(ids).toContain(id)
      expect(ids).not.toContain("econometrics")
    })
  })

  test("rejects ambiguous data sources and arbitrary legacy options before execution", async () => {
    await withAnalysisTools(async (tools) => {
      const ols = tools.find((tool) => tool.id === "ols_regression")
      expect(ols).toBeDefined()
      if (!ols) return

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
  })

  test("requires an explicit instrument and identification rationale for IV2SLS", async () => {
    await withAnalysisTools(async (tools) => {
      const iv = tools.find((tool) => tool.id === "iv_2sls")
      expect(iv).toBeDefined()
      if (!iv) return

      expect(
        iv.parameters.safeParse({
          datasetId: "dataset_1",
          stageId: "stage_001",
          dependentVar: "y",
          endogenousVar: "education",
          instrumentVar: "distance",
        }).success,
      ).toBe(false)
      expect(
        iv.parameters.safeParse({
          datasetId: "dataset_1",
          stageId: "stage_001",
          dependentVar: "y",
          endogenousVar: "education",
          instrumentVar: "distance",
          instrumentJustification: "Distance changes schooling cost and is supplied by the user as the proposed instrument.",
        }).success,
      ).toBe(true)
      expect(
        iv.parameters.safeParse({
          datasetId: "dataset_1",
          stageId: "stage_001",
          dependentVar: "y",
          endogenousVar: "education",
          instrumentVar: "distance",
          instrumentJustification: "Distance changes schooling cost and is supplied by the user as the proposed instrument.",
          covariance: "HC2",
        }).success,
      ).toBe(false)
      expect(
        iv.parameters.safeParse({
          datasetId: "dataset_1",
          stageId: "stage_001",
          dependentVar: "y",
          endogenousVar: "education",
          instrumentVar: "distance",
          instrumentJustification: "Distance changes schooling cost and is supplied by the user as the proposed instrument.",
          covariance: "robust",
        }).success,
      ).toBe(true)
    })
  })

  test("exposes propensity-score construction and visualization as strict diagnostic tools", async () => {
    await withAnalysisTools(async (tools) => {
      for (const toolID of ["psm_construction", "psm_visualize"]) {
        const propensity = tools.find((tool) => tool.id === toolID)
        expect(propensity).toBeDefined()
        if (!propensity) continue

        expect(
          propensity.parameters.safeParse({
            datasetId: "dataset_1",
            stageId: "stage_001",
            treatmentVar: "treated",
            covariates: ["age", "income"],
          }).success,
        ).toBe(true)
        for (const invalid of [
          {
            datasetId: "dataset_1",
            stageId: "stage_001",
            treatmentVar: "treated",
            covariates: [],
          },
          {
            datasetId: "dataset_1",
            stageId: "stage_001",
            treatmentVar: "treated",
            covariates: ["treated"],
          },
          {
            datasetId: "dataset_1",
            stageId: "stage_001",
            treatmentVar: "treated",
            covariates: ["age", "age"],
          },
          {
            datasetId: "dataset_1",
            stageId: "stage_001",
            treatmentVar: "treated",
            covariates: ["age"],
            dependentVar: "outcome",
          },
          {
            dataPath: "raw.xlsx",
            treatmentVar: "treated",
            covariates: ["age"],
          },
        ]) {
          expect(propensity.parameters.safeParse(invalid).success).toBe(false)
        }
      }
    })
  })

  test("exposes PSM matching as a strict ATT estimator without free matching controls", async () => {
    await withAnalysisTools(async (tools) => {
      const matching = tools.find((tool) => tool.id === "psm_matching")
      expect(matching).toBeDefined()
      if (!matching) return

      const valid = {
        datasetId: "dataset_1",
        stageId: "stage_001",
        dependentVar: "re78",
        treatmentVar: "treat",
        covariates: ["age", "education"],
        analysisUnitVar: "person_id",
        preTreatmentAggregation: "not_applicable",
      }
      expect(matching.parameters.safeParse(valid).success).toBe(true)
      for (const invalid of [
        { ...valid, covariates: ["treat"] },
        { ...valid, covariates: ["age", "age"] },
        { ...valid, analysisUnitVar: undefined },
        { ...valid, preTreatmentAggregation: undefined },
        { ...valid, matchingRatio: 2 },
        { ...valid, caliper: 0.5 },
        { ...valid, targetType: "ATE" },
        { ...valid, outputDir: "/tmp/model-owned" },
      ]) {
        expect(matching.parameters.safeParse(invalid).success).toBe(false)
      }
    })
  })

  test("exposes IPW as a strict fixed ATE estimator without weight tuning controls", async () => {
    await withAnalysisTools(async (tools) => {
      const ipw = tools.find((tool) => tool.id === "psm_ipw")
      expect(ipw).toBeDefined()
      if (!ipw) return

      const valid = {
        datasetId: "dataset_1",
        stageId: "stage_001",
        dependentVar: "re78",
        treatmentVar: "treat",
        covariates: ["age", "education"],
        analysisUnitVar: "person_id",
        preTreatmentAggregation: "not_applicable",
      }
      expect(ipw.parameters.safeParse(valid).success).toBe(true)
      for (const invalid of [
        { ...valid, covariates: ["treat"] },
        { ...valid, covariates: ["age", "age"] },
        { ...valid, analysisUnitVar: undefined },
        { ...valid, preTreatmentAggregation: undefined },
        { ...valid, targetType: "ATT" },
        { ...valid, trim: 0.05 },
        { ...valid, weightFormula: "stabilized" },
        { ...valid, outputDir: "/tmp/model-owned" },
      ]) {
        expect(ipw.parameters.safeParse(invalid).success).toBe(false)
      }
    })
  })

  test("estimators accept only a canonical dataset stage, never a raw file path", async () => {
    await withAnalysisTools(async (tools) => {
      for (const id of ["ols_regression", "panel_fe_regression", "iv_2sls"] as const) {
        const tool = tools.find((candidate) => candidate.id === id)
        expect(tool).toBeDefined()
        if (!tool) continue

        const shape =
          id === "panel_fe_regression"
            ? { dependentVar: "y", treatmentVar: "x", entityVar: "firm", timeVar: "year" }
            : id === "iv_2sls"
              ? {
                  dependentVar: "y",
                  endogenousVar: "x",
                  instrumentVar: "z",
                  instrumentJustification: "The user supplied a design-based relevance and exclusion argument.",
                }
              : { dependentVar: "y", treatmentVar: "x" }

        expect(tool.parameters.safeParse({ dataPath: "raw.xlsx", ...shape }).success).toBe(false)
        expect(tool.parameters.safeParse({ datasetId: "dataset_1", ...shape }).success).toBe(false)
        expect(tool.parameters.safeParse({ datasetId: "dataset_1", stageId: "stage_001", ...shape }).success).toBe(true)
      }
    })
  })

  test("rejects an outcome or regressor column as the panel clustering variable", async () => {
    await withAnalysisTools(async (tools) => {
      const panel = tools.find((tool) => tool.id === "panel_fe_regression")
      expect(panel).toBeDefined()
      if (!panel) return

      for (const clusterVar of ["y", "x", "control"]) {
        expect(
          panel.parameters.safeParse({
            datasetId: "dataset_1",
            stageId: "stage_001",
            dependentVar: "y",
            treatmentVar: "x",
            covariates: ["control"],
            entityVar: "firm",
            timeVar: "year",
            clusterVar,
          }).success,
        ).toBe(false)
      }

      expect(
        panel.parameters.safeParse({
          datasetId: "dataset_1",
          stageId: "stage_001",
          dependentVar: "y",
          treatmentVar: "x",
          covariates: ["control"],
          entityVar: "firm",
          timeVar: "year",
          clusterVar: "firm",
        }).success,
      ).toBe(true)
    })
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
            expect(stage.kind).toBe("describe_or_diagnostics")
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
