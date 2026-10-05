import { Installation } from "../installation"
import { Log } from "../util/log"
import { CoreApplication, type CoreRuntimeDiagnostics } from "./application"

export type CoreHostOptions = {
  directory: string
  hostname?: string
  port?: number
  parentPID?: number
  token?: string
  runtimeDiagnostics?: CoreRuntimeDiagnostics
}

type CoreHostReady = {
  event: "core.ready"
  protocolVersion: "v2"
  engineVersion: string
  url: string
}

type CoreHostEvent = {
  event: "core.event"
  protocolVersion: "v2"
  payload: unknown
}

function isLoopbackHost(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
}

function bearerToken(token: string | undefined) {
  return token ? `Bearer ${token}` : undefined
}

function authorized(request: Request, token: string | undefined) {
  if (!token) return true
  return request.headers.get("authorization") === bearerToken(token)
}

const TAURI_RUNTIME_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost"])

function runtimeCorsHeaders(origin: string | null) {
  const headers = new Headers({ "Cache-Control": "no-store" })
  if (!origin) return headers
  if (!TAURI_RUNTIME_ORIGINS.has(origin)) return undefined
  headers.set("Access-Control-Allow-Origin", origin)
  headers.set("Vary", "Origin")
  return headers
}

function runtimeError(status: number, code: string, message: string, headers: Headers) {
  return Response.json({ protocolVersion: "v2", code, message, retryable: false }, { status, headers })
}

function parentIsAlive(parentPID: number | undefined) {
  if (!parentPID) return true
  try {
    process.kill(parentPID, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 独立 Core host：只托管 Core application 和 transport 生命周期。
 *
 * 这是 Desktop sidecar 的入口，不是 `killstata serve` 的别名，也不解析 yargs。
 * Core 的既有 API 路由仍由 Server.App 提供；后续可在此处逐步替换为更窄的
 * CoreClient contract，而不会再引入 Desktop 私有的 run/result 状态机。
 */
export async function startCoreHost(options: CoreHostOptions) {
  const hostname = options.hostname ?? "127.0.0.1"
  if (!isLoopbackHost(hostname)) throw new Error("Core host 只能绑定本机回环地址")

  const application = await CoreApplication.create({ directory: options.directory, runtimeDiagnostics: options.runtimeDiagnostics })
  let stopping = false
  let parentWatch: ReturnType<typeof setInterval> | undefined
  let unsubscribe: (() => void) | undefined

  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const runtimeRoute = url.pathname === "/runtime" || url.pathname === "/runtime/install"
      if (runtimeRoute) {
        const origin = request.headers.get("origin")
        const cors = runtimeCorsHeaders(origin)
        if (!cors) return runtimeError(403, "invalid_origin", "本机运行环境请求来源无效", new Headers({ "Cache-Control": "no-store" }))
        const runtimeDiagnostics = application.runtimeDiagnostics
        if (!runtimeDiagnostics) return runtimeError(503, "runtime_unavailable", "本机运行环境服务不可用", cors)

        if (request.method === "OPTIONS") {
          const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase()
          const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
            .split(",")
            .map((header) => header.trim().toLowerCase())
            .filter(Boolean)
          if (!origin || !TAURI_RUNTIME_ORIGINS.has(origin)
            || requestedMethod !== "GET" && requestedMethod !== "POST"
            || requestedHeaders.some((header) => header !== "authorization" && header !== "content-type")) {
            return runtimeError(403, "invalid_preflight", "本机运行环境预检请求无效", cors)
          }
          cors.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
          cors.set("Access-Control-Allow-Headers", "authorization, content-type")
          cors.set("Access-Control-Max-Age", "600")
          return new Response(null, { status: 204, headers: cors })
        }

        // The runtime installer is intentionally unavailable from a Core host
        // that was started without a private Tauri bearer token.
        if (!options.token || !authorized(request, options.token)) {
          return runtimeError(401, "unauthorized", "Core host 凭据无效", cors)
        }
        if (url.pathname === "/runtime" && request.method === "GET") {
          try { return Response.json(await runtimeDiagnostics.inspect(), { headers: cors }) }
          catch { return runtimeError(500, "runtime_inspection_failed", "本机运行环境检查失败", cors) }
        }
        if (url.pathname === "/runtime/install" && request.method === "POST") {
          if (request.body !== null) return runtimeError(400, "runtime_install_input_rejected", "运行环境安装请求不能携带参数", cors)
          try { return Response.json(await runtimeDiagnostics.install(), { headers: cors }) }
          catch { return runtimeError(500, "runtime_install_failed", "本机分析环境准备未完成", cors) }
        }
        return runtimeError(405, "method_not_allowed", "本机运行环境请求方法无效", cors)
      }

      // 浏览器在携带 Authorization 前会先发送无 Token 的 CORS 预检；
      // 预检只由 Core 的 loopback CORS 层处理，真正业务请求仍必须鉴权。
      if (request.method !== "OPTIONS" && !authorized(request, options.token)) {
        return Response.json({
          protocolVersion: "v2",
          code: "unauthorized",
          message: "Core host 凭据无效",
          retryable: false,
        }, { status: 401 })
      }
      return application.fetch(request)
    },
  })

  const stop = async () => {
    if (stopping) return
    stopping = true
    if (parentWatch) clearInterval(parentWatch)
    unsubscribe?.()
    server.stop(true)
    await application.dispose()
  }

  if (options.parentPID) {
    parentWatch = setInterval(() => {
      if (!parentIsAlive(options.parentPID)) void stop().finally(() => process.exit(0))
    }, 300)
  }

  const onSignal = () => void stop().finally(() => process.exit(0))
  process.once("SIGTERM", onSignal)
  process.once("SIGINT", onSignal)
  process.once("exit", () => {
    if (parentWatch) clearInterval(parentWatch)
    unsubscribe?.()
  })

  unsubscribe = CoreApplication.onEvent((event) => {
    // 只把 Core 原始事件交给 host transport；不在 host 层翻译工具或结果语义。
    const payload: CoreHostEvent = {
      event: "core.event",
      protocolVersion: "v2",
      payload: event,
    }
    process.stdout.write(JSON.stringify(payload) + "\n")
  })

  const ready: CoreHostReady = {
    event: "core.ready",
    protocolVersion: "v2",
    engineVersion: Installation.VERSION,
    url: server.url.toString(),
  }
  process.stdout.write(JSON.stringify(ready) + "\n")
  Log.Default.info("core host ready", { url: ready.url })

  return { application, server, stop, ready }
}

if (import.meta.main) {
  const directory = process.env.KILLSTATA_CORE_DIRECTORY ?? process.cwd()
  const port = Number(process.env.KILLSTATA_CORE_PORT ?? 0)
  const parentPID = Number(process.env.KILLSTATA_CORE_PARENT_PID ?? 0) || undefined
  const token = process.env.KILLSTATA_CORE_TOKEN
  await startCoreHost({ directory, port, parentPID, token })
  await new Promise(() => {})
}
