import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

describe("session.system prompt contracts", () => {
  test("econometrics prompt defaults vague baselines to smart_baseline and keeps explicit estimators", () => {
    const sourcePath = path.join(process.cwd(), "src", "session", "system.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")

    expect(source).toContain("prefer econometrics with methodName=\"smart_baseline\"")
    expect(source).toContain("prefer econometrics with methodName=\"auto_recommend\"")
    expect(source).toContain("respect that method unless it is not executable")
    expect(source).toContain("original request, the failure reason, and the executed method")
  })

  test("econometrics tool contract documents rescue behavior for explicit method failures", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "econometrics.txt")
    const source = fs.readFileSync(sourcePath, "utf-8")

    expect(source).toContain("use `smart_baseline`")
    expect(source).toContain("use `auto_recommend`")
    expect(source).toContain("keep that estimator unless it is not executable")
    expect(source).toContain("rescue to `smart_baseline`")
  })
})
