import type { AnalysisChecklistItem, WorkflowRun, WorkflowStageKind } from "./types"

export type WorkflowLocale = "zh-CN" | "en"

const CHECKLIST_LABELS: Record<AnalysisChecklistItem["id"], { en: string; zh: string }> = {
  data_readiness: {
    en: "Data readiness",
    zh: "数据准备",
  },
  identification: {
    en: "Identification & variables",
    zh: "识别策略与变量",
  },
  baseline_model: {
    en: "Baseline model",
    zh: "基准模型",
  },
  diagnostics: {
    en: "Diagnostics & robustness",
    zh: "诊断与稳健性",
  },
  reporting: {
    en: "Reporting",
    zh: "结果报告",
  },
}

const STAGE_LABELS: Record<WorkflowStageKind, { en: string; zh: string }> = {
  healthcheck: { en: "Healthcheck", zh: "环境检查" },
  import: { en: "Import", zh: "数据导入" },
  profile_or_schema_check: { en: "Profile / schema check", zh: "结构与模式检查" },
  qa_gate: { en: "QA gate", zh: "质量门禁" },
  preprocess_or_filter: { en: "Preprocess / filter", zh: "预处理与筛选" },
  describe_or_diagnostics: { en: "Describe / diagnostics", zh: "描述统计与诊断" },
  baseline_estimate: { en: "Baseline estimate", zh: "基准估计" },
  verifier: { en: "Verifier", zh: "校验器" },
  report: { en: "Report", zh: "报告生成" },
}

const STATUS_LABELS: Record<AnalysisChecklistItem["status"], { en: string; zh: string }> = {
  pending: { en: "pending", zh: "待开始" },
  in_progress: { en: "in_progress", zh: "进行中" },
  completed: { en: "completed", zh: "已完成" },
  blocked: { en: "blocked", zh: "已阻塞" },
}

const APPROVAL_LABELS: Record<NonNullable<WorkflowRun["approvalStatus"]>, { en: string; zh: string }> = {
  required: { en: "required", zh: "待审批" },
  approved: { en: "approved", zh: "已批准" },
  declined: { en: "declined", zh: "已拒绝" },
}

export function detectWorkflowLocaleFromText(text?: string): WorkflowLocale {
  // KillStata 面向中文用户，工作流提示不跟随模型或数据字段切换语言。
  // 这样历史会话和英文变量名也不会让审批界面退回英文。
  void text
  return "zh-CN"
}

export async function inferWorkflowLocaleFromSession(sessionID: string, fallback: WorkflowLocale = "zh-CN") {
  const { MessageV2 } = await import("@/session/message-v2")
  let latest = ""
  for await (const message of MessageV2.stream(sessionID)) {
    if (message.info.role !== "user") continue
    const userText = message.parts
      .filter((part): part is Extract<(typeof message.parts)[number], { type: "text" }> => part.type === "text")
      .filter((part) => !part.synthetic && !part.ignored)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
    if (userText) latest = userText
  }
  return latest ? detectWorkflowLocaleFromText(latest) : fallback
}

export function workflowLocaleLabel(locale: WorkflowLocale, values: { en: string; zh: string }) {
  return values.zh
}

export function workflowChecklistLabel(locale: WorkflowLocale, id: AnalysisChecklistItem["id"]) {
  return workflowLocaleLabel(locale, CHECKLIST_LABELS[id])
}

export function workflowChecklistStatusLabel(locale: WorkflowLocale, status: AnalysisChecklistItem["status"]) {
  return workflowLocaleLabel(locale, STATUS_LABELS[status])
}

export function workflowApprovalStatusLabel(locale: WorkflowLocale, approvalStatus?: WorkflowRun["approvalStatus"]) {
  if (!approvalStatus) return undefined
  return workflowLocaleLabel(locale, APPROVAL_LABELS[approvalStatus])
}

export function workflowStageLabel(locale: WorkflowLocale, stage?: WorkflowStageKind | string) {
  if (!stage) return undefined
  if (!(stage in STAGE_LABELS)) return undefined
  return workflowLocaleLabel(locale, STAGE_LABELS[stage as WorkflowStageKind])
}

export function workflowPlanTitle(locale: WorkflowLocale) {
  return "工作流计划"
}

export function workflowApprovalTitle(locale: WorkflowLocale) {
  return "审批"
}

export function workflowStageTitle(locale: WorkflowLocale) {
  return "阶段"
}

export function workflowAnalysisPlanHeader(locale: WorkflowLocale) {
  return "分析计划"
}

export function workflowChecklistIntro(locale: WorkflowLocale, kind: "analysis" | "empirical") {
  return kind === "empirical" ? "已整理出这份实证执行清单：" : "已整理出这份执行清单："
}

export function workflowChecklistApprovalPrompt(locale: WorkflowLocale, kind: "analysis" | "empirical") {
  return kind === "empirical" ? "确认后将开始计量执行流程。" : "现在开始执行这份计划吗？"
}

export function workflowChecklistOptions(locale: WorkflowLocale, kind: "analysis" | "empirical") {
  return {
    yes: {
      label: "是",
      description: kind === "empirical" ? "批准计划并开始计量执行" : "批准计划并继续数据与分析步骤",
    },
    no: {
      label: "否",
      description: kind === "empirical" ? "保持规划模式，暂不运行模型" : "保持规划模式，先不执行",
    },
  }
}
