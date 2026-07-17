import { describe, expect, test } from "bun:test"
import { compareNumericResult } from "./src/numeric"
import { loadBenchmarkCatalog, resolveDatasetForTool } from "./src/catalog"

describe("econometrics acceptance base", () => {
  test("routes PSM to the locked NSW benchmark instead of Card", () => {
    const catalog = loadBenchmarkCatalog()

    expect(resolveDatasetForTool(catalog, "psm_matching").id).toBe("lalonde_nsw_dw")
    expect(() => resolveDatasetForTool(catalog, "psm_matching", "card1995")).toThrow("不能替代")
  })

  test("routes two-way fixed effects to the locked real DID panel", () => {
    const catalog = loadBenchmarkCatalog()

    expect(resolveDatasetForTool(catalog, "panel_fe_regression").id).toBe("did_real_panel")
  })

  test("accepts a matching numeric result only when N, coefficient, and SE match their field contracts", () => {
    const expected = { rowsUsed: 4709, coefficient: 0.022531813792214743, stdError: 0.02274759112693289 }
    const actual = { rowsUsed: 4709, coefficient: 0.022531813792214767, stdError: 0.0227475911269329 }

    expect(compareNumericResult(actual, expected)).toEqual([])
  })

  test("rejects a standard-error drift even when the coefficient still matches", () => {
    const expected = { rowsUsed: 4709, coefficient: 0.022531813792214743, stdError: 0.02274759112693289 }
    const drifted = { rowsUsed: 4709, coefficient: 0.022531813792214743, stdError: 0.04 }

    expect(compareNumericResult(drifted, expected)).toContain("stdError")
  })
})
