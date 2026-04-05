---
name: csv-summarizer
description: Use this to produce a fast, grounded overview of CSV data including shape, types, missingness, distributions, and large-file sampling strategy.
---

# CSV Summarizer

Use this skill when the user needs a quick, reliable understanding of a CSV before cleaning or modeling.

## Workflow

- Report row count, column count, likely variable roles, and obvious panel identifiers.
- Summarize column types, missingness rate, distinct counts, and suspicious values.
- For very large files, profile a representative sample first and say that it is a sample-based summary.
- Highlight candidate outcome, treatment, control, ID, and time columns when they are plausible.
- Flag columns that need encoding fixes, numeric coercion, or date parsing before analysis.

## Output Rules

- Prefer concise structured summaries backed by inspection artifacts.
- Surface only grounded statistics from the inspected file or numeric snapshot.
- Recommend the next tool stage: import, QA, cleaning, or estimation.

## Avoid

- Reporting inferred statistics without reading the file.
- Treating identifiers as numeric measures just because they are coded as integers.
- Ignoring large-file sampling risk.
