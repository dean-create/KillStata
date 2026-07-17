import { describe, expect, test } from "bun:test"
import { validatePanelFeNegativeCase } from "./src/negative"

describe("acceptance negative gate", () => {
  test("rejects dependentVar=treatmentVar before an estimator executor can start", async () => {
    const report = await validatePanelFeNegativeCase()

    expect(report.schemaAccepted).toBe(false)
    expect(report.executorCalls).toBe(0)
    expect(report.message).toContain("treatmentVar 不能与 dependentVar 使用同一列")
  })
})
