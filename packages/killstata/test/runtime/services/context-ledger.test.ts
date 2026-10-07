import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ContextLedger } from "@/runtime/services/context-ledger"

describe("ContextLedger 持久用户消息账本", () => {
  test("按完整 Session 重建、保留重复消息和附件，文件权限为 0600", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-context-ledger-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const repeated = "同一条要求"
          const first = [
            {
              info: { id: "u1", role: "user", time: { created: 1 } },
              parts: [
                { type: "text", text: repeated },
                { type: "file", filename: "did.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", url: "file:///data/did.xlsx" },
              ],
            },
            { info: { id: "u2", role: "user", time: { created: 2 } }, parts: [{ type: "text", text: repeated }] },
          ] as never
          const saved = await ContextLedger.persistUserMessages({
            sessionID: "ses_context_ledger",
            messages: first,
          })
          expect(saved.messageCount).toBe(2)
          expect(saved.reference).toContain(".killstata/context-ledgers/ses_context_ledger/user-messages.md")
          const absolute = path.join(root, saved.reference)
          const content = fs.readFileSync(absolute, "utf-8")
          expect(content.split(repeated)).toHaveLength(3)
          expect(content).toContain("did.xlsx")
          expect(fs.statSync(absolute).mode & 0o777).toBe(0o600)

          const second = [
            ...first,
            { info: { id: "u3", role: "user", time: { created: 3 } }, parts: [{ type: "text", text: "后续新要求" }] },
          ] as never
          const updated = await ContextLedger.persistUserMessages({
            sessionID: "ses_context_ledger",
            messages: second,
          })
          const updatedContent = fs.readFileSync(path.join(root, updated.reference), "utf-8")
          expect(updated.messageCount).toBe(3)
          expect(updatedContent).toContain("[u1]")
          expect(updatedContent).toContain("后续新要求")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("拒绝可逃逸目录的 session ID", async () => {
    await expect(ContextLedger.persistUserMessages({
      sessionID: "../escape",
      messages: [],
    })).rejects.toThrow("CONTEXT_LEDGER_SESSION_ID_INVALID")
  })

  test("拒绝通过符号链接把账本写到工作区外", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-context-ledger-link-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-context-ledger-outside-"))
    try {
      fs.mkdirSync(path.join(root, ".killstata", "context-ledgers"), { recursive: true })
      fs.symlinkSync(outside, path.join(root, ".killstata", "context-ledgers", "ses_link"))
      await expect(Instance.provide({
        directory: root,
        fn: () => ContextLedger.persistUserMessages({
          sessionID: "ses_link",
          messages: [],
        }),
      })).rejects.toThrow("CONTEXT_LEDGER_PATH_ESCAPE")
      expect(fs.existsSync(path.join(outside, "user-messages.md"))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
