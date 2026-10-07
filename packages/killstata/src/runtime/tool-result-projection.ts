import { Truncate } from "@/tool/truncation"

export namespace ToolResultProjection {
  export const INLINE_MAX_TOKENS = 2_000
  export const SUMMARY_MAX_TOKENS = 1_500
  export const HARD_BATCH_MAX_TOKENS = 25_000
  export const TOOL_SEARCH_SCHEMA_MAX_INLINE_TOKENS = 40_000
  export const MEDIA_MAX_ATTACHMENTS = 4
  export const MEDIA_MAX_BYTES = 5 * 1024 * 1024
  export const MEDIA_BATCH_MAX_BYTES = 10 * 1024 * 1024
  const MIN_EXTERNALIZED_ITEM_BUDGET = 128
  const MAX_EXTERNALIZED_RESULTS_PER_BATCH = 32

  export function batchBudget(inputBudgetTokens?: number) {
    if (inputBudgetTokens === undefined || !Number.isFinite(inputBudgetTokens)) return HARD_BATCH_MAX_TOKENS
    return Math.min(HARD_BATCH_MAX_TOKENS, Math.max(1, Math.floor(inputBudgetTokens * 0.15)))
  }

  export type Info = {
    mode: "inline" | "enriched" | "externalized" | "bounded_fallback"
    originalTokens: number
    projectedTokens: number
    omittedTokens: number
    outputReference?: string
  }

  const SIGNAL_KEY = /(?:^|\.)(?:status|success|method|datasetId|dataset_id|stageId|stage_id|runId|run_id|branch|activeStage|qaGateStatus|qa_status|rowsUsed|rows_used|row_count|estimate|coefficient|std_error|p_value|r_squared|claim_ceiling|artifactRefs|artifact_refs|outputPath|output_path|resultPath|result_path|checkpointId)$/i
  const SIGNAL_LINE = /(?:^#{1,4}\s|\b(?:error|warn(?:ing)?|failed|failure|blocked|pass|success|estimate|coefficient|p[_ -]?value|std[_ -]?error|r²|r-squared|rows? used|sample|dataset|stage|artifact|checkpoint|next|exit code)\b|(?:下一步|错误|警告|失败|阻断|通过|系数|样本|变量|产物|阶段))/i

  /**
   * Provider 无统一 tokenizer 时使用 UTF-8 字节数作为保守预算单位。
   * 这比字符/4更严格，可覆盖高熵 JSON、路径、代码及 tokenizer 的 byte fallback。
   */
  export function estimateTokens(text: string) {
    return new TextEncoder().encode(text).length
  }

  export function estimateBatch(items: Array<{ content: string }>) {
    return items.reduce((total, item) => total + estimateTokens(item.content), 0)
  }

  function clipTokens(text: string, maxTokens: number, suffix = "\n… [模型上下文投影已省略]") {
    if (estimateTokens(text) <= maxTokens) return text
    if (maxTokens <= 0) return ""
    const suffixTokens = estimateTokens(suffix)
    const effectiveSuffix = suffixTokens < maxTokens ? suffix : ""
    const budget = Math.max(0, maxTokens - estimateTokens(effectiveSuffix))
    const points = Array.from(text)
    let low = 0
    let high = points.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (estimateTokens(points.slice(0, mid).join("")) <= budget) low = mid
      else high = mid - 1
    }
    return `${points.slice(0, low).join("").trimEnd()}${effectiveSuffix}`
  }

  export function boundModelOutput(content: string, maxTokens = INLINE_MAX_TOKENS) {
    return clipTokens(content, maxTokens)
  }

  export type MediaBudget = { remainingBytes: number; remainingAttachments: number }

  export function createMediaBudget(): MediaBudget {
    return { remainingBytes: MEDIA_BATCH_MAX_BYTES, remainingAttachments: MEDIA_MAX_ATTACHMENTS }
  }

