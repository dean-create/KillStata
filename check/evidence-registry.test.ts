import { describe, expect, test } from "bun:test"
import { aggregateToolEvidence, validateEvidenceRecord } from "./src/evidence"
import { loadBenchmarkCatalog } from "./src/catalog"

describe("验收证据等级", () => {
  const catalog = loadBenchmarkCatalog()

  test("B 级必须有独立数值 oracle，W 级只证明 Harness 接线", () => {
    const harness = { schemaAccepted: true, executorCalls: 1, lifecycle: ["queued", "running", "completed"] }
    expect(
      validateEvidenceRecord(catalog, {
        toolId: "psm_construction",
        datasetId: "lalonde_nsw_dw",
        grade: "W",
        status: "PASS",
        harness,
      }),
    ).toEqual({ valid: true })
    expect(() =>
      validateEvidenceRecord(catalog, {
        toolId: "psm_construction",
        datasetId: "lalonde_nsw_dw",
        grade: "B",
        status: "PASS",
        harness,
      }),
    ).toThrow(/independent numeric oracle/i)
  })

  test("PSM 不允许用 Card 冒充 NSW，安全拒绝不能标为通过", () => {
    expect(() =>
      validateEvidenceRecord(catalog, {
        toolId: "psm_ipw",
        datasetId: "card1995",
        grade: "W",
        status: "PASS",
        harness: { schemaAccepted: true, executorCalls: 1, lifecycle: ["queued", "running", "completed"] },
      }),
    ).toThrow(/固定为 lalonde_nsw_dw/i)
    expect(() =>
      validateEvidenceRecord(catalog, {
        toolId: "psm_ipw",
        datasetId: "lalonde_nsw_dw",
        grade: "S",
        status: "PASS",
        safety: { rejected: true, reason: "balance gate" },
      }),
    ).toThrow(/must be recorded as SAFE_REJECTION/i)
  })

  test("工具汇总只取确有证据的最高等级", () => {
    expect(
      aggregateToolEvidence([
        { toolId: "psm_construction", datasetId: "lalonde_nsw_dw", grade: "W", status: "PASS" },
        {
          toolId: "psm_construction",
          datasetId: "lalonde_nsw_dw",
          grade: "B",
          status: "PASS",
          numericOracle: { name: "statsmodels", matched: true },
        },
      ]),
    ).toEqual({ toolId: "psm_construction", grade: "B", status: "PASS" })
  })
})
