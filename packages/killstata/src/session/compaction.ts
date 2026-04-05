import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { SessionPrompt } from "./prompt"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { Todo } from "./todo"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { RuntimeEvents } from "@/runtime/events"
import { RuntimeHooks } from "@/runtime/hooks"
import type { CompactionSnapshot } from "@/runtime/types"

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function clip(value: string, max = 240) {
  const normalized = compactWhitespace(value)
  if (normalized.length <= max) return normalized
  return normalized.slice(0, max - 3).trimEnd() + "..."
}

function pushUnique(target: string[], seen: Set<string>, value: string | undefined, max = 5) {
  if (!value || target.length >= max) return
  const normalized = clip(value)
  if (!normalized || seen.has(normalized)) return
  seen.add(normalized)
  target.push(normalized)
}

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context
    if (context === 0) return false
    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
    const output = Math.min(input.model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    const usable = input.model.limit.input || context - output
    return count > usable
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  export function buildFallbackSummary(input: {
    messages: MessageV2.WithParts[]
    error?: string
  }) {
    const priorSummaries: string[] = []
    const priorSummarySeen = new Set<string>()
    const recentRequests: string[] = []
    const requestSeen = new Set<string>()
    const assistantUpdates: string[] = []
    const updateSeen = new Set<string>()
    const toolUpdates: string[] = []
    const toolSeen = new Set<string>()
    const files = new Set<string>()

    for (const msg of input.messages) {
      if (msg.info.role === "assistant" && msg.info.summary) {
        for (const part of msg.parts) {
          if (part.type === "text") pushUnique(priorSummaries, priorSummarySeen, part.text, 2)
        }
      }
    }

    for (const msg of input.messages.slice(-12)) {
      if (msg.info.role === "user") {
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored && !part.synthetic) {
            pushUnique(recentRequests, requestSeen, part.text)
          }
          if (part.type === "file") {
            const fileName = clip(part.filename || part.url.split("/").pop() || "")
            if (fileName) files.add(fileName)
          }
        }
        continue
      }

      if (msg.info.role !== "assistant" || msg.info.summary) continue

      for (const part of msg.parts) {
        if (part.type === "text") {
          pushUnique(assistantUpdates, updateSeen, part.text)
          continue
        }
        if (part.type !== "tool") continue

        if (part.state.status === "completed") {
          const detail = typeof part.state.output === "string" ? part.state.output : JSON.stringify(part.state.output)
          pushUnique(toolUpdates, toolSeen, `${part.tool}: ${detail}`)
          continue
        }
        if (part.state.status === "error") {
          pushUnique(toolUpdates, toolSeen, `${part.tool} failed: ${part.state.error}`)
        }
      }
    }

    const lines = [
      "# Session Summary",
      "",
      "Generated locally because AI compaction failed before completion.",
      input.error ? `Compaction error: ${clip(input.error, 180)}` : "",
      "",
    ].filter(Boolean)

    if (priorSummaries.length > 0) {
      lines.push("## Previous summary")
      for (const item of priorSummaries) lines.push(`- ${item}`)
      lines.push("")
    }

    lines.push("## What was done")
    if (assistantUpdates.length > 0 || toolUpdates.length > 0) {
      for (const item of [...assistantUpdates, ...toolUpdates].slice(0, 6)) lines.push(`- ${item}`)
    } else {
      lines.push("- Recent assistant progress could not be recovered from the failed compaction run.")
    }
    lines.push("")

    lines.push("## Current user requests")
    if (recentRequests.length > 0) {
      for (const item of recentRequests) lines.push(`- ${item}`)
    } else {
      lines.push("- Continue from the latest visible user turn in the session.")
    }
    lines.push("")

    lines.push("## Files in play")
    if (files.size > 0) {
      for (const item of Array.from(files).slice(0, 8)) lines.push(`- ${item}`)
    } else {
      lines.push("- No explicit file attachments were captured in recent messages.")
    }
    lines.push("")

    lines.push("## Next steps")
    if (recentRequests.length > 0) {
      lines.push("- Resume from the latest user request first.")
    }
    if (toolUpdates.some((item) => item.includes("failed:"))) {
      lines.push("- Re-check the last failed step before continuing.")
    }
    lines.push("- Use the latest visible assistant and tool outputs in the session as source of truth.")

    return lines.join("\n")
  }

  async function snapshotState(input: { sessionID: string; messages: MessageV2.WithParts[] }): Promise<CompactionSnapshot> {
    const latestGoal = input.messages
      .flatMap((message) =>
        message.info.role === "user"
          ? message.parts.filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
          : [],
      )
      .map((part) => clip(part.text, 180))
      .at(-1)

    const activeTodos = (await Todo.get(input.sessionID))
      .filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
      .map((todo) => clip(todo.content, 140))
      .slice(0, 8)

    const unresolvedQuestions = (await Question.list())
      .filter((request) => request.sessionID === input.sessionID)
      .flatMap((request) => request.questions.map((question) => clip(question.question, 140)))
      .slice(0, 5)

    const trustedArtifactPaths = input.messages
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" &&
          part.state.status === "completed" &&
          part.state.metadata &&
          Array.isArray(part.state.metadata["trustedArtifactPaths"])
            ? (part.state.metadata["trustedArtifactPaths"] as string[])
            : [],
        ),
      )
      .slice(-8)

    const childSessionSummaries = input.messages
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" &&
          part.tool === "task" &&
          part.state.status === "completed" &&
          typeof part.state.metadata?.["contract"] === "object" &&
          part.state.metadata["contract"] &&
          typeof (part.state.metadata["contract"] as Record<string, unknown>)["summary"] === "string"
            ? [clip((part.state.metadata["contract"] as Record<string, unknown>)["summary"] as string, 140)]
            : [],
        ),
      )
      .slice(-5)

    const numericGroundingState = input.messages
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" && typeof part.metadata?.["numericGroundingStatus"] === "string"
            ? [part.metadata["numericGroundingStatus"] as string]
            : [],
        ),
      )
      .slice(-5)

    const pendingPermissions = Permission.list()
      .filter((permission) => permission.sessionID === input.sessionID)
      .map((permission) => clip(permission.message, 140))

    return {
      latestGoal,
      activeTodos,
      unresolvedQuestions: [...unresolvedQuestions, ...pendingPermissions].slice(0, 8),
      trustedArtifactPaths,
      childSessionSummaries,
      numericGroundingState,
    }
  }

  export async function progressiveContext(input: { sessionID: string; messages: MessageV2.WithParts[] }) {
    Bus.publish(RuntimeEvents.Compaction, {
      sessionID: input.sessionID,
      phase: "snapshot",
      details: {},
    })
    const snapshot = await snapshotState(input)
    await RuntimeHooks.compaction({
      sessionID: input.sessionID,
      phase: "snapshot",
      metadata: snapshot as unknown as Record<string, unknown>,
    })

    const trimmed = structuredClone(input.messages) as MessageV2.WithParts[]
    Bus.publish(RuntimeEvents.Compaction, {
      sessionID: input.sessionID,
      phase: "trim",
      details: {},
    })

    let seenUsers = 0
    for (let messageIndex = trimmed.length - 1; messageIndex >= 0; messageIndex--) {
      const message = trimmed[messageIndex]
      if (message.info.role === "user") {
        seenUsers += 1
        continue
      }
      if (seenUsers < 3) continue
      for (const part of message.parts) {
        if (part.type !== "tool" || part.state.status !== "completed") continue
        if (part.state.output.length <= 4_000) continue
        part.state.output = clip(part.state.output, 1200) + "\n\n[Earlier tool output trimmed for context budget.]"
      }
    }

    Bus.publish(RuntimeEvents.Compaction, {
      sessionID: input.sessionID,
      phase: "collapse",
      details: {},
    })

    const summaryLines = [
      snapshot.latestGoal ? `Latest goal: ${snapshot.latestGoal}` : undefined,
      snapshot.activeTodos.length ? `Active todos: ${snapshot.activeTodos.join(" | ")}` : undefined,
      snapshot.unresolvedQuestions.length ? `Unresolved questions: ${snapshot.unresolvedQuestions.join(" | ")}` : undefined,
      snapshot.trustedArtifactPaths.length ? `Trusted artifacts: ${snapshot.trustedArtifactPaths.join(" | ")}` : undefined,
      snapshot.childSessionSummaries.length ? `Subagent outputs: ${snapshot.childSessionSummaries.join(" | ")}` : undefined,
      snapshot.numericGroundingState.length ? `Grounding state: ${snapshot.numericGroundingState.join(" | ")}` : undefined,
    ].filter(Boolean)

    return {
      messages: trimmed,
      system: summaryLines.length
        ? [
            "<runtime-context>",
            ...summaryLines,
            "</runtime-context>",
          ]
        : [],
      snapshot,
    }
  }

  async function persistFallbackSummary(input: {
    message: MessageV2.Assistant
    sessionID: string
    messages: MessageV2.WithParts[]
  }) {
    const existing = await MessageV2.parts(input.message.id)
    for (const part of existing) {
      await Session.removePart({
        sessionID: input.sessionID,
        messageID: input.message.id,
        partID: part.id,
      })
    }

    const errorMessage =
      input.message.error && "data" in input.message.error && typeof input.message.error.data?.message === "string"
        ? input.message.error.data.message
        : undefined

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: input.message.id,
      sessionID: input.sessionID,
      type: "text",
      text: buildFallbackSummary({
        messages: input.messages,
        error: errorMessage,
      }),
      time: {
        start: Date.now(),
        end: Date.now(),
      },
      metadata: {
        compactionFallback: true,
        originalError: errorMessage,
      },
    })

    delete input.message.error
    input.message.finish = "fallback"
    input.message.time.completed = Date.now()
    await Session.updateMessage(input.message)
  }

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    const defaultPrompt =
      "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation."
    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    let result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        ...MessageV2.toModelMessages(input.messages, model),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (processor.message.error) {
      log.warn("compaction failed; using local fallback summary", {
        sessionID: input.sessionID,
        messageID: processor.message.id,
        error:
          "data" in processor.message.error && typeof processor.message.error.data?.message === "string"
            ? processor.message.error.data.message
            : String(processor.message.error),
      })
      await persistFallbackSummary({
        message: processor.message,
        sessionID: input.sessionID,
        messages: input.messages,
      })
      result = "continue"
    }

    if (result === "continue" && input.auto) {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
        agent: userMessage.agent,
        model: userMessage.model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps",
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    }
    if (processor.message.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
      })
    },
  )
}
