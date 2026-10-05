import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { NamedError } from "@killstata/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import type { JSONValue, SharedV2ProviderMetadata } from "@ai-sdk/provider"
import { Identifier } from "../id/id"
import { fn } from "@killstata/util/fn"
import { Storage } from "@/storage/storage"
import { ProviderTransform } from "@/provider/transform"
import { Truncate } from "@/tool/truncation"
import { STATUS_CODES } from "http"
import { iife } from "@killstata/util/iife"
import { type SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { summarizeToolError } from "@/runtime/tool-result-policy"
import { ToolResultProjection } from "@/runtime/tool-result-projection"
import { isDataFile } from "@/tool/data-file"

export namespace MessageV2 {
  const SAFE_ERROR_RESPONSE_HEADERS = new Set([
    "retry-after",
    "retry-after-ms",
    "x-request-id",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
  ])

  function sanitizeErrorResponseHeaders(headers: Record<string, string> | undefined) {
    if (!headers) return undefined
    const safe = Object.fromEntries(
      Object.entries(headers)
        .map(([key, value]) => [key.toLowerCase(), value] as const)
        .filter(([key]) => SAFE_ERROR_RESPONSE_HEADERS.has(key))
        .map(([key, value]) => [key, summarizeToolError(value, 512)]),
    )
    return Object.keys(safe).length > 0 ? safe : undefined
  }

  const PROVIDER_METADATA_KEYS = new Set([
    "amazon-bedrock",
    "anthropic",
    "azure",
    "bedrock",
    "cerebras",
    "cohere",
    "deepinfra",
    "gateway",
    "google",
    "google-vertex",
    "groq",
    "mistral",
    "openai",
    "openaiCompatible",
    "openrouter",
    "perplexity",
    "togetherai",
    "vercel",
    "xai",
  ])

  function isJsonValue(value: unknown): value is JSONValue {
    if (value === null) return true
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
    if (Array.isArray(value)) return value.every((item) => isJsonValue(item))
    if (typeof value === "object") {
      return Object.values(value).every((item) => isJsonValue(item))
    }
    return false
  }

  function sanitizeProviderMetadata(
    metadata: Record<string, unknown> | undefined,
  ): SharedV2ProviderMetadata | undefined {
    if (!metadata) return undefined

    const filtered = Object.fromEntries(
      Object.entries(metadata).filter((entry): entry is [string, Record<string, JSONValue>] => {
        const [key, value] = entry
        if (!PROVIDER_METADATA_KEYS.has(key)) return false
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false
        return isJsonValue(value)
      }),
    )

    return Object.keys(filtered).length > 0 ? filtered : undefined
  }

  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(),
      message: z.string(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>

  const PartBase = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(),
    files: z.string().array(),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: z.object({
      start: z.object({ line: z.number(), character: z.number() }),
      end: z.object({ line: z.number(), character: z.number() }),
    }),
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const ResourceSource = FilePartSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(),
    uri: z.string(),
  }).meta({
    ref: "ResourceSource",
  })

  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "FilePartSource",
  })

  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    source: FilePartSource.optional(),
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(),
    source: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
    reason: z.enum(["manual", "threshold", "overflow"]).optional(),
    customInstructions: z.string().max(4_000).optional(),
    preCompactTokens: z.number().int().nonnegative().optional(),
    lastMessageID: z.string().optional(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const CompactionRestorePart = PartBase.extend({
    type: z.literal("compaction-restore"),
    summarySource: z.enum(["model", "fallback"]),
    text: z.string(),
    recoveryReferences: z.array(z.string()).default([]),
    userMessageLedgerReference: z.string().optional(),
    userMessageCount: z.number().int().nonnegative().optional(),
  }).meta({
    ref: "CompactionRestorePart",
  })
  export type CompactionRestorePart = z.infer<typeof CompactionRestorePart>

  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string().optional(),
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  /**
   * 工具输入字段的预处理 schema
   * 自动将字符串输入转换为对象格式，兼容不同模型返回的格式
   * 某些模型可能返回 JSON 字符串而非对象
   */
  const ToolInputSchema = z.preprocess(
    (input) => {
      // 如果已经是对象类型，直接返回
      if (typeof input === "object" && input !== null && !Array.isArray(input)) {
        return input
      }
      // 如果是字符串，尝试解析为 JSON
      if (typeof input === "string") {
        try {
          const parsed = JSON.parse(input)
          // 确保解析结果是对象
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed
          }
          // 如果解析结果不是对象，包装成错误对象
          return { _raw: input, _parseError: "Parsed value is not an object" }
        } catch {
          // JSON 解析失败，包装成错误对象
          return { _raw: input, _parseError: "Invalid JSON" }
        }
      }
      // 其他类型，包装成对象
      return { _raw: String(input ?? ""), _parseError: "Unexpected input type" }
    },
    z.record(z.string(), z.any()),
  )

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: ToolInputSchema,
      raw: z.string(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: ToolInputSchema,
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: ToolInputSchema,
      output: z.string(),
      modelOutput: z.string().optional(),
      outputReference: z.string().optional(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: FilePart.array().optional(),
      modelAttachments: FilePart.array().optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: ToolInputSchema,
      error: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  const Base = z.object({
    id: z.string(),
    sessionID: z.string(),
  })

  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
      })
      .optional(),
    agent: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    variant: z.string().optional(),
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      SubtaskPart,
      CompactionRestorePart,
      ReasoningPart,
      FilePart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      AgentPart,
      RetryPart,
      CompactionPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema,
        NamedError.Unknown.Schema,
        OutputLengthError.Schema,
        AbortedError.Schema,
        APIError.Schema,
      ])
      .optional(),
    parentID: z.string(),
    modelID: z.string(),
    providerID: z.string(),
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    finish: z.string().optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  /** Internal compaction summaries belong to model context, not the researcher-visible transcript. */
  export function isInternalSummary(info: Info | { role?: unknown; summary?: unknown; mode?: unknown }) {
    return info.role === "assistant" && (info.summary === true || info.mode === "compaction")
  }

  export const Event = {
    Updated: BusEvent.define(
      "message.updated",
      z.object({
        info: Info,
      }),
    ),
    Removed: BusEvent.define(
      "message.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
    PartUpdated: BusEvent.define(
      "message.part.updated",
      z.object({
        part: Part,
        delta: z.string().optional(),
      }),
    ),
    PartRemoved: BusEvent.define(
      "message.part.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
        partID: z.string(),
      }),
    ),
  }

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type WithParts = z.infer<typeof WithParts>

  function toolRecoveryMarker(part: ToolPart) {
    if (part.state.status !== "completed") return undefined
    const reference = Truncate.outputReference(part.state.outputReference, part.state.metadata?.outputPath)
    if (!reference) return undefined
    if (!Truncate.referenceExists(reference)) {
      return `[工具 ${part.tool} 的完整输出引用 ${reference} 已失效；请重新运行该工具，不要继续承诺可分页恢复。]`
    }
    return `[Tool output for ${part.tool} is stored in ${reference}. Use Read with offset/limit to recover a needed section.]`
  }

  function isDataAttachment(part: FilePart) {
    const mime = part.mime.toLowerCase()
    return (
      isDataFile(part.filename ?? "") ||
      mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mime === "application/vnd.ms-excel"
    )
  }

  export function toolOutputForModel(
    output: unknown,
    model?: Provider.Model,
    mediaBudget = ToolResultProjection.createMediaBudget(),
  ) {
      if (typeof output === "string") {
        return { type: "text", value: output }
      }

      if (typeof output === "object") {
        const outputObject = output as {
          text: string
          attachments?: Array<{ mime: string; url: string }>
        }
        const capabilities = model?.capabilities?.input
        const projected = ToolResultProjection.projectMediaAttachments(
          outputObject.attachments,
          { image: capabilities?.image === true, pdf: capabilities?.pdf === true },
          mediaBudget,
        )
        return {
          type: "content",
          value: [
            { type: "text", text: outputObject.text },
            ...projected.attachments.map((attachment) => ({
              type: "media",
              mediaType: attachment.mime,
              data: iife(() => {
                const commaIndex = attachment.url.indexOf(",")
                return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
              }),
            })),
          ],
        }
      }

      return { type: "json", value: output as never }
  }

  export function toModelMessages(input: WithParts[], model: Provider.Model): ModelMessage[] {
    const result: UIMessage[] = []
    const toolNames = new Set<string>()
    const mediaBudget = ToolResultProjection.createMediaBudget()
    const toModelOutput = (output: unknown) => toolOutputForModel(output, model, mediaBudget)

    for (const msg of input) {
      if (msg.parts.length === 0) continue

      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        result.push(userMessage)
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored)
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          // text/plain and directory files are converted into text parts, ignore them
          if (
            part.type === "file" &&
            part.mime !== "text/plain" &&
            part.mime !== "application/x-directory" &&
            !isDataAttachment(part)
          )
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })

          if (part.type === "compaction") {
            userMessage.parts.push({
              type: "text",
              text: [
                `[上下文压缩边界：${part.auto ? "自动" : "手动"}`,
                part.reason ? `；原因=${part.reason}` : "",
                part.preCompactTokens !== undefined ? `；压缩前估算Token=${part.preCompactTokens}` : "",
                "；完整历史仍保留在磁盘。]",
              ].join(""),
            })
          }
          if (part.type === "compaction-restore") {
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          }
          if (part.type === "subtask") {
            userMessage.parts.push({
              type: "text",
              text: "用户已执行以下工具操作：",
            })
          }
        }
      }

      if (msg.info.role === "assistant") {
        const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`

        if (
          msg.info.error &&
          !(
            MessageV2.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        for (const part of msg.parts) {
          if (part.type === "text")
            assistantMessage.parts.push({
              type: "text",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: sanitizeProviderMetadata(part.metadata) }),
            })
          if (part.type === "compaction-restore")
            assistantMessage.parts.push({
              type: "text",
              text: part.text,
            })
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            toolNames.add(part.tool)
            if (part.state.status === "completed") {
              let outputText = part.state.time.compacted
                ? toolRecoveryMarker(part) ?? "[Old tool result content cleared]"
                : (part.state.modelOutput ? ToolResultProjection.boundModelOutput(part.state.modelOutput) : ToolResultProjection.legacy({
                    toolName: part.tool,
                    title: part.state.title,
                    output: part.state.output,
                    outputReference: Truncate.outputReference(part.state.outputReference, part.state.metadata?.outputPath),
                  }))
              const liveReference = Truncate.outputReference(part.state.outputReference, part.state.metadata?.outputPath)
              if (!part.state.time.compacted && liveReference && !Truncate.referenceExists(liveReference)) {
                outputText += `\n\n[完整输出引用 ${liveReference} 已失效；如需细节请重新运行原工具。]`
              }
              if (!part.state.time.compacted && part.state.attachments?.length && part.state.modelAttachments === undefined) {
                outputText = ToolResultProjection.boundModelOutput(
                  `${outputText}\n\n[旧 Session 的媒体附件缺少模型投影记录，已为安全起见省略；可重新运行原工具。]`,
                )
              }
              // 持久化字段、失效引用和兼容提示都属于不可信磁盘输入；所有追加完成后
              // 再执行最后一道单项收口，避免保护提示自身突破上下文预算。
              outputText = ToolResultProjection.boundModelOutput(outputText)
              const attachments = part.state.time.compacted ? [] : (part.state.modelAttachments ?? [])
              const output =
                attachments.length > 0
                  ? {
                      text: outputText,
                      attachments,
                    }
                  : outputText

              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            }
            if (part.state.status === "error")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            // Handle pending/running tool calls to prevent dangling tool_use blocks
            // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
            if (part.state.status === "pending" || part.state.status === "running")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: "[Tool execution was interrupted]",
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
          }
          if (part.type === "reasoning") {
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: sanitizeProviderMetadata(part.metadata) }),
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
        }
      }
    }

    const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

    return convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    )
  }

  export const stream = fn(Identifier.schema("session"), async function* (sessionID) {
    const list = await Array.fromAsync(await Storage.list(["message", sessionID]))
    for (let i = list.length - 1; i >= 0; i--) {
      yield await get({
        sessionID,
        messageID: list[i][2],
      })
    }
  })

  /**
   * compact_boundary 锚点：从会话尾部往回读，遇到最近一次压缩边界即停，不再往前读盘。
   *
   * 与 stream() 的区别是**磁盘 I/O 量**：stream 会把整个会话的 message+part 全部读出来
   * （长会话上千条），即使调用方（filterCompacted）只需要最近边界之后的那一段。
   * 这里把"读到哪停"下沉到读盘循环里，边界之前的消息一次都不 get()。
   * 磁盘上仍是 append-only 全量，只是不再每轮重建全文。
   */
  export const streamSinceCompactBoundary = fn(Identifier.schema("session"), async function* (sessionID) {
    const list = await Array.fromAsync(await Storage.list(["message", sessionID]))
    const completed = new Set<string>()
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = await get({ sessionID, messageID: list[i][2] })
      yield msg
      // 与 filterCompacted 同一套边界判定：成功压缩的 summary 消息标记其 parentID，
      // 读到那条被标记的 user 消息且它带 compaction part 时，边界之前的内容已被摘要覆盖。
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      )
        return
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish) completed.add(msg.info.parentID)
    }
  })

  export const parts = fn(Identifier.schema("message"), async (messageID) => {
    const result = [] as MessageV2.Part[]
    for (const item of await Storage.list(["part", messageID])) {
      const read = await Storage.read<MessageV2.Part>(item)
      result.push(read)
    }
    result.sort((a, b) => (a.id > b.id ? 1 : -1))
    return result
  })

  export const get = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      return {
        info: await Storage.read<MessageV2.Info>(["message", input.sessionID, input.messageID]),
        parts: await parts(input.messageID),
      }
    },
  )

  export async function filterCompacted(stream: AsyncIterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>()
    for await (const msg of stream) {
      result.push(msg)
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      )
        break
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish) completed.add(msg.info.parentID)
    }
    result.reverse()
    return result
  }

  export function fromError(e: unknown, ctx: { providerID: string }) {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new MessageV2.AbortedError(
          { message: summarizeToolError(e) },
          {
            cause: e,
          },
        ).toObject()
      case MessageV2.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerID: ctx.providerID,
            message: summarizeToolError(e),
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new MessageV2.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: summarizeToolError((e as SystemError).message ?? ""),
            },
          },
          { cause: e },
        ).toObject()
      case APICallError.isInstance(e):
        const message = summarizeToolError(
          iife(() => {
            let msg = e.message
            if (msg === "") {
              if (e.responseBody) return e.responseBody
              if (e.statusCode) {
                const err = STATUS_CODES[e.statusCode]
                if (err) return err
              }
              return "Unknown error"
            }
            const transformed = ProviderTransform.error(ctx.providerID, e)
            if (transformed !== msg) {
              return transformed
            }
            if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
              return msg
            }

            try {
              const body = JSON.parse(e.responseBody)
              // try to extract common error message fields
              const errMsg = body.message || body.error || body.error?.message
              if (errMsg && typeof errMsg === "string") {
                return `${msg}: ${errMsg}`
              }
            } catch {}

            return `${msg}: ${e.responseBody}`
          }).trim(),
        )

        const metadata = e.url ? { url: summarizeToolError(e.url, 2 * 1024) } : undefined
        return new MessageV2.APIError(
          {
            message,
            statusCode: e.statusCode,
            isRetryable: e.isRetryable,
            responseHeaders: sanitizeErrorResponseHeaders(e.responseHeaders),
            responseBody: e.responseBody ? summarizeToolError(e.responseBody) : undefined,
            metadata,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        return new NamedError.Unknown({ message: summarizeToolError(e) }, { cause: e }).toObject()
      default:
        return new NamedError.Unknown({ message: summarizeToolError(e) }, { cause: e }).toObject()
    }
  }
}
