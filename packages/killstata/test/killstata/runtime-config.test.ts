import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

describe("killstata.runtime-config home directories", () => {
  test("ensureKillstataHomeDirectories no longer creates an unused memory/ directory, but still writes MEMORY.md", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-home-"))
    const previousTestHome = process.env.KILLSTATA_TEST_HOME
    process.env.KILLSTATA_TEST_HOME = tempHome
    try {
      const { ensureKillstataHomeDirectories, userRoot, userWorkspaceMemoryPath } = await import(
        "../../src/killstata/runtime-config"
      )
      await ensureKillstataHomeDirectories()

      expect(fs.existsSync(path.join(userRoot(), "memory"))).toBe(false)
      expect(fs.existsSync(userWorkspaceMemoryPath())).toBe(true)
    } finally {
      if (previousTestHome === undefined) delete process.env.KILLSTATA_TEST_HOME
      else process.env.KILLSTATA_TEST_HOME = previousTestHome
      fs.rmSync(tempHome, { recursive: true, force: true })
    }
  })

  test("uses a pinned uv release asset to bootstrap a private Windows runtime", async () => {
    const { uvReleaseAsset } = await import("../../src/killstata/runtime-config")

    expect(uvReleaseAsset({ platform: "win32", arch: "x64" })).toEqual({
      archive: "uv-x86_64-pc-windows-msvc.zip",
      executable: "uv.exe",
      compressed: "zip",
    })
    expect(uvReleaseAsset({ platform: "win32", arch: "arm64" })?.archive).toBe("uv-aarch64-pc-windows-msvc.zip")
    expect(uvReleaseAsset({ platform: "freebsd", arch: "x64" })).toBeUndefined()
  })

  test("reports automatic runtime setup failures without sending users to config", async () => {
    const { formatRuntimePythonSetupError } = await import("../../src/killstata/runtime-config")
    const message = formatRuntimePythonSetupError("econometrics", {
      executable: "python3",
      source: "default",
      ok: false,
      error: "network unavailable",
      missing: [],
      installCommand: "python3 -m pip install ...",
    })

    expect(message).toContain("data-analysis engine")
    expect(message).not.toContain("killstata config")
  })
})
