import { describe, expect, test } from "bun:test"
import { FailurePolicy } from "@/runtime/failure-policy"

/**
 * 2026-08-28 did.xlsx 真实会话：模型直调 panel_fe_regression / hdfe_regression 得到
 * “工具不可用”后曾被 disposition=stop，整轮终结，模型没有重新选择已注册工具的机会。
 *
 * 正确语义：已准入方法未加载是**可修复**状态，必须给出加载路径；
 * 真正不存在的工具才终结。
 */
describe("tool_not_found 必须给出出口", () => {
  test("已准入但未加载的方法 → repair，并指向 tool_search", () => {
    const decision = FailurePolicy.classifyTool({
      toolName: "panel_fe_regression",
      message: "Model tried to call unavailable tool 'panel_fe_regression'.",
      admittedTool: true,
    })
    expect(decision.disposition).toBe("repair")
    expect(decision.userVisibleMessage).toContain("tool_search")
    expect(decision.userVisibleMessage).toContain("panel_fe_regression")
  })

  test("真正不存在的工具也允许有限次 replan，由模型选择已注册工具", () => {
    const decision = FailurePolicy.classifyTool({
      toolName: "magic_causal_wizard",
      message: "Model tried to call unavailable tool 'magic_causal_wizard'.",
      admittedTool: false,
    })
    expect(decision.disposition).toBe("repair")
    expect(decision.userVisibleMessage).toContain("已注册")
  })

  test("稳定计量路由返回方法窗口错误时，必须改走 tool_search 而不是重试原参数", () => {
    const decision = FailurePolicy.classifyTool({
      toolName: "magic_causal_wizard",
      message: "工具 econometrics_execute 无法执行方法“magic_causal_wizard”：该方法不在当前活动方法窗口。",
      failureType: "tool_contract_failure",
      errorCode: "TOOL_INPUT_INVALID",
    })
    expect(decision.disposition).toBe("repair")
    expect(decision.category).toBe("tool_not_found")
    expect(decision.userVisibleMessage).toContain("tool_search")
    expect(decision.userVisibleMessage).toContain("已注册")
    expect(decision.userVisibleMessage).not.toContain("只修改失败字段")
  })

  test("未声明准入信息时也只允许无副作用的有限 replan", () => {
    const decision = FailurePolicy.classifyTool({
      toolName: "whatever_tool",
      message: "no such tool",
    })
    expect(decision.disposition).toBe("repair")
  })
})
