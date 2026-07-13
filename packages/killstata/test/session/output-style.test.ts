import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

// 这些断言锁住的是「用户看到什么」的产品决策，不是实现细节：
// 工具调用默认只报告做了什么，代码正文 / diff / 命令输出 / 数据表格都藏在 /details 后面。
const SESSION_VIEW = path.join(process.cwd(), "src", "cli", "cmd", "tui", "routes", "session", "index.tsx")
const DEEPSEEK_PROMPT = path.join(process.cwd(), "src", "session", "prompt", "deepseek.txt")

describe("session output style", () => {
  test("Bash, Write and Edit only expand their full body when details are toggled on", () => {
    const source = fs.readFileSync(SESSION_VIEW, "utf-8")

    // 每个铺开正文的 BlockTool 分支都必须挂在 showDetails 门禁后面。
    expect(source).toContain("<Match when={ctx.showDetails() && props.metadata.output !== undefined}>")
    expect(source).toContain("<Match when={ctx.showDetails() && props.metadata.diagnostics !== undefined}>")
    expect(source).toContain("<Match when={ctx.showDetails() && props.metadata.diff !== undefined}>")

    // 反向断言：不能再出现无门禁的裸展开分支（这正是改造前的写法）。
    expect(source).not.toContain("<Match when={props.metadata.diff !== undefined}>")
    expect(source).not.toContain("<Match when={props.metadata.output !== undefined}>")
  })

  test("tool detail toggles default to off, so a fresh session is quiet", () => {
    const source = fs.readFileSync(SESSION_VIEW, "utf-8")

    expect(source).toContain('kv.signal("tool_details_visibility", false)')
    expect(source).toContain('kv.signal("generic_tool_output_visibility", false)')
  })

  test("the deepseek prompt forbids pasting code and raw data into replies", () => {
    const prompt = fs.readFileSync(DEEPSEEK_PROMPT, "utf-8")

    expect(prompt).toContain("NEVER paste code")
    expect(prompt).toContain("NEVER dump raw data")
    // 并且要给出替代做法：报形状 + 指路径。
    expect(prompt).toContain("Point to artifacts by path")
  })

  test("removed tools leave no renderer behind in the session view", () => {
    const source = fs.readFileSync(SESSION_VIEW, "utf-8")

    for (const dead of ["codesearch", "apply_patch"]) {
      expect(source).not.toContain(dead)
    }
  })
})
