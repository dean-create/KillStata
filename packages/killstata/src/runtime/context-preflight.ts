import { Token } from "@/util/token"
import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import {
  contextBudget,
  contextUsageFromEstimate,
  serializeForTokenEstimate,
  type ContextUsageSnapshot,
} from "./context-budget"

export const MAX_CONTEXT_COMPACTION_ATTEMPTS = 3

export function shouldStopContextCompaction(attempts: number) {
  return attempts >= MAX_CONTEXT_COMPACTION_ATTEMPTS
}

export type ContextPreflight = ContextUsageSnapshot & {
  estimatedTokens: number
  budgetTokens: number
  overBudget: boolean
}

export class ContextPreflightError extends Error {
  constructor(public readonly preflight: ContextPreflight) {
    super(
      `Context preflight exceeded model input budget: ${preflight.estimatedTokens} > ${preflight.budgetTokens} tokens`,
    )
    this.name = "ContextPreflightError"
  }
}

/**
 * 发送前的保守预算：system、完整工具描述和已经 compact/progressiveContext 过的 history
 * 都进入同一份快照。这里不猜 provider tokenizer，数字必须在 UI 标成估算；真正超限仍
 * 交给 provider 的结构化错误处理。
 */
export function contextPreflight(input: {
  model: Provider.Model
  system: string[]
  messages: ModelMessage[]
  toolSchemaText?: string
  reserveTokens?: number
}): ContextPreflight {
  const systemText = input.system.join("\n")
  const toolText = input.toolSchemaText ?? ""
  const messageText = input.messages
    .map((message) => (typeof message.content === "string" ? message.content : serializeForTokenEstimate(message.content)))
    .join("\n")
  const estimatedSystemTokens = Token.estimate(systemText)
  const estimatedToolTokens = Token.estimate(toolText)
  const estimatedMessageTokens = Token.estimate(messageText)
  const estimatedTokens = estimatedSystemTokens + estimatedToolTokens + estimatedMessageTokens
  const budget = contextBudget(input.model, input.reserveTokens)
  const snapshot = contextUsageFromEstimate({
    model: input.model,
    budget,
    estimatedPromptTokens: estimatedTokens,
    estimatedSystemTokens,
    estimatedToolTokens,
    estimatedMessageTokens,
  })
  return {
    ...snapshot,
    estimatedTokens,
    budgetTokens: budget.inputBudget ?? 0,
    overBudget: budget.inputBudget !== null && estimatedTokens > budget.inputBudget,
  }
}
