import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { Truncate } from "@/tool/truncation"
import { ToolResultProjection } from "@/runtime/tool-result-projection"
import {
  autoCompactThreshold,
  serializeForTokenEstimate,
} from "@/runtime/context-budget"
import type { ModelMessage } from "ai"

export const DEFAULT_HISTORY_SNIP_MIN_TURNS = 4
export const CONTEXT_WINDOW_THRESHOLDS = Object.freeze({
  historySnip: 0.75,
  historyTarget: 0.7,
  microcompact: 0.82,
  collapse: 0.9,
  emergencyCollapse: 0.95,
  collapseTarget: 0.86,
  coldCacheMinutes: 60,
  keepRecentToolResults: 5,
})
const MAX_RECOVERY_REFERENCES = 8

const COMPACTABLE_TOOL_RESULTS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "webfetch",
  // 方法搜索结果包含动态 Schema，但方法仍在当前注册表/窗口中；旧搜索结果可再次
  // 搜索生成，不能让每一轮 discovery 的 Schema 永久占住上下文。
  "tool_search",
  "edit",
  "write",
])
const REFERENCE_ONLY_COMPACTABLE_TOOL_RESULTS = new Set(["bash"])

export type HistorySnipResult = {
  messages: MessageV2.WithParts[]
  changed: boolean
  removedMessages: number
  removedTurns: number
  savedEstimate: number
  beforeEstimate: number
  afterEstimate: number
  recoveryReferences: string[]
}

function partEstimate(part: MessageV2.Part) {
  if (part.type === "text" || part.type === "reasoning") return Token.estimate(part.text)
  if (part.type === "tool") {
    if (part.state.status === "completed") {
      return ToolResultProjection.estimateTokens(
        part.state.modelOutput ? ToolResultProjection.boundModelOutput(part.state.modelOutput) : ToolResultProjection.legacy({
          toolName: part.tool,
          title: part.state.title,
          output: part.state.output,
          outputReference: part.state.outputReference,
        }),
      )
    }
    if (part.state.status === "error") return Token.estimate(part.state.error)
  }
  return 0
}

export function estimateContextMessage(message: MessageV2.WithParts) {
  return message.parts.reduce((total, part) => total + partEstimate(part), 0)
}

export function estimateContextMessages(messages: MessageV2.WithParts[]) {
  return messages.reduce((total, message) => total + estimateContextMessage(message), 0)
}

function isProtectedMessage(message: MessageV2.WithParts) {
  return (
    (message.info.role === "assistant" && message.info.summary === true) ||
    message.parts.some((part) => part.type === "compaction")
  )
}

function recoveryReference(message: MessageV2.WithParts) {
  for (const part of message.parts) {
    if (part.type !== "tool") continue
    const metadata = "metadata" in part.state ? part.state.metadata : undefined
    const reference = part.state.status === "completed"
      ? Truncate.liveOutputReference(part.state.outputReference, metadata?.outputPath)
      : Truncate.liveOutputReference(metadata?.outputPath)
    if (reference) return reference
  }
  return undefined
}

function snipBoundary(input: {
  anchor: MessageV2.User
  recoveryReferences: string[]
  mode?: "history-snip" | "collapse" | "emergency-collapse"
}): MessageV2.WithParts {
  const id = `context-snip-${input.anchor.id}`
  const references = input.recoveryReferences.length
    ? ` 可恢复工具结果：${input.recoveryReferences.join(", ")}；需要细节时使用 read 的 offset/limit 分段读取。`
    : ""
  const label = input.mode === "emergency-collapse"
    ? "较早对话已做紧急读时折叠"
    : input.mode === "collapse"
      ? "较早对话已做读时折叠"
      : "较早对话已从本轮模型视图省略"
  return {
    info: {
      ...input.anchor,
      id,
    },
    parts: [
      {
        id: `${id}-part`,
        messageID: id,
        sessionID: input.anchor.sessionID,
        type: "text",
        synthetic: true,
        text: `[${label}；完整 Session 历史仍保留在磁盘。${references}]`,
      },
    ],
  } as MessageV2.WithParts
}

function unchanged(messages: MessageV2.WithParts[], totalEstimate: number): HistorySnipResult {
  return {
    messages,
    changed: false,
    removedMessages: 0,
    removedTurns: 0,
    savedEstimate: 0,
    beforeEstimate: totalEstimate,
    afterEstimate: totalEstimate,
    recoveryReferences: [],
  }
}

/**
 * 只读地移除最早的完整 user-turn group。磁盘历史、parts 和导出记录不变；调用方只把
 * 返回的副本送给本轮模型。达到 target 前会优先移除未保护的旧轮，summary/boundary
 * 始终保留，避免 snip 把可恢复状态一起砍掉。
 */
