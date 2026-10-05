import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import { Provider } from "@/provider/provider"
import { APICallError } from "ai"
import { delegatedToolCall, QueryRuntime, isRepeatedToolCall, repeatedToolCallCount, toolCallSignature } from "@/runtime/query-runtime"
import { RuntimeHooks } from "@/runtime/hooks"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { SessionProcessor } from "@/session/processor"
import { Instance } from "@/project/instance"
import type { QueryEvent } from "@/runtime/types"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import { WorkflowResultContractError } from "@/runtime/analysis-contract"
import { ToolExecutionAbortedError } from "@/runtime/tool-orchestrator"
import { Tool } from "@/tool/tool"
import { Token } from "@/util/token"
import { ToolResultProjection } from "@/runtime/tool-result-projection"

const spies: Array<{ mockRestore(): void }> = []

function seedRepairRerunStage(sessionID: string, stageId: string, toolName: string) {
  const state = readWorkflowSession(sessionID)
  state.runs.push({
    workflowRunId: `wf_${sessionID}`,
    sessionID,
    workflowMode: "econometrics",
    workflowLocale: "zh-CN",
    branch: "main",
    activeStage: "validate",
    stageSequence: [],
    edges: [],
    trustedArtifacts: [],
    analysisChecklist: [],
    stages: [{
      nodeId: `main:${stageId}`,
      stageId,
      kind: toolName === "data_import" ? "validate" : "baseline_estimate",
      status: "completed",
      branch: "main",
      toolName,
      replayInput: {},
      artifactRefs: [],
      trustedArtifacts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never)
  state.activeRunId = `wf_${sessionID}`
  writeWorkflowSession(state)
}

afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore()
})

describe("query runtime tool safety", () => {
  test("稳定计量路由在失败治理边界还原真实方法和参数", () => {
    expect(delegatedToolCall("econometrics_execute", {
      methodID: " ols_regression ",
      arguments: { dependentVar: "outcome" },
    })).toEqual({
      toolName: "ols_regression",
      input: { dependentVar: "outcome" },
    })
    expect(delegatedToolCall("econometrics_execute", { arguments: {} })).toEqual({
      toolName: "econometrics_execute",
      input: { arguments: {} },
    })
  })

  test("Panel FE省略默认聚类列时应与显式按实体聚类复用同一调用签名", () => {
    const base = {
      datasetId: "dataset_gf",
      stageId: "stage_000",
      dependentVar: "绿色金融指数",
      treatmentVar: "绿色信贷",
      covariates: [],
      entityVar: "地区",
      timeVar: "年份",
      covariance: "clustered",
    }

    expect(toolCallSignature("panel_fe_regression", base)).toBe(
      toolCallSignature("panel_fe_regression", { ...base, clusterVar: "地区" }),
    )
  })

  test("executes model tool calls through the resolved ToolPort", async () => {
    const rounds = [
      [
        { type: "tool-input-start", id: "call_port", toolName: "read" },
        { type: "tool-call", toolCallId: "call_port", toolName: "read", input: { path: "data.csv" } },
        { type: "finish" },
      ],
      [
        { type: "text-start" },
        { type: "text-delta", text: "读取完成" },
        { type: "text-end" },
        { type: "finish" },
      ],
    ]
    const fullStream = () =>
      (async function* () {
        yield* rounds.shift() ?? []
      })()
    const execute = mock(async () => ({ title: "读取数据", metadata: { rows: 3 }, output: "rows=3" }))

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async () => ({ fullStream: fullStream() }) as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_port", sessionID: "session_port", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_port",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({
      tools: {
        definitions: { read: { id: "read", description: "read", inputSchema: {} } },
        port: { execute },
      },
      messages: [],
    } as never)) {
      events.push(event)
    }

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: "call_port", name: "read", input: { path: "data.csv" } }))
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      toolCallId: "call_port",
      output: { output: "rows=3" },
    })
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "continue" })
  })

  test("工具交付完整报告后，下一轮只生成文字收尾且不再暴露工具", async () => {
    const requests: Array<{ textOnly?: boolean }> = []
    const rounds = [
      [
        { type: "tool-call", toolCallId: "call_quality", toolName: "data_import", input: { action: "import" } },
        { type: "finish" },
      ],
      [
        { type: "text-start" },
        { type: "text-delta", text: "数据质量体检已完成。" },
        { type: "text-end" },
        { type: "finish" },
      ],
    ]

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
      requests.push({ textOnly: request.textOnly })
      return {
        fullStream: (async function* () { yield* rounds.shift() ?? [] })(),
      } as never
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_quality", sessionID: "session_quality", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_quality",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({
      tools: {
        definitions: { data_import: { id: "data_import", description: "data", inputSchema: {} } },
        port: {
          execute: async () => ({
            title: "数据质量体检",
            output: "质量摘要已完成",
            metadata: { finalizeTextOnly: true },
          }),
        },
      },
      messages: [],
    } as never)) events.push(event)

    expect(requests).toEqual([{ textOnly: undefined }, { textOnly: true }])
    expect(events).toContainEqual({ type: "text-delta", text: "数据质量体检已完成。", providerMetadata: undefined })
  })

  test("质量检查结果标记 finalizeAfterResult 时不再额外请求模型或重新读取内部产物", async () => {
    const requests: Array<{ textOnly?: boolean }> = []
    const rounds = [[
      { type: "tool-call", toolCallId: "call_validate_stop", toolName: "data_import", input: { action: "validate" } },
      { type: "finish" },
    ]]
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
      requests.push({ textOnly: request.textOnly })
      return { fullStream: (async function* () { yield* rounds.shift() ?? [] })() } as never
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_validate_stop", sessionID: "session_validate_stop", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_validate_stop",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    for await (const _event of runtime.run({
      tools: {
        definitions: { data_import: { id: "data_import", description: "data", inputSchema: {} } },
        port: {
          execute: async () => ({
            title: "数据质量检查",
            output: "质量检查已完成",
            metadata: { finalizeTextOnly: true, finalizeAfterResult: true },
          }),
        },
      },
      messages: [],
    } as never)) {}

    expect(requests).toEqual([{ textOnly: undefined }])
  })

  test("成功结果标记本轮收尾时跳过同一响应中排队的后续工具", async () => {
    const executed: string[] = []
    const rounds = [[
      { type: "tool-call", toolCallId: "call_import_finalize", toolName: "data_import", input: { action: "import" } },
      { type: "tool-call", toolCallId: "call_profile_after_finalize", toolName: "data_import", input: { action: "profile" } },
      { type: "finish" },
    ]]
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async () => {
      return { fullStream: (async function* () { yield* rounds.shift() ?? [] })() } as never
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({} as never))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_import_finalize", sessionID: "session_import_finalize", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_import_finalize",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    for await (const _event of runtime.run({
      tools: {
        definitions: { data_import: { id: "data_import", description: "data", inputSchema: {} } },
        port: {
          execute: async (call: { input: unknown }) => {
            executed.push(String((call.input as { action?: string }).action))
            return {
              title: "数据导入",
              output: "导入摘要包含变量和质量事实",
              metadata: { finalizeTextOnly: true, finalizeAfterResult: true },
            }
          },
        },
      },
      messages: [],
    } as never)) {}

    expect(executed).toEqual(["import"])
  })

  test("数据准备意图中估计成功后只允许文字收尾，不再重新探查原始文件", async () => {
    const requests: Array<{ textOnly?: boolean }> = []
    const rounds = [
      [
        { type: "tool-call", toolCallId: "call_estimate_ingest", toolName: "panel_fe_regression", input: { entityVar: "地区", timeVar: "年份" } },
        { type: "finish" },
      ],
      [
        { type: "text-start" },
        { type: "text-delta", text: "面板固定效应回归已完成。" },
        { type: "text-end" },
        { type: "finish" },
      ],
    ]
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
      requests.push({ textOnly: request.textOnly })
      return { fullStream: (async function* () { yield* rounds.shift() ?? [] })() } as never
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_ingest_estimate", sessionID: "session_ingest_estimate", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_ingest_estimate",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    for await (const _event of runtime.run({
      inputIntent: "ingest",
      tools: {
        definitions: { panel_fe_regression: { id: "panel_fe_regression", description: "面板固定效应", inputSchema: {} } },
        port: {
          execute: async () => ({
            title: "面板固定效应回归",
            output: "面板固定效应回归已完成。",
            metadata: { analysisView: { kind: "econometrics", step: "panel_fe_regression" } },
          }),
        },
      },
      messages: [],
    } as never)) {}

    expect(requests).toEqual([{ textOnly: undefined }, { textOnly: true }])
  })

  test("明确 analysis 意图下第一个估计器完成后仍保留第二个方法机会", async () => {
    const requests: Array<{ textOnly?: boolean }> = []
    const rounds = [
      [
        { type: "tool-call", toolCallId: "call_first_estimate", toolName: "panel_fe_regression", input: {} },
        { type: "finish" },
      ],
      [
        { type: "tool-call", toolCallId: "call_second_estimate", toolName: "ols_regression", input: {} },
        { type: "finish" },
      ],
      [
        { type: "text-start" },
        { type: "text-delta", text: "两种模型均已完成。" },
        { type: "text-end" },
        { type: "finish" },
      ],
    ]
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
      requests.push({ textOnly: request.textOnly })
      return { fullStream: (async function* () { yield* rounds.shift() ?? [] })() } as never
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_multi_estimate", sessionID: "session_multi_estimate", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_multi_estimate",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    for await (const _event of runtime.run({
      inputIntent: "analysis",
      tools: {
        definitions: {
          panel_fe_regression: { id: "panel_fe_regression", description: "面板固定效应", inputSchema: {} },
          ols_regression: { id: "ols_regression", description: "OLS", inputSchema: {} },
        },
        port: {
          execute: async () => ({
            title: "估计完成",
            output: "估计完成。",
            metadata: { analysisView: { kind: "econometrics", step: "estimate" } },
          }),
        },
      },
      messages: [],
    } as never)) {}

    expect(requests).toEqual([
      { textOnly: undefined },
      { textOnly: undefined },
      { textOnly: undefined },
    ])
  })

  test("数据就绪冲突需要用户决策时停止当前模型轮，不允许自动继续", async () => {
    let round = 0
    const rounds = [
      [
        { type: "tool-call", toolCallId: "call_readiness_gate", toolName: "econometrics_execute", input: { methodID: "ols_regression", arguments: {} } },
        { type: "finish" },
      ],
      [
        { type: "text-start" },
        { type: "text-delta", text: "不应在用户确认前继续" },
        { type: "text-end" },
        { type: "finish" },
      ],
    ]
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async () => {
      round += 1
      return { fullStream: (async function* () { yield* rounds[round - 1] ?? [] })() } as never
    }))
    const execute = mock(async () => ({
      title: "需要确认模型规格",
      metadata: { requiresUserDecision: true },
      output: "完全共线，请用户确认变量规格。",
    }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_readiness_gate", sessionID: "session_readiness_gate", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_readiness_gate",
      model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({
      tools: { definitions: { econometrics_execute: { id: "econometrics_execute", description: "", inputSchema: {} } }, port: { execute } },
      messages: [],
    } as never)) events.push(event)

    expect(round).toBe(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
  })

  test("复用同一用户动作的工具结果后停止无效查询循环", async () => {
    let round = 0
    let textOnlyNextRound: boolean | undefined
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
      round += 1
      if (round === 2) textOnlyNextRound = request.textOnly
      return { fullStream: (async function* () {
        if (round === 1) {
          yield { type: "tool-call", toolCallId: "call_reused_read", toolName: "read", input: { filePath: "same.json" } }
          yield { type: "finish" }
          return
        }
        yield { type: "text-start" }
        yield { type: "text-delta", text: "不应再次请求相同结果" }
        yield { type: "text-end" }
        yield { type: "finish" }
      })() } as never
    }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_reused_read", sessionID: "session_reused_read", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_reused_read",
      model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const execute = mock(async () => ({
      title: "读取结果",
      output: "已复用当前轮次同规格工具结果。",
      metadata: { reused: true, noNewInformation: true },
    }))
    const events: QueryEvent[] = []
    for await (const event of runtime.run({
      tools: { definitions: { read: { id: "read", description: "", inputSchema: {} } }, port: { execute } },
      messages: [],
    } as never)) events.push(event)

    expect(round).toBe(2)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(textOnlyNextRound).toBe(true)
    expect(events).toContainEqual({ type: "text-delta", text: "不应再次请求相同结果" })
  })

  test("discards tool calls emitted by a model attempt that later disconnects", async () => {
    const disconnect = new APICallError({
      message: "stream disconnected before completion",
      url: "https://api",
      requestBodyValues: {},
      statusCode: 503,
      responseHeaders: {},
      responseBody: "disconnect",
      isRetryable: true,
    })
    let round = 0
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(SessionRetry, "sleep").mockResolvedValue(undefined))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(
      spyOn(ModelGateway, "stream").mockImplementation(async () => {
        round += 1
        return {
          fullStream: (async function* () {
            if (round === 1) {
              yield { type: "tool-call", toolCallId: "stale", toolName: "write", input: { filePath: "stale.txt" } }
              throw disconnect
            }
            if (round === 2) {
              yield { type: "tool-call", toolCallId: "good", toolName: "read", input: { filePath: "data.csv" } }
              yield { type: "finish" }
              return
            }
            yield { type: "text-start" }
            yield { type: "text-delta", text: "完成" }
            yield { type: "text-end" }
            yield { type: "finish" }
          })(),
        } as never
      }),
    )
    const execute = mock(async () => ({ title: "读取", metadata: {}, output: "ok" }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_partial_retry", sessionID: "session_partial_retry", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_partial_retry",
      model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })

    for await (const _event of runtime.run({
      tools: { definitions: {}, port: { execute } },
      messages: [],
    } as never)) {}

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: "good", name: "read" }))
  })

  test("keeps partial model text but marks it when the stream disconnects before retry", async () => {
    const disconnect = new APICallError({
      message: "stream disconnected after text",
      url: "https://api",
      requestBodyValues: {},
      statusCode: 503,
      responseHeaders: {},
      responseBody: "disconnect",
      isRetryable: true,
    })
    let round = 0
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(SessionRetry, "sleep").mockResolvedValue(undefined))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(
      spyOn(ModelGateway, "stream").mockImplementation(async () => {
        round += 1
        return {
          fullStream: (async function* () {
            if (round === 1) {
              yield { type: "text-start" }
              yield { type: "text-delta", text: "半截内容" }
              throw disconnect
            }
            yield { type: "text-start" }
            yield { type: "text-delta", text: "新的完整回答" }
            yield { type: "text-end" }
            yield { type: "finish" }
          })(),
        } as never
      }),
    )

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_partial_text", sessionID: "session_partial_text", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_partial_text",
      model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({ tools: { definitions: {}, port: { execute: mock(async () => ({})) } }, messages: [] } as never)) {
      events.push(event)
    }

    expect(events).toContainEqual({ type: "text-delta", text: "半截内容" })
    expect(events.some((event) => event.type === "text-delta" && /中断|不作为最终结论/.test(event.text))).toBe(true)
    expect(events).toContainEqual({ type: "text-delta", text: "新的完整回答" })
  })

  test("does not execute a tool call when the provider stream ends without an explicit finish", async () => {
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(
      spyOn(ModelGateway, "stream").mockResolvedValue({
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId: "silent-stale", toolName: "write", input: { filePath: "stale.txt" } }
          // Provider 静默结束：没有 finish，也没有抛网络错误。
        })(),
      } as never),
    )
    const execute = mock(async () => ({ title: "写入", metadata: {}, output: "done" }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_silent_end", sessionID: "session_silent_end", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_silent_end",
      model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({ tools: { definitions: {}, port: { execute } }, messages: [] } as never)) {
      events.push(event)
    }
    expect(execute).toHaveBeenCalledTimes(0)
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
  })

  test("persists full tool output but sends only the bounded projection to the next model round", async () => {
    const fullOutput = JSON.stringify({
      activeStage: "baseline_estimate",
      qaGateStatus: "pass",
      huge: Array.from({ length: 6_000 }, (_, index) => `noise-${index}`),
    }, null, 2)
    let round = 0
    let secondRoundMessages: any[] = []
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(
      spyOn(ModelGateway, "stream").mockImplementation(async (input: ModelGateway.StreamInput) => {
        round += 1
        if (round === 2) secondRoundMessages = input.messages as any[]
        return {
          fullStream: (async function* () {
            if (round === 1) {
              yield { type: "tool-call", toolCallId: "projected", toolName: "pipeline", input: { action: "status" } }
              yield { type: "finish" }
              return
            }
            yield { type: "text-start" }
            yield { type: "text-delta", text: "完成" }
            yield { type: "text-end" }
            yield { type: "finish" }
          })(),
        } as never
      }),
    )
    const execute = mock(async () => ({ title: "工作流状态", metadata: {}, output: fullOutput }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_projection", sessionID: "session_projection", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_projection",
      model: { providerID: "deepseek", id: "deepseek-chat", limit: { context: 128_000, output: 8_000 } } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({
      model: { providerID: "deepseek", id: "deepseek-chat", limit: { context: 128_000, output: 8_000 } },
      tools: { definitions: {}, port: { execute } },
      messages: [],
    } as never)) events.push(event)

    const persisted = events.find((event) => event.type === "tool-result")
    expect(persisted).toMatchObject({ output: { output: fullOutput } })
    const toolMessage = secondRoundMessages.find((message) => message.role === "tool")
    const modelValue = toolMessage?.content?.[0]?.output?.value ?? ""
    expect(modelValue).toContain("baseline_estimate")
    expect(modelValue).toContain("tool-output:")
    expect(modelValue).not.toContain("noise-5999")
    expect(Token.estimate(modelValue)).toBeLessThanOrEqual(1_500)
  })

  test("immediate next round receives the same bounded media attachments as history replay", async () => {
    let round = 0
    let secondRoundMessages: any[] = []
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (input: ModelGateway.StreamInput) => {
      round += 1
      if (round === 2) secondRoundMessages = input.messages as any[]
      return { fullStream: (async function* () {
        if (round === 1) {
          yield { type: "tool-call", toolCallId: "media", toolName: "read", input: { filePath: "chart.png" } }
          yield { type: "finish" }
          return
        }
        yield { type: "text-start" }; yield { type: "text-delta", text: "看到了" }; yield { type: "text-end" }; yield { type: "finish" }
      })() } as never
    }))
    const execute = mock(async () => ({
      title: "图片", metadata: {}, output: "图片读取成功",
      attachments: [{ mime: "image/png", url: "data:image/png;base64,aGVsbG8=" }],
    }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_media", sessionID: "session_media", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_media", model: {
        providerID: "deepseek", id: "deepseek-chat",
        capabilities: { input: { image: true, pdf: false } },
      } as never,
      abort: new AbortController().signal, partFromToolCall: () => undefined,
    })
    for await (const _event of runtime.run({ tools: { definitions: {}, port: { execute } }, messages: [] } as never)) {}
    const output = secondRoundMessages.find((message) => message.role === "tool")?.content?.[0]?.output
    expect(output).toMatchObject({ type: "content" })
    expect(JSON.stringify(output)).toContain("image/png")
    expect(JSON.stringify(output)).toContain("aGVsbG8=")
  })

  test("media rejection notices are included before the final batch budget is enforced", async () => {
    let round = 0
    let secondRoundMessages: any[] = []
    const model = {
      providerID: "deepseek", id: "deepseek-chat", limit: { input: 1_000, output: 100 },
      capabilities: { input: { image: false, pdf: false } },
    } as never
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (input: ModelGateway.StreamInput) => {
      round += 1
      if (round === 2) secondRoundMessages = input.messages as any[]
      return { fullStream: (async function* () {
        if (round === 1) {
          for (let index = 0; index < 20; index++) {
            yield { type: "tool-call", toolCallId: `media-${index}`, toolName: "read", input: { filePath: `chart-${index}.png` } }
          }
          yield { type: "finish" }
          return
        }
        yield { type: "text-start" }; yield { type: "text-delta", text: "完成" }; yield { type: "text-end" }; yield { type: "finish" }
      })() } as never
    }))
    const execute = mock(async () => ({
      title: "图片", metadata: {}, output: "图片读取成功",
      attachments: [{ mime: "image/png", url: "data:image/png;base64,aGVsbG8=" }],
    }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_media_budget", sessionID: "session_media_budget", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_media_budget", model, abort: new AbortController().signal, partFromToolCall: () => undefined,
    })
    for await (const _event of runtime.run({ model, tools: { definitions: {}, port: { execute } }, messages: [] } as never)) {}

    const toolMessage = secondRoundMessages.find((message) => message.role === "tool")
    const textResults = (toolMessage?.content ?? []).map((item: any) => {
      if (item.output?.type === "content") return item.output.value.find((part: any) => part.type === "text")?.text ?? ""
      return item.output?.value ?? ""
    })
    expect(ToolResultProjection.estimateBatch(textResults.map((content: string) => ({ content })))).toBeLessThanOrEqual(150)
    expect(JSON.stringify(toolMessage)).not.toContain('"type":"media"')
  })

  test("commits pending deferred tool schemas before the next model round", async () => {
    let round = 0
    let committedBeforeSecondRound = false
    let committed = false
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async () => {
      round += 1
      if (round === 2) committedBeforeSecondRound = committed
      return { fullStream: (async function* () {
        if (round === 1) {
          yield { type: "tool-call", toolCallId: "search", toolName: "tool_search", input: { query: "固定效应", limit: 2 } }
          yield { type: "finish" }
          return
        }
        yield { type: "text-start" }; yield { type: "text-delta", text: "继续" }; yield { type: "text-end" }; yield { type: "finish" }
      })() } as never
    }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_lazy_commit", sessionID: "session_lazy_commit", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_lazy_commit", model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal, partFromToolCall: () => undefined,
    })
    for await (const _event of runtime.run({
      tools: {
        definitions: {},
        port: { execute: async () => ({ title: "工具搜索", metadata: {}, output: "已加载" }) },
        commitDeferredTools: async () => { committed = true },
      },
      messages: [],
    } as never)) {}

    expect(committedBeforeSecondRound).toBe(true)
  })

  test("方法 Schema 只在 tool_search 结果进入下一轮上下文后才视为已披露", async () => {
    let round = 0
    const receivedSchemaVisibility: string[][] = []
    let secondRequestMessages: unknown[] = []
    const schema = JSON.stringify({
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [
        `field_${index}`,
        { type: "string", description: `字段 ${index} 的完整参数说明`.repeat(3) },
      ])),
      required: ["field_0"],
    })
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
      round += 1
      if (round === 2) secondRequestMessages = request.messages
      return { fullStream: (async function* () {
        if (round === 1) {
          yield { type: "tool-call", toolCallId: "search-schema", toolName: "tool_search", input: { query: "ols_regression" } }
          yield { type: "finish" }
          return
        }
        if (round === 2) {
          yield { type: "tool-call", toolCallId: "run-ols", toolName: "econometrics_execute", input: { methodID: "ols_regression", arguments: {} } }
          yield { type: "finish" }
          return
        }
        yield { type: "text-start" }; yield { type: "text-delta", text: "已停止" }; yield { type: "text-end" }; yield { type: "finish" }
      })() } as never
    }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_schema_visibility", sessionID: "session_schema_visibility", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_schema_visibility", model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal, partFromToolCall: () => undefined,
    })
    for await (const _event of runtime.run({
      tools: {
        definitions: {
          tool_search: { id: "tool_search", description: "search", inputSchema: {} },
          econometrics_execute: { id: "econometrics_execute", description: "execute", inputSchema: {} },
        },
        port: { execute: async (call: { name: string; schemaSentToolIDs?: string[] }) => {
          receivedSchemaVisibility.push(call.schemaSentToolIDs ?? [])
          return {
            title: call.name,
            metadata: {},
            output: call.name === "tool_search"
              ? `- 方法：ols_regression\n参数 Schema：${schema}\n返回 Schema：{"type":"object"}`
              : "OLS 已执行",
          }
        } },
      },
      messages: [],
    } as never)) {}

    expect(receivedSchemaVisibility).toEqual([[], ["ols_regression"]])
    // The outer model-message JSON escapes quotes inside tool output; assert the
    // complete final field description rather than its serialized quote spelling.
    expect(JSON.stringify(secondRequestMessages)).toContain(
      "字段 49 的完整参数说明字段 49 的完整参数说明字段 49 的完整参数说明",
    )
  })

  test("ModelGateway 最终上下文投影删掉搜索块后必须撤销 Schema 已披露状态", async () => {
    let round = 0
    const receivedSchemaVisibility: string[][] = []
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
      round += 1
      if (round === 2) request.messages = request.messages.filter((message) => message.role !== "tool")
      return { fullStream: (async function* () {
        if (round === 1) {
          yield { type: "tool-call", toolCallId: "search-before-projection", toolName: "tool_search", input: { query: "ols_regression" } }
          yield { type: "finish" }
          return
        }
        if (round === 2) {
          yield { type: "tool-call", toolCallId: "estimate-after-projection", toolName: "econometrics_execute", input: { methodID: "ols_regression", arguments: {} } }
          yield { type: "finish" }
          return
        }
        yield { type: "text-start" }; yield { type: "text-delta", text: "已停止" }; yield { type: "text-end" }; yield { type: "finish" }
      })() } as never
    }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_schema_projection", sessionID: "session_schema_projection", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_schema_projection", model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal, partFromToolCall: () => undefined,
    })
    for await (const _event of runtime.run({
      tools: {
        definitions: { tool_search: { id: "tool_search" }, econometrics_execute: { id: "econometrics_execute" } },
        port: { execute: async (call: { name: string; schemaSentToolIDs?: string[] }) => {
          receivedSchemaVisibility.push(call.schemaSentToolIDs ?? [])
          return {
            title: call.name,
            metadata: {},
            output: call.name === "tool_search"
              ? '- 方法：ols_regression\n参数 Schema：{"type":"object","properties":{"dependentVar":{"type":"string"}}}\n返回 Schema：{"type":"object"}'
              : "OLS 已执行",
          }
        } },
      },
      messages: [],
    } as never)) {}

    expect(receivedSchemaVisibility).toEqual([[], []])
  })

  test("同一模型响应内搜索方法并调用估计器时，尚未返回给模型的 Schema 仍算未披露", async () => {
    async function* fullStream() {
      yield { type: "tool-call", toolCallId: "same-turn-search", toolName: "tool_search", input: { query: "ols_regression" } }
      yield { type: "tool-call", toolCallId: "same-turn-estimate", toolName: "econometrics_execute", input: { methodID: "ols_regression", arguments: {} } }
      yield { type: "finish" }
    }
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(MessageV2, "parts").mockResolvedValue([]))
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      metadata: { reflection: { failureType: "tool_contract_failure", repairAction: "先重新加载完整参数说明" } },
      repair: { toolName: "ols_regression", retryStage: "estimate", repairAction: "先重新加载完整参数说明" },
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const receivedSchemaVisibility: string[][] = []
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_same_turn_schema", sessionID: "session_same_turn_schema", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_same_turn_schema", model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => ({ state: { status: "running", input: { arguments: {} } } }) as never,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({
      tools: {
        definitions: {
          tool_search: { id: "tool_search", execution: Tool.Execution.readOnlySerial },
          econometrics_execute: { id: "econometrics_execute", execution: Tool.Execution.managedFilesystem },
        },
        port: { execute: async (call: { id: string; name: string; schemaSentToolIDs?: string[] }) => {
          receivedSchemaVisibility.push(call.schemaSentToolIDs ?? [])
          if (call.name === "econometrics_execute") {
            throw new Tool.SchemaNotSentError("ols_regression", "arguments 缺少因变量")
          }
          return {
            title: "工具搜索",
            metadata: {},
            output: '- 方法：ols_regression\n参数 Schema：{"type":"object","required":["dependentVar"]}\n返回 Schema：{"type":"object"}',
          }
        } },
      },
      messages: [],
    } as never)) events.push(event)

    expect(receivedSchemaVisibility).toEqual([[], []])
    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      metadata: { failureDecision: { disposition: "repair", userVisibleMessage: expect.stringContaining("tool_search") } },
    })
  })

  test("混合成功与可修复失败进入下一轮时，为每个原始 tool-call 配对成功或 error-text 结果", async () => {
    let round = 0
    let secondRequestMessages: unknown[] = []
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(MessageV2, "parts").mockResolvedValue([]))
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      metadata: { reflection: { failureType: "tool_contract_failure", repairAction: "修正参数字段" } },
      repair: { toolName: "bad_read", retryStage: "estimate", repairAction: "修正参数字段" },
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
      round += 1
      if (round === 2) secondRequestMessages = request.messages
      return { fullStream: (async function* () {
        if (round === 1) {
          yield { type: "tool-call", toolCallId: "good-call", toolName: "good_read", input: { path: "a.csv" } }
          yield { type: "tool-call", toolCallId: "bad-call", toolName: "bad_read", input: { path: 1 } }
          yield { type: "finish" }
          return
        }
        yield { type: "text-start" }; yield { type: "text-delta", text: "已看到错误并继续" }; yield { type: "text-end" }; yield { type: "finish" }
      })() } as never
    }))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_mixed_tool_context", sessionID: "session_mixed_tool_context", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_mixed_tool_context", model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => ({
        state: { status: "running", input: { path: 1 }, metadata: { reflection: { failureType: "tool_contract_failure" } } },
      }) as never,
    })
    for await (const _event of runtime.run({
      tools: {
        definitions: {
          good_read: { id: "good_read", execution: Tool.Execution.readOnly },
          bad_read: { id: "bad_read", execution: Tool.Execution.managedFilesystem },
        },
        port: { execute: async (call: { name: string }) => {
          if (call.name === "bad_read") throw new Tool.InputValidationError("参数 path 应为字符串")
          return { title: "读取成功", metadata: {}, output: "已读取数据" }
        } },
      },
      messages: [],
    } as never)) {}

    const serialized = JSON.stringify(secondRequestMessages)
    expect(serialized).toContain("good-call")
    expect(serialized).toContain("bad-call")
    expect(serialized).toContain("error-text")
    expect(serialized).toContain("参数 path 应为字符串")
    expect(serialized).toContain("修正参数字段")
  })

  test("flushes deferred verifiers only after the successful tool result has been delivered", async () => {
    let round = 0
    let toolResultDelivered = false
    let verifierFlushSawDeliveredResult = false
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async () => {
      round += 1
      return { fullStream: (async function* () {
        if (round === 1) {
          yield { type: "tool-call", toolCallId: "verify-order", toolName: "ols_regression", input: {} }
          yield { type: "finish" }
        } else {
          yield { type: "text-start" }
          yield { type: "text-delta", text: "已收到" }
          yield { type: "text-end" }
          yield { type: "finish" }
        }
      })() } as never
    }))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_verify_order", sessionID: "session_verify_order", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_verify_order",
      model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    for await (const event of runtime.run({
      tools: {
        definitions: {},
        port: { execute: mock(async () => ({ title: "OLS", metadata: {}, output: "result" })) },
        flushDeferredVerifiers: () => { verifierFlushSawDeliveredResult = toolResultDelivered },
      },
      messages: [],
    } as never)) {
      if (event.type === "tool-result") toolResultDelivered = true
    }

    expect(verifierFlushSawDeliveredResult).toBe(true)
  })

  test("工具结果仍待独立核验时只允许模型文字收尾，不能重复调估计工具", async () => {
    const requests: Array<{ textOnly?: boolean }> = []
    let round = 0
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
      requests.push({ textOnly: request.textOnly })
      round += 1
      return { fullStream: (async function* () {
        if (round === 1) {
          yield { type: "tool-call", toolCallId: "pending_estimate", toolName: "ols_regression", input: {} }
          yield { type: "finish" }
        } else {
          yield { type: "text-start" }
          yield { type: "text-delta", text: "估计已生成，正在等待独立核验。" }
          yield { type: "text-end" }
          yield { type: "finish" }
        }
      })() } as never
    }))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_pending_verifier", sessionID: "session_pending_verifier", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_pending_verifier", model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal, partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({
      tools: {
        definitions: { ols_regression: { id: "ols_regression", description: "OLS", inputSchema: {} } },
        port: { execute: async () => ({ title: "OLS", output: "估计已生成", metadata: { verifierPending: true } }) },
      },
      messages: [],
    } as never)) events.push(event)

    expect(requests).toEqual([{ textOnly: undefined }, { textOnly: true }])
    expect(events.filter((event) => event.type === "tool-result")).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "continue" })
  })

  test("同批次后续工具终止失败时，已成功估计的核验仍在结果交付后启动", async () => {
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: (async function* () {
      yield { type: "tool-call", toolCallId: "estimate_ok", toolName: "ols_regression", input: {} }
      yield { type: "tool-call", toolCallId: "next_cancelled", toolName: "data_import", input: {} }
      yield { type: "finish" }
    })() } as never))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_mixed_verifier", sessionID: "session_mixed_verifier", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_mixed_verifier", model: { providerID: "deepseek", id: "deepseek-chat" } as never,
      abort: new AbortController().signal, partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    let flushedAfterResult = false
    for await (const event of runtime.run({
      tools: {
        definitions: {},
        port: { execute: async (call: { id: string }) => {
          if (call.id === "next_cancelled") throw new ToolExecutionAbortedError("TOOL_ABORTED", "已取消")
          return { title: "OLS", metadata: {}, output: "估计已完成" }
        } },
        flushDeferredVerifiers: () => { flushedAfterResult = events.some((item) => item.type === "tool-result") },
      },
      messages: [],
    } as never)) events.push(event)

    expect(events.some((event) => event.type === "tool-result" && event.toolCallId === "estimate_ok")).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
    expect(flushedAfterResult).toBe(true)
  })

  test("isolated Harness execution can bypass runtime hooks without changing the executor path", async () => {
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({})
    const postTool = spyOn(RuntimeHooks, "postTool").mockResolvedValue({})
    spies.push(preTool, postTool)

    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_isolated_harness",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      runRuntimeHooks: false,
    })

    const result = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        processor.executeTool(
          "data_preprocess",
          { datasetId: "dataset_1" },
          {
            callID: "isolated_harness",
            run: async () => ({ title: "预处理", metadata: { result: { ok: true } }, output: "done" }),
          },
        ),
    })

    expect(result.metadata).toMatchObject({ result: { ok: true } })
    expect(preTool).not.toHaveBeenCalled()
    expect(postTool).not.toHaveBeenCalled()
  })

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
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
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

  test("Schema 未披露错误通过真实 QueryRuntime 进入精确 methodID 重搜恢复", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_schema_not_sent",
        toolName: "ols_regression",
        input: { dependentVar: "y" },
        error: new Tool.SchemaNotSentError("ols_regression", "参数 dependentVar 缺失"),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(MessageV2, "parts").mockResolvedValue([]))
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      metadata: { reflection: { failureType: "tool_contract_failure", repairAction: "先加载方法 Schema" } },
      repair: { toolName: "ols_regression", retryStage: "estimate", repairAction: "先加载方法 Schema" },
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_schema_not_sent", sessionID: "session_schema_not_sent", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_schema_not_sent",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => ({ state: { status: "running", input: { dependentVar: "y" } } }) as never,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({ tools: {} } as never)) events.push(event)

    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      metadata: {
        failureDecision: {
          category: "invalid_tool_input",
          disposition: "repair",
          userVisibleMessage: expect.stringContaining("tool_search"),
        },
      },
    })
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: { type: "repair", toolName: "ols_regression" } })
  })

  test("可能仍在后台运行的有副作用工具超时会标记为未确认并禁止原样重试", async () => {
    async function* fullStream() {
      yield { type: "tool-call", toolCallId: "call_write_timeout", toolName: "data_preprocess", input: { action: "filter" } }
      yield { type: "finish" }
    }
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(MessageV2, "parts").mockResolvedValue([]))
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      metadata: { reflection: { failureType: "process_timeout", repairAction: "先核对当前数据阶段和产物" } },
      repair: { toolName: "data_preprocess", retryStage: "clean", repairAction: "先核对当前数据阶段和产物" },
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_write_timeout", sessionID: "session_write_timeout", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_write_timeout", model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => ({ state: { status: "running", input: { action: "filter" } } }) as never,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({
      tools: {
        definitions: { data_preprocess: { id: "data_preprocess", execution: Tool.Execution.managedFilesystem } },
        port: { execute: async () => { throw new Tool.ExecutionTimeoutError(330_000) } },
      },
      messages: [],
    } as never)) events.push(event)

    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      blocked: true,
      metadata: {
        unconfirmed: true,
        sideEffectMayContinue: true,
        failureDiagnosis: { safeToRetry: false },
        failureDecision: { category: "side_effect_retry_blocked", disposition: "stop" },
      },
    })
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
  })

  test("稳定计量路由失败时，Provider 名称保持稳定但 repair 仍锁定真实估计器", async () => {
    async function* fullStream() {
      yield {
        type: "tool-call",
        toolCallId: "call_route_failure",
        toolName: "econometrics_execute",
        input: {
          methodID: "ols_regression",
          arguments: { datasetId: "dataset_1", stageId: "stage_001", dependentVar: "y" },
        },
      }
      yield { type: "finish" }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    const postFailure = spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      metadata: { reflection: { failureType: "estimation_failure" } },
      repair: {
        toolName: "ols_regression",
        retryStage: "baseline_estimate",
        repairAction: "修复 OLS 参数后重试",
      },
    })
    spies.push(postFailure)
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_route_failure", sessionID: "session_route_failure", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_route_failure",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        for await (const event of runtime.run({
          tools: {
            definitions: { econometrics_execute: { execution: Tool.Execution.managedFilesystem } },
            port: { execute: mock(async () => { throw new Error("OLS backend failed") }) },
          },
        } as never)) events.push(event)
      },
    })

    expect(postFailure).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "ols_regression",
      args: { datasetId: "dataset_1", stageId: "stage_001", dependentVar: "y" },
    }))
    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      toolName: "econometrics_execute",
      repair: { toolName: "ols_regression" },
    })
    expect(events.at(-1)).toMatchObject({
      type: "turn-finish",
      result: { type: "repair", toolName: "ols_regression" },
    })
  })

  test("result contract failure stops continuation instead of scheduling model repair", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_contract",
        toolName: "ols_regression",
        input: { datasetId: "dataset_1", stageId: "stage_001" },
        error: new WorkflowResultContractError([
          {
            code: "RESULT_LINEAGE_MISMATCH",
            path: "metadata.result.datasetId",
            message: "dataset mismatch",
          },
        ]),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    const postFailure = spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      metadata: { workflowFailure: { code: "RESULT_CONTRACT_INVALID" } },
      preventContinuation: true,
      repair: {
        toolName: "ols_regression",
        retryStage: "verify",
        repairAction: "不要重试",
      },
    })
    spies.push(postFailure)
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_contract", sessionID: "session_1", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({ tools: {} } as never)) events.push(event)

    expect(postFailure).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
  })

  test("DID2S 研究设计前置缺口停止自动改造数据", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_did2s_missing_relative_time",
        toolName: "did2s",
        input: { datasetId: "dataset_1", stageId: "stage_001", relativeTimeVar: "relative_time" },
        error: new Error("[ValueError] 数据中找不到变量：relative_time"),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      repair: { toolName: "did2s", retryStage: "validate", repairAction: "请处理相对时期" },
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_did2s_design", sessionID: "session_did2s_design", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_did2s_design",
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

    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      metadata: { failureDecision: { category: "precondition_failure", disposition: "stop" } },
    })
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
  })

  test("DID2S 未知 relative_time 字段属于参数错误，允许模型修正而不是直接停机", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_did2s_schema_relative_time",
        toolName: "did2s",
        input: { datasetId: "dataset_1", stageId: "stage_001", relative_time: "relative_time" },
        error: new Error("工具 did2s 参数不合法：包含未定义字段（relative_time）"),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      repair: { toolName: "did2s", retryStage: "estimate", repairAction: "按 Schema 改用 relativeTimeVar" },
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_did2s_schema", sessionID: "session_did2s_schema", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_did2s_schema",
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
      result: { type: "repair", toolName: "did2s" },
    })
  })

  test("an unavailable native tool enters bounded model replan instead of ending immediately", async () => {
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
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
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

    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      metadata: {
        failureDecision: { category: "tool_not_found", disposition: "repair" },
      },
    })
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: { type: "repair" } })
  })

  test("本轮按意图隐藏的系统工具不会被误判成延迟方法", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_hidden_read",
        toolName: "read",
        input: { filePath: "tool-output:missing" },
        error: new Error("Model tried to call unavailable tool 'read'."),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({}))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_hidden_read", sessionID: "session_1", agent: "analyst" } as MessageV2.Assistant,
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

    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      metadata: {
        failureDecision: { category: "tool_not_found", disposition: "repair" },
      },
    })
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: { type: "repair" } })
  })

  test("已准入但未加载的方法可用原参数继续加载重试，不锁定为参数未变", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_deferred_estimator",
        toolName: "panel_fe_regression",
        input: { datasetId: "dataset_1", stageId: "stage_001", dependentVar: "y" },
        error: new Error("Model tried to call unavailable tool 'panel_fe_regression'."),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      repair: {
        toolName: "panel_fe_regression",
        retryStage: "estimate",
        repairAction: "先加载方法再重试",
      },
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_deferred_estimator", sessionID: "session_1", agent: "analyst" } as MessageV2.Assistant,
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

    const repair = events.find((event) => event.type === "turn-finish")
    expect(repair).toMatchObject({
      type: "turn-finish",
      result: { type: "repair", toolName: "panel_fe_regression" },
    })
    const repairResult = (repair as Extract<QueryEvent, { type: "turn-finish" }>).result
    expect(repairResult && typeof repairResult === "object" && repairResult.type === "repair"
      ? repairResult.failedInputSignature
      : undefined).toBeUndefined()
  })

  test("已准入但未加载的方法不应把可见性修复误报成参数修复", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_deferred_visibility",
        toolName: "panel_fe_regression",
        input: { datasetId: "dataset_1", stageId: "stage_001", dependentVar: "y" },
        error: new Error("Model tried to call unavailable tool 'panel_fe_regression'."),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    // 模拟旧 hook 返回的通用参数修复文案；QueryRuntime 必须用更准确的
    // “方法已准入但尚未加载”分类覆盖它，避免误导模型改写估计规格。
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({
      repair: {
        toolName: "panel_fe_regression",
        retryStage: "estimate",
        repairAction: "根据 panel_fe_regression 参数描述修正字段、类型或列名，只重试失败调用。",
      },
    }))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_deferred_visibility", sessionID: "session_1", agent: "analyst" } as MessageV2.Assistant,
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

    const finished = events.find((event) => event.type === "turn-finish")
    const result = finished && finished.type === "turn-finish" && typeof finished.result === "object"
      ? finished.result
      : undefined
    expect(result).toMatchObject({ type: "repair", toolName: "panel_fe_regression" })
    expect(result && result.type === "repair" ? result.repairAction : "").toContain("tool_search")
    expect(result && result.type === "repair" ? result.repairAction : "").toContain("尚未加载到当前方法引用窗口")
    expect(result && result.type === "repair" ? result.repairAction : "").not.toContain("修正字段")
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
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
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

    expect(
      isRepeatedToolCall(completed, {
        toolCallId: "current",
        toolName: "ols_regression",
        input: { datasetId: "dataset_1", stageId: "stage_001" },
      }),
    ).toBe(true)
  })

  test("repeat detection uses completed history even when the provider reuses a tool-call id", () => {
    const completed = Array.from({ length: 3 }, () => ({
      type: "tool",
      callID: "call_0",
      tool: "ols_regression",
      state: { status: "completed", input: { datasetId: "dataset_1" } },
    })) as unknown as MessageV2.ToolPart[]

    expect(
      isRepeatedToolCall(completed, {
        toolCallId: "call_0",
        toolName: "ols_regression",
        input: { datasetId: "dataset_1" },
      }),
    ).toBe(true)
  })

  test("repeat history excludes running calls because the in-memory counter owns them", () => {
    const running = Array.from({ length: 3 }, (_, index) => ({
      type: "tool",
      callID: `running_${index}`,
      tool: "ols_regression",
      state: { status: "running", input: { datasetId: "dataset_1" } },
    })) as unknown as MessageV2.ToolPart[]

    expect(
      repeatedToolCallCount(running, {
        toolCallId: "current",
        toolName: "ols_regression",
        input: { datasetId: "dataset_1" },
      }),
    ).toBe(0)
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
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
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

  test("permission rejection remains terminal even when legacy continue_loop_on_deny is enabled", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_rejected_legacy",
        toolName: "bash",
        input: { command: "echo no" },
        error: new PermissionNext.RejectedError(),
      }
    }
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: { continue_loop_on_deny: true } } as never))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({}))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_rejected_legacy", sessionID: "session_1", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events = []
    for await (const event of runtime.run({ tools: {} } as never)) events.push(event)

    expect(events.find((event) => event.type === "tool-error")).toMatchObject({ blocked: true })
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
  })

  test("permission rejection with feedback is terminal and preserves the feedback for the user", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_corrected",
        toolName: "bash",
        input: { command: "curl example.invalid" },
        error: new PermissionNext.CorrectedError("不要访问外部网络"),
      }
    }
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: { id: "message_corrected", sessionID: "session_1", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events = []
    for await (const event of runtime.run({ tools: {} } as never)) events.push(event)

    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      blocked: true,
      error: expect.stringContaining("不要访问外部网络"),
    })
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
  })

  test("a user-cancelled tool stops without reflection or automatic repair", async () => {
    async function* fullStream() {
      yield {
        type: "tool-error",
        toolCallId: "call_cancelled",
        toolName: "data_import",
        input: { action: "import", inputPath: "data/did.xlsx" },
        error: new ToolExecutionAbortedError("TOOL_ABORTED", "工具调用执行期间已取消"),
      }
    }

    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
    const postFailure = spyOn(RuntimeHooks, "postToolFailure").mockResolvedValue({})
    spies.push(postFailure)
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))

    const runtime = new QueryRuntime({
      assistantMessage: {
        id: "message_cancelled",
        sessionID: "session_cancelled",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_cancelled",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })

    const events: QueryEvent[] = []
    for await (const event of runtime.run({ tools: {} } as never)) events.push(event)

    expect(postFailure).not.toHaveBeenCalled()
    expect(events.find((event) => event.type === "tool-error")).toMatchObject({
      blocked: true,
      error: "已停止本次工具执行。",
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
    spies.push(spyOn(ModelGateway, "stream").mockResolvedValue({ fullStream: fullStream() } as never))
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
    const postTool = spyOn(RuntimeHooks, "postTool").mockResolvedValue({
      metadata: {
        clientSecret: "hook-success-secret",
        verifierPending: true,
        matrix: Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => "x".repeat(2_048))),
      },
    })
    spies.push(postTool)
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
      fn: () =>
        processor.executeTool(
          "ols_regression",
          { datasetId: "dataset_1" },
          {
            callID: "hook_metadata",
            deferVerification: true,
            run: async () => ({ title: "OLS", metadata: { method: "ols_regression" }, output: "done" }),
          },
        ),
    })
    const metadata = JSON.stringify(result.metadata)

    expect(Buffer.byteLength(metadata)).toBeLessThanOrEqual(32 * 1024)
    expect(metadata).not.toContain("hook-success-secret")
    expect(result.metadata).toMatchObject({ metadataTruncated: true })
    expect(result.output).toContain("待核验")
    expect(postTool).toHaveBeenCalledWith(expect.objectContaining({ deferVerification: true }))
  })

  test("模型请求中止时仍完成助手消息收尾并交付已完成的估计结果", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-processor-abort-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const session = await Session.create({})
          const user = await Session.updateMessage({
            id: "msg_user_processor_abort",
            role: "user",
            sessionID: session.id,
            time: { created: Date.now() },
            agent: "analyst",
            model: { providerID: "test", modelID: "test" },
          } as never)
          await Session.updatePart({
            id: "prt_processor_abort_user",
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "完成 OLS 后再继续处理",
          } as never)
          const assistant = await Session.updateMessage({
            id: "msg_assistant_processor_abort",
            role: "assistant",
            parentID: user.id,
            sessionID: session.id,
            mode: "analyst",
            agent: "analyst",
            path: { cwd: root, root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as never)

          const runtimeRun = spyOn(QueryRuntime.prototype, "run").mockImplementation(async function* () {
            yield { type: "tool-input-start", toolCallId: "call_abort_ols", toolName: "ols_regression" }
            yield {
              type: "tool-call",
              toolCallId: "call_abort_ols",
              toolName: "ols_regression",
              input: { dependentVar: "y", treatmentVar: "x" },
            }
            yield {
              type: "tool-result",
              toolCallId: "call_abort_ols",
              toolName: "ols_regression",
              input: { dependentVar: "y", treatmentVar: "x" },
              output: {
                title: "OLS 回归",
                output: "OLS 已完成",
                modelOutput: "OLS 已完成",
                metadata: {
                  analysisView: {
                    kind: "regression",
                    step: "ols_regression",
                    results: [{ label: "系数", value: "0.85" }],
                    conclusion: "OLS 回归已完成。",
                  },
                },
              },
            }
            throw new DOMException("Aborted", "AbortError")
          } as never)
          spies.push(runtimeRun)

          const processor = SessionProcessor.create({
            assistantMessage: assistant as MessageV2.Assistant,
            sessionID: session.id,
            model: { providerID: "test", id: "test" } as never,
            abort: new AbortController().signal,
            runRuntimeHooks: false,
          })

          await expect(processor.process({} as never)).rejects.toThrow("Aborted")
          const stored = (await Session.messages({ sessionID: session.id }))
            .find((item) => item.info.id === assistant.id)
          const texts = stored?.parts
            .filter((part): part is MessageV2.TextPart => part.type === "text")
            .map((part) => part.text)
            .join("\n") ?? ""
          expect(texts).toContain("OLS回归")
          expect(texts).toContain("系数 0.85")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
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
        { callID: "current", execution: Tool.Execution.managedFilesystem, run },
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

  test("automatic repair applies hooks first, then rejects switching to a different estimator before execution", async () => {
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
    expect(preTool).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(0)
  })

  test("automatic repair allows econometrics_recommend (profile) while the estimator is locked", async () => {
    // 真实死锁（2026-08-05 did.xlsx）：估计器缺画像被门禁拒绝，repairAction 指向 profile，
    // 但 recommend 曾被 REPAIR_TOOL_MISMATCH 拦截——修复动作与工具锁矛盾，2 次修复后停止。
    // recommend 是修复前置条件（画像）的必经工具，必须放行；其他估计器仍被锁。
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({})
    const postTool = spyOn(RuntimeHooks, "postTool").mockResolvedValue({})
    spies.push(preTool)
    spies.push(postTool)
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_repair_recommend",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      repairToolName: "panel_fe_regression",
    })
    const run = mock(async () => ({
      title: "Profile",
      metadata: {},
      output: "profile done",
    }))

    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const result = await processor.executeTool(
          "econometrics_recommend",
          { datasetId: "dataset_1", stageId: "stage_001" },
          { callID: "profile_repair", run },
        )
        expect(result.output).toBe("profile done")
      },
    })

    expect(preTool).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
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
        // 同一响应里 OLS 修复完成后，后续用户明确要求的面板方法可以继续执行；
        // 不能让 processor 内部仍保留已经失效的 repair 锁。
        await expect(
          processor.executeTool(
            "panel_fe_regression",
            { datasetId: "dataset_1", stageId: "stage_001" },
            { callID: "repair_panel", run },
          ),
        ).resolves.toMatchObject({ output: "done" })
      },
    })

    expect(onRepairToolSucceeded).toHaveBeenCalledTimes(1)
  })

  test("automatic repair allows workflow rerun (the fix is rerun, not status)", async () => {
    // 真实死锁（2026-08-06 did_7f1335de）：verifier 报 ARTIFACT_MISSING，修复建议指向
    // workflow [rerun] 重跑 validate，但 REPAIR_WORKFLOW_MUTATION_DENIED 把 rerun 也拦下，
    // 2 次修复后停止。rerun 是修复 verifier 阻断的合法动作，必须放行；其他 mutation
    // （如 restore）继续被拒。
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({})
    const postTool = spyOn(RuntimeHooks, "postTool").mockResolvedValue({})
    spies.push(preTool)
    spies.push(postTool)
    spies.push(spyOn(Session, "messages").mockResolvedValue([]))
    const sessionID = "ses_repair_rerun_qa"
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_repair_rerun",
        sessionID,
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID,
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      repairToolName: "panel_fe_regression",
    })
    const run = mock(async () => ({ title: "Rerun", metadata: {}, output: "reran" }))

    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        seedRepairRerunStage(sessionID, "stage_000__validate", "data_import")
        const result = await processor.executeTool(
          "pipeline",
          { action: "rerun", stageId: "stage_000__validate" },
          { callID: "rerun", run },
        )
        expect(result.output).toBe("reran")
      },
    })

    expect(run).toHaveBeenCalledTimes(1)
  })

  test("automatic repair rejects workflow rerun of a different recorded estimator", async () => {
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({})
    spies.push(preTool)
    const sessionID = "ses_repair_rerun_other_estimator"
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_repair_other_rerun",
        sessionID,
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID,
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      repairToolName: "panel_fe_regression",
    })
    const run = mock(async () => ({ title: "Rerun", metadata: {}, output: "reran" }))

    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        seedRepairRerunStage(sessionID, "stage_ols", "ols_regression")
        await expect(
          processor.executeTool(
            "pipeline",
            { action: "rerun", stageId: "stage_ols" },
            { callID: "rerun_other", run },
          ),
        ).rejects.toThrow("REPAIR_TOOL_MISMATCH")
      },
    })

    expect(preTool).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(0)
  })

  test("automatic repair rejects an implicit workflow rerun targeting another estimator", async () => {
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({})
    spies.push(preTool)
    const sessionID = "ses_repair_implicit_other_estimator"
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_repair_implicit_other",
        sessionID,
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID,
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      repairToolName: "panel_fe_regression",
    })
    const run = mock(async () => ({ title: "Rerun", metadata: {}, output: "reran" }))

    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        seedRepairRerunStage(sessionID, "stage_ols", "ols_regression")
        await expect(
          processor.executeTool("pipeline", { action: "rerun" }, { callID: "rerun_implicit_other", run }),
        ).rejects.toThrow("REPAIR_TOOL_MISMATCH")
      },
    })

    expect(preTool).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(0)
  })

  test("automatic repair still blocks other workflow mutations like restore", async () => {
    // 防御：只放行 rerun，其他 mutation（restore/rerun 之外的）继续被守卫拦，
    // 避免修复模式意外改写 session 状态。
    const preTool = spyOn(RuntimeHooks, "preTool").mockResolvedValue({})
    spies.push(preTool)
    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "message_repair_restore",
        sessionID: "session_1",
        agent: "analyst",
      } as MessageV2.Assistant,
      sessionID: "session_1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
      abort: new AbortController().signal,
      repairToolName: "ols_regression",
    })
    const run = mock(async () => ({ title: "Restore", metadata: {}, output: "restored" }))

    expect(
      processor.executeTool("pipeline", { action: "restore" }, { callID: "restore", run }),
    ).rejects.toThrow("REPAIR_WORKFLOW_MUTATION_DENIED")
    expect(preTool).toHaveBeenCalledTimes(1)
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
      processor.executeTool(
        "ols_regression",
        { dependentVar: "y", stageId: "stage_001", datasetId: "dataset_1" },
        {
          callID: "unchanged",
          run,
        },
      ),
    ).rejects.toThrow("REPAIR_INPUT_UNCHANGED")
    expect(preTool).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(0)
  })

  test("switches to experimental.fallbackModel after repeated retryable failures", async () => {
    // ModelGateway.stream 真实抛的是 AI SDK 的 APICallError（fromError 会保留 isRetryable），
    // 直接抛 MessageV2.APIError 实例会被 fromError 包成 Unknown 而不可重试。
    const retryableError = new APICallError({
      message: "Provider is overloaded",
      url: "https://api",
      requestBodyValues: {},
      statusCode: 529,
      responseHeaders: {},
      responseBody: "Overloaded",
      isRetryable: true,
    })
    let streamCalls = 0
    const seenModels: string[] = []

    spies.push(
      spyOn(Config, "get").mockResolvedValue({
        experimental: { fallbackModel: "deepseek/fallback-model" },
      } as never),
    )
    spies.push(spyOn(SessionRetry, "sleep").mockResolvedValue(undefined))
    spies.push(spyOn(Provider, "getModel").mockResolvedValue({ providerID: "deepseek", id: "fallback-model" } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(
      spyOn(ModelGateway, "stream").mockImplementation(async (input: ModelGateway.StreamInput) => {
        streamCalls += 1
        seenModels.push(input.model.id)
        if (streamCalls <= 3) throw retryableError
        return { fullStream: (async function* () {})() } as never
      }),
    )

    const runtime = new QueryRuntime({
      assistantMessage: { id: "m_fallback", sessionID: "s_fallback", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "s_fallback",
      model: { providerID: "deepseek", id: "primary-model" } as Provider.Model,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })

    const events: QueryEvent[] = []
    for await (const event of runtime.run({ model: { providerID: "deepseek", id: "primary-model" } } as ModelGateway.StreamInput)) {
      events.push(event)
      if (event.type === "turn-finish") break
    }

    // 前 3 次重试仍用主模型，第 4 次起切换 fallback（attempt 重置后同步到 streamInput.model）
    expect(seenModels).toEqual(["primary-model", "primary-model", "primary-model", "fallback-model"])
    expect(events.some((e) => e.type === "status" && e.status.type === "model-switch")).toBe(true)
  })

  test("does not switch when fallbackModel is unset or equals the current model", async () => {
    const retryableError = new APICallError({
      message: "Provider is overloaded",
      url: "https://api",
      requestBodyValues: {},
      statusCode: 529,
      responseHeaders: {},
      responseBody: "Overloaded",
      isRetryable: true,
    })
    let streamCalls = 0
    const seenModels: string[] = []
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(SessionRetry, "sleep").mockResolvedValue(undefined))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(
      spyOn(ModelGateway, "stream").mockImplementation(async (input: ModelGateway.StreamInput) => {
        streamCalls += 1
        seenModels.push(input.model.id)
        // 第一次可重试（attempt=1 < 3），第二次不可重试 → turn-finish stop
        if (streamCalls === 1) throw retryableError
        throw new Error("fatal: prompt is too long")
      }),
    )

    const runtime = new QueryRuntime({
      assistantMessage: { id: "m_no_fallback", sessionID: "s_no_fallback", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "s_no_fallback",
      model: { providerID: "deepseek", id: "primary-model" } as Provider.Model,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })

    const events: QueryEvent[] = []
    for await (const event of runtime.run({ model: { providerID: "deepseek", id: "primary-model" } } as ModelGateway.StreamInput)) {
      events.push(event)
      if (event.type === "turn-finish") break
    }

    expect(seenModels).toEqual(["primary-model", "primary-model"])
    expect(events.some((e) => e.type === "status" && e.status.type === "model-switch")).toBe(false)
    expect(events.at(-1)?.type).toBe("turn-finish")
  })

  test("always-retryable provider failure without fallback opens the circuit after three consecutive failures", async () => {
    const retryableError = new APICallError({
      message: "Service Unavailable",
      url: "https://api",
      requestBodyValues: {},
      statusCode: 503,
      responseHeaders: {},
      responseBody: "temporary outage",
      isRetryable: true,
    })
    let streamCalls = 0
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: {} } as never))
    spies.push(spyOn(SessionRetry, "sleep").mockResolvedValue(undefined))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(
      spyOn(ModelGateway, "stream").mockImplementation(async () => {
        streamCalls += 1
        throw retryableError
      }),
    )

    const runtime = new QueryRuntime({
      assistantMessage: { id: "m_retry_circuit", sessionID: "s_retry_circuit", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "s_retry_circuit",
      model: { providerID: "deepseek", id: "primary-model" } as Provider.Model,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })

    const events: QueryEvent[] = []
    for await (const event of runtime.run({ model: { providerID: "deepseek", id: "primary-model" } } as ModelGateway.StreamInput)) {
      events.push(event)
    }

    expect(streamCalls).toBe(3)
    expect(events.filter((event) => event.type === "status" && event.status.type === "retry")).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
  })

  test("fallback model has its own bounded budget and stops after three more failures", async () => {
    const retryableError = new APICallError({
      message: "Service Unavailable",
      url: "https://api",
      requestBodyValues: {},
      statusCode: 503,
      responseHeaders: {},
      responseBody: "temporary outage",
      isRetryable: true,
    })
    const seenModels: string[] = []
    spies.push(spyOn(Config, "get").mockResolvedValue({ experimental: { fallbackModel: "deepseek/fallback-model" } } as never))
    spies.push(spyOn(SessionRetry, "sleep").mockResolvedValue(undefined))
    spies.push(spyOn(Provider, "getModel").mockResolvedValue({ providerID: "deepseek", id: "fallback-model" } as never))
    spies.push(spyOn(RuntimeHooks, "turnFinished").mockResolvedValue({}))
    spies.push(
      spyOn(ModelGateway, "stream").mockImplementation(async (input: ModelGateway.StreamInput) => {
        seenModels.push(input.model.id)
        throw retryableError
      }),
    )

    const runtime = new QueryRuntime({
      assistantMessage: { id: "m_fallback_circuit", sessionID: "s_fallback_circuit", agent: "analyst" } as MessageV2.Assistant,
      sessionID: "s_fallback_circuit",
      model: { providerID: "deepseek", id: "primary-model" } as Provider.Model,
      abort: new AbortController().signal,
      partFromToolCall: () => undefined,
    })
    const events: QueryEvent[] = []
    for await (const event of runtime.run({ model: { providerID: "deepseek", id: "primary-model" } } as ModelGateway.StreamInput)) {
      events.push(event)
    }

    expect(seenModels).toEqual([
      "primary-model", "primary-model", "primary-model",
      "fallback-model", "fallback-model", "fallback-model",
    ])
    expect(events.filter((event) => event.type === "status" && event.status.type === "model-switch")).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: "turn-finish", result: "stop" })
  })
})
