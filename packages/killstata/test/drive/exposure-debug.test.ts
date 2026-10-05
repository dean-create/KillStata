import { describe, expect, test } from "bun:test"
import { resolveToolAvailability } from "@/runtime/workflow"
import type { ToolAvailabilityPolicy } from "@/runtime/types"
import { WORKFLOW_INPUT_INTENT_TOOL_BUNDLES } from "@/runtime/tool-catalog"

describe("first-turn exposure for did-direct", () => {
  test("analysis intent with no stage → importBundle (has data_import)", () => {
    const policy: ToolAvailabilityPolicy = {
      sessionID: "s1",
      agent: "analyst",
      inputIntent: "analysis",
      approvalStatus: "approved",
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: true },
    }
    const res = resolveToolAvailability({ policy, toolIDs: ["data_import", "read", "pipeline", "question", "ols_regression"] })
    console.log("allowed:", res.allowedToolIDs)
    expect(res.allowedToolIDs).toContain("data_import")
  })
  test("intent bundles: analysis has data_import", () => {
    console.log("analysis bundle:", WORKFLOW_INPUT_INTENT_TOOL_BUNDLES.analysis)
    expect(WORKFLOW_INPUT_INTENT_TOOL_BUNDLES.analysis).toContain("data_import")
  })
})
