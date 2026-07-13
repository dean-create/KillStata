import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Skill } from "@/skill"

describe("user skill discovery", () => {
  test("loads skills only from ~/.killstata/skills", async () => {
    const project = path.join(Global.Path.home, "skill-discovery-test")
    const userSkill = path.join(Global.Path.home, ".killstata", "skills", "user-skill", "SKILL.md")
    const claudeSkill = path.join(Global.Path.home, ".claude", "skills", "claude-skill", "SKILL.md")
    const projectSkill = path.join(project, ".killstata", "skills", "project-skill", "SKILL.md")
    const source = (name: string) => `---\nname: ${name}\ndescription: test skill\n---\n\nTest instructions.\n`

    await Promise.all([
      fs.mkdir(path.dirname(userSkill), { recursive: true }),
      fs.mkdir(path.dirname(claudeSkill), { recursive: true }),
      fs.mkdir(path.dirname(projectSkill), { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(userSkill, source("user-skill")),
      fs.writeFile(claudeSkill, source("claude-skill")),
      fs.writeFile(projectSkill, source("project-skill")),
    ])

    try {
      await Instance.provide({
        directory: project,
        fn: async () => {
          await expect(Skill.all()).resolves.toEqual([
            expect.objectContaining({ name: "user-skill", source: "user", location: userSkill }),
          ])
          await Instance.dispose()
        },
      })
    } finally {
      await fs.rm(path.join(Global.Path.home, ".killstata", "skills", "user-skill"), { recursive: true, force: true })
      await fs.rm(path.join(Global.Path.home, ".claude"), { recursive: true, force: true })
      await fs.rm(project, { recursive: true, force: true })
    }
  })
})
