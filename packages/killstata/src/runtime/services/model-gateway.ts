import os from "os"
import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  extractReasoningMiddleware,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "@/session/message-v2"
import { SystemPrompt } from "@/session/system"
import { assemblePromptSections } from "@/runtime/services/prompt-assembly"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import { RuntimeHooks } from "@/runtime/hooks"
import { bindToolPort, emptyToolSet, providerToolSchemaText, type ResolvedToolSet } from "@/session/prompt/tools"
import type { WorkflowInputIntent, QueryCorrelation } from "@/runtime/types"
import { SessionRetry } from "@/session/retry"
import { summarizeToolError } from "@/runtime/tool-result-policy"
import { contextPreflight, ContextPreflightError } from "@/runtime/context-preflight"
import { promptFingerprint, type PromptFingerprint, classifyCacheBreak } from "@/runtime/prompt-fingerprint"
import { resolveEffectiveEffort, EFFORT_LEVELS, type EffortLevel } from "@/provider/capabilities"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { ContextManager } from "@/runtime/context-manager"
import {
  contextBudget,
  autoCompactThreshold,
  contextUsageFromEstimate,
  type ContextUsageSnapshot,
} from "@/runtime/context-budget"
import { ContextService } from "@/runtime/services/context-service"

/**
 * AI SDK 的 onError 回调可能先收到 Provider 错误，但 fullStream 本身不结束。
 * 将错误与 iterator.next() 竞争，避免主循环一直等到外层取消才知道请求失败。
 */
export function failFastStream<T>(source: AsyncIterable<T>, providerError: Promise<never>): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]()
      let completed = false
      try {
        while (true) {
          const next = iterator.next()
          // Provider 先报错时 race 会立即结束；底层 next 的迟到 rejection 不能变成未处理异常。
          next.catch(() => {})
          const result = await Promise.race([next, providerError])
          if (result.done) {
            completed = true
            return
          }
          yield result.value
        }
      } finally {
        if (!completed) {
          try {
            const closing = iterator.return?.()
            if (closing) closing.catch(() => {})
          } catch {}
        }
      }
    },
  }
}

/**
 * 静态能力域索引：整个产品有哪些能力域，与 agent、会话、阶段都无关，因此进 global 稳定层，
 * 进程内只构建一次。刻意不从 resolveTools 的 pool 取——那份被 isToolEnabled 过滤过，
 * 会随 agent 变化，放进 global 就会让缓存前缀在切换 agent 时失效。
 */
// 能力域索引是全局稳定文本，不读取当前注册表数量；新增方法只影响第二层搜索索引，
// 不让稳定 system 前缀因为“已有 N 个方法”发生变化。
const STATIC_TOOL_INVENTORY = SystemPrompt.toolInventory([])
async function staticToolInventory(): Promise<string[]> {
  return STATIC_TOOL_INVENTORY
}

export namespace ModelGateway {
  const log = Log.create({ service: "llm" })

