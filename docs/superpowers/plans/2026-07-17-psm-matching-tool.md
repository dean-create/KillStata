# PSM Matching Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use inline TDD task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose one safe, reproducible nearest-neighbour propensity-score matching tool that estimates the ATT for matched treated units without inventing invalid statistical inference.

**Architecture:** The model calls one strict TypeScript tool with only the canonical dataset stage, outcome, treatment, and pre-treatment covariates. The existing Python runner estimates the Logit propensity score, performs deterministic 1:1 nearest-neighbour matching with replacement on the logit score and a fixed 0.2-SD caliper, then publishes only an ATT plus aggregate matching and balance diagnostics. A failed support or balance check publishes no effect estimate.

**Tech Stack:** TypeScript, Bun/Zod, Python 3.12, pandas, NumPy, statsmodels Logit, existing KillStata managed-process Harness.

## Global Constraints

- The model must never supply a file path, Python command, output directory, matching ratio, caliper, estimand, or arbitrary `options`.
- The only estimand is ATT among treated units retained by the fixed matching rule; it must never be labelled ATE or ATT for all treated units when units are dropped.
- Matching is 1:1 nearest-neighbour with replacement; exact distance ties split the matched-control weight equally and source-row order is the deterministic final tie breaker only when needed for serialization.
- The caliper is `0.2 * sample_sd(logit(propensity_score))`; treated observations without an eligible control are excluded from the matched estimand and their count must be reported.
- Post-match absolute standardized mean difference must be at most `0.10` for every supplied covariate before an effect can be published.
- Do not emit bootstrap SE, p-value, confidence interval, significance language, or a numeric snapshot that could be mistaken for valid inference. Abadie–Imbens (2008) shows ordinary bootstrap inference is generally invalid for fixed-neighbour matching.
- All failure paths must remove the Harness-owned output directory; caller-owned output directories remain rejected.
- Do not edit Claude-owned `docs/methods/` or replay framework beyond registering this tool and adding its own fixture directory.

---

### Task 1: Freeze the model contract and workflow semantics

**Files:**
- Modify: `packages/killstata/test/runtime/econometrics-tool-exposure.test.ts`
- Modify: `packages/killstata/test/runtime/econometrics-tool-lifecycle.test.ts`
- Modify: `packages/killstata/src/tool/econometrics-method-tools.ts`
- Modify: `packages/killstata/src/runtime/tool-catalog.ts`
- Modify: `packages/killstata/src/runtime/workflow.ts`
- Modify: `packages/killstata/src/runtime/analysis-user-view.ts`

**Interfaces:**
- Consumes: canonical `datasetId`, `stageId`, `dependentVar`, `treatmentVar`, `covariates`.
- Produces: model-visible `psm_matching` estimator classified as an estimate, not a diagnostic.

- [ ] **Step 1: Write failing contract/lifecycle tests**

```ts
const matching = tools.find((tool) => tool.id === "psm_matching")
expect(matching?.parameters.safeParse({
  datasetId: "dataset_1", stageId: "stage_001", dependentVar: "re78",
  treatmentVar: "treat", covariates: ["age", "education"],
}).success).toBe(true)
expect(matching?.parameters.safeParse({
  datasetId: "dataset_1", stageId: "stage_001", dependentVar: "re78",
  treatmentVar: "treat", covariates: ["age"], matchingRatio: 2,
}).success).toBe(false)
expect(retryStageForToolFailure("psm_matching", "estimation_failure")).toBe("estimate")
```

- [ ] **Step 2: Run RED**

Run: `bun test test/runtime/econometrics-tool-exposure.test.ts test/runtime/econometrics-tool-lifecycle.test.ts`

Expected: `psm_matching` is absent from the safe catalog and lifecycle.

- [ ] **Step 3: Implement the smallest strict surface**

