import { describe, expect, test } from "bun:test"
import {
  WORKFLOW_ESTIMATE_TOOL_IDS,
  WORKFLOW_INPUT_INTENT_TOOL_BUNDLES,
  WORKFLOW_KNOWN_TOOL_IDS,
} from "@/runtime/tool-catalog"
import { toolExecutionTraits } from "@/runtime/tool-policy"
import { allowMcpToolForWorkflow, explainMcpToolForWorkflow, resolveToolAvailability } from "@/runtime/workflow"

describe("runtime tool policy", () => {
  test("workflow tool catalog uses real todo ids and has no duplicate known ids", () => {
    const known = [...WORKFLOW_KNOWN_TOOL_IDS]

    expect(known).toContain("todoread")
    expect(known).not.toContain("todo_read")
    expect(new Set(known).size).toBe(known.length)

    for (const bundle of Object.values(WORKFLOW_INPUT_INTENT_TOOL_BUNDLES)) {
      expect(bundle).not.toContain("todo_read")
    }
  })

  test("a new analysis workflow exposes intake only, not estimators or coding tools", () => {
    for (const toolID of ["edit", "write", "batch", "lsp", "plan_enter", "plan_exit"]) {
      expect(WORKFLOW_KNOWN_TOOL_IDS).not.toContain(toolID)
    }

    const available = resolveToolAvailability({
      policy: {
        inputIntent: "analysis",
        platformCapabilities: { mcp: false, images: false, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: false },
      },
      toolIDs: ["bash", "shell", "data_import", "data_batch", "ols_regression", "panel_fe_regression"],
    })

    expect(available.directToolIDs).toContain("data_import")
    expect(available.deferredToolIDs).toContain("ols_regression")
    expect(available.directToolIDs).not.toContain("ols_regression")
    expect(available.directToolIDs).not.toContain("bash")
    expect(available.directToolIDs).not.toContain("shell")
    expect(available.directToolIDs).not.toContain("data_batch")
  })

  test("exposes recommendation after import and estimators only after the QA gate", () => {
    const toolIDs = [
      "read",
      "workflow",
      "data_import",
      "econometrics_recommend",
      "ols_regression",
      "panel_fe_regression",
    ]
    const basePolicy = {
      inputIntent: "analysis" as const,
      workflowMode: "econometrics" as const,
      platformCapabilities: { mcp: false, images: false, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: false },
    }

    const profile = resolveToolAvailability({
      policy: { ...basePolicy, currentStage: "profile_or_schema_check" },
      toolIDs,
    })
    expect(profile.directToolIDs).toContain("econometrics_recommend")
    expect(profile.directToolIDs).not.toContain("ols_regression")

    const qa = resolveToolAvailability({
      policy: { ...basePolicy, currentStage: "qa_gate" },
      toolIDs,
    })
    expect(qa.directToolIDs).toContain("data_import")
    expect(qa.directToolIDs).not.toContain("ols_regression")

    const ready = resolveToolAvailability({
      policy: { ...basePolicy, currentStage: "preprocess_or_filter" },
      toolIDs,
    })
    expect(ready.directToolIDs).toContain("ols_regression")
    expect(ready.directToolIDs).toContain("panel_fe_regression")
  })

  test("exposes each production estimator as its own analysis tool", () => {
    expect(WORKFLOW_ESTIMATE_TOOL_IDS).toEqual([
      "psm_matching",
      "psm_ipw",
      "ols_regression",
      "panel_fe_regression",
      "iv_2sls",
      "hdfe_regression",
      "did_static",
      "did2s",
      "did_event_study_saturated",
    ])

    for (const toolID of WORKFLOW_ESTIMATE_TOOL_IDS) {
      expect(WORKFLOW_INPUT_INTENT_TOOL_BUNDLES.analysis).toContain(toolID)
      expect(toolExecutionTraits(toolID).sideEffectLevel).toBe("filesystem")
    }
  })

  test("workflow action controls side-effect traits", () => {
    expect(toolExecutionTraits("workflow", { action: "status" })).toMatchObject({
      concurrencySafe: true,
      sideEffectLevel: "none",
    })
    expect(toolExecutionTraits("workflow", { action: "diagnostics" })).toMatchObject({
      concurrencySafe: true,
      sideEffectLevel: "none",
    })
    expect(toolExecutionTraits("workflow", { action: "verify" })).toMatchObject({
      concurrencySafe: false,
      sideEffectLevel: "external",
    })
    expect(toolExecutionTraits("workflow", { action: "restore" })).toMatchObject({
      concurrencySafe: false,
      sideEffectLevel: "session",
    })
    expect(toolExecutionTraits("workflow", { action: "rerun" })).toMatchObject({
      concurrencySafe: false,
      sideEffectLevel: "filesystem",
    })
  })


  test("mcp gating allows only safe non-Stata sidecars after core workflow stages", () => {
    const safePolicy = {
      currentStage: "baseline_estimate" as const,
      platformCapabilities: { mcp: true, images: true, remote: false },
      modelCapabilities: { supportsTools: true, supportsImages: true },
    }

    expect(allowMcpToolForWorkflow({ toolName: "safe_search", policy: safePolicy })).toBe(true)
    expect(allowMcpToolForWorkflow({ toolName: "browser_fetch", policy: safePolicy })).toBe(true)
    expect(allowMcpToolForWorkflow({ toolName: "stata_run", policy: safePolicy })).toBe(false)
    expect(allowMcpToolForWorkflow({ toolName: "context7_docs", policy: safePolicy })).toBe(false)
    expect(allowMcpToolForWorkflow({ toolName: "github_create_issue", policy: safePolicy })).toBe(false)
    expect(allowMcpToolForWorkflow({ toolName: "opaque_tool", policy: safePolicy })).toBe(false)

    const mutatingSidecar = explainMcpToolForWorkflow({
      toolName: "github_create_issue",
      policy: safePolicy,
    })
    expect(mutatingSidecar.reasons.join("\n")).toContain("read-only lookup/search/status")

    const early = explainMcpToolForWorkflow({
      toolName: "safe_search",
      policy: { ...safePolicy, currentStage: "import" },
    })
    expect(early.available).toBe(false)
    expect(early.reasons.join("\n")).toContain("early data-readiness")
  })

  test("ingest intent exposes data import tools before a workflow stage exists", () => {
    const available = resolveToolAvailability({
      policy: {
        inputIntent: "ingest",
        platformCapabilities: { mcp: true, images: true, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: true },
      },
      toolIDs: ["read", "workflow", "data_import", "econometrics"],
    })

    expect(available.directToolIDs).toContain("data_import")
    expect(available.deferredToolIDs).toContain("econometrics")
  })

  test("conversation never inherits tools from an unfinished analysis workflow", () => {
    const available = resolveToolAvailability({
      policy: {
        inputIntent: "conversation",
        currentStage: "import",
        currentStageStatus: "blocked",
        repairOnly: true,
        platformCapabilities: { mcp: true, images: true, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: true },
      },
      toolIDs: ["read", "workflow", "data_import", "econometrics"],
    })

    expect(available.directToolIDs).toEqual([])
    expect(allowMcpToolForWorkflow({
      toolName: "safe_search",
      policy: { inputIntent: "conversation", currentStage: "baseline_estimate" },
    })).toBe(false)
  })

  test("automatic repair exposes only the failed estimator plus read-only inspection tools", () => {
    const available = resolveToolAvailability({
      policy: {
        inputIntent: "repair",
        currentStage: "baseline_estimate",
        currentStageStatus: "failed",
        repairOnly: true,
        repairToolName: "ols_regression",
        platformCapabilities: { mcp: false, images: false, remote: false },
        modelCapabilities: { supportsTools: true, supportsImages: false },
      },
      toolIDs: ["read", "data_import", "ols_regression", "panel_fe_regression", "iv_2sls"],
    })

    expect(available.directToolIDs).toContain("read")
    expect(available.directToolIDs).toContain("ols_regression")
    expect(available.directToolIDs).not.toContain("panel_fe_regression")
    expect(available.directToolIDs).not.toContain("iv_2sls")
    expect(available.directToolIDs).not.toContain("data_import")
  })
})
