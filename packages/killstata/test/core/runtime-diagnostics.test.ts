import { describe, expect, test, vi } from "bun:test"
import { REQUIRED_PYTHON_PACKAGES, type RuntimePythonStatus } from "../../src/killstata/runtime-config"
import { createRuntimeDiagnostics, runtimeReportFromStatus } from "../../src/killstata/runtime-diagnostics"

function status(overrides: Partial<RuntimePythonStatus> = {}): RuntimePythonStatus {
  return {
    executable: "/managed/bin/python",
    source: "managed",
    version: "Python 3.12.13",
    ok: true,
    missing: [],
    installCommand: "managed installer",
    ...overrides,
  }
}

describe("Core runtime diagnostics", () => {
  test("projects the Core Python source and fixed package statuses into the shared settings report", () => {
    const report = runtimeReportFromStatus(status({ missing: ["pandas"] }))

    expect(report.python).toEqual({
      label: "Python 解释器",
      status: "warning",
      detail: "Python 3.12.13 · /managed/bin/python · KillStata 受管环境",
      suggestion: "确认安装缺失的固定分析依赖。",
    })
    expect(report.packages.map((item) => item.label)).toEqual([...REQUIRED_PYTHON_PACKAGES])
    expect(report.packages.find((item) => item.label === "pandas")).toMatchObject({ status: "warning", detail: "未安装或无法读取。" })
    expect(report.packages.find((item) => item.label === "numpy")).toMatchObject({ status: "ready", detail: "已安装。" })
  })

  test("inspection always uses Core's fixed required package list", async () => {
    const getStatus = vi.fn(async () => status())
    const diagnostics = createRuntimeDiagnostics({ getStatus })

    await diagnostics.inspect()

    expect(getStatus).toHaveBeenCalledWith([...REQUIRED_PYTHON_PACKAGES])
  })

  test("a missing managed package is repaired through the Core managed runtime", async () => {
    const getStatus = vi.fn()
      .mockResolvedValueOnce(status({ missing: ["pandas"] }))
      .mockResolvedValueOnce(status())
    const ensureRuntimePythonReady = vi.fn(async () => status())
    const installPythonPackages = vi.fn(async () => {})
    const diagnostics = createRuntimeDiagnostics({ getStatus, ensureRuntimePythonReady, installPythonPackages })

    await expect(diagnostics.install()).resolves.toEqual(runtimeReportFromStatus(status()))
    expect(ensureRuntimePythonReady).toHaveBeenCalledWith([...REQUIRED_PYTHON_PACKAGES])
    expect(installPythonPackages).not.toHaveBeenCalled()
  })

  test("explicit Python overrides install only the missing fixed packages into that configured interpreter", async () => {
    const getStatus = vi.fn()
      .mockResolvedValueOnce(status({ source: "config", executable: "/configured/python", missing: ["pandas", "scipy"] }))
      .mockResolvedValueOnce(status({ source: "config", executable: "/configured/python", missing: ["pandas", "scipy"] }))
      .mockResolvedValueOnce(status({ source: "config", executable: "/configured/python" }))
    const installPythonPackages = vi.fn(async () => {})
    const diagnostics = createRuntimeDiagnostics({ getStatus, installPythonPackages })

    await expect(diagnostics.install()).resolves.toEqual(runtimeReportFromStatus(status({ source: "config", executable: "/configured/python" })))
    expect(installPythonPackages).toHaveBeenCalledWith("/configured/python", ["pandas", "scipy"])
  })

  test("serializes installs for one configured interpreter across diagnostic instances", async () => {
    let missing = ["pandas"]
    let releaseInstall!: () => void
    const installGate = new Promise<void>((resolve) => { releaseInstall = resolve })
    const getStatus = async () => status({ source: "config", executable: "/configured/shared-python", missing: [...missing] })
    const installPythonPackages = vi.fn(async () => {
      await installGate
      missing = []
    })
    const first = createRuntimeDiagnostics({ getStatus, installPythonPackages })
    const second = createRuntimeDiagnostics({ getStatus, installPythonPackages })
    const pending = Promise.all([first.install(), second.install()])

    try {
      await Bun.sleep(10)
      expect(installPythonPackages).toHaveBeenCalledTimes(1)
    } finally {
      releaseInstall()
    }

    const [firstReport, secondReport] = await pending
    expect(firstReport.packages.find((item) => item.label === "pandas")?.status).toBe("ready")
    expect(secondReport.packages.find((item) => item.label === "pandas")?.status).toBe("ready")
  })

  test("does not install when Core cannot run the selected Python interpreter", async () => {
    const getStatus = vi.fn(async () => status({ ok: false, version: undefined, missing: [] }))
    const ensureRuntimePythonReady = vi.fn(async () => status())
    const installPythonPackages = vi.fn(async () => {})
    const diagnostics = createRuntimeDiagnostics({ getStatus, ensureRuntimePythonReady, installPythonPackages })

    await expect(diagnostics.install()).rejects.toThrow("未检测到可运行的 Python 解释器，无法安装分析依赖。")
    expect(ensureRuntimePythonReady).not.toHaveBeenCalled()
    expect(installPythonPackages).not.toHaveBeenCalled()
  })
})
