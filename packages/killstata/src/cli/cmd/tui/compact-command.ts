export const COMPACT_INSTRUCTIONS_MAX_CHARS = 4_000

export function parseCompactCommand(input: string):
  | { matched: false }
  | { matched: true; instructions?: string; error?: string } {
  const match = input.match(/^\/(?:compact|summarize)(?:\s+([\s\S]*))?$/i)
  if (!match) return { matched: false }
  const instructions = match[1]?.trim()
  if (!instructions) return { matched: true }
  if (instructions.length > COMPACT_INSTRUCTIONS_MAX_CHARS) {
    return { matched: true, error: `压缩关注指令不能超过 ${COMPACT_INSTRUCTIONS_MAX_CHARS} 个字符。` }
  }
  return { matched: true, instructions }
}
