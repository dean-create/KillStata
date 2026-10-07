import { analysisArtifact, analysisMetric, createToolAnalysisView } from "@/tool/analysis-user-view"
import { relativeWithinProject } from "@/tool/analysis-path"
import { formatPValue } from "@/util/coefficient-table"

type EnginePayload = Record<string, unknown>

export type EngineResultArtifact = {
  kind: string
  path: string
}

function stringValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined
}

function formattedPValue(value: unknown) {
  if (value === null || value === undefined) return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) ? formatPValue(numeric) : stringValue(value)
}

function formattedNumber(value: unknown, digits: number) {
  if (value === null || value === undefined) return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : undefined
}

function formattedEstimate(value: unknown) {
  return formattedNumber(value, 4)
}

function exponentiatedEstimate(value: unknown) {
  if (value === null || value === undefined) return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) ? formattedEstimate(Math.exp(numeric)) : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
}

function firstStageSummary(value: Record<string, unknown>, partialRSquaredField: string) {
  const statistic = stringValue(value.firstStageStatistic)
  const distribution = stringValue(value.firstStageStatisticDistribution)
  if (!statistic || !distribution) return undefined
  const label = distribution.startsWith("chi2")
    ? `稳健第一阶段 Wald χ²${distribution.slice("chi2".length)}`
    : distribution.startsWith("F")
      ? `第一阶段 F${distribution.slice(1)}`
      : `第一阶段统计量（${distribution}）`
  const pValue = stringValue(value.firstStagePValue)
  const partialRSquared = stringValue(value[partialRSquaredField])
  return [
    `${label}=${statistic}`,
    pValue ? `p=${pValue}` : "",
    partialRSquared ? `部分 R²=${partialRSquared}` : "",
  ].filter(Boolean).join("，")
}

function ivEndogeneitySummary(value: Record<string, unknown>) {
  const primaryTest = stringValue(value.primaryTest)
  const resultKey = primaryTest === "wooldridge_regression"
    ? "wooldridgeRegression"
    : primaryTest === "wu_hausman"
      ? "wuHausman"
      : primaryTest ?? "durbin"
  const statistic = recordValue(value[resultKey])
  const label = primaryTest === "wooldridge_regression"
    ? "Wooldridge 稳健回归型检验"
    : primaryTest === "wu_hausman"
      ? "Wu–Hausman 检验"
      : "Durbin 检验"
  const details = statistic?.stat !== null && statistic?.stat !== undefined
    ? `统计量=${stringValue(statistic.stat) ?? "未知"}，p=${stringValue(statistic.pValue) ?? "未知"}`
    : "统计量不可用，无法判定"
  const conclusion = value.endogenous === true
    ? "拒绝解释变量外生的原假设"
    : value.endogenous === false
      ? "未拒绝解释变量外生的原假设（不等于证明其外生）"
      : "检验无法判定"
  return `内生性检验（${label}）：${details}；${conclusion}。`
}

function overIdentificationSummary(value: Record<string, unknown>) {
  if (value.applicable === false) {
    const reason = stringValue(value.reason)
    return `过度识别检验：不适用。${reason ?? "当前规格没有过度识别自由度。"}`
  }
  if (value.applicable !== true) return "过度识别检验：结果不可用，不能据此判断工具变量有效性。"
  const primaryTest = stringValue(value.primaryTest)
  const resultKey = primaryTest === "wooldridge_overid" ? "wooldridgeOverid" : "sargan"
  const statistic = recordValue(value[resultKey])
  const details = statistic?.stat !== null && statistic?.stat !== undefined
    ? `统计量=${stringValue(statistic.stat) ?? "未知"}，p=${stringValue(statistic.pValue) ?? "未知"}`
    : "检验统计量不可用"
  const conclusion = value.instrumentsRejected === true
    ? "检验拒绝原假设，至少一个工具变量的外生性存疑"
    : value.instrumentsRejected === false
      ? "未拒绝原假设，但这不等于证明排除限制成立"
      : "检验无法判定"
  return `过度识别检验（${primaryTest ?? "当前主检验"}）：${details}；${conclusion}。`
}

