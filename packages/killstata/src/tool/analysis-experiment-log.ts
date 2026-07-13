import fs from "fs"
import path from "path"
import {
  datasetRoot,
  readDatasetManifest,
  type DatasetArtifactRecord,
  type DatasetManifest,
  type DatasetStageRecord,
} from "./analysis-state"

// 实证研究的真实工作方式是「试设定」：换样本、换时间窗、换控制变量，看结果怎么动。
// 这本身是正当的稳健性分析——**前提是把试过的设定全部留痕**。只报告显著的那一次而
// 藏起其余的，就是 p-hacking。
//
// 这份日志的职责就是留痕：每跑一次回归，自动记下「数据是什么样的」和「结果是什么」，
// 谁也删不掉、也不用用户记得去点。它既是给用户看的实验记录，也是投稿时经得起查的底账。

export const EXPERIMENT_LOG_FILENAME = "EXPERIMENT_LOG.md"

export type ExperimentEntry = {
  /** 第几次实验（从 1 开始，按写入顺序） */
  index: number
  createdAt: string
  method: string
  /** 这次回归用的是哪个数据阶段 */
  stageId?: string
  stageAction?: string
  stageLabel?: string
  rowCount?: number
  columnCount?: number
  /** 上一阶段的行数，用来算样本增减 */
  parentRowCount?: number
  dependentVar?: string
  treatmentVar?: string
  covariates?: string[]
  entityVar?: string
  timeVar?: string
  clusterVar?: string
  coefficient?: number
  stdError?: number
  pValue?: number
  rSquared?: number
  rowsUsed?: number
  /** 实际执行的方法（可能因数据条件被降级） */
  effectiveMethod?: string
  degradedFrom?: string
  warnings?: string[]
}

export function experimentLogPath(datasetId: string) {
  return path.join(datasetRoot(datasetId), EXPERIMENT_LOG_FILENAME)
}

function stars(pValue?: number) {
  if (pValue === undefined || Number.isNaN(pValue)) return ""
  if (pValue < 0.01) return "***"
  if (pValue < 0.05) return "**"
  if (pValue < 0.1) return "*"
  return ""
}

function fmt(value?: number, digits = 4) {
  if (value === undefined || value === null || Number.isNaN(value)) return "—"
  return value.toFixed(digits)
}

function fmtP(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) return "—"
  // p 值小到一定程度再报小数位就没意义了，直接给上界。
  if (value < 0.0001) return "<0.0001"
  return value.toFixed(4)
}

function fmtCount(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) return "—"
  return value.toLocaleString("en-US")
}

/** 样本量相对上一阶段的变化，例如「4,709 → 3,200（-1,509）」 */
function describeSampleChange(entry: ExperimentEntry) {
  const now = entry.rowCount
  const before = entry.parentRowCount
  if (now === undefined) return "—"
  if (before === undefined || before === now) return `${fmtCount(now)} 行`
  const delta = now - before
  const sign = delta > 0 ? "+" : "−"
  return `${fmtCount(before)} → ${fmtCount(now)} 行（${sign}${fmtCount(Math.abs(delta))}）`
}

function describeSpec(entry: ExperimentEntry) {
  const parts: string[] = []
  if (entry.dependentVar) {
    const rhs = [entry.treatmentVar, ...(entry.covariates ?? [])].filter(Boolean).join(" + ")
    parts.push(`\`${entry.dependentVar} ~ ${rhs || "—"}\``)
  }
  if (entry.entityVar) parts.push(`个体 \`${entry.entityVar}\``)
  if (entry.timeVar) parts.push(`时间 \`${entry.timeVar}\``)
  if (entry.clusterVar) parts.push(`聚类 \`${entry.clusterVar}\``)
  return parts.join(" · ") || "—"
}

