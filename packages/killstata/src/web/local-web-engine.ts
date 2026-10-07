import type { FilePartInput, PermissionRuleset } from "@killstata/sdk/v2/client"
import { CoreApplication } from "../core/application"
import type { CoreApplication as CoreApplicationType } from "../core/application"
import { CoreApplicationClient } from "../core/client"
import { containsEngineInternalData, sanitizeAnalysisAssistantText } from "../runtime/analysis-text-sanitizer"
import { createLocalWebApi, type LocalWebCoreReadApi } from "./local-web-api"

const MAX_PROMPT_LENGTH = 100_000
const MAX_RUN_EVENTS = 512
const MAX_RUN_EVENT_BYTES = 512 * 1024
const MAX_SSE_QUEUE_BYTES = 4 * 1024 * 1024
const MAX_SSE_SUBSCRIBERS_PER_RUN = 8
const MAX_RETAINED_RUNS = 512
const MAX_ACTIVE_RUNS = 32
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const RESTORED_EVENT_ID_BASE = 1_000_000_000
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024
const MAX_STORED_UPLOAD_BYTES = 256 * 1024 * 1024
const MAX_STORED_UPLOADS = 32
const UPLOAD_TTL_MS = 60 * 60 * 1000
// The loopback Web host uses Bun's 10-second default idle timeout.
const SSE_HEARTBEAT_MS = 5_000
const LOCAL_PATH_RE = /(?:\/(?:Users|home|private|tmp|var|Volumes)\/|[A-Z]:\\)[^\s`"'，。；）】\]]+/gi
const SECRET_ASSIGNMENT_RE = /\b[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL)\s*[:=]\s*\S+/gi
const SECRET_VALUE_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/g

type ModelSelection = { providerID: string; modelID: string }
type PermissionRule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }
type WebQuestion = {
  requestId: string
  title: string
  prompt: string
  mode: "single" | "multi" | "text"
  options: Array<{ id: string; label: string; description?: string }>
  allowSkip: boolean
}
type WebPermission = { requestId: string; title: string; action: string; scope: string }
type WebInteraction = { kind: "question"; question: WebQuestion } | { kind: "permission"; permission: WebPermission }
type WebRunEvent = Record<string, unknown> & { type: string }
type WebRunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled"
type CoreMessage = {
  info?: { id?: string; role?: unknown; summary?: unknown; mode?: unknown }
  parts?: unknown[]
}

export type LocalWebCore = LocalWebCoreReadApi & {
  directory?: string
  subscribeEvents(handler: (event: unknown) => void): () => void
  createSession(input: { title: string; permission?: PermissionRuleset }): Promise<string>
  prompt(input: {
    sessionID: string
    text: string
    model?: ModelSelection
    variant?: string
    worksheetName?: string
    files?: FilePartInput[]
  }): Promise<void>
  command(input: {
    sessionID: string
    command: string
    arguments: string
    model?: ModelSelection
    variant?: string
    worksheetName?: string
    files?: FilePartInput[]
  }): Promise<void>
  abort(sessionID: string): Promise<void>
  loadSession(sessionID: string): Promise<CoreMessage[]>
  sessionExists(sessionID: string): Promise<boolean>
  sessionStatus(sessionID: string): Promise<{ type: string }>
  pendingQuestion(sessionID: string): Promise<unknown | undefined>
  pendingPermission(sessionID: string): Promise<unknown | undefined>
  context(sessionID: string): Promise<Record<string, unknown>>
  summarize(sessionID: string, model: ModelSelection, instructions?: string): Promise<void>
  updateTitle(sessionID: string, title: string): Promise<void>
  revert(sessionID: string, messageID: string): Promise<void>
  revertLatest(sessionID: string): Promise<void>
  unrevert(sessionID: string): Promise<void>
  replyPermission(requestID: string, reply: "once" | "reject"): Promise<void>
  replyQuestion(requestID: string, answers: string[][]): Promise<void>
  rejectQuestion(requestID: string): Promise<void>
}

export type LocalWebEngineApi = ((request: Request) => Promise<Response>) & { dispose(): void; isIdle(): boolean }
export type LocalWebCredentialHandler = (request: Request) => Promise<Response | undefined>
export type LocalWebRuntimeHandler = (request: Request) => Promise<Response | undefined>

type RunEventRecord = { id: number; payload: string; bytes: number }
type PendingInteraction = { kind: "question"; question: WebQuestion } | { kind: "permission" }
type VerificationStatus = "pass" | "warn" | "block" | "pending"
type VerificationUpdate = { sessionID: string; messageID: string; callID: string; status: VerificationStatus; message: string }
type WebRun = {
  id: string
  status: WebRunStatus
  document: string | null
  interaction?: WebInteraction
  interactions: Map<string, PendingInteraction>
  attachedDatasetID?: string
  events: RunEventRecord[]
  eventBytes: number
  nextEventID: number
  highestDroppedEventID: number
  subscribers: Map<ReadableStreamDefaultController<Uint8Array>, () => void>
  terminal: boolean
  awaitingActivity: boolean
  cancelRequested: boolean
  cancelInFlight?: Promise<boolean>
  priorMessageID?: string
  updatedAt: number
  terminalAt?: number
  restoring?: Promise<void>
}
type UploadedDataset = { id: string; name: string; mime: string; bytes: Uint8Array; createdAt: number }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function jsonError(status: number, code: string, message: string) {
  return Response.json({ protocolVersion: "v2", code, message, retryable: false }, { status })
}

function validID(value: string) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function validModel(value: unknown): ModelSelection | undefined | null {
  if (value === undefined) return undefined
  const model = record(value)
  if (!model || typeof model.providerID !== "string" || !model.providerID.trim() || model.providerID.length > 128
    || typeof model.modelID !== "string" || !model.modelID.trim() || model.modelID.length > 256) return null
  return { providerID: model.providerID.trim(), modelID: model.modelID.trim() }
}

function validPermission(value: unknown): PermissionRule[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 100) return null
  const rules: PermissionRule[] = []
  for (const raw of value) {
    const rule = record(raw)
    if (!rule || typeof rule.permission !== "string" || !rule.permission.trim() || rule.permission.length > 128
      || typeof rule.pattern !== "string" || rule.pattern.length > 512
      || (rule.action !== "allow" && rule.action !== "deny" && rule.action !== "ask")) return null
    rules.push({ permission: rule.permission, pattern: rule.pattern, action: rule.action })
  }
  return rules
}

function mimeFor(filename: string, supplied: string) {
  if (supplied && supplied !== "application/octet-stream") return supplied.slice(0, 128)
  const extension = filename.toLowerCase().split(".").at(-1)
  if (extension === "csv") return "text/csv"
  if (extension === "xls") return "application/vnd.ms-excel"
  if (extension === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  if (extension === "dta") return "application/x-stata"
  if (extension === "parquet") return "application/vnd.apache.parquet"
  return "application/octet-stream"
}

function safeFilename(value: string) {
  const name = value.replace(/[\\/\0\r\n]/g, "_").trim().slice(0, 255)
  return name || "dataset"
}

function dataURL(mime: string, bytes: Uint8Array) {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

const INTERNAL_REASONING_MARKERS = [
  "<file>",
  "Called the Read tool with the following input:",
  "You are a fresh-run verifier for killstata.",
  "你是 KillStata 的独立核验 Agent。",
  "<dataset-record>",
  "datasetId=",
  "stageId=",
]

function safeReasoning(value: string) {
  const text = value.replace(/\[REDACTED\]/g, "").trim()
  if (containsEngineInternalData(text)
    || INTERNAL_REASONING_MARKERS.some((marker) => text.includes(marker))
    || /\b(?:datasetId|stageId|workflowRunId|sessionID|checkpointId)\b/i.test(text)
    || text.includes(".killstata/")
    || /\b[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL)\s*[:=]\s*\S+/i.test(text)
    || /\bAuthorization\s*:\s*Bearer\s+\S+/i.test(text)
    || /<[|｜]+\s*DSML\s*[|｜]+/i.test(text)
    || /<\/?verifier_result>/i.test(text)) return ""
  return text
}

function safeCoreText(value: string, fallback: string) {
  const text = value.trim().slice(0, 4000)
  if (!text || containsEngineInternalData(text)
    || /(?:<file>|\.killstata\/|datasetId=|stageId=|workflowRunId)/i.test(text)
    || /\b[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL)\s*[:=]\s*\S+/i.test(text)
    || /\bAuthorization\s*:\s*Bearer\s+\S+/i.test(text)) return fallback
  return text
}

function verificationFromPart(sessionID: string, part: Record<string, unknown>): VerificationUpdate | undefined {
  if (part.type !== "tool" || typeof part.messageID !== "string" || typeof part.callID !== "string") return undefined
  const state = record(part.state)
  const metadata = record(state?.metadata)
  if (state?.status !== "completed" || !metadata) return undefined
  const verifierStatus = metadata.verifierStatus
  const pending = metadata.verifierPending === true
  if (!pending && verifierStatus !== "pass" && verifierStatus !== "warn" && verifierStatus !== "block") return undefined
  const status: VerificationStatus = pending ? "pending" : verifierStatus as Exclude<VerificationStatus, "pending">
  const verifierFailure = typeof metadata.verifierFailure === "string" ? metadata.verifierFailure : undefined
  const message = status === "pass" ? "独立核验通过。"
    : status === "warn" ? "独立核验完成，存在诊断提醒。"
      : status === "block" ? "独立核验未通过；估计结果不可作为最终结论。"
        : `独立核验未完成；估计结果已保留。${safeCoreText(verifierFailure ?? "后续可从核验阶段继续。", "后续可从核验阶段继续。")}`
  return { sessionID, messageID: part.messageID, callID: part.callID, status, message }
}

function visibleAssistantText(messages: CoreMessage[], afterMessageID?: string) {
  const latest = [...messages].reverse().find((message) => message.info?.role === "assistant"
    && message.info.summary !== true
    && message.info.mode !== "compaction"
    && (!afterMessageID || (typeof message.info.id === "string" && message.info.id > afterMessageID)))
  if (!latest || !Array.isArray(latest.parts)) return ""
  return latest.parts
    .flatMap((raw) => {
      const part = record(raw)
      if (part?.type !== "text" || part.synthetic === true || part.ignored === true || typeof part.text !== "string") return []
      const safe = safeAssistantText(part.text)
      return safe ? [safe] : []
    })
    .join("\n\n")
    .trim()
    .slice(0, 1_000_000)
}

function safeAssistantText(value: string) {
  const text = value.trim()
  const containsSecretOrPath = LOCAL_PATH_RE.test(text) || SECRET_ASSIGNMENT_RE.test(text) || SECRET_VALUE_RE.test(text)
  LOCAL_PATH_RE.lastIndex = 0
  SECRET_ASSIGNMENT_RE.lastIndex = 0
  SECRET_VALUE_RE.lastIndex = 0
  if (!containsSecretOrPath && !containsEngineInternalData(text)) return text.slice(0, 1_000_000)
  const scrubbed = text
    .replace(LOCAL_PATH_RE, "[本机路径]")
    .replace(SECRET_ASSIGNMENT_RE, "[凭据已隐藏]")
    .replace(SECRET_VALUE_RE, "[凭据已隐藏]")
  LOCAL_PATH_RE.lastIndex = 0
  SECRET_ASSIGNMENT_RE.lastIndex = 0
  SECRET_VALUE_RE.lastIndex = 0
  return sanitizeAnalysisAssistantText({ text: scrubbed, tools: [] }).text.trim().slice(0, 1_000_000)
}

function visibleUserMessage(message: CoreMessage) {
  if (message.info?.role !== "user" || !Array.isArray(message.parts)) return false
  return message.parts.some((raw) => {
    const part = record(raw)
    return part?.type === "file" || (part?.type === "text" && part.synthetic !== true && part.ignored !== true)
  })
}

function questionFrom(value: Record<string, unknown>): WebQuestion | undefined {
  if (typeof value.id !== "string" || !validID(value.id) || !Array.isArray(value.questions)) return undefined
  const first = record(value.questions[0])
  if (!first || typeof first.header !== "string" || typeof first.question !== "string" || !Array.isArray(first.options)) return undefined
  const options = first.options.slice(0, 32).flatMap((raw, index) => {
    const option = record(raw)
    if (!option || typeof option.label !== "string") return []
    return [{ id: String(index), label: option.label.slice(0, 256), ...(typeof option.description === "string" ? { description: option.description.slice(0, 1000) } : {}) }]
  })
  return {
    requestId: value.id,
    title: first.header.slice(0, 200),
    prompt: first.question.slice(0, 4_000),
    mode: first.multiple === true ? "multi" : first.custom === true ? "text" : "single",
    options,
    allowSkip: false,
  }
}

function permissionFrom(value: Record<string, unknown>): WebPermission | undefined {
  if (typeof value.id !== "string" || !validID(value.id) || typeof value.permission !== "string") return undefined
  const patterns = Array.isArray(value.patterns) ? value.patterns.filter((item): item is string => typeof item === "string").slice(0, 32) : []
  return { requestId: value.id, title: "分析需要授权", action: value.permission.slice(0, 500), scope: patterns.join(", ").slice(0, 2000) }
}

function toolLabel(tool: string, metadata: unknown, input: unknown) {
  const analysis = record(record(metadata)?.analysisView)
  const step = typeof analysis?.step === "string" ? analysis.step.trim() : ""
  const labels: Record<string, string> = {
    "data_import(import)": "导入数据", "data_import(profile)": "读取数据概览", "data_import(validate)": "检查数据质量",
    "data_import(correlation)": "分析相关性", data_import: "处理数据", data_preprocess: "预处理数据",
    econometrics_recommend: "推荐计量方法", ols_regression: "OLS 回归", panel_fe_regression: "面板固定效应回归",
    panel_random_effects: "面板随机效应与 Hausman 检验", hdfe_regression: "高维固定效应回归", iv_2sls: "工具变量回归",
    did_static: "双重差分", did2s: "两阶段双重差分", did_event_study_saturated: "交错处理事件研究",
    rdd_sharp: "锐性断点回归", rdd_fuzzy: "模糊断点回归", logit_regression: "Logit 回归", probit_regression: "Probit 回归",
    poisson_regression: "Poisson 回归", negbin_regression: "负二项回归", multinomial_logit: "多分类 Logit 回归",
    robust_regression: "稳健回归", wls_regression: "加权最小二乘", psm_construction: "估计倾向得分",
    psm_visualize: "诊断倾向得分分布", psm_matching: "倾向得分匹配", psm_ipw: "逆概率加权",
    psm_regression: "倾向得分回归调整", psm_double_robust: "双重稳健 AIPW", regression_table: "整理回归表格",
    heterogeneity_runner: "异质性与机制分析", research_brief: "撰写研究摘要", paper_draft: "起草论文",
    slide_generator: "生成演示材料", read: "读取文件", write: "写入文件", edit: "修改文件", glob: "查找文件",
    grep: "搜索内容", list: "浏览目录", bash: "执行命令", webfetch: "读取网页", websearch: "搜索网络",
    todowrite: "更新任务清单", todoread: "查看任务清单", workflow: "推进分析流程", skill: "调用专项能力",
  }
  if (step && labels[step]) return labels[step]
  const inner = step.match(/^[a-z_]+\(([^)]+)\)$/)?.[1]
  if (inner && labels[inner]) return labels[inner]
  if (step.startsWith("econometrics(")) return "计量回归"
  if (tool === "data_import") {
    const action = record(input)?.action
    if (typeof action === "string" && labels[`data_import(${action})`]) return labels[`data_import(${action})`]
  }
  return labels[tool] ?? tool.slice(0, 128)
}

function progressEvent(message: string, step?: { id: string; label: string; status: "queued" | "running" | "completed" | "failed" | "recovered" | "pending" }): WebRunEvent {
  return { type: "progress", message, ...(step ? { step: { ...step, phase: "analysis" } } : {}) }
}

function runIDFromPath(pathname: string, suffix: string) {
  const match = pathname.match(new RegExp(`^/api/v2/runs/([^/]+)/${suffix}$`))
  if (!match) return undefined
  try {
    const id = decodeURIComponent(match[1])
    return validID(id) ? id : undefined
  } catch {
    return undefined
  }
}

function toFilePart(dataset: UploadedDataset): FilePartInput {
  return { type: "file", mime: dataset.mime, filename: dataset.name, url: dataURL(dataset.mime, dataset.bytes) }
}

export function createLocalWebEngineApi(
  core: LocalWebCore,
  credentialHandler?: LocalWebCredentialHandler,
  runtimeHandler?: LocalWebRuntimeHandler,
): LocalWebEngineApi {
  const readApi = createLocalWebApi(core)
  const runs = new Map<string, WebRun>()
  const internalCompactionMessageIDs = new Set<string>()
  const expiredRunIDs = new Map<string, number>()
  const datasets = new Map<string, UploadedDataset>()
  const encoder = new TextEncoder()
  const restoredEventIDBase = RESTORED_EVENT_ID_BASE + Math.floor(Math.random() * RESTORED_EVENT_ID_BASE)
  let reservedUploadBytes = 0
  let reservedUploadSlots = 0
  let reservedRunSlots = 0
  let disposed = false

  const deleteRun = (run: WebRun) => {
    for (const [controller, cleanup] of run.subscribers) {
      cleanup()
      try { controller.close() } catch {}
    }
    run.subscribers.clear()
    runs.delete(run.id)
    expiredRunIDs.set(run.id, Date.now())
    if (expiredRunIDs.size > 2048) {
      const oldest = expiredRunIDs.keys().next().value
      if (typeof oldest === "string") expiredRunIDs.delete(oldest)
    }
  }

  const pruneRuns = (now = Date.now()) => {
    for (const run of runs.values()) {
      if (run.terminal && run.subscribers.size === 0 && run.terminalAt !== undefined && now - run.terminalAt > RUN_RETENTION_MS) deleteRun(run)
    }
    if (runs.size < MAX_RETAINED_RUNS) return
    const terminalRuns = [...runs.values()]
      .filter((run) => run.terminal && run.subscribers.size === 0)
      .sort((left, right) => left.updatedAt - right.updatedAt)
    while (runs.size >= MAX_RETAINED_RUNS && terminalRuns.length) deleteRun(terminalRuns.shift()!)
  }

  const restoreRun = async (id: string): Promise<WebRun | undefined> => {
    const existing = runs.get(id)
    if (existing) {
      await existing.restoring
      return runs.get(id)
    }
    if (!validID(id) || expiredRunIDs.has(id)) return undefined
    pruneRuns()
    const activeRunCount = [...runs.values()].filter((item) => item.status === "running" || item.status === "waiting").length
    if (runs.size + reservedRunSlots >= MAX_RETAINED_RUNS || activeRunCount + reservedRunSlots >= MAX_ACTIVE_RUNS) return undefined
    const run: WebRun = {
      id, status: "running", document: null, interactions: new Map(), events: [], eventBytes: 0,
      nextEventID: 0, highestDroppedEventID: 0, subscribers: new Map(), terminal: false,
      awaitingActivity: false, cancelRequested: false, updatedAt: Date.now(),
    }
    let finishRestore!: () => void
    run.restoring = new Promise<void>((resolve) => { finishRestore = resolve })
    runs.set(id, run)
    const eventIDBeforeRestore = run.nextEventID
    try {
      if (!await core.sessionExists(id)) {
        runs.delete(id)
        return undefined
      }
      const [messages, sessionStatus, questionRequest, permissionRequest] = await Promise.all([
        core.loadSession(id), core.sessionStatus(id), core.pendingQuestion(id), core.pendingPermission(id),
      ])
      const question = questionRequest ? questionFrom(record(questionRequest) ?? {}) : undefined
      const permission = permissionRequest ? permissionFrom(record(permissionRequest) ?? {}) : undefined
      const interaction: WebInteraction | undefined = question ? { kind: "question", question }
        : permission ? { kind: "permission", permission } : undefined
      if (run.nextEventID === eventIDBeforeRestore) {
        run.status = interaction ? "waiting" : sessionStatus.type === "idle" ? "completed" : "running"
        run.interaction = interaction
        run.interactions.clear()
        if (question) run.interactions.set(question.requestId, { kind: "question", question })
        if (permission) run.interactions.set(permission.requestId, { kind: "permission" })
        run.terminal = run.status === "completed"
        run.terminalAt = run.terminal ? Date.now() : undefined
      }
      if (run.document === null) run.document = visibleAssistantText(messages) || null
      run.events = []
      run.eventBytes = 0
      run.nextEventID = restoredEventIDBase + run.nextEventID
      run.highestDroppedEventID = run.nextEventID
      if (run.nextEventID === restoredEventIDBase) run.nextEventID += 1
      run.updatedAt = Date.now()
      return run
    } catch (error) {
      if (runs.get(id) === run) runs.delete(id)
      throw error
    } finally {
      run.restoring = undefined
      finishRestore()
    }
  }

  const lookupRun = async (id: string) => {
    try { return { run: await restoreRun(id) } }
    catch { return { run: undefined, error: jsonError(503, "core_unavailable", "暂时无法恢复研究会话") } }
  }

  const publish = (run: WebRun, event: WebRunEvent) => {
    if (disposed) return
    run.updatedAt = Date.now()
    if (event.type === "assistant_delta" || event.type === "reasoning_delta") {
      for (let index = run.events.length - 1; index >= 0; index--) {
        if (run.events[index].payload.includes(`"type":"${event.type}"`)) {
          run.eventBytes -= run.events[index].bytes
          run.highestDroppedEventID = Math.max(run.highestDroppedEventID, run.events[index].id)
          run.events.splice(index, 1)
          break
        }
      }
    }
    const id = ++run.nextEventID
    const payload = JSON.stringify({ protocolVersion: "v2", ...event })
    const frame = encoder.encode(`id: ${id}\ndata: ${payload}\n\n`)
    run.events.push({ id, payload, bytes: frame.byteLength })
    run.eventBytes += frame.byteLength
    while (run.events.length > MAX_RUN_EVENTS || run.eventBytes > MAX_RUN_EVENT_BYTES) {
      const removed = run.events.shift()
      if (removed) {
        run.eventBytes -= removed.bytes
        run.highestDroppedEventID = Math.max(run.highestDroppedEventID, removed.id)
      }
    }
    for (const [controller, cleanup] of [...run.subscribers]) {
      try {
        if (controller.desiredSize === null || controller.desiredSize < frame.byteLength) {
          cleanup()
          controller.error(new Error("local web stream consumer is too slow"))
          continue
        }
        controller.enqueue(frame)
      } catch { cleanup() }
    }
  }

  const verificationEvents: RunEventRecord[] = []
  const verificationSubscribers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>()
  const verificationSignatures = new Map<string, string>()
  let nextVerificationEventID = 0
  let verificationEventBytes = 0
  const publishVerification = (update: VerificationUpdate) => {
    const key = `${update.sessionID}:${update.callID}`
    const signature = `${update.status}:${update.message}`
    if (verificationSignatures.get(key) === signature) return
    verificationSignatures.set(key, signature)
    if (verificationSignatures.size > 1024) {
      const oldest = verificationSignatures.keys().next().value
      if (typeof oldest === "string") verificationSignatures.delete(oldest)
    }
    const id = ++nextVerificationEventID
    const payload = JSON.stringify({ protocolVersion: "v2", type: "verification", ...update })
    const frame = encoder.encode(`id: ${id}\ndata: ${payload}\n\n`)
    verificationEvents.push({ id, payload, bytes: frame.byteLength })
    verificationEventBytes += frame.byteLength
    while (verificationEvents.length > 256 || verificationEventBytes > 128 * 1024) {
      const removed = verificationEvents.shift()
      if (removed) verificationEventBytes -= removed.bytes
    }
    for (const [controller, cleanup] of [...verificationSubscribers]) {
      try {
        if (controller.desiredSize === null || controller.desiredSize < frame.byteLength) {
          cleanup()
          controller.error(new Error("local web verification stream consumer is too slow"))
          continue
        }
        controller.enqueue(frame)
      } catch { cleanup() }
    }
  }

  const terminal = (run: WebRun, status: Extract<WebRunStatus, "completed" | "failed" | "cancelled">, message: string) => {
    if (run.terminal) return
    run.terminal = true
    run.status = status
    run.terminalAt = Date.now()
    run.interaction = undefined
    run.interactions.clear()
    publish(run, { type: status, message: safeCoreText(message, status === "cancelled" ? "已停止分析。" : status === "failed" ? "分析未能完成。" : "分析已结束。") })
    run.document = null
  }

  const onCoreEvent = (raw: unknown) => {
    const envelope = record(raw)
    if (core.directory && (!envelope || envelope.directory !== core.directory || !("payload" in envelope))) return
    const event = record(envelope && "payload" in envelope ? envelope.payload : raw)
    const properties = record(event?.properties)
    if (!event || typeof event.type !== "string" || !properties) return
    const part = record(properties.part)
    const info = record(properties.info)
    const sessionID = typeof properties.sessionID === "string" ? properties.sessionID
      : typeof part?.sessionID === "string" ? part.sessionID
      : event.type === "session.updated" && typeof info?.id === "string" ? info.id : undefined
    if (!sessionID) return
    if (
      event.type === "message.updated" &&
      info?.role === "assistant" &&
      (info.summary === true || info.mode === "compaction") &&
      typeof info.id === "string"
    ) {
      const messageID = `${sessionID}:${info.id}`
      internalCompactionMessageIDs.delete(messageID)
      internalCompactionMessageIDs.add(messageID)
      if (internalCompactionMessageIDs.size > 4096) {
        const oldest = internalCompactionMessageIDs.values().next().value
        if (typeof oldest === "string") internalCompactionMessageIDs.delete(oldest)
      }
    }
    const run = runs.get(sessionID)
    const verification = event.type === "message.part.updated" && part ? verificationFromPart(sessionID, part) : undefined
    if (verification) {
      publishVerification(verification)
      if (run) publish(run, { type: "verification", callID: verification.callID, status: verification.status, message: verification.message })
    }
    if (!run) return

    if (event.type === "session.updated") {
      const title = typeof info?.title === "string" ? safeCoreText(info.title, "研究会话") : ""
      if (title) publish(run, { type: "title", title: title.slice(0, 200) })
      return
    }

    const partMessageID = typeof part?.messageID === "string" ? part.messageID : undefined
    if (event.type === "message.part.updated" && partMessageID &&
      internalCompactionMessageIDs.has(`${sessionID}:${partMessageID}`)) return
    const partBelongsToCurrentTurn = !run.priorMessageID || (partMessageID !== undefined && partMessageID > run.priorMessageID)
    if (event.type === "message.part.updated" && !partBelongsToCurrentTurn) return
    const beginsTurn = (event.type === "message.part.updated" && partBelongsToCurrentTurn) || event.type === "question.asked" || event.type === "permission.asked"
      || (event.type === "session.status" && record(properties.status)?.type !== "idle")
    if (run.awaitingActivity && beginsTurn) {
      run.awaitingActivity = false
      run.terminal = false
    }
    if (run.terminal) return
    const settling = event.type === "session.idle"
      || (event.type === "session.status" && record(properties.status)?.type === "idle")
      || event.type === "session.error"
      || event.type === "runtime.timeline.event"
    if (run.cancelRequested && !settling) return

    if (event.type === "question.asked") {
      const question = questionFrom(properties)
      if (!question) return
      run.status = "waiting"
      run.interaction = { kind: "question", question }
      run.interactions.set(question.requestId, { kind: "question", question })
      publish(run, { type: "question", message: "分析需要你的回答。", interaction: run.interaction })
      return
    }
    if (event.type === "permission.asked") {
      const permission = permissionFrom(properties)
      if (!permission) return
      run.status = "waiting"
      run.interaction = { kind: "permission", permission }
      run.interactions.set(permission.requestId, { kind: "permission" })
      publish(run, { type: "permission", message: "分析等待你的授权。", interaction: run.interaction })
      return
    }
    if (event.type === "session.status") {
      const status = record(properties.status)
      if (status?.type === "idle") {
        terminal(run, run.cancelRequested ? "cancelled" : "completed", run.cancelRequested ? "已停止分析。" : "分析已完成。")
      } else if (status?.type === "repair" || status?.type === "retry") {
        const fallback = status.type === "repair" ? "正在修复上一步执行…" : "正在重试…"
        const message = typeof status.message === "string" ? safeCoreText(status.message, fallback) : fallback
        publish(run, progressEvent(message))
      }
      return
    }
    if (event.type === "session.idle") {
      terminal(run, run.cancelRequested ? "cancelled" : "completed", run.cancelRequested ? "已停止分析。" : "分析已完成。")
      return
    }
    if (event.type === "session.error") {
      terminal(run, run.cancelRequested ? "cancelled" : "failed", run.cancelRequested ? "已停止分析。" : "分析核心执行失败，请检查分析步骤并重试。")
      return
    }
    if (event.type === "runtime.timeline.event") {
      const timeline = record(properties.event)
      const decision = record(timeline?.failureDecision)
      if (typeof decision?.userVisibleMessage === "string" && decision.disposition === "stop") {
        const cancelled = run.cancelRequested || decision.category === "user_cancelled"
        terminal(run, cancelled ? "cancelled" : "failed", cancelled ? "已停止分析。" : safeCoreText(decision.userVisibleMessage, "分析未能完成，请查看运行状态并重试。"))
      }
      return
    }
    if (event.type !== "message.part.updated" || !part) return
    if (part.type === "text" && part.synthetic !== true && part.ignored !== true && typeof part.text === "string") {
      run.document = safeAssistantText(part.text)
      if (run.document) publish(run, { type: "assistant_delta", text: run.document })
      return
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      const reasoning = safeReasoning(part.text)
      if (reasoning) publish(run, { type: "reasoning_delta", text: reasoning.slice(0, 100_000) })
      return
    }
    if (part.type === "tool") {
      const state = record(part.state)
      const input = record(state?.input)
      const metadata = record(state?.metadata)
      const label = toolLabel(typeof part.tool === "string" ? part.tool : "tool", metadata, input)
      const stateName = state?.status
      const status = stateName === "completed" ? "completed" : stateName === "error" ? "failed" : stateName === "pending" ? "queued" : "running"
      const detail = stateName === "error" && typeof state?.error === "string" && part.tool === "data_import" && input?.action === "profile"
        && /(inputPath|datasetId|Dataset manifest not found|数据集引用)/i.test(state.error)
        ? "：缺少当前数据集引用。正在使用最新数据阶段修复。" : ""
      publish(run, progressEvent(status === "completed" ? `已完成${label}` : status === "failed" ? `${label}未成功${detail}` : `正在${label}…`, {
        id: typeof part.callID === "string" ? part.callID : crypto.randomUUID(),
        label,
        status,
      }))
    }
  }

  const unsubscribe = core.subscribeEvents(onCoreEvent)

  const attachRunEvents = async (run: WebRun, request: Request) => {
    if (run.subscribers.size >= MAX_SSE_SUBSCRIBERS_PER_RUN) return jsonError(429, "too_many_streams", "此研究的实时连接已达到上限")
    const requestedID = Number(request.headers.get("last-event-id") ?? 0)
    const lastID = Number.isSafeInteger(requestedID) && requestedID >= 0 ? requestedID : 0
    const oldestID = run.events[0]?.id
    const newestID = run.events.at(-1)?.id ?? 0
    const gap = lastID > run.nextEventID
      || (lastID < run.nextEventID && (oldestID === undefined || lastID < oldestID - 1 || newestID < run.nextEventID || lastID < run.highestDroppedEventID))
    const replay = gap ? [] : run.events.filter((event) => event.id > lastID)
    let snapshotDocument = run.document
    if (gap && snapshotDocument === null) {
      try { snapshotDocument = visibleAssistantText(await core.loadSession(run.id), run.priorMessageID) || null } catch {}
    }
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let active = true
    let cleanup = () => {}
    const frame = (id: number, event: WebRunEvent) => encoder.encode(`id: ${id}\ndata: ${JSON.stringify({ protocolVersion: "v2", ...event })}\n\n`)
    const enqueue = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
      if (controller.desiredSize === null || controller.desiredSize < chunk.byteLength) {
        cleanup()
        controller.error(new Error("local web stream consumer is too slow"))
        return false
      }
      controller.enqueue(chunk)
      return true
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        cleanup = () => {
          if (!active) return
          active = false
          if (heartbeat) clearInterval(heartbeat)
          run.subscribers.delete(controller)
        }
        run.subscribers.set(controller, cleanup)
        if (gap) {
          const snapshot: WebRunEvent[] = []
          if (snapshotDocument) snapshot.push({ type: "assistant_delta", text: snapshotDocument })
          if (run.status === "waiting" && run.interaction) snapshot.push({
            type: run.interaction.kind,
            message: run.interaction.kind === "question" ? "分析需要你的回答。" : "分析等待你的授权。",
            interaction: run.interaction,
          })
          else if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
            snapshot.push({ type: run.status, message: run.status === "completed" ? "分析已完成。" : run.status === "cancelled" ? "已停止分析。" : "分析未能完成。" })
          } else snapshot.push(progressEvent("分析仍在进行，已恢复实时进度。"))
          const id = run.events.at(-1)?.id ?? run.nextEventID
          for (const event of snapshot) {
            if (!enqueue(controller, frame(id, event))) break
          }
        } else {
          for (const event of replay) {
            if (!enqueue(controller, encoder.encode(`id: ${event.id}\ndata: ${event.payload}\n\n`))) break
          }
        }
        if (active) {
          heartbeat = setInterval(() => {
            try { enqueue(controller, encoder.encode(": keep-alive\n\n")) } catch { cleanup() }
          }, SSE_HEARTBEAT_MS)
        }
      },
      cancel() { cleanup() },
    }, { highWaterMark: MAX_SSE_QUEUE_BYTES, size: (chunk) => chunk?.byteLength ?? 0 })
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" } })
  }

  const handleRun = async (request: Request): Promise<Response> => {
    let input: Record<string, unknown>
    try { input = record(await request.json()) ?? {} } catch { return jsonError(400, "invalid_json", "分析请求不是有效 JSON") }
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > MAX_PROMPT_LENGTH) {
      return jsonError(400, "invalid_prompt", "请输入有效的问题，且长度不能超过 100000 个字符")
    }
    const model = validModel(input.model)
    if (model === null) return jsonError(400, "invalid_model", "模型选择无效")
    const permission = validPermission(input.permission)
    if (permission === null) return jsonError(400, "invalid_permission", "工具授权规则无效")
    if (input.effort !== undefined && (typeof input.effort !== "string" || input.effort.length > 64)) return jsonError(400, "invalid_effort", "推理等级无效")
    const worksheetName = input.worksheetName === undefined ? undefined
      : typeof input.worksheetName === "string" && input.worksheetName.trim() && input.worksheetName.length <= 256 ? input.worksheetName.trim() : null
    if (worksheetName === null) return jsonError(400, "invalid_worksheet", "工作表名称无效")
    let command: { name: string; arguments: string } | undefined
    if (input.command !== undefined) {
      const value = record(input.command)
      if (!value || typeof value.name !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.name.replace(/^\/+/, ""))
        || typeof value.arguments !== "string" || value.arguments.length > 4000) return jsonError(400, "invalid_command", "命令请求无效")
      command = { name: value.name.replace(/^\/+/, ""), arguments: value.arguments }
    }
    const datasetInput = input.dataset === undefined ? undefined : record(input.dataset)
    let filePart: FilePartInput | undefined
    if (input.dataset !== undefined) {
      if (!datasetInput || typeof datasetInput.id !== "string" || !validID(datasetInput.id)) return jsonError(400, "invalid_dataset", "数据附件引用无效")
      const dataset = datasets.get(datasetInput.id)
      if (!dataset || Date.now() - dataset.createdAt > UPLOAD_TTL_MS || dataset.name !== datasetInput.name || dataset.bytes.byteLength !== datasetInput.bytes) {
        datasets.delete(datasetInput.id)
        return jsonError(409, "dataset_expired", "数据附件已失效，请重新选择")
      }
      const existing = typeof input.sessionID === "string" ? runs.get(input.sessionID) : undefined
      if (!existing || existing.attachedDatasetID !== dataset.id) filePart = toFilePart(dataset)
    }
    let run: WebRun | undefined
    if (input.sessionID !== undefined) {
      if (typeof input.sessionID !== "string" || !validID(input.sessionID)) return jsonError(400, "invalid_session", "研究会话标识无效")
      try { run = await restoreRun(input.sessionID) } catch { return jsonError(503, "core_unavailable", "暂时无法恢复当前研究") }
      if (!run) return jsonError(404, "session_not_found", "当前本机 Web 会话不存在，请重新开始研究")
    }
    if (run?.status === "running" || run?.status === "waiting") return jsonError(409, "run_already_active", "当前研究仍在运行或等待回答")
    const isNewRun = run === undefined
    let runSlotReserved = isNewRun
    if (isNewRun) {
      pruneRuns()
      const activeRunCount = [...runs.values()].filter((item) => item.status === "running" || item.status === "waiting").length
      if (activeRunCount + reservedRunSlots >= MAX_ACTIVE_RUNS) return jsonError(429, "too_many_active_runs", "本机同时运行的研究已达到上限，请等待当前分析结束")
      if (runs.size + reservedRunSlots >= MAX_RETAINED_RUNS) return jsonError(429, "run_history_full", "本机研究会话缓存已达到上限，请重启本机 Web 后重试")
      reservedRunSlots += 1
    }
    if (run) {
      const previousStatus = run.status
      run.status = "running"
      try {
        const previousMessages = await core.loadSession(run.id)
        run.priorMessageID = previousMessages.at(-1)?.info?.id
      } catch {
        run.status = previousStatus
        return jsonError(503, "core_unavailable", "暂时无法恢复当前研究")
      }
      run.document = null
      run.interaction = undefined
      run.interactions.clear()
      run.terminal = true
      run.awaitingActivity = true
      run.cancelRequested = false
      run.events = []
      run.eventBytes = 0
      run.nextEventID = 0
      run.highestDroppedEventID = 0
      for (const [controller, cleanup] of run.subscribers) {
        cleanup()
        try { controller.close() } catch {}
      }
      run.subscribers.clear()
    }
    try {
      if (!run) {
        const id = await core.createSession({ title: input.prompt.slice(0, 80), permission })
        run = {
          id, status: "running", document: null, interactions: new Map(), events: [],
          eventBytes: 0, nextEventID: 0, highestDroppedEventID: 0, subscribers: new Map(), terminal: false, awaitingActivity: false, cancelRequested: false, updatedAt: Date.now(),
        }
        runs.set(id, run)
        reservedRunSlots -= 1
        runSlotReserved = false
      }
      const common = {
        sessionID: run.id,
        model: model ?? undefined,
        variant: input.effort as string | undefined,
        worksheetName: datasetInput ? worksheetName ?? undefined : undefined,
        files: filePart ? [filePart] : undefined,
      }
      if (command) await core.command({ ...common, command: command.name, arguments: command.arguments })
      else await core.prompt({ ...common, text: input.prompt })
      if (datasetInput) run.attachedDatasetID = datasetInput.id as string
      return Response.json({ protocolVersion: "v2", runId: run.id })
    } catch {
      if (run && isNewRun) {
        runs.delete(run.id)
        for (const [controller, cleanup] of run.subscribers) {
          cleanup()
          try { controller.close() } catch {}
        }
      } else if (run) {
        run.terminal = false
        run.awaitingActivity = false
        terminal(run, "failed", "提交分析失败，请检查 Core 状态后重试。")
      }
      return jsonError(503, "core_unavailable", "分析核心暂时无法接受请求")
    } finally {
      if (runSlotReserved) reservedRunSlots -= 1
    }
  }

  const answerInteraction = async (request: Request, run: WebRun, requestID: string, action: "answer" | "deny") => {
    const pending = run.interactions.get(requestID)
    const activeRequestID = run.interaction?.kind === "question" ? run.interaction.question.requestId
      : run.interaction?.kind === "permission" ? run.interaction.permission.requestId : undefined
    if (!pending || run.status !== "waiting" || activeRequestID !== requestID) return jsonError(409, "interaction_expired", "此交互请求已失效，请查看最新分析状态")
    let body: Record<string, unknown> = {}
    if (action === "answer") {
      try { body = record(await request.json()) ?? {} } catch { return jsonError(400, "invalid_json", "回答不是有效 JSON") }
    } else if (request.headers.get("content-type")?.includes("application/json")) {
      try { body = record(await request.json()) ?? {} } catch { return jsonError(400, "invalid_json", "拒绝请求不是有效 JSON") }
    }
    let questionAnswers: string[][] | undefined
    if (pending.kind === "permission" && action === "answer" && body.allowed !== true && body.allowed !== false) {
      return jsonError(400, "invalid_answer", "授权回答无效")
    }
    if (pending.kind === "question" && action === "answer") {
      const selected = Array.isArray(body.selected) ? body.selected.filter((item): item is string => typeof item === "string") : []
      if (selected.length > pending.question.options.length || selected.some((id) => !pending.question.options.some((option) => option.id === id))) {
        return jsonError(400, "invalid_answer", "问题选项无效")
      }
      const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : ""
      if (!selected.length && !text) return jsonError(400, "invalid_answer", "请选择选项或填写回答")
      const labels = selected.map((id) => pending.question.options.find((option) => option.id === id)!.label)
      questionAnswers = [text ? [text] : labels]
    }
    if (run.interactions.get(requestID) !== pending) return jsonError(409, "interaction_expired", "此交互请求已失效，请查看最新分析状态")
    run.interactions.delete(requestID)
    try {
      if (pending.kind === "permission") {
        if (action === "answer" && body.allowed === true) await core.replyPermission(requestID, "once")
        else await core.replyPermission(requestID, "reject")
      } else if (action === "deny") {
        await core.rejectQuestion(requestID)
      } else {
        await core.replyQuestion(requestID, questionAnswers!)
      }
    } catch (error) {
      run.interactions.set(requestID, pending)
      throw error
    }
    if (run.cancelRequested || run.terminal) return Response.json({ protocolVersion: "v2" })
    run.interaction = undefined
    run.status = "running"
    publish(run, progressEvent("已收到你的选择，正在继续分析…"))
    return Response.json({ protocolVersion: "v2" })
  }

  const attachVerificationEvents = (request: Request) => {
    if (verificationSubscribers.size >= MAX_SSE_SUBSCRIBERS_PER_RUN) return jsonError(429, "too_many_streams", "核验状态的实时连接已达到上限")
    const requestedID = Number(request.headers.get("last-event-id") ?? 0)
    const lastID = Number.isSafeInteger(requestedID) && requestedID >= 0 ? requestedID : 0
    const oldestID = verificationEvents[0]?.id
    const gap = oldestID !== undefined && lastID < oldestID - 1
    const replay = gap ? verificationEvents : verificationEvents.filter((event) => event.id > lastID)
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let active = true
    let cleanup = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        cleanup = () => {
          if (!active) return
          active = false
          if (heartbeat) clearInterval(heartbeat)
          verificationSubscribers.delete(controller)
        }
        verificationSubscribers.set(controller, cleanup)
        for (const event of replay) {
          const frame = encoder.encode(`id: ${event.id}\ndata: ${event.payload}\n\n`)
          if (controller.desiredSize === null || controller.desiredSize < frame.byteLength) {
            cleanup()
            controller.error(new Error("local web verification stream consumer is too slow"))
            break
          }
          controller.enqueue(frame)
        }
        if (active) {
          heartbeat = setInterval(() => {
            try {
              const frame = encoder.encode(": keep-alive\n\n")
              if (controller.desiredSize === null || controller.desiredSize < frame.byteLength) {
                cleanup()
                controller.error(new Error("local web verification stream consumer is too slow"))
                return
              }
              controller.enqueue(frame)
            } catch { cleanup() }
          }, SSE_HEARTBEAT_MS)
        }
      },
      cancel() { cleanup() },
    }, { highWaterMark: 128 * 1024, size: (chunk) => chunk?.byteLength ?? 0 })
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" } })
  }

  const api = (async (request: Request): Promise<Response> => {
    if (disposed) return jsonError(503, "web_stopped", "本机 Web 服务已停止")
    const credentialResponse = await credentialHandler?.(request)
    if (credentialResponse) return credentialResponse
    const runtimeResponse = await runtimeHandler?.(request)
    if (runtimeResponse) return runtimeResponse
    pruneRuns()
    const url = new URL(request.url)
    if (url.pathname === "/api/v2/verification/events" && request.method === "GET") return attachVerificationEvents(request)
    if (url.pathname === "/api/v2/verification/events") return jsonError(405, "method_not_allowed", "本机 Web API 不支持此请求方法")
    if (url.pathname === "/api/v2/datasets" && request.method === "POST") {
      let form: FormData
      try { form = await request.formData() } catch { return jsonError(400, "invalid_upload", "数据附件格式无效") }
      const entries = [...form.entries()]
      const fileEntry: unknown = form.get("file")
      if (entries.length !== 1 || entries[0][0] !== "file" || !fileEntry || typeof fileEntry !== "object"
        || !("arrayBuffer" in fileEntry) || !("size" in fileEntry) || !("name" in fileEntry) || !("type" in fileEntry)) {
        return jsonError(400, "invalid_upload", "请只选择一个数据文件")
      }
      const file = fileEntry as File
      if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) return jsonError(413, "upload_too_large", "数据文件不能为空，且不能超过 60 MiB")
      const now = Date.now()
      for (const [id, dataset] of datasets) {
        if (now - dataset.createdAt > UPLOAD_TTL_MS) datasets.delete(id)
      }
      const storedBytes = [...datasets.values()].reduce((total, dataset) => total + dataset.bytes.byteLength, 0)
      if (datasets.size + reservedUploadSlots >= MAX_STORED_UPLOADS || storedBytes + reservedUploadBytes + file.size > MAX_STORED_UPLOAD_BYTES) {
        return jsonError(413, "upload_storage_full", "本机待处理附件已达到容量上限，请重新选择或稍后重试")
      }
      reservedUploadBytes += file.size
      reservedUploadSlots += 1
      const name = safeFilename(file.name)
      const mime = mimeFor(name, file.type)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (disposed) return jsonError(503, "web_stopped", "本机 Web 服务已停止")
        const dataset: UploadedDataset = { id: crypto.randomUUID(), name, mime, bytes, createdAt: now }
        datasets.set(dataset.id, dataset)
        const extension = name.toLowerCase().split(".").at(-1)
        return Response.json({ protocolVersion: "v2", id: dataset.id, name, format: extension ? extension.toUpperCase() : "数据文件", bytes: dataset.bytes.byteLength })
      } catch {
        return jsonError(400, "invalid_upload", "无法读取所选数据文件")
      } finally {
        reservedUploadBytes -= file.size
        reservedUploadSlots -= 1
      }
    }
    if (url.pathname === "/api/v2/datasets") return jsonError(405, "method_not_allowed", "本机 Web API 不支持此请求方法")
    if (url.pathname === "/api/v2/runs" && request.method === "POST") return handleRun(request)
    if (url.pathname === "/api/v2/runs") return jsonError(405, "method_not_allowed", "本机 Web API 不支持此请求方法")
    const resultID = runIDFromPath(url.pathname, "result")
    if (resultID && request.method === "GET") {
      const lookup = await lookupRun(resultID)
      if (lookup.error) return lookup.error
      const run = lookup.run
      if (!run) return jsonError(404, "run_not_found", "分析任务不存在")
      try {
        const messages = await core.loadSession(run.id)
        const document = run.document ?? (visibleAssistantText(messages, run.priorMessageID) || null)
        run.updatedAt = Date.now()
        return Response.json({ protocolVersion: "v2", runId: run.id, status: run.status, document, ...(run.interaction ? { interaction: run.interaction } : {}) })
      } catch { return jsonError(503, "core_unavailable", "暂时无法读取分析结果") }
    }
    const eventsID = runIDFromPath(url.pathname, "events")
    if (eventsID && request.method === "GET") {
      const lookup = await lookupRun(eventsID)
      if (lookup.error) return lookup.error
      const run = lookup.run
      return run ? attachRunEvents(run, request) : jsonError(404, "run_not_found", "分析任务不存在")
    }
    const cancelID = runIDFromPath(url.pathname, "cancel")
    if (cancelID && request.method === "POST") {
      const lookup = await lookupRun(cancelID)
      if (lookup.error) return lookup.error
      const run = lookup.run
      if (!run) return jsonError(404, "run_not_found", "分析任务不存在")
      if (run.cancelInFlight) {
        const confirmed = await run.cancelInFlight
        return confirmed ? Response.json({ protocolVersion: "v2", cancelled: true }) : jsonError(503, "core_unavailable", "分析核心暂时无法取消此任务")
      }
      if (run.cancelRequested && run.status === "cancelled") return Response.json({ protocolVersion: "v2", cancelled: true })
      if (run.status !== "running" && run.status !== "waiting") return jsonError(409, "run_not_active", "当前分析已经结束")
      const previousStatus = run.status
      const previousInteraction = run.interaction
      const previousInteractions = new Map(run.interactions)
      run.cancelRequested = true
      run.status = "running"
      run.interaction = undefined
      run.interactions.clear()
      const cancellation = (async () => {
        try {
          await core.abort(run.id)
          terminal(run, "cancelled", "已停止分析。")
          return true
        } catch {
          if (run.status !== "cancelled") {
            run.cancelRequested = false
            run.status = previousStatus
            run.interaction = previousInteraction
            run.interactions = previousInteractions
          }
          return run.status === "cancelled"
        }
      })()
      run.cancelInFlight = cancellation
      const confirmed = await cancellation
      if (run.cancelInFlight === cancellation) run.cancelInFlight = undefined
      return confirmed ? Response.json({ protocolVersion: "v2", cancelled: true }) : jsonError(503, "core_unavailable", "分析核心暂时无法取消此任务")
    }
    const interactionMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/interactions\/([^/]+)\/(answer|deny)$/)
    if (interactionMatch && request.method === "POST") {
      let runID: string
      let requestID: string
      try {
        runID = decodeURIComponent(interactionMatch[1])
        requestID = decodeURIComponent(interactionMatch[2])
      } catch { return jsonError(400, "invalid_interaction", "交互请求标识无效") }
      if (!validID(runID) || !validID(requestID)) return jsonError(400, "invalid_interaction", "交互请求标识无效")
      const lookup = await lookupRun(runID)
      if (lookup.error) return lookup.error
      const run = lookup.run
      if (!run) return jsonError(404, "run_not_found", "分析任务不存在")
      try { return await answerInteraction(request, run, requestID, interactionMatch[3] as "answer" | "deny") }
      catch { return jsonError(503, "core_unavailable", "分析核心暂时无法处理该回答") }
    }
    const sessionOperationMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(context|summarize|title|revert|undo|redo)$/)
    if (sessionOperationMatch) {
      let runID: string
      try { runID = decodeURIComponent(sessionOperationMatch[1]) } catch { return jsonError(400, "invalid_session", "研究会话标识无效") }
      if (!validID(runID)) return jsonError(400, "invalid_session", "研究会话标识无效")
      const operation = sessionOperationMatch[2]
      const expectedMethod = operation === "context" ? "GET" : operation === "title" ? "PATCH" : "POST"
      if (request.method !== expectedMethod) return jsonError(405, "method_not_allowed", "本机 Web API 不支持此请求方法")
      const lookup = await lookupRun(runID)
      if (lookup.error) return lookup.error
      const run = lookup.run
      if (!run) return jsonError(404, "run_not_found", "研究会话不存在")
      if (operation !== "context" && (run.status === "running" || run.status === "waiting")) {
        return jsonError(409, "run_already_active", "当前研究仍在运行或等待回答")
      }
      if (operation === "context") {
        try { return Response.json({ protocolVersion: "v2", context: await core.context(run.id) }) }
        catch { return jsonError(503, "core_unavailable", "暂时无法读取上下文状态") }
      }
      let body: Record<string, unknown> = {}
      if (operation === "summarize" || operation === "title" || operation === "revert") {
        try { body = record(await request.json()) ?? {} } catch { return jsonError(400, "invalid_json", "会话操作不是有效 JSON") }
      }
      try {
        if (operation === "summarize") {
          const model = validModel(body.model)
          if (!model || model === null) return jsonError(400, "invalid_model", "模型选择无效")
          if (body.instructions !== undefined && (typeof body.instructions !== "string" || body.instructions.length > 4000)) return jsonError(400, "invalid_instructions", "压缩说明无效")
          await core.summarize(run.id, model, body.instructions as string | undefined)
        } else if (operation === "title") {
          if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200) return jsonError(400, "invalid_title", "研究标题无效")
          await core.updateTitle(run.id, body.title.trim())
        } else if (operation === "revert") {
          if (typeof body.messageID !== "string" || !validID(body.messageID)) return jsonError(400, "invalid_message", "消息标识无效")
          await core.revert(run.id, body.messageID)
        } else if (operation === "undo") await core.revertLatest(run.id)
        else await core.unrevert(run.id)
        run.updatedAt = Date.now()
        return Response.json({ protocolVersion: "v2" })
      } catch {
        return jsonError(503, "core_unavailable", "分析核心暂时无法完成该会话操作")
      }
    }
    return readApi(request)
  }) as LocalWebEngineApi

  api.dispose = () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    for (const run of runs.values()) {
      for (const [controller, cleanup] of run.subscribers) {
        cleanup()
        try { controller.close() } catch {}
      }
      run.subscribers.clear()
    }
    runs.clear()
    for (const [controller, cleanup] of verificationSubscribers) {
      cleanup()
      try { controller.close() } catch {}
    }
    verificationSubscribers.clear()
    verificationEvents.length = 0
    verificationEventBytes = 0
    verificationSignatures.clear()
    datasets.clear()
  }
  api.isIdle = () => verificationSubscribers.size === 0
    && [...runs.values()].every((run) => run.terminal && run.subscribers.size === 0 && !run.restoring)

  return api
}

export function createLocalWebEngineApiFromCore(
  application: CoreApplicationType,
  credentialHandler?: LocalWebCredentialHandler,
  runtimeHandler?: LocalWebRuntimeHandler,
): LocalWebEngineApi {
  const client = CoreApplicationClient.inProcess(application)
  const sdk = client.sdk
  return createLocalWebEngineApi({
    directory: application.directory,
    async health() {
      const result = await sdk.global.health({ throwOnError: true })
      return { version: result.data.version, healthy: result.data.healthy }
    },
    async commands() {
      const result = await sdk.command.list({}, { throwOnError: true })
      return result.data.map((command) => ({
        name: command.name,
        description: command.description,
        hints: command.hints,
        advanced: command.advanced,
        blockedReason: command.blockedReason,
        availability: command.availability,
        queueBehavior: command.queueBehavior,
      }))
    },
    subscribeEvents: (handler) => CoreApplication.onEvent(handler),
    async createSession(input) {
      const result = await sdk.session.create(input, { throwOnError: true })
      return result.data.id
    },
    async prompt(input) {
      const result = await sdk.session.promptAsync({
        sessionID: input.sessionID,
        model: input.model,
        variant: input.variant,
        parts: [...(input.files ?? []), { type: "text", text: input.text }],
        ...(input.worksheetName ? { queueMetadata: { desktopWorksheetName: input.worksheetName } } : {}),
      }, { throwOnError: true })
      void result
    },
    async command(input) {
      await sdk.session.command({
        sessionID: input.sessionID,
        command: input.command,
        arguments: input.arguments,
        model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
        variant: input.variant,
        parts: input.files,
        ...(input.worksheetName ? { queueMetadata: { desktopWorksheetName: input.worksheetName } } : {}),
      }, { throwOnError: true })
    },
    async abort(sessionID) { await sdk.session.abort({ sessionID }, { throwOnError: true }) },
    async loadSession(sessionID) {
      const result = await sdk.session.messages({ sessionID }, { throwOnError: true })
      return result.data ?? []
    },
    async sessionExists(sessionID) {
      const response = await application.fetch(new Request(`http://killstata.core/session/${encodeURIComponent(sessionID)}`))
      if (response.status === 404) return false
      if (!response.ok) throw new Error("Core session lookup failed")
      return true
    },
    async sessionStatus(sessionID) {
      const result = await sdk.session.status({}, { throwOnError: true })
      return result.data[sessionID] ?? { type: "idle" }
    },
    async pendingQuestion(sessionID) {
      const result = await sdk.question.list({}, { throwOnError: true })
      return result.data.find((question) => question.sessionID === sessionID)
    },
    async pendingPermission(sessionID) {
      const result = await sdk.permission.list({}, { throwOnError: true })
      return result.data.find((permission) => permission.sessionID === sessionID)
    },
    async context(sessionID) {
      const response = await application.fetch(new Request(`http://killstata.core/session/${encodeURIComponent(sessionID)}/context`))
      if (!response.ok) throw new Error("Core context unavailable")
      const value = record(await response.json())
      if (!value) throw new Error("Core context response invalid")
      return value
    },
    async summarize(sessionID, model, instructions) {
      await sdk.session.summarize({
        sessionID,
        providerID: model.providerID,
        modelID: model.modelID,
        auto: false,
        ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
      }, { throwOnError: true })
    },
    async updateTitle(sessionID, title) {
      await sdk.session.update({ sessionID, title }, { throwOnError: true })
    },
    async revert(sessionID, messageID) {
      await sdk.session.revert({ sessionID, messageID }, { throwOnError: true })
    },
    async revertLatest(sessionID) {
      const [session, messages] = await Promise.all([
        sdk.session.get({ sessionID }, { throwOnError: true }),
        sdk.session.messages({ sessionID }, { throwOnError: true }),
      ])
      const checkpoint = session.data.revert?.messageID
      const latestUser = [...(messages.data ?? [])].reverse().find((message) =>
        visibleUserMessage({ info: message.info, parts: message.parts }) && (!checkpoint || message.info.id < checkpoint),
      )
      if (!latestUser) throw new Error("当前会话没有可撤销的用户消息")
      await sdk.session.revert({ sessionID, messageID: latestUser.info.id }, { throwOnError: true })
    },
    async unrevert(sessionID) {
      const [session, messages] = await Promise.all([
        sdk.session.get({ sessionID }, { throwOnError: true }),
        sdk.session.messages({ sessionID }, { throwOnError: true }),
      ])
      const checkpoint = session.data.revert?.messageID
      if (!checkpoint) throw new Error("当前会话没有可恢复的撤销消息")
      const nextUser = (messages.data ?? []).find((message) =>
        visibleUserMessage({ info: message.info, parts: message.parts }) && message.info.id > checkpoint,
      )
      if (nextUser) await sdk.session.revert({ sessionID, messageID: nextUser.info.id }, { throwOnError: true })
      else await sdk.session.unrevert({ sessionID }, { throwOnError: true })
    },
    async replyPermission(requestID, reply) { await sdk.permission.reply({ requestID, reply }, { throwOnError: true }) },
    async replyQuestion(requestID, answers) { await sdk.question.reply({ requestID, answers }, { throwOnError: true }) },
    async rejectQuestion(requestID) { await sdk.question.reject({ requestID }, { throwOnError: true }) },
  }, credentialHandler, runtimeHandler)
}
