import { describe, expect, test, vi } from "vitest"
import { PYTHON_RUNTIME_PACKAGES } from "../provider-config"
import { createCoreRuntimeDiagnosticsAdapter } from "./runtime-diagnostics"

const report = {
  python: { label: "Python 3.12.13", status: "ready", detail: "managed", suggestion: "" },
  packages: PYTHON_RUNTIME_PACKAGES.map(({ pip }) => ({ label: pip, status: "ready", detail: "已安装。", suggestion: "" })),
}

describe("Tauri Core runtime diagnostics adapter", () => {
  test("uses the active authenticated Core client for inspect and confirmed install", async () => {
    const core = {
      runtimeDiagnostics: vi.fn(async () => report),
      installRuntimePackages: vi.fn(async () => report),
    }
    const getCore = vi.fn(async () => core)
    const diagnostics = createCoreRuntimeDiagnosticsAdapter(getCore)

    await expect(diagnostics.inspect()).resolves.toEqual(report)
    await expect(diagnostics.installMissingPackages?.()).resolves.toEqual(report)
    expect(getCore).toHaveBeenCalledTimes(2)
    expect(core.runtimeDiagnostics).toHaveBeenCalledTimes(1)
    expect(core.installRuntimePackages).toHaveBeenCalledTimes(1)
  })

  test("rejects malformed runtime data before showing it in Desktop settings", async () => {
    const diagnostics = createCoreRuntimeDiagnosticsAdapter(async () => ({
      runtimeDiagnostics: async () => ({ python: {}, packages: [] }),
      installRuntimePackages: async () => report,
    }))

    await expect(diagnostics.inspect()).rejects.toThrow("本机运行环境响应格式无效")
  })
})
