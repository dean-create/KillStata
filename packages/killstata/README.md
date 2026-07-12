# killstata

[![npm version](https://img.shields.io/npm/v/killstata?label=npm)](https://www.npmjs.com/package/killstata)
![Windows first](https://img.shields.io/badge/platform-Windows%20first-0078D4)

killstata is an AI-native CLI for econometric analysis workflows.

It is designed for users who need reproducible data import, staged preprocessing, econometric estimation, and paper-ready outputs from the command line.

## Install

Recommended for Windows users:

```bash
npm i -g killstata@latest
```

For source development:

```bash
bun install
```

## Quick Start

```bash
killstata
killstata --version
killstata init
killstata skills list
```

## Screenshots

![KillStata start screen](https://raw.githubusercontent.com/dean-create/KillStata/main/docs/images/killstata-home.png)

![KillStata capability view](https://raw.githubusercontent.com/dean-create/KillStata/main/docs/images/killstata-capabilities.png)

## Common Prompt Examples

- `Import this Excel file and show me the schema.`
- `Run QA on the current dataset and tell me if panel keys are duplicated.`
- `Use the current panel stage and run a fixed-effects regression with clustered SE.`
- `Export a three-line table and a short result summary.`

## What It Supports

- Data import from `CSV`, `XLSX`, and `DTA`
- Structured working datasets with tracked stages
- QA, filtering, preprocessing, and rollback workflows
- Econometric methods such as OLS, panel fixed effects, DID-style flows, IV, and PSM-related flows
- Output generation for summaries, regression tables, and deliverables

## Output Layout

Typical artifact layout:

```text
.killstata/
  datasets/
    <datasetId>/
      manifest.json
      stages/
      inspection/
      meta/
      audit/
      reports/
```

## Install Troubleshooting

If installation succeeds but the CLI still does not start, retry the Windows-first install path:

```bash
npm i -g killstata@latest
```

If you are developing from source on a platform without a bundled native binary, install Bun:

- https://bun.sh

## Key Design

- Continue from saved artifacts instead of rereading raw files
- Treat preprocessing as tracked stages, not silent overwrites
- Generate outputs from structured result files for better traceability

## Repository

- GitHub: `https://github.com/dean-create/KillStata`

## License

MIT
