# Desktop/Web parity and local CLI verification

Date: 2026-10-05

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

## CLI full-suite failures

The full CLI package suite ran 2,169 tests: 2,161 passed, 5 skipped, and 3 failed.

- Two `killstata.runtime-config` subprocess tests passed when rerun alone.
- `test/drive/scripted-stable-composite-panel.test.ts` failed in the full run and once when isolated with the managed Python runtime. The estimate and heterogeneity tool completed, then the scripted model flow ended in `unknown_model_failure` instead of the expected “本轮已暂停” status.
- The temporary managed Python executable was removed between continuation turns, so a later isolated rerun stopped before the scenario at runtime setup. This replay remains an unresolved release gate; its source files were not changed in the Desktop/Web task.
- GitHub push protection rejected the original branch history because the `a037cf2` test fixture used a key-shaped temporary filename. The fixture has been replaced in the candidate snapshot with a non-secret long filename and its redaction test passes; no bypass was used.

## Clean-checkout CI repair

The previous Draft PR #6 head failed GitHub typecheck because the clean checkout lacked `packages/killstata/src/data/file-discovery.ts` and the ignored `trash/killstata-legacy-econometrics/tool/*` sources imported by regression tests. I restored the unmodified `file-discovery.ts` blob from commit `1459e457` and copied the 28 referenced TypeScript oracle modules from committed history `ffcd4e09` into `packages/killstata/test/fixtures/legacy`; the old OLS runner is kept in the same test-only fixture tree. Test imports now resolve without the ignored trash tree. The active main worktree and its modified trash files were not touched.

- CLI typecheck after the repair: passed.
- Focused legacy import/exposure/replay tests: 185 passed; backend stderr: 1 passed; file discovery: 2 passed.
- The repair is committed and pushed as `f9e576b`; GitHub CI is rerunning it now. The previous clean-checkout failure remains the last remote result until that run completes.

## Not verified

- Access from a second physical LAN device.
- A real external model Provider request.
- Native runtime startup on a Linux host.
- Public npm publication. The registry still serves `killstata@0.1.27`; `0.1.30` remains an unpublished candidate pending the review gate and final approval.
