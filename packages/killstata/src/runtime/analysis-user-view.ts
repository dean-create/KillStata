import { displayPath } from "@/tool/analysis-display"
import { readToolAnalysisView } from "@/tool/analysis-user-view"
import { isNegatedWorkflowRequest, isWorkflowConsultation } from "@/runtime/input-intent"
import { WORKFLOW_ANALYSIS_TOOL_IDS, isWorkflowEstimateTool } from "@/runtime/tool-catalog"

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
  ...WORKFLOW_ANALYSIS_TOOL_IDS,
  "regression_table",
  "research_brief",
  "heterogeneity_runner",
  "paper_draft",
  "slide_generator",
])

const FINAL_PRESENTATION_TOOL_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["paper_draft"]),
  new Set(["slide_generator"]),
  new Set(["research_brief"]),
  new Set(["heterogeneity_runner"]),
  new Set(["regression_table"]),
  new Set<string>([...WORKFLOW_ANALYSIS_TOOL_IDS, "econometrics"]),
]

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

export function localizeAnalysisWarning(warning: string) {
  const text = warning.trim()
  if (!text) return undefined
  if (!/[A-Za-z]/.test(text)) return text

  if (/breusch-pagan.*significant|heteroskedasticity.*breusch-pagan/i.test(text)) {
    return "异方差检验显著，建议使用稳健或聚类标准误进行推断。"
  }

  const duplicateRows = text.match(/found\s+(\d+)\s+duplicate entity-time rows/i)
  if (duplicateRows) return `发现 ${duplicateRows[1]} 条个体—时间重复记录，需要处理后再估计。`

  const clusterCount = text.match(/cluster count is low\s*\((\d+)\)/i)
  if (clusterCount) return `聚类数量较少（${clusterCount[1]}），聚类标准误可能不稳定。`

  const droppedRows = text.match(/dropped\s+(\d+)\s+rows with missing model variables/i)
  if (droppedRows) return `因模型变量缺失，已剔除 ${droppedRows[1]} 条样本。`

  const absorbed = text.match(/fully absorbed by fixed effects.*?:\s*(.+)$/i)
  if (absorbed) return `以下变量被固定效应完全吸收，已从模型中移除：${absorbed[1]}。`

  return "检测到需要关注的诊断问题，请查看结果文件中的诊断说明。"
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
  for (const toolGroup of FINAL_PRESENTATION_TOOL_GROUPS) {
    const match = findStep(parts, (part) => toolGroup.has(part.tool))
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
  if (step === "econometrics_recommend") return "计量方法推荐"
  if (step === "psm_construction") return "倾向得分与共同支撑诊断"
  if (step === "psm_visualize") return "倾向得分分布诊断"
  if (step === "psm_matching") return "倾向得分最近邻匹配"
  if (step === "ols_regression") return "OLS 回归"
  if (step === "panel_fe_regression") return "面板固定效应回归"
  if (step === "iv_2sls") return "工具变量回归"
  if (step === "hdfe_regression") return "高维固定效应回归"
  if (step === "did_static") return "传统双重差分"
  if (step === "did2s") return "两阶段双重差分"
  if (step === "did_event_study_saturated") return "现代交错处理事件研究"
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

  if (isWorkflowEstimateTool(latest.tool)) {
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

  if (isWorkflowEstimateTool(latest.tool)) return "汇总结论、诊断信息和关键产物文件"
  if (latest.tool === "psm_construction") return "先检查共同支撑与协变量平衡，再决定是否进入匹配或加权"
  if (latest.tool === "psm_visualize") return "结合分布图检查重叠，再决定是否进入匹配或加权"
  if (latest.tool === "psm_matching") return "检查已匹配处理组的 ATT、样本丢失和协变量平衡"
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
  return uniqueStrings(
    raw
      .filter((warning) => !INTERNAL_WARNING_PATTERNS.some((pattern) => pattern.test(warning)))
      .map(localizeAnalysisWarning),
    4,
  )
}

export function wantsRawAnalysisDetail(latestUserText?: string) {
  return Boolean(latestUserText && RAW_DETAIL_REQUEST_PATTERN.test(latestUserText))
}

export function isAnalysisTurn(tools: AnalysisToolPartLike[], _latestUserText?: string) {
  if (tools.some((part) => getAnalysisView(part))) return true
  if (tools.some((part) => CORE_ANALYSIS_TOOLS.has(part.tool))) return true
  // 不从用户的字面措辞推断模式。像“除了数据分析还能做什么”是闲聊，
  // 只有实际调用了分析工具才进入分析结果的净化与摘要视图。
  return false
}

type PendingTaskFile = {
  filename?: string
  url: string
  mime?: string
}

export function pendingTaskLabel(input: { text?: string; files: PendingTaskFile[] }) {
  const dataFiles = input.files.filter((file) => !file.mime?.startsWith("image/"))
  const source = [input.text ?? "", ...dataFiles.map((file) => `${file.filename} ${file.url}`)]
    .join(" ")
    .toLowerCase()

  if (isNegatedWorkflowRequest(source) || isWorkflowConsultation(source)) return

  if (
    /\b(regression|econometric|econometrics|panel_fe|auto_recommend|did|ols|2sls|iv|psm|rdd)\b/.test(
      source,
    ) ||
    /计量|回归|固定效应|面板|基准模型|双重差分|工具变量|倾向得分|控制变量|稳健性|再分析|重新回归|再估计/.test(source)
  ) {
    return "正在进行计量分析"
  }

  if (
    dataFiles.length > 0 ||
    /\.(xlsx|xls|csv|dta|sav)\b/.test(source) ||
    /\b(excel|spreadsheet|workbook|import)\b/.test(source) ||
    /导入|读取数据|上传数据|数据文件|清洗数据|处理数据/.test(source)
  ) {
    return "正在处理数据"
  }
}

export function shouldShowReasoning(input: {
  hasContent: boolean
  showThinking: boolean
  isAnalysis: boolean
  waitingForAccess: boolean
}) {
  if (!input.hasContent || !input.showThinking) return false
  if (input.isAnalysis || input.waitingForAccess) return false
  return true
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
