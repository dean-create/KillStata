import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { CoreApplication } from "@/core/application"
import { CoreApplicationClient } from "@/core/client"
import { CoreApplicationClient as CoreClient } from "@/core/client"
import { Instance } from "@/project/instance"

function temporaryDirectory(prefix: string) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

test("CoreApplication serves the existing API without going through yargs", async () => {
  const directory = temporaryDirectory("killstata-core-test-")
  const application = await CoreApplication.create({ directory })
  try {
    const response = await application.fetch(new Request("http://killstata.core/global/health"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ healthy: true })
  } finally {
    await application.dispose()
  }
})

test("CoreApplicationClient binds the same SDK to an in-process Core", async () => {
  const directory = temporaryDirectory("killstata-core-client-test-")
  const application = await CoreApplication.create({ directory })
  try {
    const client = CoreApplicationClient.inProcess(application)
    expect(client).toBeInstanceOf(CoreClient)
    const result = await client.sdk.global.health({ throwOnError: true })
    expect(result.data?.healthy).toBe(true)
  } finally {
    await application.dispose()
  }
})

test("CoreApplication uses an injectable runtime diagnostics owner in its directory context", async () => {
  const directory = temporaryDirectory("killstata-core-runtime-test-")
  const report = { python: { label: "Python 3.12", status: "ready" as const, detail: "managed", suggestion: "" }, packages: [] }
  const contexts: string[] = []
  const inspect = async () => { contexts.push(Instance.directory); return report }
  const install = async () => { contexts.push(Instance.directory); return report }
  const application = await CoreApplication.create({ directory, runtimeDiagnostics: { inspect, install } })
  try {
    await expect(application.runtimeDiagnostics!.inspect()).resolves.toEqual(report)
    await expect(application.runtimeDiagnostics!.install()).resolves.toEqual(report)
    expect(contexts).toEqual([directory, directory])
  } finally {
    await application.dispose()
    // File.init schedules a best-effort background workspace scan during Core bootstrap.
    await Bun.sleep(100)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("Core exposes a readable context snapshot for a real session without a model request", async () => {
  const directory = temporaryDirectory("killstata-core-context-route-test-")
  const application = await CoreApplication.create({ directory })
  try {
    const client = CoreApplicationClient.inProcess(application)
    const created = await client.sdk.session.create({ title: "Desktop context command test" }, { throwOnError: true })
    const response = await application.fetch(new Request(`http://killstata.core/session/${encodeURIComponent(created.data.id)}/context`))

    expect(response.status).toBe(200)
    const snapshot = await response.json() as { sessionID?: unknown; historyVersion?: unknown; tokenEstimate?: unknown }
    expect(snapshot.sessionID).toBe(created.data.id)
    expect(typeof snapshot.historyVersion).toBe("number")
    expect(typeof snapshot.tokenEstimate).toBe("number")
  } finally {
    await application.dispose()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
