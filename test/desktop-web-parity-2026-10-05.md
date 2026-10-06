# Desktop/Web parity and local CLI verification

Date: 2026-10-06

## Passed

- Desktop full suite, serialized: 365 passed, 2 skipped.
- Desktop TypeScript check: passed.
- KillStata CLI TypeScript check: passed.
- CLI Web command tests: 9 passed, including the `--share` help contract.
- Candidate Web production build and Tauri debug bundle: passed.
- Web UI at 1440×900 and 390×844: passed visual checks. At 390×844, opening Settings from the workspace drawer now closes the drawer so the full Settings panel remains usable.
- Desktop and Web showed the same frontend “1” research record and shared Settings content. The `MessageThread` regression and Desktop/Web integration tests confirm reasoning stays collapsed while the main reply is visible.
- Final npm dry-run for `0.1.30`: 12 artifacts (11 native targets plus launcher); every tarball SHA-512 matched the release manifest; dry-run published nothing.
- Isolated npm prefix install of the final macOS arm64 native tarball and launcher: `killstata --version` returned `0.1.30`; `killstata web --help`, default loopback startup, and `--share` startup worked.
- LAN share smoke used a fake profile and a synthetic workspace on the same Mac. A visitor connected to Core and saw only a sanitized, read-only model profile. No dataset was submitted to an external model provider.
- `git diff --check` passed for the feature delta against its `a037cf2` implementation base. Preparing a GitHub branch directly from `origin/main` exposes older trailing whitespace in that base snapshot; those unrelated lines were not normalized in this task.

## CLI full-suite and Python environment repair

- The previous GitHub run reported 2,089 pass, 69 skip, and 11 fail. Its test step supplied `KILLSTATA_PYTHON=python` and relative `PYTHONPATH`; seven model tests also overwrote that setting with a developer-home path. The workflow now passes the absolute `actions/setup-python` interpreter and repository path, and the tests honor the injected interpreter.
- Clean-home failures also exposed a hard-coded `/Users/cw` permission fixture and a panel fixture that rendered an undetermined Hausman result as random effects. The permission path now comes from `Global.Path.data`; panel text and its schema preserve the undetermined state.
- Final local CI-shaped suite: 2,170 tests across 309 files, 2 snapshots, **2,165 pass / 5 skip / 0 fail**, 10,533 assertions. CLI typecheck, `git diff --check`, and workflow YAML parsing pass.
- The PR has not yet received a fresh GitHub run for these fixes. The previous red check belongs to the earlier PR head; push this work and inspect the new run before release review.
- GitHub push protection had rejected the original history's key-shaped test fixture filename. The candidate uses a harmless long fixture name; no bypass was used.

## Clean-checkout CI repair

The previous Draft PR #6 head failed GitHub typecheck because the clean checkout lacked `packages/killstata/src/data/file-discovery.ts` and the ignored `trash/killstata-legacy-econometrics/tool/*` sources imported by regression tests. I restored the unmodified `file-discovery.ts` blob from commit `1459e457` and copied the 28 referenced TypeScript oracle modules from committed history `ffcd4e09` into `packages/killstata/test/fixtures/legacy`; the old OLS runner is kept in the same test-only fixture tree. Test imports now resolve without the ignored trash tree. The active main worktree and its modified trash files were not touched.

- CLI typecheck after the repair: passed.
- Focused legacy import/exposure/replay tests: 185 passed; backend stderr: 1 passed; file discovery: 2 passed.
- The repair is committed and pushed as `f9e576b`; local CLI typecheck and focused tests pass. GitHub then ran the full test suite, but 11 Python-dependent tests failed during runtime preparation because the workflow supplied the short command `python` as `KILLSTATA_PYTHON`.
- A full local CI-shaped rerun with the locked Python environment initially showed three unrelated clean-home issues: the log test classified `/tmp` as a temporary path, permission tests hard-coded the developer home, and schema normalization ignored the explicit interpreter outside an Instance context. The final rerun used the machine's normal `HOME` and the CI-style absolute interpreter.
- The permission fixture now derives its runner from `Global.Path.data`; Python model tests use injected `KILLSTATA_PYTHON`; the schema normalization test checks the explicit interpreter first. The legacy panel fixture and schema now retain an explicitly undetermined Hausman recommendation rather than defaulting to RE.
- Final local Core rerun: 2165 pass, 5 skip, 0 fail; 2170 tests across 309 files, 10533 assertions. The absolute-interpreter workflow change parses as YAML; CLI typecheck and `git diff --check` pass. These fixes are not yet on the PR head; fresh GitHub CI is still required.

## Not verified

- Access from a second physical LAN device.
- A real external model Provider request.
- Native runtime startup on a Linux host.
- Public npm publication. The registry still serves `killstata@0.1.27`; `0.1.30` remains an unpublished candidate pending the review gate and final approval.
