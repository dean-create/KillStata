import { describe, expect, test } from "bun:test"
import {
  classifyPsmDiagnosticPrecondition,
  formatPsmDiagnosticPreconditionMessage,
} from "../../../../trash/killstata-legacy-econometrics/tool/psm-backend"
import { psmDiagnosticRequiresUserDecision } from "../../../../trash/killstata-legacy-econometrics/tool/econometrics-method-tools"

describe("PSM 诊断前提分类", () => {
  test("把处理变量不是 0/1 的确定性失败分类为不可重试前提问题", () => {
    expect(classifyPsmDiagnosticPrecondition("Treatment must be binary 0/1 with both treated and control groups present")).toBe("treatment_not_binary")
    expect(formatPsmDiagnosticPreconditionMessage("did")).toMatch(/同时包含 0 和 1/)
    expect(formatPsmDiagnosticPreconditionMessage("did")).toMatch(/不要先按单一年份筛选/)
  })

  test("不把普通后端错误误判为 PSM 诊断前提问题", () => {
    expect(classifyPsmDiagnosticPrecondition("Python process exited with code 1")).toBeUndefined()
  })

  test("用户已明确要求后续估计时，诊断不提前截断；诊断-only 仍停在决策点", () => {
    expect(psmDiagnosticRequiresUserDecision({ requestedToolIDs: ["psm_construction", "psm_matching"] })).toBe(false)
    expect(psmDiagnosticRequiresUserDecision({ requestedToolIDs: ["psm_construction", "psm_visualize"] })).toBe(true)
  })
})
