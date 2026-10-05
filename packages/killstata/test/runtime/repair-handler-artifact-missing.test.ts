import { describe, expect, test } from "bun:test"
import { applyRepairHandler } from "@/runtime/workflow"
import type { StageFailureCode, StageFailureRecord } from "@/runtime/types"

/**
 * ARTIFACT_MISSING 修复提示归因修复（2026-07-21）：
 *   真实会话复现：用户在 baseline_estimate 阶段估 panel_fe_regression，缺
 *   profile 产物，门禁提示 "请先分析数据结构"（属 profile_or_schema_check）；
 *   但修复提示走 ARTIFACT_MISSING handler，把 retryStage 指到 "import"，与门禁
 *   文案自相矛盾，模型浪费 2 次修复预算才发现要重跑画像。
 *
 *   修后语义：
 *   - 缺 profile 类产物 → retryStage=profile_or_schema_check，与门禁文案一致
 *   - 缺 QA 类产物 → retryStage=validate
 *   - 缺 estimator 类产物 → retryStage=profile_or_diagnostics（baseline_estimate 上）
 *   - 其它阶段缺产物 → retryStage=import
 *
 *   且 repairAction 文案要带可操作的"先做什么"指引，与 retryStage 对齐。
 */

function makeFailure(code: StageFailureCode, repairMetadata: Record<string, unknown> = {}): StageFailureRecord {
  return {
    code,
    toolName: "panel_fe_regression",
    message: "missing artifact",
    retryStage: "",
    repairAction: "",
    autoRepairAllowed: true,
    requiresVerifier: false,
    maxRetries: 2,
    repairMetadata,
    createdAt: new Date().toISOString(),
  }
}

describe("ARTIFACT_MISSING repair-handler alignment", () => {
  test("profile artifact missing during baseline_estimate routes back to profile stage, not import", () => {
    const out = applyRepairHandler({
      failure: makeFailure("ARTIFACT_MISSING", { missingArtifactKind: "profile" }),
      stage: { kind: "baseline_estimate", stageId: "stage_001" } as never,
    })
    expect(out.retryStage).toBe("profile_or_schema_check")
    expect(String(out.repairAction)).toContain("profile")
    expect(out.repairAction).not.toMatch(/regenerate .* lineage/i)
  })

  test("qa artifact missing routes back to validate", () => {
    const out = applyRepairHandler({
      failure: makeFailure("ARTIFACT_MISSING", { missingArtifactKind: "validate" }),
      stage: { kind: "baseline_estimate", stageId: "stage_001" } as never,
    })
    expect(out.retryStage).toBe("validate")
    expect(String(out.repairAction)).toMatch(/QA|数据质量检查/)
  })

  test("non-profile/qa artifact missing during baseline_estimate stays at profile_or_diagnostics", () => {
    const out = applyRepairHandler({
      failure: makeFailure("ARTIFACT_MISSING", { missingArtifactKind: "estimation" }),
      stage: { kind: "baseline_estimate", stageId: "stage_001" } as never,
    })
    expect(out.retryStage).toBe("profile_or_diagnostics")
  })

  test("missing artifact at import stage still falls through to import", () => {
    const out = applyRepairHandler({
      failure: makeFailure("ARTIFACT_MISSING", {}),
      stage: { kind: "import", stageId: "stage_000" } as never,
    })
    expect(out.retryStage).toBe("import")
  })
})
