import { describe, expect, test } from "bun:test"
import { inspectLinearmodelsDatasets } from "./src/linearmodels"

describe("linearmodels benchmark runtime", () => {
  test("pins the installed package and the datasets required by base tools", () => {
    const report = inspectLinearmodelsDatasets()

    expect(report.version).toBe("7.0")
    expect(report.datasets).toEqual(expect.arrayContaining(["card", "wage_panel", "munnell", "jobtraining", "mroz", "wage"]))
  })
})
