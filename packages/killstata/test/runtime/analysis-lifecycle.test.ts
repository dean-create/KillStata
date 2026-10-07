import { describe, expect, test } from "bun:test"
import {
  AnalysisLifecycleError,
  createAnalysisLifecycle,
  hasCompletedRequiredEstimateMethods,
  missingRequiredEstimateMethodIDs,
  reduceAnalysisLifecycle,
} from "@/runtime/analysis-lifecycle"
import type { AnalysisLifecycleRecord, AnalysisToolOperationIdentity } from "@/runtime/types"

function startToolRun(state: AnalysisLifecycleRecord, operation: AnalysisToolOperationIdentity) {
  return reduceAnalysisLifecycle(state, { type: "tool_run_started", operation })
}

describe("analysis lifecycle reducer", () => {
  test("a non-PreparedSpec result cannot close an estimate without a matching started operation", () => {
    let state = reduceAnalysisLifecycle(createAnalysisLifecycle(), {
      type: "request_registered",
      requestId: "request_tool_start_required",
      kind: "estimate",
      sourceMessageId: "message_tool_start_required",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_started",
      requestId: "request_tool_start_required",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_completed",
      requestId: "request_tool_start_required",
      datasetId: "dataset_tool_start_required",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
    })

    expect(() => reduceAnalysisLifecycle(state, {
      type: "tool_run_recorded",
      operation: {
        requestId: "request_tool_start_required",
        operationId: "call_tool_start_required",
        toolID: "composite_evaluation",
        datasetId: "dataset_tool_start_required",
        stageId: "stage_000",
        stageFingerprint: `sha256:${"a".repeat(64)}`,
        inputFingerprint: `sha256:${"b".repeat(64)}`,
        authorizationMessageId: "message_tool_start_required",
        status: "completed",
        resultId: "result_tool_start_required",
        artifactRefs: ["artifacts/composite_result.parquet"],
        resultContractStatus: "pass",
        subResults: [],
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    })).toThrow(AnalysisLifecycleError)
  })

  test("heterogeneity batch result records every sub-spec and only a complete batch closes the required method", () => {
    let state = createAnalysisLifecycle()
    state = reduceAnalysisLifecycle(state, {
      type: "request_registered",
      requestId: "request_heterogeneity",
      kind: "estimate",
      sourceMessageId: "message_heterogeneity",
    } as never)
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_started",
      requestId: "request_heterogeneity",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_completed",
      requestId: "request_heterogeneity",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
    })

    const partialOperation = {
      requestId: "request_heterogeneity",
      operationId: "call_heterogeneity_partial",
      toolID: "heterogeneity_runner",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
      inputFingerprint: `sha256:${"b".repeat(64)}`,
      authorizationMessageId: "message_heterogeneity",
      status: "partial" as const,
      resultId: "run_heterogeneity_partial",
      artifactRefs: ["artifacts/combined_publication_bundle.json"],
      resultContractStatus: "pass" as const,
      subResults: [
        { specId: "heter_1", specType: "heterogeneity" as const, status: "success" as const },
        { specId: "heter_2", specType: "placebo" as const, status: "failed" as const },
      ],
      updatedAt: "2026-10-03T00:00:00.000Z",
    }
    state = startToolRun(state, partialOperation)
    expect(() => startToolRun(state, partialOperation)).toThrow("已经登记为运行中")
    state = reduceAnalysisLifecycle(state, {
      type: "tool_run_recorded",
      operation: partialOperation,
    } as never)
    expect(state.status).toBe("waiting_user")
    expect(state.toolRuns?.[0]?.subResults).toHaveLength(2)
    expect(reduceAnalysisLifecycle(state, { type: "tool_run_recorded", operation: partialOperation }).toolRuns)
      .toEqual(state.toolRuns)
    expect(missingRequiredEstimateMethodIDs(["heterogeneity_runner"], state, "request_heterogeneity"))
      .toEqual(["heterogeneity_runner"])

    state = reduceAnalysisLifecycle(state, {
      type: "decision_approved",
      requestId: "request_heterogeneity",
      issueCode: "HETEROGENEITY_BATCH_PARTIAL",
      resumeAs: "spec_pending",
      choice: "继续未成功的异质性规格",
      decisionMessageId: "message_heterogeneity_continue",
    })
    const approvedPartial = state
    expect(state.decisionApproval?.approvedInputFingerprint).toBe(`sha256:${"b".repeat(64)}`)
    expect(state.decisionApproval?.approvedSubSpecIDs).toEqual(["heter_1", "heter_2"])
    expect(() => startToolRun(state, {
      requestId: "request_heterogeneity",
      operationId: "call_heterogeneity_changed_plan",
      toolID: "heterogeneity_runner",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
      inputFingerprint: `sha256:${"c".repeat(64)}`,
      authorizationMessageId: "message_heterogeneity",
    })).toThrow("不在批准范围")
    const changedStage = reduceAnalysisLifecycle(
      reduceAnalysisLifecycle(approvedPartial, {
        type: "diagnosis_started",
        requestId: "request_heterogeneity",
      }),
      {
        type: "diagnosis_completed",
        requestId: "request_heterogeneity",
        datasetId: "dataset_1",
        stageId: "stage_001",
        stageFingerprint: `sha256:${"e".repeat(64)}`,
      },
    )
    expect(() => startToolRun(changedStage, {
      requestId: "request_heterogeneity",
      operationId: "call_heterogeneity_stale_approval",
      toolID: "heterogeneity_runner",
      datasetId: "dataset_1",
      stageId: "stage_001",
      stageFingerprint: `sha256:${"e".repeat(64)}`,
      inputFingerprint: `sha256:${"b".repeat(64)}`,
      authorizationMessageId: "message_heterogeneity",
    })).toThrow("批准")

    const incompleteRetry = startToolRun(approvedPartial, {
      requestId: "request_heterogeneity",
      operationId: "call_heterogeneity_subset_retry",
      toolID: "heterogeneity_runner",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
      inputFingerprint: `sha256:${"b".repeat(64)}`,
      authorizationMessageId: "message_heterogeneity",
    })
    expect(() => reduceAnalysisLifecycle(incompleteRetry, {
      type: "tool_run_recorded",
      operation: {
        requestId: "request_heterogeneity",
        operationId: "call_heterogeneity_subset_retry",
        toolID: "heterogeneity_runner",
        datasetId: "dataset_1",
        stageId: "stage_000",
        stageFingerprint: `sha256:${"a".repeat(64)}`,
        inputFingerprint: `sha256:${"b".repeat(64)}`,
        authorizationMessageId: "message_heterogeneity",
        status: "completed",
        resultId: "run_heterogeneity_subset_retry",
        artifactRefs: ["artifacts/combined_publication_bundle.json"],
        resultContractStatus: "pass",
        subResults: [{ specId: "heter_1", specType: "heterogeneity", status: "success" }],
        updatedAt: "2026-10-03T00:01:00.000Z",
      },
    } as never)).toThrow("完整规格集")
    state = startToolRun(approvedPartial, {
      requestId: "request_heterogeneity",
      operationId: "call_heterogeneity_complete",
      toolID: "heterogeneity_runner",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
      inputFingerprint: `sha256:${"b".repeat(64)}`,
      authorizationMessageId: "message_heterogeneity",
    })
    const completed = reduceAnalysisLifecycle(state, {
      type: "tool_run_recorded",
      operation: {
        requestId: "request_heterogeneity",
        operationId: "call_heterogeneity_complete",
        toolID: "heterogeneity_runner",
        datasetId: "dataset_1",
        stageId: "stage_000",
        stageFingerprint: `sha256:${"a".repeat(64)}`,
        inputFingerprint: `sha256:${"b".repeat(64)}`,
        authorizationMessageId: "message_heterogeneity",
        status: "completed",
        resultId: "run_heterogeneity_complete",
        artifactRefs: ["artifacts/combined_publication_bundle.json"],
        resultContractStatus: "pass",
        subResults: [
          { specId: "heter_1", specType: "heterogeneity", status: "success" },
          { specId: "heter_2", specType: "placebo", status: "success" },
        ],
        updatedAt: "2026-10-03T00:02:00.000Z",
      },
    } as never)
    expect(completed.status).toBe("completed")
    expect(missingRequiredEstimateMethodIDs(["heterogeneity_runner"], completed, "request_heterogeneity"))
      .toEqual([])
    expect(() => startToolRun(completed, {
      requestId: "request_heterogeneity",
      operationId: "call_heterogeneity_duplicate",
      toolID: "heterogeneity_runner",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
      inputFingerprint: `sha256:${"d".repeat(64)}`,
      authorizationMessageId: "message_heterogeneity",
    })).toThrow("已完成该估计工具")
  })

  test("tool run cannot complete against a different fingerprint than the request diagnosis", () => {
    let state = createAnalysisLifecycle()
    state = reduceAnalysisLifecycle(state, {
      type: "request_registered",
      requestId: "request_stage_binding",
      kind: "estimate",
      sourceMessageId: "message_stage_binding",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_started",
      requestId: "request_stage_binding",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_completed",
      requestId: "request_stage_binding",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
    })

    state = startToolRun(state, {
      requestId: "request_stage_binding",
      operationId: "call_stage_binding",
      toolID: "heterogeneity_runner",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
      inputFingerprint: `sha256:${"c".repeat(64)}`,
      authorizationMessageId: "message_stage_binding",
    })

    expect(() => reduceAnalysisLifecycle(state, {
      type: "tool_run_recorded",
      operation: {
        requestId: "request_stage_binding",
        operationId: "call_stage_binding",
        toolID: "heterogeneity_runner",
        datasetId: "dataset_1",
        stageId: "stage_000",
        stageFingerprint: `sha256:${"b".repeat(64)}`,
        inputFingerprint: `sha256:${"c".repeat(64)}`,
        authorizationMessageId: "message_stage_binding",
        status: "completed",
        resultId: "run_stage_binding",
        artifactRefs: ["artifacts/combined_publication_bundle.json"],
        resultContractStatus: "pass",
        subResults: [{ specId: "heter_1", specType: "heterogeneity", status: "success" }],
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    })).toThrow("数据指纹")
    expect(state.toolRuns).toHaveLength(1)
  })

  test("tool run cannot complete against another dataset or stage with the same content fingerprint", () => {
    let state = createAnalysisLifecycle()
    state = reduceAnalysisLifecycle(state, {
      type: "request_registered",
      requestId: "request_lineage_binding",
      kind: "estimate",
      sourceMessageId: "message_lineage_binding",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_started",
      requestId: "request_lineage_binding",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_completed",
      requestId: "request_lineage_binding",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
    })

    state = startToolRun(state, {
      requestId: "request_lineage_binding",
      operationId: "call_lineage_binding",
      toolID: "heterogeneity_runner",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
      inputFingerprint: `sha256:${"b".repeat(64)}`,
      authorizationMessageId: "message_lineage_binding",
    })

    expect(() => reduceAnalysisLifecycle(state, {
      type: "tool_run_recorded",
      operation: {
        requestId: "request_lineage_binding",
        operationId: "call_lineage_binding",
        toolID: "heterogeneity_runner",
        datasetId: "dataset_2",
        stageId: "stage_000",
        stageFingerprint: `sha256:${"a".repeat(64)}`,
        inputFingerprint: `sha256:${"b".repeat(64)}`,
        authorizationMessageId: "message_lineage_binding",
        status: "completed",
        resultId: "run_lineage_binding",
        artifactRefs: ["artifacts/combined_publication_bundle.json"],
        resultContractStatus: "pass",
        subResults: [{ specId: "heter_1", specType: "heterogeneity", status: "success" }],
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    })).toThrow("数据集或阶段")
    expect(state.toolRuns).toHaveLength(1)
  })

  test("a late tool result cannot overwrite a confirmed cancellation", () => {
    let state = createAnalysisLifecycle()
    state = reduceAnalysisLifecycle(state, {
      type: "request_registered",
      requestId: "request_late_result",
      kind: "estimate",
      sourceMessageId: "message_late_result",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_started",
      requestId: "request_late_result",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_completed",
      requestId: "request_late_result",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
    })
    state = startToolRun(state, {
      requestId: "request_late_result",
      operationId: "call_late_result",
      toolID: "heterogeneity_runner",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
      inputFingerprint: `sha256:${"b".repeat(64)}`,
      authorizationMessageId: "message_late_result",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "cancelled",
      requestId: "request_late_result",
      outcomeConfirmed: true,
      failureCode: "USER_CANCELLED",
    })

    expect(() => reduceAnalysisLifecycle(state, {
      type: "tool_run_recorded",
      operation: {
        requestId: "request_late_result",
        operationId: "call_late_result",
        toolID: "heterogeneity_runner",
        datasetId: "dataset_1",
        stageId: "stage_000",
        stageFingerprint: `sha256:${"a".repeat(64)}`,
        inputFingerprint: `sha256:${"b".repeat(64)}`,
        authorizationMessageId: "message_late_result",
        status: "completed",
        resultId: "run_late_result",
        artifactRefs: ["artifacts/combined_publication_bundle.json"],
        resultContractStatus: "pass",
        subResults: [{ specId: "heter_1", specType: "heterogeneity", status: "success" }],
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    })).toThrow("终态")
    expect(state.status).toBe("cancelled")
    expect(state.toolRuns).toMatchObject([{ status: "cancelled", failureCode: "USER_CANCELLED" }])
  })

  test("an unconfirmed tool failure closes the running operation and rejects a late success", () => {
    let state = reduceAnalysisLifecycle(createAnalysisLifecycle(), {
      type: "request_registered",
      requestId: "request_tool_unconfirmed",
      kind: "estimate",
      sourceMessageId: "message_tool_unconfirmed",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_started",
      requestId: "request_tool_unconfirmed",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_completed",
      requestId: "request_tool_unconfirmed",
      datasetId: "dataset_tool_unconfirmed",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
    })
    state = startToolRun(state, {
      requestId: "request_tool_unconfirmed",
      operationId: "call_tool_unconfirmed",
      toolID: "composite_evaluation",
      datasetId: "dataset_tool_unconfirmed",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
      inputFingerprint: `sha256:${"b".repeat(64)}`,
      authorizationMessageId: "message_tool_unconfirmed",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "tool_run_terminated",
      requestId: "request_tool_unconfirmed",
      operationId: "call_tool_unconfirmed",
      outcome: "unconfirmed",
      failureCode: "ENGINE_TIMEOUT",
    })

    expect(state.status).toBe("unconfirmed")
    expect(state.toolRuns).toMatchObject([{ status: "unconfirmed", failureCode: "ENGINE_TIMEOUT" }])
    expect(() => reduceAnalysisLifecycle(state, {
      type: "tool_run_recorded",
      operation: {
        requestId: "request_tool_unconfirmed",
        operationId: "call_tool_unconfirmed",
        toolID: "composite_evaluation",
        datasetId: "dataset_tool_unconfirmed",
        stageId: "stage_000",
        stageFingerprint: `sha256:${"a".repeat(64)}`,
        inputFingerprint: `sha256:${"b".repeat(64)}`,
        authorizationMessageId: "message_tool_unconfirmed",
        status: "completed",
        resultId: "result_late_tool_unconfirmed",
        artifactRefs: ["artifacts/composite_result.parquet"],
        resultContractStatus: "pass",
        subResults: [],
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    })).toThrow("终态")
  })

  test("only analysis-output tools can close an estimate request through a tool-run record", () => {
    let state = createAnalysisLifecycle()
    state = reduceAnalysisLifecycle(state, {
      type: "request_registered",
      requestId: "request_tool_allowlist",
      kind: "estimate",
      sourceMessageId: "message_tool_allowlist",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_started",
      requestId: "request_tool_allowlist",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_completed",
      requestId: "request_tool_allowlist",
      datasetId: "dataset_1",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"a".repeat(64)}`,
    })

    expect(() => reduceAnalysisLifecycle(state, {
      type: "tool_run_recorded",
      operation: {
        requestId: "request_tool_allowlist",
        operationId: "call_tool_allowlist",
        toolID: "data_import",
        datasetId: "dataset_1",
        stageId: "stage_000",
        stageFingerprint: `sha256:${"a".repeat(64)}`,
        inputFingerprint: `sha256:${"b".repeat(64)}`,
        authorizationMessageId: "message_tool_allowlist",
        status: "completed",
        resultId: "run_tool_allowlist",
        artifactRefs: ["artifacts/result.json"],
        resultContractStatus: "pass",
        subResults: [{ specId: "tool_result", specType: "heterogeneity", status: "success" }],
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    })).toThrow("受控估计工具")
  })

  test("required estimate methods are complete only in the matching lifecycle with a passed result contract", () => {
    const lifecycle = createAnalysisLifecycle()
    lifecycle.requestId = "request_current"
    lifecycle.specRuns = [
      {
        requestId: "request_current",
        specId: "spec_ols",
        revision: 1,
        methodID: "ols_regression",
        status: "completed",
        stageFingerprint: "sha256:data-current",
        specStatus: "ready",
        resultContractStatus: "pass",
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
      {
        requestId: "request_current",
        specId: "spec_panel",
        revision: 1,
        methodID: "panel_fe_regression",
        status: "completed",
        stageFingerprint: "sha256:data-current",
        specStatus: "ready",
        resultContractStatus: "block",
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
      {
        requestId: "request_old",
        specId: "spec_iv_old",
        revision: 1,
        methodID: "iv_2sls",
        status: "completed",
        stageFingerprint: "sha256:data-current",
        specStatus: "ready",
        resultContractStatus: "pass",
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    ]

    expect(missingRequiredEstimateMethodIDs(
      ["ols_regression", "panel_fe_regression", "iv_2sls", "did2s"],
      lifecycle,
      "request_current",
    )).toEqual(["panel_fe_regression", "iv_2sls", "did2s"])
    expect(hasCompletedRequiredEstimateMethods(
      ["ols_regression", "panel_fe_regression"], lifecycle, "request_current",
    )).toBe(false)
    expect(hasCompletedRequiredEstimateMethods(
      ["ols_regression"], lifecycle, "request_current",
    )).toBe(true)
    expect(hasCompletedRequiredEstimateMethods(
      [], lifecycle, "request_current",
    )).toBe(false)
    const userAuthorizedOLS = structuredClone(lifecycle)
    userAuthorizedOLS.specRuns[0]!.authorization = {
      requestId: "request_current",
      specId: "spec_ols",
      revision: 1,
      stageFingerprint: "sha256:data-current",
      decisionMessageId: "message_user_choice",
      decidedAt: "2026-10-03T00:00:00.000Z",
    }
    expect(hasCompletedRequiredEstimateMethods([], userAuthorizedOLS, "request_current")).toBe(true)
    const alsoAuthorizedPanel = structuredClone(userAuthorizedOLS)
    alsoAuthorizedPanel.specRuns.push({
      requestId: "request_current",
      specId: "spec_panel_authorized",
      revision: 1,
      methodID: "panel_fe_regression",
      status: "ready",
      stageFingerprint: "sha256:data-current",
      specStatus: "ready",
      authorization: {
        requestId: "request_current",
        specId: "spec_panel_authorized",
        revision: 1,
        stageFingerprint: "sha256:data-current",
        decisionMessageId: "message_user_choice",
        decidedAt: "2026-10-03T00:00:00.000Z",
      },
      updatedAt: "2026-10-03T00:00:00.000Z",
    })
    expect(hasCompletedRequiredEstimateMethods([], alsoAuthorizedPanel, "request_current")).toBe(false)
    expect(missingRequiredEstimateMethodIDs(["ols_regression"], undefined, "request_current"))
      .toEqual(["ols_regression"])
  })

  test("partial multi-method success can wait for the remaining method and preserve completed results on cancel", () => {
    const completedOLS = {
      requestId: "request_multi",
      specId: "spec_ols",
      revision: 1,
      methodID: "ols_regression",
      status: "completed" as const,
      stageFingerprint: "sha256:data-current",
      specStatus: "ready" as const,
      resultId: "result_ols",
      artifactRefs: ["artifacts/ols/results.json"],
      resultContractStatus: "pass" as const,
      updatedAt: "2026-10-03T00:00:00.000Z",
    }
    const completed = {
      ...createAnalysisLifecycle(),
      status: "completed" as const,
      requestId: "request_multi",
      requestKind: "estimate" as const,
      specId: "spec_ols",
      specRevision: 1,
      methodID: "ols_regression",
      stageFingerprint: "sha256:data-current",
      resultId: "result_ols",
      artifactRefs: ["artifacts/ols/results.json"],
      resultContractStatus: "pass" as const,
      specRuns: [completedOLS],
    }

    const waiting = reduceAnalysisLifecycle(completed, {
      type: "decision_required",
      requestId: "request_multi",
      issueCode: "ESTIMATE_REQUEST_INCOMPLETE",
      pendingMethodIDs: ["panel_fe_regression"],
    })
    expect(waiting.status).toBe("waiting_user")
    expect(waiting.specRuns).toEqual([completedOLS])

    const cancelled = reduceAnalysisLifecycle(waiting, {
      type: "cancelled",
      requestId: "request_multi",
      outcomeConfirmed: true,
      failureCode: "USER_DECLINED_PENDING_METHOD",
    })
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.specRuns).toEqual([completedOLS])
  })

  test("ready is not authorization; execution requires approval bound to the exact spec and data", () => {
    let state = createAnalysisLifecycle()
    state = reduceAnalysisLifecycle(state, {
      type: "request_registered",
      requestId: "request_1",
      kind: "estimate",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessed",
      requestId: "request_1",
      specId: "spec_1",
      revision: 1,
      methodID: "ols_regression",
      stageFingerprint: "sha256:dataset-a",
      status: "ready",
    })

    expect(state.status).toBe("ready")
    expect(state.authorization).toBeUndefined()
    expect(() => reduceAnalysisLifecycle(state, {
      type: "execution_started",
      requestId: "request_1",
      specId: "spec_1",
      stageFingerprint: "sha256:dataset-a",
    })).toThrow(AnalysisLifecycleError)

    state = reduceAnalysisLifecycle(state, {
      type: "user_decision",
      requestId: "request_1",
      specId: "spec_1",
      revision: 1,
      stageFingerprint: "sha256:dataset-a",
      decision: "approve",
      decisionMessageId: "message_approval_1",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "execution_started",
      requestId: "request_1",
      specId: "spec_1",
      stageFingerprint: "sha256:dataset-a",
    })

    expect(state.status).toBe("running")
    expect(state.authorization).toMatchObject({ specId: "spec_1", stageFingerprint: "sha256:dataset-a" })
  })

  test("a user rejection is a terminal stop and cannot be followed by execution", () => {
    let state = reduceAnalysisLifecycle(createAnalysisLifecycle(), {
      type: "request_registered",
      requestId: "request_2",
      kind: "estimate",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessed",
      requestId: "request_2",
      specId: "spec_2",
      revision: 1,
      methodID: "wls_regression",
      stageFingerprint: "sha256:dataset-b",
      status: "requires_user_decision",
      issueCode: "WEIGHT_SOURCE_UNAVAILABLE",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "user_decision",
      requestId: "request_2",
      specId: "spec_2",
      revision: 1,
      stageFingerprint: "sha256:dataset-b",
      decision: "reject",
      decisionMessageId: "message_rejection_2",
    })

    expect(state.status).toBe("cancelled")
    expect(state.authorization).toBeUndefined()
    expect(() => reduceAnalysisLifecycle(state, {
      type: "execution_started",
      requestId: "request_2",
      specId: "spec_2",
      stageFingerprint: "sha256:dataset-b",
    })).toThrow(AnalysisLifecycleError)
  })

  test("execution output must be verified before the lifecycle is completed", () => {
    let state = createAnalysisLifecycle()
    state = reduceAnalysisLifecycle(state, {
      type: "request_registered",
      requestId: "request_3",
      kind: "estimate",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessed",
      requestId: "request_3",
      specId: "spec_3",
      revision: 1,
      methodID: "ols_regression",
      stageFingerprint: "sha256:dataset-c",
      status: "ready",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "user_decision",
      requestId: "request_3",
      specId: "spec_3",
      revision: 1,
      stageFingerprint: "sha256:dataset-c",
      decision: "approve",
      decisionMessageId: "message_approval_3",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "execution_started",
      requestId: "request_3",
      specId: "spec_3",
      stageFingerprint: "sha256:dataset-c",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "execution_result",
      requestId: "request_3",
      specId: "spec_3",
      resultId: "result_3",
      artifactRefs: ["managed://result.json"],
    })

    expect(state.status).toBe("verifying")
    expect(state.resultId).toBe("result_3")
    expect(() => reduceAnalysisLifecycle({ ...state, artifactRefs: [] }, {
      type: "result_contract_verified",
      requestId: "request_3",
      specId: "spec_3",
      resultId: "result_3",
      status: "pass",
    })).toThrow(AnalysisLifecycleError)
    state = reduceAnalysisLifecycle(state, {
      type: "result_contract_verified",
      requestId: "request_3",
      specId: "spec_3",
      resultId: "result_3",
      status: "pass",
    })
    expect(state.status).toBe("completed")
    expect(() => reduceAnalysisLifecycle(state, {
      type: "verification_completed",
      requestId: "request_3",
      specId: "spec_3",
      resultId: "other-result",
      status: "pass",
    })).toThrow(AnalysisLifecycleError)

    state = reduceAnalysisLifecycle(state, {
      type: "verification_completed",
      requestId: "request_3",
      specId: "spec_3",
      resultId: "result_3",
      status: "pass",
    })
    expect(state.status).toBe("completed")
  })

  test("ambiguous execution failure remains unconfirmed, not completed or retry-authorized", () => {
    let state = createAnalysisLifecycle()
    state = reduceAnalysisLifecycle(state, {
      type: "request_registered",
      requestId: "request_4",
      kind: "estimate",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessed",
      requestId: "request_4",
      specId: "spec_4",
      revision: 1,
      methodID: "ols_regression",
      stageFingerprint: "sha256:dataset-d",
      status: "ready",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "user_decision",
      requestId: "request_4",
      specId: "spec_4",
      revision: 1,
      stageFingerprint: "sha256:dataset-d",
      decision: "approve",
      decisionMessageId: "message_approval_4",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "execution_started",
      requestId: "request_4",
      specId: "spec_4",
      stageFingerprint: "sha256:dataset-d",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "execution_unconfirmed",
      requestId: "request_4",
      specId: "spec_4",
      failureCode: "ENGINE_TIMEOUT",
    })

    expect(state.status).toBe("unconfirmed")
    expect(state.failureCode).toBe("ENGINE_TIMEOUT")
    expect(() => reduceAnalysisLifecycle(state, {
      type: "execution_started",
      requestId: "request_4",
      specId: "spec_4",
      stageFingerprint: "sha256:dataset-d",
    })).toThrow(AnalysisLifecycleError)
  })

  test("a correctable Python schema error returns to spec_pending instead of hanging in assessing", () => {
    let state = createAnalysisLifecycle()
    state = reduceAnalysisLifecycle(state, {
      type: "request_registered",
      requestId: "request_5",
      kind: "estimate",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessment_started",
      requestId: "request_5",
      methodID: "ols_regression",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "assessment_failed",
      requestId: "request_5",
      failureCode: "INVALID_ARGUMENT",
      recovery: "model_correction",
    })

    expect(state.status).toBe("spec_pending")
    expect(state.failureCode).toBe("INVALID_ARGUMENT")
    expect(state.authorization).toBeUndefined()
  })

  test("a deterministic failure may re-assess the same method, but may not silently switch methods", () => {
    let state = reduceAnalysisLifecycle(createAnalysisLifecycle(), {
      type: "request_registered",
      requestId: "request_retry_1",
      kind: "estimate",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessed",
      requestId: "request_retry_1",
      specId: "spec_ols_retry_1",
      revision: 1,
      methodID: "ols_regression",
      stageFingerprint: "sha256:retry-data",
      status: "ready",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "user_decision",
      requestId: "request_retry_1",
      specId: "spec_ols_retry_1",
      revision: 1,
      stageFingerprint: "sha256:retry-data",
      decision: "approve",
      decisionMessageId: "message_retry_1",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "execution_started",
      requestId: "request_retry_1",
      specId: "spec_ols_retry_1",
      stageFingerprint: "sha256:retry-data",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "execution_failed",
      requestId: "request_retry_1",
      specId: "spec_ols_retry_1",
      failureCode: "METHOD_EXECUTION_FAILED",
      retryable: false,
    })

    expect(state.status).toBe("failed")
    expect(state.specRuns).toMatchObject([{ specId: "spec_ols_retry_1", status: "failed" }])
    expect(() => reduceAnalysisLifecycle(state, {
      type: "spec_assessment_started",
      requestId: "request_retry_1",
      methodID: "panel_fe_regression",
    })).toThrow(AnalysisLifecycleError)

    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessment_started",
      requestId: "request_retry_1",
      methodID: "ols_regression",
    })
    expect(state.status).toBe("assessing")
    expect(state.authorization).toBeUndefined()
    expect(state.specRuns).toMatchObject([{ specId: "spec_ols_retry_1", status: "failed" }])
  })

  test("data diagnosis records its stage fingerprint and blocks method assessment on a blocking issue", () => {
    let state = reduceAnalysisLifecycle(createAnalysisLifecycle(), {
      type: "request_registered",
      requestId: "request_6",
      kind: "estimate",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_started",
      requestId: "request_6",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_completed",
      requestId: "request_6",
      datasetId: "dataset_6",
      stageId: "stage_000",
      stageFingerprint: `sha256:${"e".repeat(64)}`,
      blockingIssueCode: "DATA_QUALITY_BLOCKED",
    })

    expect(state.status).toBe("waiting_user")
    expect(state.stageFingerprint).toBe(`sha256:${"e".repeat(64)}`)
    expect(state.issueCode).toBe("DATA_QUALITY_BLOCKED")
    expect(() => reduceAnalysisLifecycle(state, {
      type: "spec_assessment_started",
      requestId: "request_6",
      methodID: "panel_fe_regression",
    })).toThrow(AnalysisLifecycleError)
  })

  test("user-approved column substitution reopens only the matching request and issue for a new spec", () => {
    let state = reduceAnalysisLifecycle(createAnalysisLifecycle(), {
      type: "request_registered",
      requestId: "request_7",
      kind: "estimate",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_started",
      requestId: "request_7",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "diagnosis_completed",
      requestId: "request_7",
      datasetId: "dataset_7",
      stageId: "stage_001",
      stageFingerprint: `sha256:${"f".repeat(64)}`,
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessment_started",
      requestId: "request_7",
      methodID: "panel_fe_regression",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "decision_required",
      requestId: "request_7",
      issueCode: "DATA_COLUMN_MISSING",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "decision_approved",
      requestId: "request_7",
      issueCode: "DATA_COLUMN_MISSING",
      resumeAs: "spec_pending",
      choice: "年份",
      decisionMessageId: "message_7",
    })

    expect(state.status).toBe("spec_pending")
    expect(state.authorization).toBeUndefined()
    expect(state.decisionApproval).toMatchObject({
      requestId: "request_7",
      issueCode: "DATA_COLUMN_MISSING",
      resumeAs: "spec_pending",
      choice: "年份",
      stageFingerprint: `sha256:${"f".repeat(64)}`,
      decisionMessageId: "message_7",
    })
    expect(() => reduceAnalysisLifecycle(state, {
      type: "execution_started",
      requestId: "request_7",
      specId: "spec_7",
      stageFingerprint: `sha256:${"f".repeat(64)}`,
    })).toThrow(AnalysisLifecycleError)
  })

  test("user-approved panel-key repair enters repairing and still cannot execute the previous spec", () => {
    let state = reduceAnalysisLifecycle(createAnalysisLifecycle(), {
      type: "request_registered",
      requestId: "request_8",
      kind: "estimate",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessment_started",
      requestId: "request_8",
      methodID: "panel_fe_regression",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "decision_required",
      requestId: "request_8",
      issueCode: "DATA_PANEL_KEY_NOT_UNIQUE",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "decision_approved",
      requestId: "request_8",
      issueCode: "DATA_PANEL_KEY_NOT_UNIQUE",
      resumeAs: "repairing",
      choice: "省份+地区",
      decisionMessageId: "message_8",
    })

    expect(state.status).toBe("repairing")
    expect(state.decisionApproval).toMatchObject({
      requestId: "request_8",
      issueCode: "DATA_PANEL_KEY_NOT_UNIQUE",
      resumeAs: "repairing",
      choice: "省份+地区",
    })
    expect(() => reduceAnalysisLifecycle(state, {
      type: "execution_started",
      requestId: "request_8",
      specId: "spec_8",
      stageFingerprint: "sha256:old-stage",
    })).toThrow(AnalysisLifecycleError)
  })

  test("two requested methods retain independent outcomes when the second is blocked", () => {
    let state = createAnalysisLifecycle()
    state = reduceAnalysisLifecycle(state, {
      type: "request_registered",
      requestId: "request_9",
      kind: "estimate",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessment_started",
      requestId: "request_9",
      methodID: "ols_regression",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessed",
      requestId: "request_9",
      specId: "spec_ols_9",
      revision: 1,
      methodID: "ols_regression",
      stageFingerprint: "sha256:dataset-i",
      status: "ready",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "user_decision",
      requestId: "request_9",
      specId: "spec_ols_9",
      revision: 1,
      stageFingerprint: "sha256:dataset-i",
      decision: "approve",
      decisionMessageId: "message_9",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "execution_started",
      requestId: "request_9",
      specId: "spec_ols_9",
      stageFingerprint: "sha256:dataset-i",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "execution_result",
      requestId: "request_9",
      specId: "spec_ols_9",
      resultId: "result_ols_9",
      artifactRefs: ["managed://ols-result.json"],
    })
    state = reduceAnalysisLifecycle(state, {
      type: "result_contract_verified",
      requestId: "request_9",
      specId: "spec_ols_9",
      resultId: "result_ols_9",
      status: "pass",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessment_started",
      requestId: "request_9",
      methodID: "panel_fe_regression",
    })
    state = reduceAnalysisLifecycle(state, {
      type: "spec_assessed",
      requestId: "request_9",
      specId: "spec_panel_9",
      revision: 2,
      methodID: "panel_fe_regression",
      stageFingerprint: "sha256:dataset-i",
      status: "requires_user_decision",
      issueCode: "PANEL_KEYS_REQUIRED",
    })

    expect(state.status).toBe("waiting_user")
    expect(state.specRuns).toMatchObject([
      { specId: "spec_ols_9", methodID: "ols_regression", status: "completed", resultContractStatus: "pass" },
      { specId: "spec_panel_9", methodID: "panel_fe_regression", status: "waiting_user", issueCode: "PANEL_KEYS_REQUIRED" },
    ])

    state = reduceAnalysisLifecycle(state, {
      type: "verification_completed",
      requestId: "request_9",
      specId: "spec_ols_9",
      resultId: "result_ols_9",
      status: "pass",
    })

    expect(state.status).toBe("waiting_user")
    expect(state.specId).toBe("spec_panel_9")
    expect(state.specRuns).toMatchObject([
      { specId: "spec_ols_9", status: "completed", verifierStatus: "pass" },
      { specId: "spec_panel_9", status: "waiting_user", issueCode: "PANEL_KEYS_REQUIRED" },
    ])
  })
})
