import { describe, expect, test } from "bun:test"
import { MessageV2 } from "@/session/message-v2"
import { FailurePolicy } from "@/runtime/failure-policy"

function apiError(statusCode: number, message: string, isRetryable: boolean, responseHeaders?: Record<string, string>) {
  return new MessageV2.APIError({
    message,
    statusCode,
    isRetryable,
    responseHeaders,
  }).toObject()
}

describe("统一失败策略", () => {
  test("429、503 与网络断流属于临时失败，前台请求有限重试", () => {
    expect(FailurePolicy.classifyModel(apiError(429, "Too Many Requests", true), "foreground")).toMatchObject({
      category: "rate_limited",
      disposition: "retry",
      maxConsecutiveFailures: 3,
    })
    expect(FailurePolicy.classifyModel(apiError(503, "Service Unavailable", true), "foreground")).toMatchObject({
      category: "provider_unavailable",
      disposition: "retry",
    })
    expect(
      FailurePolicy.classifyModel(
        { data: { message: "stream disconnected before completion" } } as never,
        "foreground",
      ),
    ).toMatchObject({ category: "transient_network", disposition: "retry" })
    expect(
      FailurePolicy.classifyModel(
        { data: { message: "stream disconnected before first meaningful response: no events for 60000ms" } } as never,
        "foreground",
      ),
    ).toMatchObject({
      category: "transient_network",
      disposition: "retry",
      maxConsecutiveFailures: 3,
    })
  })

  test("400、401、403 与余额不足属于确定性失败，不自动重试", () => {
    expect(FailurePolicy.classifyModel(apiError(400, "Bad Request", false), "foreground")).toMatchObject({
      category: "invalid_request",
      disposition: "stop",
    })
    expect(FailurePolicy.classifyModel(apiError(401, "Unauthorized", false), "foreground")).toMatchObject({
      category: "authentication",
      disposition: "stop",
    })
    expect(FailurePolicy.classifyModel(apiError(403, "Forbidden", false), "foreground")).toMatchObject({
      category: "permission_denied",
      disposition: "stop",
    })
    expect(FailurePolicy.classifyModel(apiError(405, "Method Not Allowed", true), "foreground")).toMatchObject({
      category: "invalid_request",
      disposition: "stop",
    })
    expect(FailurePolicy.classifyModel(apiError(402, "Insufficient Balance", true), "foreground")).toMatchObject({
      category: "quota_exhausted",
      disposition: "stop",
    })
  })

  test("Provider 413 进入上下文压缩而不是网络重试", () => {
    expect(FailurePolicy.classifyModel(apiError(413, "Payload Too Large", false), "foreground")).toMatchObject({
      category: "context_overflow",
      disposition: "compact",
    })
  })

  test("后台容量故障直接停止，但后台网络断流仍允许由调用方做有限恢复", () => {
    expect(FailurePolicy.classifyModel(apiError(503, "Service Unavailable", true), "background")).toMatchObject({
      category: "provider_unavailable",
      disposition: "stop",
    })
    expect(
      FailurePolicy.classifyModel(
        { data: { message: "stream disconnected before completion" } } as never,
        "background",
      ),
    ).toMatchObject({ category: "transient_network", disposition: "retry" })
  })

  test("Retry-After 优先于指数退避", () => {
    const error = apiError(429, "Too Many Requests", true, { "retry-after": "7" })
    expect(FailurePolicy.retryDelay(1, error as MessageV2.APIError)).toBe(7000)
    const negative = apiError(429, "Too Many Requests", true, { "retry-after-ms": "-10" })
    expect(FailurePolicy.retryDelay(1, negative as MessageV2.APIError)).toBe(FailurePolicy.RETRY_INITIAL_DELAY)
    const huge = apiError(429, "Too Many Requests", true, { "retry-after-ms": "999999999999" })
    expect(FailurePolicy.retryDelay(1, huge as MessageV2.APIError)).toBe(FailurePolicy.RETRY_MAX_DELAY)
  })

  test("工具失败区分终止、模型修复与未知失败", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "missing_tool",
        message: "Model tried to call unavailable tool 'missing_tool'",
        failureType: "tool_contract_failure",
      }),
    ).toMatchObject({ category: "tool_not_found", disposition: "repair" })
    expect(
      FailurePolicy.classifyTool({
        toolName: "ols_regression",
        message: "missing column wage",
        failureType: "column_not_found",
      }),
    ).toMatchObject({ category: "invalid_tool_input", disposition: "repair" })
    expect(
      FailurePolicy.classifyTool({
        toolName: "ols_regression",
        message: "backend exploded",
        failureType: "unknown_failure",
      }),
    ).toMatchObject({ category: "unknown_tool_failure", disposition: "stop" })
    expect(
      FailurePolicy.classifyTool({
        toolName: "ols_regression",
        message: "backend exploded",
        failureType: "unknown_failure",
        hookSuggestedRepair: true,
      }),
    ).toMatchObject({ category: "unknown_tool_failure", disposition: "repair" })
  })

  test("传统 DID 缺少四格样本时停止并交还用户决策，不进入自动重试", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "did_static",
        message: "传统 DID 必须同时包含处理组/对照组与政策前/政策后四个样本单元",
        failureType: "estimation_failure",
        preventContinuation: true,
      }),
    ).toMatchObject({
      category: "precondition_failure",
      disposition: "stop",
    })
  })

  test("传统 DID 的政策后变量没有 0/1 时报告设计缺口，不泄露幂等凭证提示", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "did_static",
        message: "[ValueError] 传统 DID 的政策后变量必须同时包含 0 和 1",
        failureType: "estimation_failure",
        sideEffectLevel: "filesystem",
      }),
    ).toMatchObject({
      category: "precondition_failure",
      disposition: "stop",
      userVisibleMessage: expect.stringContaining("传统 2×2 DID"),
    })
  })

  test("DID2S 缺少或不一致的相对时期时停止并交还研究设计决策", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "did2s",
        message: "[ValueError] 数据中找不到变量：relative_time",
        failureType: "column_not_found",
        preventContinuation: true,
      }),
    ).toMatchObject({
      category: "precondition_failure",
      disposition: "stop",
    })
  })

  test("有副作用工具默认禁止自动 repair，只读工具才可按分类修复", () => {
    // estimation_failure 不修改源数据（只写结果文件），重试安全——即使 sideEffectLevel=filesystem
    // 也应放行为 repair（2026-08-25 status-check 修复）。
    expect(
      FailurePolicy.classifyTool({
        toolName: "write",
        message: "backend failed after write",
        failureType: "estimation_failure",
        sideEffectLevel: "filesystem",
      }),
    ).toMatchObject({ category: "estimation_failure", disposition: "repair" })
    expect(
      FailurePolicy.classifyTool({
        toolName: "read",
        message: "missing file",
        failureType: "file_not_found",
        sideEffectLevel: "none",
      }),
    ).toMatchObject({ category: "invalid_tool_input", disposition: "repair" })
  })

  test("预处理的结构化缺列错误仍允许模型修正阶段，而不是误报幂等凭证", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "data_preprocess",
        message: "COLUMN_NOT_FOUND: Columns not found: cohort",
        failureType: "column_not_found",
        sideEffectLevel: "session",
      }),
    ).toMatchObject({
      category: "invalid_tool_input",
      disposition: "repair",
    })
  })

  test("QA/前置门禁允许切换到修复工具，但未知或估计中断仍阻止有副作用重试", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "data_import",
        message: "QA gate blocked after verified duplicate-key diagnosis",
        failureType: "validate_blocked",
        sideEffectLevel: "filesystem",
      }),
    ).toMatchObject({ category: "qa_blocked", disposition: "repair" })
    expect(
      FailurePolicy.classifyTool({
        toolName: "data_preprocess",
        message: "数据预处理前必须先完成画像",
        failureType: "planning_failure",
        sideEffectLevel: "filesystem",
      }),
    ).toMatchObject({ category: "precondition_failure", disposition: "repair" })
    expect(
      FailurePolicy.classifyTool({
        toolName: "write",
        message: "backend failed after write",
        failureType: "estimation_failure",
        sideEffectLevel: "filesystem",
      }),
    ).toMatchObject({ category: "estimation_failure", disposition: "repair" })
    expect(
      FailurePolicy.classifyTool({
        toolName: "data_import",
        message: "unknown failure after import",
        failureType: "unknown_failure",
        sideEffectLevel: "filesystem",
        hookSuggestedRepair: true,
      }),
    ).toMatchObject({ category: "side_effect_retry_blocked", disposition: "stop" })
  })

  test("Schema 校验在执行前失败时允许修正参数，即使工具本身可能写文件", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "data_preprocess",
        message: "工具 data_preprocess 参数不合法：包含未定义字段（action）",
        failureType: "tool_contract_failure",
        errorCode: "TOOL_INPUT_INVALID",
        sideEffectLevel: "filesystem",
      }),
    ).toMatchObject({ category: "invalid_tool_input", disposition: "repair" })
  })

  test("延迟计量方法的 Schema 未披露时指引模型重新搜索，不切换方法或重跑", () => {
    const decision = FailurePolicy.classifyTool({
      toolName: "ols_regression",
      message: "ols_regression 的完整参数 Schema 未进入本轮模型上下文。",
      errorCode: "TOOL_SCHEMA_NOT_SENT",
      failureType: "tool_contract_failure",
      sideEffectLevel: "filesystem",
    })

    expect(decision).toMatchObject({ category: "invalid_tool_input", disposition: "repair" })
    expect(decision.userVisibleMessage).toContain("tool_search")
    expect(decision.userVisibleMessage).toContain("不要猜参数或切换方法")
  })

  test("有副作用工具超时后 fail-closed，只读工具超时仍可有限恢复", () => {
    expect(FailurePolicy.classifyTool({
      toolName: "data_preprocess",
      message: "TOOL_EXECUTION_TIMEOUT",
      errorCode: "TOOL_EXECUTION_TIMEOUT",
      failureType: "process_timeout",
      sideEffectLevel: "filesystem",
    })).toMatchObject({ category: "side_effect_retry_blocked", disposition: "stop" })
    expect(FailurePolicy.classifyTool({
      toolName: "read",
      message: "TOOL_EXECUTION_TIMEOUT",
      errorCode: "TOOL_EXECUTION_TIMEOUT",
      failureType: "process_timeout",
      sideEffectLevel: "none",
      readOnlyTool: true,
    })).toMatchObject({ category: "process_timeout", disposition: "repair" })
  })

  test("分位数分箱能力缺口停止无意义的 create_column 重试", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "data_preprocess",
        message: "当前 create_column 不支持分位数分箱；请提供已分好组的列或确认新增分箱方法",
        failureType: "tool_contract_failure",
        sideEffectLevel: "filesystem",
      }),
    ).toMatchObject({ category: "precondition_failure", disposition: "stop" })
  })

  test("执行数据快照不稳定时停止，不重试旧 PreparedSpec", () => {
    const decision = FailurePolicy.classifyTool({
      toolName: "econometrics_execute",
      message: "当前数据文件在创建执行快照时发生变化；估计器没有运行。",
      errorCode: "DATA_SNAPSHOT_UNSTABLE",
      failureType: "data_snapshot_failure" as never,
      sideEffectLevel: "filesystem",
    })

    expect(decision).toMatchObject({ scope: "tool", category: "precondition_failure", disposition: "stop" })
    expect(decision.userVisibleMessage).toContain("估计器没有运行")
    expect(decision.userVisibleMessage).toContain("刷新诊断")
  })

  test("PSM 平衡或共同支撑失败停止自动改规格", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "psm_matching",
        message: "PSM matching failed post-match balance: max absolute SMD=0.2402 exceeds 0.10",
        failureType: "validate_blocked",
        sideEffectLevel: "filesystem",
      }),
    ).toMatchObject({ category: "precondition_failure", disposition: "stop" })
  })

  test("PyFixest 时期变量类型错误不包装成幂等凭证错误", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "did_event_study_saturated",
        message: "[ValueError] The variable v_2 must be of a numeric type, and more specifically, in the format YYYYMMDDHHMMSS.",
        failureType: "unknown_failure",
        sideEffectLevel: "filesystem",
      }),
    ).toMatchObject({ category: "invalid_tool_input", disposition: "stop" })
  })

  test("综合评价的重复评价单元不包装成幂等凭证错误", () => {
    expect(
      FailurePolicy.classifyTool({
        toolName: "composite_evaluation",
        message: "ID 列组合在评价范围内存在重复，无法安全回写综合评价结果",
        failureType: "unknown_failure",
        sideEffectLevel: "filesystem",
      }),
    ).toMatchObject({ category: "precondition_failure", disposition: "stop" })
  })

  test("短结果只有在没有数据、阶段、产物或 checkpoint 进度证据时才是低信号", () => {
    expect(FailurePolicy.toolResultSignal({ output: "完成", metadata: {} })).toMatchObject({
      lowSignal: true,
      progressEvidence: [],
    })
    expect(
      FailurePolicy.toolResultSignal({ output: "完成", metadata: { datasetId: "dataset_1", stageId: "stage_2" } }),
    ).toMatchObject({
      lowSignal: false,
      progressEvidence: ["datasetId", "stageId"],
    })
  })

  test("连续三次模型压缩失败后打开熔断并明确改用本地摘要", () => {
    const decision = FailurePolicy.classifyCompaction(3)
    expect(decision).toMatchObject({
      scope: "compaction",
      category: "compaction_circuit_open",
      disposition: "fallback",
      maxConsecutiveFailures: 3,
    })
    expect(decision?.userVisibleMessage).toContain("任务进度已保留")
    expect(FailurePolicy.classifyCompaction(2)).toBeUndefined()
  })
})
