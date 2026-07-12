import type { QueryLifecyclePhase, SessionRunState } from "./types"

type GuardState = "idle" | "dispatching" | "running"

export class QueryGuard {
  private state: GuardState = "idle"
  private generation = 0

  snapshot(pending: number, action?: string): SessionRunState {
    const phase: QueryLifecyclePhase = this.state === "idle" ? "idle" : this.state
    return {
      phase,
      generation: this.generation,
      pending,
      action: action as SessionRunState["action"],
    }
  }

  accept() {
    return this.snapshot(0)
  }

  tryDispatch(): number | undefined {
    if (this.state !== "idle") return undefined
    this.state = "dispatching"
    this.generation += 1
    return this.generation
  }

  start(generation: number) {
    if (this.generation !== generation) return false
    this.state = "running"
    return true
  }

  finish(generation: number) {
    if (this.generation !== generation) return false
    this.state = "idle"
    return true
  }

  cancelDispatch(generation: number) {
    if (this.generation !== generation) return false
    if (this.state !== "dispatching") return false
    this.state = "idle"
    return true
  }

  get active() {
    return this.state !== "idle"
  }
}
