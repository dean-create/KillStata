---
name: tabular-cleaning
description: Use this to clean, filter, recode, winsorize, standardize, and otherwise transform tabular data before estimation.
---

# Tabular Cleaning

Use this skill when the user wants to modify the working dataset before analysis.

## Tool path

- Use `data_import` with `action="qa"` before making substantive changes.
- Use `data_import` with `action="filter"` for row restrictions.
- Use `data_import` with `action="preprocess"` for winsorizing, logs, standardization, dummy creation, or recoding.

## Cleaning rules

- Explain the cleaning rule before applying it.
- Preserve the canonical stage lineage; do not overwrite the source artifact.
- Keep a clear distinction between user-confirmed sample restrictions and convenience filtering.
- Re-run QA after material cleaning steps.

## Avoid

- Silent row deletion.
- Mixing cleaning and estimation in one step.
- Reporting results from a stage that has not passed QA.
