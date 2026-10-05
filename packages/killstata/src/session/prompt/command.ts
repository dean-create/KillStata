import type { WorkflowInputIntent } from "@/runtime/types"
import { $ } from "bun"
import { Agent } from "../../agent/agent"
import { Bus } from "../../bus"
import { Command } from "../../command"
import { CommandInput, argsRegex, bashRegex, log, placeholderRegex, quoteTrimRegex } from "./types"
import { ConfigMarkdown } from "../../config/markdown"
import { MessageV2 } from "../message-v2"
import { NamedError } from "@killstata/util/error"
import { Provider } from "../../provider/provider"
import { Session } from "../session-state"
import { lastModel, resolvePromptParts } from "./message"
import { prompt } from "./dispatch"
import { shell } from "./shell"
import { formatModelNotFoundMessage } from "../../provider/model-policy"

/**
 * 斜杠命令执行：模板展开、参数替换与子任务派发。
 */

/**
 * Regular expression to match @ file references in text
 * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
 * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
 */

export async function command(input: CommandInput) {
  log.info("command", input)
  const command = await Command.get(input.command)
  const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())
  const intent: WorkflowInputIntent | undefined =
    input.command === "workflow" ||
    input.command === "stage" ||
    input.command === "artifact" ||
    input.command === "doctor"
      ? "status"
      : input.command === "verify"
        ? "verify"
        : input.command === "rerun"
          ? "repair"
          : command.workflowAware
            ? "analysis"
            : undefined
  const queuePriority =
    command.queueBehavior === "immediate"
      ? 100
      : input.command === "verify"
        ? 70
        : input.command === "rerun"
          ? 60
          : 20

  const raw = input.arguments.match(argsRegex) ?? []
  const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

  const templateCommand = await command.template

  const placeholders = templateCommand.match(placeholderRegex) ?? []
  let last = 0
  for (const item of placeholders) {
    const value = Number(item.slice(1))
    if (value > last) last = value
  }

  // Let the final placeholder swallow any extra arguments so prompts read naturally
  const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
    const position = Number(index)
    const argIndex = position - 1
    if (argIndex >= args.length) return ""
    if (position === last) return args.slice(argIndex).join(" ")
    return args[argIndex]
  })
  const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
  let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

  // If command doesn't explicitly handle arguments (no $N or $ARGUMENTS placeholders)
  // but user provided arguments, append them to the template
  if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
    template = template + "\n\n" + input.arguments
  }

  const shell = ConfigMarkdown.shell(template)
  if (shell.length > 0) {
    const results = await Promise.all(
      shell.map(async ([, cmd]) => {
        try {
          return await $`${{ raw: cmd }}`.quiet().nothrow().text()
        } catch (error) {
          return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
        }
      }),
    )
    let index = 0
    template = template.replace(bashRegex, () => results[index++])
  }
  template = template.trim()

  const taskModel = await (async () => {
    if (command.model) {
      return Provider.parseModel(command.model)
    }
    if (command.agent) {
      const cmdAgent = await Agent.get(command.agent)
      if (cmdAgent?.model) {
        return cmdAgent.model
      }
    }
    if (input.model) return Provider.parseModel(input.model)
    return await lastModel(input.sessionID)
  })()

  try {
    await Provider.getModel(taskModel.providerID, taskModel.modelID)
  } catch (e) {
    if (Provider.ModelNotFoundError.isInstance(e)) {
      const { providerID, modelID, suggestions } = e.data
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: new NamedError.Unknown({ message: formatModelNotFoundMessage({ providerID, modelID, suggestions }) }).toObject(),
      })
    }
    throw e
  }
  const agent = await Agent.get(agentName)
  if (!agent) {
    const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
    const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
    const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
    Bus.publish(Session.Event.Error, {
      sessionID: input.sessionID,
      error: error.toObject(),
    })
    throw error
  }

  const templateParts = await resolvePromptParts(template)
  const commandParts = command.workflowAware
    ? templateParts.map((part) => {
        if (part.type !== "text") return part
        return {
          ...part,
          synthetic: true,
        }
      })
    : templateParts
  const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
  const parts = isSubtask
    ? [
        {
          type: "subtask" as const,
          agent: agent.name,
          description: command.description ?? "",
          command: input.command,
          model: {
            providerID: taskModel.providerID,
            modelID: taskModel.modelID,
          },
          // TODO: how can we make task tool accept a more complex input?
          prompt: commandParts.find((y) => y.type === "text")?.text ?? "",
        },
      ]
    : [...commandParts, ...(input.parts ?? [])]

  const userAgent = isSubtask ? (input.agent ?? (await Agent.defaultAgent())) : agentName
  const userModel = isSubtask
    ? input.model
      ? Provider.parseModel(input.model)
      : await lastModel(input.sessionID)
    : taskModel

  const result = (await prompt({
    sessionID: input.sessionID,
    messageID: input.messageID,
    model: userModel,
    agent: userAgent,
    parts,
    variant: input.variant,
    intent,
    queueActionType: "command",
    queuePriority: input.queuePriority ?? queuePriority,
    queueMetadata: {
      ...(input.queueMetadata ?? {}),
      command: input.command,
      queueBehavior: command.queueBehavior ?? (command.immediate ? "immediate" : "queued"),
      workflowAware: command.workflowAware ?? false,
    },
  })) as MessageV2.WithParts

  Bus.publish(Command.Event.Executed, {
    name: input.command,
    sessionID: input.sessionID,
    arguments: input.arguments,
    messageID: result.info.id,
  })

  return result
}
