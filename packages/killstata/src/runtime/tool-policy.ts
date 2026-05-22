import type { SubagentContract, SubagentWriteIntent, ToolExecutionTraits } from "./types"
import { toolSideEffectLevel } from "./tool-catalog"

export function toolExecutionTraits(toolName: string, args?: unknown): ToolExecutionTraits {
  const sideEffectLevel = toolSideEffectLevel(toolName, args)

  if (sideEffectLevel === "none") {
    return {
      concurrencySafe: true,
      sideEffectLevel: "none",
      interruptBehavior: "cancel",
      resultBudget: 12_000,
    }
  }

  if (sideEffectLevel === "session") {
    return {
      concurrencySafe: false,
      sideEffectLevel: "session",
      interruptBehavior: "continue",
    }
  }

  if (sideEffectLevel === "filesystem") {
    return {
      concurrencySafe: false,
      sideEffectLevel: "filesystem",
      interruptBehavior: "continue",
    }
  }

  return {
    concurrencySafe: false,
    sideEffectLevel: "external",
    interruptBehavior: "continue",
  }
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
