import { Session } from "@/session"
import { toolIDsByFamily } from "@/runtime/tool-manifest"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"

type ScriptedModelRequest = {
  sessionID: string
  agent?: { name?: string }
  small?: boolean
  textOnly?: boolean
  tools?: { definitions?: Record<string, unknown> }
}

type AnalysisRequestKind = "inspect" | "estimate" | "explain" | "repair"

let registrationCallSequence = 0

/**
 * Deterministic ModelGateway fixtures must follow the model-visible first-turn contract:
 * register the current data request before importing, diagnosing, searching, or estimating.
 * Real Provider behavior is tested separately; this helper only scripts that protocol step.
 */
export async function scriptedAnalysisRequestResponse(
  request: ScriptedModelRequest,
): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> } | undefined> {
  if (request.small || request.textOnly || request.agent?.name === "verifier") return undefined
  const definitions = request.tools?.definitions ?? {}
  if (Object.keys(definitions).length !== 1 || !Object.hasOwn(definitions, "analysis_request")) return undefined

  const ledger = RuntimeTaskLedger.listTasks(request.sessionID)
  const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
  if (!task?.messageID || task.analysisRequest) return undefined

  const messages = await Session.messages({ sessionID: request.sessionID })
  const source = messages.find((message) => message.info.id === task.messageID)
  const userText = source?.parts
    .map((part) => {
      if (part.type !== "text" || part.synthetic || part.ignored) return ""
      return part.text.trim()
    })
    .filter(Boolean)
    .join("\n")
  const requiredToolIDs = [
    ...(Array.isArray(task.metadata?.requiredToolIDs)
      ? task.metadata.requiredToolIDs.filter((id): id is string => typeof id === "string")
      : []),
    ...(Array.isArray(task.metadata?.confirmedToolIDs)
      ? task.metadata.confirmedToolIDs.filter((id): id is string => typeof id === "string")
      : []),
  ]
  const estimatorToolIDs = new Set([
    ...toolIDsByFamily("diagnostic", "estimator", "runner"),
    "composite_evaluation",
  ])
  const hasEstimateTarget = requiredToolIDs.some((id) => estimatorToolIDs.has(id))
  const hasDataRepair = requiredToolIDs.includes("data_preprocess")
  const intent = task.metadata?.intent
  const kind: AnalysisRequestKind = hasEstimateTarget
    ? "estimate"
    : intent === "repair" || hasDataRepair
      ? "repair"
      : intent === "conversation" || intent === "status"
        ? "explain"
        : "inspect"
  const callId = `call_scripted_analysis_request_${++registrationCallSequence}`
  const input = {
    kind,
    researchGoal: (userText || "处理当前用户的数据请求").slice(0, 1000),
    constraints: [],
  }

  return {
    fullStream: (async function* () {
      yield { type: "start" }
      yield { type: "start-step" }
      yield { type: "tool-input-start", id: callId, toolName: "analysis_request" }
      yield { type: "tool-call", toolCallId: callId, toolName: "analysis_request", input }
      yield {
        type: "finish-step",
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      }
      yield { type: "finish" }
    })(),
  }
}
