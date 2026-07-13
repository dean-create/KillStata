import { describe, expect, test } from "bun:test"
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
})
