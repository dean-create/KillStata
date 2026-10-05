import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Bus } from "@/bus"
import { projectStateRoot } from "@/runtime/dataset-state"
import { RuntimeEvents } from "./events"
import { isDeterministicToolFailureCode } from "./tool-attempt-policy"
import { AnalysisLifecycleError, createAnalysisLifecycle, reduceAnalysisLifecycle, type AnalysisLifecycleEvent } from "./analysis-lifecycle"
import type {
  InputGraphNode,
  QueuedSessionAction,
  RestoreTarget,
  RuntimeCheckpoint,
  ContextManagerSnapshot,
  RuntimeFailureDecision,
  ExecPolicyDecision,
  RuntimeTaskRecord,
  AnalysisRequestKind,
  AnalysisSpecRecord,
  AnalysisSpecStatus,
  AnalysisSpecPreflight,
  AnalysisLifecycleRecord,
  AnalysisToolRunRecord,
  PreparedSpecRecord,
  RuntimeTaskStatus,
  TaskTimelineEvent,
  TaskTimelineEventKind,
  QueryCorrelation,
  CompactionLifecycle,
} from "./types"

export type LedgerFile = {
  version: 1
  sessionID: string
  activeTaskId?: string
  nextTimelineSequence?: number
  tasks: RuntimeTaskRecord[]
  checkpoints: RuntimeCheckpoint[]
}

export type LedgerHealth = {
  status: "unavailable"
  code: "LEDGER_CORRUPT" | "LEDGER_UNSUPPORTED_VERSION"
  message: string
  path: string
  detectedAt: string
}

export class LedgerCorruptionError extends Error {
  constructor(
    public readonly code: LedgerHealth["code"],
    message: string,
    public readonly file: string,
  ) {
    super(message)
    this.name = "LedgerCorruptionError"
  }
}

let writeSequence = 0
const ledgerHealth = new Map<string, LedgerHealth>()

function nowIso() {
  return new Date().toISOString()
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${crypto.createHash("sha1").update(value).digest("hex").slice(0, 12)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateLedger(value: unknown, sessionID: string, file: string): LedgerFile {
  if (!isRecord(value)) throw new LedgerCorruptionError("LEDGER_CORRUPT", "ledger root must be an object", file)
  if (value.version !== 1) {
    throw new LedgerCorruptionError(
      "LEDGER_UNSUPPORTED_VERSION",
      `unsupported ledger version: ${String(value.version)}`,
      file,
    )
  }
  if (value.sessionID !== sessionID) {
    throw new LedgerCorruptionError("LEDGER_CORRUPT", "ledger sessionID does not match its filename", file)
  }
  if (
    value.nextTimelineSequence !== undefined &&
    (typeof value.nextTimelineSequence !== "number" ||
      !Number.isSafeInteger(value.nextTimelineSequence) ||
      value.nextTimelineSequence < 0)
  ) {
    throw new LedgerCorruptionError("LEDGER_CORRUPT", "ledger timeline sequence is invalid", file)
  }
  if (!Array.isArray(value.tasks) || !Array.isArray(value.checkpoints)) {
    throw new LedgerCorruptionError("LEDGER_CORRUPT", "ledger tasks/checkpoints must be arrays", file)
  }
  for (const task of value.tasks) {
    if (!isRecord(task) || typeof task.taskId !== "string" || task.sessionID !== sessionID || !Array.isArray(task.timeline)) {
      throw new LedgerCorruptionError("LEDGER_CORRUPT", "ledger contains an invalid task record", file)
    }
  }
  for (const checkpoint of value.checkpoints) {
    if (!isRecord(checkpoint) || checkpoint.sessionID !== sessionID || typeof checkpoint.checkpointId !== "string") {
      throw new LedgerCorruptionError("LEDGER_CORRUPT", "ledger contains an invalid checkpoint", file)
    }
  }
  return value as unknown as LedgerFile
}

function ledgerRoot() {
  const root = path.join(projectStateRoot(), "tasks")
  fs.mkdirSync(root, { recursive: true })
  return root
}

function ledgerPath(sessionID: string) {
  return path.join(ledgerRoot(), `${sessionID}.json`)
}

function readLedger(sessionID: string): LedgerFile {
  const file = ledgerPath(sessionID)
  if (!fs.existsSync(file)) {
    ledgerHealth.delete(sessionID)
    return {
      version: 1,
      sessionID,
      nextTimelineSequence: 0,
      tasks: [],
      checkpoints: [],
    }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    const ledger = validateLedger(parsed, sessionID, file)
    ledgerHealth.delete(sessionID)
    return ledger
  } catch (error) {
    const corruption = error instanceof LedgerCorruptionError
      ? error
      : new LedgerCorruptionError("LEDGER_CORRUPT", "ledger JSON is not valid", file)
    const health: LedgerHealth = {
      status: "unavailable",
      code: corruption.code,
      message: corruption.message,
      path: file,
      detectedAt: nowIso(),
    }
    ledgerHealth.set(sessionID, health)
    throw corruption
  }
}

function writeLedger(ledger: LedgerFile) {
  const target = ledgerPath(ledger.sessionID)
  const temporary = `${target}.tmp-${process.pid}-${++writeSequence}`
  const serialized = `${JSON.stringify(ledger, null, 2)}\n`
  try {
    fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 })
    fs.renameSync(temporary, target)
    ledgerHealth.delete(ledger.sessionID)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // Keep the original write error.
    }
    throw error
  }
}

