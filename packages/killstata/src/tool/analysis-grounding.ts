import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"

export type NumericMetric =
  | "coefficient"
  | "std_error"
  | "p_value"
  | "r_squared"
  | "n_obs"
  | "group_count"
  | "mean"
  | "std"
  | "min"
  | "max"
  | "correlation"
  | "ci_lower"
  | "ci_upper"
  | "median"
  | "q1"
  | "q3"
  | "missing_count"
  | "missing_share"

export type GroundingScope = "regression" | "descriptive" | "correlation" | "diagnostics"

export type NumericSnapshotEntry = {
  metric: NumericMetric
  scope: GroundingScope
  term: string
  model?: string
  value: number
  display: string
  sourcePath: string
  datasetId?: string
  stageId?: string
  runId?: string
  significance?: "" | "*" | "**" | "***"
}

export type NumericSnapshotDocument = {
  version: 1
  sourceTool: "econometrics" | "data_import" | "grounding"
  scope: GroundingScope
  generatedAt: string
  snapshotPath: string
  datasetId?: string
  stageId?: string
  runId?: string
  entries: NumericSnapshotEntry[]
  context?: Record<string, unknown>
}

export type GroundingIssue = {
  type: "missing_snapshot" | "ungrounded_value" | "sign_mismatch" | "significance_mismatch"
  line: string
  detail: string
  metric?: NumericMetric
}

export type GroundingLineRemediation = {
  line: string
  replacement: string
  issueTypes: GroundingIssue["type"][]
}

export type GroundingResult = {
  status: "pass" | "partial" | "not_applicable" | "fail"
  issues: GroundingIssue[]
  snapshotPaths: string[]
  trustedSourcePaths: string[]
  redactions: GroundingLineRemediation[]
  unverifiedMetrics: NumericMetric[]
  recovered: boolean
}

type SnapshotMeta = {
  datasetId?: string
  stageId?: string
  runId?: string
}

function nowIso() {
  return new Date().toISOString()
}

function stripBom(text: string) {
  return text.replace(/^\uFEFF/, "")
}

function significanceStars(pValue?: number) {
  if (pValue === undefined || !Number.isFinite(pValue)) return ""
  if (pValue < 0.01) return "***"
  if (pValue < 0.05) return "**"
  if (pValue < 0.1) return "*"
  return ""
}

