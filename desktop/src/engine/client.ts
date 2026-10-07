/**
 * Desktop 的 HTTP/SSE 引擎客户端。contract.ts 已被移除，
 * 这里内联所有需要的类型和校验函数，保持 Demo 模式和 fallback 路径可用。
 */

/** --- 内联 contract 类型 --- */
export type EngineProtocolVersion = "v1" | "v2"
export type EngineStatus = "ready" | "starting" | "unavailable"
export type EngineCapabilities = { structuredSteps: boolean; interactive: boolean }
export type EngineHealth = { protocolVersion: EngineProtocolVersion; engineVersion: string; status: EngineStatus; capabilities?: EngineCapabilities }
export type EngineCommand = { name: string; description: string; hints?: string[]; advanced?: boolean; blockedReason?: string; availability?: string[]; queueBehavior?: "queued" | "immediate" }
export type EngineDataset = { id: string; name: string; format: string; bytes: number }
/** dataset 可选：纯研究对话（问方法论、解释结果）不需要先挂数据附件。 */
export type EngineRunRequest = {
  prompt: string
  /** 同一项研究复用Core session，保证数据阶段、工具窗口和用户确认连续。 */
  sessionID?: string
  dataset?: EngineDataset
  worksheetName?: string
  command?: { name: string; arguments: string }
  /** 当前 Desktop 选择的模型；已有 Core session 不能靠 lastModel 隐式继承旧选择。 */
  model?: { providerID: string; modelID: string }
  /** 会话工具授权档位；由引擎在建立会话时提交给权限层。 */
  permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  /** 推理等级；引擎按 provider 能力解析或降级。 */
  effort?: string
}
export type EngineRun = { runId: string }
export type EngineProgressStep = { id: string; label: string; phase: "analysis"; status: "queued" | "running" | "completed" | "failed" | "recovered" | "pending" }
export type EngineQuestionOption = { id: string; label: string; description?: string }
export type EngineQuestion = { requestId: string; title: string; prompt: string; mode: "single" | "multi" | "text"; options: EngineQuestionOption[]; allowSkip: boolean }
export type EnginePermission = { requestId: string; title: string; action: string; scope: string }
export type EngineInteraction = { kind: "question"; question: EngineQuestion } | { kind: "permission"; permission: EnginePermission }
export type EngineInteractionAnswer = { selected?: string[]; text?: string; skipped?: boolean; allowed?: boolean }
export type EngineRunResult = { runId: string; status: "running" | "waiting" | "completed" | "failed" | "cancelled"; document: string | null; interaction?: EngineInteraction }
export type EngineContextSnapshot = Record<string, unknown>
export type EngineRunEvent =
  | { type: "progress"; message: string; step?: EngineProgressStep }
  | { type: "verification"; callID: string; status: "pass" | "warn" | "block" | "pending"; message: string }
  /** 流式回答：快照式全量文本（非增量），每次事件携带到目前为止的完整可见正文。 */
  | { type: "assistant_delta"; text: string }
  /** 流式思考过程：快照式全量文本，已过滤引擎内部标记。 */
  | { type: "reasoning_delta"; text: string }
  /** Core 依据问题生成的会话标题；Desktop 只回填展示，不自行总结。 */
  | { type: "title"; title: string }
  | { type: "completed"; message: string }
  | { type: "failed"; message: string }
  | { type: "cancelled"; message: string }
  | { type: "question"; message: string; question: EngineQuestion }
  | { type: "permission"; message: string; permission: EnginePermission }
  | { type: "waiting"; message: string; requestId: string; kind: "question" | "permission" }

export type EngineVerificationUpdate = {
  sessionID: string
  messageID: string
  callID: string
  status: "pass" | "warn" | "block" | "pending"
  message: string
}

class EngineProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "EngineProtocolError" }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EngineProtocolError("引擎响应不是对象")
  return value as Record<string, unknown>
}

function parseProtocolEnvelope(value: unknown, expectedVersion: EngineProtocolVersion = "v1"): Record<string, unknown> {
  const input = record(value)
  if (input.protocolVersion !== expectedVersion) throw new EngineProtocolError(`不兼容的引擎协议：${String(input.protocolVersion)}`)
  return input
}

