import { describe, expect, test } from "bun:test"
import { runCardOlsIvEvidence } from "./src/card-ols-iv"

describe("Card (1995) OLS/IV 真实工具验收", () => {
  test("在 linearmodels Card 数据上经 Harness 执行，并对齐 OLS 与 IV 的 N、系数和标准误", async () => {
    const report = await runCardOlsIvEvidence()

    for (const item of [report.ols, report.iv]) {
      expect(item.harness.lifecycle).toEqual(["queued", "running", "completed"])
      expect(item.harness.executorCalls).toBe(1)
      expect(item.numericOracle.matched).toBe(true)
    }
    expect(report.ols.result.rowsUsed).toBe(3010)
    expect(report.iv.result.rowsUsed).toBe(3010)
    expect(report.invalidInstrumentSchemaRejected).toBe(true)
  }, 120_000)
})
