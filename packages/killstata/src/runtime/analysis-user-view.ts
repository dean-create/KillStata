import { displayPath } from "@/tool/analysis-display"
import { readToolAnalysisView } from "@/tool/analysis-user-view"

type ToolStateLike = {
  status?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type AnalysisToolPartLike = {
  tool: string
  state: ToolStateLike
}

export type AnalysisUserView = {
  foundInput?: string
  steps: string[]
  artifacts: string[]
  results: Array<{ label: string; value: string }>
  current?: string
  nextStep?: string
  conclusion?: string
  warnings: string[]
}

const CORE_ANALYSIS_TOOLS = new Set([
  "data_import",
  "econometrics",
  "regression_table",
  "research_brief",
  "heterogeneity_runner",
  "paper_draft",
  "slide_generator",
])

const FINAL_PRESENTATION_TOOLS = [
  "paper_draft",
  "slide_generator",
  "research_brief",
  "heterogeneity_runner",
  "regression_table",
  "econometrics",
] as const

const ANALYSIS_REQUEST_PATTERN =
  /\b(csv|xlsx|xls|dta|sav|parquet|regression|econometric|econometrics|diagnostics?)\b|数据|导入|描述统计|回归|计量|变量|检查表|输出路径/i

const RAW_DETAIL_REQUEST_PATTERN =
  /原始数据|原始内容|文件全文|完整日志|完整\s*json|原始\s*json|调试模式|完整过程|不要摘要|show raw|raw data|full log|full text|raw json/i

const PREFERRED_ARTIFACT_NAMES = ["results.json", "diagnostics.json", "numeric_snapshot.json", "model_metadata.json"]

const PREFERRED_RESULT_LABELS = ["did 系数", "系数", "标准误", "p 值", "N", "组数", "within R²", "R²"]

const INTERNAL_WARNING_PATTERNS = [
  /Reused existing .* stage/i,
  /source file fingerprint is unchanged/i,
  /^QA gate warning\(s\):/i,
  /already exists.*skipping/i,
  /stage .* was cached/i,
]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function uniqueStrings(items: Array<string | undefined>, limit?: number) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    result.push(item)
    if (limit !== undefined && result.length >= limit) break
  }
  return result
}

function isCompletedTool(part: AnalysisToolPartLike) {
  return part.state.status === "completed"
}

function findStep(parts: AnalysisToolPartLike[], predicate: (part: AnalysisToolPartLike) => boolean) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (predicate(parts[index])) return parts[index]
  }
  return undefined
}

function getAnalysisView(part: AnalysisToolPartLike) {
  return readToolAnalysisView(part.state.metadata)
}

function uniquePartsByReference(parts: Array<AnalysisToolPartLike | undefined>) {
  const seen = new Set<AnalysisToolPartLike>()
  const result: AnalysisToolPartLike[] = []
  for (const part of parts) {
    if (!part || seen.has(part)) continue
    seen.add(part)
    result.push(part)
  }
  return result
}

function selectPrimaryResultPart(parts: AnalysisToolPartLike[]) {
  for (const tool of FINAL_PRESENTATION_TOOLS) {
    const match = findStep(parts, (part) => part.tool === tool)
    if (match) return match
  }
  return parts[parts.length - 1]
}

function selectPrimaryParts(parts: AnalysisToolPartLike[]) {
  const visible = parts.filter((part) => Boolean(getAnalysisView(part)))
  const primaryResultPart = selectPrimaryResultPart(visible)
  if (primaryResultPart && primaryResultPart.tool !== "data_import") {
    return uniquePartsByReference([
      findStep(visible, (part) => part.tool === "data_import" && stringValue(part.state.input?.action) === "import"),
      findStep(visible, (part) => part.tool === "data_import" && stringValue(part.state.input?.action) === "qa"),
      primaryResultPart,
    ])
  }

  const actionOrder = ["import", "preprocess", "filter", "qa", "describe", "correlation"]
  const ordered = actionOrder.map((action) =>
    findStep(visible, (part) => part.tool === "data_import" && stringValue(part.state.input?.action) === action),
  )
  const selected = uniquePartsByReference(ordered)
  if (selected.length) return selected

  const fallback = visible[visible.length - 1]
  return fallback ? [fallback] : []
}

