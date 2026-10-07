function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (!isRecord(value)) return []
  return Object.values(value).flatMap(stringsIn)
}

/**
 * 只统计当前 API 请求中由服务端 tool_search 结果明确披露过的完整 Schema。
 * 用户文本、其他工具输出以及仅“加载”但尚未返回给模型的方法均不算已披露。
 */
export function methodSchemaIDsVisibleToModel(messages: unknown): Set<string> {
  const result = new Set<string>()
  if (!Array.isArray(messages)) return result

  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool-result" || part.toolName !== "tool_search") continue
      for (const text of stringsIn(part.output)) {
        let methodID: string | undefined
        let hasCompleteInputSchema = false
        let hasCompleteOutputSchema = false
        for (const line of text.split(/\r?\n/)) {
          const method = /^\s*-\s*方法：([a-zA-Z0-9_-]+)\s*$/.exec(line)
          if (method) {
            methodID = method[1]
            hasCompleteInputSchema = false
            hasCompleteOutputSchema = false
            continue
          }
          const parameters = /^\s*参数 Schema：(.+)$/.exec(line)
          if (methodID && parameters) {
            try {
              hasCompleteInputSchema = isRecord(JSON.parse(parameters[1]!))
            } catch {
              hasCompleteInputSchema = false
            }
            continue
          }
          const outputSchema = /^\s*返回 Schema：(.+)$/.exec(line)
          if (methodID && outputSchema) {
            try {
              hasCompleteOutputSchema = isRecord(JSON.parse(outputSchema[1]!))
            } catch {
              hasCompleteOutputSchema = false
            }
            if (hasCompleteInputSchema && hasCompleteOutputSchema) result.add(methodID)
            methodID = undefined
            hasCompleteInputSchema = false
            hasCompleteOutputSchema = false
          }
        }
      }
    }
  }
  return result
}
