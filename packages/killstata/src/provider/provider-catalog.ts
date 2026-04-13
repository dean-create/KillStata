export const POPULAR_PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "xai",
  "groq",
  "mistral",
  "alibaba",
  "alibaba-cn",
  "deepseek",
  "moonshotai-cn",
  "moonshotai",
  "zhipuai",
  "zai",
  "minimax",
  "minimax-cn",
  "siliconflow-cn",
  "siliconflow",
  "stepfun",
  "iflowcn",
  "modelscope",
  "qihang-ai",
  "jiekou",
  "bailing",
  "xiaomi",
  "perplexity",
  "cohere",
  "togetherai",
  "deepinfra",
  "cerebras",
] as const

export const PROVIDER_PRIORITY: Record<string, number> = Object.fromEntries(
  POPULAR_PROVIDER_ORDER.map((providerID, index) => [providerID, index + 1]),
)

export function providerPriority(providerID: string) {
  return PROVIDER_PRIORITY[providerID] ?? 99
}

export function isPopularProvider(providerID: string) {
  return providerID in PROVIDER_PRIORITY
}

export function supportsApiKeyProvider(
  provider: { env?: string[] },
  methods: Array<{ type: "oauth" | "api" }> = [],
) {
  if (methods.some((method) => method.type === "api")) return true
  return (provider.env?.length ?? 0) > 0 || methods.length === 0
}

export function normalizeApiKey(value: string) {
  const trimmed = value.trim()
  const quoted = trimmed.match(/^(['"])(.*)\1$/)
  return quoted ? quoted[2].trim() : trimmed
}

export function normalizeProviderID(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@ai-sdk\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function normalizeBaseURL(value: string) {
  return value.trim().replace(/\/+$/, "")
}

export function buildCustomProviderConfig(input: {
  providerID: string
  providerName: string
  baseURL: string
  modelID: string
}) {
  const baseURL = normalizeBaseURL(input.baseURL)

  return {
    [input.providerID]: {
      name: input.providerName,
      api: baseURL,
      env: [],
      options: {
        baseURL,
      },
      models: {
        [input.modelID]: {
          id: input.modelID,
          name: input.modelID,
          provider: {
            npm: "@ai-sdk/openai-compatible",
          },
        },
      },
    },
  }
}
