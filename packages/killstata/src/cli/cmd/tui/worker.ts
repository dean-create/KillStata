import { Installation } from "@/installation"
import { CoreApplication } from "@/core/application"
import { startCoreHost } from "@/core/host"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { createKillstataClient, type Event } from "@killstata/sdk/v2"

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Bun.Server<unknown> | undefined
let coreApplication: CoreApplication | undefined
let coreHost: Awaited<ReturnType<typeof startCoreHost>> | undefined

const eventStream = {
  abort: undefined as AbortController | undefined,
}

async function ensureCoreApplication() {
  if (!coreApplication) coreApplication = await CoreApplication.create({ directory: process.cwd() })
  return coreApplication!
}

// 在接受 RPC 之前必须先完成 CoreApplication 初始化，
// 否则 TUI SyncProvider.bootstrap() 的 SDK 调用会因 "Core application 尚未启动" 全部抛异常 → 直接退出。
coreApplication = await ensureCoreApplication()

const startEventStream = (directory: string) => {
  if (eventStream.abort) eventStream.abort.abort()
  const abort = new AbortController()
  eventStream.abort = abort
  const signal = abort.signal

  ;(async () => {
    const sdk = createKillstataClient({
      baseUrl: "http://killstata.internal",
      directory,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        (await ensureCoreApplication()).fetch(new Request(input, init))) as typeof fetch,
      signal,
    })
    while (!signal.aborted) {
      const events = await Promise.resolve(sdk.event.subscribe({}, { signal })).catch(() => undefined)
      if (!events) {
        await Bun.sleep(250)
        continue
      }
      for await (const event of events.stream) Rpc.emit("event", event as Event)
      if (!signal.aborted) await Bun.sleep(250)
    }
  })().catch((error) => {
    Log.Default.error("event stream error", { error: error instanceof Error ? error.message : error })
  })
}

startEventStream(process.cwd())

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const request = new Request(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
    })
    const response = await (await ensureCoreApplication()).fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    // Core host 仅支持本机回环，局域网/mDNS 场景需走 killstata serve 的完整 Server
    if (input.mdns || (input.hostname && !["127.0.0.1", "localhost", "::1"].includes(input.hostname))) {
      Log.Default.warn("core host fallback to Server.listen for non-loopback/mDNS", { hostname: input.hostname, mdns: input.mdns })
      const { Server } = await import("../../../server/server")
      server = Server.listen(input as any)
      return { url: server!.url.toString() }
    }
    coreHost = await startCoreHost({
      directory: process.cwd(),
      hostname: input.hostname,
      port: input.port,
    })
    server = coreHost.server
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      fn: async () => {
        await upgrade().catch(() => {})
      },
    })
  },
  async reload() {
    Config.global.reset()
    if (eventStream.abort) eventStream.abort.abort()
    eventStream.abort = undefined
    await coreHost?.stop()
    coreHost = undefined
    coreApplication = undefined
    await Instance.disposeAll()
    // 重新建立 Core 与事件流，避免后续 rpc.fetch 因 Core 未初始化而抛异常。
    await ensureCoreApplication()
    startEventStream(process.cwd())
  },
  async shutdown() {
    Log.Default.info("worker shutting down")
    if (eventStream.abort) eventStream.abort.abort()
    await coreHost?.stop()
    coreHost = undefined
    coreApplication = undefined
    await Instance.disposeAll()
    if (server) server.stop(true)
  },
}

Rpc.listen(rpc)
