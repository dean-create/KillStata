import { read, utils } from "xlsx"

export type ColumnKind = "number" | "text" | "mixed" | "empty"

export type ColumnSummary = {
  name: string
  kind: ColumnKind
  missingCount: number
  uniqueCount: number
  /** 文本/混合列的前五个本地高频值；不包含缺失值。 */
  topValues?: Array<{ value: string; count: number }>
  mean?: number
  standardDeviation?: number
  minimum?: number
  maximum?: number
  histogram?: number[]
}

export type DataPreview = {
  headers: string[]
  totalRows: number
  /** 仅供本机结构检查使用；表格界面仍严格显示前 50 行。 */
  observations: string[][]
  rows: string[][]
  columns: ColumnSummary[]
}

export type PanelStructure = {
  kind: "balanced" | "unbalanced" | "ambiguous" | "not-panel"
  individualCount: number
  periodCount: number
  observedCellCount: number
  expectedCellCount: number
  duplicateCellCount: number
  incompleteRowCount: number
}

export type CsvPreview = DataPreview

export type WorkbookPreview = {
  sheetNames: string[]
  selectedSheetName: string | undefined
  preview: DataPreview
}

const displayRowLimit = 50
function parseCsvRows(source: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (!quoted && character === ",") {
      row.push(cell)
      cell = ""
      continue
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && source[index + 1] === "\n") index += 1
      row.push(cell)
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
      cell = ""
      continue
    }
    cell += character
  }

  row.push(cell)
  if (row.some((value) => value.trim())) rows.push(row)
  return rows
}

function isMissingValue(value: string) {
  return value.trim() === ""
}

function numericHistogram(values: number[], minimum: number, maximum: number) {
  if (minimum === maximum) return [values.length]
  const binCount = Math.min(8, Math.max(2, Math.ceil(Math.sqrt(values.length))))
  const bins = Array.from({ length: binCount }, () => 0)
  const width = (maximum - minimum) / binCount
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor((value - minimum) / width))
    bins[index] += 1
  }
  return bins
}

function topValueFrequencies(values: string[]) {
  const frequencies = new Map<string, { count: number; firstIndex: number }>()
  values.forEach((value, index) => {
    const current = frequencies.get(value)
    if (current) current.count += 1
    else frequencies.set(value, { count: 1, firstIndex: index })
  })
  return [...frequencies.entries()]
    .sort(([, left], [, right]) => right.count - left.count || left.firstIndex - right.firstIndex)
    .slice(0, 5)
    .map(([value, { count }]) => ({ value, count }))
}

function summarizeColumn(name: string, values: string[]): ColumnSummary {
  const observed = values.filter((value) => !isMissingValue(value)).map((value) => value.trim())
  const missingCount = values.length - observed.length
  const uniqueCount = new Set(observed).size
  if (!observed.length) return { name, kind: "empty", missingCount, uniqueCount }

  const numericValues = observed.map((value) => Number(value))
  const numericCount = numericValues.filter(Number.isFinite).length
  if (!numericCount) return { name, kind: "text", missingCount, uniqueCount, topValues: topValueFrequencies(observed) }
  if (numericCount !== observed.length) return { name, kind: "mixed", missingCount, uniqueCount, topValues: topValueFrequencies(observed) }

  let minimum = numericValues[0]
  let maximum = numericValues[0]
  for (const value of numericValues) {
    if (value < minimum) minimum = value
    if (value > maximum) maximum = value
  }
  const mean = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
  const squaredDistance = numericValues.reduce((sum, value) => sum + (value - mean) ** 2, 0)
  const standardDeviation = numericValues.length > 1 ? Math.sqrt(squaredDistance / (numericValues.length - 1)) : 0
  return {
    name,
    kind: "number",
    missingCount,
    uniqueCount,
    mean,
    standardDeviation,
    minimum,
    maximum,
    histogram: numericHistogram(numericValues, minimum, maximum),
  }
}

