const ASSIGNMENT_SECRET_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\b\s*[:=]\s*["']?[^"',\s}]+/gi
const BEARER_SECRET_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_\-]{40,}\b/g

export namespace Redact {
  export function text(input: unknown, maxLength = 2_000) {
    const raw = typeof input === "string" ? input : (JSON.stringify(input) ?? String(input))
    const redacted = raw
      .replace(BEARER_SECRET_PATTERN, "Bearer [REDACTED]")
      .replace(ASSIGNMENT_SECRET_PATTERN, (match, key) => `${key}: [REDACTED]`)
      .replace(LONG_TOKEN_PATTERN, "[REDACTED]")

    if (redacted.length <= maxLength) return redacted
    return `${redacted.slice(0, maxLength)}... [truncated]`
  }
}
