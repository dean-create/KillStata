import fs from "fs/promises"
import path from "path"
import { Instance } from "@/project/instance"
import type { MessageV2 } from "@/session/message-v2"

function safeSessionID(sessionID: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) {
    throw new Error("CONTEXT_LEDGER_SESSION_ID_INVALID")
  }
  return sessionID
}

function safeAttachmentReference(part: MessageV2.FilePart) {
  const raw = part.source?.type === "file"
    ? part.source.path
    : part.url.startsWith("file://")
      ? decodeURIComponent(new URL(part.url).pathname)
      : undefined
  if (!raw) return part.url.startsWith("data:") ? "[内联数据已省略]" : part.filename ?? "[无引用]"
  const absolute = path.resolve(raw)
  let worktree: string | undefined
  try {
    worktree = Instance.worktree
  } catch {}
  if (worktree) {
    const relative = path.relative(worktree, absolute)
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative
  }
  return `[外部文件:${path.basename(absolute)}]`
}

export namespace ContextLedger {
  export function buildUserMessages(messages: MessageV2.WithParts[]) {
    const sections: string[] = []
    const ordered = [...messages].sort((left, right) => {
      const leftTime = "time" in left.info ? left.info.time.created : 0
      const rightTime = "time" in right.info ? right.info.time.created : 0
      return leftTime - rightTime || left.info.id.localeCompare(right.info.id)
    })
    for (const message of ordered) {
      if (message.info.role !== "user") continue
      const content: string[] = []
      for (const part of message.parts) {
        if (part.type === "text" && !part.synthetic && !part.ignored) {
          content.push(part.text)
        }
        if (part.type === "file") {
          content.push(
            `[附件 filename=${part.filename ?? "unknown"} mime=${part.mime} ref=${safeAttachmentReference(part)}]`,
          )
        }
      }
      if (content.length === 0) continue
      sections.push(`## [${message.info.id}]\n${content.join("\n")}`)
    }
    return {
      content: sections.join("\n\n"),
      messageCount: sections.length,
    }
  }

  export async function persistUserMessages(input: {
    sessionID: string
    messages: MessageV2.WithParts[]
  }) {
    const sessionID = safeSessionID(input.sessionID)
    const ledger = buildUserMessages(input.messages)
    const directory = path.join(Instance.worktree, ".killstata", "context-ledgers", sessionID)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const [realWorktree, realDirectory] = await Promise.all([
      fs.realpath(Instance.worktree),
      fs.realpath(directory),
    ])
    const containment = path.relative(realWorktree, realDirectory)
    if (!containment || containment.startsWith("..") || path.isAbsolute(containment)) {
      throw new Error("CONTEXT_LEDGER_PATH_ESCAPE")
    }
    const filepath = path.join(realDirectory, "user-messages.md")
    const temporary = path.join(realDirectory, `.user-messages.${process.pid}.${Date.now()}.tmp`)
    try {
      await fs.writeFile(temporary, ledger.content, { mode: 0o600 })
      await fs.rename(temporary, filepath)
      await fs.chmod(filepath, 0o600)
    } catch (error) {
      await fs.unlink(temporary).catch(() => {})
      throw new Error(
        `CONTEXT_LEDGER_PERSIST_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return {
      reference: path.join(".killstata", "context-ledgers", sessionID, "user-messages.md"),
      messageCount: ledger.messageCount,
    }
  }
}