export function snipHistory(input: {
  messages: MessageV2.WithParts[]
  targetTokens: number
  minRecentTurns?: number
  mode?: "history-snip" | "collapse" | "emergency-collapse"
}): HistorySnipResult {
  const targetTokens = Math.max(0, input.targetTokens)
  const minRecentTurns = Math.max(1, input.minRecentTurns ?? DEFAULT_HISTORY_SNIP_MIN_TURNS)
  const userStarts = input.messages.flatMap((message, index) => (message.info.role === "user" ? [index] : []))
  const totalEstimate = estimateContextMessages(input.messages)
  if (userStarts.length <= minRecentTurns || totalEstimate <= targetTokens) {
    return unchanged(input.messages, totalEstimate)
  }

  const remove = new Set<number>()
  let currentEstimate = totalEstimate
  let removedTurns = 0
  const recoveryReferences: string[] = []

  for (let turn = 0; turn < userStarts.length - minRecentTurns && currentEstimate > targetTokens; turn++) {
    const start = userStarts[turn]
    const end = userStarts[turn + 1] ?? input.messages.length
    const group = input.messages.slice(start, end)
    if (group.some(isProtectedMessage)) continue
    for (let index = start; index < end; index++) remove.add(index)
    currentEstimate -= group.reduce((total, message) => total + estimateContextMessage(message), 0)
    removedTurns += 1
    for (const message of group) {
      const reference = recoveryReference(message)
      if (reference && !recoveryReferences.includes(reference) && recoveryReferences.length < MAX_RECOVERY_REFERENCES) {
        recoveryReferences.push(reference)
      }
    }
  }

  if (remove.size === 0) {
    return unchanged(input.messages, totalEstimate)
  }

  const projected = input.messages.filter((_message, index) => !remove.has(index))
  const anchor = projected.find((message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user")
  if (!anchor) {
    return unchanged(input.messages, totalEstimate)
  }

  const firstUserIndex = projected.findIndex((message) => message.info.role === "user")
  projected.splice(
    firstUserIndex,
    0,
    snipBoundary({
      anchor: anchor.info,
      recoveryReferences,
      mode: input.mode,
    }),
  )

  return {
    messages: projected,
    changed: true,
    removedMessages: remove.size,
    removedTurns,
    savedEstimate: Math.max(0, totalEstimate - currentEstimate),
    beforeEstimate: totalEstimate,
    afterEstimate: currentEstimate,
    recoveryReferences,
  }
}

export type MicrocompactReason = "pressure" | "time-gap"

function completedToolReference(part: MessageV2.ToolPart) {
  if (part.state.status !== "completed") return undefined
  return Truncate.liveOutputReference(part.state.outputReference, part.state.metadata?.outputPath)
}

function completedToolModelOutput(part: MessageV2.ToolPart) {
  if (part.state.status !== "completed") return ""
  return part.state.modelOutput ?? ToolResultProjection.legacy({
    toolName: part.tool,
    title: part.state.title,
    output: part.state.output,
    outputReference: completedToolReference(part),
  })
}

export function isMicrocompactableToolResult(part: MessageV2.ToolPart) {
  if (COMPACTABLE_TOOL_RESULTS.has(part.tool)) return true
  if (REFERENCE_ONLY_COMPACTABLE_TOOL_RESULTS.has(part.tool)) {
    return completedToolReference(part) !== undefined
  }
  return false
}

/**
 * 只裁剪可重新读取、重新搜索或从受控引用恢复的工具结果。
 * 数据导入、工作流、实验日志和计量估计结果不在白名单中，不能靠“以后再猜”恢复。
 */
export function microcompactToolResults(
  messages: MessageV2.WithParts[],
  options: {
    reason?: MicrocompactReason
    keepRecent?: number
    minimumOutputTokens?: number
  } = {},
) {
  const reason = options.reason ?? "pressure"
  const keepRecent = Math.max(1, options.keepRecent ?? CONTEXT_WINDOW_THRESHOLDS.keepRecentToolResults)
  const minimumOutputTokens = Math.max(0, options.minimumOutputTokens ?? (reason === "time-gap" ? 0 : 2_000))
  const candidates = messages.flatMap((message, messageIndex) =>
    message.parts.flatMap((part, partIndex) =>
      part.type === "tool" &&
      part.state.status === "completed" &&
      isMicrocompactableToolResult(part)
        ? [{ messageIndex, partIndex }]
        : [],
    ),
  )
  const clear = new Set(
    candidates.slice(0, Math.max(0, candidates.length - keepRecent)).map((item) => `${item.messageIndex}:${item.partIndex}`),
  )
  if (clear.size === 0) {
    return { messages, clearedParts: 0, savedEstimate: 0 }
  }

  const projected = structuredClone(messages) as MessageV2.WithParts[]
  let clearedParts = 0
  let savedEstimate = 0
  for (const [messageIndex, message] of projected.entries()) {
    for (const [partIndex, part] of message.parts.entries()) {
      if (!clear.has(`${messageIndex}:${partIndex}`)) continue
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const modelOutput = completedToolModelOutput(part)
      if (ToolResultProjection.estimateTokens(modelOutput) < minimumOutputTokens) continue
      const reference = completedToolReference(part)
      const replacement = reference
        ? `[较早工具结果正文已清理；完整结果仍可从 ${reference} 使用 read 的 offset/limit 分段恢复。]`
        : part.tool === "edit" || part.tool === "write"
          ? `[较早的 ${part.tool} 执行结果已清理；如需确认当前状态，请使用 read 重新检查目标文件，不要重复写入。]`
          : `[较早的 ${part.tool} 结果已清理；需要时可重新调用该工具获取当前结果。]`
      savedEstimate += Math.max(
        0,
        ToolResultProjection.estimateTokens(modelOutput) - ToolResultProjection.estimateTokens(replacement),
      )
      part.state.modelOutput = replacement
      part.state.output = replacement
      clearedParts += 1
    }
  }
  if (clearedParts === 0) return { messages, clearedParts, savedEstimate }
  return { messages: projected, clearedParts, savedEstimate }
}

export type ContextProjectionAction = {
  action: "history-snip" | "microcompact" | "collapse" | "summary"
  beforeTokens: number
  afterTokens: number
  savedEstimate: number
  removedTurns?: number
  clearedParts?: number
  emergency?: boolean
  reason?: MicrocompactReason
}

export type ContextWindowProjection = {
  messages: MessageV2.WithParts[]
  actions: ContextProjectionAction[]
  beforeEstimate: number
  afterEstimate: number
  summaryRequired: boolean
  recoveryReferences: string[]
}

function lastAssistantAt(messages: MessageV2.WithParts[]) {
  return messages.reduce((latest, message) => {
    if (message.info.role !== "assistant") return latest
    return Math.max(latest, message.info.time.completed ?? message.info.time.created)
  }, 0)
}

function references(messages: MessageV2.WithParts[]) {
  return Array.from(new Set(messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return []
      const reference = completedToolReference(part)
      return reference ? [reference] : []
    })
  ))).slice(-MAX_RECOVERY_REFERENCES)
}

