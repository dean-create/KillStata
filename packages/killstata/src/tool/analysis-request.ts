import z from "zod"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"

const AnalysisRequestInput = z.object({
  kind: z.enum(["inspect", "estimate", "explain", "repair"])
    .describe("当前用户动作类型：仅检查数据、请求估计、解释已有结果或修复已知问题。"),
  researchGoal: z.string().trim().min(1).max(1000)
    .describe("用简短中文概括用户本条消息的研究目标；缺少目标时只登记 inspect 或 explain，不得虚构变量角色。"),
  constraints: z.array(z.string().trim().min(1).max(240)).max(12).default([])
    .describe("模型从当前用户消息提取的约束摘要，例如“不作因果解释”“不删除观测”；它是待核对解释，不是授权凭据，不得写入用户未明确表达的决定。"),
}).strict()

export const AnalysisRequestTool = Tool.define("analysis_request", Tool.Execution.session, ToolModel.forTool("analysis_request"), {
  description:
    "登记当前用户消息对应的计量分析请求，作为后续数据诊断、规格准备与任务恢复的稳定锚点。此工具只写当前会话任务账本，不读取、修改或估计数据。requestId 和 sourceMessageId 由 Harness 生成并绑定，模型不得提供或覆盖。重复登记同一用户消息会返回原请求，不会重写其意图。登记本身不是用户对方法、变量、样本处理或因果设定的授权。",
  parameters: AnalysisRequestInput,
  async execute(params, ctx) {
    const sourceMessageId = ctx.extra?.sourceUserMessageId
    if (typeof sourceMessageId !== "string" || sourceMessageId.length === 0) {
      throw new Tool.InputValidationError("Harness 未提供当前用户消息引用，未登记分析请求。请保留当前轮次并重试，不要猜测消息 ID。")
    }
    const ledger = RuntimeTaskLedger.listTasks(ctx.sessionID)
    const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId && item.messageID === sourceMessageId)
    if (!task) {
      throw new Tool.InputValidationError("当前任务账本没有与这条用户消息匹配的活动任务，未登记分析请求。请由 Harness 从当前用户消息恢复，不要复用其他轮次的任务。")
    }

    const request = RuntimeTaskLedger.recordAnalysisRequest({
      sessionID: ctx.sessionID,
      taskId: task.taskId,
      sourceMessageId,
      kind: params.kind,
      researchGoal: params.researchGoal,
      constraints: params.constraints,
    })
    return {
      title: "分析请求已登记",
      output: [
        `本条用户消息已登记为“${request.kind}”请求。`,
        `目标摘要：${request.researchGoal}`,
        request.constraints.length ? `模型提取的约束摘要（以原始用户消息为准）：${request.constraints.join("；")}` : "当前没有提取到约束；如研究含义不清，需回到原始用户消息或向用户确认。",
        "这是任务记录，不是研究规格或执行授权；请继续读取当前数据诊断，并在目标或变量角色缺失时向用户澄清。",
      ].join("\n"),
      metadata: {
        analysisRequestRefreshPool: true,
        finalizeAfterResult: true,
        analysisRequest: {
          version: request.version,
          requestId: request.requestId,
          sourceMessageId: request.sourceMessageId,
          kind: request.kind,
          registeredAt: request.registeredAt,
        },
        researchGoal: request.researchGoal,
        modelInterpretedConstraints: request.constraints,
        userAuthorization: false,
      },
    }
  },
})