/** 与上一次实验对比：系数动了多少、显著性变强还是变弱 */
function describeDelta(entry: ExperimentEntry, previous?: ExperimentEntry) {
  if (!previous) return undefined
  if (entry.coefficient === undefined || previous.coefficient === undefined) return undefined

  const lines: string[] = []
  const coefBefore = previous.coefficient
  const coefNow = entry.coefficient
  const pct =
    coefBefore !== 0 ? ` (${coefNow > coefBefore ? "+" : ""}${(((coefNow - coefBefore) / Math.abs(coefBefore)) * 100).toFixed(1)}%)` : ""
  lines.push(`系数 ${fmt(coefBefore)} → **${fmt(coefNow)}**${pct}`)

  if (entry.pValue !== undefined && previous.pValue !== undefined) {
    const before = fmtP(previous.pValue)
    const now = fmtP(entry.pValue)
    // 两个 p 值在报告精度下无法区分时（例如都是 <0.0001），不要拿底层浮点去分高下——
    // 说"更不显著"只会让读者困惑，而且这种差别在统计上本来也没有意义。
    if (before === now) {
      lines.push(`p 值 ${now}（显著性相当）`)
    } else {
      const direction = entry.pValue < previous.pValue ? "更显著" : "更不显著"
      lines.push(`p ${before} → **${now}**（${direction}）`)
    }
  }
  return lines.join(" · ")
}

function renderEntry(entry: ExperimentEntry, previous?: ExperimentEntry) {
  const lines: string[] = []
  const label = entry.stageLabel || entry.stageAction || entry.stageId || "原始数据"
  lines.push(`## 实验 ${entry.index} · ${label}`)
  lines.push("")
  lines.push(`- **时间**：${entry.createdAt}`)
  lines.push(`- **数据**：${describeSampleChange(entry)}${entry.stageId ? ` · \`${entry.stageId}\`` : ""}`)
  lines.push(`- **方法**：\`${entry.effectiveMethod || entry.method}\`${entry.degradedFrom ? `（自 \`${entry.degradedFrom}\` 降级）` : ""}`)
  lines.push(`- **设定**：${describeSpec(entry)}`)

  const star = stars(entry.pValue)
  lines.push(
    `- **结果**：系数 **${fmt(entry.coefficient)}**` +
      ` · 标准误 ${fmt(entry.stdError)}` +
      // 显著性星号本身就是 `*`，再用 `**` 加粗会和 markdown 的强调语法打架，直接输出。
      ` · p = ${fmtP(entry.pValue)}${star ? ` ${star}` : ""}` +
      ` · R² ${fmt(entry.rSquared, 3)}` +
      ` · N = ${fmtCount(entry.rowsUsed)}`,
  )

  const delta = describeDelta(entry, previous)
  if (delta) lines.push(`- **对比实验 ${previous!.index}**：${delta}`)

  if (entry.warnings?.length) {
    lines.push(`- **告警**：${entry.warnings.slice(0, 3).join("；")}`)
  }
  lines.push("")
  return lines.join("\n")
}

/** 设定汇总表——把所有试过的设定并排放，一眼看出结论对设定有多敏感 */
function renderSummaryTable(entries: ExperimentEntry[]) {
  const lines: string[] = []
  lines.push("## 设定汇总")
  lines.push("")
  lines.push("| # | 数据阶段 | N | 方法 | 系数 | 标准误 | p 值 | 显著性 |")
  lines.push("|---|---|---|---|---|---|---|---|")
  for (const e of entries) {
    const label = e.stageLabel || e.stageAction || e.stageId || "—"
    lines.push(
      `| ${e.index} | ${label} | ${fmtCount(e.rowsUsed ?? e.rowCount)} | ${e.effectiveMethod || e.method} ` +
        `| ${fmt(e.coefficient)} | ${fmt(e.stdError)} | ${fmtP(e.pValue)} | ${stars(e.pValue) || "n.s."} |`,
    )
  }
  lines.push("")
  return lines.join("\n")
}

export function renderExperimentLog(input: { datasetId: string; entries: ExperimentEntry[] }) {
  const lines: string[] = []
  lines.push(`# 实证分析实验日志`)
  lines.push("")
  lines.push(`数据集：\`${input.datasetId}\` · 共 ${input.entries.length} 次实验`)
  lines.push("")

  if (input.entries.length === 0) {
    lines.push("_尚未运行任何回归。_")
    lines.push("")
    return lines.join("\n")
  }

  lines.push(renderSummaryTable(input.entries))
  lines.push("---")
  lines.push("")

  input.entries.forEach((entry, idx) => {
    lines.push(renderEntry(entry, idx > 0 ? input.entries[idx - 1] : undefined))
  })

  lines.push("---")
  lines.push("")
  lines.push(
    "> 本日志自动记录**每一次**回归尝试，包括未被采用的设定。" +
      "报告结果时应披露全部尝试过的设定，只挑选显著的那一个而隐去其余，属于 p-hacking。",
  )
  lines.push("")
  return lines.join("\n")
}

