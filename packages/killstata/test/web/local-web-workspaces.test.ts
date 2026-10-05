import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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
      const created = await response?.json() as { id: string; name: string; directory?: string }
      const resolved = await registry.resolveDirectory(created.id)
      const data = await readdir(path.join(directory, "web", "workspaces"))

      expect(response?.status).toBe(201)
      expect(created.name).toBe("panel-study")
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(created.directory).toBeUndefined()
      expect(data).toEqual([created.id])
      expect(resolved.directory).toBe(await realpath(path.join(directory, "web", "workspaces", created.id)))
      expect((await stat(resolved.directory)).mode & 0o077).toBe(0)
      expect((await stat(path.join(directory, "web"))).mode & 0o077).toBe(0)
      expect((await stat(path.join(directory, "web", "workspaces.json"))).mode & 0o077).toBe(0)
      expect(await readFile(path.join(directory, "web", "workspaces.json"), "utf8")).toContain("panel-study")
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
