---
name: rdd-estimation
description: Use this for regression discontinuity workflows when a running variable and cutoff determine treatment assignment.
---

# RDD Estimation

Use this skill when identification comes from a threshold in a running variable.

## Method routing

- Sharp design: `econometrics` with `methodName="rdd_sharp"`.
- Fuzzy local design: `methodName="rdd_fuzzy"`.
- Fuzzy global variant: `methodName="rdd_fuzzy_global"`.

## Required setup

- Confirm the running variable, cutoff, treatment rule, and bandwidth logic.
- Check whether manipulation around the threshold is plausible.
- Keep the local estimand interpretation explicit.

## Reporting rules

- Report the cutoff and running variable clearly.
- Report the local effect only from structured outputs.
- Distinguish sharp and fuzzy designs in both tables and narrative.
