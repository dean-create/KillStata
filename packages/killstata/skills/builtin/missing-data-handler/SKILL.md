---
name: missing-data-handler
description: Use this to decide how to handle missing data, distinguish low-risk from high-risk imputations, and explain the identification cost of each choice.
---

# Missing Data Handler

Use this skill when missingness is material enough to affect descriptive results, model sample size, or causal identification.

## Decision Process

- Start by quantifying missingness by variable and by row.
- Distinguish likely MCAR, MAR, and MNAR cases using data structure and domain clues.
- Prefer the lowest-risk repair that preserves the analysis goal.
- If the treatment, outcome, or key identifiers are heavily missing, escalate the risk explicitly before modeling.

## Repair Rules

- Use row deletion only when the loss is limited and unlikely to distort identification.
- Use simple fills only for low-risk operational fields, not substantive outcome or treatment variables by default.
- Use interpolation or regression imputation only when the assumptions are defensible and documented.
- Record before/after missing counts for every touched variable.

## Avoid

- Silent `dropna` on key model variables.
- Imputing treatment or outcome variables without stating the assumption and risk.
- Presenting imputed results as if they were identical to raw-data estimates.
