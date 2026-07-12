---
name: variable-engineering
description: Use this to build interaction terms, logs, lags, leads, bins, and derived indicators with explicit naming and audit rules.
---

# Variable Engineering

Use this skill when the task needs new variables before estimation, robustness, or reporting.

## Workflow

- State the purpose of each derived variable before creating it.
- Preserve the source columns and use explicit, reversible naming.
- Verify type compatibility before transformations such as logs, ratios, or lags.
- Re-run QA on the engineered columns before estimation.

## Naming Rules

- Interaction terms: `varA_x_varB`
- Logs: `ln_var`
- Lags: `L1_var`, `L2_var`
- Leads: `F1_var`, `F2_var`
- Quantile groups: `var_qtile`

## Common Patterns

- Interaction terms for heterogeneous effects
- Log transforms for skewed positive variables
- Lag and lead construction for panel and event-study work
- Threshold or quantile bins for nonlinear specifications

## Avoid

- Overwriting raw variables.
- Taking logs of non-positive values without a documented rule.
- Creating lags or leads without sorting by entity and time first.
