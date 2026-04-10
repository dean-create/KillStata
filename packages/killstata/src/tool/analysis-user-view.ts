import { displayPath, type DisplayVisibility } from "./analysis-display"

export type AnalysisViewMetric = {
  label: string
  value: string
  visibility?: DisplayVisibility
}

export type AnalysisViewArtifact = {
  label: string
  path: string
  visibility?: DisplayVisibility
}

export type ToolAnalysisView = {
  kind: string
  foundInputFile?: string
  step?: string
  datasetId?: string
  stageId?: string
  results?: AnalysisViewMetric[]
  artifacts?: AnalysisViewArtifact[]
  warnings?: string[]
  conclusion?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeVisibility(value: unknown): DisplayVisibility | undefined {
  return value === "user_default" || value === "user_collapsed" || value === "internal_only" ? value : undefined
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeMetrics(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const metrics = value
    .map((item) => {
      if (!isObject(item)) return undefined
      const label = normalizeString(item.label)
      const metricValue = normalizeString(item.value)
      if (!label || !metricValue) return undefined
      return {
        label,
        value: metricValue,
        visibility: normalizeVisibility(item.visibility),
      }
    })
    .filter(Boolean) as AnalysisViewMetric[]
  return metrics.length ? metrics : undefined
}

function normalizeArtifacts(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const artifacts = value
    .map((item) => {
      if (!isObject(item)) return undefined
      const label = normalizeString(item.label)
      const artifactPath = normalizeString(item.path)
      if (!label || !artifactPath) return undefined
      return {
        label,
        path: artifactPath,
        visibility: normalizeVisibility(item.visibility),
      }
    })
    .filter(Boolean) as AnalysisViewArtifact[]
  return artifacts.length ? artifacts : undefined
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const lines = value
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item))
  return lines.length ? lines : undefined
}

export function analysisMetric(
  label: string,
  value: string | number | undefined,
  visibility?: DisplayVisibility,
): AnalysisViewMetric | undefined {
  if (value === undefined || value === null || value === "") return undefined
  return {
    label: label.trim(),
    value: typeof value === "number" ? String(value) : value.trim(),
    visibility,
  }
}

export function analysisArtifact(
  filePath: string | undefined,
  options?: {
    label?: string
    visibility?: DisplayVisibility
  },
): AnalysisViewArtifact | undefined {
  if (!filePath) return undefined
  return {
    label: options?.label?.trim() || displayPath(filePath, "name"),
    path: filePath,
    visibility: options?.visibility ?? "user_default",
  }
}

export function analysisInputFile(filePath?: string) {
  return filePath ? displayPath(filePath, "name") : undefined
}

export function createToolAnalysisView(
  input: Omit<ToolAnalysisView, "results" | "artifacts" | "warnings"> & {
    results?: Array<AnalysisViewMetric | undefined | null | false>
    artifacts?: Array<AnalysisViewArtifact | undefined | null | false>
    warnings?: Array<string | undefined | null | false>
  },
): ToolAnalysisView {
  return {
    kind: input.kind.trim(),
    foundInputFile: normalizeString(input.foundInputFile),
    step: normalizeString(input.step),
    datasetId: normalizeString(input.datasetId),
    stageId: normalizeString(input.stageId),
    results: normalizeMetrics(input.results),
    artifacts: normalizeArtifacts(input.artifacts),
    warnings: normalizeStringList(input.warnings),
    conclusion: normalizeString(input.conclusion),
  }
}

export function readToolAnalysisView(metadata?: Record<string, unknown>): ToolAnalysisView | undefined {
  if (!metadata || !isObject(metadata.analysisView)) return undefined
  const raw = metadata.analysisView
  const kind = normalizeString(raw.kind)
  if (!kind) return undefined
  return createToolAnalysisView({
    kind,
    foundInputFile: normalizeString(raw.foundInputFile),
    step: normalizeString(raw.step),
    datasetId: normalizeString(raw.datasetId),
    stageId: normalizeString(raw.stageId),
    results: normalizeMetrics(raw.results),
    artifacts: normalizeArtifacts(raw.artifacts),
    warnings: normalizeStringList(raw.warnings),
    conclusion: normalizeString(raw.conclusion),
  })
}
