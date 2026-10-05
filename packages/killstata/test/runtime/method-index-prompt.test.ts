import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "@/session/system"
import { toolIDsByFamily, TOOL_MANIFEST } from "@/runtime/tool-manifest"
import { ToolModel } from "@/tool/model-contracts"

const inventory = () => SystemPrompt.toolInventory([]).join("\n")

describe("系统提示词里的计量方法索引", () => {
  test("稳定提示词不预加载诊断/估计方法索引", () => {
    const rendered = inventory()
    const expected = toolIDsByFamily("diagnostic", "estimator")

    expect(expected.length).toBeGreaterThan(0)
    for (const toolID of expected) expect(rendered).not.toContain(toolID)
    expect(rendered).toContain("Python Registry")
  })

  test("索引不得点名 TOOL_MANIFEST 之外的方法 ID", () => {
    const rendered = inventory()
    const known = new Set(TOOL_MANIFEST.map((entry) => entry.id))
    const listed = [...rendered.matchAll(/^- ([a-z0-9_]+)｜/gm)].map((match) => match[1])

    expect(listed).toEqual([])
    expect(known.size).toBeGreaterThan(0)
  })

  test("索引条目数与准入表完全一致，不多不少", () => {
    const listed = [...inventory().matchAll(/^- ([a-z0-9_]+)｜/gm)].map((match) => match[1])
    expect(listed).toEqual([])
  })

  test("每条索引都带适用与不适用两段，缺契约的方法不静默漏出", () => {
    expect(inventory().split("\n").filter((item) => /^- [a-z0-9_]+｜/.test(item))).toEqual([])
  })

  test("索引明确要求按方法 ID 或中文产品别名搜索，且声明自身不是调用授权", () => {
    const rendered = inventory()
    expect(rendered).toContain("方法引用")
    expect(rendered).toContain("tool_search")
    expect(rendered).toContain("参数 Schema")
  })

  test("ToolModel.lookup 对未知 ID 返回 undefined 而不是抛错", () => {
    expect(ToolModel.lookup("no_such_method_id")).toBeUndefined()
    expect(ToolModel.lookup("ols_regression")).toBeUndefined()
  })

  test("方法级契约不再由 TypeScript 维护，必须从 Python Registry describe 获取", () => {
    expect(ToolModel.lookup("ols_regression")).toBeUndefined()
    expect(ToolModel.lookup("panel_fe_regression")).toBeUndefined()
    expect(ToolModel.lookup("did2s")).toBeUndefined()
  })

  test("Python 执行能力的字段和选择文案不在 TypeScript 模型契约中重复维护", () => {
    for (const toolID of ["data_import", "data_preprocess", "composite_evaluation", "econometrics_recommend", "heterogeneity_runner"]) {
      expect(ToolModel.lookup(toolID), toolID).toBeUndefined()
      expect(ToolModel.forTool(toolID).inputExamples, toolID).toBeUndefined()
    }
    expect(ToolModel.forTool("data_preprocess").namespace).toBe("data")
    expect(ToolModel.forTool("econometrics_recommend").namespace).toBe("econometrics_diagnostic")
  })
})
