// @vitest-environment node
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const packageApp = join(process.cwd(), "src-tauri", "target", "release", "bundle", "macos", "KillStata.app")

describe("packaged macOS sidecars", () => {
  test.runIf(existsSync(packageApp))("validate the engine protocol without using a model API", () => {
    const result = spawnSync("bun", ["scripts/verify-release-sidecars.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    })

    expect(result.status).toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('"verified":true')
  }, 35_000)
})
