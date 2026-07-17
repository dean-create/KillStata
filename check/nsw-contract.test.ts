import { describe, expect, test } from "bun:test"
import { ensureNswAnalysisFixture, ensureNswFixture } from "./src/nsw"

describe("NSW/LaLonde PSM benchmark", () => {
  test("downloads the authoritative DW sample into check-only storage and locks its schema", () => {
    const fixture = ensureNswFixture()

    expect(fixture.rows).toBe(445)
    expect(fixture.columns).toEqual(["data_id", "treat", "age", "education", "black", "hispanic", "married", "nodegree", "re74", "re75", "re78"])
    expect(fixture.sha256).toMatch(/^[a-f0-9]{64}$/)
  }, 60_000)

  test("derives a check-only row identifier because authoritative data_id is a sample label, not an observation ID", () => {
    const fixture = ensureNswAnalysisFixture()

    expect(fixture.rows).toBe(445)
    expect(fixture.columns.at(-1)).toBe("unit_id")
    expect(fixture.uniqueUnitCount).toBe(445)
    expect(fixture.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
