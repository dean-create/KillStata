import { createKillstataClient, type KillstataClient } from "@killstata/sdk/v2/client"
import type { Event, FilePartInput, Part, Message } from "@killstata/sdk/v2/client"

type CoreFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type CoreEventSource = {
  on: (handler: (event: Event) => void) => () => void
  /** 可选：等待事件流真正挂上当前 Core 实例（Core 重启后订阅会失效）。 */
  whenConnected?: (timeoutMilliseconds?: number) => Promise<void>
  /** 可选：Core 即将重启时主动作废当前连接，避免陈旧的已连接状态放行提交。 */
  invalidate?: () => void
}

export type CoreSessionClientOptions = {
  fetch: CoreFetcher
  events?: CoreEventSource
}

export type CoreSessionMessage = {
  info: Message
  parts: Part[]
}

function isVisibleUserMessage(message: CoreSessionMessage) {
  if (message.info.role !== "user") return false
  return message.parts.some((part) =>
    part.type === "file" || (part.type === "text" && !part.synthetic && !part.ignored),
  )
}

export type CoreSession = import("@killstata/sdk/v2").Session
export type CoreContextSnapshot = Record<string, unknown>

/**
 * 工作表选择是 Desktop → Harness 的结构化请求事实，不是研究者说的话。
 *
 * 把它拼进 text 会诱导模型回显内部 tool 参数，也让测试中的用户消息不再等于用户实际输入。
 * Core 的 queueMetadata 会随本轮动作进入工具解析层，而不进入模型对话正文。
 */
export function corePromptPayload(input: {
  text: string
  files?: FilePartInput[]
  worksheetName?: string
}) {
  const worksheetName = input.worksheetName?.trim()
  return {
    parts: [...(input.files ?? []), { type: "text" as const, text: input.text }],
    ...(worksheetName ? { queueMetadata: { desktopWorksheetName: worksheetName } } : {}),
  }
}

/**
 * Desktop/TUI 共用的 Core session 门面。
 *
 * 它只保存 Core session ID，不创建第二份 run/result 状态机。分析是否完成、
 * 结果正文、工具调用和等待中的 permission/question 都来自 Core session/events。
 */
export class CoreSessionClient {
  readonly sdk: KillstataClient
  readonly events?: CoreEventSource
  private readonly fetcher: CoreFetcher

  constructor(options: CoreSessionClientOptions) {
    this.fetcher = options.fetch
    this.events = options.events
    this.sdk = createKillstataClient({
      baseUrl: "http://killstata.core",
      fetch: options.fetch as typeof fetch,
    })
  }

  async health() {
    return this.sdk.global.health({ throwOnError: true })
  }

  async commands() {
    return this.sdk.command.list({}, { throwOnError: true })
  }

