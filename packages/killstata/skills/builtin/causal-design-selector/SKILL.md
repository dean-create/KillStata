---
name: causal-design-selector
description: Use this to map research questions to OLS, FE, DID, IV, RDD, PSM, or event study workflows and surface the required assumptions.
---

# Causal Design Selector

Use this skill when the user describes a research question but has not clearly chosen an econometric design.

## Routing logic

- Use descriptive analysis when the task is exploratory only.
- Use `panel_fe_regression` for baseline panel associations with entity and time fixed effects.
- Use DID for policy or treatment timing with treatment and control groups.
- Use IV or 2SLS when a credible instrument is provided.
- Use RDD when a forcing variable and cutoff drive assignment.
- Use PSM or IPW when selection on observables is the main issue.
- Use event study for dynamic treatment effects.

## Before estimation

- Identify outcome, treatment, covariates, entity identifier, time identifier, and clustering level.
- State the key identifying assumption in plain language.
- Run QA before any causal model.

## Avoid

- Guessing a design without explaining why it matches the question.
- Running DID without treatment timing checks.
- Running IV without naming the instrument and first-stage logic.
