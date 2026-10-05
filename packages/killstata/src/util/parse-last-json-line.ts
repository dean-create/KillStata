/**
 * 从 Python 后端标准输出中提取最后一行可解析 JSON。
 * @param stdout    后端标准输出
 * @param toolName  工具中文名（用于错误消息）
 * @param exact     true 时要求 stdout 仅包含一行（data-preprocess 等特殊场景）
 */
export function parseLastJsonLine(stdout: string, toolName: string, exact?: boolean): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (exact) {
    if (lines.length !== 1) throw new Error(`${toolName}后端必须只返回一条 JSON 结果`)
    try {
      return JSON.parse(lines[0])
    } catch {
      throw new Error(`${toolName}后端没有返回可解析的 JSON 结果`)
    }
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i])
    } catch {
      continue
    }
  }
  throw new Error(`${toolName}后端没有返回可解析的结果`)
}

/** 取 UTF-16 代理对安全的尾部文本：slice(-N) 可能从多字节字符中间切断，这里去掉孤立的代理对高位。 */
export function tailUtf8(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const tail = text.slice(-maxChars)
  const first = tail.charCodeAt(0)
  if (first >= 0xd800 && first <= 0xdbff) return tail.slice(1)
  return tail
}

/**
 * 后端非零退出错误模板（16 个 *-backend.ts 共用）：退出码 + stderr 尾部 1500 字符。
 * 截断用 tailUtf8 保证不切断多字节字符；判断用原始 stderr（与历史行为一致）。
 */
export function formatBackendExitError(label: string, result: { code: number | null; stderr: string }): string {
  const tail = result.stderr ? tailUtf8(result.stderr.trim(), 1500) : ""
  return `${label} 后端异常退出（代码 ${result.code ?? "未知"}）${tail ? `，stderr：${tail}` : ""}`
}
