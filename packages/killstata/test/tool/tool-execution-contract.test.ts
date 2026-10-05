import { describe, expect, test } from "bun:test"
import z from "zod"
import { Tool } from "@/tool/tool"

const model = {
  namespace: "filesystem" as const,
  useWhen: "需要执行测试工具契约回归时。",
  doNotUseWhen: "真实文件操作。",
  returns: "返回一个标准工具结果。",
  failureRecovery: "检查失败字段并停止重复执行。",
}

function context(abort = new AbortController().signal): Tool.Context {
  return {
    sessionID: "session-test",
    messageID: "message-test",
    agent: "test",
    abort,
    metadata() {},
    ask: async () => {},
  }
}

describe("通用工具执行契约", () => {
  test("拒绝缺少标准字段的工具成功返回，错误码标记为输出契约失败", async () => {
    const definition = Tool.define(
      "contract_probe",
      Tool.Execution.readOnly,
      model,
      {
        description: "仅用于验证通用输出契约。",
        parameters: z.object({}),
        async execute() {
          return { title: "不完整", output: "missing metadata" } as never
        },
      },
    )
    const initialized = await definition.init()

    await expect(initialized.execute({}, context())).rejects.toMatchObject({
      code: "TOOL_OUTPUT_INVALID",
      name: "ToolOutputValidationError",
    })
  })

  test("拒绝输出字段类型不符合通用 Schema 的结果", async () => {
    const definition = Tool.define(
      "wrong_output_type_probe",
      Tool.Execution.readOnly,
      model,
      {
        description: "验证返回字段类型。",
        parameters: z.object({}),
        async execute() {
          return { title: "错误类型", metadata: {}, output: 42 } as never
        },
      },
    )
    const initialized = await definition.init()

    await expect(initialized.execute({}, context())).rejects.toMatchObject({
      code: "TOOL_OUTPUT_INVALID",
      message: expect.stringContaining("output"),
    })
  })

  test("拒绝结构无效的附件，避免媒体投影阶段才崩溃", async () => {
    const definition = Tool.define(
      "invalid_attachment_probe",
      Tool.Execution.readOnly,
      model,
      {
        description: "验证附件元素结构。",
        parameters: z.object({}),
        async execute() {
          return { title: "附件", metadata: {}, output: "ok", attachments: [null] } as never
        },
      },
    )
    const initialized = await definition.init()

    await expect(initialized.execute({}, context())).rejects.toMatchObject({
      code: "TOOL_OUTPUT_INVALID",
      message: expect.stringContaining("attachments.0"),
    })
  })

  test("达到工具统一执行期限时中止该次调用并返回类型化超时", async () => {
    let executionSignal: AbortSignal | undefined
    const definition = Tool.define(
      "timeout_probe",
      {
        ...Tool.Execution.readOnly,
        timeout: { kind: "bounded", timeoutMs: 5 },
      } as Tool.ExecutionPolicy,
      model,
      {
        description: "仅用于验证工具执行期限。",
        parameters: z.object({}),
        async execute(_args, ctx) {
          executionSignal = ctx.abort
          await new Promise((resolve) => setTimeout(resolve, 40))
          return { title: "late", metadata: {}, output: String(ctx.abort.aborted) }
        },
      },
    )
    const initialized = await definition.init()

    await expect(initialized.execute({}, context())).rejects.toMatchObject({
      code: "TOOL_EXECUTION_TIMEOUT",
      name: "ToolExecutionTimeoutError",
      timeoutMs: 5,
    })
    expect(executionSignal?.aborted).toBe(true)
  })

  test("用户取消与工具超时保持不同错误身份", async () => {
    const parentAbort = new AbortController()
    const cancelReason = new Error("user cancelled")
    const definition = Tool.define(
      "cancel_probe",
      {
        ...Tool.Execution.readOnly,
        timeout: { kind: "bounded", timeoutMs: 500 },
      } as Tool.ExecutionPolicy,
      model,
      {
        description: "仅用于验证用户取消优先级。",
        parameters: z.object({}),
        async execute(_args, ctx) {
          await new Promise<void>((_resolve, reject) => {
            ctx.abort.addEventListener("abort", () => reject(ctx.abort.reason), { once: true })
          })
          return { title: "unreachable", metadata: {}, output: "" }
        },
      },
    )
    const initialized = await definition.init()
    const pending = initialized.execute({}, context(parentAbort.signal))
    parentAbort.abort(cancelReason)

    await expect(pending).rejects.toBe(cancelReason)
  })

  test("工具等待用户确认的时间不消耗执行超时预算", async () => {
    const definition = Tool.define(
      "permission_wait_probe",
      {
        ...Tool.Execution.readOnly,
        timeout: { kind: "bounded", timeoutMs: 15 },
      } as Tool.ExecutionPolicy,
      model,
      {
        description: "验证用户交互等待不计入工具执行期限。",
        parameters: z.object({}),
        async execute(_args, ctx) {
          await ctx.ask({ permission: "test", patterns: ["*"], metadata: {}, always: [] })
          return { title: "确认完成", metadata: {}, output: "工具执行成功" }
        },
      },
    )
    const initialized = await definition.init()
    const ctx = context()
    ctx.ask = async () => { await new Promise((resolve) => setTimeout(resolve, 40)) }

    await expect(initialized.execute({}, ctx)).resolves.toMatchObject({ output: "工具执行成功" })
  })
})
