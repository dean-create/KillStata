import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

describe("killstata.runtime-config home directories", () => {
  test("ensureKillstataHomeDirectories creates only the private runtime root", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-home-"))
    const previousTestHome = process.env.KILLSTATA_TEST_HOME
    process.env.KILLSTATA_TEST_HOME = tempHome
    try {
      const { ensureKillstataHomeDirectories, userRoot } = await import(
        "../../src/killstata/runtime-config"
      )
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

  test("pins PyFixest in both the managed runtime and the manual repair command", async () => {
    const { REQUIRED_PYTHON_PACKAGES, pythonInstallCommand, pythonPackageInstallSpecs } = await import(
      "../../src/killstata/runtime-config"
    )

    expect(REQUIRED_PYTHON_PACKAGES).toContain("pyfixest")
    expect(pythonPackageInstallSpecs(["pyfixest"])).toEqual(["pyfixest==0.60.0"])
    expect(pythonInstallCommand("python3", ["pyfixest"])).toBe(
      "python3 -m pip install pyfixest==0.60.0",
    )
  })

  test("treats an installed but incompatible PyFixest version as missing", async () => {
    const { checkPythonPackages, probePythonExecutable } = await import(
      "../../src/killstata/runtime-config"
    )
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