function previewFromRows(headers: string[], sourceRows: string[][]): DataPreview {
  if (headers.some((header) => !header.trim())) throw new Error("数据列名不能为空")
  const normalizedNames = headers.map((header) => header.trim())
  if (new Set(normalizedNames).size !== normalizedNames.length) throw new Error("数据列名重复")
  const normalizedRows = sourceRows.map((row) => headers.map((_, index) => row[index] ?? ""))
  return {
    headers,
    totalRows: normalizedRows.length,
    observations: normalizedRows,
    rows: normalizedRows.slice(0, displayRowLimit),
    columns: headers.map((header, index) => summarizeColumn(header, normalizedRows.map((row) => row[index]))),
  }
}

/**
 * 这是严格的数据形状检查，不推断计量设定：研究者必须先准确指定单位与时间字段。
 * 同一单位-时间单元出现多行时不能擅自汇总，因此返回 ambiguous 而不是伪称非平衡面板。
 */
export function inspectPanelStructure(preview: DataPreview, unitName: string, timeName: string): PanelStructure | undefined {
  const unitIndex = preview.headers.indexOf(unitName.trim())
  const timeIndex = preview.headers.indexOf(timeName.trim())
  if (unitIndex < 0 || timeIndex < 0 || unitIndex === timeIndex) return undefined

  const individuals = new Set<string>()
  const periods = new Set<string>()
  const cells = new Set<string>()
  let completeRows = 0
  let incompleteRowCount = 0

  for (const row of preview.observations) {
    const individual = row[unitIndex]?.trim() ?? ""
    const period = row[timeIndex]?.trim() ?? ""
    if (isMissingValue(individual) || isMissingValue(period)) {
      incompleteRowCount += 1
      continue
    }
    completeRows += 1
    individuals.add(individual)
    periods.add(period)
    cells.add(`${individual}\u0000${period}`)
  }

  const individualCount = individuals.size
  const periodCount = periods.size
  const observedCellCount = cells.size
  const expectedCellCount = individualCount * periodCount
  const duplicateCellCount = completeRows - observedCellCount
  const kind = individualCount < 2 || periodCount < 2
    ? "not-panel"
    : duplicateCellCount > 0 || incompleteRowCount > 0
      ? "ambiguous"
      : observedCellCount === expectedCellCount
        ? "balanced"
        : "unbalanced"

  return {
    kind,
    individualCount,
    periodCount,
    observedCellCount,
    expectedCellCount,
    duplicateCellCount,
    incompleteRowCount,
  }
}

export function parseCsvPreview(source: string): DataPreview {
  const [headers = [], ...rows] = parseCsvRows(source)
  const normalizedHeaders = headers.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "") : value)
  return previewFromRows(normalizedHeaders, rows)
}

function previewWorksheet(worksheet: ReturnType<typeof read>["Sheets"][string] | undefined): DataPreview {
  if (!worksheet) return { headers: [], totalRows: 0, observations: [], rows: [], columns: [] }
  const [headerRow = [], ...rows] = utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  })
  const headers = headerRow.map((value, index) => {
    const text = String(value ?? "")
    return index === 0 ? text.replace(/^\uFEFF/, "") : text
  })

  return previewFromRows(headers, rows.map((row) => row.map((value) => String(value ?? ""))))
}

export function parseWorkbook(source: ArrayBuffer, sheetName?: string): WorkbookPreview {
  const workbook = read(source, { type: "array", cellText: true })
  const sheetNames = workbook.SheetNames
  const selectedSheetName = sheetName && sheetNames.includes(sheetName) ? sheetName : sheetNames[0]

  return {
    sheetNames,
    selectedSheetName,
    preview: previewWorksheet(selectedSheetName ? workbook.Sheets[selectedSheetName] : undefined),
  }
}

export function parseWorkbookPreview(source: ArrayBuffer, sheetName?: string): DataPreview {
  return parseWorkbook(source, sheetName).preview
}
