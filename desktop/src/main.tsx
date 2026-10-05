import { render } from "solid-js/web"
import App from "./App"
import { createDemoCredentialStore, type CredentialStore } from "./credentials"
import { createTauriCredentialStore } from "./tauri-credentials"
import { createCoreEngineAdapter } from "./core/engine-adapter"
import { createLazySessionOperations } from "./core/lazy-session-operations"
import { createCoreRuntimeDiagnosticsAdapter } from "./core/runtime-diagnostics"
import { createLoopbackCoreTransport } from "./core/transport"
import { CoreSessionClient } from "./core/client"
import { HttpEngineClient, createDemoEngine, type EngineClient } from "./engine/client"
import { resolveEngineProtocolVersion } from "./engine/protocol-config"
import { createDemoRuntimeDiagnostics, type RuntimeDiagnostics } from "./runtime-diagnostics"
import { createLocalWorkspaceStore, UNASSIGNED_WORKSPACE_ID, type WorkspaceStore } from "./workspace-store"
import { createTauriWorkspaceStore } from "./tauri-workspace-store"
import { createTauriParityFixtureAdapters, shouldUseTauriParityFixture } from "./tauri-parity-fixture"
import { workspaceMode, type WorkspaceMode } from "./workspace-mode"
import { createBrowserSharedWorkspacePicker, createBrowserWorkspacePicker } from "./web/workspace-picker"
import { createSharedWebCredentialStore, createWebCredentialStore } from "./web/credential-store"
import { createWebUiPreferencesStore } from "./web/ui-preferences"
import { createTauriUiPreferencesStore } from "./tauri-ui-preferences"
import type { SharedUiPreferences } from "./ui-preferences"
import { createWebRuntimeDiagnostics } from "./web/runtime-diagnostics"
import "./styles.css"

type TauriCoreConnection = { url: string; token: string }

/**
 * 与 Core 的事件流传输。凭据变更会重启 Core 进程并换掉 Bus 实例，
 * 此时必须作废这条连接（见 createLoopbackCoreTransport 的 invalidate 注释）。
 */
let coreTransport: ReturnType<typeof createLoopbackCoreTransport> | undefined
let coreClientPromise: Promise<CoreSessionClient> | undefined

function tauriCoreSessionClient(): Promise<CoreSessionClient> {
  if (!coreClientPromise) {
    coreClientPromise = (async () => {
      const { invoke } = await import("@tauri-apps/api/core")
      const connection = await invoke<TauriCoreConnection>("core_connection")
      coreTransport = createLoopbackCoreTransport(connection)
      return new CoreSessionClient(coreTransport)
    })().catch((error) => {
      coreClientPromise = undefined
      throw error
    })
  }
  return coreClientPromise
}

function tauriCoreEngine(): EngineClient {
  let adapterPromise: Promise<EngineClient> | undefined
  const target = () => adapterPromise ??= tauriCoreSessionClient()
    .then((core) => createCoreEngineAdapter(core))
    .catch((error) => {
      adapterPromise = undefined
      throw error
    })
  return {
    ...createLazySessionOperations(target),
    health: () => target().then((engine) => engine.health()),
    commands: () => target().then((engine) => engine.commands()),
    uploadDataset: (file) => target().then((engine) => engine.uploadDataset(file)),
    startRun: (input) => target().then((engine) => engine.startRun(input)),
    cancelRun: (runID) => target().then((engine) => engine.cancelRun(runID)),
    getResult: (runID) => target().then((engine) => engine.getResult(runID)),
    answerInteraction: (runID, requestID, answer) => target().then((engine) => engine.answerInteraction?.(runID, requestID, answer) ?? Promise.reject(new Error("当前 Core 不支持交互式回答"))),
    denyInteraction: (runID, requestID, reason) => target().then((engine) => engine.denyInteraction?.(runID, requestID, reason) ?? Promise.reject(new Error(reason ?? "当前 Core 不支持交互式拒绝"))),
    subscribe(runID, listener) {
      let unsubscribe: (() => void) | undefined
      let cancelled = false
      void target().then((engine) => {
        unsubscribe = engine.subscribe(runID, listener)
        if (cancelled) unsubscribe()
      })
      return () => {
        cancelled = true
        unsubscribe?.()
      }
    },
  }
}

function tauriCredentials(): CredentialStore {
  async function invokeTauri<T>(command: string, args?: Record<string, unknown>) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<T>(command, args)
  }
  return createTauriCredentialStore(invokeTauri, () => coreTransport?.events?.invalidate?.())
}

function tauriUiPreferences() {
  return createTauriUiPreferencesStore(async <T,>(command: string, args?: Record<string, unknown>) => {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<T>(command, args)
  })
}

function tauriRuntimeDiagnostics(): RuntimeDiagnostics {
  return createCoreRuntimeDiagnosticsAdapter(tauriCoreSessionClient)
}

function tauriWorkspaceStore(): WorkspaceStore {
  return createTauriWorkspaceStore(async <T,>(command: string, args?: Record<string, unknown>) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return await invoke<T>(command, args)
    })
}

async function selectTauriWorkspace() {
  const { invoke } = await import("@tauri-apps/api/core")
  return (await invoke<{ id: string; name: string } | null>("select_workspace_directory")) ?? undefined
}

