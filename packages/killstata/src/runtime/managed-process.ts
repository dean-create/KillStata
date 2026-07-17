import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import { Log } from "@/util/log"
import { Shell } from "@/shell/shell"

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const TERMINATION_GRACE_MS = 250
const log = Log.create({ service: "managed-process" })

const SAFE_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "OPENBLAS_NUM_THREADS",
  "OMP_NUM_THREADS",
  "MKL_NUM_THREADS",
])

const SENSITIVE_ENV_NAME = /(api.?key|token|secret|password|authorization|cookie)/i

export type ManagedProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
}

export function summarizeManagedProcess(result: ManagedProcessResult) {
  return {
    exitCode: result.code,
    signal: result.signal,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  }
}

export class ManagedProcessError extends Error {
  constructor(
    public readonly code: "PROCESS_TIMEOUT" | "PROCESS_ABORTED" | "PROCESS_CWD_DENIED" | "PROCESS_COMMAND_DENIED" | "PROCESS_SPAWN_FAILED",
    message: string,
    public readonly timeoutMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ManagedProcessError"
  }
}

class TailCapture {
  private chunks: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  bytes = 0

  constructor(private readonly limit: number) {}

  append(chunk: Buffer | string) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.bytes += next.byteLength
    if (next.byteLength >= this.limit) {
      this.chunks = next.subarray(next.byteLength - this.limit)
      return
    }
    const combined = Buffer.concat([this.chunks, next])
    this.chunks = combined.byteLength > this.limit ? combined.subarray(combined.byteLength - this.limit) : combined
  }

  get truncated() {
    return this.bytes > this.chunks.byteLength
  }

  text() {
    return this.chunks.toString("utf-8")
  }
}

function buildChildEnvironment(overrides: NodeJS.ProcessEnv | undefined) {
  const env: Record<string, string> = {}
  for (const name of SAFE_ENV_NAMES) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === undefined || SENSITIVE_ENV_NAME.test(name)) continue
    env[name] = value
  }
  return env
}

function assertExecutionPolicy(input: {
  command: string
  allowedCommands: readonly string[]
  cwd: string
  allowedCwdRoot: string
}) {
  if (!input.allowedCommands.includes(input.command)) {
    throw new ManagedProcessError("PROCESS_COMMAND_DENIED", "Harness 拒绝执行未登记的后端命令")
  }

  let cwd: string
  let root: string
  try {
    cwd = fs.realpathSync(input.cwd)
    root = fs.realpathSync(input.allowedCwdRoot)
  } catch (error) {
    throw new ManagedProcessError("PROCESS_CWD_DENIED", "Harness 找不到允许的分析工作目录", undefined, {
      cause: error,
    })
  }
  const relative = path.relative(root, cwd)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ManagedProcessError("PROCESS_CWD_DENIED", "Harness 拒绝在项目目录之外启动分析后端")
  }
}

export async function runManagedProcess(input: {
  command: string
  allowedCommands: readonly string[]
  args: string[]
  cwd: string
  allowedCwdRoot: string
  stdin?: string
  env?: NodeJS.ProcessEnv
  abort?: AbortSignal
  timeoutMs: number
  maxOutputBytes?: number
}): Promise<ManagedProcessResult> {
  assertExecutionPolicy(input)
  if (input.abort?.aborted) {
    throw new ManagedProcessError("PROCESS_ABORTED", "计量工具已由用户取消")
  }
  const maxOutputBytes = Math.max(1, Math.floor(input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES))
  const startedAt = Date.now()

  return new Promise<ManagedProcessResult>((resolve, reject) => {
    const stdout = new TailCapture(maxOutputBytes)
    const stderr = new TailCapture(maxOutputBytes)
    let termination: "timeout" | "abort" | undefined
    let terminationTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const proc = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: buildChildEnvironment(input.env),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const cleanup = () => {
      clearTimeout(timeoutTimer)
      if (terminationTimer) clearTimeout(terminationTimer)
      input.abort?.removeEventListener("abort", abortHandler)
    }
    const forceKill = () => {
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL")
        else proc.kill("SIGKILL")
      } catch {
        proc.kill("SIGKILL")
      }
    }
    const rejectTermination = () => {
      if (settled || !termination) return
      settled = true
      cleanup()
      proc.stdin?.destroy()
      proc.stdout?.destroy()
      proc.stderr?.destroy()
      if (termination === "timeout") {
        log.warn("process timeout", { timeoutMs: input.timeoutMs, durationMs: Date.now() - startedAt })
        reject(new ManagedProcessError("PROCESS_TIMEOUT", `计量分析超过 ${input.timeoutMs}ms，Harness 已终止后端进程`, input.timeoutMs))
        return
      }
      log.info("process aborted", { durationMs: Date.now() - startedAt })
      reject(new ManagedProcessError("PROCESS_ABORTED", "计量工具已由用户取消"))
    }
    const terminate = (reason: "timeout" | "abort") => {
      if (termination || settled) return
      termination = reason
      void Shell.killTree(proc, { exited: () => settled }).catch(() => {}).finally(() => {
        if (!settled) forceKill()
      })
      terminationTimer = setTimeout(() => {
        forceKill()
        rejectTermination()
      }, TERMINATION_GRACE_MS)
      terminationTimer.unref?.()
    }
    const abortHandler = () => terminate("abort")
    const timeoutTimer = setTimeout(() => terminate("timeout"), input.timeoutMs)
    timeoutTimer.unref?.()

    proc.stdout?.on("data", (chunk) => stdout.append(chunk))
    proc.stderr?.on("data", (chunk) => stderr.append(chunk))
    proc.stdin?.on("error", () => {})
    input.abort?.addEventListener("abort", abortHandler, { once: true })
    // AbortSignal 不会为迟到的 listener 重放事件，因此注册后必须复查一次。
    if (input.abort?.aborted) terminate("abort")

    proc.once("error", (error) => {
      if (settled) return
      if (termination) {
        rejectTermination()
        return
      }
      settled = true
      cleanup()
      reject(new ManagedProcessError("PROCESS_SPAWN_FAILED", `无法启动计量分析后端：${error.message}`, undefined, { cause: error }))
    })
    proc.once("close", (code, signal) => {
      if (settled) return
      if (termination) {
        rejectTermination()
        return
      }
      settled = true
      cleanup()
      const result = {
        code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - startedAt,
      }
      log.info("process finished", summarizeManagedProcess(result))
      resolve(result)
    })

    proc.stdin?.end(input.stdin ?? "")
  })
}
