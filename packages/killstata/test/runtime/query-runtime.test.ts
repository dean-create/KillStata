import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import {
  QueryRuntime,
  isRepeatedToolCall,
  repeatedToolCallCount,
  toolCallSignature,
} from "@/runtime/query-runtime"
import { RuntimeHooks } from "@/runtime/hooks"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { Instance } from "@/project/instance"
import type { QueryEvent } from "@/runtime/types"

const spies: Array<{ mockRestore(): void }> = []

afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore()
})

describe("query runtime tool safety", () => {
  test("native tool failures enter the repair lifecycle exactly once", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_1",
        toolName: "ols_regression",
        input: { datasetId: "dataset_1", stageId: "stage_001" },
        error: new Error("backend exploded"),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(MessageV2, "parts").mockResolvedValue([]))
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(LLM, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    const postFailure = spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      metadata: { workflowFailure: { code: "ESTIMATION_FAILED" } },
      repair: {
        toolName: "ols_regression",
        retryStage: "baseline_estimate",
        repairAction: "修复设定后重试",
      },
    })
    spies.push(postFailure)
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: {
        id: "message_1",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () =>
        ({
          state: {
            status: "running",
            input: { datasetId: "dataset_1", stageId: "stage_001" },
            metadata: { reflection: { failureType: "estimation_failure" } },
          },
        }) as unknown as MessageV2.ToolPart,
    })

    const events: QueryEvent[] = []
    for await (const event of runtime.run({
      tools: {},
    } as never)) {
      events.push(event)
    }

    expect(postFailure).toHaveBeenCalledTimes(1)
    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      metadata: { workflowFailure: { code: "ESTIMATION_FAILED" } },
      repair: { toolName: "ols_regression", retryStage: "baseline_estimate" },
    })
    expect(events.at(-1)).toMatchObject({
      type: "turn-finish",
      result: { type: "repair", toolName: "ols_regression" },
    })
  })

  test("an unavailable native tool enters the bounded repair lifecycle without locking a fake method", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_missing",
        toolName: "hallucinated_estimator",
        input: { dependentVar: "y" },
        error: new Error("Model tried to call unavailable tool 'hallucinated_estimator'."),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(LLM, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({}))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: {
        id: "message_missing",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })

    const events: QueryEvent[] = []
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        for await (const event of runtime.run({ tools: {} } as never)) events.push(event)
      },
    })

    expect(events.at(-1)).toMatchObject({
      type: "turn-finish",
      result: {
        type: "repair",
        toolName: "hallucinated_estimator",
        lockTool: false,
      },
    })
  })

  test("an uppercase known estimator failure locks repair to its canonical tool name", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_uppercase",
        toolName: "OLS_REGRESSION",
        input: { datasetId: "dataset_1", dependentVar: 123 },
        error: new Error("Invalid arguments for tool OLS_REGRESSION."),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(LLM, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({}))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: {
        id: "message_uppercase",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })

    const events: QueryEvent[] = []
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        for await (const event of runtime.run({ tools: {} } as never)) events.push(event)
      },
    })

    expect(events.at(-1)).toMatchObject({
      type: "turn-finish",
      result: {
        type: "repair",
        toolName: "ols_regression",
        lockTool: true,
      },
    })
  })

  test("repeat detection ignores the pending current call and inspects the prior completed calls", () => {
    const completed = Array.from({ length: 3 }, (_, index) => ({
      type: "tool",
      callID: `previous_${index}`,
      tool: "ols_regression",
      state: { status: "completed", input: { datasetId: "dataset_1" } },
    })) as unknown as MessageV2.ToolPart[]
    const pending = {
      type: "tool",
      callID: "current",
      tool: "ols_regression",
      state: { status: "pending", input: {} },
    } as MessageV2.ToolPart

    expect(
      isRepeatedToolCall([...completed, pending], {
        toolCallId: "current",
        toolName: "ols_regression",
        input: { datasetId: "dataset_1" },
      }),
    ).toBe(true)
  })

  test("repeat detection is not bypassed by changing JSON object key order", () => {
    const completed = Array.from({ length: 3 }, (_, index) => ({
      type: "tool",
      callID: `previous_${index}`,
      tool: "ols_regression",
      state: { status: "completed", input: { stageId: "stage_001", datasetId: "dataset_1" } },
    })) as unknown as MessageV2.ToolPart[]

    expect(isRepeatedToolCall(completed, {
      toolCallId: "current",
      toolName: "ols_regression",
      input: { datasetId: "dataset_1", stageId: "stage_001" },
    })).toBe(true)
  })

  test("repeat detection uses completed history even when the provider reuses a tool-call id", () => {
    const completed = Array.from({ length: 3 }, () => ({
      type: "tool",
      callID: "call_0",
      tool: "ols_regression",
      state: { status: "completed", input: { datasetId: "dataset_1" } },
    })) as unknown as MessageV2.ToolPart[]

    expect(isRepeatedToolCall(completed, {
      toolCallId: "call_0",
      toolName: "ols_regression",
      input: { datasetId: "dataset_1" },
    })).toBe(true)
  })

  test("repeat history excludes running calls because the in-memory counter owns them", () => {
    const running = Array.from({ length: 3 }, (_, index) => ({
      type: "tool",
      callID: `running_${index}`,
      tool: "ols_regression",
      state: { status: "running", input: { datasetId: "dataset_1" } },
    })) as unknown as MessageV2.ToolPart[]

    expect(repeatedToolCallCount(running, {
      toolCallId: "current",
      toolName: "ols_regression",
      input: { datasetId: "dataset_1" },
    })).toBe(0)
  })

  test("a user permission rejection does not create a fake workflow failure", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_rejected",
        toolName: "ols_regression",
        input: { datasetId: "dataset_1", stageId: "stage_001" },
        error: new PermissionNext.RejectedError(),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(LLM, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    const postFailure = spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({})
    spies.push(postFailure)
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: {
        id: "message_rejected",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () =>
        ({
          state: {
            status: "running",
            input: { datasetId: "dataset_1", stageId: "stage_001" },
            metadata: { reflection: { failureType: "estimation_failure" } },
          },
        }) as unknown as MessageV2.ToolPart,
    })

    const events = []
    for await (const event of runtime.run({ tools: {} } as never)) events.push(event)

    expect(postFailure).toHaveBeenCalledTimes(0)
    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      blocked: true,
      error: "用户已取消本次工具执行。",
    })
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
  })

  test("large backend errors are redacted and bounded before hooks or model context", async () => {
    const raw = new Error(`回归失败 api_key=sk-private-error-value ${"x".repeat(20_000)}`)
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_large_error",
        toolName: "ols_regression",
        input: { datasetId: "dataset_1", stageId: "stage_001" },
        error: raw,
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(LLM, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    const postFailure = spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      metadata: {
        clientSecret: "hook-failure-secret",
        matrix: Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => "x".repeat(2_048))),
      },
    })
    spies.push(postFailure)
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_error", sessionID: "session_1", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () =>
        ({
          state: {
            status: "running",
            input: { datasetId: "dataset_1", stageId: "stage_001" },
            metadata: { reflection: { failureType: "estimation_failure" } },
          },
        }) as unknown as MessageV2.ToolPart,
    })

    const events = []
    for await (const event of runtime.run({ tools: {} } as never)) events.push(event)
    const hookError = postFailure.mock.calls[0]?.[0].error
    const visible = events.find((event) => event.type === "tool-error")

    expect(typeof hookError).toBe("string")
    expect(Buffer.byteLength(String(hookError))).toBeLessThanOrEqual(4 * 1024)
    expect(String(hookError)).toContain("[已脱敏]")
    expect(String(hookError)).not.toContain("sk-private-error-value")
    expect(visible).toMatchObject({ error: hookError })
    const failureMetadata = JSON.stringify((visible as Extract<QueryEvent, { type: "tool-error" }>).metadata)
    expect(Buffer.byteLength(failureMetadata)).toBeLessThanOrEqual(32 * 1024)
    expect(failureMetadata).not.toContain("hook-failure-secret")
  })

  test("post-tool hook metadata is sanitized and bounded at the final success boundary", async () => {
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(RuntimeHooks, "preTool").mockResolvedValue({}))
    spies.push(spyOn(RuntimeHooks, "postTool").mockResolvedValue({
      metadata: {
        clientSecret: "hook-success-secret",
        matrix: Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => "x".repeat(2_048))),
      },
    }))
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_hook_metadata",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
    })

    const result = await Instance.provide({
      directory: process.cwd(),
      fn: () => processor.executeTool("ols_regression", { datasetId: "dataset_1" }, {
        callID: "hook_metadata",
        run: async () => ({ title: "OLS", metadata: { method: "ols_regression" }, output: "done" }),
      }),
    })
    const metadata = JSON.stringify(result.metadata)

    expect(Buffer.byteLength(metadata)).toBeLessThanOrEqual(32 * 1024)
    expect(metadata).not.toContain("hook-success-secret")
    expect(result.metadata).toMatchObject({ metadataTruncated: true })
  })

  test("native doom-loop rejection happens before the estimator executor starts", async () => {
    const previousMessages = Array.from({ length: 3 }, (_, index) => ({
      info: { id: `assistant_${index}`, role: "assistant" },
      parts: [
        {
          type: "tool",
          callID: `previous_${index}`,
          tool: "ols_regression",
          state: {
            status: "completed",
            input: { datasetId: "dataset_1", stageId: "stage_001" },
          },
        },
      ],
    }))

    spies.push(spyOn(Session, "messages").mockResolvedValue(previousMessages as never))
    spies.push(spyOn(Agent, "get").mockResolvedValue({ permission: [] } as never))
    const ask = spyOn(PermissionNext, "ask").mockRejectedValue(new PermissionNext.RejectedError())
    spies.push(ask)
    spies.push(spyOn(RuntimeHooks, "preTool").mockResolvedValue({}))
    spies.push(spyOn(RuntimeHooks, "postTool").mockResolvedValue({}))

    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_current",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
    })
    const run = mock(async () => ({ title: "OLS", metadata: {}, output: "done" }))

    expect(
      processor.executeTool(
        "ols_regression",
        { datasetId: "dataset_1", stageId: "stage_001" },
        { callID: "current", run },
      ),
    ).rejects.toBeInstanceOf(PermissionNext.RejectedError)

    expect(ask).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(0)
  })

  test("the fourth identical tool call in one model response cannot bypass the doom-loop gate", async () => {
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(Agent, "get").mockResolvedValue({ permission: [] } as never))
    const ask = spyOn(PermissionNext, "ask").mockRejectedValue(new PermissionNext.RejectedError())
    spies.push(ask)
    spies.push(spyOn(RuntimeHooks, "preTool").mockResolvedValue({}))
    spies.push(spyOn(RuntimeHooks, "postTool").mockResolvedValue({}))

    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_concurrent",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
    })
    const run = mock(async () => ({ title: "Read", metadata: {}, output: "done" }))

    const results = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        Promise.allSettled(
          Array.from({ length: 4 }, (_, index) =>
            processor.executeTool(
              "read",
              { filePath: "dataset.csv", offset: 0, limit: 100 },
              { callID: `same_response_${index}`, run },
            ),
          ),
        ),
    })

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(3)
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(3)
  })

  test("repeat protection combines two historical calls with concurrent calls in the current response", async () => {
    const previousMessages = Array.from({ length: 2 }, (_, index) => ({
      info: { id: `assistant_mixed_${index}`, role: "assistant" },
      parts: [
        {
          type: "tool",
          callID: `previous_mixed_${index}`,
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "dataset.csv", offset: 0, limit: 100 },
          },
        },
      ],
    }))
    spies.push(spyOn(Session, "messages").mockResolvedValue(previousMessages as never))
    spies.push(spyOn(Agent, "get").mockResolvedValue({ permission: [] } as never))
    const ask = spyOn(PermissionNext, "ask").mockRejectedValue(new PermissionNext.RejectedError())
    spies.push(ask)
    spies.push(spyOn(RuntimeHooks, "preTool").mockResolvedValue({}))
    spies.push(spyOn(RuntimeHooks, "postTool").mockResolvedValue({}))

    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_mixed_repeat",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
    })
    const run = mock(async () => ({ title: "Read", metadata: {}, output: "done" }))

    const results = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        Promise.allSettled(
          Array.from({ length: 2 }, (_, index) =>
            processor.executeTool(
              "read",
              { filePath: "dataset.csv", offset: 0, limit: 100 },
              { callID: `current_mixed_${index}`, run },
            ),
          ),
        ),
    })

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  test("automatic repair rejects switching to a different estimator before hooks or execution", async () => {
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({})
    spies.push(preTool)
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_repair",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      repairToolName: "ols_regression",
    })
    const run = mock(async () => ({ title: "Panel FE", metadata: {}, output: "done" }))

    expect(
      processor.executeTool(
        "panel_fe_regression",
        { datasetId: "dataset_1", stageId: "stage_001" },
        { callID: "method_switch", run },
      ),
    ).rejects.toThrow("REPAIR_TOOL_MISMATCH")
    expect(preTool).toHaveBeenCalledTimes(0)
    expect(run).toHaveBeenCalledTimes(0)
  })

  test("automatic repair keeps the method lock through reads and releases it only after estimator success", async () => {
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(RuntimeHooks, "preTool").mockResolvedValue({}))
    spies.push(spyOn(RuntimeHooks, "postTool").mockResolvedValue({}))
    const onRepairToolSucceeded = mock(() => {})
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_repair_success",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      repairToolName: "ols_regression",
      onRepairToolSucceeded,
    })
    const run = mock(async () => ({ title: "Done", metadata: {}, output: "done" }))

    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        await processor.executeTool("read", { filePath: "dataset.csv" }, { callID: "repair_read", run })
        expect(onRepairToolSucceeded).toHaveBeenCalledTimes(0)
        await processor.executeTool(
          "ols_regression",
          { datasetId: "dataset_1", stageId: "stage_001" },
          { callID: "repair_ols", run },
        )
      },
    })

    expect(onRepairToolSucceeded).toHaveBeenCalledTimes(1)
  })

  test("automatic repair blocks workflow rerun from executing a different recorded estimator", async () => {
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({})
    spies.push(preTool)
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_repair_rerun",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      repairToolName: "ols_regression",
    })
    const run = mock(async () => ({ title: "Rerun", metadata: {}, output: "done" }))

    expect(
      processor.executeTool("workflow", { action: "rerun", stageId: "old_panel_stage" }, { callID: "rerun", run }),
    ).rejects.toThrow("REPAIR_WORKFLOW_MUTATION_DENIED")
    expect(preTool).toHaveBeenCalledTimes(0)
    expect(run).toHaveBeenCalledTimes(0)
  })

  test("automatic repair rejects unchanged estimator parameters before execution", async () => {
    const failedInput = { datasetId: "dataset_1", stageId: "stage_001", dependentVar: "y" }
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({})
    spies.push(preTool)
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_repair_unchanged",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      repairToolName: "ols_regression",
      repairInputSignature: toolCallSignature("ols_regression", failedInput),
    })
    const run = mock(async () => ({ title: "OLS", metadata: {}, output: "done" }))

    expect(
      processor.executeTool("ols_regression", { dependentVar: "y", stageId: "stage_001", datasetId: "dataset_1" }, {
        callID: "unchanged",
        run,
      }),
    ).rejects.toThrow("REPAIR_INPUT_UNCHANGED")
    expect(preTool).toHaveBeenCalledTimes(0)
    expect(run).toHaveBeenCalledTimes(0)
  })
})
