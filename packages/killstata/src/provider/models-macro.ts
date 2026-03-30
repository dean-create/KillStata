import { Global } from "../global"

export async function data() {
  const path = Bun.env.MODELS_DEV_API_JSON
  if (path) {
    const file = Bun.file(path)
    if (await file.exists()) {
      return await file.text()
    }
  }

  const cacheFile = Bun.file(`${Global.Path.cache}/models.json`)
  if (await cacheFile.exists()) {
    return await cacheFile.text()
  }

  const url = Global.Path.modelsDevUrl
  try {
    return await fetch(`${url}/api.json`).then((x) => x.text())
  } catch {
    return JSON.stringify({
      opencode: {
        id: "opencode",
        name: "Killstata Cloud",
        api: "https://api.opencode.ai/v1",
        env: ["OPENCODE_API_KEY"],
        models: {
          "gpt-5-nano": {
            id: "gpt-5-nano",
            name: "GPT-5 Nano",
            family: "gpt-5",
            release_date: "2026-01-01",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            limit: { context: 128000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
            options: {},
          },
        },
      },
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
    })
  }
}
