import { describe, expect, test } from "bun:test"
import { verifyWorkbookContracts } from "./src/workbook-contract"

describe("real workbook contracts", () => {
  test("locks the two user Excel datasets and preserves their panel facts", () => {
    const report = verifyWorkbookContracts()

    expect(report.did).toMatchObject({
      rows: 4709,
      entities: 277,
      periods: 17,
      duplicateEntityTimeRows: 0,
      treatmentReversals: 0,
    })
    expect(report.digital).toMatchObject({
      rows: 9683,
      compositeEntities: 421,
      ambiguousDuplicateEntityTimeRows: 115,
      compositeDuplicateEntityTimeRows: 0,
    })
  }, 60_000)
})
