import fs from "fs"
import path from "path"
import z from "zod"
import { Instance } from "../project/instance"
import { ensureRuntimePythonReady, formatRuntimePythonSetupError } from "@/killstata/runtime-config"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import { analysisMetric, createToolAnalysisView } from "./analysis-user-view"
import { resolveArtifactInput } from "./analysis-state"
import { resolveDatasetStagePath, resolveToolPath } from "./analysis-path"
import { readStoredDataReadinessState } from "@/runtime/data-readiness"
import { runEngineMethodBackend } from "@/runtime/services/econometrics-engine-backend"

// ── Python profile 结果类型（原在 econometrics.ts 中） ──

type EngineProfileColumn = {
  name: string
  dtype_family: string
  non_null_count: number
  unique_count: number
  binary: boolean
  numeric: boolean
  datetime: boolean
  integer_like: boolean
  nonnegative: boolean
}

type EngineRecommendationResult = {
  profile: {
    row_count: number
    column_count: number
    columns: EngineProfileColumn[]
    candidate_entity_vars: string[]
    candidate_time_vars: string[]
    candidate_treatment_vars: string[]
    candidate_instrument_vars: string[]
    entity_count?: number
    time_count?: number
    duplicate_panel_keys?: number
    avg_periods_per_entity?: number
    balanced_ratio?: number
    data_structure: "cross_section" | "time_series" | "panel" | "repeated_cross_section" | "unknown"
    dependent_var_type: "continuous" | "binary" | "count" | "unknown"
    treatment_var_type: "continuous" | "binary" | "count" | "unknown"
  }
  recommendation: {
    data_structure: "cross_section" | "time_series" | "panel" | "repeated_cross_section" | "unknown"
    recommended_method: "ols_regression" | "panel_fe_regression"
    covariance: "nonrobust" | "robust" | "cluster" | "hac"
    preferred_entity_var?: string
    preferred_time_var?: string
    preferred_treatment_var?: string
    preferred_cluster_var?: string
    confidence: "high" | "medium" | "low"
    reasons: string[]
    warnings: string[]
    next_best_methods: string[]
    post_estimation_rules: string[]
  }
  profilePath?: string
  recommendationPath?: string
}

// ── Zod Schema ──

// 完整输入契约由 Python Registry 的 EconometricsRecommendArguments 单独维护。
// TS 这里只接受 JSON 对象；ToolPort 在 pre-run 阶段注入当前数据血缘并调用
// Python Pydantic validate，再把规范化后的对象交给下方工作流适配器。
const AutoRecommendInput = z.record(z.string(), z.unknown())
type Params = Record<string, unknown>

function formatValidationError(error: z.ZodError) {
  return `计量工具参数不合法：${error.issues.map((i) => `${i.path.join(".") || "参数"}：${i.message}`).join("；")}`
}

const DATA_STRUCTURE_LABELS: Record<string, string> = {
  panel: "面板数据",
  repeated_cross_section: "重复截面数据",
  time_series: "时间序列数据",
  cross_section: "截面数据",
  unknown: "暂未识别",
}

const METHOD_LABELS: Record<string, string> = {
  ols_regression: "普通最小二乘回归（OLS）",
  panel_fe_regression: "面板固定效应回归（FE）",
}

const COVARIANCE_LABELS: Record<string, string> = {
  robust: "稳健标准误（HC1）",
  cluster: "按个体聚类稳健标准误",
  hac: "HAC 稳健标准误",
}

function localizeRecommendationWarning(warning: string) {
  if (/A DID-like treatment name was detected/i.test(warning)) {
    return "检测到名称类似 DID 的处理变量；列名不能替代识别策略，选择 DID 前需确认处理时点与处理设计。"
  }
  const duplicate = warning.match(/Detected\s+(\d+)\s+duplicate entity-time keys/i)
  if (duplicate) {
    return `检测到 ${duplicate[1]} 个重复实体-时间键；面板固定效应估计前应先修复或构造复合实体标识。`
  }
  const clusters = warning.match(/(?:Only|Cluster count is modest)\s+(\d+)\s+clusters?/i)
  if (clusters) return `聚类数量为 ${clusters[1]}，聚类稳健标准误可能不稳定，建议同时比较稳健标准误。`
  const sample = warning.match(/Sample size is small \((\d+)\)/i)
  if (sample) return `样本量较小（${sample[1]}），统计推断可能不稳定。`
  if (/Instrument-like variables detected/i.test(warning)) {
    return "检测到可能的工具变量列；工具变量的相关性与排他性必须结合研究设计由用户确认。"
  }
  if (/dependent variable looks binary/i.test(warning)) {
    return "因变量看起来是二元变量；OLS只能作为线性概率基准，解释口径需要明确。"
  }
  if (/time series/i.test(warning)) return "当前更接近时间序列数据，建议结合趋势项、滞后项和 HAC 推断进一步确认。"
  return "推荐方案包含需要关注的诊断问题，请先查看数据质量检查。"
}

