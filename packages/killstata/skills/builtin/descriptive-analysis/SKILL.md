---
name: descriptive-analysis
description: Use this for descriptive statistics, correlation summaries, sample profiling, and saveable exploratory outputs.
---

# Descriptive Analysis

Use this skill before or alongside econometric estimation when the user needs a statistical profile of the data.

## Primary tool path

1. Use `data_import` with `action="describe"` for descriptive statistics.
2. Use `data_import` with `action="correlation"` when relationships among numeric variables matter.
3. Save CSV or XLSX outputs so the user can inspect the summary table directly.

## Reporting checklist

- Identify the estimation sample being described.
- Report sample size and whether filters were applied.
- Distinguish between raw descriptive statistics and regression-ready sample statistics.
- Call out obvious anomalies such as impossible ranges or strong outliers.

## When to stop and escalate

- Key variables are non-numeric when they should be numeric.
- Correlations suggest coding errors or duplicated variables.
- The described sample does not match the intended estimation sample.
