import fs from "fs/promises"
import os from "os"
import path from "path"
import { Agent } from "../../agent/agent"
import { Bus } from "../../bus"
import { ConfigMarkdown } from "../../config/markdown"
import { FileTime } from "../../file/time"
import { Identifier } from "../../id/id"
import { Instance } from "../../project/instance"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { ListTool } from "../../tool/ls"
import { MCP } from "../../mcp"
import { MessageV2 } from "../message-v2"
import { NamedError } from "@killstata/util/error"
import { PermissionNext } from "@/permission/next"
import { PromptInput, log } from "./types"
import { Provider } from "../../provider/provider"
import { ReadTool } from "../../tool/read"
import { Session } from "../session-state"
import { Tool } from "@/tool/tool"
import { fileURLToPath } from "bun"
import { pathToFileURL } from "url"
import { iife } from "@killstata/util/iife"
import { start } from "./queue"
import { emptyToolSet } from "./tools"
import { SessionRetry } from "../retry"
import { isDataFile } from "@/tool/data-file"
import { relativeWithinProject } from "@/tool/analysis-path"

/**
 * 用户消息构建：把 parts（文本 / 文件 / MCP 资源 / 子任务）落成持久化消息，
 * 以及标题生成与模型解析。
 */

const DATA_FILE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/x-stata",
])

type FileInputPart = {
  mime: string
  filename?: string
  url: string
}

function isDataAttachment(part: FileInputPart) {
  return isDataFile(part.filename ?? "") || DATA_FILE_MIMES.has(part.mime)
}

async function materializeInlineDataFile(part: FileInputPart, sessionID: string) {
  const comma = part.url.indexOf(",")
  if (comma < 0) throw new Error("Excel 附件的 data URL 格式无效")

  const header = part.url.slice("data:".length, comma)
  const body = part.url.slice(comma + 1)
  const bytes = header.includes(";base64")
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body), "utf8")
  if (bytes.length === 0) throw new Error("数据附件为空")

  const requestedName = path.basename(part.filename ?? "")
  const fallbackExtension = part.mime === "text/csv" ? ".csv" : part.mime === "application/vnd.ms-excel" ? ".xls" : ".xlsx"
  const safeName = (requestedName || `attachment${fallbackExtension}`).replace(/[^A-Za-z0-9._-]/g, "_")
  const filename = isDataFile(safeName) ? safeName : `${safeName}${fallbackExtension}`
  const directory = path.join(Instance.worktree, ".killstata", "attachments", sessionID)
  await fs.mkdir(directory, { recursive: true })
  const filepath = path.join(directory, `${Identifier.ascending("part")}-${filename}`)
  await fs.writeFile(filepath, bytes, { mode: 0o600 })
  await fs.chmod(filepath, 0o600)
  return filepath
}

export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
  const parts: PromptInput["parts"] = [
    {
      type: "text",
      text: template,
    },
  ]
  const files = ConfigMarkdown.files(template)
  const seen = new Set<string>()
  await Promise.all(
    files.map(async (match) => {
      const name = match[1]
      if (seen.has(name)) return
      seen.add(name)
      const filepath = name.startsWith("~/")
        ? path.join(os.homedir(), name.slice(2))
        : path.resolve(Instance.worktree, name)

      const stats = await fs.stat(filepath).catch(() => undefined)
      if (!stats) {
        const agent = await Agent.get(name)
        if (agent) {
          parts.push({
            type: "agent",
            name: agent.name,
          })
        }
        return
      }

      if (stats.isDirectory()) {
        parts.push({
          type: "file",
          url: `file://${filepath}`,
          filename: name,
          mime: "application/x-directory",
        })
        return
      }

      parts.push({
        type: "file",
        url: `file://${filepath}`,
        filename: name,
        mime: "text/plain",
      })
    }),
  )
  return parts
}

