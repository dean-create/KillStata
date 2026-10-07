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
  if (pathname === "/api/v2/workspaces" || pathname === "/api/v2/workspaces/ensure"
    || pathname === "/api/v2/workspaces/prepare") return method === "POST"
  if (pathname === "/api/v2/credentials/status") return method === "GET"
  if (pathname === "/api/v2/credentials/activate") return method === "POST"
  if (pathname === "/api/v2/health" || pathname === "/api/v2/commands") return method === "GET"
  if (pathname === "/api/v2/datasets" || pathname === "/api/v2/runs") return method === "POST"
  if (pathname === "/api/v2/verification/events") return method === "GET"
  if (/^\/api\/v2\/runs\/[A-Za-z0-9_-]{1,128}\/(?:result|events|context)$/.test(pathname)) return method === "GET"
  if (/^\/api\/v2\/runs\/[A-Za-z0-9_-]{1,128}\/title$/.test(pathname)) return method === "PATCH"
  const mutatingRunRoute = /^\/api\/v2\/runs\/[A-Za-z0-9_-]{1,128}\/(?:cancel|interactions\/[A-Za-z0-9_-]{1,128}\/(?:answer|deny)|summarize|revert|undo|redo)$/
  return mutatingRunRoute.test(pathname) && method === "POST"
}

type SharePermissionAction = "allow" | "deny" | "ask"
type SharePermissionRule = { permission: string; pattern: string; action: SharePermissionAction }

const sharedPermissionRules = (edit: SharePermissionAction, bash: SharePermissionAction): SharePermissionRule[] => {
  const rule = (permission: string, action: SharePermissionAction): SharePermissionRule => ({ permission, pattern: "*", action })
  return [
    rule("read", "allow"),
    rule("glob", "allow"),
    rule("grep", "allow"),
    rule("list", "allow"),
    rule("todoread", "allow"),
    rule("todowrite", "allow"),
    rule("question", "allow"),
    rule("edit", edit),
    rule("write", edit),
    rule("patch", edit),
    rule("bash", bash),
    rule("task", "deny"),
    rule("webfetch", "deny"),
    rule("websearch", "deny"),
    rule("external_directory", "deny"),
  ]
}

const SHARE_PERMISSION_RULESETS = [
  sharedPermissionRules("ask", "ask"), // read_only
  sharedPermissionRules("allow", "ask"), // workspace_write
]

function isSupportedSharePermissionRuleset(value: unknown) {
  if (!Array.isArray(value)) return false
  return SHARE_PERMISSION_RULESETS.some((ruleset) => value.length === ruleset.length && ruleset.every((expected, index) => {
    const actual = value[index]
    return actual && typeof actual === "object" && !Array.isArray(actual)
      && (actual as Record<string, unknown>).permission === expected.permission
      && (actual as Record<string, unknown>).pattern === expected.pattern
      && (actual as Record<string, unknown>).action === expected.action
  }))
}

function isShareWorkspaceCreation(pathname: string, method: string) {
  return (pathname === "/api/v2/workspaces" || pathname === "/api/v2/workspaces/ensure") && method === "POST"
}

function isShareWorkspacePreparation(pathname: string, method: string) {
  return pathname === "/api/v2/workspaces/prepare" && method === "POST"
}

function isShareCredentialStatus(pathname: string, method: string) {
  return pathname === "/api/v2/credentials/status" && method === "GET"
}

function shareWorkspaceID(request: Request) {
  const url = new URL(request.url)
  const headerID = request.headers.get("x-killstata-workspace-id") ?? undefined
  const queryID = url.pathname.endsWith("/events") ? url.searchParams.get("workspaceId") ?? undefined : undefined
  if (headerID && queryID && headerID !== queryID) return undefined
  const id = headerID ?? queryID
  return id && id !== "__unassigned__" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined
}

