import { Instance } from "../project/instance"

type AnalystPlanState = {
  asked: boolean
  preference?: "plan_first" | "direct"
  blockedOnce?: boolean
}

type ExplorerConfirmationState = {
  confirmedActions: Record<string, boolean>
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
    return analyst()[sessionID] ?? { asked: false }
  }

  export function setAnalyst(sessionID: string, state: AnalystPlanState) {
    analyst()[sessionID] = state
  }

  export function getExplorer(sessionID: string) {
    return explorer()[sessionID] ?? { confirmedActions: {} }
  }

  export function confirmExplorerAction(sessionID: string, signature: string) {
    const state = getExplorer(sessionID)
    state.confirmedActions[signature] = true
    explorer()[sessionID] = state
  }

  export function isExplorerActionConfirmed(sessionID: string, signature: string) {
    return !!getExplorer(sessionID).confirmedActions[signature]
  }
}

