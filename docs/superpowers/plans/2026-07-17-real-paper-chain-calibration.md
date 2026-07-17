# Real Paper Econometrics Chain Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development for every behavior change. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `/Users/cw/Desktop/ks/test` 的两份真实论文 Excel，校准 `Excel → 数据画像与 QA → DeepSeek 工具选择与参数 → 独立计量工具 → 后端结果 → 中文总结` 全链路。

**Architecture:** 把校准拆成四层：数据事实契约、离线工具调用契约、真实后端数值、真实 DeepSeek 路由。每层单独给出失败原因；不把外部大文件复制进仓库，改用 SHA-256 锁定来源，并将真实数据测试设为显式 E2E 命令，避免 CI 环境缺文件时假绿或误红。

**Tech Stack:** Bun test、TypeScript、KillStata `DataImportTool`/独立计量工具、受管 Python、PyFixest/linearmodels、DeepSeek OpenAI-compatible SDK。

## Global Constraints

- 原始 Excel 只读，不修改、不另存覆盖。
- 默认数据目录为 `/Users/cw/Desktop/ks/test`，可用 `KILLSTATA_REAL_PAPER_DATA_DIR` 显式覆盖。
- `did.xlsx` SHA-256 固定为 `1f906de3652b904a1436b1e5169a049ac2bbc948001b072bb2b349b92c7bd5db`。
- `test_datasets.xlsx` SHA-256 固定为 `a001c91e746b69d37cb3beeb46b1059065691fa532cb65b1e462eb4c10a02927`。
- 模型只能调用已注册的强类型工具；不得恢复万能 `methodName/options` 入口。
- 不能因工具失败自动换估计量；失败必须明确归因到数据、参数、识别设计或后端。
- 真实数据 E2E 缺文件、缺 Python 或哈希漂移时必须失败并给出修复指引，禁止静默跳过。
- 不把路径、原始行级数据、公式别名或 traceback 放进模型中文总结。

---

### Task 1: Freeze the two workbook contracts

**Files:**
- Create: `test/real-paper-chain/dataset-contract.json`
- Create: `packages/killstata/test/helpers/real-paper-datasets.ts`
- Test: `packages/killstata/test/tool/real-paper-data-chain.e2e.ts`

**Interfaces:**
- Produces: `resolveRealPaperDatasets(): { didPath: string; digitalPath: string }`
- Produces: `verifyRealPaperDataset(path, expectedSha256): void`
- Consumes: `KILLSTATA_REAL_PAPER_DATA_DIR` or the fixed local default.

- [ ] **Step 1: Write the failing source-contract test**

```ts
test("locks the real paper workbooks by hash before running analysis", () => {
  const files = resolveRealPaperDatasets()
  expect(() => verifyRealPaperDataset(files.didPath, contract.did.sha256)).not.toThrow()
  expect(() => verifyRealPaperDataset(files.digitalPath, contract.digital.sha256)).not.toThrow()
})
```

- [ ] **Step 2: Run it and verify RED**

Run: `bun test test/tool/real-paper-data-chain.e2e.ts`

Expected: FAIL because `resolveRealPaperDatasets` does not exist.

- [ ] **Step 3: Implement the minimal resolver and SHA-256 verifier**

The verifier must reject missing files and hash drift with the exact file name and expected hash. It must never skip.

- [ ] **Step 4: Verify workbook facts through the real import path**

For `did.xlsx`, import named sheet `Data_原始编码` and assert 4709 rows, 35 columns, Chinese headers intact. For `test_datasets.xlsx`, import `Sheet1` and assert 9683 rows, 8 columns.

- [ ] **Step 5: Run the source-contract tests GREEN**

Run: `KILLSTATA_PYTHON="$HOME/.killstata/venv/bin/python" bun test test/tool/real-paper-data-chain.e2e.ts`

Expected: PASS with both exact hashes and row/column contracts.

---

### Task 2: Turn the observed panel risks into QA gates

**Files:**
- Modify: `packages/killstata/test/tool/real-paper-data-chain.e2e.ts`
- Modify only after RED proves a gap: `packages/killstata/src/tool/econometrics-smart.ts`
- Modify only after RED proves a gap: `packages/killstata/src/session/system.ts`

