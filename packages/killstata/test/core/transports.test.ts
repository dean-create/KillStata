import { expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { CoreApplication } from "@/core/application"
import { CoreApplicationClient } from "@/core/client"
import { createInProcessCoreClient } from "@/core/transports"

function temporaryDirectory(prefix: string) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

test("in-process transport and CoreApplicationClient share one health contract", async () => {
  const directory = temporaryDirectory("killstata-core-transport-")
  const application = await CoreApplication.create({ directory })
  try {
    const direct = CoreApplicationClient.inProcess(application)
    const managed = createInProcessCoreClient(directory)
    const [directHealth, managedHealth] = await Promise.all([
      direct.sdk.global.health({ throwOnError: true }),
      managed.client.sdk.global.health({ throwOnError: true }),
    ])
    expect(directHealth.data?.healthy).toBe(true)
    expect(managedHealth.data?.healthy).toBe(true)
    await managed.dispose()
  } finally {
    await application.dispose()
  }
})
