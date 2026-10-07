"""Independent SciPy/NumPy oracle for NSW propensity-score ATE adjustments."""

from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.special import expit


COVARIATES = ["age", "age_squared", "education", "black", "hispanic", "nodegree"]


def run(frame: pd.DataFrame) -> dict:
    treatment = frame["treat"].to_numpy(dtype=float)
    outcome = frame["re78"].to_numpy(dtype=float)
    raw = frame[COVARIATES].to_numpy(dtype=float)
    standardized = (raw - raw.mean(axis=0)) / raw.std(axis=0)
    propensity_design = np.column_stack([np.ones(len(raw)), standardized])
    objective = lambda beta: np.logaddexp(0.0, propensity_design @ beta).sum() - treatment @ (propensity_design @ beta)
    gradient = lambda beta: propensity_design.T @ (expit(propensity_design @ beta) - treatment)
    fit = minimize(
        objective,
        np.zeros(propensity_design.shape[1]),
        jac=gradient,
        method="L-BFGS-B",
        options={"ftol": 1e-15, "gtol": 1e-12, "maxiter": 10_000, "maxls": 100},
    )
    if not fit.success:
        return {"status": "FAIL", "reason": str(fit.message)}
    propensity = expit(propensity_design @ fit.x)
    if not np.isfinite(propensity).all() or ((propensity < 0.05) | (propensity > 0.95)).any():
        return {"status": "SAFE_REJECTION", "reason": "overlap"}

    treated = treatment == 1
    control = treatment == 0
    treated_weights = 1.0 / propensity[treated]
    control_weights = 1.0 / (1.0 - propensity[control])
    ess = lambda weights: float(weights.sum() ** 2 / np.square(weights).sum())
    weighted_smd = {}
    for index, column in enumerate(COVARIATES):
        treated_values = raw[treated, index]
        control_values = raw[control, index]
        pooled_sd = float(np.sqrt((np.var(treated_values, ddof=1) + np.var(control_values, ddof=1)) / 2.0))
        treated_mean = float(np.average(treated_values, weights=treated_weights))
        control_mean = float(np.average(control_values, weights=control_weights))
        weighted_smd[column] = (treated_mean - control_mean) / pooled_sd

    weighted_max_abs_smd = float(max(abs(value) for value in weighted_smd.values()))
    if min(ess(treated_weights), ess(control_weights)) < 20 or weighted_max_abs_smd > 0.10:
        return {"status": "SAFE_REJECTION", "reason": "ESS or balance"}

    # PSM regression adjustment: OLS of the outcome on treatment and estimated propensity.
    regression_design = np.column_stack([np.ones(len(treatment)), treatment, propensity])
    regression_adjustment_ate = float(np.linalg.lstsq(regression_design, outcome, rcond=None)[0][1])

    # AIPW: separate linear outcome models by treatment group plus the canonical augmentation.
    outcome_design = np.column_stack([np.ones(len(raw)), raw])
    treated_beta = np.linalg.lstsq(outcome_design[treated], outcome[treated], rcond=None)[0]
    control_beta = np.linalg.lstsq(outcome_design[control], outcome[control], rcond=None)[0]
    m1 = outcome_design @ treated_beta
    m0 = outcome_design @ control_beta
    contribution = m1 - m0 + treatment / propensity * (outcome - m1) - (1.0 - treatment) / (1.0 - propensity) * (outcome - m0)
    if not np.isfinite(contribution).all():
        return {"status": "FAIL", "reason": "non-finite AIPW contribution"}

    return {
        "status": "PASS",
        "diagnostic": {
            "regression_adjustment_ate": regression_adjustment_ate,
            "aipw_ate": float(contribution.mean()),
            "treated_count": int(treated.sum()),
            "control_count": int(control.sum()),
            "treatment_ess": ess(treated_weights),
            "control_ess": ess(control_weights),
            "weighted_max_abs_smd": weighted_max_abs_smd,
            "weighted_smd": weighted_smd,
        },
    }


if __name__ == "__main__":
    frame = pd.read_csv(sys.argv[1])
    print(json.dumps(run(frame), sort_keys=True))
