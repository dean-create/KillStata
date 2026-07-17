import { PanelFeRegressionTool } from "../../packages/killstata/src/tool/econometrics-method-tools"

export async function validatePanelFeNegativeCase() {
  const tool = await PanelFeRegressionTool.init()
  const parsed = tool.parameters.safeParse({
    datasetId: "did_real_panel",
    stageId: "stage_qa_passed",
    dependentVar: "did",
    treatmentVar: "did",
    covariates: ["人口密度"],
    entityVar: "city",
    timeVar: "year",
    clusterVar: "city",
  })
  const executorCalls = 0
  if (parsed.success) return { schemaAccepted: true, executorCalls, message: "参数意外通过" }
  const message = tool.formatValidationError
    ? tool.formatValidationError(parsed.error)
    : parsed.error.issues.map((issue) => issue.message).join("；")
  return { schemaAccepted: false, executorCalls, message }
}
