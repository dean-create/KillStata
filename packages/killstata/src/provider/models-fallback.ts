function model(
  id: string,
  name: string,
  family: string,
  releaseDate: string,
  limit: { context: number; output: number },
  extras?: Partial<{
    attachment: boolean
    reasoning: boolean
    temperature: boolean
    tool_call: boolean
    input: Array<"text" | "audio" | "image" | "video" | "pdf">
    output: Array<"text" | "audio" | "image" | "video" | "pdf">
  }>,
) {
  return {
    id,
    name,
    family,
    release_date: releaseDate,
    attachment: extras?.attachment ?? false,
    reasoning: extras?.reasoning ?? true,
    temperature: extras?.temperature ?? true,
    tool_call: extras?.tool_call ?? true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit,
    modalities: {
      input: extras?.input ?? ["text"],
      output: extras?.output ?? ["text"],
    },
    options: {},
  }
}

export function fallbackProviders() {
  return {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      npm: "@ai-sdk/anthropic",
      models: {
        "claude-sonnet-4": model("claude-sonnet-4", "Claude Sonnet 4", "claude", "2026-01-01", {
          context: 200000,
          output: 8192,
        }),
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      models: {
        "gpt-5": model("gpt-5", "GPT-5", "gpt", "2026-01-01", {
          context: 400000,
          output: 16384,
        }),
      },
    },
    google: {
      id: "google",
      name: "Google AI Studio",
      api: "https://generativelanguage.googleapis.com/v1beta/openai",
      env: ["GOOGLE_GENERATIVE_AI_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "gemini-2.5-flash": model(
          "gemini-2.5-flash",
          "Gemini 2.5 Flash",
          "gemini",
          "2026-01-01",
          { context: 1048576, output: 8192 },
          {
            attachment: true,
            input: ["text", "image", "pdf"],
          },
        ),
      },
    },
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      env: ["OPENROUTER_API_KEY"],
      npm: "@openrouter/ai-sdk-provider",
      models: {
        "openai/gpt-5": model("openai/gpt-5", "GPT-5 via OpenRouter", "openrouter", "2026-01-01", {
          context: 400000,
          output: 16384,
        }),
      },
    },
    xai: {
      id: "xai",
      name: "xAI",
      env: ["XAI_API_KEY"],
      npm: "@ai-sdk/xai",
      models: {
        "grok-3-mini": model("grok-3-mini", "Grok 3 Mini", "grok", "2026-01-01", {
          context: 131072,
          output: 8192,
        }),
      },
    },
    groq: {
      id: "groq",
      name: "Groq",
      env: ["GROQ_API_KEY"],
      npm: "@ai-sdk/groq",
      models: {
        "llama-3.3-70b-versatile": model(
          "llama-3.3-70b-versatile",
          "Llama 3.3 70B Versatile",
          "llama",
          "2026-01-01",
          { context: 131072, output: 8192 },
        ),
      },
    },
    mistral: {
      id: "mistral",
      name: "Mistral",
      env: ["MISTRAL_API_KEY"],
      npm: "@ai-sdk/mistral",
      models: {
        "mistral-large-latest": model("mistral-large-latest", "Mistral Large", "mistral", "2026-01-01", {
          context: 131072,
          output: 8192,
        }),
      },
    },
    perplexity: {
      id: "perplexity",
      name: "Perplexity",
      env: ["PERPLEXITY_API_KEY"],
      npm: "@ai-sdk/perplexity",
      models: {
        "sonar-pro": model("sonar-pro", "Sonar Pro", "sonar", "2026-01-01", {
          context: 128000,
          output: 8192,
        }),
      },
    },
    cohere: {
      id: "cohere",
      name: "Cohere",
      env: ["COHERE_API_KEY"],
      npm: "@ai-sdk/cohere",
      models: {
        "command-r-plus": model("command-r-plus", "Command R+", "command", "2026-01-01", {
          context: 128000,
          output: 4096,
        }),
      },
    },
    togetherai: {
      id: "togetherai",
      name: "Together AI",
      env: ["TOGETHER_API_KEY"],
      npm: "@ai-sdk/togetherai",
      models: {
        "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo": model(
          "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
          "Meta Llama 3.1 70B Turbo",
          "llama",
          "2026-01-01",
          { context: 131072, output: 8192 },
        ),
      },
    },
    deepinfra: {
      id: "deepinfra",
      name: "DeepInfra",
      env: ["DEEPINFRA_API_KEY"],
      npm: "@ai-sdk/deepinfra",
      models: {
        "meta-llama/Meta-Llama-3.1-70B-Instruct": model(
          "meta-llama/Meta-Llama-3.1-70B-Instruct",
          "Meta Llama 3.1 70B",
          "llama",
          "2026-01-01",
          { context: 131072, output: 8192 },
        ),
      },
    },
    cerebras: {
      id: "cerebras",
      name: "Cerebras",
      env: ["CEREBRAS_API_KEY"],
      npm: "@ai-sdk/cerebras",
      models: {
        "llama3.1-70b": model("llama3.1-70b", "Llama 3.1 70B", "llama", "2026-01-01", {
          context: 131072,
          output: 8192,
        }),
      },
    },
  }
}
