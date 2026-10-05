export type ContextModel = {
  providerID: string
  id: string
  limit: {
    context?: number
    input?: number
    output?: number
  }
}

export type ContextUsageTokens = {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export type ContextCacheReport = {
  observationCount: number
  truncated: boolean
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  promptTokens: number
  hitRatio: number
  breakCount: number
  breakReasons: Record<string, number>
  lastBreakReason?: string
  updatedAt: string
}

export type ContextBudget = {
  contextLimit: number | null
  inputBudget: number | null
  reserveTokens: number
}

export type ContextUsageSource = "estimated" | "actual"
export type ContextCompactionState = "none" | "pending" | "microcompact" | "summary"

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const AUTOCOMPACT_SMALL_WINDOW_FRACTION = 0.2

/**
 * 第五层自动压缩线；inputBudget 已经扣除了本轮输出预留。
 * 大窗口沿用 Claude Code 风格的 13K 缓冲，小窗口按 20% 缩放，避免固定 13K
 * 让压缩后的系统前缀永远高于触发线而递归压缩。预算小于 13K 时没有可安全
 * 分配的压缩缓冲，保留 0 的硬边界并由上层报告窗口不足。
 */
export function autoCompactThreshold(inputBudget: number | null) {
  if (inputBudget === null) return null
  if (inputBudget <= AUTOCOMPACT_BUFFER_TOKENS) return 0
  const buffer = Math.min(
    AUTOCOMPACT_BUFFER_TOKENS,
    Math.floor(inputBudget * AUTOCOMPACT_SMALL_WINDOW_FRACTION),
  )
  return Math.max(0, inputBudget - buffer)
}

export type ContextUsageSnapshot = {
  providerID: string
  modelID: string
  contextLimit: number | null
  inputBudget: number | null
  reserveTokens: number
  estimatedPromptTokens: number
  estimatedSystemTokens: number
  estimatedToolTokens: number
  estimatedMessageTokens: number
  actual?: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    promptTokens: number
    usedTokens: number
  }
  usedTokens: number
  remainingTokens: number | null
  percentage: number | null
  source: ContextUsageSource
  compactionState: ContextCompactionState
  updatedAt: string
  cache?: ContextCacheReport
}

const DEFAULT_OUTPUT_RESERVE = 32_000