function preferredArtifactNames(parts: AnalysisToolPartLike[]) {
  const sourcePart = selectPrimaryResultPart(parts)
  const sourceParts = sourcePart ? [sourcePart] : parts.slice(-1)
  const allArtifacts = sourceParts.flatMap((part) => getAnalysisView(part)?.artifacts ?? [])

  const byName = uniqueStrings(
    allArtifacts
      .filter((artifact) => (artifact.visibility ?? "user_default") !== "internal_only")
      .map((artifact) => displayPath(artifact.path, "name")),
  )

  const prioritized = [
    ...PREFERRED_ARTIFACT_NAMES.filter((name) => byName.includes(name)),
    ...byName.filter((name) => !PREFERRED_ARTIFACT_NAMES.includes(name)),
  ]

  return prioritized.slice(0, 6)
}

function latestDatasetStage(parts: AnalysisToolPartLike[]) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const view = getAnalysisView(parts[index])
    if (!view) continue
    if (view.datasetId || view.stageId) {
      return {
        datasetId: view.datasetId,
        stageId: view.stageId,
      }
    }
  }
  return {}
}

function latestFoundInput(parts: AnalysisToolPartLike[]) {
  for (const part of parts) {
    const view = getAnalysisView(part)
    if (view?.foundInputFile) return view.foundInputFile
  }
  return undefined
}

function preferredResults(parts: AnalysisToolPartLike[]) {
  const source = selectPrimaryResultPart(parts) ?? parts[parts.length - 1]
  const view = source ? getAnalysisView(source) : undefined
  const metrics = view?.results?.filter((item) => (item.visibility ?? "user_default") !== "internal_only") ?? []
  if (metrics.length === 0) return []

  const ordered = [
    ...PREFERRED_RESULT_LABELS.flatMap((label) => metrics.filter((item) => item.label === label)),
    ...metrics.filter((item) => !PREFERRED_RESULT_LABELS.includes(item.label)),
  ]

  return ordered.slice(0, 8)
}

function latestConclusion(parts: AnalysisToolPartLike[]) {
  const source = selectPrimaryResultPart(parts) ?? parts[parts.length - 1]
  return source ? getAnalysisView(source)?.conclusion : undefined
}

function displayStepLabel(step?: string) {
  if (!step) return undefined
  if (step === "data_import(import)") return "数据导入"
  if (step === "data_import(qa)") return "数据检查"
  if (step === "data_import(describe)") return "描述统计"
  if (step === "data_import(correlation)") return "相关性分析"
  if (step === "econometrics(panel_fe_regression)") return "固定效应回归"
  if (step.startsWith("econometrics(")) return "计量回归"
  if (step === "regression_table") return "三线表与回归表格"
  if (step === "heterogeneity_runner") return "异质性与机制分析"
  if (step === "research_brief") return "研究摘要"
  if (step === "paper_draft") return "论文草稿"
  if (step === "slide_generator") return "演示材料"
  return step
}

function summarizeCurrent(parts: AnalysisToolPartLike[]) {
  const latest = parts[parts.length - 1]
  if (!latest) return undefined
  const view = getAnalysisView(latest)
  if (!view) return undefined
  const step = view.step ?? latest.tool
  const label = displayStepLabel(step) ?? step

  if (latest.tool === "econometrics") {
    return `已完成${label}，正在整理回归结果`
  }

  if (latest.tool === "regression_table") {
    return `已完成${label}，正在整理可引用表格文件`
  }

  if (latest.tool === "data_import") {
    if (step.includes("(import)")) return `已完成${label}，正在准备后续校验或清洗`
    if (step.includes("(qa)")) return `已完成${label}，正在准备进入分析`
    if (step.includes("(describe)") || step.includes("(correlation)")) return `已完成${label}，正在整理统计结果`
    return `已完成${label}`
  }

  return label ? `已完成${label}` : undefined
}

function inferNextStep(parts: AnalysisToolPartLike[]) {
  const latest = parts[parts.length - 1]
  if (!latest) return undefined
  const view = getAnalysisView(latest)
  const step = view?.step ?? latest.tool

  if (latest.tool === "econometrics") return "汇总结论、诊断信息和关键产物文件"
  if (latest.tool === "regression_table") return "检查表格标题、列名、注释和导出格式是否可直接引用"
  if (latest.tool === "heterogeneity_runner") return "整理异质性、机制和稳健性扩展产物"
  if (latest.tool === "research_brief") return "整理研究摘要并输出关键信息"
  if (latest.tool === "paper_draft") return "整理草稿结构并准备导出"
  if (latest.tool === "slide_generator") return "整理演示材料并准备导出"

  if (latest.tool === "data_import") {
    if (step.includes("(import)")) return "继续执行数据校验、清洗或筛选"
    if (step.includes("(qa)")) return "进入描述统计或计量分析"
    if (step.includes("(describe)") || step.includes("(correlation)")) return "整理统计发现并决定是否继续建模"
    return "继续执行下一步数据处理"
  }

  return "继续执行下一步分析"
}

