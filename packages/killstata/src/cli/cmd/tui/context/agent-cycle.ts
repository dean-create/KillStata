export interface CycleAgent {
  name: string
}

const TAB_CYCLE_AGENT_NAMES = new Set(["analyst", "explorer"])

export function pickTabCycleAgents<T extends CycleAgent>(agents: T[]): T[] {
  const preferred = agents.filter((agent) => TAB_CYCLE_AGENT_NAMES.has(agent.name))
  return preferred.length > 0 ? preferred : agents
}

export function nextTabCycleIndex(input: {
  agents: CycleAgent[]
  currentName: string
  direction: 1 | -1
}) {
  const { agents, currentName, direction } = input
  if (agents.length === 0) return -1

  const currentIndex = agents.findIndex((agent) => agent.name === currentName)
  if (currentIndex === -1) return direction === 1 ? 0 : agents.length - 1

  let next = currentIndex + direction
  if (next < 0) next = agents.length - 1
  if (next >= agents.length) next = 0
  return next
}