function parseNumeric(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const normalized = value.trim().replace(/,/g, "")
  if (!normalized) return undefined
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

function formatValue(metric: NumericMetric, value: number) {
  if (metric === "n_obs" || metric === "group_count" || metric === "missing_count") return `${Math.round(value)}`
  return value.toFixed(6)
}

function normalizeMetric(metric: NumericMetric) {
  return metric.toLowerCase()
}

function csvRows(filePath: string) {
  const raw = stripBom(fs.readFileSync(filePath, "utf-8"))
  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let quoted = false

  for (let idx = 0; idx < raw.length; idx += 1) {
    const char = raw[idx]
    const next = raw[idx + 1]
    if (char === '"') {
      if (quoted && next === '"') {
        field += '"'
        idx += 1
        continue
      }
      quoted = !quoted
      continue
    }
    if (!quoted && char === ",") {
      row.push(field)
      field = ""
      continue
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") idx += 1
      row.push(field)
      if (row.some((item) => item.length > 0)) rows.push(row)
      row = []
      field = ""
      continue
    }
    field += char
  }
  row.push(field)
  if (row.some((item) => item.length > 0)) rows.push(row)
  return rows
}

function csvRecords(filePath: string) {
  const rows = csvRows(filePath)
  if (rows.length === 0) return []
  const headers = rows[0]!.map((item) => item.trim())
  return rows.slice(1).map((row) =>
    Object.fromEntries(headers.map((header, idx) => [header || `column_${idx}`, (row[idx] ?? "").trim()])),
  )
}

function createEntry(
  input: SnapshotMeta & {
    metric: NumericMetric
    scope: GroundingScope
    term: string
    value: number
    sourcePath: string
    model?: string
    significance?: "" | "*" | "**" | "***"
  },
) {
  return {
    metric: input.metric,
    scope: input.scope,
    term: input.term,
    model: input.model,
    value: input.value,
    display: formatValue(input.metric, input.value),
    sourcePath: input.sourcePath,
    datasetId: input.datasetId,
    stageId: input.stageId,
    runId: input.runId,
    significance: input.significance,
  } satisfies NumericSnapshotEntry
}

function writeSnapshot(doc: NumericSnapshotDocument) {
  fs.mkdirSync(path.dirname(doc.snapshotPath), { recursive: true })
  fs.writeFileSync(doc.snapshotPath, JSON.stringify(doc, null, 2), "utf-8")
  return doc
}

export function snapshotPreview(snapshot: NumericSnapshotDocument, limit = 12) {
  return {
    scope: snapshot.scope,
    entryCount: snapshot.entries.length,
    entries: snapshot.entries.slice(0, limit),
  }
}

function snapshotStamp() {
  const now = new Date()
  const pad = (value: number, size = 2) => value.toString().padStart(size, "0")
  return [
    now.getFullYear().toString(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    pad(now.getMilliseconds(), 3),
  ].join("")
}

function stageScopedSnapshotPath(input: {
  csvPath: string
  stageId?: string
  action: "describe" | "correlation"
}) {
  const stageId = input.stageId ?? "stage_unknown"
  return path.join(path.dirname(input.csvPath), `${stageId}_${input.action}_${snapshotStamp()}_numeric_snapshot.json`)
}

function resolveSnapshotMetadataPath(snapshotPath: string) {
  if (path.isAbsolute(snapshotPath)) return snapshotPath
  return path.resolve(Instance.directory, snapshotPath)
}

function isNumericSnapshotDocument(value: unknown): value is NumericSnapshotDocument {
  return !!value && typeof value === "object" && Array.isArray((value as NumericSnapshotDocument).entries)
}

function loadSnapshotFromPath(snapshotPath: string) {
  const absolutePath = resolveSnapshotMetadataPath(snapshotPath)
  if (!fs.existsSync(absolutePath)) return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf-8"))
    return isNumericSnapshotDocument(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function uniqueEntries(entries: NumericSnapshotEntry[]) {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = [
      entry.metric,
      entry.scope,
      entry.term,
      entry.model ?? "",
      entry.value,
      entry.sourcePath,
    ].join("|")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function makeDerivedSnapshot(input: {
  sourcePath: string
  scope: GroundingScope
  entries: NumericSnapshotEntry[]
  datasetId?: string
  stageId?: string
  runId?: string
  context?: Record<string, unknown>
}) {
  return {
    version: 1,
    sourceTool: "grounding",
    scope: input.scope,
    generatedAt: nowIso(),
    snapshotPath: input.sourcePath,
    datasetId: input.datasetId,
    stageId: input.stageId,
    runId: input.runId,
    entries: uniqueEntries(input.entries),
    context: input.context,
  } satisfies NumericSnapshotDocument
}

function parseJsonFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
  } catch {
    return undefined
  }
}

function metricAliases(key: string): NumericMetric | undefined {
  const normalized = key.toLowerCase()
  if (normalized === "coefficient") return "coefficient"
  if (normalized === "std_error" || normalized === "stderr" || normalized === "standard_error") return "std_error"
  if (normalized === "p_value" || normalized === "pvalue") return "p_value"
  if (normalized === "r_squared" || normalized === "r2") return "r_squared"
  if (normalized === "n_obs" || normalized === "rows_used" || normalized === "row_count" || normalized === "rows_after")
    return "n_obs"
  if (normalized === "group_count" || normalized === "cluster_count" || normalized === "groups") return "group_count"
  if (normalized === "mean") return "mean"
  if (normalized === "std") return "std"
  if (normalized === "min") return "min"
  if (normalized === "max") return "max"
  if (normalized === "median") return "median"
  if (normalized === "q1" || normalized === "25%") return "q1"
  if (normalized === "q3" || normalized === "75%") return "q3"
  if (normalized === "ci_lower") return "ci_lower"
  if (normalized === "ci_upper") return "ci_upper"
  if (normalized === "correlation") return "correlation"
  if (normalized === "missing_count") return "missing_count"
  if (normalized === "missing_share") return "missing_share"
  return undefined
}

function scopeForMetric(metric: NumericMetric): GroundingScope {
  if (
    metric === "coefficient" ||
    metric === "std_error" ||
    metric === "r_squared" ||
    metric === "n_obs" ||
    metric === "group_count" ||
    metric === "ci_lower" ||
    metric === "ci_upper"
  ) {
    return "regression"
  }
  if (metric === "correlation") return "correlation"
  if (metric === "p_value") return "diagnostics"
  return "descriptive"
}

function snapshotFromCoefficientCsv(filePath: string) {
  const rows = csvRecords(filePath)
  if (!rows.length) return undefined
  const first = rows[0]!
  if (!("coefficient" in first || "std_error" in first || "p_value" in first)) return undefined
  const entries: NumericSnapshotEntry[] = []
  for (const row of rows) {
    const term = row.term || row.variable || row.column_0
    if (!term) continue
    const pValue = parseNumeric(row.p_value)
    const stars = significanceStars(pValue)
    for (const metric of ["coefficient", "std_error", "p_value", "ci_lower", "ci_upper"] as const) {
      const value = parseNumeric(row[metric])
      if (value === undefined) continue
      entries.push(
        createEntry({
          metric,
          scope: metric === "p_value" ? "diagnostics" : "regression",
          term,
          model: "(1)",
          value,
          sourcePath: filePath,
          significance: metric === "coefficient" ? stars : undefined,
        }),
      )
    }
  }
  if (!entries.length) return undefined
  return makeDerivedSnapshot({
    sourcePath: filePath,
    scope: "regression",
    entries,
    context: { recoveredFrom: "coefficient_csv" },
  })
}

function snapshotFromDescribeCsv(filePath: string) {
  const rows = csvRecords(filePath)
  if (!rows.length) return undefined
  const first = rows[0]!
  if (!("variable" in first) || !("mean" in first || "count" in first || "std" in first)) return undefined
  const entries: NumericSnapshotEntry[] = []
  for (const row of rows) {
    const term = row.variable
    if (!term) continue
    for (const [metric, key] of [
      ["n_obs", "count"],
      ["mean", "mean"],
      ["std", "std"],
      ["min", "min"],
      ["q1", "25%"],
      ["median", "50%"],
      ["q3", "75%"],
      ["max", "max"],
      ["missing_count", "missing_count"],
      ["missing_share", "missing_share"],
    ] as const) {
      const value = parseNumeric(row[key])
      if (value === undefined) continue
      entries.push(
        createEntry({
          metric,
          scope: "descriptive",
          term,
          value,
          sourcePath: filePath,
        }),
      )
    }
  }
  if (!entries.length) return undefined
  return makeDerivedSnapshot({
    sourcePath: filePath,
    scope: "descriptive",
    entries,
    context: { recoveredFrom: "describe_csv" },
  })
}

function snapshotFromCorrelationCsv(filePath: string) {
  const rows = csvRows(filePath)
  if (rows.length < 2) return undefined
  const headers = rows[0]!.slice(1).map((item) => item.trim())
  const entries: NumericSnapshotEntry[] = []
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!
    const rowLabel = row[0]?.trim()
    if (!rowLabel) continue
    for (let colIndex = 1; colIndex < row.length; colIndex += 1) {
      const columnLabel = headers[colIndex - 1]
      if (!columnLabel || rowLabel >= columnLabel) continue
      const value = parseNumeric(row[colIndex])
      if (value === undefined) continue
      entries.push(
        createEntry({
          metric: "correlation",
          scope: "correlation",
          term: `${rowLabel}::${columnLabel}`,
          value,
          sourcePath: filePath,
        }),
      )
    }
  }
  if (!entries.length) return undefined
  return makeDerivedSnapshot({
    sourcePath: filePath,
    scope: "correlation",
    entries,
    context: { recoveredFrom: "correlation_csv" },
  })
}

function appendJsonMetricEntries(entries: NumericSnapshotEntry[], sourcePath: string, value: unknown, pathStack: string[] = []) {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendJsonMetricEntries(entries, sourcePath, item, [...pathStack, `${index}`]))
    return
  }

  const record = value as Record<string, unknown>

  for (const [key, raw] of Object.entries(record)) {
    if (key === "breusch_pagan_pvalue") {
      const numeric = parseNumeric(raw)
      if (numeric !== undefined) {
        entries.push(
          createEntry({
            metric: "p_value",
            scope: "diagnostics",
            term: "breusch_pagan",
            value: numeric,
            sourcePath,
          }),
        )
      }
      continue
    }

    const metric = metricAliases(key)
    if (metric) {
      const numeric = parseNumeric(raw)
      if (numeric !== undefined) {
        const term = metric === "r_squared" ? "model" : pathStack[pathStack.length - 1] ?? key
        entries.push(
          createEntry({
            metric,
            scope: scopeForMetric(metric),
            term,
            value: numeric,
            sourcePath,
          }),
        )
      }
      continue
    }

    if ((key === "missing_share" || key === "missing_count") && raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [term, inner] of Object.entries(raw as Record<string, unknown>)) {
        const numeric = parseNumeric(inner)
        if (numeric === undefined) continue
        entries.push(
          createEntry({
            metric: key === "missing_share" ? "missing_share" : "missing_count",
            scope: "descriptive",
            term,
            value: numeric,
            sourcePath,
          }),
        )
      }
      continue
    }

    appendJsonMetricEntries(entries, sourcePath, raw, [...pathStack, key])
  }
}

