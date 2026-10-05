import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { AgentEngine } from "@/runtime/engine"

describe("AgentEngine Tool-Use Loop", () => {
  test("does not import workflow, data, or concrete tool business modules", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "engine", "engine.ts"), "utf-8")

    for (const forbidden of ["pipeline", "econometrics", "DataContext", "@/tool/"]) {
      expect(source).not.toContain(forbidden)
    }
  })

  test("drives a generic request-tool-result-request loop without business knowledge", async () => {
    type Event =
      | { type: "call"; id: string; name: string; input: { path: string } }
      | { type: "result"; id: string; output: string }
      | { type: "error"; id: string; error: string }
      | { type: "end"; decision: string }
    type Call = Extract<Event, { type: "call" }>
    const requests: string[][] = []
    const rounds: Event[][] = [
      [{ type: "call", id: "call-1", name: "read", input: { path: "data.csv" } }],
      [{ type: "end", decision: "stop" }],
    ]

    const events = []
    for await (const event of AgentEngine.runToolUse<string[], Event, Call, string, string>({
      request: ["user: inspect data"],
      adapter: {
        async stream(request) {
          requests.push(request)
          return (async function* () {
            yield* rounds.shift() ?? []
          })()
        },
        callFromEvent(event) {
          return event.type === "call" ? event : undefined
        },
        decisionFromEvent(event) {
          return event.type === "end" ? event.decision : undefined
        },
        async execute(call) {
          return `result:${call.input.path}`
        },
        resultEvent(call, output) {
          return { type: "result", id: call.id, output }
        },
        errorEvent(call, error) {
          return { type: "error", id: call.id, error: String(error) }
        },
        appendToolResults(request, results) {
          return [...request, ...results.map((result) => `tool:${result.call.name}=${result.output}`)]
        },
        async onToolError() {
          return undefined
        },
        continues(decision) {
          return decision === "continue"
        },
        terminalEvent(decision) {
          return { type: "end", decision }
        },
      },
    })) {
      events.push(event)
    }

    expect(requests).toEqual([
      ["user: inspect data"],
      ["user: inspect data", "tool:read=result:data.csv"],
    ])
    expect(events).toEqual([
      { type: "call", id: "call-1", name: "read", input: { path: "data.csv" } },
      { type: "result", id: "call-1", output: "result:data.csv" },
      { type: "end", decision: "stop" },
    ])
  })

  test("returns the adapter's repair decision without interpreting the business failure", async () => {
    const events = []
    for await (const event of AgentEngine.runToolUse<string, { type: "end"; decision: "repair" }, never, never, "repair">({
      request: "user",
      adapter: {
        stream: async function* () {
          yield { type: "end", decision: "repair" }
        },
        callFromEvent: () => undefined,
        decisionFromEvent: (event) => event.decision,
        execute: async () => {
          throw new Error("unreachable")
        },
        resultEvent: () => ({ type: "end", decision: "repair" }),
        errorEvent: () => ({ type: "end", decision: "repair" }),
        appendToolResults: (request) => request,
        onToolError: async () => undefined,
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) {
      events.push(event)
    }
    expect(events).toEqual([{ type: "end", decision: "repair" }])
  })

  test("混合批次出现可修复错误时保留成功结果并继续下一轮", async () => {
    type Event =
      | { type: "call"; id: string }
      | { type: "result"; id: string; output: string }
      | { type: "error"; id: string; error: string }
      | { type: "end"; decision: "repair" | "stop" }
    type Call = Extract<Event, { type: "call" }>
    const requests: string[][] = []
    const events: Event[] = []
    let preparedFailureCount: number | undefined
    let round = 0

    for await (const event of AgentEngine.runToolUse<string[], Event, Call, string, "repair" | "stop">({
      request: ["user"],
      adapter: {
        stream(request) {
          requests.push(request)
          return (async function* () {
            if (round++ === 0) {
              yield { type: "call", id: "broken" }
              yield { type: "call", id: "recovered" }
            } else {
              yield { type: "end", decision: "stop" }
            }
          })()
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        execute: async (call) => {
          if (call.id === "broken") throw new Error("invalid input")
          return "ok"
        },
        resultEvent: (call, output) => ({ type: "result", id: call.id, output }),
        errorEvent: (call, error) => ({ type: "error", id: call.id, error: String(error) }),
        prepareToolResults: (results, failureCount) => {
          preparedFailureCount = failureCount
          return results
        },
        appendToolResults: (request, results, failures = []) => [
          ...request,
          ...results.map(({ call, output }) => `tool:${call.id}=${output}`),
          ...failures.map(({ call, error }) => `error:${call.id}=${String(error)}`),
        ],
        async onToolError() {
          return "repair"
        },
        continueAfterMixedToolFailure: ({ succeeded }) => succeeded.length > 0,
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(requests).toEqual([["user"], ["user", "tool:recovered=ok", "error:broken=Error: invalid input"]])
    expect(preparedFailureCount).toBe(1)
    expect(events).toEqual([
      { type: "call", id: "broken" },
      { type: "call", id: "recovered" },
      { type: "error", id: "broken", error: "Error: invalid input" },
      { type: "result", id: "recovered", output: "ok" },
      { type: "end", decision: "stop" },
    ])
  })

  test("同一批次后出现终止错误时不能被前面的修复决定吞掉", async () => {
    type Decision = "repair" | "stop"
    type Event =
      | { type: "call"; id: string }
      | { type: "error"; id: string; error: string }
      | { type: "end"; decision: Decision }
    type Call = Extract<Event, { type: "call" }>
    const requests: string[] = []
    const events: Event[] = []
    let round = 0

    for await (const event of AgentEngine.runToolUse<string, Event, Call, string, Decision>({
      request: "user",
      adapter: {
        stream() {
          requests.push(`round-${round}`)
          return (async function* () {
            if (round++ === 0) {
              yield { type: "call", id: "repairable" }
              yield { type: "call", id: "terminal" }
            }
          })()
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        execute: async (call) => {
          throw new Error(call.id === "terminal" ? "design stop" : "temporary failure")
        },
        resultEvent: () => ({ type: "end", decision: "repair" }),
        errorEvent: (call, error) => ({ type: "error", id: call.id, error: String(error) }),
        appendToolResults: (request) => request,
        onToolError: async (event) => event.type === "error" && event.id === "terminal" ? "stop" : "repair",
        mergeToolErrorDecisions: (current, next) => current === "stop" || next === "stop" ? "stop" : current ?? next,
        continues: (decision) => decision === "repair",
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(requests).toEqual(["round-0"])
    expect(events).toEqual([
      { type: "call", id: "repairable" },
      { type: "call", id: "terminal" },
      { type: "error", id: "repairable", error: "Error: temporary failure" },
      { type: "error", id: "terminal", error: "Error: design stop" },
      { type: "end", decision: "stop" },
    ])
  })

  test("uses prepared outputs consistently even when the adapter returns cloned call records", async () => {
    type Event = { type: "call"; id: string } | { type: "result"; output: string } | { type: "end"; decision: string }
    type Call = Extract<Event, { type: "call" }>
    const events: Event[] = []
    const appended: string[] = []
    let round = 0

    for await (const event of AgentEngine.runToolUse<string, Event, Call, string, string>({
      request: "request",
      adapter: {
        stream: async function* () {
          if (round++ === 0) yield { type: "call", id: "call-1" }
          else yield { type: "end", decision: "stop" }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        execute: async () => "raw",
        prepareToolResults: (results) => results.map(({ call }) => ({ call: { ...call }, output: "projected" })),
        resultEvent: (_call, output) => ({ type: "result", output }),
        errorEvent: () => ({ type: "end", decision: "stop" }),
        appendToolResults: (request, results) => {
          appended.push(...results.map((item) => item.output))
          return request
        },
        onToolError: async () => undefined,
        continues: (decision) => decision === "continue",
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(events).toContainEqual({ type: "result", output: "projected" })
    expect(appended).toEqual(["projected"])
  })

  test("并行执行只读调用，串行执行有副作用调用并保持模型调用顺序", async () => {
    type Event =
      | { type: "call"; id: string; parallel: boolean }
      | { type: "end"; decision: string }
    type Call = Extract<Event, { type: "call" }>
    const order: string[] = []
    const releaseRead = Promise.withResolvers<void>()
    let round = 0

    for await (const _event of AgentEngine.runToolUse<string, Event, Call, string, string>({
      request: "request",
      adapter: {
        stream: async function* () {
          if (round++ === 0) {
            yield { type: "call", id: "read-1", parallel: true }
            yield { type: "call", id: "read-2", parallel: true }
            yield { type: "call", id: "write-1", parallel: false }
          } else {
            yield { type: "end", decision: "stop" }
          }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        canExecuteInParallel: (call) => call.parallel,
        execute: async (call) => {
          order.push(`${call.id}-start`)
          if (call.id === "read-2" && order.includes("read-1-start")) releaseRead.resolve()
          if (call.parallel) await releaseRead.promise
          order.push(`${call.id}-end`)
          return call.id
        },
        resultEvent: () => ({ type: "end", decision: "continue" }),
        errorEvent: () => ({ type: "end", decision: "stop" }),
        appendToolResults: (request) => request,
        onToolError: async () => undefined,
        continues: (decision) => decision === "continue",
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) {}

    expect(order).toEqual([
      "read-1-start", "read-2-start", "read-1-end", "read-2-end", "write-1-start", "write-1-end",
    ])
  })

  test("只读批次默认最多同时执行十个调用", async () => {
    type Event =
      | { type: "call"; id: string; parallel: true }
      | { type: "end"; decision: "stop" }
    type Call = Extract<Event, { type: "call" }>
    let active = 0
    let maxActive = 0
    let round = 0

    for await (const _event of AgentEngine.runToolUse<string, Event, Call, string, "stop">({
      request: "request",
      adapter: {
        stream: async function* () {
          if (round++ === 0) {
            for (let index = 0; index < 25; index++) yield { type: "call", id: `read-${index}`, parallel: true }
          } else {
            yield { type: "end", decision: "stop" }
          }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        canExecuteInParallel: () => true,
        execute: async (call) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await Promise.resolve()
          active -= 1
          return call.id
        },
        resultEvent: () => ({ type: "end", decision: "stop" }),
        errorEvent: () => ({ type: "end", decision: "stop" }),
        appendToolResults: (request) => request,
        onToolError: async () => "stop",
        continues: (decision) => decision !== "stop",
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) {}

    expect(maxActive).toBeLessThanOrEqual(10)
  })

  test("串行调用失败后不执行同一响应中排队的后续调用", async () => {
    type Event =
      | { type: "call"; id: string; parallel: boolean }
      | { type: "error"; id: string; error: string; skipped?: boolean }
      | { type: "end"; decision: "stop" }
    type Call = Extract<Event, { type: "call" }>
    const executed: string[] = []
    const events: Event[] = []

    for await (const event of AgentEngine.runToolUse<string, Event, Call, string, "stop">({
      request: "request",
      adapter: {
        stream: async function* () {
          yield { type: "call", id: "estimate", parallel: false }
          yield { type: "call", id: "validate-after-failure", parallel: false }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: () => undefined,
        canExecuteInParallel: (call) => call.parallel,
        execute: async (call) => {
          executed.push(call.id)
          if (call.id === "estimate") throw new Error("design guard")
          return "unexpected"
        },
        resultEvent: () => ({ type: "end", decision: "stop" }),
        errorEvent: (call, error) => ({ type: "error", id: call.id, error: String(error), skipped: String(error).includes("未执行") }),
        appendToolResults: (request) => request,
        onToolError: async () => "stop",
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(executed).toEqual(["estimate"])
    expect(events).toContainEqual(expect.objectContaining({ type: "error", id: "validate-after-failure", skipped: true }))
  })

  test("终止决策已到达时，不执行本响应中尚未执行的工具并明确标记跳过", async () => {
    type Event =
      | { type: "call"; id: string }
      | { type: "error"; id: string; error: string; skipped?: boolean }
      | { type: "end"; decision: "stop" }
    type Call = Extract<Event, { type: "call" }>
    const events: Event[] = []
    const executed: string[] = []

    for await (const event of AgentEngine.runToolUse<string, Event, Call, string, "stop">({
      request: "request",
      adapter: {
        stream: async function* () {
          yield { type: "call", id: "must-not-run" }
          yield { type: "end", decision: "stop" }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        execute: async (call) => { executed.push(call.id); return "unexpected" },
        resultEvent: () => ({ type: "end", decision: "stop" }),
        errorEvent: (call, error) => ({ type: "error", id: call.id, error: String(error), skipped: String(error).includes("未执行") }),
        appendToolResults: (request) => request,
        onToolError: async () => "stop",
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(executed).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ type: "error", id: "must-not-run", skipped: true }))
  })

  test("终止决策后的迟到 tool-call 不能重新打开本轮执行", async () => {
    type Event = { type: "call"; id: string } | { type: "end"; decision: "stop" }
    type Call = Extract<Event, { type: "call" }>
    const executed: string[] = []
    const events: Event[] = []

    for await (const event of AgentEngine.runToolUse<string, Event, Call, string, "stop">({
      request: "request",
      adapter: {
        stream: async function* () {
          yield { type: "end", decision: "stop" }
          yield { type: "call", id: "late-call" }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        execute: async (call) => { executed.push(call.id); return "unexpected" },
        resultEvent: () => ({ type: "end", decision: "stop" }),
        errorEvent: () => ({ type: "end", decision: "stop" }),
        appendToolResults: (request) => request,
        onToolError: async () => "stop",
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(executed).toEqual([])
    expect(events).toEqual([{ type: "end", decision: "stop" }])
  })

  test("工具错误处理器崩溃时仍保存原工具错误并由适配器发出终止事件", async () => {
    type Event =
      | { type: "call"; id: string }
      | { type: "error"; id: string; error: string }
      | { type: "end"; decision: "stop"; stage?: string }
    type Call = Extract<Event, { type: "call" }>
    const events: Event[] = []

    for await (const event of AgentEngine.runToolUse<string, Event, Call, string, "stop">({
      request: "request",
      adapter: {
        stream: async function* () { yield { type: "call", id: "broken" } },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        execute: async () => { throw new Error("native failure") },
        resultEvent: () => ({ type: "end", decision: "stop" }),
        errorEvent: (call, error) => ({ type: "error", id: call.id, error: String(error) }),
        appendToolResults: (request) => request,
        onToolError: async () => { throw new Error("failure hook crashed") },
        loopFailureEvent: ({ stage }) => ({ type: "end", decision: "stop", stage }),
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(events).toContainEqual({ type: "error", id: "broken", error: "Error: native failure" })
    expect(events).toContainEqual({ type: "end", decision: "stop", stage: "tool_error_handler" })
  })

  test("失败决策合并器不能把真实工具错误吞成无失败并继续", async () => {
    type Event = { type: "call"; id: string } | { type: "error"; id: string } | { type: "end"; decision: "stop"; stage?: string }
    type Call = Extract<Event, { type: "call" }>
    let rounds = 0
    const events: Event[] = []

    for await (const event of AgentEngine.runToolUse<string, Event, Call, string, "stop">({
      request: "request",
      adapter: {
        stream: async function* () {
          rounds += 1
          if (rounds === 1) yield { type: "call", id: "failed" }
          else yield { type: "end", decision: "stop" }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        execute: async () => { throw new Error("tool failed") },
        resultEvent: () => ({ type: "end", decision: "stop" }),
        errorEvent: (call) => ({ type: "error", id: call.id }),
        appendToolResults: (request) => request,
        onToolError: async () => "stop",
        mergeToolErrorDecisions: () => undefined,
        loopFailureEvent: ({ stage }) => ({ type: "end", decision: "stop", stage }),
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(rounds).toBe(1)
    expect(events).toContainEqual({ type: "end", decision: "stop", stage: "unhandled_tool_failure" })
  })

  test("结果已交付后上下文追加异常会终止循环且不重新执行工具", async () => {
    type Event =
      | { type: "call"; id: string }
      | { type: "result"; id: string; output: string }
      | { type: "end"; decision: "stop"; stage?: string }
    type Call = Extract<Event, { type: "call" }>
    let executionCount = 0
    const events: Event[] = []

    for await (const event of AgentEngine.runToolUse<string, Event, Call, string, "stop">({
      request: "request",
      adapter: {
        stream: async function* () {
          if (executionCount === 0) yield { type: "call", id: "write-once" }
          else yield { type: "end", decision: "stop" }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        execute: async () => { executionCount += 1; return "persisted" },
        resultEvent: (_call, output) => ({ type: "result", id: "write-once", output }),
        errorEvent: () => ({ type: "end", decision: "stop" }),
        appendToolResults: async () => { throw new Error("message append failed") },
        onToolError: async () => "stop",
        loopFailureEvent: ({ stage }) => ({ type: "end", decision: "stop", stage }),
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(executionCount).toBe(1)
    expect(events).toContainEqual({ type: "result", id: "write-once", output: "persisted" })
    expect(events).toContainEqual({ type: "end", decision: "stop", stage: "append_results" })
  })

  test("结果准备阶段失败时保留不确定状态并且不重新执行工具", async () => {
    type Event =
      | { type: "call"; id: string }
      | { type: "error"; id: string; error: string }
      | { type: "end"; decision: "stop"; stage?: string }
    type Call = Extract<Event, { type: "call" }>
    let round = 0
    let executionCount = 0
    let failureHandlerCount = 0
    const events: Event[] = []

    for await (const event of AgentEngine.runToolUse<string, Event, Call, string, "stop">({
      request: "request",
      adapter: {
        stream: async function* () {
          if (round++ === 0) {
            yield { type: "call", id: "may-have-written" }
            yield { type: "call", id: "real-error" }
          } else yield { type: "end", decision: "stop" }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        execute: async (call) => {
          executionCount += 1
          if (call.id === "real-error") throw new Error("native executor error")
          return "raw result"
        },
        canExecuteInParallel: () => true,
        prepareToolResults: () => { throw new Error("projection failed") },
        resultEvent: () => ({ type: "end", decision: "stop" }),
        errorEvent: (call, error) => ({ type: "error", id: call.id, error: String(error) }),
        appendToolResults: (request) => request,
        onToolError: async () => { failureHandlerCount += 1; return "stop" },
        loopFailureEvent: ({ stage }) => ({ type: "end", decision: "stop", stage }),
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(executionCount).toBe(2)
    expect(failureHandlerCount).toBe(1)
    expect(round).toBe(1)
    expect(events).toContainEqual({ type: "error", id: "real-error", error: "Error: native executor error" })
    expect(events).toContainEqual({ type: "end", decision: "stop", stage: "prepare_results" })
  })

  test("结果事件构造异常显式收尾且不重新执行已完成工具", async () => {
    type Event =
      | { type: "call"; id: string }
      | { type: "result"; id: string; output: string }
      | { type: "end"; decision: "stop"; stage?: string }
    let round = 0
    let executionCount = 0
    const events: Event[] = []

    for await (const event of AgentEngine.runToolUse<string, Event, { id: string }, string, "stop">({
      request: "request",
      adapter: {
        stream: async function* () {
          if (round++ === 0) yield { type: "call", id: "call-result-event" }
          else yield { type: "end", decision: "stop" }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? "stop" : undefined,
        execute: async () => { executionCount += 1; return "already executed" },
        resultEvent: (call, output) => { throw new Error(`result event ${call.id} serialization failed: ${output}`) },
        errorEvent: () => ({ type: "end", decision: "stop" }),
        appendToolResults: (request) => request,
        onToolError: async () => "stop",
        loopFailureEvent: ({ stage }) => ({ type: "end", decision: "stop", stage }),
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) events.push(event)

    expect(executionCount).toBe(1)
    expect(round).toBe(1)
    expect(events).toContainEqual({ type: "end", decision: "stop", stage: "result_event" })
  })

  test("成功结果声明本轮收尾时不执行同一响应中排队的后续调用", async () => {
    type Event =
      | { type: "call"; id: string }
      | { type: "end"; decision: "stop" }
    type Call = Extract<Event, { type: "call" }>
    const executed: string[] = []

    for await (const _event of AgentEngine.runToolUse<string, Event, Call, { done: boolean }, "stop">({
      request: "request",
      adapter: {
        stream: async function* () {
          yield { type: "call", id: "import" }
          yield { type: "call", id: "profile-after-finalize" }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: () => undefined,
        canExecuteInParallel: () => false,
        execute: async (call) => {
          executed.push(call.id)
          return { done: call.id === "import" }
        },
        shouldStopAfterResult: (output) => output.done,
        resultEvent: () => ({ type: "end", decision: "stop" }),
        errorEvent: () => ({ type: "end", decision: "stop" }),
        appendToolResults: (request) => request,
        shouldContinueAfterResults: () => false,
        decisionAfterResults: () => "stop",
        onToolError: async () => "stop",
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) {}

    expect(executed).toEqual(["import"])
  })

  test("并行只读调用失败后不执行后续串行副作用调用", async () => {
    type Event =
      | { type: "call"; id: string; parallel: boolean }
      | { type: "error"; id: string; error: string }
      | { type: "end"; decision: "stop" }
    type Call = Extract<Event, { type: "call" }>
    const executed: string[] = []

    for await (const _event of AgentEngine.runToolUse<string, Event, Call, string, "stop">({
      request: "request",
      adapter: {
        stream: async function* () {
          yield { type: "call", id: "read-failed", parallel: true }
          yield { type: "call", id: "write-after-failure", parallel: false }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: () => undefined,
        canExecuteInParallel: (call) => call.parallel,
        execute: async (call) => {
          executed.push(call.id)
          if (call.id === "read-failed") throw new Error("read failed")
          return "write executed"
        },
        resultEvent: () => ({ type: "end", decision: "stop" }),
        errorEvent: (call, error) => ({ type: "error", id: call.id, error: String(error) }),
        appendToolResults: (request) => request,
        onToolError: async () => "stop",
        continues: () => false,
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) {}

    expect(executed).toEqual(["read-failed"])
  })

  test("把批次位置传给适配器，但引擎不解释工具业务", async () => {
    type Event =
      | { type: "call"; id: string; parallel: boolean }
      | { type: "end"; decision: string }
    type Call = Extract<Event, { type: "call" }>
    const contexts: Array<{ batchSize?: number; batchIndex?: number }> = []
    let round = 0

    for await (const _event of AgentEngine.runToolUse<string, Event, Call, string, string>({
      request: "request",
      adapter: {
        stream: async function* () {
          if (round++ === 0) {
            yield { type: "call", id: "read", parallel: true }
            yield { type: "call", id: "estimate", parallel: false }
          } else {
            yield { type: "end", decision: "stop" }
          }
        },
        callFromEvent: (event) => event.type === "call" ? event : undefined,
        decisionFromEvent: (event) => event.type === "end" ? event.decision : undefined,
        canExecuteInParallel: (call) => call.parallel,
        execute: async (_call, context) => {
          contexts.push(context ?? {})
          return "ok"
        },
        resultEvent: () => ({ type: "end", decision: "continue" }),
        errorEvent: () => ({ type: "end", decision: "stop" }),
        appendToolResults: (request) => request,
        onToolError: async () => undefined,
        continues: (decision) => decision === "continue",
        terminalEvent: (decision) => ({ type: "end", decision }),
      },
    })) {}

    expect(contexts).toEqual([
      { batchSize: 2, batchIndex: 0 },
      { batchSize: 2, batchIndex: 1 },
    ])
  })
})
