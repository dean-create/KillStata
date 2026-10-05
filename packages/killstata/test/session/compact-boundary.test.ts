import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"

/**
 * compact_boundary 锚点：从最近一次压缩边界之后加载，边界之前的消息不再读盘。
 *
 * 测的是真实读盘行为——建一个"边界前有大量消息"的会话，断言新读法只拿到边界之后的部分，
 * 而磁盘上仍是 append-only 全量（老读法还能看到全部）。
 */

async function withSession<T>(fn: (sessionID: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-boundary-"))
  try {
    return await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        return await fn(session.id)
      },
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function addUser(sessionID: string, text: string, compactionBoundary = false) {
  const msg = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    time: { created: Date.now() },
    agent: "analyst",
    model: { providerID: "test", modelID: "test" },
  } as never)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID,
    ...(compactionBoundary
      ? { type: "compaction", auto: true }
      : { type: "text", text, time: { start: Date.now(), end: Date.now() } }),
  } as never)
  return msg
}

/** 写一条"成功压缩"的 assistant summary，parentID 指向边界那条 user 消息。 */
async function addSummary(sessionID: string, parentID: string) {
  return await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID,
    sessionID,
    mode: "compaction",
    agent: "compaction",
    summary: true,
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test",
    providerID: "test",
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  } as never)
}

describe("compact_boundary 锚点", () => {
  test("只加载边界之后的消息，边界之前不读盘", async () => {
    await withSession(async (sessionID) => {
      // 边界之前：3 条老消息
      await addUser(sessionID, "old-1")
      await addUser(sessionID, "old-2")
      await addUser(sessionID, "old-3")

      // 压缩边界：带 compaction part 的 user 消息 + 指向它的 summary
      const boundary = await addUser(sessionID, "", true)
      await addSummary(sessionID, boundary.id)

      // 边界之后：2 条新消息
      await addUser(sessionID, "new-1")
      await addUser(sessionID, "new-2")

      const bounded = await Array.fromAsync(MessageV2.streamSinceCompactBoundary(sessionID))
      const full = await Array.fromAsync(MessageV2.stream(sessionID))

      // 新读法在边界处停下：不该把 3 条老消息也读出来
      expect(bounded.length).toBeLessThan(full.length)
      const boundedTexts = bounded.flatMap((m) =>
        m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text),
      )
      expect(boundedTexts).toContain("new-2")
      expect(boundedTexts).not.toContain("old-1")

      // 磁盘仍是 append-only 全量：老读法照样能看到全部 7 条
      expect(full.length).toBe(7)
      const fullTexts = full.flatMap((m) =>
        m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text),
      )
      expect(fullTexts).toContain("old-1")
    })
  })

  test("没有压缩边界时读全量（行为与旧实现一致）", async () => {
    await withSession(async (sessionID) => {
      await addUser(sessionID, "a")
      await addUser(sessionID, "b")
      await addUser(sessionID, "c")

      const bounded = await Array.fromAsync(MessageV2.streamSinceCompactBoundary(sessionID))
      const full = await Array.fromAsync(MessageV2.stream(sessionID))
      expect(bounded.length).toBe(full.length)
    })
  })

  test("filterCompacted 接在新读法后面结果不变", async () => {
    await withSession(async (sessionID) => {
      await addUser(sessionID, "old")
      const boundary = await addUser(sessionID, "", true)
      await addSummary(sessionID, boundary.id)
      await addUser(sessionID, "new")

      const viaBounded = await MessageV2.filterCompacted(MessageV2.streamSinceCompactBoundary(sessionID))
      const viaFull = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      // 两条路径给模型看到的消息集合必须一致——新读法只是省了读盘，不改语义
      expect(viaBounded.map((m) => m.info.id)).toEqual(viaFull.map((m) => m.info.id))
    })
  })
})
