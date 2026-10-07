/**
 * Env 注册表 & 类型安全测试。
 * 锁死 ENV_DEFINITIONS 的形状。
 */

import { describe, expect, it } from "bun:test"
import { ENV_DEFINITIONS } from "@/env"

describe("Env 注册表", () => {
  it("每个已知变量的 description 不为空", () => {
    for (const [key, def] of Object.entries(ENV_DEFINITIONS)) {
      expect(def.description).toBeTruthy()
    }
  })

  it("ENV_DEFINITIONS 的 key 覆盖计划迁移的环境变量", () => {
    const keys = Object.keys(ENV_DEFINITIONS)
    expect(keys).toContain("KILLSTATA_PYTHON")
    expect(keys).toContain("KILLSTATA_DISABLE_AUTO_RUNTIME")
    expect(keys).toContain("KILLSTATA_CLIENT")
    expect(keys).toContain("AGENT")
    expect(keys).toContain("KILLSTATA")
  })

  it("ENV_DEFINITIONS 的 key 遵循环境变量命名规范", () => {
    for (const key of Object.keys(ENV_DEFINITIONS)) {
      // 允许大写字母+下划线（标准），也允许小写+下划线（http_proxy 等）
      expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/)
    }
  })
})
