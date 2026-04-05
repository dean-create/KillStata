---
name: regression-reporting
description: Use this for regression interpretation, diagnostics, robustness summaries, academic tables, and publication-style chart outputs.
---

# Regression Reporting

Use this skill after a model has been estimated and the user needs paper-ready outputs.

## Tool path

1. Read the saved `results.json`, `diagnostics.json`, and coefficient table artifacts.
2. Use `regression_table` when the user wants a three-line table in Markdown, LaTeX, or Excel.
3. Use saved visualization artifacts when event-study or matching charts already exist; do not recreate numbers from memory.

## Reporting checklist

- State the dependent variable, treatment variable, and key controls.
- State whether standard errors are robust or clustered and at what level.
- State whether entity and time fixed effects are included.
- Keep every reported number grounded in structured outputs from the current run.
- Save final outputs in a user-deliverable format.

## Chart rules

- Prefer tool-generated PNG outputs for event-study, matching, or model diagnostics.
- Use publication-style labels, axis titles, and notes.
- If a chart does not already exist, generate it from the model outputs rather than screenshotting another interface.
