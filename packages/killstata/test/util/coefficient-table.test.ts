import { describe, expect, test } from "bun:test"
import { formatEstimate, formatPValue, renderCoefficientTable } from "@/util/coefficient-table"

describe("formatPValue", () => {
  test("extremely small p 值显示为 <0.001，不被 toFixed 抹成 0.000", () => {
    expect(formatPValue(1e-10)).toBe("<0.001")
    expect(formatPValue(0.0009)).toBe("<0.001")
  })

  test("正常范围保留 3 位小数", () => {
    expect(formatPValue(0.0421)).toBe("0.042")
    expect(formatPValue(0.5)).toBe("0.500")
  })

  test("非有限值显示为占位符", () => {
    expect(formatPValue(null)).toBe("—")
    expect(formatPValue(undefined)).toBe("—")
    expect(formatPValue(NaN)).toBe("—")
  })
})

describe("formatEstimate", () => {
  test("正数补一个前导空格，与负数的负号对齐同一列宽", () => {
    const positive = formatEstimate(0.3211)
    const negative = formatEstimate(-0.3211)
    expect(Bun.stringWidth(positive)).toBe(Bun.stringWidth(negative))
  })
})

describe("renderCoefficientTable", () => {
  test("中英文变量名混排时按显示宽度而非字符数对齐", () => {
    const table = renderCoefficientTable([
      { term: "education", estimate: 0.3211, stdError: 0.0452, pValue: 0.0000012 },
      { term: "处理组均值", estimate: -1.2, stdError: 0.5, pValue: 0.03 },
    ])
    const lines = table.split("\n")
    // 表头 + 分隔线 + 两条数据行 + 底部分隔 + 注
    expect(lines.length).toBe(6)
    // 数据行的显示宽度必须一致（表头/分隔线/注 可能不同）
    const dataLines = [lines[0], lines[2], lines[3]]
    const widths = dataLines.map((line) => Bun.stringWidth(line))
    expect(new Set(widths).size).toBe(1)
    expect(table).toContain("***")
  })

  test("空系数列表返回空字符串而不是只有表头的表格", () => {
    expect(renderCoefficientTable([])).toBe("")
  })

  test("极小 p 值不会撑爆列宽（<0.001 比 0.0000012 短）", () => {
    const table = renderCoefficientTable([{ term: "x", estimate: 1, stdError: 1, pValue: 1e-10 }])
    expect(table).toContain("<0.001")
    expect(table).not.toContain("1e-10")
  })
})
