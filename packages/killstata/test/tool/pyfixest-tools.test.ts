import { describe, expect, test } from "bun:test"
import z from "zod"
import {
  Did2sTool,
  DidStaticTool,
  HdfeRegressionTool,
  resolveDidCluster,
  resolveHdfeCovariance,
  SaturatedDidEventStudyTool,
} from "../../src/tool/pyfixest"

describe("PyFixest tool contracts", () => {
  test("defines four independent model-facing tools", () => {
    expect(HdfeRegressionTool.id).toBe("hdfe_regression")
    expect(DidStaticTool.id).toBe("did_static")
    expect(Did2sTool.id).toBe("did2s")
    expect(SaturatedDidEventStudyTool.id).toBe("did_event_study_saturated")
  })

  test("keeps every model-facing contract representable as an object JSON schema", async () => {
    for (const tool of [HdfeRegressionTool, DidStaticTool, Did2sTool, SaturatedDidEventStudyTool]) {
      const initialized = await tool.init()
      const schema = z.toJSONSchema(initialized.parameters, { unrepresentable: "any" }) as {
        type?: string
        properties?: Record<string, unknown>
      }
      expect(schema.type).toBe("object")
      expect(Object.keys(schema.properties ?? {})).toContain("dependentVar")
    }
  })

  test("requires explicit group and post variables for traditional DID", async () => {
    const tool = await DidStaticTool.init()
    const parsed = tool.parameters.parse({
      datasetId: "did_123",
      stageId: "stage_000",
      dependentVar: "fte",
      groupVar: "treated",
      postVar: "t",
      covariates: ["bk", "kfc", "roys"],
    })

    expect(parsed.covariance).toBe("HC1")
    expect(tool.parameters.safeParse({
      datasetId: "did_123",
      stageId: "stage_000",
      dependentVar: "fte",
      groupVar: "treated",
      postVar: "treated",
    }).success).toBe(false)
    expect(tool.parameters.safeParse({
      datasetId: "did_123",
      stageId: "stage_000",
      dependentVar: "fte",
      groupVar: "treated",
      postVar: "t",
      formula: "fte ~ treated * t",
    }).success).toBe(false)
  })

  test("derives HDFE covariance from the declared clustering design", async () => {
    const tool = await HdfeRegressionTool.init()

    const heteroskedastic = tool.parameters.parse({
      datasetId: "panel_123",
      stageId: "stage_000",
      dependentVar: "y",
      treatmentVar: "x",
      fixedEffects: ["firm", "year"],
    })
    const clustered = tool.parameters.parse({
      datasetId: "panel_123",
      stageId: "stage_000",
      dependentVar: "y",
      treatmentVar: "x",
      fixedEffects: ["firm", "year"],
      clusterVars: ["firm", "year"],
    })

    expect(resolveHdfeCovariance(heteroskedastic)).toBe("HC1")
    expect(resolveHdfeCovariance(clustered)).toBe("CRV1")
  })

  test("rejects ambiguous HDFE data sources and unsupported cluster designs before execution", async () => {
    const tool = await HdfeRegressionTool.init()

    expect(tool.parameters.safeParse({
      dataPath: "panel.csv",
      datasetId: "panel_123",
      dependentVar: "y",
      treatmentVar: "x",
      fixedEffects: ["firm"],
    }).success).toBe(false)
    expect(tool.parameters.safeParse({
      dataPath: "panel.csv",
      dependentVar: "y",
      treatmentVar: "x",
      fixedEffects: ["firm"],
      clusterVars: ["firm", "year", "region"],
    }).success).toBe(false)
    expect(tool.parameters.safeParse({
      datasetId: "panel_123",
      dependentVar: "y",
      treatmentVar: "x",
      fixedEffects: ["firm"],
    }).success).toBe(false)
    expect(tool.parameters.safeParse({
      datasetId: "panel_123",
      stageId: "stage_000",
      dependentVar: "y",
      treatmentVar: "x",
      fixedEffects: ["firm"],
    }).success).toBe(true)
  })

  test("requires the full DID2S design instead of accepting a free-form formula", async () => {
    const tool = await Did2sTool.init()
    const valid = tool.parameters.parse({
      datasetId: "panel_123",
      stageId: "stage_000",
      dependentVar: "outcome",
      treatmentVar: "treated",
      relativeTimeVar: "event_time",
      entityVar: "firm",
      timeVar: "year",
    })

    expect(resolveDidCluster(valid.entityVar, valid.clusterVar)).toBe("firm")
    expect(valid.referencePeriod).toBe(-1)
    expect(tool.parameters.safeParse({
      dataPath: "panel.csv",
      dependentVar: "outcome",
      treatmentVar: "treated",
      entityVar: "firm",
      timeVar: "year",
      formula: "outcome ~ treated | firm + year",
    }).success).toBe(false)
  })

  test("uses a cohort variable for the saturated event study", async () => {
    const tool = await SaturatedDidEventStudyTool.init()
    const parsed = tool.parameters.parse({
      datasetId: "panel_123",
      stageId: "stage_000",
      dependentVar: "outcome",
      cohortVar: "first_treat_year",
      entityVar: "firm",
      timeVar: "year",
    })

    expect(resolveDidCluster(parsed.entityVar, parsed.clusterVar)).toBe("firm")
    expect(tool.parameters.safeParse({
      datasetId: "panel_123",
      stageId: "stage_000",
      dependentVar: "outcome",
      cohortVar: "first_treat_year",
      entityVar: "firm",
      timeVar: "year",
      covariates: ["size"],
    }).success).toBe(false)
    expect(tool.parameters.safeParse({
      datasetId: "panel_123",
      stageId: "stage_000",
      dependentVar: "outcome",
      cohortVar: "first_treat_year",
      entityVar: "firm",
      timeVar: "year",
      aggregateAtt: true,
    }).success).toBe(false)
    expect(tool.parameters.safeParse({
      dataPath: "panel.csv",
      dependentVar: "outcome",
      treatmentVar: "treated",
      entityVar: "firm",
      timeVar: "year",
    }).success).toBe(false)
  })
})
