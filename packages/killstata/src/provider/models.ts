import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import z from "zod"
import { data } from "./models-macro" with { type: "macro" }
import { Installation } from "../installation"
import { Flag } from "../flag/flag"

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const filepath = path.join(Global.Path.cache, "models.json")

  function localFallback() {
    return {
      google: {
        id: "google",
        name: "Google AI Studio",
        api: "https://generativelanguage.googleapis.com/v1beta/openai",
        env: ["GOOGLE_GENERATIVE_AI_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "gemini-2.5-flash": {
            id: "gemini-2.5-flash",
            name: "Gemini 2.5 Flash",
            family: "gemini",
            release_date: "2026-01-01",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            limit: { context: 1048576, output: 8192 },
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            options: {},
          },
        },
      },
    } satisfies Record<string, Provider>
  }

  function removeHostedProviders(providers: Record<string, Provider>) {
    const result = { ...providers }
    delete result.killstata
    return result
  }

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

  export async function get() {
    if (!Flag.KILLSTATA_DISABLE_MODELS_FETCH) refresh()
    const file = Bun.file(filepath)
    const result = await file.json().catch(() => {})
    if (result) return removeHostedProviders(result as Record<string, Provider>)
    try {
      if (typeof data === "function") {
        const json = await data()
        return removeHostedProviders(JSON.parse(json) as Record<string, Provider>)
      }
    } catch (error) {
      log.error("failed to load embedded models.dev fallback", { error })
    }
    return removeHostedProviders(localFallback())
  }

  export async function refresh() {
    if (Flag.KILLSTATA_DISABLE_MODELS_FETCH) return
    const file = Bun.file(filepath)
    log.info("refreshing", {
      file,
    })
    const url = Global.Path.modelsDevUrl
    const result = await fetch(`${url}/api.json`, {
      headers: {
        "User-Agent": Installation.USER_AGENT,
      },
      signal: AbortSignal.timeout(10 * 1000),
    }).catch((e) => {
      log.error("Failed to fetch models.dev", {
        error: e,
      })
    })
    if (result && result.ok) await Bun.write(file, await result.text())
  }
}

setInterval(() => ModelsDev.refresh(), 60 * 1000 * 60).unref()
