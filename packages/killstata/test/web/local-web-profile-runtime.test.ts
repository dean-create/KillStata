import { describe, expect, test, vi } from "bun:test"
import { Auth } from "../../src/auth"
import { Flag } from "../../src/flag/flag"
import { createLocalWebProfileRuntime } from "../../src/web/local-web-profile-runtime"

describe("local Web active model profile", () => {
  test("keeps the key in process memory and adds only model settings to Core config", async () => {
    const originalConfig = process.env.KILLSTATA_CONFIG_CONTENT
    process.env.KILLSTATA_CONFIG_CONTENT = JSON.stringify({ model: "deepseek/deepseek-v4-flash" })
    const restartCore = vi.fn(async () => {})
    const runtime = createLocalWebProfileRuntime({ restartCore })
    const profile = {
      id: "web-profile-1",
      displayName: "Study model",
      provider: "custom" as const,
      model: "custom/model-a",
      smallModel: "custom/model-b",
      baseURL: "https://models.example/v1",
      apiKey: "active-web-secret",
    }

    try {
      await runtime.activate(profile)

      const config = JSON.parse(Flag.KILLSTATA_CONFIG_CONTENT ?? "{}")
      expect(config.model).toBe("custom/model-a")
      expect(config.provider.custom.options.baseURL).toBe("https://models.example/v1")
      expect(config.provider.custom.models["model-a"]).toBeDefined()
      expect(config.provider.custom.models["model-b"]).toBeDefined()
      expect(JSON.stringify(config)).not.toContain(profile.apiKey)
      expect(await Auth.get("custom")).toEqual({ type: "api", key: profile.apiKey })
      expect(restartCore).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.dispose()
      if (originalConfig === undefined) delete process.env.KILLSTATA_CONFIG_CONTENT
      else process.env.KILLSTATA_CONFIG_CONTENT = originalConfig
      Auth.clearRuntimeOverride("custom")
    }
  })

  test("does not restart every workspace Core when visitors activate the same host profile concurrently", async () => {
    const originalConfig = process.env.KILLSTATA_CONFIG_CONTENT
    delete process.env.KILLSTATA_CONFIG_CONTENT
    const restartCore = vi.fn(async () => {})
    const runtime = createLocalWebProfileRuntime({ restartCore })
    const profile = {
      id: "shared-host-profile",
      displayName: "Host model",
      provider: "custom" as const,
      model: "custom/model-a",
      baseURL: "https://models.example/v1",
      apiKey: "host-secret",
    }

    try {
      await Promise.all([runtime.activate(profile), runtime.activate(profile), runtime.activate(profile)])

      expect(restartCore).toHaveBeenCalledTimes(1)
      expect(await Auth.get("custom")).toEqual({ type: "api", key: profile.apiKey })
    } finally {
      runtime.dispose()
      if (originalConfig === undefined) delete process.env.KILLSTATA_CONFIG_CONTENT
      else process.env.KILLSTATA_CONFIG_CONTENT = originalConfig
      Auth.clearRuntimeOverride("custom")
    }
  })
})
