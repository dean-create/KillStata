# Desktop and Web Parity with Local CLI Sharing Implementation Plan

> **For agentic workers:** Execute this plan inline in task order. Every task has a focused test cycle and a reviewable result.

**Goal:** Ship the shared KillStata research UI through Desktop and a globally installable `killstata web` CLI, with the same default frontend experience and an explicit LAN share link for other people.

**Architecture:** `desktop/src/App.tsx` remains the only research interface. Desktop and browser hosts provide platform adapters for file selection, workspaces, credentials, and the analysis engine. Both surfaces start in `frontend` mode, which records research information without requiring a key or contacting the analysis engine; a user must explicitly connect the analysis core to run analysis. `killstata web --share` exposes the same connected-capable UI over private LAN addresses using a time-bounded bearer link. Visitors can use the host's preconfigured model and Core after explicitly connecting; they cannot view or mutate host credentials. Each visitor selects an opaque workspace ID, and selected files upload to the host only when the visitor submits connected analysis.

**Tech Stack:** SolidJS, Vite, Tauri, Bun CLI, Node.js npm launcher, Bun tests, Vitest, Playwright.

## Global Constraints

- Preserve the shared `desktop/src/App.tsx` surface and keep platform-specific file, workspace, credential, and engine capabilities behind existing adapters.
- Both Tauri and Web default to `frontend`; entering connected mode requires a visible user action and must not read or store an API key before that action.
- `killstata web` binds `127.0.0.1:3080` by default and opens the browser; `--no-open` suppresses the automatic browser launch.
- `killstata web --share` is opt-in, restricts advertised URLs and accepted Host values to local private IPv4 addresses, and requires a time-bounded share token.
- Share visitors may call Core analysis routes after an explicit connection action; credential reads expose only sanitized profile summaries and activation. Credential discovery/mutation, runtime installation, shared preferences, and workspace listing remain owner-only.
- Share visitors receive separate opaque server workspace IDs. Files stay in the visitor's browser until connected analysis is submitted, when the selected file uploads to the host Core and requests use the host administrator's model profile.
- Do not publish the npm package until the isolated install, package integrity, platform smoke, Desktop/Web parity, and review gates pass.

---

### Task 1: Make the shared app default to frontend mode with explicit connection

**Files:**
- Modify: `desktop/src/workspace-mode.ts`
- Test: `desktop/src/workspace-mode.test.ts`
- Modify: `desktop/src/App.tsx`
- Test: `desktop/src/App.test.tsx`
- Modify: `desktop/src/main.tsx`
- Test: `desktop/src/shared-surface-parity.test.tsx`

**Interfaces:**
- `workspaceMode({ isTauri, requestedMode })` returns `connected` only when `requestedMode === "connected"`; otherwise it returns `frontend` for both Tauri and browser hosts.
- `App` accepts `connectionAvailable?: boolean` and `sharedVisitor?: boolean`, initializes internal mode from `mode ?? "frontend"`, and exposes the same “连接分析核心” action in Desktop and Web settings.
- A local user who has not configured a key can enter model settings. A share visitor must select a workspace and can connect only when the host already has a configured profile; the visitor sees a sanitized model summary with all credential mutations hidden.
- `main.tsx` constructs Tauri/Web adapters independently of the initial mode so the shared UI can connect after explicit user action. Browser development without a local Web host continues using demo adapters.

- [x] Write tests proving Tauri defaults to `frontend`, an explicit `connected` request is honored, and frontend submission records research without calling health, commands, credentials, or analysis APIs.
- [x] Run `desktop/src/workspace-mode.test.ts` and the App behavior tests before fixing the mode boundary.
- [x] Change `workspaceMode`, App mode state, connection control, and host adapter selection; the default is now shared across Tauri and browser hosts.
- [x] Run Desktop tests and `bun run typecheck`; the latest Desktop full suite passes.

### Task 2: Make the local Web CLI lazy and usable before model configuration

**Files:**
- Modify: `desktop/scripts/build-web.ts`
- Modify: `desktop/src/main.tsx`
- Modify: `desktop/src/web/credential-store.ts`
- Modify: `packages/killstata/src/cli/cmd/web.ts`
- Test: `packages/killstata/test/cli/web-command.test.ts`
- Test: `packages/killstata/test/web/local-web-workspace-engine.test.ts`

