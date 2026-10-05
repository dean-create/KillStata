import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import readline from "node:readline"
import path from "node:path"
import { buildChildEnvironment } from "../managed-process"
import { Instance } from "@/project/instance"

export type EngineOperation = "health" | "catalog" | "search" | "describe" | "validate" | "preflight" | "execute"
export type EngineRequestPayload = Record<string, unknown>

export type EngineErrorBody = {
  code: string
  message_zh: string
  retryable?: boolean
  method_id?: string | null
  field?: string | null
  details?: Record<string, unknown>
}

export type EngineProgressFrame = {
  requestID: string
  sequence: number
  event: Record<string, unknown>
}

export type EnginePreflightResult = {
  method_id: string
  executable: boolean
  status: "ready" | "repairable" | "requires_user_decision" | "incompatible"
  normalized_arguments: Record<string, unknown>
  data_fingerprint: string
  issues: Array<Record<string, unknown>>
  repair_plan: Array<Record<string, unknown>>
}

export type EngineValidationResult = {
  registry_version: number
  method_id: string
  arguments: Record<string, unknown>
}

type EngineResponse = {
  protocol_version: number
  request_id: string
  type?: "progress" | "result" | "error"
  sequence?: number
  event?: Record<string, unknown>
  ok: boolean
  result?: Record<string, unknown>
  error?: EngineErrorBody
}

export class EconometricsEngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = "EconometricsEngineError"
  }
}

type PendingRequest = {
  resolve: (result: Record<string, unknown>) => void
  reject: (error: EconometricsEngineError) => void
  timer: ReturnType<typeof setTimeout>
  abort?: () => void
  lastProgressSequence: number
}

const MAX_ENGINE_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ENGINE_STDERR_BYTES = 8 * 1024

function terminateEngineProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = "SIGTERM") {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // 进程组可能已经退出，退回到单进程清理。
    }
  }
  child.kill(signal)
}

function waitForEngineProcessExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const escalation = setTimeout(() => terminateEngineProcess(child, "SIGKILL"), 500)
    child.once("close", () => {
      clearTimeout(escalation)
      resolve()
    })
  })
}

export type EconometricsEngineClientOptions = {
  command: string
  cwd: string
  pythonPath: string
  methodRoot?: string
  timeoutMs?: number
  onProgress?: (frame: EngineProgressFrame) => void
}

/**
 * 长驻 Python 引擎客户端。请求在 TypeScript 侧串行排队，Python stdout 只承载 JSONL；
 * 进程崩溃、超时和取消都会清理当前请求，后续请求从新进程开始，避免复用半完成状态。
 */
export class EconometricsEngineClient {
  private readonly options: EconometricsEngineClientOptions
  private process?: ChildProcessWithoutNullStreams
  private lines?: readline.Interface
  private sequence = 0
  private closed = false
  private queue: Promise<unknown> = Promise.resolve()
  private pending = new Map<string, PendingRequest>()
  private stopping?: Promise<void>
  private healthResult?: Promise<{ registry_version: number; method_count: number }>
  private catalogResult?: Promise<{ registry_version: number; methods: Array<Record<string, unknown>> }>
  private stderrTail = ""

  constructor(options: EconometricsEngineClientOptions) {
    this.options = { ...options, cwd: path.resolve(options.cwd), pythonPath: path.resolve(options.pythonPath) }
  }

  setProgressHandler(handler: EconometricsEngineClientOptions["onProgress"]) {
    this.options.onProgress = handler
  }

  request<T extends Record<string, unknown> = Record<string, unknown>>(
    operation: EngineOperation,
    payload: EngineRequestPayload = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const run = this.queue.then(() => this.runRequest<T>(operation, payload, signal))
    this.queue = run.catch(() => undefined)
    return run
  }

  health(signal?: AbortSignal) {
    if (!this.healthResult) {
      this.healthResult = this.request<{ registry_version: number; method_count: number }>("health", {}, signal)
        .catch((error) => {
          this.healthResult = undefined
          throw error
        })
    }
    return this.healthResult
  }

