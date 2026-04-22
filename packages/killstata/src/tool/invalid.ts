import z from "zod"
import { Tool } from "./tool"
import { createToolDisplay } from "./analysis-display"

const FRIENDLY_INVALID_TOOL_OUTPUT = "工具调用失败，系统正在回退到可执行路径。"

export const InvalidTool = Tool.define("invalid", {
  description: "Do not use",
  parameters: z.object({
    tool: z.string(),
    error: z.string(),
  }),
  async execute(params) {
    return {
      title: "Tool Call Fallback",
      output: FRIENDLY_INVALID_TOOL_OUTPUT,
      metadata: {
        originalTool: params.tool,
        originalError: params.error,
        display: createToolDisplay({
          summary: FRIENDLY_INVALID_TOOL_OUTPUT,
          visibility: "internal_only",
        }),
      },
    }
  },
})