export async function lastModel(sessionID: string) {
  for await (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}

export async function createUserMessage(input: PromptInput) {
  log.info("createUserMessage start", {
    sessionID: input.sessionID,
    messageID: input.messageID,
    partCount: input.parts.length,
  })
  const agent = await Agent.get(input.agent ?? (await Agent.defaultAgent()))
  const info: MessageV2.Info = {
    id: input.messageID ?? Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    time: {
      created: Date.now(),
    },
    tools: input.tools,
    agent: agent.name,
    model: input.model ?? agent.model ?? (await lastModel(input.sessionID)),
    system: input.system,
    variant: input.variant,
  }

  const parts = await Promise.all(
    input.parts.map(async (part): Promise<MessageV2.Part[]> => {
      if (part.type === "file") {
        // before checking the protocol we check if this is an mcp resource because it needs special handling
        if (part.source?.type === "resource") {
          const { clientName, uri } = part.source
          log.info("mcp resource", { clientName, uri, mime: part.mime })

          const pieces: MessageV2.Part[] = [
            {
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: `正在读取 MCP 资源：${part.filename}（${uri}）`,
            },
          ]

          try {
            const resourceContent = await MCP.readResource(clientName, uri)
            if (!resourceContent) {
              throw new Error(`找不到 MCP 资源：${clientName}/${uri}`)
            }

            // Handle different content types
            const contents = Array.isArray(resourceContent.contents)
              ? resourceContent.contents
              : [resourceContent.contents]

            for (const content of contents) {
              if ("text" in content && content.text) {
                pieces.push({
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: content.text as string,
                })
              } else if ("blob" in content && content.blob) {
                // Handle binary content if needed
                const mimeType = "mimeType" in content ? content.mimeType : part.mime
                pieces.push({
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `[二进制内容：${mimeType}]`,
                })
              }
            }

            pieces.push({
              ...part,
              id: part.id ?? Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
            })
          } catch (error: unknown) {
            log.error("failed to read MCP resource", { error, clientName, uri })
            const message = error instanceof Error ? error.message : String(error)
            pieces.push({
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: `读取 MCP 资源 ${part.filename} 失败：${message}`,
            })
          }

          return pieces
        }
        const url = new URL(part.url)
        if (url.protocol === "data:" && isDataAttachment(part)) {
          const filepath = await materializeInlineDataFile(part, input.sessionID)
          const relative = relativeWithinProject(filepath)
          const label = part.filename ?? path.basename(filepath)
          return [
            {
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: `用户附加了需要分析的数据文件：${label}（路径：${relative}）。不要把文件内容直接读入对话；请调用 data_import(action="import", inputPath=${JSON.stringify(relative)})，再根据返回的 datasetId/stageId 继续 数据质量检查、画像和计量分析。`,
            },
            {
              ...part,
              id: part.id ?? Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              url: pathToFileURL(filepath).href,
            },
          ]
        }
        if (url.protocol === "file:") {
          const filepath = fileURLToPath(part.url)
          if (isDataAttachment(part)) {
            const relative = relativeWithinProject(filepath)
            const label = part.filename ?? path.basename(filepath)
            return [
              {
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `用户附加了数据文件 ${label}。在 数据质量检查 和分析前，先调用 data_import，参数为 action="import"、inputPath=${JSON.stringify(relative)}；成功后复用返回的 datasetId/stageId。`,
              },
              {
                ...part,
                id: part.id ?? Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                // Excel/DTA 只保留 file:// 引用；绝不把 workbook bytes 转成 data URL。
                url: pathToFileURL(filepath).href,
              },
            ]
          }
        }
        switch (url.protocol) {
          case "data:":
            if (part.mime === "text/plain") {
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `已按以下参数读取文件：${JSON.stringify({ filePath: part.filename })}`,
                },
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: Buffer.from(part.url, "base64url").toString(),
                },
                {
                  ...part,
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                },
              ]
            }
            break
          case "file:":
            log.info("file", { mime: part.mime })
            // have to normalize, symbol search returns absolute paths
            // Decode the pathname since URL constructor doesn't automatically decode it
            const filepath = fileURLToPath(part.url)
            const stat = await Bun.file(filepath).stat()

            if (stat.isDirectory()) {
              part.mime = "application/x-directory"
            }

            if (part.mime === "text/plain") {
              let offset: number | undefined = undefined
              let limit: number | undefined = undefined
              const range = {
                start: url.searchParams.get("start"),
                end: url.searchParams.get("end"),
              }
              if (range.start != null) {
                let start = parseInt(range.start)
                let end = range.end ? parseInt(range.end) : undefined
                offset = Math.max(start - 1, 0)
                if (end) {
                  limit = end - offset
                }
              }
              const args = { filePath: filepath, offset, limit }

              const pieces: MessageV2.Part[] = [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `已按以下参数读取文件：${JSON.stringify(args)}`,
                },
              ]

              await ReadTool.init()
                .then(async (t) => {
                  const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                  const readCtx: Tool.Context = {
                    sessionID: input.sessionID,
                    abort: new AbortController().signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, model },
                    metadata: async () => {},
                    ask: async () => {},
                  }
                  const result = await t.execute(args, readCtx)
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((attachment) => ({
                        ...attachment,
                        synthetic: true,
                        filename: attachment.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({
                      ...part,
                      id: part.id ?? Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                    })
                  }
                })
                .catch((error) => {
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : error.toString()
                  Bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({
                      message,
                    }).toObject(),
                  })
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `读取文件 ${filepath} 失败：${message}`,
                  })
                })

              return pieces
            }

            if (part.mime === "application/x-directory") {
              const args = { path: filepath }
              const listCtx: Tool.Context = {
                sessionID: input.sessionID,
                abort: new AbortController().signal,
                agent: input.agent!,
                messageID: info.id,
                extra: { bypassCwdCheck: true },
                metadata: async () => {},
                ask: async () => {},
              }
              const result = await ListTool.init().then((t) => t.execute(args, listCtx))
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `已按以下参数列出目录：${JSON.stringify(args)}`,
                },
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: result.output,
                },
                {
                  ...part,
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                },
              ]
            }

            const file = Bun.file(filepath)
            FileTime.read(input.sessionID, filepath)
            return [
              {
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                text: `已按以下参数读取文件：{\"filePath\":\"${filepath}\"}`,
                synthetic: true,
              },
              {
                id: part.id ?? Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "file",
                url: `data:${part.mime};base64,` + Buffer.from(await file.bytes()).toString("base64"),
                mime: part.mime,
                filename: part.filename!,
                source: part.source,
              },
            ]
        }
      }

      if (part.type === "agent") {
        // Check if this agent would be denied by task permission
        const perm = PermissionNext.evaluate("task", part.name, agent.permission)
        const hint = perm.action === "deny" ? "。该子 Agent 由用户显式指定，运行时已确认存在。" : ""
        return [
          {
            id: Identifier.ascending("part"),
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
          {
            id: Identifier.ascending("part"),
            messageID: info.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            text:
              " 请根据上方消息与上下文生成边界明确的子任务提示，并调用 task 工具，subagent_type=" +
              part.name +
              hint,
          },
        ]
      }

      return [
        {
          id: Identifier.ascending("part"),
          ...part,
          messageID: info.id,
          sessionID: input.sessionID,
        },
      ]
    }),
  ).then((x) => x.flat())

  await Session.updateMessage(info)
  log.info("createUserMessage message persisted", {
    sessionID: input.sessionID,
    messageID: info.id,
  })
  for (const part of parts) {
    await Session.updatePart(part)
  }
  log.info("createUserMessage parts persisted", {
    sessionID: input.sessionID,
    messageID: info.id,
    partCount: parts.length,
  })

  return {
    info,
    parts,
  }
}

