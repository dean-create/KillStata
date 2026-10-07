import { describe, expect, test } from "vitest"
import { createMarkdownReport } from "./report"

describe("Markdown result export", () => {
  test("keeps the research question and dataset label without leaking a local path", () => {
    const report = createMarkdownReport({
      datasetName: "minimum-wage.csv",
      prompt: "估计最低工资对就业的影响",
      document: "平均处理效应为 0.12。",
      generatedAt: new Date("2026-07-28T14:00:00.000Z"),
    })

    expect(report).toContain("# KillStata 分析结果")
    expect(report).toContain("- 数据：minimum-wage.csv")
    expect(report).toContain("- 研究问题：估计最低工资对就业的影响")
    expect(report).toContain("平均处理效应为 0.12。")
    expect(report).not.toContain("/Users/")
  })
})
