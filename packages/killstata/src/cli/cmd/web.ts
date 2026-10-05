import { existsSync } from "node:fs"
import path from "node:path"
import open from "open"
import type { Argv } from "yargs"
import { CoreApplication } from "../../core/application"
import { InstanceBootstrap } from "../../project/bootstrap"
import { Instance } from "../../project/instance"
import { createLocalWebCredentialStore, type LocalWebCredentialStoreOptions } from "../../web/local-web-credentials"
import { createLocalWebProfileRuntime, type LocalWebProfileRuntimeOptions } from "../../web/local-web-profile-runtime"
import { createLocalWebRuntimeDiagnostics, type LocalWebRuntimeContext } from "../../web/local-web-runtime"
import { createLocalWebEngineApiFromCore, type LocalWebCredentialHandler, type LocalWebEngineApi, type LocalWebRuntimeHandler } from "../../web/local-web-engine"
import { createLocalWebWorkspaceRegistry, type LocalWebWorkspaceRegistryOptions } from "../../web/local-web-workspaces"
import { createLocalWebWorkspaceEngine, type LocalWebWorkspaceEngineOptions } from "../../web/local-web-workspace-engine"
import { createLocalWebUiPreferences } from "../../web/local-web-ui-preferences"
import { startLocalWebHost, type LocalWebHost, type LocalWebHostOptions } from "../../web/local-web-host"
import { cmd } from "./cmd"

export type LocalWebService = { launchUrl: string; shareUrls?: string[]; stop(): Promise<void> }
export type LocalWebServiceOptions = { directory: string; port: number; share?: boolean }
export type LocalWebServiceDependencies = {
  createCore: (options: { directory: string }) => Promise<CoreApplication>
  createApi: (application: CoreApplication, credentialHandler?: LocalWebCredentialHandler, runtimeHandler?: LocalWebRuntimeHandler) => LocalWebEngineApi
  createCredentialRuntime: (options: LocalWebProfileRuntimeOptions) => ReturnType<typeof createLocalWebProfileRuntime>
  createCredentialStore: (options: LocalWebCredentialStoreOptions) => ReturnType<typeof createLocalWebCredentialStore>
  createRuntimeDiagnostics: (runInCoreContext: LocalWebRuntimeContext) => ReturnType<typeof createLocalWebRuntimeDiagnostics>
  createWorkspaceRegistry: (options: LocalWebWorkspaceRegistryOptions) => ReturnType<typeof createLocalWebWorkspaceRegistry>
  createWorkspaceEngine: (options: LocalWebWorkspaceEngineOptions) => ReturnType<typeof createLocalWebWorkspaceEngine>
  startHost: (options: LocalWebHostOptions) => Promise<LocalWebHost>
  assetsDirectory: () => string
}

export function resolveLocalWebAssetsDirectory() {
  const candidates = [
    path.resolve(path.dirname(process.execPath), "..", "dist-web"),
    path.resolve(import.meta.dir, "../../../../../desktop/dist-web"),
  ]
  const directory = candidates.find((candidate) => existsSync(path.join(candidate, "index.html")))
  if (!directory) throw new Error("KillStata Web 资源未找到；请重新安装包含 Web 资源的发布包，或在源码目录运行 `bun run --cwd desktop build:web`。")
  return directory
}

const defaultServiceDependencies: LocalWebServiceDependencies = {
  createCore: CoreApplication.create,
  createApi: createLocalWebEngineApiFromCore,
  createCredentialRuntime: createLocalWebProfileRuntime,
  createCredentialStore: createLocalWebCredentialStore,
  createRuntimeDiagnostics: (runInCoreContext) => createLocalWebRuntimeDiagnostics({ runInCoreContext }),
  createWorkspaceRegistry: createLocalWebWorkspaceRegistry,
  createWorkspaceEngine: createLocalWebWorkspaceEngine,
  startHost: startLocalWebHost,
  assetsDirectory: resolveLocalWebAssetsDirectory,
}