function publishTask(task: RuntimeTaskRecord) {
  Bus.publish(RuntimeEvents.TaskUpdated, {
    sessionID: task.sessionID,
    task,
  })
}

function publishTimeline(event: TaskTimelineEvent) {
  Bus.publish(RuntimeEvents.TimelineEvent, {
    sessionID: event.sessionID,
    event,
  })
}

function updateTask(sessionID: string, taskId: string, updater: (task: RuntimeTaskRecord, ledger: LedgerFile) => void) {
  const ledger = readLedger(sessionID)
  const task = ledger.tasks.find((item) => item.taskId === taskId)
  if (!task) return undefined
  updater(task, ledger)
  task.updatedAt = nowIso()
  writeLedger(ledger)
  publishTask(task)
  return task
}

function inputGraphFromMetadata(action: QueuedSessionAction): InputGraphNode[] {
  const graph = Array.isArray(action.metadata?.inputGraph) ? action.metadata.inputGraph : []
  return graph.filter((item): item is InputGraphNode => {
    if (!item || typeof item !== "object") return false
    const record = item as Record<string, unknown>
    return typeof record.id === "string" && typeof record.type === "string"
  })
}

export namespace RuntimeTaskLedger {
  export function recordQueued(action: QueuedSessionAction) {
    const ledger = readLedger(action.sessionID)
    const createdAt = nowIso()
    const task: RuntimeTaskRecord = {
      taskId: action.id,
      sessionID: action.sessionID,
      actionType: action.type,
      status: "queued",
      priority: action.priority,
      messageID: typeof action.metadata?.messageID === "string" ? action.metadata.messageID : undefined,
      inputGraph: inputGraphFromMetadata(action),
      timeline: [],
      metadata: action.metadata,
      createdAt,
      updatedAt: createdAt,
    }
    ledger.tasks = [...ledger.tasks.filter((item) => item.taskId !== action.id), task].slice(-100)
    ledger.activeTaskId = action.id
    writeLedger(ledger)
    publishTask(task)
    appendEvent({
      sessionID: action.sessionID,
      taskId: action.id,
      kind: "input.accepted",
      message: `${action.type} accepted`,
      metadata: action.metadata,
    })
    return task
  }

  export function recordAnalysisRequest(input: {
    sessionID: string
    taskId: string
    sourceMessageId: string
    kind: AnalysisRequestKind
    researchGoal: string
    constraints: string[]
  }) {
    const ledger = readLedger(input.sessionID)
    const task = ledger.tasks.find((item) => item.taskId === input.taskId && item.sessionID === input.sessionID)
    if (!task) throw new Error("当前任务不存在，无法登记分析请求。")
    if (!task.messageID || task.messageID !== input.sourceMessageId) {
      throw new Error("源用户消息与任务不匹配，无法登记分析请求。")
    }
    if (task.analysisRequest) {
      if (task.analysisRequest.sourceMessageId !== input.sourceMessageId) {
        throw new Error("当前任务已绑定另一条用户消息，拒绝覆盖分析请求。")
      }
      if (!task.analysisLifecycle) {
        task.analysisLifecycle = reduceAnalysisLifecycle(createAnalysisLifecycle(), {
          type: "request_registered",
          requestId: task.analysisRequest.requestId,
          kind: task.analysisRequest.kind,
          sourceMessageId: task.analysisRequest.sourceMessageId,
        })
        task.updatedAt = nowIso()
        writeLedger(ledger)
        publishTask(task)
      }
      return task.analysisRequest
    }
    const researchGoal = input.researchGoal.trim()
    const constraints = input.constraints.map((item) => item.trim()).filter(Boolean).slice(0, 12)
    if (!researchGoal || researchGoal.length > 1000 || constraints.some((item) => item.length > 240)) {
      throw new Error("分析请求摘要或约束超出长度限制。")
    }
    task.analysisRequest = {
      version: 1,
      requestId: `analysis_${crypto.randomUUID()}`,
      sourceMessageId: input.sourceMessageId,
      kind: input.kind,
      researchGoal,
      constraints,
      registeredAt: nowIso(),
    }
    task.analysisLifecycle = reduceAnalysisLifecycle(createAnalysisLifecycle(), {
      type: "request_registered",
      requestId: task.analysisRequest.requestId,
      kind: task.analysisRequest.kind,
      sourceMessageId: task.analysisRequest.sourceMessageId,
    })
    task.updatedAt = task.analysisRequest.registeredAt
    writeLedger(ledger)
    publishTask(task)
    return task.analysisRequest
  }

