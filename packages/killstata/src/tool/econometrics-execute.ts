import z from "zod"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import type { MessageV2 } from "@/session/message-v2"

/**
 * OpenAI-compatible模型没有Anthropic的inline tool_reference协议时，使用这个稳定路由入口。
 * 通用信封由Zod校验；具体方法参数由Python Registry的Pydantic契约校验。
 */
export const EconometricsExecuteInput = z
  .object({
    specId: z.string().trim().min(1).describe("仅使用 analysis_prepare 在当前 AnalysisRequest、数据阶段和 Python Registry 版本下返回的 specId；不能猜测或复用其他任务的 ID。"),
  })
  .strict()

type EconometricsExecuteResult = {
  title: string
  metadata: Record<string, unknown>
  output: string
  attachments?: MessageV2.FilePart[]
}

export type EconometricsMethodExecutor = (
  input: z.infer<typeof EconometricsExecuteInput>,
  ctx: Tool.Context,
) => Promise<EconometricsExecuteResult>

export const EconometricsExecuteTool = Tool.define(
  "econometrics_execute",
  Tool.Execution.managedFilesystem,
  ToolModel.forTool("econometrics_execute"),
  {
    description:
      "执行 analysis_prepare 已验证并绑定到当前用户 estimate 请求、数据阶段、指纹和 Python Registry 版本的规格。输入只接受当前账本返回的 specId；不接收 methodID、研究参数或数据血缘。执行前 Harness 会重新核对 PreparedSpec、用户方法授权、当前 stage、Pydantic Schema 和 Python preflight；任何绑定失效均停止且不自动重跑。未完成规格准备时先 tool_search 加载完整 Schema，再调用 analysis_prepare。",
    parameters: EconometricsExecuteInput,
    async execute(params, ctx) {
      const executor = ctx.extra?.executeEconometricsMethod as EconometricsMethodExecutor | undefined
      if (!executor) {
        throw new Error("当前运行时没有提供计量方法执行路由；请先调用 tool_search 加载目标方法。")
      }
      return executor(params, ctx)
    },
  },
)