export async function createLocalWebService(
  options: LocalWebServiceOptions,
  dependencies: LocalWebServiceDependencies = defaultServiceDependencies,
): Promise<LocalWebService> {
  const registry = dependencies.createWorkspaceRegistry({ launchDirectory: options.directory })
  let workspaceEngine: ReturnType<typeof createLocalWebWorkspaceEngine> | undefined
  const runtime = dependencies.createCredentialRuntime({
    async restartCore() {
      await workspaceEngine?.resetAll()
    },
  })
  const credentials = dependencies.createCredentialStore({ activate: runtime.activate })
  workspaceEngine = dependencies.createWorkspaceEngine({
    registry,
    createCore: dependencies.createCore,
      createApi: (application, runtimeHandler) => dependencies.createApi(application, undefined, runtimeHandler),
      createRuntimeHandler(directory) {
        const runtimeDiagnostics = dependencies.createRuntimeDiagnostics(async (operation) => {
          const nested = await Instance.provide({ directory, init: InstanceBootstrap, fn: operation })
          return await nested
        })
        return runtimeDiagnostics.handle
      },
    credentialHandler: credentials.handle,
    uiPreferenceHandler: createLocalWebUiPreferences().handle,
  })
  let host: LocalWebHost | undefined
  try {
    host = await dependencies.startHost({
      assetsDirectory: dependencies.assetsDirectory(),
      api: workspaceEngine,
      port: options.port,
      share: options.share,
    })
  } catch (error) {
    await workspaceEngine.shutdown()
    runtime.dispose()
    throw error
  }

  let stopped = false
  return {
    launchUrl: host.launchUrl,
    shareUrls: host.shareUrls,
    async stop() {
      if (stopped) return
      stopped = true
      try { await host.stop() }
      finally {
        await workspaceEngine.shutdown()
        runtime.dispose()
      }
    },
  }
}

export function buildWebCommandOptions(yargs: Argv) {
  return yargs
    .option("port", {
      describe: "本机 Web 服务端口",
      type: "number",
      default: 3080,
    })
    .option("open", {
      describe: "启动后自动打开浏览器；传 --no-open 可关闭",
      type: "boolean",
      default: true,
    })
    .option("share", {
      describe: "可信局域网访客可连接主机已配置的模型，但不能查看或修改主机凭据",
      type: "boolean",
      default: false,
    })
    .check((args) => {
      if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65_535) {
        throw new Error("--port 必须是 0 到 65535 之间的整数")
      }
      return true
    })
}

export type ExecuteLocalWebOptions = { port: number; noOpen: boolean; share?: boolean }
export type ExecuteLocalWebDependencies = {
  startService(port: number, share: boolean): Promise<LocalWebService>
  openBrowser(url: string): Promise<unknown>
  waitForShutdown(): Promise<void>
  stdout(message: string): void
  stderr(message: string): void
}

function waitForShutdownSignal() {
  return new Promise<void>((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish)
      process.off("SIGTERM", finish)
      resolve()
    }
    process.once("SIGINT", finish)
    process.once("SIGTERM", finish)
  })
}

const defaultExecutionDependencies: ExecuteLocalWebDependencies = {
  startService: async (port, share) => createLocalWebService({ directory: process.cwd(), port, share }),
  openBrowser: async (url) => { await open(url) },
  waitForShutdown: waitForShutdownSignal,
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
}

export async function executeLocalWebCommand(
  options: ExecuteLocalWebOptions,
  dependencies: ExecuteLocalWebDependencies = defaultExecutionDependencies,
) {
  const share = options.share === true
  const service = await dependencies.startService(options.port, share)
  try {
    dependencies.stdout(`KillStata Web: ${service.launchUrl}`)
    for (const url of service.shareUrls ?? []) dependencies.stdout(`局域网预览：${url}`)
    if (share) dependencies.stderr("分享链接仅用于可信局域网；访客可连接主机已配置的模型，但不能查看或修改主机凭据。分析数据会在访客提交后传到主机。")
    if (!options.noOpen) {
      try { await dependencies.openBrowser(service.launchUrl) }
      catch { dependencies.stderr("无法自动打开浏览器；请在本机浏览器中打开终端显示的启动链接。") }
    }
    await dependencies.waitForShutdown()
  } finally {
    await service.stop()
  }
}

export const WebCommand = cmd({
  command: "web",
  describe: "starts the local browser interface",
  builder: buildWebCommandOptions,
  handler: async (args) => executeLocalWebCommand({ port: args.port, noOpen: !args.open, share: args.share }),
})
