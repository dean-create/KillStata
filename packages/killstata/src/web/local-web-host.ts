import { existsSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createLocalWebSession } from "./local-web-session"

const MAXIMUM_WEB_REQUEST_BYTES = 64 * 1024 * 1024
const RESPONSE_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
}

export type LocalWebHostOptions = {
  assetsDirectory: string
  api: (request: Request) => Promise<Response>
  port?: number
  share?: boolean
  networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>
}

export type LocalWebHost = {
  url: string
  launchUrl: string
  shareUrls?: string[]
  stop(): Promise<void>
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function isPrivateIPv4(address: string) {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part, index) => !/^\d{1,3}$/.test(address.split(".")[index]!) || part < 0 || part > 255)) return false
  const [first, second] = parts
  return first === 10
    || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && second === 168)
}

export function isLoopbackAddress(address: string) {
  const normalized = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address
  return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.")
}

export function isShareClientAddress(address: string) {
  const normalized = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address
  return isLoopbackAddress(normalized) || isPrivateIPv4(normalized)
}

export function isAllowedWebClientAddress(address: string | undefined, share: boolean, sharedSession: boolean) {
  if (!share) return !address || isLoopbackAddress(address)
  if (!address) return false
  return sharedSession ? isShareClientAddress(address) : isLoopbackAddress(address)
}

export function isShareApiRouteAllowed(pathname: string, method: string) {
  if (pathname === "/api/v2/workspaces") return method === "POST"
  if (pathname === "/api/v2/credentials/profiles" || pathname === "/api/v2/credentials/status") return method === "GET"
  if (pathname === "/api/v2/credentials/activate") return method === "POST"
  if (pathname === "/api/v2/health" || pathname === "/api/v2/commands") return method === "GET"
  if (pathname === "/api/v2/datasets" || pathname === "/api/v2/runs") return method === "POST"
  if (pathname === "/api/v2/verification/events") return method === "GET"
  const runRoute = /^\/api\/v2\/runs\/[A-Za-z0-9_-]{1,128}\/(?:result|events|cancel|interactions\/[A-Za-z0-9_-]{1,128}\/(?:answer|deny)|context|summarize|title|revert|undo|redo)$/
  return runRoute.test(pathname) && (method === "GET" || method === "POST")
}

export function privateIPv4Addresses(
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
) {
  const addresses = Object.values(interfaces).flatMap((items) => (items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal && isPrivateIPv4(item.address))
    .map((item) => item.address))
  return [...new Set(addresses)].sort()
}

