export type DataStructureKind = "cross_section" | "time_series" | "panel" | "repeated_cross_section" | "unknown"

export type CovarianceStrategy = "nonrobust" | "robust" | "cluster" | "hac"

export type VariableValueType = "continuous" | "binary" | "count" | "unknown"

export type SmartColumnProfile = {
  name: string
  dtypeFamily: "numeric" | "datetime" | "categorical" | "boolean" | "unknown"
  nonNullCount: number
  uniqueCount: number
  binary: boolean
  numeric: boolean
  datetime: boolean
  integerLike: boolean
  nonnegative: boolean
}

export type SmartDatasetProfile = {
  rowCount: number
  columnCount: number
  columns: SmartColumnProfile[]
  explicitEntityVar?: string
  explicitTimeVar?: string
  explicitTreatmentVar?: string
  explicitDependentVar?: string
  candidateEntityVars: string[]
  candidateTimeVars: string[]
  candidateTreatmentVars: string[]
  candidateInstrumentVars: string[]
  entityCount?: number
  timeCount?: number
  duplicatePanelKeys?: number
  avgPeriodsPerEntity?: number
  balancedRatio?: number
  dataStructure: DataStructureKind
  dependentVarType: VariableValueType
  treatmentVarType: VariableValueType
}

export type SmartRecommendation = {
  dataStructure: DataStructureKind
  recommendedMethod:
    | "ols_regression"
    | "panel_fe_regression"
    | "did_static"
    | "iv_2sls"
    | "psm_double_robust"
  covariance: CovarianceStrategy
  preferredEntityVar?: string
  preferredTimeVar?: string
  preferredTreatmentVar?: string
  preferredClusterVar?: string
  confidence: "high" | "medium" | "low"
  reasons: string[]
  warnings: string[]
  nextBestMethods: string[]
  postEstimationRules: string[]
}

const ENTITY_HINT = /(entity|firm|company|province|city|county|region|district|state|id|地区|省份|省|市|区县|企业|公司|编号|代码)$/i
const TIME_HINT = /(^t$|time|year|date|month|quarter|period|week|day|年份|年|季度|月|日期|时期)/i
const TREATMENT_HINT = /(did|treat|treated|policy|post|shock|intervention|试点|政策|处理|冲击)/i
const INSTRUMENT_HINT = /(^(iv|z)$|instrument|工具变量)/i

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function normalizeName(value: string) {
  return value.trim().toLowerCase()
}

function getColumn(columns: SmartColumnProfile[], name?: string) {
  if (!name) return
  const normalized = normalizeName(name)
  return columns.find((column) => normalizeName(column.name) === normalized)
}

function classifyValueType(column?: SmartColumnProfile): VariableValueType {
  if (!column) return "unknown"
  if (column.binary) return "binary"
  if (column.numeric && column.integerLike && column.nonnegative) return "count"
  if (column.numeric) return "continuous"
  return "unknown"
}

export function buildSmartDatasetProfile(input: {
  rowCount: number
  columns: SmartColumnProfile[]
  entityVar?: string
  timeVar?: string
  treatmentVar?: string
  dependentVar?: string
  entityCount?: number
  timeCount?: number
  duplicatePanelKeys?: number
  avgPeriodsPerEntity?: number
  balancedRatio?: number
}): SmartDatasetProfile {
  const candidateEntityVars = uniq(
    input.columns.filter((column) => ENTITY_HINT.test(column.name) && column.uniqueCount > 1).map((column) => column.name),
  )
  const candidateTimeVars = uniq(
    input.columns
      .filter((column) => column.datetime || TIME_HINT.test(column.name))
      .filter((column) => column.uniqueCount > 1)
      .map((column) => column.name),
  )
  const candidateTreatmentVars = uniq(
    input.columns.filter((column) => TREATMENT_HINT.test(column.name) || column.name === input.treatmentVar).map((column) => column.name),
  )
  const candidateInstrumentVars = uniq(
    input.columns.filter((column) => INSTRUMENT_HINT.test(column.name)).map((column) => column.name),
  )

  const entityVar = input.entityVar ?? candidateEntityVars[0]
  const timeVar = input.timeVar ?? candidateTimeVars[0]

  let dataStructure: DataStructureKind = "unknown"
  if (entityVar && timeVar && (input.avgPeriodsPerEntity ?? 0) > 1.1 && (input.entityCount ?? 0) > 1 && (input.timeCount ?? 0) > 1) {
    dataStructure = "panel"
  } else if (timeVar) {
    const timeCol = getColumn(input.columns, timeVar)
    const uniqueTime = timeCol?.uniqueCount ?? input.timeCount ?? 0
    if (uniqueTime > 1 && input.rowCount <= uniqueTime * 1.2) dataStructure = "time_series"
    else if (uniqueTime > 1 && input.rowCount > uniqueTime * 1.2) dataStructure = "repeated_cross_section"
  } else if (input.rowCount > 0) {
    dataStructure = "cross_section"
  }

  const dependentVarType = classifyValueType(getColumn(input.columns, input.dependentVar))
  const treatmentVarType = classifyValueType(getColumn(input.columns, input.treatmentVar ?? candidateTreatmentVars[0]))

  return {
    rowCount: input.rowCount,
    columnCount: input.columns.length,
    columns: input.columns,
    explicitEntityVar: input.entityVar,
    explicitTimeVar: input.timeVar,
    explicitTreatmentVar: input.treatmentVar,
    explicitDependentVar: input.dependentVar,
    candidateEntityVars,
    candidateTimeVars,
    candidateTreatmentVars,
    candidateInstrumentVars,
    entityCount: input.entityCount,
    timeCount: input.timeCount,
    duplicatePanelKeys: input.duplicatePanelKeys,
    avgPeriodsPerEntity: input.avgPeriodsPerEntity,
    balancedRatio: input.balancedRatio,
    dataStructure,
    dependentVarType,
    treatmentVarType,
  }
}