  export function recordAnalysisSpec(input: {
    sessionID: string
    taskId: string
    requestId: string
    sourceMessageId: string
    methodID: string
    arguments: Record<string, unknown>
    argumentSources: AnalysisSpecRecord["argumentSources"]
    datasetId: string
    stageId: string
    stageFingerprint: string
    registryVersion: number
    schemaVersion: number
    specHash: string
    status: AnalysisSpecStatus
    preflight?: AnalysisSpecPreflight
    preparedAt?: string
  }): { spec: AnalysisSpecRecord; preparedSpec?: PreparedSpecRecord } {
    const ledger = readLedger(input.sessionID)
    const task = ledger.tasks.find((item) => item.taskId === input.taskId && item.sessionID === input.sessionID)
    if (!task) throw new Error("当前任务不存在，无法保存分析规格。")
    if (!task.messageID || task.messageID !== input.sourceMessageId) {
      throw new Error("分析规格的源用户消息与任务不匹配，已拒绝保存。")
    }
    const request = task.analysisRequest
    if (!request || request.requestId !== input.requestId || request.sourceMessageId !== input.sourceMessageId) {
      throw new Error("分析规格没有匹配的 AnalysisRequest，已拒绝保存。")
    }
    if (request.kind !== "estimate" && request.kind !== "inspect") {
      throw new Error("当前请求类型不允许准备计量方法规格。")
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(input.stageFingerprint)) {
      throw new Error("分析规格的数据阶段指纹无效，已拒绝保存。")
    }
    if (!Number.isSafeInteger(input.registryVersion) || input.registryVersion < 1 ||
        !Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
      throw new Error("Python Registry 或方法 Schema 版本无效，已拒绝保存。")
    }
    const serializedArguments = JSON.stringify(input.arguments)
    if (!serializedArguments || Buffer.byteLength(serializedArguments, "utf8") > 32 * 1024) {
      throw new Error("分析规格参数超过账本保存上限，未保存。")
    }
    const argumentFields = Object.keys(input.arguments)
    if (
      argumentFields.some((field) => {
        const source = input.argumentSources[field]
        if (!source) return true
        if (source.kind === "model_interpretation" || source.kind === "user_explicit") {
          return source.sourceMessageId !== input.sourceMessageId
        }
        return source.kind !== "registry_default_or_normalization" ||
          source.registryVersion !== input.registryVersion ||
          source.schemaVersion !== input.schemaVersion
      }) ||
      Object.keys(input.argumentSources).some((field) => !Object.hasOwn(input.arguments, field))
    ) {
      throw new Error("分析规格参数来源与当前用户消息不匹配，已拒绝保存。")
    }

    const history = task.analysisSpecs ?? []
    const latest = history.at(-1)
    if (
      latest?.requestId === input.requestId &&
      latest.specHash === input.specHash &&
      latest.status === input.status &&
      latest.datasetId === input.datasetId &&
      latest.stageId === input.stageId
    ) {
      return {
        spec: latest,
        ...(task.preparedSpec?.specId === latest.specId ? { preparedSpec: task.preparedSpec } : {}),
      }
    }

    const createdAt = nowIso()
    const revision = (latest?.revision ?? 0) + 1
    const specId = `spec_${crypto.randomUUID()}`
    const spec: AnalysisSpecRecord = {
      version: 1,
      specId,
      requestId: input.requestId,
      sourceMessageId: input.sourceMessageId,
      revision,
      methodID: input.methodID,
      arguments: structuredClone(input.arguments),
      argumentSources: structuredClone(input.argumentSources),
      datasetId: input.datasetId,
      stageId: input.stageId,
      stageFingerprint: input.stageFingerprint,
      registryVersion: input.registryVersion,
      schemaVersion: input.schemaVersion,
      specHash: input.specHash,
      status: input.status,
      ...(input.preflight ? { preflight: structuredClone(input.preflight) } : {}),
      createdAt,
    }
    if (JSON.stringify(spec.preflight ?? {}).length > 24 * 1024) {
      throw new Error("分析规格的前置诊断超过账本保存上限，未保存。")
    }

    let preparedSpec: PreparedSpecRecord | undefined
    if (input.status === "ready" || input.status === "preflight_ready") {
      if (!input.preflight?.executable || input.preflight.status !== "ready" ||
          input.preflight.dataFingerprint !== input.stageFingerprint) {
        throw new Error("只有与当前数据指纹一致且 preflight ready 的规格可以记录为就绪。")
      }
      if (input.status === "ready" && request.kind !== "estimate") {
        throw new Error("只有已登记的 estimate 请求可以生成可执行 PreparedSpec。")
      }
      if (input.status === "preflight_ready" && request.kind !== "inspect") {
        throw new Error("只有 inspect 请求可以记录不带执行授权的 preflight 结果。")
      }
    }
    if (input.status === "ready") {
      preparedSpec = {
        version: 1,
        specId,
        requestId: input.requestId,
        sourceMessageId: input.sourceMessageId,
        revision,
        methodID: input.methodID,
        arguments: structuredClone(input.arguments),
        datasetId: input.datasetId,
        stageId: input.stageId,
        stageFingerprint: input.stageFingerprint,
        registryVersion: input.registryVersion,
        schemaVersion: input.schemaVersion,
        specHash: input.specHash,
        preflight: structuredClone(input.preflight!),
        preparedAt: input.preparedAt ?? createdAt,
      }
    }

    task.analysisSpecs = [...history, spec].slice(-20)
    task.preparedSpec = preparedSpec
    task.analysisLifecycle = reduceAnalysisLifecycle(task.analysisLifecycle ?? createAnalysisLifecycle(), {
      type: "spec_assessed",
      requestId: input.requestId,
      specId,
      revision,
      methodID: input.methodID,
      stageFingerprint: input.stageFingerprint,
      status: input.status,
      issueCode: input.preflight?.issues
        .map((issue) => issue.code)
        .find((code): code is string => typeof code === "string"),
    })
    task.updatedAt = createdAt
    writeLedger(ledger)
    publishTask(task)
    return { spec, ...(preparedSpec ? { preparedSpec } : {}) }
  }

