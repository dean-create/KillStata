import { describe, expect, test } from "bun:test"
import { DATA_FILE_EXTENSIONS, isDataFile, unsupportedDataFileMessage } from "../../src/tool/data-file"

describe("tool.data-file", () => {
  test("accepts exactly the formats the import pipeline can read", () => {
    for (const name of ["panel.csv", "研究数据.xlsx", "old.xls", "stata.dta"]) {
      expect(isDataFile(name)).toBe(true)
    }
  })

  test("extension matching is case-insensitive (Windows exports are often .CSV / .XLSX)", () => {
    expect(isDataFile("DATA.CSV")).toBe(true)
    expect(isDataFile("Book1.XLSX")).toBe(true)
  })

  test("rejects everything the product cannot actually analyze", () => {
    for (const name of ["notes.txt", "script.py", "report.pdf", "archive.zip", "README", "data.json"]) {
      expect(isDataFile(name)).toBe(false)
    }
  })

  test("parquet is rejected: it is our internal stage format, not a file users should pick", () => {
    // 用户手工挑 parquet 等于绕过 import 流程，会跳过 QA 和 stage 追踪。
    expect(isDataFile("stage_000_import.parquet")).toBe(false)
  })

  test("full paths work, not just bare filenames", () => {
    expect(isDataFile("/Users/x/研究/面板数据.dta")).toBe(true)
    expect(isDataFile("/Users/x/研究/notes.md")).toBe(false)
  })

  test("the rejection message tells the user what IS supported, not just what failed", () => {
    const message = unsupportedDataFileMessage("report.pdf")
    expect(message).toContain(".pdf")
    for (const ext of DATA_FILE_EXTENSIONS) {
      expect(message).toContain(ext)
    }
  })
})
