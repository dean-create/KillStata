import { test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

async function createSkill(root: string, relativeDir: string, name: string, description: string, body = "# Test Skill") {
  const skillDir = path.join(root, relativeDir)
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

${body}
`,
  )
}

test("discovers bundled built-in skills on a fresh install", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.some((skill) => skill.name === "tabular-ingest" && skill.source === "builtin")).toBeTrue()
      expect(skills.some((skill) => skill.name === "regression-reporting" && skill.source === "builtin")).toBeTrue()
    },
  })
})

test("discovers project-local skills from .killstata/skill", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await createSkill(dir, ".killstata/skill/shared-skill", "shared-skill", "Project override")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = await Skill.get("shared-skill")
      expect(skill).toBeDefined()
      expect(skill!.source).toBe("project")
      expect(skill!.description).toBe("Project override")
      expect(skill!.location).toContain(path.join(".killstata", "skill", "shared-skill", "SKILL.md"))
    },
  })
})

test("discovers imported skills from ~/.killstata/skill/imported", async () => {
  await using tmp = await tmpdir()

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = path.join(tmp.path, "home")
  await createSkill(process.env.OPENCODE_TEST_HOME!, ".killstata/skill/imported/imported-skill", "imported-skill", "Imported")

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skill = await Skill.get("imported-skill")
        expect(skill).toBeDefined()
        expect(skill!.source).toBe("imported")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

test("doctor reports missing helper file references", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await createSkill(
        dir,
        ".killstata/skill/bad-skill",
        "bad-skill",
        "Broken helper references",
        "# Bad Skill\n\nUse `scripts/missing.py` before running this workflow.",
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const findings = await Skill.doctor()
      expect(findings.some((finding) => finding.skill === "bad-skill" && finding.code === "missing_helper")).toBeTrue()
    },
  })
})