**Interfaces:**
- Consumes: canonical `datasetId/stageId` returned by real `data_import`.
- Produces: explicit QA results for `city + year`, `地区 + 年份`, and `省份 + 地区 + 年份`.

- [ ] **Step 1: Assert the DID panel contract**

Run QA with `entityVar="city"`, `timeVar="year"`; assert no duplicate keys. Assert the source facts: 277 entities, 17 periods, binary `did`, 98 ever-treated, 179 never-treated, cohorts 2012/2013/2014, no treatment reversal.

- [ ] **Step 2: Assert the cohort-column parsing hazard**

Assert `time` contains numeric 2012–2014 plus 3043 text values equal to `"36"`. The chain must not call `did2s` or saturated event study with this raw column; the returned repair guidance must say to normalize never-treated cohorts and derive relative time first.

- [ ] **Step 3: Assert the digital panel key hazard**

Run QA with `entityVar="地区"`, `timeVar="年份"`; assert it blocks or warns on 23 duplicate entity-time rows. Verify independently that `省份 + 地区` defines 421 entities with 23 periods and zero duplicate keys.

- [ ] **Step 4: Add the smallest repair only if a gate is missing**

If current QA lets duplicate keys through, make it block FE. If recommendation prefers `省份` over the user-declared `地区`, keep explicit user roles authoritative. Do not add a general formula language or automatic estimator switching.

- [ ] **Step 5: Verify QA RED→GREEN**

Run: `KILLSTATA_PYTHON="$HOME/.killstata/venv/bin/python" bun test test/tool/real-paper-data-chain.e2e.ts`

Expected: the valid DID panel passes; the raw cohort and ambiguous digital key are rejected with actionable Chinese guidance.

---

### Task 3: Calibrate offline research intents and strict tool arguments

**Files:**
- Create: `packages/killstata/test/fixtures/real-paper-intents/did-panel.json`
- Create: `packages/killstata/test/fixtures/real-paper-intents/digital-panel.json`
- Create: `packages/killstata/test/tool/real-paper-intent-routing.test.ts`

**Interfaces:**
- Fixture shape: `{ id, dataset, prompt, expectedTool, expectedArgs, forbiddenTools, rationale }`.
- Produces: strict-schema validation for every expected call through `ToolRegistry.tools()`.

- [ ] **Step 1: Add positive baseline and robustness cases**

Include these exact routes:

1. `经济发展水平 ~ did + 人口密度 + 金融发展程度 + 城镇化水平 + 产业结构整体升级 + 产业结构高级化 + 教育水平支出 + 人力资本`, city/year FE → `panel_fe_regression` with `entityVar="city"`, `timeVar="year"`, `clusterVar="city"`.
2. Same design with `人均GDP`, `高质量发展指数`, and `包容性TFP指数` as alternative outcomes → repeated `panel_fe_regression` calls, never automatic estimator replacement.
3. Digital panel: `数字普惠金融指数` on the four digital infrastructure measures with entity/year FE → must request or use a validated province-region composite key before `panel_fe_regression`.

- [ ] **Step 2: Add mechanism and heterogeneity cases without overclaiming**

Mechanism screens use `创新指数`, `产业结构高级化2`, `金融发展程度` as outcomes in separate FE regressions and must be labelled associative mechanism evidence, not formal mediation proof. Heterogeneity requests lacking a declared grouping variable must ask for the group definition instead of inventing eastern/central/western membership.

- [ ] **Step 3: Add negative method-selection cases**

- Raw `did.xlsx` must not route to `did_static` because it is a 17-period staggered panel, not a 2×2 group/post design.
- Raw `time` must not be passed as `relativeTimeVar` or cohort without normalization.
- No column may be guessed as an IV; `iv_2sls` is forbidden without a user-supplied instrument and exclusion rationale.
- PSM must not treat 4709 city-year rows as independent cross-sectional units without a declared baseline period and estimand.
- OLS must not encode Chinese city/year strings as ordinary controls when FE is requested.

- [ ] **Step 4: Run offline routing schema tests**

Run: `bun test test/tool/real-paper-intent-routing.test.ts`

Expected: every positive expected argument object passes its dedicated Zod schema; every forbidden free-form or misrouted argument fails.

---

### Task 4: Execute real fixed-effect, robustness, and mechanism regressions

