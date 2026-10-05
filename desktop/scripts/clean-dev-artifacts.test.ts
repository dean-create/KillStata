import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { CLEAN_TARGETS, cleanTargets } from "./clean-dev-artifacts"

describe("Desktop development artifact cleanup", () => {
  test("cleans only the explicit generated directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-desktop-clean-"))
    try {
      for (const relative of CLEAN_TARGETS) {
        fs.mkdirSync(path.join(root, relative), { recursive: true })
        fs.writeFileSync(path.join(root, relative, "generated"), "x")
      }
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(path.join(root, "src", "keep.ts"), "keep")

      cleanTargets(root)

      for (const relative of CLEAN_TARGETS) expect(fs.existsSync(path.join(root, relative))).toBe(false)
      expect(fs.existsSync(path.join(root, "src", "keep.ts"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
