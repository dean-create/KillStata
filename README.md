# KillStata

[![npm version](https://img.shields.io/npm/v/killstata?label=npm)](https://www.npmjs.com/package/killstata)
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
- [Screenshots](#screenshots)
- [Core Features](#core-features)
- [Installation](#installation)
- [Common Commands](#common-commands)
- [Prompt Examples](#prompt-examples)
- [Artifacts Layout](#artifacts-layout)
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

## Screenshots

### Start Screen

![KillStata start screen](./docs/images/killstata-home.png)

### Capability View

![KillStata capability view](./docs/images/killstata-capabilities.png)

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

### Windows Users

```bash
npm i -g killstata@latest
```

This is the recommended install path right now. Windows users should get the bundled native binary and be able to run the CLI out of the box.

### Source Development

If you are working from source:

```bash
bun install
```

### 新手引导

If this is your first time installing KillStata, run the basic setup before starting real work:

```bash
killstata config
```

This command helps you complete the initial configuration so the CLI is ready to use.

Recommended local prerequisites:

- Python should already be installed and available in `PATH`
- A normal terminal environment should be available for running CLI commands
- If you are working from source, keep `bun` installed as well

## Common Commands

```bash
killstata
killstata --version
killstata init
killstata skills list
```

What they do:

- `killstata`: start the interactive CLI
- `killstata --version`: verify the installed version
- `killstata init`: set up the local Python econometrics environment
- `killstata skills list`: inspect built-in and local skills

## Prompt Examples

Once the CLI starts, useful prompts look like this:

- `Import this Excel file and show me the schema.`
- `Run QA on the current dataset and tell me if panel keys are duplicated.`
- `Use the current panel stage and run a fixed-effects regression with clustered SE.`
- `Export a three-line table and a short result summary.`
- `Continue from the current artifact instead of rereading the raw file.`

## Artifacts Layout

KillStata stores analysis outputs as tracked artifacts instead of treating the raw spreadsheet as permanent working memory.

Typical layout:

```text
.killstata/
  datasets/
    <datasetId>/
      manifest.json
      stages/
        stage_000_*.parquet
      inspection/
        stage_000_*.csv
        stage_000_*.xlsx
      meta/
        *_schema.json
        *_labels.json
      audit/
        *_summary.json
        *_log.md
      reports/
        main/
          results.json
          diagnostics.json
          numeric_snapshot.json
          three_line_table.tex
          three_line_table.docx
          delivery_result_summary.md
```

Why this matters:

- `manifest.json` records the source of truth
- `stages/` stores processing history
- `inspection/` stores user-readable table outputs
- `reports/` stores econometric results and paper-ready deliverables

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

Windows-priority npm release dry run:

```bash
bun run --cwd packages/killstata release:windows:latest --dry-run
```

Windows-priority npm release:

```bash
$env:NPM_TOKEN="your_npm_token"
bun run --cwd packages/killstata release:windows:latest
```

What the release script does:

- checks that you are on `main` or `master`
- checks that the branch is in sync with `origin`
- runs workspace typecheck before publish
- publishes the Windows-first npm packages
- verifies the published version and dist-tag on npm

## FAQ

### Do I need Stata installed?

No. KillStata is designed as its own CLI workflow layer. It can import common research data formats and run its own analysis pipeline without requiring a local Stata installation.
If you already have Stata 17 or newer, you can also use Stata through MCP integration.

### Does it keep rereading the raw Excel file forever?

No. Raw files are only the entry point. After import, KillStata is designed to continue from structured artifacts and tracked stages rather than repeatedly treating the original spreadsheet as the source of truth.

### Why is the project Windows-first right now?

Because the current npm packaging and release flow are optimized for Windows users first. Cross-platform distribution is still important, but Windows is the current stability target.

### Can it handle large datasets or many tables?

That is exactly why the project uses an artifact-first design. The goal is to avoid shoving raw tables into prompt context and instead continue from saved dataset stages, summaries, diagnostics, and result artifacts.

### What should I do if installation fails?

For Windows users, retry the recommended path first:

```bash
npm i -g killstata@latest
```

If the CLI still cannot find a native binary, reinstall the package and then check:

```bash
killstata --version
```

For source-mode development on unsupported platforms, install Bun:

- https://bun.sh

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

This project is licensed under the Apache License 2.0. See the LICENSE file for details.