**Files:**
- Modify: `packages/killstata/test/tool/real-paper-data-chain.e2e.ts`
- Create: `test/real-paper-chain/backend-results.json`

**Interfaces:**
- Consumes: canonical DID stage after import, recommendation, and QA.
- Produces: bounded golden metrics for the treatment coefficient, clustered SE, p-value, sample size, and confidence interval.

- [ ] **Step 1: Write the fixed-effect baseline test**

Call `panel_fe_regression` with the exact variables from Task 3. Assert 4709 observations, 277 entity clusters, finite coefficient/SE/p-value, entity and year FE, and no path/formula leakage in the Chinese output.

- [ ] **Step 2: Cross-check with the independent HDFE tool**

Call `hdfe_regression` with `fixedEffects=["city","year"]` and `clusterVars=["city"]`. Assert the `did` point estimate matches `panel_fe_regression` within `1e-6`; record but do not hide legitimate small-sample SE convention differences.

- [ ] **Step 3: Run outcome robustness cases**

Run the same FE design for `人均GDP`, `高质量发展指数`, `包容性TFP指数`. Assert each result is finite, grounded, and reports the actual sample rather than reusing the first regression.

- [ ] **Step 4: Run mechanism-screen cases**

Run separate FE regressions for `创新指数`, `产业结构高级化2`, and `金融发展程度`. Assert summaries use “机制线索/关联证据” and never claim a mediated causal effect from significance alone.

- [ ] **Step 5: Persist a compact reproducibility record**

Write only source hashes, tool IDs, arguments, bounded metrics, backend/version, and test timestamp to `test/real-paper-chain/backend-results.json`; never copy raw rows.

---

### Task 5: Measure real DeepSeek tool selection

**Files:**
- Create: `packages/killstata/script/real-paper-tool-routing-calibration.ts`
- Create: `test/real-paper-chain/deepseek-routing-results.json`

**Interfaces:**
- Consumes: the Task 3 fixtures, `SystemPrompt.provider()`, actual `ToolRegistry` schemas, and configured DeepSeek auth.
- Produces: `{ fixtureId, selectedTool, args, schemaValid, violations }[]` without executing estimators.

- [ ] **Step 1: Write an offline parser test for captured tool calls**

It must reject unknown tools, JSON strings that cannot normalize to objects, extra keys, missing canonical stage IDs, and forbidden method substitutions.

- [ ] **Step 2: Call DeepSeek through the existing OpenAI-compatible provider**

Use temperature 0, one required tool call, the real KillStata system prompt, and the currently registered tools. Tool executors return a fixed calibration marker so this step measures selection and arguments only.

- [ ] **Step 3: Score all fixtures**

Score exact tool selection, required role fields, forbidden fields, and schema validity separately. Do not collapse them into one pass rate because each failure requires a different repair.

- [ ] **Step 4: Apply prompt/tool-description repairs only after failures are observed**

Change the smallest responsible description or system rule; do not hard-code full user sentences into production routing.

- [ ] **Step 5: Rerun and save the bounded calibration report**

Run: `bun run script/real-paper-tool-routing-calibration.ts`

Expected: a JSON result per fixture, with no API key, source path, raw row, chain-of-thought, or unbounded provider response.

---

### Task 6: Final adversarial verification and handoff

**Files:**
- Create: `test/real-paper-chain/VERIFICATION.md`
- Modify: `PLAN.md`
- Modify: `PROGRESS.md`

- [ ] **Step 1: Run focused offline and real-data suites**

```bash
bun test test/tool/real-paper-intent-routing.test.ts
KILLSTATA_PYTHON="$HOME/.killstata/venv/bin/python" bun test test/tool/real-paper-data-chain.e2e.ts
```

- [ ] **Step 2: Run collateral gates**

```bash
bun run typecheck
KILLSTATA_PYTHON="$HOME/.killstata/venv/bin/python" bun test
git diff --check
```

- [ ] **Step 3: Review false-positive risks**

Confirm no test silently returns when Python/data/auth is missing; confirm real-data and live-model tests clearly distinguish opt-in environment requirements from default CI.

- [ ] **Step 4: Record remaining capability gaps**

At minimum classify: composite entity creation, cohort normalization/relative-time derivation, scientifically declared heterogeneity groups, and live DeepSeek variability. None may be advertised as completed until its corresponding test is green.
