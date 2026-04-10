# Contributing to KILLSTATA

Thanks for contributing.

This repository is now centered on the CLI core, so the highest-value contributions are the ones that improve reliability, traceability, analysis quality, packaging, and developer clarity.

## Good Contribution Types

- bug fixes
- CLI workflow reliability improvements
- better error messages and fallback behavior
- documentation improvements
- tests for runtime, CLI, and packaging behavior
- release and distribution improvements

## Before You Open A PR

1. Check whether an issue already exists.
2. Keep the change focused.
3. Explain what changed and how you verified it.
4. Avoid mixing refactors, docs changes, and behavior changes in one giant PR.

If you are planning a large feature, start with an issue or discussion first. It saves everyone from surprise architecture fanfiction.

## Development Setup

Requirements:

- Bun 1.3+
- Node.js 18+

Install dependencies from the repo root:

```bash
bun install
```

## Useful Commands

Typecheck the workspace:

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

Dry-run the automated Windows npm release:

```bash
bun run --cwd packages/killstata release:windows:latest --dry-run
```

Run the automated Windows npm release:

```bash
$env:NPM_TOKEN="your_npm_token"
bun run --cwd packages/killstata release:windows:latest
```

Run the CLI from source:

```bash
bun dev
```

## Repository Layout

Important paths:

- `packages/killstata`: main CLI package
- `packages/plugin`: plugin-related code
- `packages/script`: shared scripts
- `packages/sdk/js`: SDK code
- `packages/util`: shared utilities

If you are changing user-facing workflow behavior, the most important code usually lives in `packages/killstata`.

## Pull Request Expectations

### Keep It Reviewable

- prefer small PRs over giant repo-wide rewrites
- explain the problem first, then the fix
- include reproduction or verification steps

### If You Change Behavior

Please say:

- what changed
- why it changed
- how you verified it
- whether there are edge cases or known tradeoffs

### If You Change Docs Only

Say so clearly in the PR description. Review goes faster when people do not have to play detective.

### Commit Style

Conventional-style commit prefixes are preferred:

- `feat:`
- `fix:`
- `docs:`
- `chore:`
- `refactor:`
- `test:`

Examples:

- `docs: clarify Windows-first npm packaging`
- `fix: handle missing stage artifact gracefully`
- `test: add regression table output coverage`

## Style Notes

General preferences:

- keep logic explicit
- avoid vague abstractions
- use precise types
- prefer traceable behavior over clever shortcuts
- preserve user-facing clarity when handling failures

In short: boring and correct beats magical and flaky.

## Reporting Issues

When opening an issue, try to include:

- operating system
- command you ran
- expected behavior
- actual behavior
- error output or logs
- sample dataset shape if relevant

If the bug is data-specific, describe the schema and workflow context without posting sensitive data.

## Questions

If you are unsure whether a change fits the project, open an issue first.

That is not bureaucracy. That is just cheaper than rebuilding the same thing twice.