/**
 * 五级策略的读时部分。完整历史从不在这里落盘修改；调用方只把返回视图送给模型。
 */
export function projectContextWindow(input: {
  messages: MessageV2.WithParts[]
  inputBudget: number | null
  now?: number
  enableMicrocompact?: boolean
}): ContextWindowProjection {
  const beforeEstimate = estimateContextMessages(input.messages)
  if (input.inputBudget === null || input.inputBudget <= 0) {
    return {
      messages: input.messages,
      actions: [],
      beforeEstimate,
      afterEstimate: beforeEstimate,
      summaryRequired: false,
      recoveryReferences: references(input.messages),
    }
  }

  const actions: ContextProjectionAction[] = []
  let messages = input.messages
  let estimate = beforeEstimate
  const pressure = () => estimate / input.inputBudget!
  const applySnip = (
    action: "history-snip" | "collapse",
    targetRatio: number,
    minRecentTurns: number,
    emergency = false,
  ) => {
    const before = estimate
    const result = snipHistory({
      messages,
      targetTokens: Math.floor(input.inputBudget! * targetRatio),
      minRecentTurns,
      mode: action === "history-snip" ? "history-snip" : emergency ? "emergency-collapse" : "collapse",
    })
    if (!result.changed) return
    messages = result.messages
    estimate = estimateContextMessages(messages)
    actions.push({
      action,
      beforeTokens: before,
      afterTokens: estimate,
      savedEstimate: Math.max(0, before - estimate),
      removedTurns: result.removedTurns,
      ...(action === "collapse" ? { emergency } : {}),
    })
  }

  if (pressure() >= CONTEXT_WINDOW_THRESHOLDS.historySnip) {
    applySnip("history-snip", CONTEXT_WINDOW_THRESHOLDS.historyTarget, 8)
  }

  const now = input.now ?? Date.now()
  const assistantAt = lastAssistantAt(messages)
  const coldCache = assistantAt > 0 &&
    now - assistantAt >= CONTEXT_WINDOW_THRESHOLDS.coldCacheMinutes * 60_000
  if (input.enableMicrocompact !== false && (pressure() >= CONTEXT_WINDOW_THRESHOLDS.microcompact || coldCache)) {
    const before = estimate
    const result = microcompactToolResults(messages, {
      reason: coldCache ? "time-gap" : "pressure",
      keepRecent: CONTEXT_WINDOW_THRESHOLDS.keepRecentToolResults,
    })
    if (result.clearedParts > 0) {
      messages = result.messages
      estimate = estimateContextMessages(messages)
      actions.push({
        action: "microcompact",
        beforeTokens: before,
        afterTokens: estimate,
        savedEstimate: Math.max(0, before - estimate),
        clearedParts: result.clearedParts,
        reason: coldCache ? "time-gap" : "pressure",
      })
    }
  }

  if (pressure() >= CONTEXT_WINDOW_THRESHOLDS.collapse) {
    applySnip("collapse", CONTEXT_WINDOW_THRESHOLDS.collapseTarget, 4)
  }
  if (pressure() >= CONTEXT_WINDOW_THRESHOLDS.emergencyCollapse) {
    applySnip("collapse", CONTEXT_WINDOW_THRESHOLDS.collapseTarget, 2, true)
  }

  const summaryThreshold = autoCompactThreshold(input.inputBudget)!
  const summaryRequired = estimate > summaryThreshold
  if (summaryRequired) {
    actions.push({
      action: "summary",
      beforeTokens: estimate,
      afterTokens: estimate,
      savedEstimate: 0,
    })
  }

  return {
    messages,
    actions,
    beforeEstimate,
    afterEstimate: estimate,
    summaryRequired,
    recoveryReferences: references(messages),
  }
}