  catalog(signal?: AbortSignal) {
    if (!this.catalogResult) {
      this.catalogResult = this.request<{ registry_version: number; methods: Array<Record<string, unknown>> }>("catalog", {}, signal)
        .catch((error) => {
          this.catalogResult = undefined
          throw error
        })
    }
    return this.catalogResult
  }

  search(input: { query: string; limit?: number }, signal?: AbortSignal) {
    return this.request<{ methods: Array<Record<string, unknown>> }>("search", input, signal)
  }

  describe(methodID: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("describe", { method_id: methodID }, signal)
  }

  validate(
    methodID: string,
    arguments_: Record<string, unknown>,
    options: { runtime?: Record<string, unknown>; signal?: AbortSignal } = {},
  ) {
    return this.request<EngineValidationResult>("validate", {
      method_id: methodID,
      arguments: arguments_,
      ...(options.runtime ? { runtime: options.runtime } : {}),
    }, options.signal)
  }

  preflight(payload: { method_id: string; data_path: string; arguments: Record<string, unknown>; runtime?: Record<string, unknown> }, signal?: AbortSignal) {
    return this.request<EnginePreflightResult>("preflight", payload, signal)
  }

  execute(payload: {
    method_id: string
    data_path: string
    output_dir: string
    arguments: Record<string, unknown>
    runtime?: Record<string, unknown>
    expected_data_fingerprint?: string
  }, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("execute", payload, signal)
  }

  async close() {
    this.closed = true
    await this.restart("ENGINE_CLOSED", "计量引擎已关闭。")
  }

