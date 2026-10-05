import fs from "fs"
import path from "path"
import { Bus } from "@/bus"
import { RuntimeEvents } from "@/runtime/events"
import { RuntimeHooks } from "./hooks"
import type {
  InputAcceptedHook,
  PostToolFailureHook,
  PostToolHook,
  PreToolHook,
  TurnFinishedHook,
} from "./hooks"
import { Session } from "@/session"
import { Log } from "@/util/log"
import {
  prepareToolMetadata,
  prepareToolOutput,
  stripProjectRoots,
  summarizeToolError,
} from "./tool-result-policy"

/**
 * 每会话工具调用闭环 JSONL 日志（cwd/test/sandbox/logs/<sessionID>.jsonl）。
 *
 * 目的：排查 bug 时能快速看到"一次对话里模型对工具的完整调用链"——dev.log 只记
 * lifecycle 元组，没有 args/result/error/路径；本日志把 pre/post/fail + 会话边界
 * 按 session 分文件落盘，便于 jq + 编辑器联合排查。
 *
 * 设计约束（踩过的坑）：
 * - **不能静态 import Instance**（PROGRESS 第七轮：静态边让 Log.create 变 undefined）：
 *   目录解析用 process.cwd()，会话目录从 Session.Event.Created 的 info.directory 取。
 * - **hook 实现绝不返回 LifecycleHookResult**：hooks.ts 用 Promise.all 收集，
 *   任何 reject 会冒泡到主流程工具调用。这里每步 try/catch，写失败只禁本 session。
 * - **hook 必须是命名函数（固定引用）**：RuntimeHooks.register 用 includes 去重，
 *   匿名 lambda 引用每次不同，register 多调一次就多一份订阅（测试暴露：同一 call
 *   被写 3 行）。命名引用 + includes 保证幂等。
 * - **写失败禁用而非重试**：Bun.file.writer 一旦抛错，重试只会风暴，直接 dead 标记。
 */
export namespace TraceLogger {
  const log = Log.create({ service: "trace" })

  export interface Options {
    /** 将本次配置绑定到会话，避免同进程多项目时首个 session 的目录污染后续 session。 */
    sessionID?: string
    /** 总开关；默认 true。环境变量 KILLSTATA_TRACE_LOGGER=0 可关。 */
    enabled?: boolean
    /** 覆盖日志目录；默认 <cwd>/test/sandbox/logs。环境变量可改。 */
    dirOverride?: string
    /** LRU 文件上限（默认 20）。 */
    maxFiles?: number
    /** 单文件软上限字节（默认 50 MiB）；超限禁用该 session 后续写入并告警。 */
    maxFileBytes?: number
    /** 单行字节上限（默认 256 KiB）；超限降级为大字段省略。 */
    maxLineBytes?: number
  }

  let registered = false
  let enabled = true
  let logsDir = path.join(process.cwd(), "test", "sandbox", "logs")
  let maxFiles = 20
  let maxFileBytes = 50 * 1024 * 1024
  let maxLineBytes = 256 * 1024

  interface SessionWriter {
    file: string
    sink: { write(data: string): number; flush(): void; end(): void }
    bytes: number
    dead: boolean
  }
  interface SessionConfig {
    enabled: boolean
    logsDir: string
    maxFiles: number
    maxFileBytes: number
    maxLineBytes: number
  }
  const writers = new Map<string, SessionWriter>()
  const sessionConfigs = new Map<string, SessionConfig>()
  const lruOrder: string[] = []
  const sessionDirs = new Map<string, string>()
  const startTimes = new Map<string, { start: number; sessionID: string }>()

  // Bus 订阅去重：Bus.subscribe 没有 includes 防护，测试多轮 register 会重复订阅
  //（unsubscribe 需要 instance context，测试环境不可用，所以用标志而非 unsub）。
  let busSubscribed = false

