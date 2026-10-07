import { Instance } from "../project/instance"

type AnalystPlanState = {
  planGenerated: boolean
  planApproved: boolean
  planDeclined: boolean
  generatedAt?: string
  approvedAt?: string
}

export namespace AnalysisIntent {
  const analyst = Instance.state(() => {
    const data: Record<string, AnalystPlanState> = {}
    return data
  })

  export function getAnalyst(sessionID: string) {
    return analyst()[sessionID] ?? { planGenerated: false, planApproved: false, planDeclined: false }
  }

  export function setAnalyst(sessionID: string, state: AnalystPlanState) {
    analyst()[sessionID] = state
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
