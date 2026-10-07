import { describe, expect, it } from "vitest"
import { createCoreEngineAdapter } from "./engine-adapter"
import type { EngineRunEvent } from "../engine/client"
import type { CoreSessionClient } from "./client"

/**
 * 只驱动 adapter 的事件翻译：用一个手工 core stub 发布 Core 事件，
 * 断言 Desktop 侧收到的 EngineRunEvent。不触网、不起 Core。
 */
function createHarness() {
  let publish: ((event: unknown) => void) | undefined
  const core = {
    subscribe(handler: (event: unknown) => void) {
      publish = handler
      return () => {}
    },
  } as unknown as CoreSessionClient

  const adapter = createCoreEngineAdapter(core)
  const received: EngineRunEvent[] = []
  const sessionID = "ses_test"
  adapter.subscribe(sessionID, (event) => received.push(event))
  return {
    adapter,
    sessionID,
    received,
    emit: (event: unknown) => publish?.(event),
  }
}

function createUnsubscribedHarness() {
  let publish: ((event: unknown) => void) | undefined
  const core = {
    subscribe(handler: (event: unknown) => void) {
      publish = handler
      return () => {}
    },
  } as unknown as CoreSessionClient
  const adapter = createCoreEngineAdapter(core)
  return {
    sessionID: "ses_pending",
    emit: (event: unknown) => publish?.(event),
    subscribe: (listener: (event: EngineRunEvent) => void) => adapter.subscribe("ses_pending", listener),
  }
}

const toolPart = (callID: string, status: string, extra: Record<string, unknown> = {}, toolName = "data_import") => ({
  type: "message.part.updated",
  properties: {
    part: {
      id: `prt_${callID}`,
      sessionID: "ses_test",
      messageID: "msg_1",
      type: "tool",
      callID,
      tool: toolName,
      state: { status, input: {}, ...extra },
    },
  },
})

