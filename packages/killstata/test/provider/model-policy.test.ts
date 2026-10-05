import { beforeAll, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { mapValues } from "remeda"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { ModelsDev } from "@/provider/models"
import { ProviderAuth } from "@/provider/auth"
import { Auth } from "@/auth"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { CUSTOM_API_KEY_ENV, CUSTOM_PROVIDER_ID, allowedProvidersMessage, formatModelNotFoundMessage, isAllowedProvider } from "@/provider/model-policy"

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
  const previousConfigDir = process.env.KILLSTATA_CONFIG_DIR
  const previousDisableProjectConfig = process.env.KILLSTATA_DISABLE_PROJECT_CONFIG
  process.env.KILLSTATA_CONFIG_DIR = root
  process.env.KILLSTATA_DISABLE_PROJECT_CONFIG = "true"
  try {
    return await Instance.provide({ directory: root, fn: async () => fn(root) })
  } finally {
    if (previousConfigDir === undefined) delete process.env.KILLSTATA_CONFIG_DIR
    else process.env.KILLSTATA_CONFIG_DIR = previousConfigDir
    if (previousDisableProjectConfig === undefined) delete process.env.KILLSTATA_DISABLE_PROJECT_CONFIG
    else process.env.KILLSTATA_DISABLE_PROJECT_CONFIG = previousDisableProjectConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("provider allowlist", () => {
  beforeAll(async () => {
    await Instance.disposeAll()
  })

  test("isAllowedProvider admits DeepSeek, OpenAI-compatible, Anthropic, and Gemini only", () => {
    expect(isAllowedProvider(DEEPSEEK_PROVIDER_ID)).toBe(true)
    expect(isAllowedProvider(CUSTOM_PROVIDER_ID)).toBe(true)
    expect(isAllowedProvider("anthropic")).toBe(true)
    expect(isAllowedProvider("google")).toBe(true)
    for (const rejected of ["openai", "openrouter", "groq", ""]) {
      expect(isAllowedProvider(rejected)).toBe(false)
    }
  })

  test("the rejection message names supported providers and the correct connection modes", () => {
    const message = allowedProvidersMessage("openai", "gpt-5")
    expect(message).toContain(DEEPSEEK_PROVIDER_ID)
    expect(message).toContain(CUSTOM_PROVIDER_ID)
    expect(message).toContain("anthropic")
    expect(message).toContain("google")
    expect(message).toContain("baseURL")
    expect(message).toContain("Requested: openai/gpt-5")
  })

  test("模型不存在时使用中文并给出真实候选模型", () => {
    expect(formatModelNotFoundMessage({
      providerID: CUSTOM_PROVIDER_ID,
      modelID: "DeepSeek-V4-Flash-0731",
      suggestions: ["DeepSeek-v3", "DeepSeek-R1-0528"],
    })).toBe("找不到模型 custom/DeepSeek-V4-Flash-0731。当前可用模型：DeepSeek-v3、DeepSeek-R1-0528。请检查模型配置或选择其中一个模型。")
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

  test("configured native Anthropic and Google models remain available with their native SDK adapters", async () => {
    await withProject(async (root) => {
      fs.writeFileSync(
        path.join(root, "killstata.json"),
        JSON.stringify({
          model: "anthropic/claude-test",
          provider: {
            anthropic: {
              name: "Anthropic",
              api: "https://api.anthropic.com/v1",
              options: { baseURL: "https://api.anthropic.com/v1" },
              models: {
                "claude-test": {
                  id: "claude-test",
                  name: "Claude Test",
                  provider: { npm: "@ai-sdk/anthropic" },
                },
              },
            },
            google: {
              name: "Google Gemini",
              api: "https://generativelanguage.googleapis.com/v1beta",
              options: { baseURL: "https://generativelanguage.googleapis.com/v1beta" },
              models: {
                "gemini-test": {
                  id: "gemini-test",
                  name: "Gemini Test",
                  provider: { npm: "@ai-sdk/google" },
                },
              },
            },
          },
        }),
        "utf-8",
      )

      const providers = await Provider.list()
      expect(Object.keys(providers).sort()).toEqual(["anthropic", "deepseek", "google"].sort())
      expect((await Provider.getModel("anthropic", "claude-test"))?.api.npm).toBe("@ai-sdk/anthropic")
      expect((await Provider.getModel("google", "gemini-test"))?.api.npm).toBe("@ai-sdk/google")
      const anthropicLanguage = await Provider.getLanguage(await Provider.getModel("anthropic", "claude-test"))
      const googleLanguage = await Provider.getLanguage(await Provider.getModel("google", "gemini-test"))
      expect(anthropicLanguage.modelId).toBe("claude-test")
      expect(googleLanguage.modelId).toBe("gemini-test")
    })
  })

  test("discovers the models exposed by a custom endpoint with its API key", async () => {
    const previousKey = process.env[CUSTOM_API_KEY_ENV]
    const previousFetch = globalThis.fetch
    process.env[CUSTOM_API_KEY_ENV] = "test-tokenhub-key"
    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers)
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
      })
      return new Response(
        JSON.stringify({
          data: [{ id: "deepseek-v4-flash" }, { id: "kimi-k3" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    try {
      await withProject(async (root) => {
        fs.writeFileSync(
          path.join(root, "killstata.json"),
          JSON.stringify({
            model: "custom/deepseek-v4-flash",
            provider: {
              [CUSTOM_PROVIDER_ID]: {
                name: "TokenHub",
                options: { baseURL: "https://api.tokenhub.market" },
              },
            },
          }),
          "utf-8",
        )

        const providers = await Provider.list()
        expect(Object.keys(providers[CUSTOM_PROVIDER_ID]!.models).sort()).toEqual(["deepseek-v4-flash", "kimi-k3"])
        expect(providers[CUSTOM_PROVIDER_ID]!.models["deepseek-v4-flash"]).toMatchObject({
          capabilities: { reasoning: true },
          limit: { context: 1_000_000 },
          variants: expect.objectContaining({ medium: { reasoningEffort: "medium" } }),
        })
        expect(requests).toEqual([
          {
            url: "https://api.tokenhub.market/models",
            authorization: "Bearer test-tokenhub-key",
          },
        ])
      })
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env[CUSTOM_API_KEY_ENV]
      else process.env[CUSTOM_API_KEY_ENV] = previousKey
    }
  })

  test("explicit custom API key environment variable overrides stale persisted auth", async () => {
    const previousKey = process.env[CUSTOM_API_KEY_ENV]
    const previousFetch = globalThis.fetch
    process.env[CUSTOM_API_KEY_ENV] = "current-environment-key"
    const auth = spyOn(Auth, "all").mockResolvedValue({
      [CUSTOM_PROVIDER_ID]: { type: "api", key: "stale-persisted-key" },
    })
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch

    try {
      await withProject(async (root) => {
        writeCustomProviderConfig(root, {
          name: "Sidus TokenHub",
          options: { baseURL: "https://model.sidus-ai.com/api/open-apis/v1" },
          models: { "DeepSeek-V4-Flash-0731": {} },
        })

        const provider = await Provider.getProvider(CUSTOM_PROVIDER_ID)
        expect(provider?.key).toBe("current-environment-key")
      })
    } finally {
      auth.mockRestore()
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env[CUSTOM_API_KEY_ENV]
      else process.env[CUSTOM_API_KEY_ENV] = previousKey
    }
  })

  test("model discovery uses the explicit custom API key instead of stale persisted auth", async () => {
    const previousKey = process.env[CUSTOM_API_KEY_ENV]
    const previousFetch = globalThis.fetch
    process.env[CUSTOM_API_KEY_ENV] = "current-environment-key"
    const auth = spyOn(Auth, "all").mockResolvedValue({
      [CUSTOM_PROVIDER_ID]: { type: "api", key: "stale-persisted-key" },
    })
    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers)
      requests.push({ url: String(input), authorization: headers.get("authorization") })
      return new Response(JSON.stringify({ data: [{ id: "DeepSeek-V4-Flash-0731" }] }), { status: 200 })
    }) as typeof fetch

    try {
      await withProject(async (root) => {
        writeCustomProviderConfig(root, {
          name: "Sidus",
          options: { baseURL: "https://model.sidus-ai.com/api/open-apis/v1" },
        })

        const providers = await Provider.list()
        expect(requests).toEqual([{
          url: "https://model.sidus-ai.com/api/open-apis/v1/models",
          authorization: "Bearer current-environment-key",
        }])
        expect(Object.keys(providers[CUSTOM_PROVIDER_ID]!.models)).toContain("DeepSeek-V4-Flash-0731")
      })
    } finally {
      auth.mockRestore()
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env[CUSTOM_API_KEY_ENV]
      else process.env[CUSTOM_API_KEY_ENV] = previousKey
    }
  })

  test("requested custom model is missing时，错误应列出动态目录中的真实候选", async () => {
    const previousKey = process.env[CUSTOM_API_KEY_ENV]
    const previousFetch = globalThis.fetch
    process.env[CUSTOM_API_KEY_ENV] = "test-sidus-key"
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "DeepSeek-v3" }, { id: "DeepSeek-R1-0528" }] }), { status: 200 })) as unknown as typeof fetch

    try {
      await withProject(async (root) => {
        writeCustomProviderConfig(root, {
          name: "Sidus",
          options: { baseURL: "https://model.sidus-ai.com/api/open-apis/v1" },
        })

        await expect(Provider.getModel(CUSTOM_PROVIDER_ID, "DeepSeek-V4-Flash-0731")).rejects.toMatchObject({
          data: { suggestions: ["DeepSeek-v3", "DeepSeek-R1-0528"] },
        })
      })
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env[CUSTOM_API_KEY_ENV]
      else process.env[CUSTOM_API_KEY_ENV] = previousKey
    }
  })

  test("resolves a bare model ID against the configured provider", async () => {
    await withProject(async (root) => {
      fs.writeFileSync(
        path.join(root, "killstata.json"),
        JSON.stringify({
          model: "custom/kimi-k3",
          provider: {
            [CUSTOM_PROVIDER_ID]: {
              options: { baseURL: "https://api.tokenhub.market" },
              models: { "kimi-k3": {} },
            },
          },
        }),
        "utf-8",
      )

      await expect(Provider.resolveModel("kimi-k3")).resolves.toMatchObject({
        providerID: CUSTOM_PROVIDER_ID,
        id: "kimi-k3",
      })
      await expect(Provider.resolveModel()).resolves.toMatchObject({
        providerID: CUSTOM_PROVIDER_ID,
        id: "kimi-k3",
      })
    })
  })

  test("title and summary helpers keep the current custom provider when choosing a small model", async () => {
    await withProject(async (root) => {
      writeCustomProviderConfig(root, {
        name: "Sidus TokenHub",
        options: { baseURL: "https://model.sidus-ai.com/api/open-apis/v1" },
        models: {
          "DeepSeek-V4-Flash-0731": {
            id: "DeepSeek-V4-Flash-0731",
            provider: { npm: "@ai-sdk/openai-compatible" },
          },
        },
      })

      await expect(Provider.getSmallModel(CUSTOM_PROVIDER_ID)).resolves.toMatchObject({
        providerID: CUSTOM_PROVIDER_ID,
        id: "DeepSeek-V4-Flash-0731",
      })
      const model = await Provider.getModel(CUSTOM_PROVIDER_ID, "DeepSeek-V4-Flash-0731")
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.variants).toHaveProperty("medium")
    })
  })

  test("显式前台模型优先于同 Provider 的旧 small_model 配置", async () => {
    await withProject(async (root) => {
      fs.writeFileSync(
        path.join(root, "killstata.json"),
        JSON.stringify({
          small_model: "custom/deepseek-v4-flash",
          provider: {
            [CUSTOM_PROVIDER_ID]: {
              options: { baseURL: "https://example.invalid/v1" },
              models: {
                "deepseek-v4-flash": {},
                "agnes-2.5-flash": {},
              },
            },
          },
        }),
        "utf-8",
      )

      await expect(Provider.getSmallModel(CUSTOM_PROVIDER_ID, "agnes-2.5-flash")).resolves.toMatchObject({
        providerID: CUSTOM_PROVIDER_ID,
        id: "agnes-2.5-flash",
      })
    })
  })

  test("current provider is preferred when global small_model points to another provider", async () => {
    await withProject(async (root) => {
      fs.writeFileSync(
        path.join(root, "killstata.json"),
        JSON.stringify({
          small_model: "custom/deepseek-v4-flash",
          provider: {
            [CUSTOM_PROVIDER_ID]: {
              options: { baseURL: "https://api.tokenhub.market" },
              models: { "deepseek-v4-flash": {} },
            },
          },
        }),
        "utf-8",
      )

      await expect(Provider.getSmallModel(DEEPSEEK_PROVIDER_ID)).resolves.toMatchObject({
        providerID: DEEPSEEK_PROVIDER_ID,
        id: DEEPSEEK_DEFAULT_MODEL_ID,
      })
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
