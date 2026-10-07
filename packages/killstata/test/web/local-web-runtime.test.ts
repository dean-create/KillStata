import { describe, expect, test, vi } from "bun:test"
import { REQUIRED_PYTHON_PACKAGES } from "../../src/killstata/runtime-config"
import { createLocalWebRuntimeDiagnostics, runtimeReportFromStatus } from "../../src/web/local-web-runtime"

const report = {
  python: { label: "Python 3.12", status: "ready" as const, detail: "Python 3.12 · managed", suggestion: "" },
  packages: [{ label: "pydantic", status: "warning" as const, detail: "未安装", suggestion: "确认安装固定依赖。" }],
}

describe("local Web runtime diagnostics", () => {
  test("maps the exact CLI-required package set into the shared runtime report", () => {
    const mapped = runtimeReportFromStatus({
      executable: "/managed/python",
      source: "managed",
      version: "Python 3.12.4",
      ok: true,
      missing: ["pydantic", "pyfixest"],
      installCommand: "managed pip install",
    })

    expect(mapped.packages.map((item) => item.label)).toEqual([...REQUIRED_PYTHON_PACKAGES])
    expect(mapped.python.status).toBe("warning")
    expect(mapped.packages.find((item) => item.label === "pydantic")?.status).toBe("warning")
    expect(mapped.packages.find((item) => item.label === "pandas")?.status).toBe("ready")
  })

  test("serves inspection from the CLI adapter and never accepts package names for installation", async () => {
    const inspect = vi.fn(async () => report)
    const install = vi.fn(async () => report)
    const contexts: string[] = []
    const runtime = createLocalWebRuntimeDiagnostics({
      inspect,
      install,
      async runInCoreContext(operation) { contexts.push("entered"); return operation() },
    })

    const inspection = await runtime.handle(new Request("http://127.0.0.1/api/v2/runtime"))
    const invalidInstallation = await runtime.handle(new Request("http://127.0.0.1/api/v2/runtime/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packages: ["arbitrary-command-package"] }),
    }))
    const installation = await runtime.handle(new Request("http://127.0.0.1/api/v2/runtime/install", { method: "POST" }))

    expect(await inspection?.json()).toEqual(report)
    expect(invalidInstallation?.status).toBe(400)
    expect(await installation?.json()).toEqual(report)
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]).toEqual([])
    expect(contexts).toEqual(["entered", "entered"])
  })
})
