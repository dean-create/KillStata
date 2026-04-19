import { fileURLToPath } from "url"

const LONG_PASTE_MIN_LINES = 3
const LONG_PASTE_MIN_CHARS = 150

export function normalizePastedText(input: { text?: string; bytes?: Uint8Array }) {
  const raw = input.bytes ? new TextDecoder().decode(input.bytes) : (input.text ?? "")
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export function resolvePastedFilePath(input: string) {
  const raw = input.trim().replace(/^['"]+|['"]+$/g, "")
  if (!raw) return ""
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw)
    } catch {
      return raw
    }
  }
  if (process.platform === "win32") return raw.replace(/\\ /g, " ")
  return raw.replace(/\\(.)/g, "$1")
}

export function lineCount(input: string) {
  if (!input) return 0
  return (input.match(/\n/g)?.length ?? 0) + 1
}

export function shouldSummarizePaste(input: string, disablePasteSummary?: boolean) {
  if (disablePasteSummary) return false
  return lineCount(input) >= LONG_PASTE_MIN_LINES || input.length > LONG_PASTE_MIN_CHARS
}

export function pastedTextLabel(input: string) {
  return `[Pasted ~${lineCount(input)} lines]`
}

export function attachmentLabel(input: { mime: string; count: number }) {
  return input.mime === "application/pdf" ? `[PDF ${input.count + 1}]` : `[Image ${input.count + 1}]`
}
