/** 数据处理能力的模型可见性真相源；数值证据属于 Python 引擎测试。 */
export type DataMethodToolID = "data_preprocess" | "composite_evaluation"
export type DataMethodFamily = "preprocess" | "mcda"

export type DataMethodAdmission = {
  toolID: DataMethodToolID
  method: string
  family: DataMethodFamily
}

const PREPROCESS_METHODS = [
  "winsorize", "listwise_deletion", "median_impute", "zscore_standardize",
  "log_transform", "mean_impute", "knn_impute", "zscore_detect", "iqr_detect",
  "trim", "minmax_scale", "robust_scale", "boxcox_transform",
  "yeojohnson_transform", "fill_constant", "forward_fill", "backward_fill",
  "linear_interpolate", "group_linear_interpolate", "regression_impute",
  "create_dummies", "combine_columns", "filter", "create_column",
] as const

const MCDA_METHODS = ["entropy_weight", "topsis"] as const

export const DATA_METHOD_ADMISSIONS: readonly DataMethodAdmission[] = [
  ...PREPROCESS_METHODS.map((method) => ({ toolID: "data_preprocess" as const, method, family: "preprocess" as const })),
  ...MCDA_METHODS.map((method) => ({ toolID: "composite_evaluation" as const, method, family: "mcda" as const })),
]

export const MODEL_ADMITTED_DATA_TOOL_IDS = [
  ...new Set(DATA_METHOD_ADMISSIONS.map((admission) => admission.toolID)),
] as DataMethodToolID[]

export const MODEL_ADMITTED_PREPROCESS_METHOD_IDS = DATA_METHOD_ADMISSIONS.filter(
  (admission) => admission.toolID === "data_preprocess",
).map((admission) => admission.method)

export const MODEL_ADMITTED_MCDA_METHOD_IDS = DATA_METHOD_ADMISSIONS.filter(
  (admission) => admission.toolID === "composite_evaluation",
).map((admission) => admission.method)

export function isDataMethodToolAdmitted(toolID: DataMethodToolID) {
  return MODEL_ADMITTED_DATA_TOOL_IDS.includes(toolID)
}
