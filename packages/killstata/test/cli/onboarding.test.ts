import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { hasFirstRunCredential } from "@/cli/onboarding"

describe("first-run onboarding", () => {
  test("requires onboarding when no supported credential is available", () => {
    expect(hasFirstRunCredential({ auth: {} })).toBe(false)
  })

  test("accepts a non-empty DeepSeek environment key", () => {
    expect(
      hasFirstRunCredential({
        deepSeekApiKey: " key-from-environment ",
        auth: {},
      }),
    ).toBe(true)
  })

  test("accepts a saved DeepSeek credential without requiring any other setup", () => {
    expect(
      hasFirstRunCredential({
        auth: {
          deepseek: { type: "api", key: "saved-key" },
        },
      }),
    ).toBe(true)
  })

  test("does not treat an empty saved key as ready", () => {
    expect(
      hasFirstRunCredential({
        auth: {
          deepseek: { type: "api", key: "   " },
        },
      }),
    ).toBe(false)
  })

  test("starts the interface immediately instead of prewarming the analysis runtime", () => {
    const threadSource = fs.readFileSync(path.join(process.cwd(), "src", "cli", "cmd", "tui", "thread.ts"), "utf-8")
    expect(threadSource).not.toContain("prepareFirstRunAnalysisRuntime")
  })
})