function parseOptionalEngineProgressStep(value: unknown): EngineProgressStep | undefined {
  if (value === undefined) return undefined
  const input = record(value)
  if (typeof input.id !== "string" || !input.id.trim() || input.id.length > 128) throw new EngineProtocolError("进度步骤缺少有效标识")
  if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 256) throw new EngineProtocolError("进度步骤缺少有效名称")
  if (input.phase !== "analysis") throw new EngineProtocolError("进度步骤包含未知阶段")
  if (input.status !== "queued" && input.status !== "running" && input.status !== "completed" && input.status !== "failed" && input.status !== "recovered" && input.status !== "pending") throw new EngineProtocolError("进度步骤包含未知状态")
  return { id: input.id, label: input.label, phase: "analysis", status: input.status }
}

function parseEngineInteraction(value: unknown): EngineInteraction {
  const input = record(value)
  if (input.kind === "question") {
    const question = record(input.question)
    if (typeof question.requestId !== "string" || !question.requestId.trim() || question.requestId.length > 128) throw new EngineProtocolError("问题请求标识无效")
    if (typeof question.title !== "string" || !question.title.trim() || question.title.length > 200) throw new EngineProtocolError("问题标题无效")
    if (typeof question.prompt !== "string" || !question.prompt.trim() || question.prompt.length > 4_000) throw new EngineProtocolError("问题内容无效")
    if (question.mode !== "single" && question.mode !== "multi" && question.mode !== "text") throw new EngineProtocolError("问题类型无效")
    if (!Array.isArray(question.options) || question.options.length > 32) throw new EngineProtocolError("问题选项无效")
    const options = question.options.map((option: unknown) => {
      const parsed = record(option)
      if (typeof parsed.id !== "string" || !parsed.id.trim() || parsed.id.length > 128) throw new EngineProtocolError("问题选项标识无效")
      if (typeof parsed.label !== "string" || !parsed.label.trim() || parsed.label.length > 256) throw new EngineProtocolError("问题选项名称无效")
      return { id: parsed.id, label: parsed.label, ...(parsed.description === undefined ? {} : { description: String(parsed.description) }) }
    })
    if (typeof question.allowSkip !== "boolean") throw new EngineProtocolError("问题跳过设置无效")
    return { kind: "question", question: { requestId: question.requestId, title: question.title, prompt: question.prompt, mode: question.mode, options, allowSkip: question.allowSkip } }
  }
  if (input.kind === "permission") {
    const permission = record(input.permission)
    if (typeof permission.requestId !== "string" || !permission.requestId.trim() || permission.requestId.length > 128) throw new EngineProtocolError("授权请求标识无效")
    if (typeof permission.title !== "string" || !permission.title.trim() || permission.title.length > 200) throw new EngineProtocolError("授权标题无效")
    if (typeof permission.action !== "string" || !permission.action.trim() || permission.action.length > 2_000) throw new EngineProtocolError("授权动作无效")
    if (typeof permission.scope !== "string" || !permission.scope.trim() || permission.scope.length > 2_000) throw new EngineProtocolError("授权范围无效")
    return { kind: "permission", permission: { requestId: permission.requestId, title: permission.title, action: permission.action, scope: permission.scope } }
  }
  throw new EngineProtocolError("未知交互类型")
}

function parseEngineHealth(value: unknown): EngineHealth {
  const raw = record(value)
  if (raw.protocolVersion !== "v1" && raw.protocolVersion !== "v2") throw new EngineProtocolError(`不兼容的引擎协议：${String(raw.protocolVersion)}`)
  const input = parseProtocolEnvelope(raw, raw.protocolVersion as EngineProtocolVersion)
  if (typeof input.engineVersion !== "string" || !input.engineVersion) throw new EngineProtocolError("引擎响应缺少版本号")
  if (input.status !== "ready" && input.status !== "starting" && input.status !== "unavailable") throw new EngineProtocolError("引擎响应包含未知状态")
  if (raw.protocolVersion === "v1") return { protocolVersion: "v1", engineVersion: input.engineVersion, status: input.status }
  const capabilities = record(input.capabilities)
  if (typeof capabilities.structuredSteps !== "boolean" || typeof capabilities.interactive !== "boolean") throw new EngineProtocolError("v2 引擎响应缺少能力声明")
  return { protocolVersion: "v2", engineVersion: input.engineVersion, status: input.status, capabilities: { structuredSteps: capabilities.structuredSteps, interactive: capabilities.interactive } }
}

