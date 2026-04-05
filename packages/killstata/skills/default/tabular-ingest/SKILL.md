---
name: tabular-ingest
description: Use this for Excel, CSV, DTA, and Parquet intake, format conversion, sheet selection, and schema sanity checks.
---

# Tabular Ingest

Use this skill when turning raw files into a canonical working dataset.

## Tool path

1. If Python readiness is uncertain, run `data_import` with `action="healthcheck"`.
2. Run `data_import` with `action="import"`.
3. Keep the returned `datasetId` and `stageId` for every later step.

## Intake checklist

- Confirm source path and format.
- Record row count, column count, and major identifier columns after import.
- Save inspection exports only for user review, not as the working layer.
- Treat Parquet stages as the canonical working dataset.

## Escalate when

- Parsing fails.
- Required columns disappear after import.
- Multiple tables appear in one file and no canonical table is obvious.
