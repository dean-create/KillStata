import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  expandPath,
  formatSize,
  listDataDir,
  looksLikePath,
  parentDir,
} from "../../src/cli/cmd/tui/component/data-file-browser"

let root: string

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-browser-"))
  // 数据文件
  fs.writeFileSync(path.join(root, "panel.csv"), "a,b\n1,2\n")
  fs.writeFileSync(path.join(root, "研究数据.xlsx"), "fake")
  fs.writeFileSync(path.join(root, "legacy.dta"), "fake")
  // 不该出现在列表里的文件
  fs.writeFileSync(path.join(root, "notes.txt"), "no")
  fs.writeFileSync(path.join(root, "script.py"), "no")
  fs.writeFileSync(path.join(root, "stage_000.parquet"), "no")
  // 目录
  fs.mkdirSync(path.join(root, "raw"))
  fs.mkdirSync(path.join(root, "node_modules"))
  fs.mkdirSync(path.join(root, ".git"))
  fs.mkdirSync(path.join(root, ".killstata"))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("tui.data-file-browser", () => {
  test("lists only data files the import pipeline can actually read", () => {
    const { entries } = listDataDir(root)
    const files = entries.filter((e) => e.kind === "file").map((e) => e.name)

    expect(files.sort()).toEqual(["legacy.dta", "panel.csv", "研究数据.xlsx"].sort())
    // txt/py 分析不了；parquet 是内部 stage 格式，用户手工挑它会绕过 QA 和 stage 追踪。
    expect(files).not.toContain("notes.txt")
    expect(files).not.toContain("script.py")
    expect(files).not.toContain("stage_000.parquet")
  })

  test("hides noise directories that never hold user data", () => {
    const { entries } = listDataDir(root)
    const dirs = entries.filter((e) => e.kind === "dir").map((e) => e.name)

    expect(dirs).toContain("raw")
    for (const noise of ["node_modules", ".git", ".killstata"]) {
      expect(dirs).not.toContain(noise)
    }
  })

  test("directories are listed before files, so navigating is not a treasure hunt", () => {
    const { entries } = listDataDir(root)
    const firstFileIndex = entries.findIndex((e) => e.kind === "file")
    const lastDirIndex = entries.map((e) => e.kind).lastIndexOf("dir")

    expect(lastDirIndex).toBeLessThan(firstFileIndex)
  })

  test("attaches file size so the user can anticipate a slow import", () => {
    const { entries } = listDataDir(root)
    const csv = entries.find((e) => e.name === "panel.csv")

    expect(csv?.kind).toBe("file")
    expect(csv?.kind === "file" && csv.size).toBeGreaterThan(0)
  })

  test("an unreadable directory yields an error instead of throwing", () => {
    const { entries, error } = listDataDir(path.join(root, "does-not-exist"))

    expect(entries).toHaveLength(0)
    expect(error).toBeTruthy()
  })

  test("expands ~ to the home directory (users type ~/Desktop/data.xlsx)", () => {
    expect(expandPath("~")).toBe(os.homedir())
    expect(expandPath("~/Desktop/data.xlsx")).toBe(path.join(os.homedir(), "Desktop", "data.xlsx"))
  })

  test("resolves relative paths to absolute ones", () => {
    expect(path.isAbsolute(expandPath("./data.csv"))).toBe(true)
  })

  test("tells a path apart from a filter query", () => {
    // 这些是在指路径 —— 应该直接跳过去。
    for (const p of ["/Users/x/data.csv", "~/data.csv", "./data.csv", "../data.csv"]) {
      expect(looksLikePath(p)).toBe(true)
    }
    // 这些是在按名字筛选 —— 不该被当成路径。
    for (const q of ["panel", "研究", "grunfeld.csv"]) {
      expect(looksLikePath(q)).toBe(false)
    }
  })

  test("parentDir stops at the filesystem root instead of looping forever", () => {
    expect(parentDir("/")).toBeUndefined()
    expect(parentDir("/Users/x")).toBe("/Users")
  })

  test("formats sizes in units a human reads", () => {
    expect(formatSize(512)).toBe("512 B")
    expect(formatSize(2048)).toBe("2 KB")
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB")
  })
})
