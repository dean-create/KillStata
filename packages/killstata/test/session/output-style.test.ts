import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { TOOL_MANIFEST } from "@/runtime/tool-manifest"
import { SystemPrompt } from "@/session/system"

// 这些断言锁住的是「用户看到什么」的产品决策，不是实现细节：
// 工具调用默认只报告做了什么，代码正文 / diff / 命令输出 / 数据表格都藏在 /details 后面。
const SESSION_VIEW = path.join(process.cwd(), "src", "cli", "cmd", "tui", "routes", "session", "index.tsx")

describe("session output style", () => {
  test("Bash and Write only expand their full body when details are toggled on; Edit stays compact", () => {
    const source = fs.readFileSync(SESSION_VIEW, "utf-8")

    // 每个仍保留正文的 BlockTool 分支都必须挂在 showDetails 门禁后面。
    expect(source).toContain("<Match when={ctx.showDetails() && props.metadata.output !== undefined}>")
    // Write 的详情视图挂在 showDetails 本身（LSP 删除后不再有 diagnostics 门禁，
    // 否则 Write 详情会永不渲染），正文取自 props.input.filePath。
    expect(source).toContain("<Match when={ctx.showDetails()}>")
    expect(source).not.toContain("props.metadata.diagnostics")

    // Diff 已退出产品界面，不能留下任何会话渲染入口。
    expect(source).not.toContain("metadata.diff")
    expect(source).not.toContain("<Match when={props.metadata.output !== undefined}>")
  })

  test("tool detail toggles default to off, so a fresh session is quiet", () => {
    const source = fs.readFileSync(SESSION_VIEW, "utf-8")

    expect(source).toContain('kv.signal("tool_details_visibility", false)')
    expect(source).toContain('kv.signal("generic_tool_output_visibility", false)')
  })

  test("完整提示词禁止向用户倾倒原始数据和内部过程", () => {
    const prompt = SystemPrompt.sections({
      model: { providerID: "deepseek", api: { id: "deepseek-v4-flash" } } as never,
      agent: { name: "analyst" } as never,
    })
      .map((section) => section.content)
      .join("\n")

    expect(prompt).toContain("不粘贴代码、原始数据")
    expect(prompt).toContain("内部工作路径")
  })

  test("每个 Provider 的完整提示词都要求直接、简洁且保留计量交付完整性", () => {
    for (const model of [
      { providerID: "deepseek", api: { id: "deepseek-v4-flash" } },
      { providerID: "custom", api: { id: "qwen3-max" } },
    ]) {
      const prompt = SystemPrompt.sections({ model: model as never, agent: { name: "analyst" } as never })
        .map((section) => section.content)
        .join("\n")
      expect(prompt).toContain("最简单方案")
      expect(prompt).toContain("工具调用之间最多用一句中文说明")
      expect(prompt).toContain("不受机械字数上限限制")
      expect(prompt).toContain("直奔行动或结论")
    }
  })

  test("the prompt never promises a capability the code does not have", () => {
    // 校验的是**渲染后送达模型的完整提示词**，而不是单个 txt 文件：方法论层已从
    // deepseek.txt 抽到 econometrics-context.ts，只扫一个文件会漏掉绝大部分点名。
    const prompt = SystemPrompt.provider({
      providerID: "deepseek",
      api: { id: "deepseek-v4-flash" },
    } as never).join("\n")

    // 真相源是 registry 的注册 ID + 两张准入表，**不是** tool/econometrics.ts 的
    // SUPPORTED_METHODS——后者只是遗留 mega 工具的内部方法列表。像 data_preprocess /
    // composite_evaluation 这类独立 Tool.define + 方法级准入的工具，本来就不在那张表里，
    // 拿它当能力真相源会把真实存在的工具误判成"不存在的方法"。
    const known = new Set(TOOL_MANIFEST.map((entry) => entry.id))
    expect(known.size).toBeGreaterThan(10)

    // 扫所有 snake_case 标识符，不要求反引号包裹：方法论层的工具名是插值进来的
    // （`${T.panelFE}` → panel_fe_regression），渲染后没有反引号。只认反引号的旧写法
    // 在本次分层后实际只能扫到 1 个名字，等于空过。
    const artifacts = new Set([
      "numeric_snapshot",
      "results_json",
      "model_metadata",
      "diagnostics_json",
      // 阶段名与方法/概念名，与工具 ID 同形但不受 registry 约束
      "baseline_estimate",
      "profile_or_schema_check",
      "validate",
      "preprocess_or_filter",
      "profile_or_diagnostics",
      "relative_time",
      "random_effects",
      "fixed_effects",
      "att_gt",
      "first_stage",
      "exit_plan",
      // workflow 工具的只读/查询 action（不是独立工具 ID）
      "rerun_plan",
      "timeline",
      "tools",
      "skills",
      "status",
      "artifacts",
      "export_artifact",
      "doctor",
      "verify",
      "diagnostics",
      "data_path",
      "output_dir",
      "not_in",
      "not_contains",
    ])
    const mentioned = new Set(prompt.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])
    for (const id of mentioned) {
      if (artifacts.has(id) || id.includes(".")) continue
      if (!known.has(id)) {
        throw new Error(`prompt 点名了一个未注册的工具: ${id}（不在 TOOL_MANIFEST 里）`)
      }
    }
    // 断言它确实扫到了东西——否则正则一旦失配，这个测试会静默变成空过。
    expect([...mentioned].filter((id) => known.has(id)).length).toBeGreaterThan(5)

    // 已删除的产物不该再出现在 prompt 里
    expect(prompt).not.toContain("three_line_table")
    expect(prompt).not.toContain("三线表")
    expect(prompt).not.toContain("Callaway")
  })

  test("提示词固定直接、无填充且数字可追溯的表达方式", () => {
    const prompt = SystemPrompt.sections({
      model: { providerID: "deepseek", api: { id: "deepseek-chat" } } as never,
      agent: { name: "analyst" } as never,
    })
      .map((section) => section.content)
      .join("\n")

    expect(prompt).toContain("不复述用户问题")
    expect(prompt).toContain("不展示内部推理")
    expect(prompt).toContain("不得凭记忆计算、补全、改符号或猜测统计数字")

    expect(prompt).toContain("统计数字只来自本轮工具结果")
  })

  test("removed tools leave no renderer behind in the session view", () => {
    const source = fs.readFileSync(SESSION_VIEW, "utf-8")

    for (const dead of ["codesearch", "apply_patch"]) {
      expect(source).not.toContain(dead)
    }
  })

  test("hiding tool bodies by default requires a discoverable way to get them back", () => {
    const source = fs.readFileSync(SESSION_VIEW, "utf-8")

    // 收敛输出的前提是逃生门必须存在且好找：命令面板 + 快捷键（/details 斜杠命令已移除）。
    // 若有人删掉这个 toggle 命令，默认隐藏就变成了「用户永远看不到正文」。
    const detailsToggle = source.slice(
      source.indexOf('value: "session.toggle.actions"') - 400,
      source.indexOf('value: "session.toggle.actions"') + 200,
    )
    expect(detailsToggle).toContain('keybind: "tool_details"')
  })
})
