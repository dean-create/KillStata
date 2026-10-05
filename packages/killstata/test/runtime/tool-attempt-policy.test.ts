import { describe, expect, test } from "bun:test"
import { isDeterministicToolFailureCode, maxToolFailureAttempts } from "@/runtime/tool-attempt-policy"

describe("计量工具失败预算", () => {
  test("计量工具保留通用预算，由确定性错误码收紧重试", () => {
    expect(maxToolFailureAttempts("ols_regression")).toBe(3)
    expect(maxToolFailureAttempts("panel_fe_regression")).toBe(3)
    expect(maxToolFailureAttempts("iv_test")).toBe(3)
    expect(isDeterministicToolFailureCode("DESIGN_MATRIX_RANK_DEFICIENT")).toBe(true)
    expect(isDeterministicToolFailureCode("ENGINE_TIMEOUT")).toBe(false)
  })

  test("数据导入和只读工具仍保留通用失败预算", () => {
    expect(maxToolFailureAttempts("data_import")).toBe(3)
    expect(maxToolFailureAttempts("read")).toBe(3)
  })
})
