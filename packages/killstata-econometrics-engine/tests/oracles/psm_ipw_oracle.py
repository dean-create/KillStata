"""Independent SciPy oracle for NSW Hájek IPW ATE.

This oracle does not import the production propensity-score or IPW implementation.
It locks one pre-treatment covariate specification on the public NSW experiment sample.
"""

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
    design = np.column_stack([np.ones(len(raw)), (raw - raw.mean(axis=0)) / raw.std(axis=0)])

    objective = lambda beta: np.logaddexp(0.0, design @ beta).sum() - treatment @ (design @ beta)
    gradient = lambda beta: design.T @ (expit(design @ beta) - treatment)
    fitted = minimize(
        objective,
        np.zeros(design.shape[1]),
        jac=gradient,
        method="L-BFGS-B",
        options={"ftol": 1e-15, "gtol": 1e-12, "maxiter": 10_000, "maxls": 100},
    )
    if not fitted.success:
        return {"status": "FAIL", "reason": str(fitted.message)}

    scores = expit(design @ fitted.x)
    if not np.isfinite(scores).all() or ((scores < 0.05) | (scores > 0.95)).any():
        return {"status": "SAFE_REJECTION", "reason": "overlap"}

    treated = treatment == 1
    control = treatment == 0
    treated_weights = 1.0 / scores[treated]
    control_weights = 1.0 / (1.0 - scores[control])
    treated_ess = float(treated_weights.sum() ** 2 / np.square(treated_weights).sum())
    control_ess = float(control_weights.sum() ** 2 / np.square(control_weights).sum())

    weighted_smd: dict[str, float] = {}
    for index, column in enumerate(COVARIATES):
        treated_values = raw[treated, index]
        control_values = raw[control, index]
        pooled_sd = float(np.sqrt((np.var(treated_values, ddof=1) + np.var(control_values, ddof=1)) / 2.0))
        treated_mean = float(np.average(treated_values, weights=treated_weights))
        control_mean = float(np.average(control_values, weights=control_weights))
        weighted_smd[column] = (treated_mean - control_mean) / pooled_sd

    max_abs_smd = float(max(abs(value) for value in weighted_smd.values()))
    if min(treated_ess, control_ess) < 20 or max_abs_smd > 0.10:
        return {"status": "SAFE_REJECTION", "reason": "ESS or balance"}

    ate = float(np.average(outcome[treated], weights=treated_weights) - np.average(outcome[control], weights=control_weights))
    return {
        "status": "PASS",
        "diagnostic": {
            "ate": ate,
            "treated_count": int(treated.sum()),
            "control_count": int(control.sum()),
            "treatment_ess": treated_ess,
            "control_ess": control_ess,
            "min_propensity_score": float(scores.min()),
            "max_propensity_score": float(scores.max()),
            "max_weight": float(max(treated_weights.max(), control_weights.max())),
            "weighted_smd": weighted_smd,
            "weighted_max_abs_smd": max_abs_smd,
        },
    }


if __name__ == "__main__":
    source_path = sys.argv[1]
    result = run(pd.read_csv(source_path))
    print(json.dumps(result, sort_keys=True))
