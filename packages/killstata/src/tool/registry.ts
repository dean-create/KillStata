import { QuestionTool } from "./question"
import { BashTool, ShellTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolDefinition } from "@killstata/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncation"
import { PlanExitTool, PlanEnterTool } from "./plan"
import { ApplyPatchTool } from "./apply_patch"
import { EconometricsTool } from "./econometrics"
import { DataImportTool } from "./data-import"
import { DataBatchTool } from "./data-batch"
import { RegressionTableTool } from "./regression-table"
import { ResearchBriefTool } from "./research-brief"
import { HeterogeneityRunnerTool } from "./heterogeneity-runner"
import { PaperDraftTool } from "./paper-draft"
import { SlideGeneratorTool } from "./slide-generator"
import { WorkflowTool } from "./workflow"
import { resolveToolAvailability, workflowToolPolicy } from "@/runtime/workflow"
import type { ToolAvailabilityPolicy } from "@/runtime/types"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  export const state = Instance.state(async () => {
    const custom = [] as Tool.Info[]
    const glob = new Bun.Glob("{tool,tools}/*.{js,ts}")

    for (const dir of await Config.directories()) {
      for await (const match of glob.scan({
        cwd: dir,
        absolute: true,
        followSymlinks: true,
        dot: true,
      })) {
        const namespace = path.basename(match, path.extname(match))
        const mod = await import(match)
        for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
          custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
        }
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const result = await def.execute(args as any, ctx)
          const out = await Truncate.output(result, {}, initCtx?.agent)
          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)
    const config = await Config.get()

    return [
      InvalidTool,
      ...(["app", "cli", "desktop"].includes(Flag.KILLSTATA_CLIENT) ? [QuestionTool] : []),
      BashTool,
      ShellTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      WebFetchTool,
      TodoWriteTool,
      TodoReadTool,
      WebSearchTool,
      CodeSearchTool,
      SkillTool,
      WorkflowTool,
      ApplyPatchTool,
      EconometricsTool,
      RegressionTableTool,
      DataImportTool,
      DataBatchTool,
      ResearchBriefTool,
      HeterogeneityRunnerTool,
      PaperDraftTool,
      SlideGeneratorTool,
      ...(Flag.KILLSTATA_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      ...(Flag.KILLSTATA_EXPERIMENTAL_PLAN_MODE && Flag.KILLSTATA_CLIENT === "cli" ? [PlanExitTool, PlanEnterTool] : []),
      ...custom,
    ]
  }

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
    context?: ToolAvailabilityPolicy,
  ) {
    const tools = await all()
    const policy = workflowToolPolicy({
      ...context,
      sessionID: context?.sessionID,
      agent: context?.agent ?? agent?.name,
      platformCapabilities: {
        mcp: context?.platformCapabilities?.mcp ?? true,
        images: context?.platformCapabilities?.images ?? true,
        remote: context?.platformCapabilities?.remote ?? false,
      },
      modelCapabilities: {
        supportsTools: context?.modelCapabilities?.supportsTools ?? true,
        supportsImages: context?.modelCapabilities?.supportsImages ?? true,
      },
    })
    const resolution = resolveToolAvailability({ policy, toolIDs: tools.map((tool) => tool.id) })
    const workflowAllowed = new Set(resolution.allowedToolIDs)
    const result = await Promise.all(
      tools
        .filter((t) => {
          if (!workflowAllowed.has(t.id)) return false
          // Enable websearch/codesearch for zen users OR via enable flag
          if (t.id === "codesearch" || t.id === "websearch") {
            return model.providerID === "killstata" || Flag.KILLSTATA_ENABLE_EXA
          }

          // use apply tool in same format as codex
          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (t.id === "apply_patch") return usePatch
          if (t.id === "edit" || t.id === "write") return !usePatch

          return true
        })
        .map(async (t) => {
          using _ = log.time(t.id)
          return {
            id: t.id,
            ...(await t.init({ agent })),
          }
        }),
    )
    return result
  }
}
