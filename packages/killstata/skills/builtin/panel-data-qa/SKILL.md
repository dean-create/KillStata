---
name: panel-data-qa
description: Use this for panel integrity checks including entity-time keys, duplicates, treatment timing, lag readiness, and sample attrition.
---

# Panel Data QA

Use this skill when the user is working with panel or repeated cross-section data and the analysis depends on entity and time structure.

## Primary tool path

1. Use `data_import` with `action="qa"` on the working dataset.
2. Verify entity and time identifiers before any FE, DID, event study, or panel regression.
3. Inspect duplicates, missing key identifiers, and sample attrition before estimation.
4. Save the QA report and mention blocking errors before moving to `econometrics`.

## QA checklist

- Is `entityVar + timeVar` unique?
- Are treatment and outcome variables populated in the estimation sample?
- Are there unexpected gaps in the panel?
- Does treatment timing look plausible for DID or event study?
- Are lag or lead constructions possible with the current identifiers?

## Output expectations

- State whether the panel is usable as-is.
- Separate blocking errors from warnings.
- Recommend the minimum repair if the panel is not estimation-ready.
