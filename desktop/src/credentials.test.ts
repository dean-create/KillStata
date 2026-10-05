import { describe, expect, test } from "vitest"
import { createDemoCredentialStore } from "./credentials"

describe("browser preview credentials", () => {
  test("explains that model discovery needs a connected service", async () => {
    const credentials = createDemoCredentialStore()

    await expect(credentials.discoverModels!("custom", "https://example.test/v1"))
      .rejects.toThrow("浏览器预览未连接模型服务，无法读取服务商目录。")
  })
})
