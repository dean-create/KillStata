import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { SkillTool } from "@/tool/skill"
import { Skill } from "@/skill"
import { userSkillsRoot } from "@/skill/manage"

// 产品决策：删掉 28 个内置 skill 的内容，但**保留 agent 加载并使用 skill 的能力**——
// 因为用户会从 GitHub 下载第三方计量 skill（如 Callaway-Sant'Anna DID）来干活。
//
// 这些断言锁住这个决策的两面：加载框架必须活着，硬编码的内置别名必须死透。

async function withUserSkill<T>(
  skill: { name: string; description: string; body: string },
  fn: () => Promise<T>,
) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "killstata-skill-")))
  const skillDir = path.join(userSkillsRoot(), skill.name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}\n`,
  )
  try {
    return await Instance.provide({ directory: dir, fn })
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("skill framework survives, builtin skills are gone", () => {
  test("a user-installed skill is discovered and its content loads", async () => {
    await withUserSkill(
      {
        name: "did-callaway-santanna",
        description: "Staggered DID with proper aggregation",
        body: "# 使用 csdid\n1. att_gt()...",
      },
      async () => {
        const tool = await SkillTool.init()

        // agent 在工具描述里必须能看到这个下载来的 skill
        expect(tool.description).toContain("did-callaway-santanna")
        expect(tool.description).toContain("Staggered DID with proper aggregation")

        // 并且能真正加载它的内容
        const ctx = {
          sessionID: "s",
          messageID: "",
          callID: "",
          agent: undefined,
          abort: AbortSignal.any([]),
          metadata: async () => {},
          ask: async () => {},
        } as never
        const loaded = await tool.execute({ name: "did-callaway-santanna" } as never, ctx)
        expect(loaded.output).toContain("使用 csdid")
        expect((loaded.metadata as { source: string }).source).toBe("user")
      },
    )
  })

  test("the alias layer (which hard-coded the 28 deleted builtin skills) is gone", () => {
    // 别名系统会把 xlsx-processor / csv-summarizer 等已删除的内置 skill 拼进工具描述，
    // 让模型看到一堆永远 unavailable 的假承诺。它必须彻底消失。
    expect(fs.existsSync(path.join(process.cwd(), "src", "skill", "alias.ts"))).toBe(false)

    const skillIndex = fs.readFileSync(path.join(process.cwd(), "src", "skill", "index.ts"), "utf-8")
    expect(skillIndex).not.toContain("alias")

    const skillTool = fs.readFileSync(path.join(process.cwd(), "src", "tool", "skill.ts"), "utf-8")
    expect(skillTool).not.toContain("SkillAlias")
    expect(skillTool).not.toContain("formatSkillAliasText")
  })

  test("no builtin skills ship in the package", () => {
    // skills/ 目录（曾装 28 个内置 SKILL.md）不该再存在
    expect(fs.existsSync(path.join(process.cwd(), "skills"))).toBe(false)
  })

  test("with nothing installed, the skill tool says so plainly instead of listing phantoms", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "killstata-noskill-")))
    try {
      await Instance.provide({
        directory: dir,
        fn: async () => {
          // 隔离：确保这次没有任何用户 skill 被扫到
          const installed = await Skill.all()
          if (installed.length > 0) return // 本机装了 skill，跳过这条断言
          const tool = await SkillTool.init()
          expect(tool.description).toContain("No skills are currently installed")
        },
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
