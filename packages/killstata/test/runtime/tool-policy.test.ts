import { describe, expect, test } from "bun:test"
import {
  WORKFLOW_INPUT_INTENT_TOOL_BUNDLES,
  WORKFLOW_KNOWN_TOOL_IDS,
} from "@/runtime/tool-catalog"
import { toolExecutionTraits } from "@/runtime/tool-policy"
import { allowMcpToolForWorkflow, explainMcpToolForWorkflow, resolveToolAvailability } from "@/runtime/workflow"
import { validateBatchableToolCall } from "@/tool/batch"

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

  test("batch only accepts read-only tool calls", () => {
    expect(() => validateBatchableToolCall("read", { filePath: "README.md" })).not.toThrow()
    expect(() => validateBatchableToolCall("workflow", { action: "tools" })).not.toThrow()

    expect(() => validateBatchableToolCall("data_import", { action: "import" })).toThrow(/not safe for batch/)
    expect(() => validateBatchableToolCall("workflow", { action: "rerun" })).toThrow(/not safe for batch/)
    expect(() => validateBatchableToolCall("batch", {})).toThrow(/not allowed in batch/)
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
      toolIDs: ["read", "workflow", "data_import", "data_batch", "econometrics"],
    })

    expect(available.directToolIDs).toContain("data_import")
    expect(available.directToolIDs).toContain("data_batch")
    expect(available.deferredToolIDs).toContain("econometrics")
  })
})
