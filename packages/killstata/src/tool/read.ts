import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import { assertExternalDirectory } from "./external-directory"
import { resolveWorkspacePath } from "./analysis-path"
import { createToolDisplay, displayPath } from "./analysis-display"
import { numericSnapshotPreview } from "./analysis-tool-metadata"
import type { NumericSnapshotDocument } from "./analysis-grounding"
import { MessageV2 } from "@/session/message-v2"
import { SessionInstruction } from "@/session/instruction"
import { Truncate } from "./truncation"

const DEFAULT_READ_LIMIT = 2000
const NUMERIC_SNAPSHOT_READ_LIMIT = 300
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
const NUMERIC_SNAPSHOT_MAX_BYTES = 12 * 1024

function isNumericSnapshotPath(filepath: string) {
  return path.basename(filepath).toLowerCase().includes("numeric_snapshot")
}

function isParquetPath(filepath: string) {
  return path.extname(filepath).toLowerCase() === ".parquet"
}

function isBinaryTabularPath(filepath: string) {
  return [".dta", ".xls", ".xlsx"].includes(path.extname(filepath).toLowerCase())
}

// 超过这个大小的 CSV 就不是「一张小结果表」，而是一份数据集了。
const RAW_CSV_READ_LIMIT_BYTES = 256 * 1024

function isCsvPath(filepath: string) {
  return path.extname(filepath).toLowerCase() === ".csv"
}

// killstata 自己产出的 CSV（coefficient_table、inspection 导出等）是结果产物，
// 模型读它们是正当的 —— guidance 里就明确推荐读 inspection CSV。
function isKillstataArtifact(filepath: string) {
  return path.normalize(filepath).includes(`${path.sep}.killstata${path.sep}`)
}

export function buildQualityInspectionReadGuidance() {
  return [
    "当前是只读质量体检任务，导入时已经返回缺失、面板键和异常值的有界摘要。",
    "本次不再读取内部外部化产物，也不启动数据预处理；请直接根据已有摘要给出质量结论。",
    "只有用户明确要求完整报告或原始明细时，才读取相应文件。",
  ].join("\n")
}

type TextWindow = {
  raw: string[]
  totalLines?: number
  hasMoreLines: boolean
  truncatedByBytes: boolean
}

/**
 * 只把请求窗口附近的文本保留在内存中。旧实现先 `file.text()` 再 split，模型输出虽然
 * 有 50 KiB 上限，但 100 MB 日志仍会完整进入 Node/Bun 堆；这里按 UTF-8 chunk 扫描，
 * 对当前窗口之前的行直接丢弃，对超长当前行在达到输出上限后立即停止。
 */
async function readTextWindow(filepath: string, offset: number, limit: number, maxBytes: number): Promise<TextWindow> {
  const stream = fs.createReadStream(filepath, { encoding: "utf8" })
  const raw: string[] = []
  const safeOffset = Math.max(0, offset)
  const safeLimit = Math.max(0, limit)
  let carry = ""
  let lineNumber = 0
  let bytes = 0
  let hasMoreLines = false
  let truncatedByBytes = false
  let stopped = false

  const consumeLine = (line: string) => {
    const current = lineNumber++
    if (current < safeOffset) return false
    if (current >= safeOffset + safeLimit) {
      hasMoreLines = true
      return true
    }

    const visible = line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + "..." : line
    const size = Buffer.byteLength(visible, "utf8") + (raw.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      truncatedByBytes = true
      hasMoreLines = true
      return true
    }
    raw.push(visible)
    bytes += size
    return false
  }

  for await (const chunk of stream) {
    carry += String(chunk)
    while (true) {
      const newline = carry.indexOf("\n")
      if (newline === -1) break
      const line = carry.slice(0, newline)
      carry = carry.slice(newline + 1)
      if (consumeLine(line)) {
        stopped = true
        break
      }
    }
    if (stopped) break

    // A line without a newline must not make the read buffer grow with the file. If it is
    // before the requested offset we only need to find the next newline.
    if (Buffer.byteLength(carry, "utf8") > maxBytes + MAX_LINE_LENGTH * 4) {
      if (lineNumber >= safeOffset) {
        // 该行在窗口内但还没结束就已经撑破缓冲（压缩 JSON、单行 CSV 这类整文件一行的情况）。
        // 必须先把开头按 MAX_LINE_LENGTH 收进窗口再停，否则整行被丢弃、结果为空。
        consumeLine(carry)
        truncatedByBytes = true
        hasMoreLines = true
        stopped = true
        break
      }
      carry = ""
    }
  }

  if (!stopped) {
    // String.split("\\n") treats an empty file and a trailing newline as one final line.
    consumeLine(carry)
  }

  return {
    raw,
    totalLines: stopped ? undefined : lineNumber,
    hasMoreLines,
    truncatedByBytes,
  }
}

