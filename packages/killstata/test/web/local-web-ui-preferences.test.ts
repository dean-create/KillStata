import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createLocalWebUiPreferences } from "../../src/web/local-web-ui-preferences"

describe("local Web shared UI preferences", () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true })
    root = undefined
  })

  test("stores theme, reasoning effort, and permission mode in separate private files", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "killstata-ui-preferences-"))
    const preferences = createLocalWebUiPreferences({ root })

    const empty = (await preferences.handle(new Request("http://127.0.0.1/api/v2/ui-preferences")))!
    expect(await empty.json()).toEqual({ protocolVersion: "v2", preferences: {} })

    const theme = (await preferences.handle(new Request("http://127.0.0.1/api/v2/ui-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "theme", value: "dark" }),
    })))!
    expect(theme.status).toBe(200)

    const effort = (await preferences.handle(new Request("http://127.0.0.1/api/v2/ui-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "reasoningEffort", value: "high" }),
    })))!
    expect(effort.status).toBe(200)

    for (const value of ["read_only", "workspace_write", "full_access"]) {
      const permission = (await preferences.handle(new Request("http://127.0.0.1/api/v2/ui-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "permissionMode", value }),
      })))!
      expect(permission.status).toBe(200)
    }

    const loaded = (await preferences.handle(new Request("http://127.0.0.1/api/v2/ui-preferences")))!
    expect(await loaded.json()).toEqual({ protocolVersion: "v2", preferences: { theme: "dark", reasoningEffort: "high", permissionMode: "full_access" } })
    expect((await fs.readdir(path.join(root!, "ui-preferences"))).sort()).toEqual(["permission-mode", "reasoning-effort", "theme"])
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(root!, "ui-preferences"))).mode & 0o777).toBe(0o700)
      expect((await fs.stat(path.join(root!, "ui-preferences", "theme"))).mode & 0o777).toBe(0o600)
      expect((await fs.stat(path.join(root!, "ui-preferences", "permission-mode"))).mode & 0o777).toBe(0o600)
    }
  })

  test("keeps one canonical mode when both surfaces concurrently seed an absent permission preference", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "killstata-ui-preference-seed-"))
    const preferences = createLocalWebUiPreferences({ root })

    const seeds = await Promise.all(["read_only", "full_access"].map((value) => preferences.handle(new Request("http://127.0.0.1/api/v2/ui-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "permissionMode", value, onlyIfAbsent: true }),
    }))))

    const saved = await Promise.all(seeds.map(async (response) => (await response!.json()).saved))
    expect(saved.sort()).toEqual([false, true])
    const loaded = (await preferences.handle(new Request("http://127.0.0.1/api/v2/ui-preferences")))!
    const mode = ((await loaded.json()) as { preferences: { permissionMode: string } }).preferences.permissionMode
    expect(["read_only", "full_access"]).toContain(mode)
  })

  test("rejects unknown keys, invalid values, extra fields, and unsupported methods", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "killstata-ui-preference-reject-"))
    const preferences = createLocalWebUiPreferences({ root })
    const send = (body: unknown) => preferences.handle(new Request("http://127.0.0.1/api/v2/ui-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }))

    expect((await send({ key: "permissionMode", value: "admin" }))!.status).toBe(400)
    expect((await send({ key: "theme", value: "contrast" }))!.status).toBe(400)
    expect((await send({ key: "theme", value: "dark", path: "../../outside" }))!.status).toBe(400)
    expect((await preferences.handle(new Request("http://127.0.0.1/api/v2/ui-preferences", { method: "DELETE" })))!.status).toBe(405)
    expect(await fs.readdir(root!)).toEqual([])
  })

  test("does not follow a symlink used as the KillStata home directory", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "killstata-ui-preference-symlink-"))
    const external = path.join(root, "external")
    const linkedHome = path.join(root, "linked-home")
    await fs.mkdir(external)
    await fs.symlink(external, linkedHome)
    const preferences = createLocalWebUiPreferences({ root: linkedHome })

    const response = (await preferences.handle(new Request("http://127.0.0.1/api/v2/ui-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "theme", value: "dark" }),
    })))!

    expect(response.status).toBe(500)
    expect(await fs.readdir(external)).toEqual([])
  })
})
