import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  DEEPSEEK_DEFAULT_PROVIDER_MODEL,
  DEEPSEEK_MODELS,
  PYTHON_RUNTIME_PACKAGES,
  defaultProviderBaseURL,
  engineConfigContent,
  validateBaseURL,
  validateProviderSettings,
} from "./provider-config"

describe("provider configuration", () => {
  test("uses the Core-supported DeepSeek V4 Flash model as the default", () => {
    expect(DEEPSEEK_DEFAULT_PROVIDER_MODEL).toBe("deepseek/deepseek-v4-flash")
  })

  test("keeps Desktop, Tauri and Core built-in DeepSeek catalogs aligned", () => {
    const corePolicy = fs.readFileSync(path.join(process.cwd(), "..", "packages", "killstata", "src", "provider", "deepseek-policy.ts"), "utf8")
    const tauri = fs.readFileSync(path.join(process.cwd(), "src-tauri", "src", "main.rs"), "utf8")
    for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      expect(corePolicy).toContain(`\"${model}\"`)
      expect(tauri).toContain(`deepseek/${model}`)
    }
    expect(DEEPSEEK_MODELS.map((item) => item.id)).toEqual([
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
    ])
  })

  test("accepts the built-in DeepSeek models and rejects unknown models", () => {
    expect(validateProviderSettings({ provider: "deepseek", model: DEEPSEEK_DEFAULT_PROVIDER_MODEL }).ok).toBe(true)
    expect(validateProviderSettings({ provider: "deepseek", model: "deepseek/deepseek-v4.1-flash-expires-on-0910" }).ok).toBe(false)
    expect(validateProviderSettings({
      provider: "deepseek",
      model: DEEPSEEK_DEFAULT_PROVIDER_MODEL,
      smallModel: "deepseek/deepseek-v4.1-flash-expires-on-0910",
    }).ok).toBe(false)
    expect(validateProviderSettings({ provider: "deepseek", model: "deepseek/unknown" }).ok).toBe(false)
  })

  test("uses provider-specific defaults and requires discovered native model IDs", () => {
    expect(defaultProviderBaseURL("anthropic")).toBe("https://api.anthropic.com/v1")
    expect(defaultProviderBaseURL("google")).toBe("https://generativelanguage.googleapis.com/v1beta")
    expect(validateProviderSettings({ provider: "anthropic", model: "anthropic/claude-sonnet", baseURL: defaultProviderBaseURL("anthropic")! }).ok).toBe(true)
    expect(validateProviderSettings({ provider: "google", model: "google/gemini-2.5-flash" }).ok).toBe(true)
    expect(validateProviderSettings({ provider: "anthropic", model: "google/gemini-2.5-flash" }).ok).toBe(false)
    expect(validateProviderSettings({ provider: "google", model: "" }).ok).toBe(false)
  })

  test("normalizes OpenAI-compatible IDs from discovered catalog and keeps provider prefixes", () => {
    expect(validateProviderSettings({ provider: "custom", model: "qwen-max", baseURL: "https://dashscope.aliyuncs.com/v1" })).toMatchObject({
      ok: true,
      value: { model: "custom/qwen-max" },
    })
    expect(validateProviderSettings({ provider: "custom", model: "custom/qwen-max", baseURL: "https://dashscope.aliyuncs.com/v1" }).ok).toBe(true)
    expect(validateProviderSettings({ provider: "custom", model: "custom/local", baseURL: "http://127.0.0.1:8000/v1" }).ok).toBe(true)
    expect(validateProviderSettings({ provider: "custom", model: "custom/local", baseURL: "http://example.com/v1" }).ok).toBe(false)
  })

  test("builds non-secret CLI config content without API keys", () => {
    const content = engineConfigContent({ provider: "custom", model: "custom/qwen-max", baseURL: "https://example.com/v1", smallModel: "custom/qwen-mini" }, "sk-secret")
    expect(content).toContain('"model":"custom/qwen-max"')
    expect(content).toContain('"baseURL":"https://example.com/v1"')
    expect(content).not.toContain("sk-secret")
  })

  test("registers custom models under the unprefixed ID consumed by Core lookup", () => {
    const content = engineConfigContent({ provider: "custom", model: "custom/qwen-max", baseURL: "https://example.com/v1" }, "secret")
    const config = JSON.parse(content ?? "{}")

    expect(config.provider.custom.models).toHaveProperty("qwen-max")
    expect(config.provider.custom.models).not.toHaveProperty("custom/qwen-max")
  })

  test("registers both foreground and small models for the selected provider", () => {
    const custom = JSON.parse(engineConfigContent({
      provider: "custom", model: "custom/qwen-max", smallModel: "custom/qwen-mini", baseURL: "https://example.com/v1",
    }, "secret") ?? "{}")
    const anthropic = JSON.parse(engineConfigContent({
      provider: "anthropic", model: "anthropic/claude-sonnet-4", smallModel: "anthropic/claude-haiku", baseURL: "https://api.anthropic.com/v1",
    }, "secret") ?? "{}")

    expect(Object.keys(custom.provider.custom.models)).toEqual(["qwen-max", "qwen-mini"])
    expect(Object.keys(anthropic.provider.anthropic.models)).toEqual(["claude-sonnet-4", "claude-haiku"])
  })

  test("serializes native provider configs with SDK adapters and no key material", () => {
    const anthropic = engineConfigContent({ provider: "anthropic", model: "anthropic/claude-sonnet-4", baseURL: "https://api.anthropic.com/v1" }, "secret")
    const google = engineConfigContent({ provider: "google", model: "google/gemini-2.5-flash" }, "secret")
    expect(anthropic).toContain("@ai-sdk/anthropic")
    expect(google).toContain("@ai-sdk/google")
    expect(anthropic).not.toContain("secret")
    expect(google).not.toContain("secret")
  })

  test("shows the canonical Python Registry and analysis runtime package list", () => {
    expect(PYTHON_RUNTIME_PACKAGES.map((item) => item.pip)).toEqual([
      "pydantic", "pandas", "numpy", "scipy", "statsmodels", "linearmodels", "pyfixest", "rdrobust", "matplotlib", "scikit-learn", "openpyxl", "pyarrow", "python-docx",
    ])
  })

  test("accepts only https or loopback http base URLs", () => {
    expect(validateBaseURL("https://example.com")).toBeUndefined()
    expect(validateBaseURL("http://localhost:8000")).toBeUndefined()
    expect(validateBaseURL("http://example.com")).toBeTruthy()
  })
})
