import { displayPath } from "@/tool/analysis-display"
import { readToolAnalysisView } from "@/tool/analysis-user-view"
import { isNegatedWorkflowRequest, isWorkflowConsultation } from "@/runtime/input-intent"
import { WORKFLOW_ANALYSIS_TOOL_IDS, isWorkflowEstimateTool } from "@/runtime/tool-catalog"

type ToolStateLike = {
  status?: string
  input?: Record<string, unknown>
  error?: string
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

// 与 python/econometrics/data_preprocess.py 的 _find_duplicate_key_resolution 同步：
// 数据质量报告在验证出"加某一列可让重复归零"时，会在错误文本里留下这个标记 + 具体列名。
const DUPLICATE_KEY_RESOLVED_MARKER = /verified: combining '([^']+)' with column '([^']+)'/i

/**
 * 面板键重复的用户提示。
 *
 * 若 数据质量检查已经验证出重复能被某一列消解（同名实体分属不同上级区域，如"其他"这个地区名
 * 在多个省份各出现一次），直接告诉用户这不是真实重复、系统已核实哪一列能解决——不要
 * 再问用户"要不要删除这些行"。2026-08-12 gf.xlsx 事故：旧版本对两种情况给同一句模糊
 * 提示，模型据此向用户提议"删除重复行"并标为推荐项，用户选择后会删掉 115 行完全合法
 * 的数据（6 个省份各自的"其他"类别观测）。
 */
export function duplicatePanelKeyMessage(count: string | number, sourceText?: string) {
  const resolved = sourceText?.match(DUPLICATE_KEY_RESOLVED_MARKER)
  if (resolved) {
    const [, entityVar, resolvingColumn] = resolved
    return `质检发现 ${count} 条记录共享同一个"${entityVar}—时间"键，但这不是数据重复：系统已核实，把 "${resolvingColumn}" 与 "${entityVar}" 组合成复合标识后重复即完全消失，说明它们是不同的观测单位（例如同名地区分属不同省份）。系统会用这个复合标识继续分析，不会删除任何行。`
  }
  return `质检发现 ${count} 条记录与其他记录共享同一个“个体—时间”键。这不等于完整数据行重复；请先检查实体标识是否完整（例如是否需要组合上级地区与实体名称生成复合实体 ID），确认后再决定去重或合并。`
}

// 注意：这里含 regression_table / research_brief / paper_draft / slide_generator 以及
// 已下线的 mega 工具 econometrics —— 它们当前都没有实现，也不在 TOOL_MANIFEST 里。
// 保留是因为本集合按 tool name 匹配**历史消息**做渲染：删掉会让老会话的工具卡片
// 退化成裸 ID，而且没有任何测试会失败（仓库里没有历史会话 fixture）。
// 这是展示层的历史兼容名单，不代表这些工具当前可被调度。
const CORE_ANALYSIS_TOOLS = new Set([
  "data_import",
  "econometrics_execute",
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
  new Set(["econometrics_execute"]),
]

const RAW_DETAIL_REQUEST_PATTERN =
  /原始数据|原始内容|文件全文|完整日志|完整\s*json|原始\s*json|调试模式|完整过程|不要摘要|show raw|raw data|full log|full text|raw json/i

const PREFERRED_ARTIFACT_NAMES = ["results.json", "diagnostics.json", "numeric_snapshot.json", "model_metadata.json"]

const PREFERRED_RESULT_LABELS = [
  "did 系数",
  "系数",
  "核心解释变量平均边际效应（概率尺度）",
  "控制变量平均边际效应（概率尺度）",
  "平均边际效应 p 值",
  "McFadden 伪 R²",
  "标准误",
  "p 值",
  "95% 置信区间",
  "协方差",
  "N",
  "组数",
  "组内 R²",
  "within R²",
  "R²",
  "固定效应",
]

const INTERNAL_WARNING_PATTERNS = [
  /Reused existing .* stage/i,
  /source file fingerprint is unchanged/i,
  /^(?:QA gate|数据质量检查) warning\(s\):/i,
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
  // 已由数据导入层整理过的中文质量事实可能包含英文列名（如 time/year）。
  // 不能因为列名含 ASCII 就把整条可核验结论降级成泛化提醒。
  if (/^(?:质量检查事实|缺失|重复键|异常值)[：:]/.test(text)) return text
  if (!/[A-Za-z]/.test(text)) return text

  if (/breusch-pagan.*significant|heteroskedasticity.*breusch-pagan/i.test(text)) {
    return "异方差检验显著，建议使用稳健或聚类标准误进行推断。"
  }

  const duplicateRows = text.match(/found\s+(\d+)\s+duplicate entity-time rows/i)
  if (duplicateRows) return duplicatePanelKeyMessage(duplicateRows[1], text)

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
      findStep(visible, (part) => part.tool === "data_import" && stringValue(part.state.input?.action) === "validate"),
      primaryResultPart,
    ])
  }

  const actionOrder = ["import", "preprocess", "filter", "validate", "profile", "correlation"]
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

  // 回归兜底需要同时交代估计、推断口径与规格；最多十项仍是有界摘要，避免把
  // “固定效应”这类影响解释边界的关键信息排挤掉。
  return ordered.slice(0, 10)
}

