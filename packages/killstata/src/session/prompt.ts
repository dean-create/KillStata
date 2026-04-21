import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions } from "ai"
import { SessionCompaction } from "./compaction"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { Plugin } from "../plugin"
import ANALYST_SWITCH from "../session/prompt/analyst-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { clone } from "remeda"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { ListTool } from "../tool/ls"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { $, fileURLToPath } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@killstata/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { Truncate } from "@/tool/truncation"
import type { QueuedSessionAction, ToolAvailabilityPolicy, WorkflowInputIntent } from "@/runtime/types"
import { RuntimeHooks } from "@/runtime/hooks"
import { allowMcpToolForWorkflow } from "@/runtime/workflow"
import { SessionRunCoordinator } from "./run-state"
import { detectWorkflowLocaleFromText } from "@/runtime/workflow-locale"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const OUTPUT_TOKEN_MAX = Flag.KILLSTATA_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  async function enqueueAction(
    sessionID: string,
    action: Omit<QueuedSessionAction, "id" | "sessionID" | "createdAt"> & { metadata?: Record<string, unknown> },
  ) {
    const queued = {
      id: ulid(),
      sessionID,
      createdAt: Date.now(),
      ...action,
    } satisfies QueuedSessionAction
    SessionRunCoordinator.enqueue(queued)
    await RuntimeHooks.inputAccepted({
      sessionID,
      action: action.type,
      metadata: action.metadata,
    })
    return queued
  }

  function waitForAction(sessionID: string, actionID?: string) {
    return SessionRunCoordinator.waitForAction(sessionID, actionID)
  }

  function resolveCallbacks(sessionID: string, message: MessageV2.WithParts, actionID?: string) {
    SessionRunCoordinator.resolveAction(sessionID, message, actionID)
  }

  function startDispatch(sessionID: string) {
    void dispatch(sessionID).catch((error) => {
      log.error("dispatch failed", { sessionID, error })
      SessionRunCoordinator.fail(sessionID, error)
    })
  }

  function nextQueuedAction(sessionID: string) {
    return SessionRunCoordinator.next(sessionID)
  }

  function completedReplyForAction(
    action: QueuedSessionAction,
    messages: MessageV2.WithParts[],
  ): MessageV2.WithParts | undefined {
    if (action.type !== "prompt" && action.type !== "command" && action.type !== "shell") return undefined
    const messageID = typeof action.metadata?.["messageID"] === "string" ? action.metadata["messageID"] : undefined
    if (!messageID) return undefined
    return messages.findLast(
      (message) =>
        message.info.role === "assistant" &&
        message.info.parentID === messageID &&
        !!message.info.finish &&
        !["tool-calls", "unknown"].includes(message.info.finish),
    )
  }

  function start(sessionID: string) {
    const runtime = SessionRunCoordinator.ensure(sessionID)
    if (runtime.abort) return
    const controller = new AbortController()
    runtime.abort = controller
    return controller.signal
  }

  export function assertNotBusy(sessionID: string) {
    if (SessionRunCoordinator.active(sessionID)) throw new Session.BusyError(sessionID)
  }

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    system: z.string().optional(),
    variant: z.string().optional(),
    queuePriority: z.number().int().optional(),
    queueActionType: z.enum(["prompt", "command", "shell", "continue", "retry", "repair", "compaction"]).optional(),
    queueMetadata: z.record(z.string(), z.any()).optional(),
    intent: z.enum(["status", "repair", "verify", "report", "analysis"]).optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    log.info("prompt start", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      noReply: input.noReply,
      partCount: input.parts.length,
    })
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

    const message = await createUserMessage(input)
    log.info("prompt user message created", {
      sessionID: input.sessionID,
      messageID: message.info.id,
      partCount: message.parts.length,
    })
    await Session.touch(input.sessionID)

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.update(session.id, (draft) => {
        draft.permission = permissions
      })
    }

    if (input.noReply === true) {
      log.info("prompt noReply returning", {
        sessionID: input.sessionID,
        messageID: message.info.id,
      })
      return message
    }

    const queued = await enqueueAction(input.sessionID, {
      type: input.queueActionType ?? "prompt",
      priority: input.queuePriority ?? 10,
      metadata: {
        messageID: message.info.id,
        intent: input.intent,
        hasImageInput: input.parts.some((part) => part.type === "file" && part.mime?.startsWith("image/")),
        ...(input.queueMetadata ?? {}),
      },
    })
    const completion = waitForAction(input.sessionID, queued.id)

    log.info("prompt entering loop", {
      sessionID: input.sessionID,
      messageID: message.info.id,
    })
    startDispatch(input.sessionID)
    return completion
  })

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: `file://${filepath}`,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: `file://${filepath}`,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  export function cancel(sessionID: string) {
    log.info("cancel", { sessionID })
    SessionRunCoordinator.cancel(sessionID, new Error("Session prompt cancelled"))
    return
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => {
    const completion = waitForAction(sessionID)
    startDispatch(sessionID)
    return completion
  })

  async function dispatch(sessionID: string) {
    const begun = SessionRunCoordinator.tryBeginDispatch(sessionID)
    if (!begun) {
      return
    }
    const { generation, abort } = begun
    if (!SessionRunCoordinator.startDispatch(sessionID, generation)) {
      SessionRunCoordinator.cancelDispatch(sessionID, generation)
      return
    }
    let activeAction: QueuedSessionAction | undefined

    using _ = defer(() => {
      SessionRunCoordinator.finishDispatch(sessionID, generation)
      if (SessionRunCoordinator.pending(sessionID) > 0) {
        queueMicrotask(() => startDispatch(sessionID))
      }
    })

    let step = 0
    let analysisRepairAttempts = 0
    const session = await Session.get(sessionID)
    while (true) {
      SessionStatus.set(sessionID, { type: "busy" })
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      if (!activeAction && SessionRunCoordinator.pending(sessionID) > 0) {
        activeAction = nextQueuedAction(sessionID)
      }
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      const completedAction = activeAction ? completedReplyForAction(activeAction, msgs) : undefined
      if (completedAction) {
        resolveCallbacks(sessionID, completedAction, activeAction?.id)
        activeAction = undefined
        if (SessionRunCoordinator.pending(sessionID) > 0) continue
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      if (
        lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id
      ) {
        log.info("exiting loop", { sessionID })
        break
      }

      step++
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        })

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
      const task = tasks.pop()

      // pending subtask
      // TODO: centralize "invoke tool" logic
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
        const assistantMessage = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        let part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        }
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          { args: taskArgs },
        )
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        const taskCtx: Tool.Context = {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          async metadata(input) {
            await Session.updatePart({
              ...part,
              type: "tool",
              state: {
                ...part.state,
                ...input,
              },
            } satisfies MessageV2.ToolPart)
          },
          async ask(req) {
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }
        const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          result,
        )
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments: result.attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserMsg: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: lastUser.model,
          }
          await Session.updateMessage(summaryUserMsg)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }

        continue
      }

      // pending compaction
      if (task?.type === "compaction") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
        })
        if (result === "stop") break
        continue
      }

      // context overflow, needs compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      ) {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }

      // normal processing
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
      })

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })

      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        intent: activeAction?.metadata?.["intent"] as WorkflowInputIntent | undefined,
        hasImageInput: Boolean(activeAction?.metadata?.["hasImageInput"]),
      })

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      const sessionMessages = clone(msgs)

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of sessionMessages) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      const progressive = await SessionCompaction.progressiveContext({
        sessionID,
        messages: sessionMessages,
      })
      const preparedMessages = progressive.messages

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: preparedMessages })

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system: [
          ...(await SystemPrompt.environment({ messages: msgs })),
          ...(await SystemPrompt.custom()),
          ...progressive.system,
        ].filter((item): item is string => typeof item === "string"),
        messages: [
          ...MessageV2.toModelMessages(preparedMessages, model),
          ...(isLastStep
            ? [
              {
                role: "assistant" as const,
                content: MAX_STEPS,
              },
            ]
            : []),
        ],
        tools,
        model,
      })
      if (result === "stop") break
      if (typeof result === "object" && result.type === "repair") {
        analysisRepairAttempts += 1
        if (analysisRepairAttempts > 2) break
        SessionStatus.set(sessionID, {
          type: "repair",
          tool: result.toolName,
          retryStage: result.retryStage,
          message: result.repairAction,
        })

        const repairUserMessage: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID,
          role: "user",
          time: {
            created: Date.now(),
          },
          agent: lastUser.agent,
          model: lastUser.model,
        }
        await Session.updateMessage(repairUserMessage)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: repairUserMessage.id,
          sessionID,
          type: "text",
          synthetic: true,
          text: [
            `The ${result.toolName} step failed during ${result.retryStage}.`,
            `Repair action: ${result.repairAction}`,
            result.reflectionPath ? `Reflection log: ${result.reflectionPath}` : "",
            "Retry only the failed stage. Reuse successful stages and saved artifacts instead of restarting the whole workflow.",
          ]
            .filter(Boolean)
            .join("\n"),
        } satisfies MessageV2.TextPart)
        continue
      }
      analysisRepairAttempts = 0
      if (result === "compact") {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
      }
      continue
    }
    SessionCompaction.prune({ sessionID })
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      resolveCallbacks(sessionID, item, activeAction?.id)
      return item
    }
    throw new Error("Impossible")
  }

  async function lastModel(sessionID: string) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    intent?: WorkflowInputIntent
    hasImageInput?: boolean
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}
    const resolvedIntent: WorkflowInputIntent = input.intent ?? "analysis"

    const extractKeyedValue = (input: string, key: string): string | undefined => {
      const match = new RegExp(`\\b${key}\\s*[:=]\\s*([^\\n\\r}]+)`, "i").exec(input)
      if (!match) return undefined
      return match[1].trim().replace(/^['"]|['"]$/g, "").replace(/[},]+$/g, "").trim()
    }

    const isShellCommandTool = (toolName: string) => toolName === "bash" || toolName === "shell"

    const mapStringToolInput = (toolName: string, value: string): Record<string, unknown> | undefined => {
      if (isShellCommandTool(toolName)) {
        const extracted = extractKeyedValue(value, "command")
        if (extracted) return { command: extracted }
        return { command: value.trim() }
      }
      if (toolName === "glob") {
        const extracted = extractKeyedValue(value, "pattern")
        if (extracted) return { pattern: extracted }
        return { pattern: value.trim() }
      }
      return undefined
    }

    const normalizeToolArgs = (toolName: string, args: unknown): unknown => {
      if (typeof args !== "string") return args
      try {
        const parsed = JSON.parse(args)
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed
        }
        if (typeof parsed === "string") {
          const mapped = mapStringToolInput(toolName, parsed)
          if (mapped) return mapped
        }
      } catch {
        // fall through to raw string mapping
      }
      if (isShellCommandTool(toolName)) {
        const command = extractKeyedValue(args, "command")
        const workdir = extractKeyedValue(args, "workdir")
        const description = extractKeyedValue(args, "description")
        const timeoutRaw = extractKeyedValue(args, "timeout")
        const timeout = timeoutRaw ? Number(timeoutRaw) : undefined
        if (command) {
          return {
            command,
            ...(workdir ? { workdir } : {}),
            ...(description ? { description } : {}),
            ...(Number.isFinite(timeout) ? { timeout } : {}),
          }
        }
      }
      if (toolName === "glob") {
        const pattern = extractKeyedValue(args, "pattern")
        const path = extractKeyedValue(args, "path")
        if (pattern) return { pattern, ...(path ? { path } : {}) }
      }
      return mapStringToolInput(toolName, args) ?? args
    }

    const context = (args: any, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
      agent: input.agent.name,
      metadata: async (val: { title?: string; metadata?: any }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          await Session.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
              time: {
                start: Date.now(),
              },
            },
          })
        }
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
        })
      },
    })

    const toolAvailability: ToolAvailabilityPolicy = {
      sessionID: input.session.id,
      agent: input.agent.name,
      inputIntent: resolvedIntent,
      platformCapabilities: {
        mcp: true,
        images: input.hasImageInput ?? false,
        remote: Flag.KILLSTATA_CLIENT !== "cli",
      },
      modelCapabilities: {
        supportsTools: true,
        supportsImages: /vision|vl|omni|gpt-4o|gpt-5/i.test(input.model.api.id),
      },
    }

    for (const item of await ToolRegistry.tools(
      { modelID: input.model.api.id, providerID: input.model.providerID },
      input.agent,
      toolAvailability,
    )) {
      let schema
      try {
        // 安全地转换 Zod schema 为 JSON Schema
        const params = item.parameters as any
        let jsonSchemaResult: any

        // 使用 Zod 内置的 toJSONSchema（Zod v4）
        // 使用 unrepresentable: "any" 选项处理不可直接转换的类型
        if (params && typeof params === "object") {
          jsonSchemaResult = z.toJSONSchema(params, { unrepresentable: "any" })
        } else {
          // 已经是 JSON Schema 格式，直接使用
          jsonSchemaResult = params
        }

        schema = ProviderTransform.schema(input.model, jsonSchemaResult as any)
      } catch (error) {
        console.error(`[ERROR] Failed to convert schema for tool: ${item.id}`, {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
          parametersType: typeof item.parameters,
          parametersDef: (item.parameters as any)?._def?.typeName,
        })
        throw new Error(`Schema conversion failed for tool '${item.id}': ${error instanceof Error ? error.message : error}`)
      }
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          // 规范化工具参数：兼容 JSON 字符串或纯字符串输入
          const normalizedArgs = normalizeToolArgs(item.id, args)

          const ctx = context(normalizedArgs, options)
          return input.processor.executeTool(item.id, normalizedArgs, {
            callID: options.toolCallId,
            run: async () => {
              await Plugin.trigger(
                "tool.execute.before",
                {
                  tool: item.id,
                  sessionID: ctx.sessionID,
                  callID: ctx.callID,
                },
                {
                  args: normalizedArgs,
                },
              )
              const result = await item.execute(normalizedArgs, ctx)
              await Plugin.trigger(
                "tool.execute.after",
                {
                  tool: item.id,
                  sessionID: ctx.sessionID,
                  callID: ctx.callID,
                },
                result,
              )
              return result
            },
          })
        },
      })
    }

    for (const [key, item] of Object.entries(await MCP.tools())) {
      if (!allowMcpToolForWorkflow({ toolName: key, policy: toolAvailability })) continue
      const execute = item.execute
      if (!execute) continue

      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        // 规范化工具参数：兼容 JSON 字符串或纯字符串输入
        const normalizedArgs = normalizeToolArgs(key, args)

        const ctx = context(normalizedArgs, opts)

        return input.processor.executeTool(key, normalizedArgs, {
          callID: opts.toolCallId,
          run: async () => {
            await Plugin.trigger(
              "tool.execute.before",
              {
                tool: key,
                sessionID: ctx.sessionID,
                callID: opts.toolCallId,
              },
              {
                args: normalizedArgs,
              },
            )

            await ctx.ask({
              permission: key,
              metadata: {},
              patterns: ["*"],
              always: ["*"],
            })

            const result = await execute(normalizedArgs, opts)

            await Plugin.trigger(
              "tool.execute.after",
              {
                tool: key,
                sessionID: ctx.sessionID,
                callID: opts.toolCallId,
              },
              result,
            )

            const textParts: string[] = []
            const attachments: MessageV2.FilePart[] = []

            for (const contentItem of result.content) {
              if (contentItem.type === "text") {
                textParts.push(contentItem.text)
              } else if (contentItem.type === "image") {
                attachments.push({
                  id: Identifier.ascending("part"),
                  sessionID: input.session.id,
                  messageID: input.processor.message.id,
                  type: "file",
                  mime: contentItem.mimeType,
                  url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                })
              } else if (contentItem.type === "resource") {
                const { resource } = contentItem
                if (resource.text) {
                  textParts.push(resource.text)
                }
                if (resource.blob) {
                  attachments.push({
                    id: Identifier.ascending("part"),
                    sessionID: input.session.id,
                    messageID: input.processor.message.id,
                    type: "file",
                    mime: resource.mimeType ?? "application/octet-stream",
                    url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                    filename: resource.uri,
                  })
                }
              }
            }

            const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
            const metadata = {
              ...(result.metadata ?? {}),
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            }

            return {
              title: "",
              metadata,
              output: truncated.content,
              attachments,
              content: result.content,
            }
          },
        })
      }
      tools[key] = item
    }

    return tools
  }

  async function createUserMessage(input: PromptInput) {
    log.info("createUserMessage start", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      partCount: input.parts.length,
    })
    const agent = await Agent.get(input.agent ?? (await Agent.defaultAgent()))
    const info: MessageV2.Info = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.name,
      model: input.model ?? agent.model ?? (await lastModel(input.sessionID)),
      system: input.system,
      variant: input.variant,
    }

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<MessageV2.Part[]> => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: MessageV2.Part[] = [
              {
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                id: part.id ?? Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: Buffer.from(part.url, "base64url").toString(),
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const stat = await Bun.file(filepath).stat()

              if (stat.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI)
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start - 1, 0)
                  if (end) {
                    limit = end - offset
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: MessageV2.Part[] = [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      metadata: async () => { },
                      ask: async () => { },
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        id: part.id ?? Identifier.ascending("part"),
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { path: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  metadata: async () => { },
                  ask: async () => { },
                }
                const result = await ListTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the list tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              const file = Bun.file(filepath)
              FileTime.read(input.sessionID, filepath)
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {\"filePath\":\"${filepath}\"}`,
                  synthetic: true,
                },
                {
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + Buffer.from(await file.bytes()).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = PermissionNext.evaluate("task", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              id: Identifier.ascending("part"),
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            id: Identifier.ascending("part"),
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat())

    log.info("createUserMessage before plugin trigger", {
      sessionID: input.sessionID,
      messageID: info.id,
      partCount: parts.length,
    })
    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: info,
        parts,
      },
    )
    log.info("createUserMessage after plugin trigger", {
      sessionID: input.sessionID,
      messageID: info.id,
      partCount: parts.length,
    })

    await Session.updateMessage(info)
    log.info("createUserMessage message persisted", {
      sessionID: input.sessionID,
      messageID: info.id,
    })
    for (const part of parts) {
      await Session.updatePart(part)
    }
    log.info("createUserMessage parts persisted", {
      sessionID: input.sessionID,
      messageID: info.id,
      partCount: parts.length,
    })

    return {
      info,
      parts,
    }
  }

  async function insertReminders(input: { messages: MessageV2.WithParts[]; agent: Agent.Info; session: Session.Info }) {
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return input.messages
    const userText = userMessage.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const workflowLocale = detectWorkflowLocaleFromText(userText)
    const isPlanSwitchRequest =
      userMessage.info.agent === "explorer" && /User has requested to enter explorer mode/i.test(userText)
    const isPlanApprovalSwitch =
      userMessage.info.agent === "analyst" && /The plan at .* has been approved/i.test(userText)

    // Original logic when experimental explorer mode is disabled
    if (!Flag.KILLSTATA_EXPERIMENTAL_PLAN_MODE) {
      if (input.agent.name === "explorer") {
        userMessage.parts.push({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            workflowLocale === "zh-CN"
              ? `<system-reminder>
Explorer 模式已启用。

当前是数据准备模式。你可以检查文件，并运行导入、QA、描述统计、相关性、预处理和变量工程等数据准备工具。
在任何删除型步骤（如 filter/dropna/rollback）之前，都必须先征求用户确认。
默认不要运行正式计量估计或报告生成工具；请把准备好的产物交给 Analyst。

你可以从三种常见方向提供帮助：
1. 分析数据集：检查文件、概括结构、识别变量角色、标记 QA 问题，并进行非破坏性清洗。
2. 设计实证研究：细化研究问题、变量、识别策略和所需准备步骤。
3. 解答计量问题：解释方法、假设、诊断与建议的下一步。
</system-reminder>`
              : `<system-reminder>
Explorer mode is active.

This is data-preparation mode. You may inspect files and run data-prep tools for import, QA, describe, correlation, preprocessing, and variable engineering.
Before any deletion-like step such as filter/dropna/rollback, ask the user to confirm.
Do not run formal econometric estimation or report-generation tools by default; hand prepared artifacts to Analyst.

You can provide targeted help in three common ways:
1. Analyze a dataset: inspect files, summarize structure, identify variable roles, flag QA issues, and do non-destructive cleaning.
2. Design an empirical study: refine the question, variables, identification strategy, and required preparation steps.
3. Solve an econometrics question: explain methods, assumptions, diagnostics, and recommended next steps.
</system-reminder>`,
          synthetic: true,
        })
      }
      const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "explorer")
      if (wasPlan && input.agent.name === "analyst") {
        userMessage.parts.push({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            workflowLocale === "zh-CN"
              ? ANALYST_SWITCH +
                "\n\n先检查最新数据集和 QA 产物，再给出执行清单，之后再运行计量分析。"
              : ANALYST_SWITCH +
                "\n\nReview the latest dataset and QA artifacts first, then present an execution checklist before running econometrics.",
          synthetic: true,
        })
      }
      return input.messages
    }

    // New explorer mode logic when flag is enabled
    const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")

    // Switching from explorer mode to analyst mode
    if (input.agent.name !== "explorer" && assistantMessage?.info.agent === "explorer") {
      if (isPlanApprovalSwitch) {
        const plan = await Session.planReadPath(input.session)
        const exists = await Bun.file(plan).exists()
        if (exists) {
          const part = await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text:
              workflowLocale === "zh-CN"
                ? ANALYST_SWITCH + "\n\n" + `计划文件已存在：${plan}。你应按其中定义的计划执行。`
                : ANALYST_SWITCH + "\n\n" + `A plan file exists at ${plan}. You should execute on the plan defined within it`,
            synthetic: true,
          })
          userMessage.parts.push(part)
        }
      } else {
        const part = await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            workflowLocale === "zh-CN"
              ? `<system-reminder>
Analyst 模式已启用。

你正在接收来自 Explorer 的工作流交接。不要直接跳去跑回归。

开始实证执行前：
1. 优先读取最新的 canonical dataset / datasetId-stageId 上下文。
2. 检查最近的 QA、描述统计与 workflow 产物。
3. 先展示简洁执行清单：数据准备、识别策略与变量、基准模型、诊断与稳健性、结果报告。
4. 在运行估计或重执行数据步骤前先征求批准。
5. 优先复用 Explorer 生成的产物，除非 workflow 证据显示它们已过期或缺失。
</system-reminder>`
              : `<system-reminder>
Analyst mode is active.

You are receiving a workflow handoff from Explorer. Do not jump straight into regression.

Before empirical execution:
1. Read the latest canonical dataset / datasetId-stageId context when available.
2. Inspect the most recent QA, describe, and workflow artifacts.
3. Present a concise execution checklist with these items: Data readiness, Identification & variables, Baseline model, Diagnostics & robustness, Reporting.
4. Ask for approval before running estimation or execution-heavy data steps.
5. Reuse Explorer-produced artifacts instead of re-importing or re-cleaning unless the workflow evidence says they are stale or missing.
</system-reminder>`,
          synthetic: true,
        })
        userMessage.parts.push(part)
      }
      return input.messages
    }

    // Entering explorer mode
    if (input.agent.name === "explorer" && assistantMessage?.info.agent !== "explorer") {
      if (!isPlanSwitchRequest) {
        const part = await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            workflowLocale === "zh-CN"
              ? `<system-reminder>
Explorer 模式已启用。

当前是数据准备模式，不是只读规划模式。

你可以检查文件，并运行导入、描述统计、相关性、QA、预处理和变量工程等数据准备工具。
在任何删除型步骤（如 filter/dropna/rollback）之前，都必须先征求用户确认。
默认不要运行正式计量估计、回归表或报告生成工具。
你的职责是把干净数据集、QA 证据和变量候选交给 Analyst。

你可以从三种常见方向提供帮助：
1. 分析数据集：检查文件、概括结构、识别变量角色、标记 QA 问题，并进行非破坏性清洗。
2. 设计实证研究：细化研究问题、变量、识别策略和准备计划。
3. 解答计量问题：解释方法、假设、诊断，以及 workflow 下一步该做什么。
</system-reminder>`
              : `<system-reminder>
Explorer mode is active.

This is data-preparation mode, not read-only planning mode.

You may inspect files and run data-prep tools for import, describe, correlation, QA, preprocessing, and variable engineering.
Before any deletion-like step such as filter/dropna/rollback, ask the user to confirm.
Do not run formal econometric estimation, regression tables, or report-generation tools by default.
Your job is to hand clean datasets, QA evidence, and variable candidates to Analyst.

You can provide targeted help in three common ways:
1. Analyze a dataset: inspect files, summarize structure, identify variable roles, flag QA issues, and do non-destructive cleaning.
2. Design an empirical study: refine the research question, variables, identification strategy, and preparation plan.
3. Solve an econometrics question: explain methods, assumptions, diagnostics, and what should happen next in the workflow.
</system-reminder>`,
          synthetic: true,
        })
        userMessage.parts.push(part)
        return input.messages
      }

      const plan = Session.plan(input.session)
      const exists = await Bun.file(plan).exists()
      if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })
      const part = await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text:
          workflowLocale === "zh-CN"
            ? `<system-reminder>
Explorer 模式已启用。用户明确表示现在不希望你执行，因此你绝对不能进行任何编辑（下文提到的计划文件除外）、运行任何非只读工具（包括修改配置或提交 commit），也不能对系统做其他任何更改。这条规则优先于你收到的其他指令。

## 计划文件信息：
${exists ? `计划文件已存在：${plan}。你可以读取它，并使用 edit 工具做增量修改。` : `计划文件尚不存在。你应使用 write 工具在 ${plan} 创建它。`}
请通过写入或编辑这个文件来逐步构建计划。注意：这是唯一允许你修改的文件；除此之外，你只能执行只读操作。

## 规划流程

### 阶段 1：初步理解
目标：通过阅读代码并向用户提问，全面理解需求。关键点：这一阶段只允许使用 explore 子代理类型。

1. 专注理解用户需求，以及与需求相关的代码。

2. **最多并行启动 3 个 explore agent**（单条消息内多次工具调用），高效探索代码库。
   - 当任务仅涉及已知文件、用户已给出明确路径、或只是很小的定点修改时，用 1 个 agent。
   - 当范围不确定、涉及多个模块、或需要先理解现有模式再规划时，再用多个 agent。
   - 质量高于数量，最多 3 个，但通常越少越好。
   - 如果用多个 agent，请给每个 agent 指定明确的探索重点。

3. 探索后，使用 question tool 先澄清用户需求里的歧义。

### 阶段 2：设计
目标：设计实现方案。

基于第一阶段的探索结果，启动通用 agent 设计实现方案。

最多并行启动 1 个 agent。
</system-reminder>`
            : `<system-reminder>
Explorer mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Explorer agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning and ready to switch to analyst agent.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    }
    return input.messages
  }

  export const ShellInput = z.object({
    sessionID: Identifier.schema("session"),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }
    using _ = defer(() => cancel(input.sessionID))

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      SessionRevert.cleanup(session)
    }
    const agent = await Agent.get(input.agent)
    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const userMsg: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateMessage(userMsg)
    const userPart: MessageV2.Part = {
      type: "text",
      id: Identifier.ascending("part"),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    const msg: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    const part: MessageV2.Part = {
      type: "tool",
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    const shell = Shell.preferred()
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const proc = spawn(shell, args, {
      cwd: Instance.directory,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "dumb",
      },
    })

    let output = ""

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve()
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    return { info: msg, parts: [part] }
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
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
      input.command === "workflow" || input.command === "stage" || input.command === "artifact" || input.command === "doctor"
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
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
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

    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      variant: input.variant,
      intent,
      queueActionType: "command",
      queuePriority,
      queueMetadata: {
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

  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: string
    modelID: string
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return

    // Find first non-synthetic user message
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return

    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return

    // Gather all messages up to and including the first real user message for context
    // This includes any shell/subtask executions that preceded the user's first prompt
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    const result = await LLM.stream({
      agent,
      user: firstRealUser.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : MessageV2.toModelMessages(contextMessages, model)),
      ],
    })
    const text = await result.text.catch((err) => log.error("failed to generate title", { error: err }))
    if (text)
      return Session.update(
        input.session.id,
        (draft) => {
          const cleaned = text
            .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0)
          if (!cleaned) return

          const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
          draft.title = title
        },
        { touch: false },
      )
  }
}
