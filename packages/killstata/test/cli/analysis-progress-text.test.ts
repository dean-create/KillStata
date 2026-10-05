import { describe, expect, test } from "bun:test"
import { analysisProgressText } from "../../src/cli/cmd/tui/routes/session/progress-text"

// 进度行文案锁死：用户报告过「正在导入数据 · 已已用 14」——「已用」前多出一个「已」。
// 模板改为纯函数拼装 + 全角逗号分隔后，输出格式必须稳定，且绝不出现「已已」这类重复。

describe("analysisProgressText", () => {
  test("running：正在 + label + 已用秒数", () => {
    expect(analysisProgressText({ label: "导入数据", elapsed: 14, completed: false })).toBe("正在导入数据，已用 14s")
  })

  test("completed：已完成 + label", () => {
    expect(analysisProgressText({ label: "导入数据", elapsed: 14, completed: true })).toBe("已完成：导入数据")
  })

  test("elapsed 边界：0 秒也带 s", () => {
    expect(analysisProgressText({ label: "拟合 OLS 回归", elapsed: 0, completed: false })).toBe(
      "正在拟合 OLS 回归，已用 0s",
    )
  })

  test("绝不出现重复的「已已」", () => {
    for (const label of ["导入数据", "拟合 OLS 回归", "清洗数据", "进行双重差分"]) {
      const running = analysisProgressText({ label, elapsed: 14, completed: false })
      expect(running).not.toContain("已已")
      expect(running).toContain("已用")
    }
  })
})