describe("Core engine adapter event translation", () => {
  it("reuses the Core session for follow-up turns and leaves intent classification to Core", async () => {
    let sessionNumber = 0
    const prompts: Array<Record<string, unknown>> = []
    const core = {
      subscribe: () => () => {},
      whenEventStreamReady: async () => {},
      createSession: async () => ({ id: `ses_${++sessionNumber}` }),
      prompt: async (input: Record<string, unknown>) => { prompts.push(input) },
    } as unknown as CoreSessionClient
    const adapter = createCoreEngineAdapter(core)

    const model = { providerID: "deepseek", modelID: "deepseek-v4-flash" }
    const first = await adapter.startRun({ prompt: "导入并分析数据", model })
    const second = await adapter.startRun({ prompt: "按刚才的方法继续", sessionID: first.runId, model })

    expect(first.runId).toBe("ses_1")
    expect(second.runId).toBe("ses_1")
    expect(sessionNumber).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(prompts.every((prompt) => prompt.sessionID === "ses_1")).toBe(true)
    expect(prompts.every((prompt) => prompt.intent === undefined)).toBe(true)
    expect(prompts.every((prompt) => prompt.model === model)).toBe(true)
  })

  it("routes a selected Core slash command through session.command, not ordinary prompt", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const commands: Array<Record<string, unknown>> = []
    const core = {
      subscribe: () => () => {},
      whenEventStreamReady: async () => {},
      createSession: async () => ({ id: "ses_command" }),
      prompt: async (input: Record<string, unknown>) => { prompts.push(input) },
      command: async (input: Record<string, unknown>) => { commands.push(input) },
    } as unknown as CoreSessionClient
    const adapter = createCoreEngineAdapter(core)

    const result = await adapter.startRun({
      prompt: "/doctor",
      command: { name: "doctor", arguments: "" },
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
      effort: "high",
    })

    expect(result.runId).toBe("ses_command")
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      sessionID: "ses_command", command: "doctor", arguments: "", variant: "high",
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    })
    expect(prompts).toEqual([])
  })

  it("ignores a previous turn idle that arrives while a reused session is starting", async () => {
    let publish: ((event: unknown) => void) | undefined
    let promptCount = 0
    const core = {
      subscribe(handler: (event: unknown) => void) {
        publish = handler
        return () => {}
      },
      whenEventStreamReady: async () => {},
      createSession: async () => ({ id: "ses_follow_up" }),
      prompt: async () => {
        promptCount += 1
        if (promptCount !== 2) return
        publish?.({ type: "session.idle", properties: { sessionID: "ses_follow_up" } })
        publish?.({ type: "session.status", properties: { sessionID: "ses_follow_up", status: { type: "busy" } } })
        publish?.({
          type: "message.part.updated",
          properties: { part: { sessionID: "ses_follow_up", type: "text", text: "这是新一轮正文", synthetic: false, ignored: false } },
        })
        publish?.({ type: "session.idle", properties: { sessionID: "ses_follow_up" } })
      },
    } as unknown as CoreSessionClient
    const adapter = createCoreEngineAdapter(core)

    const first = await adapter.startRun({ prompt: "第一轮" })
    const off = adapter.subscribe(first.runId, () => {})
    publish?.({ type: "session.idle", properties: { sessionID: first.runId } })
    off()

    await adapter.startRun({ prompt: "第二轮", sessionID: first.runId })
    const received: EngineRunEvent[] = []
    adapter.subscribe(first.runId, (event) => received.push(event))

    expect(received).toEqual([
      { type: "assistant_delta", text: "这是新一轮正文" },
      { type: "completed", message: "分析已完成。" },
    ])
  })

  it("attaches the same dataset only once within a reused Core session", async () => {
    const prompts: Array<{ files?: unknown[]; worksheetName?: string }> = []
    const core = {
      subscribe: () => () => {},
      whenEventStreamReady: async () => {},
      createSession: async () => ({ id: "ses_dataset" }),
      prompt: async (input: { files?: unknown[]; worksheetName?: string }) => { prompts.push(input) },
    } as unknown as CoreSessionClient
    const adapter = createCoreEngineAdapter(core)
    const file = new File(["id,y\n1,2"], "study.csv", { type: "text/csv" })
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("id,y\n1,2").buffer,
    })
    const dataset = await adapter.uploadDataset(file)
    const sameDataset = await adapter.uploadDataset(file)

    const first = await adapter.startRun({ prompt: "导入", dataset, worksheetName: "Data_原始编码" })
    await adapter.startRun({ prompt: "继续分析", dataset: sameDataset, worksheetName: "Data_可读", sessionID: first.runId })

    expect(sameDataset.id).toBe(dataset.id)
    expect(prompts[0]?.files).toHaveLength(1)
    expect(prompts[1]?.files).toBeUndefined()
    expect(prompts.map((prompt) => prompt.worksheetName)).toEqual(["Data_原始编码", "Data_可读"])
  })

  it("drops internal timeline messages instead of printing them as progress", () => {
    const harness = createHarness()
    // 这些是 task-ledger 给工程排障用的内部字符串，研究者不该看到。
    for (const message of ["cache observation", "context v1", "query completed"]) {
      harness.emit({
        type: "runtime.timeline.event",
        properties: { sessionID: harness.sessionID, event: { id: "tle_1", taskId: "t1", sessionID: harness.sessionID, kind: "model.request", message, createdAt: "" } },
      })
    }
    expect(harness.received).toHaveLength(0)
  })

  it("does not stream internal dataset lineage as researcher-visible reasoning", () => {
    const harness = createHarness()
    harness.emit({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: harness.sessionID,
          type: "reasoning",
          text: "datasetId=dataset_private stageId=stage_000，准备读取 manifest。",
        },
      },
    })
    expect(harness.received).toHaveLength(0)

    harness.emit({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: harness.sessionID,
          type: "reasoning",
          text: "I need the actual datasetId and stageId before continuing.",
        },
      },
    })
    expect(harness.received).toHaveLength(0)
  })

  it("suppresses internal compaction-summary text while streaming ordinary assistant text", () => {
    const harness = createHarness()
    harness.emit({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_internal_summary",
          sessionID: harness.sessionID,
          role: "assistant",
          mode: "compaction",
          summary: true,
        },
      },
    })
    harness.emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_internal_summary",
          sessionID: harness.sessionID,
          messageID: "msg_internal_summary",
          type: "text",
          text: "<summary>内部恢复摘要 datasetId=private</summary>",
          synthetic: false,
          ignored: false,
        },
      },
    })
    harness.emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_internal_reasoning",
          sessionID: harness.sessionID,
          messageID: "msg_internal_summary",
          type: "reasoning",
          text: "内部压缩草稿：用户要求只检查参数，不运行估计。",
        },
      },
    })
    harness.emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_user_answer",
          sessionID: harness.sessionID,
          messageID: "msg_user_answer",
          type: "text",
          text: "这是面向研究者的答案。",
          synthetic: false,
          ignored: false,
        },
      },
    })

    expect(harness.received).toEqual([{ type: "assistant_delta", text: "这是面向研究者的答案。" }])
  })

  it("getResult chooses the latest user-facing assistant response, not the internal summary", async () => {
    const core = {
      subscribe: () => () => {},
      loadSession: async () => [
        {
          info: { id: "msg_answer", role: "assistant", mode: "analyst", summary: false },
          parts: [{ type: "text", text: "这是已交付的分析结果。", synthetic: false, ignored: false }],
        },
        {
          info: { id: "msg_summary", role: "assistant", mode: "compaction", summary: true },
          parts: [{ type: "text", text: "<summary>隐藏的上下文摘要</summary>", synthetic: false, ignored: false }],
        },
      ],
    } as unknown as CoreSessionClient
    const adapter = createCoreEngineAdapter(core)

    await expect(adapter.getResult("ses_summary_filter")).resolves.toMatchObject({
      status: "completed",
      document: "这是已交付的分析结果。",
    })
  })

  it("projects a terminal Core failure as failed instead of disposable progress", () => {
    const harness = createHarness()
    harness.emit({
      type: "runtime.timeline.event",
      properties: {
        sessionID: harness.sessionID,
        event: {
          id: "tle_2",
          taskId: "t1",
          sessionID: harness.sessionID,
          kind: "failure",
          message: "internal failure detail",
          failureDecision: {
            scope: "tool",
            category: "data_quality_blocked",
            disposition: "stop",
            reason: "missing time variable",
            userVisibleMessage: "数据缺少时间变量，已停止分析。",
          },
          createdAt: "",
        },
      },
    })
    expect(harness.received).toEqual([{ type: "failed", message: "数据缺少时间变量，已停止分析。" }])
  })

  it("projects user cancellation as cancelled", () => {
    const harness = createHarness()
    harness.emit({
      type: "runtime.timeline.event",
      properties: {
        sessionID: harness.sessionID,
        event: {
          failureDecision: {
            scope: "tool",
            category: "user_cancelled",
            disposition: "stop",
            reason: "cancelled",
            userVisibleMessage: "用户已停止本次工具执行。",
          },
        },
      },
    })
    expect(harness.received).toEqual([{ type: "cancelled", message: "用户已停止本次工具执行。" }])
  })

  it("keeps recoverable failure decisions inside the harness loop", () => {
    const harness = createHarness()
    harness.emit({
      type: "runtime.timeline.event",
      properties: {
        sessionID: harness.sessionID,
        event: {
          failureDecision: {
            scope: "tool",
            category: "invalid_argument",
            disposition: "repair",
            reason: "wrong field",
            userVisibleMessage: "参数错误，正在修复。",
          },
        },
      },
    })
    expect(harness.received).toEqual([])
  })

  it("does not announce session busy as its own progress line", () => {
    const harness = createHarness()
    harness.emit({ type: "session.status", properties: { sessionID: harness.sessionID, status: { type: "busy" } } })
    expect(harness.received).toHaveLength(0)
  })

  it("translates a tool call into a Codex-style step keyed by callID", () => {
    const harness = createHarness()
    harness.emit(toolPart("call_1", "running"))
    harness.emit(toolPart("call_1", "completed", { output: "", title: "", metadata: {}, time: { start: 0, end: 1 } }))

    expect(harness.received).toEqual([
      { type: "progress", message: "正在处理数据…", step: { id: "call_1", label: "处理数据", phase: "analysis", status: "running" } },
      { type: "progress", message: "已完成处理数据", step: { id: "call_1", label: "处理数据", phase: "analysis", status: "completed" } },
    ])
  })

  it("delivers a completed verifier result after session idle without reopening the turn", () => {
    const harness = createHarness()
    const updates: unknown[] = []
    harness.adapter.subscribeVerification?.((update) => updates.push(update))
    harness.emit(toolPart("call_ols", "completed", {
      output: "估计结果", metadata: { verifierPending: true }, time: { start: 0, end: 1 },
    }, "ols_regression"))
    harness.emit({ type: "session.idle", properties: { sessionID: harness.sessionID } })
    const verifiedPart = toolPart("call_ols", "completed", {
      output: "估计结果\n\n独立核验通过。", metadata: { verifierStatus: "pass" }, time: { start: 0, end: 2 },
    }, "ols_regression")
    harness.emit(verifiedPart)
    harness.emit(verifiedPart)

    expect(harness.received[0]).toMatchObject({
      type: "progress", step: { id: "call_ols", status: "completed" },
    })
    expect(harness.received.at(-1)).toEqual({
      type: "verification", callID: "call_ols", status: "pass", message: "独立核验通过。",
    })
    expect(updates).toEqual([
      {
        sessionID: harness.sessionID, messageID: "msg_1", callID: "call_ols",
        status: "pending", message: "独立核验未完成；估计结果已保留。后续可从核验阶段继续。",
      },
      {
        sessionID: harness.sessionID, messageID: "msg_1", callID: "call_ols",
        status: "pass", message: "独立核验通过。",
      },
    ])
    expect(harness.received.filter((event) => event.type === "verification")).toHaveLength(2)
  })

  it("keeps the failed data_import action and recovery hint visible", () => {
    const harness = createHarness()
    harness.emit(toolPart("call_profile", "error", {
      input: { action: "profile" },
      error: "工具执行失败：数据动作 profile 需要 inputPath，或提供当前会话的 datasetId。",
      time: { start: 0, end: 1 },
    }))

    expect(harness.received).toEqual([{
      type: "progress",
      message: "读取数据概览未成功：缺少当前数据集引用。正在使用最新数据阶段修复。",
      step: { id: "call_profile", label: "读取数据概览", phase: "analysis", status: "failed" },
    }])
  })

  it("marks an earlier failed step as recovered only after the same tool succeeds", () => {
    const harness = createHarness()
    harness.emit(toolPart("recommend_failed", "error", { error: "Dataset manifest not found", time: { start: 0, end: 1 } }, "econometrics_recommend"))
    harness.emit(toolPart("other_success", "completed", { output: "", title: "", metadata: {} }, "ols_regression"))
    expect(harness.received.some((event) => event.type === "progress" && event.step?.status === "recovered")).toBe(false)

    harness.emit(toolPart("recommend_retried", "completed", {
      output: "", title: "", metadata: { analysisView: { step: "econometrics(profile)" } }, time: { start: 2, end: 3 },
    }, "econometrics_recommend"))
    expect(harness.received).toContainEqual({
      type: "progress",
      message: "推荐计量方法已恢复",
      step: { id: "recommend_failed", label: "推荐计量方法", phase: "analysis", status: "recovered" },
    })
    expect(harness.received.at(-1)).toMatchObject({
      type: "progress",
      step: { id: "recommend_retried", status: "completed" },
    })
  })

  it("prefers the analysis step label Core attaches to the tool metadata", () => {
    const harness = createHarness()
    harness.emit(toolPart("call_2", "running", { metadata: { analysisView: { kind: "estimate", step: "did2s" } } }))
    expect(harness.received[0]).toMatchObject({
      message: "正在两阶段双重差分…",
      step: { label: "两阶段双重差分" },
    })
  })

  it("collapses Core's two end-of-run notifications into a single completed event", () => {
    const harness = createHarness()
    // Core 对同一次结束发两条：session.status{idle} 和 session.idle。若都翻译成
    // completed，App 会在第二条时认为流式消息不存在而重新拉全文，出现重复气泡。
    harness.emit({ type: "session.status", properties: { sessionID: harness.sessionID, status: { type: "idle" } } })
    harness.emit({ type: "session.idle", properties: { sessionID: harness.sessionID } })

    expect(harness.received).toEqual([{ type: "completed", message: "分析已完成。" }])
  })

  it("still delivers the Core-generated title after the run reached a terminal state", () => {
    const harness = createHarness()
    harness.emit({ type: "session.idle", properties: { sessionID: harness.sessionID } })
    // Core 的标题事件比 session.idle 晚到；解绑过早会让标题永远丢失。
    harness.emit({ type: "session.updated", properties: { info: { id: harness.sessionID, title: "最低工资与就业" } } })

    expect(harness.received).toEqual([
      { type: "completed", message: "分析已完成。" },
      { type: "title", title: "最低工资与就业" },
    ])
  })

  it("replays events that arrive after prompt acceptance but before the UI subscribes", () => {
    const harness = createUnsubscribedHarness()
    harness.emit({
      type: "message.part.updated",
      properties: { part: { sessionID: harness.sessionID, type: "text", text: "流式正文", synthetic: false, ignored: false } },
    })
    harness.emit({ type: "session.status", properties: { sessionID: harness.sessionID, status: { type: "idle" } } })
    harness.emit({ type: "session.idle", properties: { sessionID: harness.sessionID } })

    const received: EngineRunEvent[] = []
    harness.subscribe((event) => received.push(event))

    expect(received).toEqual([
      { type: "assistant_delta", text: "流式正文" },
      { type: "completed", message: "分析已完成。" },
    ])
  })

  it("未订阅时进入终态后只缓冲标题，不让迟到进度挤掉 completed", () => {
    const harness = createUnsubscribedHarness()
    harness.emit({ type: "session.idle", properties: { sessionID: harness.sessionID } })
    harness.emit({
      type: "runtime.timeline.event",
      properties: { sessionID: harness.sessionID, event: { failureDecision: { userVisibleMessage: "不应进入终态后的缓冲" } } },
    })
    harness.emit({ type: "session.updated", properties: { info: { id: harness.sessionID, title: "终态标题" } } })

    const received: EngineRunEvent[] = []
    harness.subscribe((event) => received.push(event))

    expect(received).toEqual([
      { type: "completed", message: "分析已完成。" },
      { type: "title", title: "终态标题" },
    ])
  })

  it("新的会话启动不会清空旧会话的 terminal 去重标记", async () => {
    let publish: ((event: unknown) => void) | undefined
    let sessionNumber = 0
    const core = {
      subscribe(handler: (event: unknown) => void) {
        publish = handler
        return () => {}
      },
      whenEventStreamReady: async () => {},
      createSession: async () => ({ id: `ses_${++sessionNumber}` }),
      prompt: async () => {},
    } as unknown as CoreSessionClient
    const adapter = createCoreEngineAdapter(core)
    const first = await adapter.startRun({ prompt: "第一项" })
    const firstEvents: EngineRunEvent[] = []
    adapter.subscribe(first.runId, (event) => firstEvents.push(event))

    publish?.({ type: "session.idle", properties: { sessionID: first.runId } })
    await adapter.startRun({ prompt: "第二项" })
    publish?.({ type: "session.idle", properties: { sessionID: first.runId } })

    expect(firstEvents.filter((event) => event.type === "completed")).toHaveLength(1)
  })

  it("prompt 提交失败时不会把未订阅的旧事件泄漏到后续复用会话", async () => {
    let publish: ((event: unknown) => void) | undefined
    let promptCount = 0
    const core = {
      subscribe(handler: (event: unknown) => void) {
        publish = handler
        return () => {}
      },
      whenEventStreamReady: async () => {},
      createSession: async () => ({ id: "ses_reused" }),
      prompt: async () => {
        promptCount += 1
        if (promptCount === 1) {
          publish?.({ type: "runtime.timeline.event", properties: { sessionID: "ses_reused", event: { failureDecision: { userVisibleMessage: "旧任务步骤" } } } })
          throw new Error("提交失败")
        }
      },
    } as unknown as CoreSessionClient
    const adapter = createCoreEngineAdapter(core)

    await expect(adapter.startRun({ prompt: "第一项" })).rejects.toThrow("提交失败")
    await adapter.startRun({ prompt: "第二项" })
    const received: EngineRunEvent[] = []
    adapter.subscribe("ses_reused", (event) => received.push(event))

    expect(received).toEqual([])
  })
})
