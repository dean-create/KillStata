import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import * as DatasetState from "@/runtime/dataset-state"

describe("managed source assets", () => {
  test("stores one immutable project copy for equal source content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-source-asset-"))
    const sourcePath = path.join(root, "firms.csv")
    fs.writeFileSync(sourcePath, "firm_id\n00123\n")
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const ensureSourceAsset = (DatasetState as any).ensureSourceAsset
          expect(ensureSourceAsset).toBeFunction()

          const first = ensureSourceAsset({ sourcePath })
          const second = ensureSourceAsset({ sourcePath })
          expect(first.sourceId).toBe(second.sourceId)
          expect(first.managedPath).toContain(`.killstata/sources/${first.sourceId}/`)
          expect(fs.readFileSync(first.managedPath, "utf-8")).toBe("firm_id\n00123\n")
          expect(fs.statSync(first.managedPath).mode & 0o222).toBe(0)

          const renamedPath = path.join(root, "renamed.dta")
          fs.writeFileSync(renamedPath, "firm_id\n00123\n")
          const renamed = ensureSourceAsset({ sourcePath: renamedPath })
          expect(renamed.managedPath).toBe(first.managedPath)
          expect(fs.readdirSync(path.dirname(first.managedPath)).sort()).toEqual([
            path.basename(first.managedPath),
            "source.json",
          ].sort())
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("refuses to write an imported source snapshot through an external sources symlink", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-source-asset-workspace-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-source-asset-external-"))
    const sourcePath = path.join(root, "firms.csv")
    fs.writeFileSync(sourcePath, "firm_id\n00123\n")
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const internal = path.join(root, ".killstata")
          fs.mkdirSync(internal, { recursive: true })
          fs.symlinkSync(external, path.join(internal, "sources"), "dir")
          expect(() => DatasetState.ensureSourceAsset({ sourcePath })).toThrow(/受管源文件|项目之外/)
          expect(fs.readdirSync(external)).toEqual([])
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })
})
