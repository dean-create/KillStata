import { describe, expect, test } from "bun:test"
import { detectWorkflowThrashing } from "@/session/prompt/thrashing"

function assistantMsg(parts: Array<{ tool: string; action?: string; status?: string; input?: Record<string, unknown> }>) {
  return {
    info: { role: "assistant" },
    parts: parts.map((p) => ({
      type: "tool",
      tool: p.tool,
      state: {
        status: p.status ?? "completed",
        input: { ...(p.action ? { action: p.action } : {}), ...(p.input ?? {}) },
      },
    })),
  } as any
}

describe("detectWorkflowThrashing", () => {
  test("同一条消息内 6 个并行 workflow 只读调用应触发（此前只统计 1 个漏检）", () => {
    const msgs = [
      assistantMsg([
        { tool: "pipeline", action: "status" },
        { tool: "pipeline", action: "tools" },
        { tool: "pipeline", action: "stage" },
        { tool: "pipeline", action: "doctor" },
        { tool: "pipeline", action: "tasks" },
        { tool: "pipeline", action: "diagnostics" },
      ]),
    ]
    const result = detectWorkflowThrashing(msgs as any)
    expect(result.consecutiveCalls).toBe(6)
    expect(result.thrashing).toBe(true)
  })

  test("5 次就触发（WINDOW=5）", () => {
    const msgs = [
      assistantMsg([
        { tool: "pipeline", action: "status" },
        { tool: "pipeline", action: "tools" },
        { tool: "pipeline", action: "stage" },
        { tool: "pipeline", action: "doctor" },
        { tool: "pipeline", action: "verify" },
      ]),
    ]
    expect(detectWorkflowThrashing(msgs as any).thrashing).toBe(true)
  })

  test("4 次不触发", () => {
    const msgs = [
      assistantMsg([
        { tool: "pipeline", action: "status" },
        { tool: "pipeline", action: "tools" },
        { tool: "pipeline", action: "stage" },
        { tool: "pipeline", action: "doctor" },
      ]),
    ]
    expect(detectWorkflowThrashing(msgs as any).thrashing).toBe(false)
  })

  test("混入非只读 workflow action（rerun）中断计数", () => {
    const msgs = [
      assistantMsg([
        { tool: "pipeline", action: "status" },
        { tool: "pipeline", action: "rerun" },
        { tool: "pipeline", action: "status" },
        { tool: "pipeline", action: "tools" },
        { tool: "pipeline", action: "stage" },
      ]),
    ]
    const result = detectWorkflowThrashing(msgs as any)
    expect(result.consecutiveCalls).toBeLessThan(5)
    expect(result.thrashing).toBe(false)
  })

  test("非 thrashing 工具（read）中断计数", () => {
    const msgs = [
      assistantMsg([
        { tool: "pipeline", action: "status" },
        { tool: "read" },
        { tool: "pipeline", action: "tools" },
        { tool: "pipeline", action: "stage" },
        { tool: "pipeline", action: "doctor" },
      ]),
    ]
    const result = detectWorkflowThrashing(msgs as any)
    expect(result.consecutiveCalls).toBeLessThan(5)
    expect(result.thrashing).toBe(false)
  })

  test("跨多条消息连续统计", () => {
    const msgs = [
      assistantMsg([{ tool: "pipeline", action: "status" }]),
      assistantMsg([{ tool: "pipeline", action: "tools" }]),
      assistantMsg([{ tool: "pipeline", action: "stage" }]),
      assistantMsg([{ tool: "pipeline", action: "doctor" }]),
      assistantMsg([{ tool: "pipeline", action: "verify" }]),
    ]
    expect(detectWorkflowThrashing(msgs as any).thrashing).toBe(true)
  })

  test("data_import 的重复画像/频数/质检调用也应触发", () => {
    const msgs = [
      assistantMsg([{ tool: "data_import", action: "profile" }]),
      assistantMsg([{ tool: "data_import", action: "frequency" }]),
      assistantMsg([{ tool: "data_import", action: "frequency" }]),
      assistantMsg([{ tool: "data_import", action: "validate" }]),
      assistantMsg([{ tool: "data_import", action: "healthcheck" }]),
    ]
    const result = detectWorkflowThrashing(msgs as any)
    expect(result.toolName).toBe("data_import")
    expect(result.consecutiveCalls).toBe(5)
    expect(result.thrashing).toBe(true)
  })

  test("data_import 的导入或非只读动作会中断重复查询计数", () => {
    const msgs = [
      assistantMsg([{ tool: "data_import", action: "profile" }]),
      assistantMsg([{ tool: "data_import", action: "frequency" }]),
      assistantMsg([{ tool: "data_import", action: "import" }]),
      assistantMsg([{ tool: "data_import", action: "validate" }]),
      assistantMsg([{ tool: "data_import", action: "profile" }]),
    ]
    const result = detectWorkflowThrashing(msgs as any)
    expect(result.thrashing).toBe(false)
    expect(result.consecutiveCalls).toBeLessThan(5)
  })

  test("五个不同的只读数据动作不应被误判为空转", () => {
    const msgs = [
      assistantMsg([{ tool: "data_import", action: "profile" }]),
      assistantMsg([{ tool: "data_import", action: "frequency" }]),
      assistantMsg([{ tool: "data_import", action: "validate" }]),
      assistantMsg([{ tool: "data_import", action: "correlation" }]),
      assistantMsg([{ tool: "data_import", action: "healthcheck" }]),
    ]

    expect(detectWorkflowThrashing(msgs as any).thrashing).toBe(false)
  })

  test("数据变换后连续五个不同只读查询也应触发空转护栏", () => {
    const msgs = [
      assistantMsg([{ tool: "data_preprocess", action: "create_column", input: { datasetId: "d1", stageId: "stage_000" } }]),
      assistantMsg([{ tool: "data_import", action: "frequency", input: { datasetId: "d1", stageId: "stage_001", variables: ["post"], groupBy: ["did"] } }]),
      assistantMsg([{ tool: "data_import", action: "validate", input: { datasetId: "d1", stageId: "stage_001" } }]),
      assistantMsg([{ tool: "data_import", action: "frequency", input: { datasetId: "d1", stageId: "stage_001", variables: ["post"], groupBy: ["time"] } }]),
      assistantMsg([{ tool: "data_import", action: "frequency", input: { datasetId: "d1", stageId: "stage_001", variables: ["year"], groupBy: ["did"] } }]),
      assistantMsg([{ tool: "data_import", action: "frequency", input: { datasetId: "d1", stageId: "stage_001", variables: ["time"], groupBy: ["did"] } }]),
    ]
    const result = detectWorkflowThrashing(msgs as any)
    expect(result.consecutiveCalls).toBe(5)
    expect(result.thrashing).toBe(true)
  })

  test("同一外部化工具结果反复分页读取应触发空转护栏", () => {
    const msgs = [
      assistantMsg([{ tool: "read", input: { filePath: "tool-output:result-1", offset: 0 } }]),
      assistantMsg([{ tool: "pipeline", action: "artifacts" }]),
      assistantMsg([{ tool: "read", input: { filePath: "tool-output:result-1", offset: 200 } }]),
      assistantMsg([{ tool: "pipeline", action: "tasks" }]),
      assistantMsg([{ tool: "read", input: { filePath: "tool-output:result-1", offset: 400 } }]),
      assistantMsg([{ tool: "read", input: { filePath: "tool-output:result-1", offset: 600 } }]),
      assistantMsg([{ tool: "read", input: { filePath: "tool-output:result-1", offset: 800 } }]),
    ]

    const result = detectWorkflowThrashing(msgs as any)
    expect(result.thrashing).toBe(true)
    expect(result.toolName).toBe("read")
  })

  test("不同实体/时间列的 validate 不应被误判为同一查询重复", () => {
    const msgs = [
      assistantMsg([{ tool: "data_import", action: "validate", input: { entityVar: "省份", timeVar: "年份" } }]),
      assistantMsg([{ tool: "data_import", action: "validate", input: { entityVar: "地区", timeVar: "年份" } }]),
      assistantMsg([{ tool: "data_import", action: "validate", input: { entityVar: "省份", timeVar: "year" } }]),
      assistantMsg([{ tool: "data_import", action: "validate", input: { entityVar: "地区", timeVar: "year" } }]),
      assistantMsg([{ tool: "data_import", action: "validate", input: { entityVar: "省份", timeVar: "time" } }]),
    ]

    expect(detectWorkflowThrashing(msgs as any).thrashing).toBe(false)
  })

  test("用户要求不安全就停止时，不同只读探查也应触发研究设计空转护栏", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "用户请求" }] },
      assistantMsg([{ tool: "data_import", action: "import" }]),
      assistantMsg([{ tool: "data_import", action: "profile" }]),
      assistantMsg([{ tool: "read" }]),
      assistantMsg([{ tool: "data_import", action: "frequency" }]),
      assistantMsg([{ tool: "econometrics_recommend" }]),
    ]
    const result = detectWorkflowThrashing(msgs as any, {
      userText: "如果当前工具不能构造 relative_time，请说明需要我提供这列并停止，不要用 Bash 或猜阈值反复试错。",
    })
    expect(result.researchDesign).toBe(true)
    expect(result.thrashing).toBe(true)
  })

  test("用户说‘如果不支持就停止’且已完成基准估计时，仍应拦截后续猜造分组", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "用户请求" }] },
      assistantMsg([{ tool: "data_import", action: "import" }]),
      assistantMsg([{ tool: "data_import", action: "profile" }]),
      assistantMsg([{ tool: "ols_regression" }]),
      assistantMsg([{ tool: "data_import", action: "profile" }]),
      assistantMsg([{ tool: "data_import", action: "frequency" }]),
    ]
    const result = detectWorkflowThrashing(msgs as any, {
      userText: "先跑基准OLS，再按中位数分组；如果不支持，请说明需要我提供分类列并停止，不要猜阈值或反复尝试。",
    })
    expect(result.researchDesign).toBe(true)
    expect(result.thrashing).toBe(true)
  })

  test("研究设计空转护栏不会拦截已经进入预处理或估计的任务", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "用户请求" }] },
      assistantMsg([{ tool: "data_import", action: "import" }]),
      assistantMsg([{ tool: "data_import", action: "profile" }]),
      assistantMsg([{ tool: "data_preprocess", action: "create_column" }]),
      assistantMsg([{ tool: "data_import", action: "frequency" }]),
      assistantMsg([{ tool: "econometrics_recommend" }]),
    ]
    const result = detectWorkflowThrashing(msgs as any, {
      userText: "如果当前工具不能构造 relative_time，请说明需要我提供这列并停止，不要用 Bash 或猜阈值反复试错。",
    })
    expect(result.researchDesign).toBe(false)
  })
})
