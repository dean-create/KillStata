import { describe, expect, test } from "bun:test"
import { buildFailureDiagnosis } from "@/runtime/failure-diagnosis"

describe("计量失败诊断", () => {
  test("未注册工具调用被识别为无副作用的工具选择错误", () => {
    const diagnosis = buildFailureDiagnosis({
      toolName: "magic_causal_wizard",
      failureType: "unknown_failure",
      error: "Tool magic_causal_wizard is not available in this request.",
    })

    expect(diagnosis.failureCode).toBe("TOOL_NOT_FOUND")
    expect(diagnosis.stage).toBe("input")
    expect(diagnosis.methodID).toBeUndefined()
    expect(diagnosis.safeToRetry).toBe(true)
    expect(diagnosis.summary_zh).toContain("未在当前注册目录")
    expect(diagnosis.summary_zh).toContain("没有执行")
    expect(diagnosis.repairOptions).toMatchObject([{
      repair_id: "select_registered_tool",
      semantic_impact: "none",
      requires_confirmation: false,
      resulting_method_ids: [],
    }])
  })

  test("已准入但尚未加载的方法提示按精确 ID 搜索，而不换方法", () => {
    const diagnosis = buildFailureDiagnosis({
      toolName: "econometrics_execute",
      failureType: "unknown_failure",
      error: "工具 econometrics_execute 无法执行方法“ols_regression”：该方法不在当前活动方法窗口。",
      input: { methodID: "ols_regression" },
    })

    expect(diagnosis.failureCode).toBe("METHOD_NOT_LOADED")
    expect(diagnosis.methodID).toBe("ols_regression")
    expect(diagnosis.stage).toBe("input")
    expect(diagnosis.safeToRetry).toBe(true)
    expect(diagnosis.summary_zh).toContain("已准入但尚未加载")
    expect(diagnosis.repairOptions[0]?.resulting_method_ids).toEqual(["ols_regression"])
    expect(diagnosis.repairOptions[0]?.description_zh).toContain("tool_search")
    expect(diagnosis.repairOptions[0]?.requires_confirmation).toBe(false)
  })

  test("完全共线失败生成需要用户确认的修复选项，不建议原样重试", () => {
    const diagnosis = buildFailureDiagnosis({
      toolName: "ols_regression",
      failureType: "estimation_failure",
      error: "设计矩阵秩亏，存在完全共线性，请检查解释变量。",
      input: { datasetId: "ds", stageId: "stage_001", methodID: "ols_regression" },
    })

    expect(diagnosis.failureCode).toBe("DESIGN_MATRIX_RANK_DEFICIENT")
    expect(diagnosis.safeToRetry).toBe(false)
    expect(diagnosis.repairOptions.some((item) => item.requires_confirmation)).toBe(true)
    expect(diagnosis.summary_zh).toContain("共线")
  })

  test("框架兜底不暴露内部路径和数据集 ID", () => {
    const diagnosis = buildFailureDiagnosis({
      toolName: "ols_regression",
      failureType: "unknown_failure",
      error: "读取 /Users/private/.killstata/dataset.parquet 失败，datasetId=secret",
      input: { datasetId: "secret", stageId: "stage_001" },
    })

    expect(diagnosis.user_fallback_zh).toContain("本次估计没有完成")
    expect(diagnosis.user_fallback_zh).not.toContain("/Users/private")
    expect(diagnosis.user_fallback_zh).not.toContain("secret")
  })

  test("数据快照失败说明估计器未运行并要求刷新诊断后重新准备规格", () => {
    const diagnosis = buildFailureDiagnosis({
      toolName: "ols_regression",
      failureType: "data_snapshot_failure" as never,
      error: "当前数据文件在创建执行快照时发生变化；估计器没有运行。",
    })

    expect(diagnosis.failureCode).toBe("DATA_SNAPSHOT_UNSTABLE")
    expect(diagnosis.stage).toBe("runtime")
    expect(diagnosis.safeToRetry).toBe(false)
    expect(diagnosis.repairOptions).toEqual([])
    expect(diagnosis.user_fallback_zh).toContain("刷新数据诊断")
    expect(diagnosis.user_fallback_zh).toContain("重新准备规格")
  })
})
