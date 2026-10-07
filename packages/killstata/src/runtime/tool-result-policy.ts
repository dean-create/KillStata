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

/**
 * 软消费方：从 metadata.result.principle_checks 抽出顶层 advisory。
 * 当 claim_ceiling 不是 "full" 时返回中文短语，模型和人都会看到。
 * 这是 principle_checks 当前唯一的消费方——把"声明上限"从只写 metadata
 * 变成一个可见的、不可忽略的 advis字段。
 */
export function extractClaimCeilingAdvisory(record: unknown): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined
  const result = (record as Record<string, unknown>)["result"]
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined
  const pc = (result as Record<string, unknown>)["principle_checks"]
  if (!pc || typeof pc !== "object" || Array.isArray(pc)) return undefined
  const ceiling = (pc as Record<string, unknown>)["claim_ceiling"]
  if (ceiling === "blocked") {
    const findings = (pc as Record<string, unknown>)["findings"]
    const reason =
      Array.isArray(findings) && findings.length > 0
        ? `（原因：${(findings as string[]).slice(0, 2).join("；")}）`
        : ""
    return `声明上限=blocked：当前结果不应作为因果断言依据${reason}`
  }
  if (ceiling === "restricted") {
    return `声明上限=restricted：结论需降级为"参考性/受限证据"，避免过度因果表述`
  }
  return undefined
}

function shortenUtf8(text: string, maxBytes: number, suffix: string) {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text
  const suffixBytes = Buffer.byteLength(suffix, "utf-8")
  const available = Math.max(1, maxBytes - suffixBytes)
  let preview = Buffer.from(text, "utf-8").subarray(0, available).toString("utf-8")
  if (preview.endsWith("�")) preview = preview.slice(0, -1)
  return `${preview}${suffix}`
}

// 项目根发现。
//
// **不能静态 import Instance**：本模块位于依赖图底层，静态引入 project/instance 会补上一条
// 让既有潜在环变成实际环的边——`Log.create` 在 bus-event 里成了 undefined，整个应用起不来
//（2026-08-08 实测：加了这个 import 后 `bun dev` 直接崩，用户当场撞上）。
// 动态 import 不产生静态环边。**必须在首次真正需要时才触发**，不能放在模块顶层：
// 顶层触发会让任何 import 本模块的进程都把 Instance/Project/Storage 整条图拉起来，
// 时机还不确定——那正是本次事故那条静态边的同类风险。首次调用退回文件系统判据即可。
let instanceModule: typeof import("@/project/instance") | undefined
let instanceRequested = false

function requestInstanceModule() {
  if (instanceModule || instanceRequested) return
  instanceRequested = true
  void import("@/project/instance")
    .then((loaded) => {
      instanceModule = loaded
    })
    .catch(() => {})
}

// 文件系统兜底：与 Project.fromDirectory 同一判据——向上找 `.killstata` 标记目录。
// cwd 进程内不变，只算一次。
let cachedCwdRoots: string[] | undefined