**Interfaces:**
- The Web distribution compiles with `VITE_KILLSTATA_MODE="frontend"` and retains `/api` as the local engine URL for later explicit connection.
- `createLocalWebService` does not activate saved provider credentials or warm a Core at startup. Workspace registry, static assets, and UI preferences remain available.
- The Web credential adapter implements `prepareEngineForAnalysis()` by activating the selected local profile only when the user submits connected analysis.
- Existing `createLocalWebWorkspaceEngine` creates a Core only after an engine-specific request; frontend load and workspace selection must not cause that request.

- [x] Add tests asserting local Web startup performs no credential activation and no Core warmup, while connected analysis activates credentials before health/analysis requests.
- [x] Run the focused CLI/Web tests before changing startup and connection behavior.
- [x] Change the Web build mode to frontend and defer activation/Core startup until explicit connection.
- [x] Run the focused tests, production Web build, and `desktop` typecheck; an installed cold local page renders without API-key configuration.

### Task 3: Keep browser file selection available in frontend mode

**Files:**
- Modify: `desktop/src/main.tsx`
- Modify: `desktop/src/web/workspace-picker.ts`
- Test: `desktop/src/web/workspace-picker.test.ts`
- Test: `desktop/src/App.test.tsx`

**Interfaces:**
- Desktop continues to use Tauri workspace and file pickers.
- Local KillStata Web uses the browser workspace/file adapter in both frontend and connected modes; no absolute client path is sent to Core.
- Shared Web uses a server-created opaque workspace ID plus an IndexedDB file-handle adapter; reselecting a saved directory reuses that ID without listing or exposing other visitor workspaces.
- Visitor file bytes stay in the browser in `frontend` mode and upload to the selected host workspace only after connected analysis is submitted.
- Browser-only development keeps the current preview affordance when no local host workspace API exists.
- Shared mode stores browser file handles locally; selected file bytes leave the visitor's device only after connected analysis is explicitly submitted.

- [x] Add tests for server-created opaque workspace IDs, browser-local file handles, reselecting without workspace listing/ensure, and cancellation.
- [x] Run the focused browser workspace tests before wiring the visitor flow.
- [x] Wire the browser adapters so shared visitors create an opaque workspace on the host while file handles remain in browser IndexedDB.
- [x] Run workspace picker and App tests; verify frontend mode never uploads file bytes and connected mode uploads only on explicit submit.

### Task 4: Add explicit LAN sharing with host-managed analysis

**Files:**
- Modify: `packages/killstata/src/web/local-web-session.ts`
- Test: `packages/killstata/test/web/local-web-session.test.ts`
- Modify: `packages/killstata/src/web/local-web-host.ts`
- Test: `packages/killstata/test/web/local-web-host.test.ts`
- Modify: `packages/killstata/src/cli/cmd/web.ts`
- Test: `packages/killstata/test/cli/web-command.test.ts`
- Modify: `desktop/src/main.tsx`
- Test: `desktop/src/shared-surface-parity.test.tsx`

**Interfaces:**
- `startLocalWebHost({ share?: boolean })` binds loopback when `share` is false and `0.0.0.0` when true.
- Share mode advertises only RFC1918 IPv4 interface addresses, accepts only their exact Host authorities plus loopback, and rejects requests with a non-private remote address.
- Share launch links use a 32-byte random bearer token with a one-hour exchange window and multiple browser exchanges; browser cookies remain `HttpOnly` and `SameSite=Strict`.
- Shared links redirect to `/?share=1`; the common UI retains the same engine connection action. Share-cookie requests can create their own workspace and call Core analysis routes, while only reading sanitized credential summaries and activating the host profile. The owner's loopback session retains full credential management.
- Share-cookie requests receive 404 for credential writes/discovery, runtime inspection/installation, preference APIs, workspace listing, and workspace ensure. Core requests must carry the visitor's opaque workspace ID.
- `killstata web --share` prints the local URL and each private-LAN share URL; it never changes the default bind behavior.

- [x] Add tests for token expiry, private-IP URL derivation, Host allowlisting, public remote rejection, host-owned credentials, workspace scoping, and forbidden credential/runtime routes.
- [x] Run focused session/host/CLI/UI tests; share-token, route, and credential guards pass.
- [x] Implement the opt-in LAN listener, time-bounded share token, sanitized host-profile API, visitor workspace creation, and Core route allowlist.
- [x] Run a local-LAN smoke with the final CLI candidate: share URL exchange, visitor workspace creation, host profile activation, and Core-ready state all pass; the profile is read-only and a synthetic CSV was not submitted to an external model provider.

