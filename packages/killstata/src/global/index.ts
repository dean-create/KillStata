import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"

const app = "opencode"

const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)

export namespace Global {
  export const Path = {
    // Allow override via OPENCODE_TEST_HOME for test isolation
    get home() {
      return process.env.OPENCODE_TEST_HOME || os.homedir()
    },
    data,
    bin: path.join(data, "bin"),
    log: path.join(data, "log"),
    cache,
    config,
    state,
    // Allow overriding models.dev URL for offline deployments
    get modelsDevUrl() {
      return process.env.OPENCODE_MODELS_URL || "https://models.dev"
    },
  }
}

async function ensureDir(dir: string) {
  try {
    const stat = await fs.stat(dir).catch(() => undefined)
    if (stat?.isDirectory()) return
    await fs.mkdir(dir, { recursive: true })
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === "EEXIST") return
    throw error
  }
}

await Promise.all([
  ensureDir(Global.Path.data),
  ensureDir(Global.Path.config),
  ensureDir(Global.Path.state),
  ensureDir(Global.Path.log),
  ensureDir(Global.Path.bin),
])

const CACHE_VERSION = "18"

const version = await Bun.file(path.join(Global.Path.cache, "version"))
  .text()
  .catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Bun.file(path.join(Global.Path.cache, "version")).write(CACHE_VERSION)
}
