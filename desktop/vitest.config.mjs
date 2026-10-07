import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    // 这两个 engine 测试使用 Bun 原生 API，并由 `bun run test:engine` 覆盖。
    // 排除它们可使 `bun run test` 保持一个可在浏览器环境运行的 Vitest 套件。
    exclude: ["**/node_modules/**", "**/dist/**", "**/trash/**", "**/pi-main/**", "**/deepseek-harness-master/**", "engine/auto-decision.test.ts", "engine/workspace-permission.test.ts"],
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
    globals: true,
  },
})
