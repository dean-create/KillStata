import z from "zod"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { Log } from "../util/log"
import { BunProc } from "../bun"
import { ModelsDev } from "./models"
import { NamedError } from "@killstata/util/error"
import { Auth } from "../auth"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "@killstata/util/iife"
import { Global } from "../global"
import path from "path"

// Keep first-party provider protocols explicit: OpenAI-compatible, Anthropic Messages,
// and Google Generative AI use separate SDK adapters and authentication contracts.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModelV2 } from "@ai-sdk/provider"
import { ProviderTransform } from "./transform"
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL_ID,
  DEEPSEEK_MODEL_IDS,
  DEEPSEEK_PRO_MODEL_ID,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
  isDeepSeekProvider,
  normalizeDeepSeekModelID,
} from "./deepseek-policy"
import {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_NPM,
  ANTHROPIC_PROVIDER_ID,
  CUSTOM_API_KEY_ENV,
  CUSTOM_PROVIDER_ID,
  GOOGLE_API_KEY_ENV,
  GOOGLE_NPM,
  GOOGLE_PROVIDER_ID,
  OPENAI_COMPATIBLE_NPM,
  allowedProvidersMessage,
  isAllowedProvider,
  isCustomProvider,
} from "./model-policy"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
    [OPENAI_COMPATIBLE_NPM]: createOpenAICompatible,
    [ANTHROPIC_NPM]: createAnthropic as unknown as (options: any) => SDK,
    [GOOGLE_NPM]: createGoogleGenerativeAI as unknown as (options: any) => SDK,
  }

  function providerApiKeyEnv(providerID: string) {
    if (providerID === CUSTOM_PROVIDER_ID) return CUSTOM_API_KEY_ENV
    if (providerID === ANTHROPIC_PROVIDER_ID) return ANTHROPIC_API_KEY_ENV
    if (providerID === GOOGLE_PROVIDER_ID) return GOOGLE_API_KEY_ENV
    return DEEPSEEK_API_KEY_ENV
  }

  function isNativeProvider(providerID: string) {
    return providerID === ANTHROPIC_PROVIDER_ID || providerID === GOOGLE_PROVIDER_ID
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>

  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: provider.api!,
        npm: model.provider?.npm ?? provider.npm ?? OPENAI_COMPATIBLE_NPM,
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        experimentalOver200K: model.cost?.context_over_200k
          ? {
              cache: {
                read: model.cost.context_over_200k.cache_read ?? 0,
                write: model.cost.context_over_200k.cache_write ?? 0,
              },
              input: model.cost.context_over_200k.input,
              output: model.cost.context_over_200k.output,
            }
          : undefined,
      },
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
      variants: {},
    }

    m.variants = ProviderTransform.variants(m)

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: provider.id,
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
    }
  }

  function deepSeekModel(modelID: (typeof DEEPSEEK_MODEL_IDS)[number], name: string): Model {
    const model: Model = {
      id: modelID,
      providerID: DEEPSEEK_PROVIDER_ID,
      name,
      family: "deepseek",
      api: {
        id: modelID,
        url: DEEPSEEK_BASE_URL,
        npm: "@ai-sdk/openai-compatible",
      },
      status: "active",
      headers: {},
      options: {},
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
        output: DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
      },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      release_date: "2026-04-24",
      variants: {},
    }
    model.variants = ProviderTransform.variants(model)
    return model
  }

  function deepSeekProvider(apiKey?: string, existing?: Partial<Info>): Info {
    const options = { ...(existing?.options ?? {}) }
    const key = existing?.key || apiKey
    delete options["apiKey"]
    options["baseURL"] = DEEPSEEK_BASE_URL
    return {
      id: DEEPSEEK_PROVIDER_ID,
      name: "DeepSeek",
      source: key === existing?.key ? (existing?.source ?? "custom") : "env",
      env: [DEEPSEEK_API_KEY_ENV],
      key,
      options,
      models: {
        [DEEPSEEK_DEFAULT_MODEL_ID]: deepSeekModel(DEEPSEEK_DEFAULT_MODEL_ID, "DeepSeek V4 Flash"),
        [DEEPSEEK_PRO_MODEL_ID]: deepSeekModel(DEEPSEEK_PRO_MODEL_ID, "DeepSeek V4 Pro"),
      },
    }
  }

  // Keep the provider set explicit. Native providers survive only when a model
  // was configured for them; unrelated providers are still dropped.
  function enforceAllowedProviders(providers: Record<string, Info>) {
    // Capture both before we clear the map: `existing` carries the key merged in from
    // auth.json / config, which must win over the env var (see deepSeekProvider).
    const existingDeepSeek = providers[DEEPSEEK_PROVIDER_ID]
    const custom = providers[CUSTOM_PROVIDER_ID]
    const anthropic = providers[ANTHROPIC_PROVIDER_ID]
    const google = providers[GOOGLE_PROVIDER_ID]
    const customUsable =
      custom && typeof custom.options["baseURL"] === "string" && Object.keys(custom.models).length > 0

    for (const providerID of Object.keys(providers)) {
      delete providers[providerID]
    }

    const apiKey = Env.get(DEEPSEEK_API_KEY_ENV)?.trim()
    providers[DEEPSEEK_PROVIDER_ID] = deepSeekProvider(apiKey || undefined, existingDeepSeek)

    if (customUsable) {
      const customKey = Env.get(CUSTOM_API_KEY_ENV)?.trim()
      providers[CUSTOM_PROVIDER_ID] = {
        ...custom,
        // 当前进程明确提供的密钥优先于 auth.json 中的旧密钥；否则用户切换
        // TokenHub/API key 后，模型发现可能成功，但真正请求仍会携带已失效凭证。
        key: customKey || custom.key,
      }
    }

    for (const [providerID, provider] of [
      [ANTHROPIC_PROVIDER_ID, anthropic],
      [GOOGLE_PROVIDER_ID, google],
    ] as const) {
      if (!provider || Object.keys(provider.models).length === 0) continue
      const env = providerApiKeyEnv(providerID)
      providers[providerID] = {
        ...provider,
        env: [env],
        key: Env.get(env)?.trim() || provider.key,
      }
    }
  }

  function providerApiKey(provider: Info) {
    // 模型发现发生在 enforceAllowedProviders() 之前；此时 provider.key 可能刚从
    // auth.json 合并进来，不能等到最终 provider 收口后才覆盖。显式环境密钥代表
    // 当前进程/当前端点的选择，必须在发现阶段就优先于旧的持久化凭证，否则会用
    // 旧端点的模型目录污染当前 Provider（真实 Sidus 回放暴露的问题）。
    const environmentKey = provider.env
      .map((name) => Env.get(name)?.trim())
      .find((value): value is string => Boolean(value))
    if (environmentKey) return environmentKey

    const apiKey = provider.options["apiKey"]
    if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim()
    if (typeof provider.key === "string" && provider.key.trim()) return provider.key.trim()
    return undefined
  }

  function providerBaseURL(provider: Info) {
    const configured = provider.options["baseURL"]
    if (typeof configured === "string" && configured.trim()) {
      return configured.replace(/\/+$/, "")
    }
    const firstModel = Object.values(provider.models)[0]
    if (firstModel?.api.url) return firstModel.api.url.replace(/\/+$/, "")
    return undefined
  }

  function isDiscoverableOpenAICompatibleProvider(provider: Info) {
    const firstModel = Object.values(provider.models)[0]
    const npm = firstModel?.api.npm
    const baseURL = providerBaseURL(provider)
    return !!baseURL && (!npm || npm.includes("@ai-sdk/openai-compatible"))
  }

  function discoveredModel(provider: Info, modelID: string, baseURL: string): Model {
    const existing = provider.models[modelID]
    if (existing) return existing

    const npm = Object.values(provider.models)[0]?.api.npm ?? "@ai-sdk/openai-compatible"
    // /models 通常只返回 id，不返回推理能力和上下文窗口。TokenHub 上的
    // deepseek-v4-flash 仍然是 DeepSeek V4 Flash，不能因为走 custom endpoint
    // 就降级成“无推理能力、窗口为0”的普通模型。
    const deepSeekLike = modelID.toLowerCase().includes("deepseek")
    const model: Model = {
      id: modelID,
      providerID: provider.id,
      name: modelID,
      family: provider.id,
      api: {
        id: modelID,
        url: baseURL,
        npm,
      },
      status: "active",
      headers: {},
      options: {},
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: deepSeekLike ? DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS : 0,
        output: deepSeekLike ? DEEPSEEK_V4_MAX_OUTPUT_TOKENS : 0,
      },
      capabilities: {
        temperature: true,
        reasoning: deepSeekLike,
        attachment: false,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      release_date: "",
      variants: {},
    }

    model.variants = ProviderTransform.variants(model)
    return model
  }

  async function persistedLocalModels() {
    const file = Bun.file(path.join(Global.Path.state, "model.json"))
    const data = (await file.json().catch(() => undefined)) as
      | {
          model?: Record<string, { providerID?: string; modelID?: string }>
          recent?: { providerID?: string; modelID?: string }[]
          favorite?: { providerID?: string; modelID?: string }[]
        }
      | undefined
    if (!data) return []

    const result: { providerID: string; modelID: string }[] = []
    const seen = new Set<string>()

    const push = (item: { providerID?: string; modelID?: string } | undefined) => {
      if (!item?.providerID || !item?.modelID) return
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return
      seen.add(key)
      result.push({
        providerID: item.providerID,
        modelID: item.modelID,
      })
    }

    for (const item of Object.values(data.model ?? {})) push(item)
    for (const item of data.recent ?? []) push(item)
    for (const item of data.favorite ?? []) push(item)

    return result
  }

  async function discoverProviderModels(provider: Info) {
    if (!isDiscoverableOpenAICompatibleProvider(provider)) return []

    const apiKey = providerApiKey(provider)
    const baseURL = providerBaseURL(provider)
    if (!apiKey || !baseURL) return []

    const headers = {
      ...(provider.options["headers"] && typeof provider.options["headers"] === "object"
        ? provider.options["headers"]
        : {}),
      Authorization: `Bearer ${apiKey}`,
    }

    try {
      const response = await fetch(`${baseURL}/models`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        throw new Error(`model discovery failed with ${response.status} ${response.statusText}`)
      }

      const payload = (await response.json()) as {
        data?: Array<{
          id?: string
        }>
      }

      return (payload.data ?? [])
        .map((item) => item.id?.trim())
        .filter((item): item is string => !!item)
        .filter((item, index, all) => all.indexOf(item) === index)
    } catch (error) {
      log.warn("provider model discovery failed", {
        providerID: provider.id,
        baseURL,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  const state = Instance.state(async () => {
    using _ = log.time("state")
    const config = await Config.get()
    const modelsDev = await ModelsDev.get()
    const database = mapValues(modelsDev, fromModelsDevProvider)
    database[DEEPSEEK_PROVIDER_ID] = deepSeekProvider()

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null
    const configuredProviderIDs = new Set(Object.keys(config.provider ?? {}))

    function isProviderAllowed(providerID: string): boolean {
      if (!isAllowedProvider(providerID)) return false
      if (isNativeProvider(providerID) && !configuredProviderIDs.has(providerID)) return false
      if (enabled && !enabled.has(providerID)) return false
      if (disabled.has(providerID)) return false
      return true
    }

    const providers: { [providerID: string]: Info } = {}
    const languages = new Map<string, LanguageModelV2>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const sdk = new Map<number, SDK>()

    log.info("init")

    const configProviders = Object.entries(config.provider ?? {})

    function mergeProvider(providerID: string, provider: Partial<Info>) {
      const existing = providers[providerID]
      if (existing) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerID] ?? (isNativeProvider(providerID)
        ? { id: providerID, name: provider.name ?? providerID, source: "config", env: [], options: {}, models: {} } as Info
        : undefined)
      if (!match) return
      // @ts-expect-error
      providers[providerID] = mergeDeep(match, provider)
    }

    // extend database from config
    for (const [providerID, provider] of configProviders) {
      if (!isAllowedProvider(providerID)) continue
      const existing = database[providerID]
      const custom = isCustomProvider(providerID)
      const parsed: Info = {
        id: providerID,
        name: provider.name ?? existing?.name ?? providerID,
        env: [providerApiKeyEnv(providerID)],
        options: mergeDeep(
          existing?.options ?? {},
          custom || isNativeProvider(providerID)
            ? omit(provider.options ?? {}, ["apiKey"])
            : omit(provider.options ?? {}, ["apiKey", "baseURL"]),
        ),
        source: "config",
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existingModel = parsed.models[model.id ?? modelID]
        const deepSeekLike = `${modelID} ${model.id ?? ""}`.toLowerCase().includes("deepseek")
        const name = iife(() => {
          if (model.name) return model.name
          if (model.id && model.id !== modelID) return modelID
          return existingModel?.name ?? modelID
        })
        const parsedModel: Model = {
          id: modelID,
          api: {
            id: model.id ?? existingModel?.api.id ?? modelID,
            npm:
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelsDev[providerID]?.npm ??
              "@ai-sdk/openai-compatible",
            url: provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID,
          capabilities: {
            temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
            // 配置里的精确 DeepSeek 模型不会经过 discoveredModel()；按名称补齐与
            // 发现模型一致的 reasoning 能力，否则用户请求 medium 会静默降成 off。
            reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? deepSeekLike,
            attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
            toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
            input: {
              text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
              audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
              image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
              video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
              pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
            },
            output: {
              text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
              audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
              image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
              video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
              pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
            },
            interleaved: model.interleaved ?? false,
          },
          cost: {
            input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
            output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
            cache: {
              read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
              write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
            },
          },
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          limit: {
            context: model.limit?.context ?? existingModel?.limit?.context ?? (deepSeekLike ? DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS : 0),
            output: model.limit?.output ?? existingModel?.limit?.output ?? (deepSeekLike ? DEEPSEEK_V4_MAX_OUTPUT_TOKENS : 0),
          },
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          family: model.family ?? existingModel?.family ?? "",
          release_date: model.release_date ?? existingModel?.release_date ?? "",
          variants: {},
        }
        const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
        parsedModel.variants = mapValues(
          pickBy(merged, (v) => !v.disabled),
          (v) => omit(v, ["disabled"]),
        )
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }

    // load env
    const env = Env.all()
    for (const [providerID, provider] of Object.entries(database)) {
      if (!isAllowedProvider(providerID)) continue
      if (disabled.has(providerID)) continue
      const apiKey = provider.env.map((item) => env[item]).find(Boolean)
      if (!apiKey) continue
      mergeProvider(providerID, {
        source: "env",
        key: provider.env.length === 1 ? apiKey : undefined,
      })
    }

    // load apikeys
    for (const [providerID, provider] of Object.entries(await Auth.all())) {
      if (!isAllowedProvider(providerID)) continue
      if (disabled.has(providerID)) continue
      if (provider.type !== "api") continue
      mergeProvider(providerID, {
        source: "api",
        key: provider.key,
      })
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      if (!isAllowedProvider(providerID)) continue
      const partial: Partial<Info> = { source: "config" }
      partial.env = [isCustomProvider(providerID) ? CUSTOM_API_KEY_ENV : DEEPSEEK_API_KEY_ENV]
      if (provider.name) partial.name = provider.name
      // DeepSeek's baseURL is fixed by us; a custom endpoint's baseURL is the whole point of it,
      // so it must survive into the provider options.
      if (provider.options)
        partial.options = isCustomProvider(providerID)
          ? omit(provider.options, ["apiKey"])
          : omit(provider.options, ["apiKey", "baseURL"])
      mergeProvider(providerID, partial)
    }

    for (const item of await persistedLocalModels()) {
      const provider = providers[item.providerID]
      if (!provider || provider.models[item.modelID]) continue
      const baseURL = providerBaseURL(provider)
      if (!baseURL) continue
      provider.models[item.modelID] = discoveredModel(provider, item.modelID, baseURL)
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      if (!isProviderAllowed(providerID)) continue
      if (isDeepSeekProvider(providerID)) continue
      const discoveredModels = await discoverProviderModels(provider)
      if (discoveredModels.length === 0) continue

      const baseURL = providerBaseURL(provider)
      if (!baseURL) continue

      for (const modelID of discoveredModels) {
        if (provider.models[modelID]) continue
        provider.models[modelID] = discoveredModel(provider, modelID, baseURL)
      }

      log.info("provider model discovery completed", {
        providerID,
        discovered: discoveredModels.length,
        total: Object.keys(provider.models).length,
      })
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      if (!isProviderAllowed(providerID)) {
        delete providers[providerID]
        continue
      }

      const configProvider = config.provider?.[providerID]

      for (const [modelID, model] of Object.entries(provider.models)) {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (modelID === "gpt-5-chat-latest" || (providerID === "openrouter" && modelID === "openai/gpt-5-chat"))
          delete provider.models[modelID]
        if (model.status === "alpha" && !Flag.KILLSTATA_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
        if (model.status === "deprecated") delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        )
          delete provider.models[modelID]

        // Filter out disabled variants from config
        const configVariants = configProvider?.models?.[modelID]?.variants
        if (configVariants && model.variants) {
          const merged = mergeDeep(model.variants, configVariants)
          model.variants = mapValues(
            pickBy(merged, (v) => !v.disabled),
            (v) => omit(v, ["disabled"]),
          )
        }
      }

      if (Object.keys(provider.models).length === 0) {
        delete providers[providerID]
        continue
      }

      log.info("found", { providerID })
    }

    enforceAllowedProviders(providers)

    return {
      models: languages,
      providers,
      sdk,
      modelLoaders,
    }
  })

  export async function list() {
    return state().then((state) => state.providers)
  }

  async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
      const options = { ...provider.options }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      if (!options["baseURL"]) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }

      const key = Bun.hash.xxHash32(JSON.stringify({ npm: model.api.npm, options }))
      const existing = s.sdk.get(key)
      if (existing) return existing

      const customFetch = options["fetch"]

      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        // Preserve custom fetch if it exists, wrap it with timeout logic
        const fetchFn = customFetch ?? fetch
        const opts = init ?? {}

        if (options["timeout"] !== undefined && options["timeout"] !== null) {
          const signals: AbortSignal[] = []
          if (opts.signal) signals.push(opts.signal)
          if (options["timeout"] !== false) signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

          opts.signal = combined
        }

        return await fetchFn(input, {
          ...opts,
          // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
          timeout: false,
        })
      }

      const bundledFn = BUNDLED_PROVIDERS[model.api.npm]
      if (!bundledFn) {
        throw new Error(
          `Unsupported provider SDK "${model.api.npm}" for ${model.providerID}/${model.id}. ` +
            `KillStata only bundles explicitly supported provider protocols.`,
        )
      }

      const loaded = bundledFn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, loaded)
      return loaded as SDK
    } catch (e) {
      throw new InitError({ providerID: model.providerID }, { cause: e })
    }
  }

  export async function getProvider(providerID: string) {
    return state().then((s) => s.providers[providerID])
  }

  export async function getModel(providerID: string, modelID: string) {
    if (!isAllowedProvider(providerID)) {
      throw new Error(allowedProvidersMessage(providerID, modelID))
    }
    // DeepSeek accepts a few compatibility aliases (deepseek-chat / deepseek-reasoner / ...).
    // A custom endpoint has no aliases: the model id is whatever the user declared or we discovered.
    const resolvedModelID = isDeepSeekProvider(providerID) ? normalizeDeepSeekModelID(modelID) : modelID
    if (!resolvedModelID) {
      throw new Error(allowedProvidersMessage(providerID, modelID))
    }
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const info = provider.models[resolvedModelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
      // 动态目录中的模型名可能与用户手动配置的名字完全不同（例如服务端
      // 更新了别名）。模糊匹配为空时仍列出真实可用候选，帮助用户修正配置，
      // 但绝不把候选模型静默当成用户要求的模型执行。
      const suggestions = matches.length ? matches.map((m) => m.target) : availableModels.slice(0, 5)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return info
  }

  /**
   * 解析用户或测试驱动选择的模型：裸模型 ID 跟随配置的默认 provider，只有显式的
   * provider/model 才切换 provider。这样 custom OpenAI 兼容端点的选择策略集中在
   * Provider 内，调用方不用各自复制一份。
   */
  export async function resolveModel(model?: string) {
    const requested = model?.trim()
    if (!requested) {
      const configured = await defaultModel()
      return getModel(configured.providerID, configured.modelID)
    }

    if (requested.includes("/")) {
      const parsed = parseModel(requested)
      return getModel(parsed.providerID, parsed.modelID)
    }

    const configured = await defaultModel()
    return getModel(configured.providerID, requested)
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const key = `${model.providerID}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerID]
    const sdk = await getSDK(model)

    try {
      const language = s.modelLoaders[model.providerID]
        ? await s.modelLoaders[model.providerID](sdk, model.api.id, provider.options)
        : sdk.languageModel(model.api.id)
      s.models.set(key, language)
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerID: model.providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  export async function closest(providerID: string, query: string[]) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item))
          return {
            providerID,
            modelID,
          }
      }
    }
  }

  export async function getSmallModel(providerID: string, preferredModelID?: string) {
    const cfg = await Config.get()

    // 前台显式选择模型时，标题/摘要等后台装饰请求必须沿用同一个模型。
    // 否则全局 small_model 即使属于同一 Provider，也可能是旧端点或旧模型，
    // 造成后台请求失败、额外消耗额度，并把正常前台会话污染成错误状态。
    if (preferredModelID?.trim()) {
      return getModel(providerID, preferredModelID)
    }

    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      // 标题/摘要必须和当前前台请求使用同一 Provider。全局 small_model 可能
      // 属于另一个 Provider（例如前台显式选择 deepseek、配置仍保留 custom），
      // 不能让后台装饰请求跨 Provider 夺走凭证、额度和模型语义。
      if (parsed.providerID !== providerID) {
        // 忽略跨 Provider 的全局小模型，继续按当前 Provider 选择默认模型。
      } else if (!isAllowedProvider(parsed.providerID)) {
        throw new Error(allowedProvidersMessage(parsed.providerID, parsed.modelID))
      } else {
        return getModel(parsed.providerID, parsed.modelID)
      }
    }

    // 标题、摘要等后台请求必须沿用当前会话的 provider。此前这里无视 providerID，
    // 始终返回内置 DeepSeek；自定义 OpenAI 兼容端点的主请求因此能成功，收尾标题却
    // 被发往另一个模型/端点，最终把正常分析误报成 Unauthorized。
    const provider = await getProvider(providerID)
    if (provider) return getModel(providerID, defaultModelID(provider, cfg))

    // 保留旧调用方在 provider 尚未可用时的 DeepSeek 兜底行为。
    return getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
  }

  const priority = [DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PRO_MODEL_ID]
  export function sort(models: Model[]) {
    const priorityRank = (model: Model) => {
      const index = priority.findIndex((filter) => model.id.includes(filter))
      return index === -1 ? 999 : index
    }
    return sortBy(
      models,
      [priorityRank, "asc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export function defaultModelID(provider: Info, cfg?: { model?: string; small_model?: string }) {
    for (const configured of [cfg?.model, cfg?.small_model]) {
      if (!configured) continue
      const parsed = parseModel(configured)
      if (!isAllowedProvider(parsed.providerID)) continue
      if (parsed.providerID !== provider.id) continue
      const modelID = isDeepSeekProvider(parsed.providerID) ? normalizeDeepSeekModelID(parsed.modelID) : parsed.modelID
      if (modelID && provider.models[modelID]) return modelID
    }

    const [model] = sort(Object.values(provider.models))
    if (!model) throw new Error(`no models found for provider ${provider.id}`)
    return model.id
  }

  // 目录里的 "custom" 是一个空模板：用户声明 baseURL + models 之前它没有任何模型，
  // 因此也谈不上"默认模型"。列表接口必须跳过它，而不是让 defaultModelID 抛错、
  // 把整个 provider 列表（以及依赖它的 TUI 启动）一起拖垮。
  export function defaultModelIDs(providers: Record<string, Info>, cfg?: { model?: string; small_model?: string }) {
    const result: Record<string, string> = {}
    for (const [providerID, provider] of Object.entries(providers)) {
      if (Object.keys(provider.models).length === 0) continue
      result[providerID] = defaultModelID(provider, cfg)
    }
    return result
  }

  export async function defaultModel() {
    const cfg = await Config.get()
    if (cfg.model) {
      const parsed = parseModel(cfg.model)
      if (!isAllowedProvider(parsed.providerID))
        throw new Error(allowedProvidersMessage(parsed.providerID, parsed.modelID))
      const modelID = isDeepSeekProvider(parsed.providerID) ? normalizeDeepSeekModelID(parsed.modelID) : parsed.modelID
      if (!modelID) throw new Error(allowedProvidersMessage(parsed.providerID, parsed.modelID))
      return {
        providerID: parsed.providerID,
        modelID,
      }
    }

    const provider = await getProvider(DEEPSEEK_PROVIDER_ID)
    if (!provider) throw new Error("no providers found")
    return {
      providerID: DEEPSEEK_PROVIDER_ID,
      modelID: defaultModelID(provider, cfg),
    }
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: providerID,
      modelID: rest.join("/"),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: z.string(),
    }),
  )
}
