// @vitest-environment node
import { spawnSync } from "node:child_process"
import { describe, expect, test } from "vitest"

describe("Desktop sidecar preparation", () => {
  test("refuses a release build without an explicit versioned core binary", () => {
    const result = spawnSync("bun", ["scripts/prepare-sidecars.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, KILLSTATA_ENGINE_BINARY: "" },
      encoding: "utf8",
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain("KILLSTATA_ENGINE_BINARY")
  })

  test("refuses a release build without a core provenance manifest", () => {
    const result = spawnSync("bun", ["scripts/prepare-sidecars.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, KILLSTATA_ENGINE_BINARY: "/bin/echo", KILLSTATA_ENGINE_VERSION: "0.1.0", KILLSTATA_CORE_MANIFEST: "/tmp/missing-core-release.json" },
      encoding: "utf8",
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain("Core manifest")
  })
})