### Task 5: Package and document the npm entry point

**Files:**
- Modify: `packages/killstata/README.md`
- Modify: `README.md`
- Modify: `packages/killstata/script/build.ts` only if target metadata no longer matches the agreed platform matrix.
- Modify: `packages/killstata/script/pack-release.ts` only if the packaged launcher/assets omit the new Web entry point.
- Test: `packages/killstata/test/cli/web-assets.test.ts`
- Test: `packages/killstata/test/script/release-core.test.ts`

**Interfaces:**
- Document global install: `npm install -g killstata@latest`, then `killstata --version`, `killstata web`, and `killstata web --share`.
- Document one-shot install: `npx killstata@latest web`.
- Document that default access is local, `--share` allows trusted private-LAN visitors to use the host-configured Core, and SSH port forwarding is required across private networks.
- Do not claim that the current public `0.1.27` package contains this feature; build a new versioned candidate and verify every tarball before requesting publish approval.

- [x] Add and run package assertions for launcher helpers, Web assets, and command availability in the packed artifact.
- [x] Build all 11 native targets and launcher; inspect package metadata and verify the SHA-512 SRI for all 12 tarballs.
- [x] Run npm release dry-run for 0.1.30; registry plans all packages for publication and uploads none.
- [x] Install final 0.1.30 arm64 and launcher tarballs into an isolated npm prefix; `--version`, corrected `web --help`, loopback Web startup, and `--share` startup work.

### Task 6: Verify Desktop/Web visual and interaction parity

**Files:**
- Test: `desktop/src/shared-surface-parity.test.tsx`
- Test: `desktop/src/App.test.tsx`
- Test: `packages/killstata/test/web/local-web-browser-flow-host.ts`
- Update: `PLAN.md` and `PROGRESS.md`

- [x] Run Desktop unit/integration tests, CLI/Web tests, typechecks, Web production builds, Tauri debug bundle, and release package dry-run. Desktop: 365 pass / 2 skip. Latest local Core suite: 2165 pass / 5 skip / 0 fail (2170 tests, 309 files, 10533 assertions); CLI typecheck and `git diff --check` pass.
- [x] Compare shared Desktop/Web start, submitted “1” research record, settings, and reasoning behavior; test Web at 1440×900 and 390×844. Fix and verify the narrow-screen settings overlay regression.
- [x] Verify local loopback and private-LAN share separately. Share route/session tests block credential mutation; installed candidate activates the fake host profile in an isolated visitor workspace. No data was submitted to an external Provider and no second physical device was available.
- [x] Finish the adversarial review and create Draft PR #6 with the known CLI full-suite failure disclosed.
- [x] Restore clean-checkout typecheck dependencies from committed history into tracked source/test fixtures without copying modified local `trash/` files; CLI typecheck and focused legacy tests pass locally.
- [x] Diagnose the 11-failure GitHub run: use the absolute setup-python interpreter and PYTHONPATH; make model tests respect injected Python; use the actual managed runtime root in permission tests; align the legacy panel fixture with undetermined Hausman results.
- [x] Rerun the full Core suite with locked dependencies and CI's 20-second test timeout; all 2165 tests pass, 5 skip.
- [x] Review follow-up: reject Hausman flags/recommendations that contradict missing or invalid statistics; require `rejectRe === (pValue < alpha)`; prevent the session result from showing an RE recommendation or reason when metrics are malformed or contradictory. Panel contract/session-output tests pass 9/9, including the `p == alpha` boundary.
- [x] Rerun the full Desktop suite after raising only the slow parity test's local timeout to 10 seconds; 365 pass / 2 skip. Desktop typecheck and Web production build pass.
- [x] Make the three real-DID scripted journeys portable: use the local-data helper, run when a private workbook is configured, and skip explicitly in a clean checkout without it. Verified 3 skip / 3 pass without data and 6 pass / 0 fail with local `did.xlsx`.
- [x] Push the missing-workbook test fix and confirm a fresh clean checkout: Core 2105 pass / 72 skip / 0 fail; Desktop/Web 365 pass / 2 skip; Python engine 150 pass.
- [x] Switch the queued typecheck/Nix hash jobs to `ubuntu-latest`; standalone typecheck passed. The Nix updater exposed an optional missing `patches/` fileset path, now wrapped in `lib.fileset.maybeMissing`.
- [ ] Confirm the next Nix hash workflow and test workflow; complete Linux host and second-device verification; obtain final approval before public npm publish.