  private async runRequest<T extends Record<string, unknown>>(
    operation: EngineOperation,
    payload: EngineRequestPayload,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new EconometricsEngineError("ENGINE_ABORTED", "计量引擎请求已取消。")
    if (this.closed) throw new EconometricsEngineError("ENGINE_CLOSED", "计量引擎已关闭。")
    const child = this.ensureProcess()
    const requestID = `engine_${++this.sequence}`
    const request = JSON.stringify({
      protocol_version: 2,
      request_id: requestID,
      operation,
      stream_progress: true,
      payload,
    })

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.restart("ENGINE_TIMEOUT", "计量引擎响应超时，已重新启动引擎。")
      }, this.options.timeoutMs ?? 300_000)
      const pending: PendingRequest = {
        resolve: (result) => resolve(result as T),
        reject,
        timer,
        lastProgressSequence: 0,
      }
      const abort = () => {
        if (!this.pending.has(requestID)) return
        this.restart("ENGINE_ABORTED", "计量引擎请求已取消。")
      }
      pending.abort = abort
      this.pending.set(requestID, pending)
      signal?.addEventListener("abort", abort, { once: true })
      child.stdin.write(`${request}\n`, (error) => {
        if (!error) return
        this.pending.delete(requestID)
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        reject(new EconometricsEngineError("ENGINE_WRITE_FAILED", `无法向计量引擎发送请求：${error.message}`))
      })
    })
  }

  private ensureProcess() {
    if (this.process) return this.process
    const env = buildChildEnvironment({
      PYTHONPATH: this.options.pythonPath,
      ...(this.options.methodRoot ? { KILLSTATA_ENGINE_METHOD_ROOT: this.options.methodRoot } : {}),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    })
    const child = spawn(this.options.command, ["-u", "-m", "killstata_econometrics_engine"], {
      cwd: this.options.cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.process = child
    this.lines = readline.createInterface({ input: child.stdout })
    this.lines.on("line", (line) => this.handleLine(line))
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`
      if (Buffer.byteLength(this.stderrTail, "utf8") > MAX_ENGINE_STDERR_BYTES) {
        this.stderrTail = this.stderrTail.slice(-MAX_ENGINE_STDERR_BYTES)
      }
    })
    child.on("error", (error) => this.restart("ENGINE_SPAWN_FAILED", `无法启动计量引擎：${error.message}`))
    child.on("close", () => {
      if (this.process !== child) return
      this.process = undefined
      this.lines?.close()
      this.lines = undefined
      this.rejectPending(
        "ENGINE_CRASHED",
        "计量引擎意外退出，未返回结构化结果。",
        this.stderrTail ? { stderr: this.stderrTail } : undefined,
      )
    })
    return child
  }

  private handleLine(line: string) {
    if (!line.trim()) return
    if (Buffer.byteLength(line, "utf8") > MAX_ENGINE_RESPONSE_BYTES) {
      this.restart("ENGINE_RESPONSE_TOO_LARGE", "计量引擎响应超过安全大小限制。")
      return
    }
    let response: EngineResponse
    try {
      response = JSON.parse(line) as EngineResponse
    } catch {
      this.restart("ENGINE_INVALID_RESPONSE", "计量引擎返回了无法解析的响应。")
      return
    }
    const pending = this.pending.get(response.request_id)
    if (!pending) return
    if (response.type === "progress") {
      const sequence = response.sequence
      if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence <= pending.lastProgressSequence || !response.event) {
        this.restart("ENGINE_INVALID_PROGRESS", "计量引擎进度帧顺序无效，已重新启动引擎。")
        return
      }
      pending.lastProgressSequence = sequence
      this.options.onProgress?.({
        requestID: response.request_id,
        sequence,
        event: response.event,
      })
      return
    }
    this.pending.delete(response.request_id)
    clearTimeout(pending.timer)
    if (response.ok && response.result) {
      pending.resolve(response.result)
      return
    }
    const error = response.error
    pending.reject(new EconometricsEngineError(
      error?.code ?? "ENGINE_REQUEST_FAILED",
      error?.message_zh ?? "计量引擎请求失败。",
      {
        ...(error?.details ?? {}),
        ...(error?.method_id ? { method_id: error.method_id } : {}),
        ...(error?.field ? { field: error.field } : {}),
      },
      error?.retryable === true,
    ))
  }

  private rejectPending(code: string, message: string, details?: Record<string, unknown>) {
    for (const [requestID, pending] of this.pending) {
      this.pending.delete(requestID)
      clearTimeout(pending.timer)
      pending.reject(new EconometricsEngineError(code, message, details))
    }
  }

  private restart(code: string, message: string) {
    const child = this.process
    this.process = undefined
    this.lines?.close()
    this.lines = undefined
    const stderr = this.stderrTail
    this.stderrTail = ""
    this.healthResult = undefined
    this.catalogResult = undefined
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) clearTimeout(request.timer)
    const rejectPending = () => {
      for (const request of pending) {
        request.reject(new EconometricsEngineError(code, message, stderr ? { stderr } : undefined))
      }
    }
    if (!child) {
      rejectPending()
      return this.stopping ?? Promise.resolve()
    }
    const processExit = waitForEngineProcessExit(child)
    terminateEngineProcess(child)
    const stopping = processExit.then(() => {
      rejectPending()
      if (this.stopping === stopping) this.stopping = undefined
    })
    this.stopping = stopping
    return stopping
  }
}

const sessionClients = Instance.state(
  () => new Map<string, EconometricsEngineClient>(),
  async (clients) => {
    await Promise.all([...clients.values()].map((client) => client.close()))
  },
)

/** 同一项目实例内按 session 复用长驻引擎；Instance.dispose 会统一关闭所有子进程。 */
export function sessionEconometricsEngine(
  sessionID: string,
  options: EconometricsEngineClientOptions,
) {
  const clients = sessionClients()
  const existing = clients.get(sessionID)
  if (existing) {
    if (options.onProgress) existing.setProgressHandler(options.onProgress)
    return existing
  }
  const created = new EconometricsEngineClient(options)
  clients.set(sessionID, created)
  return created
}
