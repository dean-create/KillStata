import { describe, expect, test } from "bun:test"
import { claimsEstimateSuccessWithoutEvidence, isMethodDecisionDeclined, missingRequiredMethodIDs, pendingEstimateMethodsForTask, requiredMethodProgressSignature, unresolvedMethodDecisionIDs } from "@/session/prompt/dispatch"

describe("稳定计量路由的完成度检查", () => {
  test("拒绝短语‘不继续’不能被 continuation cue 当成授权继续", () => {
    expect(isMethodDecisionDeclined("我不继续面板固定效应回归，只保留 OLS 结果。" )).toBe(true)
    expect(isMethodDecisionDeclined("我确认继续面板固定效应回归。" )).toBe(false)
    expect(isMethodDecisionDeclined("拒绝自动清洗，但继续执行 Panel FE。" )).toBe(false)
    expect(isMethodDecisionDeclined("我不同意。" )).toBe(true)
  })

  test("伪成功过滤识别英文完成声明、整组声明并保留真实部分进度", () => {
    expect(claimsEstimateSuccessWithoutEvidence(
      "OLS regression completed successfully.",
      ["ols_regression"],
      [],
    )).toBe(true)
    expect(claimsEstimateSuccessWithoutEvidence(
      "OLS regression completed successfully, but Panel FE has not been run.",
      ["panel_fe_regression"],
      ["ols_regression"],
    )).toBe(false)
    expect(claimsEstimateSuccessWithoutEvidence(
      "OLS and Panel FE both completed successfully; there are no missing values.",
      ["panel_fe_regression"],
      ["ols_regression"],
    )).toBe(true)
    expect(claimsEstimateSuccessWithoutEvidence(
      "OLS 和面板固定效应回归均已完成。",
      ["panel_fe_regression"],
      ["ols_regression"],
    )).toBe(true)
    expect(claimsEstimateSuccessWithoutEvidence(
      "RLM completed successfully.",
      ["panel_fe_regression"],
      ["robust_regression"],
    )).toBe(false)
    expect(claimsEstimateSuccessWithoutEvidence(
      "本轮尚未执行 Panel FE 回归。",
      ["panel_fe_regression"],
      ["ols_regression"],
    )).toBe(false)
  })

  test("从 econometrics_execute 的 methodID 识别已完成的方法", () => {
    const messages = [{
      info: { role: "assistant", parentID: "user_1" },
      parts: [
        {
          type: "tool",
          tool: "econometrics_execute",
          state: {
            status: "completed",
            input: { methodID: "ols_regression" },
            metadata: { result: { success: true } },
          },
        },
        {
          type: "tool",
          tool: "econometrics_execute",
          state: {
            status: "completed",
            input: { methodID: "panel_fe_regression" },
            metadata: { result: { success: true } },
          },
        },
      ],
    }] as any

    expect(missingRequiredMethodIDs(
      ["ols_regression", "panel_fe_regression"],
      messages,
      "user_1",
    )).toEqual([])
  })

  test("stable specId 执行从结构化结果识别具体方法完成", () => {
    const messages = [{
      info: { role: "assistant", parentID: "user_1" },
      parts: [{
        type: "tool",
        tool: "econometrics_execute",
        state: {
          status: "completed",
          input: { specId: "spec_ols_1" },
          metadata: { method: "ols_regression", result: { success: true } },
        },
      }],
    }] as any

    expect(missingRequiredMethodIDs(["ols_regression"], messages, "user_1")).toEqual([])
    expect(requiredMethodProgressSignature(messages, "user_1")).toContain("ols_regression")
    expect(requiredMethodProgressSignature(messages, "user_1")).toContain("spec_ols_1")

    const blockedMessages = [{
      info: { role: "assistant", parentID: "user_1" },
      parts: [{
        type: "tool",
        tool: "econometrics_execute",
        state: {
          status: "completed",
          input: { specId: "spec_ols_blocked" },
          metadata: { method: "ols_regression", requiresUserDecision: true, result: { success: true } },
        },
      }],
    }] as any
    expect(missingRequiredMethodIDs(["ols_regression"], blockedMessages, "user_1")).toEqual(["ols_regression"])
  })

  test("仅返回前置条件阻断而没有估计结果时不算方法完成", () => {
    const messages = [{
      info: { role: "assistant", parentID: "user_1" },
      parts: [{
        type: "tool",
        tool: "econometrics_execute",
        state: {
          status: "completed",
          input: { methodID: "panel_fe_regression" },
          metadata: { panelRepairSuggested: true },
        },
      }],
    }] as any

    expect(missingRequiredMethodIDs(
      ["panel_fe_regression"],
      messages,
      "user_1",
    )).toEqual(["panel_fe_regression"])
  })

  test("导入后画像、质检与派生阶段各自计为新进度，重复画像不重置预算", () => {
    const messages = (parts: unknown[]) => [{
      info: { role: "assistant", parentID: "user_1" },
      parts,
    }] as any
    const importPart = {
      type: "tool",
      tool: "data_import",
      state: { status: "completed", input: { action: "import" }, metadata: { stageId: "stage_000" } },
    }
    const profilePart = {
      type: "tool",
      tool: "data_import",
      state: { status: "completed", input: { action: "profile" }, metadata: { stageId: "stage_000" } },
    }
    const validatePart = {
      type: "tool",
      tool: "data_import",
      state: { status: "completed", input: { action: "validate" }, metadata: { stageId: "stage_000" } },
    }
    const filteredStagePart = {
      type: "tool",
      tool: "data_preprocess",
      state: {
        status: "completed",
        input: { method: "filter", options: { rules: [{ column: "year", operator: "eq", value: 2021 }] } },
        metadata: { stageId: "stage_001" },
      },
    }

    const importProgress = requiredMethodProgressSignature(messages([importPart]), "user_1")
    const profileProgress = requiredMethodProgressSignature(messages([importPart, profilePart]), "user_1")
    const duplicateProfileProgress = requiredMethodProgressSignature(messages([importPart, profilePart, profilePart]), "user_1")
    const validatedProgress = requiredMethodProgressSignature(messages([importPart, profilePart, validatePart]), "user_1")
    const filteredProgress = requiredMethodProgressSignature(messages([importPart, profilePart, validatePart, filteredStagePart]), "user_1")

    expect(profileProgress).not.toBe(importProgress)
    expect(duplicateProfileProgress).toBe(profileProgress)
    expect(validatedProgress).not.toBe(profileProgress)
    expect(filteredProgress).not.toBe(validatedProgress)
  })

  test("只读方法搜索不伪装成数据或估计执行进度", () => {
    const messages = [{
      info: { role: "assistant", parentID: "user_1" },
      parts: [{ type: "tool", tool: "tool_search", state: { status: "completed", input: { query: "panel_random_effects" }, metadata: {} } }],
    }] as any

    expect(requiredMethodProgressSignature(messages, "user_1")).toBe("")
  })

  test("analysis_prepare 的用户决策可跨轮承接，后续 ready 规格会清除待决状态", () => {
    const decision = {
      info: { role: "assistant", parentID: "user_1" },
      parts: [{
        type: "tool",
        tool: "analysis_prepare",
        state: {
          status: "completed",
          input: { methodID: "rdd_sharp" },
          metadata: {
            analysisSpecStatus: "requires_user_decision",
            requiresUserDecision: true,
          },
        },
      }],
    }
    const rePrepared = {
      info: { role: "assistant", parentID: "user_2" },
      parts: [{
        type: "tool",
        tool: "analysis_prepare",
        state: {
          status: "completed",
          input: { methodID: "rdd_sharp" },
          metadata: {
            analysisSpecStatus: "ready",
            requiresUserDecision: false,
          },
        },
      }],
    }

    expect(unresolvedMethodDecisionIDs([decision] as any, "user_1")).toEqual(["rdd_sharp"])
    expect(unresolvedMethodDecisionIDs([decision, rePrepared] as any, "user_1")).toEqual(["rdd_sharp"])
    expect(unresolvedMethodDecisionIDs([rePrepared] as any, "user_2")).toEqual([])
  })

  test("部分估计停点从当前请求 lifecycle 恢复尚未完成的方法，而不是只查旧 ToolPart", () => {
    const task = {
      taskId: "task_multi",
      messageID: "user_1",
      metadata: { requiredToolIDs: ["ols_regression", "panel_fe_regression"] },
      analysisRequest: {
        version: 1,
        requestId: "request_multi",
        sourceMessageId: "user_1",
        kind: "estimate",
        researchGoal: "分别估计 OLS 和 Panel FE",
        constraints: [],
        registeredAt: "2026-10-03T00:00:00.000Z",
      },
      analysisLifecycle: {
        version: 1,
        requestId: "request_multi",
        requestKind: "estimate",
        status: "waiting_user",
        issueCode: "ESTIMATE_REQUEST_INCOMPLETE",
        specRuns: [{
          requestId: "request_multi",
          specId: "spec_ols",
          revision: 1,
          methodID: "ols_regression",
          status: "completed",
          stageFingerprint: `sha256:${"a".repeat(64)}`,
          specStatus: "ready",
          resultContractStatus: "pass",
          updatedAt: "2026-10-03T00:00:00.000Z",
        }],
        updatedAt: "2026-10-03T00:00:00.000Z",
      },
    } as any

    expect(pendingEstimateMethodsForTask(task, "user_1")).toEqual(["panel_fe_regression"])
    expect(pendingEstimateMethodsForTask(task, "different_user")).toEqual([])
  })
})
