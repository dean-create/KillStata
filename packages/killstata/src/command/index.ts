import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import { MCP } from "../mcp"
import { Log } from "../util/log"
import { withTimeout } from "@/util/timeout"

export namespace Command {
  const log = Log.create({ service: "command" })
  const MCP_PROMPTS_TIMEOUT_MS = 250

  export const Event = {
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(),
        sessionID: Identifier.schema("session"),
        arguments: z.string(),
        messageID: Identifier.schema("message"),
      }),
    ),
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      mcp: z.boolean().optional(),
      availability: z.array(z.string()).optional(),
      queueBehavior: z.enum(["queued", "immediate"]).optional(),
      workflowAware: z.boolean().optional(),
      immediate: z.boolean().optional(),
      remoteSafe: z.boolean().optional(),
      repairOnlyAllowed: z.boolean().optional(),
      requiresTrustedArtifacts: z.boolean().optional(),
      advanced: z.boolean().optional(),
      visibleWhen: z.array(z.string()).optional(),
      blockedReason: z.string().optional(),
      // workaround for zod not supporting async functions natively so we use getters
      // https://zod.dev/v4/changelog?id=zfunction
      template: z.promise(z.string()).or(z.string()),
      subtask: z.boolean().optional(),
      hints: z.array(z.string()),
    })
    .meta({
      ref: "Command",
    })

  // for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
  export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

  export function hints(template: string): string[] {
    const result: string[] = []
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }

  export const Default = {
    PROGRESS: "progress",
    RESULTS: "results",
    DOCTOR: "doctor",
  } as const

  export function capabilityTags(command: Pick<Info, "availability" | "queueBehavior" | "workflowAware" | "immediate" | "remoteSafe" | "repairOnlyAllowed" | "requiresTrustedArtifacts">) {
    return [
      command.workflowAware ? "workflow" : undefined,
      ...(command.availability ?? []),
      command.queueBehavior ?? (command.immediate ? "immediate" : undefined),
      command.remoteSafe ? "remote-safe" : undefined,
      command.repairOnlyAllowed ? "repair-only-ok" : undefined,
      command.requiresTrustedArtifacts ? "trusted-artifacts" : undefined,
    ].filter((item, index, arr): item is string => typeof item === "string" && arr.indexOf(item) === index)
  }

  export function resolveCapability(command: Pick<Info, "availability" | "queueBehavior" | "workflowAware" | "immediate" | "remoteSafe" | "repairOnlyAllowed" | "requiresTrustedArtifacts" | "visibleWhen" | "blockedReason">) {
    return {
      availability: command.availability,
      queueBehavior: command.queueBehavior,
      workflowAware: command.workflowAware,
      immediate: command.immediate,
      remoteSafe: command.remoteSafe,
      repairOnlyAllowed: command.repairOnlyAllowed,
      requiresTrustedArtifacts: command.requiresTrustedArtifacts,
      visibleWhen: command.visibleWhen,
      blockedReason: command.blockedReason,
    }
  }

  function workflowTemplate(input: {
    action:
      | "status"
      | "stage"
      | "artifacts"
      | "doctor"
      | "verify"
      | "rerun_plan"
      | "rerun"
      | "tasks"
      | "timeline"
      | "restore"
      | "tools"
      | "skills"
      | "diagnostics"
      | "agent"
    guidance: string[]
  }) {
    const commandName =
      input.action === "status"
        ? "workflow"
        : input.action === "stage"
          ? "stage"
          : input.action === "artifacts"
            ? "artifact"
            : input.action
    return [
      `You are handling the /${commandName} command.`,
      `Always call the workflow tool with action="${input.action}" first.`,
      "If the user supplied $ARGUMENTS, treat them as an optional stage identifier or filter and pass them through when appropriate.",
      ...input.guidance,
    ].join("\n")
  }

  function applyDisabledCommands(commands: Record<string, Info>, disabled: string[] | undefined) {
    if (!disabled?.length) return commands
    const blocked = new Set(disabled)
    return Object.fromEntries(Object.entries(commands).filter(([name]) => !blocked.has(name)))
  }

  function showAdvancedCommands(cfg: Awaited<ReturnType<typeof Config.get>>) {
    return cfg.tui?.showAdvancedCommands === true || cfg.tui?.show_advanced_commands === true
  }

  function visibleCommands(commands: Record<string, Info>, cfg: Awaited<ReturnType<typeof Config.get>>) {
    const filtered = applyDisabledCommands(commands, cfg.disabled_commands)
    if (showAdvancedCommands(cfg)) return filtered
    return Object.fromEntries(Object.entries(filtered).filter(([, command]) => command.advanced !== true))
  }

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const result: Record<string, Info> = {
      // 只保留三个命令。其余「看阶段/看任务/看时间线/看工具」的命令都删了 —— 那些问题
      // 直接用自然语言问就行，不该逼用户背命令。
      [Default.PROGRESS]: {
        name: Default.PROGRESS,
        description: "分析进度：现在做到哪一步、下一步是什么",
        workflowAware: true,
        availability: ["workflow"],
        queueBehavior: "queued",
        remoteSafe: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "status",
          guidance: [
            "Summarize the active workflow run, active stage, latest failure, verifier state, and trusted artifacts.",
            "Keep the answer procedural and stage-oriented.",
          ],
        }),
      },
      [Default.RESULTS]: {
        name: Default.RESULTS,
        description: "分析结果：已产出的数据、诊断和回归结果",
        workflowAware: true,
        availability: ["workflow"],
        queueBehavior: "queued",
        remoteSafe: true,
        requiresTrustedArtifacts: false,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "artifacts",
          guidance: [
            "List artifact paths clearly and identify which ones are trusted for downstream reporting.",
          ],
        }),
      },
      [Default.DOCTOR]: {
        name: Default.DOCTOR,
        description: "环境检查：Python、模型、依赖是否就绪",
        workflowAware: true,
        availability: ["workflow"],
        queueBehavior: "immediate",
        immediate: true,
        remoteSafe: true,
        repairOnlyAllowed: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "doctor",
          guidance: [
            "Highlight missing dependencies, workflow blockers, and the minimum repair needed before the next stage can continue.",
          ],
        }),
      },
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      result[name] = {
        name,
        agent: command.agent,
        model: command.model,
        description: command.description,
        availability: command.availability,
        queueBehavior: command.queueBehavior,
        workflowAware: command.workflowAware,
        immediate: command.immediate,
        remoteSafe: command.remoteSafe,
        repairOnlyAllowed: command.repairOnlyAllowed,
        requiresTrustedArtifacts: command.requiresTrustedArtifacts,
        advanced: command.advanced,
        visibleWhen: command.visibleWhen,
        blockedReason: command.blockedReason,
        get template() {
          return command.template
        },
        subtask: command.subtask,
        hints: hints(command.template),
      }
    }
    const mcpPrompts = await withTimeout(MCP.prompts(), MCP_PROMPTS_TIMEOUT_MS).catch((error) => {
      log.warn("skipping MCP prompt commands during command list bootstrap", {
        error: error instanceof Error ? error.message : String(error),
      })
      return {}
    })

    for (const [name, prompt] of Object.entries(mcpPrompts)) {
      result[name] = {
        name,
        mcp: true,
        description: prompt.description,
        advanced: true,
        get template() {
          // since a getter can't be async we need to manually return a promise here
          return new Promise<string>(async (resolve, reject) => {
            const template = await MCP.getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? // substitute each argument with $1, $2, etc.
                  Object.fromEntries(prompt.arguments?.map((argument, i) => [argument.name, `$${i + 1}`]))
                : {},
            ).catch(reject)
            resolve(
              template?.messages
                .map((message) => (message.content.type === "text" ? message.content.text : ""))
                .join("\n") || "",
            )
          })
        },
        hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
      }
    }

    return result
  })

  export async function get(name: string) {
    const [commands, cfg] = await Promise.all([state(), Config.get()])
    return applyDisabledCommands(commands, cfg.disabled_commands)[name]
  }

  export async function list() {
    const [commands, cfg] = await Promise.all([state(), Config.get()])
    return Object.values(visibleCommands(commands, cfg))
  }
}
