---
name: heterogeneity-analysis
description: Use this to run explicit heterogeneity, mechanism, placebo, and alternative-spec analyses from an existing baseline model.
---

# Heterogeneity Analysis

Use this only after a baseline econometric result already exists.

## Tool path

1. Read the baseline `results.json`, `diagnostics.json`, and `numeric_snapshot.json`.
2. Confirm the subgroup and mechanism variables are explicitly named by the user.
3. Call `heterogeneity_runner`.
4. Read the generated summary and narrative artifacts before reporting conclusions.

## Rules

- Do not enumerate all possible subgroup variables automatically.
- If baseline QA or diagnostics are blocking, stop and repair the baseline first.
- Keep every reported number grounded in the specification's own structured outputs.