```ts
const psmMatchingParameters = z.object({
  ...canonicalDataSourceFields,
  dependentVar: columnName.describe("结果变量列名"),
  treatmentVar: columnName.describe("严格以 0/1 编码的处理变量列名"),
  covariates: z.array(columnName).min(1, "至少需要一个处理前协变量"),
}).strict().superRefine((value, ctx) => validateColumnRoles(value, ctx, ["dependentVar", "treatmentVar"]))
```

Register `PsmMatchingTool` in `ProductionEconometricsTools`, the workflow executable loader, analysis tool catalog, and Chinese user-view labels. Its description must state “ATT（已匹配处理组）”, fixed rule, and no significance inference.

- [ ] **Step 4: Run GREEN**

Run: `bun test test/runtime/econometrics-tool-exposure.test.ts test/runtime/econometrics-tool-lifecycle.test.ts`

Expected: all existing tests plus the strict matching assertions pass.

### Task 2: Replace the copied matching algorithm with a deterministic, diagnostic ATT implementation

**Files:**
- Modify: `packages/killstata/python/econometrics/econometric_algorithm.py`
- Modify: `packages/killstata/src/tool/econometrics.ts`
- Create: `packages/killstata/test/tool/propensity-score-matching.test.ts`

**Interfaces:**
- Consumes: `outcome`, binary `treatment`, strictly interior `propensity_score`, numeric covariate frame.
- Produces: `{ att, matched_treated_count, unmatched_treated_count, control_count, reused_control_count, caliper, max_match_distance, pre_match_smd, post_match_smd, balance_pass }`.

- [ ] **Step 1: Write a failing real-Python test**

```ts
expect(result.title).toBe("倾向得分最近邻匹配")
expect(result.output).toContain("已匹配处理组的 ATT")
expect(result.output).not.toMatch(/p 值|置信区间|显著/)
expect(readResult(root, source.datasetId).att).toBeCloseTo(2, 8)
expect(readResult(root, source.datasetId).post_match_max_abs_smd).toBeLessThanOrEqual(0.1)
```

The deterministic fixture must contain a treatment effect of 2, overlapping 0/1 treatment, two nonconstant covariates, and no exact match tie. Add a second test with an unmatched treated observation and assert that the result says `ATT（已匹配处理组）`, records one exclusion, and never labels it as all-treated ATT. Add a third test where post-match balance exceeds 0.10 and assert no published `results.json` or artifact remains.

- [ ] **Step 2: Run RED**

Run: `KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python bun test test/tool/propensity-score-matching.test.ts`

Expected: module/tool missing or legacy output incorrectly exposes ATE/invalid inference.

- [ ] **Step 3: Implement the fixed estimator**

```python
def propensity_score_nearest_neighbor_att(outcome, treatment, propensity_score, covariates):
    logits = np.log(scores / (1.0 - scores))
    caliper = 0.2 * float(np.std(logits, ddof=1))
    # For every treated row, retain controls at the smallest distance within the caliper.
    # Exact ties share one treated observation's control weight equally.
    # Return aggregate diagnostics and weighted post-match SMDs; never calculate bootstrap inference.
```

In the embedded runner, use the new function only for `psm_matching`; emit a scalar ATT coefficient table with no SE/p-value, a diagnostics JSON containing pre/post SMD maps and matching counts, and an output label `PSM nearest-neighbour ATT`. Reject non-finite outcomes, no eligible treated matches, caliper collapse, and failed post-match balance before artifact publication.

- [ ] **Step 4: Run GREEN**

Run: `KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python bun test test/tool/propensity-score-matching.test.ts`

Expected: deterministic ATT, unmatched-unit labelling, balance rejection, tie behavior, and no-inference output all pass.

### Task 3: Add LaLonde/NSW benchmark and model-call replay

