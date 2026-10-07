import type { SubagentContract, SubagentWriteIntent, ToolExecutionTraits } from "./types"
import { Tool } from "@/tool/tool"

export function toolExecutionTraits(execution: Tool.ExecutionPolicy | undefined, args?: unknown): ToolExecutionTraits {
  const resolved = execution?.resolve ? execution.resolve(args) : execution ?? ToolExecutionFallback
  const sideEffectLevel = resolved.sideEffect
  const requiresConfirmation = resolved.approval === "confirm"

  if (sideEffectLevel === "none") {
    return {
      concurrencySafe: resolved.concurrency === "parallel",
      approval: resolved.approval,
      confirmation: resolved.approval === "confirm" ? resolved.confirmation : undefined,
      requiresConfirmation: false,
      sideEffectLevel: "none",
      interruptBehavior: "cancel",
      resultBudget: 12_000,
    }
  }

  if (sideEffectLevel === "session") {
    return {
      concurrencySafe: false,
      approval: resolved.approval,
      confirmation: resolved.approval === "confirm" ? resolved.confirmation : undefined,
      requiresConfirmation,
      sideEffectLevel: "session",
      interruptBehavior: "continue",
    }
  }

  if (sideEffectLevel === "filesystem") {
    return {
      concurrencySafe: false,
      approval: resolved.approval,
      confirmation: resolved.approval === "confirm" ? resolved.confirmation : undefined,
      requiresConfirmation,
      sideEffectLevel: "filesystem",
      interruptBehavior: "continue",
    }
  }

  return {
    concurrencySafe: resolved.concurrency === "parallel",
    approval: resolved.approval,
    confirmation: resolved.approval === "confirm" ? resolved.confirmation : undefined,
    requiresConfirmation,
    sideEffectLevel: "external",
    interruptBehavior: "continue",
  }
}

const ToolExecutionFallback: Tool.ExecutionPolicy = {
  readOnly: false,
  approval: "blocked",
  concurrency: "serial",
  sideEffect: "external",
  timeout: { kind: "bounded", timeoutMs: Tool.Timeout.DEFAULT_MS },
}

export function subagentWriteIntent(agent: string): SubagentWriteIntent {
  if (agent === "explore" || agent === "verifier") return "read_only"
  if (agent === "general") return "mutating"
  return "analysis"
}

export function createSubagentContract(input: {
  description: string
  agent: string
  sessionID: string
  summary: string
  findings?: string[]
  producedArtifacts?: string[]
  nextStepRecommendation?: string
}): SubagentContract {
  return {
    description: input.description,
    writeIntent: subagentWriteIntent(input.agent),
    summary: input.summary,
    findings: input.findings ?? [],
    producedArtifacts: input.producedArtifacts ?? [],
    nextStepRecommendation: input.nextStepRecommendation ?? "",
    sessionID: input.sessionID,
    agent: input.agent,
  }
}
