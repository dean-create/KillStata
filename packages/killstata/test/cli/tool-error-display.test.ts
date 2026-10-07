import { describe, expect, test } from "bun:test"
import * as ToolErrorDisplay from "../../src/cli/cmd/tool-error-display"

const { friendlyToolErrorForCli } = ToolErrorDisplay

// P1-A：`killstata run` 一次性命令原先直接把内部报错原文（英文 + 内部工具 ID）
// 印到用户终端。TUI transcript 路径已有中文脱敏，但 CLI 流式渲染路径漏了这道工序。
// 这些用例锁定 CLI 渲染函数必须复用同一套中文兜底，绝不泄露内部技术碎片。
describe("friendlyToolErrorForCli", () => {
  test("QA 阻断显示为待处理 warning，普通故障仍显示为执行失败 error", () => {
    const present = (ToolErrorDisplay as Record<string, unknown>).analysisToolErrorPresentation as
      | ((input: { tool: string; failureType?: string; failureLabel: string }) => unknown)
      | undefined

    expect(
      present?.({ tool: "data_import", failureType: "validate_blocked", failureLabel: "数据需要处理" }),
    ).toEqual({
      tone: "warning",
      title: "数据质检发现待处理项 · 暂未继续分析",
      guidanceLabel: "建议下一步",
    })
    expect(
      present?.({ tool: "ols_regression", failureType: "estimation_failure", failureLabel: "估计失败" }),
    ).toEqual({
      tone: "error",
      title: "OLS回归未完成 · 估计失败",
      guidanceLabel: "修复建议",
    })
  })

  // 错误标题是产品面文案：不得出现内部工具 ID，也不得把 unknown_failure 的
  // 占位标签（"未知错误"/"执行未完成"）当成对用户的解释拼进标题。
  test("标题不泄露内部工具 ID；归因不明时不拼无信息量标签", () => {
    const present = (ToolErrorDisplay as Record<string, unknown>).analysisToolErrorPresentation as
      | ((input: { tool: string; failureType?: string; failureLabel: string }) => { title: string })
      | undefined

    const importFailure = present?.({ tool: "data_import", failureLabel: "执行未完成" })
    expect(importFailure?.title).toBe("数据处理未完成")
    expect(importFailure?.title).not.toContain("data_import")

    const routerFailure = present?.({
      tool: "econometrics_execute",
      failureType: "unknown_failure",
      failureLabel: "执行未完成",
    })
    expect(routerFailure?.title).toBe("这一步未完成")
    expect(routerFailure?.title).not.toContain("econometrics_execute")
  })

  test("把'工具不可用'内部错误转成中文，且不泄露工具名与可用工具清单", () => {
    const raw =
      "Model tried to call unavailable tool 'panel_fe_regression'. Available tools: question, read, glob, grep, data_import."
    const display = friendlyToolErrorForCli(raw)

    expect(display).not.toContain("unavailable tool")
    expect(display).not.toContain("Available tools")
    expect(display).not.toContain("panel_fe_regression")
    expect(display).not.toContain("data_import")
    // 必须是可读中文，而不是空串或英文原文
    expect(/[一-鿿]/.test(display)).toBe(true)
  })

  test("把 QA 门拦截转成可操作中文，不吐英文原文", () => {
    const raw =
      "Data operation blocked by QA gate: QA gate blocked by 1 blocking issue(s): Found 1 duplicate entity-time rows"
    const display = friendlyToolErrorForCli(raw)

    expect(display).not.toContain("QA gate")
    expect(display).not.toContain("blocking issue")
    expect(display).toContain("重复")
  })

  test("Python traceback 与本机绝对路径绝不进入用户可见文本", () => {
    const raw = 'Traceback (most recent call last):\n  File "/Users/cw/private.py", line 3\nValueError: broken'
    const display = friendlyToolErrorForCli(raw)

    expect(display).not.toContain("Traceback")
    expect(display).not.toContain("/Users/")
    expect(/[一-鿿]/.test(display)).toBe(true)
  })

  test("data_import 后端运行时错误转中文，且不吐英文原因与技术标签", () => {
    const raw =
      "Data operation failed: group_linear_interpolate requires time_var\n" +
      "Python interpreter: /Users/cw/.killstata/venv/bin/python\n" +
      "Reflection log: .killstata/runtime/reflection/x.json\n" +
      "Install command: uv pip install ..."
    const display = friendlyToolErrorForCli(raw)

    expect(display).not.toContain("Data operation failed")
    expect(display).not.toContain("time_var")
    expect(display).not.toContain("Python interpreter")
    expect(display).not.toContain("Install command")
    expect(/[一-鿿]/.test(display)).toBe(true)
  })

  test("普通非内部错误保留原文（脱敏后），不被无差别吞掉", () => {
    const raw = "Connection to model provider timed out after 30s"
    const display = friendlyToolErrorForCli(raw)

    // 这类错误对用户是有用的诊断信息，应保留而非替换成通用兜底
    expect(display).toContain("timed out")
  })
})
