import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { HeterogeneityRunnerInputSchema } from "../../src/tool/heterogeneity-runner"

describe("tool.heterogeneity_runner", () => {
  test("placebo schema no longer declares the unexecuted policyTimes field", () => {
    const parsed = HeterogeneityRunnerInputSchema.safeParse({
      methodFamily: "did",
      dependentVar: "y",
      treatmentVar: "d",
      placebo: { variables: ["placebo_var"] },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.placebo).toEqual({ variables: ["placebo_var"] })
    }
  })

  test("source no longer contains the v1 policyTimes placeholder warning", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "heterogeneity-runner.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")
    expect(source).not.toContain("policyTimes")
  })
})
