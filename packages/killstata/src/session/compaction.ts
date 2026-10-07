import crypto from "crypto"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { emptyToolSet } from "./prompt/tools"
import { Truncate } from "../tool/truncation"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@killstata/util/fn"
import { Agent } from "@/agent/agent"
import { Todo } from "./todo"
import { Question } from "@/question"
import { PermissionNext } from "@/permission/next"
import { RuntimeEvents } from "@/runtime/events"
import { RuntimeHooks } from "@/runtime/hooks"
import { workflowStatusSummary, workflowTaskLedger } from "@/runtime/workflow"
import { ContextManager } from "@/runtime/context-manager"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { buildContextCapsule } from "@/runtime/context-capsule-adapter"
import { renderContextCapsule } from "@/runtime/context-capsule"
import { FailurePolicy } from "@/runtime/failure-policy"
import { summarizeToolError } from "@/runtime/tool-result-policy"
import { ToolResultProjection } from "@/runtime/tool-result-projection"
import {
  estimateContextMessages,
  isMicrocompactableToolResult,
  microcompactToolResults,
} from "./context-projection"
import type { CompactionLifecycle, CompactionSnapshot, RuntimeFailureDecision } from "@/runtime/types"
import PROMPT_COMPACTION from "@/agent/prompt/compaction.txt"
import { SystemPrompt } from "./system"
import { ContextLedger } from "@/runtime/services/context-ledger"
import { sanitizeAnalysisAssistantText } from "@/runtime/analysis-text-sanitizer"
import { workflowStageLabel } from "@/runtime/workflow-locale"

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function clip(value: string, max = 240) {
  const normalized = compactWhitespace(value)
  if (normalized.length <= max) return normalized
  return normalized.slice(0, max - 3).trimEnd() + "..."
}

function safeModelContextEntries(values: string[], max = 140) {
  return values
    .map((value) => sanitizeAnalysisAssistantText({ text: value, tools: [] }).text.trim())
    .map((value) => clip(value, max))
    .filter(Boolean)
}

function pushUnique(target: string[], seen: Set<string>, value: string | undefined, max = 5) {
  if (!value || target.length >= max) return
  const normalized = clip(value)
  if (!normalized || seen.has(normalized)) return
  seen.add(normalized)
  target.push(normalized)
}

function escapePromptXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  export const CreateInput = z
    .object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
      reason: z.enum(["manual", "threshold", "overflow"]).optional(),
      instructions: z.string().trim().min(1).max(4_000).optional(),
    })
    .superRefine((input, ctx) => {
      if (input.auto && input.instructions) {
        ctx.addIssue({
          code: "custom",
          path: ["instructions"],
          message: "自动压缩不接受用户自定义指令。",
        })
      }
      if (input.auto && input.reason === "manual") {
        ctx.addIssue({ code: "custom", path: ["reason"], message: "自动压缩不能使用 manual 原因。" })
      }
      if (!input.auto && input.reason && input.reason !== "manual") {
        ctx.addIssue({ code: "custom", path: ["reason"], message: "手动压缩只能使用 manual 原因。" })
      }
    })

  export function buildPrompt(input: {
    auto: boolean
    customInstructions?: string
  }) {
    const request = [
      `<compaction-request trigger="${input.auto ? "automatic" : "manual"}">`,
      input.auto
        ? "这是自动压缩。禁止新增待确认问题；摘要必须支持下一轮直接继续当前工作。"
        : "这是用户主动发起的手动压缩。可以保留确实尚未解决、需要用户决定的问题。",
      !input.auto && input.customInstructions
        ? `<custom-instructions>\n${escapePromptXml(input.customInstructions)}\n</custom-instructions>`
        : undefined,
      "请严格遵守 system 中的九段 XML 摘要协议。不得调用工具。",
      "</compaction-request>",
    ]
    // 动态关注指令放在前面，静态提示词的第二次禁用工具警告始终位于请求末尾。
    return [request.filter(Boolean).join("\n"), PROMPT_COMPACTION].join("\n\n")
  }

  export function parseSummary(raw: string):
    | { ok: true; summary: string }
    | { ok: false; error: string } {
    const match = raw.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)
    const summary = match?.[1]?.trim()
    if (!summary) {
      return {
        ok: false,
        error: "摘要响应缺少完整的 <summary>...</summary> 块。",
      }
    }
    const chapters = [
      "主要请求和意图",
      "关键技术与计量概念",
      "文件、数据与代码位置",
      "错误、根因与修复",
      "问题解决过程",
      "所有真实用户消息",
      "待完成任务",
      "当前工作",
      "可选下一步",
    ]
    const missing = chapters.flatMap((title, index) => {
      const pattern = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?${index + 1}\\.\\s*${title}`, "m")
      return pattern.test(summary) ? [] : [index + 1]
    })
    if (missing.length > 0) {
      return {
        ok: false,
        error: `摘要响应缺少固定章节：${missing.join("、")}。`,
      }
    }
    return { ok: true, summary }
  }

  export function continuationSummary(summary: string, auto: boolean) {
    const lines = [
      "本会话从一次上下文压缩后继续。以下摘要覆盖压缩前的有效对话；这不是新任务。",
      "",
      summary.trim(),
    ]
    if (auto) {
      lines.push(
        "",
        "直接继续压缩前正在进行的任务：不要向用户提出新的问题，不要复述摘要，也不要添加任何继续声明或过渡开场。",
      )
    }
    return lines.join("\n")
  }

  export function boundaryMetadata(input: {
    messages: MessageV2.WithParts[]
    parentID: string
    auto: boolean
    reason: CompactionLifecycle["reason"]
    customInstructions?: string
  }) {
    return {
      reason: input.reason,
      customInstructions: input.auto ? undefined : input.customInstructions,
      preCompactTokens: estimateContextMessages(input.messages),
      lastMessageID: input.messages
        .filter((message) => message.info.id !== input.parentID)
        .at(-1)?.info.id,
    }
  }
  /**
   * 缓存断裂检测：上一轮有 prompt cache 命中，这一轮却掉到 0（且输入规模没变小）。
   *
   * 说明缓存前缀被破坏了——通常是系统提示/工具描述/早期消息被改动，导致整个前缀
   * 重新计费。这在长会话里是隐性的成本放大器（每轮全价重算输入），但不会报错，
   * 只能靠 cached_tokens 的变化发现。返回 true 时调用方应记日志/告警，不改变执行流程。
   *
   * 依赖 provider 上报 cachedInputTokens（OpenAI 兼容 API 的
   * prompt_tokens_details.cached_tokens）。不上报的 provider 恒为 0，
   * 此时 previous 也是 0，不会误报。
   */
  export function detectCacheBreak(input: {
    previous: MessageV2.Assistant["tokens"] | undefined
    current: MessageV2.Assistant["tokens"]
  }): boolean {
    const previous = input.previous
    if (!previous) return false
    // 上一轮压根没命中缓存 → 没有"断裂"可言（可能是 provider 不支持）。
    if (previous.cache.read <= 0) return false
    if (input.current.cache.read > 0) return false
    // 输入变小可能只是历史被压缩/裁剪了，不算前缀被破坏。
    const previousInput = previous.input + previous.cache.read
    const currentInput = input.current.input + input.current.cache.read
    return currentInput >= previousInput
  }

  export function compactionOperationId(sessionID: string, parentID: string) {
    return `cmp_${sessionID}_${parentID}_prt_${crypto.createHash("sha1").update(`${sessionID}:${parentID}`).digest("hex").slice(0, 12)}`
  }

  export function compactionLifecycle(input: {
    operationId: string
    sessionID: string
    parentID: string
    reason: CompactionLifecycle["reason"]
    status: CompactionLifecycle["status"]
    inputMessageCount: number
    inputHistoryVersion?: number
    summarySource?: CompactionLifecycle["summarySource"]
    errorCode?: string
    errorMessage?: string
    createdAt: string
    updatedAt?: string
  }): CompactionLifecycle {
    return {
      ...input,
      inputMessageCount: Math.max(0, input.inputMessageCount),
      updatedAt: input.updatedAt ?? input.createdAt,
    }
  }

  export function compactionFailureCode(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return "COMPACTION_ABORTED"
    return "COMPACTION_FAILED"
  }

  // 直接本地生成 fallback summary；熔断阈值统一由 FailurePolicy 管理，避免压缩与模型请求各写一套。

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

  export function buildUserMessageLedger(messages: MessageV2.WithParts[]) {
    return ContextLedger.buildUserMessages(messages).content
  }

  export function buildFallbackSummary(input: { messages: MessageV2.WithParts[]; error?: string }) {
    const priorSummaries: string[] = []
    const priorSummarySeen = new Set<string>()
    const recentRequests: string[] = []
    const requestSeen = new Set<string>()
    const assistantUpdates: string[] = []
    const updateSeen = new Set<string>()
    const toolUpdates: string[] = []
    const toolSeen = new Set<string>()
    const files = new Set<string>()

    for (const msg of input.messages) {
      if (msg.info.role !== "user") continue
      for (const part of msg.parts) {
        if (part.type === "text" && !part.ignored && !part.synthetic) {
          pushUnique(recentRequests, requestSeen, part.text, 200)
        }
      }
    }

    for (const msg of input.messages) {
      if (msg.info.role === "assistant" && msg.info.summary) {
        for (const part of msg.parts) {
          if (part.type === "text") pushUnique(priorSummaries, priorSummarySeen, part.text, 2)
        }
      }
    }

    for (const msg of input.messages.slice(-12)) {
      if (msg.info.role === "user") {
        for (const part of msg.parts) {
          if (part.type === "file") {
            const fileName = clip(part.filename || part.url.split("/").pop() || "")
            if (fileName) files.add(fileName)
          }
        }
        continue
      }

      if (msg.info.role !== "assistant" || msg.info.summary) continue

      for (const part of msg.parts) {
        if (part.type === "text") {
          pushUnique(assistantUpdates, updateSeen, part.text)
          continue
        }
        if (part.type !== "tool") continue

        if (part.state.status === "completed") {
          const detail = completedToolModelOutput(part)
          pushUnique(toolUpdates, toolSeen, `${part.tool}: ${detail}`)
          continue
        }
        if (part.state.status === "error") {
          pushUnique(toolUpdates, toolSeen, `${part.tool} 失败：${part.state.error}`)
        }
      }
    }

    const lines = [
      "# 会话摘要",
      "",
      "模型压缩未完成，以下内容由本地可恢复状态生成。",
      input.error ? `压缩错误：${clip(input.error, 180)}` : "",
      "",
    ].filter(Boolean)

    if (priorSummaries.length > 0) {
      lines.push("## 先前摘要")
      for (const item of priorSummaries) lines.push(`- ${item}`)
      lines.push("")
    }

    lines.push("## 已完成内容")
    if (assistantUpdates.length > 0 || toolUpdates.length > 0) {
      for (const item of [...assistantUpdates, ...toolUpdates].slice(0, 6)) lines.push(`- ${item}`)
    } else {
      lines.push("- 无法从失败的压缩轮次恢复最近进度，后续不得猜测已完成状态。")
    }
    lines.push("")

    lines.push("## 所有真实用户消息")
    if (recentRequests.length > 0) {
      for (const item of recentRequests) lines.push(`- ${item}`)
    } else {
      lines.push("- 从会话中最近可见的用户请求继续。")
    }
    lines.push("")

    lines.push("## 相关文件")
    if (files.size > 0) {
      for (const item of Array.from(files).slice(0, 8)) lines.push(`- ${item}`)
    } else {
      lines.push("- 最近消息中没有捕获到明确文件附件。")
    }
    lines.push("")

    lines.push("## 下一步")
    if (recentRequests.length > 0) {
      lines.push("- 优先继续最近的用户请求。")
    }
    if (toolUpdates.some((item) => item.includes("失败："))) {
      lines.push("- 继续前先重新核对最近失败阶段及其错误。")
    }
    lines.push("- 以会话中最近可见的助手消息和工具输出为事实来源。")

    return lines.join("\n")
  }

  async function recordCompactionLifecycle(input: {
    lifecycle: CompactionLifecycle
    taskId?: string
    failureDecision?: RuntimeFailureDecision
  }) {
    RuntimeTaskLedger.appendEventBestEffort({
      sessionID: input.lifecycle.sessionID,
      taskId: input.taskId,
      kind: "compaction",
      compaction: input.lifecycle,
      failureDecision: input.failureDecision,
      message: `compaction ${input.lifecycle.status}`,
      metadata: {
        operationId: input.lifecycle.operationId,
        reason: input.lifecycle.reason,
        status: input.lifecycle.status,
      },
    })
  }

  export function prepareSummaryInput(messages: MessageV2.WithParts[]) {
    const history = messages.filter(
      (message) => !message.parts.some((part) => part.type === "compaction"),
    )
    const microcompacted = microcompactToolResults(history, {
      reason: "pressure",
      keepRecent: 1,
      minimumOutputTokens: 0,
    })
    const projected = structuredClone(microcompacted.messages) as MessageV2.WithParts[]
    for (const message of projected) {
      for (const part of message.parts) {
        if (part.type !== "tool" || part.state.status !== "completed") continue
        if (!isMicrocompactableToolResult(part)) continue
        const reference = completedToolReference(part)
        if (reference) {
          part.state.modelOutput = `[大型工具结果位于 ${reference}；使用 read 的 offset/limit 分段恢复。]`
          continue
        }
      }
    }
    return projected
  }

  async function snapshotState(input: {
    sessionID: string
    messages: MessageV2.WithParts[]
  }): Promise<CompactionSnapshot> {
    const latestGoal = input.messages
      .flatMap((message) =>
        message.info.role === "user"
          ? message.parts.filter(
              (part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored,
            )
          : [],
      )
      .map((part) => clip(part.text, 180))
      .at(-1)

    const [todoItems, questionRequests, permissionRequests] = await Promise.all([
      Todo.get(input.sessionID),
      Question.list(),
      PermissionNext.list(),
    ])

    const activeTodos = todoItems
      .filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
      .map((todo) => clip(todo.content, 140))

    const unresolvedQuestions = questionRequests
      .filter((request) => request.sessionID === input.sessionID)
      .flatMap((request) => request.questions.map((question) => clip(question.question, 140)))

    const trustedArtifactPaths = Array.from(new Set(input.messages
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" &&
          part.state.status === "completed" &&
          part.state.metadata &&
          Array.isArray(part.state.metadata["trustedArtifactPaths"])
            ? (part.state.metadata["trustedArtifactPaths"] as string[])
            : [],
        ),
      )))

    const childSessionSummaries = Array.from(new Set(input.messages
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" &&
          part.tool === "task" &&
          part.state.status === "completed" &&
          typeof part.state.metadata?.["contract"] === "object" &&
          part.state.metadata["contract"] &&
          typeof (part.state.metadata["contract"] as Record<string, unknown>)["summary"] === "string"
            ? [clip((part.state.metadata["contract"] as Record<string, unknown>)["summary"] as string, 140)]
            : [],
        ),
      )))

    const numericGroundingState = input.messages
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" && typeof part.metadata?.["numericGroundingStatus"] === "string"
            ? [part.metadata["numericGroundingStatus"] as string]
            : [],
        ),
      )

    // 必须用 PermissionNext：所有真实的审批请求都走它。旧的 Permission 模块从来没人
    // 调用过 ask()，pending 永远是空的，导致「未决审批」这一段上下文一直是空的。
    const pendingPermissions = permissionRequests
      .filter((permission) => permission.sessionID === input.sessionID)
      .map((permission) => clip(`${permission.permission} 待批准`, 140))

    const workflow = workflowStatusSummary(input.sessionID)
    const ledger = workflowTaskLedger(input.sessionID)
    const activeTask = ledger.activeTaskId
      ? ledger.tasks.find((task) => task.taskId === ledger.activeTaskId)
      : undefined
    const latestContextSnapshot = ContextManager.snapshot({
      sessionID: input.sessionID,
      text: input.messages
        .slice(-8)
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      capsule: buildContextCapsule(input.sessionID),
    })
    ContextManager.publish(latestContextSnapshot)

    return {
      latestGoal,
      activeTodos,
      unresolvedQuestions: [...unresolvedQuestions, ...pendingPermissions],
      trustedArtifactPaths,
      childSessionSummaries,
      numericGroundingState,
      activeTaskId: ledger.activeTaskId,
      latestCheckpointId: activeTask?.latestCheckpointId,
      activeStageId: workflow.activeStage?.stageId,
      activeStageKind: workflow.activeStage?.kind,
      latestFailureCode: workflow.workflow?.latestFailure?.code,
      latestVerifierStatus: workflow.workflow?.latestVerifier?.status,
      inputGraphRefs: activeTask?.inputGraph
        .map((node) => node.ref ?? node.label ?? node.id)
        .filter(Boolean),
      latestContextSnapshot,
    }
  }

  export async function progressiveContext(input: { sessionID: string; messages: MessageV2.WithParts[] }) {
    Bus.publish(RuntimeEvents.Compaction, {
      sessionID: input.sessionID,
      phase: "snapshot",
      details: {},
    })
    const snapshot = await snapshotState(input)
    const safeTodos = safeModelContextEntries(snapshot.activeTodos)
    const safeQuestions = safeModelContextEntries(snapshot.unresolvedQuestions)
    const safeChildSummaries = safeModelContextEntries(snapshot.childSessionSummaries)
    const safeNumericGrounding = safeModelContextEntries(snapshot.numericGroundingState)
    await RuntimeHooks.compaction({
      sessionID: input.sessionID,
      phase: "snapshot",
      metadata: snapshot as unknown as Record<string, unknown>,
    })

    const summaryLines = [
      snapshot.latestGoal ? `最新目标：${snapshot.latestGoal}` : undefined,
      safeTodos.length ? `进行中的任务：${safeTodos.join(" | ")}` : undefined,
      safeQuestions.length
        ? `未决问题：${safeQuestions.join(" | ")}`
        : undefined,
      snapshot.trustedArtifactPaths.length
        ? `可信结果产物：已登记 ${snapshot.trustedArtifactPaths.length} 项，可通过产物查询工具读取。`
        : undefined,
      safeChildSummaries.length
        ? `子 Agent 输出：${safeChildSummaries.join(" | ")}`
        : undefined,
      safeNumericGrounding.length
        ? `数字接地状态：${safeNumericGrounding.join(" | ")}`
        : undefined,
      snapshot.latestContextSnapshot
        ? `上下文快照：v${snapshot.latestContextSnapshot.historyVersion}；活跃阶段类型=${workflowStageLabel("zh-CN", snapshot.activeStageKind ?? snapshot.latestContextSnapshot.capsule?.workflow.activeStageKind) ?? "未知"}`
        : undefined,
      snapshot.inputGraphRefs?.length
        ? `已保留 ${snapshot.inputGraphRefs.length} 项本轮输入引用，由 Harness 管理。`
        : undefined,
    ].filter(Boolean)
    const references = recoveryReferences(input.messages)
    if (references.length > 0) summaryLines.push(`可恢复证据：${references.join(", ")}`)

    return {
      messages: input.messages,
      system: summaryLines.length ? ["<runtime-context>", ...summaryLines, "</runtime-context>"] : [],
      snapshot,
    }
  }

  /** 收集仍可通过 Read 恢复的全部工具输出引用；轻量读时投影才使用有界引用。 */
  export function recoveryReferences(messages: MessageV2.WithParts[]) {
    return Array.from(
      new Set(
        messages.flatMap((message) =>
          message.parts.flatMap((part) => {
            if (part.type !== "tool" || part.state.status !== "completed") return []
            const reference = completedToolReference(part)
            return reference ? [reference] : []
          }),
        ),
      ),
    )
  }

  /**
   * 全量摘要之后恢复的是可验证状态，不是原始工作簿或整段旧日志。
   * ContextCapsule/ledger 是事实来源；聊天摘要只负责补充用户目标和未决问题。
   */
  export function buildRestorationPayload(input: {
    snapshot: CompactionSnapshot
    messages: MessageV2.WithParts[]
    userMessageLedgerReference?: string
    userMessageCount?: number
  }) {
    const references = recoveryReferences(input.messages)
    const referenceContext = input.snapshot.latestContextSnapshot?.referenceContext
    const capsule = input.snapshot.latestContextSnapshot?.capsule
    const safeTodos = safeModelContextEntries(input.snapshot.activeTodos)
    const safeQuestions = safeModelContextEntries(input.snapshot.unresolvedQuestions)
    const safeChildSummaries = safeModelContextEntries(input.snapshot.childSessionSummaries)
    const safeNumericGrounding = safeModelContextEntries(input.snapshot.numericGroundingState)
    const text = [
      "[上下文压缩恢复状态]",
      input.snapshot.latestGoal ? `最近目标：${input.snapshot.latestGoal}` : undefined,
      safeTodos.length ? `当前待办：${safeTodos.join(" | ")}` : undefined,
      input.snapshot.activeTaskId ? "活动任务：存在一个未完成任务" : undefined,
      input.snapshot.latestCheckpointId ? "已保存可恢复断点" : undefined,
      (input.snapshot.activeStageKind ?? capsule?.workflow.activeStageKind)
        ? `活跃阶段类型：${workflowStageLabel("zh-CN", input.snapshot.activeStageKind ?? capsule?.workflow.activeStageKind) ?? "未知"}`
        : input.snapshot.activeStageId ? "活跃阶段状态已保存" : undefined,
      input.snapshot.latestFailureCode ? `最新失败：${input.snapshot.latestFailureCode}` : undefined,
      input.snapshot.latestVerifierStatus ? `verifier：${input.snapshot.latestVerifierStatus}` : undefined,
      safeQuestions.length ? `未决问题：${safeQuestions.join(" | ")}` : undefined,
      input.snapshot.trustedArtifactPaths.length ? `已登记 ${input.snapshot.trustedArtifactPaths.length} 个可信产物，可通过查询工具读取。` : undefined,
      safeNumericGrounding.length ? `数字接地状态：${safeNumericGrounding.join(" | ")}` : undefined,
      safeChildSummaries.length ? `子 Agent：${safeChildSummaries.join(" | ")}` : undefined,
      input.snapshot.inputGraphRefs?.length ? `已保留 ${input.snapshot.inputGraphRefs.length} 项输入引用，由 Harness 管理。` : undefined,
      referenceContext?.activeWorkflowRunId ? "工作流状态已恢复。" : undefined,
      referenceContext?.trustedArtifacts.length ? `状态快照包含 ${referenceContext.trustedArtifacts.length} 个可信产物。` : undefined,
      capsule ? renderContextCapsule(capsule) : undefined,
      input.userMessageLedgerReference
        ? `本会话的 ${input.userMessageCount ?? 0} 条用户消息账本已保存，Harness 按原顺序保留。`
        : undefined,
      references.length ? `可恢复工具结果：${references.join(", ")}` : undefined,
    ].filter(Boolean).join("\n")
    return {
      references,
      text,
      userMessageLedgerReference: input.userMessageLedgerReference,
    }
  }

  async function persistRestorePart(input: {
    message: MessageV2.Assistant
    sessionID: string
    snapshot: CompactionSnapshot
    messages: MessageV2.WithParts[]
    summarySource: "model" | "fallback"
    userMessageLedger: {
      reference: string
      messageCount: number
    }
  }) {
    const { references, text } = buildRestorationPayload({
      ...input,
      userMessageLedgerReference: input.userMessageLedger.reference,
      userMessageCount: input.userMessageLedger.messageCount,
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: input.message.id,
      sessionID: input.sessionID,
      type: "compaction-restore",
      summarySource: input.summarySource,
      text,
      recoveryReferences: references,
      userMessageLedgerReference: input.userMessageLedger.reference,
      userMessageCount: input.userMessageLedger.messageCount,
    } satisfies MessageV2.CompactionRestorePart)
    return { references, text }
  }

  async function persistModelSummary(input: {
    message: MessageV2.Assistant
    sessionID: string
    auto: boolean
  }) {
    const existing = await MessageV2.parts(input.message.id)
    const raw = existing
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const parsed = parseSummary(raw)
    if (!parsed.ok) return parsed

    for (const part of existing) {
      await Session.removePart({
        sessionID: input.sessionID,
        messageID: input.message.id,
        partID: part.id,
      })
    }
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: input.message.id,
      sessionID: input.sessionID,
      type: "text",
      text: continuationSummary(parsed.summary, input.auto),
      time: {
        start: Date.now(),
        end: Date.now(),
      },
      metadata: {
        compactionSummary: true,
        suppressFollowUpQuestions: input.auto,
      },
    })
    input.message.finish = "stop"
    input.message.time.completed = Date.now()
    await Session.updateMessage(input.message)
    return parsed
  }

  async function persistAutoContinuation(input: {
    sessionID: string
    userMessage: MessageV2.User
    text: string
  }) {
    let analysisContinuation = ""
    try {
      const ledger = RuntimeTaskLedger.listTasks(input.sessionID)
      const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
      const request = task?.analysisRequest
      if (task && request) {
        const requiredMethods = Array.isArray(task.metadata?.requiredToolIDs)
          ? task.metadata.requiredToolIDs.filter((id): id is string => typeof id === "string").join(",")
          : ""
        const confirmedMethods = Array.isArray(task.metadata?.confirmedToolIDs)
          ? task.metadata.confirmedToolIDs.filter((id): id is string => typeof id === "string").join(",")
          : ""
        analysisContinuation = [
          "<killstata-analysis-continuation>",
          "以下是 Harness 从活动任务账本恢复的状态，不是用户的新指令；继续使用原 AnalysisRequest，不要重新登记。",
          `requestId=${request.requestId}`,
          `requestKind=${request.kind}`,
          `sourceUserMessageId=${request.sourceMessageId}`,
          `analysisStatus=${task.analysisLifecycle?.status ?? "unavailable"}`,
          `currentMethodID=${task.analysisLifecycle?.methodID ?? task.preparedSpec?.methodID ?? "none"}`,
          `preparedSpecId=${task.preparedSpec?.specId ?? "none"}`,
          `requiredToolIDs=${requiredMethods || "none"}`,
          `confirmedToolIDs=${confirmedMethods || "none"}`,
          "inspect 请求只能报告方法预检，不得运行估计；estimate 请求仍须满足已确认的方法、当前数据阶段和有效 PreparedSpec。",
          "</killstata-analysis-continuation>",
        ].join("\n")
      }
    } catch {
      // The durable summary remains usable if the task ledger is unavailable; the next turn must not invent IDs.
    }
    const continueMsg = await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: { created: Date.now() },
      agent: input.userMessage.agent,
      model: input.userMessage.model,
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: continueMsg.id,
      sessionID: input.sessionID,
      type: "text",
      synthetic: true,
      text: [input.text, analysisContinuation].filter(Boolean).join("\n\n"),
      time: { start: Date.now(), end: Date.now() },
    })
  }

  async function persistFallbackSummary(input: {
    message: MessageV2.Assistant
    sessionID: string
    messages: MessageV2.WithParts[]
    circuitDecision?: RuntimeFailureDecision
    error?: string
  }) {
    const existing = await MessageV2.parts(input.message.id)
    for (const part of existing) {
      await Session.removePart({
        sessionID: input.sessionID,
        messageID: input.message.id,
        partID: part.id,
      })
    }

    const errorMessage = input.error ?? (
      input.message.error && "data" in input.message.error && typeof input.message.error.data?.message === "string"
        ? input.message.error.data.message
        : undefined
    )

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: input.message.id,
      sessionID: input.sessionID,
      type: "text",
      text: [
        input.circuitDecision ? `> 系统警告：${input.circuitDecision.userVisibleMessage}` : undefined,
        buildFallbackSummary({
          messages: input.messages,
          error: errorMessage,
        }),
      ].filter(Boolean).join("\n\n"),
      time: {
        start: Date.now(),
        end: Date.now(),
      },
      metadata: {
        compactionFallback: true,
        compactionCircuitOpen: input.circuitDecision !== undefined,
        failureDecision: input.circuitDecision,
        originalError: errorMessage,
      },
    })

    delete input.message.error
    input.message.finish = "fallback"
    input.message.time.completed = Date.now()
    await Session.updateMessage(input.message)
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
    reason?: CompactionLifecycle["reason"]
    customInstructions?: string
  }) {
    const boundaryMessage = input.messages.findLast((message) => message.info.id === input.parentID)
    if (!boundaryMessage || boundaryMessage.info.role !== "user") {
      throw new Error("压缩边界对应的用户消息不存在。")
    }
    const userMessage = boundaryMessage.info as MessageV2.User
    const boundaryPart = boundaryMessage.parts.find(
      (part): part is MessageV2.CompactionPart => part.type === "compaction",
    )
    const reason: CompactionLifecycle["reason"] =
      input.reason ?? boundaryPart?.reason ?? (input.auto ? "threshold" : "manual")
    const customInstructions = input.auto
      ? undefined
      : input.customInstructions ?? boundaryPart?.customInstructions
    const boundary = boundaryMetadata({
      messages: input.messages,
      parentID: input.parentID,
      auto: input.auto,
      reason,
      customInstructions,
    })
    if (boundaryPart) {
      await Session.updatePart({
        ...boundaryPart,
        ...boundary,
      })
    }
    const operationId = compactionOperationId(input.sessionID, input.parentID)
    const createdAt = new Date().toISOString()
    const started = compactionLifecycle({
      operationId,
      sessionID: input.sessionID,
      parentID: input.parentID,
      reason,
      status: "started",
      inputMessageCount: input.messages.length,
      inputHistoryVersion: input.messages.length,
      createdAt,
    })
    await recordCompactionLifecycle({ lifecycle: started })
    let summarySource: CompactionLifecycle["summarySource"]
    try {
      input.abort.throwIfAborted()
    const fullSessionMessages = await Session.messages({ sessionID: input.sessionID })
    const userMessageLedger = await ContextLedger.persistUserMessages({
      sessionID: input.sessionID,
      messages: fullSessionMessages,
    })
    const agent = await Agent.get(userMessage.agent)
    // 摘要质量直接决定下一轮能否续接，始终复用当前会话的同一个模型。
    const model = await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant

    // 熔断：连续多次压缩失败说明压缩模型/上下文持续不可用，再调 model 只是重复烧 token。
    // 直接本地生成 fallback summary（buildFallbackSummary 是纯本地遍历，零 API 调用）。
    const consecutiveFallbacks = input.auto
      ? RuntimeTaskLedger.consecutiveCompactionFallbacks(input.sessionID)
      : 0
    const circuitDecision = input.auto
      ? FailurePolicy.classifyCompaction(consecutiveFallbacks)
      : undefined
    if (circuitDecision) {
      log.warn("compaction repeatedly failed; skipping model call, using local fallback summary", {
        sessionID: input.sessionID,
        consecutiveFallbacks,
      })
      await persistFallbackSummary({
        message: msg,
        sessionID: input.sessionID,
        messages: input.messages,
        circuitDecision,
      })
      summarySource = "fallback"
      await persistRestorePart({
        message: msg,
        sessionID: input.sessionID,
        snapshot: await snapshotState({ sessionID: input.sessionID, messages: input.messages }),
        messages: input.messages,
        summarySource,
        userMessageLedger,
      })
      await recordCompactionLifecycle({
        lifecycle: compactionLifecycle({
          ...started,
          status: "completed",
          summarySource,
          updatedAt: new Date().toISOString(),
        }),
        failureDecision: circuitDecision,
      })
      if (input.auto) {
        await persistAutoContinuation({
          sessionID: input.sessionID,
          userMessage,
          text: `${circuitDecision.userVisibleMessage}\n从当前 checkpoint 直接继续；不要提问或复述摘要。`,
        })
      }
      Bus.publish(Event.Compacted, { sessionID: input.sessionID })
      return "continue"
    }

    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    const promptText = buildPrompt({
      auto: input.auto,
      customInstructions,
    })
    const [system, customSystem] = await Promise.all([
      SystemPrompt.environment({ sessionID: input.sessionID, messages: input.messages }),
      SystemPrompt.custom(),
    ])
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: emptyToolSet(),
      system,
      customSystem,
      messages: [
        ...MessageV2.toModelMessages(prepareSummaryInput(input.messages), model),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
      requestSource: "background",
      contextPolicy: "compaction",
    })

    const modelFailure = processor.message.error
      ? (
          "data" in processor.message.error && typeof processor.message.error.data?.message === "string"
            ? processor.message.error.data.message
            : String(processor.message.error)
        )
      : result === "compact"
        ? "压缩请求自身仍超过输入预算；递归压缩已被阻止。"
        : typeof result === "object"
          ? "压缩摘要器返回了工具修复请求；摘要模式禁止工具调用。"
          : undefined
    const parsed = modelFailure
      ? { ok: false as const, error: modelFailure }
      : await persistModelSummary({
          message: processor.message,
          sessionID: input.sessionID,
          auto: input.auto,
        })
    if (!parsed.ok) {
      log.warn("compaction failed; using local fallback summary", {
        sessionID: input.sessionID,
        messageID: processor.message.id,
        error: parsed.error,
      })
      await persistFallbackSummary({
        message: processor.message,
        sessionID: input.sessionID,
        messages: input.messages,
        error: parsed.error,
      })
      summarySource = "fallback"
      const snapshot = await snapshotState({ sessionID: input.sessionID, messages: input.messages })
      await persistRestorePart({
        message: processor.message,
        sessionID: input.sessionID,
        snapshot,
        messages: input.messages,
        summarySource,
        userMessageLedger,
      })
      if (input.auto) {
        await persistAutoContinuation({
          sessionID: input.sessionID,
          userMessage,
          text: "模型压缩未完成，已改用本地摘要并保留任务进度。从当前 checkpoint 直接继续；不要提问或复述摘要。",
        })
      }
      await recordCompactionLifecycle({
        lifecycle: compactionLifecycle({
          ...started,
          status: "completed",
          summarySource,
          updatedAt: new Date().toISOString(),
        }),
      })
      Bus.publish(Event.Compacted, { sessionID: input.sessionID })
      return "continue"
    }

    // 走到这里说明 XML 摘要已经解析并重写成功；analysis 草稿不会进入后续上下文。
    summarySource = "model"
    const snapshot = await snapshotState({ sessionID: input.sessionID, messages: input.messages })
    await persistRestorePart({
      message: processor.message,
      sessionID: input.sessionID,
      snapshot,
      messages: input.messages,
      summarySource,
      userMessageLedger,
    })
    if (input.auto) {
      await persistAutoContinuation({
        sessionID: input.sessionID,
        userMessage,
        text: "直接继续压缩前正在进行的任务；不要提问、不要复述摘要、不要添加开场白。",
      })
    }
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    await recordCompactionLifecycle({
      lifecycle: compactionLifecycle({
        ...started,
        status: "completed",
        summarySource,
        updatedAt: new Date().toISOString(),
      }),
    })
    return "continue"
    } catch (error) {
      const cancelled = input.abort.aborted || (error instanceof DOMException && error.name === "AbortError")
      const lifecycle = compactionLifecycle({
        ...started,
        status: cancelled ? "cancelled" : "failed",
        errorCode: compactionFailureCode(error),
        errorMessage: clip(summarizeToolError(error), 180),
        updatedAt: new Date().toISOString(),
      })
      await recordCompactionLifecycle({ lifecycle })
      if (cancelled) return "stop"
      throw error
    }
  }

  export const create = fn(
    CreateInput,
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        reason: input.reason ?? (input.auto ? "threshold" : "manual"),
        customInstructions: input.instructions,
      })
    },
  )
}
