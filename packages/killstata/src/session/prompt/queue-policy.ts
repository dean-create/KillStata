import type { QueuedSessionAction } from "@/runtime/types"

export function sortQueuedSessionActions(actions: QueuedSessionAction[]) {
  return [...actions].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
}
