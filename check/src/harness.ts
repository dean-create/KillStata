import { Bus } from "../../packages/killstata/src/bus"
import { RuntimeEvents } from "../../packages/killstata/src/runtime/events"
import { SessionProcessor } from "../../packages/killstata/src/session/processor"

export type HarnessEvidence = {
  schemaAccepted: boolean
  executorCalls: number
  lifecycle: string[]
  result: unknown
}

export function assertHarnessEvidence(evidence: HarnessEvidence) {
  if (!evidence.schemaAccepted) throw new Error("Harness schema validation did not accept the fixed parameters")
  if (evidence.executorCalls !== 1) throw new Error("Harness must invoke the tool executor exactly once")
  const expected = ["queued", "running", "completed"]
  if (!expected.every((phase, index) => evidence.lifecycle[index] === phase)) {
    throw new Error(`Harness lifecycle is incomplete: ${evidence.lifecycle.join(" → ")}`)
  }
  if (!evidence.result || typeof evidence.result !== "object" || Array.isArray(evidence.result)) {
    throw new Error("Harness must return a structured result, not raw log text")
  }
  return { status: "PASS" as const }
}

export async function executeThroughHarness(input: {
  sessionID: string
  messageID: string
  callID: string
  toolID: string
  params: Record<string, unknown>
  ctx: { abort: AbortSignal; [key: string]: unknown }
  execute: (params: Record<string, unknown>) => Promise<{ metadata?: { result?: unknown } }>
}) {
  const lifecycle: string[] = []
  const unsubscribe = Bus.subscribe(RuntimeEvents.ToolLifecycle, (event) => {
    if (event.properties.sessionID === input.sessionID && event.properties.callID === input.callID) {
      lifecycle.push(event.properties.phase)
    }
  })
  let executorCalls = 0
  try {
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: input.messageID,
        sessionID: input.sessionID,
        agent: "econometrics",
      } as never,
      sessionID: input.sessionID,
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: input.ctx.abort,
    })
    const execution = await processor.executeTool(input.toolID, input.params, {
      callID: input.callID,
      run: async (params) => {
        executorCalls += 1
        return input.execute(params as Record<string, unknown>) as never
      },
    })
    const evidence = {
      schemaAccepted: true,
      executorCalls,
      lifecycle,
      result: execution.metadata.result,
    }
    assertHarnessEvidence(evidence)
    return { execution, evidence }
  } finally {
    unsubscribe()
  }
}
