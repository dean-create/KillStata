import { describe, expect, test } from "bun:test"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_DEFAULT_MODEL_ID,
  DEEPSEEK_PRO_MODEL_ID,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
  normalizeDeepSeekModelID,
} from "@/provider/deepseek-policy"

describe("DeepSeek-only provider policy", () => {
  test("provider list exposes only DeepSeek models", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const providers = await Provider.list()
        expect(Object.keys(providers)).toEqual([DEEPSEEK_PROVIDER_ID])
        expect(Object.keys(providers[DEEPSEEK_PROVIDER_ID]!.models).sort()).toEqual(
          [DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PRO_MODEL_ID].sort(),
        )
        for (const model of Object.values(providers[DEEPSEEK_PROVIDER_ID]!.models)) {
          expect(model.limit.context).toBe(DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS)
          expect(model.limit.output).toBe(DEEPSEEK_V4_MAX_OUTPUT_TOKENS)
          expect(model.capabilities.reasoning).toBe(true)
        }
      },
    })
  })

  test("default and small model resolve to DeepSeek flash", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        await expect(Provider.defaultModel()).resolves.toEqual({
          providerID: DEEPSEEK_PROVIDER_ID,
          modelID: DEEPSEEK_DEFAULT_MODEL_ID,
        })
        const small = await Provider.getSmallModel("openai")
        expect(small.id).toBe(DEEPSEEK_DEFAULT_MODEL_ID)
        expect(small.providerID).toBe(DEEPSEEK_PROVIDER_ID)
      },
    })
  })

  test("non-DeepSeek models and saved auth credentials are rejected", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        await expect(Provider.getModel("openai", "gpt-5")).rejects.toThrow(/DeepSeek-only mode/)
        await expect(ProviderAuth.authorize({ providerID: "openai", method: 0 })).rejects.toThrow(
          DEEPSEEK_API_KEY_ENV,
        )
        await expect(ProviderAuth.api({ providerID: "openai", key: "test-key" })).rejects.toThrow(DEEPSEEK_API_KEY_ENV)
        await expect(ProviderAuth.api({ providerID: DEEPSEEK_PROVIDER_ID, key: "test-key" })).rejects.toThrow(
          DEEPSEEK_API_KEY_ENV,
        )
      },
    })
  })

  test("DeepSeek compatibility aliases resolve to V4 flash", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        expect(normalizeDeepSeekModelID("deepseek-chat")).toBe(DEEPSEEK_DEFAULT_MODEL_ID)
        expect(normalizeDeepSeekModelID("deepseek-reasoner")).toBe(DEEPSEEK_DEFAULT_MODEL_ID)
        expect(normalizeDeepSeekModelID("deepseek-v4flash")).toBe(DEEPSEEK_DEFAULT_MODEL_ID)
        expect(normalizeDeepSeekModelID("deepseek-v4pro")).toBe(DEEPSEEK_PRO_MODEL_ID)

        const aliasModel = await Provider.getModel(DEEPSEEK_PROVIDER_ID, "deepseek-chat")
        expect(aliasModel.id).toBe(DEEPSEEK_DEFAULT_MODEL_ID)
      },
    })
  })
})
