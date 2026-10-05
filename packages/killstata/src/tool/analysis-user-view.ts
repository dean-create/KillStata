import { displayPath, type DisplayVisibility } from "./analysis-display"
import { formatPValue } from "@/util/coefficient-table"

/**
 * 估计器 output 里代替产物路径的固定措辞。这是用户可见的产品边界（"不给用户看路径"），
 * 措辞会被反复调整——散在 13 个估计器文件里改一遍必然漏（iv-test 就漏过一次），
 * 因此收在这里，改一处即全部生效。
 */
export const ARTIFACT_SAVED_NOTICE = "完整结果与系数表已生成，已保存为本次分析产物。"

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

export type AnalysisViewPanelCandidate = {
  entityVars: string[]
  timeVar: string
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
  /** 导入就绪阶段核验出的真实列名；只在用户明确询问变量时用于收尾补全。 */
  variables?: string[]
  /** 导入阶段生成的有界质量事实；用于纠正模型对缺失/面板键的误述。 */
  qualityFacts?: string
  /** 数据就绪阶段核验出的面板键；仅保存列名，不保存大规模逐行数据。 */
  panelCandidates?: AnalysisViewPanelCandidate[]
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
  const lines = value.map((item) => normalizeString(item)).filter((item): item is string => Boolean(item))
  return lines.length ? lines : undefined
}

function normalizePanelCandidates(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const candidates = value
    .map((item) => {
      if (!isObject(item) || !Array.isArray(item.entityVars)) return undefined
      const entityVars = item.entityVars
        .map((name) => normalizeString(name))
        .filter((name): name is string => Boolean(name))
      const timeVar = normalizeString(item.timeVar)
      if (!entityVars.length || !timeVar) return undefined
      return { entityVars, timeVar }
    })
    .filter(Boolean) as AnalysisViewPanelCandidate[]
  return candidates.length ? candidates : undefined
}

export function analysisMetric(
  label: string,
  value: string | number | undefined,
  visibility?: DisplayVisibility,
): AnalysisViewMetric | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const normalizedLabel = label.trim()
  const rawValue = typeof value === "number" ? String(value) : value.trim()
  // 很多估计器为兼容正文先把 p 值格式化成字符串；在用户视图边界统一恢复学术显示，
  // 避免 1e-10 或被四舍五入的 0.0000 被误读为“精确等于零”。
  const normalizedValue = /^p\s*(?:值|value)/i.test(normalizedLabel) && Number.isFinite(Number(rawValue))
    ? formatPValue(Number(rawValue))
    : rawValue
  return {
    label: normalizedLabel,
    value: normalizedValue,
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

/** 导入展示优先使用用户原始文件名，避免受管快照名把内部 dataset ID 带到结果正文。 */
export function importDisplayFile(input: {
  originalFilename?: unknown
  sourcePath?: unknown
  fallbackPath?: unknown
}) {
  const candidate = [input.originalFilename, input.sourcePath, input.fallbackPath].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )
  return analysisInputFile(candidate)
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
    variables: normalizeStringList(input.variables),
    qualityFacts: normalizeString(input.qualityFacts),
    panelCandidates: normalizePanelCandidates(input.panelCandidates),
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
    variables: normalizeStringList(raw.variables),
    qualityFacts: normalizeString(raw.qualityFacts),
    panelCandidates: normalizePanelCandidates(raw.panelCandidates),
  })
}
