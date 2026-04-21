export type ReasoningExpansionState = Record<string, boolean>

export function isReasoningExpanded(state: ReasoningExpansionState, partID: string) {
  return state[partID] === true
}

export function toggleReasoningExpandedState(state: ReasoningExpansionState, partID: string) {
  return {
    ...state,
    [partID]: !isReasoningExpanded(state, partID),
  }
}
