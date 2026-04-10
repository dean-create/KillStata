# KillStata

KillStata is an AI-native CLI for econometric research workflows.

It is built for people who work with panel data, policy evaluation, causal inference, and paper-ready outputs, but do not want to manually stitch together Stata, Python, spreadsheets, and reporting scripts every time.

This repository is the open-source CLI core. It focuses on reproducible data import, staged data processing, econometric estimation, and deliverable generation.

## What KILLSTATA Does

KillStata is not just a chat interface and not just a regression wrapper.

It treats empirical analysis as a workflow:

1. Import raw data into a tracked dataset artifact.
2. Run QA and preprocessing as explicit stages.
3. Execute econometric methods against the current stage.
4. Save structured outputs that can be verified, exported, and reused.

In practice, that means KillStata is designed to answer questions like:

- "Import this Excel file and check whether the panel keys are duplicated."
- "Run a panel fixed-effects regression on the cleaned stage."
- "Generate a three-line table and a short interpretation."
- "Do not read the raw file again; continue from the current analysis artifact."

## Core Features

### Data Workflow

- Import `CSV`, `XLSX`, and `DTA` files
- Convert raw input into a canonical internal working layer
- Preserve `datasetId` and `stageId` so processing steps stay traceable
- Run QA, filtering, preprocessing, and rollback as explicit stages

### Econometric Analysis

- OLS regression
- Panel fixed-effects regression
- DID-style workflows
- IV / 2SLS workflows
- PSM-related workflows
- Diagnostics, schema checks, and recommendation helpers

### Deliverables

- Regression outputs in structured JSON form
- Human-readable summaries
- Three-line tables for papers
- Export-friendly files such as Markdown, LaTeX, CSV, XLSX, and DOCX
- Analysis artifacts that can be reused in later steps instead of rerunning from raw files

## Why The Architecture Matters

KillStata follows three product principles:

- `Artifact-first`: continue from saved analysis artifacts, not from raw files every time
- `Stage-based`: every important data transformation creates a new stage instead of silently overwriting the old one
- `Grounded reporting`: narrative outputs should come from structured result files, not from model memory alone

This is the reason the CLI can stay usable even when tasks become long, multi-step, and data-heavy.

## Installation

### For Users

If you are installing the CLI from npm:

```bash
npm install -g killstata
```

Current packaging is optimized for Windows-first CLI distribution.

### For Source Development

If you are working on the repository itself:

```bash
bun install
```

## Quick Start

Start the CLI:

```bash
killstata
```

Typical workflow:

1. Open a project folder with your data files.
2. Import a dataset.
3. Let KillStata run QA and build the working dataset stage.
4. Ask for estimation, diagnostics, tables, or report outputs.

Example prompts:

- `Import this Excel file and show me the schema.`
- `Use the current panel stage and run a fixed-effects regression with clustered SE.`
- `Export a three-line table and a short result summary.`

## Repository Structure

This repository is a CLI-focused monorepo.

```text
packages/
  killstata/   main CLI package
  plugin/      plugin-related code
  script/      shared build and automation scripts
  sdk/js/      JavaScript SDK pieces
  util/        shared utilities
```

The main package is here:

- [packages/killstata](./packages/killstata)

## Development

Install dependencies:

```bash
bun install
```

Run typecheck:

```bash
bun run typecheck
```

Run CLI package tests:

```bash
bun run --cwd packages/killstata test
```

Build the CLI package:

```bash
bun run --cwd packages/killstata build
```

Windows-priority build:

```bash
bun run --cwd packages/killstata build:windows-priority
```

## Workflow Docs

If you want the lower-level architecture and runtime workflow details, start here:

- [CURRENT_IMPLEMENTED_WORKFLOW.md](./CURRENT_IMPLEMENTED_WORKFLOW.md)
- [FINAL_OUTPUT_CHAIN_AUDIT.md](./FINAL_OUTPUT_CHAIN_AUDIT.md)

These documents explain how `datasetId`, `stageId`, runtime workflow state, and output artifacts fit together.

## Project Status

- This repository currently focuses on the CLI core
- Desktop / GUI code is not the main target of this repository anymore
- The codebase is actively being shaped around reproducible econometric workflows rather than generic chat UX

## License

MIT. See [LICENSE](./LICENSE).
