import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SessionCompaction } from "../../src/session/compaction"
import { Instance } from "../../src/project/instance"

describe("session.compaction", () => {
  test("builds a fallback summary from recent session context", () => {
    const summary = SessionCompaction.buildFallbackSummary({
      error: "stream disconnected before completion",
      messages: [
        {
          info: { id: "u1", sessionID: "s1", role: "user", time: { created: 1 }, agent: "default", model: { providerID: "openai", modelID: "gpt-5.2" } },
          parts: [{ id: "p1", sessionID: "s1", messageID: "u1", type: "text", text: "Fix compact failures in session summarize.", time: { start: 1, end: 1 } }],
        },
        {
          info: {
            id: "a1",
            sessionID: "s1",
            role: "assistant",
            parentID: "u1",
            mode: "default",
            agent: "default",
            path: { cwd: "d:/repo", root: "d:/repo" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "gpt-5.2",
            providerID: "openai",
            time: { created: 2 },
          },
          parts: [
            { id: "p2", sessionID: "s1", messageID: "a1", type: "text", text: "I traced the issue to compaction using the same streaming path as normal chat.", time: { start: 2, end: 2 } },
            {
              id: "p3",
              sessionID: "s1",
              messageID: "a1",
              type: "tool",
              tool: "grep",
              callID: "call1",
              state: {
                status: "completed",
                input: { pattern: "compact" },
                output: "session/compaction.ts and session/processor.ts are involved.",
                time: { start: 2, end: 2 },
              },
            },
          ],
        },
      ] as any,
    })

    expect(summary).toContain("Generated locally because AI compaction failed")
    expect(summary).toContain("Fix compact failures in session summarize")
    expect(summary).toContain("session/compaction.ts")
    expect(summary).toContain("## Next steps")
  })
})

describe("session.compaction overflow threshold", () => {
  // 注意：预留的输出空间不是模型声明的 output，而是被 OUTPUT_TOKEN_MAX(32K) 钳制后的值。
  // DeepSeek: context 1M => usable = 1M - 32K = 968K，安全线 = 968K * 0.9 ≈ 871K
  const deepseek = { limit: { context: 1_000_000, output: 384_000 } } as any
  // 一个通过 custom 端点接进来的小窗口模型 —— 这才是真正容易撑爆的场景。
  // 预留输出 = min(8K, 32K) = 8K => usable = 128K - 8K = 120K，安全线 = 108K
  const smallModel = { limit: { context: 128_000, output: 8_000 } } as any

  function tokensOf(total: number) {
    return { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as any
  }

  // isOverflow 要读 config（用户可以关掉自动压缩），所以必须在 Instance 上下文里跑。
  async function overflow(tokens: any, model: any) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-compaction-"))
    try {
      return await Instance.provide({
        directory: root,
        fn: () => SessionCompaction.isOverflow({ tokens, model }),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  test("compacts BEFORE the window is actually full, not after", async () => {
    // 900K 仍在 usable(968K) 之内 —— 没有安全余量的旧逻辑不会压缩，下一轮叠上新用户消息、
    // 系统提示、工具 schema 就会顶爆上限，用户看到的是一次硬报错而不是一次压缩。
    expect(await overflow(tokensOf(900_000), deepseek)).toBe(true)
  })

  test("does not compact while there is still real headroom", async () => {
    // 600K 远低于安全线(871K)，此时压缩只会白白丢掉上下文。
    expect(await overflow(tokensOf(600_000), deepseek)).toBe(false)
  })

  test("counts cached and output tokens too, not just input", async () => {
    // 缓存命中的 token 一样占窗口。只看 input 会严重低估真实用量。
    // 400K + 400K(cache) + 120K(output) = 920K > 871K
    const split = { input: 400_000, output: 120_000, reasoning: 0, cache: { read: 400_000, write: 0 } } as any
    expect(await overflow(split, deepseek)).toBe(true)
  })

  test("protects a small custom-endpoint model too (this is where overflow really bites)", async () => {
    // 115K 仍在 usable(120K) 之内，但已越过安全线(108K) —— 必须提前压缩。
    expect(await overflow(tokensOf(115_000), smallModel)).toBe(true)
    expect(await overflow(tokensOf(50_000), smallModel)).toBe(false)
  })

  test("a model that reports no context limit never triggers compaction", async () => {
    const unknown = { limit: { context: 0, output: 0 } } as any
    expect(await overflow(tokensOf(999_999_999), unknown)).toBe(false)
  })
})
