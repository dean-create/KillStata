import type { AnalysisRequestRecord, PreparedSpecRecord, WorkflowInputIntent } from "./types"

const DATA_WORK_INTENTS = new Set<WorkflowInputIntent>(["analysis", "ingest", "repair"])

/** True only for a data-bearing user turn that has not yet been durably registered. */
export function needsAnalysisRequestRegistration(input: {
  agent: string
  intent: WorkflowInputIntent
  userMessageId?: string
  hasDataAttachment: boolean
  hasExplicitDataSource: boolean
  hasActiveDataset: boolean
  request?: AnalysisRequestRecord
}) {
  if (input.agent === "verifier") return false
  const hasData = input.hasDataAttachment || input.hasExplicitDataSource ||
    (DATA_WORK_INTENTS.has(input.intent) && input.hasActiveDataset)
  if (!hasData) return false
  return !input.userMessageId || input.request?.sourceMessageId !== input.userMessageId
}

/** Estimate 请求不能仅靠助手正文收尾，除非当前 stage 已准备规格或已到明确停点。 */
export function needsAnalysisPreparation(input: {
  request?: AnalysisRequestRecord
  preparedSpec?: PreparedSpecRecord
  currentData?: { datasetId: string; stageId: string } | null
  hasDecisionStop: boolean
  hasSuccessfulEstimate: boolean
}) {
  const request = input.request
  if (!request || request.kind !== "estimate" || input.hasDecisionStop || input.hasSuccessfulEstimate) return false
  const prepared = input.preparedSpec
  return !(
    prepared &&
    input.currentData &&
    prepared.requestId === request.requestId &&
    prepared.sourceMessageId === request.sourceMessageId &&
    prepared.datasetId === input.currentData.datasetId &&
    prepared.stageId === input.currentData.stageId
  )
}

/** A prepared specification is not an estimate result; estimate requests need a result or an explicit stop. */
export function needsAnalysisCompletion(input: {
  request?: AnalysisRequestRecord
  hasDecisionStop: boolean
  hasSuccessfulEstimate: boolean
}) {
  return Boolean(
    input.request?.kind === "estimate" &&
    !input.hasDecisionStop &&
    !input.hasSuccessfulEstimate,
  )
}
