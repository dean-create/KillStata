---
name: robustness-check
description: Use this after a baseline result to design and compare robustness checks such as alternative variables, subsamples, placebo tests, and alternative estimators.
---

# Robustness Check

Use this skill after a baseline model exists and the next step is to test whether the result is stable.

## Strategy Menu

- Replace key variables with defensible alternatives.
- Run subsample analyses on meaningful groups.
- Try a nearby alternative estimator when identification permits.
- Use placebo or falsification tests when the design supports them.
- Compare sensitivity across covariance estimators and covariate sets.

## Comparison Rules

- Keep one baseline specification fixed as the anchor.
- Change one robustness dimension at a time when possible.
- Report direction, magnitude, significance, and sample changes side by side.
- Stop if a blocking diagnostic already invalidates the baseline design.

## Output Rules

- Use the same treatment and outcome definitions unless the robustness design explicitly changes them.
- Save comparison tables and a short narrative describing what held and what broke.

## Avoid

- Throwing many alternative models at the problem without a rationale.
- Calling a fragile result robust because one alternative happens to match.
- Mixing robustness checks with unlogged data changes.
