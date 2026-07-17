import { describe, expect, test } from "bun:test"
import { scorePanelFeModelCall } from "./src/live"

const expectedArgs = {
  dependentVar: "经济发展水平",
  treatmentVar: "did",
  covariates: ["人口密度", "金融发展程度"],
  entityVar: "city",
  timeVar: "year",
  clusterVar: "city",
}

describe("DeepSeek replay scorer", () => {
  test("permits execution only for the expected tool and exact variable roles", () => {
    expect(
      scorePanelFeModelCall({ toolName: "panel_fe_regression", input: expectedArgs }, expectedArgs),
    ).toEqual({ accepted: true, violations: [] })
  })

  test("blocks a neighboring estimator even when its JSON is otherwise valid", () => {
    expect(scorePanelFeModelCall({ toolName: "hdfe_regression", input: expectedArgs }, expectedArgs)).toEqual({
      accepted: false,
      violations: ["wrong_tool"],
    })
  })
})