function positive(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 模型窗口的统一口径：输入预算 = 模型输入上限，或完整窗口扣除本轮输出预留。
 * 不知道窗口上限时返回 null，调用方不能据此伪造百分比或主动压缩。
 */
export function contextBudget(model: ContextModel, outputReserveTokens?: number): ContextBudget {
  const contextLimit = positive(model.limit.context) ?? null
  const configuredOutput = positive(outputReserveTokens) ?? positive(model.limit.output)
  const reserveTokens = Math.max(0, Math.min(configuredOutput ?? DEFAULT_OUTPUT_RESERVE, DEFAULT_OUTPUT_RESERVE))
  const explicitInputBudget = positive(model.limit.input)
  const inputBudget = explicitInputBudget ?? (contextLimit === null ? null : Math.max(0, contextLimit - reserveTokens))

  return {
    contextLimit,
    inputBudget,
    reserveTokens,
  }
}

/** Provider 返回的 input token 已在 Session.getUsage 中拆成非缓存 input；缓存片段再单独计入窗口。 */
export function contextTokens(tokens: ContextUsageTokens) {
  const promptTokens = Math.max(0, tokens.input) + Math.max(0, tokens.cache.read) + Math.max(0, tokens.cache.write)
  return {
    promptTokens,
    usedTokens: promptTokens + Math.max(0, tokens.output) + Math.max(0, tokens.reasoning),
  }
}

export function contextPercentage(usedTokens: number, inputBudget: number | null) {
  if (inputBudget === null || inputBudget <= 0) return null
  return Math.round((Math.max(0, usedTokens) / inputBudget) * 100)
}

/**
 * 用于估算工具描述的稳定序列化。execute 函数本身不进入 prompt，但要保留 schema、描述等字段。
 * 统一排序避免对象键顺序变化造成估算和 fingerprint 之外的额外漂移。
 */
function encodedMedia(value: Record<string, unknown>) {
  const type = value.type
  let encoded: string | undefined
  let mime: string | undefined
  if (type === "media" && typeof value.data === "string") {
    encoded = value.data
    mime = typeof value.mediaType === "string" ? value.mediaType : undefined
  } else if (type === "image" && typeof value.image === "string") {
    encoded = value.image
  } else if (type === "file" && typeof value.data === "string") {
    encoded = value.data
    mime = typeof value.mediaType === "string" ? value.mediaType : undefined
  } else {
    return undefined
  }

  const dataMatch = encoded.match(/^data:([^;,]+);base64,(.+)$/)
  if (dataMatch) {
    mime ??= dataMatch[1]
    encoded = dataMatch[2]
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length === 0 || encoded.length % 4 !== 0) return undefined
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  const bytes = Math.max(0, Math.floor(encoded.length * 3 / 4) - padding)
  return { mime: mime?.toLowerCase() ?? "application/octet-stream", bytes }
}

function mediaTokenProxy(media: { mime: string; bytes: number }) {
  // 没有图片尺寸/PDF页数时按字节做保守代理，但绝不展开 Base64：
  // 图片约 1 token/512B + 256 固定视觉开销；PDF更保守地按 1/256B + 512。
  const estimatedTokens = media.mime === "application/pdf"
    ? Math.ceil(media.bytes / 256) + 512
    : Math.ceil(media.bytes / 512) + 256
  return `{"mediaType":${JSON.stringify(media.mime)},"bytes":${media.bytes},"mediaTokenProxy":"${"x".repeat(estimatedTokens * 4)}"}`
}

export function serializeForTokenEstimate(value: unknown): string {
  if (typeof value === "function") return "[function]"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map(serializeForTokenEstimate).join(",")}]`
  if (value && typeof value === "object") {
    const media = encodedMedia(value as Record<string, unknown>)
    if (media) return mediaTokenProxy(media)
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${serializeForTokenEstimate(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

/** 两种来源（估算 / provider 实际用量）共用的窗口描述字段。 */
function snapshotBase(model: ContextModel, budget: ContextBudget) {
  return {
    providerID: model.providerID,
    modelID: model.id,
    contextLimit: budget.contextLimit,
    inputBudget: budget.inputBudget,
    reserveTokens: budget.reserveTokens,
  }
}

export function contextUsageFromEstimate(input: {
  model: ContextModel
  budget: ContextBudget
  estimatedPromptTokens: number
  estimatedSystemTokens: number
  estimatedToolTokens: number
  estimatedMessageTokens: number
  compactionState?: ContextCompactionState
  updatedAt?: string
}): ContextUsageSnapshot {
  const usedTokens = Math.max(0, input.estimatedPromptTokens)
  return {
    ...snapshotBase(input.model, input.budget),
    estimatedPromptTokens: usedTokens,
    estimatedSystemTokens: Math.max(0, input.estimatedSystemTokens),
    estimatedToolTokens: Math.max(0, input.estimatedToolTokens),
    estimatedMessageTokens: Math.max(0, input.estimatedMessageTokens),
    usedTokens,
    remainingTokens: input.budget.inputBudget === null ? null : input.budget.inputBudget - usedTokens,
    percentage: contextPercentage(usedTokens, input.budget.inputBudget),
    source: "estimated",
    compactionState: input.compactionState ?? "none",
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
}

export function contextUsageFromActual(input: {
  model: ContextModel
  budget: ContextBudget
  tokens: ContextUsageTokens
  estimated?: Pick<
    ContextUsageSnapshot,
    "estimatedPromptTokens" | "estimatedSystemTokens" | "estimatedToolTokens" | "estimatedMessageTokens"
  >
  compactionState?: ContextCompactionState
  updatedAt?: string
}): ContextUsageSnapshot {
  const actual = contextTokens(input.tokens)
  return {
    ...snapshotBase(input.model, input.budget),
    estimatedPromptTokens: input.estimated?.estimatedPromptTokens ?? actual.promptTokens,
    estimatedSystemTokens: input.estimated?.estimatedSystemTokens ?? 0,
    estimatedToolTokens: input.estimated?.estimatedToolTokens ?? 0,
    estimatedMessageTokens: input.estimated?.estimatedMessageTokens ?? 0,
    actual: {
      inputTokens: Math.max(0, input.tokens.input),
      outputTokens: Math.max(0, input.tokens.output),
      reasoningTokens: Math.max(0, input.tokens.reasoning),
      cacheReadTokens: Math.max(0, input.tokens.cache.read),
      cacheWriteTokens: Math.max(0, input.tokens.cache.write),
      promptTokens: actual.promptTokens,
      usedTokens: actual.usedTokens,
    },
    usedTokens: actual.usedTokens,
    remainingTokens: input.budget.inputBudget === null ? null : input.budget.inputBudget - actual.usedTokens,
    percentage: contextPercentage(actual.usedTokens, input.budget.inputBudget),
    source: "actual",
    compactionState: input.compactionState ?? "none",
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
}
