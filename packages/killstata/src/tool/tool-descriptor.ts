import z from "zod"
import { Tool } from "./tool"

export type UnifiedToolEffect = "read_only" | "writes_state" | "writes_files" | "external"
export type UnifiedToolCategory = "system" | "filesystem" | "data" | "diagnostic" | "estimator" | "extension"
export type UnifiedToolExecutor = "typescript" | "python"

export type UnifiedToolPermission = {
  effect: UnifiedToolEffect
  destructive: boolean
  parallel_safe: boolean
  requires_confirmation: boolean
}

export type UnifiedToolDescriptor = {
  tool_id: string
  name: string
  description: string
  input_schema: Record<string, unknown>
  accepted_input_aliases?: string[]
  output_schema: Record<string, unknown>
  permission: UnifiedToolPermission
  category: UnifiedToolCategory
  executor: UnifiedToolExecutor
}

/** 所有 TS 工具通过同一个 Harness envelope 返回；工具自身的业务 metadata 仍由执行端提供。 */
export const TYPESCRIPT_TOOL_OUTPUT_SCHEMA: Record<string, unknown> = Object.freeze({
  ...z.toJSONSchema(Tool.OutputSchema, { unrepresentable: "any" }),
})

function categoryForNamespace(namespace: Tool.ModelNamespace): UnifiedToolCategory {
  if (namespace === "filesystem" || namespace === "search") return "filesystem"
  if (namespace === "data") return "data"
  if (namespace === "econometrics_diagnostic") return "diagnostic"
  if (namespace === "econometrics_estimator") return "estimator"
  if (namespace === "report") return "extension"
  return "system"
}

export function permissionForExecution(execution: Tool.ExecutionPolicy): UnifiedToolPermission {
  const effect: UnifiedToolEffect = execution.readOnly
    ? "read_only"
    : execution.sideEffect === "session"
      ? "writes_state"
      : execution.sideEffect === "filesystem"
        ? "writes_files"
        : "external"
  return {
    effect,
    destructive: false,
    parallel_safe: execution.concurrency === "parallel",
    requires_confirmation: execution.approval === "confirm",
  }
}

export function descriptorForTypeScriptTool(input: {
  toolID: string
  name: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
  modelNamespace: Tool.ModelNamespace
  execution: Tool.ExecutionPolicy
}): UnifiedToolDescriptor {
  return {
    tool_id: input.toolID,
    name: input.name,
    description: input.description,
    input_schema: isRecord(input.inputSchema) ? input.inputSchema : {},
    output_schema: isRecord(input.outputSchema) ? input.outputSchema : TYPESCRIPT_TOOL_OUTPUT_SCHEMA,
    permission: permissionForExecution(input.execution),
    category: categoryForNamespace(input.modelNamespace),
    executor: "typescript",
  }
}

export function descriptorForPythonTool(input: unknown): UnifiedToolDescriptor {
  if (!isRecord(input)) throw new Error("Python 工具描述必须是对象")
  const required = ["tool_id", "name", "description", "input_schema", "output_schema", "permission", "category", "executor"]
  for (const key of required) {
    if (!(key in input)) throw new Error(`Python 工具描述缺少字段：${key}`)
  }
  if (input.executor !== "python") throw new Error("Python 工具描述的 executor 必须为 python")
  if (!isRecord(input.input_schema) || !isRecord(input.output_schema) || !isRecord(input.permission)) {
    throw new Error("Python 工具描述的 Schema 或 permission 格式无效")
  }
  if (input.accepted_input_aliases !== undefined && (!Array.isArray(input.accepted_input_aliases) || input.accepted_input_aliases.some((alias) => typeof alias !== "string"))) {
    throw new Error("Python 工具描述的 accepted_input_aliases 必须是字符串数组")
  }
  return input as unknown as UnifiedToolDescriptor
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
