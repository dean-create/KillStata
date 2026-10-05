import { describe, expect, test } from "vitest"
import { formatElapsed, progressTone } from "./thread"

describe("formatElapsed", () => {
  test("formats sub-minute durations in whole seconds", () => {
    expect(formatElapsed(0)).toBe("0 秒")
    expect(formatElapsed(4_999)).toBe("4 秒")
    expect(formatElapsed(59_999)).toBe("59 秒")
  })

  test("formats minute ranges and clamps negative input to zero", () => {
    expect(formatElapsed(60_000)).toBe("1 分 0 秒")
    expect(formatElapsed(65_000)).toBe("1 分 5 秒")
    expect(formatElapsed(-5_000)).toBe("0 秒")
  })

  test("formats hour ranges without inventing precision", () => {
    expect(formatElapsed(3_600_000)).toBe("1 时 0 分")
    expect(formatElapsed(7_800_000)).toBe("2 时 10 分")
  })
})

describe("progressTone", () => {
  test("classifies known engine copy and falls back to working", () => {
    expect(progressTone("读取数据已完成")).toBe("done")
    expect(progressTone("推荐计量方法已恢复")).toBe("done")
    expect(progressTone("独立核验通过。")).toBe("done")
    expect(progressTone("独立核验完成，存在诊断提醒。")).toBe("done")
    expect(progressTone("独立核验未通过；估计结果不可作为最终结论。")).toBe("attention")
    expect(progressTone("独立核验未完成；估计结果已保留。")).toBe("attention")
    expect(progressTone("读取数据未完成，引擎正在处理")).toBe("attention")
    expect(progressTone("分析引擎提出了澄清问题：…")).toBe("waiting")
    expect(progressTone("分析引擎请求授权…")).toBe("waiting")
    expect(progressTone("正在计算系数…")).toBe("working")
    expect(progressTone("完全未知的新文案")).toBe("working")
  })
})
