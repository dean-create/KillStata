import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isAllowedWebClientAddress, isPrivateIPv4, isShareClientAddress, isShareApiRouteAllowed, privateIPv4Addresses, startLocalWebHost } from "../../src/web/local-web-host"
import { createLocalWebUiPreferences } from "../../src/web/local-web-ui-preferences"

type TestNetworkInterfaces = ReturnType<typeof os.networkInterfaces>

describe("local Web host", () => {
  let temporaryRoot: string | undefined
  let host: Awaited<ReturnType<typeof startLocalWebHost>> | undefined

  afterEach(async () => {
    await host?.stop()
    host = undefined
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  })

  async function start(
    api: (request: Request) => Promise<Response> = async () => Response.json({ ok: true }),
    options: { share?: boolean; networkInterfaces?: TestNetworkInterfaces } = {},
  ) {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "killstata-web-host-"))
    const assets = path.join(temporaryRoot, "dist")
    await mkdir(path.join(assets, "assets"), { recursive: true })
    await writeFile(path.join(assets, "index.html"), "<!doctype html><main>KillStata local web</main>")
    await writeFile(path.join(assets, "assets", "app.js"), "window.killstata = true")
    host = await startLocalWebHost({
      assetsDirectory: assets,
      api,
      port: 0,
      share: options.share,
      networkInterfaces: options.networkInterfaces ? () => options.networkInterfaces! : undefined,
    })
    return host
  }

  async function openBrowser(host: Awaited<ReturnType<typeof startLocalWebHost>>) {
    const response = await fetch(host.launchUrl, { redirect: "manual" })
    const cookie = response.headers.get("set-cookie")?.split(";")[0]
    return { response, cookie }
  }

  test("binds only to loopback and exchanges the launch URL for a clean browser session", async () => {
    const local = await start()
    const { response, cookie } = await openBrowser(local)

    expect(new URL(local.url).hostname).toBe("127.0.0.1")
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/")
    expect(response.headers.get("set-cookie")).toContain("HttpOnly")
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict")
    expect(response.headers.get("set-cookie")).toContain("Path=/")
    expect(cookie?.startsWith("killstata_web=")).toBe(true)

    const page = await fetch(local.url, { headers: { cookie: cookie! } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("KillStata local web")
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'")
    expect(page.headers.get("referrer-policy")).toBe("no-referrer")
  })

  test("advertises only private IPv4 interfaces for LAN sharing", () => {
    const interfaces: TestNetworkInterfaces = {
      en0: [
        { address: "192.168.1.12", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.1.12/24" },
        { address: "8.8.8.8", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "8.8.8.8/24" },
        { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: true, cidr: "127.0.0.1/8" },
      ],
      en1: [
        { address: "10.20.0.4", netmask: "255.255.0.0", family: "IPv4", mac: "", internal: false, cidr: "10.20.0.4/16" },
        { address: "172.31.4.9", netmask: "255.255.0.0", family: "IPv4", mac: "", internal: false, cidr: "172.31.4.9/16" },
      ],
    }

    expect(privateIPv4Addresses(interfaces)).toEqual(["10.20.0.4", "172.31.4.9", "192.168.1.12"])
    expect(isPrivateIPv4("192.168.1.12")).toBe(true)
    expect(isPrivateIPv4("8.8.8.8")).toBe(false)
    expect(isPrivateIPv4("172.32.0.1")).toBe(false)
    expect(isShareClientAddress("10.20.0.4")).toBe(true)
    expect(isShareClientAddress("::ffff:192.168.1.99")).toBe(true)
    expect(isShareClientAddress("8.8.8.8")).toBe(false)
    expect(isAllowedWebClientAddress("192.168.1.99", true, false)).toBe(false)
    expect(isAllowedWebClientAddress("192.168.1.99", true, true)).toBe(true)
    expect(isAllowedWebClientAddress("127.0.0.1", true, false)).toBe(true)
    expect(isAllowedWebClientAddress("127.0.0.1", false, false)).toBe(true)
  })

  test("lets share visitors use analysis with the host profile but blocks credential administration", () => {
    expect(isShareApiRouteAllowed("/api/v2/workspaces", "POST")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/workspaces/ensure", "POST")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/workspaces", "GET")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/credentials/profiles", "GET")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/credentials/status", "GET")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/credentials/activate", "POST")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/credentials/profiles", "POST")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/credentials/discover", "POST")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/runtime", "GET")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/health", "GET")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/runs", "POST")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/runs/run-1/events", "GET")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/runs/%2e%2e/credentials/profiles", "GET")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/runs/run-1/unknown", "POST")).toBe(false)
  })

  test("fails closed when LAN sharing cannot derive a private IPv4 address", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "killstata-web-share-no-lan-"))
    const assets = path.join(temporaryRoot, "dist")
    await mkdir(assets, { recursive: true })
    await writeFile(path.join(assets, "index.html"), "preview")

    await expect(startLocalWebHost({
      assetsDirectory: assets,
      api: async () => Response.json({ ok: true }),
      share: true,
      networkInterfaces: () => ({}),
      port: 0,
    })).rejects.toThrow("未检测到可用的私有局域网 IPv4 地址")
  })

  test("serves a share-token preview while denying credential and engine APIs", async () => {
    const apiCalls: Array<[string, string]> = []
    const shared = await start(async (request) => {
      const pathname = new URL(request.url).pathname
      apiCalls.push([pathname, request.method])
      if (pathname === "/api/v2/credentials/profiles") {
        return Response.json({ profiles: [{ id: "host-default", provider: "deepseek", model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true }], defaultProfileId: "host-default" })
      }
      return Response.json({ ok: true })
    }, {
      share: true,
      networkInterfaces: {
        en0: [{ address: "192.168.1.12", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.1.12/24" }],
      },
    })
    const shareURL = new URL(shared.shareUrls![0]!)
    const localShareLaunch = new URL(shared.url)
    localShareLaunch.searchParams.set("share", "1")
    localShareLaunch.searchParams.set("token", shareURL.searchParams.get("token")!)
    const first = await fetch(localShareLaunch, { redirect: "manual" })
    const firstCookie = first.headers.get("set-cookie")?.split(";")[0]
    const second = await fetch(localShareLaunch, { redirect: "manual" })
    expect(first.status).toBe(303)
    expect(first.headers.get("location")).toBe("/?share=1")
    expect(first.headers.get("set-cookie")).toContain("killstata_share=1")
    expect(second.status).toBe(303)
    expect(second.headers.get("set-cookie")?.split(";")[0]).toBe(firstCookie)

    const workspace = await fetch(new URL("/api/v2/workspaces", shared.url), {
      method: "POST",
      headers: { cookie: firstCookie!, origin: new URL(shared.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "visitor-study" }),
    })
    const credentials = await fetch(new URL("/api/v2/credentials/profiles", shared.url), { headers: { cookie: firstCookie! } })
    const forbiddenCredentialMutation = await fetch(new URL("/api/v2/credentials/profiles", shared.url), {
      method: "POST",
      headers: { cookie: firstCookie!, origin: new URL(shared.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "must-not-reach-host" }),
    })
    const activation = await fetch(new URL("/api/v2/credentials/activate", shared.url), {
      method: "POST",
      headers: { cookie: firstCookie!, origin: new URL(shared.url).origin },
    })
    const engine = await fetch(new URL("/api/v2/health", shared.url), { headers: { cookie: firstCookie! } })
    const workspaceList = await fetch(new URL("/api/v2/workspaces", shared.url), { headers: { cookie: firstCookie! } })
    const runtime = await fetch(new URL("/api/v2/runtime", shared.url), { headers: { cookie: firstCookie! } })

    expect(workspace.status).toBe(200)
    expect(credentials.status).toBe(200)
    expect(await credentials.json()).not.toHaveProperty("apiKey")
    expect(forbiddenCredentialMutation.status).toBe(404)
    expect(activation.status).toBe(200)
    expect(engine.status).toBe(200)
    expect(workspaceList.status).toBe(404)
    expect(runtime.status).toBe(404)

    const owner = await openBrowser(shared)
    expect(owner.response.headers.get("set-cookie")).toContain("killstata_share=;")
    const ownerHealth = await fetch(new URL("/api/v2/health", shared.url), {
      headers: { cookie: owner.cookie!, origin: new URL(shared.url).origin },
    })
    expect(ownerHealth.status).toBe(200)
    expect(apiCalls).toContainEqual(["/api/v2/workspaces", "POST"])
    expect(apiCalls).toContainEqual(["/api/v2/credentials/profiles", "GET"])
    expect(apiCalls).toContainEqual(["/api/v2/credentials/activate", "POST"])
    expect(apiCalls).toContainEqual(["/api/v2/health", "GET"])
  })

  test("reports a concise port-in-use error for a second Web listener", async () => {
    const first = await start()
    const secondAssets = path.join(temporaryRoot!, "second-dist")
    await mkdir(secondAssets, { recursive: true })
    await writeFile(path.join(secondAssets, "index.html"), "second app")

    await expect(startLocalWebHost({
      assetsDirectory: secondAssets,
      api: async () => Response.json({ ok: true }),
      port: Number(new URL(first.url).port),
    }))
      .rejects.toThrow("本地 Web 端口已被占用")
  })

  test("rejects static and API requests without the launch-derived cookie", async () => {
    const apiCalls: Request[] = []
    const local = await start(async (request) => {
      apiCalls.push(request)
      return Response.json({ ok: true })
    })

    const page = await fetch(local.url)
    const api = await fetch(new URL("/api/v2/health", local.url))
    expect(page.status).toBe(401)
    expect(api.status).toBe(401)
    expect(apiCalls).toHaveLength(0)
  })

  test("rejects a spoofed Host header even when the request reaches the loopback listener", async () => {
    const local = await start()
    const { cookie } = await openBrowser(local)
    const response = await fetch(local.url, { headers: { cookie: cookie!, host: "attacker.example" } })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "invalid_host" })
  })

  test("does not serve an asset symlink that resolves outside the Web asset root", async () => {
    const local = await start()
    const outsideFile = path.join(temporaryRoot!, "secret.txt")
    await writeFile(outsideFile, "private host file")
    await symlink(outsideFile, path.join(temporaryRoot!, "dist", "assets", "secret.txt"))
    const { cookie } = await openBrowser(local)
    const response = await fetch(new URL("/assets/secret.txt", local.url), { headers: { cookie: cookie! } })

    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain("private host file")
  })

  test("serves assets and same-origin API after launch without adding CORS access", async () => {
    const local = await start(async () => Response.json({ ok: true }, { headers: { "Cache-Control": "no-cache" } }))
    const { cookie } = await openBrowser(local)
    const asset = await fetch(new URL("/assets/app.js", local.url), { headers: { cookie: cookie! } })
    const api = await fetch(new URL("/api/v2/health", local.url), {
      headers: { cookie: cookie!, origin: local.url.replace(/\/$/, "") },
    })

    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain("window.killstata")
    expect(api.status).toBe(200)
    expect(await api.json()).toEqual({ ok: true })
    expect(api.headers.get("cache-control")).toBe("private, no-store")
    expect(api.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("allows cookie-authenticated same-origin GET streams without an Origin header", async () => {
    const local = await start()
    const { cookie } = await openBrowser(local)
    const response = await fetch(new URL("/api/v2/runs/run-1/events", local.url), {
      headers: { cookie: cookie! },
    })

    expect(response.status).toBe(200)
  })

  test("rejects state-changing API requests without a same-origin Origin header", async () => {
    const apiCalls: Request[] = []
    const local = await start(async (request) => {
      apiCalls.push(request)
      return Response.json({ ok: true })
    })
    const { cookie } = await openBrowser(local)
    const response = await fetch(new URL("/api/v2/runs", local.url), {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: "{}",
    })

    expect(response.status).toBe(403)
    expect(apiCalls).toHaveLength(0)
  })

  test("protects shared UI preference reads and writes with the launch session and same-origin policy", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "killstata-web-host-preferences-"))
    const assets = path.join(temporaryRoot, "dist")
    await mkdir(assets, { recursive: true })
    await writeFile(path.join(assets, "index.html"), "KillStata")
    const preferences = createLocalWebUiPreferences({ root: path.join(temporaryRoot, "home") })
    host = await startLocalWebHost({
      assetsDirectory: assets,
      api: async (request) => await preferences.handle(request) ?? Response.json({ missing: true }, { status: 404 }),
      port: 0,
    })
    const unauthorized = await fetch(new URL("/api/v2/ui-preferences", host.url), {
      method: "PUT",
      headers: { "content-type": "application/json", origin: new URL(host.url).origin },
      body: JSON.stringify({ key: "theme", value: "dark" }),
    })
    const { cookie } = await openBrowser(host)
    const crossOrigin = await fetch(new URL("/api/v2/ui-preferences", host.url), {
      method: "PUT",
      headers: { cookie: cookie!, "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ key: "theme", value: "dark" }),
    })
    const sameOrigin = await fetch(new URL("/api/v2/ui-preferences", host.url), {
      method: "PUT",
      headers: { cookie: cookie!, "content-type": "application/json", origin: new URL(host.url).origin },
      body: JSON.stringify({ key: "theme", value: "dark" }),
    })
    const read = await fetch(new URL("/api/v2/ui-preferences", host.url), { headers: { cookie: cookie! } })

    expect(unauthorized.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(sameOrigin.status).toBe(200)
    expect(await read.json()).toMatchObject({ preferences: { theme: "dark" } })
  })

  test("rejects cross-origin API requests before the Core/API handler", async () => {
    const apiCalls: Request[] = []
    const local = await start(async (request) => {
      apiCalls.push(request)
      return Response.json({ ok: true })
    })
    const { cookie } = await openBrowser(local)

    const response = await fetch(new URL("/api/v2/runs", local.url), {
      method: "POST",
      headers: { cookie: cookie!, origin: "http://evil.example", "content-type": "application/json" },
      body: "{}",
    })

    expect(response.status).toBe(403)
    expect(apiCalls).toHaveLength(0)
  })

  test("does not resolve a URL-encoded traversal outside the Web asset root", async () => {
    const local = await start()

    await writeFile(path.join(temporaryRoot!, "secret.txt"), "not a web asset")
    const { cookie } = await openBrowser(local)
    const response = await fetch(new URL("/%2e%2e/secret.txt", local.url), { headers: { cookie: cookie! } })

    expect([403, 404]).toContain(response.status)
    expect(await response.text()).not.toContain("not a web asset")
  })
})
