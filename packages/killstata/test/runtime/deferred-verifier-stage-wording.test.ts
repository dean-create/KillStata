import { expect, test } from "bun:test"
import { buildAnalysisUserView } from "@/runtime/analysis-user-view"

test("数据导入/质检的独立核验待完成提示不冒称估计结果已生成", () => {
  const view = buildAnalysisUserView({
    tools: [{
      tool: "data_import",
      state: {
        status: "completed",
        input: { action: "validate" },
        metadata: {
          verifierPending: true,
          analysisView: { kind: "data", step: "data_import(validate)", warnings: [] },
        },
      },
    }],
  })

  expect(view?.warnings).toContain("当前步骤已完成，独立核验待完成；这不表示计量估计已完成。")
  expect(view?.warnings).not.toContain("估计结果已生成，状态：待核验；核验完成前请勿将其作为最终结论。")
})

test("计量估计的独立核验待完成提示保留估计结果边界", () => {
  const view = buildAnalysisUserView({
    tools: [{
      tool: "ols_regression",
      state: {
        status: "completed",
        metadata: {
          verifierPending: true,
          analysisView: { kind: "regression", step: "ols_regression", results: [] },
        },
      },
    }],
  })

  expect(view?.warnings).toContain("估计结果已生成，状态：待核验；核验完成前请勿将其作为最终结论。")
  expect(view?.warnings).not.toContain("当前步骤已完成，独立核验待完成；这不表示计量估计已完成。")
})

test("稳定 econometrics_execute 路由按内部方法 ID 保留估计待核验提示", () => {
  const view = buildAnalysisUserView({
    tools: [{
      tool: "econometrics_execute",
      state: {
        status: "completed",
        input: { methodID: "ols_regression" },
        metadata: {
          verifierPending: true,
          analysisView: { kind: "regression", step: "ols_regression", results: [] },
        },
      },
    }],
  })

  expect(view?.warnings).toContain("估计结果已生成，状态：待核验；核验完成前请勿将其作为最终结论。")
  expect(view?.warnings).not.toContain("当前步骤已完成，独立核验待完成；这不表示计量估计已完成。")
})
