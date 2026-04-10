# KillStata

[![License](https://img.shields.io/github/license/dean-create/KillStata?label=license)](./LICENSE)
[![Typecheck](https://img.shields.io/github/actions/workflow/status/dean-create/KillStata/typecheck.yml?branch=main&label=typecheck)](https://github.com/dean-create/KillStata/actions/workflows/typecheck.yml)
![CLI](https://img.shields.io/badge/interface-CLI-111111)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6)
![Runtime](https://img.shields.io/badge/runtime-Bun-F9F1E1)
![Platform](https://img.shields.io/badge/platform-Windows%20first-0078D4)

KillStata is an AI-native CLI for econometric research workflows.

It is built for people doing empirical research with panel data, policy evaluation, causal inference, and paper-ready reporting, but who do not want to glue together spreadsheets, Stata scripts, Python notebooks, regression exports, and result summaries by hand every single time.

This repository is the open-source CLI core. It focuses on reproducible data import, staged data processing, econometric estimation, and deliverable generation.

## Table of Contents

- [Why KillStata](#why-killstata)
- [Core Features](#core-features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Repository Structure](#repository-structure)
- [Development](#development)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Workflow Docs](#workflow-docs)
- [License](#license)

## Why KillStata

KillStata is not just a chat box and not just a regression wrapper.

It treats empirical analysis as a workflow:

1. Import raw data into a tracked dataset artifact.
2. Run QA and preprocessing as explicit stages.
3. Execute econometric methods against the current stage.
4. Save structured outputs that can be verified, exported, and reused.

In practice, KillStata is built for tasks like:

- "Import this Excel file and check whether the panel keys are duplicated."
- "Run a panel fixed-effects regression on the cleaned stage."
- "Generate a three-line table and a short interpretation."
- "Do not read the raw file again; continue from the current analysis artifact."

The core idea is simple:

- raw files are entry points
- artifacts are the working memory
- stages are the audit trail
- structured outputs are the source of truth

That design is what keeps the CLI usable when the analysis gets long, multi-step, and data-heavy.

## Core Features

### Data Workflow

- Import `CSV`, `XLSX`, and `DTA` files
- Convert raw input into a canonical internal working layer
- Preserve `datasetId` and `stageId` so each step stays traceable
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
- Export-friendly outputs such as Markdown, LaTeX, CSV, XLSX, and DOCX
- Analysis artifacts that can be reused instead of rerunning from raw files

## Installation

### For Users

If you want the CLI from npm:

```bash
npm install -g killstata
```

Current packaging is optimized for Windows-first CLI distribution.

### For Source Development

If you are working from source:

```bash
bun install
```

## Quick Start

Start the CLI:

```bash
killstata
```

Typical flow:

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

Main package:

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

## FAQ

### Do I need Stata installed?

No. KillStata is designed as its own CLI workflow layer. It can import common research data formats and run its own analysis pipeline without requiring a local Stata installation.

### Does it keep rereading the raw Excel file forever?

No. Raw files are only the entry point. After import, KillStata is designed to continue from structured artifacts and tracked stages rather than repeatedly treating the original spreadsheet as the source of truth.

### Why is the project Windows-first right now?

Because the current npm packaging and release flow are optimized for Windows users first. Cross-platform distribution is still important, but Windows is the current stability target.

### Can it handle large datasets or many tables?

That is exactly why the project uses an artifact-first design. The goal is to avoid shoving raw tables into prompt context and instead continue from saved dataset stages, summaries, diagnostics, and result artifacts.

### Is this repository the desktop app?

No. This repository now focuses on the CLI core. If you are looking for a full desktop GUI experience, that is not the main target of this repo anymore.

## Roadmap

Near-term priorities:

- stabilize the Windows-first npm distribution flow
- improve cross-platform binary packaging
- keep tightening the CLI-only repository structure
- improve UTF-8 and Chinese text handling across outputs
- make artifact-driven analysis paths more visible in the UX

Medium-term priorities:

- expand econometric workflow coverage
- improve structured result grounding and delivery quality
- strengthen regression-table and report-generation polish
- improve contributor onboarding and test clarity

## Contributing

Contributions are welcome.

Good contribution types:

- bug fixes
- workflow reliability improvements
- better error handling and user-facing messages
- documentation improvements
- test coverage for CLI and runtime behavior
- packaging and release improvements

Before opening a PR:

1. check whether an issue already exists
2. keep the PR focused
3. explain what changed and how you verified it

Start here:

- [CONTRIBUTING.md](./CONTRIBUTING.md)

## Workflow Docs

If you want the lower-level architecture and runtime workflow details, start here:

- [CURRENT_IMPLEMENTED_WORKFLOW.md](./CURRENT_IMPLEMENTED_WORKFLOW.md)
- [FINAL_OUTPUT_CHAIN_AUDIT.md](./FINAL_OUTPUT_CHAIN_AUDIT.md)

These documents explain how `datasetId`, `stageId`, runtime workflow state, and output artifacts fit together.

## License

MIT. See [LICENSE](./LICENSE).