/** --- 客户端实现 --- */

type Fetcher = typeof fetch
type EngineEventSource = Pick<EventSource, "onmessage" | "onerror" | "close">
type EventSourceFactory = (url: URL) => EngineEventSource

const createEventSource: EventSourceFactory = (url) => new EventSource(url)

export interface EngineClient {
  health(): Promise<EngineHealth>
  commands(): Promise<EngineCommand[]>
  uploadDataset(file: File): Promise<EngineDataset>
  startRun(input: EngineRunRequest): Promise<EngineRun>
  cancelRun(runId: string): Promise<void>
  getResult(runId: string): Promise<EngineRunResult>
  summarize?(sessionID: string, model: { providerID: string; modelID: string }, instructions?: string): Promise<void>
  updateTitle?(sessionID: string, title: string): Promise<void>
  revert?(sessionID: string, messageID: string): Promise<void>
  revertLatest?(sessionID: string): Promise<void>
  unrevert?(sessionID: string): Promise<void>
  context?(sessionID: string): Promise<EngineContextSnapshot>
  answerInteraction?(runId: string, requestId: string, answer: EngineInteractionAnswer): Promise<void>
  denyInteraction?(runId: string, requestId: string, reason?: string): Promise<void>
  subscribe(runId: string, listener: (event: EngineRunEvent) => void): () => void
  /** 会话级核验更新，独立于主模型 Turn 的终态和当前选中的研究。 */
  subscribeVerification?(listener: (update: EngineVerificationUpdate) => void): () => void
  /** Web 工作区变化时，将长连接重新绑定到新的本机 Core。 */
  refreshWorkspaceContext?(): void
}

/**
 * Desktop 的版本化 HTTP/SSE 客户端。默认使用 v1；v2 必须由调用方显式传入，
 * 防止现有 bridge、mock 和 frontend 路径意外进入交互协议。
 */
export class HttpEngineClient implements EngineClient {
  private readonly baseUrl: URL
  private readonly verificationListeners = new Set<(update: EngineVerificationUpdate) => void>()
  private verificationSource?: EngineEventSource

