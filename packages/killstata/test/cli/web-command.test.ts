import { describe, expect, test, vi } from "bun:test"
import yargs from "yargs"
import type { CoreApplication } from "../../src/core/application"
import type { LocalWebCredentialHandler, LocalWebEngineApi } from "../../src/web/local-web-engine"
import type { LocalWebHost } from "../../src/web/local-web-host"
import type { LocalWebCredentialStoreOptions, LocalWebStoredProfile } from "../../src/web/local-web-credentials"
import { createLocalWebRuntimeDiagnostics, type LocalWebRuntimeContext } from "../../src/web/local-web-runtime"
import { createLocalWebWorkspaceEngine } from "../../src/web/local-web-workspace-engine"
import { createLocalWebWorkspaceRegistry, type LocalWebWorkspaceRegistryOptions } from "../../src/web/local-web-workspaces"
import { buildWebCommandOptions, createLocalWebService, executeLocalWebCommand } from "../../src/cli/cmd/web"

function noCredentialDependencies() {
  return {
    createCredentialRuntime: () => ({ activate: async () => {}, dispose: () => {} }),
    createCredentialStore: () => ({ handle: async () => undefined, activateDefault: async () => {} }),
    createRuntimeDiagnostics: (runInCoreContext: LocalWebRuntimeContext) => createLocalWebRuntimeDiagnostics({ runInCoreContext }),
    createWorkspaceRegistry: (options: LocalWebWorkspaceRegistryOptions) => createLocalWebWorkspaceRegistry(options),
    createWorkspaceEngine: createLocalWebWorkspaceEngine,
  }
}