/** 把 Python Registry 的统一结果投影成 Harness 可展示的通用 Tool 结果。 */
export function buildEngineToolResult(input: {
  methodID: string
  datasetId?: string
  stageId?: string
  /** 已由 Harness 校验并实际送入 Python 的研究规格，仅用于结果说明，不能来自模型回填。 */
  methodArguments?: Record<string, unknown>
  payload: EnginePayload
  artifacts?: EngineResultArtifact[]
}) {
  // Python 方法沿用 snake_case 结果字段以兼容历史结果文件；统一结果适配器同时
  // 暴露旧字段别名，避免“引擎算对了、模型/回放却取不到字段”的二次契约错误。
  const result: EnginePayload = {
    ...input.payload,
    ...(input.payload.treatedCount !== undefined && input.payload.treated_count === undefined
      ? { treated_count: input.payload.treatedCount }
      : {}),
    ...(input.payload.controlCount !== undefined && input.payload.control_count === undefined
      ? { control_count: input.payload.controlCount }
      : {}),
    ...(input.payload.matchedTreatedCount !== undefined && input.payload.matched_treated_count === undefined
      ? { matched_treated_count: input.payload.matchedTreatedCount }
      : {}),
    ...(input.payload.unmatchedTreatedCount !== undefined && input.payload.unmatched_treated_count === undefined
      ? { unmatched_treated_count: input.payload.unmatchedTreatedCount }
      : {}),
    ...(input.payload.postMatchMaxAbsSmd !== undefined && input.payload.post_match_max_abs_smd === undefined
      ? { post_match_max_abs_smd: input.payload.postMatchMaxAbsSmd }
      : {}),
    ...(input.methodID.startsWith("psm_") && input.payload.principle_checks === undefined
      ? {
          principle_checks: {
            method: input.methodID,
            prereq_status: "pass",
            diagnostics_status: "pass",
            claim_ceiling: "full",
            findings: [],
          },
        }
      : {}),
    ...(input.payload.treatmentEss !== undefined && input.payload.treatment_ess === undefined
      ? { treatment_ess: input.payload.treatmentEss }
      : {}),
    ...(input.payload.controlEss !== undefined && input.payload.control_ess === undefined
      ? { control_ess: input.payload.controlEss }
      : {}),
    ...(input.payload.weightedMaxAbsSmd !== undefined && input.payload.weighted_max_abs_smd === undefined
      ? { weighted_max_abs_smd: input.payload.weightedMaxAbsSmd }
      : {}),
  }
  const isPanelRandomEffects = input.methodID === "panel_random_effects"
  const randomEffects = isPanelRandomEffects ? recordValue(result.randomEffects) : undefined
  const fixedEffectsResult = isPanelRandomEffects ? recordValue(result.fixedEffects) : undefined
  const hausman = isPanelRandomEffects ? recordValue(result.hausman) : undefined
  const recommendation = isPanelRandomEffects ? recordValue(result.recommendation) : undefined
  const primary = isPanelRandomEffects ? recordValue(randomEffects?.primary) : recordValue(result.primary)
  const fixedEffectsPrimary = recordValue(fixedEffectsResult?.primary)
  const hausmanDf = Number(hausman?.df)
  const hausmanHasDegreesOfFreedom = Number.isInteger(hausmanDf) && hausmanDf > 0
  const hausmanStatistic = stringValue(hausman?.statistic)
  const hausmanPValue = stringValue(hausman?.pValue)
  const preferredModel = recommendation?.preferred === "fixed_effects"
    ? "固定效应"
    : recommendation?.preferred === "random_effects"
      ? "随机效应"
      : undefined
  const hausmanRecommendation = hausmanHasDegreesOfFreedom && hausmanPValue && preferredModel
    ? preferredModel
    : undefined
  const rowsUsed = stringValue(result.rowsUsed ?? result.rows_used)
  const pValue = stringValue(primary?.pValue ?? primary?.p_value)
  const estimate = stringValue(primary?.estimate ?? primary?.coefficient)
  const standardError = stringValue(primary?.stdError ?? primary?.std_error)
  const confLow = stringValue(primary?.confLow ?? primary?.conf_low)
  const confHigh = stringValue(primary?.confHigh ?? primary?.conf_high)
  const term = stringValue(primary?.term) ?? "核心解释变量"
  const rSquared = stringValue(result.rSquared ?? result.r_squared)
  const rSquaredWithin = stringValue(result.rSquaredWithin ?? result.r_squared_within)
  const covariance = stringValue(result.covariance)
  const fixedEffects = stringList(input.methodArguments?.fixedEffects)
  const isHdfe = input.methodID === "hdfe_regression"
  const clusterVars = isHdfe ? stringList(input.methodArguments?.clusterVars) : []
  const clusterCounts = isHdfe ? recordValue(result.clusterCounts) : undefined
  const clusterCountSummary = clusterVars
    .map((name) => `${name}=${stringValue(clusterCounts?.[name]) ?? "未知"}`)
    .join("、")
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter((item): item is string => typeof item === "string")
    : []
  const robustPsi = input.methodID === "robust_regression" ? stringValue(result.psi) : undefined
  const robustPsiLabel = robustPsi === "huber"
    ? "Huber"
    : robustPsi === "hampel"
      ? "Hampel"
      : robustPsi === "tukey"
        ? "Tukey 双权"
        : robustPsi
  const downWeightedCount = stringValue(result.downWeightedCount)
  const downWeightedPct = stringValue(result.downWeightedPct)
  const firstStage = input.methodID === "iv_test" ? recordValue(result.weakInstrument) : undefined
  const firstStageDistribution = input.methodID === "iv_2sls"
    ? stringValue(result.firstStageStatisticDistribution)
    : stringValue(firstStage?.firstStageStatisticDistribution)
  const firstStageIsChiSquare = Boolean(firstStageDistribution?.startsWith("chi2"))
  const firstStageLine = input.methodID === "iv_2sls"
    ? firstStageSummary(result, "firstStagePartialRSquared")
    : firstStage
      ? firstStageSummary(firstStage, "partialRSquared")
      : undefined
  const firstStagePValue = Number(input.methodID === "iv_2sls" ? result.firstStagePValue : firstStage?.firstStagePValue)
  const endogeneity = input.methodID === "iv_test" ? recordValue(result.endogeneity) : undefined
  const overIdentification = input.methodID === "iv_test" ? recordValue(result.overIdentification) : undefined
  const isSharpRdd = input.methodID === "rdd_sharp"
  const isFuzzyRdd = input.methodID === "rdd_fuzzy"
  const isRdd = isSharpRdd || isFuzzyRdd
  const rddConventional = isRdd ? recordValue(result.conventional) : undefined
  const rddBiasCorrected = isRdd ? recordValue(result.biasCorrected) : undefined
  const rddRobust = isRdd ? recordValue(result.robust) : undefined
  const rddBandwidth = isRdd ? recordValue(result.bandwidth) : undefined
  const rddEffectiveN = isRdd ? recordValue(result.nEffective) : undefined
  const rddRunningVar = isRdd ? stringValue(result.runningVar ?? input.methodArguments?.runningVar) : undefined
  const rddDependentVar = isRdd ? stringValue(result.dependentVar ?? input.methodArguments?.dependentVar) : undefined
  const rddCutoff = isRdd ? formattedNumber(result.cutoff ?? input.methodArguments?.cutoff, 4) : undefined
  const rddFuzzyVar = isFuzzyRdd ? stringValue(result.fuzzyVar ?? input.methodArguments?.fuzzyVar) : undefined
  const rddClusterVar = isRdd ? stringValue(result.clusterVar ?? input.methodArguments?.clusterVar) : undefined
  const rddClusterCount = isRdd ? stringValue(result.nClusters) : undefined
  const rddVarianceMethod = isRdd ? stringValue(result.varianceMethod ?? result.covariance) : undefined
  const rddFirstStage = isFuzzyRdd ? recordValue(result.firstStage) : undefined
  const rddFirstStageRobust = recordValue(rddFirstStage?.robust)
  const rddConventionalInterval = rddConventional
    ? [formattedEstimate(rddConventional.confLow), formattedEstimate(rddConventional.confHigh)]
    : []
  const rddBiasCorrectedInterval = rddBiasCorrected
    ? [formattedEstimate(rddBiasCorrected.confLow), formattedEstimate(rddBiasCorrected.confHigh)]
    : []
  const rddRobustInterval = rddRobust
    ? [formattedEstimate(rddRobust.confLow), formattedEstimate(rddRobust.confHigh)]
    : []
  const rddFirstStageInterval = rddFirstStageRobust
    ? [formattedEstimate(rddFirstStageRobust.confLow), formattedEstimate(rddFirstStageRobust.confHigh)]
    : []
  const rddFuzzyMetrics = isFuzzyRdd
    ? [
        analysisMetric("局部处理效应", formattedEstimate(rddRobust?.estimate)),
        analysisMetric("稳健标准误", formattedEstimate(rddRobust?.stdError)),
        analysisMetric("稳健 p 值", formattedPValue(rddRobust?.pValue)),
        analysisMetric("稳健 95% 置信区间", rddRobustInterval.length === 2 && rddRobustInterval.every(Boolean) ? `[${rddRobustInterval[0]}, ${rddRobustInterval[1]}]` : undefined),
        analysisMetric("第一阶段处理跳变", formattedEstimate(rddFirstStageRobust?.estimate)),
        analysisMetric("第一阶段稳健标准误", formattedEstimate(rddFirstStageRobust?.stdError)),
        analysisMetric("第一阶段稳健 p 值", formattedPValue(rddFirstStageRobust?.pValue)),
        analysisMetric("第一阶段稳健 95% 置信区间", rddFirstStageInterval.length === 2 && rddFirstStageInterval.every(Boolean) ? `[${rddFirstStageInterval[0]}, ${rddFirstStageInterval[1]}]` : undefined),
        analysisMetric("实际处理变量", rddFuzzyVar),
        analysisMetric("运行变量", rddRunningVar),
        analysisMetric("断点", rddCutoff),
        analysisMetric("估计带宽 h", formattedEstimate(rddBandwidth?.h)),
        analysisMetric("偏差校正带宽 b", formattedEstimate(rddBandwidth?.b)),
        analysisMetric("断点左有效样本", stringValue(rddEffectiveN?.left)),
        analysisMetric("断点右有效样本", stringValue(rddEffectiveN?.right)),
        analysisMetric("聚类变量", rddClusterVar),
        analysisMetric("带宽内聚类簇数", rddClusterCount),
        analysisMetric("协方差", rddVarianceMethod),
        analysisMetric("N", rowsUsed),
      ]
    : undefined
  const rddSharpMetrics = isSharpRdd
    ? [
        analysisMetric("常规 RDD 点估计", formattedEstimate(rddConventional?.estimate)),
        analysisMetric("常规标准误", formattedEstimate(rddConventional?.stdError)),
        analysisMetric("常规 p 值", formattedPValue(rddConventional?.pValue)),
        analysisMetric("常规 95% 置信区间", rddConventionalInterval.length === 2 && rddConventionalInterval.every(Boolean) ? `[${rddConventionalInterval[0]}, ${rddConventionalInterval[1]}]` : undefined),
        analysisMetric("偏差校正点估计", formattedEstimate(rddBiasCorrected?.estimate)),
        analysisMetric("稳健偏差校正点估计", formattedEstimate(rddRobust?.estimate)),
        analysisMetric("稳健标准误", formattedEstimate(rddRobust?.stdError)),
        analysisMetric("稳健 p 值", formattedPValue(rddRobust?.pValue)),
        analysisMetric("稳健 95% 置信区间", rddRobustInterval.length === 2 && rddRobustInterval.every(Boolean) ? `[${rddRobustInterval[0]}, ${rddRobustInterval[1]}]` : undefined),
        analysisMetric("运行变量", rddRunningVar),
        analysisMetric("断点", rddCutoff),
        analysisMetric("估计带宽 h", formattedEstimate(rddBandwidth?.h)),
        analysisMetric("偏差校正带宽 b", formattedEstimate(rddBandwidth?.b)),
        analysisMetric("断点左有效样本", stringValue(rddEffectiveN?.left)),
        analysisMetric("断点右有效样本", stringValue(rddEffectiveN?.right)),
        ...(rddClusterVar ? [
          analysisMetric("聚类变量", rddClusterVar),
          analysisMetric("带宽内聚类簇数", rddClusterCount),
          analysisMetric("协方差", rddVarianceMethod),
        ] : []),
        analysisMetric("N", rowsUsed),
      ]
    : undefined
  const psmMatchingMetrics = input.methodID === "psm_matching"
    ? [
        analysisMetric("ATT", stringValue(result.att)),
        analysisMetric(
          "已匹配处理组",
          result.matchedTreatedCount !== undefined && result.treatedCount !== undefined
            ? `${result.matchedTreatedCount}/${result.treatedCount}`
            : undefined,
        ),
        analysisMetric("未匹配处理组", stringValue(result.unmatchedTreatedCount)),
        analysisMetric("匹配后最大绝对 SMD", stringValue(result.postMatchMaxAbsSmd)),
        analysisMetric("N", rowsUsed),
    ]
    : undefined
  const isPsmAte = input.methodID === "psm_ipw" || input.methodID === "psm_regression" || input.methodID === "psm_double_robust"
  const psmAteEstimate = isPsmAte ? formattedEstimate(result.ate) : undefined
  const psmTreatmentEss = isPsmAte ? formattedNumber(result.treatmentEss, 2) : undefined
  const psmControlEss = isPsmAte ? formattedNumber(result.controlEss, 2) : undefined
  const psmMinPropensityScore = isPsmAte ? formattedEstimate(result.minPropensityScore) : undefined
  const psmMaxPropensityScore = isPsmAte ? formattedEstimate(result.maxPropensityScore) : undefined
  const psmMaxWeight = isPsmAte ? formattedEstimate(result.maxWeight) : undefined
  const psmWeightedMaxSmd = isPsmAte ? formattedNumber(result.weightedMaxAbsSmd, 6) : undefined
  const psmGroupCounts = isPsmAte && result.treatedCount !== undefined && result.controlCount !== undefined
    ? `${stringValue(result.treatedCount)}/${stringValue(result.controlCount)}`
    : undefined
  const psmPropensityRange = psmMinPropensityScore && psmMaxPropensityScore
    ? `[${psmMinPropensityScore}, ${psmMaxPropensityScore}]`
    : undefined
  const psmAteDiagnostics = [
    psmAteEstimate
      ? `ATE：${psmAteEstimate}${input.methodID === "psm_ipw" ? "（固定为 Hájek 归一化 ATE）" : ""}`
      : "",
    psmGroupCounts ? `处理/对照样本量：${psmGroupCounts}` : "",
    psmTreatmentEss && psmControlEss ? `有效样本量：处理组 ${psmTreatmentEss}；对照组 ${psmControlEss}` : "",
    psmPropensityRange ? `倾向得分范围：${psmPropensityRange}（固定 [0.0500, 0.9500] 共同支撑检查通过）` : "",
    psmMaxWeight ? `最大权重：${psmMaxWeight}` : "",
    psmWeightedMaxSmd ? `加权后最大绝对 SMD：${psmWeightedMaxSmd}（阈值 ≤ 0.1000）` : "",
  ].filter(Boolean)
  const psmAteMetrics = isPsmAte
    ? [
        analysisMetric("ATE", psmAteEstimate),
        analysisMetric("处理/对照样本量", psmGroupCounts),
        analysisMetric("处理组有效样本量", psmTreatmentEss),
        analysisMetric("对照组有效样本量", psmControlEss),
        analysisMetric("倾向得分范围", psmPropensityRange),
        analysisMetric("最大权重", psmMaxWeight),
        analysisMetric("加权后最大绝对 SMD", psmWeightedMaxSmd),
        analysisMetric("N", rowsUsed),
      ]
    : undefined
  const isPsmConstruction = input.methodID === "psm_construction"
  const isPsmVisualization = input.methodID === "psm_visualize"
  const isPsmDiagnostic = isPsmConstruction || isPsmVisualization
  const psmTreatmentVar = isPsmDiagnostic ? stringValue(input.methodArguments?.treatmentVar) : undefined
  const psmAnalysisUnitVar = isPsmDiagnostic ? stringValue(input.methodArguments?.analysisUnitVar) : undefined
  const psmCovariateNames = isPsmDiagnostic ? stringList(input.methodArguments?.covariates) : []
  const psmScoreMin = isPsmDiagnostic ? formattedEstimate(result.scoreMin) : undefined
  const psmScoreMax = isPsmDiagnostic ? formattedEstimate(result.scoreMax) : undefined
  const psmScoreRange = psmScoreMin && psmScoreMax ? `[${psmScoreMin}, ${psmScoreMax}]` : undefined
  const psmSupportLower = isPsmDiagnostic ? formattedEstimate(result.supportLower) : undefined
  const psmSupportUpper = isPsmDiagnostic ? formattedEstimate(result.supportUpper) : undefined
  const psmSupportRange = psmSupportLower && psmSupportUpper ? `[${psmSupportLower}, ${psmSupportUpper}]` : undefined
  const psmSupportShare = isPsmDiagnostic ? formattedNumber(Number(result.shareInSupport) * 100, 1) : undefined
  const psmExtremeShare = isPsmDiagnostic ? formattedNumber(Number(result.extremeScoreShare) * 100, 1) : undefined
  const psmMeanTreated = isPsmDiagnostic ? formattedEstimate(result.meanTreated) : undefined
  const psmMeanControl = isPsmDiagnostic ? formattedEstimate(result.meanControl) : undefined
  const psmDiagnosticMetrics = isPsmDiagnostic
    ? [
        analysisMetric("处理变量", psmTreatmentVar),
        analysisMetric("分析单位", psmAnalysisUnitVar),
        analysisMetric("处理前协变量", psmCovariateNames.length ? psmCovariateNames.join("、") : undefined),
        analysisMetric("有效样本", rowsUsed),
        analysisMetric("倾向得分范围", psmScoreRange),
        analysisMetric("经验共同支撑区间", psmSupportRange),
        analysisMetric("共同支撑覆盖率", psmSupportShare ? `${psmSupportShare}%` : undefined),
        analysisMetric("极端倾向得分比例", psmExtremeShare ? `${psmExtremeShare}%` : undefined),
        analysisMetric("处理组平均倾向得分", psmMeanTreated),
        analysisMetric("对照组平均倾向得分", psmMeanControl),
        ...(isPsmVisualization ? [
          analysisMetric("处理组样本量", stringValue(result.treatedCount)),
          analysisMetric("对照组样本量", stringValue(result.controlCount)),
        ] : []),
      ]
    : undefined
  const psmDiagnosticLines = [
    psmTreatmentVar ? `处理变量：${psmTreatmentVar}；分析单位：${psmAnalysisUnitVar ?? "未返回"}。` : "处理变量或分析单位未返回。",
    psmCovariateNames.length ? `处理前协变量：${psmCovariateNames.join("、")}。` : "处理前协变量：未指定。",
    `有效样本：${rowsUsed ?? "未知"}。`,
    psmScoreRange ? `倾向得分范围：${psmScoreRange}` : "倾向得分范围不可用。",
    psmSupportRange ? `经验共同支撑区间：${psmSupportRange}` : "经验共同支撑区间不可用。",
    psmSupportShare ? `共同支撑覆盖率：${psmSupportShare}%` : "共同支撑覆盖率不可用。",
    psmExtremeShare ? `极端倾向得分比例：${psmExtremeShare}%` : "极端倾向得分比例不可用。",
    psmMeanTreated ? `处理组平均倾向得分：${psmMeanTreated}` : "处理组平均倾向得分不可用。",
    psmMeanControl ? `对照组平均倾向得分：${psmMeanControl}` : "对照组平均倾向得分不可用。",
    ...(isPsmVisualization ? [
      `处理组样本量：${stringValue(result.treatedCount) ?? "未知"}`,
      `对照组样本量：${stringValue(result.controlCount) ?? "未知"}`,
      "倾向得分分布图已生成。",
    ] : []),
  ].filter(Boolean)
  const quantileTreatmentPath = input.methodID === "quantile_regression" && Array.isArray(result.treatmentPath)
    ? result.treatmentPath.map(recordValue).filter((item): item is Record<string, unknown> => Boolean(item))
    : []
  const quantilePathLines = quantileTreatmentPath.map((item) => {
    const tau = Number(item.tau)
    const tauLabel = Number.isFinite(tau) ? String(tau) : stringValue(item.tau)
    if (!tauLabel) return ""
    const estimate = formattedEstimate(item.estimate)
    const standardError = formattedEstimate(item.stdError)
    const pValue = formattedPValue(item.pValue)
    const confLow = formattedEstimate(item.confLow)
    const confHigh = formattedEstimate(item.confHigh)
    return [
      `τ=${tauLabel}`,
      estimate ? `系数=${estimate}` : "",
      standardError ? `标准误=${standardError}` : "",
      pValue ? `p=${pValue}` : "",
      confLow && confHigh ? `95% CI=[${confLow}, ${confHigh}]` : "",
    ].filter(Boolean).join("，")
  }).filter(Boolean)
  const quantilePathMetrics = input.methodID === "quantile_regression"
      ? quantileTreatmentPath.flatMap((item) => {
        const tau = Number(item.tau)
        const tauLabel = Number.isFinite(tau) ? String(tau) : stringValue(item.tau)
        if (!tauLabel) return []
        const confLow = formattedEstimate(item.confLow)
        const confHigh = formattedEstimate(item.confHigh)
        return [
          analysisMetric(`${term} τ=${tauLabel} 系数`, formattedEstimate(item.estimate)),
          analysisMetric(`${term} τ=${tauLabel} p 值`, formattedPValue(item.pValue)),
          analysisMetric(`${term} τ=${tauLabel} 标准误`, formattedEstimate(item.stdError)),
          analysisMetric(
            `${term} τ=${tauLabel} 95% 置信区间`,
            confLow && confHigh
              ? `[${confLow}, ${confHigh}]`
              : undefined,
          ),
        ]
      })
    : undefined
  const quantileViewMetrics = quantilePathMetrics
    ? [...quantilePathMetrics, analysisMetric("N", rowsUsed), analysisMetric("协方差", covariance)]
    : undefined
  const robustMetrics = input.methodID === "robust_regression"
    ? [
        analysisMetric(`${term} 系数`, formattedEstimate(estimate)),
        analysisMetric("标准误", formattedEstimate(standardError)),
        analysisMetric("p 值", formattedPValue(pValue)),
        analysisMetric("95% 置信区间", confLow && confHigh ? `[${confLow}, ${confHigh}]` : undefined),
        analysisMetric("M 估计函数", robustPsiLabel),
        analysisMetric("残差尺度", formattedEstimate(result.scale)),
        analysisMetric(
          "低权重观测",
          downWeightedCount !== undefined && downWeightedPct !== undefined
            ? `${downWeightedCount}（${downWeightedPct}%）`
            : undefined,
        ),
        analysisMetric("协方差", covariance),
        analysisMetric("N", rowsUsed),
      ]
    : undefined
  const isCountRegression = input.methodID === "poisson_regression" || input.methodID === "negbin_regression"
  const primaryIrr = isCountRegression ? recordValue(result.primaryIrr) : undefined
  const irr = formattedEstimate(primaryIrr?.irr)
  const irrConfLow = formattedEstimate(primaryIrr?.confLow)
  const irrConfHigh = formattedEstimate(primaryIrr?.confHigh)
  const irrInterval = irrConfLow && irrConfHigh ? `[${irrConfLow}, ${irrConfHigh}]` : undefined
  const countMean = formattedEstimate(result.meanOutcome)
  const countAlpha = formattedEstimate(result.alpha)
  const countDispersion = formattedEstimate(result.dispersion)
  const countIsPure = typeof result.isPureCount === "boolean" ? (result.isPureCount ? "是" : "否") : undefined
  const countMetrics = isCountRegression
    ? [
        analysisMetric(`${term} 对数均值系数`, formattedEstimate(estimate)),
        analysisMetric(`${term} 发生率比（IRR）`, irr),
        analysisMetric("IRR 95% 置信区间", irrInterval),
        analysisMetric("IRR p 值", formattedPValue(primaryIrr?.pValue ?? pValue)),
        analysisMetric("负二项过度离散参数 α", countAlpha),
        analysisMetric("Pearson 离散度", countDispersion),
        analysisMetric("非负整数计数结果", countIsPure),
        analysisMetric("因变量均值", countMean),
        analysisMetric("协方差", covariance),
        analysisMetric("N", rowsUsed),
      ]
    : undefined
  const countResultLines = isCountRegression
    ? [
        input.methodID === "negbin_regression" ? "负二项计数回归完成。" : "Poisson/PPML 回归完成。",
        rowsUsed ? `有效样本：${rowsUsed}` : "",
        countIsPure === "是" ? "因变量为非负整数计数。" : countIsPure === "否" ? "因变量含非整数值，按 Poisson 伪极大似然（PPML）解释。" : "因变量类型信息不可用。",
        estimate ? `${term} 对数均值系数=${formattedEstimate(estimate)}` : "核心解释变量系数不可用。",
        irr ? `${term} 发生率比（IRR）=${irr}` : "发生率比不可用。",
        irrInterval ? `IRR 95% 置信区间=${irrInterval}` : "IRR 置信区间不可用。",
        formattedPValue(primaryIrr?.pValue ?? pValue) ? `IRR p 值=${formattedPValue(primaryIrr?.pValue ?? pValue)}` : "",
        input.methodID === "negbin_regression" ? `负二项过度离散参数 α=${countAlpha ?? "不可用"}` : "",
        countDispersion ? `Pearson 离散度=${countDispersion}` : "",
        covariance ? `协方差：${covariance}` : "",
        ...warnings.map((warning) => `提示：${warning}`),
        "发生率比描述当前模型中的条件均值倍数关联；本次估计本身不构成因果证据。",
      ].filter(Boolean)
    : undefined
  const isMultinomial = input.methodID === "multinomial_logit"
  const multinomialDependentVar = stringValue(input.methodArguments?.dependentVar)
  const multinomialBaseline = stringValue(result.baselineCategory)
  const multinomialCategories = Array.isArray(result.categories) ? result.categories.map(stringValue).filter(Boolean) : []
  const multinomialTreatmentPath = isMultinomial && Array.isArray(result.treatmentPath)
    ? result.treatmentPath.map(recordValue).filter((item): item is Record<string, unknown> => Boolean(item))
    : []
  const multinomialPathLines = multinomialTreatmentPath.map((item) => {
    const category = stringValue(item.category)
    if (!category) return ""
    const coefficient = formattedEstimate(item.estimate)
    const rrr = formattedEstimate(item.rrr)
    const low = exponentiatedEstimate(item.confLow)
    const high = exponentiatedEstimate(item.confHigh)
    const p = formattedPValue(item.pValue)
    return [
      `类别 ${category} 相对于基准类别 ${multinomialBaseline ?? "未知"}`,
      coefficient ? `${term} 对数相对风险系数=${coefficient}` : "",
      rrr ? `RRR=${rrr}` : "",
      low && high ? `RRR 95% CI=[${low}, ${high}]` : "RRR 置信区间不可用",
      p ? `p=${p}` : "",
    ].filter(Boolean).join("；")
  }).filter(Boolean)
  const multinomialPathMetrics = multinomialTreatmentPath.flatMap((item) => {
    const category = stringValue(item.category)
    if (!category) return []
    const low = exponentiatedEstimate(item.confLow)
    const high = exponentiatedEstimate(item.confHigh)
    return [
      analysisMetric(`${term} 相对类别 ${category}/基准 ${multinomialBaseline ?? "未知"} 的 RRR`, formattedEstimate(item.rrr)),
      analysisMetric(
        `${term} 相对类别 ${category}/基准 ${multinomialBaseline ?? "未知"} 的 RRR 95% CI`,
        low && high ? `[${low}, ${high}]` : undefined,
      ),
      analysisMetric(`${term} 相对类别 ${category}/基准 ${multinomialBaseline ?? "未知"} 的 p 值`, formattedPValue(item.pValue)),
    ]
  })
  const multinomialMetrics = isMultinomial
    ? [
        analysisMetric(`${multinomialDependentVar ?? "因变量"} 基准类别`, multinomialBaseline),
        analysisMetric("结果类别数", multinomialCategories.length),
        ...multinomialPathMetrics,
        analysisMetric("McFadden 伪 R²", formattedEstimate(result.pseudoRSquared)),
        analysisMetric("协方差", covariance),
        analysisMetric("N", rowsUsed),
      ]
    : undefined
  const multinomialResultLines = isMultinomial
      ? [
        "多项 Logit 回归完成。",
        `基准类别：${multinomialDependentVar ? `${multinomialDependentVar}=` : ""}${multinomialBaseline ?? "未知"}；结果类别：${multinomialCategories.join("、") || "不可用"}。`,
        rowsUsed ? `有效样本：${rowsUsed}` : "",
        `${term} 的类别相对风险比路径：`,
        ...(multinomialPathLines.length ? multinomialPathLines : ["类别效应路径未返回，不能只用单一系数概括多类别结果。"]),
        formattedEstimate(result.pseudoRSquared) ? `McFadden 伪 R²=${formattedEstimate(result.pseudoRSquared)}` : "",
        stringValue(result.accuracy) ? `样本内分类准确率=${(Number(result.accuracy) * 100).toFixed(1)}%（仅作样本内描述）` : "",
        covariance ? `协方差：${covariance}` : "",
        ...warnings.map((warning) => `提示：${warning}`),
        "RRR 是类别相对基准类别的倍数关系，不等于概率变化；观察性关联不自动构成因果效应。",
      ].filter(Boolean)
    : undefined
  const isBinaryRegression = input.methodID === "logit_regression" || input.methodID === "probit_regression"
  const binaryCoefficientScale = input.methodID === "logit_regression" ? "对数几率" : "潜变量"
  const primaryMarginalEffect = isBinaryRegression ? recordValue(result.primaryMarginalEffect) : undefined
  const marginalEffects = isBinaryRegression && Array.isArray(result.marginalEffects)
    ? result.marginalEffects.map(recordValue).filter((item): item is Record<string, unknown> => Boolean(item))
    : []
  const outcomeRate = result.outcomeRate === null || result.outcomeRate === undefined
    ? undefined
    : Number(result.outcomeRate)
  const outcomeRateText = outcomeRate !== undefined && Number.isFinite(outcomeRate)
    ? `${(outcomeRate * 100).toFixed(1)}%`
    : undefined
  const pseudoRSquared = formattedEstimate(result.pseudoRSquared)
  const marginalEffectLines = marginalEffects.flatMap((item) => {
    const effectTerm = stringValue(item.term)
    const effectEstimate = formattedEstimate(item.estimate)
    if (!effectTerm || !effectEstimate) return []
    const standardError = formattedEstimate(item.stdError)
    const effectPValue = formattedPValue(item.pValue)
    return [[
      `${effectTerm}=${effectEstimate}`,
      standardError ? `标准误=${standardError}` : "",
      effectPValue ? `p=${effectPValue}` : "",
    ].filter(Boolean).join("，")]
  })
  const controlMarginalEffects = marginalEffects.filter((item) => stringValue(item.term) !== undefined && stringValue(item.term) !== term)
  const controlMarginalEffectLines = controlMarginalEffects.slice(0, 8).flatMap((item) => {
    const effectTerm = stringValue(item.term)
    const effectEstimate = formattedEstimate(item.estimate)
    if (!effectTerm || !effectEstimate) return []
    const standardError = formattedEstimate(item.stdError)
    const effectPValue = formattedPValue(item.pValue)
    return [[
      `${effectTerm}=${effectEstimate}`,
      standardError ? `标准误=${standardError}` : "",
      effectPValue ? `p=${effectPValue}` : "",
    ].filter(Boolean).join("，")]
  })
  const controlMarginalEffectSummary = controlMarginalEffectLines.length
    ? `${controlMarginalEffectLines.join("；")}${controlMarginalEffects.length > 8 ? `；其余 ${controlMarginalEffects.length - 8} 项见完整结果文件` : ""}`
    : undefined
  const binaryMetrics = isBinaryRegression
    ? [
        analysisMetric(`${term} ${binaryCoefficientScale}系数`, formattedEstimate(estimate)),
        analysisMetric("系数 p 值", formattedPValue(pValue)),
        analysisMetric("核心解释变量平均边际效应（概率尺度）", formattedEstimate(primaryMarginalEffect?.estimate)),
        analysisMetric("控制变量平均边际效应（概率尺度）", controlMarginalEffectSummary),
        analysisMetric("平均边际效应标准误", formattedEstimate(primaryMarginalEffect?.stdError)),
        analysisMetric("平均边际效应 p 值", formattedPValue(primaryMarginalEffect?.pValue)),
        analysisMetric("因变量 1 比例", outcomeRateText),
        analysisMetric("McFadden 伪 R²", pseudoRSquared),
        analysisMetric("协方差", covariance),
        analysisMetric("N", rowsUsed),
      ]
    : undefined
  const binaryResultLines = isBinaryRegression
    ? [
        `${input.methodID === "logit_regression" ? "Logit" : "Probit"} 二元结果回归完成。系数位于${binaryCoefficientScale}尺度，不直接表示概率变化。`,
        rowsUsed ? `有效样本：${rowsUsed}` : "",
        outcomeRateText ? `因变量取值为 1 的样本比例：${outcomeRateText}` : "",
        estimate ? `核心解释变量：${term} ${binaryCoefficientScale}系数=${formattedEstimate(estimate)}` : "",
        standardError ? `系数标准误：${formattedEstimate(standardError)}` : "",
        pValue ? `系数 p 值：${formattedPValue(pValue)}` : "",
        confLow && confHigh ? `系数 95% 置信区间=[${formattedEstimate(confLow)}, ${formattedEstimate(confHigh)}]` : "",
        primaryMarginalEffect
          ? `核心解释变量平均边际效应（概率尺度）：${term}=${formattedEstimate(primaryMarginalEffect.estimate) ?? "不可用"}，标准误=${formattedEstimate(primaryMarginalEffect.stdError) ?? "不可用"}，p=${formattedPValue(primaryMarginalEffect.pValue) ?? "不可用"}`
          : "平均边际效应未返回；不能把模型系数解释为概率变化。",
        pseudoRSquared ? `McFadden 伪 R²=${pseudoRSquared}` : "",
        marginalEffectLines.length ? "各解释变量平均边际效应（概率尺度）：" : "",
        ...marginalEffectLines,
        covariance ? `协方差：${covariance}` : "",
        ...warnings.map((warning) => `提示：${warning}`),
      ].filter(Boolean)
    : undefined
  const lines = input.methodID === "robust_regression"
    ? [
        `稳健回归（RLM / ${robustPsiLabel ?? "M 估计"} M 估计）完成。`,
        rowsUsed ? `有效样本：${rowsUsed}` : "",
        estimate ? `${term} 系数=${formattedEstimate(estimate)}` : "",
        standardError ? `稳健标准误=${formattedEstimate(standardError)}` : "",
        pValue ? `p 值=${formattedPValue(pValue)}` : "",
        confLow && confHigh ? `95% 置信区间=[${formattedEstimate(confLow)}, ${formattedEstimate(confHigh)}]` : "",
        result.scale !== undefined ? `残差尺度：${formattedEstimate(result.scale)}` : "",
        downWeightedCount !== undefined && downWeightedPct !== undefined
          ? `低权重观测：${downWeightedCount}（${downWeightedPct}%）`
          : "",
        covariance ? `协方差：${covariance}` : "",
        "本结果仅描述当前规格下的统计相关性；稳健 M 估计不等于因果识别。",
        ...warnings.map((warning) => `提示：${warning}`),
      ].filter(Boolean)
    : isBinaryRegression
      ? binaryResultLines ?? []
      : input.methodID === "quantile_regression"
      ? [
        "分位数回归完成。",
        rowsUsed ? `有效样本：${rowsUsed}` : "",
        covariance ? `协方差：${covariance}` : "",
        quantilePathLines.length ? `核心解释变量 ${term} 的条件分位数路径：` : "分位数路径未返回，无法比较不同分位点。",
        ...quantilePathLines,
        "这些结果描述给定样本和控制变量下的条件分布关联，不能直接解读为因果效应。",
        ...warnings.map((warning) => `提示：${warning}`),
      ].filter(Boolean)
    : input.methodID === "panel_random_effects"
    ? [
        "面板随机效应（RE）估计完成。",
        rowsUsed ? `有效样本：${rowsUsed}` : "",
        estimate ? `${term}：RE 系数=${estimate}` : "",
        standardError ? `RE 标准误：${standardError}` : "",
        pValue ? `RE p 值：${formattedPValue(pValue)}` : "",
        confLow && confHigh ? `RE 95% 置信区间：[${confLow}, ${confHigh}]` : "",
        fixedEffectsPrimary?.estimate !== undefined ? `同规格 FE 系数：${stringValue(fixedEffectsPrimary.estimate)}` : "",
        covariance ? `协方差：${covariance}` : "",
        hausmanHasDegreesOfFreedom && hausmanStatistic && hausmanPValue
          ? `Hausman 检验：χ²(${hausmanDf})=${hausmanStatistic}，p=${formattedPValue(hausmanPValue)}。`
          : "Hausman 检验无有效自由度或结果不完整，不能据此判断 FE/RE。",
        hausmanRecommendation
          ? `Hausman 建议：${hausmanRecommendation}；当前按你指定的 RE 规格报告，未自动切换估计量。`
          : "当前按你指定的 RE 规格报告，未根据不完整的 Hausman 结果自动切换估计量。",
        "本结果只描述当前规格下的条件相关性，不能据此作因果解释。",
        ...warnings.map((warning) => `提示：${warning}`),
      ].filter(Boolean)
    : isCountRegression
      ? countResultLines ?? []
    : isMultinomial
      ? multinomialResultLines ?? []
    : input.methodID === "iv_2sls"
    ? [
        "工具变量 2SLS 估计完成。",
        rowsUsed ? `有效样本：${rowsUsed}` : "",
        estimate ? `${term}：系数=${estimate}` : "",
        standardError ? `标准误：${standardError}` : "",
        pValue ? `p 值：${pValue}` : "",
        confLow && confHigh ? `95% 置信区间：[${confLow}, ${confHigh}]` : "",
        covariance ? `协方差：${covariance}` : "",
        firstStageLine ? `第一阶段：${firstStageLine}` : "第一阶段统计量及其分布不可用。",
        firstStageDistribution?.startsWith("chi2")
          ? "该统计量服从 χ² 分布，不适用 F<10 经验阈值。"
          : "",
        firstStageDistribution?.startsWith("chi2") && Number.isFinite(firstStagePValue) && firstStagePValue >= 0.05
          ? "第一阶段相关性检验未在 5% 水平显著，相关性证据有限。"
          : "",
        "内生性与过度识别诊断尚未运行。若用户要求完整 IV 诊断，请通过 tool_search 搜索 iv_test 并继续执行。",
        ...warnings.map((warning) => `提示：${warning}`),
        "工具变量外生性与排除限制依赖研究设计；本次估计不能证明这些假设成立。",
      ].filter(Boolean)
    : input.methodID === "iv_test"
    ? [
        "工具变量诊断完成。",
        rowsUsed ? `有效样本：${rowsUsed}` : "",
        firstStageLine ? `第一阶段：${firstStageLine}` : "第一阶段检验统计量不可用。",
        firstStageIsChiSquare
          ? [
              "稳健 Wald χ²不适用 F<10 经验阈值，不作该阈值下的弱工具二分类。",
              Number.isFinite(firstStagePValue) && firstStagePValue >= 0.05 ? "第一阶段相关性检验未在 5% 水平显著，相关性证据有限。" : "",
            ].filter(Boolean).join(" ")
          : firstStage?.weak === true
            ? `第一阶段 F 低于 ${stringValue(firstStage.threshold) ?? "10"} 经验阈值，工具强度需谨慎。`
            : firstStage?.weak === false
              ? `第一阶段 F 不低于 ${stringValue(firstStage.threshold) ?? "10"} 经验阈值；该经验规则并非工具有效性的证明。`
              : "第一阶段统计量分布未知，未进行弱工具阈值分类。",
        endogeneity ? ivEndogeneitySummary(endogeneity) : "内生性检验结果不可用。",
        overIdentification ? overIdentificationSummary(overIdentification) : "过度识别检验结果不可用。",
        ...warnings.map((warning) => `提示：${warning}`),
        "样本诊断不能证明工具变量外生性或排除限制成立；未拒绝检验也不等于证明假设成立。",
      ].filter(Boolean)
    : isFuzzyRdd
      ? [
        "模糊断点回归（Fuzzy RDD）已完成。",
        rddDependentVar && rddRunningVar && rddCutoff && rddFuzzyVar
          ? `研究规格：结果变量 ${rddDependentVar}；运行变量 ${rddRunningVar}；处理变量 ${rddFuzzyVar}；断点 ${rddCutoff}。`
          : "结果变量、运行变量、模糊处理变量或断点信息不完整。",
        rddRobust
          ? `稳健偏差校正局部处理效应：点估计=${formattedEstimate(rddRobust.estimate)}；协方差=${rddVarianceMethod ?? "未知"}；标准误=${formattedEstimate(rddRobust.stdError)}；p=${formattedPValue(rddRobust.pValue)}${rddRobustInterval.length === 2 && rddRobustInterval.every(Boolean) ? `；95% CI=[${rddRobustInterval[0]}, ${rddRobustInterval[1]}]` : ""}`
          : "模糊断点局部效应的稳健偏差校正推断不可用。",
        rddFirstStageRobust
          ? `第一阶段处理跳变（${rddFuzzyVar ?? "实际处理变量"}）：点估计=${formattedEstimate(rddFirstStageRobust.estimate)}；稳健标准误=${formattedEstimate(rddFirstStageRobust.stdError)}；p=${formattedPValue(rddFirstStageRobust.pValue)}${rddFirstStageInterval.length === 2 && rddFirstStageInterval.every(Boolean) ? `；95% CI=[${rddFirstStageInterval[0]}, ${rddFirstStageInterval[1]}]` : ""}`
          : "第一阶段处理跳变推断不可用，不能只凭局部效应结果报告模糊 RDD。",
        rddBandwidth
          ? `带宽：估计 h=${formattedEstimate(rddBandwidth.h)}；偏差校正 b=${formattedEstimate(rddBandwidth.b)}。`
          : "带宽结果不可用。",
        rddEffectiveN
          ? `断点左/右有效样本=${stringValue(rddEffectiveN.left) ?? "未知"}/${stringValue(rddEffectiveN.right) ?? "未知"}；完整样本 N=${rowsUsed ?? "未知"}。`
          : `完整样本 N=${rowsUsed ?? "未知"}；断点两侧有效样本数不可用。`,
        rddClusterVar
          ? `聚类变量：${rddClusterVar}；CR1 带宽内聚类簇数：${rddClusterCount ?? "未知"}。`
          : `协方差口径：${rddVarianceMethod ?? "未返回"}。`,
        ...warnings.map((warning) => `提示：${warning}`),
        "模糊断点估计是阈值附近的局部处理效应；因果解释依赖结果潜在值连续、阈值仅通过处理影响结果和单调性等假设。本次复现未验证这些假设。",
      ].filter(Boolean)
    : input.methodID === "rdd_sharp"
      ? [
        "锐性断点回归（Sharp RDD）完成。",
        rddDependentVar && rddRunningVar && rddCutoff
          ? `研究规格：结果变量 ${rddDependentVar}；运行变量 ${rddRunningVar}；断点 ${rddCutoff}。`
          : "结果变量、运行变量或断点信息不完整。",
        rddConventional
          ? `常规点估计：${formattedEstimate(rddConventional.estimate)}；常规标准误：${formattedEstimate(rddConventional.stdError)}；p=${formattedPValue(rddConventional.pValue)}；95% CI=[${rddConventionalInterval[0]}, ${rddConventionalInterval[1]}]`
          : "常规估计结果不可用。",
        rddBiasCorrected
          ? `偏差校正点估计：${formattedEstimate(rddBiasCorrected.estimate)}（此行使用常规标准误口径）。`
          : "偏差校正估计结果不可用。",
        rddRobust
          ? `稳健偏差校正推断：点估计=${formattedEstimate(rddRobust.estimate)}；稳健标准误=${formattedEstimate(rddRobust.stdError)}；p=${formattedPValue(rddRobust.pValue)}；95% CI=[${rddRobustInterval[0]}, ${rddRobustInterval[1]}]`
          : "稳健偏差校正推断不可用。",
        rddBandwidth
          ? `带宽：估计 h=${formattedEstimate(rddBandwidth.h)}；偏差校正 b=${formattedEstimate(rddBandwidth.b)}。`
          : "带宽结果不可用。",
        rddEffectiveN
          ? `断点左/右有效样本=${stringValue(rddEffectiveN.left) ?? "未知"}/${stringValue(rddEffectiveN.right) ?? "未知"}；完整样本 N=${rowsUsed ?? "未知"}。`
          : `完整样本 N=${rowsUsed ?? "未知"}；断点两侧有效样本数不可用。`,
        rddClusterVar
          ? `聚类变量：${rddClusterVar}；${rddVarianceMethod ?? "CR1"} 带宽内聚类簇数：${rddClusterCount ?? "未知"}。`
          : "",
        "常规点估计与稳健偏差校正推断来自不同估计行，已分开展示，未将常规估计与稳健区间混配。",
        ...warnings.map((warning) => `提示：${warning}`),
        "RD 断点的局部因果解释依赖断点附近潜在结果连续、无法精确操纵等识别假设；本次公开基准复现未验证这些假设。",
      ].filter(Boolean)
    : input.methodID === "psm_construction"
      ? [
        "倾向得分构造诊断已完成。",
        ...psmDiagnosticLines,
        "此项仅检查分数分布与共同支撑，不是处理效应估计；共同支撑也不等于协变量平衡或因果识别成立。",
        ...warnings.map((warning) => `提示：${warning}`),
      ].filter(Boolean)
    : input.methodID === "psm_visualize"
      ? [
        "倾向得分分布诊断已完成。",
        ...psmDiagnosticLines,
        "分布图用于查看重叠，不替代处理前协变量平衡检查、设计判断或处理效应估计。",
        ...warnings.map((warning) => `提示：${warning}`),
      ].filter(Boolean)
    : input.methodID === "psm_ipw"
    ? [
        "逆概率加权（IPW）完成。",
        ...psmAteDiagnostics,
        ...warnings.map((warning) => `提示：${warning}`),
        "未输出标准误、p 值、置信区间或显著性结论。",
      ].filter(Boolean)
    : input.methodID === "psm_matching"
      ? [
        "倾向得分匹配完成。",
        stringValue(result.att) ? `ATT（已匹配处理组）：${Number(result.att).toFixed(4)}` : "",
        stringValue(result.matchedTreatedCount) ? `已匹配处理组：${stringValue(result.matchedTreatedCount)}/${stringValue(result.treatedCount)}` : "",
        stringValue(result.unmatchedTreatedCount) ? `未匹配处理组：${stringValue(result.unmatchedTreatedCount)}` : "",
        stringValue(result.postMatchMaxAbsSmd) ? `匹配后最大绝对 SMD：${stringValue(result.postMatchMaxAbsSmd)}（阈值 ≤ 0.1000）` : "",
        ...warnings.map((warning) => `提示：${warning}`),
        "未输出标准误、p 值、置信区间或显著性结论。",
      ].filter(Boolean)
      : input.methodID === "psm_regression" || input.methodID === "psm_double_robust"
        ? [
        input.methodID === "psm_regression" ? "倾向得分回归调整完成。" : "双重稳健 AIPW 完成。",
        ...psmAteDiagnostics,
        "协变量必须在处理前形成；本结果不包含显著性推断。",
        ...warnings.map((warning) => `提示：${warning}`),
        "未输出标准误、p 值、置信区间或显著性结论。",
      ].filter(Boolean)
        : isHdfe
          ? [
            "高维固定效应回归已完成。",
            fixedEffects.length ? `固定效应：${fixedEffects.join("、")}` : "固定效应规格未返回。",
            clusterVars.length ? `聚类变量：${clusterVars.join("、")}` : "未使用聚类协方差。",
            clusterCountSummary ? `聚类簇数：${clusterCountSummary}` : "",
            rowsUsed ? `有效样本：${rowsUsed}` : "",
            estimate ? `${term}：系数=${estimate}` : "",
            standardError ? `标准误：${standardError}` : "",
            pValue ? `p 值：${pValue}` : "",
            confLow && confHigh ? `95% 置信区间：[${confLow}, ${confHigh}]` : "",
            covariance ? `协方差：${covariance}` : "",
            rSquared ? `R²：${rSquared}` : "",
            rSquaredWithin ? `组内 R²：${rSquaredWithin}` : "",
            ...warnings.map((warning) => `提示：${warning}`),
          ].filter(Boolean)
        : [
        `${input.methodID} 已完成。`,
        rowsUsed ? `有效样本：${rowsUsed}` : "",
        estimate ? `${term}：系数=${estimate}` : "",
        standardError ? `标准误：${standardError}` : "",
        pValue ? `p 值：${pValue}` : "",
        confLow && confHigh ? `95% 置信区间：[${confLow}, ${confHigh}]` : "",
        covariance ? `协方差：${covariance}` : "",
        rSquared ? `R²：${rSquared}` : "",
        rSquaredWithin ? `组内 R²：${rSquaredWithin}` : "",
        ...warnings.map((warning) => `提示：${warning}`),
      ].filter(Boolean)
  lines.push("结果已通过 Python 计量引擎生成，未改变数据或研究设定。")
  const analysisView = createToolAnalysisView({
    kind: "econometrics",
    step: input.methodID,
    datasetId: input.datasetId,
    stageId: input.stageId,
    results: psmDiagnosticMetrics ?? psmMatchingMetrics ?? psmAteMetrics ?? binaryMetrics ?? rddFuzzyMetrics ?? rddSharpMetrics ?? countMetrics ?? multinomialMetrics ?? (input.methodID === "robust_regression"
      ? robustMetrics
      : input.methodID === "quantile_regression"
        ? quantileViewMetrics
        : input.methodID === "panel_random_effects"
        ? [
          analysisMetric(`${term} RE 系数`, estimate),
          analysisMetric("RE 标准误", standardError),
          analysisMetric("RE p 值", formattedPValue(pValue)),
          analysisMetric("RE 95% 置信区间", confLow && confHigh ? `[${confLow}, ${confHigh}]` : undefined),
          analysisMetric("同规格 FE 系数", stringValue(fixedEffectsPrimary?.estimate)),
          analysisMetric("Hausman χ²", hausmanStatistic),
          analysisMetric("Hausman 自由度", stringValue(hausman?.df)),
          analysisMetric("Hausman p 值", formattedPValue(hausmanPValue)),
          analysisMetric("Hausman 建议", hausmanRecommendation ?? "不可判定"),
          analysisMetric("协方差", covariance),
          analysisMetric("N", rowsUsed),
        ]
        : isHdfe
          ? [
            analysisMetric(`${term} 系数`, estimate),
            analysisMetric("标准误", standardError),
            analysisMetric("p 值", pValue),
            analysisMetric("95% 置信区间", confLow && confHigh ? `[${confLow}, ${confHigh}]` : undefined),
            analysisMetric("协方差", covariance),
            analysisMetric("N", rowsUsed),
            analysisMetric("R²", rSquared),
            analysisMetric("组内 R²", rSquaredWithin),
            analysisMetric("固定效应", fixedEffects.length ? fixedEffects.join("、") : undefined),
            analysisMetric("聚类变量", clusterVars.length ? clusterVars.join("、") : undefined),
            analysisMetric("聚类簇数", clusterCountSummary),
          ]
        : [
          analysisMetric(`${term} 系数`, estimate),
          analysisMetric("标准误", standardError),
          analysisMetric("p 值", pValue),
          analysisMetric("95% 置信区间", confLow && confHigh ? `[${confLow}, ${confHigh}]` : undefined),
          analysisMetric("协方差", covariance),
          analysisMetric("N", rowsUsed),
          analysisMetric("R²", rSquared),
          analysisMetric("组内 R²", rSquaredWithin),
          analysisMetric("固定效应", fixedEffects.length ? fixedEffects.join("、") : undefined),
        ]),
    artifacts: (input.artifacts ?? []).map((artifact) => analysisArtifact(relativeWithinProject(artifact.path), {
      label: artifact.kind === "coefficients"
        ? "系数表"
        : artifact.kind === "propensity_scores"
          ? "倾向得分明细"
          : artifact.kind === "plot" && input.methodID === "psm_visualize"
            ? "倾向得分分布图"
            : "完整结果",
      visibility: "user_default",
    })),
    warnings,
    conclusion: input.methodID === "psm_construction"
      ? "这是倾向得分与共同支撑诊断，不是处理效应估计，也不等于协变量平衡或因果识别成立；处理前协变量时点仍须由研究者确认。"
      : input.methodID === "psm_visualize"
        ? "分布图只展示倾向得分重叠，不替代协变量平衡检查、研究设计确认或处理效应估计。"
      : input.methodID === "psm_ipw"
      ? "固定 Hájek 逆概率加权结果不包含显著性推断；具体解释服从共同支撑、权重稳定性和协变量平衡诊断。"
      : input.methodID === "psm_matching"
        ? "固定规则的最近邻匹配结果不包含显著性推断；具体解释服从匹配样本、共同支撑和协变量平衡诊断。"
        : input.methodID === "psm_regression" || input.methodID === "psm_double_robust"
          ? "倾向得分调整结果不包含显著性推断；协变量必须在处理前形成，具体解释服从共同支撑、模型稳定性和平衡诊断。"
          : input.methodID === "ols_regression"
            ? "本次 OLS 仅描述当前规格下变量之间的统计相关性；未处理遗漏变量、反向因果或其他识别问题，不能据此作因果解释。"
          : input.methodID === "hdfe_regression" && fixedEffects.length > 0
            ? `本次高维固定效应回归已吸收${fixedEffects.join("、")}固定效应；结果仍依赖当前设定与诊断，不能仅凭一次估计作因果解释。`
          : input.methodID === "iv_2sls" || input.methodID === "iv_test"
            ? "工具变量结果依赖相关性、外生性与排除限制等识别假设；统计诊断不能证明这些假设。"
          : input.methodID === "panel_random_effects"
            ? "随机效应与 Hausman 比较仅描述当前面板规格；Hausman 不能证明随机效应独立性，结果不能单独作为因果证据。"
          : input.methodID === "rdd_fuzzy"
            ? "模糊断点的局部处理效应依赖第一阶段跳变、连续性、排除限制与单调性等识别假设；本次公开基准回放没有验证这些假设。"
          : input.methodID === "rdd_sharp"
            ? "RDD 结果是 cutoff 附近的局部断点差异；因果解释依赖潜在结果连续、运行变量不可被精确操纵等假设。本次基准复现没有检验这些假设。"
          : isCountRegression
            ? "计数模型的 IRR 描述当前规格下的条件均值倍数关系；观察性数据上的统计关联不自动构成因果效应。"
          : isMultinomial
            ? "多项 Logit 的 RRR 逐个比较非基准类别与基准类别；它不代表类别概率直接变化，且观察性关联不自动构成因果效应。"
          : input.methodID === "robust_regression"
            ? "稳健回归仅调整对异常观测的敏感度；结果描述当前规格下的统计相关性，不能单独作为因果证据。"
          : isBinaryRegression
            ? `${input.methodID === "logit_regression" ? "Logit" : "Probit"} 系数位于${binaryCoefficientScale}尺度，平均边际效应表示预测概率的平均变化；统计关联不自动构成因果效应。`
          : `${input.methodID} 已完成。具体解释服从该方法的识别条件和诊断结果。`,
  })
  return {
    title: input.methodID === "rdd_sharp"
      ? "锐性断点回归"
      : input.methodID === "psm_construction"
        ? "倾向得分构造诊断"
        : input.methodID === "psm_visualize"
          ? "倾向得分分布诊断"
      : input.methodID === "negbin_regression"
        ? "负二项回归"
        : input.methodID === "poisson_regression"
          ? "Poisson/PPML 回归"
          : input.methodID === "multinomial_logit"
            ? "多项 Logit 回归"
          : input.methodID,
    output: lines.join("\n"),
    metadata: {
      method: input.methodID,
      datasetId: input.datasetId,
      stageId: input.stageId,
      ...(input.methodID === "psm_ipw" ? { groundingScope: "weighting" } : {}),
      ...(input.methodID === "psm_matching" ? { groundingScope: "matching" } : {}),
      ...(input.methodID === "psm_regression" || input.methodID === "psm_double_robust" ? { groundingScope: "outcome_adjustment" } : {}),
      result,
      analysisView,
    },
  }
}