function cwdProjectRoots(): string[] {
  if (cachedCwdRoots) return cachedCwdRoots
  const cwd = process.cwd()
  const roots: string[] = []
  let dir = cwd
  while (true) {
    if (fs.existsSync(path.join(dir, ".killstata"))) {
      roots.push(dir)
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  roots.push(cwd)
  cachedCwdRoots = roots
  return cachedCwdRoots
}

function projectRoots(): string[] {
  requestInstanceModule()
  const roots: string[] = []
  // 项目根在前：它产出的相对路径唯一，且与 artifactRefs 的存储形式一致；
  // 先剥启动目录会把 `packages/killstata/src/x` 截成 `src/x`，反而歧义。
  for (const read of [() => instanceModule?.Instance.worktree, () => instanceModule?.Instance.directory]) {
    try {
      const root = read()
      if (root) roots.push(root)
    } catch {
      // 无 instance context（测试、postTool 之后的异步续体）：交给下面的文件系统兜底。
    }
  }
  roots.push(...cwdProjectRoots())
  return [...new Set(roots.filter((root) => root && root !== "/"))]
}

/**
 * 项目内路径改写成项目相对形式，**不脱敏**。
 *
 * `summarizeToolError` 的输出是喂给模型的（query-runtime 里 `event.error = safeError`），
 * 而原来的规则把所有 `/Users/…` 一律换成 `[本机路径已隐藏]`——**模型连自己刚传进去的路径
 * 都看不见**，自然无法修复。2026-08-08 实测：子 agent 明说 "The list path was masked"，
 * 随后白白耗掉两轮自动修复配额，并开始满文件系统瞎找。
 *
 * 脱敏的目的是不泄漏与项目无关的本机结构，项目内路径不在此列。
 */
export function stripProjectRoots(text: string) {
  let result = text
  for (const root of projectRoots()) {
    result = result.split(`${root}/`).join("").split(root).join(".")
  }
  return result
}

function hidePrivatePaths(text: string) {
  return stripProjectRoots(text)
    .replace(/(["'])(?:\/Users\/|\/home\/).*?\1/g, "$1[本机路径已隐藏]$1")
    .replace(/(["'])[A-Za-z]:\\Users\\.*?\1/g, "$1[本机路径已隐藏]$1")
    .replace(/(["'])(?:(?:\/private)?\/var\/folders\/|\/tmp\/).*?\1/g, "$1[临时路径已隐藏]$1")
    .replace(/(?:\/Users\/|\/home\/)[^:\r\n]*/g, "[本机路径已隐藏]")
    .replace(/[A-Za-z]:\\Users\\[^:\r\n]*/g, "[本机路径已隐藏]")
    .replace(/(?:(?:\/private)?\/var\/folders\/|\/tmp\/)[^:\r\n]*/g, "[临时路径已隐藏]")
}

// 内部产物路径段（如 stage_000_logit_regression_20260816-170300）常年超过
// Redact.LONG_TOKEN_PATTERN 的 40 字符阈值，被当成密钥打码成 [已脱敏]，模型拿着
// 这串路径去 read/list 必然 ENOENT，只能绕行猜测（2026-08-14 与 2026-08-16 两次
// 真实数据实测各命中一次——同一现象、两条独立管线：sanitizeToolRecord（喂 metadata）
// 已经在 2026-08-14 加了保护，但 summarizeToolError（喂错误消息文本，query-runtime
// 里 event.error = safeError 直接喂模型）走的是完全独立的 redact() -> Redact.text()，
// 没有同一份保护——两处各自维护一份判断，一处修了一处没跟上，是本次复发的根因。
// Redact.text 是全仓库通用工具，不该塞进 killstata 的路径概念。改法：调用它之前，
// 往每个 .killstata 路径段里插入零宽字符打断连续 [A-Za-z0-9_-] 序列——
// LONG_TOKEN_PATTERN 天然因词边界被截断而不再匹配，其余脱敏规则（密钥/Bearer token）
// 不受影响；脱敏完成后再把零宽字符去掉，恢复成人类可读的原始路径。
const ZERO_WIDTH_BREAK = "\u200b"

/**
 * \u6253\u65ad\u4e00\u6bb5\u6587\u672c\u91cc\u8fde\u7eed\u7684 [A-Za-z0-9_-] \u5e8f\u5217\uff0c\u8ba9 Redact.LONG_TOKEN_PATTERN
 * \u56e0\u8bcd\u8fb9\u754c\u88ab\u622a\u65ad\u800c\u4e0d\u518d\u8bef\u5224\u6210\u5bc6\u94a5\u3002\u5bfc\u51fa\u4f9b\u5de5\u5177\u81ea\u8eab\u5728\u62fc\u88c5 output \u524d\u4e3b\u52a8\u4fdd\u62a4\u2014\u2014
 * \u6bd4\u5982 ls.ts \u6e32\u67d3 `.killstata` \u76ee\u5f55\u4e0b\u7684\u88f8\u6587\u4ef6\u540d\uff08\u4e0d\u5e26\u8def\u5f84\u524d\u7f00\uff0c
 * breakLongTokensInInternalPaths \u7684 `.killstata` \u951a\u70b9\u5339\u914d\u4e0d\u5230\uff09\u3002
 */
export function shieldFromLongTokenRedaction(text: string): string {
  return text.replace(/(?<=.)(?=.)/g, ZERO_WIDTH_BREAK)
}

function breakLongTokensInInternalPaths(text: string): string {
  return text.replace(/\.killstata(?:[\\/][\w.-]+)*/g, (match) => shieldFromLongTokenRedaction(match))
}

function redact(text: string, privatePaths = false) {
  const withoutPrivatePaths = privatePaths ? hidePrivatePaths(text) : text
  const protectedText = breakLongTokensInInternalPaths(withoutPrivatePaths)
  const redacted = Redact.text(protectedText, Number.MAX_SAFE_INTEGER).replaceAll(ZERO_WIDTH_BREAK, "")
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

  for (let index = 0; index < lines.length; ) {
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
  const normalized = localizeKnownBackendError(
    stripAnsi(stripStackNoise(raw)).replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
  )
  const privateSafe = redact(normalized, true).text
  const prepared = prepareToolOutput(privateSafe)
  return shortenUtf8(prepared.text, maxBytes, "… [错误摘要已截断]")
}

/** 把常见后端术语翻成模型和用户都能直接行动的中文，不改变错误类别。 */
function localizeKnownBackendError(text: string) {
  return text.replace(
    /exog does not have full column rank\.[\s\S]*?check_rank=False\.?/i,
    "模型设计矩阵不满秩，存在完全共线性；不建议关闭秩检查或强行估计。",
  )
}

export function sanitizeToolRecord(value: unknown, key = "", depth = 0): unknown {
  const canonicalKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase()
  // 这些不是认证凭证，而是 Harness 继续执行当前数据阶段所必需的内部引用。
  // 它们不能进入用户可见正文（Desktop/Core 另有显示层过滤），但如果在工具元数据
  // 边界被 Redact 的长 token 规则替换成“[已脱敏]”，workflow 持久化会丢失真相源，
  // 后续 profile/validate/estimate 只能把占位符当 ID，最终形成“导入成功但 OLS 找不到
  // stage”的死循环。保持这些字段原值，安全边界放在展示层而不是工作流状态层。
  const lineageField = new Set(["datasetid", "stageid", "runid", "workflowrunid", "branch"]).has(canonicalKey)
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
  if (lineageField && typeof value === "string") return value
  if (typeof value === "string") {
    if (canonicalKey === "outputpath" && /(?:^|[\\/])tool-output[\\/]/.test(value)) {
      return prepareToolOutput(value).text
    }
    // 内部工作区路径一律原样保留（相对化），不依赖字段名。
    // 此前只有 `*path` 字段受保护：artifactRefs 数组里的元素（key 是 "artifactrefs"，
    // 不以 path 结尾）走了通用脱敏，内部产物目录名如 stage_000_panel_fe_regression_20260814-171259
    // 长 45 字符，被 Redact 的 LONG_TOKEN（≥40 连续串）误当密钥 REDACT 成 [已脱敏]——
    // 模型拿这个路径去 read 必然 ENOENT，只能绕行（2026-08-14 实测：
    // scandir '.killstata/datasets/did_8fa73b03/reports/main/[已脱敏]'）。
    //
    // 判定逻辑内联而非 import analysis-path 的 isInternalWorkspacePath：本文件被
    // util/log.ts 间接依赖、几乎所有模块都在依赖链上，而 analysis-path.ts 顶层静态
    // import 了 project/instance——静态引入会把该依赖链带回本文件，正是 2026-08-08
    // 那次 `bun dev` 循环导入崩溃的同类环（当时是本文件顶层 import Instance）。
    // 正则须与 analysis-path.ts 的 INTERNAL_WORKSPACE_RE 保持一致：内部产物路径
    // 恒以 `.killstata` 作路径段出现，判定不依赖是否恰好被字符串前后缀命中。
    const normalizedPath = value.replaceAll("\\", "/")
    if (/(?:^|\/)\.killstata(?:\/|$)/.test(normalizedPath)) {
      const artifactIndex = normalizedPath.lastIndexOf("/.killstata/")
      if (artifactIndex >= 0) return normalizedPath.slice(artifactIndex + 1)
      const rootIndex = normalizedPath.indexOf(".killstata")
      return rootIndex > 0 ? normalizedPath.slice(rootIndex) : normalizedPath
    }
    return summarizeToolError(value, MAX_RECORD_STRING_BYTES)
  }
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_RECORD_DEPTH) return "[嵌套内容已折叠]"
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_RECORD_ENTRIES).map((item) => sanitizeToolRecord(item, key, depth + 1))
    if (value.length > MAX_RECORD_ENTRIES) items.push(`[其余 ${value.length - MAX_RECORD_ENTRIES} 项已折叠]`)
    return items
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const sanitized = Object.fromEntries(
    entries.slice(0, MAX_RECORD_ENTRIES).map(([field, item]) => [field, sanitizeToolRecord(item, field, depth + 1)]),
  )
  if (entries.length > MAX_RECORD_ENTRIES) {
    sanitized._collapsed = `其余 ${entries.length - MAX_RECORD_ENTRIES} 个字段已折叠`
  }
  return sanitized
}

export function prepareToolMetadata(value: unknown, maxBytes = MAX_METADATA_BYTES): Record<string, unknown> {
  const sanitized = sanitizeToolRecord(value)
  const record =
    sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? (sanitized as Record<string, unknown>)
      : { value: sanitized }

  // 软消费方：把 claim_ceiling 提到顶层，模型与用户都能看到。
  // 这是 principle_checks 当前唯一的消费方——把"声明上限"从只写 metadata
  // 变成一个可见的、不可忽略的 advis字段。
  const advisory = extractClaimCeilingAdvisory(record)
  if (advisory) record["_claimAdvisory"] = advisory

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
