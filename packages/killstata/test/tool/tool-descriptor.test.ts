import { describe, expect, test } from "bun:test"
import { Tool } from "@/tool/tool"
import { descriptorForPythonTool, descriptorForTypeScriptTool, permissionForExecution, TYPESCRIPT_TOOL_OUTPUT_SCHEMA } from "@/tool/tool-descriptor"

describe("统一工具描述协议", () => {
  test("TypeScript 工具从执行策略生成统一 permission，不重写输入 Schema", () => {
    const inputSchema = { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
    const descriptor = descriptorForTypeScriptTool({
      toolID: "grep",
      name: "搜索文件内容",
      description: "在受控工作区搜索文本。",
      inputSchema,
      modelNamespace: "search",
      execution: Tool.Execution.readOnly,
    })

    expect(descriptor).toEqual({
      tool_id: "grep",
      name: "搜索文件内容",
      description: "在受控工作区搜索文本。",
      input_schema: inputSchema,
      output_schema: TYPESCRIPT_TOOL_OUTPUT_SCHEMA,
      permission: {
        effect: "read_only",
        destructive: false,
        parallel_safe: true,
        requires_confirmation: false,
      },
      category: "filesystem",
      executor: "typescript",
    })
  })

  test("确认型写工具的 permission 由 TS 执行策略生成", () => {
    expect(permissionForExecution(Tool.Execution.protectedFilesystem)).toEqual({
      effect: "writes_files",
      destructive: false,
      parallel_safe: false,
      requires_confirmation: true,
    })
  })

  test("Python 描述原样保留 Schema，不允许缺字段或伪装 executor", () => {
    const descriptor = {
      tool_id: "ols_regression",
      name: "普通最小二乘",
      description: "执行 OLS。",
      input_schema: { type: "object", properties: { dependentVar: { type: "string" } } },
      output_schema: { type: "object", required: ["success"] },
      permission: { effect: "writes_files", destructive: false, parallel_safe: false, requires_confirmation: false },
      category: "estimator",
      executor: "python",
    } as const
    expect(descriptorForPythonTool(descriptor)).toBe(descriptor)
    expect(() => descriptorForPythonTool({ ...descriptor, executor: "typescript" })).toThrow(/executor/)
    expect(() => descriptorForPythonTool({ ...descriptor, input_schema: undefined })).toThrow(/Schema/)
  })
})