  constructor(
    baseUrl: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly token?: string,
    private readonly eventSourceFactory: EventSourceFactory = createEventSource,
    private readonly protocolVersion: EngineProtocolVersion = "v1",
    private readonly workspaceID?: () => string,
  ) {
    const pageOrigin = typeof globalThis.location === "undefined" ? undefined : globalThis.location.origin
    try {
      this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`, pageOrigin)
    } catch {
      throw new EngineProtocolError("分析引擎地址无效")
    }
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"])
    const sameOrigin = pageOrigin !== undefined && this.baseUrl.origin === pageOrigin
    const localDevelopment = this.baseUrl.protocol === "http:"
      && loopbackHosts.has(this.baseUrl.hostname)
      && (pageOrigin === undefined || (() => {
        const page = new URL(pageOrigin)
        return page.protocol === "http:" && loopbackHosts.has(page.hostname)
      })())
    if (!sameOrigin && !localDevelopment) {
      throw new EngineProtocolError("分析引擎地址必须与当前 Web 页面同源，或使用 HTTP 本地回环地址")
    }
  }

  private endpoint(path: string) {
    return new URL(`${this.protocolVersion}/${path}`, this.baseUrl)
  }

  async health(): Promise<EngineHealth> {
    const response = await this.request(this.endpoint("health"))
    if (!response.ok) throw await this.errorMessage(response, `引擎健康检查失败：HTTP ${response.status}`)
    return parseEngineHealth(await response.json())
  }

  async commands(): Promise<EngineCommand[]> {
    const response = await this.request(this.endpoint("commands"))
    if (!response.ok) throw await this.errorMessage(response, `读取命令目录失败：HTTP ${response.status}`)
    const payload = parseProtocolEnvelope(await response.json(), this.protocolVersion)
    const commands = payload.commands
    if (!Array.isArray(commands) || commands.some((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true
      const command = item as Record<string, unknown>
      if (typeof command.name !== "string" || typeof command.description !== "string") return true
      if (command.hints !== undefined && (!Array.isArray(command.hints) || command.hints.some((hint: unknown) => typeof hint !== "string"))) return true
      if (command.advanced !== undefined && typeof command.advanced !== "boolean") return true
      if (command.blockedReason !== undefined && typeof command.blockedReason !== "string") return true
      if (command.availability !== undefined && (!Array.isArray(command.availability) || command.availability.some((value: unknown) => typeof value !== "string"))) return true
      return command.queueBehavior !== undefined && command.queueBehavior !== "queued" && command.queueBehavior !== "immediate"
    })) {
      throw new EngineProtocolError("命令目录响应无效")
    }
    return commands.map((item: unknown) => {
      const command = item as Record<string, unknown>
      return {
        ...command,
        name: (command.name as string).replace(/^\/+/, ""),
        description: (command.description as string).trim(),
        hints: Array.isArray(command.hints) ? command.hints.slice(0, 8) : undefined,
      }
    }) as EngineCommand[]
  }

  async uploadDataset(file: File): Promise<EngineDataset> {
    const body = new FormData()
    body.set("file", file)
    const response = await this.request(this.endpoint("datasets"), { method: "POST", body })
    if (!response.ok) throw await this.errorMessage(response, `上传数据失败：HTTP ${response.status}`)
    const payload = parseProtocolEnvelope(await response.json(), this.protocolVersion)
    if (typeof payload.id !== "string" || typeof payload.name !== "string" || typeof payload.format !== "string" || typeof payload.bytes !== "number") {
      throw new EngineProtocolError("数据上传响应无效")
    }
    return { id: payload.id, name: payload.name, format: payload.format, bytes: payload.bytes }
  }

  async startRun(input: EngineRunRequest): Promise<EngineRun> {
    const response = await this.request(this.endpoint("runs"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw await this.errorMessage(response, `提交分析失败：HTTP ${response.status}`)
    const payload = parseProtocolEnvelope(await response.json(), this.protocolVersion)
    if (typeof payload.runId !== "string" || !payload.runId) throw new EngineProtocolError("分析响应缺少 runId")
    return { runId: payload.runId }
  }

  async cancelRun(runId: string): Promise<void> {
    const response = await this.request(this.endpoint(`runs/${encodeURIComponent(runId)}/cancel`), { method: "POST" })
    if (!response.ok) throw await this.errorMessage(response, `取消分析失败：HTTP ${response.status}`)
    const payload = parseProtocolEnvelope(await response.json(), this.protocolVersion)
    if (payload.cancelled !== true) throw new EngineProtocolError("取消确认响应无效")
  }

  async getResult(runId: string): Promise<EngineRunResult> {
    const response = await this.request(this.endpoint(`runs/${encodeURIComponent(runId)}/result`))
    if (!response.ok) throw await this.errorMessage(response, `读取分析结果失败：HTTP ${response.status}`)
    return this.parseResult(runId, await response.json())
  }

  async context(sessionID: string): Promise<EngineContextSnapshot> {
    const response = await this.sessionOperation(sessionID, "context", "GET")
    const payload = parseProtocolEnvelope(await response.json(), "v2")
    return record(payload.context) as EngineContextSnapshot
  }

  async summarize(sessionID: string, model: { providerID: string; modelID: string }, instructions?: string): Promise<void> {
    await this.sessionOperation(sessionID, "summarize", "POST", { model, ...(instructions?.trim() ? { instructions: instructions.trim() } : {}) })
  }

  async updateTitle(sessionID: string, title: string): Promise<void> {
    await this.sessionOperation(sessionID, "title", "PATCH", { title })
  }

  async revert(sessionID: string, messageID: string): Promise<void> {
    await this.sessionOperation(sessionID, "revert", "POST", { messageID })
  }

  async revertLatest(sessionID: string): Promise<void> {
    await this.sessionOperation(sessionID, "undo", "POST")
  }

  async unrevert(sessionID: string): Promise<void> {
    await this.sessionOperation(sessionID, "redo", "POST")
  }

  async answerInteraction(runId: string, requestId: string, answer: EngineInteractionAnswer): Promise<void> {
    await this.sendInteraction(runId, requestId, "answer", answer)
  }

  async denyInteraction(runId: string, requestId: string, reason?: string): Promise<void> {
    await this.sendInteraction(runId, requestId, "deny", { reason })
  }

  private async sendInteraction(runId: string, requestId: string, action: "answer" | "deny", body: unknown): Promise<void> {
    if (this.protocolVersion !== "v2") throw new EngineProtocolError("当前引擎协议不支持交互式回答")
    const response = await this.request(this.endpoint(`runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(requestId)}/${action}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await this.errorMessage(response, action === "answer" ? "提交引擎回答失败：请求未被接受" : "拒绝引擎请求失败：请求未被接受")
    parseProtocolEnvelope(await response.json(), "v2")
  }