  export function register(options: Options = {}) {
    const envValue = process.env.KILLSTATA_TRACE_LOGGER
    const resolvedEnabled = options.enabled ?? !(envValue === "0" || envValue === "false")
    const envDir = envValue && envValue !== "0" && envValue !== "false" ? envValue : undefined
    const config: SessionConfig = {
      enabled: resolvedEnabled,
      logsDir: path.resolve(options.dirOverride ?? envDir ?? path.join(process.cwd(), "test", "sandbox", "logs")),
      maxFiles: options.maxFiles ?? 20,
      maxFileBytes: options.maxFileBytes ?? 50 * 1024 * 1024,
      maxLineBytes: options.maxLineBytes ?? 256 * 1024,
    }
    if (options.sessionID) {
      sessionConfigs.set(options.sessionID, config)
      // 首次配置同时作为尚未显式绑定 session 的兼容默认值（例如 session.created
      // 先于 processor.register 到达）；后续会话只写自己的绑定，不覆盖该默认值。
      if (!registered) {
        enabled = config.enabled
        logsDir = config.logsDir
        maxFiles = config.maxFiles
        maxFileBytes = config.maxFileBytes
        maxLineBytes = config.maxLineBytes
      }
    } else {
      enabled = config.enabled
      logsDir = config.logsDir
      maxFiles = config.maxFiles
      maxFileBytes = config.maxFileBytes
      maxLineBytes = config.maxLineBytes
    }

    if (!config.enabled) return
    try {
      fs.mkdirSync(config.logsDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      log.warn("trace logs dir create failed", { dir: config.logsDir, error: String(error) })
      config.enabled = false
      return
    }

    if (options.sessionID) rebindSessionWriter(options.sessionID, config)

    if (registered) return
    registered = true

    // 工具闭环 hook：命名函数引用，RuntimeHooks 的 includes 保证不重复注册。
    // 所有回调只做 fire-and-forget 写入，绝不抛给调用方。
    RuntimeHooks.registerPreTool(onPreTool)
    RuntimeHooks.registerPostTool(onPostTool)
    RuntimeHooks.registerPostToolFailure(onPostToolFailure)
    RuntimeHooks.registerTurnFinished(onTurnFinished)
    RuntimeHooks.registerInputAccepted(onInputAccepted)

    if (!busSubscribed) {
      busSubscribed = true
      Bus.subscribe(Session.Event.Created, onSessionCreated)
      Bus.subscribe(Session.Event.Error, onSessionError)
      Bus.subscribe(RuntimeEvents.ToolLifecycle, onToolLifecycle)
    }

    log.info("trace logger registered", { dir: config.logsDir, maxFiles: config.maxFiles })
  }

  /** 关掉全部 writer（进程退出前调用；未调用也安全，OS 会回收）。 */
  export function shutdown() {
    for (const writer of writers.values()) {
      try {
        writer.sink.end()
      } catch {}
    }
    writers.clear()
    lruOrder.length = 0
    startTimes.clear()
    sessionConfigs.clear()
  }

  /** 仅测试用：复位注册标志与 writer 状态，让 register 可带新配置重跑。 */
  export function resetForTests() {
    shutdown()
    registered = false
    enabled = true
    logsDir = path.join(process.cwd(), "test", "sandbox", "logs")
    maxFiles = 20
    maxFileBytes = 50 * 1024 * 1024
    maxLineBytes = 256 * 1024
    sessionDirs.clear()
  }

  /** 当前日志目录（测试断言用）。 */
  export function logsDirPath(sessionID?: string) {
    return sessionID ? configFor(sessionID).logsDir : logsDir
  }

  /** 读回一个会话的日志行（解析失败的行以 _parseError 占位，不丢原始内容）。 */
  export function readSession(sessionID: string): Array<Record<string, unknown>> {
    const file = path.join(configFor(sessionID).logsDir, `${sessionID}.jsonl`)
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)
    const output: Array<Record<string, unknown>> = []
    for (const line of lines) {
      try {
        output.push(JSON.parse(line))
      } catch {
        output.push({ _parseError: line.slice(0, 200) })
      }
    }
    return output
  }

  // ---- hook / 事件回调（命名引用，保证 register 幂等） ----

  const onPreTool: PreToolHook = ({ sessionID, toolName, args, callID, correlation }) => {
    try {
      if (callID) startTimes.set(callID, { start: Date.now(), sessionID })
      writeLine(sessionID, {
        kind: "tool.pre",
        callID,
        toolName,
        correlation,
        args: typeof args === "object" && args !== null ? prepareToolMetadata(args) : args,
      })
    } catch {}
  }

