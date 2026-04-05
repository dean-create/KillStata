---
name: xlsx-processor
description: Use this to inspect multi-sheet Excel files, choose canonical sheets, merge workbook tabs, and convert spreadsheet inputs into analysis-ready tables.
---

# XLSX Processor

Use this skill when the input is an Excel workbook and the task depends on sheet selection, cross-sheet merging, or format normalization.

## Workflow

- List all sheet names before selecting one as the canonical analysis sheet.
- Check whether header rows, merged cells, notes rows, or blank spacer columns need cleanup.
- If multiple sheets must be combined, document the join key or append rule before transformation.
- Normalize date, numeric, and identifier columns before export or downstream QA.
- Preserve the workbook structure in the audit trail so the chosen sheet and discarded sheets are explicit.

## Output Rules

- Prefer Parquet as the working dataset after import.
- Keep CSV/XLSX outputs as inspection or exchange artifacts.
- Record sheet names, row counts, and any dropped decorative content in the import log.

## Avoid

- Guessing the correct sheet without listing alternatives.
- Mixing tabs with different schemas without documenting the reconciliation rule.
- Treating formatting-only differences as data unless the workbook proves otherwise.
