import { describe, expect, test } from "bun:test"
import {
  ALL_ECONOMETRICS_ESTIMATOR_TOOL_IDS,
  ECONOMETRICS_ADMISSIONS,
  MODEL_ADMITTED_ECONOMETRICS_DIAGNOSTIC_TOOL_IDS,
  MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS,
  admissionForEconometricsTool,
} from "@/runtime/econometrics-admission"
import { DATA_METHOD_ADMISSIONS } from "@/runtime/data-method-admission"

describe("econometrics admission registry", () => {
  test("runtime allowlists contain only executable visibility facts", () => {
    expect(Object.keys(ECONOMETRICS_ADMISSIONS[0]!).sort()).toEqual(["surface", "toolID"])
    expect(Object.keys(DATA_METHOD_ADMISSIONS[0]!).sort()).toEqual(["family", "method", "toolID"])
  })

  test("keeps the backend census and the reviewed model-visible surface", () => {
    expect(ALL_ECONOMETRICS_ESTIMATOR_TOOL_IDS).toContain("logit_regression")
    expect(ALL_ECONOMETRICS_ESTIMATOR_TOOL_IDS).toContain("multinomial_logit")
    expect(MODEL_ADMITTED_ECONOMETRICS_DIAGNOSTIC_TOOL_IDS).toEqual([
      "psm_construction", "psm_visualize", "iv_test",
    ])
    expect(MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS).toEqual([
      "psm_matching", "psm_ipw", "psm_regression", "psm_double_robust",
      "did_static", "did2s", "did_event_study_saturated", "ols_regression",
      "panel_fe_regression", "iv_2sls", "hdfe_regression", "logit_regression",
      "probit_regression", "poisson_regression", "negbin_regression",
      "quantile_regression", "panel_random_effects", "rdd_sharp", "rdd_fuzzy",
      "multinomial_logit", "robust_regression", "wls_regression",
    ])
    expect(admissionForEconometricsTool("did2s")).toEqual({ toolID: "did2s", surface: "estimator" })
    expect(admissionForEconometricsTool("iv_test")).toEqual({ toolID: "iv_test", surface: "diagnostic" })
  })
})
