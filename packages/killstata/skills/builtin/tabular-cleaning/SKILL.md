---
name: tabular-cleaning
description: Use this for row filtering, deletion confirmation, missing-data handling, interpolation, winsorization, and reproducible cleaning checkpoints.
---

# Tabular Cleaning

Use this skill when the user wants to clean, filter, or transform tabular data.

## Primary tool path

1. Run `data_import` with `action="qa"` before destructive cleaning.
2. For row deletion or filtering, confirm the exact condition with the user first.
3. Use `data_import` with `action="filter"` for explicit row removal rules.
4. Use `data_import` with `action="preprocess"` for missing-data handling, transforms, interpolation, winsorization, standardization, and dummy creation.
5. Save an inspection output after each major cleaning step.

## Cleaning policy

- Never overwrite the raw source file.
- Prefer one transformation per step when the user cares about auditability.
- Treat interpolation and regression imputation as high-risk operations and call them out explicitly.
- Report sample changes after deletion, filtering, or imputation.

## Missing-data guidance

- Prefer simple, transparent handling first.
- Use interpolation only when the time axis is explicit.
- Use grouped interpolation only when entity and time identifiers are known.
- Use regression imputation only when the user accepts model-based filling.

## Escalation conditions

- Missingness is concentrated in key outcome or treatment variables.
- Filtering removes a large share of the sample.
- A transformation changes the meaning of a key variable.