export function buildRawCsvReadGuidance(filepath: string, bytes: number) {
  const mb = (bytes / 1024 / 1024).toFixed(1)
  return [
    `拒绝将 ${mb} MB 的原始数据集按文本读取：${filepath}`,
    "这是原始数据而不是分析产物。文本读取只会把一个被截断的任意行切片放入上下文，",
    "基于该切片得出的统计量并不可信。",
    "建议改用：",
    '- 调用 data_import，先 action="import"，再 action="validate" 或 action="profile"',
    "- 读取 numeric_snapshot.json、results.json 或 diagnostics.json 中的可信数值",
    "- 若只需列名和类型，导入摘要已经提供这些信息",
  ].join("\n")
}

export function buildParquetReadGuidance(filepath: string) {
  const normalized = path.normalize(filepath)
  const isCanonicalStage =
    normalized.includes(`${path.sep}.killstata${path.sep}`) &&
    normalized.includes(`${path.sep}datasets${path.sep}`) &&
    normalized.includes(`${path.sep}stages${path.sep}`)

  const headline = isCanonicalStage
    ? `不能将规范 Parquet 数据阶段按文本读取：${filepath}`
    : `不能将 Parquet 文件按文本读取：${filepath}`

  const guidance = isCanonicalStage
    ? [
        "该文件是 KillStata 的规范工作数据集。",
        "不要用 read 工具读取规范 Parquet 数据阶段。",
        "请通过 datasetId/stageId 调用 data_import 或对应的专用估计工具。",
      ]
    : [
        "Parquet 是二进制表格格式，不能作为纯文本读取。",
        "需要分析结果时，不要对 Parquet 数据集使用 read 工具。",
        "先用 data_import 导入数据集，再按研究设计调用相应的专用估计工具。",
      ]

  const alternatives = [
    "可用替代方式：",
    "- inspection CSV/XLSX：查看行级数据",
    "- results.json：查看模型结果",
    "- diagnostics.json：查看质检与诊断",
    "- model_metadata.json：查看模型设定元数据",
    "- numeric_snapshot.json：引用可信统计量",
  ]

  return [headline, ...guidance, ...alternatives].join("\n")
}

export function buildBinaryTabularReadGuidance(filepath: string) {
  const ext = path.extname(filepath).toLowerCase()
  const label =
    ext === ".dta" ? "Stata 数据集" : ext === ".xlsx" || ext === ".xls" ? "Excel 工作簿" : "二进制数据文件"
  return [
    `不能将${label}按文本读取：${filepath}`,
    `${label}是结构化二进制格式，不应通过 read 工具作为纯文本打开。`,
    "可用替代方式：",
    '- 用 data_import 的 action="import" 导入分析数据',
    "- 使用导出的 inspection CSV/XLSX 查看行级数据",
    "- 使用 results.json、diagnostics.json、model_metadata.json 或 numeric_snapshot.json 获取结构化结果",
  ].join("\n")
}

