import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { classifyToolFailure, persistToolReflection } from "@/tool/analysis-reflection"
import {
  buildGroundingFailureText,
  collectNumericSnapshotsFromToolMetadata,
  validateNumericGrounding,
} from "@/tool/analysis-grounding"
import { Instance } from "@/project/instance"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  /**
   * 规范化工具输入，确保返回对象类型
   * 某些模型可能返回 JSON 字符串格式的 input，需要解析为对象
   * ToolState schema 要求 input �?z.record(z.string(), z.any())
   * @param input - 工具输入，可能是对象�?JSON 字符�?   * @returns 规范化后的对象类型输�?   */
  function extractKeyedValue(input: string, key: string): string | undefined {
    const match = new RegExp(`\\b${key}\\s*[:=]\\s*([^\\n\\r}]+)`, "i").exec(input)
    if (!match) return undefined
    return match[1].trim().replace(/^['"]|['"]$/g, "").replace(/[},]+$/g, "").trim()
  }

  function mapStringToolInput(toolName: string | undefined, value: string): Record<string, unknown> | undefined {
    if (!toolName) return undefined
    if (toolName === "bash") {
      const extracted = extractKeyedValue(value, "command")
      if (extracted) return { command: extracted }
      return { command: value }
    }
    if (toolName === "glob") {
      const extracted = extractKeyedValue(value, "pattern")
      if (extracted) return { pattern: extracted }
      return { pattern: value }
    }
    return undefined
  }

  function normalizeToolInput(input: unknown, toolName?: string): Record<string, unknown> {
    // 如果已经是对象类型，直接返回
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      return input as Record<string, unknown>
    }
    // 如果是字符串，尝试解析�Ϊ JSON
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input)
        // 确Ϳ�解析结枛是对�?
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
        if (typeof parsed === "string") {
          const mapped = mapStringToolInput(toolName, parsed)
          if (mapped) return mapped
        }
        const mapped = mapStringToolInput(toolName, input)
        if (mapped) return mapped
        // 如枛解析结枛不是对象，包装成错误对象
        return { _raw: input, _parseError: "Parsed value is not an object" }
      } catch {
        const mapped = mapStringToolInput(toolName, input)
        if (mapped) return mapped
        // JSON 解析失败，包装成错误对象
        return { _raw: input, _parseError: "Invalid JSON" }
      }
    }
    // 其他类型，包装成对象
    return { _raw: String(input), _parseError: "Unexpected input type" }
  }

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false
    let repair:
      | {
        type: "repair"
        toolName: string
        retryStage: string
        repairAction: string
        reflectionPath?: string
      }
      | undefined

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        // 使用 normalizeToolInput 确保 input 是对象类型，符合 ToolState schema
                        input: normalizeToolInput(value.input, value.toolName),
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(normalizeToolInput(value.input, value.toolName)),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        // 使用 normalizeToolInput 确保 input 是对象类型，符合 ToolState schema
                        input: value.input ? normalizeToolInput(value.input, value.toolName) : match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    const existingReflection =
                      match.state.metadata && typeof match.state.metadata === "object"
                        ? (match.state.metadata["reflection"] as Record<string, unknown> | undefined)
                        : undefined
                    let reflectionMetadata = existingReflection
                    if (!reflectionMetadata) {
                      const reflection = classifyToolFailure({
                        toolName: value.toolName,
                        error: (value.error as any).toString(),
                        input: value.input ? normalizeToolInput(value.input, value.toolName) : match.state.input,
                      })
                      const reflectionPath = persistToolReflection(reflection)
                      reflectionMetadata = {
                        ...reflection,
                        reflectionPath: reflectionPath.startsWith(Instance.directory)
                          ? reflectionPath.slice(Instance.directory.length + 1)
                          : reflectionPath,
                      }
                    }
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        // 使用 normalizeToolInput 确保 input 是对象类型，符合 ToolState schema
                        input: value.input ? normalizeToolInput(value.input, value.toolName) : match.state.input,
                        error: (value.error as any).toString(),
                        metadata: {
                          ...(match.state.metadata ?? {}),
                          ...(reflectionMetadata ? { reflection: reflectionMetadata } : {}),
                        },
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      reflectionMetadata &&
                      (value.toolName === "data_import" || value.toolName === "econometrics") &&
                      !blocked
                    ) {
                      repair = {
                        type: "repair",
                        toolName: value.toolName,
                        retryStage:
                          typeof reflectionMetadata["retryStage"] === "string" ? reflectionMetadata["retryStage"] : "verify",
                        repairAction:
                          typeof reflectionMetadata["repairAction"] === "string"
                            ? reflectionMetadata["repairAction"]
                            : "Repair the failed stage and retry once.",
                        reflectionPath:
                          typeof reflectionMetadata["reflectionPath"] === "string"
                            ? reflectionMetadata["reflectionPath"]
                            : undefined,
                      }
                    }

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    const messageParts = await MessageV2.parts(input.assistantMessage.id)
                    const numericSnapshots = messageParts.flatMap((part) => {
                      if (part.type !== "tool" || part.state.status !== "completed") return []
                      return collectNumericSnapshotsFromToolMetadata(part.state.metadata)
                    })
                    const grounding = validateNumericGrounding({
                      text: currentText.text,
                      snapshots: numericSnapshots,
                    })
                    if (grounding.status === "fail") {
                      currentText.text = buildGroundingFailureText(grounding)
                    }
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    currentText.metadata = {
                      ...(currentText.metadata ?? {}),
                      numericGroundingStatus: grounding.status === "fail" ? "numeric_grounding_failed" : grounding.status,
                      grounding,
                    }
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => { })
              continue
            }
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (repair) return repair
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}