  export const OUTPUT_TOKEN_MAX = Flag.KILLSTATA_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    customSystem?: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: ResolvedToolSet
    retries?: number
    requestSource?: "foreground" | "background"
    contextPolicy?: "managed" | "compaction"
    /** 工具已交付完整事实；下一次只允许模型生成用户可见文字，不再调用工具。 */
    textOnly?: boolean
    effort?: EffortLevel
    inputIntent?: WorkflowInputIntent
    correlation?: QueryCorrelation
    promptFingerprint?: PromptFingerprint
    contextUsage?: ContextUsageSnapshot
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
    ])

    const initialSections = [
      ...SystemPrompt.header(input.model.providerID).map((content, index) => ({
        id: `global.header.${index}`,
        stability: "global" as const,
        content,
      })),
      ...SystemPrompt.sections({
        model: input.model,
        agent: input.agent,
        conversationOnly: input.inputIntent === "conversation",
        runtime: input.system,
        custom: input.customSystem,
        user: input.user.system ? [input.user.system] : [],
      }),
    ]
    const initialPrompt = assemblePromptSections(initialSections)
    const promptHook = await RuntimeHooks.promptAssembled({
      sessionID: input.sessionID,
      agent: input.agent.name,
      inputIntent: input.inputIntent,
      system: initialPrompt.system,
    })

    const variantID = input.user.variant ?? input.agent.variant
    const variantIsEffort = EFFORT_LEVELS.includes(variantID as EffortLevel)
    const requestedEffort = input.effort ?? (variantIsEffort ? (variantID as EffortLevel) : undefined)
    const effectiveEffort = requestedEffort ? resolveEffectiveEffort(input.model, requestedEffort) : undefined
    const effectiveVariantID = effectiveEffort?.effective ?? variantID
    const variant = !input.small && input.model.variants && effectiveVariantID ? input.model.variants[effectiveVariantID] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )

    const params = {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      options,
    }

    const maxOutputTokens = ProviderTransform.maxOutputTokens(
      input.model.api.npm,
      params.options,
      input.model.limit.output,
      OUTPUT_TOKEN_MAX,
    )

    const compactionRequest = input.contextPolicy === "compaction"
    // 系统工具是每轮固定能力；普通对话不再走零工具旁路。是否实际执行仍由 prompt、
    // 本轮权限与工作流门禁决定。只有压缩器必须保持空工具集，避免摘要时产生副作用。
    if (!compactionRequest && !input.textOnly) await input.tools.refreshToolPool()
    const resolvedTools = input.textOnly
      ? emptyToolSet()
      : input.inputIntent === "conversation"
      ? emptyToolSet()
      : compactionRequest
        ? emptyToolSet()
        : resolveTools(input)
    // Provider 看到的 schema 顺序必须稳定；对象插入顺序漂移会让相同工具集产生不同缓存前缀。
    const tools = Object.fromEntries(
      Object.entries(bindToolPort(resolvedTools)).sort(([left], [right]) => left.localeCompare(right)),
    )
    const catalog = !compactionRequest
      ? (() => {
          return SystemPrompt.toolCatalog(
            Object.values(resolvedTools.definitions).map((definition) => ({
              id: definition.id,
              modelNamespace: definition.modelNamespace,
            })),
            resolvedTools.deferredToolSummary(),
            resolvedTools.methodReferences(),
          )
        })()
      : []
    const inventory = compactionRequest ? [] : await staticToolInventory()
    const sections = [
      ...SystemPrompt.header(input.model.providerID).map((content, index) => ({
        id: `global.header.${index}`,
        stability: "global" as const,
        content,
      })),
      ...SystemPrompt.sections({
        model: input.model,
        agent: input.agent,
        conversationOnly: input.inputIntent === "conversation",
        runtime: input.system,
        custom: input.customSystem,
        user: input.user.system ? [input.user.system] : [],
        hooks: promptHook.appendSystem,
        inventory,
        catalog,
      }),
    ]
    const promptBundle = assemblePromptSections(sections)
    const system = promptBundle.providerSystem

    // tools 已在上面按名排序，这里直接复用同一顺序。
    const toolEstimateText = providerToolSchemaText(resolvedTools.definitions)
    const contextBudgetInfo = contextBudget(input.model, maxOutputTokens)
    let messages = input.messages
    let preflight = contextPreflight({
      model: input.model,
      system,
      messages,
      toolSchemaText: toolEstimateText,
      reserveTokens: maxOutputTokens,
    })
    const pressure = () =>
      contextBudgetInfo.inputBudget && contextBudgetInfo.inputBudget > 0
        ? preflight.estimatedPromptTokens / contextBudgetInfo.inputBudget
        : 0
    const projectFinalView = (emergency: boolean) => {
      if (contextBudgetInfo.inputBudget === null) return
      const targetPromptRatio = emergency ? 0.9 : 0.88
      const targetMessageTokens = Math.max(
        0,
        Math.floor(contextBudgetInfo.inputBudget * targetPromptRatio) -
          preflight.estimatedSystemTokens -
          preflight.estimatedToolTokens,
      )
      const projected = ContextService.projectFinalModelView({
        sessionID: input.sessionID,
        messages,
        targetTokens: targetMessageTokens,
        minRecentTurns: emergency ? 2 : 4,
        emergency,
      })
      if (!projected.changed) return
      messages = projected.messages
      preflight = contextPreflight({
        model: input.model,
        system,
        messages,
        toolSchemaText: toolEstimateText,
        reserveTokens: maxOutputTokens,
      })
    }
    if (input.contextPolicy !== "compaction" && pressure() >= 0.9) projectFinalView(false)
    if (input.contextPolicy !== "compaction" && pressure() >= 0.95) projectFinalView(true)
    input.messages = messages
    const compactThreshold = autoCompactThreshold(contextBudgetInfo.inputBudget)
    const autoCompactDue =
      input.contextPolicy !== "compaction" &&
      cfg.compaction?.auto !== false &&
      compactThreshold !== null &&
      preflight.estimatedPromptTokens > compactThreshold
    const contextSnapshot = contextUsageFromEstimate({
      model: input.model,
      budget: contextBudgetInfo,
      estimatedPromptTokens: preflight.estimatedPromptTokens,
      estimatedSystemTokens: preflight.estimatedSystemTokens,
      estimatedToolTokens: preflight.estimatedToolTokens,
      estimatedMessageTokens: preflight.estimatedMessageTokens,
      compactionState: preflight.overBudget || autoCompactDue ? "pending" : "none",
    })
    input.contextUsage = contextSnapshot
    const toolPool = resolvedTools.toolPoolSnapshot()
    // 后台请求（标题、摘要）用的是自己的迷你 prompt，publish 会把会话真实用量覆盖掉。
    if (input.requestSource !== "background") {
      ContextManager.publishUsage({
        sessionID: input.sessionID,
        historyVersion: input.messages.length,
        usage: contextSnapshot,
      })
    }

    const fingerprint = promptFingerprint({
      modelID: input.model.id,
      providerID: input.model.providerID,
      effort: effectiveEffort?.effective,
      variant: effectiveVariantID,
      system,
      // ProviderTransform 只在第一个 system 消息上设置缓存断点；因此真正稳定的
      // cache prefix 是 global（产品规则、方法论、能力域索引），项目/Agent 规则和
      // 当前轮目录都放在动态尾部，不能在指纹里冒充可复用前缀。
      stableSystem: promptBundle.globalSystem,
      dynamicSystemTail: [...promptBundle.sessionSystem, ...promptBundle.turnSystem],
      tools,
      dynamicMethodReferences: resolvedTools.methodReferences(),
      messages: input.messages,
      providerOptions: options,
    })
    l.info("prompt fingerprint", {
      systemHash: fingerprint.systemHash,
      stableSystemHash: fingerprint.stableSystemHash,
      dynamicSystemTailHash: fingerprint.dynamicSystemTailHash,
      stableToolSchemaHash: fingerprint.stableToolSchemaHash,
      dynamicMethodTailHash: fingerprint.dynamicMethodTailHash,
      toolSchemaHash: fingerprint.toolSchemaHash,
      providerOptionsHash: fingerprint.providerOptionsHash,
      promptHash: fingerprint.promptHash,
      effort: effectiveEffort,
      variant: effectiveVariantID,
    })
    if (input.correlation) {
      input.promptFingerprint = fingerprint
      RuntimeTaskLedger.appendEventBestEffort({
        sessionID: input.sessionID,
        kind: "model.request",
        correlation: input.correlation,
        message: "prompt fingerprint ready",
        metadata: {
          fingerprint: {
            systemHash: fingerprint.systemHash,
            stableSystemHash: fingerprint.stableSystemHash,
            dynamicSystemTailHash: fingerprint.dynamicSystemTailHash,
            stableToolSchemaHash: fingerprint.stableToolSchemaHash,
            dynamicMethodTailHash: fingerprint.dynamicMethodTailHash,
            toolSchemaHash: fingerprint.toolSchemaHash,
            providerOptionsHash: fingerprint.providerOptionsHash,
            promptHash: fingerprint.promptHash,
            modelID: fingerprint.modelID,
            providerID: fingerprint.providerID,
            effort: fingerprint.effort,
            variant: fingerprint.variant,
          },
        },
      })
      RuntimeTaskLedger.appendEventBestEffort({
        sessionID: input.sessionID,
        kind: "tool.pool",
        correlation: input.correlation,
        message: "tool pool prepared",
        metadata: {
          ...toolPool,
          estimatedSchemaTokens: preflight.estimatedToolTokens,
        },
      })
    }

    l.info("context preflight", preflight)
    if (
      preflight.overBudget &&
      cfg.compaction?.auto === false &&
      input.contextPolicy !== "compaction"
    ) {
      throw new Error("当前请求超过模型输入预算，且自动压缩已关闭；请手动运行 /compact。")
    }
    if (preflight.overBudget || autoCompactDue) {
      throw new ContextPreflightError(
        autoCompactDue && compactThreshold !== null
          ? {
              ...preflight,
              budgetTokens: compactThreshold,
              overBudget: true,
              compactionState: "pending",
            }
          : preflight,
      )
    }

    l.info("stream params ready", {
      messageCount: input.messages.length,
      toolCount: Object.keys(tools).length,
      systemCount: system.length,
      maxOutputTokens,
    })

    let rejectProviderStreamError: (error: unknown) => void = () => {}
    let providerStreamErrorSettled = false
    const providerStreamError = new Promise<never>((_, reject) => {
      rejectProviderStreamError = reject
    })
    // 标题/摘要等后台调用可能在 Provider 回调后不再消费 fullStream；先接住拒绝，
    // 但保留原 Promise 给 failFastStream 的消费者继续观察并传播。
    providerStreamError.catch(() => {})
    const result = streamText({
      onError({ error }) {
        l.error("stream error", {
          error: summarizeToolError(error),
        })
        if (!providerStreamErrorSettled) {
          providerStreamErrorSettled = true
          rejectProviderStreamError(error)
        }
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return null
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools),
      tools,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("killstata")
          ? {
              "x-killstata-project": Instance.project.id,
              "x-killstata-session": input.sessionID,
              "x-killstata-request": input.user.id,
              "x-killstata-client": Flag.KILLSTATA_CLIENT,
            }
          : {
              "User-Agent": `killstata/${Installation.VERSION}`,
            }),
        ...input.model.headers,
      },
      maxRetries: input.retries ?? (input.requestSource === "background" ? SessionRetry.BACKGROUND_MAX_RETRIES : 0),
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
          extractReasoningMiddleware({ tagName: "think", startWithReasoning: false }),
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        // AI SDK 5 默认会把完整 prompt/response 作为 span attribute。计量数据、
        // 用户文本和工具结果不得进入遥测；这里只保留时延、token 等非正文指标。
        recordInputs: false,
        recordOutputs: false,
      },
    })

    l.info("streamText returned")
    // 不能用 { ...result } 覆盖 fullStream：streamText 返回的是类实例，
    // text/usage/finishReason/steps/response 全在原型上作为 getter，对象展开只复制
    // 自有属性，会让 `await stream.text` 变成 undefined（后台标题与会话摘要静默失效）。
    // 以原对象为原型建视图，只在自有层覆盖 fullStream，其余访问仍沿原型链求值。
    const view = Object.create(result) as typeof result
    Object.defineProperty(view, "fullStream", {
      // 标题/摘要是后台装饰请求，调用方已有独立失败隔离；只有前台主循环需要
      // 立即消费并分类 Provider 流错误，避免把后台失败变成进程级未处理异常。
      value: input.requestSource === "background"
        ? result.fullStream
        : failFastStream(result.fullStream, providerStreamError),
      enumerable: true,
      configurable: true,
    })
    return view
  }

  function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">): ResolvedToolSet {
    const disabled = PermissionNext.disabled(Object.keys(input.tools.definitions), input.agent.permission)
    const isToolDisabledByUser = (tool: string) => {
      if (input.user.tools?.[tool] === false) return true
      if (tool === "shell" && input.user.tools?.bash === false) return true
      if (tool === "bash" && input.user.tools?.shell === false) return true
      return false
    }
    const definitions = Object.fromEntries(
      Object.entries(input.tools.definitions).filter(([tool]) => {
        if (isToolDisabledByUser(tool) || disabled.has(tool)) {
          if (process.env.KILLSTATA_DRIVE_DEBUG) {
            console.log(`[llm-resolveTools-debug] removing ${tool} disabled=${disabled.has(tool)} userDisabled=${isToolDisabledByUser(tool)}`)
          }
          return false
        }
        return true
      }),
    )
    input.tools.setRequestAllowlist(Object.keys(definitions))
    return {
      definitions,
      port: input.tools.port,
      setRequestAllowlist: input.tools.setRequestAllowlist,
      refreshToolPool: input.tools.refreshToolPool,
      commitDeferredTools: input.tools.commitDeferredTools,
      deferredToolSummary: input.tools.deferredToolSummary,
      methodReferences: input.tools.methodReferences,
      toolPoolSnapshot: input.tools.toolPoolSnapshot,
    }
  }

}