**Files:**
- Create: `packages/killstata/test/fixtures/golden/lalonde_nsw_dw.csv`
- Create: `packages/killstata/test/tool/psm-matching-golden.test.ts`
- Modify: `packages/killstata/test/tool/replay-fixtures.test.ts`
- Create: `packages/killstata/test/fixtures/replay/psm_matching/pass-01-lalonde-nsw.json`
- Create: `packages/killstata/test/fixtures/replay/psm_matching/pass-02-json-string-args.json`
- Create: `packages/killstata/test/fixtures/replay/psm_matching/reject-01-missing-outcome.json`
- Create: `packages/killstata/test/fixtures/replay/psm_matching/reject-02-treatment-in-covariates.json`
- Create: `packages/killstata/test/fixtures/replay/psm_matching/reject-03-free-caliper.json`

**Interfaces:**
- Consumes: NBER Dehejia–Wahba NSW treated/control data; fields `treat, age, education, black, hispanic, married, nodegree, re74, re75, re78`.
- Produces: a fixed, versioned aggregate benchmark for this exact implementation and a five-case model-argument replay gate.

- [ ] **Step 1: Write failing benchmark and replay registration tests**

```ts
expect(result.att).toBeCloseTo(expected.att, 10)
expect(result.rows_used).toBe(expected.rowsUsed)
expect(result.unmatched_treated_count).toBe(expected.unmatchedTreated)
expect(result.post_match_max_abs_smd).toBeLessThanOrEqual(0.1)
```

The expected file must be generated once by an independent, auditable NumPy reference implementation in the test, not copied from the production function.

- [ ] **Step 2: Run RED**

Run: `bun test test/tool/psm-matching-golden.test.ts test/tool/replay-fixtures.test.ts`

Expected: missing fixture/tool registration or disagreement with the legacy implementation.

- [ ] **Step 3: Add the versioned fixture and reference oracle**

Download the source only from Rajeev Dehejia's NBER data page, retain the source URL and SHA-256 in a sidecar JSON, and build the repository CSV from the published `nsw_dw.dta` fields. The test's oracle must implement sorting, caliper, tied-control weights, ATT, and weighted SMD independently of `econometric_algorithm.py`.

- [ ] **Step 4: Run GREEN**

Run: `KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python bun test test/tool/psm-matching-golden.test.ts test/tool/replay-fixtures.test.ts`

Expected: LaLonde/NSW benchmark and every replay fixture pass; invalid free-caliper/estimand fields are rejected by `.strict()`.

### Task 4: Complete the admission gates and update the handoff

**Files:**
- Modify: `PLAN.md`
- Modify: `PROGRESS.md`
- Coordinate: `docs/methods/psm_matching.md` remains Claude-owned; provide its exact algorithm/benchmark/inference facts in the handoff.

- [ ] **Step 1: Run focused and adversarial verification**

Run:

```bash
/Users/cw/.killstata/venv/bin/python -m py_compile python/econometrics/econometric_algorithm.py
bun run typecheck
KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python bun test test/tool/propensity-score-matching.test.ts test/tool/psm-matching-golden.test.ts test/tool/replay-fixtures.test.ts
git diff --check
```

Expected: all commands exit 0. Also deliberately set `KILLSTATA_PYTHON=/definitely/missing/python` for the matching test and assert a non-zero exit so the test cannot silently skip Python.

- [ ] **Step 2: Run full verification**

Run: `KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python bun test && bun run build`

Expected: 0 test failures and successful Linux/macOS/Windows packages.

- [ ] **Step 3: Update current plans without growing PROGRESS.md past 300 lines**

Replace the current status lines with the actual model-visible count, benchmark classification, inference boundary, and verification counts. Set the next item to `psm_ipw` and preserve all unrelated Claude worktree changes.

## Self-review

- Spec coverage: strict tool contract (Task 1), deterministic matching/caliper/ties/balance/failure cleanup (Task 2), LaLonde/NSW and replay gate (Task 3), harness and release checks (Task 4).
- Placeholder scan: no TODO/TBD steps; each implementation action has an explicit interface and command.
- Type consistency: the contract fields are `datasetId/stageId/dependentVar/treatmentVar/covariates`; the estimator result fields are defined in Task 2 and consumed by Task 3.

## Execution Handoff

The user explicitly requested to continue, so this plan is being executed inline in this session rather than waiting for a plan-choice prompt.
