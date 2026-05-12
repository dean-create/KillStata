import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
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
    INIT: "init",
    REVIEW: "review",
    WORKFLOW: "workflow",
    STAGE: "stage",
    RERUN: "rerun",
    ARTIFACT: "artifact",
    DOCTOR: "doctor",
    VERIFY: "verify",
    TASKS: "tasks",
    TIMELINE: "timeline",
    RESTORE: "restore",
    TOOLS: "tools",
    SKILLS: "skills",
    DIAGNOSTICS: "diagnostics",
    AGENT: "agent",
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
      [Default.INIT]: {
        name: Default.INIT,
        description: "create/update AGENTS.md",
        advanced: true,
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", Instance.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      },
      [Default.REVIEW]: {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        advanced: true,
        get template() {
          return PROMPT_REVIEW.replace("${path}", Instance.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      },
      [Default.WORKFLOW]: {
        name: Default.WORKFLOW,
        description: "查看当前计量工作流、阶段状态、校验器和下一步",
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
      [Default.STAGE]: {
        name: Default.STAGE,
        description: "inspect a workflow stage, including replay input, artifacts, and verifier evidence",
        advanced: true,
        workflowAware: true,
        availability: ["workflow"],
        queueBehavior: "queued",
        remoteSafe: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "stage",
          guidance: [
            "Explain the selected stage or the active stage if no stage id is supplied.",
            "Include inputs, outputs, artifacts, and the verifier outcome if present.",
          ],
        }),
      },
      [Default.RERUN]: {
        name: Default.RERUN,
        description: "rerun only the failed or selected stage; do not restart successful earlier stages",
        advanced: true,
        workflowAware: true,
        availability: ["workflow"],
        queueBehavior: "queued",
        remoteSafe: true,
        repairOnlyAllowed: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "rerun",
          guidance: [
            "If rerun is blocked, explain the exact reason and stop.",
            "If rerun is runnable, rerun only the target stage with the recorded replay input, then run workflow verification again.",
            "Do not rerun already successful upstream stages.",
          ],
        }),
      },
      [Default.ARTIFACT]: {
        name: Default.ARTIFACT,
        description: "列出当前分析的可信数据、诊断、表格和报告产物",
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
        description: "检查 Python、模型、依赖和工作流健康状态",
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
      [Default.VERIFY]: {
        name: Default.VERIFY,
        description: "run the structured workflow verifier against the current or selected stage",
        advanced: true,
        workflowAware: true,
        availability: ["workflow"],
        queueBehavior: "queued",
        remoteSafe: true,
        repairOnlyAllowed: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "verify",
          guidance: [
            "Return the verifier result first.",
            "If verification blocks, stop and report only the repair stage that must run next.",
          ],
        }),
      },
      [Default.TASKS]: {
        name: Default.TASKS,
        description: "show persisted runtime tasks, queue state, current task, and failed task status",
        advanced: true,
        workflowAware: true,
        availability: ["workflow", "task-ledger"],
        queueBehavior: "queued",
        remoteSafe: true,
        repairOnlyAllowed: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "tasks",
          guidance: [
            "Show the active task, queued/running/failed tasks, and the latest checkpoint if available.",
            "Keep the output concise and operational.",
          ],
        }),
      },
      [Default.TIMELINE]: {
        name: Default.TIMELINE,
        description: "show the task timeline with workflow, tool, verifier, checkpoint, and restore events",
        advanced: true,
        workflowAware: true,
        availability: ["workflow", "task-ledger"],
        queueBehavior: "queued",
        remoteSafe: true,
        repairOnlyAllowed: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "timeline",
          guidance: [
            "Show the recent timeline events in chronological order.",
            "Highlight where the current workflow is blocked or recoverable.",
          ],
        }),
      },
      [Default.RESTORE]: {
        name: Default.RESTORE,
        description: "restore workflow pointers to the latest trusted checkpoint or selected checkpoint/stage",
        advanced: true,
        workflowAware: true,
        availability: ["workflow", "restore"],
        queueBehavior: "queued",
        remoteSafe: true,
        repairOnlyAllowed: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "restore",
          guidance: [
            "Restore only workflow pointers and trusted artifact references; never overwrite raw data.",
            "If restore is unavailable, explain which checkpoint or stage is missing.",
          ],
        }),
      },
      [Default.TOOLS]: {
        name: Default.TOOLS,
        description: "explain currently available tools and why blocked tools are hidden",
        advanced: true,
        workflowAware: true,
        availability: ["workflow", "tool-capability"],
        queueBehavior: "queued",
        remoteSafe: true,
        repairOnlyAllowed: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "tools",
          guidance: [
            "Explain available tools, hidden tools, and the exact policy reason.",
            "Use stage, agent, model, platform, and repair-only context when available.",
          ],
        }),
      },
      [Default.SKILLS]: {
        name: Default.SKILLS,
        description: "查看当前阶段推荐使用的数据和计量分析技能",
        workflowAware: true,
        availability: ["workflow", "skills"],
        queueBehavior: "queued",
        remoteSafe: true,
        repairOnlyAllowed: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "skills",
          guidance: [
            "Show the current stage skill bundle and why it is relevant.",
            "Do not paste long skill documents unless explicitly requested.",
          ],
        }),
      },
      [Default.DIAGNOSTICS]: {
        name: Default.DIAGNOSTICS,
        description: "show Python, MCP, LSP, dependency, workflow, and verifier diagnostics",
        advanced: true,
        workflowAware: true,
        availability: ["workflow", "diagnostics"],
        queueBehavior: "immediate",
        immediate: true,
        remoteSafe: true,
        repairOnlyAllowed: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "diagnostics",
          guidance: [
            "Summarize runtime diagnostics first, then workflow blockers.",
            "Prefer actionable repair hints over generic explanations.",
          ],
        }),
      },
      [Default.AGENT]: {
        name: Default.AGENT,
        description: "show workflow coordinator and sub-agent control state",
        advanced: true,
        workflowAware: true,
        availability: ["workflow", "agent-control"],
        queueBehavior: "queued",
        remoteSafe: true,
        repairOnlyAllowed: true,
        hints: ["$ARGUMENTS"],
        template: workflowTemplate({
          action: "agent",
          guidance: [
            "Show the current coordinator agent, fork mode, recent decisions, and structured inter-agent handoff messages.",
            "Use this for operational status only; do not infer hidden agent state from chat text.",
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
