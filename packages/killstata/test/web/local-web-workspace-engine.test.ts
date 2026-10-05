import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { CoreApplication } from "../../src/core/application"
import type { LocalWebEngineApi } from "../../src/web/local-web-engine"
import { createLocalWebWorkspaceEngine } from "../../src/web/local-web-workspace-engine"
import { createLocalWebWorkspaceRegistry } from "../../src/web/local-web-workspaces"

async function withWorkspaceRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "killstata-web-workspace-engine-"))
  try { await run(root) }
  finally { await rm(root, { recursive: true, force: true }) }
}

describe("per-workspace Web Core router", () => {
  test("serves shared UI preferences before requiring a selected workspace Core", async () => {
    await withWorkspaceRoot(async (root) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: path.join(root, "data"), launchDirectory: root })
      let createdCores = 0
      const engine = createLocalWebWorkspaceEngine({
        registry,
        createCore: async ({ directory }) => {
          createdCores += 1
          return { directory, fetch: async () => new Response(), dispose: async () => {} }
        },
        createRuntimeHandler: () => async () => undefined,
        createApi: (application) => Object.assign(
          async () => Response.json({ directory: application.directory }),
          { dispose() {}, isIdle: () => true },
        ) as LocalWebEngineApi,
        uiPreferenceHandler: async (request) => new URL(request.url).pathname === "/api/v2/ui-preferences"
          ? Response.json({ protocolVersion: "v2", preferences: { reasoningEffort: "high" } })
          : undefined,
      })

      const response = await engine(new Request("http://127.0.0.1/api/v2/ui-preferences"))
      expect(await response.json()).toEqual({ protocolVersion: "v2", preferences: { reasoningEffort: "high" } })
      expect(createdCores).toBe(0)
      await engine.shutdown()
    })
  })

  test("routes opaque workspace IDs to isolated Core directories", async () => {
    await withWorkspaceRoot(async (root) => {
      const launchDirectory = path.join(root, "launch")
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: path.join(root, "data"), launchDirectory })
      const first = await registry.create("first-study")
      const second = await registry.create("second-study")
      const firstDirectory = (await registry.resolveDirectory(first.id)).directory
      const secondDirectory = (await registry.resolveDirectory(second.id)).directory
      const createdDirectories: string[] = []
      const disposedDirectories: string[] = []
      const engine = createLocalWebWorkspaceEngine({
        registry,
        createCore: async ({ directory }) => {
          createdDirectories.push(directory)
          return { directory, fetch: async () => new Response(), dispose: async () => { disposedDirectories.push(directory) } } satisfies CoreApplication
        },
        createRuntimeHandler: () => async () => undefined,
        createApi: (application) => Object.assign(
          async () => Response.json({ directory: application.directory }),
          { dispose() {}, isIdle: () => true },
        ) as LocalWebEngineApi,
      })

      const defaultResult = await engine(new Request("http://127.0.0.1/api/v2/health"))
      const firstResult = await engine(new Request("http://127.0.0.1/api/v2/health", { headers: { "x-killstata-workspace-id": first.id } }))
      const secondResult = await engine(new Request("http://127.0.0.1/api/v2/health", { headers: { "x-killstata-workspace-id": second.id } }))
      const directories = [
        (await defaultResult.json()).directory,
        (await firstResult.json()).directory,
        (await secondResult.json()).directory,
      ]

      expect(directories).toEqual([launchDirectory, firstDirectory, secondDirectory])
      expect(new Set(createdDirectories).size).toBe(3)
      await engine.shutdown()
      expect(disposedDirectories).toHaveLength(3)
    })
  })

  test("routes EventSource requests by opaque query ID and rejects conflicting context", async () => {
    await withWorkspaceRoot(async (root) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: path.join(root, "data"), launchDirectory: root })
      const workspace = await registry.create("event-study")
      const workspaceDirectory = (await registry.resolveDirectory(workspace.id)).directory
      const engine = createLocalWebWorkspaceEngine({
        registry,
        createCore: async ({ directory }) => ({ directory, fetch: async () => new Response(), dispose: async () => {} }),
        createRuntimeHandler: () => async () => undefined,
        createApi: (application) => Object.assign(
          async () => Response.json({ directory: application.directory }),
          { dispose() {}, isIdle: () => true },
        ) as LocalWebEngineApi,
      })

      const streamRoute = await engine(new Request(`http://127.0.0.1/api/v2/runs/run-1/events?workspaceId=${workspace.id}`))
      const unknownRoute = await engine(new Request("http://127.0.0.1/api/v2/health", { headers: { "x-killstata-workspace-id": "../outside" } }))
      const conflictRoute = await engine(new Request(`http://127.0.0.1/api/v2/runs/run-1/events?workspaceId=${workspace.id}`, { headers: { "x-killstata-workspace-id": "__unassigned__" } }))

      expect((await streamRoute.json()).directory).toBe(workspaceDirectory)
      expect(unknownRoute.status).toBe(400)
      expect(conflictRoute.status).toBe(400)
      await engine.shutdown()
    })
  })

  test("does not evict workspace cores with active runs", async () => {
    await withWorkspaceRoot(async (root) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: path.join(root, "data"), launchDirectory: root })
      const first = await registry.create("first")
      const second = await registry.create("second")
      const firstDirectory = (await registry.resolveDirectory(first.id)).directory
      const secondDirectory = (await registry.resolveDirectory(second.id)).directory
      let firstIdle = false
      const disposed: string[] = []
      const engine = createLocalWebWorkspaceEngine({
        registry,
        maxLiveCores: 1,
        createCore: async ({ directory }) => ({ directory, fetch: async () => new Response(), dispose: async () => { disposed.push(directory) } }),
        createRuntimeHandler: () => async () => undefined,
        createApi: (application) => Object.assign(
          async () => Response.json({ directory: application.directory }),
          { dispose() {}, isIdle: () => application.directory === firstDirectory ? firstIdle : true },
        ) as LocalWebEngineApi,
      })

      await engine(new Request("http://127.0.0.1/api/v2/health", { headers: { "x-killstata-workspace-id": first.id } }))
      const blocked = await engine(new Request("http://127.0.0.1/api/v2/health", { headers: { "x-killstata-workspace-id": second.id } }))
      expect(blocked.status).toBe(429)
      firstIdle = true
      const switched = await engine(new Request("http://127.0.0.1/api/v2/health", { headers: { "x-killstata-workspace-id": second.id } }))
      expect((await switched.json()).directory).toBe(secondDirectory)
      expect(disposed).toEqual([firstDirectory])
      await engine.shutdown()
    })
  })

  test("rejects an unknown workspace before evicting a valid idle Core", async () => {
    await withWorkspaceRoot(async (root) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: path.join(root, "data"), launchDirectory: root })
      const workspace = await registry.create("kept-study")
      const workspaceDirectory = (await registry.resolveDirectory(workspace.id)).directory
      const disposed: string[] = []
      let created = 0
      const engine = createLocalWebWorkspaceEngine({
        registry,
        maxLiveCores: 1,
        createCore: async ({ directory }) => {
          created += 1
          return { directory, fetch: async () => new Response(), dispose: async () => { disposed.push(directory) } }
        },
        createRuntimeHandler: () => async () => undefined,
        createApi: (application) => Object.assign(
          async () => Response.json({ directory: application.directory }),
          { dispose() {}, isIdle: () => true },
        ) as LocalWebEngineApi,
      })

      const request = (workspaceID: string) => engine(new Request("http://127.0.0.1/api/v2/health", {
        headers: { "x-killstata-workspace-id": workspaceID },
      }))
      await request(workspace.id)
      const missing = await request("missing-workspace")
      const stillCached = await request(workspace.id)

      expect(missing.status).toBe(404)
      expect((await stillCached.json()).directory).toBe(workspaceDirectory)
      expect(created).toBe(1)
      expect(disposed).toEqual([])
      await engine.shutdown()
    })
  })
})
