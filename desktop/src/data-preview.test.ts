import { describe, expect, test } from "vitest"
import * as XLSX from "xlsx"
import { inspectPanelStructure, parseCsvPreview } from "./data-preview"
import * as dataPreview from "./data-preview"

describe("parseCsvPreview", () => {
  test("keeps up to fifty local rows in a compact table", () => {
    const preview = parseCsvPreview([
      "firm,employment,policy",
      "A,12,0",
      "B,15,0",
      "C,11,1",
      "D,17,1",
      "E,14,1",
      "F,13,0",
      "G,16,1",
    ].join("\n"))

    expect(preview).toMatchObject({
      headers: ["firm", "employment", "policy"],
      totalRows: 7,
      rows: [
        ["A", "12", "0"],
        ["B", "15", "0"],
        ["C", "11", "1"],
        ["D", "17", "1"],
        ["E", "14", "1"],
        ["F", "13", "0"],
        ["G", "16", "1"],
      ],
    })
  })

  test("derives local column facts from all CSV rows while capping the displayed table at fifty", () => {
    const source = [
      "firm,employment,policy,note",
      "A,10,0,stable",
      "B,12,0,stable",
      "C,14,1,treated",
      "D,,1,NA",
      "E,16,1,.",
      ...Array.from({ length: 50 }, (_, index) => `firm-${index + 6},${index + 20},${index % 2},note-${index + 6}`),
    ].join("\n")

    const preview = parseCsvPreview(source)
    expect(preview.rows).toHaveLength(50)
    expect(preview).toMatchObject({
      totalRows: 55,
      columns: [
        { name: "firm", kind: "text", missingCount: 0, uniqueCount: 55 },
        { name: "employment", kind: "number", missingCount: 1, uniqueCount: 54, mean: expect.any(Number), standardDeviation: expect.any(Number), minimum: 10, maximum: 69, histogram: expect.any(Array) },
        { name: "policy", kind: "number", missingCount: 0, uniqueCount: 2, mean: expect.any(Number), standardDeviation: expect.any(Number), minimum: 0, maximum: 1, histogram: expect.any(Array) },
        { name: "note", kind: "text", missingCount: 0, uniqueCount: 54 },
      ],
    })

    const employment = preview.columns[1]
    expect(employment.mean).toBeCloseTo(42.1667, 3)
    expect(employment.standardDeviation).toBeGreaterThan(0)
  })

  test("keeps a compact local value distribution for a text column", () => {
    const preview = parseCsvPreview([
      "region,outcome",
      "东部,12",
      "西部,9",
      "东部,11",
      "中部,10",
      "东部,13",
      "西部,8",
      "北部,7",
      "南部,6",
      "海外,5",
    ].join("\n"))

    expect(preview.columns[0]).toMatchObject({
      name: "region",
      kind: "text",
      topValues: [
        { value: "东部", count: 3 },
        { value: "西部", count: 2 },
        { value: "中部", count: 1 },
        { value: "北部", count: 1 },
        { value: "南部", count: 1 },
      ],
    })
  })

  test("classifies selected unit and time fields from all local observations, including gaps and duplicate cells", () => {
    const balanced = parseCsvPreview([
      "firm,year,outcome",
      "A,2020,10",
      "A,2021,12",
      "B,2020,8",
      "B,2021,11",
    ].join("\n"))
    const unbalanced = parseCsvPreview([
      "firm,year,outcome",
      "A,2020,10",
      "A,2021,12",
      "B,2020,8",
      "B,2020,9",
      "B,,11",
    ].join("\n"))

    expect(inspectPanelStructure(balanced, "firm", "year")).toMatchObject({
      kind: "balanced",
      individualCount: 2,
      periodCount: 2,
      observedCellCount: 4,
      expectedCellCount: 4,
      duplicateCellCount: 0,
      incompleteRowCount: 0,
    })
    expect(inspectPanelStructure(unbalanced, "firm", "year")).toMatchObject({
      kind: "ambiguous",
      individualCount: 2,
      periodCount: 2,
      observedCellCount: 3,
      expectedCellCount: 4,
      duplicateCellCount: 1,
      incompleteRowCount: 1,
    })
  })

  test("does not mistake the first fifty displayed rows for the complete panel shape", () => {
    const preview = parseCsvPreview([
      "firm,year",
      ...Array.from({ length: 50 }, (_, index) => `A,${index + 1}`),
      "B,1",
    ].join("\n"))

    expect(preview.rows).toHaveLength(50)
    expect(inspectPanelStructure(preview, "firm", "year")).toMatchObject({
      kind: "unbalanced",
      individualCount: 2,
      periodCount: 50,
      observedCellCount: 51,
      expectedCellCount: 100,
    })
  })

  test("does not split a quoted comma into a second column", () => {
    const preview = parseCsvPreview('firm,note\nA,"before, policy"')

    expect(preview.rows).toEqual([["A", "before, policy"]])
  })

  test("keeps NA, none and dot as observed category values instead of guessing missingness", () => {
    const preview = parseCsvPreview("status\nNA\nnone\n.\n")

    expect(preview.columns[0]).toMatchObject({
      kind: "text",
      missingCount: 0,
      uniqueCount: 3,
      topValues: [
        { value: "NA", count: 1 },
        { value: "none", count: 1 },
        { value: ".", count: 1 },
      ],
    })
  })

  test("rejects empty or duplicate headers instead of publishing ambiguous local facts", () => {
    expect(() => parseCsvPreview("firm,,outcome\nA,2020,1")).toThrow("列名不能为空")
    expect(() => parseCsvPreview("firm,firm,outcome\nA,2020,1")).toThrow("列名重复")
  })

  test("summarizes a large numeric column without expanding it into function arguments", () => {
    const rowCount = 150_000
    const preview = parseCsvPreview(["value", ...Array.from({ length: rowCount }, (_, index) => String(index + 1))].join("\n"))

    expect(preview.columns[0]).toMatchObject({
      kind: "number",
      minimum: 1,
      maximum: rowCount,
      uniqueCount: rowCount,
    })
  })

  test("reads the first local worksheet into the same compact preview", () => {
    const workbook = XLSX.utils.book_new()
    const firstWorksheet = XLSX.utils.aoa_to_sheet([
      ["firm", "employment", "policy"],
      ["A", 12, 0],
      ["B", 15, 0],
      ["C", 11, 1],
      ["D", 17, 1],
      ["E", 14, 1],
      ["F", 13, 0],
      ["G", 16, 1],
    ])
    XLSX.utils.book_append_sheet(workbook, firstWorksheet, "研究数据")
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["不应", "读取"]]), "第二张表")
    const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer
    const parser = (dataPreview as typeof dataPreview & {
      parseWorkbookPreview?: (source: ArrayBuffer) => { headers: string[]; totalRows: number; rows: string[][] }
    }).parseWorkbookPreview

    expect(parser).toBeTypeOf("function")
    if (!parser) return

    expect(parser(bytes)).toMatchObject({
      headers: ["firm", "employment", "policy"],
      totalRows: 7,
      rows: [
        ["A", "12", "0"],
        ["B", "15", "0"],
        ["C", "11", "1"],
        ["D", "17", "1"],
        ["E", "14", "1"],
        ["F", "13", "0"],
        ["G", "16", "1"],
      ],
    })
  })

  test("selects a named local worksheet while preserving the available sheet order", () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["firm", "employment"],
      ["A", 12],
    ]), "基准样本")
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["region", "wage"],
      ["东部", 8],
      ["西部", 7],
    ]), "地区样本")
    const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer
    const parser = (dataPreview as typeof dataPreview & {
      parseWorkbook?: (source: ArrayBuffer, sheetName?: string) => {
        sheetNames: string[]
        selectedSheetName: string | undefined
        preview: { headers: string[]; totalRows: number; rows: string[][] }
      }
    }).parseWorkbook

    expect(parser).toBeTypeOf("function")
    if (!parser) return

    expect(parser(bytes, "地区样本")).toMatchObject({
      sheetNames: ["基准样本", "地区样本"],
      selectedSheetName: "地区样本",
      preview: {
        headers: ["region", "wage"],
        totalRows: 2,
        rows: [["东部", "8"], ["西部", "7"]],
      },
    })
    expect(parser(bytes, "已删除工作表").selectedSheetName).toBe("基准样本")
  })
})
