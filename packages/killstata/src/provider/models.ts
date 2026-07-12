import z from "zod"
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL_ID,
  DEEPSEEK_PRO_MODEL_ID,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
} from "./deepseek-policy"
import { CUSTOM_API_KEY_ENV, CUSTOM_PROVIDER_ID, OPENAI_COMPATIBLE_NPM } from "./model-policy"

export namespace ModelsDev {
  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        context_over_200k: z
          .object({
            input: z.number(),
            output: z.number(),
            cache_read: z.number().optional(),
            cache_write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    experimental: z.boolean().optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string() }).optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  })
  export type Model = z.infer<typeof Model>

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })
  export type Provider = z.infer<typeof Provider>

  function deepSeekCatalogModel(id: string, name: string): Model {
    return {
      id,
      name,
      family: "deepseek",
      release_date: "2026-04-24",
      attachment: false,
      reasoning: true,
      temperature: true,
      tool_call: true,
      limit: {
        context: DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
        output: DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
      },
      modalities: { input: ["text"], output: ["text"] },
      options: {},
    }
  }

  // Killstata does not pull the models.dev catalog. It supports exactly two providers, so the
  // catalog is a two-entry constant: the built-in DeepSeek, and a "custom" OpenAI-compatible
  // endpoint whose models the user declares in killstata.json (or that we discover via /v1/models).
  const BUILTIN_CATALOG: Record<string, Provider> = {
    [DEEPSEEK_PROVIDER_ID]: {
      id: DEEPSEEK_PROVIDER_ID,
      name: "DeepSeek",
      api: DEEPSEEK_BASE_URL,
      env: [DEEPSEEK_API_KEY_ENV],
      npm: OPENAI_COMPATIBLE_NPM,
      models: {
        [DEEPSEEK_DEFAULT_MODEL_ID]: deepSeekCatalogModel(DEEPSEEK_DEFAULT_MODEL_ID, "DeepSeek V4 Flash"),
        [DEEPSEEK_PRO_MODEL_ID]: deepSeekCatalogModel(DEEPSEEK_PRO_MODEL_ID, "DeepSeek V4 Pro"),
      },
    },
    [CUSTOM_PROVIDER_ID]: {
      id: CUSTOM_PROVIDER_ID,
      name: "Custom (OpenAI-compatible)",
      env: [CUSTOM_API_KEY_ENV],
      npm: OPENAI_COMPATIBLE_NPM,
      // Left empty on purpose: the models come from killstata.json (provider.custom.models)
      // or from probing the endpoint's /v1/models.
      models: {},
    },
  }

  export async function get(): Promise<Record<string, Provider>> {
    return structuredClone(BUILTIN_CATALOG)
  }
}
