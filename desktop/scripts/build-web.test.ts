// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { buildWebDistribution, WEB_BUILD_ENV } from "./build-web"

describe("local Web distribution build", () => {
  let outputDirectory: string | undefined

  afterEach(() => {
    if (outputDirectory) rmSync(outputDirectory, { recursive: true, force: true })
    outputDirectory = undefined
  })

  test("builds a frontend-first same-origin v2 UI without embedding an engine token", async () => {
    const output = mkdtempSync(path.join(os.tmpdir(), "killstata-web-build-"))
    outputDirectory = output

    await buildWebDistribution({
      projectRoot: path.resolve(import.meta.dirname, ".."),
      outputDirectory: output,
    })

    const index = readFileSync(path.join(output, "index.html"), "utf8")
    const assets = readdirSync(path.join(output, "assets"))
    const scripts = assets.filter((asset) => asset.endsWith(".js"))
    const bundle = scripts.map((asset) => readFileSync(path.join(output, "assets", asset), "utf8")).join("\n")

    expect(index).toContain("/assets/")
    expect(WEB_BUILD_ENV.VITE_KILLSTATA_MODE).toBe("frontend")
    expect(assets.some((asset) => asset.endsWith(".css"))).toBe(true)
    expect(bundle).toContain("/api")
    expect(bundle).toContain("v2")
    expect(bundle).not.toContain("dev-token")
    expect(bundle).not.toContain("VITE_ENGINE_TOKEN")
  })

  test("refuses credential-like Vite variables instead of embedding them in published Web assets", async () => {
    outputDirectory = mkdtempSync(path.join(os.tmpdir(), "killstata-web-secret-"))
    const originalToken = process.env.VITE_ENGINE_TOKEN
    const originalApiKey = process.env.VITE_OPENAI_API_KEY
    delete process.env.VITE_ENGINE_TOKEN
    process.env.VITE_OPENAI_API_KEY = "test-only-never-publish"

    try {
      await expect(buildWebDistribution({
        projectRoot: path.resolve(import.meta.dirname, ".."),
        outputDirectory,
      })).rejects.toThrow("Web 构建环境禁止注入凭据变量")
      expect(existsSync(path.join(outputDirectory, "index.html"))).toBe(false)
    } finally {
      if (originalToken === undefined) delete process.env.VITE_ENGINE_TOKEN
      else process.env.VITE_ENGINE_TOKEN = originalToken
      if (originalApiKey === undefined) delete process.env.VITE_OPENAI_API_KEY
      else process.env.VITE_OPENAI_API_KEY = originalApiKey
    }
  })
})
