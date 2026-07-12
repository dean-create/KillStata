---
name: diagnostic-testing
description: Use this after estimation to read diagnostics, identify blocking versus warning-level failures, and map each failure to a concrete repair action.
---

# Diagnostic Testing

Use this skill after any regression-like estimation step that produces diagnostics artifacts.

## Checklist

- Read `diagnostics.json` before drawing conclusions.
- Check heteroskedasticity first, then autocorrelation, multicollinearity, specification risk, and influential observations.
- For panel or clustered models, verify cluster count and panel integrity.
- For IV, inspect instrument strength before reporting coefficients.
- For DID, inspect pre-trends or parallel-trends diagnostics before reporting treatment effects.

## Severity Rules

- Warning: heteroskedasticity, high VIF, low cluster count
- Blocking: weak IV, failed parallel trends, broken panel identifiers, missing core diagnostics

## Repair Guidance

- Heteroskedasticity -> robust or clustered standard errors
- Multicollinearity -> reduce or regroup covariates
- Weak IV -> replace the instrument or stop IV interpretation
- Failed parallel trends -> repair the design or abandon DID

## Avoid

- Reporting coefficients before diagnostics are read.
- Treating blocking diagnostics as optional footnotes.
- Ignoring the saved metadata and numeric snapshot.
