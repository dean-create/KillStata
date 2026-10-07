/**
 * 模型可见计量能力的人工 allowlist。
 *
 * 本文件只表达“哪个已实现工具允许暴露给模型”以及它属于诊断还是估计。
 * 数值正确性、冻结数据和独立 oracle 由 Python 引擎测试负责；真实模型表现由
 * Drive 场景负责。运行时不得把历史报告次数或旧证据文字当成可执行事实。
 */
export const ALL_ECONOMETRICS_ESTIMATOR_TOOL_IDS = [
  "psm_matching", "psm_ipw", "psm_regression", "psm_double_robust",
  "ols_regression", "panel_fe_regression", "iv_2sls", "hdfe_regression",
  "did_static", "did2s", "did_event_study_saturated", "logit_regression",
  "probit_regression", "poisson_regression", "negbin_regression",
  "quantile_regression", "panel_random_effects", "rdd_sharp", "rdd_fuzzy",
  "multinomial_logit", "robust_regression", "wls_regression",
] as const

type AdmissionSurface = "diagnostic" | "estimator"

export type EconometricsAdmission = {
  toolID: string
  surface: AdmissionSurface
}

const DIAGNOSTIC_TOOL_IDS = ["psm_construction", "psm_visualize", "iv_test"] as const
const ESTIMATOR_TOOL_IDS = [
  "psm_matching", "psm_ipw", "psm_regression", "psm_double_robust",
  "did_static", "did2s", "did_event_study_saturated", "ols_regression",
  "panel_fe_regression", "iv_2sls", "hdfe_regression", "logit_regression",
  "probit_regression", "poisson_regression", "negbin_regression",
  "quantile_regression", "panel_random_effects", "rdd_sharp", "rdd_fuzzy",
  "multinomial_logit", "robust_regression", "wls_regression",
] as const

export const ECONOMETRICS_ADMISSIONS: readonly EconometricsAdmission[] = [
  ...DIAGNOSTIC_TOOL_IDS.map((toolID) => ({ toolID, surface: "diagnostic" as const })),
  ...ESTIMATOR_TOOL_IDS.map((toolID) => ({ toolID, surface: "estimator" as const })),
]

export const MODEL_ADMITTED_ECONOMETRICS_DIAGNOSTIC_TOOL_IDS = ECONOMETRICS_ADMISSIONS.filter(
  (item) => item.surface === "diagnostic",
).map((item) => item.toolID)

export const MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS = ECONOMETRICS_ADMISSIONS.filter(
  (item) => item.surface === "estimator",
).map((item) => item.toolID)

export const MODEL_ADMITTED_PSM_ESTIMATOR_TOOL_IDS = MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS.filter(
  (toolID) => toolID.startsWith("psm_"),
)

const admissionByToolID = new Map<string, EconometricsAdmission>(
  ECONOMETRICS_ADMISSIONS.map((item) => [item.toolID, item]),
)

export function admissionForEconometricsTool(toolID: string) {
  return admissionByToolID.get(toolID)
}
