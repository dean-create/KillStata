---
name: xlsx-processor
description: Use this to inspect multi-sheet Excel files, choose canonical sheets, merge workbook tabs, and convert spreadsheet inputs into analysis-ready tables.
---

# XLSX Processor

Use this skill when the source is an Excel workbook and sheet structure matters.

## What to do

- List sheet names before choosing the canonical sheet.
- Check for header offsets, merged cells, note rows, decorative columns, and hidden totals.
- If multiple sheets are needed, state the append or join rule before importing.
- Normalize dates, identifiers, and numerics before downstream QA.

## Tool path

1. Use `data_import` to import the workbook.
2. Save the selected sheet as the canonical dataset artifact.
3. Export inspection files only if the user needs to verify the workbook mapping.

## Avoid

- Guessing the correct sheet.
- Treating formatting-only structure as data.
- Mixing tabs with incompatible schemas without documenting the reconciliation rule.
