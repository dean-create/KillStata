import z from "zod"
import { Tool } from "./tool"
import { summarizeToolError } from "@/runtime/tool-result-policy"

const FRIENDLY_INVALID_TOOL_OUTPUT = "工具调用参数不符合契约，请根据工具描述修正参数后重试。"

export const InvalidTool = Tool.define("invalid", {
  description: "Do not use",
  parameters: z.object({
    tool: z.string(),
    error: z.string(),
  }),
  async execute(params) {
    const error = summarizeToolError(params.error)
    const message = [
      `工具：${params.tool}`,
      FRIENDLY_INVALID_TOOL_OUTPUT,
      `参数错误：${error}`,
      "不要重复原参数，也不要改换计量方法。",
    ].join("\n")
    throw new Error(`计量工具参数不合法：${message}`)
  },
})