async function selectTauriWorkspaceFile(workspaceID?: string) {
  const { invoke } = await import("@tauri-apps/api/core")
  if (workspaceID) await invoke("activate_workspace", { request: { id: workspaceID } })
  const raw = await invoke<ArrayBuffer>("select_workspace_file")
  const bytes = new Uint8Array(raw)
  const separator = bytes.indexOf(10)
  if (separator < 0) throw new Error("无法读取所选数据文件")
  const metadata = JSON.parse(new TextDecoder().decode(bytes.slice(0, separator))) as { name?: unknown; bytes?: unknown }
  if (metadata.name === null && metadata.bytes === 0) return undefined
  if (typeof metadata.name !== "string" || !metadata.name || typeof metadata.bytes !== "number" || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0) throw new Error("所选数据文件响应无效")
  if (separator + 1 + metadata.bytes !== bytes.byteLength) throw new Error("所选数据文件响应无效")
  return new File([bytes.slice(separator + 1)], metadata.name)
}

const engineURL = import.meta.env.VITE_ENGINE_URL
const engineToken = import.meta.env.VITE_ENGINE_TOKEN
const engineProtocolVersion = resolveEngineProtocolVersion(import.meta.env.VITE_ENGINE_PROTOCOL_VERSION)
const isTauri = "__TAURI_INTERNALS__" in window
const isLocalWeb = !isTauri && import.meta.env.VITE_KILLSTATA_WEB === "1"
const isSharedVisitor = isLocalWeb && document.cookie.split(";").some((part) => part.trim() === "killstata_share=1")
const mode: WorkspaceMode = workspaceMode({ isTauri, requestedMode: import.meta.env.VITE_KILLSTATA_MODE })
// An explicit development-only fixture lets us inspect the native WebView without touching credentials, shared preferences, or saved research history.
const tauriParityFixture = shouldUseTauriParityFixture({
  isTauri,
  isFixtureBuild: import.meta.env.DEV || import.meta.env.MODE === "parity",
  flag: import.meta.env.VITE_KILLSTATA_TAURI_PARITY_FIXTURE,
}) ? createTauriParityFixtureAdapters() : undefined
const webWorkspaceContext = { id: UNASSIGNED_WORKSPACE_ID }
const connectedWebEngine = isLocalWeb && engineURL
  ? new HttpEngineClient(engineURL, fetch, engineToken, undefined, engineProtocolVersion, () => webWorkspaceContext.id)
  : undefined
const engine = tauriParityFixture?.engine ?? (isTauri ? tauriCoreEngine() : connectedWebEngine ?? createDemoEngine())
const credentials = tauriParityFixture?.credentials ?? (isTauri ? tauriCredentials() : isSharedVisitor ? createSharedWebCredentialStore() : isLocalWeb ? createWebCredentialStore() : createDemoCredentialStore())
const runtimeDiagnostics = tauriParityFixture?.runtimeDiagnostics ?? (isTauri ? tauriRuntimeDiagnostics() : isLocalWeb && !isSharedVisitor ? createWebRuntimeDiagnostics(fetch, () => webWorkspaceContext.id) : createDemoRuntimeDiagnostics())
const uiPreferences = tauriParityFixture?.uiPreferences ?? (isTauri ? tauriUiPreferences() : isLocalWeb && !isSharedVisitor ? createWebUiPreferencesStore() : undefined)
const browserWorkspacePicker = isLocalWeb
  ? isSharedVisitor ? createBrowserSharedWorkspacePicker() : createBrowserWorkspacePicker()
  : undefined
const workspaceStore = tauriParityFixture?.workspaceStore ?? (isTauri ? tauriWorkspaceStore() : createLocalWorkspaceStore())

function renderApp(initialUiPreferences?: SharedUiPreferences, initialWorkspaceHistoryEnabled?: boolean) {
  render(
    () => <App engine={engine} credentials={credentials} runtimeDiagnostics={runtimeDiagnostics} uiPreferences={uiPreferences} initialUiPreferences={initialUiPreferences} initialWorkspaceHistoryEnabled={initialWorkspaceHistoryEnabled} workspaceStore={workspaceStore} workspacePicker={isTauri ? selectTauriWorkspace : browserWorkspacePicker?.selectWorkspace} workspaceFilePicker={isTauri ? selectTauriWorkspaceFile : browserWorkspacePicker?.selectFile} workspaceContextChanged={isLocalWeb ? (id) => { webWorkspaceContext.id = id; connectedWebEngine?.refreshWorkspaceContext() } : undefined} mode={mode} connectionAvailable={isTauri || isLocalWeb} sharedVisitor={isSharedVisitor} requireApiKey={isTauri || isLocalWeb} />,
    document.getElementById("root")!,
  )
}

async function initialSharedPreferences() {
  if (!uiPreferences) return undefined
  let timeout: number | undefined
  const fallback = new Promise<undefined>((resolve) => {
    timeout = window.setTimeout(() => resolve(undefined), 500)
  })
  try {
    return await Promise.race([uiPreferences.load(), fallback])
  } catch {
    return undefined
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout)
  }
}

async function initialWorkspaceHistory() {
  const fallbackValue = workspaceStore.isEnabled?.() ?? false
  if (!isTauri || !workspaceStore.loadEnabled) return fallbackValue
  let timeout: number | undefined
  const fallback = new Promise<boolean>((resolve) => {
    timeout = window.setTimeout(() => resolve(fallbackValue), 500)
  })
  try {
    return await Promise.race([workspaceStore.loadEnabled(), fallback])
  } catch {
    return fallbackValue
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout)
  }
}

if (!uiPreferences && !isTauri) renderApp(undefined, workspaceStore.isEnabled?.() ?? false)
else void Promise.all([initialSharedPreferences(), initialWorkspaceHistory()]).then(([preferences, historyEnabled]) => renderApp(preferences, historyEnabled))