async function hasSupportedSharedRunPermissions(request: Request) {
  const body = await request.clone().json().catch(() => undefined)
  if (!body || typeof body !== "object" || Array.isArray(body)) return false
  const permission = (body as Record<string, unknown>).permission
  return permission !== undefined && isSupportedSharePermissionRuleset(permission)
}

async function hasSupportedSharedModelRequest(request: Request, api: (request: Request) => Promise<Response>) {
  const body = await request.clone().json().catch(() => undefined)
  if (!body || typeof body !== "object" || Array.isArray(body)) return false
  const model = (body as Record<string, unknown>).model
  if (!model || typeof model !== "object" || Array.isArray(model)) return false
  const selection = model as Record<string, unknown>
  if (typeof selection.providerID !== "string" || typeof selection.modelID !== "string") return false

  try {
    const status = await sharedCredentialStatus(await api(new Request("http://127.0.0.1/api/v2/credentials/status")))
    if (!status.ok) return false
    const value = await status.json() as Record<string, unknown>
    if (value.configured !== true || typeof value.provider !== "string" || typeof value.model !== "string") return false
    const prefix = `${value.provider}/`
    const modelID = value.model.startsWith(prefix) ? value.model.slice(prefix.length) : value.model
    return selection.providerID === value.provider && selection.modelID === modelID
  } catch {
    return false
  }
}

