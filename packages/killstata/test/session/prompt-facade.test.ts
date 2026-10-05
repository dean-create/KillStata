import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "@/session/prompt"
import { AUTOMATIC_TOOL_REPAIR_LIMIT, shouldAutomaticallyRepairTool } from "@/session/prompt"

/**
 * `session/prompt` 门面的公开 API 契约。
 *
 * 该模块原本是 2204 行的单个 namespace，2026-07-27 拆成 types/intent/queue/message/
 * reminder/tools/dispatch/shell/command 九个子模块。拆分的前提是**公开 API 一个不少、
 * 行为一字不改**，这里把这条契约钉死：往子模块里搬东西时若漏了 re-export，
 * 或误改了 namespace 成员名，测试会立刻变红。
 */

// 拆分前 SessionPrompt 对外暴露的成员（外部 12 个使用点全部落在这个集合里）
const NAMESPACE_MEMBERS = [
  "PromptInput",
  "ShellInput",
  "CommandInput",
  "OUTPUT_TOKEN_MAX",
  "AUTOMATIC_TOOL_REPAIR_LIMIT",
  "shouldAutomaticallyRepairTool",
  "detectInputIntent",
  "assertNotBusy",
  "prompt",
  "loop",
  "cancel",
  "resolvePromptParts",
  "shell",
  "command",
] as const

describe("session/prompt 门面契约", () => {
  test("namespace 暴露拆分前的全部成员", () => {
    for (const name of NAMESPACE_MEMBERS) {
      expect((SessionPrompt as Record<string, unknown>)[name], `SessionPrompt.${name} 缺失`).toBeDefined()
    }
  })

  test("namespace 外的两个具名导出仍可直接 import", () => {
    // revert.ts / task.ts 等按 `import { AUTOMATIC_TOOL_REPAIR_LIMIT } from "./prompt"` 使用
    expect(AUTOMATIC_TOOL_REPAIR_LIMIT).toBe(3)
    expect(shouldAutomaticallyRepairTool(0)).toBe(true)
    expect(shouldAutomaticallyRepairTool(2)).toBe(true)
    expect(shouldAutomaticallyRepairTool(3)).toBe(false)
  })

  test("zod schema 既能当类型也能当值用", () => {
    // PromptInput 等是 `const` + `type` 双声明；跨模块若被误生成 import type，
    // 运行时取值会变成 undefined，这里直接验证值侧可用。
    expect(typeof SessionPrompt.PromptInput.parse).toBe("function")
    expect(typeof SessionPrompt.ShellInput.parse).toBe("function")
    expect(typeof SessionPrompt.CommandInput.parse).toBe("function")
  })

  test("跨模块调用链：intent 判定与拆分前一致", () => {
    const detect = SessionPrompt.detectInputIntent
    // conversation / analysis / ingest 三条主路径各取一例，
    // 详尽的意图用例在 test/session/input-intent.test.ts
    expect(detect([{ type: "text", text: "你好" }] as never)).toBe("conversation")
    expect(detect([{ type: "text", text: "帮我跑一个 OLS 回归" }] as never)).toBe("analysis")
    expect(detect([{ type: "text", text: "检查数据质量" }] as never)).toBe("ingest")
  })
})
