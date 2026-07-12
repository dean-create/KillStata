import { Instance } from "../project/instance"

type AnalystPlanState = {
  planGenerated: boolean
  planApproved: boolean
  planDeclined: boolean
  generatedAt?: string
  approvedAt?: string
}

type ExplorerConfirmationState = {
  confirmedActions: Record<string, boolean>
  hasPreparedData: boolean
  lastAction?: string
  lastDatasetId?: string
  lastStageId?: string
  lastRunId?: string
  lastBranch?: string
  updatedAt?: string
}

export namespace AnalysisIntent {
  const analyst = Instance.state(() => {
    const data: Record<string, AnalystPlanState> = {}
    return data
  })

  const explorer = Instance.state(() => {
    const data: Record<string, ExplorerConfirmationState> = {}
    return data
  })

  export function getAnalyst(sessionID: string) {
    return analyst()[sessionID] ?? { planGenerated: false, planApproved: false, planDeclined: false }
  }

  export function setAnalyst(sessionID: string, state: AnalystPlanState) {
    analyst()[sessionID] = state
  }

  export function getExplorer(sessionID: string) {
    return explorer()[sessionID] ?? { confirmedActions: {}, hasPreparedData: false }
  }

  export function confirmExplorerAction(sessionID: string, signature: string) {
    const state = getExplorer(sessionID)
    state.confirmedActions[signature] = true
    explorer()[sessionID] = state
  }

  export function isExplorerActionConfirmed(sessionID: string, signature: string) {
    return !!getExplorer(sessionID).confirmedActions[signature]
  }

  export function markExplorerPrepared(
    sessionID: string,
    input: {
      action: string
      datasetId?: string
      stageId?: string
      runId?: string
      branch?: string
    },
  ) {
    explorer()[sessionID] = {
      ...getExplorer(sessionID),
      hasPreparedData: true,
      lastAction: input.action,
      lastDatasetId: input.datasetId,
      lastStageId: input.stageId,
      lastRunId: input.runId,
      lastBranch: input.branch,
      updatedAt: new Date().toISOString(),
    }
  }

  export function markAnalystPlanGenerated(sessionID: string) {
    const current = getAnalyst(sessionID)
    analyst()[sessionID] = {
      ...current,
      planGenerated: true,
      planDeclined: false,
      generatedAt: current.generatedAt ?? new Date().toISOString(),
    }
  }

  export function markAnalystPlanApproval(sessionID: string, approved: boolean) {
    const current = getAnalyst(sessionID)
    analyst()[sessionID] = {
      ...current,
      planGenerated: true,
      planApproved: approved,
      planDeclined: !approved,
      generatedAt: current.generatedAt ?? new Date().toISOString(),
      approvedAt: approved ? new Date().toISOString() : current.approvedAt,
    }
  }
}
