import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { findDataFiles } from "../../src/data/file-discovery"

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "killstata-file-discovery-"))
}

describe("workspace data file discovery", () => {
  test("returns sorted relative data paths and skips internal or unsupported folders", async () => {
    const root = await tempRoot()
    try {
      for (const directory of ["nested", ".git", ".killstata", "node_modules", "trash", "__pycache__", ".venv", "venv"]) {
        await fs.mkdir(path.join(root, directory), { recursive: true })
      }
      for (const file of ["alpha.csv", "nested/beta.XLSX", "nested/ignored.parquet", ".git/secret.csv", ".killstata/stage.csv", "node_modules/pkg.csv", "trash/old.csv", "__pycache__/cache.csv", ".venv/data.csv", "venv/data.dta"]) {
        await fs.writeFile(path.join(root, file), "x")
      }

      await expect(findDataFiles({ root, query: "" })).resolves.toEqual(["alpha.csv", "nested/beta.XLSX"])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("filters by case-insensitive relative path and clamps the result limit", async () => {
    const root = await tempRoot()
    try {
      await fs.mkdir(path.join(root, "nested"), { recursive: true })
      for (const file of ["nested/Alpha.csv", "nested/Beta.dta", "root.csv"]) {
        await fs.writeFile(path.join(root, file), "x")
      }

      await expect(findDataFiles({ root, query: "ALPHA" })).resolves.toEqual(["nested/Alpha.csv"])
      await expect(findDataFiles({ root, query: "", limit: 0 })).resolves.toHaveLength(1)
      await expect(findDataFiles({ root, query: "", limit: 1 })).resolves.toHaveLength(1)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
