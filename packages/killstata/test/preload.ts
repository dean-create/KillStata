import os from "os"
import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { afterAll } from "bun:test"

const dir = path.join(os.tmpdir(), "killstata-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })

afterAll(() => {
  fsSync.rmSync(dir, { recursive: true, force: true })
})

const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["OPENCODE_TEST_HOME"] = testHome
process.env["HOME"] = testHome
process.env["USERPROFILE"] = testHome
process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["OPENCODE_DISABLE_MODELS_FETCH"] = "true"
