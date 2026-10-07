import fs from "fs/promises"
import fsSync from "fs"
import path from "path"
import { Global } from "../global"
import { Identifier } from "../id/id"
import type { Agent } from "../agent/agent"
import { Scheduler } from "../scheduler"

export namespace Truncate {
  export const MAX_LINES = 2000
  export const MAX_BYTES = 50 * 1024
  export const DIR = path.join(Global.Path.data, "tool-output")
  export const GLOB = path.join(DIR, "*")
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
  const HOUR_MS = 60 * 60 * 1000

  export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }
  const REFERENCE_PREFIX = "tool-output:"
  const LEGACY_REFERENCE_PREFIX = "tool-output/"

  function outputReferenceID(value: string) {
    // 兼容旧版/模型自行还原出的 `.killstata/workspace/tool-output/tool_x.json` 形态；
    // 实际受管文件仍按无扩展名 ID 存储，扩展名只属于历史展示路径。
    return value.match(/(?:^|[\\/])tool-output(?::|[\\/])(tool_[0-9A-Za-z]+)(?:\.json)?$/)?.[1]
  }

  /** 大块工具输出被卸载到磁盘后留下的引用标记；压缩/历史裁剪据此判断结果还能不能恢复。 */
  export function isOutputReference(value: unknown): value is string {
    return typeof value === "string" && outputReferenceID(value) !== undefined
  }

  export interface Options {
    maxLines?: number
    maxBytes?: number
    direction?: "head" | "tail"
  }

  export function init() {
    Scheduler.register({
      id: "tool.truncation.cleanup",
      interval: HOUR_MS,
      run: cleanup,
      scope: "global",
    })
  }

  export async function cleanup() {
    const cutoff = Identifier.timestamp(Identifier.create("tool", false, Date.now() - RETENTION_MS))
    const glob = new Bun.Glob("tool_*")
    const entries = await Array.fromAsync(glob.scan({ cwd: DIR, onlyFiles: true })).catch(() => [] as string[])
    for (const entry of entries) {
      if (Identifier.timestamp(entry) >= cutoff) continue
      await fs.unlink(path.join(DIR, entry)).catch(() => {})
    }
  }

  export function resolveOutputReference(reference: string) {
    const id = outputReferenceID(reference)
    if (!id) {
      if (reference.includes("tool-output")) {
        throw new Error("TOOL_OUTPUT_REFERENCE_DENIED：分页输出标识不合法。")
      }
      return undefined
    }
    if (!/^tool_[0-9A-Za-z]+$/.test(id)) {
      throw new Error("TOOL_OUTPUT_REFERENCE_DENIED：分页输出标识不合法。")
    }
    return path.join(DIR, id)
  }

  export function referenceExists(reference: string) {
    try {
      const filepath = resolveOutputReference(reference)
      if (!filepath) return false
      return fsSync.existsSync(filepath)
    } catch {
      return false
    }
  }

  /** 从新旧字段中解析唯一的受控输出引用；不会把普通路径误当成恢复凭据。 */
  export function outputReference(...values: unknown[]) {
    return values.find((value): value is string => isOutputReference(value))
  }

  /** 仅返回仍可读取的输出引用，供 Compaction/Snip 生成恢复承诺。 */
  export function liveOutputReference(...values: unknown[]) {
    const reference = outputReference(...values)
    return reference && referenceExists(reference) ? reference : undefined
  }

  /** 将已脱敏的完整工具输出写入受控存储，返回可由 Read 分页读取的稳定引用。 */
  export async function persist(text: string) {
    const id = Identifier.ascending("tool")
    const filepath = path.join(DIR, id)
    await fs.mkdir(DIR, { recursive: true })
    await fs.writeFile(filepath, text, { mode: 0o600 })
    return `${REFERENCE_PREFIX}${id}`
  }

  export async function output(text: string, options: Options = {}, _agent?: Agent.Info): Promise<Result> {
    const maxLines = options.maxLines ?? MAX_LINES
    const maxBytes = options.maxBytes ?? MAX_BYTES
    const direction = options.direction ?? "head"
    const lines = text.split("\n")
    const totalBytes = Buffer.byteLength(text, "utf-8")

    if (lines.length <= maxLines && totalBytes <= maxBytes) {
      return { content: text, truncated: false }
    }

    const out: string[] = []
    let i = 0
    let bytes = 0
    let hitBytes = false

    if (direction === "head") {
      for (i = 0; i < lines.length && i < maxLines; i++) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.push(lines[i])
        bytes += size
      }
    } else {
      for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.unshift(lines[i])
        bytes += size
      }
    }

    const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
    const unit = hitBytes ? "bytes" : "lines"
    const preview = out.join("\n")

    const outputReference = await persist(text)

    const hint = `工具执行成功，但输出过长。完整脱敏输出标识：${outputReference}\n如需查看，请使用 Read 的 offset/limit 分页读取相关片段，不要一次读取整个文件。`
    const message =
      direction === "head"
        ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
        : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`

    return { content: message, truncated: true, outputPath: outputReference }
  }
}