// ── 执行 ──

export const EconometricsRecommendTool = Tool.define("econometrics_recommend", Tool.Execution.managedFilesystem, ToolModel.forTool("econometrics_recommend"), async () => ({
  description:
    "只读分析当前规范化数据的结构、变量类型、缺失和面板线索，给出当前准入工具中可执行的基础计量候选，不运行回归、不创建因果结论。原始 Excel 应先用 data_import 导入；变量角色或方法不清时先调用本工具。返回的是基于数据结构的候选与缺口，不是研究设计授权：不得仅凭列名认定处理变量、结果变量、工具变量有效性、平行趋势或因果方向。需要用户决定的识别问题应明确提出，不自动调用推荐方法。",
  parameters: AutoRecommendInput,
  formatValidationError,
  execute: async (params, ctx) => {
    const datasetId = params.datasetId as string
    const stageId = params.stageId as string
    const dependentVar = params.dependentVar as string | undefined
    const treatmentVar = params.treatmentVar as string | undefined
    const entityVar = params.entityVar as string | undefined
    const timeVar = params.timeVar as string | undefined
    const runtime = await ensureRuntimePythonReady()
    if (!runtime.ok || runtime.missing.length) {
      throw new Error(formatRuntimePythonSetupError("auto_recommend", runtime))
    }

    const artifactInput = resolveArtifactInput({ datasetId, stageId })
    if (!artifactInput.resolvedInputPath) throw new Error("找不到数据文件")
    const dataPath = await resolveDatasetStagePath({
      datasetId,
      filePath: artifactInput.resolvedInputPath,
      toolName: "econometrics_recommend",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      ask: ctx.ask,
    })
    if (!fs.existsSync(dataPath)) throw new Error("找不到数据文件")

    // 上传阶段已经完成的就绪检查比“第一列名字像实体”更可靠。只有单列、唯一且
    // 键列完整的候选才可自动带入画像；复合键、重复键或缺失键仍不能替用户决定。
    const readinessState = readStoredDataReadinessState(datasetId, stageId)
    const verifiedPanel = readinessState.report?.panelCandidates.find(
      (candidate) =>
        candidate.entityVars.length === 1 &&
        candidate.unique &&
        candidate.entityMissingCount === 0 &&
        candidate.timeMissingCount === 0,
    )
    const inferredEntityVar = entityVar ?? (!readinessState.stale ? verifiedPanel?.entityVars[0] : undefined)
    const inferredTimeVar = timeVar ?? (!readinessState.stale ? verifiedPanel?.timeVar : undefined)

    const outputDir = await resolveToolPath({
      filePath: path.join(Instance.directory, "analysis", `auto_recommend_${Date.now()}`),
      mode: "write",
      toolName: "econometrics_recommend",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      ask: ctx.ask,
    })
    fs.mkdirSync(outputDir, { recursive: true })

    await ctx.ask({
      permission: "bash",
      patterns: [`${runtime.executable} *recommend*`],
      always: [`${runtime.executable} *recommend*`],
      metadata: { description: "执行数据智能分析", managedRuntime: true },
    })

    const engineResult = await runEngineMethodBackend({
      sessionID: ctx.sessionID,
      pythonCommand: runtime.executable,
      cwd: Instance.directory,
      methodID: "econometrics_recommend",
      payload: {
        dataPath,
        outputDir,
        dependentVar,
        treatmentVar,
        entityVar: inferredEntityVar,
        timeVar: inferredTimeVar,
      },
      runtime: { datasetId, stageId },
      abort: ctx.abort,
    }) as unknown as EngineRecommendationResult
    const engineProfile = engineResult.profile
    const engineRecommendation = engineResult.recommendation
    const profile = {
      rowCount: engineProfile.row_count,
      columnCount: engineProfile.column_count,
      columns: engineProfile.columns.map((col: EngineProfileColumn) => ({
        name: col.name,
        dtypeFamily: col.dtype_family as "numeric" | "datetime" | "categorical" | "boolean" | "unknown",
        nonNullCount: col.non_null_count,
        uniqueCount: col.unique_count,
        binary: col.binary,
        numeric: col.numeric,
        datetime: col.datetime,
        integerLike: col.integer_like,
        nonnegative: col.nonnegative,
      })),
      explicitEntityVar: inferredEntityVar,
      explicitTimeVar: inferredTimeVar,
      explicitTreatmentVar: treatmentVar,
      explicitDependentVar: dependentVar,
      candidateEntityVars: engineProfile.candidate_entity_vars,
      candidateTimeVars: engineProfile.candidate_time_vars,
      candidateTreatmentVars: engineProfile.candidate_treatment_vars,
      candidateInstrumentVars: engineProfile.candidate_instrument_vars,
      entityCount: engineProfile.entity_count,
      timeCount: engineProfile.time_count,
      duplicatePanelKeys: engineProfile.duplicate_panel_keys,
      avgPeriodsPerEntity: engineProfile.avg_periods_per_entity,
      balancedRatio: engineProfile.balanced_ratio,
      dataStructure: engineProfile.data_structure,
      dependentVarType: engineProfile.dependent_var_type,
      treatmentVarType: engineProfile.treatment_var_type,
    }
    const recommendation = {
      dataStructure: engineRecommendation.data_structure,
      recommendedMethod: engineRecommendation.recommended_method,
      covariance: engineRecommendation.covariance,
      preferredEntityVar: engineRecommendation.preferred_entity_var,
      preferredTimeVar: engineRecommendation.preferred_time_var,
      preferredTreatmentVar: engineRecommendation.preferred_treatment_var,
      preferredClusterVar: engineRecommendation.preferred_cluster_var,
      confidence: engineRecommendation.confidence,
      reasons: engineRecommendation.reasons,
      warnings: engineRecommendation.warnings,
      nextBestMethods: engineRecommendation.next_best_methods,
      postEstimationRules: engineRecommendation.post_estimation_rules,
    }

    const profilePath = engineResult.profilePath ?? path.join(outputDir, "profile.json")
    const recommendationPath = engineResult.recommendationPath ?? path.join(outputDir, "recommendation.json")

    const structureLabel = DATA_STRUCTURE_LABELS[profile.dataStructure] ?? "暂未识别"
    const methodLabel = METHOD_LABELS[recommendation.recommendedMethod] ?? "当前准入的基础回归"
    const covarianceLabel = COVARIANCE_LABELS[recommendation.covariance] ?? recommendation.covariance
    const localizedWarnings = recommendation.warnings.map(localizeRecommendationWarning)
    const analysisView = createToolAnalysisView({
      kind: "econometrics",
      step: "econometrics(recommendation)",
      datasetId,
      stageId,
      results: [
        analysisMetric("数据结构", structureLabel),
        analysisMetric("推荐方法", methodLabel),
        analysisMetric("建议协方差", covarianceLabel),
        analysisMetric("样本量", profile.rowCount),
        analysisMetric("面板实体数", profile.entityCount),
        analysisMetric("时间期数", profile.timeCount),
        analysisMetric("重复实体-时间键", profile.duplicatePanelKeys),
        // 这里只回显模型传入的面板变量，工具未做唯一性核验；措辞不能说“已核验”，
        // 否则会与上一行的“重复实体-时间键：N”自相矛盾，并诱导在重复键上直接做 FE。
        entityVar && timeVar
          ? analysisMetric("面板键（模型指定，未核验）", `${entityVar} × ${timeVar}`)
          : undefined,
      ],
      warnings: localizedWarnings,
      conclusion: "数据结构画像与基础方法候选已完成；执行具体计量方法前仍需确认研究设计和变量角色。",
    })

    const output = [
      "## 数据智能分析结果",
      "",
      `- 数据结构：${structureLabel}`,
      `- 推荐方法：${methodLabel}`,
      `- 建议协方差：${covarianceLabel}`,
      `- 样本量：${profile.rowCount}`,
      profile.entityCount != null ? `- 实体数：${profile.entityCount}` : undefined,
      profile.timeCount != null ? `- 时间期数：${profile.timeCount}` : undefined,
      profile.duplicatePanelKeys != null ? `- 重复实体-时间键：${profile.duplicatePanelKeys}` : undefined,
      recommendation.preferredEntityVar
        ? `- 预选个体变量：${recommendation.preferredEntityVar}`
        : undefined,
      recommendation.preferredTimeVar
        ? `- 预选时间变量：${recommendation.preferredTimeVar}`
        : undefined,
      localizedWarnings.length ? "\n需要注意：" : undefined,
      ...localizedWarnings.map((warning) => `- ${warning}`),
      "",
      "数据画像与推荐方案已生成，已保存为本次分析产物。",
    ]
      .filter((l): l is string => Boolean(l))
      .join("\n")

    return {
      title: "数据智能分析",
      output,
      metadata: {
        method: "auto_recommend",
        // 用户只问“该用什么方法”时，推荐结果就是本轮交付边界；下一轮用户
        // 明确采纳后，resolveTools 会重新开放估计工具。
        finalizeTextOnly: ctx.extra?.recommendationOnly === true,
        backend: "python-registry",
        datasetId,
        stageId,
        profile,
        recommendation,
        profilePath,
        recommendationPath,
        analysisView,
      },
    }
  },
}))
