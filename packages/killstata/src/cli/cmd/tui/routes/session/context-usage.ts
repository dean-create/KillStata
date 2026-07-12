import type { AssistantMessage, Message } from "@killstata/sdk/v2"

type ProviderWithModels = {
  id: string
  models: Record<
    string,
    {
      limit?: {
        context?: number
      }
    }
  >
}

export type ContextUsageLevel = "ok" | "watch" | "danger"

export type ContextUsage = {
  tokens: number
  tokensLabel: string
  percentage: number | null
  level: ContextUsageLevel
}

function isAssistantWithUsage(message: Message): message is AssistantMessage {
  return message.role === "assistant" && message.tokens.output > 0
}

function levelFromPercentage(percentage: number | null): ContextUsageLevel {
  if (percentage === null) return "ok"
  if (percentage >= 85) return "danger"
  if (percentage >= 70) return "watch"
  return "ok"
}

export function getContextUsage(messages: Message[], providers: ProviderWithModels[]) {
  const last = messages.findLast(isAssistantWithUsage)
  if (!last) return undefined

  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  const model = providers.find((provider) => provider.id === last.providerID)?.models[last.modelID]
  const percentage = model?.limit?.context ? Math.round((tokens / model.limit.context) * 100) : null

  return {
    tokens,
    tokensLabel: tokens.toLocaleString(),
    percentage,
    level: levelFromPercentage(percentage),
  } satisfies ContextUsage
}

export function formatContextUsage(usage: ContextUsage) {
  const parts = [usage.tokensLabel]
  if (usage.percentage !== null) parts.push(`${usage.percentage}%`)
  if (usage.level === "watch") parts.push("watch")
  if (usage.level === "danger") parts.push("compact")
  return parts.join("  ")
}

export function contextUsageHint(usage: ContextUsage) {
  if (usage.level === "danger") return "Context high: run /compact; use data_import for large Excel files."
  if (usage.level === "watch") return "Context growing: prefer data_import artifacts for large tables."
  return undefined
}
