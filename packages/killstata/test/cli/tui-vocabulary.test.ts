import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

// 内部实现概念不许泄漏到用户界面。
//
// 用户看到「执行者 探索器」「仅修复模式」「阶段 数据导入」时的第一反应是"这些是什么东西"——
// 因为它们是 workflow 状态机和多 agent 架构的内部术语，对做实证研究的人毫无意义。
// 界面只该出现用户的语言：数据、样本、系数、显著性。
const TUI_ROOT = path.join(process.cwd(), "src", "cli", "cmd", "tui")

function readAllTsx(dir: string): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...readAllTsx(p))
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      out.push({ file: path.relative(TUI_ROOT, p), content: fs.readFileSync(p, "utf-8") })
    }
  }
  return out
}

describe("TUI vocabulary", () => {
  test("internal workflow/agent jargon never reaches the screen", () => {
    const banned = [
      "探索器", // explorer agent —— 用户不需要知道我们内部有几个 agent
      "分析器", // analyst agent
      "校验器", // verifier
      "子智能体", // subagent
      "协调器", // coordinator
      "仅修复模式", // repair-only：workflow 状态机内部状态
    ]

    const offenders: string[] = []
    for (const { file, content } of readAllTsx(TUI_ROOT)) {
      for (const word of banned) {
        if (content.includes(word)) offenders.push(`${file}: "${word}"`)
      }
    }

    expect(offenders).toEqual([])
  })

  test("the code-diff sidebar is gone (users here do not edit source files)", () => {
    const sidebar = fs.readFileSync(path.join(TUI_ROOT, "routes", "session", "sidebar.tsx"), "utf-8")

    // "Modified Files" + 增删行数是 OpenCode 的编码功能；做计量分析的用户不改代码。
    expect(sidebar).not.toContain("Modified Files")
    expect(sidebar).not.toContain("session_diff")
  })

  test("the subagent navigation footer is gone (there are no subagents to navigate)", () => {
    expect(fs.existsSync(path.join(TUI_ROOT, "routes", "session", "subagent-footer.tsx"))).toBe(false)

    const session = fs.readFileSync(path.join(TUI_ROOT, "routes", "session", "index.tsx"), "utf-8")
    expect(session).not.toContain("SubagentFooter")
  })
})
