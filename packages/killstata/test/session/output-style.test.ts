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
    // Bash 的正文 key 在 metadata.output，Edit 的在 metadata.diff。
    expect(source).toContain("<Match when={ctx.showDetails() && props.metadata.output !== undefined}>")
    expect(source).toContain("<Match when={ctx.showDetails() && props.metadata.diff !== undefined}>")
    // Write 的详情视图挂在 showDetails 本身（LSP 删除后不再有 diagnostics 门禁，
    // 否则 Write 详情会永不渲染），正文取自 props.input.filePath。
    expect(source).toContain("<Match when={ctx.showDetails()}>")
    expect(source).not.toContain("props.metadata.diagnostics")

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

  test("the prompt never promises a capability the code does not have", () => {
    const prompt = fs.readFileSync(DEEPSEEK_PROMPT, "utf-8")
    const econ = fs.readFileSync(path.join(process.cwd(), "src", "tool", "econometrics.ts"), "utf-8")

    // 每一个 prompt 里点名的估计方法，都必须真实存在于 SUPPORTED_METHODS。
    // 否则模型会拿着一个不存在的方法名去调工具，或者向用户承诺做不到的事。
    // （改造前就踩过：prompt 承诺 DID 交错采纳用 Callaway-Sant'Anna，代码里根本没有这个估计量。）
    const methodsBlock = econ.slice(econ.indexOf("const SUPPORTED_METHODS"))
    const supported = new Set(
      (methodsBlock.slice(0, methodsBlock.indexOf("]")).match(/"[a-z_0-9]+"/g) ?? []).map((m) => m.replace(/"/g, "")),
    )
    expect(supported.size).toBeGreaterThan(10)

    for (const named of prompt.match(/`([a-z_]+_[a-z_0-9]+)`/g) ?? []) {
      const id = named.replace(/`/g, "")
      // 只校验看起来像估计方法的（含下划线且不是工具名/文件名）
      const toolsAndFiles = ["data_import", "experiment_log", "numeric_snapshot", "results_json"]
      if (toolsAndFiles.includes(id) || id.includes(".")) continue
      if (!supported.has(id)) {
        throw new Error(`prompt 点名了一个不存在的方法: ${id}（不在 SUPPORTED_METHODS 里）`)
      }
    }

    // 已删除的产物不该再出现在 prompt 里
    expect(prompt).not.toContain("three_line_table")
    expect(prompt).not.toContain("三线表")
    expect(prompt).not.toContain("Callaway")
  })

  test("the prompt pins a steady, no-filler persona", () => {
    const prompt = fs.readFileSync(DEEPSEEK_PROMPT, "utf-8")

    // 性格必须是可执行的行为准则，不是"沉稳务实"四个空洞的形容词
    expect(prompt).toContain("No preamble")
    expect(prompt).toContain("No exclamation marks")
    expect(prompt).toContain('Say "I don\'t know" when you don\'t know')
    // 编造系数是这里最坏的产出——必须明说
    expect(prompt).toContain("A fabricated coefficient is the worst thing you can produce")
  })

  test("removed tools leave no renderer behind in the session view", () => {
    const source = fs.readFileSync(SESSION_VIEW, "utf-8")

    for (const dead of ["codesearch", "apply_patch"]) {
      expect(source).not.toContain(dead)
    }
  })

  test("hiding tool bodies by default requires a discoverable way to get them back", () => {
    const source = fs.readFileSync(SESSION_VIEW, "utf-8")

    // 收敛输出的前提是逃生门必须存在且好找：/details 斜杠命令。
    // 若有人删掉它，默认隐藏就变成了「用户永远看不到正文」。
    const detailsToggle = source.slice(
      source.indexOf('value: "session.toggle.actions"') - 400,
      source.indexOf('value: "session.toggle.actions"') + 200,
    )
    expect(detailsToggle).toContain('name: "details"')
  })
})
