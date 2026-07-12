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

const HIDDEN_PROVIDER_PATTERNS = [/\bcoding[- ]plan\b/i, /\btoken[- ]plan\b/i]

type ProviderDisplayInput = {
  id: string
  name?: string
  api?: string
  env?: string[]
}

const PROVIDER_DISPLAY_OVERRIDES: Record<
  string,
  {
    name: string
    region: string
    note: string
  }
> = {
  alibaba: {
    name: "Alibaba International (DashScope)",
    region: "International",
    note: "Use Alibaba Cloud international DashScope keys",
  },
  "alibaba-cn": {
    name: "Alibaba China (DashScope/Bailian)",
    region: "China",
    note: "Use mainland China DashScope / Bailian keys",
  },
  minimax: {
    name: "MiniMax Global (minimax.io)",
    region: "Global",
    note: "Use keys issued for platform.minimax.io",
  },
  "minimax-cn": {
    name: "MiniMax China (minimaxi.com)",
    region: "China",
    note: "Use keys issued for platform.minimaxi.com",
  },
}

export function providerPriority(providerID: string) {
  return PROVIDER_PRIORITY[providerID] ?? 99
}

export function isPopularProvider(providerID: string) {
  return providerID in PROVIDER_PRIORITY
}

export function isUserSelectableProvider(provider: { id: string; name?: string }) {
  const haystacks = [provider.id, provider.name ?? ""]
  return !HIDDEN_PROVIDER_PATTERNS.some((pattern) => haystacks.some((value) => pattern.test(value)))
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

export function providerEndpointHost(provider: ProviderDisplayInput) {
  if (!provider.api) return
  try {
    return new URL(provider.api).host
  } catch {
    return provider.api.replace(/^https?:\/\//, "").split("/")[0]
  }
}

export function providerDisplayName(provider: ProviderDisplayInput) {
  return PROVIDER_DISPLAY_OVERRIDES[provider.id]?.name ?? provider.name ?? provider.id
}

export function providerDisplayDescription(provider: ProviderDisplayInput) {
  const override = PROVIDER_DISPLAY_OVERRIDES[provider.id]
  const host = providerEndpointHost(provider)
  const parts = [
    override?.region,
    host ? `endpoint: ${host}` : undefined,
    provider.env?.[0] ? `key: ${provider.env[0]}` : "API key",
  ].filter((item): item is string => !!item)
  return parts.join(" | ")
}

export function providerDisplayNote(provider: ProviderDisplayInput) {
  return PROVIDER_DISPLAY_OVERRIDES[provider.id]?.note
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
