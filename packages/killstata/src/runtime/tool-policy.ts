import type { SubagentContract, SubagentWriteIntent, ToolExecutionTraits } from "./types"

const READ_ONLY_TOOLS = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "codesearch",
  "todoread",
  "question",
  "skill",
  "lsp",
  "workflow",
])

const SESSION_TOOLS = new Set(["todowrite", "question", "plan_enter", "plan_exit"])
const FILESYSTEM_TOOLS = new Set([
  "bash",
  "shell",
  "edit",
  "write",
  "apply_patch",
  "data_import",
  "econometrics",
  "regression_table",
  "task",
])

export function toolExecutionTraits(toolName: string): ToolExecutionTraits {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return {
      concurrencySafe: true,
      sideEffectLevel: "none",
      interruptBehavior: "cancel",
      resultBudget: 12_000,
    }
  }

  if (SESSION_TOOLS.has(toolName)) {
    return {
      concurrencySafe: false,
      sideEffectLevel: "session",
      interruptBehavior: "continue",
    }
  }

  if (FILESYSTEM_TOOLS.has(toolName)) {
    return {
      concurrencySafe: false,
      sideEffectLevel: toolName === "task" ? "external" : "filesystem",
      interruptBehavior: "continue",
    }
  }

  if (toolName.startsWith("mcp_")) {
    return {
      concurrencySafe: false,
      sideEffectLevel: "external",
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
