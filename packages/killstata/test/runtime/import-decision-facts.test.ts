import { describe, expect, test } from "bun:test"
import { formatDataReadinessForModel, type DataReadinessReport } from "@/runtime/data-readiness"

/**
 * 导入即决策：data_import(import) 一轮内必须给全"模型判断计量方法所需的事实"。
 * 这里覆盖 readiness 渲染侧；变量清单与 sheet 名单的拼装在 data-import 工具内。
 */
const baseReport = (overrides: Partial<DataReadinessReport> = {}): DataReadinessReport => ({
  version: 1,
  generatedAt: "2026-08-28T00:00:00.000Z",
  rowCount: 500,
  columnCount: 4,
  usableObservationCount: 500,
  columns: [
    { name: "wage", type: "numeric", missingCount: 0, uniqueCount: 480, constant: false },
    { name: "educ", type: "numeric", missingCount: 0, uniqueCount: 18, constant: false },
    { name: "treated", type: "numeric", missingCount: 0, uniqueCount: 2, constant: false, binary: true },
    { name: "region", type: "categorical", missingCount: 0, uniqueCount: 6, constant: false },
  ],
  panelCandidates: [],
  exactLinearDependencies: [],
  candidateMethods: [
    { methodID: "ols_regression", status: "candidate", reason: "存在至少两个有变化的数值列", repairSuggestions: [] },
    { methodID: "did_static", status: "needs_roles", reason: "需要用户确认研究设计与识别变量", repairSuggestions: ["先确认处理与政策后变量"] },
    { methodID: "psm_matching", status: "needs_roles", reason: "需要用户确认研究设计与识别变量", repairSuggestions: [] },
  ],
  warnings: [],
  ...overrides,
})

describe("导入后就绪报告向模型呈现的方法候选", () => {
  test("needs_roles 的设计类方法必须出现，而不是被整批丢弃", () => {
    const rendered = formatDataReadinessForModel(baseReport())

    // 回归点：此前只渲染 status==="candidate"，did/psm/iv/rdd 对模型完全不可见
    expect(rendered).toContain("did_static")
    expect(rendered).toContain("psm_matching")
  })

  test("needs_roles 必须标注为待确认识别变量，不能表述成推荐", () => {
    const rendered = formatDataReadinessForModel(baseReport())

    expect(rendered).toContain("需先确认识别变量")
    expect(rendered).toContain("这不是推荐")
    // 类型层面可直接适配的那组仍单独成句，两组语义不能混
    expect(rendered).toContain("按数据类型可优先适配：ols_regression")
  })

  test("没有 needs_roles 候选时不输出该段落", () => {
    const rendered = formatDataReadinessForModel(
      baseReport({
        candidateMethods: [
          { methodID: "ols_regression", status: "candidate", reason: "r", repairSuggestions: [] },
        ],
      }),
    )

    expect(rendered).not.toContain("需先确认识别变量")
  })

  test("方法 ID 经过转义清洗，不会把构造出的标签注入上下文", () => {
    const rendered = formatDataReadinessForModel(
      baseReport({
        candidateMethods: [
          { methodID: "<script>alert(1)</script>", status: "needs_roles", reason: "r", repairSuggestions: [] },
        ],
      }),
    )

    expect(rendered).not.toContain("<script>")
    expect(rendered).toContain("&lt;script&gt;")
  })
})
