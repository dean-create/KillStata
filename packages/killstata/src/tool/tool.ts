import z from "zod"
import { MessageV2 } from "../session/message-v2"
import type { Agent } from "../agent/agent"
import type { PermissionNext } from "../permission/next"
import { Truncate } from "./truncation"
import { prepareToolMetadata, prepareToolOutput, summarizeToolError } from "@/runtime/tool-result-policy"

export namespace Tool {
  /** Zod 在工具执行函数之前拒绝输入；该错误保证没有发生工具副作用。 */
  export class InputValidationError extends Error {
    readonly code = "TOOL_INPUT_INVALID" as const

    constructor(message: string, options?: ErrorOptions) {
      super(message, options)
      this.name = "ToolInputValidationError"
    }
  }

  /** 所有 TypeScript 工具的最小运行时返回契约；descriptor 与执行校验共用此 Schema。 */
  export const OutputSchema = z.object({
    title: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()),
    output: z.string(),
    attachments: MessageV2.FilePart.array().optional(),
  }).passthrough()

  export class OutputValidationError extends Error {
    readonly code = "TOOL_OUTPUT_INVALID" as const

    constructor(error: z.ZodError) {
      const fields = [...new Set(error.issues.map((issue) => issue.path.join(".") || "返回值"))]
      super(`工具结果未通过输出 Schema 校验：${fields.join("、")}。工具可能已完成执行，但结果不可信；请检查阶段与产物，不要原样重跑。`)
      this.name = "ToolOutputValidationError"
    }
  }

  export class ExecutionTimeoutError extends Error {
    readonly code = "TOOL_EXECUTION_TIMEOUT" as const

    constructor(public readonly timeoutMs: number) {
      super(`工具执行超过 ${timeoutMs}ms，已请求停止。若工具可能写入数据或产物，请先核对当前状态，再决定是否继续。`)
      this.name = "ToolExecutionTimeoutError"
    }
  }

  export class SchemaNotSentError extends Error {
    readonly code = "TOOL_SCHEMA_NOT_SENT" as const

    constructor(toolID: string, detail?: string, options?: ErrorOptions) {
      super(
        `${toolID} 的完整参数 Schema 未进入本轮模型上下文${detail ? `：${detail}` : ""}。` +
          `本次估计尚未执行；请先用 tool_search 查询精确 ID“${toolID}”，再严格按返回 Schema 修正参数。`,
        options,
      )
      this.name = "ToolSchemaNotSentError"
    }
  }

  async function raceExecutionWithTimeout<T>(input: {
    execute: (context: Context | undefined) => Promise<T>
    context: Context | undefined
    timeout: TimeoutPolicy
  }): Promise<T> {
    const controller = new AbortController()
    let timeoutError: ExecutionTimeoutError | undefined
    let termination: "cancelled" | "timeout" | undefined
    let cancellationError: unknown
    let rejectControl: (error: unknown) => void = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let remainingMs = input.timeout.kind === "bounded" ? input.timeout.timeoutMs : undefined
    let timerStartedAt = 0
    let pauseDepth = 0
    const control = new Promise<never>((_, reject) => {
      rejectControl = reject
    })
    const signal = input.context?.abort
    const abort = () => {
      if (termination) return
      termination = "cancelled"
      const reason = signal?.reason ?? new DOMException("已取消工具执行", "AbortError")
      cancellationError = reason
      controller.abort(reason)
      rejectControl(reason)
    }
    const pauseTimeout = () => {
      pauseDepth += 1
      if (pauseDepth !== 1 || timer === undefined || remainingMs === undefined) return
      clearTimeout(timer)
      timer = undefined
      remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt))
    }
    const resumeTimeout = () => {
      pauseDepth = Math.max(0, pauseDepth - 1)
      if (pauseDepth !== 0 || remainingMs === undefined || controller.signal.aborted || timeoutError) return
      timerStartedAt = Date.now()
      timer = setTimeout(() => {
        if (termination) return
        termination = "timeout"
        timeoutError = new ExecutionTimeoutError(input.timeout.kind === "bounded" ? input.timeout.timeoutMs : 0)
        controller.abort(timeoutError)
        rejectControl(timeoutError)
      }, remainingMs)
      timer.unref?.()
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener("abort", abort, { once: true })

    const timedContext = input.context ? { ...input.context, abort: controller.signal } : undefined
    if (input.timeout.kind === "bounded" && timedContext) {
      timedContext.ask = async (request) => {
        pauseTimeout()
        let abortHandler: (() => void) | undefined
        try {
          if (controller.signal.aborted) throw controller.signal.reason
          await Promise.race([
            input.context!.ask(request),
            new Promise<never>((_, reject) => {
              abortHandler = () => reject(controller.signal.reason ?? new DOMException("已取消", "AbortError"))
              controller.signal.addEventListener("abort", abortHandler, { once: true })
            }),
          ])
        } finally {
          if (abortHandler) controller.signal.removeEventListener("abort", abortHandler)
          resumeTimeout()
        }
      }
      resumeTimeout()
    }

    const operation = Promise.resolve().then(() => input.execute(timedContext))
    // A timed-out, non-cooperative implementation may settle later. Consume its rejection so
    // it cannot become an unhandled process-level error after the caller has already stopped.
    operation.catch(() => undefined)
    try {
      return await Promise.race([operation, control])
    } catch (error) {
      if (termination === "cancelled") throw cancellationError
      if (termination === "timeout") throw timeoutError
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  }

  interface Metadata {
    [key: string]: any
  }

  export interface InitContext {
    agent?: Agent.Info
  }

  export type ApprovalLevel = "automatic" | "confirm" | "blocked"
  export type ConfirmationOwner = "dispatcher" | "tool"
  export type TimeoutPolicy =
    | { kind: "bounded"; timeoutMs: number }
    | { kind: "interactive" }

  export const Timeout = Object.freeze({
    DEFAULT_MS: 120_000,
    MANAGED_EXECUTION_MS: 330_000,
    LONG_RUNNING_MS: 900_000,
    COMMAND_GRACE_MS: 5_000,
  })

  /**
   * 仅用于帮助模型做工具选择，不参与运行时准入或权限判断。
   * 安全画像继续由 ExecutionPolicy 管理，避免把“模型怎么理解工具”和“系统是否放行”混为一谈。
   */
  export type ModelNamespace =
    | "interaction"
    | "filesystem"
    | "search"
    | "web"
    | "pipeline"
    | "data"
    | "econometrics_diagnostic"
    | "econometrics_estimator"
    | "report"
    | "subagent"

  export const ModelNamespaceLabel = Object.freeze({
    interaction: "交互澄清",
    filesystem: "文件与命令",
    search: "精准搜索",
    web: "网络检索",
    pipeline: "任务与阶段管理",
    data: "数据管理",
    econometrics_diagnostic: "计量诊断与方法选择",
    econometrics_estimator: "计量估计",
    report: "结果与报告",
    subagent: "子任务协作",
  }) satisfies Readonly<Record<ModelNamespace, string>>

  /** 固定顺序用于 system prompt 和缓存指纹，不能依赖不同平台的 ICU locale 排序。 */
  export const ModelNamespaceOrder = Object.freeze([
    "interaction",
    "filesystem",
    "search",
    "web",
    "pipeline",
    "data",
    "econometrics_diagnostic",
    "econometrics_estimator",
    "report",
    "subagent",
  ] as const satisfies readonly ModelNamespace[])

  export interface ModelContract {
    namespace: ModelNamespace
    useWhen: string
    doNotUseWhen: string
    returns: string
    failureRecovery: string
    /** 只给复杂工具提供 1～2 个最小有效示例，防止 schema token 膨胀。 */
    inputExamples?: readonly Record<string, unknown>[]
  }

  export function renderModelDescription(summary: string, model: ModelContract): string {
    return [
      `【工具族】${ModelNamespaceLabel[model.namespace]}`,
      summary.trim(),
      `【适用】${model.useWhen}`,
      `【不适用】${model.doNotUseWhen}`,
      `【返回】${model.returns}`,
      `【失败恢复】${model.failureRecovery}`,
    ].join("\n")
  }

  type ExecutionShape =
    | { readOnly: true; concurrency: "parallel" | "serial"; sideEffect: "none" | "external" }
    | {
        readOnly: false
        concurrency: "serial"
        sideEffect: "session" | "filesystem" | "external"
      }
  type TimedExecutionShape = ExecutionShape & { timeout: TimeoutPolicy }

  type ExecutionResolver = {
    resolve?: (args: unknown) => ExecutionPolicy
  }

  /**
   * 每个工具必须在定义处声明执行风险。confirm 采用判别联合，强制说明确认责任归属：
   * dispatcher 做统一确认，或 tool 根据路径/命令做精确确认；不能两边都猜。
   */
  export type ExecutionPolicy =
    | (TimedExecutionShape & ExecutionResolver & { approval: "automatic"; confirmation?: never })
    | (TimedExecutionShape & ExecutionResolver & { approval: "confirm"; confirmation: ConfirmationOwner })
    | (TimedExecutionShape & ExecutionResolver & { approval: "blocked"; confirmation?: never })

  const executionPolicy = <T extends ExecutionPolicy>(policy: T): T => Object.freeze(policy)

  export const Execution = Object.freeze({
    readOnly: executionPolicy({
      readOnly: true,
      approval: "automatic",
      concurrency: "parallel",
      sideEffect: "none",
      timeout: { kind: "bounded", timeoutMs: Timeout.DEFAULT_MS },
    }),
    readOnlySerial: executionPolicy({
      readOnly: true,
      approval: "automatic",
      concurrency: "serial",
      sideEffect: "none",
      timeout: { kind: "bounded", timeoutMs: Timeout.DEFAULT_MS },
    }),
    session: executionPolicy({
      readOnly: false,
      approval: "automatic",
      concurrency: "serial",
      sideEffect: "session",
      timeout: { kind: "bounded", timeoutMs: Timeout.DEFAULT_MS },
    }),
    interactive: executionPolicy({
      readOnly: false,
      approval: "automatic",
      concurrency: "serial",
      sideEffect: "session",
      timeout: { kind: "interactive" },
    }),
    managedFilesystem: executionPolicy({
      readOnly: false,
      approval: "automatic",
      concurrency: "serial",
      sideEffect: "filesystem",
      timeout: { kind: "bounded", timeoutMs: Timeout.MANAGED_EXECUTION_MS },
    }),
    managedExternal: executionPolicy({
      readOnly: false,
      approval: "automatic",
      concurrency: "serial",
      sideEffect: "external",
      timeout: { kind: "bounded", timeoutMs: Timeout.MANAGED_EXECUTION_MS },
    }),
    protectedFilesystem: executionPolicy({
      readOnly: false,
      approval: "confirm",
      confirmation: "tool",
      concurrency: "serial",
      sideEffect: "filesystem",
      timeout: { kind: "bounded", timeoutMs: Timeout.DEFAULT_MS },
    }),
    protectedCommand: executionPolicy({
      readOnly: false,
      approval: "confirm",
      confirmation: "tool",
      concurrency: "serial",
      sideEffect: "filesystem",
      timeout: { kind: "bounded", timeoutMs: Timeout.LONG_RUNNING_MS + Timeout.COMMAND_GRACE_MS },
    }),
    protectedExternal: executionPolicy({
      readOnly: false,
      approval: "confirm",
      confirmation: "tool",
      concurrency: "serial",
      sideEffect: "external",
      timeout: { kind: "bounded", timeoutMs: Timeout.LONG_RUNNING_MS },
    }),
    protectedExternalRead: executionPolicy({
      readOnly: true,
      approval: "confirm",
      confirmation: "tool",
      concurrency: "serial",
      sideEffect: "external",
      timeout: { kind: "bounded", timeoutMs: Timeout.DEFAULT_MS },
    }),
    confirmExternal: executionPolicy({
      readOnly: false,
      approval: "confirm",
      confirmation: "dispatcher",
      concurrency: "serial",
      sideEffect: "external",
      timeout: { kind: "bounded", timeoutMs: Timeout.MANAGED_EXECUTION_MS },
    }),
    blocked: executionPolicy({
      readOnly: false,
      approval: "blocked",
      concurrency: "serial",
      sideEffect: "external",
      timeout: { kind: "bounded", timeoutMs: Timeout.DEFAULT_MS },
    }),
  }) satisfies Readonly<Record<string, ExecutionPolicy>>

  /** 通用执行期限入口；Tool.define 与 Harness 直调 Python Registry 方法共用同一套 timeout/cancel 行为。 */
  export function executeWithPolicyTimeout<T>(input: {
    execution: ExecutionPolicy
    args: unknown
    context: Context | undefined
    execute: (context: Context | undefined) => Promise<T>
  }): Promise<T> {
    const resolvedExecution = input.execution.resolve?.(input.args) ?? input.execution
    const timeout = resolvedExecution.timeout
    if (
      !timeout ||
      (timeout.kind === "bounded" && (!Number.isFinite(timeout.timeoutMs) || timeout.timeoutMs <= 0))
    ) {
      throw new Error("TOOL_EXECUTION_POLICY_MISSING：工具未声明有效的执行期限。")
    }
    return raceExecutionWithTimeout({
      execute: input.execute,
      context: input.context,
      timeout,
    })
  }

  export type Context<M extends Metadata = Metadata> = {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    callID?: string
    extra?: { [key: string]: any }
    metadata(input: { title?: string; metadata?: M }): void
    progress?(input: { message: string; title?: string; metadata?: Record<string, unknown> }): void
    ask(input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">): Promise<void>
  }
  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string
    model: ModelContract
    execution: ExecutionPolicy
    init: (ctx?: InitContext) => Promise<{
      description: string
      parameters: Parameters
      execute(
        args: z.infer<Parameters>,
        ctx: Context,
      ): Promise<{
        title: string
      metadata: M
      output: string
      attachments?: MessageV2.FilePart[]
    }>
      outputSchema?: z.ZodType<unknown>
      formatValidationError?(error: z.ZodError): string
    }>
  }

  export type InferParameters<T extends Info> = T extends Info<infer P> ? z.infer<P> : never
  export type InferMetadata<T extends Info> = T extends Info<any, infer M> ? M : never

  /**
   * 某些模型会把工具参数整体序列化成 JSON 字符串而不是对象；
   * 这里做一次尽力而为的规整，解析失败时原样返回，交给 Zod 产出可读错误。
   */
  export function normalizeToolArgs(args: unknown): unknown {
    if (typeof args === "string") {
      try {
        const parsed = JSON.parse(args)
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed
        }
      } catch {
        // JSON 解析失败，保留原始值让 Zod 验证产生有意义的错误信息
      }
    }
    return args
  }

  function chineseZodIssue(issue: z.core.$ZodIssue): string {
    const detail = issue as z.core.$ZodIssue & Record<string, any>
    const field = issue.path.length ? issue.path.join(".") : "参数"
    if (/[\u3400-\u9fff]/.test(issue.message)) return `${field}：${issue.message}`
    switch (issue.code) {
      case "invalid_type":
        return `${field}：类型错误，应为 ${String(detail.expected ?? "schema 指定类型")}`
      case "invalid_value":
        return `${field}：取值不在允许范围${Array.isArray(detail.values) ? `（${detail.values.join("、")}）` : ""}`
      case "too_small":
        return `${field}：小于最小要求 ${String(detail.minimum ?? "")}`.trim()
      case "too_big":
        return `${field}：超过最大要求 ${String(detail.maximum ?? "")}`.trim()
      case "invalid_format":
        return `${field}：格式不符合 ${String(detail.format ?? "schema")}`
      case "unrecognized_keys":
        return `${field}：包含未定义字段${Array.isArray(detail.keys) ? `（${detail.keys.join("、")}）` : ""}`
      case "invalid_union":
        return `${field}：不符合任何允许的参数结构`
      case "not_multiple_of":
        return `${field}：必须是 ${String(detail.divisor ?? "指定数值")} 的倍数`
      default:
        return `${field}：不符合该字段的参数约束`
    }
  }

  export function formatZodErrorChinese(error: z.ZodError): string {
    return error.issues.map(chineseZodIssue).join("；")
  }

  export function define<Parameters extends z.ZodType, Result extends Metadata>(
    id: string,
    execution: ExecutionPolicy,
    model: ModelContract,
    init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
  ): Info<Parameters, Result> {
    // 即使多个工具复用同一模板，也为每个定义创建独立、不可变的策略对象；
    // 任一工具或插件都不能在运行期改写共享模板，进而改变其他工具的权限/并发画像。
    const isolatedExecution = Object.freeze({ ...execution }) as ExecutionPolicy
    return {
      id,
      model: Object.freeze({
        ...model,
        inputExamples: model.inputExamples?.map((example) => Object.freeze({ ...example })),
      }),
      execution: isolatedExecution,
      init: async (initCtx) => {
        const toolInfo = init instanceof Function ? await init(initCtx) : init
        const execute = toolInfo.execute
        // 不能写 `toolInfo.execute = ...`：当 init 是静态对象字面量（如 ListTool 的写法）
        // 而非工厂函数时，`toolInfo` 就是模块级单例——原地赋值会修改这个共享对象本身。
        // 每次调用 `.init()` 都会在上一次已经包装过的 execute 基础上再包一层
        // prepareToolOutput/Truncate.output，N 次 init 产生 N 层嵌套执行：
        // 第二层收到的输入已经被第一层的 redact() 清掉了零宽保护字符，同一段内部产物
        // 文件名会被第二层的 LONG_TOKEN_PATTERN 再次误判成密钥打码成 [已脱敏]，且随
        // 进程存活期内 init 次数增多而逐次加重（2026-08-16 drive harness 真实数据实测：
        // list 工具在多轮对话里重复解析后，同一目录内容从"完整"变成"文件名被脱敏"）。
        // 返回新对象而不改写 toolInfo，保证每次 init() 都基于原始 execute 包一层。
        return {
          ...toolInfo,
          description: renderModelDescription(toolInfo.description, model),
          execute: async (args, ctx) => {
            const normalizedArgs = normalizeToolArgs(args)

            let parsedArgs: any
            try {
              parsedArgs = toolInfo.parameters.parse(normalizedArgs)
            } catch (error) {
              if (error instanceof z.ZodError) {
                const allIssuesAlreadyChinese = error.issues.every((issue) => /[\u3400-\u9fff]/.test(issue.message))
                const formatted = allIssuesAlreadyChinese && toolInfo.formatValidationError
                  ? toolInfo.formatValidationError(error)
                  : `工具 ${id} 参数不合法：${formatZodErrorChinese(error)}`
                throw new InputValidationError(
                  formatted.includes("修复建议：")
                    ? formatted
                    : `${formatted}\n修复建议：只修改报错字段并重新核对其格式或来源；${model.failureRecovery}`,
                  { cause: error },
                )
              }
              throw new InputValidationError(
                `工具 ${id} 的参数不符合要求：${error}。\n修复建议：根据参数说明检查字段名、数据类型、ID 来源和必填项，只修改错误参数后重试；${model.failureRecovery}`,
                { cause: error },
              )
            }
            let result: Awaited<ReturnType<typeof execute>>
            try {
              result = await executeWithPolicyTimeout({
                execution: isolatedExecution,
                args: parsedArgs,
                context: ctx,
                execute: (timedContext) => execute(parsedArgs, timedContext as Context),
              })
            } catch (error) {
              // 取消属于用户/运行时控制流，不应被包装成“可重试失败”。其他失败统一保留原始根因，
              // 再附加工具自身的恢复边界，让模型知道下一步该修什么、不能擅自换什么。
              if (ctx?.abort?.aborted) throw error
              // 权限拒绝、提问取消、受管进程错误和结果契约错误都是运行时按类型/错误码分流的
              // 控制信号。它们都是 Error 子类，必须保持最外层 identity；只包装普通 Error。
              if (error instanceof Error && error.constructor !== Error) throw error
              const message = summarizeToolError(error)
              if (message.includes("修复建议：")) throw error
              throw new Error(`${message}\n修复建议：${model.failureRecovery}`, { cause: error })
            }
            const outputSchema = toolInfo.outputSchema ?? OutputSchema
            const validatedResult = outputSchema.safeParse(result)
            if (!validatedResult.success) throw new OutputValidationError(validatedResult.error)
            result = validatedResult.data as Awaited<ReturnType<typeof execute>>
            const prepared = prepareToolOutput(result.output)
            const sanitizedResult = {
              ...result,
              output: prepared.text,
              metadata: prepareToolMetadata({
                ...result.metadata,
                outputPolicy: {
                  redactions: prepared.redactions,
                  collapsedLines: prepared.collapsedLines,
                  shortenedLines: prepared.shortenedLines,
                },
              }) as Result,
            }
            // skip truncation for tools that handle it themselves
            if (result.metadata.truncated !== undefined) {
              return sanitizedResult
            }
            const truncated = await Truncate.output(prepared.text, {}, initCtx?.agent)
            return {
              ...sanitizedResult,
              output: truncated.content,
              metadata: prepareToolMetadata({
                ...sanitizedResult.metadata,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              }) as Result,
            }
          },
        }
      },
    }
  }
}
