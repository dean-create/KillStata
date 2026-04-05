---
name: tabular-ingest
description: Use this for Excel, CSV, DTA, and Parquet intake, format conversion, sheet selection, and schema sanity checks.
---

# Tabular Ingest

Use this skill when the user is starting from raw Excel, CSV, DTA, or Parquet files and needs a clean canonical dataset artifact before analysis.

## Primary tool path

1. Use `data_import` with `action="healthcheck"` if Python readiness is uncertain.
2. Use `data_import` with `action="import"` to create the canonical dataset artifact.
3. Prefer the returned `datasetId` and `stageId` over raw file paths for later steps.
4. If the source is Excel, confirm sheet selection before importing if the workbook likely contains multiple sheets.

## Intake checklist

- Confirm file path and format.
- Record row and column counts after import.
- Save an inspection export if the user wants to verify the imported data.
- Note encoding issues, obvious mixed types, and suspicious date/time parsing.

## Format guidance

- Use Excel or DTA only as source and delivery formats.
- Use the canonical artifact for repeated operations.
- Use exported CSV or XLSX only for inspection or user delivery.

## Escalation conditions

- The file cannot be parsed.
- Expected columns are missing after import.
- Multiple sheets or multiple datasets appear in the same workbook.
- DTA labels or variable names look corrupted.