function summarizeResults(view: AnalysisUserView) {
  const metrics = view.results.slice(0, 8).map((item) => `${item.label} ${item.value}`)
  const artifacts = view.artifacts
    .filter((item) => !item.startsWith("datasetId=") && !item.startsWith("stageId="))
    .slice(0, 3)

  const segments: string[] = []
  if (metrics.length) segments.push(metrics.join("，"))
  if (!segments.length && artifacts.length) segments.push(`已生成${artifacts.join("、")}`)
  if (!segments.length && view.artifacts.length) segments.push("结果文件已生成")
  return segments.join("；")
}

function collectWarnings(parts: AnalysisToolPartLike[]) {
  const raw = uniqueStrings(
    parts.flatMap((part) => getAnalysisView(part)?.warnings ?? []),
    4,
  )
  return raw.filter((warning) => !INTERNAL_WARNING_PATTERNS.some((pattern) => pattern.test(warning)))
}

export function wantsRawAnalysisDetail(latestUserText?: string) {
  return Boolean(latestUserText && RAW_DETAIL_REQUEST_PATTERN.test(latestUserText))
}

export function isAnalysisTurn(tools: AnalysisToolPartLike[], latestUserText?: string) {
  if (tools.some((part) => getAnalysisView(part))) return true
  if (tools.some((part) => CORE_ANALYSIS_TOOLS.has(part.tool))) return true
  return Boolean(latestUserText && ANALYSIS_REQUEST_PATTERN.test(latestUserText))
}

export function buildAnalysisUserView(input: { tools: AnalysisToolPartLike[]; latestUserText?: string }) {
  if (wantsRawAnalysisDetail(input.latestUserText)) return undefined
  if (!isAnalysisTurn(input.tools, input.latestUserText)) return undefined

  const completed = input.tools.filter(isCompletedTool)
  if (!completed.length) return undefined

  const primaryParts = selectPrimaryParts(completed)
  if (!primaryParts.length) return undefined

  const { datasetId, stageId } = latestDatasetStage(primaryParts)
  const artifacts = preferredArtifactNames(primaryParts)

  return {
    foundInput: latestFoundInput(primaryParts),
    steps: uniqueStrings(
      primaryParts.map((part) => getAnalysisView(part)?.step),
      6,
    ),
    artifacts: uniqueStrings(
      [datasetId ? `datasetId=${datasetId}` : undefined, stageId ? `stageId=${stageId}` : undefined, ...artifacts],
      8,
    ),
    results: preferredResults(primaryParts),
    current: summarizeCurrent(primaryParts),
    nextStep: inferNextStep(primaryParts),
    conclusion: latestConclusion(primaryParts),
    warnings: collectWarnings(primaryParts),
  } satisfies AnalysisUserView
}

export function renderAnalysisUserView(view: AnalysisUserView) {
  const lines: string[] = []
  const hasFinalResult = view.results.length > 0 || Boolean(view.conclusion)

  if (view.foundInput) {
    lines.push(`数据：${view.foundInput}`)
  }

  if (view.steps.length) {
    lines.push(`流程：${view.steps.map((step) => displayStepLabel(step) ?? step).join(" -> ")}`)
  }

  if (view.current) {
    lines.push(`当前：${view.current}`)
  }

  const resultSummary = summarizeResults(view)
  if (resultSummary) {
    lines.push(`结果：${resultSummary}`)
  }

  if (view.conclusion) {
    lines.push(`结论：${view.conclusion}`)
  }

  if (!hasFinalResult && view.nextStep) {
    lines.push(`下一步：${view.nextStep}`)
  }

  if (view.warnings.length) {
    lines.push(`提示：${view.warnings.slice(0, 2).join("；")}`)
  }

  return lines.filter(Boolean).join("\n").trim()
}

export function maybeBuildAnalysisUserViewText(input: { tools: AnalysisToolPartLike[]; latestUserText?: string }) {
  const view = buildAnalysisUserView(input)
  if (!view) return undefined
  return {
    view,
    text: renderAnalysisUserView(view),
  }
}

export function isToolMetadataRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value)
}
