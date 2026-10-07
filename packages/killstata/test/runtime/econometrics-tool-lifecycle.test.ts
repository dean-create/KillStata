import { describe, expect, test } from "bun:test"
import { WORKFLOW_ANALYSIS_TOOL_IDS } from "@/runtime/tool-catalog"
import { isVerifierReadableArtifactRef, isWorkflowArtifactRef } from "@/runtime/workflow"
import { isFinalAnalysisResultTool } from "@/runtime/turn-assembler"
import { retryStageForToolFailure } from "@/tool/analysis-reflection"

describe("independent econometrics tool lifecycle", () => {
  test("every model-visible econometrics tool can trigger a visible fallback result", () => {
    for (const toolID of WORKFLOW_ANALYSIS_TOOL_IDS) {
      expect(isFinalAnalysisResultTool(toolID)).toBe(true)
    }
  })

  test("admitted estimator failures retry the estimation stage instead of falling through to verification", () => {
    for (const toolName of ["psm_matching", "psm_ipw", "psm_regression", "psm_double_robust", "did2s"]) {
      expect(retryStageForToolFailure(toolName, "estimation_failure")).toBe("estimate")
    }
  })

  test("recommendation failures return to profiling", () => {
    expect(retryStageForToolFailure("econometrics_recommend", "schema_mismatch")).toBe("profile")
  })

  test("propensity-score diagnostic failures return to profile or QA instead of pretending estimation completed", () => {
    for (const toolName of ["psm_construction", "psm_visualize"]) {
      expect(retryStageForToolFailure(toolName, "column_not_found")).toBe("profile")
      expect(retryStageForToolFailure(toolName, "validate_blocked")).toBe("validate")
      expect(retryStageForToolFailure(toolName, "estimation_failure")).toBe("validate")
    }
  })

  test("keeps PNG diagnostics as workflow artifacts without feeding binary files to the verifier", () => {
    expect(isWorkflowArtifactRef("analysis/psm_visualize/ps_distribution.png", "plot_path")).toBe(true)
    expect(isVerifierReadableArtifactRef("analysis/psm_visualize/ps_distribution.png")).toBe(false)
  })
})
