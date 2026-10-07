import type { EngineClient } from "../engine/client"

type SessionOperationName = "context" | "summarize" | "updateTitle" | "revert" | "revertLatest" | "unrevert" | "subscribeVerification"
type SessionOperations = Pick<EngineClient, SessionOperationName>

/**
 * Main process creates the Core adapter lazily; keep its session operations on the
 * same facade as prompt submission instead of exposing only the analysis methods.
 */
export function createLazySessionOperations(resolve: () => Promise<EngineClient>): SessionOperations {
  return {
    subscribeVerification(listener) {
      let unsubscribe: (() => void) | undefined
      let cancelled = false
      void resolve().then((engine) => {
        unsubscribe = engine.subscribeVerification?.(listener)
        if (cancelled) unsubscribe?.()
      }).catch(() => {
        // Core readiness is surfaced by health(); a background event subscription
        // must not create an unhandled rejection while that check is in flight.
      })
      return () => {
        cancelled = true
        unsubscribe?.()
      }
    },
    async context(sessionID) {
      const engine = await resolve()
      if (!engine.context) throw new Error("当前引擎不支持读取上下文状态")
      return engine.context(sessionID)
    },
    async summarize(sessionID, model, instructions) {
      const engine = await resolve()
      if (!engine.summarize) throw new Error("当前引擎不支持会话压缩")
      return engine.summarize(sessionID, model, instructions)
    },
    async updateTitle(sessionID, title) {
      const engine = await resolve()
      if (!engine.updateTitle) throw new Error("当前引擎不支持重命名会话")
      return engine.updateTitle(sessionID, title)
    },
    async revert(sessionID, messageID) {
      const engine = await resolve()
      if (!engine.revert) throw new Error("当前引擎不支持撤销会话")
      return engine.revert(sessionID, messageID)
    },
    async revertLatest(sessionID) {
      const engine = await resolve()
      if (!engine.revertLatest) throw new Error("当前引擎不支持撤销会话")
      return engine.revertLatest(sessionID)
    },
    async unrevert(sessionID) {
      const engine = await resolve()
      if (!engine.unrevert) throw new Error("当前引擎不支持重做会话")
      return engine.unrevert(sessionID)
    },
  }
}
