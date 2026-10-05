import { describe, expect, test } from "bun:test"
import path from "path"

describe("Script package", () => {
  test("package.json exists with correct name", async () => {
    const pkgPath = path.resolve(import.meta.dir, "../package.json")
    const pkg = await Bun.file(pkgPath).json()
    expect(pkg.name).toBe("@killstata/script")
  })

  test("module exports Script with correct shape", async () => {
    const mod = await import("../src/index")
    expect(mod.Script).toBeDefined()
    // channel/version/preview are computed at module load from real env
    expect(typeof mod.Script.channel).toBe("string")
    expect(typeof mod.Script.version).toBe("string")
    expect(typeof mod.Script.preview).toBe("boolean")
  })
})
