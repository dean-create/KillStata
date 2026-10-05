import { describe, expect, test } from "bun:test"
import { answerDriveQuestion, belongsToPromptTurn, dedupeDriveToolCalls, findPromptUserMessageID, hasDriveSessionErrors, reportedDriveSessionError, reportedDriveTool, restoreChronologicalOrder, visibleTurnText } from "./runner"
import { findScenario } from "./scenarios"

describe("drive runner 多轮采集", () => {
  test("把 MessageV2.stream 的最新到最旧结果恢复为用户看到的时间顺序", () => {
    expect(restoreChronologicalOrder(["最终结果", "中间进度", "开始导入"])).toEqual([
      "开始导入",
      "中间进度",
      "最终结果",
    ])
  })

  test("最终 UX 断言覆盖同一轮用户实际看到的全部文本，而不是只取最长一段", () => {
    expect(visibleTurnText([
      "两阶段 DID 需要 cohort 和 relative_time 两列。",
      "已暂停，等待你确认研究设计。",
    ])).toContain("cohort 和 relative_time")
  })

  test("稳定计量路由在报告中还原实际 methodID，保留场景断言兼容性", () => {
    expect(reportedDriveTool("econometrics_execute", { methodID: "ols_regression", arguments: {} })).toBe("ols_regression")
    expect(reportedDriveTool("econometrics_execute", { methodID: " did2s ", arguments: {} })).toBe("did2s")
    expect(reportedDriveTool("econometrics_execute", { arguments: {} })).toBe("econometrics_execute")
    expect(reportedDriveTool("data_import", { action: "import" })).toBe("data_import")
  })

  test("同一个工具 callID 被异步消息再次看见时只保留一次，独立调用不合并", () => {
    const calls = dedupeDriveToolCalls([
      { tool: "data_import", status: "completed", callID: "import-did", args: '{"action":"import"}' },
      { tool: "ols_regression", status: "completed", callID: "ols-did" },
      { tool: "data_import", status: "completed", callID: "import-gf", args: '{"action":"import"}' },
      { tool: "data_import", status: "completed", callID: "import-gf", args: '{"action":"import"}' },
      { tool: "ols_regression", status: "completed", callID: "ols-gf" },
      { tool: "ols_regression", status: "completed" },
      { tool: "ols_regression", status: "completed" },
    ])

    expect(calls).toEqual([
      { tool: "data_import", status: "completed", callID: "import-did", args: '{"action":"import"}' },
      { tool: "ols_regression", status: "completed", callID: "ols-did" },
      { tool: "data_import", status: "completed", callID: "import-gf", args: '{"action":"import"}' },
      { tool: "ols_regression", status: "completed", callID: "ols-gf" },
      { tool: "ols_regression", status: "completed" },
      { tool: "ols_regression", status: "completed" },
    ])
  })

  test("异步迟到的上一轮 assistant 消息不应混入当前用户轮次", () => {
    expect(belongsToPromptTurn({ role: "assistant", parentID: "user-current" } as never, "user-current")).toBe(true)
    expect(belongsToPromptTurn({ role: "assistant", parentID: "user-previous" } as never, "user-current")).toBe(false)
    expect(belongsToPromptTurn({ role: "assistant", parentID: "user-previous" } as never)).toBe(true)
  })

  test("本轮父消息优先匹配真实用户文本，不被 synthetic user 抢走", () => {
    const messages = [
      {
        info: { role: "user", id: "user-original" },
        parts: [{ type: "text", text: "导入 did.xlsx 并跑 OLS" }],
      },
      {
        info: { role: "user", id: "user-synthetic" },
        parts: [{ type: "text", text: "请提炼上方工具结果", synthetic: true }],
      },
    ] as never
    expect(findPromptUserMessageID(messages, "导入 did.xlsx 并跑 OLS")).toBe("user-original")
  })

  test("保留复用标记，场景断言不会把缓存命中算成再次执行", () => {
    const calls = dedupeDriveToolCalls([
      { tool: "panel_fe_regression", status: "completed", callID: "first", reused: false },
      { tool: "panel_fe_regression", status: "completed", callID: "reused", reused: true },
    ])

    expect(calls.find((call) => call.callID === "reused")?.reused).toBe(true)
  })

  test("把会话级模型错误提取为用户可读的诊断文本", () => {
    expect(reportedDriveSessionError({ name: "AuthError", data: { message: "模型服务认证失败" } })).toBe("模型服务认证失败")
  })

  test("会话级 Provider 错误必须阻断 Drive 场景，避免无工具调用假绿", () => {
    expect(hasDriveSessionErrors([])).toBe(false)
    expect(hasDriveSessionErrors(["模型服务认证失败，请检查当前 provider 凭证后从失败阶段继续。"])).toBe(true)
  })

  test("真实回放可以选择第二或第三个问题选项，而不是永远确认第一项", () => {
    expect(answerDriveQuestion(["仅用窗口", "保留全样本", "停止分析"], "first-option")).toEqual(["仅用窗口"])
    expect(answerDriveQuestion(["仅用窗口", "保留全样本", "停止分析"], "second-option")).toEqual(["保留全样本"])
    expect(answerDriveQuestion(["仅用窗口", "保留全样本", "停止分析"], "third-option")).toEqual(["停止分析"])
    expect(answerDriveQuestion(["仅用窗口", "保留全样本", "停止分析"], "first-option", 1)).toEqual(["保留全样本"])
    expect(answerDriveQuestion(["仅用窗口"], "third-option")).toEqual([])
    expect(answerDriveQuestion(["仅用窗口"], "none")).toEqual([])
  })

  test("变量纠错场景用完整问题文本匹配真实列名", () => {
    const scenario = findScenario("nonexistent-variable")!
    const assertions = scenario.behavior({
      questionEvents: [{ prompt: "核心解释变量'城镇化率'在数据中名为'城镇化水平'，是否使用'城镇化水平'？", options: ["是同一变量", "不是"] }],
      assistantText: "",
      finalAssistantText: "OLS，遗漏变量影响未评估。",
    } as never)

    expect(assertions.find((assertion) => assertion.label === "模型先询问是否把城镇化率替换为城镇化水平")?.pass).toBe(true)
  })

  test("用户拒绝确认时，完成态工具但带 decision 标记不算真实估计", () => {
    const scenario = findScenario("gf-missing-year-reject")!
    const assertions = scenario.behavior({
      questionEvents: [{ prompt: "时间变量 year 不存在", options: ["用年份替代", "停止本次分析"] }],
      toolCalls: [{ tool: "panel_fe_regression", status: "completed", requiresUserDecision: true }],
      assistantText: "",
      assistantTexts: [],
      finalAssistantText: "",
    } as never)

    expect(assertions.every((assertion) => assertion.pass)).toBe(true)
  })

  test("回归结果导出不能用原始数据导出来冒充，即使工具执行成功", () => {
    const scenario = findScenario("export-results")!
    const exportedData = { tool: "data_import", status: "completed", args: JSON.stringify({ action: "export", outputPath: "regression_results.csv" }) }
    const assertions = scenario.behavior({
      turnTexts: [[], ["回归结果已导出到 regression_results.csv。"]],
      lastTurnAssistantText: "回归结果已导出到 regression_results.csv。",
      toolCalls: [exportedData],
      turnToolCalls: [[], [exportedData]],
    } as never)

    expect(assertions.some((assertion) => !assertion.pass)).toBe(true)
  })
})