async function hasShareWorkspaceCapability(request: Request) {
  const body = await request.clone().json().catch(() => undefined)
  if (!body || typeof body !== "object" || Array.isArray(body)) return false
  const token = (body as Record<string, unknown>).accessToken
  return typeof token === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(token)
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

async function sharedCredentialStatus(response: Response) {
  if (!response.ok) return response
  const body = await response.clone().json().catch(() => undefined)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError(502, "credential_status_invalid", "主机模型状态暂时不可用。")
  }
  const value = body as Record<string, unknown>
  const providers = new Set(["deepseek", "custom", "anthropic", "google"])
  if (typeof value.configured !== "boolean" || typeof value.provider !== "string" || !providers.has(value.provider)
    || typeof value.model !== "string" || !value.model.trim() || value.model.length > 256) {
    return jsonError(502, "credential_status_invalid", "主机模型状态暂时不可用。")
  }
  return Response.json({ configured: value.configured, provider: value.provider, model: value.model })
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
          if (sharedSession && url.pathname === "/api/v2/workspaces/ensure" && request.method === "POST"
            && !(await hasShareWorkspaceCapability(request))) {
            return respond(jsonError(403, "workspace_access_denied", "重新连接访客工作区需要此浏览器保存的工作区凭据。"), request.method)
          }
          if (sharedSession && url.pathname === "/api/v2/workspaces" && request.method === "POST") {
            const body = await request.clone().json().catch(() => undefined)
            const id = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).id : undefined
            if (typeof id !== "string" || !(await hasShareWorkspaceCapability(request))) {
              return respond(jsonError(403, "workspace_preparation_required", "访客工作区尚未安全准备或凭据无效，请重新选择工作区。"), request.method)
            }
          }
          const visitorWorkspaceID = sharedSession ? shareWorkspaceID(request) : undefined
          if (sharedSession && !isShareWorkspaceCreation(url.pathname, request.method)
            && !isShareWorkspacePreparation(url.pathname, request.method)
            && !isShareCredentialStatus(url.pathname, request.method)
            && (!visitorWorkspaceID || !session.hasShareWorkspace(cookieHeader, visitorWorkspaceID))) {
            return respond(jsonError(403, "workspace_required", "分享访客必须先选择一个独立工作区。"), request.method)
          }
          const runPathMatch = url.pathname.match(/^\/api\/v2\/runs\/([A-Za-z0-9_-]{1,128})\//)
          if (sharedSession && runPathMatch
            && (!visitorWorkspaceID || !session.hasShareRun(cookieHeader, visitorWorkspaceID, runPathMatch[1]!))) {
            return respond(jsonError(404, "share_run_unavailable", "此分享会话无法访问该研究。"), request.method)
          }
          let shareRunRequest: Record<string, unknown> | undefined
          if (sharedSession && url.pathname === "/api/v2/runs" && request.method === "POST") {
            const body = await request.clone().json().catch(() => undefined)
            shareRunRequest = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined
            if (shareRunRequest?.sessionID !== undefined
              && (typeof shareRunRequest.sessionID !== "string" || !visitorWorkspaceID
                || !session.hasShareRun(cookieHeader, visitorWorkspaceID, shareRunRequest.sessionID))) {
              return respond(jsonError(404, "share_run_unavailable", "此分享会话无法访问该研究。"), request.method)
            }
          }
          if (sharedSession && url.pathname === "/api/v2/runs" && request.method === "POST"
            && !(await hasSupportedSharedRunPermissions(request))) {
            return respond(jsonError(403, "share_permission_unsupported", "分享模式只允许只读分析或工作区读写授权；完全访问和自定义规则不可用。"), request.method)
          }
          const modelBoundShareRoute = (url.pathname === "/api/v2/runs"
            || /^\/api\/v2\/runs\/[A-Za-z0-9_-]{1,128}\/summarize$/.test(url.pathname))
            && request.method === "POST"
          if (sharedSession && modelBoundShareRoute && !(await hasSupportedSharedModelRequest(request, options.api))) {
            return respond(jsonError(403, "share_model_unsupported", "分享模式只能使用主机当前配置的默认模型。"), request.method)
          }
          try {
            const apiRequest = request.clone()
            apiRequest.headers.delete("x-killstata-workspace-role")
            apiRequest.headers.delete("x-killstata-workspace-preparation")
            apiRequest.headers.set("x-killstata-workspace-role", sharedSession ? "visitor" : "owner")
            if (sharedSession && url.pathname === "/api/v2/workspaces" && request.method === "POST") {
              apiRequest.headers.set("x-killstata-workspace-preparation", "1")
            }
            let response = await options.api(apiRequest)
            if (sharedSession && url.pathname === "/api/v2/credentials/status" && request.method === "GET") {
              response = await sharedCredentialStatus(response)
            }
            if (sharedSession && isShareWorkspaceCreation(url.pathname, request.method) && response.ok) {
              const body = await response.clone().json().catch(() => undefined)
              const id = body && typeof body === "object" && !Array.isArray(body)
                ? (body as Record<string, unknown>).id
                : undefined
              const accessToken = body && typeof body === "object" && !Array.isArray(body)
                ? (body as Record<string, unknown>).accessToken
                : undefined
              if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || id === "__unassigned__"
                || typeof accessToken !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(accessToken)
                || !session.registerShareWorkspace(cookieHeader, id)) {
                return respond(jsonError(502, "share_workspace_invalid", "无法建立访客工作区，请重新选择后重试。"), request.method)
              }
            }
            if (sharedSession && isShareWorkspacePreparation(url.pathname, request.method) && response.ok) {
              const body = await response.clone().json().catch(() => undefined)
              const id = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).id : undefined
              const accessToken = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).accessToken : undefined
              if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || id === "__unassigned__"
                || typeof accessToken !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(accessToken)) {
                return respond(jsonError(502, "workspace_preparation_invalid", "无法安全准备访客工作区，请重新选择后重试。"), request.method)
              }
            }
            if (sharedSession && url.pathname === "/api/v2/runs" && request.method === "POST" && response.ok
              && shareRunRequest?.sessionID === undefined) {
              const body = await response.clone().json().catch(() => undefined)
              const id = body && typeof body === "object" && !Array.isArray(body)
                ? (body as Record<string, unknown>).runId
                : undefined
              if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !visitorWorkspaceID
                || !session.registerShareRun(cookieHeader, visitorWorkspaceID, id)) {
                return respond(jsonError(502, "share_run_invalid", "无法登记本次分享会话，请重新开始研究。"), request.method)
              }
            }
            return respond(response, request.method)
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