  subscribe(runId: string, listener: (event: EngineRunEvent) => void): () => void {
    const url = this.endpoint(`runs/${encodeURIComponent(runId)}/events`)
    if (this.token) url.searchParams.set("token", this.token)
    const workspaceID = this.workspaceID?.()
    if (workspaceID) url.searchParams.set("workspaceId", workspaceID)
    const source = this.eventSourceFactory(url)
    let closed = false
    let recovered = false
    let badEventCount = 0
    const close = () => {
      if (closed) return
      closed = true
      source.close()
    }
    const emit = (event: EngineRunEvent) => {
      if (closed) return
      listener(event)
      if (event.type !== "progress") badEventCount = 0
      if (this.protocolVersion === "v1" && (event.type === "completed" || event.type === "failed" || event.type === "cancelled")) close()
    }
    const startRecovery = () => {
      if (closed || recovered) return
      recovered = true
      emit({ type: "progress", message: "与分析引擎的连接已断开，正在确认分析状态…" })
      void this.recoverRunState(runId, emit, close)
    }
    source.onmessage = (message) => {
      if (closed) return
      try {
        const payload = parseProtocolEnvelope(JSON.parse(message.data), this.protocolVersion)
        if (payload.type === "assistant_delta" || payload.type === "reasoning_delta") {
          if (this.protocolVersion !== "v2") throw new EngineProtocolError("v1 不支持流式事件")
          if (typeof payload.text !== "string") throw new EngineProtocolError("流式事件无效")
          emit({ type: payload.type, text: payload.text })
          return
        }
        if (payload.type === "title") {
          if (this.protocolVersion !== "v2" || typeof payload.title !== "string" || !payload.title.trim() || payload.title.length > 200) {
            throw new EngineProtocolError("标题事件无效")
          }
          emit({ type: "title", title: payload.title.trim() })
          return
        }
        if (payload.type === "verification") {
          if (this.protocolVersion !== "v2" || typeof payload.callID !== "string" || !payload.callID.trim()
            || (payload.status !== "pass" && payload.status !== "warn" && payload.status !== "block" && payload.status !== "pending")
            || typeof payload.message !== "string" || !payload.message.trim()) throw new EngineProtocolError("核验事件无效")
          const event: Extract<EngineRunEvent, { type: "verification" }> = {
            type: "verification", callID: payload.callID, status: payload.status, message: payload.message,
          }
          emit(event)
          if (typeof payload.sessionID === "string" && typeof payload.messageID === "string") {
            this.notifyVerification({
              sessionID: payload.sessionID, messageID: payload.messageID,
              callID: event.callID, status: event.status, message: event.message,
            })
          }
          return
        }
        if (typeof payload.message !== "string" || !payload.message.trim()) throw new EngineProtocolError("进度事件无效")
        if (payload.type === "progress") {
          const step = parseOptionalEngineProgressStep(payload.step)
          emit(step ? { type: "progress", message: payload.message, step } : { type: "progress", message: payload.message })
          return
        }
        if (payload.type === "question" || payload.type === "permission") {
          if (this.protocolVersion !== "v2") throw new EngineProtocolError("v1 不支持交互事件")
          const interaction = parseEngineInteraction(payload.interaction)
          if (payload.type === "question" && interaction.kind === "question") emit({ type: "question", message: payload.message, question: interaction.question })
          else if (payload.type === "permission" && interaction.kind === "permission") emit({ type: "permission", message: payload.message, permission: interaction.permission })
          else throw new EngineProtocolError("交互事件类型不匹配")
          return
        }
        if (payload.type === "waiting") {
          if (this.protocolVersion !== "v2" || typeof payload.requestId !== "string" || !payload.requestId.trim() || payload.requestId.length > 128 || (payload.kind !== "question" && payload.kind !== "permission")) throw new EngineProtocolError("等待事件无效")
          emit({ type: "waiting", message: payload.message, requestId: payload.requestId, kind: payload.kind })
          return
        }
        if (payload.type === "completed" || payload.type === "failed" || payload.type === "cancelled") {
          emit({ type: payload.type, message: payload.message })
          return
        }
        throw new EngineProtocolError("未知进度事件")
      } catch {
        badEventCount += 1
        emit({ type: "progress", message: "引擎返回了无法读取的进度事件，正在继续等待后续状态。" })
        // 连续协议坏包意味着当前 SSE 不再可信；转入和断流相同的有界状态
        // 恢复，而不是直接关闭连接后让上层永久停在 running。
        if (badEventCount >= 20) startRecovery()
      }
    }
    source.onerror = () => {
      startRecovery()
    }
    return close
  }

