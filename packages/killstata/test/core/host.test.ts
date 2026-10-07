import { afterEach, expect, test, vi } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { startCoreHost } from "@/core/host"
import type { RuntimeDiagnosticsReport } from "@/killstata/runtime-diagnostics"

const hosts: Array<Awaited<ReturnType<typeof startCoreHost>>> = []
const directories: string[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

test("Core host allows browser preflight but keeps business routes authenticated", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "killstata-core-host-")))
  directories.push(directory)
  const host = await startCoreHost({ directory, port: 0, token: "test-token" })
  hosts.push(host)

  const preflight = await fetch(new URL("global/health", host.ready.url), {
    method: "OPTIONS",
    headers: {
      Origin: "http://tauri.localhost",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
    },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost")

  const unauthorized = await fetch(new URL("global/health", host.ready.url))
  expect(unauthorized.status).toBe(401)

  const authorized = await fetch(new URL("global/health", host.ready.url), {
    headers: { Authorization: "Bearer test-token" },
  })
  expect(authorized.status).toBe(200)
  expect(await authorized.json()).toMatchObject({ healthy: true })
})

test("Core host exposes runtime diagnostics only through its bearer-authenticated Tauri origin", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "killstata-core-host-runtime-")))
  directories.push(directory)
  const report: RuntimeDiagnosticsReport = { python: { label: "Python 3.12", status: "ready", detail: "managed", suggestion: "" }, packages: [] }
  const inspect = vi.fn(async () => report)
  const install = vi.fn(async () => report)
  const host = await startCoreHost({ directory, port: 0, token: "test-token", runtimeDiagnostics: { inspect, install } })
  hosts.push(host)

  const runtimeURL = new URL("runtime", host.ready.url)
  const preflight = await fetch(runtimeURL, {
    method: "OPTIONS",
    headers: {
      Origin: "tauri://localhost",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
    },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get("access-control-allow-origin")).toBe("tauri://localhost")

  const unauthenticated = await fetch(runtimeURL)
  expect(unauthenticated.status).toBe(401)
  expect(inspect).not.toHaveBeenCalled()

  const crossOrigin = await fetch(runtimeURL, {
    headers: { Authorization: "Bearer test-token", Origin: "http://attacker.example" },
  })
  expect(crossOrigin.status).toBe(403)
  expect(inspect).not.toHaveBeenCalled()

  const inspection = await fetch(runtimeURL, {
    headers: { Authorization: "Bearer test-token", Origin: "tauri://localhost" },
  })
  expect(inspection.status).toBe(200)
  expect(await inspection.json()).toEqual(report)
  expect(inspect).toHaveBeenCalledTimes(1)
  expect(install).not.toHaveBeenCalled()

  const invalidInstallation = await fetch(new URL("runtime/install", host.ready.url), {
    method: "POST",
    headers: { Authorization: "Bearer test-token", Origin: "tauri://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ packages: ["arbitrary-command-package"] }),
  })
  expect(invalidInstallation.status).toBe(400)
  expect(install).not.toHaveBeenCalled()

  const installation = await fetch(new URL("runtime/install", host.ready.url), {
    method: "POST",
    headers: { Authorization: "Bearer test-token", Origin: "tauri://localhost" },
  })
  expect(installation.status).toBe(200)
  expect(await installation.json()).toEqual(report)
  expect(install).toHaveBeenCalledTimes(1)
  expect(install.mock.calls[0]).toEqual([])
})
