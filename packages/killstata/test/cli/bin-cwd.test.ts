import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("installed KillStata launcher", () => {
  test("preserves the caller working directory when starting its native executable", async () => {
    const callerDirectory = await mkdtemp(path.join(os.tmpdir(), "killstata-launch-cwd-"))
    temporaryDirectories.push(callerDirectory)
    const launcher = path.resolve(import.meta.dir, "../../bin/killstata")
    const result = Bun.spawnSync({
      cmd: [process.execPath, launcher, "-e", "process.stdout.write(process.cwd())"],
      cwd: callerDirectory,
      env: { ...process.env, KILLSTATA_BIN_PATH: process.execPath },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(await realpath(callerDirectory))
  })
})