  function base64Bytes(url: string) {
    const match = url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/)
    if (!match) return undefined
    const payload = match[2]
    if (payload.length === 0 || payload.length % 4 !== 0) return undefined
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
    return { mime: match[1].toLowerCase(), bytes: Math.max(0, Math.floor(payload.length * 3 / 4) - padding) }
  }

  export function projectMediaAttachments<T extends { mime: string; url: string }>(
    attachments: T[] | undefined,
    capabilities: { image: boolean; pdf: boolean },
    budget: MediaBudget,
  ): { attachments: T[]; notices: string[] } {
    const accepted: T[] = []
    const notices = new Set<string>()
    for (const attachment of attachments ?? []) {
      const parsed = base64Bytes(attachment.url)
      if (!parsed || parsed.mime !== attachment.mime.toLowerCase()) {
        notices.add("有媒体附件格式无效，未发送给模型；完整附件仍保留在 Session。")
        continue
      }
      const supported = parsed.mime.startsWith("image/") ? capabilities.image : parsed.mime === "application/pdf" ? capabilities.pdf : false
      if (!supported) {
        notices.add("当前模型不支持该媒体类型，附件未进入模型上下文。")
        continue
      }
      if (parsed.bytes > MEDIA_MAX_BYTES) {
        notices.add(`媒体附件过大（单项上限 ${MEDIA_MAX_BYTES} 字节），未进入模型上下文。`)
        continue
      }
      if (budget.remainingAttachments <= 0) {
        notices.add(`媒体附件超过数量上限 ${MEDIA_MAX_ATTACHMENTS}，其余附件未进入模型上下文。`)
        continue
      }
      if (parsed.bytes > budget.remainingBytes) {
        notices.add(`媒体附件超过批次总量上限 ${MEDIA_BATCH_MAX_BYTES} 字节，未进入模型上下文。`)
        continue
      }
      budget.remainingAttachments -= 1
      budget.remainingBytes -= parsed.bytes
      accepted.push(attachment)
    }
    return { attachments: accepted, notices: [...notices] }
  }

  function inlineBudget(inputBudgetTokens?: number, maxInlineTokens = INLINE_MAX_TOKENS) {
    if (!inputBudgetTokens || inputBudgetTokens <= 0) return maxInlineTokens
    return Math.max(256, Math.min(maxInlineTokens, Math.floor(inputBudgetTokens * 0.05)))
  }

  function safeEvidence(metadata: Record<string, unknown> | undefined) {
    const values: string[] = []
    const visit = (value: unknown, path: string, depth: number) => {
      if (depth > 4 || value === undefined || value === null || values.length >= 20) return
      if (Array.isArray(value)) {
        if (SIGNAL_KEY.test(path)) {
          for (const item of value.slice(0, 8)) {
            if (["string", "number", "boolean"].includes(typeof item)) values.push(`${path}: ${String(item)}`)
          }
        }
        return
      }
      if (typeof value === "object") {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          visit(nested, path ? `${path}.${key}` : key, depth + 1)
        }
        return
      }
      if (SIGNAL_KEY.test(path)) values.push(`${path}: ${String(value).slice(0, 240)}`)
    }
    visit(metadata, "", 0)
    return [...new Set(values)]
  }

  function jsonSignals(output: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(output)
    } catch {
      return []
    }
    const signals: string[] = []
    const visit = (value: unknown, path: string, depth: number) => {
      if (depth > 6 || value === undefined || value === null || signals.length >= 80) return
      if (Array.isArray(value)) {
        signals.push(`${path || "result"}: [${value.length} items]`)
        if (SIGNAL_KEY.test(path)) {
          for (const item of value.slice(0, 12)) {
            if (["string", "number", "boolean"].includes(typeof item)) signals.push(`${path}: ${String(item)}`)
          }
        }
        for (let index = 0; index < Math.min(2, value.length); index++) {
          visit(value[index], `${path || "result"}[${index}]`, depth + 1)
        }
        return
      }
      if (typeof value === "object") {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          visit(nested, path ? `${path}.${key}` : key, depth + 1)
        }
        return
      }
      if (SIGNAL_KEY.test(path)) signals.push(`${path}: ${String(value).slice(0, 320)}`)
    }
    visit(parsed, "", 0)
    return [...new Set(signals)]
  }

  function textSignals(output: string) {
    const lines = output.split(/\r?\n/)
    const selected = new Set<number>()
    const frequencies = new Map<string, number>()
    for (const line of lines) {
      const key = line.trim()
      if (key) frequencies.set(key, (frequencies.get(key) ?? 0) + 1)
    }
    for (let index = 0; index < Math.min(lines.length, 8); index++) {
      if (lines[index].trim() && (lines[index].length <= 1_000 || SIGNAL_LINE.test(lines[index]))) selected.add(index)
    }
    for (let index = 0; index < lines.length && selected.size < 100; index++) {
      if (SIGNAL_LINE.test(lines[index])) {
        const first = lines.findIndex((line) => line.trim() === lines[index].trim())
        if (first === index) selected.add(index)
      }
      if (lines[index].trimStart().startsWith("|") && /estimate|p[_ -]?value|coefficient|系数/i.test(lines[index])) {
        for (let row = index; row < Math.min(lines.length, index + 5); row++) selected.add(row)
      }
    }
    for (let index = Math.max(0, lines.length - 5); index < lines.length; index++) {
      if (lines[index].trim() && (lines[index].length <= 1_000 || SIGNAL_LINE.test(lines[index]))) selected.add(index)
    }
    return [...selected].sort((a, b) => a - b).map((index) => {
      const count = frequencies.get(lines[index].trim()) ?? 1
      const line = clipTokens(lines[index], 120, "…")
      return count > 1 ? `${line} [重复 ${count} 次]` : line
    })
  }

  function summary(output: string) {
    const json = jsonSignals(output)
    const lines = json.length > 0 ? json : textSignals(output)
    return clipTokens(lines.join("\n"), Math.max(128, SUMMARY_MAX_TOKENS - 180))
  }

  export function emergency(input: {
    toolName: string
    title: string
    output: string
    maxTokens?: number
  }): { content: string; info: Info } {
    const content = clipTokens([
      `## ${input.title || input.toolName}结果摘要`,
      "结果投影无法写入外部文件；完整脱敏输出仍保留在当前 Session。",
      "",
      summary(input.output) || "未提取到可安全概括的字段。",
    ].join("\n"), Math.min(input.maxTokens ?? SUMMARY_MAX_TOKENS, SUMMARY_MAX_TOKENS))
    return {
      content,
      info: {
        mode: "bounded_fallback" as const,
        originalTokens: estimateTokens(input.output),
        projectedTokens: estimateTokens(content),
        omittedTokens: Math.max(0, estimateTokens(input.output) - estimateTokens(content)),
      } satisfies Info,
    }
  }

  /** 旧 Session 没有 modelOutput 时的同步、有界兼容投影；不在重放路径执行磁盘写入。 */
  export function legacy(input: {
    toolName: string
    title?: string
    output: string
    outputReference?: string
  }) {
    const originalTokens = estimateTokens(input.output)
    if (originalTokens <= INLINE_MAX_TOKENS) return input.output
    const reference = input.outputReference
    return clipTokens([
      `## ${input.title || input.toolName}历史结果摘要`,
      reference ? `完整引用：${reference}` : "完整结果保留在 Session；该旧记录没有可分页引用。",
      "",
      summary(input.output) || "未提取到可安全概括的字段。",
    ].join("\n"), SUMMARY_MAX_TOKENS)
  }

  export async function project(input: {
    toolName: string
    title: string
    output: string
    metadata?: Record<string, unknown>
    inputBudgetTokens?: number
    maxInlineTokens?: number
  }): Promise<{ content: string; info: Info }> {
    const originalTokens = estimateTokens(input.output)
    const budget = inlineBudget(input.inputBudgetTokens, input.maxInlineTokens)
    const trimmed = input.output.trim()
    const existingReference = Truncate.liveOutputReference(input.metadata?.outputPath)

    if (!existingReference && originalTokens <= budget && trimmed.length > 32) {
      return {
        content: input.output,
        info: { mode: "inline", originalTokens, projectedTokens: originalTokens, omittedTokens: 0 },
      }
    }

    if (!existingReference && originalTokens <= budget) {
      const evidence = safeEvidence(input.metadata)
      const content = clipTokens([
        `## ${input.title || input.toolName}执行成功`,
        trimmed ? `结果：${trimmed}` : "结果：工具未返回正文。",
        evidence.length ? `\n### 结构化证据\n${evidence.map((item) => `- ${item}`).join("\n")}` : undefined,
        "\n### 下一步\n根据上述状态继续当前计划；若任务需要更多统计细节，请读取该工具生成的结构化产物，不要仅凭“成功”推断结论。",
      ].filter(Boolean).join("\n"), budget)
      return {
        content,
        info: {
          mode: "enriched",
          originalTokens,
          projectedTokens: estimateTokens(content),
          omittedTokens: 0,
        },
      }
    }

    const outputReference = existingReference ?? await Truncate.persist(input.output)
    const key = summary(input.output)
    const content = clipTokens([
      `## ${input.title || input.toolName}结果摘要`,
      `- 状态：工具执行成功，完整脱敏结果已外部化`,
      `- 原始规模：约 ${originalTokens} Token`,
      `- 完整输出引用：${outputReference}`,
      "",
      "### 关键信息",
      key || "未提取到可安全概括的结构化字段。",
      "",
      "### 下一步",
      `需要更多细节时，使用 Read 读取 ${outputReference}，通过 offset/limit 定位相关片段；不要一次读取完整输出。`,
    ].join("\n"), SUMMARY_MAX_TOKENS)
    const projectedTokens = estimateTokens(content)
    return {
      content,
      info: {
        mode: "externalized",
        originalTokens,
        projectedTokens,
        omittedTokens: Math.max(0, originalTokens - projectedTokens),
        outputReference,
      },
    }
  }

  function fitToolSearchSchemas(output: string, maxTokens: number) {
    const lines = output.split(/\r?\n/)
    const starts = lines.flatMap((line, index) => {
      const match = line.match(/^- 方法：([^\s]+)\s*$/)
      return match ? [{ index, methodID: match[1] }] : []
    })
    if (starts.length === 0) return undefined

    const blocks = starts.map((start, index) => {
      const end = starts[index + 1]?.index ?? lines.length
      const rawLines = lines.slice(start.index, end)
      const omissionAt = rawLines.findIndex((line) => line.startsWith("- 其余方法的 Schema 因搜索结果大小上限未展开："))
      const blockLines = omissionAt < 0 ? rawLines : rawLines.slice(0, omissionAt)
      const schemaJSON = (label: string) => {
        const line = blockLines.find((item) => item.trimStart().startsWith(label))
        if (!line) return false
        const text = line.slice(line.indexOf(label) + label.length).trim()
        try {
          const schema = JSON.parse(text)
          return typeof schema === "object" && schema !== null && !Array.isArray(schema)
        } catch {
          return false
        }
      }
      return {
        methodID: start.methodID,
        content: blockLines.join("\n"),
        complete: schemaJSON("参数 Schema：") && schemaJSON("返回 Schema："),
      }
    })
    const knownOmissions = lines
      .filter((line) => line.startsWith("- 其余方法的 Schema 因搜索结果大小上限未展开："))
      .flatMap((line) => line.match(/未展开：([^。]+)/)?.[1]?.split(/[、,，]\s*/) ?? [])
      .filter(Boolean)
    const available = blocks.filter((block) => block.complete)
    const omittedIDs = [...new Set([
      ...blocks.filter((block) => !block.complete).map((block) => block.methodID),
      ...knownOmissions,
    ])]
    const header = lines.slice(0, starts[0].index).find((line) => line.trim()) ?? "工具搜索结果："
    const compose = (selected: typeof available, omitted: string[]) => {
      const parts = [header, ...selected.map((block) => block.content)]
      if (omitted.length) {
        parts.push(
          `- 以下方法的完整 Schema 未向模型披露，不能依据部分说明执行：${omitted.join("、")}。请用精确 methodID 并将 limit 设为 1 重新搜索。`,
        )
      }
      return parts.join("\n")
    }

    const selected: typeof available = []
    const skipped = [...omittedIDs]
    for (const [index, block] of available.entries()) {
      const laterIDs = available.slice(index + 1).map((item) => item.methodID)
      const nextSkipped = [...skipped, ...laterIDs]
      const candidate = compose([...selected, block], nextSkipped)
      if (estimateTokens(candidate) <= maxTokens) {
        selected.push(block)
      } else {
        skipped.push(block.methodID)
      }
    }

    const result = compose(selected, [...new Set(skipped)])
    if (estimateTokens(result) <= maxTokens) return result
    return clipTokens(
      "工具搜索结果预算不足，未向模型完整披露方法 Schema。请缩小搜索范围并使用 limit=1；不要依据不完整 Schema 调用计量工具。",
      maxTokens,
      "",
    )
  }

  function forceFitBatch<T extends { toolName: string; content: string; outputReference?: string; fullOutput?: string }>(
    items: T[],
    maxTokens: number,
  ): T[] {
    if (items.length === 0) return items
    const perItem = Math.max(1, Math.floor((maxTokens - Math.max(0, items.length - 1)) / items.length))
    let result = items.map((item) => {
      const reference = item.outputReference ? `\n引用：${item.outputReference}` : ""
      const label = `${item.toolName}: `
      const available = Math.max(1, perItem - estimateTokens(label + reference))
      return { ...item, content: `${label}${clipTokens(item.content, available, "…")}${reference}` }
    })
    if (estimateBatch(result) <= maxTokens) return result
    let remaining = Math.max(0, maxTokens)
    result = result.map((item) => {
      const marker = item.outputReference ? `引用：${item.outputReference}` : `${item.toolName}: …`
      const content = clipTokens(marker, Math.min(perItem, remaining), "")
      remaining -= estimateTokens(content)
      return { ...item, content }
    })
    if (estimateBatch(result) <= maxTokens) return result
    return result.map((item) => ({ ...item, content: "" }))
  }

  export const emergencyBatch = forceFitBatch

  export async function fitBatch<T extends { toolName: string; content: string; outputReference?: string; fullOutput?: string }>(
    items: T[],
    maxTokens = HARD_BATCH_MAX_TOKENS,
  ): Promise<T[]> {
    if (estimateBatch(items) <= maxTokens) return items
    const perItem = Math.max(0, Math.floor((maxTokens - Math.max(0, items.length - 1)) / Math.max(1, items.length)))
    const boundedItems = items.map((item) => {
      if (item.toolName !== "tool_search") return item
      const itemBudget = Math.max(1, perItem - estimateTokens(`${item.toolName}: `))
      const content = fitToolSearchSchemas(item.content, itemBudget)
      return content === undefined ? item : { ...item, content, outputReference: undefined }
    })
    if (estimateBatch(boundedItems) <= maxTokens) return boundedItems
    // 预算连每项一个保守单位都容不下时，不能为数百个结果制造无意义外部文件；
    // 保留 tool-result 协议项，由 forceFitBatch 将超额正文降为空串。
    if (perItem < MIN_EXTERNALIZED_ITEM_BUDGET) return forceFitBatch(boundedItems, maxTokens)
    const withReferences = await Promise.all(boundedItems.map(async (item, index) => {
      if (item.toolName === "tool_search") return item
      if (estimateTokens(item.content) <= perItem || item.outputReference) return item
      if (index >= MAX_EXTERNALIZED_RESULTS_PER_BATCH) return item
      try {
        return { ...item, outputReference: await Truncate.persist(item.fullOutput ?? item.content) }
      } catch {
        return item
      }
    }))
    return forceFitBatch(withReferences, maxTokens)
  }
}
