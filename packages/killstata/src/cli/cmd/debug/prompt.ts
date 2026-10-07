import { EOL } from "os"
import { Agent } from "../../../agent/agent"
import { SystemPrompt } from "../../../session/system"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

/**
 * 提示词溯源：把 system prompt 按层拆开，标出每层的来源文件。
 *
 * 存在的理由：提示词由六层拼装而成（人格 / 方法论 / 角色 / 运行时 / 工具目录 / 用户规则），
 * 出现"模型为什么这么做"时，此前只能人肉翻六个文件对照。有了这个命令可以直接看到
 * 每条规则出自哪一层、哪个文件。
 */
export const PromptCommand = cmd({
  command: "prompt",
  describe: "show the layered system prompt and where each layer comes from",
  builder: (yargs) =>
    yargs
      .option("agent", {
        type: "string",
        default: "analyst",
        describe: "agent name (analyst, explorer, ...)",
      })
      .option("provider", {
        type: "string",
        default: "deepseek",
        describe: "provider id (deepseek or custom)",
      })
      .option("full", {
        type: "boolean",
        default: false,
        describe: "print each layer's full text instead of a summary",
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const agent = await Agent.get(args.agent)
      if (!agent) {
        process.stdout.write(`Agent not found: "${args.agent}". Available: ${(await Agent.list()).filter((a) => !a.hidden).map((a) => a.name).join(", ")}\n`)
        return
      }
      const model = {
        providerID: args.provider,
        api: { id: args.provider === "deepseek" ? "deepseek-v4-flash" : "qwen-max" },
      } as never

      const providerLayers = SystemPrompt.provider(model)
      const layers = [
        {
          layer: "persona",
          source: args.provider === "deepseek" ? "session/prompt/deepseek.txt" : "session/prompt/qwen.txt",
          text: providerLayers[0] ?? "",
        },
        {
          layer: "methodology",
          source: "session/prompt/econometrics-context.ts",
          text: providerLayers[1] ?? "",
        },
        {
          layer: "role",
          source: agent.prompt ? "agent config (custom prompt)" : "agent/prompt/roles.ts",
          text: (agent.prompt ? [agent.prompt] : SystemPrompt.agent(agent)).join("\n"),
        },
        {
          layer: "runtime",
          source: "session/system.ts environment()",
          text: (await SystemPrompt.environment({ sessionID: "ses_debug_prompt" })).join("\n"),
        },
        {
          layer: "user",
          source: "session/instruction.ts (AGENTS.md / custom rules)",
          text: (await SystemPrompt.custom()).join("\n"),
        },
      ]

      for (const { layer, source, text } of layers) {
        const lineCount = text ? text.split("\n").length : 0
        process.stdout.write(`${EOL}=== ${layer} (${source}) — ${lineCount} lines ===${EOL}`)
        if (!text) {
          process.stdout.write(`(empty)${EOL}`)
          continue
        }
        // 摘要模式只打标题行，足以定位"这条规则属于哪一层"；--full 给全文。
        const shown = args.full ? text : text.split("\n").filter((line) => line.startsWith("#")).join("\n")
        process.stdout.write((shown || "(no headings; use --full)") + EOL)
      }

      // 工具目录层依赖具体请求的工具集合，这里只说明它由什么决定。
      process.stdout.write(
        `${EOL}=== catalog (session/llm.ts + runtime/tool-manifest.ts) ===${EOL}` +
          `Assembled per request from the live tool set; see SystemPrompt.toolCatalog().${EOL}`,
      )
    })
  },
})
