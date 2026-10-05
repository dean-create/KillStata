import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

describe("killstata.runtime-config home directories", () => {
  test("waits for runtime subprocesses without blocking Bun and enforces a deadline", async () => {
    const { runProcessAsync } = await import("../../src/killstata/runtime-config")
    let timerAt: number | undefined
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerAt = Date.now()
        resolve()
      }, 25)
    })

    const startedAt = Date.now()
    const result = await runProcessAsync(process.execPath, ["-e", "setTimeout(() => process.stdout.write('ready'), 180)"], {}, { timeoutMs: 2_000 })
    const completedAt = Date.now()
    await timer

    expect(timerAt).toBeDefined()
    expect(timerAt!).toBeLessThan(completedAt)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("ready")
    await expect(runProcessAsync(process.execPath, ["-e", "setTimeout(() => {}, 5_000)"], {}, { timeoutMs: 50 })).rejects.toThrow("运行环境子进程超时")
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  test("terminates runtime subprocess descendants when a deadline expires", async () => {
    const { runProcessAsync } = await import("../../src/killstata/runtime-config")
    const marker = path.join(os.tmpdir(), `killstata-runtime-child-${process.pid}-${Date.now()}.txt`)
    const descendant = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "child-survived"), 1200)`
    const parent = `const fs=require("fs");const child=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setTimeout(()=>{},5000)`

    try {
      const operation = runProcessAsync(process.execPath, ["-e", parent], {}, { timeoutMs: 500 })
      const startupDeadline = Date.now() + 400
      while (!fs.existsSync(marker) && Date.now() < startupDeadline) await Bun.sleep(10)
      expect(fs.existsSync(marker)).toBe(true)
      await expect(operation).rejects.toThrow("运行环境子进程超时")
      await Bun.sleep(850)
      expect(fs.readFileSync(marker, "utf8")).toMatch(/^\d+$/)
    } finally {
      fs.rmSync(marker, { force: true })
    }
  })

  test("prefers explicit Python configuration to an existing managed interpreter", async () => {
    const { selectRuntimePythonSelection } = await import("../../src/killstata/runtime-config")

    expect(selectRuntimePythonSelection({
      environmentOverride: undefined,
      configOverride: "/configured/python",
      managedExecutable: "/managed/python",
      preferredExecutable: "/preferred/python",
      systemExecutable: "/usr/bin/python3",
      defaultExecutable: "python3",
    })).toEqual({ executable: "/configured/python", source: "config" })
  })

  test("keeps the cross-process lock longer than the maximum bounded runtime setup path", () => {
    const source = fs.readFileSync(path.resolve("src/killstata/runtime-config.ts"), "utf8")
    const lockWaitMinutes = Number(source.match(/const RUNTIME_INSTALL_LOCK_WAIT_MS = (\d+) \* 60_000/)?.[1])
    const maximumSetupMinutes = 3 * 20 + 5 * 0.5 + 2

    expect(lockWaitMinutes).toBeGreaterThan(maximumSetupMinutes)
  })

  test("serializes the same Python install target across independent Bun processes", async () => {
    const { runProcessAsync } = await import("../../src/killstata/runtime-config")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-python-install-lock-"))
    const marker = path.join(root, "installing")
    const attempts = [path.join(root, "first-attempt"), path.join(root, "second-attempt")]
    const modulePath = path.resolve("src/killstata/runtime-config.ts")
    const scripts = attempts.map((attempt, index) => {
      const otherAttempt = attempts[1 - index]!
      return [
        'import fs from "node:fs/promises"',
        'import { existsSync } from "node:fs"',
        `import { withRuntimePythonInstallLock } from ${JSON.stringify(modulePath)}`,
        `await fs.writeFile(${JSON.stringify(attempt)}, "attempting")`,
        `await withRuntimePythonInstallLock("/shared/configured/python", async () => {`,
        `  const owner = await fs.open(${JSON.stringify(marker)}, "wx"); await owner.close()`,
        `  const deadline = Date.now() + 5_000`,
        `  while (!existsSync(${JSON.stringify(otherAttempt)}) && Date.now() < deadline) await Bun.sleep(10)`,
        `  if (!existsSync(${JSON.stringify(otherAttempt)})) throw new Error("second process did not contend for the lock")`,
        `  await Bun.sleep(250); await fs.rm(${JSON.stringify(marker)}, { force: true })`,
        `})`,
      ].join("; ")
    })
    const env = {
      ...process.env,
      KILLSTATA_TEST_HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    }

    try {
      const [first, second] = await Promise.all(scripts.map((script) =>
        runProcessAsync(process.execPath, ["-e", script], env, { timeoutMs: 10_000 }),
      ))
      if (first.status !== 0) throw new Error(first.stderr || first.stdout)
      if (second.status !== 0) throw new Error(second.stderr || second.stdout)
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("keeps the managed Python lock stable when venv creation adds a symlink", async () => {
    const { runProcessAsync } = await import("../../src/killstata/runtime-config")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-python-symlink-lock-"))
    const executable = path.join(root, "venv", "bin", "python")
    const target = path.join(root, "runtime", "bin", "python3")
    const ready = path.join(root, "symlink-ready")
    const attempting = path.join(root, "contender-attempting")
    const marker = path.join(root, "installing")
    const modulePath = path.resolve("src/killstata/runtime-config.ts")
    const ownerScript = [
      'import fs from "node:fs/promises"',
      'import { existsSync } from "node:fs"',
      `import { withRuntimePythonInstallLock } from ${JSON.stringify(modulePath)}`,
      `await withRuntimePythonInstallLock(${JSON.stringify(executable)}, async () => {`,
      `  await fs.mkdir(${JSON.stringify(path.dirname(target))}, { recursive: true })`,
      `  await fs.writeFile(${JSON.stringify(target)}, "managed runtime")`,
      `  await fs.mkdir(${JSON.stringify(path.dirname(executable))}, { recursive: true })`,
      `  await fs.symlink(${JSON.stringify(target)}, ${JSON.stringify(executable)})`,
      `  const owner = await fs.open(${JSON.stringify(marker)}, "wx"); await owner.close()`,
      `  await fs.writeFile(${JSON.stringify(ready)}, "ready")`,
      `  const deadline = Date.now() + 5_000` ,
      `  while (!existsSync(${JSON.stringify(attempting)}) && Date.now() < deadline) await Bun.sleep(10)`,
      `  if (!existsSync(${JSON.stringify(attempting)})) throw new Error("contender did not reach the lock")`,
      `  await Bun.sleep(500)`,
      `  await fs.rm(${JSON.stringify(marker)}, { force: true })`,
      `})`,
    ].join("; ")
    const contenderScript = [
      'import fs from "node:fs/promises"',
      'import { existsSync } from "node:fs"',
      `import { withRuntimePythonInstallLock } from ${JSON.stringify(modulePath)}`,
      `while (!existsSync(${JSON.stringify(ready)})) await Bun.sleep(10)`,
      `await fs.writeFile(${JSON.stringify(attempting)}, "attempting")`,
      `await withRuntimePythonInstallLock(${JSON.stringify(executable)}, async () => { const contender = await fs.open(${JSON.stringify(marker)}, "wx"); await contender.close(); await fs.rm(${JSON.stringify(marker)}, { force: true }) })`,
    ].join("; ")
    const env = {
      ...process.env,
      KILLSTATA_TEST_HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    }

    try {
      const [owner, contender] = await Promise.all([
        runProcessAsync(process.execPath, ["-e", ownerScript], env, { timeoutMs: 10_000 }),
        runProcessAsync(process.execPath, ["-e", contenderScript], env, { timeoutMs: 10_000 }),
      ])
      if (owner.status !== 0) throw new Error(owner.stderr || owner.stdout || `owner exited ${owner.status}`)
      if (contender.status !== 0) throw new Error(contender.stderr || contender.stdout || `contender exited ${contender.status}`)
      expect(owner.status).toBe(0)
      expect(contender.status).toBe(0)
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("ensureKillstataHomeDirectories creates only the private runtime root", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-home-"))
    const previousTestHome = process.env.KILLSTATA_TEST_HOME
    process.env.KILLSTATA_TEST_HOME = tempHome
    try {
      const { ensureKillstataHomeDirectories, userRoot } = await import("../../src/killstata/runtime-config")
      await ensureKillstataHomeDirectories()

      expect(fs.existsSync(userRoot())).toBe(true)
      expect(fs.readdirSync(userRoot())).toEqual([])
    } finally {
      if (previousTestHome === undefined) delete process.env.KILLSTATA_TEST_HOME
      else process.env.KILLSTATA_TEST_HOME = previousTestHome
      fs.rmSync(tempHome, { recursive: true, force: true })
    }
  })

  test("uses a pinned uv release asset to bootstrap a private Windows runtime", async () => {
    const { uvReleaseAsset } = await import("../../src/killstata/runtime-config")

    expect(uvReleaseAsset({ platform: "win32", arch: "x64" })).toEqual({
      archive: "uv-x86_64-pc-windows-msvc.zip",
      executable: "uv.exe",
      compressed: "zip",
    })
    expect(uvReleaseAsset({ platform: "win32", arch: "arm64" })?.archive).toBe("uv-aarch64-pc-windows-msvc.zip")
    expect(uvReleaseAsset({ platform: "freebsd", arch: "x64" })).toBeUndefined()
  })

  test("reports automatic runtime setup failures without sending users to config", async () => {
    const { formatRuntimePythonSetupError } = await import("../../src/killstata/runtime-config")
    const message = formatRuntimePythonSetupError("econometrics", {
      executable: "python3",
      source: "default",
      ok: false,
      error: "network unavailable",
      missing: [],
      installCommand: "python3 -m pip install ...",
    })

    expect(message).toBe("KillStata 没能自动准备数据分析环境。请检查网络连接后重试当前分析。")
    expect(message.replace("KillStata", "")).not.toMatch(/[A-Za-z]{3,}/)
    expect(message).not.toContain("killstata config")
  })

  test("reports missing packages with an actionable install command", async () => {
    const { formatRuntimePythonSetupError } = await import("../../src/killstata/runtime-config")
    const message = formatRuntimePythonSetupError("ols_regression", {
      executable: "python3",
      source: "managed",
      ok: true,
      missing: ["pyfixest"],
      installCommand: "python3 -m pip install pyfixest==0.60.0",
    })

    expect(message).toContain("ols_regression")
    expect(message).toContain("缺少依赖包 pyfixest")
    expect(message).toContain("python3 -m pip install pyfixest==0.60.0")
  })

  test("pins PyFixest in both the managed runtime and the manual repair command", async () => {
    const { REQUIRED_PYTHON_PACKAGES, pythonInstallCommand, pythonPackageInstallSpecs } = await import(
      "../../src/killstata/runtime-config"
    )

    expect(REQUIRED_PYTHON_PACKAGES).toContain("pyfixest")
    expect(pythonPackageInstallSpecs(["pyfixest"])).toEqual(["pyfixest==0.60.0"])
    expect(pythonInstallCommand("python3", ["pyfixest"])).toBe("python3 -m pip install pyfixest==0.60.0")
  })

  test("installs Pydantic for the Python Registry contract", async () => {
    const { REQUIRED_PYTHON_PACKAGES, pythonPackageInstallSpecs } = await import(
      "../../src/killstata/runtime-config"
    )

    expect(REQUIRED_PYTHON_PACKAGES).toContain("pydantic")
    expect(pythonPackageInstallSpecs(["pydantic"])).toEqual(["pydantic==2.13.2"])
  })

  test("treats an installed but incompatible PyFixest version as missing", async () => {
    const { checkPythonPackages, probePythonExecutable } = await import("../../src/killstata/runtime-config")
    const probe = probePythonExecutable(process.env.KILLSTATA_PYTHON ?? "python3")
    expect(probe.ok).toBe(true)
    if (!probe.ok) return
    const python = probe.resolved

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-pyfixest-version-"))
    const packageDir = path.join(root, "pyfixest")
    fs.mkdirSync(packageDir)
    fs.writeFileSync(path.join(packageDir, "__init__.py"), "__version__ = '0.59.0'\n", "utf-8")
    const previous = process.env.PYTHONPATH
    process.env.PYTHONPATH = previous ? `${root}${path.delimiter}${previous}` : root
    try {
      expect(checkPythonPackages(python, ["pyfixest"]).missing).toEqual(["pyfixest"])
    } finally {
      if (previous === undefined) delete process.env.PYTHONPATH
      else process.env.PYTHONPATH = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
