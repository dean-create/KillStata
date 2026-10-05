import { SessionCompaction } from "@/session/compaction"
import type { MessageV2 } from "@/session/message-v2"
import type { WorkflowInputIntent } from "@/runtime/types"
import type { Provider } from "@/provider/provider"
import { contextBudget } from "@/runtime/context-budget"
import { ContextManager } from "@/runtime/context-manager"
import {
  projectContextWindow,
  projectModelMessageWindow,
} from "@/session/context-projection"
import type { ModelMessage } from "ai"
import { Config } from "@/config/config"

/** 服务层的本轮上下文投影入口；不包含工作流或工具决策。 */
export const ContextService = {
  async projectForModel(input: {
    sessionID: string
    messages: MessageV2.WithParts[]
    inputIntent?: WorkflowInputIntent
    model: Provider.Model
    now?: number
  }) {
    const runtime = input.inputIntent === "conversation"
      ? { messages: input.messages, system: [] as string[] }
      : await SessionCompaction.progressiveContext({
          sessionID: input.sessionID,
          messages: input.messages,
        })
    const budget = contextBudget(
      input.model,
      Math.min(input.model.limit.output, 32_000),
    )
    const config = await Config.get()
    const projection = projectContextWindow({
      messages: runtime.messages,
      inputBudget: budget.inputBudget,
      now: input.now,
      enableMicrocompact: config.compaction?.prune !== false,
    })
    for (const action of projection.actions) {
      if (action.action === "summary" && config.compaction?.auto === false) continue
      ContextManager.publishAction({
        sessionID: input.sessionID,
        historyVersion: input.messages.length,
        action: {
          action: action.action,
          beforeTokens: action.beforeTokens,
          afterTokens: action.afterTokens,
          savedEstimate: action.savedEstimate,
          restoredReferences: projection.recoveryReferences.length,
          removedTurns: action.removedTurns,
          clearedParts: action.clearedParts,
          emergency: action.emergency,
          reason: action.reason,
          updatedAt: new Date().toISOString(),
        },
      })
    }
    return {
      ...runtime,
      messages: projection.messages,
      projection,
      summaryRequired: config.compaction?.auto !== false && projection.summaryRequired,
    }
  },

  projectFinalModelView(input: {
    sessionID: string
    messages: ModelMessage[]
    targetTokens: number
    minRecentTurns: number
    emergency: boolean
  }) {
    const projection = projectModelMessageWindow(input)
    if (projection.changed) {
      ContextManager.publishAction({
        sessionID: input.sessionID,
        historyVersion: input.messages.length,
        action: {
          action: "collapse",
          beforeTokens: projection.beforeTokens,
          afterTokens: projection.afterTokens,
          savedEstimate: projection.savedEstimate,
          restoredReferences: projection.recoveryReferences.length,
          removedTurns: projection.removedTurns,
          emergency: input.emergency,
          updatedAt: new Date().toISOString(),
        },
      })
    }
    return projection
  },
  detectCacheBreak(input: Parameters<typeof SessionCompaction.detectCacheBreak>[0]) {
    return SessionCompaction.detectCacheBreak(input)
  },
}
