import { describe, expect, test } from "bun:test"
import { PanelFeRegressionTool } from "@/tool/econometrics-method-tools"
import { Did2sTool } from "@/tool/pyfixest"
import {
  loadRoutingFixtures,
  scoreCapturedRouting,
  type RoutingFixture,
  type ToolSchemaInfo,
} from "../../script/real-paper-tool-routing-calibration"

async function toolMap(): Promise<Map<string, ToolSchemaInfo>> {
  const panel = await PanelFeRegressionTool.init()
  const did2s = await Did2sTool.init()
  return new Map<string, ToolSchemaInfo>([
    ["panel_fe_regression", panel],
    ["did2s", did2s],
  ])
}

describe("DeepSeek routing calibration scorer", () => {
  test("loads every real-paper intent without provider access", () => {
    const fixtures = loadRoutingFixtures()
    expect(fixtures.length).toBeGreaterThanOrEqual(14)
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length)
  })

  test("accepts the exact fixed-effect call and its strict parameters", async () => {
    const fixture = loadRoutingFixtures().find((item) => item.id === "did-fe-baseline")!
    const scored = scoreCapturedRouting({
      fixture,
      call: { toolName: fixture.expectedTool!, input: JSON.stringify(fixture.expectedArgs) },
      tools: await toolMap(),
    })
    expect(scored.exactTool).toBe(true)
    expect(scored.schemaValid).toBe(true)
    expect(scored.requiredArgsMatch).toBe(true)
    expect(scored.violations).toEqual([])
  })

  test("classifies unknown, malformed, missing-stage and extra-key calls", async () => {
    const fixture = loadRoutingFixtures().find((item) => item.id === "did-fe-baseline")!
    const tools = await toolMap()

    const unknown = scoreCapturedRouting({
      fixture,
      call: { toolName: "econometrics", input: fixture.expectedArgs },
      tools,
    })
    expect(unknown.violations).toContain("unknown_tool")
    expect(unknown.violations).toContain("wrong_tool")

    for (const input of [
      "{not-json",
      { ...fixture.expectedArgs, stageId: undefined },
      { ...fixture.expectedArgs, methodName: "panel_fe_regression" },
    ]) {
      const scored = scoreCapturedRouting({
        fixture,
        call: { toolName: "panel_fe_regression", input },
        tools,
      })
      expect(scored.schemaValid).toBe(false)
      expect(scored.violations).toContain("schema_invalid")
      expect(scored.violations).toContain("argument_mismatch")
    }
  })

  test("marks a schema-valid but semantically forbidden modern-DID call", async () => {
    const fixture = loadRoutingFixtures().find((item) => item.id === "did-raw-cohort-event-study")!
    const unsafeInput = {
      datasetId: "did_real",
      stageId: "stage_imported",
      dependentVar: "经济发展水平",
      treatmentVar: "did",
      relativeTimeVar: "time",
      entityVar: "city",
      timeVar: "year",
      clusterVar: "city",
      covariates: [],
      referencePeriod: -1,
    }
    const scored = scoreCapturedRouting({
      fixture,
      call: { toolName: "did2s", input: unsafeInput },
      tools: await toolMap(),
    })
    expect(scored.schemaValid).toBe(true)
    expect(scored.forbiddenSelected).toBe(true)
    expect(scored.violations).toContain("forbidden_tool")
  })

  test("a clarification with no tool call is clean when prerequisites are missing", async () => {
    const fixture: RoutingFixture = {
      id: "missing-design",
      dataset: "did.xlsx/Data_原始编码",
      prompt: "自动挑工具变量",
      decision: "clarify",
      forbiddenTools: ["iv_2sls"],
      requiredGuidance: ["工具变量"],
    }
    const scored = scoreCapturedRouting({
      fixture,
      responseText: "请明确工具变量并说明排除限制。",
      tools: await toolMap(),
    })
    expect(scored.exactTool).toBe(true)
    expect(scored.violations).toEqual([])
    expect(scored.guidanceCoverage[0]).toEqual({ phrase: "工具变量", present: true })
  })
})