describe("killstata web command", () => {
  test("defaults to loopback port 3080 and parses --no-open", async () => {
    const defaults = await buildWebCommandOptions(yargs([])).parse()
    const explicit = await buildWebCommandOptions(yargs(["--port", "4318", "--no-open", "--share"])).parse()

    expect(defaults).toMatchObject({ port: 3080, open: true, share: false })
    expect(explicit).toMatchObject({ port: 4318, open: false, share: true })
    expect(explicit).not.toHaveProperty("host")
  })

  test("describes LAN sharing as access to the host-configured model without credential access", async () => {
    const help = await buildWebCommandOptions(yargs([]).help()).getHelp()

    expect(help).toContain("可信局域网访客使用主机模型")
    expect(help).toContain("禁用完全访问授权")
    expect(help).not.toContain("不开放分析核心")
  })

  test("prints one launch URL, skips browser opening on request, then closes the service", async () => {
    const calls: string[] = []
    const service = { launchUrl: "http://127.0.0.1:3080/?token=one-use", stop: vi.fn(async () => { calls.push("stop") }) }
    const stdout: string[] = []
    const dependencies = {
      startService: vi.fn(async (port: number, share: boolean) => { calls.push(`start:${port}:${share}`); return service }),
      openBrowser: vi.fn(async () => { calls.push("open") }),
      waitForShutdown: vi.fn(async () => { calls.push("shutdown") }),
      stdout: (message: string) => stdout.push(message),
      stderr: vi.fn(),
    }

    await executeLocalWebCommand({ port: 3080, noOpen: true, share: false }, dependencies)

    expect(calls).toEqual(["start:3080:false", "shutdown", "stop"])
    expect(dependencies.openBrowser).not.toHaveBeenCalled()
    expect(stdout).toEqual(["KillStata Web: http://127.0.0.1:3080/?token=one-use"])
    expect(service.stop).toHaveBeenCalledTimes(1)
  })

  test("prints LAN preview links only when --share is enabled", async () => {
    const calls: string[] = []
    const service = {
      launchUrl: "http://127.0.0.1:3080/?token=local",
      shareUrls: ["http://192.168.1.12:3080/?share=1&token=share"],
      stop: vi.fn(async () => { calls.push("stop") }),
    }
    const stdout: string[] = []
    const dependencies = {
      startService: vi.fn(async (port: number, share: boolean) => { calls.push(`start:${port}:${share}`); return service }),
      openBrowser: vi.fn(async () => calls.push("open")),
      waitForShutdown: vi.fn(async () => { calls.push("shutdown") }),
      stdout: (message: string) => { stdout.push(message) },
      stderr: vi.fn(),
    }

    await executeLocalWebCommand({ port: 3080, noOpen: true, share: true }, dependencies)

    expect(calls).toEqual(["start:3080:true", "shutdown", "stop"])
    expect(stdout).toContain("局域网预览：http://192.168.1.12:3080/?share=1&token=share")
    expect(dependencies.stderr.mock.calls.flat().join(" ")).toContain("可信局域网")
    expect(dependencies.stderr.mock.calls.flat().join(" ")).toContain("未加密 HTTP")
    expect(dependencies.stderr.mock.calls.flat().join(" ")).toContain("完全访问档位已禁用")
    expect(dependencies.stderr.mock.calls.flat().join(" ")).toContain("主机模型额度")
    expect(dependencies.stderr.mock.calls.flat().join(" ")).not.toContain("不能连接分析核心")
  })

  test("keeps the local server available if browser opening fails and still cleans up on exit", async () => {
    const calls: string[] = []
    const service = { launchUrl: "http://127.0.0.1:3080/?token=one-use", stop: vi.fn(async () => { calls.push("stop") }) }
    const stderr: string[] = []
    const dependencies = {
      startService: vi.fn(async () => { calls.push("start"); return service }),
      openBrowser: vi.fn(async () => { calls.push("open"); throw new Error("browser unavailable") }),
      waitForShutdown: vi.fn(async () => { calls.push("shutdown") }),
      stdout: vi.fn(),
      stderr: (message: string) => stderr.push(message),
    }

    await executeLocalWebCommand({ port: 3080, noOpen: false }, dependencies)

    expect(calls).toEqual(["start", "open", "shutdown", "stop"])
    expect(stderr.join(" ")).toContain("无法自动打开浏览器")
    expect(stderr.join(" ")).not.toContain("one-use")
  })

  test("stops the Core/Web service when shutdown waiting fails", async () => {
    const service = { launchUrl: "http://127.0.0.1:3080/?token=one-use", stop: vi.fn(async () => {}) }
    const dependencies = {
      startService: vi.fn(async () => service),
      openBrowser: vi.fn(async () => {}),
      waitForShutdown: vi.fn(async () => { throw new Error("signal waiter failed") }),
      stdout: vi.fn(),
      stderr: vi.fn(),
    }

    await expect(executeLocalWebCommand({ port: 3080, noOpen: true }, dependencies)).rejects.toThrow("signal waiter failed")
    expect(service.stop).toHaveBeenCalledTimes(1)
  })

  test("disposes Core and API subscriptions if binding the local server fails", async () => {
    const core = { directory: "/study", fetch: async () => new Response(), dispose: vi.fn(async () => {}) } satisfies CoreApplication
    const api = Object.assign(async () => new Response(), { dispose: vi.fn(), isIdle: () => true }) as LocalWebEngineApi
    const dependencies = {
      ...noCredentialDependencies(),
      createCore: vi.fn(async () => core),
      createApi: vi.fn(() => api),
      startHost: vi.fn(async () => { throw new Error("本地 Web 端口已被占用") }),
      assetsDirectory: () => "/validated/dist-web",
    }

    await expect(createLocalWebService({ directory: "/study", port: 3080 }, dependencies)).rejects.toThrow("本地 Web 端口已被占用")
    expect(api.dispose).not.toHaveBeenCalled()
    expect(core.dispose).not.toHaveBeenCalled()
  })

  test("defers saved-profile activation and Core startup until a connected API request", async () => {
    const order: string[] = []
    const profile: LocalWebStoredProfile = {
      id: "profile-1", displayName: "Local", provider: "deepseek", model: "deepseek/deepseek-v4-flash", apiKey: "runtime-only",
    }
    const api = Object.assign(async () => new Response(), { dispose: vi.fn(), isIdle: () => true }) as LocalWebEngineApi
    const core = { directory: "/study", fetch: async () => new Response(), dispose: vi.fn(async () => { order.push("core") }) } satisfies CoreApplication
    const host = {
      url: "http://127.0.0.1:3080/",
      launchUrl: "http://127.0.0.1:3080/?token=one-use",
      async stop() {},
    } satisfies LocalWebHost
    let localApi: ((request: Request) => Promise<Response>) | undefined
    const dependencies = {
      ...noCredentialDependencies(),
      createCredentialRuntime: vi.fn(() => ({
        activate: async (active?: LocalWebStoredProfile) => { order.push(active ? "activate-profile" : "activate-none") },
        dispose: () => { order.push("runtime-dispose") },
      })),
      createCredentialStore: vi.fn((storeOptions: LocalWebCredentialStoreOptions) => ({
        handle: async () => undefined,
        async activateDefault() {
          order.push("load-profile")
          if (!storeOptions.activate) throw new Error("credential activator missing")
          await storeOptions.activate(profile)
        },
      })),
      createRuntimeDiagnostics: (runInCoreContext: LocalWebRuntimeContext) => createLocalWebRuntimeDiagnostics({ runInCoreContext }),
      createCore: vi.fn(async () => { order.push("core"); return core }),
      createApi: vi.fn((_application: CoreApplication, _credentialHandler?: LocalWebCredentialHandler, runtimeHandler?: (request: Request) => Promise<Response | undefined>) => {
        expect(runtimeHandler).toBeTruthy()
        order.push("api")
        return api
      }),
      startHost: vi.fn(async (options) => { localApi = options.api; order.push("host"); return host }),
      assetsDirectory: () => "/validated/dist-web",
    }

    const service = await createLocalWebService({ directory: "/study", port: 3080 }, dependencies)

    expect(order).toEqual(["host"])
    expect(dependencies.createCredentialStore).toHaveBeenCalledTimes(1)
    expect(localApi).toBeTruthy()
    const response = await localApi!(new Request("http://127.0.0.1/api/v2/health"))
    expect(response.status).toBe(200)
    expect(order).toEqual(["host", "core", "api"])
    await service.stop()
    expect(order.slice(-2)).toEqual(["core", "runtime-dispose"])
  })

  test("starts Core lazily and stops the listener before disposing it exactly once", async () => {
    const order: string[] = []
    const core = { directory: "/study", fetch: async () => new Response(), dispose: async () => { order.push("core") } } satisfies CoreApplication
    const api = Object.assign(async () => new Response(), { dispose: () => { order.push("api") }, isIdle: () => true }) as LocalWebEngineApi
    const host = {
      url: "http://127.0.0.1:3080/",
      launchUrl: "http://127.0.0.1:3080/?token=one-use",
      async stop() { order.push("host") },
    } satisfies LocalWebHost
    let localApi: ((request: Request) => Promise<Response>) | undefined
    const service = await createLocalWebService({ directory: "/study", port: 3080 }, {
      ...noCredentialDependencies(),
      createCore: async () => core,
      createApi: () => api,
      startHost: async (options) => { localApi = options.api; return host },
      assetsDirectory: () => "/validated/dist-web",
    })

    expect(order).toEqual([])
    expect(localApi).toBeTruthy()
    await localApi!(new Request("http://127.0.0.1/api/v2/health"))
    await service.stop()
    await service.stop()

    expect(order).toEqual(["host", "api", "core"])
  })

})
