# killstata

killstata is an AI-powered CLI for econometric analysis workflows.

It is designed for users who need reproducible data import, staged preprocessing, econometric estimation, and paper-ready outputs from the command line.

## Install

```bash
npm install -g killstata
```

For source development:

```bash
bun install
```

## Run

```bash
killstata
```

## What It Supports

- Data import from `CSV`, `XLSX`, and `DTA`
- Structured working datasets with tracked stages
- QA, filtering, preprocessing, and rollback workflows
- Econometric methods such as OLS, panel fixed effects, DID-style flows, IV, and PSM-related flows
- Output generation for summaries, regression tables, and deliverables

## Key Design

- Continue from saved artifacts instead of rereading raw files
- Treat preprocessing as tracked stages, not silent overwrites
- Generate outputs from structured result files for better traceability

## Main Package Path

- [packages/killstata](.)

## Repository

- GitHub: `https://github.com/dean-create/KILLSTATA`

## License

MIT