  async createSession(input?: { title?: string; permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }> }): Promise<CoreSession> {
    const result = await this.sdk.session.create(input, { throwOnError: true })
    return result.data
  }

  async listSessions() {
    const result = await this.sdk.session.list({ roots: true }, { throwOnError: true })
    return result.data ?? []
  }

  async loadSessionInfo(sessionID: string): Promise<CoreSession> {
    const result = await this.sdk.session.get({ sessionID }, { throwOnError: true })
    return result.data
  }

  async loadSession(sessionID: string, limit = 100): Promise<CoreSessionMessage[]> {
    const result = await this.sdk.session.messages({ sessionID, limit }, { throwOnError: true })
    return result.data ?? []
  }

  async loadAllSessionMessages(sessionID: string): Promise<CoreSessionMessage[]> {
    const result = await this.sdk.session.messages({ sessionID }, { throwOnError: true })
    return result.data ?? []
  }

  async summarize(sessionID: string, model: { providerID: string; modelID: string }, instructions?: string) {
    await this.sdk.session.summarize({
      sessionID,
      providerID: model.providerID,
      modelID: model.modelID,
      auto: false,
      ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
    }, { throwOnError: true })
  }

  async updateTitle(sessionID: string, title: string) {
    const result = await this.sdk.session.update({ sessionID, title }, { throwOnError: true })
    return result.data
  }

  async revert(sessionID: string, messageID: string) {
    const result = await this.sdk.session.revert({ sessionID, messageID }, { throwOnError: true })
    return result.data
  }

  async revertLatest(sessionID: string) {
    const [session, messages] = await Promise.all([this.loadSessionInfo(sessionID), this.loadAllSessionMessages(sessionID)])
    const checkpoint = session.revert?.messageID
    const latestUser = [...messages].reverse().find((message) =>
      isVisibleUserMessage(message) && (!checkpoint || message.info.id < checkpoint),
    )
    if (!latestUser) throw new Error("当前会话没有可撤销的用户消息")
    await this.revert(sessionID, latestUser.info.id)
  }

  async unrevert(sessionID: string) {
    const result = await this.sdk.session.unrevert({ sessionID }, { throwOnError: true })
    return result.data
  }

  async redo(sessionID: string) {
    const session = await this.loadSessionInfo(sessionID)
    const checkpoint = session.revert?.messageID
    if (!checkpoint) throw new Error("当前会话没有可恢复的撤销消息")
    const messages = await this.loadAllSessionMessages(sessionID)
    const nextUser = messages.find((message) => isVisibleUserMessage(message) && message.info.id > checkpoint)
    if (nextUser) return this.revert(sessionID, nextUser.info.id)
    return this.unrevert(sessionID)
  }

  async context(sessionID: string): Promise<CoreContextSnapshot> {
    const response = await this.fetcher(`http://killstata.core/session/${encodeURIComponent(sessionID)}/context`)
    if (!response.ok) throw new Error(`读取上下文状态失败：HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("上下文状态响应无效")
    return value as CoreContextSnapshot
  }

  async runtimeDiagnostics(): Promise<unknown> {
    return this.runtimeRequest("/runtime", "GET")
  }

  async installRuntimePackages(): Promise<unknown> {
    return this.runtimeRequest("/runtime/install", "POST")
  }

  private async runtimeRequest(path: string, method: "GET" | "POST"): Promise<unknown> {
    const response = await this.fetcher(`http://killstata.core${path}`, { method })
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { message?: unknown } | undefined
      throw new Error(typeof body?.message === "string" ? body.message.slice(0, 500) : `读取本机运行环境失败：HTTP ${response.status}`)
    }
    return response.json()
  }

  async prompt(input: {
    sessionID: string
    text: string
    files?: FilePartInput[]
    model?: { providerID: string; modelID: string }
    intent?: "conversation" | "status" | "repair" | "verify" | "report" | "analysis" | "ingest"
    worksheetName?: string
    /** 推理等级；Core 作为 agent variant 解析，模型不支持时自行降级。 */
    variant?: string
  }) {
    await this.sdk.session.promptAsync({
      sessionID: input.sessionID,
      model: input.model,
      intent: input.intent,
      variant: input.variant,
      ...corePromptPayload(input),
    }, { throwOnError: true })
  }

  async command(input: {
    sessionID: string
    command: string
    arguments: string
    model?: { providerID: string; modelID: string }
    variant?: string
    parts?: FilePartInput[]
    queueMetadata?: Record<string, unknown>
  }) {
    await this.sdk.session.command({
      sessionID: input.sessionID,
      command: input.command,
      arguments: input.arguments,
      model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
      variant: input.variant,
      parts: input.parts,
      queueMetadata: input.queueMetadata,
    }, { throwOnError: true })
  }

  async textResult(sessionID: string) {
    const messages = await this.loadSession(sessionID, 100)
    return messages
      .flatMap((message) => message.info.role === "assistant"
        && message.info.summary !== true
        && message.info.mode !== "compaction"
        ? message.parts
        : [])
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text)
      .join("\n\n")
      .trim()
  }

  async abort(sessionID: string) {
    return this.sdk.session.abort({ sessionID }, { throwOnError: true })
  }

  async replyPermission(requestID: string, reply: "once" | "always" | "reject", message?: string) {
    return this.sdk.permission.reply({ requestID, reply, message }, { throwOnError: true })
  }

  async replyQuestion(requestID: string, answers: Array<string[]>) {
    return this.sdk.question.reply({ requestID, answers }, { throwOnError: true })
  }

  async rejectQuestion(requestID: string) {
    return this.sdk.question.reject({ requestID }, { throwOnError: true })
  }

  subscribe(handler: (event: Event) => void) {
    return this.events?.on(handler) ?? (() => {})
  }

  /**
   * 等待事件流就绪。注入凭据会重启 Core 进程并换掉 Bus 实例，此时旧订阅已失效；
   * 在重连完成前提交 prompt 会让整回合的事件发到新实例的 bus 上而无人接收。
   */
  async whenEventStreamReady() {
    await this.events?.whenConnected?.()
  }
}
