import { describe, expect, test } from "bun:test"
import { ContextService } from "@/runtime/services/context-service"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"

describe("context service", () => {
  test("keeps a conversation turn free of progressive workflow context", async () => {
    const messages = [{ info: { role: "user" }, parts: [] }] as never
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-context-service-low-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const result = await ContextService.projectForModel({
            sessionID: "session-context-service-test",
            messages,
            inputIntent: "conversation",
            model: { limit: { context: 128_000, input: 120_000, output: 8_000 } } as never,
          })

          expect(result.messages).toBe(messages)
          expect(result.system).toEqual([])
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("纯对话不注入工作流，但仍经过高压力读时投影", async () => {
    const messages = Array.from({ length: 6 }, (_, index) => [
      {
        info: { id: `u-${index}`, sessionID: "ses-chat", role: "user", time: { created: index * 2 }, agent: "analyst", model: { providerID: "test", modelID: "test" } },
        parts: [{ id: `up-${index}`, messageID: `u-${index}`, sessionID: "ses-chat", type: "text", text: "用户内容".repeat(1_000) }],
      },
      {
        info: { id: `a-${index}`, sessionID: "ses-chat", role: "assistant", parentID: `u-${index}`, mode: "analyst", agent: "analyst", path: { cwd: ".", root: "." }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, modelID: "test", providerID: "test", time: { created: index * 2 + 1, completed: index * 2 + 1 }, finish: "stop" },
        parts: [{ id: `ap-${index}`, messageID: `a-${index}`, sessionID: "ses-chat", type: "text", text: "助手内容".repeat(1_000) }],
      },
    ]).flat() as any[]

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-context-service-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const result = await ContextService.projectForModel({
            sessionID: "ses-chat",
            messages,
            inputIntent: "conversation",
            model: { limit: { context: 18_000, input: 10_000, output: 8_000 } } as never,
            now: 20_000,
          })

          expect(result.system).toEqual([])
          expect(result.projection.actions.length).toBeGreaterThan(0)
          expect(result.messages.length).toBeLessThan(messages.length)
          expect(messages).toHaveLength(12)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("用户关闭 auto compaction 时仍做无损投影，并且不自动进入第五层", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-context-auto-off-"))
    fs.mkdirSync(path.join(root, ".killstata"), { recursive: true })
    fs.writeFileSync(
      path.join(root, ".killstata", "killstata.json"),
      JSON.stringify({ compaction: { auto: false } }),
    )
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const messages = [{
            info: {
              id: "user-large",
              sessionID: "ses-auto-off",
              role: "user",
              time: { created: 1 },
              agent: "analyst",
              model: { providerID: "test", modelID: "test" },
            },
            parts: [{
              id: "part-large",
              messageID: "user-large",
              sessionID: "ses-auto-off",
              type: "text",
              text: "长".repeat(40_000),
            }],
          }] as never
          const result = await ContextService.projectForModel({
            sessionID: "ses-auto-off",
            messages,
            inputIntent: "conversation",
            model: { limit: { context: 25_000, input: 20_000, output: 5_000 } } as never,
          })
          // 小窗口采用自适应压缩缓冲；前四层投影已把消息降到安全线以下时，
          // projection 本身也不再要求第五层摘要，但 auto=false 的不进入语义仍需保留。
          expect(result.projection.summaryRequired).toBe(false)
          expect(result.summaryRequired).toBe(false)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("lets dispatch obtain the model view through the context service", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "dispatch.ts"), "utf-8")
    const queryRuntime = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "query-runtime.ts"), "utf-8")
    const gateway = fs.readFileSync(path.join(process.cwd(), "src", "runtime", "services", "model-gateway.ts"), "utf-8")

    expect(source).toContain('import { ContextService } from "@/runtime/services/context-service"')
    expect(source).toContain("ContextService.projectForModel({")
    expect(source).not.toContain("SessionCompaction.progressiveContext({")
    expect(source).not.toContain("ContextService.isOverflow({")
    expect(source).not.toContain("ContextService.selectTier({")
    expect(source).not.toContain("ContextService.microcompact(")
    expect(queryRuntime).not.toContain("ContextService.isOverflow({")
    expect(gateway).toContain("ContextService.projectFinalModelView({")
    expect(gateway).toContain("autoCompactThreshold(")
    expect(source).not.toContain("SessionCompaction.prune(")
    const compaction = fs.readFileSync(path.join(process.cwd(), "src", "session", "compaction.ts"), "utf-8")
    expect(compaction).not.toContain("export async function prune(")
  })
})
