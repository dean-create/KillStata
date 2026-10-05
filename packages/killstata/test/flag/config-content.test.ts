import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

const originalConfig = process.env.KILLSTATA_CONFIG_CONTENT

afterEach(() => {
  if (originalConfig === undefined) delete process.env.KILLSTATA_CONFIG_CONTENT
  else process.env.KILLSTATA_CONFIG_CONTENT = originalConfig
})

describe("runtime config content flag", () => {
  test("reads the current process value so a managed host can reconfigure Core", () => {
    const config = JSON.stringify({ model: "custom/model-a" })
    process.env.KILLSTATA_CONFIG_CONTENT = config

    expect(Flag.KILLSTATA_CONFIG_CONTENT).toBe(config)
  })
})