function securityResponse(response: Response, requestMethod: string) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) headers.set(name, value)
  headers.set("Cache-Control", "private, no-store")
  return new Response(requestMethod === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function jsonError(status: number, code: string, message: string) {
  return Response.json({ protocolVersion: "v2", code, message, retryable: false }, { status })
}

function originMatches(request: Request, expectedOrigin: string, requireOrigin: boolean) {
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return false
  const origin = request.headers.get("origin")
  if (origin === null) return !requireOrigin
  return origin === expectedOrigin
}

export async function startLocalWebHost(options: LocalWebHostOptions): Promise<LocalWebHost> {
  const assetRoot = await realpath(options.assetsDirectory)
  if (!existsSync(path.join(assetRoot, "index.html"))) throw new Error("KillStata Web 资源缺少 index.html")

  const share = options.share === true
  const shareAddresses = share
    ? privateIPv4Addresses(options.networkInterfaces?.() ?? os.networkInterfaces())
    : []
  if (share && shareAddresses.length === 0) throw new Error("未检测到可用的私有局域网 IPv4 地址，无法生成分享链接。")
  const session = createLocalWebSession({ share })
  let server: Bun.Server<unknown>
  const respond = (response: Response, method: string) => securityResponse(response, method)

  try {
    server = Bun.serve({
      hostname: share ? "0.0.0.0" : "127.0.0.1",
      port: options.port ?? 0,
      maxRequestBodySize: MAXIMUM_WEB_REQUEST_BYTES,
      async fetch(request, currentServer) {
        const url = new URL(request.url)
        const authority = request.headers.get("host") ?? ""
        const allowedAuthorities = new Set([
          `127.0.0.1:${currentServer.port}`,
          ...shareAddresses.map((address) => `${address}:${currentServer.port}`),
        ])
        if (!allowedAuthorities.has(authority)) {
          return respond(jsonError(403, "invalid_host", "本地 Web 请求 Host 无效"), request.method)
        }
        const remoteAddress = currentServer.requestIP(request)?.address
        if (share ? !remoteAddress || !isShareClientAddress(remoteAddress) : remoteAddress && !isLoopbackAddress(remoteAddress)) {
          return respond(jsonError(403, "loopback_only", "本地 Web 只允许本机访问"), request.method)
        }

        const expectedOrigin = `http://${authority}`
        if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
          const queryValues = [...url.searchParams.keys()]
          const sharedLaunch = url.searchParams.get("share") === "1"
          const validQuery = sharedLaunch
            ? share && queryValues.length === 2 && queryValues.includes("token") && queryValues.includes("share")
            : queryValues.length === 1 && queryValues[0] === "token"
          if (!validQuery) return respond(jsonError(400, "invalid_launch_url", "启动链接无效"), request.method)
          if (!sharedLaunch && remoteAddress && !isLoopbackAddress(remoteAddress)) {
            return respond(jsonError(403, "loopback_only", "本机启动链接只允许本机打开"), request.method)
          }
          const cookieValue = session.exchangeLaunchToken(url.searchParams.get("token") ?? "", sharedLaunch)
          if (!cookieValue) return respond(jsonError(401, "invalid_launch_token", "启动链接无效或已过期，请重新运行 killstata web"), request.method)
          const headers = new Headers({ Location: sharedLaunch ? "/?share=1" : "/" })
          headers.append("Set-Cookie", session.setCookieHeader(cookieValue))
          headers.append("Set-Cookie", sharedLaunch
            ? "killstata_share=1; SameSite=Strict; Path=/; Max-Age=28800"
            : "killstata_share=; SameSite=Strict; Path=/; Max-Age=0")
          return respond(new Response(null, {
            status: 303,
            headers,
          }), request.method)
        }

        const cookieHeader = request.headers.get("cookie")
        if (!session.authenticateCookieHeader(cookieHeader)) {
          return respond(jsonError(401, "web_session_required", "请使用终端刚生成的本机启动链接打开 KillStata"), request.method)
        }
        const sharedSession = session.isShareCookieHeader(cookieHeader)
        if (!isAllowedWebClientAddress(remoteAddress, share, sharedSession)) {
          return respond(jsonError(403, "loopback_only", "本机分析服务只允许本机访问"), request.method)
        }
        const stateChangingApiRequest = url.pathname.startsWith("/api/") && request.method !== "GET" && request.method !== "HEAD"
        if (!originMatches(request, expectedOrigin, stateChangingApiRequest)) {
          return respond(jsonError(403, "invalid_origin", "本地 Web 请求来源无效"), request.method)
        }

        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          if (url.searchParams.has("token")) return respond(jsonError(400, "token_in_query_rejected", "会话凭据不能通过 URL 参数传递"), request.method)
          if (sharedSession && !isShareApiRouteAllowed(url.pathname, request.method)) {
            return respond(jsonError(404, "share_route_unavailable", "此分享链接不允许访问该本机 API"), request.method)
          }
          try {
            return respond(await options.api(request), request.method)
          } catch {
            return respond(jsonError(500, "local_web_failure", "本机 Web 服务暂时无法处理请求"), request.method)
          }
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          return respond(new Response("Method Not Allowed", { status: 405 }), request.method)
        }

        let decodedPath: string
        try {
          decodedPath = decodeURIComponent(url.pathname)
        } catch {
          return respond(new Response("Bad Request", { status: 400 }), request.method)
        }
        if (decodedPath.includes("\\") || decodedPath.includes("\0")) {
          return respond(new Response("Forbidden", { status: 403 }), request.method)
        }
        const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "")
        const candidate = path.resolve(assetRoot, relativePath)
        if (!isWithin(assetRoot, candidate)) return respond(new Response("Forbidden", { status: 403 }), request.method)

        let filePath: string
        try {
          filePath = await realpath(candidate)
        } catch {
          return respond(new Response("Not Found", { status: 404 }), request.method)
        }
        if (!isWithin(assetRoot, filePath) || !(await stat(filePath)).isFile()) {
          return respond(new Response("Forbidden", { status: 403 }), request.method)
        }

        const headers = new Headers({
          "Content-Type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        })
        return respond(new Response(request.method === "HEAD" ? null : Bun.file(filePath), { headers }), request.method)
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/EADDRINUSE|port .+ in use/i.test(message)) {
      throw new Error("本地 Web 端口已被占用，请选择其他端口或关闭占用该端口的程序")
    }
    throw error
  }

  const url = `http://127.0.0.1:${server.port}/`
  const launchUrl = new URL(url)
  launchUrl.searchParams.set("token", session.launchToken)
  const shareUrls = shareAddresses.map((address) => {
    const shareURL = new URL(url)
    shareURL.hostname = address
    shareURL.searchParams.set("share", "1")
    shareURL.searchParams.set("token", session.shareToken!)
    return shareURL.toString()
  })
  return {
    url,
    launchUrl: launchUrl.toString(),
    shareUrls,
    async stop() {
      await server.stop(true)
    },
  }
}
