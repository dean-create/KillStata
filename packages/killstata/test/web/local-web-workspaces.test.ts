import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createLocalWebWorkspaceRegistry } from "../../src/web/local-web-workspaces"

async function withDataDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "killstata-web-workspaces-"))
  try { await run(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

describe("local Web managed workspaces", () => {
  test("creates a private managed directory and returns only an opaque workspace ID", async () => {
    await withDataDirectory(async (directory) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: directory })
      const response = await registry.handle(new Request("http://127.0.0.1/api/v2/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "panel-study" }),
      }))
      const created = await response?.json() as { id: string; name: string; directory?: string; accessToken: string }
      const resolved = await registry.resolveDirectory(created.id)
      const data = await readdir(path.join(directory, "web", "workspaces"))
      const serializedRegistry = await readFile(path.join(directory, "web", "workspaces.json"), "utf8")

      expect(response?.status).toBe(201)
      expect(created.name).toBe("panel-study")
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(created.accessToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
      expect(created.directory).toBeUndefined()
      expect(serializedRegistry).not.toContain(created.accessToken)
      expect(serializedRegistry).toContain("accessTokenHash")
      expect(data).toEqual([created.id])
      expect(resolved.directory).toBe(await realpath(path.join(directory, "web", "workspaces", created.id)))
      expect((await stat(resolved.directory)).mode & 0o077).toBe(0)
      expect((await stat(path.join(directory, "web"))).mode & 0o077).toBe(0)
      expect((await stat(path.join(directory, "web", "workspaces.json"))).mode & 0o077).toBe(0)
      expect(serializedRegistry).toContain("panel-study")
    })
  })

  test("preserves concurrent workspace writes from independent hosts sharing one data directory", async () => {
    await withDataDirectory(async (directory) => {
      const registries = Array.from({ length: 6 }, () => createLocalWebWorkspaceRegistry({ dataDirectory: directory }))
      const created = await Promise.all(registries.map((registry, index) => registry.create(`parallel-study-${index}`)))
      const listed = await registries[0]!.list()

      expect(listed.map(({ id }) => id).sort()).toEqual(created.map(({ id }) => id).sort())
      expect(await Promise.all(created.map(({ id }) => registries[0]!.resolveDirectory(id)))).toHaveLength(created.length)
    })
  })

  test("serializes workspace registry updates across host processes", async () => {
    await withDataDirectory(async (directory) => {
      const moduleURL = pathToFileURL(path.resolve(import.meta.dir, "../../src/web/local-web-workspaces.ts")).href
      const children = ["process-study-a", "process-study-b"].map((name) => Bun.spawn([process.execPath, "-e", `
        import { createLocalWebWorkspaceRegistry } from ${JSON.stringify(moduleURL)}
        createLocalWebWorkspaceRegistry({ dataDirectory: ${JSON.stringify(directory)} })
          .create(${JSON.stringify(name)})
          .catch(() => { process.exitCode = 1 })
      `], { cwd: path.resolve(import.meta.dir, "../.."), stdout: "ignore", stderr: "ignore" }))
      const exitCodes = await Promise.all(children.map((child) => child.exited))
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: directory })

      expect(exitCodes).toEqual([0, 0])
      expect((await registry.list()).map(({ name }) => name).sort()).toEqual(["process-study-a", "process-study-b"])
    })
  })

  test("requires the workspace capability to rebind a shared browser workspace", async () => {
    await withDataDirectory(async (directory) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: directory })
      const created = await registry.handle(new Request("http://127.0.0.1/api/v2/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "private-study" }),
      }))
      const workspace = await created?.json() as { id: string; name: string; accessToken: string }
      const ensure = (accessToken?: string) => registry.handle(new Request("http://127.0.0.1/api/v2/workspaces/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-killstata-workspace-role": "visitor" },
        body: JSON.stringify({ id: workspace.id, name: workspace.name, ...(accessToken ? { accessToken } : {}) }),
      }))

      expect((await ensure())?.status).toBe(403)
      expect((await ensure("forged-workspace-token"))?.status).toBe(403)
      const rebound = await ensure(workspace.accessToken)
      expect(rebound?.status).toBe(200)
      expect(await rebound?.json()).toMatchObject({ id: workspace.id, name: workspace.name, accessToken: workspace.accessToken })
      expect(await registry.resolveDirectory(workspace.id)).not.toHaveProperty("accessTokenHash")
    })
  })

  test("prepares a visitor capability without creating a workspace, then finalizes only through the host preparation marker", async () => {
    await withDataDirectory(async (directory) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: directory })
      const preparedResponse = await registry.handle(new Request("http://127.0.0.1/api/v2/workspaces/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-killstata-workspace-role": "visitor" },
        body: JSON.stringify({ name: "prepared-study" }),
      }))
      const prepared = await preparedResponse?.json() as { id: string; name: string; accessToken: string }
      const finalize = (hostPreparationMarker: boolean) => registry.handle(new Request("http://127.0.0.1/api/v2/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-killstata-workspace-role": "visitor",
          ...(hostPreparationMarker ? { "x-killstata-workspace-preparation": "1" } : {}),
        },
        body: JSON.stringify({ id: prepared.id, name: prepared.name, accessToken: prepared.accessToken }),
      }))

      expect(preparedResponse?.status).toBe(200)
      expect(prepared.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
      expect(prepared.accessToken).toMatch(/^[A-Za-z0-9_-]{40,64}$/)
      expect(await registry.list()).toEqual([])
      expect((await finalize(false))?.status).toBe(403)
      const createdResponse = await finalize(true)
      expect(createdResponse?.status).toBe(201)
      expect(await createdResponse?.json()).toMatchObject(prepared)
      expect(await registry.list()).toEqual([{ id: prepared.id, name: prepared.name }])
      expect((await registry.resolveDirectory(prepared.id)).directory).toContain(prepared.id)
    })
  })

  test("lets a saved prepared capability finalize through ensure after a browser reload", async () => {
    await withDataDirectory(async (directory) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: directory })
      const preparedResponse = await registry.handle(new Request("http://127.0.0.1/api/v2/workspaces/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-killstata-workspace-role": "visitor" },
        body: JSON.stringify({ name: "reload-study" }),
      }))
      const prepared = await preparedResponse?.json() as { id: string; name: string; accessToken: string }
      const ensure = (accessToken: string) => registry.handle(new Request("http://127.0.0.1/api/v2/workspaces/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-killstata-workspace-role": "visitor" },
        body: JSON.stringify({ id: prepared.id, name: prepared.name, accessToken }),
      }))

      expect(preparedResponse?.status).toBe(200)
      expect(await registry.list()).toEqual([])
      expect((await ensure("A".repeat(prepared.accessToken.length)))?.status).toBe(404)
      expect(await registry.list()).toEqual([])

      const finalized = await ensure(prepared.accessToken)
      expect(finalized?.status).toBe(200)
      expect(await finalized?.json()).toMatchObject(prepared)
      expect(await registry.list()).toEqual([{ id: prepared.id, name: prepared.name }])

      const retried = await ensure(prepared.accessToken)
      expect(retried?.status).toBe(200)
      expect(await retried?.json()).toMatchObject(prepared)
    })
  })

  test("expires an uncommitted visitor capability without creating a workspace", async () => {
    await withDataDirectory(async (directory) => {
      let currentTime = 10_000
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: directory, now: () => currentTime })
      const prepared = await registry.prepare("expired-study")
      currentTime += 60_001
      const response = await registry.handle(new Request("http://127.0.0.1/api/v2/workspaces/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-killstata-workspace-role": "visitor" },
        body: JSON.stringify({ id: prepared.id, name: prepared.name, accessToken: prepared.accessToken }),
      }))

      expect(response?.status).toBe(404)
      expect(await registry.list()).toEqual([])
    })
  })

  test("lets only the local owner rotate a legacy workspace capability", async () => {
    await withDataDirectory(async (directory) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: directory })
      const workspaceRoot = path.join(directory, "web", "workspaces")
      const workspaceID = "legacy-workspace-1"
      await mkdir(path.join(workspaceRoot, workspaceID), { recursive: true })
      await writeFile(path.join(directory, "web", "workspaces.json"), JSON.stringify({ version: 1, workspaces: [{ id: workspaceID, name: "legacy" }] }))
      const response = await registry.handle(new Request("http://127.0.0.1/api/v2/workspaces/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-killstata-workspace-role": "owner" },
        body: JSON.stringify({ id: workspaceID, name: "legacy" }),
      }))
      const result = await response?.json() as { id: string; name: string; accessToken: string }

      expect(response?.status).toBe(200)
      expect(result.id).toBe(workspaceID)
      expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    })
  })

  test("rejects arbitrary paths and malformed workspace names without creating directories", async () => {
    await withDataDirectory(async (directory) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: directory })
      const response = await registry.handle(new Request("http://127.0.0.1/api/v2/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "research", path: "/etc" }),
      }))

      expect(response?.status).toBe(400)
      expect(await readdir(path.join(directory, "web").replace(/\/workspaces$/, "")).catch(() => [])).toEqual([])
    })
  })

  test("keeps the unassigned workspace bound to the launch directory", async () => {
    await withDataDirectory(async (directory) => {
      const launchDirectory = path.join(directory, "launch")
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: path.join(directory, "data"), launchDirectory })
      const resolved = await registry.resolveDirectory("__unassigned__")
      expect(resolved).toEqual({ id: "__unassigned__", name: "未归档研究", directory: launchDirectory })
    })
  })

  test("rejects a managed workspace directory replaced by an external symlink", async () => {
    await withDataDirectory(async (directory) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: directory })
      const workspace = await registry.create("panel-study")
      const external = await mkdtemp(path.join(os.tmpdir(), "killstata-web-workspace-link-"))
      const workspaceDirectory = path.join(directory, "web", "workspaces", workspace.id)
      try {
        await rm(workspaceDirectory, { recursive: true })
        await symlink(external, workspaceDirectory)
        await expect(registry.resolveDirectory(workspace.id)).rejects.toThrow("不在本机受管数据范围内")
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })
  })

  test("rejects a workspace directory replaced with a symlink outside the managed root", async () => {
    await withDataDirectory(async (directory) => {
      const registry = createLocalWebWorkspaceRegistry({ dataDirectory: directory })
      const workspace = await registry.create("linked-study")
      const workspaceDirectory = path.join(directory, "web", "workspaces", workspace.id)
      const outside = await mkdtemp(path.join(os.tmpdir(), "killstata-web-outside-"))
      try {
        await rm(workspaceDirectory, { recursive: true })
        await symlink(outside, workspaceDirectory)
        await expect(registry.resolveDirectory(workspace.id)).rejects.toThrow("不在本机受管数据范围内")
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })
})
