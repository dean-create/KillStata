---
name: workflow-orchestrator
description: Use this to orchestrate Excel, tabular data cleaning, econometric estimation, diagnostics, and publication-style outputs in the correct stage order.
---

# Workflow Orchestrator

Use this skill first for any non-trivial spreadsheet, tabular, or empirical analysis task.

## Stage order

1. Intake: identify files, formats, likely sheets, and the target canonical dataset.
2. Import: use `data_import` with `action="import"` and keep `datasetId` and `stageId`.
3. QA and cleaning: run `qa`, then `filter` or `preprocess` only as needed.
4. Design or method selection: confirm whether the task is descriptive, FE, DID, IV, PSM, or RDD.
5. Estimation: call `econometrics` with explicit identifiers, treatment, covariates, and options.
6. Post-estimation expansion: after a baseline exists, use `heterogeneity_runner` for explicit subgroup, mechanism, placebo, and alternative-spec work.
7. Validation: read structured artifacts before reporting any number.
8. Output: save tables, diagnostics, and charts to visible results.
9. Writing and presentation: use `paper_draft` for the article draft and `slide_generator` for the seminar deck.

## Routing rules

- Excel or multi-sheet workbook: load `xlsx-processor`.
- Raw CSV, XLSX, DTA, or Parquet intake: load `tabular-ingest`.
- Cleaning, recoding, winsorizing, standardizing, or feature construction: load `tabular-cleaning`.
- Panel identifiers or repeated observations: load `panel-data-qa`.
- Idea formation, topic scoping, identification alternatives, or data planning: load `research-briefing`.
- Descriptive profile or summary tables: load `descriptive-analysis`.
- Known DID, IV, PSM, or RDD design: load the matching method skill before estimation.
- Post-estimation reporting or paper-ready tables: load `regression-reporting`.
- Stability, sensitivity, or alternative specifications: load `robustness-check`.
- Explicit heterogeneity, mechanism, placebo, or alternative-spec extensions after a baseline: load `heterogeneity-analysis`.
- Paper-first drafting from saved outputs: load `paper-drafting`.
- Academic seminar deck generation from saved outputs: load `slide-generator`.

## Non-negotiables

- Do not keep working from raw Excel once a canonical dataset artifact exists.
- Do not report coefficients, p-values, standard errors, R-squared, or sample size without reading structured outputs from the same run.
- Do not skip QA before causal or panel estimation.
- Repair only the failed stage when a tool errors; do not restart the whole workflow.
- `research_brief` is a pre-estimation artifact.
- `heterogeneity_runner` is a post-baseline artifact.
- `paper_draft` and `slide_generator` must consume saved structured artifacts, not remembered numbers.
