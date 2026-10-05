import { describe, expect, test } from "bun:test"
import { parseCompactCommand } from "@/cli/cmd/tui/compact-command"
import fs from "fs"
import path from "path"

describe("/compact 手动命令", () => {
  test("支持无指令压缩、别名和多行关注指令", () => {
    expect(parseCompactCommand("/compact")).toEqual({ matched: true })
    expect(parseCompactCommand("/summarize 重点保留平行趋势诊断")).toEqual({
      matched: true,
      instructions: "重点保留平行趋势诊断",
    })
    expect(parseCompactCommand("/compact 第一行\n第二行")).toEqual({
      matched: true,
      instructions: "第一行\n第二行",
    })
  })

  test("不吞掉相似普通文本，并限制指令规模", () => {
    expect(parseCompactCommand("/compaction test")).toEqual({ matched: false })
    expect(parseCompactCommand("请 compact 当前内容")).toEqual({ matched: false })
    expect(parseCompactCommand(`/compact ${"长".repeat(4_001)}`)).toEqual({
      matched: true,
      error: "压缩关注指令不能超过 4000 个字符。",
    })
  })

  test("TUI、HTTP 校验与生成 SDK 贯通 instructions 字段", () => {
    const prompt = fs.readFileSync(path.join(process.cwd(), "src", "cli", "cmd", "tui", "component", "prompt", "index.tsx"), "utf-8")
    const route = fs.readFileSync(path.join(process.cwd(), "src", "server", "routes", "session.ts"), "utf-8")
    const sdk = fs.readFileSync(path.join(process.cwd(), "..", "sdk", "js", "src", "v2", "gen", "sdk.gen.ts"), "utf-8")
    expect(prompt).toContain("instructions: compactCommand.instructions")
    expect(route).toContain("instructions: body.instructions")
    expect(route).toContain("自动压缩不接受用户自定义指令")
    expect(sdk).toContain('{ in: "body", key: "instructions" }')
  })
})
