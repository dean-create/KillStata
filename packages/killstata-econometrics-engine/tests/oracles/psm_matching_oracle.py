"""Independent NSW oracle for KillStata's fixed nearest-neighbour PSM contract.

This intentionally does not import the production econometrics module.  It repeats the
contract in a small check-only implementation so a regression in the production matcher
cannot certify itself.  Specifications are named, frozen and literature-traceable; the
script never searches covariate combinations from observed balance or outcomes.
"""

import json
import sys

import numpy as np
import pandas as pd
from scipy.optimize import minimize


SPECS = {
    # MIT's Dehejia-Wahba replication lists: age age2 ed black hisp nodeg.
    "dw_demographics": ["age", "age_squared", "education", "black", "hispanic", "nodegree"],
    # This is the original existing tool replay; it must stay a rejected safety case.
    "full_baseline": ["age", "education", "black", "hispanic", "married", "nodegree", "re74", "re75"],
}


def maximum_abs_smd(frame, treatment, control_weights, matched_treated, covariates):
    values = {}
    treated_mask = treatment == 1
    control_mask = treatment == 0
    for column in covariates:
        treated = frame.loc[treated_mask, column].to_numpy(dtype=float)
        controls = frame.loc[control_mask, column].to_numpy(dtype=float)
        pooled_sd = float(np.sqrt((np.var(treated, ddof=1) + np.var(controls, ddof=1)) / 2.0))
        if pooled_sd == 0:
            raise ValueError(f"zero pooled variance for {column}")
        matched_mean = float(frame.loc[matched_treated, column].mean())
        weighted_control_mean = float(np.average(controls, weights=control_weights))
        values[column] = (matched_mean - weighted_control_mean) / pooled_sd
    return values, float(max(abs(value) for value in values.values()))


def run(frame, specification):
    covariates = SPECS[specification]
    treatment = frame["treat"].astype(float)
    outcome = frame["re78"].astype(float)
    raw_design = frame[covariates].to_numpy(dtype=float)
    # 标准化只改善独立优化器条件数；截距会吸收平移/缩放，因此与生产 Logit 的
    # 原始设计矩阵有同一线性预测。这里不用 statsmodels，避免与生产倾向得分实现自证。
    design = np.column_stack([np.ones(len(frame)), (raw_design - raw_design.mean(axis=0)) / raw_design.std(axis=0)])
    response = treatment.to_numpy(dtype=float)
    objective = lambda beta: np.logaddexp(0.0, design @ beta).sum() - response @ (design @ beta)
    gradient = lambda beta: design.T @ (1.0 / (1.0 + np.exp(-(design @ beta))) - response)
    fit = minimize(
        objective,
        np.zeros(design.shape[1]),
        jac=gradient,
        method="L-BFGS-B",
        options={"ftol": 1e-15, "gtol": 1e-12, "maxiter": 10000, "maxls": 100},
    )
    if not fit.success:
        raise RuntimeError(f"independent Logit did not converge: {fit.message}")
    scores = pd.Series(1.0 / (1.0 + np.exp(-(design @ fit.x))), index=frame.index)
    logits = np.log(scores / (1.0 - scores))
    caliper = float(0.2 * np.std(logits.to_numpy(), ddof=1))
    control_index = treatment.index[treatment == 0]
    treated_index = treatment.index[treatment == 1]
    weights = pd.Series(0.0, index=control_index)
    matched_treated = []
    effects = []
    distances = []

    for row in treated_index:
        distance = (logits.loc[control_index] - logits.loc[row]).abs()
        nearest = float(distance.min())
        if nearest > caliper:
            continue
        ties = distance.index[np.isclose(distance.to_numpy(), nearest, rtol=0.0, atol=1e-12)]
        weights.loc[ties] += 1.0 / len(ties)
        matched_treated.append(row)
        effects.append(float(outcome.loc[row] - outcome.loc[ties].mean()))
        distances.append(nearest)

    if not matched_treated:
        raise ValueError("PSM matching found no treated observation with a control inside the fixed caliper")

    pre_smd = {}
    for column in covariates:
        treated = frame.loc[treatment == 1, column].to_numpy(dtype=float)
        controls = frame.loc[treatment == 0, column].to_numpy(dtype=float)
        pooled_sd = float(np.sqrt((np.var(treated, ddof=1) + np.var(controls, ddof=1)) / 2.0))
        pre_smd[column] = float((treated.mean() - controls.mean()) / pooled_sd)
    post_smd, post_max = maximum_abs_smd(frame, treatment, weights.to_numpy(), matched_treated, covariates)
    if post_max > 0.10:
        return {
            "status": "SAFE_REJECTION",
            "reason": f"PSM matching failed post-match balance: max absolute SMD={post_max:.4f} exceeds 0.10",
        }
    return {
        "status": "PASS",
        "diagnostic": {
            "att": float(np.mean(effects)),
            "caliper": caliper,
            "treated_count": int(len(treated_index)),
            "control_count": int(len(control_index)),
            "matched_treated_count": int(len(matched_treated)),
            "unmatched_treated_count": int(len(treated_index) - len(matched_treated)),
            "reused_control_count": int((weights > 1.0).sum()),
            "max_match_distance": float(max(distances)),
            "pre_match_max_abs_smd": float(max(abs(value) for value in pre_smd.values())),
            "post_match_max_abs_smd": post_max,
        },
    }


if __name__ == "__main__":
    path, specification = sys.argv[1:]
    if specification not in SPECS:
        raise SystemExit(f"unknown frozen NSW matching specification: {specification}")
    print(json.dumps(run(pd.read_csv(path), specification)))
