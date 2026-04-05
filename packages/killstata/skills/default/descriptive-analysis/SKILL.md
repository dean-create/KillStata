---
name: descriptive-analysis
description: Use this for dataset profiling, summary statistics, correlation structure, and baseline descriptive tables before modeling.
---

# Descriptive Analysis

Use this skill before or alongside econometric estimation when the user needs a grounded statistical profile.

## Tool path

- Use `data_import` with `action="describe"` for summary statistics.
- Use `data_import` with `action="correlation"` when relationships between variables matter.
- Use `data_import` with `action="qa"` first if the dataset has not been checked yet.

## Reporting rules

- Report sample size from structured outputs.
- Make the unit of observation explicit.
- Distinguish overall summaries from subgroup summaries.
- Keep descriptive findings separate from causal claims.
