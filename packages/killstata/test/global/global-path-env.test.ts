import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"

describe("Global 路径环境隔离", () => {
  test("XDG 配置目录在模块加载前注入时成为 Global.Path.config", () => {
    const root = `${os.tmpdir()}/killstata-global-path-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const script = `import { Global } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/global/index.ts"))}; process.env.XDG_CONFIG_HOME=${JSON.stringify(path.join(root, "late-config"))}; console.log(Global.Path.config)`
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        HOME: root,
        KILLSTATA_TEST_HOME: root,
        XDG_CONFIG_HOME: path.join(root, "initial-config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
    })
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout).trim()).toBe(path.join(root, "late-config", "killstata"))
  })
})
