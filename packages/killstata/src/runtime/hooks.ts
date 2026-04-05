import type { LifecycleHookResult } from "./types"

export type InputAcceptedHook = (input: {
  sessionID: string
  action: string
  metadata?: Record<string, unknown>
}) => Promise<LifecycleHookResult | void> | LifecycleHookResult | void

export type PromptAssembledHook = (input: {
  sessionID: string
  agent: string
  system: string[]
}) => Promise<LifecycleHookResult | void> | LifecycleHookResult | void

export type PreToolHook = (input: {
  sessionID: string
  toolName: string
  args: unknown
}) => Promise<LifecycleHookResult | void> | LifecycleHookResult | void

export type PostToolHook = (input: {
  sessionID: string
  messageID: string
  agent: string
  model: {
    providerID: string
    modelID: string
  }
  toolName: string
  args: unknown
  result: {
    title: string
    metadata: Record<string, unknown>
    output: string
    attachments?: unknown[]
  }
}) => Promise<LifecycleHookResult | void> | LifecycleHookResult | void

export type PostToolFailureHook = (input: {
  sessionID: string
  messageID?: string
  agent?: string
  model?: {
    providerID: string
    modelID: string
  }
  toolName: string
  args: unknown
  error: unknown
}) => Promise<LifecycleHookResult | void> | LifecycleHookResult | void

export type TurnFinishedHook = (input: {
  sessionID: string
  result: string
}) => Promise<LifecycleHookResult | void> | LifecycleHookResult | void

export type CompactionHook = (input: {
  sessionID: string
  phase: string
  metadata?: Record<string, unknown>
}) => Promise<LifecycleHookResult | void> | LifecycleHookResult | void

async function collect(results: Array<LifecycleHookResult | void>) {
  const output: LifecycleHookResult = {}
  for (const result of results) {
    if (!result) continue
    if (result.block) output.block = result.block
    if (result.preventContinuation) output.preventContinuation = true
    if (result.updatedInput !== undefined) output.updatedInput = result.updatedInput
    if (result.repair) output.repair = result.repair
    if (result.appendSystem?.length) {
      output.appendSystem = [...(output.appendSystem ?? []), ...result.appendSystem]
    }
    if (result.metadata) {
      output.metadata = {
        ...(output.metadata ?? {}),
        ...result.metadata,
      }
    }
  }
  return output
}

export namespace RuntimeHooks {
  const inputAcceptedHooks: InputAcceptedHook[] = []
  const promptAssembledHooks: PromptAssembledHook[] = []
  const preToolHooks: PreToolHook[] = []
  const postToolHooks: PostToolHook[] = []
  const postToolFailureHooks: PostToolFailureHook[] = []
  const turnFinishedHooks: TurnFinishedHook[] = []
  const compactionHooks: CompactionHook[] = []

  export function registerInputAccepted(hook: InputAcceptedHook) {
    if (inputAcceptedHooks.includes(hook)) return
    inputAcceptedHooks.push(hook)
  }

  export function registerPromptAssembled(hook: PromptAssembledHook) {
    if (promptAssembledHooks.includes(hook)) return
    promptAssembledHooks.push(hook)
  }

  export function registerPreTool(hook: PreToolHook) {
    if (preToolHooks.includes(hook)) return
    preToolHooks.push(hook)
  }

  export function registerPostTool(hook: PostToolHook) {
    if (postToolHooks.includes(hook)) return
    postToolHooks.push(hook)
  }

  export function registerPostToolFailure(hook: PostToolFailureHook) {
    if (postToolFailureHooks.includes(hook)) return
    postToolFailureHooks.push(hook)
  }

  export function registerTurnFinished(hook: TurnFinishedHook) {
    if (turnFinishedHooks.includes(hook)) return
    turnFinishedHooks.push(hook)
  }

  export function registerCompaction(hook: CompactionHook) {
    if (compactionHooks.includes(hook)) return
    compactionHooks.push(hook)
  }

  export async function inputAccepted(input: Parameters<InputAcceptedHook>[0]) {
    return collect(await Promise.all(inputAcceptedHooks.map((hook) => hook(input))))
  }

  export async function promptAssembled(input: Parameters<PromptAssembledHook>[0]) {
    return collect(await Promise.all(promptAssembledHooks.map((hook) => hook(input))))
  }

  export async function preTool(input: Parameters<PreToolHook>[0]) {
    return collect(await Promise.all(preToolHooks.map((hook) => hook(input))))
  }

  export async function postTool(input: Parameters<PostToolHook>[0]) {
    return collect(await Promise.all(postToolHooks.map((hook) => hook(input))))
  }

  export async function postToolFailure(input: Parameters<PostToolFailureHook>[0]) {
    return collect(await Promise.all(postToolFailureHooks.map((hook) => hook(input))))
  }

  export async function turnFinished(input: Parameters<TurnFinishedHook>[0]) {
    return collect(await Promise.all(turnFinishedHooks.map((hook) => hook(input))))
  }

  export async function compaction(input: Parameters<CompactionHook>[0]) {
    return collect(await Promise.all(compactionHooks.map((hook) => hook(input))))
  }
}
