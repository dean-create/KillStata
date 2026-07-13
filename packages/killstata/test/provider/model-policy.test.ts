import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { mapValues } from "remeda"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { ModelsDev } from "@/provider/models"
import { ProviderAuth } from "@/provider/auth"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { CUSTOM_PROVIDER_ID, allowedProvidersMessage, isAllowedProvider } from "@/provider/model-policy"

// A custom provider only counts as usable once the user gives it a baseURL and at least one model.
function writeCustomProviderConfig(root: string, provider: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(root, "killstata.json"),
    JSON.stringify({ provider: { [CUSTOM_PROVIDER_ID]: provider } }),
    "utf-8",
  )
}

async function withProject<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-model-policy-"))
  try {
    return await Instance.provide({ directory: root, fn: async () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("provider allowlist (deepseek + custom)", () => {
  test("isAllowedProvider admits exactly deepseek and custom", () => {
    expect(isAllowedProvider(DEEPSEEK_PROVIDER_ID)).toBe(true)
    expect(isAllowedProvider(CUSTOM_PROVIDER_ID)).toBe(true)
    for (const rejected of ["openai", "anthropic", "google", "openrouter", "groq", ""]) {
      expect(isAllowedProvider(rejected)).toBe(false)
    }
  })

  test("the rejection message names both supported providers and how to configure custom", () => {
    const message = allowedProvidersMessage("openai", "gpt-5")
    expect(message).toContain(DEEPSEEK_PROVIDER_ID)
    expect(message).toContain(CUSTOM_PROVIDER_ID)
    expect(message).toContain("baseURL")
    expect(message).toContain("Requested: openai/gpt-5")
  })

  test("a custom provider with baseURL and a model shows up alongside deepseek and is resolvable", async () => {
    await withProject(async (root) => {
      writeCustomProviderConfig(root, {
        name: "Qwen (DashScope)",
        options: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
        models: { "qwen3-max": {} },
      })

      const providers = await Provider.list()
      expect(Object.keys(providers).sort()).toEqual([CUSTOM_PROVIDER_ID, DEEPSEEK_PROVIDER_ID].sort())

      const custom = providers[CUSTOM_PROVIDER_ID]!
      expect(custom.name).toBe("Qwen (DashScope)")
      expect(custom.options["baseURL"]).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1")

      // Custom model ids pass through verbatim (no DeepSeek alias normalization).
      const model = await Provider.getModel(CUSTOM_PROVIDER_ID, "qwen3-max")
      expect(model.id).toBe("qwen3-max")
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
    })
  })

  test("a custom provider declared without a baseURL is dropped instead of half-working", async () => {
    await withProject(async (root) => {
      writeCustomProviderConfig(root, {
        name: "Broken",
        models: { "some-model": {} },
      })

      const providers = await Provider.list()
      expect(Object.keys(providers)).toEqual([DEEPSEEK_PROVIDER_ID])
    })
  })

  test("declaring a custom provider does not steal the default model from deepseek", async () => {
    await withProject(async (root) => {
      writeCustomProviderConfig(root, {
        options: { baseURL: "https://example.invalid/v1" },
        models: { "some-model": {} },
      })

      await expect(Provider.defaultModel()).resolves.toEqual({
        providerID: DEEPSEEK_PROVIDER_ID,
        modelID: DEEPSEEK_DEFAULT_MODEL_ID,
      })
    })
  })

  test("an API key can be saved for the custom provider via /connect", async () => {
    await withProject(async () => {
      await expect(ProviderAuth.api({ providerID: CUSTOM_PROVIDER_ID, key: "custom-key" })).resolves.toBeUndefined()
    })
  })

  // 回归测试：一个全新用户没有任何配置、也没有 API key 时，provider 列表接口必须能返回。
  // 曾经的 bug：目录里的 "custom" 是个空模板（没有模型），而列表接口对每个 provider 都
  // 调用 defaultModelID，遇到空模型直接抛 "no models found for provider custom"，
  // 结果 TUI 一启动就崩——用户连进去配 key 的机会都没有。
  test("a provider with no models yet is skipped, not fatal (zero-config startup must work)", async () => {
    const catalog = await ModelsDev.get()
    const providers = mapValues(catalog, (item) => Provider.fromModelsDevProvider(item))

    // custom 在目录里，但它还没有任何模型。
    expect(providers[CUSTOM_PROVIDER_ID]).toBeDefined()
    expect(Object.keys(providers[CUSTOM_PROVIDER_ID].models)).toHaveLength(0)

    // 这一步过去会抛错，现在必须安然返回，且只给出真正可用的 provider 的默认模型。
    const defaults = Provider.defaultModelIDs(providers, {})
    expect(defaults[DEEPSEEK_PROVIDER_ID]).toBe(DEEPSEEK_DEFAULT_MODEL_ID)
    expect(defaults[CUSTOM_PROVIDER_ID]).toBeUndefined()
  })
})
