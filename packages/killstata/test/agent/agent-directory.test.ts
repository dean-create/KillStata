/**
 * 自定义 subagent 目录加载验收：.killstata/agent/*.md（frontmatter + prompt body）
 * 经 config.ts loadAgent 进入 Agent 注册表，TaskTool 可通过 subagent_type 调用。
 */
import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Agent } from "@/agent/agent"
import { Instance } from "@/project/instance"

describe("自定义 agent 目录加载", () => {
  test(".killstata/agent/*.md 被解析进 Agent 注册表", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-agent-home-"))
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-agent-project-"))
    const previousTestHome = process.env.KILLSTATA_TEST_HOME
    process.env.KILLSTATA_TEST_HOME = home

    const agentDir = path.join(home, ".killstata", "agent")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "custom-explorer.md"),
      [
        "---",
        "name: custom-explorer",
        "description: 自定义探索子 agent（验收用）",
        "mode: subagent",
        "model: deepseek/deepseek-v4-flash",
        "---",
        "",
        "你是自定义探索子 agent，只做只读数据探索。",
      ].join("\n"),
      "utf-8",
    )

    try {
      await Instance.provide({
        directory: project,
        fn: async () => {
          const agent = await Agent.get("custom-explorer")
          expect(agent).toBeDefined()
          expect(agent?.mode).toBe("subagent")
          expect(agent?.model).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-flash" })
          expect(agent?.description).toContain("自定义探索")
          // prompt body 进入 agent.prompt
          expect(agent?.prompt).toContain("只做只读数据探索")
        },
      })
    } finally {
      if (previousTestHome === undefined) delete process.env.KILLSTATA_TEST_HOME
      else process.env.KILLSTATA_TEST_HOME = previousTestHome
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})
