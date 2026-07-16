import stripAnsi from "strip-ansi"
import fs from "fs"
import path from "path"
import { Redact } from "@/util/redact"

const MAX_LINE_BYTES = 8 * 1024
const REDACTED_MARKER = "[已脱敏]"
const MAX_RECORD_DEPTH = 5
const MAX_RECORD_ENTRIES = 50
const MAX_RECORD_STRING_BYTES = 2 * 1024
const MAX_ERROR_LOG_BYTES = 64 * 1024
const MAX_METADATA_BYTES = 32 * 1024

function shortenUtf8(text: string, maxBytes: number, suffix: string) {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text
  const suffixBytes = Buffer.byteLength(suffix, "utf-8")
  const available = Math.max(1, maxBytes - suffixBytes)
  let preview = Buffer.from(text, "utf-8").subarray(0, available).toString("utf-8")
  if (preview.endsWith("�")) preview = preview.slice(0, -1)
  return `${preview}${suffix}`
}

function hidePrivatePaths(text: string) {
  return text
    .replace(/(["'])(?:\/Users\/|\/home\/).*?\1/g, "$1[本机路径已隐藏]$1")
    .replace(/(["'])[A-Za-z]:\\Users\\.*?\1/g, "$1[本机路径已隐藏]$1")
    .replace(/(["'])(?:(?:\/private)?\/var\/folders\/|\/tmp\/).*?\1/g, "$1[临时路径已隐藏]$1")
    .replace(/(?:\/Users\/|\/home\/)[^:\r\n]*/g, "[本机路径已隐藏]")
    .replace(/[A-Za-z]:\\Users\\[^:\r\n]*/g, "[本机路径已隐藏]")
    .replace(/(?:(?:\/private)?\/var\/folders\/|\/tmp\/)[^:\r\n]*/g, "[临时路径已隐藏]")
}

function redact(text: string, privatePaths = false) {
  const withoutPrivatePaths = privatePaths ? hidePrivatePaths(text) : text
  const redacted = Redact.text(withoutPrivatePaths, Number.MAX_SAFE_INTEGER)
  const redactions = redacted.split("[REDACTED]").length - 1
  return {
    text: redacted.replaceAll("[REDACTED]", REDACTED_MARKER),
    redactions,
  }
}

function stripStackNoise(text: string) {
  const output: string[] = []
  let inPythonTraceback = false

  for (const line of text.split("\n")) {
    if (/^Traceback \(most recent call last\):\s*$/i.test(line.trim())) {
      inPythonTraceback = true
      continue
    }
    if (inPythonTraceback) {
      if (/^\s+File\s+["']/.test(line) || /^\s+/.test(line) || line.trim() === "") continue
      if (/^During handling of the above exception/i.test(line.trim())) continue
      inPythonTraceback = false
    }
    if (/^\s*at\s+\S/.test(line)) continue
    output.push(line)
  }

  return output.join("\n")
}

export function prepareToolOutput(input: string) {
  const normalized = stripAnsi(input).replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  let shortenedLines = 0
  const shortened = normalized.split("\n").map((line) => {
    if (Buffer.byteLength(line, "utf-8") <= MAX_LINE_BYTES) return line
    shortenedLines += 1
    return shortenUtf8(line, MAX_LINE_BYTES, "… [单行已缩短]")
  })
  const redacted = redact(shortened.join("\n"))
  const lines = redacted.text.split("\n")
  const output: string[] = []
  let collapsedLines = 0

  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    let end = index + 1
    while (end < lines.length && lines[end] === line) end += 1
    const repetitions = end - index - 1
    if (line === "") {
      output.push(...Array(Math.min(end - index, 2)).fill(""))
      collapsedLines += Math.max(0, end - index - 2)
    } else {
      output.push(line)
      if (repetitions > 0) {
        output.push(`[相同行重复 ${repetitions} 次，已折叠]`)
        collapsedLines += repetitions
      }
    }
    index = end
  }

  return {
    text: output.join("\n").trimEnd(),
    redactions: redacted.redactions,
    collapsedLines,
    shortenedLines,
  }
}

export function summarizeToolError(error: unknown, maxBytes = 4 * 1024) {
  let raw: string
  if (error instanceof Error) raw = error.message
  else if (typeof error === "string") raw = error
  else {
    try {
      raw = JSON.stringify(error) ?? String(error)
    } catch {
      raw = String(error)
    }
  }
  const normalized = stripAnsi(stripStackNoise(raw)).replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  const privateSafe = redact(normalized, true).text
  const prepared = prepareToolOutput(privateSafe)
  return shortenUtf8(prepared.text, maxBytes, "… [错误摘要已截断]")
}

export function sanitizeToolRecord(value: unknown, key = "", depth = 0): unknown {
  const canonicalKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase()
  const sensitiveField =
    canonicalKey.endsWith("apikey") ||
    canonicalKey.endsWith("password") ||
    canonicalKey.endsWith("passwd") ||
    canonicalKey.endsWith("secret") ||
    canonicalKey.endsWith("token") ||
    canonicalKey.endsWith("authorization") ||
    canonicalKey.endsWith("cookie") ||
    canonicalKey.endsWith("credential") ||
    canonicalKey.endsWith("credentials") ||
    canonicalKey.endsWith("privatekey")
  if (sensitiveField) return REDACTED_MARKER
  if (typeof value === "string") {
    if (canonicalKey === "outputpath" && /(?:^|[\\/])tool-output[\\/]/.test(value)) {
      return prepareToolOutput(value).text
    }
    if (canonicalKey.endsWith("path")) {
      const normalizedPath = value.replaceAll("\\", "/")
      if (normalizedPath.startsWith(".killstata/")) return normalizedPath
      const artifactIndex = normalizedPath.lastIndexOf("/.killstata/")
      if (artifactIndex >= 0) return normalizedPath.slice(artifactIndex + 1)
    }
    return summarizeToolError(value, MAX_RECORD_STRING_BYTES)
  }
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_RECORD_DEPTH) return "[嵌套内容已折叠]"
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_RECORD_ENTRIES)
      .map((item) => sanitizeToolRecord(item, key, depth + 1))
    if (value.length > MAX_RECORD_ENTRIES) items.push(`[其余 ${value.length - MAX_RECORD_ENTRIES} 项已折叠]`)
    return items
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const sanitized = Object.fromEntries(
    entries
      .slice(0, MAX_RECORD_ENTRIES)
      .map(([field, item]) => [field, sanitizeToolRecord(item, field, depth + 1)]),
  )
  if (entries.length > MAX_RECORD_ENTRIES) {
    sanitized._collapsed = `其余 ${entries.length - MAX_RECORD_ENTRIES} 个字段已折叠`
  }
  return sanitized
}

export function prepareToolMetadata(value: unknown, maxBytes = MAX_METADATA_BYTES): Record<string, unknown> {
  const sanitized = sanitizeToolRecord(value)
  const record = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : { value: sanitized }

  let serialized: string
  try {
    serialized = JSON.stringify(record)
  } catch {
    return { metadataTruncated: true, summary: "工具元数据无法序列化，已折叠。" }
  }
  if (Buffer.byteLength(serialized, "utf-8") <= maxBytes) return record

  // 保留顶层标量标识，大型数组/矩阵只留有界摘要。
  const identifiers = Object.fromEntries(
    Object.entries(record)
      .filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item))
      .slice(0, 8),
  )
  const compact = {
    ...identifiers,
    metadataTruncated: true,
    summary: summarizeToolError(serialized, Math.max(1_024, Math.floor(maxBytes / 4))),
  }
  if (Buffer.byteLength(JSON.stringify(compact), "utf-8") <= maxBytes) return compact
  return {
    metadataTruncated: true,
    summary: "工具元数据超过会话安全上限，完整结果请从已产出文件分页读取。",
  }
}

function readBoundedFile(filePath: string, maxBytes: number) {
  const stat = fs.statSync(filePath)
  const fd = fs.openSync(filePath, "r")
  try {
    if (stat.size <= maxBytes) {
      const buffer = Buffer.alloc(stat.size)
      fs.readSync(fd, buffer, 0, buffer.length, 0)
      return { text: buffer.toString("utf-8"), truncated: false }
    }

    const half = Math.floor(maxBytes / 2)
    const head = Buffer.alloc(half)
    const tail = Buffer.alloc(maxBytes - half)
    fs.readSync(fd, head, 0, head.length, 0)
    fs.readSync(fd, tail, 0, tail.length, Math.max(0, stat.size - tail.length))
    return {
      text: `${head.toString("utf-8")}\n… [日志中段已截断] …\n${tail.toString("utf-8")}`,
      truncated: true,
    }
  } finally {
    fs.closeSync(fd)
  }
}

export function sanitizeToolErrorLog(filePath: string, allowedRoot: string) {
  const root = fs.realpathSync(allowedRoot)
  const target = fs.realpathSync(filePath)
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("ERROR_LOG_PATH_DENIED：错误日志不在工具专用目录内。")
  }

  const raw = readBoundedFile(target, MAX_ERROR_LOG_BYTES)
  let payload: unknown
  if (!raw.truncated) {
    try {
      payload = sanitizeToolRecord(JSON.parse(raw.text))
    } catch {
      payload = { error: summarizeToolError(raw.text, 8 * 1024), invalidJson: true }
    }
  } else {
    payload = { error: summarizeToolError(raw.text, 8 * 1024), sourceTruncated: true }
  }

  let output = JSON.stringify(payload, null, 2)
  if (Buffer.byteLength(output, "utf-8") > MAX_ERROR_LOG_BYTES) {
    output = JSON.stringify({ error: summarizeToolError(output, 8 * 1024), sourceTruncated: true }, null, 2)
  }
  fs.writeFileSync(target, output, { encoding: "utf-8", mode: 0o600 })
  fs.chmodSync(target, 0o600)
  return target
}