  subscribeVerification(listener: (update: EngineVerificationUpdate) => void): () => void {
    if (this.protocolVersion !== "v2") return () => {}
    this.verificationListeners.add(listener)
    this.openVerificationSource()
    return () => {
      this.verificationListeners.delete(listener)
      if (this.verificationListeners.size === 0) {
        this.verificationSource?.close()
        this.verificationSource = undefined
      }
    }
  }

  refreshWorkspaceContext() {
    if (this.protocolVersion !== "v2" || !this.verificationSource || this.verificationListeners.size === 0) return
    this.verificationSource.close()
    this.verificationSource = undefined
    this.openVerificationSource()
  }

  private openVerificationSource() {
    if (this.verificationSource || this.verificationListeners.size === 0) return
    const url = this.endpoint("verification/events")
    if (this.token) url.searchParams.set("token", this.token)
    const workspaceID = this.workspaceID?.()
    if (workspaceID) url.searchParams.set("workspaceId", workspaceID)
    const source = this.eventSourceFactory(url)
    this.verificationSource = source
    source.onmessage = (message) => {
      if (this.verificationSource !== source) return
      try {
        const payload = parseProtocolEnvelope(JSON.parse(message.data), "v2")
        if (payload.type !== "verification" || typeof payload.sessionID !== "string" || !payload.sessionID
          || typeof payload.messageID !== "string" || !payload.messageID
          || typeof payload.callID !== "string" || !payload.callID
          || (payload.status !== "pass" && payload.status !== "warn" && payload.status !== "block" && payload.status !== "pending")
          || typeof payload.message !== "string" || !payload.message.trim()) return
        this.notifyVerification({
          sessionID: payload.sessionID, messageID: payload.messageID,
          callID: payload.callID, status: payload.status, message: payload.message,
        })
      } catch {
        // 忽略无效的会话级核验事件，不能把全局流的格式噪音带进研究记录。
      }
    }
  }

  private notifyVerification(update: EngineVerificationUpdate) {
    for (const listener of [...this.verificationListeners]) listener(update)
  }

  private async parseResult(runId: string, value: unknown): Promise<EngineRunResult> {
    const payload = parseProtocolEnvelope(value, this.protocolVersion)
    if (payload.runId !== runId || typeof payload.runId !== "string") throw new EngineProtocolError("分析结果与当前任务不匹配")
    const allowedStatus = this.protocolVersion === "v2"
      ? payload.status === "running" || payload.status === "waiting" || payload.status === "completed" || payload.status === "failed" || payload.status === "cancelled"
      : payload.status === "running" || payload.status === "completed" || payload.status === "failed" || payload.status === "cancelled"
    if (!allowedStatus || (payload.document !== null && typeof payload.document !== "string")) throw new EngineProtocolError("分析结果响应无效")
    const status = payload.status as EngineRunResult["status"]
    const interaction = payload.interaction === undefined ? undefined : parseEngineInteraction(payload.interaction)
    if (this.protocolVersion !== "v2" && (interaction !== undefined || status === "waiting")) throw new EngineProtocolError("分析结果响应无效")
    return { runId: payload.runId, status, document: payload.document, interaction }
  }

