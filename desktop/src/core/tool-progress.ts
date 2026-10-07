/**
 * Core 工具调用 → 研究者可读进度行。
 *
 * 边界：Core 拥有工具执行、权限与编排；Desktop 只负责把 Core 已经发出的
 * tool part 翻译成一句中文。这里不推断分析状态、不重排步骤、不发明结果。
 *
 * 为什么不直接打印 Core 的 timeline message：`runtime.timeline.event` 的
 * message 是给工程排障的内部字符串（"cache observation"、"context v1"、
 * "query completed"），直接透传会让研究者看到无意义的英文噪音。
 */

/** 工具 / 分析步骤 id → 中文标签。与 Core `displayStepLabel` 的用户可见语义保持一致。 */
const STEP_LABELS: Record<string, string> = {
  // 数据阶段
  "data_import(import)": "导入数据",
  "data_import(profile)": "读取数据概览",
  "data_import(validate)": "检查数据质量",
  "data_import(correlation)": "分析相关性",
  data_import: "处理数据",
  data_preprocess: "预处理数据",
  // 计量估计
  econometrics_recommend: "推荐计量方法",
  ols_regression: "OLS 回归",
  panel_fe_regression: "面板固定效应回归",
  panel_random_effects: "面板随机效应与 Hausman 检验",
  hdfe_regression: "高维固定效应回归",
  iv_2sls: "工具变量回归",
  did_static: "双重差分",
  did2s: "两阶段双重差分",
  did_event_study_saturated: "交错处理事件研究",
  rdd_sharp: "锐性断点回归",
  rdd_fuzzy: "模糊断点回归",
  logit_regression: "Logit 回归",
  probit_regression: "Probit 回归",
  poisson_regression: "Poisson 回归",
  negbin_regression: "负二项回归",
  multinomial_logit: "多分类 Logit 回归",
  robust_regression: "稳健回归",
  wls_regression: "加权最小二乘",
  // 倾向得分
  psm_construction: "估计倾向得分",
  psm_visualize: "诊断倾向得分分布",
  psm_matching: "倾向得分匹配",
  psm_ipw: "逆概率加权",
  psm_regression: "倾向得分回归调整",
  psm_double_robust: "双重稳健 AIPW",
  // 产出
  regression_table: "整理回归表格",
  heterogeneity_runner: "异质性与机制分析",
  research_brief: "撰写研究摘要",
  paper_draft: "起草论文",
  slide_generator: "生成演示材料",
  // 通用工具
  read: "读取文件",
  write: "写入文件",
  edit: "修改文件",
  glob: "查找文件",
  grep: "搜索内容",
  list: "浏览目录",
  bash: "执行命令",
  webfetch: "读取网页",
  websearch: "搜索网络",
  todowrite: "更新任务清单",
  todoread: "查看任务清单",
  workflow: "推进分析流程",
  skill: "调用专项能力",
}

export type ToolProgressState = "pending" | "running" | "completed" | "error"

type ToolInput = Record<string, unknown>

/**
 * 取工具的展示标签。优先用 Core 在 metadata.analysisView.step 里给出的分析步骤
 * （比工具名更具体，例如 econometrics → did2s），否则回退到工具名映射。
 */
export function toolProgressLabel(tool: string, metadata?: Record<string, unknown>, input?: ToolInput): string {
  const step = analysisStep(metadata)
  if (step) {
    if (STEP_LABELS[step]) return STEP_LABELS[step]
    // econometrics(xxx) 这类带括号的步骤：先试括号内的估计量名。
    const inner = step.match(/^[a-z_]+\(([^)]+)\)$/)?.[1]
    if (inner && STEP_LABELS[inner]) return STEP_LABELS[inner]
    if (step.startsWith("econometrics(")) return "计量回归"
  }
  // 失败的 ToolPart 通常没有成功结果才会写入的 analysisView，仍应从原始
  // action 还原具体步骤，否则 data_import 的所有失败都会退化成“处理数据”。
  if (tool === "data_import" && typeof input?.action === "string") {
    const actionLabel = STEP_LABELS[`data_import(${input.action})`]
    if (actionLabel) return actionLabel
  }
  return STEP_LABELS[tool] ?? tool
}

/** Core 把分析步骤挂在 tool state metadata 的 analysisView 上。 */
function analysisStep(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const view = (metadata as { analysisView?: unknown }).analysisView
  if (!view || typeof view !== "object") return undefined
  const step = (view as { step?: unknown }).step
  return typeof step === "string" && step.trim() ? step.trim() : undefined
}

/**
 * Codex 式进度文案：正在做什么 / 做完了什么 / 哪一步没成。
 * 排队中的工具不单独播报（会在下一拍变成"正在…"，提前播报只是闪烁）。
 */
export function toolProgressMessage(
  label: string,
  state: ToolProgressState,
  error?: string,
  context?: { tool?: string; input?: ToolInput },
): string {
  if (state === "completed") return `已完成${label}`
  if (state === "error") {
    const detail = recoverableFailureDetail(error, context)
    return detail ? `${label}未成功：${detail}` : `${label}未成功`
  }
  return `正在${label}…`
}

/**
 * 把 Harness 已确认可自动修复的血缘错误翻译成用户能采取行动的说明。
 * 只映射稳定的错误模式，不把 Python 路径、内部 ID 或原始异常直接泄露到进度行。
 */
function recoverableFailureDetail(error: string | undefined, context?: { tool?: string; input?: ToolInput }) {
  if (
    context?.tool === "data_import" &&
    context.input?.action === "profile" &&
    error &&
    /(inputPath|datasetId|Dataset manifest not found|数据集引用)/i.test(error)
  ) {
    return "缺少当前数据集引用。正在使用最新数据阶段修复。"
  }
  return undefined
}

/** tool state → 进度步骤状态；Desktop 的 ProgressStep 只有四种状态。 */
export function toolProgressStatus(state: ToolProgressState): "queued" | "running" | "completed" | "failed" {
  if (state === "pending") return "queued"
  if (state === "completed") return "completed"
  if (state === "error") return "failed"
  return "running"
}
