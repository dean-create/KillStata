import { getStage, readDatasetManifest } from "./dataset-state"

/** 上传后由数据导入层生成的、与具体模型无关的事实快照。 */
export type DataReadinessReport = {
  version: 1
  generatedAt: string
  rowCount: number
  columnCount: number
  /** 至少包含一个非缺失单元格的行数；0 表示文件虽可读但没有可用观测。 */
  usableObservationCount?: number
  /** 由 TS 写入 stage metadata，用于审计就绪报告属于哪个阶段。 */
  sourceStageId?: string
  columns: Array<{
    name: string
    type: "numeric" | "categorical" | "datetime" | "other"
    missingCount: number
    uniqueCount: number
    constant: boolean
    binary?: boolean
    integerLike?: boolean
    nonnegative?: boolean
  }>
  panelCandidates: Array<{
    /** 一项或多项实际列；多项表示建议生成复合实体标识。 */
    entityVars: string[]
    timeVar: string
    duplicateRows: number
    entityCount: number
    timeCount: number
    unique: boolean
    suggestedAction: "use_as_is" | "combine_columns" | "aggregate" | "resolve_missing"
    entityMissingCount?: number
    timeMissingCount?: number
  }>
  exactLinearDependencies: Array<{
    columns: string[]
    relation: string
    rank: number
    designColumns: number
  }>
  candidateMethods: Array<{
    methodID: string
    status: "candidate" | "needs_roles" | "incompatible"
    reason: string
    repairSuggestions: string[]
  }>
  warnings: string[]
}

export type DataDiagnosisMismatch = "missing_report" | "unsupported_version" | "stage_mismatch" | "fingerprint_missing" | "fingerprint_invalid" | "content_mismatch"

export function dataDiagnosisFingerprintMismatch(
  report: unknown,
  stageId: string,
  dataFingerprint: string,
): DataDiagnosisMismatch | undefined {
  if (!report || typeof report !== "object" || Array.isArray(report)) return "missing_report"
  const value = report as Record<string, unknown>
  if (value.version !== 1) return "unsupported_version"
  if (value.stage_id !== stageId) return "stage_mismatch"
  if (typeof value.data_fingerprint !== "string") return "fingerprint_missing"
  if (!/^sha256:[0-9a-f]{64}$/.test(value.data_fingerprint) || !/^sha256:[0-9a-f]{64}$/.test(dataFingerprint)) {
    return "fingerprint_invalid"
  }
  if (value.data_fingerprint !== dataFingerprint) return "content_mismatch"
  return undefined
}

export function dataDiagnosisMatchesFingerprint(report: unknown, stageId: string, dataFingerprint: string) {
  return dataDiagnosisFingerprintMismatch(report, stageId, dataFingerprint) === undefined
}

/** 只投影诊断中已验证的完整面板键事实，不判断任何方法能否执行。 */
function hasVerifiedCompletePanelKey(candidate: DataReadinessReport["panelCandidates"][number]) {
  return candidate.unique && candidate.entityMissingCount === 0 && candidate.timeMissingCount === 0
}