  const onPostTool: PostToolHook = ({ sessionID, messageID, agent, model, toolName, args, callID, correlation, result }) => {
    try {
      const durationMs = takeDuration(callID)
      const output = prepareToolOutput(result.output)
      writeLine(sessionID, {
        kind: "tool.post",
        messageID,
        agent,
        model,
        callID,
        toolName,
        correlation,
        args: typeof args === "object" && args !== null ? prepareToolMetadata(args) : args,
        result: {
          title: result.title,
          output: stripProjectRoots(output.text),
          metadata: prepareToolMetadata(result.metadata),
          truncated: output.shortenedLines > 0 || output.collapsedLines > 0,
        },
        ...(durationMs !== undefined ? { durationMs } : {}),
      })
    } catch {}
  }

  const onPostToolFailure: PostToolFailureHook = ({
    sessionID,
    messageID,
    agent,
    model,
    toolName,
    args,
    error,
    errorCode,
    callID,
    correlation,
  }) => {
    try {
      const durationMs = takeDuration(callID)
      writeLine(sessionID, {
        kind: "tool.fail",
        messageID,
        agent,
        model,
        callID,
        toolName,
        correlation,
        args: typeof args === "object" && args !== null ? prepareToolMetadata(args) : args,
        error: summarizeToolError(error),
        ...(errorCode ? { errorCode } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      })
    } catch {}
  }

  const onTurnFinished: TurnFinishedHook = ({ sessionID, result }) => {
    try {
      writeLine(sessionID, { kind: "turn.finished", result })
    } catch {}
  }

  const onInputAccepted: InputAcceptedHook = ({ sessionID, action, metadata }) => {
    try {
      writeLine(sessionID, {
        kind: "input.accepted",
        action,
        ...(metadata ? { metadata: prepareToolMetadata(metadata) } : {}),
      })
    } catch {}
  }

  const onSessionCreated = (event: { properties: { info: { id: string; title: string; parentID?: string; directory: string; time: { created: number } } } }) => {
    try {
      const { info } = event.properties
      sessionDirs.set(info.id, info.directory)
      writeLine(info.id, {
        kind: "session.created",
        sessionID: info.id,
        title: info.title,
        ...(info.parentID ? { parentID: info.parentID } : {}),
        directory: info.directory,
        createdAt: info.time.created,
      })
    } catch {}
  }

  const onSessionError = (event: { properties: { sessionID?: string; error?: unknown } }) => {
    try {
      if (!event.properties.sessionID) return
      writeLine(event.properties.sessionID, {
        kind: "session.error",
        error: summarizeToolError(event.properties.error),
      })
    } catch {}
  }

  const onToolLifecycle = (event: {
    properties: {
      sessionID: string
      callID: string
      toolName: string
      phase: string
      batchId?: string
      reason?: string
    }
  }) => {
    try {
      const { sessionID, callID, toolName, phase, batchId, reason } = event.properties
      writeLine(sessionID, {
        kind: "tool.lifecycle",
        callID,
        toolName,
        phase,
        ...(batchId ? { batchId } : {}),
        ...(reason ? { reason } : {}),
      })
    } catch {}
  }

  // ---- 写入 ----

  /** 内部专用：写前取时长并清理 startTimes；未配对（如 callID 为空）返回 undefined。 */
  function takeDuration(callID: string): number | undefined {
    if (!callID) return undefined
    const entry = startTimes.get(callID)
    if (!entry) return undefined
    startTimes.delete(callID)
    return Date.now() - entry.start
  }

  function writeLine(sessionID: string, record: Record<string, unknown>) {
    const config = configFor(sessionID)
    if (!config.enabled) return
    const writer = ensureWriter(sessionID, config)
    if (!writer || writer.dead) return
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      sessionID,
      directory: sessionDirs.get(sessionID) ?? process.cwd(),
      ...record,
    }
    let text = JSON.stringify(line)
    if (Buffer.byteLength(text, "utf-8") > config.maxLineBytes) {
      text = JSON.stringify({
        ...line,
        args: "[行超限，args 已省略]",
        result: "[行超限，result 已省略]",
        error: "[行超限，error 已省略]",
        _truncated: true,
      })
      if (Buffer.byteLength(text, "utf-8") > config.maxLineBytes) return
    }
    const bytes = Buffer.byteLength(text + "\n", "utf-8")
    if (writer.bytes + bytes > config.maxFileBytes) {
      // 软上限：50 MiB 对单会话已是天文数字，正常不会触达；直接禁用避免复杂轮转。
      writer.dead = true
      log.warn("trace file size cap reached, disabled", { sessionID, file: writer.file })
      return
    }
    try {
      writer.sink.write(text + "\n")
      writer.sink.flush()
      writer.bytes += bytes
      touchLRU(sessionID)
    } catch (error) {
      writer.dead = true
      log.warn("trace write failed, session disabled", { sessionID, error: String(error) })
    }
  }

