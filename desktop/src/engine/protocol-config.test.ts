import { describe, expect, test } from "vitest"
import { resolveEngineProtocolVersion } from "./protocol-config"

describe("Desktop engine protocol configuration", () => {
  test("默认使用 v1，只有显式 v2 配置才启用 v2", () => {
    expect(resolveEngineProtocolVersion(undefined)).toBe("v1")
    expect(resolveEngineProtocolVersion("v1")).toBe("v1")
    expect(resolveEngineProtocolVersion("v2")).toBe("v2")
    expect(resolveEngineProtocolVersion("v3")).toBe("v1")
  })
})