export function recommendEconometricsPlan(profile: SmartDatasetProfile): SmartRecommendation {
  const reasons: string[] = []
  const warnings: string[] = []
  const nextBestMethods: string[] = []
  const postEstimationRules: string[] = []

  const preferredEntityVar = profile.explicitEntityVar ?? profile.candidateEntityVars[0]
  const preferredTimeVar = profile.explicitTimeVar ?? profile.candidateTimeVars[0]
  const preferredTreatmentVar = profile.explicitTreatmentVar ?? profile.candidateTreatmentVars[0]

  let recommendedMethod: SmartRecommendation["recommendedMethod"] = "ols_regression"
  let covariance: CovarianceStrategy = "robust"
  let confidence: SmartRecommendation["confidence"] = "medium"
  let preferredClusterVar: string | undefined

  if (profile.dataStructure === "panel") {
    recommendedMethod = "panel_fe_regression"
    preferredClusterVar = preferredEntityVar
    covariance = "cluster"
    confidence = preferredEntityVar && preferredTimeVar ? "high" : "medium"
    reasons.push("Detected repeated observations across entity and time dimensions, so a panel baseline is appropriate.")
    nextBestMethods.push("did_static", "iv_2sls", "ols_regression")

    if (preferredTreatmentVar && /did/i.test(preferredTreatmentVar)) {
      reasons.push("The treatment variable name looks like a DID indicator, so DID-family models are plausible robustness extensions.")
      nextBestMethods.unshift("did_static")
    }

    if ((profile.entityCount ?? 0) < 10) {
      covariance = "robust"
      warnings.push(`Only ${profile.entityCount ?? 0} clusters were detected; clustered standard errors may be unstable.`)
      reasons.push("Because the cluster count is very low, robust standard errors are safer as the default baseline.")
    } else if ((profile.entityCount ?? 0) < 30) {
      warnings.push(`Cluster count is modest (${profile.entityCount}); report clustered SE with caution and compare against robust SE.`)
    }

    if ((profile.duplicatePanelKeys ?? 0) > 0) {
      warnings.push(`Detected ${profile.duplicatePanelKeys} duplicate entity-time keys; aggregate or repair them before trusting FE estimates.`)
      confidence = "low"
    }
  } else if (profile.dataStructure === "time_series") {
    recommendedMethod = "ols_regression"
    covariance = "hac"
    confidence = "medium"
    reasons.push("Detected a single time dimension without a stable panel entity, so a time-series baseline is more appropriate than panel FE.")
    nextBestMethods.push("ols_regression")
    warnings.push("The current built-in baseline tool is OLS-oriented; for time series you should consider trend terms, lags, and HAC inference.")
  } else if (profile.dataStructure === "repeated_cross_section") {
    recommendedMethod = "ols_regression"
    covariance = "robust"
    confidence = "medium"
    reasons.push("Detected repeated observations over time without a stable entity identifier, which fits repeated cross-section OLS as a baseline.")
    nextBestMethods.push("psm_double_robust", "ols_regression")
  } else {
    recommendedMethod = "ols_regression"
    covariance = "robust"
    confidence = "medium"
    reasons.push("No reliable panel structure was detected, so cross-sectional OLS is the safest baseline family.")
    nextBestMethods.push("psm_double_robust", "iv_2sls")
  }

  if (profile.candidateInstrumentVars.length > 0) {
    warnings.push(`Instrument-like variables detected: ${profile.candidateInstrumentVars.join(", ")}.`)
    nextBestMethods.unshift("iv_2sls")
    if (profile.dataStructure !== "panel") {
      recommendedMethod = "iv_2sls"
      reasons.push("Instrument-like variable names were detected, so IV/2SLS should be considered for the primary specification.")
    }
  }

  if (profile.rowCount < 100) {
    warnings.push(`Sample size is small (${profile.rowCount}); inference may be unstable.`)
    confidence = "low"
  }

  if (profile.rowCount < 250 && profile.columnCount > 25) {
    warnings.push("The sample is not large relative to the number of variables; keep the baseline specification parsimonious.")
  }

  if (profile.dependentVarType === "binary") {
    warnings.push("The dependent variable looks binary. OLS can still be used as a linear probability baseline, but interpretation should be explicit.")
  }

  postEstimationRules.push(
    "If heteroskedasticity tests fail, switch nonrobust inference to robust standard errors.",
    "If clustered SE are requested but the cluster count is too low, keep the warning and add a robust-SE comparison.",
    "If panel keys are incomplete or duplicate entity-time rows remain unresolved, downgrade FE to pooled OLS and report the downgrade clearly.",
    "If multicollinearity is severe, reduce overlapping controls before adding more robustness layers.",
  )

  return {
    dataStructure: profile.dataStructure,
    recommendedMethod,
    covariance,
    preferredEntityVar,
    preferredTimeVar,
    preferredTreatmentVar,
    preferredClusterVar,
    confidence,
    reasons,
    warnings,
    nextBestMethods: uniq(nextBestMethods),
    postEstimationRules,
  }
}