export function formatDataReadinessForModel(report: DataReadinessReport | undefined) {
  if (!report) return ""
  const encoder = new TextEncoder()
  const maxBytes = 12_000
  const clean = (value: unknown, maxChars = 240) => {
    const normalized = String(value ?? "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, maxChars)
    return normalized
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  }
  const candidates = report.candidateMethods
    .filter((item) => item.status === "candidate")
    .map((item) => clean(item.methodID, 100))
  // needs_roles 的设计类方法（DID/PSM/IV/RDD）此前被整批丢弃，模型在导入后对它们
  // 完全不可见——而这恰恰是最需要模型主动向用户确认识别变量的一批。这里如实列出
  // "结构上可行但缺角色"，措辞保持事实陈述，不构成方法推荐。
  const needsRoles = report.candidateMethods
    .filter((item) => item.status === "needs_roles")
    .map((item) => clean(item.methodID, 100))
  const uniquePanel = report.panelCandidates.filter(hasVerifiedCompletePanelKey).slice(0, 3)
  const directCountColumns = report.columns
    .filter((item) => item.type === "numeric" && item.integerLike === true && item.nonnegative === true && !item.constant)
    .slice(0, 12)
  const lines = [
    "<data-readiness>",
    "数据就绪检查已在上传后静默完成；以下是结构事实，不代表自动替用户做研究设计决定。",
    `规模：${report.rowCount} 行 × ${report.columnCount} 列；数值列 ${report.columns.filter((item) => item.type === "numeric").length} 个。`,
    report.usableObservationCount !== undefined
      ? `至少含有效单元格的观测：${report.usableObservationCount} 行。`
      : "有效观测数尚未记录，需要在具体方法前复核。",
    candidates.length ? `按数据类型可优先适配：${candidates.join("、")}。` : "当前没有足够事实给出类型层面的优先方法。",
  ]
  if (directCountColumns.length) {
    lines.push(
      `已验证可直接作为非负计数结果的列：${directCountColumns.map((item) => clean(item.name, 80)).join("、")}；这些列已经是整数时，不要重复取整，也不要用 create_column 把它们误生成 0/1 指示列。`,
    )
  }
  if (needsRoles.length) {
    lines.push(
      `数据结构上可行但需先确认识别变量：${needsRoles.join("、")}。这不是推荐，采用其中任何一种前必须先与用户确认处理变量、时间结构、工具变量或断点等角色。`,
    )
  }
  if (uniquePanel.length) {
    lines.push(
      `已验证唯一且完整的面板键候选：${uniquePanel.map((item) => `${item.entityVars.map((name) => clean(name, 80)).join("+")}×${clean(item.timeVar, 80)}`).join("；")}。`,
    )
  }
  const missingColumns = report.columns.filter((item) => item.missingCount > 0).slice(0, 12)
  if (missingColumns.length) {
    lines.push(
      `缺失提示：${missingColumns.map((item) => `${clean(item.name, 80)} ${item.missingCount}/${report.rowCount} 行（${report.rowCount > 0 ? ((item.missingCount / report.rowCount) * 100).toFixed(1) : "0.0"}%）`).join("；")}。缺失是否影响估计需结合当前规格确认。`,
    )
  }
  for (const dependency of report.exactLinearDependencies.slice(0, 4)) {
    lines.push(`完全共线提醒：${clean(dependency.relation, 500)}。涉及这些变量的回归规格必须先征得用户确认。`)
  }
  for (const warning of report.warnings.slice(0, 6)) lines.push(`数据提醒：${clean(warning, 500)}`)
  lines.push(
    "用户指定的方法若与当前数据就绪条件不一致，先说明冲突和可逆修正方案；不要为了让回归运行而静默删除变量、删除重复行或更换计量方法。",
  )

  const closing = "</data-readiness>"
  const result: string[] = []
  let bytes = 0
  let omitted = false
  for (const line of lines) {
    if (omitted) continue
    const lineBytes = encoder.encode(`${line}\n`).length
    const reserve = encoder.encode(`${omitted ? "" : "数据就绪摘要其余内容已省略；需要时调用 data_import profile 或 validate。\n"}${closing}`).length
    if (bytes + lineBytes + reserve > maxBytes) {
      omitted = true
      continue
    }
    result.push(line)
    bytes += lineBytes
  }
  if (omitted) result.push("数据就绪摘要其余内容已省略；需要时调用 data_import profile 或 validate。")
  result.push(closing)
  return result.join("\n")
}

function isReadinessReport(value: unknown): value is DataReadinessReport {
  if (!value || typeof value !== "object") return false
  const report = value as Partial<DataReadinessReport>
  return report.version === 1 && typeof report.rowCount === "number" && Array.isArray(report.columns) && Array.isArray(report.panelCandidates)
}

export type StoredDataReadiness = {
  report?: DataReadinessReport
  stale: boolean
  targetStageId?: string
  sourceStageId?: string
  reason?: string
}

/**
 * workflow 节点 ID 归一到数据阶段 ID。
 *
 * 两者是不同命名空间：workflow 的 `resolveWorkflowStageId` 在同一数据阶段上遇到不同
 * kind 时会派生 `stage_001__profile_or_schema_check`、`stage_001__baseline_estimate_001`
 * 这类节点名，而数据 manifest 里只有 `stage_001`。调用方（如 data-context 的
 * `activeOrLatestStage`）拿到的是节点 ID，直接查 manifest 会让 `getStage` 抛错，
 * 落进 catch 后每轮注入“读取当前数据阶段的就绪报告失败，需要重新执行数据画像”——
 * 而报告其实好端端地存在。模型据此反复重跑 profile 也永远清不掉
 *（2026-08-28 did.xlsx 真实会话）。
 *
 * 只做保守剥离：截断第一个 `__` 之前的部分，且仅在该数据阶段确实存在时才采用。
 */
function normalizeToDatasetStageId(
  manifest: { stages: Array<{ stageId: string }> },
  stageId: string,
): string | undefined {
  if (manifest.stages.some((stage) => stage.stageId === stageId)) return stageId
  const separator = stageId.indexOf("__")
  if (separator <= 0) return undefined
  const base = stageId.slice(0, separator)
  return manifest.stages.some((stage) => stage.stageId === base) ? base : undefined
}

/** 读取当前阶段的就绪快照，并区分“没有报告”和“报告属于旧祖先阶段”。 */
export function readStoredDataReadinessState(datasetId: string, stageId?: string): StoredDataReadiness {
  try {
    const manifest = readDatasetManifest(datasetId)
    const normalizedStageId = stageId ? normalizeToDatasetStageId(manifest, stageId) : undefined
    if (stageId && !normalizedStageId) {
      // 归一失败说明这个 ID 既不是数据阶段也无法映射：如实说明找不到该阶段，
      // 不要伪装成“读取失败”让模型误以为重跑画像能修好。
      return {
        stale: true,
        targetStageId: stageId,
        reason: "找不到当前数据阶段 " + stageId + "，不能使用其他阶段的就绪结论。",
      }
    }
    const stage = getStage(manifest, normalizedStageId)
    const direct = stage?.metadata?.dataReadiness ?? stage?.metadata?.readiness
    if (isReadinessReport(direct)) {
      return { report: direct, stale: false, targetStageId: stage?.stageId, sourceStageId: stage?.stageId }
    }
    if (!normalizedStageId) {
      const imported = [...manifest.stages]
        .reverse()
        .find((candidate) => candidate.action === "import" && isReadinessReport(candidate.metadata?.dataReadiness ?? candidate.metadata?.readiness))
      const inherited = imported?.metadata?.dataReadiness ?? imported?.metadata?.readiness
      return isReadinessReport(inherited)
        ? { report: inherited, stale: false, targetStageId: imported?.stageId, sourceStageId: imported?.stageId }
        : { stale: false }
    }

    // 只沿真实 parentStageId 链查找，绝不从另一个分支或任意最新 import 借报告。
    const visited = new Set<string>()
    let parentStageId = stage?.parentStageId
    while (parentStageId && !visited.has(parentStageId)) {
      visited.add(parentStageId)
      const parent = getStage(manifest, parentStageId)
      const parentReport = parent?.metadata?.dataReadiness ?? parent?.metadata?.readiness
      if (isReadinessReport(parentReport)) {
        return {
          report: parentReport,
          stale: true,
          targetStageId: normalizedStageId,
          sourceStageId: parentStageId,
          reason: "当前数据阶段 " + normalizedStageId + " 已由 " + parentStageId + " 派生，但没有该阶段自己的就绪报告。",
        }
      }
      parentStageId = parent?.parentStageId
    }
    return {
      stale: true,
      targetStageId: normalizedStageId,
      reason: "当前数据阶段 " + normalizedStageId + " 没有自己的就绪报告，不能复用无关阶段的验证结果。",
    }
  } catch {
    return { stale: Boolean(stageId), targetStageId: stageId, reason: "读取当前数据阶段的就绪报告失败，需要重新执行数据画像。" }
  }
}

/** 兼容旧调用方：只返回当前阶段的新鲜报告；派生阶段的祖先报告不伪装成当前事实。 */
export function readStoredDataReadiness(datasetId: string, stageId?: string) {
  const state = readStoredDataReadinessState(datasetId, stageId)
  return state.stale ? undefined : state.report
}

export function formatStoredDataReadinessForModel(state: StoredDataReadiness) {
  if (!state.report && !state.stale) return ""
  const report = formatDataReadinessForModel(state.report)
  const notice = state.stale
    ? "<data-readiness>当前阶段就绪检查需要刷新：" +
      String(state.reason ?? "不能复用旧阶段报告")
        .replace(/[\r\n]+/g, " ")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;") +
      "</data-readiness>"
    : ""
  return [report, notice].filter(Boolean).join("\n")
}
