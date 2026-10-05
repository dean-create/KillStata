import { describe, expect, test } from "vitest"
import { PYTHON_RUNTIME_PACKAGES } from "./provider-config"
import { parseRuntimeDiagnosticsReport } from "./runtime-diagnostics"

const report = {
  python: { label: "Python 3.12.13", status: "ready", detail: "managed", suggestion: "" },
  packages: PYTHON_RUNTIME_PACKAGES.map(({ pip }) => ({ label: pip, status: "ready", detail: "已安装。", suggestion: "" })),
}

describe("runtime diagnostics contract", () => {
  test("accepts a Core report with ready Python and package checks", () => {
    expect(parseRuntimeDiagnosticsReport(report)).toEqual(report)
  })

  test("rejects reports with malformed package states", () => {
    expect(() => parseRuntimeDiagnosticsReport({
      ...report,
      packages: [{ label: "pydantic", status: "installed", detail: "已安装。", suggestion: "" }],
    })).toThrow("本机运行环境响应格式无效")
  })
})
