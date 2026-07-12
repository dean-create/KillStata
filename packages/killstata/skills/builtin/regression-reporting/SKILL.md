---
name: regression-reporting
description: Use this for regression interpretation, diagnostics, robustness summaries, and three-line table outputs for papers.
---

# Regression Reporting

Use this skill after a model has been estimated and the user needs paper-ready outputs.

## Primary tool path

1. Read the saved regression outputs, diagnostics, and metadata.
2. Use `regression_table` when the user wants a paper-ready three-line table in Markdown, LaTeX, or Excel.
3. Keep coefficients, standard errors, significance markers, and notes aligned with the saved model outputs.

## Reporting checklist

- Report the exact dependent variable and key treatment variable.
- State whether standard errors are robust or clustered and at what level.
- Mention whether entity and time fixed effects are included.
- Save table outputs in a format the user can paste into a paper.
- Do not claim causal interpretation without restating the identifying assumptions.

## Diagnostics checklist

- Mention key QA warnings if they affect interpretation.
- Flag duplicate panel keys, severe multicollinearity, or weak first-stage issues.
- Distinguish baseline specification from robustness specifications.
