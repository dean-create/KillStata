import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { loadCustomRules } from "@/session/custom-rules"
import { SystemPrompt } from "@/session/system"

let project: string

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-rules-project-"))
  fs.mkdirSync(path.join(project, ".killstata"), { recursive: true })
  fs.writeFileSync(path.join(project, ".killstata", "rules.md"), "旧项目规则，不应读取")
  fs.writeFileSync(path.join(project, ".killstata", "AGENTS.md"), "隐藏项目规则")
  fs.writeFileSync(path.join(project, "AGENTS.md"), "根项目规则")
  fs.writeFileSync(path.join(project, "CONTEXT.md"), "不能被读取")
})

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true })
})

describe("custom rules", () => {
  test("loads only project .killstata/AGENTS.md and root AGENTS.md", async () => {
    const rules = await loadCustomRules({ project })

    expect(rules.map((rule) => rule.path)).toEqual([
      path.join(project, ".killstata", "AGENTS.md"),
      path.join(project, "AGENTS.md"),
    ])
    expect(rules.map((rule) => rule.content)).toEqual(["隐藏项目规则", "根项目规则"])
  })

  test("reads AGENTS.md again for the next conversation instead of caching it", async () => {
    const rulePath = path.join(project, "AGENTS.md")
    fs.writeFileSync(rulePath, "第一版")
    expect((await loadCustomRules({ project })).at(-1)?.content).toBe("第一版")

    fs.writeFileSync(rulePath, "第二版")
    expect((await loadCustomRules({ project })).at(-1)?.content).toBe("第二版")
  })

  test("renders the latest AGENTS.md content into the session system prompt", async () => {
    fs.writeFileSync(path.join(project, ".killstata", "AGENTS.md"), "提示词第一版")
    fs.writeFileSync(path.join(project, "AGENTS.md"), "根规则第一版")

    await Instance.provide({
      directory: project,
      fn: async () => {
        expect((await SystemPrompt.custom()).join("\n")).toContain("提示词第一版")

        fs.writeFileSync(path.join(project, "AGENTS.md"), "根规则第二版")
        const prompt = (await SystemPrompt.custom()).join("\n")
        expect(prompt).toContain("根规则第二版")
        expect(prompt).not.toContain("根规则第一版")
      },
    })
  })

  test("omits an oversized AGENTS.md without dropping the other bounded rule file", async () => {
    fs.writeFileSync(path.join(project, ".killstata", "AGENTS.md"), "x".repeat(32 * 1024 + 1))
    fs.writeFileSync(path.join(project, "AGENTS.md"), "根项目规则")

    const rules = await loadCustomRules({ project })

    expect(rules.map((rule) => rule.path)).toEqual([path.join(project, "AGENTS.md")])
    expect(rules[0]?.content).toBe("根项目规则")
  })
})
