import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"

const app = "killstata"

function xdgRoot(env: string, fallback: string | undefined, defaultRoot: string) {
  return process.env[env] || fallback || path.join(os.homedir(), defaultRoot)
}

export namespace Global {
  export const Path = {
    // Allow override via KILLSTATA_TEST_HOME for test isolation
    get home() {
      return process.env.KILLSTATA_TEST_HOME || os.homedir()
    },
    get data() {
      return path.join(xdgRoot("XDG_DATA_HOME", xdgData, ".local/share"), app)
    },
    get bin() {
      return path.join(this.data, "bin")
    },
    get log() {
      return path.join(this.data, "log")
    },
    get cache() {
      return path.join(xdgRoot("XDG_CACHE_HOME", xdgCache, ".cache"), app)
    },
    get config() {
      return path.join(xdgRoot("XDG_CONFIG_HOME", xdgConfig, ".config"), app)
    },
    get state() {
      return path.join(xdgRoot("XDG_STATE_HOME", xdgState, ".local/state"), app)
    },
    // Allow overriding models.dev URL for offline deployments
    get modelsDevUrl() {
      return process.env.KILLSTATA_MODELS_URL || "https://models.dev"
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
