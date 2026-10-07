import { describe, expect, test, vi } from "vitest"
import { createWebRuntimeDiagnostics } from "./runtime-diagnostics"

describe("Web runtime diagnostics adapter", () => {
  test("rejects a Core report whose package inventory differs from the shared UI catalog", async () => {
    const fetcher = vi.fn(async () => Response.json({
      python: { label: "Python 3.12", status: "ready", detail: "managed", suggestion: "" },
      packages: [{ label: "not-a-killstata-package", status: "ready", detail: "已安装。", suggestion: "" }],
    })) as unknown as typeof fetch
    const diagnostics = createWebRuntimeDiagnostics(fetcher)

    await expect(diagnostics.inspect()).rejects.toThrow("本机运行环境响应格式无效")
    expect(fetcher).toHaveBeenCalledWith("/api/v2/runtime", expect.objectContaining({ credentials: "same-origin" }))
  })
})
