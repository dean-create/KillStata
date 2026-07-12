---
name: iv-estimation
description: Use this for instrumental-variables and 2SLS workflows when a credible instrument is available and endogeneity is central.
---

# IV Estimation

Use this skill when the user already has an IV design or names an instrument.

## Tool path

- Baseline IV estimation: `econometrics` with `methodName="iv_2sls"`.
- Instrument diagnostics or checks: `methodName="iv_test"` when needed.

## Required setup

- Confirm dependent variable, endogenous treatment, instrument, controls, and clustering level.
- State the exclusion restriction and relevance logic in plain language.
- Check that the instrument is available and non-degenerate before estimation.

## Reporting rules

- Report first-stage strength only from saved diagnostics.
- Flag weak-IV issues explicitly.
- Do not present IV as causal unless the instrument assumptions are stated.