function snapshotFromStructuredJson(filePath: string) {
  const parsed = parseJsonFile(filePath)
  if (!parsed) return undefined
  if (isNumericSnapshotDocument(parsed)) return parsed

  const entries: NumericSnapshotEntry[] = []
  appendJsonMetricEntries(entries, filePath, parsed)
  if (!entries.length) return undefined

  const scope = entries.some((entry) => entry.scope === "regression")
    ? "regression"
    : entries.some((entry) => entry.scope === "diagnostics")
      ? "diagnostics"
      : entries.some((entry) => entry.scope === "correlation")
        ? "correlation"
        : "descriptive"

  return makeDerivedSnapshot({
    sourcePath: filePath,
    scope,
    entries,
    context: { recoveredFrom: "structured_json" },
  })
}

function snapshotFromTrustedArtifactPath(filePath: string) {
  const absolutePath = resolveSnapshotMetadataPath(filePath)
  if (!fs.existsSync(absolutePath)) return undefined
  const ext = path.extname(absolutePath).toLowerCase()
  if (ext === ".json") return snapshotFromStructuredJson(absolutePath)
  if (ext === ".csv") return snapshotFromCoefficientCsv(absolutePath) ?? snapshotFromDescribeCsv(absolutePath) ?? snapshotFromCorrelationCsv(absolutePath)
  return undefined
}