export const ReadTool = Tool.define("read", Tool.Execution.readOnly, ToolModel.forTool("read"), {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().trim().min(1, "文件路径不能为空").describe("要读取的文件路径"),
    offset: z.coerce.number().describe("开始读取的行号，从 0 开始").optional(),
    limit: z.coerce.number().describe("要读取的行数，默认 2000").optional(),
  }),
  async execute(params, ctx) {
    const outputReferencePath = Truncate.resolveOutputReference(params.filePath)
    const filepath = outputReferencePath ?? resolveWorkspacePath(params.filePath)
    const title = path.relative(Instance.worktree, filepath)

    if (ctx.extra?.qualityInspectionOnly === true && (Boolean(outputReferencePath) || isKillstataArtifact(filepath))) {
      return {
        title: "质量体检摘要已足够",
        output: buildQualityInspectionReadGuidance(),
        metadata: {
          qualityInspectionReadBlocked: true,
          display: createToolDisplay({
            summary: "质量体检使用已有摘要",
            details: ["当前质量任务不读取内部外部化产物。"],
            visibility: "user_collapsed",
          }),
        },
      }
    }

    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(outputReferencePath) || Boolean(ctx.extra?.["bypassCwdCheck"]),
    })

    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    const file = Bun.file(filepath)
    if (fs.existsSync(filepath) && fs.statSync(filepath).isDirectory()) {
      return {
        title: "目录路径",
        output: [
          `这是目录而不是文件：${filepath}`,
          "请使用 list 工具查看目录内容；如果要读取具体结果，请先定位一个文件路径。",
          "不要把目录路径重复传给 read。",
        ].join("\n"),
        metadata: {
          directory: true,
          display: createToolDisplay({
            summary: "目录路径，请改用 list",
            details: ["read 只读取文件；目录内容使用 list 工具。"],
            visibility: "user_collapsed",
          }),
        },
      }
    }
    if (!(await file.exists())) {
      if (outputReferencePath) {
        return {
          title: "分页输出引用不可用",
          output: [
            "分页输出引用已失效或已被清理，本次没有读取到原始内容。",
            "请改用当前会话中对应的 results.json、coefficients.csv 或 numeric_snapshot.json；如果仍需要完整工具输出，请重新执行产生该输出的动作。",
            "不要继续猜测或重复读取这个 tool-output 引用。",
          ].join("\n"),
          metadata: {
            outputReferenceExpired: true,
            display: createToolDisplay({
              summary: "分页输出引用已失效",
              details: ["未读取到内部工具输出；请使用当前结果产物。"],
              visibility: "user_collapsed",
            }),
          },
        }
      }
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      // 把绝对路径转成 workspace 相对路径，绕过 tool-result-policy 把 /Users/... 替换成
      // [本机路径已隐藏] 的机制——模型需要看到路径才能帮用户排查问题
      const relativePath = path.relative(Instance.directory, filepath)

      const dirEntries = fs.readdirSync(dir)
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.relative(Instance.directory, path.join(dir, entry)))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`找不到文件：${relativePath}\n\n可能是以下路径：\n${suggestions.join("\n")}`)
      }

      throw new Error(`找不到文件：${relativePath}`)
    }

    // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
    const isImage =
      file.type.startsWith("image/") && file.type !== "image/svg+xml" && file.type !== "image/vnd.fastbidsheet"
    const isPdf = file.type === "application/pdf"
    if (isImage || isPdf) {
      const mime = file.type
      const msg = `${isImage ? "Image" : "PDF"} read successfully`
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
          loaded: [] as string[],
          numericSnapshotPreview: undefined as ReturnType<typeof numericSnapshotPreview> | undefined,
          display: createToolDisplay({
            summary: `Read ${displayPath(filepath, "name")}`,
            details: [`Source: ${displayPath(filepath)}`],
            visibility: "user_collapsed",
          }),
        },
        attachments: [
          {
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(await file.bytes()).toString("base64")}`,
          },
        ],
      }
    }

    if (isParquetPath(filepath)) {
      throw new Error(buildParquetReadGuidance(filepath))
    }

    if (isBinaryTabularPath(filepath)) {
      return {
        title,
        metadata: {
          preview: undefined,
          truncated: undefined,
          loaded: [],
          numericSnapshotPreview: undefined,
          display: createToolDisplay({
            summary: `Binary file: ${displayPath(filepath, "name")} — use data_import`,
            details: ["Binary tabular file — imported via data_import instead"],
            artifacts: [],
          }),
        } as Record<string, unknown>,
        output: buildBinaryTabularReadGuidance(filepath),
        attachments: [],
      }
    }

    // CSV 是纯文本，所以上面的二进制拦截拦不住它 —— 但一份几 MB 的原始 CSV 被当文本读进来，
    // 危害不在于撑爆窗口（有截断兜底），而在于模型会拿到几千行**被截断过的**数据，
    // 然后对着这个任意切片心算统计量，绕过 data_import 的 grounding 链路。
    // 我们自己产出的结果表（.killstata/ 下）不在此限。
    if (isCsvPath(filepath) && !isKillstataArtifact(filepath) && file.size > RAW_CSV_READ_LIMIT_BYTES) {
      // 这是只读工具的安全引导，不是业务失败：如果抛异常，模型/驱动器会把它当成
      // 需要修复的工具错误，用户只会看到一条红色失败记录。返回结构化 guidance，
      // 既阻止截断 CSV 进入上下文，也让模型可以无噪声地改用 data_import。
      const guidance = buildRawCsvReadGuidance(filepath, file.size)
      return {
        title: "原始数据需通过导入",
        output: guidance,
        metadata: {
          rawDatasetReadBlocked: true,
          display: createToolDisplay({
            summary: "原始 CSV 请使用 data_import",
            details: ["未读取截断的原始数据；请使用 data_import 导入并检查。"],
            visibility: "user_collapsed",
          }),
        },
      }
    }

    const isBinary = await isBinaryFile(filepath, file)
    if (isBinary) throw new Error(`read 不支持直接读取二进制文件：${filepath}`)

    const sessionMessages = await MessageV2.filterCompacted(
      MessageV2.streamSinceCompactBoundary(ctx.sessionID),
    ).catch(() => [])
    const loaded = await SessionInstruction.resolve(sessionMessages, filepath, ctx.messageID).catch(() => [])

    const numericSnapshot = isNumericSnapshotPath(filepath)
    const limit = params.limit ?? (numericSnapshot ? NUMERIC_SNAPSHOT_READ_LIMIT : DEFAULT_READ_LIMIT)
    const offset = params.offset || 0
    const maxBytes = numericSnapshot ? NUMERIC_SNAPSHOT_MAX_BYTES : MAX_BYTES
    const window = await readTextWindow(filepath, offset, limit, maxBytes)
    const raw = window.raw
    const numericText = numericSnapshot && file.size <= maxBytes ? await file.text() : undefined
    const parsedNumericSnapshot = numericText ? parseNumericSnapshot(numericText) : undefined
    const truncatedByBytes = window.truncatedByBytes

    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = "<file>\n"
    output += content.join("\n")

    const totalLines = window.totalLines
    const lastReadLine = offset + raw.length
    const hasMoreLines = window.hasMoreLines || totalLines === undefined
    const truncated = hasMoreLines || truncatedByBytes

    if (truncatedByBytes) {
      output += `\n\n(Output truncated at ${maxBytes} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines ?? "unknown"} lines)`
    }
    if (numericSnapshot && params.limit === undefined) {
      output +=
        "\n(Numeric snapshot files default to a smaller preview window. Use offset/limit to inspect only the needed metrics.)"
    }
    output += "\n</file>"

    if (loaded.length > 0) {
      output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
    }

    FileTime.read(ctx.sessionID, filepath)

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
        loaded: loaded.map((item) => item.filepath),
        numericSnapshotPreview: parsedNumericSnapshot ? numericSnapshotPreview(parsedNumericSnapshot) : undefined,
        display: createToolDisplay({
          summary: `Read ${displayPath(filepath, "name")}`,
          details: [
            `Source: ${displayPath(filepath)}`,
            `Lines returned: ${raw.length}`,
            truncated ? "Result truncated" : `Complete file preview (${totalLines ?? "unknown"} lines)`,
            parsedNumericSnapshot ? `Numeric snapshot entries: ${parsedNumericSnapshot.entries.length}` : undefined,
          ],
          artifacts: [
            {
              label: "source",
              path: filepath,
              visibility: "user_collapsed",
            },
          ],
          visibility: "user_collapsed",
        }),
      },
    }
  },
})

async function isBinaryFile(filepath: string, file: Bun.BunFile): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".dta":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  const stat = await file.stat()
  const fileSize = stat.size
  if (fileSize === 0) return false

  const bufferSize = Math.min(4096, fileSize)
  const buffer = await file.slice(0, bufferSize).arrayBuffer()
  if (buffer.byteLength === 0) return false
  const bytes = new Uint8Array(buffer)

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}

function parseNumericSnapshot(text: string) {
  try {
    const parsed = JSON.parse(text) as NumericSnapshotDocument
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
      return parsed
    }
  } catch {}
  return undefined
}
