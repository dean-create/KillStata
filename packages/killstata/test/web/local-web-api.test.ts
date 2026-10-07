import { describe, expect, test } from "bun:test"
import type { CoreApplication } from "../../src/core/application"
import { createLocalWebApi, createLocalWebApiFromCore } from "../../src/web/local-web-api"

describe("local Web Engine Protocol API", () => {
  test("returns only the Engine Protocol v2 health contract", async () => {
    const api = createLocalWebApi({
      health: async () => ({ version: "test-core", healthy: true }),
      commands: async () => [],
    })

    const response = await api(new Request("http://127.0.0.1/api/v2/health"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      protocolVersion: "v2",
      engineVersion: "test-core",
      status: "ready",
      capabilities: { structuredSteps: true, interactive: true },
    })
  })

  test("maps Core commands to the v2 contract and never leaks Core fields", async () => {
    const api = createLocalWebApi({
      health: async () => ({ version: "test-core", healthy: true }),
      commands: async () => [{
        name: "/results",
        description: "  查看结果  ",
        hints: ["summary", "table"],
        internalPath: "/private/.killstata",
      }],
    })

    const response = await api(new Request("http://127.0.0.1/api/v2/commands"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      protocolVersion: "v2",
      commands: [{ name: "results", description: "查看结果", hints: ["summary", "table"] }],
    })
  })

  test("uses the public Core SDK over CoreApplication.fetch", async () => {
    const requests: string[] = []
    const application = {
      directory: "/managed/project",
      async fetch(request: Request) {
        const route = new URL(request.url).pathname
        requests.push(route)
        if (route === "/global/health") return Response.json({ healthy: true, version: "test-core" })
        if (route === "/command") return Response.json([{ name: "/results", hints: [], template: "internal" }])
        return new Response("Not Found", { status: 404 })
      },
      async dispose() {},
    } satisfies CoreApplication
    const api = createLocalWebApiFromCore(application)

    const health = await api(new Request("http://127.0.0.1/api/v2/health"))
    const commands = await api(new Request("http://127.0.0.1/api/v2/commands"))
    const commandsBody = await commands.text()

    expect(requests).toEqual(["/global/health", "/command"])
    expect((await health.json()).engineVersion).toBe("test-core")
    expect(JSON.parse(commandsBody)).toMatchObject({ commands: [{ name: "results", description: "执行此命令" }] })
    expect(commandsBody).not.toContain("internal")
  })

  test("does not forward unsupported methods or API paths to Core", async () => {
    const calls: string[] = []
    const api = createLocalWebApi({
      health: async () => { calls.push("health"); return { version: "test-core", healthy: true } },
      commands: async () => { calls.push("commands"); return [] },
    })

    const methodResponse = await api(new Request("http://127.0.0.1/api/v2/health", { method: "POST" }))
    const routeResponse = await api(new Request("http://127.0.0.1/api/v1/health"))

    expect(methodResponse.status).toBe(405)
    expect(routeResponse.status).toBe(404)
    expect(calls).toEqual([])
  })
})