function estimateModelMessage(message: ModelMessage) {
  return Token.estimate(serializeForTokenEstimate(message))
}

function protectedModelMessage(message: ModelMessage) {
  const serialized = serializeForTokenEstimate(message)
  return (
    message.role === "system" ||
    serialized.includes("上下文压缩恢复状态") ||
    serialized.includes("context-capsule")
  )
}

/**
 * ModelGateway 已知 system/tool Schema 实际开销后的最后一道读时投影。
 * 按完整 user turn 删除，避免拆开 tool-call/tool-result；完整 Session 历史不变。
 */
export function projectModelMessageWindow(input: {
  messages: ModelMessage[]
  targetTokens: number
  minRecentTurns: number
  emergency: boolean
}) {
  const targetTokens = Math.max(0, input.targetTokens)
  const minRecentTurns = Math.max(1, input.minRecentTurns)
  const beforeTokens = input.messages.reduce((total, message) => total + estimateModelMessage(message), 0)
  const userStarts = input.messages.flatMap((message, index) => message.role === "user" ? [index] : [])
  if (userStarts.length <= minRecentTurns || beforeTokens <= targetTokens) {
    return {
      messages: input.messages,
      changed: false,
      removedTurns: 0,
      beforeTokens,
      afterTokens: beforeTokens,
      savedEstimate: 0,
      recoveryReferences: [] as string[],
    }
  }

  const remove = new Set<number>()
  const removedMessages: ModelMessage[] = []
  let currentTokens = beforeTokens
  let removedTurns = 0
  for (
    let turn = 0;
    turn < userStarts.length - minRecentTurns && currentTokens > targetTokens;
    turn += 1
  ) {
    const start = userStarts[turn]
    const end = userStarts[turn + 1] ?? input.messages.length
    const group = input.messages.slice(start, end)
    if (group.some(protectedModelMessage)) continue
    for (let index = start; index < end; index += 1) remove.add(index)
    removedMessages.push(...group)
    currentTokens -= group.reduce((total, message) => total + estimateModelMessage(message), 0)
    removedTurns += 1
  }
  if (remove.size === 0) {
    return {
      messages: input.messages,
      changed: false,
      removedTurns: 0,
      beforeTokens,
      afterTokens: beforeTokens,
      savedEstimate: 0,
      recoveryReferences: [] as string[],
    }
  }

  const recoveryReferences = Array.from(new Set(
    serializeForTokenEstimate(removedMessages).match(/tool-output:[A-Za-z0-9_-]+/g) ?? [],
  )).slice(-MAX_RECOVERY_REFERENCES)
  const boundary: ModelMessage = {
    role: "user",
    content: [
      input.emergency ? "[较早对话已做最终紧急读时投影；完整 Session 历史仍保留在磁盘。" : "[较早对话已做最终读时投影；完整 Session 历史仍保留在磁盘。",
      recoveryReferences.length
        ? ` 可恢复工具结果：${recoveryReferences.join(", ")}；按需使用 read 分段读取。`
        : "",
      "]",
    ].join(""),
  }
  const messages = [boundary, ...input.messages.filter((_message, index) => !remove.has(index))]
  const afterTokens = messages.reduce((total, message) => total + estimateModelMessage(message), 0)
  return {
    messages,
    changed: true,
    removedTurns,
    beforeTokens,
    afterTokens,
    savedEstimate: Math.max(0, beforeTokens - afterTokens),
    recoveryReferences,
  }
}
