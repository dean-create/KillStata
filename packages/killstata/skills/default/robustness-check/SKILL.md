---
name: robustness-check
description: Use this for diagnostic testing, alternative specifications, sensitivity checks, and stability reporting after a baseline result exists.
---

# Robustness Check

Use this skill after a baseline estimate exists and the next step is to test whether the result is stable.

## What to check

- Diagnostics from `diagnostics.json`.
- Alternative clustering, standard errors, or fixed-effects structure when justified.
- Reasonable sample restrictions or alternative control sets.
- Sensitivity of sign, magnitude, and significance to specification changes.

## Workflow

1. Read the baseline structured outputs.
2. Identify the smallest set of additional checks needed.
3. Run only targeted re-estimation steps.
4. Summarize which findings are stable, weakened, or reversed.

## Avoid

- Running an unbounded checklist of robustness tests.
- Treating robustness as a substitute for the main identifying assumptions.
- Reporting a robustness conclusion without naming the altered specification.
