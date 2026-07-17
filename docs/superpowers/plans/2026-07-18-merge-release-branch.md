# Release Branch Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已提交的 `agent/repo-cleanup-20260714` 与 npm 发布链路合并到 `main`，不覆盖并行工作区中未提交的计量验收文件。

**Architecture:** 先把 npm 发布链路作为一个独立、可审计提交写入当前分支；随后在隔离 worktree 中从 `origin/main` 合并该分支并推送。当前工作区的未提交计量实现、`check/` 和 `human.txt` 不进入这次合并。

**Tech Stack:** Git、Bun、npm CLI。

## Global Constraints

- 仅发布已经通过 402/402 测试的 npm 发布链路与当前分支已有提交。
- 不暂存、移动或删除 `check/`、`human.txt` 或未提交的计量文件。
- 合并前后均检查 Git 历史、工作树和 npm registry；正式 npm 发布只在已推送的 `main` 上执行。

---

### Task 1: 固化 npm 发布链路提交

**Files:**
- Modify: `README.md`, `CONTRIBUTING.md`, `PLAN.md`, `PROGRESS.md`
- Create: `docs/npm-release.md`, `docs/progress/2026-07-17.md`, `packages/killstata/script/{pack-release,release-core,release}.ts`, `packages/killstata/test/release/release-core.test.ts`
- Delete: `packages/killstata/script/publish.ts`, `packages/killstata/script/release-windows.ts`

- [ ] **Step 1: 暂存仅发布链路文件**

Run the explicit path-only `git add` command; do not use `git add .`.

- [ ] **Step 2: 提交发布链路**

Run: `git commit -m "build: harden npm multi-platform release"`

Expected: one commit containing only release scripts, release documentation, release tests and restored README screenshots.

### Task 2: 在隔离 worktree 合并到 main

**Files:** none; Git history only.

- [ ] **Step 1: 创建临时 main worktree**

Run: `git worktree add <temporary-path> origin/main`

- [ ] **Step 2: 合并发布分支**

Run: `git merge --no-ff agent/repo-cleanup-20260714`

Expected: either a merge commit or explicit conflict resolution before continuing.

- [ ] **Step 3: 验证合并内容**

Run targeted release tests, typecheck, `git diff --check`, and compare `main` against the source branch.

### Task 3: 推送并发布 npm

**Files:** npm registry only.

- [ ] **Step 1: 推送 main**

Run: `git push origin HEAD:main`

- [ ] **Step 2: 正式发布**

Run: `bun run --cwd packages/killstata release:npm --version 0.1.26`

- [ ] **Step 3: 逐包核验**

Run `npm view` for all 12 packages and assert `killstata@latest` is `0.1.26`.
