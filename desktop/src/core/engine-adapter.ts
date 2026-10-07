import type { Event, Part, PermissionRequest, QuestionRequest } from "@killstata/sdk/v2/client"
import type { EngineClient, EngineCommand, EngineDataset, EngineHealth, EngineRun, EngineRunEvent, EngineRunRequest, EngineRunResult, EngineVerificationUpdate } from "../engine/client"
import { toolProgressLabel, toolProgressMessage, toolProgressStatus } from "./tool-progress"
import type { CoreSessionClient } from "./client"

/** EngineInteraction 及其关联类型：从已移除的 engine/contract.ts 内联，保持 Desktop UI 端口兼容 */
interface EngineInteractionQuestion {
  requestId: string
  title: string
  prompt: string
  mode: "single" | "multi" | "text"
  options: Array<{ id: string; label: string; description?: string }>
  allowSkip: boolean
}
interface EngineInteractionPermission {
  requestId: string
  title: string
  action: string
  scope: string
}
type EngineInteraction =
  | { kind: "question"; question: EngineInteractionQuestion }
  | { kind: "permission"; permission: EngineInteractionPermission }
interface EngineInteractionAnswer {
  allowed?: boolean
  selected?: string[]
  text?: string
}

function fileMime(file: File) {
  if (file.type) return file.type
  const extension = file.name.toLowerCase().split(".").pop()
  if (extension === "csv") return "text/csv"
  if (extension === "xls") return "application/vnd.ms-excel"
  if (extension === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  if (extension === "dta") return "application/x-stata"
  return "application/octet-stream"
}

async function fileDataURL(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${fileMime(file)};base64,${btoa(binary)}`
}

/**
 * 流式正文 / 思考过程 / 工具步骤转发开关。
 *
 * 曾因 `tauri dev` 的文件监听把 Core TraceLogger 写的 `src-tauri/test/sandbox/logs/*.jsonl`
 * 当成源码改动、触发 cargo 重建导致"发送即重启"而被关闭；根因已由 `src-tauri/.taurignore`
 * 忽略 `test/` 修复（已实测：写入该目录不再触发 Rebuilding）。
 */
const STREAMING_PARTS_ENABLED = true

const REASONING_INTERNAL_MARKERS = [
  "<file>",
  "Called the Read tool with the following input:",
  "You are a fresh-run verifier for killstata.",
  "你是 KillStata 的独立核验 Agent。",
  "<dataset-record>",
  "datasetId=",
  "stageId=",
]

/** 精简移植 Core 的 containsEngineInternalData：过滤混入思考流的引擎内部数据，避免用户看到乱码。 */
function reasoningHasInternalData(text: string) {
  return (
    REASONING_INTERNAL_MARKERS.some((marker) => text.includes(marker)) ||
    /\b(?:datasetId|stageId|workflowRunId|sessionID|checkpointId)\b/i.test(text) ||
    text.includes(".killstata/") ||
    /<[|｜]+\s*DSML\s*[|｜]+/i.test(text) ||
    /<\/?verifier_result>/i.test(text)
  )
}

function cleanReasoning(text: string) {
  const trimmed = text.replace(/\[REDACTED\]/g, "").trim()
  return reasoningHasInternalData(trimmed) ? "" : trimmed
}

function visibleAssistantText(parts: Part[]) {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join("\n\n")
    .trim()
}

function isInternalCompactionSummary(info: { role: string; summary?: unknown; mode?: string }) {
  return info.role === "assistant" && (info.summary === true || info.mode === "compaction")
}

function questionInteraction(request: QuestionRequest): Extract<EngineInteraction, { kind: "question" }> {
  const first = request.questions[0]
  if (!first) throw new Error("Core question request 没有问题内容")
  const options = first.options.map((option, index) => ({
    id: String(index),
    label: option.label,
    description: option.description,
  }))
  return {
    kind: "question",
    question: {
      requestId: request.id,
      title: first.header,
      prompt: first.question,
      mode: first.multiple ? "multi" : first.custom ? "text" : "single",
      options,
      allowSkip: false,
    },
  }
}

function permissionInteraction(request: PermissionRequest): Extract<EngineInteraction, { kind: "permission" }> {
  return {
    kind: "permission",
    permission: {
      requestId: request.id,
      title: "分析需要授权",
      action: request.permission,
      scope: request.patterns.join(", "),
    },
  }
}

function engineCommand(command: { name: string; description?: string; hints?: string[]; advanced?: boolean; blockedReason?: string; availability?: string[]; queueBehavior?: "queued" | "immediate" }): EngineCommand {
  return {
    name: command.name.replace(/^\/+/, ""),
    description: command.description ?? "执行此命令",
    hints: command.hints,
    advanced: command.advanced,
    blockedReason: command.blockedReason,
    availability: command.availability,
    queueBehavior: command.queueBehavior,
  }
}

/**
 * 迁移期适配器：保留 Desktop App 的 UI 端口，但所有状态读写已经落到 Core
 * session/message/part/event。`runId` 在此只作为兼容命名，实际值是 sessionID。
 */
export function createCoreEngineAdapter(core: CoreSessionClient): EngineClient {
  const datasets = new Map<string, { file: File; url: string }>()
  const datasetIDs = new WeakMap<File, string>()
  const attachedDatasetIDs = new Map<string, string>()
  const interactions = new Map<string, EngineInteraction>()
  const internalCompactionMessages = new Set<string>()

  const listeners = new Map<string, Set<(event: EngineRunEvent) => void>>()
  const pendingEvents = new Map<string, EngineRunEvent[]>()
  const failedSteps = new Map<string, Array<{ tool: string; id: string; label: string }>>()
  const deliveredVerifications = new Map<string, string>()
  const verificationListeners = new Set<(update: EngineVerificationUpdate) => void>()
  // 复用 session 时，旧轮次的 idle 可能在新 prompt 接受期间迟到。必须等 Core
  // 发出新一轮 busy/part/interaction 后才解除上一轮终态，避免把迟到 idle 当成新结果。
  const awaitingSessionActivity = new Set<string>()
  const MAX_INTERNAL_COMPACTION_MESSAGES = 4096

  const interactionKey = (sessionID: string, requestID: string) => `${sessionID}:${requestID}`

  /**
   * 已经发过终态事件的 session。Core 对同一次结束会发两条通知
   * （session.status{idle} 和 session.idle），若都翻译成 completed，
   * 第二条会让 App 认为流式消息不存在而重新拉一次全文，界面上出现重复气泡。
   */
  const MAX_SETTLED_SESSIONS = 256
  const settled = new Map<string, true>()
  const markSettled = (sessionID: string) => {
    if (settled.has(sessionID)) return false
    settled.set(sessionID, true)
    if (settled.size > MAX_SETTLED_SESSIONS) {
      const oldest = settled.keys().next().value
      if (typeof oldest === "string") settled.delete(oldest)
    }
    return true
  }

  const deliver = (sessionID: string, event: EngineRunEvent) => {
    const terminal = event.type === "completed" || event.type === "failed" || event.type === "cancelled"
    // 终态后的迟到进度/交互没有新的研究意义；无订阅时也不能让它们挤掉
    // 唯一的终态事件。标题是唯一允许在终态后继续补入的展示信息。
    if (settled.has(sessionID) && event.type !== "title" && event.type !== "verification") return
    if (terminal) {
      if (!markSettled(sessionID)) return
      failedSteps.delete(sessionID)
    }
    const sessionListeners = listeners.get(sessionID)
    if (sessionListeners?.size) {
      for (const listener of [...sessionListeners]) listener(event)
      if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
        // 保留 listeners：Core 的 session.updated（标题）会在 session.idle 之后才到，
        // 此时若已解绑，标题事件会掉进 pendingEvents 再也没人消费。listener 的生命周期
        // 由订阅方负责（App 每轮 startRun 前会先 unsubscribe）。
        pendingEvents.delete(sessionID)
      }
      return
    }
    const pending = pendingEvents.get(sessionID) ?? []
    if (pending.length >= 32) pending.shift()
    pending.push(event)
    pendingEvents.set(sessionID, pending)
  }

  // Core 事件是全局 SSE；适配器只做传输级 fan-out，不复制 session/result 事实。
  // 订阅在 adapter 创建时建立，避免 startRun 的异步 prompt 先于 UI subscribe 而丢失事件。
  core.subscribe((event: Event) => {
    const properties = event.properties
    let sessionID = properties && typeof properties === "object" && "sessionID" in properties && typeof properties.sessionID === "string"
      ? properties.sessionID
      : undefined
    // message.part.updated 的 properties 只有 { part, delta? }，sessionID 挂在 part 上。
    if (!sessionID && event.type === "message.part.updated") sessionID = event.properties.part?.sessionID
    // session.updated 的 properties 是 { info }，sessionID 在 info.id 上。
    if (!sessionID && event.type === "session.updated") sessionID = event.properties.info?.id
    if (event.type === "message.updated" && isInternalCompactionSummary(event.properties.info)) {
      internalCompactionMessages.delete(event.properties.info.id)
      internalCompactionMessages.add(event.properties.info.id)
      if (internalCompactionMessages.size > MAX_INTERNAL_COMPACTION_MESSAGES) {
        const oldest = internalCompactionMessages.values().next().value
        if (typeof oldest === "string") internalCompactionMessages.delete(oldest)
      }
    }
    if (!sessionID) return

    const part = event.type === "message.part.updated" ? event.properties.part : undefined
    const verifierStatus = part?.type === "tool" && part.state.status === "completed"
      ? part.state.metadata?.verifierStatus
      : undefined
    const verifierPending = part?.type === "tool" && part.state.status === "completed"
      ? part.state.metadata?.verifierPending === true
      : false
    const verifierFailure = part?.type === "tool" && part.state.status === "completed" && typeof part.state.metadata?.verifierFailure === "string"
      ? part.state.metadata.verifierFailure
      : undefined
    const verificationUpdate = verifierStatus === "pass" || verifierStatus === "warn" || verifierStatus === "block" || verifierPending
    const startsCurrentTurn = (event.type === "message.part.updated" && !verificationUpdate)
      || event.type === "permission.asked"
      || event.type === "question.asked"
      || (event.type === "session.status" && event.properties.status.type !== "idle")
    if (awaitingSessionActivity.has(sessionID) && startsCurrentTurn) {
      awaitingSessionActivity.delete(sessionID)
      settled.delete(sessionID)
    }

    let translated: EngineRunEvent | undefined
    if (event.type === "permission.asked") {
      const interaction = permissionInteraction(event.properties)
      interactions.set(interactionKey(sessionID, event.properties.id), interaction)
      translated = { type: "permission", message: "分析等待你的授权。", permission: interaction.permission }
    } else if (event.type === "question.asked") {
      const interaction = questionInteraction(event.properties)
      interactions.set(interactionKey(sessionID, event.properties.id), interaction)
      translated = { type: "question", message: "分析需要你的回答。", question: interaction.question }
    } else if (event.type === "session.status") {
      // busy 不再单独播报："分析正在执行…" 与随后的工具步骤重复，只会把进度区刷成噪音。
      if (event.properties.status.type === "repair") translated = { type: "progress", message: event.properties.status.message || "正在修复上一步执行…" }
      else if (event.properties.status.type === "retry") translated = { type: "progress", message: event.properties.status.message || "正在重试…" }
      else if (event.properties.status.type === "idle") translated = { type: "completed", message: "分析已完成。" }
    } else if (event.type === "runtime.timeline.event") {
      // timeline.message 是给工程排障的内部字符串（"cache observation"、"context v1"、
      // "query completed"），对研究者无意义。只放行 Core 明确标记为用户可见的失败说明，
      // 其余一律丢弃——进度改由 tool part 提供（见 message.part.updated 分支）。
      const decision = (event.properties.event as {
        failureDecision?: {
          category?: string
          disposition?: "retry" | "repair" | "stop" | "compact" | "fallback"
          userVisibleMessage?: string
        }
      }).failureDecision
      const visible = decision?.userVisibleMessage?.trim()
      if (visible && decision?.disposition === "stop") {
        translated = decision.category === "user_cancelled"
          ? { type: "cancelled", message: visible }
          : { type: "failed", message: visible }
      }
    } else if (event.type === "session.error") {
      const error = event.properties.error
      translated = {
        type: "failed",
        message: error && "data" in error && typeof error.data === "object" && error.data && "message" in error.data && typeof error.data.message === "string" ? error.data.message : "Core session 执行失败",
      }
    } else if (event.type === "session.idle") {
      translated = { type: "completed", message: "分析已完成。" }
    } else if (event.type === "session.updated") {
      // Core 用小模型依据问题生成会话标题；Desktop 只回填，不自己总结。
      const title = event.properties.info?.title?.trim()
      if (title) translated = { type: "title", title }
    } else if (STREAMING_PARTS_ENABLED && event.type === "message.part.updated") {
      // 不再用 knownSessions 作二次过滤：deliver 已按 sessionID 精确路由到该 run 的 listener，
      // 而 knownSessions 会在 terminal 事件时被清空，与随后仍在到达的 part 事件形成竞态，
      // 表现为流式正文整段丢失。
      // 流式：文本 part → 全量正文快照；reasoning part → 过滤后的思考过程快照；
      // tool part → Codex 式步骤行（按 callID 就地更新"正在…／已完成"）。
      const part = event.properties.part
      if (internalCompactionMessages.has(part.messageID)) return
      if (part.type === "text" && !part.synthetic && !part.ignored
      ) {
        translated = { type: "assistant_delta", text: part.text }
      } else if (part.type === "reasoning") {
        const reasoning = cleanReasoning(part.text)
        if (reasoning) translated = { type: "reasoning_delta", text: reasoning }
      } else if (part.type === "tool") {
        const state = part.state
        const metadata = "metadata" in state ? (state.metadata as Record<string, unknown> | undefined) : undefined
        const input = state.input && typeof state.input === "object" && !Array.isArray(state.input)
          ? state.input as Record<string, unknown>
          : undefined
        const label = toolProgressLabel(part.tool, metadata, input)
        if (verificationUpdate && state.status === "completed") {
          const status = (verifierPending ? "pending" : verifierStatus) as "pass" | "warn" | "block" | "pending"
          const message = status === "pass" ? "独立核验通过。" : status === "warn"
            ? "独立核验完成，存在诊断提醒。"
            : status === "block" ? "独立核验未通过；估计结果不可作为最终结论。"
              : `独立核验未完成；估计结果已保留。${verifierFailure ?? "后续可从核验阶段继续。"}`
          const key = `${sessionID}:${part.callID}`
          const signature = `${status}:${message}`
          if (deliveredVerifications.get(key) === signature) return
          if (!deliveredVerifications.has(key)) {
            deliver(sessionID, {
              type: "progress",
              message: toolProgressMessage(label, "completed", undefined, { tool: part.tool, input }),
              step: { id: part.callID, label, phase: "analysis", status: "completed" },
            })
          }
          deliveredVerifications.set(key, signature)
          if (deliveredVerifications.size > 1024) {
            const oldest = deliveredVerifications.keys().next().value
            if (typeof oldest === "string") deliveredVerifications.delete(oldest)
          }
          translated = {
            type: "verification", callID: part.callID, status, message,
          }
          for (const listener of verificationListeners) listener({
            sessionID, messageID: part.messageID, callID: part.callID,
            status, message,
          })
        } else if (state.status === "error") {
          const previous = failedSteps.get(sessionID) ?? []
          if (!previous.some((step) => step.id === part.callID)) {
            failedSteps.set(sessionID, [...previous, { tool: part.tool, id: part.callID, label }].slice(-32))
          }
        } else if (state.status === "completed") {
          const previous = failedSteps.get(sessionID) ?? []
          failedSteps.set(sessionID, previous.filter((step) => step.tool !== part.tool))
          for (const step of previous) {
            if (step.tool !== part.tool || step.id === part.callID) continue
            deliver(sessionID, {
              type: "progress",
              message: `${step.label}已恢复`,
              step: { id: step.id, label: step.label, phase: "analysis", status: "recovered" },
            })
          }
        }
        if (!translated) translated = {
          type: "progress",
          message: toolProgressMessage(
            label,
            state.status,
            state.status === "error" ? state.error : undefined,
            { tool: part.tool, input },
          ),
          // step.id 用 callID：同一次工具调用从 running 到 completed 就地更新同一行，
          // 而不是在进度区堆两条。
          step: { id: part.callID, label, phase: "analysis", status: toolProgressStatus(state.status) },
        }
      }
    }
    if (translated) deliver(sessionID, translated)
  })

  return {
    subscribeVerification(listener) {
      verificationListeners.add(listener)
      return () => verificationListeners.delete(listener)
    },
    async health(): Promise<EngineHealth> {
      const result = await core.health()
      return { protocolVersion: "v1" as const, engineVersion: result.data.version, status: result.data.healthy ? "ready" as const : "unavailable" as const }
    },
    async commands() {
      const result = await core.commands()
      return (result.data ?? []).map(engineCommand)
    },
    async uploadDataset(file: File): Promise<EngineDataset> {
      const existingID = datasetIDs.get(file)
      if (existingID) {
        return { id: existingID, name: file.name, format: file.name.split(".").at(-1)?.toUpperCase() ?? "数据文件", bytes: file.size }
      }
      const id = crypto.randomUUID()
      datasets.set(id, { file, url: await fileDataURL(file) })
      datasetIDs.set(file, id)
      return { id, name: file.name, format: file.name.split(".").at(-1)?.toUpperCase() ?? "数据文件", bytes: file.size }
    },
    async startRun(input: EngineRunRequest): Promise<EngineRun> {
      // 无附件时按纯研究对话提交；Core 用 intent 区分是否进入数据工作流。
      const dataset = input.dataset ? datasets.get(input.dataset.id) : undefined
      if (input.dataset && !dataset) throw new Error("数据附件已失效，请重新选择")
      // 首次提交会因注入凭据重启 Core，事件流需要重新挂到新 Instance 的 Bus 上。
      // 必须等它就绪再建 session，否则这一回合的流式与完成事件会全部丢失。
      await core.whenEventStreamReady()
      const session = input.sessionID
        ? { id: input.sessionID }
        : await core.createSession({ title: input.prompt.slice(0, 80), permission: input.permission })
      if (input.sessionID) {
        // 同一 session 的下一轮必须等待 Core 的 busy/part/interaction 作为代际边界；
        // 在此之前保留上一轮 settled，拦住迟到的 idle。
        awaitingSessionActivity.add(session.id)
        pendingEvents.delete(session.id)
      } else {
        settled.delete(session.id)
      }
      failedSteps.delete(session.id)
      // session ID 一旦取得就先建立本轮缓冲，再提交异步 prompt。这样事件的归属
      // 不依赖 UI 恰好何时 subscribe；提交失败时清掉这块缓冲，避免旧事件污染重试。
      // 若 createSession 已经异步产生标题等事件，则保留那部分已排队内容。
      if (!pendingEvents.has(session.id)) pendingEvents.set(session.id, [])
      try {
        const attachDataset = dataset && attachedDatasetIDs.get(session.id) !== input.dataset?.id
        const files = attachDataset && dataset
          ? [{ type: "file" as const, mime: fileMime(dataset.file), filename: dataset.file.name, url: dataset.url }]
          : undefined
        if (input.command) {
          if (!core.command) throw new Error("当前 Core 不支持斜杠命令执行")
          await core.command({
            sessionID: session.id,
            command: input.command.name,
            arguments: input.command.arguments,
            model: input.model,
            parts: files,
            variant: input.effort,
            // 文件字节在同一 session 内只附加一次，但工作表选择属于每轮研究语义。
            queueMetadata: dataset && input.worksheetName ? { desktopWorksheetName: input.worksheetName } : undefined,
          })
        } else {
          await core.prompt({
            sessionID: session.id,
            text: input.prompt,
            files,
            model: input.model,
            // 文件字节在同一 session 内只附加一次，但工作表选择属于每轮研究语义。
            // 用户切换 sheet 后必须把新的 named_sheet 约束继续交给 Core。
            worksheetName: dataset ? input.worksheetName : undefined,
            variant: input.effort,
          })
        }
        if (attachDataset && input.dataset) attachedDatasetIDs.set(session.id, input.dataset.id)
      } catch (error) {
        awaitingSessionActivity.delete(session.id)
        pendingEvents.delete(session.id)
        throw error
      }
      return { runId: session.id }
    },
    async cancelRun(sessionID) {
      await core.abort(sessionID)
    },
    async getResult(sessionID): Promise<EngineRunResult> {
      const messages = await core.loadSession(sessionID)
      const latestAssistant = [...messages].reverse().find((message) =>
        message.info.role === "assistant" && !isInternalCompactionSummary(message.info),
      )
      const document = latestAssistant ? visibleAssistantText(latestAssistant.parts) : ""
      return { runId: sessionID, status: (document ? "completed" : "running") as "completed" | "running", document: document || null }
    },
    async summarize(sessionID, model, instructions) {
      await core.summarize(sessionID, model, instructions)
    },
    async updateTitle(sessionID, title) {
      await core.updateTitle(sessionID, title)
    },
    async revert(sessionID, messageID) {
      await core.revert(sessionID, messageID)
    },
    async revertLatest(sessionID) {
      await core.revertLatest(sessionID)
    },
    async unrevert(sessionID) {
      if (core.redo) await core.redo(sessionID)
      else await core.unrevert(sessionID)
    },
    async context(sessionID) {
      return core.context(sessionID)
    },
    async answerInteraction(sessionID, requestID, answer: EngineInteractionAnswer) {
      const interaction = interactions.get(interactionKey(sessionID, requestID))
      if (!interaction) throw new Error("Core 交互请求已过期")
      if (interaction.kind === "permission") {
        await core.replyPermission(requestID, answer.allowed === false ? "reject" : "once")
      } else {
        const selected = answer.selected ?? []
        const question = interaction.question
        const labels = selected.map((id: string) => question.options.find((option) => option.id === id)?.label ?? id)
        await core.replyQuestion(requestID, [answer.text ? [answer.text] : labels])
      }
      interactions.delete(interactionKey(sessionID, requestID))
    },
    async denyInteraction(sessionID, requestID) {
      const interaction = interactions.get(interactionKey(sessionID, requestID))
      if (interaction?.kind === "question") await core.rejectQuestion(requestID)
      else await core.replyPermission(requestID, "reject")
      interactions.delete(interactionKey(sessionID, requestID))
    },
    subscribe(sessionID, listener) {
      const sessionListeners = listeners.get(sessionID) ?? new Set()
      sessionListeners.add(listener)
      listeners.set(sessionID, sessionListeners)
      const queued = pendingEvents.get(sessionID)
      if (queued?.length) {
        pendingEvents.delete(sessionID)
        for (const event of queued) listener(event)
      }
      return () => {
        const current = listeners.get(sessionID)
        current?.delete(listener)
        if (current?.size === 0) listeners.delete(sessionID)
      }
    },
  }
}