// 首句生成一次；此后每累计这么多个真实用户问题，在第 N 个问题时重新生成一次标题。
export const TITLE_REGENERATE_INTERVAL = 20

/**
 * 纯决策函数：是否应该（重新）生成标题，以及若是，目标真实用户消息在 history 里的下标。
 * 抽出来是为了不必真的发起模型请求就能对"首句生成一次 + 每 N 问周期重生成 + 手动改名后
 * 永久停止 + 同一计数不重复生成"这套规则做单元测试。
 */
export function shouldGenerateTitle(input: {
  session: Pick<Session.Info, "parentID" | "titleSource" | "titleGeneratedAtCount">
  history: MessageV2.WithParts[]
}): { generate: false } | { generate: true; targetUserIdx: number; questionCount: number } {
  if (input.session.parentID) return { generate: false }
  // 用户手动改过标题后永久停止自动重命名，不覆盖用户主动起的名字。
  if (input.session.titleSource === "manual") return { generate: false }

  // 找出全部非 synthetic 的真实用户消息（按顺序）
  const realUserIndices: number[] = []
  input.history.forEach((m, idx) => {
    if (m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)) {
      realUserIndices.push(idx)
    }
  })
  const questionCount = realUserIndices.length
  if (questionCount === 0) return { generate: false }

  const isFirst = questionCount === 1
  const isPeriodic = questionCount > 1 && questionCount % TITLE_REGENERATE_INTERVAL === 0
  if (!isFirst && !isPeriodic) return { generate: false }
  // 同一个问题计数只生成一次：避免同一条未完成消息被重新处理（如崩溃恢复）时重复触发。
  if (input.session.titleGeneratedAtCount === questionCount) return { generate: false }

  return { generate: true, targetUserIdx: realUserIndices[questionCount - 1], questionCount }
}

export async function ensureTitle(input: {
  session: Session.Info
  history: MessageV2.WithParts[]
  providerID: string
  modelID: string
}) {
  const decision = shouldGenerateTitle(input)
  if (!decision.generate) return
  const { targetUserIdx, questionCount } = decision

  try {
    // Gather all messages up to and including the target real user message for context
    // This includes any shell/subtask executions that preceded that prompt
    const contextMessages = input.history.slice(0, targetUserIdx + 1)
    const targetUser = contextMessages[targetUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = targetUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && targetUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID, input.modelID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    const result = await ModelGateway.stream({
      agent,
      user: targetUser.info as MessageV2.User,
      system: [],
      small: true,
      tools: emptyToolSet(),
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      requestSource: "background",
      retries: SessionRetry.BACKGROUND_MAX_RETRIES,
      messages: [
        {
          role: "user",
          content: "请为以下会话生成中文标题：\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : MessageV2.toModelMessages(contextMessages, model)),
      ],
    })
    const text = await result.text
    if (text)
      return Session.update(
        input.session.id,
        (draft) => {
          const cleaned = text
            .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0)
          if (!cleaned) return

          const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
          draft.title = title
          draft.titleGeneratedAtCount = questionCount
        },
        { touch: false },
      )
  } catch (error) {
    // 标题是后台装饰信息；provider/模型失败不能影响前台分析结果。
    log.error("failed to generate title", { error })
  }
}
