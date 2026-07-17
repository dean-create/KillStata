import { describe, expect, test } from "bun:test"
import { runFixedPanelFePilot } from "./src/pilot"

describe("real-paper acceptance pilot", () => {
  test("executes the fixed FE specification through the production harness and preserves its numeric contract", async () => {
    const report = await runFixedPanelFePilot()

    expect(report.route).toEqual({ mode: "fixed", toolId: "panel_fe_regression" })
    expect(report.harness.schemaAccepted).toBe(true)
    expect(report.harness.executorCalls).toBe(1)
    expect(report.harness.lifecycle).toEqual(["queued", "running", "completed"])
    expect(report.numeric.linearmodelsWiringFailures).toEqual([])
    expect(report.numeric.independentOracle).toEqual(
      expect.objectContaining({ failures: [], reference: expect.objectContaining({ rowsUsed: 4709 }) }),
    )
    expect(report.numeric.crossEngine.rowsMatch).toBe(true)
    expect(report.numeric.crossEngine.coefficientGap).toBeLessThan(1e-8)
    expect(report.result.rowsUsed).toBe(4709)
  }, 300_000)
})
