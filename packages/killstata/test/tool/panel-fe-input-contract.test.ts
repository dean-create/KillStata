import { describe, expect, test } from "bun:test"
import { PanelFeTool } from "../fixtures/legacy/tool/panel-fe"

describe("panel_fe_regression input contract", () => {
  test("treats blank optional routing and clustering fields as omitted", async () => {
    const tool = await PanelFeTool.init()
    const parsed = tool.parameters.parse({
      datasetId: "dataset_1",
      stageId: "stage_001",
      runId: "  ",
      branch: "",
      dependentVar: "y",
      treatmentVar: "x",
      covariates: [],
      entityVar: "firm",
      timeVar: "year",
      clusterVar: " ",
      covariance: "clustered",
    })

    expect(parsed.runId).toBeUndefined()
    expect(parsed.branch).toBeUndefined()
    expect(parsed.clusterVar).toBeUndefined()
    expect(parsed.entityVar).toBe("firm")
  })

  test("still rejects blank required model variables", async () => {
    const tool = await PanelFeTool.init()
    expect(tool.parameters.safeParse({
      datasetId: "dataset_1",
      stageId: "stage_001",
      dependentVar: "",
      treatmentVar: "x",
      covariates: [],
      entityVar: "firm",
      timeVar: "year",
    }).success).toBe(false)
  })
})
