import crypto from "crypto"
import type { ModelMessage } from "ai"
import { serializeForTokenEstimate } from "./context-budget"

export type PromptFingerprintInput = {
  modelID: string
  providerID: string
  effort?: string
  variant?: string
  system: string[]
  /** 稳定 system 前缀；缺省时兼容旧调用，把完整 system 当作稳定部分。 */
  stableSystem?: string[]
  /** 当前轮目录、环境和 hook 等动态 system 尾部。 */
  dynamicSystemTail?: string[]
  tools: Record<string, unknown>
  /** 已经通过 tool_search 装载的方法引用；只参与动态尾部，不进入稳定 tools 前缀。 */
  dynamicMethodReferences?: readonly unknown[]
  messages: ModelMessage[]
  providerOptions?: Record<string, unknown>
  contextVersion?: number
}

export type PromptFingerprint = PromptFingerprintInput & {
  systemHash: string
  stableSystemHash: string
  dynamicSystemTailHash: string
  stableToolSchemaHash: string
  dynamicMethodTailHash: string
  /** 兼容已有 ledger / 调试消费者；其值等于 stableToolSchemaHash。 */
  toolSchemaHash: string
  providerOptionsHash: string
  promptHash: string
}

export function fingerprintFromHashes(input: {
  modelID: string
  providerID: string
  effort?: string
  variant?: string
  systemHash: string
  stableSystemHash?: string
  dynamicSystemTailHash?: string
  toolSchemaHash: string
  stableToolSchemaHash?: string
  dynamicMethodTailHash?: string
  providerOptionsHash: string
  promptHash: string
}): PromptFingerprint {
  return {
    modelID: input.modelID,
    providerID: input.providerID,
    effort: input.effort,
    variant: input.variant,
    system: [],
    tools: {},
    messages: [],
    providerOptions: {},
    systemHash: input.systemHash,
    stableSystemHash: input.stableSystemHash ?? input.systemHash,
    dynamicSystemTailHash: input.dynamicSystemTailHash ?? "",
    stableToolSchemaHash: input.stableToolSchemaHash ?? input.toolSchemaHash,
    dynamicMethodTailHash: input.dynamicMethodTailHash ?? "",
    toolSchemaHash: input.stableToolSchemaHash ?? input.toolSchemaHash,
    providerOptionsHash: input.providerOptionsHash,
    promptHash: input.promptHash,
  }
}

function hash(value: unknown) {
  return crypto.createHash("sha256").update(serializeForTokenEstimate(value)).digest("hex")
}

export function promptFingerprint(input: PromptFingerprintInput): PromptFingerprint {
  const stableSystemHash = hash(input.stableSystem ?? input.system)
  const dynamicSystemTailHash = hash(input.dynamicSystemTail ?? [])
  const stableToolSchemaHash = hash(input.tools)
  const dynamicMethodTailHash = hash(input.dynamicMethodReferences ?? [])
  const providerOptionsHash = hash(input.providerOptions ?? {})
  return {
    ...input,
    stableSystemHash,
    dynamicSystemTailHash,
    // 兼容已有 ledger / 调试消费者；systemHash 代表可复用的稳定前缀。
    systemHash: stableSystemHash,
    stableToolSchemaHash,
    dynamicMethodTailHash,
    toolSchemaHash: stableToolSchemaHash,
    providerOptionsHash,
    promptHash: hash({
      modelID: input.modelID,
      providerID: input.providerID,
      effort: input.effort,
      variant: input.variant,
      system: input.system,
      stableSystem: input.stableSystem ?? input.system,
      dynamicSystemTail: input.dynamicSystemTail ?? [],
      tools: input.tools,
      dynamicMethodReferences: input.dynamicMethodReferences ?? [],
      messages: input.messages,
      providerOptions: input.providerOptions ?? {},
      contextVersion: input.contextVersion,
    }),
  }
}

export type CacheBreakReason =
  | "first_request"
  | "model_changed"
  | "system_changed"
  | "tools_changed"
  | "dynamic_prompt_tail_changed"
  | "dynamic_method_tail_changed"
  | "provider_options_changed"
  | "context_changed"
  | "unexpected"

export function classifyCacheBreak(previous: PromptFingerprint | undefined, current: PromptFingerprint): CacheBreakReason {
  if (!previous) return "first_request"
  if (previous.modelID !== current.modelID || previous.providerID !== current.providerID) return "model_changed"
  if ((previous.stableSystemHash ?? previous.systemHash) !== current.stableSystemHash) return "system_changed"
  if ((previous.stableToolSchemaHash ?? previous.toolSchemaHash) !== current.stableToolSchemaHash) return "tools_changed"
  if ((previous.dynamicMethodTailHash ?? "") !== current.dynamicMethodTailHash) return "dynamic_method_tail_changed"
  if ((previous.dynamicSystemTailHash ?? "") !== current.dynamicSystemTailHash) return "dynamic_prompt_tail_changed"
  if (previous.providerOptionsHash !== current.providerOptionsHash) return "provider_options_changed"
  if (previous.contextVersion !== current.contextVersion) return "context_changed"
  return "unexpected"
}
