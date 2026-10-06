import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { permissionRuleset } from "../../../../desktop/src/session-policy"
import { isAllowedWebClientAddress, isPrivateIPv4, isShareClientAddress, isShareApiRouteAllowed, privateIPv4Addresses, startLocalWebHost } from "../../src/web/local-web-host"
import { createLocalWebUiPreferences } from "../../src/web/local-web-ui-preferences"
import { createLocalWebWorkspaceRegistry } from "../../src/web/local-web-workspaces"

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
    expect(isShareApiRouteAllowed("/api/v2/workspaces/ensure", "POST")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/workspaces/prepare", "POST")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/workspaces", "GET")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/credentials/profiles", "GET")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/credentials/status", "GET")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/credentials/activate", "POST")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/credentials/profiles", "POST")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/credentials/discover", "POST")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/runtime", "GET")).toBe(false)
    expect(isShareApiRouteAllowed("/api/v2/health", "GET")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/runs", "POST")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/runs/run-1/events", "GET")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/runs/run-1/title", "PATCH")).toBe(true)
    expect(isShareApiRouteAllowed("/api/v2/runs/run-1/title", "POST")).toBe(false)
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
    let nextRunID = 0
    const shared = await start(async (request) => {
      const pathname = new URL(request.url).pathname
      apiCalls.push([pathname, request.method])
      if (pathname === "/api/v2/workspaces" || pathname === "/api/v2/workspaces/ensure" || pathname === "/api/v2/workspaces/prepare") {
        const body = await request.json().catch(() => ({})) as { name?: string }
        return Response.json({ protocolVersion: "v2", id: "visitor-workspace-1", name: body.name ?? "visitor-study", accessToken: "visitor-capability-token-012345678901234567890123" })
      }
      if (pathname === "/api/v2/credentials/profiles") {
        return Response.json({ profiles: [{ id: "host-default", provider: "deepseek", model: "deepseek/deepseek-v4-flash", configured: true, isDefault: true }], defaultProfileId: "host-default" })
      }
      if (pathname === "/api/v2/credentials/status") {
        return Response.json({
          configured: true,
          provider: "custom",
          model: "custom/host-model",
          profileId: "owner-private-profile-id",
          baseURL: "https://internal-owner-endpoint.example/v1",
          smallModel: "custom/private-small-model",
        })
      }
      if (pathname === "/api/v2/runs") return Response.json({ protocolVersion: "v2", runId: `shared-run-${++nextRunID}` })
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
    const secondCookie = second.headers.get("set-cookie")?.split(";")[0]
    expect(first.status).toBe(303)
    expect(first.headers.get("location")).toBe("/?share=1")
    expect(first.headers.get("set-cookie")).toContain("killstata_share=1")
    expect(second.status).toBe(303)
    expect(secondCookie).not.toBe(firstCookie)

    const preparation = await fetch(new URL("/api/v2/workspaces/prepare", shared.url), {
      method: "POST",
      headers: { cookie: firstCookie!, origin: new URL(shared.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "visitor-study" }),
    })
    const preparedWorkspace = await preparation.json() as { id: string; name: string; accessToken: string }
    const workspace = await fetch(new URL("/api/v2/workspaces", shared.url), {
      method: "POST",
      headers: { cookie: firstCookie!, origin: new URL(shared.url).origin, "content-type": "application/json" },
      body: JSON.stringify(preparedWorkspace),
    })
    const visitorWorkspaceID = preparedWorkspace.id
    const privateProfiles = await fetch(new URL("/api/v2/credentials/profiles", shared.url), { headers: { cookie: firstCookie! } })
    const credentials = await fetch(new URL("/api/v2/credentials/status", shared.url), { headers: { cookie: firstCookie! } })
    const forbiddenCredentialMutation = await fetch(new URL("/api/v2/credentials/profiles", shared.url), {
      method: "POST",
      headers: { cookie: firstCookie!, origin: new URL(shared.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "must-not-reach-host" }),
    })
    const activation = await fetch(new URL("/api/v2/credentials/activate", shared.url), {
      method: "POST",
      headers: { cookie: firstCookie!, origin: new URL(shared.url).origin, "x-killstata-workspace-id": visitorWorkspaceID },
    })
    const missingWorkspaceEngine = await fetch(new URL("/api/v2/health", shared.url), { headers: { cookie: firstCookie! } })
    const engine = await fetch(new URL("/api/v2/health", shared.url), {
      headers: { cookie: firstCookie!, "x-killstata-workspace-id": visitorWorkspaceID },
    })
    const otherVisitorWorkspaceEngine = await fetch(new URL("/api/v2/health", shared.url), {
      headers: { cookie: secondCookie!, "x-killstata-workspace-id": visitorWorkspaceID },
    })
    const reclaimedWorkspace = await fetch(new URL("/api/v2/workspaces/ensure", shared.url), {
      method: "POST",
      headers: { cookie: secondCookie!, origin: new URL(shared.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ id: visitorWorkspaceID, name: "visitor-study" }),
    })
    const capabilityRebind = await fetch(new URL("/api/v2/workspaces/ensure", shared.url), {
      method: "POST",
      headers: { cookie: secondCookie!, origin: new URL(shared.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ id: visitorWorkspaceID, name: "visitor-study", accessToken: "visitor-capability-token-012345678901234567890123" }),
    })
    const reclaimedHealth = await fetch(new URL("/api/v2/health", shared.url), {
      headers: { cookie: secondCookie!, "x-killstata-workspace-id": visitorWorkspaceID },
    })
    const workspaceList = await fetch(new URL("/api/v2/workspaces", shared.url), { headers: { cookie: firstCookie! } })
    const runtime = await fetch(new URL("/api/v2/runtime", shared.url), { headers: { cookie: firstCookie! } })

    expect(preparation.status).toBe(200)
    expect(workspace.status).toBe(200)
    expect(privateProfiles.status).toBe(404)
    expect(credentials.status).toBe(200)
    const sharedModelStatus = await credentials.json()
    expect(sharedModelStatus).toEqual({ configured: true, provider: "custom", model: "custom/host-model" })
    expect(forbiddenCredentialMutation.status).toBe(404)
    expect(activation.status).toBe(200)
    expect(missingWorkspaceEngine.status).toBe(403)
    expect(engine.status).toBe(200)
    expect(otherVisitorWorkspaceEngine.status).toBe(403)
    expect(reclaimedWorkspace.status).toBe(403)
    expect(capabilityRebind.status).toBe(200)
    expect(reclaimedHealth.status).toBe(200)
    expect(workspaceList.status).toBe(404)
    expect(runtime.status).toBe(404)

    const owner = await openBrowser(shared)
    expect(owner.response.headers.get("set-cookie")).toContain("killstata_share=;")
    const ownerHealth = await fetch(new URL("/api/v2/health", shared.url), {
      headers: { cookie: owner.cookie!, origin: new URL(shared.url).origin },
    })
    expect(ownerHealth.status).toBe(200)
    expect(apiCalls).toContainEqual(["/api/v2/workspaces/prepare", "POST"])
    expect(apiCalls).toContainEqual(["/api/v2/workspaces", "POST"])
    expect(apiCalls).toContainEqual(["/api/v2/credentials/status", "GET"])
    expect(apiCalls).not.toContainEqual(["/api/v2/credentials/profiles", "GET"])
    expect(apiCalls).toContainEqual(["/api/v2/credentials/activate", "POST"])
    expect(apiCalls).toContainEqual(["/api/v2/health", "GET"])
  })

  test("uses the prepared bearer capability across share sessions and ignores visitor role headers", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "killstata-web-share-registry-"))
    const assets = path.join(temporaryRoot, "dist")
    await mkdir(assets, { recursive: true })
    await writeFile(path.join(assets, "index.html"), "preview")
    const registry = createLocalWebWorkspaceRegistry({ dataDirectory: path.join(temporaryRoot, "data") })
    const shared = await startLocalWebHost({
      assetsDirectory: assets,
      api: async (request) => await registry.handle(request) ?? Response.json({ ok: true }),
      port: 0,
      share: true,
      networkInterfaces: () => ({
        en0: [{ address: "192.168.1.12", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.1.12/24" }],
      }),
    })
    host = shared
    const shareURL = new URL(shared.url)
    shareURL.searchParams.set("share", "1")
    shareURL.searchParams.set("token", new URL(shared.shareUrls![0]!).searchParams.get("token")!)
    const exchangeShareLink = async () => {
      const response = await fetch(shareURL, { redirect: "manual" })
      expect(response.status).toBe(303)
      return response.headers.get("set-cookie")?.split(";")[0]!
    }
    const firstCookie = await exchangeShareLink()
    const secondCookie = await exchangeShareLink()
    const origin = new URL(shared.url).origin
    const prepareResponse = await fetch(new URL("/api/v2/workspaces/prepare", shared.url), {
      method: "POST",
      headers: { cookie: firstCookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "visitor-study" }),
    })
    const preparedResponseBody = await prepareResponse.json() as { id: string; name: string; accessToken: string }
    const prepared = { id: preparedResponseBody.id, name: preparedResponseBody.name, accessToken: preparedResponseBody.accessToken }
    const registryAfterPrepare = await registry.list()
    const wrongCapability = `${prepared.accessToken[0] === "A" ? "B" : "A"}${prepared.accessToken.slice(1)}`
    const forgedFinalize = await fetch(new URL("/api/v2/workspaces", shared.url), {
      method: "POST",
      headers: { cookie: secondCookie, origin, "content-type": "application/json", "x-killstata-workspace-role": "owner" },
      body: JSON.stringify({ ...prepared, accessToken: wrongCapability }),
    })
    const registryAfterOtherSession = await registry.list()
    const createdResponse = await fetch(new URL("/api/v2/workspaces/ensure", shared.url), {
      method: "POST",
      headers: { cookie: secondCookie, origin, "content-type": "application/json", "x-killstata-workspace-role": "owner" },
      body: JSON.stringify(prepared),
    })
    const created = await createdResponse.json() as { id: string; name: string; accessToken: string }
    const ensureURL = new URL("/api/v2/workspaces/ensure", shared.url)
    const validRebind = await fetch(ensureURL, {
      method: "POST",
      headers: { cookie: firstCookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ id: created.id, name: created.name, accessToken: created.accessToken }),
    })
    const visitorHealth = await fetch(new URL("/api/v2/health", shared.url), {
      headers: { cookie: firstCookie, "x-killstata-workspace-id": created.id },
    })

    expect(prepareResponse.status).toBe(200)
    expect(registryAfterPrepare).toEqual([])
    expect(forgedFinalize.status).toBe(403)
    expect(registryAfterOtherSession).toEqual([])
    expect(createdResponse.status).toBe(200)
    expect(created.accessToken).toMatch(/^[A-Za-z0-9_-]{40,64}$/)
    expect(created).toMatchObject(prepared)
    expect(validRebind.status).toBe(200)
    expect((await validRebind.json()).accessToken).toBe(created.accessToken)
    expect(visitorHealth.status).toBe(200)
  })

  test("accepts only built-in session permission profiles from shared visitors", async () => {
    const apiCalls: Request[] = []
    let nextRunID = 0
    const shared = await start(async (request) => {
      const pathname = new URL(request.url).pathname
      if (pathname === "/api/v2/workspaces" || pathname === "/api/v2/workspaces/ensure" || pathname === "/api/v2/workspaces/prepare") {
        return Response.json({ protocolVersion: "v2", id: "visitor-workspace", name: "visitor-study", accessToken: "visitor-capability-token-012345678901234567890123" })
      }
      if (pathname === "/api/v2/credentials/status") {
        apiCalls.push(request)
        return Response.json({ configured: true, provider: "custom", model: "custom/host-model" })
      }
      apiCalls.push(request)
      if (pathname === "/api/v2/runs") return Response.json({ protocolVersion: "v2", runId: `shared-run-${++nextRunID}` })
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
    const launch = await fetch(localShareLaunch, { redirect: "manual" })
    const cookie = launch.headers.get("set-cookie")?.split(";")[0]
    const preparation = await fetch(new URL("/api/v2/workspaces/prepare", shared.url), {
      method: "POST",
      headers: { cookie: cookie!, origin: new URL(shared.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "visitor-study" }),
    })
    const preparedWorkspace = await preparation.json() as { id: string; name: string; accessToken: string }
    const workspace = await fetch(new URL("/api/v2/workspaces", shared.url), {
      method: "POST",
      headers: { cookie: cookie!, origin: new URL(shared.url).origin, "content-type": "application/json" },
      body: JSON.stringify(preparedWorkspace),
    })
    const visitorWorkspaceID = preparedWorkspace.id
    const headers = {
      cookie: cookie!,
      origin: new URL(shared.url).origin,
      "content-type": "application/json",
      "x-killstata-workspace-id": visitorWorkspaceID,
    }
    const forged = await fetch(new URL("/api/v2/runs", shared.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "inspect host files", model: { providerID: "custom", modelID: "host-model" }, permission: [{ permission: "*", pattern: "*", action: "allow" }] }),
    })
    const fullAccess = await fetch(new URL("/api/v2/runs", shared.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "inspect host files", model: { providerID: "custom", modelID: "host-model" }, permission: permissionRuleset("full_access") }),
    })
    const missingPermission = await fetch(new URL("/api/v2/runs", shared.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "inspect host files", model: { providerID: "custom", modelID: "host-model" } }),
    })
    const unsupportedModel = await fetch(new URL("/api/v2/runs", shared.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "inspect host files", model: { providerID: "deepseek", modelID: "deepseek-v4-pro" }, permission: permissionRuleset("workspace_write") }),
    })

    expect(forged.status).toBe(403)
    expect(await forged.json()).toMatchObject({ code: "share_permission_unsupported" })
    expect(fullAccess.status).toBe(403)
    expect(missingPermission.status).toBe(403)
    expect(unsupportedModel.status).toBe(403)
    expect(apiCalls.filter((request) => new URL(request.url).pathname === "/api/v2/runs")).toHaveLength(0)

    const supported = await fetch(new URL("/api/v2/runs", shared.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "inspect my dataset", model: { providerID: "custom", modelID: "host-model" }, permission: permissionRuleset("workspace_write") }),
    })
    expect(supported.status).toBe(200)
    expect(apiCalls.filter((request) => new URL(request.url).pathname === "/api/v2/runs")).toHaveLength(1)
    const supportedRunID = (await supported.json()).runId as string
    const ownRun = await fetch(new URL(`/api/v2/runs/${supportedRunID}/result`, shared.url), {
      headers: { cookie: cookie!, "x-killstata-workspace-id": visitorWorkspaceID },
    })
    expect(ownRun.status).toBe(200)
    const unsupportedSummaryModel = await fetch(new URL(`/api/v2/runs/${supportedRunID}/summarize`, shared.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ model: { providerID: "deepseek", modelID: "deepseek-v4-pro" } }),
    })
    expect(unsupportedSummaryModel.status).toBe(403)
    const supportedSummaryModel = await fetch(new URL(`/api/v2/runs/${supportedRunID}/summarize`, shared.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ model: { providerID: "custom", modelID: "host-model" } }),
    })
    expect(supportedSummaryModel.status).toBe(200)

    const readOnly = await fetch(new URL("/api/v2/runs", shared.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "inspect my dataset", model: { providerID: "custom", modelID: "host-model" }, permission: permissionRuleset("read_only") }),
    })
    expect(readOnly.status).toBe(200)
    expect(apiCalls.filter((request) => new URL(request.url).pathname === "/api/v2/runs")).toHaveLength(2)
    const secondLaunch = await fetch(localShareLaunch, { redirect: "manual" })
    const secondCookie = secondLaunch.headers.get("set-cookie")?.split(";")[0]
    const otherVisitorRun = await fetch(new URL(`/api/v2/runs/${supportedRunID}/result`, shared.url), {
      headers: { cookie: secondCookie!, "x-killstata-workspace-id": visitorWorkspaceID },
    })
    expect(otherVisitorRun.status).toBe(403)
    const reclaim = await fetch(new URL("/api/v2/workspaces/ensure", shared.url), {
      method: "POST",
      headers: { cookie: secondCookie!, origin: new URL(shared.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ id: visitorWorkspaceID, name: "visitor-study", accessToken: "visitor-capability-token-012345678901234567890123" }),
    })
    expect(reclaim.status).toBe(200)
    const staleRun = await fetch(new URL(`/api/v2/runs/${supportedRunID}/result`, shared.url), {
      headers: { cookie: secondCookie!, "x-killstata-workspace-id": visitorWorkspaceID },
    })
    expect(staleRun.status).toBe(404)
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
