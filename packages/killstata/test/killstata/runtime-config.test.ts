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
})
