---
name: psm-estimation
description: Use this for propensity-score matching, weighting, and doubly robust workflows when selection on observables is the core design.
---

# PSM Estimation

Use this skill when treatment assignment is modeled from observables.

## Method routing

- Build scores and overlap artifacts: `psm_construction`.
- Matching estimators: `psm_matching`.
- Inverse-probability weighting: `psm_ipw`.
- Outcome regression after matching: `psm_regression`.
- Doubly robust estimators: `psm_double_robust` or `psm_dr_ipw_ra`.
- Matching or overlap chart: `psm_visualize` when the user needs a figure.

## Required setup

- Confirm treatment, outcome, and covariates used for selection.
- Check common support and overlap before interpreting treatment effects.
- Keep the selection model separate from the outcome discussion.

## Reporting rules

- Report the matched or weighted estimand clearly.
- Report balance or overlap diagnostics from structured outputs.
- Use the saved PNG if a propensity-score distribution chart is generated.