  export function recordToolAttempt(input: {
    sessionID: string
    toolName: string
    signature: string
    stageId?: string
    workflowRunId?: string
    kind: "started" | "failed" | "completed"
    errorCode?: string
    maxAttempts?: number
  }) {
    const ledger = readLedger(input.sessionID)
    const taskId = ledger.activeTaskId
    if (!taskId) return { allowed: true, count: 0, max: input.maxAttempts ?? 3 }
    const task = ledger.tasks.find((item) => item.taskId === taskId)
    if (!task) return { allowed: true, count: 0, max: input.maxAttempts ?? 3 }

    const max = input.maxAttempts ?? 3
    const attempts = Array.isArray(task.metadata?.toolAttempts) ? task.metadata.toolAttempts : []
    const matching = attempts.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) &&
        typeof item === "object" &&
        (item as Record<string, unknown>).toolName === input.toolName &&
        (item as Record<string, unknown>).signature === input.signature,
    )
    // 预算针对的是"同一签名反复失败"，不是调用次数：成功执行一次就把该签名的失败清零，
    // 否则 read/todoread/workflow status 这类幂等调用在长任务里会被误判成耗尽额度。
    const lastSuccess = matching.findLastIndex((item) => item.kind === "completed")
    const recentFailures = matching.slice(lastSuccess + 1).filter((item) => item.kind === "failed")
    const count = recentFailures.length
    if (input.kind === "started") {
      const lastFailure = recentFailures.at(-1)
      if (lastFailure && isDeterministicToolFailureCode(typeof lastFailure.errorCode === "string" ? lastFailure.errorCode : undefined)) {
        return { allowed: false, count: 1, max: 1 }
      }
      // 只有 failed/completed 参与计数，"started" 不必落盘：每次工具调用都写一遍整册
      // ledger 只是徒增一次读-改-写，还会把无人读取的记录挤进 200 条上限。
      return { allowed: count < max, count, max }
    }
    task.metadata = {
      ...(task.metadata ?? {}),
      toolAttempts: [
        ...attempts,
        {
          toolName: input.toolName,
          signature: input.signature,
          stageId: input.stageId,
          workflowRunId: input.workflowRunId,
          kind: input.kind,
          errorCode: input.errorCode,
          createdAt: nowIso(),
        },
      ].slice(-200),
    }
    task.updatedAt = nowIso()
    writeLedger(ledger)
    publishTask(task)
    return { allowed: true, count, max }
  }

  export function markStatus(input: {
    sessionID: string
    taskId?: string
    status: RuntimeTaskStatus
    message?: string
    metadata?: Record<string, unknown>
  }) {
    const currentLedger = readLedger(input.sessionID)
    const taskId = input.taskId ?? currentLedger.activeTaskId
    if (!taskId) return undefined
    const currentTask = currentLedger.tasks.find((item) => item.taskId === taskId)
    if (input.status === "completed" && (currentTask?.status === "failed" || currentTask?.status === "cancelled")) {
      return currentTask
    }
    const task = updateTask(input.sessionID, taskId, (draft, ledger) => {
      draft.status = input.status
      if (input.metadata) draft.metadata = { ...(draft.metadata ?? {}), ...input.metadata }
      if (["dispatching", "running", "queued"].includes(input.status)) ledger.activeTaskId = taskId
    })
    if (task) {
      appendEvent({
        sessionID: input.sessionID,
        taskId,
        kind: input.status === "completed" ? "completed" : "query.state",
        message: input.message ?? input.status,
        metadata: input.metadata,
      })
    }
    return task
  }

  type AppendEventInput = {
    sessionID: string
    taskId?: string
    kind: TaskTimelineEventKind
    correlation?: QueryCorrelation
    stageId?: string
    workflowRunId?: string
    compaction?: CompactionLifecycle
    failureDecision?: RuntimeFailureDecision
    message?: string
    metadata?: Record<string, unknown>
  }

  /** 只改内存中的 ledger，不落盘、不广播；调用方负责合并写入，避免同一次操作重复读写文件。 */
  function stageEvent(ledger: LedgerFile, input: AppendEventInput) {
    const taskId = input.taskId ?? ledger.activeTaskId
    if (!taskId) return undefined
    const sequence = ledger.nextTimelineSequence ?? 0
    ledger.nextTimelineSequence = sequence + 1
    const event: TaskTimelineEvent = {
      id: stableId("tle", `${taskId}:${sequence}`),
      sequence,
      taskId,
      sessionID: input.sessionID,
      kind: input.kind,
      correlation: input.correlation,
      stageId: input.stageId,
      workflowRunId: input.workflowRunId,
      compaction: input.compaction,
      failureDecision: input.failureDecision,
      message: input.message,
      metadata: input.metadata,
      createdAt: nowIso(),
    }
    const task = ledger.tasks.find((item) => item.taskId === taskId)
    if (task) {
      task.timeline = [...task.timeline, event].slice(-200)
      task.stageId = input.stageId ?? task.stageId
      task.workflowRunId = input.workflowRunId ?? task.workflowRunId
      if (input.failureDecision) {
        task.latestFailureDecision = input.failureDecision
        if (input.failureDecision.disposition === "stop") {
          task.status = input.failureDecision.category === "user_cancelled" ? "cancelled" : "failed"
        }
      }
      task.updatedAt = event.createdAt
    }
    return { event, task }
  }

  export function transitionAnalysis(input: {
    sessionID: string
    taskId: string
    event: AnalysisLifecycleEvent
  }): AnalysisLifecycleRecord {
    const ledger = readLedger(input.sessionID)
    const task = ledger.tasks.find((item) => item.taskId === input.taskId && item.sessionID === input.sessionID)
    if (!task) throw new Error("当前任务不存在，无法更新分析生命周期。")
    const current = task.analysisLifecycle ?? createAnalysisLifecycle()
    const lifecycle = reduceAnalysisLifecycle(current, input.event)
    task.analysisLifecycle = lifecycle
    const staged = stageEvent(ledger, {
      sessionID: input.sessionID,
      taskId: input.taskId,
      kind: "analysis.lifecycle",
      message: `analysis lifecycle: ${lifecycle.status}`,
      metadata: {
        eventType: input.event.type,
        status: lifecycle.status,
        requestId: lifecycle.requestId,
        specId: lifecycle.specId,
        specRevision: lifecycle.specRevision,
        methodID: lifecycle.methodID,
        issueCode: lifecycle.issueCode,
        failureCode: lifecycle.failureCode,
        resultContractStatus: lifecycle.resultContractStatus,
      },
    })
    task.updatedAt = lifecycle.updatedAt
    writeLedger(ledger)
    if (staged) publishTimeline(staged.event)
    publishTask(task)
    return lifecycle
  }

  export function watchAnalysisToolRunAbort(input: {
    sessionID: string
    taskId: string
    requestId: string
    operationId: string
    signal: AbortSignal
    onError?: (error: unknown) => void
  }) {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      try {
        const task = readLedger(input.sessionID).tasks.find((item) => item.taskId === input.taskId)
        const run = task?.analysisLifecycle?.toolRuns?.find((item) => item.operationId === input.operationId)
        if (run?.status !== "running") return
        transitionAnalysis({
          sessionID: input.sessionID,
          taskId: input.taskId,
          event: {
            type: "tool_run_terminated",
            requestId: input.requestId,
            operationId: input.operationId,
            outcome: "unconfirmed",
            failureCode: "TOOL_ABORTED_UNCONFIRMED",
          },
        })
      } catch (error) {
        input.onError?.(error)
      }
    }
    input.signal.addEventListener("abort", onAbort, { once: true })
    if (input.signal.aborted) onAbort()
    return () => {
      input.signal.removeEventListener("abort", onAbort)
      settled = true
    }
  }

  export function completeAnalysisToolRun(input: {
    sessionID: string
    taskId: string
    signal: AbortSignal
    operation: AnalysisToolRunRecord
    onError?: (error: unknown) => void
  }) {
    if (input.signal.aborted) {
      try {
        const task = readLedger(input.sessionID).tasks.find((item) => item.taskId === input.taskId)
        const run = task?.analysisLifecycle?.toolRuns?.find((item) => item.operationId === input.operation.operationId)
        if (run?.status === "running") {
          transitionAnalysis({
            sessionID: input.sessionID,
            taskId: input.taskId,
            event: {
              type: "tool_run_terminated",
              requestId: input.operation.requestId,
              operationId: input.operation.operationId,
              outcome: "unconfirmed",
              failureCode: "TOOL_ABORTED_UNCONFIRMED",
            },
          })
        } else if (run?.status !== "completed" && run?.status !== "partial") {
          throw new AnalysisLifecycleError("当前工具运行已取消或尚未开始，不能登记迟到结果。")
        }
      } catch (error) {
        input.onError?.(error)
      }
      const latest = readLedger(input.sessionID).tasks
        .find((item) => item.taskId === input.taskId)?.analysisLifecycle?.toolRuns
        ?.find((item) => item.operationId === input.operation.operationId)
      if (latest?.status !== "completed" && latest?.status !== "partial") {
        throw new AnalysisLifecycleError("用户已取消当前工具运行；输出仍为未确认状态，不能登记为成功。")
      }
    }
    return transitionAnalysis({
      sessionID: input.sessionID,
      taskId: input.taskId,
      event: { type: "tool_run_recorded", operation: input.operation },
    })
  }

  export function recordAnalysisVerificationForStage(input: {
    sessionID: string
    stageId: string
    datasetId: string
    methodID?: string
    status: "pass" | "warn" | "block"
  }) {
    const ledger = readLedger(input.sessionID)
    const candidates = ledger.tasks.flatMap((task) =>
      (task.analysisSpecs ?? []).flatMap((spec) => {
        const result = task.analysisLifecycle?.specRuns.find((run) =>
          run.specId === spec.specId &&
          run.requestId === spec.requestId &&
          Boolean(run.resultId) &&
          run.resultContractStatus === "pass" &&
          (!input.methodID || run.methodID === input.methodID),
        )
        const stageMatches = spec.datasetId === input.datasetId &&
          (input.stageId === spec.stageId || input.stageId.startsWith(`${spec.stageId}__`))
        return stageMatches && result ? [{ task, result }] : []
      }),
    ).sort((left, right) => right.result.updatedAt.localeCompare(left.result.updatedAt))
    const candidate = candidates[0]
    if (!candidate?.task.analysisRequest || !candidate.result.resultId) return undefined
    return transitionAnalysis({
      sessionID: input.sessionID,
      taskId: candidate.task.taskId,
      event: {
        type: "verification_completed",
        requestId: candidate.result.requestId,
        specId: candidate.result.specId,
        resultId: candidate.result.resultId,
        status: input.status,
      },
    })
  }

  export function appendEvent(input: AppendEventInput) {
    const ledger = readLedger(input.sessionID)
    const staged = stageEvent(ledger, input)
    if (!staged) return undefined
    writeLedger(ledger)
    publishTimeline(staged.event)
    if (staged.task) publishTask(staged.task)
    return staged.event
  }

  export function appendEventBestEffort(input: Parameters<typeof appendEvent>[0]) {
    try {
      return appendEvent(input)
    } catch {
      // Observability must never block the agent loop when no project instance
      // exists yet or the local ledger directory is temporarily unavailable.
      return undefined
    }
  }

  /**
   * 把子代理会话挂到当前活跃任务上。子代理有自己的 sessionID 和自己的 ledger 文件，
   * 这里只记录"谁派生了它"，不会把父任务当成它自己的父节点。
   */
  export function linkChildTask(input: { sessionID: string; taskId?: string; childSessionID: string }) {
    try {
      const taskId = input.taskId ?? readLedger(input.sessionID).activeTaskId
      if (!taskId) return undefined
      return updateTask(input.sessionID, taskId, (task) => {
        task.childSessionID = input.childSessionID
        task.metadata = {
          ...(task.metadata ?? {}),
          childSessionID: input.childSessionID,
        }
      })
    } catch {
      // 与 appendEventBestEffort 同理：子代理关联只是可观测性，不能阻断工具执行。
      return undefined
    }
  }

  /**
   * 子代理结束只写父任务时间线。父轮次此时通常还在执行中，用子代理的结果去改父任务
   * 状态会把仍在跑的任务标成终态。
   */
  export function recordChildTaskOutcome(input: {
    sessionID: string
    childSessionID: string
    status: Extract<RuntimeTaskStatus, "completed" | "failed" | "cancelled">
    result?: Record<string, unknown>
  }) {
    return appendEventBestEffort({
      sessionID: input.sessionID,
      kind: "agent.control",
      message: `subagent ${input.status}`,
      metadata: {
        childSessionID: input.childSessionID,
        status: input.status,
        ...(input.result ?? {}),
      },
    })
  }

  export function latestContextSnapshot(sessionID: string): ContextManagerSnapshot | undefined {
    const ledger = readLedger(sessionID)
    for (const task of [...ledger.tasks].reverse()) {
      const snapshot = task.metadata?.latestContextSnapshot
      if (!snapshot || typeof snapshot !== "object") continue
      return snapshot as ContextManagerSnapshot
    }
    return undefined
  }

  export function recordCacheObservation(input: {
    sessionID: string
    correlation: QueryCorrelation
    fingerprint: Record<string, unknown>
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    breakReason?: string
  }) {
    return appendEventBestEffort({
      sessionID: input.sessionID,
      kind: "model.request",
      correlation: input.correlation,
      message: "cache observation",
      metadata: {
        fingerprint: input.fingerprint,
        tokens: input.tokens,
        cacheHitRatio: cacheHitRatio(input.tokens),
        breakReason: input.breakReason,
      },
    })
  }

  export function cacheHitRatio(tokens: { input: number; cache: { read: number; write: number } }) {
    const total = tokens.input + tokens.cache.read + tokens.cache.write
    return total > 0 ? tokens.cache.read / total : 0
  }

  export function latestCacheObservation(sessionID: string) {
    const ledger = readLedger(sessionID)
    for (const task of [...ledger.tasks].reverse()) {
      for (const event of [...task.timeline].reverse()) {
        if (event.kind !== "model.request" || event.message !== "cache observation") continue
        const metadata = event.metadata
        if (!metadata || typeof metadata !== "object") continue
        const fingerprint = metadata.fingerprint
        const tokens = metadata.tokens
        if (!fingerprint || typeof fingerprint !== "object" || !tokens || typeof tokens !== "object") continue
        return {
          fingerprint: fingerprint as Record<string, unknown>,
          tokens: tokens as {
            input: number
            output: number
            reasoning: number
            cache: { read: number; write: number }
          },
        }
      }
    }
    return undefined
  }

  export type CacheObservation = {
    createdAt: string
    fingerprint: Record<string, unknown>
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    cacheHitRatio: number
    breakReason?: string
  }

  export function cacheObservations(sessionID: string, limit = 50, source?: LedgerFile): CacheObservation[] {
    const ledger = source ?? readLedger(sessionID)
    const result: CacheObservation[] = []
    for (const task of ledger.tasks) {
      for (const event of task.timeline) {
        if (event.kind !== "model.request" || event.message !== "cache observation") continue
        const metadata = event.metadata
        if (!metadata || typeof metadata !== "object") continue
        const fingerprint = metadata.fingerprint
        const tokens = metadata.tokens
        if (!fingerprint || typeof fingerprint !== "object" || !tokens || typeof tokens !== "object") continue
        const raw = tokens as CacheObservation["tokens"]
        result.push({
          createdAt: event.createdAt,
          fingerprint: fingerprint as Record<string, unknown>,
          tokens: raw,
          cacheHitRatio: typeof metadata.cacheHitRatio === "number" ? metadata.cacheHitRatio : cacheHitRatio(raw),
          breakReason: typeof metadata.breakReason === "string" ? metadata.breakReason : undefined,
        })
      }
    }
    if (limit <= 0) return []
    return result.slice(-limit)
  }

  export function cacheReport(sessionID: string, limit = 50, source?: LedgerFile) {
    const observations = cacheObservations(sessionID, limit + 1, source)
    const truncated = observations.length > limit
    const window = truncated ? observations.slice(-limit) : observations
    const breakReasons: Record<string, number> = {}
    let uncachedInputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let breakCount = 0
    for (const observation of window) {
      uncachedInputTokens += observation.tokens.input
      cacheReadTokens += observation.tokens.cache.read
      cacheWriteTokens += observation.tokens.cache.write
      if (observation.breakReason && observation.breakReason !== "first_request") {
        breakCount += 1
        breakReasons[observation.breakReason] = (breakReasons[observation.breakReason] ?? 0) + 1
      }
    }
    const promptTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
    return {
      observationCount: window.length,
      truncated,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      promptTokens,
      hitRatio: promptTokens > 0 ? cacheReadTokens / promptTokens : 0,
      breakCount,
      breakReasons,
      lastBreakReason: window.findLast((item) => item.breakReason && item.breakReason !== "first_request")?.breakReason,
      updatedAt: window.at(-1)?.createdAt ?? new Date(0).toISOString(),
    }
  }

  export function recordPolicyDecision(sessionID: string, decision: ExecPolicyDecision) {
    const ledger = readLedger(sessionID)
    const taskId = ledger.activeTaskId
    if (taskId) {
      const task = ledger.tasks.find((item) => item.taskId === taskId)
      if (task) {
        task.policyDecisions = [...(task.policyDecisions ?? []), decision].slice(-50)
        task.audit = [
          ...(task.audit ?? []),
          {
            kind: "exec_policy",
            decisionId: decision.decisionId,
            action: decision.action,
            reason: decision.reason,
            createdAt: decision.createdAt,
          },
        ].slice(-100)
        task.updatedAt = nowIso()
      }
      writeLedger(ledger)
      if (task) publishTask(task)
    }
    appendEvent({
      sessionID,
      taskId,
      kind: "policy.decision",
      message: `${decision.toolName}: ${decision.action}`,
      metadata: { decision },
    })
  }

  export function recordContextSnapshot(sessionID: string, snapshot: ContextManagerSnapshot, source?: LedgerFile) {
    const ledger = source ?? readLedger(sessionID)
    const taskId = ledger.activeTaskId
    const task = taskId ? ledger.tasks.find((item) => item.taskId === taskId) : undefined
    if (task) {
      task.contextVersion = snapshot.historyVersion
      task.metadata = {
        ...(task.metadata ?? {}),
        latestContextSnapshot: snapshot,
      }
      task.updatedAt = nowIso()
    }
    const staged = stageEvent(ledger, {
      sessionID,
      taskId,
      kind: "context.snapshot",
      message: `context v${snapshot.historyVersion}`,
      metadata: { snapshot },
    })
    if (!task && !staged) return
    writeLedger(ledger)
    if (task) publishTask(task)
    if (staged) publishTimeline(staged.event)
  }

  export function createCheckpoint(input: Omit<RuntimeCheckpoint, "checkpointId" | "createdAt">) {
    const ledger = readLedger(input.sessionID)
    const createdAt = nowIso()
    const checkpoint: RuntimeCheckpoint = {
      ...input,
      checkpointId: stableId(
        "chk",
        `${input.sessionID}:${input.workflowRunId ?? ""}:${input.stageId ?? ""}:${createdAt}`,
      ),
      createdAt,
    }
    ledger.checkpoints = [...ledger.checkpoints, checkpoint].slice(-50)
    if (input.taskId) {
      const task = ledger.tasks.find((item) => item.taskId === input.taskId)
      if (task) {
        task.latestCheckpointId = checkpoint.checkpointId
        task.updatedAt = createdAt
      }
    }
    ledger.activeTaskId = input.taskId ?? ledger.activeTaskId
    writeLedger(ledger)
    Bus.publish(RuntimeEvents.CheckpointCreated, {
      sessionID: input.sessionID,
      checkpoint,
    })
    appendEvent({
      sessionID: input.sessionID,
      taskId: input.taskId,
      kind: "checkpoint",
      stageId: input.stageId,
      workflowRunId: input.workflowRunId,
      message: "workflow checkpoint created",
    })
    return checkpoint
  }

  export function resolveRestoreTarget(sessionID: string, target: RestoreTarget = {}) {
    const ledger = readLedger(sessionID)
    const checkpoint = [...ledger.checkpoints].reverse().find((item) => {
      if (target.checkpointId) return item.checkpointId === target.checkpointId
      if (target.stageId) return item.stageId === target.stageId
      return item.verifierStatus !== "block"
    })
    return {
      ledger,
      checkpoint,
    }
  }

  export function recordRestore(sessionID: string, checkpoint: RuntimeCheckpoint, taskId?: string) {
    const ledger = readLedger(sessionID)
    const activeTaskId = taskId ?? ledger.activeTaskId
    if (activeTaskId) {
      const task = ledger.tasks.find((item) => item.taskId === activeTaskId)
      if (task) {
        task.status = "restored"
        task.latestCheckpointId = checkpoint.checkpointId
        task.stageId = checkpoint.stageId ?? task.stageId
        task.workflowRunId = checkpoint.workflowRunId ?? task.workflowRunId
        task.updatedAt = nowIso()
      }
    }
    writeLedger(ledger)
    Bus.publish(RuntimeEvents.RestoreCompleted, {
      sessionID,
      checkpoint,
      restoredTaskId: activeTaskId,
    })
    appendEvent({
      sessionID,
      taskId: activeTaskId,
      kind: "restore",
      stageId: checkpoint.stageId,
      workflowRunId: checkpoint.workflowRunId,
      message: "workflow restored from checkpoint",
      metadata: { checkpointId: checkpoint.checkpointId },
    })
  }

  export function health(sessionID: string): LedgerHealth | undefined {
    return ledgerHealth.get(sessionID)
  }

  export function consecutiveCompactionFallbacks(sessionID: string) {
    const ledger = readLedger(sessionID)
    const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
    if (!task) return 0
    let count = 0
    for (let index = task.timeline.length - 1; index >= 0; index -= 1) {
      const event = task.timeline[index]
      if (event.kind !== "compaction" || event.compaction?.status !== "completed") continue
      if (event.compaction.reason === "manual") continue
      if (event.compaction.summarySource === "fallback") {
        count += 1
        continue
      }
      if (event.compaction.summarySource === "model") break
    }
    return count
  }

  export function listTasks(sessionID: string) {
    return readLedger(sessionID)
  }
}