  function ensureWriter(sessionID: string, config: SessionConfig): SessionWriter | undefined {
    const existing = writers.get(sessionID)
    if (existing) return existing

    const sameDirectoryWriterCount = () =>
      [...writers.values()].filter((writer) => path.dirname(writer.file) === config.logsDir).length
    while (sameDirectoryWriterCount() >= config.maxFiles) {
      const oldestIndex = lruOrder.findIndex((candidate) => {
        const writer = writers.get(candidate)
        return writer && path.dirname(writer.file) === config.logsDir
      })
      if (oldestIndex < 0) break
      const [oldest] = lruOrder.splice(oldestIndex, 1)
      if (!oldest || !writers.has(oldest)) continue
      const victim = writers.get(oldest)!
      writers.delete(oldest)
      try {
        victim.sink.end()
      } catch {}
      try {
        fs.unlinkSync(victim.file)
      } catch {}
    }

    const file = path.join(config.logsDir, `${sessionID}.jsonl`)
    try {
      // 先开一次保证文件存在且权限 0o600（Bun.file.writer 无 mode 参数）。
      fs.closeSync(fs.openSync(file, "a", 0o600))
      fs.chmodSync(file, 0o600)
      const prior = fs.readFileSync(file)
      const sink = Bun.file(file).writer()
      // Bun FileSink 从 offset 0 开始；重开已有日志时先回写原内容，把 cursor 推到末尾，
      // 否则迁移/进程内重绑后的第一条新记录会覆盖旧记录。
      if (prior.length > 0) {
        sink.write(prior.toString("utf-8"))
        sink.flush()
      }
      const writer: SessionWriter = {
        file,
        sink,
        bytes: prior.length,
        dead: false,
      }
      writers.set(sessionID, writer)
      lruOrder.push(sessionID)
      return writer
    } catch (error) {
      log.warn("trace writer open failed", { sessionID, error: String(error) })
      return undefined
    }
  }

  function rebindSessionWriter(sessionID: string, config: SessionConfig) {
    const existing = writers.get(sessionID)
    if (!existing || path.dirname(existing.file) === config.logsDir) return

    // Bun FileSink.end() 可能释放/截断其内部视图；迁移内容必须在关闭 sink 前读出。
    let prior: Buffer | undefined
    try {
      if (fs.existsSync(existing.file)) prior = fs.readFileSync(existing.file)
    } catch {}
    try {
      existing.sink.end()
    } catch {}
    writers.delete(sessionID)
    const lruIndex = lruOrder.indexOf(sessionID)
    if (lruIndex >= 0) lruOrder.splice(lruIndex, 1)

    const target = path.join(config.logsDir, `${sessionID}.jsonl`)
    try {
      if (fs.existsSync(existing.file)) {
        if (prior) fs.appendFileSync(target, prior, { mode: 0o600 })
        fs.chmodSync(target, 0o600)
        fs.unlinkSync(existing.file)
      }
    } catch (error) {
      // writer 已解绑，后续一定写入新配置目录；迁移失败时保留旧文件供人工恢复。
      log.warn("trace writer rebind migration failed", {
        sessionID,
        from: existing.file,
        to: target,
        error: String(error),
      })
    }
  }

  function touchLRU(sessionID: string) {
    const index = lruOrder.indexOf(sessionID)
    if (index >= 0) lruOrder.splice(index, 1)
    lruOrder.push(sessionID)
  }

  function configFor(sessionID: string): SessionConfig {
    return sessionConfigs.get(sessionID) ?? {
      enabled,
      logsDir,
      maxFiles,
      maxFileBytes,
      maxLineBytes,
    }
  }
}
