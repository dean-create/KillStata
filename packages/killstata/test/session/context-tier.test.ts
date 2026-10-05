import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { SessionCompaction } from "@/session/compaction"
import { microcompactToolResults } from "@/session/context-projection"
import { Truncate } from "@/tool/truncation"
import type { MessageV2 } from "@/session/message-v2"

/**
 * 分级 context 栈 + 缓存断裂检测。
 * 测的是"什么时候该降级、降到哪一档"以及"清理是否保护了近期上下文"，
 * 不测琐碎的 getter。
 */

function tokens(input: {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}): MessageV2.Assistant["tokens"] {
  return {
    input: input.input ?? 0,
    output: input.output ?? 0,
    reasoning: 0,
    cache: { read: input.cacheRead ?? 0, write: input.cacheWrite ?? 0 },
  }
}

function toolPart(
  id: string,
  output: string,
  options?: { modelOutput?: string; outputReference?: string; tool?: string },
): MessageV2.Part {
  return {
    id,
    messageID: "msg",
    sessionID: "ses",
    type: "tool",
    tool: options?.tool ?? "read",
    callID: id,
    state: {
      status: "completed",
      input: {},
      output,
      modelOutput: options?.modelOutput,
      outputReference: options?.outputReference,
      title: "t",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  } as MessageV2.Part
}

function message(role: "user" | "assistant", parts: MessageV2.Part[]): MessageV2.WithParts {
  return { info: { id: `m-${role}-${parts[0]?.id ?? "x"}`, role }, parts } as MessageV2.WithParts
}

describe("分级 context 栈", () => {
  test("microcompact 只清可重新获取的旧工具结果，并保留最近 5 个", () => {
    const big = "x".repeat(5_000)
    const msgs = [
      message("user", [toolPart("p1", big, { modelOutput: big })]),
      message("assistant", [toolPart("p2", big, { modelOutput: big })]),
      message("user", [toolPart("p3", big, { modelOutput: big })]),
      message("assistant", [toolPart("p4", big, { modelOutput: big })]),
      message("user", [toolPart("p5", big, { modelOutput: big })]),
      message("assistant", [toolPart("p6", big, { modelOutput: big })]),
      message("user", [toolPart("p7", big, { modelOutput: big })]),
    ]

    const result = microcompactToolResults(msgs)

    expect(result.clearedParts).toBeGreaterThan(0)
    expect(result.savedEstimate).toBeGreaterThan(0)

    const stateOf = (m: MessageV2.WithParts) => {
      const part = m.parts[0]
      if (part.type !== "tool" || part.state.status !== "completed") throw new Error("expected completed tool part")
      return part.state.output
    }
    // 最近 5 个可裁剪结果保留。
    for (const index of [2, 3, 4, 5, 6]) expect(stateOf(result.messages[index])).toBe(big)
    // 更早的被替换为中文占位，且占位说明可重新读取。
    expect(stateOf(result.messages[0])).toContain("重新调用该工具")
    expect(stateOf(result.messages[0])).not.toContain("Tool output cleared")

    // 不改原数组（只影响本轮送模型的副本）
    expect(stateOf(msgs[0])).toBe(big)
  })

  test("计量结果和数据工作流状态不属于普通 microcompact 白名单", () => {
    const big = "x".repeat(5_000)
    const protectedTools = [
      "data_import",
      "pipeline",
      "experiment_log",
      "skill",
      "ols_regression",
      "did_static",
      "psm_matching",
    ]
    const msgs = protectedTools.map((tool, index) =>
      message(index % 2 === 0 ? "user" : "assistant", [
        toolPart(`protected-${index}`, big, { modelOutput: big, tool }),
      ])
    )

    const result = microcompactToolResults(msgs)
    expect(result.clearedParts).toBe(0)
    for (const item of result.messages) {
      const part = item.parts[0] as MessageV2.ToolPart
      if (part.state.status !== "completed") throw new Error("expected completed tool")
      expect(part.state.modelOutput).toBe(big)
    }
  })

  test("旧的 tool_search 方法引用可以清理，当前方法实现与分析结果不受影响", () => {
    const big = "方法参数 Schema 内容 ".repeat(1_000)
    const messages = Array.from({ length: 6 }, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", [
        toolPart(`search-${index}`, big, { modelOutput: big, tool: "tool_search" }),
      ])
    )

    const result = microcompactToolResults(messages)
    const first = result.messages[0].parts[0]
    if (first.type !== "tool" || first.state.status !== "completed") throw new Error("expected completed tool part")
    expect(result.clearedParts).toBe(1)
    expect(first.state.modelOutput).toContain("重新调用该工具")
    const latest = result.messages.at(-1)?.parts[0]
    if (latest?.type !== "tool" || latest.state.status !== "completed") throw new Error("expected latest tool part")
    expect(latest.state.modelOutput).toBe(big)
  })

  test("冷缓存时间衰减保留最近 5 个可裁剪结果", () => {
    const big = "x".repeat(5_000)
    const msgs = Array.from({ length: 8 }, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", [
        toolPart(`cold-${index}`, big, { modelOutput: big }),
      ])
    )

    const result = microcompactToolResults(msgs, {
      reason: "time-gap",
      keepRecent: 5,
    })
    expect(result.clearedParts).toBe(3)
  })

  test("小块输出不值得清，保持原样", () => {
    const small = "y".repeat(100)
    const msgs = [
      message("user", [toolPart("p1", small)]),
      message("assistant", [toolPart("p2", small)]),
      message("user", [toolPart("p3", small)]),
      message("assistant", [toolPart("p4", small)]),
    ]
    const result = microcompactToolResults(msgs)
    expect(result.clearedParts).toBe(0)
  })

  test("microcompact 同时收口模型投影，并识别顶层完整输出引用", async () => {
    const full = "完整结果".repeat(2_000)
    const projected = "模型结果".repeat(1_000)
    const reference = await Truncate.persist("完整结果")
    const msgs = [
      message("user", [toolPart("p1", full, { modelOutput: projected, outputReference: reference })]),
      message("assistant", [toolPart("p2", full, { modelOutput: projected })]),
      message("user", [toolPart("p3", full, { modelOutput: projected })]),
      message("assistant", [toolPart("p4", full, { modelOutput: projected })]),
      message("user", [toolPart("p5", full, { modelOutput: projected })]),
      message("assistant", [toolPart("p6", full, { modelOutput: projected })]),
      message("user", [toolPart("p7", full, { modelOutput: projected })]),
    ]

    const result = microcompactToolResults(msgs)
    const first = result.messages[0].parts[0]
    if (first.type !== "tool" || first.state.status !== "completed") throw new Error("expected completed tool part")

    expect(first.state.modelOutput).toContain(reference)
    expect(first.state.modelOutput).not.toContain(projected)
    expect(SessionCompaction.recoveryReferences(result.messages)).toContain(reference)
    expect((msgs[0].parts[0] as MessageV2.ToolPart).state).toMatchObject({ output: full, modelOutput: projected })
  })

  test("progressiveContext 向模型注入中文运行时摘要", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-progressive-context-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const messages = [
            message("user", [
              {
                id: "p-goal",
                messageID: "msg-goal",
                sessionID: "ses-progressive-context",
                type: "text",
                text: "继续分析政策效应",
              } as MessageV2.Part,
            ]),
          ]
          const result = await SessionCompaction.progressiveContext({
            sessionID: "ses-progressive-context",
            messages,
          })
          const system = result.system.join("\n")

          expect(system).toContain("最新目标：继续分析政策效应")
          expect(system).not.toContain("Latest goal:")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("缓存断裂检测", () => {
  test("上轮命中、这轮归零且输入没变小 → 判定断裂", () => {
    expect(
      SessionCompaction.detectCacheBreak({
        previous: tokens({ input: 1_000, cacheRead: 40_000 }),
        current: tokens({ input: 41_000, cacheRead: 0 }),
      }),
    ).toBe(true)
  })

  test("provider 不上报缓存（两轮都是 0）→ 不误报", () => {
    expect(
      SessionCompaction.detectCacheBreak({
        previous: tokens({ input: 40_000, cacheRead: 0 }),
        current: tokens({ input: 41_000, cacheRead: 0 }),
      }),
    ).toBe(false)
  })

  test("输入显著变小（历史被压缩）→ 不算前缀被破坏", () => {
    expect(
      SessionCompaction.detectCacheBreak({
        previous: tokens({ input: 1_000, cacheRead: 40_000 }),
        current: tokens({ input: 5_000, cacheRead: 0 }),
      }),
    ).toBe(false)
  })

  test("这轮仍有缓存命中 → 未断裂", () => {
    expect(
      SessionCompaction.detectCacheBreak({
        previous: tokens({ input: 1_000, cacheRead: 40_000 }),
        current: tokens({ input: 1_000, cacheRead: 38_000 }),
      }),
    ).toBe(false)
  })

  test("首轮无 previous → 不判定", () => {
    expect(
      SessionCompaction.detectCacheBreak({ previous: undefined, current: tokens({ input: 40_000 }) }),
    ).toBe(false)
  })
})