/** 从 results.json 里把可引用的数字捞出来 */
function readResultNumbers(outputPath?: string) {
  if (!outputPath || !fs.existsSync(outputPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as Record<string, any>
    return {
      coefficient: typeof parsed.coefficient === "number" ? parsed.coefficient : undefined,
      stdError: typeof parsed.std_error === "number" ? parsed.std_error : undefined,
      pValue: typeof parsed.p_value === "number" ? parsed.p_value : undefined,
      rSquared: typeof parsed.r_squared === "number" ? parsed.r_squared : undefined,
      rowsUsed: typeof parsed.rows_used === "number" ? parsed.rows_used : undefined,
      effectiveMethod: typeof parsed.effective_method === "string" ? parsed.effective_method : undefined,
      degradedFrom: typeof parsed.degraded_from === "string" ? parsed.degraded_from : undefined,
      warnings: Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : undefined,
    }
  } catch {
    return {}
  }
}

/** 只有真正跑出了估计结果的 artifact 才算一次"实验"——推荐/画像类的不算 */
function isEstimationArtifact(artifact: DatasetArtifactRecord) {
  const skip = new Set(["auto_recommend", "qa", "describe", "correlation", "profile"])
  return !skip.has(artifact.action)
}

function findStage(manifest: DatasetManifest, stageId?: string): DatasetStageRecord | undefined {
  if (!stageId) return undefined
  return manifest.stages.find((item) => item.stageId === stageId)
}

/**
 * 从 manifest 重建整份实验日志。
 * 数据全部来自已落盘的 stage / artifact / results.json —— 不新增任何真相来源，
 * 因此任何时候重跑都能得到同一份日志。
 */
export function buildExperimentEntries(manifest: DatasetManifest): ExperimentEntry[] {
  const artifacts = manifest.artifacts
    .filter(isEstimationArtifact)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return artifacts.map((artifact, idx) => {
    const stage = findStage(manifest, artifact.stageId)
    const parent = findStage(manifest, stage?.parentStageId)
    const spec = (artifact.metadata?.["spec"] ?? {}) as Record<string, any>

    return {
      index: idx + 1,
      createdAt: artifact.createdAt,
      method: artifact.action,
      stageId: stage?.stageId,
      stageAction: stage?.action,
      stageLabel: stage?.label,
      rowCount: stage?.rowCount,
      columnCount: stage?.columnCount,
      parentRowCount: parent?.rowCount,
      dependentVar: spec["dependentVar"],
      treatmentVar: spec["treatmentVar"],
      covariates: Array.isArray(spec["covariates"]) ? spec["covariates"] : undefined,
      entityVar: spec["entityVar"],
      timeVar: spec["timeVar"],
      clusterVar: spec["clusterVar"],
      ...readResultNumbers(artifact.outputPath),
    } satisfies ExperimentEntry
  })
}

/**
 * 回归跑完后自动调用：重建并写出日志。
 * 刻意做成"全量重建"而不是"追加一行"——manifest 才是真相源，这样即使中途有回归失败、
 * 或者用户回滚了某个 stage，日志也不会和事实对不上。
 */
export function refreshExperimentLog(datasetId: string): string | undefined {
  try {
    const manifest = readDatasetManifest(datasetId)
    const entries = buildExperimentEntries(manifest)
    if (entries.length === 0) return undefined

    const target = experimentLogPath(datasetId)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, renderExperimentLog({ datasetId, entries }), "utf-8")
    return target
  } catch {
    // 日志是附加价值，绝不能因为它写失败而让一次成功的回归报错。
    return undefined
  }
}
