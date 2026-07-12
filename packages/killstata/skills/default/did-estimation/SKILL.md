---
name: did-estimation
description: Use this for difference-in-differences, staggered adoption, and event-study workflows when treatment timing drives identification.
---

# DID Estimation

Use this skill when the design is explicitly DID or event-study.

## Method routing

- Static two-group DID: `econometrics` with `methodName="did_static"`.
- Staggered treatment timing: `methodName="did_staggered"`.
- Dynamic treatment effects: `methodName="did_event_study"` and, if needed, `did_event_study_viz`.

## Required setup

- Confirm outcome, treatment, entity ID, time ID, and clustering level.
- Confirm treatment timing variables and treatment group construction.
- Run `panel-data-qa` before estimation.

## Report only if grounded

- Treatment effect, standard error, p-value, sample size, and identifying assumptions.
- Parallel-trends discussion should be explicit and separate from numeric claims.
