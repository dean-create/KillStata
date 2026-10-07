/**
 * 计量结果系数表的终端渲染：定宽等号线 + 按显示宽度对齐的列，替代此前逐行拼接的
 * "变量：系数 x，标准误 y，p 值 z" 纯文本。中文变量名/标签在等宽终端里占两列宽，
 * 必须用 Bun.stringWidth 而非 length 计算列宽，否则中英文混排必然错位。
 */

export type CoefficientRow = {
  term: string
  estimate: number | null
  stdError?: number | null
  pValue?: number | null
  confLow?: number | null
  confHigh?: number | null
}

export type CoefficientColumn<T extends CoefficientRow = CoefficientRow> = {
  header: string
  value: (row: T) => string
}

/** 极小 p 值遵循学术惯例显示为 <0.001，避免 toFixed 把 1e-10 这类值显示成 0.0000 丢失显著性信息。 */
export function formatPValue(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—"
  if (v < 0.001) return "<0.001"
  return v.toFixed(3)
}

export function formatSignificance(p: number | null | undefined): string {
  if (typeof p !== "number" || !Number.isFinite(p)) return ""
  if (p < 0.001) return "***"
  if (p < 0.01) return "**"
  if (p < 0.05) return "*"
  if (p < 0.1) return "·"
  return ""
}

/** 系数/标准误等连续值：定宽 4 位小数，正数补一个空格对齐负号，保证竖直列对齐。 */
export function formatEstimate(v: number | null | undefined, digits = 4): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—"
  const text = v.toFixed(digits)
  return v < 0 ? text : ` ${text}`
}

function displayWidth(text: string): number {
  return Bun.stringWidth(text)
}

function padDisplay(text: string, width: number, align: "left" | "right"): string {
  const gap = Math.max(0, width - displayWidth(text))
  const padding = " ".repeat(gap)
  return align === "left" ? text + padding : padding + text
}

const DEFAULT_COLUMNS: CoefficientColumn[] = [
  { header: "变量", value: (row) => row.term },
  { header: "系数", value: (row) => `${formatEstimate(row.estimate)}${formatSignificance(row.pValue)}` },
  { header: "标准误", value: (row) => formatEstimate(row.stdError) },
  { header: "p 值", value: (row) => formatPValue(row.pValue) },
]

export const COLUMNS_WITH_CI: CoefficientColumn[] = [
  ...DEFAULT_COLUMNS,
  {
    header: "95% CI",
    value: (row) => `[${formatEstimate(row.confLow).trim()}, ${formatEstimate(row.confHigh).trim()}]`,
  },
]

/**
 * 渲染一张定宽系数表。第一列（变量名）左对齐，其余数值列右对齐；列宽取表头和
 * 该列全部数据里显示宽度的最大值，用 ─ 画分隔线。系数后追加显著性标记（*** p<0.001, ** p<0.01, * p<0.05, · p<0.1）。
 */
export function renderCoefficientTable<T extends CoefficientRow = CoefficientRow>(
  rows: T[],
  columns: CoefficientColumn<T>[] = DEFAULT_COLUMNS as CoefficientColumn<T>[],
): string {
  if (rows.length === 0) return ""

  const cells = rows.map((row) => columns.map((col) => col.value(row)))
  const widths = columns.map((col, i) =>
    Math.max(displayWidth(col.header), ...cells.map((cellRow) => displayWidth(cellRow[i]))),
  )

  const renderRow = (values: string[]) =>
    values.map((value, i) => padDisplay(value, widths[i], i === 0 ? "left" : "right")).join("  ")

  const headerSep = widths.map((width) => "─".repeat(width)).join("──")
  const topSep = widths.map((width) => "═".repeat(width)).join("══")

  const header = renderRow(columns.map((col) => col.header))
  const note = "注：*** p<0.001, ** p<0.01, * p<0.05, · p<0.1"

  return [
    header,
    headerSep,
    ...cells.map((cellRow) => renderRow(cellRow)),
    topSep,
    note,
  ].join("\n")
}
