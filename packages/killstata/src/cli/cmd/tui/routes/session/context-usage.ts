import type { RuntimeContextTuiState } from "@tui/context/runtime-state"
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
  usedTokens: number
  usedTokensLabel: string
  budgetTokens: number | null
  budgetTokensLabel: string
  remainingTokens: number | null
  remainingTokensLabel: string
  percentage: number | null
  level: ContextUsageLevel
  source: "estimated" | "actual"
}

function levelFromPercentage(percentage: number | null): ContextUsageLevel {
  if (percentage === null) return "ok"
  if (percentage >= 85) return "danger"
  if (percentage >= 70) return "watch"
  return "ok"
}

export function formatTokens(tokens: number | null | undefined) {
  return tokens === null || tokens === undefined ? "未知" : tokens.toLocaleString()
}

/** 把运行时 ISO 时间转成紧凑的本地日期时间，避免把 T、毫秒和 Z 直接暴露给用户。 */
export function formatUpdatedAt(input: string) {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  const pad = (value: number) => value.toString().padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function contextUsageFromRuntime(state: RuntimeContextTuiState | undefined): ContextUsage | undefined {
  const usage = state?.usage
  if (!usage) return undefined
  return {
    usedTokens: usage.usedTokens,
    usedTokensLabel: formatTokens(usage.usedTokens),
    budgetTokens: usage.inputBudget,
    budgetTokensLabel: formatTokens(usage.inputBudget),
    remainingTokens: usage.remainingTokens,
    remainingTokensLabel: formatTokens(usage.remainingTokens),
    percentage: usage.percentage,
    level: levelFromPercentage(usage.percentage),
    source: usage.source,
  }
}

/** 兼容没有 runtime 快照的旧会话：只使用上一条 assistant 的 provider usage。 */
export function getContextUsage(messages: Message[], providers: ProviderWithModels[]) {
  const last = messages.findLast(
    (message): message is AssistantMessage =>
      message.role === "assistant" && (message.tokens.input > 0 || message.tokens.output > 0),
  )
  if (!last) return undefined
  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  const model = providers.find((provider) => provider.id === last.providerID)?.models[last.modelID]
  const budget = model?.limit?.context ? model.limit.context : null
  const percentage = budget === null ? null : Math.round((tokens / budget) * 100)
  return {
    usedTokens: tokens,
    usedTokensLabel: formatTokens(tokens),
    budgetTokens: budget,
    budgetTokensLabel: formatTokens(budget),
    remainingTokens: budget === null ? null : budget - tokens,
    remainingTokensLabel: formatTokens(budget === null ? null : budget - tokens),
    percentage,
    level: levelFromPercentage(percentage),
    source: "actual" as const,
  } satisfies ContextUsage
}

export function formatContextUsage(usage: ContextUsage) {
  const parts = [`${usage.usedTokensLabel}/${usage.budgetTokensLabel}`]
  if (usage.percentage !== null) parts.push(`${usage.percentage}%`)
  parts.push(usage.source === "actual" ? "实际" : "估算")
  if (usage.level === "watch") parts.push("注意")
  if (usage.level === "danger") parts.push("建议整理")
  return parts.join("  ")
}

export function contextUsageHint(usage: ContextUsage) {
  if (usage.level === "danger") return "上下文较高：可以运行 /compact 整理旧内容。"
  if (usage.level === "watch") return "上下文正在增长：大表建议使用 data_import 产物引用。"
  return undefined
}
