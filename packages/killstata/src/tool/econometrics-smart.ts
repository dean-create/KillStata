/**
 * 旧类型兼容层。
 *
 * 数据画像和方法推荐已经迁移到 Python Registry 的
 * `econometrics_recommend` handler；TypeScript 只保留展示层需要的形状，
 * 不再在此文件实现变量分类或方法选择算法。
 */

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
  recommendedMethod: "ols_regression" | "panel_fe_regression"
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
