import type { QueuedSessionAction } from "@/runtime/types"
import { MessageV2 } from "../message-v2"
import { RuntimeHooks } from "@/runtime/hooks"
import { Session } from "../session-state"
import { SessionRunCoordinator } from "../run-state"
import { ulid } from "ulid"

/**
 * 队列动作一旦开始执行，后续消息只能排队，不能改变这次动作的消息归属。
 * dispatch 用它把活动动作固定到自己的用户消息，避免用户追问在分析尚未结束时
 * 抢成 lastUser，导致分析工具池被错误地用于咨询轮。
 */
export function actionMessageID(action?: QueuedSessionAction) {
  const messageID = action?.metadata?.["messageID"]
  return typeof messageID === "string" ? messageID : undefined
}

/**
 * 会话动作队列：入队、等待、回调解析与忙碌判定。
 */

export async function enqueueAction(
  sessionID: string,
  action: Omit<QueuedSessionAction, "id" | "sessionID" | "createdAt"> & { metadata?: Record<string, unknown> },
) {
  const queued = {
    id: ulid(),
    sessionID,
    createdAt: Date.now(),
    ...action,
  } satisfies QueuedSessionAction
  SessionRunCoordinator.enqueue(queued)
  await RuntimeHooks.inputAccepted({
    sessionID,
    action: action.type,
    metadata: action.metadata,
  })
  return queued
}

export function waitForAction(sessionID: string, actionID?: string) {
  return SessionRunCoordinator.waitForAction(sessionID, actionID)
}

export function resolveCallbacks(sessionID: string, message: MessageV2.WithParts, actionID?: string) {
  SessionRunCoordinator.resolveAction(sessionID, message, actionID)
}

export function nextQueuedAction(sessionID: string) {
  return SessionRunCoordinator.next(sessionID)
}

export function completedReplyForAction(
  action: QueuedSessionAction,
  messages: MessageV2.WithParts[],
): MessageV2.WithParts | undefined {
  if (action.type !== "prompt" && action.type !== "command" && action.type !== "shell") return undefined
  const messageID = typeof action.metadata?.["messageID"] === "string" ? action.metadata["messageID"] : undefined
  if (!messageID) return undefined
  return messages.findLast(
    (message) =>
      message.info.role === "assistant" &&
      message.info.parentID === messageID &&
      !!message.info.finish &&
      !["tool-calls", "unknown"].includes(message.info.finish),
  )
}

export function start(sessionID: string) {
  const runtime = SessionRunCoordinator.ensure(sessionID)
  if (runtime.abort) return
  const controller = new AbortController()
  runtime.abort = controller
  return controller.signal
}

export function assertNotBusy(sessionID: string) {
  if (SessionRunCoordinator.active(sessionID)) throw new Session.BusyError(sessionID)
}
