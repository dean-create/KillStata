import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import { Skill } from "../skill"
import { ConfigMarkdown } from "../config/markdown"
import { PermissionNext } from "../permission/next"

export const SkillTool = Tool.define("skill", Tool.Execution.session, ToolModel.forTool("skill"), async (ctx) => {
  const skills = await Skill.all()

  // Filter skills by agent permissions if agent provided
  const agent = ctx?.agent
  const accessibleSkills = agent
    ? skills.filter((skill) => {
        const rule = PermissionNext.evaluate("skill", skill.name, agent.permission)
        return rule.action !== "deny"
      })
    : skills

  // 只列出真正安装了的 skill（用户从 GitHub 下载到 ~/.killstata/skills 的第三方计量 skill）。
  // 原先这里还拼了一层"能力别名"，把 28 个已删除的内置 skill 硬编码成别名——那会让模型看到
  // 一堆 "unavailable" 的假承诺。别名系统已随内置 skill 一起移除。
  const description =
    accessibleSkills.length === 0
      ? "加载已安装 Skill 的完整任务指令。当前没有可用 Skill；不要猜测名称或声称已加载。用户可将 Skill 安装到 ~/.killstata/skills。没有匹配 Skill 时直接使用现有工具完成任务。"
      : [
          "加载与当前任务明确匹配的 Skill 完整指令。Skill 提供专门知识、执行步骤和边界；调用前按描述核对适用范围，只能选择下列真实可用项。不要凭相似名称猜测，不要重复加载已经生效的 Skill。加载后仍须遵守当前工具权限、用户范围和计量证据要求。",
          "<available_skills>",
          ...accessibleSkills.flatMap((skill) => [
            `  <skill>`,
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            `    <source>${skill.source}</source>`,
            `  </skill>`,
          ]),
          "</available_skills>",
        ].join(" ")

  const examples = accessibleSkills
    .map((skill) => `'${skill.name}'`)
    .slice(0, 3)
    .join(", ")
  const hint = examples.length > 0 ? `（例如 ${examples}）` : ""

  const parameters = z.object({
    name: z.string().describe(`来自 available_skills 的真实技能标识${hint}`),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const skill = await Skill.get(params.name)

      if (!skill) {
        const available = await Skill.all().then((x) => x.map((skill) => skill.name).join(", "))
        throw new Error(`找不到 Skill“${params.name}”。当前可用 Skill：${available || "无"}`)
      }

      await ctx.ask({
        permission: "skill",
        patterns: [params.name],
        always: [params.name],
        metadata: {},
      })
      // Load and parse skill content
      const parsed = await ConfigMarkdown.parse(skill.location)
      const dir = path.dirname(skill.location)

      // Format output similar to plugin pattern
      const output = [
        `## Skill：${skill.name}`,
        "",
        `**来源**：${skill.source}`,
        `**基础目录**：${dir}`,
        ...(skill.recommendedTools?.length
          ? [
              "",
              `**建议使用工具**: ${skill.recommendedTools.join(", ")}。本技能建议只在这些工具之间选择，确有必要再用其他工具。`,
            ]
          : []),
        "",
        parsed.content.trim(),
      ]
        .filter(Boolean)
        .join("\n")

      return {
        title: `Loaded skill: ${skill.name}`,
        output,
        metadata: {
          name: skill.name,
          dir,
          source: skill.source,
        },
      }
    },
  }
})