function latestConclusion(parts: AnalysisToolPartLike[]) {
  const source = selectPrimaryResultPart(parts) ?? parts[parts.length - 1]
  return source ? getAnalysisView(source)?.conclusion : undefined
}

export function displayStepLabel(step?: string) {
  if (!step) return undefined
  if (step === "econometrics(recommendation)") return "计量方法推荐"
  if (step === "data_import(import)") return "数据导入"
  if (step === "data_import(validate)") return "数据检查"
  if (step === "data_import(profile)") return "描述统计"
  if (step === "data_import(correlation)") return "相关性分析"
  if (step === "econometrics(panel_fe_regression)") return "固定效应回归"
  if (step.startsWith("econometrics(")) return "计量回归"
  if (step === "econometrics_recommend") return "计量方法推荐"
  if (step === "psm_construction") return "倾向得分与共同支撑诊断"
  if (step === "psm_visualize") return "倾向得分分布诊断"
  if (step === "psm_matching") return "倾向得分最近邻匹配"
  if (step === "psm_ipw") return "逆概率加权"
  if (step === "psm_regression") return "倾向得分回归调整"
  if (step === "psm_double_robust") return "双重稳健 AIPW"
  if (step === "ols_regression") return "OLS回归"
  if (step === "panel_fe_regression") return "面板固定效应回归"
  if (step === "panel_random_effects") return "面板随机效应 + Hausman 检验"
  if (step === "iv_2sls") return "工具变量回归"
  if (step === "hdfe_regression") return "高维固定效应回归"
  if (step === "did_static") return "传统双重差分"
  if (step === "did2s") return "两阶段双重差分"
  if (step === "did_event_study_saturated") return "现代交错处理事件研究"
  if (step === "logit_regression") return "Logit 回归"
  if (step === "probit_regression") return "Probit 回归"
  if (step === "poisson_regression") return "Poisson 回归"
  if (step === "negbin_regression") return "负二项回归"
  if (step === "quantile_regression") return "分位数回归"
  if (step === "panel_random_effects") return "面板随机效应 + Hausman 检验"
  if (step === "rdd_sharp") return "锐性断点回归"
  if (step === "rdd_fuzzy") return "模糊断点回归"
  if (step === "multinomial_logit") return "多分类 Logit 回归"
  if (step === "robust_regression") return "稳健回归（RLM）"
  if (step === "wls_regression") return "加权最小二乘（WLS）"
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
    if (step.includes("(validate)")) return `已完成${label}，正在准备进入分析`
    if (step.includes("(profile)") || step.includes("(correlation)")) return `已完成${label}，正在整理统计结果`
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
  if (latest.tool === "psm_construction") return "先核对共同支撑、极端分数和处理前协变量时点；匹配或加权后再检查协变量平衡"
  if (latest.tool === "psm_visualize") return "结合分布图检查重叠，再决定是否进入匹配或加权"
  if (latest.tool === "psm_matching") return "检查已匹配处理组的 ATT、样本丢失和协变量平衡"
  if (latest.tool === "regression_table") return "检查表格标题、列名、注释和导出格式是否可直接引用"
  if (latest.tool === "heterogeneity_runner") return "整理异质性、机制和稳健性扩展产物"
  if (latest.tool === "research_brief") return "整理研究摘要并输出关键信息"
  if (latest.tool === "paper_draft") return "整理草稿结构并准备导出"
  if (latest.tool === "slide_generator") return "整理演示材料并准备导出"

  if (latest.tool === "data_import") {
    if (step.includes("(import)")) return "继续执行数据校验、清洗或筛选"
    if (step.includes("(validate)")) return "进入描述统计或计量分析"
    if (step.includes("(profile)") || step.includes("(correlation)")) return "整理统计发现并决定是否继续建模"
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
    parts.flatMap((part) => [
      ...(getAnalysisView(part)?.warnings ?? []),
      part.state.metadata?.verifierPending === true
        ? isWorkflowEstimateTool(
          typeof part.state.input?.methodID === "string" ? part.state.input.methodID : part.tool,
        )
          ? "估计结果已生成，状态：待核验；核验完成前请勿将其作为最终结论。"
          : "当前步骤已完成，独立核验待完成；这不表示计量估计已完成。"
        : undefined,
      part.state.metadata?.verifierStatus === "block"
        ? "独立核验未通过；估计结果保留，但不可作为最终结论。"
        : undefined,
      part.state.metadata?.verifierStatus === "warn"
        ? "独立核验完成，存在诊断提醒；请查看核验结果。"
        : undefined,
      typeof part.state.metadata?.verifierFailure === "string"
        ? `独立核验未完成：${part.state.metadata.verifierFailure}`
        : undefined,
    ]),
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
  const source = [input.text ?? "", ...dataFiles.map((file) => `${file.filename} ${file.url}`)].join(" ").toLowerCase()

  if (isNegatedWorkflowRequest(source) || isWorkflowConsultation(source)) return

  if (
    /\b(regression|econometric|econometrics|panel_fe|auto_recommend|did|ols|2sls|iv|psm|rdd)\b/.test(source) ||
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
  if (input.waitingForAccess) return false
  void input.isAnalysis
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

/**
 * 当模型在同一轮请求多个估计器却没有生成总结文本时，按估计器拆开兜底。
 * `buildAnalysisUserView` 默认只选择最后一个主结果，这是正常对话的简洁策略；
 * 但收尾失败时继续只展示最后一个会把已经完成的其他模型“吞掉”。
 */
export function maybeBuildAnalysisUserViewTexts(input: { tools: AnalysisToolPartLike[]; latestUserText?: string }) {
  const completed = input.tools.filter(isCompletedTool)
  const estimators = completed.filter((part) => isWorkflowEstimateTool(part.tool) && getAnalysisView(part))
  if (estimators.length <= 1) {
    const single = maybeBuildAnalysisUserViewText(input)
    return single ? [single] : []
  }

  return estimators.flatMap((estimator) => {
    const single = maybeBuildAnalysisUserViewText({
      tools: [estimator],
      latestUserText: input.latestUserText,
    })
    if (!single) return []
    const step = getAnalysisView(estimator)?.step ?? estimator.tool
    const label = displayStepLabel(step) ?? step
    return [{
      view: single.view,
      text: `【${label}】\n${single.text}`,
    }]
  })
}

export function isToolMetadataRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value)
}
