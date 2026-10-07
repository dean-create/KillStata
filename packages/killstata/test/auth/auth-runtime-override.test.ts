import { describe, expect, test } from "bun:test"
import { Auth } from "../../src/auth"

describe("runtime-only provider credentials", () => {
  test("uses a temporary credential without persisting it to auth.json", async () => {
    const providerID = `web-test-${crypto.randomUUID()}`
    const info = { type: "api" as const, key: "local-web-secret" }

    Auth.setRuntimeOverride(providerID, info)
    try {
      expect(await Auth.get(providerID)).toEqual(info)
    } finally {
      Auth.clearRuntimeOverride(providerID)
    }

    expect(await Auth.get(providerID)).toBeUndefined()
  })
})