  private async recoverRunState(runId: string, emit: (event: EngineRunEvent) => void, close: () => void) {
    const url = this.endpoint(`runs/${encodeURIComponent(runId)}/result`)
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        const result = await this.parseResult(runId, await (await this.request(url)).json())
        if (result.status === "completed") return emit({ type: "completed", message: "分析已完成。" })
        if (result.status === "failed") return emit({ type: "failed", message: "分析未能完成。" })
        if (result.status === "cancelled") return emit({ type: "cancelled", message: "已停止分析。" })
        if (result.status === "waiting" && result.interaction) {
          if (result.interaction.kind === "question") emit({ type: "question", message: "分析等待你的回答。", question: result.interaction.question })
          else emit({ type: "permission", message: "分析等待你的授权。", permission: result.interaction.permission })
          return
        }
      } catch {
        // 引擎暂不可达，继续等待下一轮。
      }
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
    emit({ type: "failed", message: "暂时无法确认分析结果，请稍后重新打开完整结果。" })
    close()
  }

  private async request(input: URL, init?: RequestInit) {
    const headers = new Headers(init?.headers)
    if (this.token) headers.set("authorization", `Bearer ${this.token}`)
    const workspaceID = this.workspaceID?.()
    if (workspaceID) headers.set("x-killstata-workspace-id", workspaceID)
    const fetcher = this.fetcher
    return fetcher(input, { ...init, credentials: init?.credentials ?? "same-origin", headers })
  }

  private async sessionOperation(sessionID: string, operation: string, method: "GET" | "POST" | "PATCH", body?: unknown) {
    if (this.protocolVersion !== "v2") throw new EngineProtocolError("当前引擎协议不支持会话操作")
    const response = await this.request(this.endpoint(`runs/${encodeURIComponent(sessionID)}/${operation}`), {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    })
    if (!response.ok) throw await this.errorMessage(response, `会话操作失败：HTTP ${response.status}`)
    return response
  }

  private async errorMessage(response: Response, fallback: string): Promise<EngineProtocolError> {
    try {
      const body = (await response.json()) as Record<string, unknown>
      if ((body.protocolVersion === "v1" || body.protocolVersion === "v2") && typeof body.message === "string" && body.message.trim()) return new EngineProtocolError(body.message.trim())
    } catch {
      // 响应体不是 JSON 或无法解析时回退到状态码信息。
    }
    return new EngineProtocolError(fallback)
  }
}

export function createDemoEngine(): EngineClient {
  return {
    health: async () => ({ protocolVersion: "v1", engineVersion: "ui-demo", status: "ready" }),
    commands: async () => [
      { name: "progress", description: "分析进度：现在做到哪一步、下一步是什么" },
      { name: "results", description: "分析结果：已产出的数据、诊断和回归结果" },
      { name: "doctor", description: "环境检查：Python、模型、依赖是否就绪" },
    ],
    uploadDataset: async (file) => ({ id: crypto.randomUUID(), name: file.name, format: file.name.split(".").at(-1)?.toUpperCase() || "数据文件", bytes: file.size }),
    startRun: async () => ({ runId: crypto.randomUUID() }),
    cancelRun: async () => {},
    getResult: async (runId) => ({ runId, status: "completed", document: "界面演示，尚未连接分析引擎。" }),
    subscribe: (_runId, listener) => {
      listener({ type: "progress", message: "正在检查数据质量…" })
      const timers = [
        setTimeout(() => listener({ type: "reasoning_delta", text: "先看数据结构，" }), 150),
        setTimeout(() => listener({ type: "reasoning_delta", text: "先看数据结构，再决定用哪种估计量。" }), 300),
        setTimeout(() => listener({ type: "assistant_delta", text: "## 分析结果\n\n" }), 450),
        setTimeout(() => listener({ type: "assistant_delta", text: "## 分析结果\n\n界面演示：这是流式输出的示例文本，尚未连接分析引擎。" }), 650),
        setTimeout(() => listener({ type: "completed", message: "分析已完成。" }), 850),
      ]
      return () => timers.forEach(clearTimeout)
    },
  }
}