function dedupeSnapshots(snapshots: NumericSnapshotDocument[]) {
  const seen = new Set<string>()
  return snapshots.filter((snapshot) => {
    const key = `${snapshot.snapshotPath}|${snapshot.scope}|${snapshot.entries.length}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function collectTrustedArtifactPathsFromToolMetadata(metadata: unknown) {
  const found = new Set<string>()
  const visit = (value: unknown, keyHint?: string) => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, keyHint))
      return
    }
    if (!value || typeof value !== "object") {
      if (typeof value === "string") {
        const normalized = value.trim()
        const ext = path.extname(normalized).toLowerCase()
        const basename = path.basename(normalized).toLowerCase()
        const looksLikeTrustedArtifact =
          [".json", ".csv"].includes(ext) &&
          (
            /path$/i.test(keyHint ?? "") ||
            keyHint === "relativePath" ||
            basename.includes("numeric_snapshot") ||
            basename.includes("diagnostics") ||
            basename.includes("coefficient") ||
            basename.includes("summary") ||
            basename.includes("metadata") ||
            basename.includes("describe") ||
            basename.includes("correlation")
          )
        if (looksLikeTrustedArtifact) found.add(normalized)
      }
      return
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      visit(nested, key)
    }
  }
  visit(metadata)
  return [...found]
}

export async function recoverNumericSnapshots(input: {
  snapshots: NumericSnapshotDocument[]
  trustedArtifactPaths: string[]
  explicitReadPaths?: string[]
}) {
  const base = dedupeSnapshots(input.snapshots)
  const recovered = [
    ...input.trustedArtifactPaths,
    ...(input.explicitReadPaths ?? []),
  ]
    .map(snapshotFromTrustedArtifactPath)
    .filter((item): item is NumericSnapshotDocument => Boolean(item))

  const merged = dedupeSnapshots([...base, ...recovered])
  return {
    snapshots: merged,
    recovered: recovered.length > 0,
    trustedSourcePaths: [...new Set(merged.map((snapshot) => snapshot.snapshotPath))],
  }
}

export function createEconometricsNumericSnapshot(input: SnapshotMeta & {
  outputDir: string
  methodName: string
  result: Record<string, unknown>
  coefficientsPath?: string
  diagnosticsPath?: string
  metadataPath?: string
}) {
  const snapshotPath = path.join(input.outputDir, "numeric_snapshot.json")
  const entries: NumericSnapshotEntry[] = []

  if (input.coefficientsPath && fs.existsSync(input.coefficientsPath)) {
    for (const row of csvRecords(input.coefficientsPath)) {
      const term = row.term || row.variable || row.column_0
      if (!term) continue
      const pValue = parseNumeric(row.p_value)
      const stars = significanceStars(pValue)
      for (const metric of ["coefficient", "std_error", "p_value", "ci_lower", "ci_upper"] as const) {
        const value = parseNumeric(row[metric])
        if (value === undefined) continue
        entries.push(
          createEntry({
            metric,
            scope: "regression",
            term,
            model: "(1)",
            value,
            sourcePath: input.coefficientsPath,
            datasetId: input.datasetId,
            stageId: input.stageId,
            runId: input.runId,
            significance: metric === "coefficient" ? stars : undefined,
          }),
        )
      }
    }
  }

  if (input.metadataPath && fs.existsSync(input.metadataPath)) {
    const metadata = JSON.parse(fs.readFileSync(input.metadataPath, "utf-8")) as Record<string, unknown>
    const rowsUsed = parseNumeric(metadata.rows_used)
    if (rowsUsed !== undefined) {
      entries.push(
        createEntry({
          metric: "n_obs",
          scope: "regression",
          term: "rows_used",
          value: rowsUsed,
          sourcePath: input.metadataPath,
          datasetId: input.datasetId,
          stageId: input.stageId,
          runId: input.runId,
        }),
      )
    }
    const groupCount = parseNumeric(metadata.cluster_count)
    if (groupCount !== undefined) {
      entries.push(
        createEntry({
          metric: "group_count",
          scope: "regression",
          term: "group_count",
          value: groupCount,
          sourcePath: input.metadataPath,
          datasetId: input.datasetId,
          stageId: input.stageId,
          runId: input.runId,
        }),
      )
    }
  }

  if (input.diagnosticsPath && fs.existsSync(input.diagnosticsPath)) {
    const diagnostics = JSON.parse(fs.readFileSync(input.diagnosticsPath, "utf-8")) as Record<string, any>
    const residuals = diagnostics.residuals as Record<string, unknown> | undefined
    if (residuals) {
      for (const metric of ["mean", "std", "min", "max"] as const) {
        const value = parseNumeric(residuals[metric])
        if (value === undefined) continue
        entries.push(
          createEntry({
            metric,
            scope: "diagnostics",
            term: "residuals",
            value,
            sourcePath: input.diagnosticsPath,
            datasetId: input.datasetId,
            stageId: input.stageId,
            runId: input.runId,
          }),
        )
      }
    }

    const heteroskedasticity = diagnostics.heteroskedasticity as Record<string, unknown> | undefined
    const bpPValue = heteroskedasticity ? parseNumeric(heteroskedasticity.breusch_pagan_pvalue) : undefined
    if (bpPValue !== undefined) {
      entries.push(
        createEntry({
          metric: "p_value",
          scope: "diagnostics",
          term: "breusch_pagan",
          value: bpPValue,
          sourcePath: input.diagnosticsPath,
          datasetId: input.datasetId,
          stageId: input.stageId,
          runId: input.runId,
        }),
      )
    }
  }

  for (const metric of ["coefficient", "std_error", "p_value", "r_squared"] as const) {
    const value = parseNumeric(input.result[metric])
    if (value === undefined) continue
    const term = metric === "r_squared" ? "model" : String(input.result.treatment_var ?? input.result.treatmentVar ?? "treatment")
    const alreadyExists = entries.some((entry) => entry.metric === metric && entry.term === term)
    if (alreadyExists) continue
    entries.push(
      createEntry({
        metric,
        scope: "regression",
        term,
        model: "(1)",
        value,
        sourcePath: input.coefficientsPath ?? String(input.result.output_path ?? snapshotPath),
        datasetId: input.datasetId,
        stageId: input.stageId,
        runId: input.runId,
        significance: metric === "coefficient" ? significanceStars(parseNumeric(input.result.p_value)) : undefined,
      }),
    )
  }

  const snapshot: NumericSnapshotDocument = {
    version: 1,
    sourceTool: "econometrics",
    scope: "regression",
    generatedAt: nowIso(),
    snapshotPath,
    datasetId: input.datasetId,
    stageId: input.stageId,
    runId: input.runId,
    entries,
    context: {
      methodName: input.methodName,
    },
  }
  return writeSnapshot(snapshot)
}

export function createDescribeNumericSnapshot(input: SnapshotMeta & {
  csvPath: string
}) {
  const entries: NumericSnapshotEntry[] = []
  for (const row of csvRecords(input.csvPath)) {
    const term = row.variable
    if (!term) continue
    const mapping: Array<[NumericMetric, string]> = [
      ["n_obs", "count"],
      ["mean", "mean"],
      ["std", "std"],
      ["min", "min"],
      ["q1", "25%"],
      ["median", "50%"],
      ["q3", "75%"],
      ["max", "max"],
      ["missing_count", "missing_count"],
      ["missing_share", "missing_share"],
    ]
    for (const [metric, key] of mapping) {
      const value = parseNumeric(row[key])
      if (value === undefined) continue
      entries.push(
        createEntry({
          metric,
          scope: "descriptive",
          term,
          value,
          sourcePath: input.csvPath,
          datasetId: input.datasetId,
          stageId: input.stageId,
          runId: input.runId,
        }),
      )
    }
  }

  const snapshotPath = stageScopedSnapshotPath({
    csvPath: input.csvPath,
    stageId: input.stageId,
    action: "describe",
  })
  return writeSnapshot({
    version: 1,
    sourceTool: "data_import",
    scope: "descriptive",
    generatedAt: nowIso(),
    snapshotPath,
    datasetId: input.datasetId,
    stageId: input.stageId,
    runId: input.runId,
    entries,
  })
}

export function createCorrelationNumericSnapshot(input: SnapshotMeta & {
  csvPath: string
}) {
  const rows = csvRows(input.csvPath)
  const entries: NumericSnapshotEntry[] = []
  if (rows.length >= 2) {
    const headers = rows[0]!.slice(1).map((item) => item.trim())
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!
      const rowLabel = row[0]?.trim()
      if (!rowLabel) continue
      for (let colIndex = 1; colIndex < row.length; colIndex += 1) {
        const columnLabel = headers[colIndex - 1]
        if (!columnLabel || rowLabel >= columnLabel) continue
        const value = parseNumeric(row[colIndex])
        if (value === undefined) continue
        entries.push(
          createEntry({
            metric: "correlation",
            scope: "correlation",
            term: `${rowLabel}::${columnLabel}`,
            value,
            sourcePath: input.csvPath,
            datasetId: input.datasetId,
            stageId: input.stageId,
            runId: input.runId,
          }),
        )
      }
    }
  }

  const snapshotPath = stageScopedSnapshotPath({
    csvPath: input.csvPath,
    stageId: input.stageId,
    action: "correlation",
  })
  return writeSnapshot({
    version: 1,
    sourceTool: "data_import",
    scope: "correlation",
    generatedAt: nowIso(),
    snapshotPath,
    datasetId: input.datasetId,
    stageId: input.stageId,
    runId: input.runId,
    entries,
  })
}

type NumericCandidate = {
  raw: string
  value: number
  decimals: number
}

function numericCandidates(line: string) {
  const matches = line.match(/(?<![A-Za-z])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![A-Za-z])/g) ?? []
  return matches
    .map((item) => {
      const normalized = item.replace(/,/g, "")
      const value = Number(normalized)
      if (!Number.isFinite(value)) return undefined
      const decimals = normalized.includes(".") ? normalized.split(".")[1]!.length : 0
      return {
        raw: item,
        value,
        decimals,
      } satisfies NumericCandidate
    })
    .filter((item): item is NumericCandidate => Boolean(item))
}

function groundedValueMatches(entryValue: number, candidate: NumericCandidate) {
  if (nearlyEqual(entryValue, candidate.value)) return true
  if (candidate.decimals === 0) return Math.round(entryValue) === candidate.value
  const tolerance = 0.5 / 10 ** candidate.decimals
  return Math.abs(entryValue - candidate.value) <= tolerance
}

function isExemptLine(line: string) {
  return (
    /run_[a-z0-9_-]+/i.test(line) ||
    /stage_\d+/i.test(line) ||
    /[a-z]:\\/i.test(line) ||
    /\/[^ ]+\.(json|csv|xlsx|md|txt)/i.test(line) ||
    /\\[^ ]+\.(json|csv|xlsx|md|txt)/i.test(line) ||
    /\*{1,3}\s*p\s*(?:<|<=|≤)\s*0\.\d+/i.test(line)
  )
}

function metricFromLine(line: string): NumericMetric | undefined {
  const normalized = line.toLowerCase()
  if (/p[- ]?value|p 值|p值/.test(normalized)) return "p_value"
  if (/std\.? error|standard error|标准误/.test(normalized)) return "std_error"
  if (/r-squared|r squared|adj\.? r2|adj\.? r\^2|r2\b|r\^2/.test(normalized)) return "r_squared"
  if (/\bcoefficient\b|系数/.test(normalized)) return "coefficient"
  if (/\bmean\b|均值/.test(normalized)) return "mean"
  if (/\bstd\b|standard deviation|标准差/.test(normalized)) return "std"
  if (/\bmin\b|最小值/.test(normalized)) return "min"
  if (/\bmax\b|最大值/.test(normalized)) return "max"
  if (/correlation|相关系数/.test(normalized)) return "correlation"
  if (/\bobservations\b|\bsample size\b|样本量|\bn\s*=|\bn\b/.test(normalized)) return "n_obs"
  return undefined
}

function hasStatisticalLanguage(line: string) {
  return (
    metricsFromLine(line).length > 0 ||
    /significant|insignificant|not significant|显著|不显著|positive|negative|正向|负向/.test(line.toLowerCase())
  )
}

function metricsFromLine(line: string): NumericMetric[] {
  const metrics = new Set<NumericMetric>()
  const normalized = line.toLowerCase()
  if (/p[- ]?value|p 值|p值/.test(normalized)) metrics.add("p_value")
  if (/std\.? error|standard error|标准误/.test(normalized)) metrics.add("std_error")
  if (/r-squared|r squared|adj\.? r2|adj\.? r\^2|r2\b|r\^2|within r2|within r\^2|within r²|组内r2|组内r²/.test(normalized)) metrics.add("r_squared")
  if (/组数|cluster count|group count|groups\b/.test(normalized)) metrics.add("group_count")
  if (/\bcoefficient\b|系数/.test(normalized)) metrics.add("coefficient")
  if (/\bmean\b|均值/.test(normalized)) metrics.add("mean")
  if (/\bstd\b|standard deviation|标准差/.test(normalized)) metrics.add("std")
  if (/\bmin\b|最小值/.test(normalized)) metrics.add("min")
  if (/\bmax\b|最大值/.test(normalized)) metrics.add("max")
  if (/correlation|相关系数/.test(normalized)) metrics.add("correlation")
  if (/\bobservations\b|\bsample size\b|样本量|\bn\s*=|\bn\b/.test(normalized)) metrics.add("n_obs")
  const primary = metricFromLine(line)
  if (primary) metrics.add(primary)
  return [...metrics]
}

function nearlyEqual(a: number, b: number) {
  return Math.abs(a - b) <= 5e-5
}

function uniqueMetricEntries(entries: NumericSnapshotEntry[], metrics: NumericMetric[]) {
  if (metrics.length === 0) return [] as NumericSnapshotEntry[]
  const metricSet = new Set(metrics)
  return uniqueEntries(entries.filter((entry) => metricSet.has(entry.metric)))
}

function findMatchingEntries(entries: NumericSnapshotEntry[], line: string, metric?: NumericMetric) {
  const lowered = line.toLowerCase()
  const directMatches = entries.filter((entry) => {
    if (metric && entry.metric !== metric) return false
    const term = entry.term.toLowerCase()
    if (term === "residuals" || term === "breusch_pagan") return false
    if (term === "model" && metric !== "r_squared") return false
    if (term === "rows_used" && metric !== "n_obs") return false
    if (term === "group_count" && metric !== "group_count") return false
    return lowered.includes(term)
  })
  if (directMatches.length > 0) return directMatches
  const metricMatches = entries.filter((entry) => (metric ? entry.metric === metric : true))
  if (metricMatches.length === 1) return metricMatches
  const uniqueValues = [...new Set(metricMatches.map((entry) => entry.value))]
  return uniqueValues.length === 1 ? metricMatches : []
}

export async function collectNumericSnapshotsFromToolMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return [] as NumericSnapshotDocument[]
  const record = metadata as Record<string, unknown>
  const fromPaths = [
    ...(typeof record.numericSnapshotPath === "string" ? [record.numericSnapshotPath] : []),
    ...(Array.isArray(record.numericSnapshotPaths)
      ? record.numericSnapshotPaths.filter((item): item is string => typeof item === "string")
      : []),
  ]
    .map(loadSnapshotFromPath)
    .filter((item): item is NumericSnapshotDocument => Boolean(item))

  if (fromPaths.length > 0) return fromPaths

  const snapshot = record.numericSnapshot
  if (!snapshot) return [] as NumericSnapshotDocument[]
  if (Array.isArray(snapshot)) return snapshot.filter(isNumericSnapshotDocument)
  if (isNumericSnapshotDocument(snapshot)) return [snapshot]
  return [] as NumericSnapshotDocument[]
}

export function validateNumericGrounding(input: {
  text: string
  snapshots: NumericSnapshotDocument[]
}): GroundingResult {
  const lines = input.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isExemptLine(line))

  const candidateLines = lines.filter((line) => hasStatisticalLanguage(line))
  if (candidateLines.length === 0) {
    return {
      status: "not_applicable",
      issues: [],
      snapshotPaths: input.snapshots.map((item) => item.snapshotPath),
      trustedSourcePaths: input.snapshots.map((item) => item.snapshotPath),
      redactions: [],
      unverifiedMetrics: [],
      recovered: false,
    }
  }

  const entries = input.snapshots.flatMap((snapshot) => snapshot.entries)
  if (entries.length === 0) {
    const issues = candidateLines.map((line) => ({
      type: "missing_snapshot" as const,
      line,
      detail: "Statistical claim found but no numeric snapshot is available.",
    }))
    return {
      status: "fail",
      issues,
      snapshotPaths: input.snapshots.map((item) => item.snapshotPath),
      trustedSourcePaths: input.snapshots.map((item) => item.snapshotPath),
      redactions: issues.map((issue) => ({
        line: issue.line,
        replacement: "Exact statistical values are omitted here because no grounded numeric artifact was available in this turn.",
        issueTypes: [issue.type],
      })),
      unverifiedMetrics: [],
      recovered: false,
    }
  }

  const issues: GroundingIssue[] = []
  for (const line of candidateLines) {
    const metrics = metricsFromLine(line)
    const values = numericCandidates(line)
    if (metrics.length > 0 && values.length > 0) {
      const metricEntries = uniqueMetricEntries(entries, metrics)
      const broadMatches = findMatchingEntries(entries, line)
      const matches = uniqueEntries([...broadMatches, ...metrics.flatMap((metric) => findMatchingEntries(entries, line, metric))])
      const hasMetricValueMatches = values.every((value) => metricEntries.some((entry) => groundedValueMatches(entry.value, value)))
      if (matches.length === 0 && !hasMetricValueMatches) {
        issues.push({
          type: "ungrounded_value",
          line,
          detail: `No uniquely matching numeric entries were found for metrics: ${metrics.map(normalizeMetric).join(", ")}.`,
          metric: metrics[0],
        })
      }
      for (const value of values) {
        const matchedByLineScopedEntries = matches.some((entry) => groundedValueMatches(entry.value, value))
        const matchedByMetricScopedEntries = metricEntries.some((entry) => groundedValueMatches(entry.value, value))
        if (!matchedByLineScopedEntries && !matchedByMetricScopedEntries) {
          issues.push({
            type: "ungrounded_value",
            line,
            detail: `No grounded numeric value in the matched snapshot entries equals ${value.raw}.`,
            metric: metrics[0],
          })
        }
      }
    }

    // ---- 显著性校验 ----
    // 要求同一行中同时出现数值或明确统计术语，才视为统计显著性声明
    // 这样可以避免日常中文如"显著提升"、"显著改善"被误判为统计声明
    const hasSignificantKeyword =
      /significant|显著/.test(line.toLowerCase()) && !/not significant|不显著/.test(line.toLowerCase())
    if (hasSignificantKeyword) {
      // 判断是否为真正的统计语境：同行需要有数值，或者出现统计特征术语
      const lineHasNumericValues = numericCandidates(line).length > 0
      const lineHasStatisticalContext =
        /p\s*[<<=]\s*0\.\d|p\s*值|p[- ]?value|系数|coefficient|标准误|std\.?\s*error|置信区间|confidence|水平上显著|水平显著|\d+%\s*(?:水平|level|significance)/i.test(
          line,
        )
      // 只有在统计语境下才触发显著性校验
      if (lineHasNumericValues || lineHasStatisticalContext) {
        const matches = findMatchingEntries(entries, line, "p_value")
        if (matches.length === 0) {
          issues.push({
            type: "ungrounded_value",
            line,
            detail: "Significance claim is not tied to a unique p-value in numeric snapshots.",
            metric: "p_value",
          })
        }
        if (matches.some((entry) => entry.value >= 0.1)) {
          issues.push({
            type: "significance_mismatch",
            line,
            detail: "Line claims significance but matching p-value is not below 0.1.",
            metric: "p_value",
          })
        }
      }
    }

    // ---- 非显著性校验 ----
    // "不显著" / "not significant" 同样需要统计语境
    const hasNotSignificantKeyword = /not significant|不显著/.test(line.toLowerCase())
    if (hasNotSignificantKeyword) {
      const lineHasNumericValues = numericCandidates(line).length > 0
      const lineHasStatisticalContext =
        /p\s*[<<=]\s*0\.\d|p\s*值|p[- ]?value|系数|coefficient|标准误|std\.?\s*error|\d+%\s*(?:水平|level)/i.test(
          line,
        )
      if (lineHasNumericValues || lineHasStatisticalContext) {
        const matches = findMatchingEntries(entries, line, "p_value")
        if (matches.length === 0) {
          issues.push({
            type: "ungrounded_value",
            line,
            detail: "Non-significance claim is not tied to a unique p-value in numeric snapshots.",
            metric: "p_value",
          })
        }
        if (matches.some((entry) => entry.value < 0.1)) {
          issues.push({
            type: "significance_mismatch",
            line,
            detail: "Line claims non-significance but matching p-value is below 0.1.",
            metric: "p_value",
          })
        }
      }
    }

    // ---- 正向/正效应方向校验 ----
    // 要求同行出现数值、或出现明确统计术语（如"系数为正"、"正向效应"、"coefficient"）
    // 通用的"正向引导"、"正向反馈"不触发
    if (/\bpositive\b|正向|为正|正效应|正向效应/.test(line.toLowerCase())) {
      const lineHasNumericValues = numericCandidates(line).length > 0
      const lineHasDirectionContext =
        /系数|coefficient|效应|effect|估计值|estimate|回归|regression|coef|beta|处理效应|treatment\s*effect/i.test(
          line,
        )
      if (lineHasNumericValues || lineHasDirectionContext) {
        const matches = findMatchingEntries(entries, line, "coefficient")
        if (matches.length === 0) {
          issues.push({
            type: "ungrounded_value",
            line,
            detail: "Positive-direction claim is not tied to a unique coefficient in numeric snapshots.",
            metric: "coefficient",
          })
        }
        if (matches.some((entry) => entry.value < 0)) {
          issues.push({
            type: "sign_mismatch",
            line,
            detail: "Line claims a positive effect but matching coefficient is negative.",
            metric: "coefficient",
          })
        }
      }
    }

    // ---- 负向/负效应方向校验 ----
    // 同上，要求统计语境
    if (/\bnegative\b|负向|为负|负效应|负向效应/.test(line.toLowerCase())) {
      const lineHasNumericValues = numericCandidates(line).length > 0
      const lineHasDirectionContext =
        /系数|coefficient|效应|effect|估计值|estimate|回归|regression|coef|beta|处理效应|treatment\s*effect/i.test(
          line,
        )
      if (lineHasNumericValues || lineHasDirectionContext) {
        const matches = findMatchingEntries(entries, line, "coefficient")
        if (matches.length === 0) {
          issues.push({
            type: "ungrounded_value",
            line,
            detail: "Negative-direction claim is not tied to a unique coefficient in numeric snapshots.",
            metric: "coefficient",
          })
        }
        if (matches.some((entry) => entry.value > 0)) {
          issues.push({
            type: "sign_mismatch",
            line,
            detail: "Line claims a negative effect but matching coefficient is positive.",
            metric: "coefficient",
          })
        }
      }
    }
  }

  const issueMap = new Map<string, GroundingIssue[]>()
  for (const issue of issues) {
    const current = issueMap.get(issue.line) ?? []
    current.push(issue)
    issueMap.set(issue.line, current)
  }

  const redactions = [...issueMap.entries()].map(([line, lineIssues]) => {
    const issueTypes = [...new Set(lineIssues.map((issue) => issue.type))]
    const mentionsSign = issueTypes.includes("sign_mismatch")
    const mentionsSignificance = issueTypes.includes("significance_mismatch")
    const replacement = mentionsSign || mentionsSignificance
      ? "This directional or significance claim is omitted because the draft statement was inconsistent with grounded outputs."
      : "Exact statistical values are omitted here because they were not verified against grounded outputs."
    return {
      line,
      replacement,
      issueTypes,
    } satisfies GroundingLineRemediation
  })

  const affectedLineCount = issueMap.size
  const status = issues.length === 0 ? "pass" : affectedLineCount < candidateLines.length ? "partial" : "fail"
  const unverifiedMetrics = [...new Set(issues.map((issue) => issue.metric).filter((item): item is NumericMetric => Boolean(item)))]

  return {
    status,
    issues,
    snapshotPaths: input.snapshots.map((item) => item.snapshotPath),
    trustedSourcePaths: input.snapshots.map((item) => item.snapshotPath),
    redactions,
    unverifiedMetrics,
    recovered: false,
  }
}

function linePrefix(line: string) {
  const match = /^(\s*(?:[-*+]|\d+\.)\s+)/.exec(line)
  return match?.[1] ?? ""
}

export function rewriteGroundedText(input: {
  text: string
  grounding: GroundingResult
}) {
  if (input.grounding.status === "pass" || input.grounding.status === "not_applicable") {
    return input.text.trimEnd()
  }

  const redactionMap = new Map(input.grounding.redactions.map((item) => [item.line, item]))
  const rewritten = input.text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      const redaction = redactionMap.get(trimmed)
      if (!redaction) return line
      return `${linePrefix(line)}${redaction.replacement}`
    })
    .join("\n")
    .trimEnd()

  const note = input.grounding.unverifiedMetrics.length
    ? `Unverified statistics omitted: ${input.grounding.unverifiedMetrics.join(", ")}.`
    : "Some statistical values were omitted because they could not be verified against grounded outputs."

  return [rewritten, note].filter(Boolean).join("\n\n")
}

export function buildGroundingFailureText(result: GroundingResult) {
  const snapshotLine = result.snapshotPaths.length
    ? `Available numeric snapshots:\n- ${result.snapshotPaths.join("\n- ")}`
    : "No numeric snapshot is currently available."
  return [
    "Exact statistical values were omitted because the draft response contained ungrounded or inconsistent numerical claims.",
    "Read numeric_snapshot.json or another explicitly read structured artifact before summarizing coefficients, p-values, R-squared, N, descriptive statistics, or correlations.",
    snapshotLine,
  ].join("\n\n")
}

