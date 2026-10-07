import { Instance } from "@/project/instance"

/**
 * 已确认的方法路线：用户或模型在上一轮明确选择的目标估计器。
 * 用于让下一轮 resolveTools 直接加载 did2s / 事件研究，而不依赖二次搜索。
 */
export namespace ConfirmedMethods {
  const state = Instance.state(() => new Map<string, Set<string>>())

  export function add(sessionID: string, toolIDs: string[]) {
    const map = state()
    const set = map.get(sessionID) ?? new Set<string>()
    for (const id of toolIDs) set.add(id)
    map.set(sessionID, set)
  }

  export function consume(sessionID: string): string[] {
    const map = state()
    const set = map.get(sessionID)
    if (!set || set.size === 0) return []
    map.delete(sessionID)
    return [...set]
  }

  export function peek(sessionID: string): string[] {
    const set = state().get(sessionID)
    return set ? [...set] : []
  }
}
