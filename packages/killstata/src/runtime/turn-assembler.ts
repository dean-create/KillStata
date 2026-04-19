import { Identifier } from "@/id/id"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "@/session/summary"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import type { QueryEvent, QueryRuntimeResult } from "./types"
import { maybeBuildAnalysisUserViewText } from "./analysis-user-view"
import {
  collectTrustedArtifactPathsFromToolMetadata,
  collectNumericSnapshotsFromToolMetadata,
  recoverNumericSnapshots,
  rewriteGroundedText,
  validateNumericGrounding,
} from "@/tool/analysis-grounding"
import { sanitizeAnalysisAssistantText, type AnalysisToolPartLike } from "./analysis-text-sanitizer"

const FINAL_ANALYSIS_RESULT_TOOLS = new Set([
  "econometrics",
  "regression_table",
  "heterogeneity_runner",
  "research_brief",
  "paper_draft",
  "slide_generator",
])

export class TurnAssembler {
  private toolcalls: Record<string, MessageV2.ToolPart> = {}
  private reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
  private currentText: MessageV2.TextPart | undefined
  private snapshot: string | undefined

  constructor(
    private readonly input: {
      assistantMessage: MessageV2.Assistant
      sessionID: string
      model: Provider.Model
    },
  ) {}

  partFromToolCall(toolCallID: string) {
    return this.toolcalls[toolCallID]
  }

  async consume(event: QueryEvent) {
    switch (event.type) {
      case "status":
        SessionStatus.set(this.input.sessionID, event.status)
        return

      case "reasoning-start":
        if (event.id in this.reasoningMap) return
        this.reasoningMap[event.id] = {
          id: Identifier.ascending("part"),
          messageID: this.input.assistantMessage.id,
          sessionID: this.input.assistantMessage.sessionID,
          type: "reasoning",
          text: "",
          time: {
            start: Date.now(),
          },
          metadata: event.providerMetadata as Record<string, unknown> | undefined,
        }
        return

      case "reasoning-delta": {
        const part = this.reasoningMap[event.id]
        if (!part) return
        part.text += event.text
        if (event.providerMetadata) part.metadata = event.providerMetadata as Record<string, unknown>
        if (part.text) {
          await Session.updatePart({ part, delta: event.text })
        }
        return
      }

      case "reasoning-end": {
        const part = this.reasoningMap[event.id]
        if (!part) return
        part.text = part.text.trimEnd()
        part.time = {
          ...part.time,
          end: Date.now(),
        }
        if (event.providerMetadata) part.metadata = event.providerMetadata as Record<string, unknown>
        await Session.updatePart(part)
        delete this.reasoningMap[event.id]
        return
      }

      case "tool-input-start": {
        const part = await Session.updatePart({
          id: this.toolcalls[event.toolCallId]?.id ?? Identifier.ascending("part"),
          messageID: this.input.assistantMessage.id,
          sessionID: this.input.assistantMessage.sessionID,
          type: "tool",
          tool: event.toolName,
          callID: event.toolCallId,
          state: {
            status: "pending",
            input: {},
            raw: "",
          },
        })
        this.toolcalls[event.toolCallId] = part as MessageV2.ToolPart
        return
      }

      case "tool-call": {
        const match = this.toolcalls[event.toolCallId]
        if (!match) return
        const part = await Session.updatePart({
          ...match,
          tool: event.toolName,
          state: {
            status: "running",
            input: this.normalizeToolInput(event.input),
            time: {
              start: Date.now(),
            },
          },
          metadata: event.providerMetadata as Record<string, unknown> | undefined,
        })
        this.toolcalls[event.toolCallId] = part as MessageV2.ToolPart
        return
      }

      case "tool-result": {
        const match = this.toolcalls[event.toolCallId]
        if (!match || match.state.status !== "running") return
        await Session.updatePart({
          ...match,
          state: {
            status: "completed",
            input: event.input ? this.normalizeToolInput(event.input) : match.state.input,
            output: event.output.output,
            metadata: event.output.metadata,
            title: event.output.title,
            attachments: event.output.attachments as MessageV2.FilePart[] | undefined,
            time: {
              start: match.state.time.start,
              end: Date.now(),
            },
          },
        })
        delete this.toolcalls[event.toolCallId]
        return
      }

      case "tool-error": {
        const match = this.toolcalls[event.toolCallId]
        if (!match || match.state.status !== "running") return
        await Session.updatePart({
          ...match,
          state: {
            status: "error",
            input: event.input ? this.normalizeToolInput(event.input) : match.state.input,
            error: String(event.error),
            metadata: event.metadata ?? match.state.metadata,
            time: {
              start: match.state.time.start,
              end: Date.now(),
            },
          },
        })
        delete this.toolcalls[event.toolCallId]
        return
      }

      case "step-start":
        this.snapshot = await Snapshot.track()
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: this.input.assistantMessage.id,
          sessionID: this.input.sessionID,
          snapshot: this.snapshot,
          type: "step-start",
        })
        return

      case "step-finish": {
        const usage = Session.getUsage({
          model: this.input.model,
          usage: event.usage,
          metadata: event.providerMetadata,
        })
        this.input.assistantMessage.finish = event.finishReason
        this.input.assistantMessage.cost += usage.cost
        this.input.assistantMessage.tokens = usage.tokens
        await Session.updatePart({
          id: Identifier.ascending("part"),
          reason: event.finishReason,
          snapshot: await Snapshot.track(),
          messageID: this.input.assistantMessage.id,
          sessionID: this.input.assistantMessage.sessionID,
          type: "step-finish",
          tokens: usage.tokens,
          cost: usage.cost,
        })
        await Session.updateMessage(this.input.assistantMessage)
        if (this.snapshot) {
          const patch = await Snapshot.patch(this.snapshot)
          if (patch.files.length) {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: this.input.assistantMessage.id,
              sessionID: this.input.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          this.snapshot = undefined
        }
        SessionSummary.summarize({
          sessionID: this.input.sessionID,
          messageID: this.input.assistantMessage.parentID,
        })
        return
      }

      case "text-start":
        if (this.currentText) {
          await this.finalizeText()
        }
        this.currentText = {
          id: Identifier.ascending("part"),
          messageID: this.input.assistantMessage.id,
          sessionID: this.input.assistantMessage.sessionID,
          type: "text",
          text: "",
          time: {
            start: Date.now(),
          },
          metadata: event.providerMetadata as Record<string, unknown> | undefined,
        }
        return

      case "text-delta":
        if (!this.currentText) {
          this.currentText = this.createTextPart(event.providerMetadata as Record<string, unknown> | undefined)
        }
        this.currentText.text += event.text
        if (event.providerMetadata) this.currentText.metadata = event.providerMetadata as Record<string, unknown>
        if (this.currentText.text) {
          await Session.updatePart({
            part: this.currentText,
            delta: event.text,
          })
        }
        return

      case "text-end":
        if (!this.currentText) {
          this.currentText = this.createTextPart(event.providerMetadata as Record<string, unknown> | undefined)
        }
        await this.finalizeText(event.providerMetadata as Record<string, unknown> | undefined)
        return

      case "stream-start":
      case "finish":
      case "turn-finish":
        return
    }
  }

  async finalize(result: QueryRuntimeResult, error?: unknown) {
    if (this.currentText) {
      await this.finalizeText()
    }

    for (const [id, part] of Object.entries(this.reasoningMap)) {
      part.text = part.text.trimEnd()
      part.time = {
        ...part.time,
        end: Date.now(),
      }
      await Session.updatePart(part)
      delete this.reasoningMap[id]
    }

    if (this.snapshot) {
      const patch = await Snapshot.patch(this.snapshot)
      if (patch.files.length) {
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: this.input.assistantMessage.id,
          sessionID: this.input.sessionID,
          type: "patch",
          hash: patch.hash,
          files: patch.files,
        })
      }
      this.snapshot = undefined
    }

    const parts = await MessageV2.parts(this.input.assistantMessage.id)
    for (const part of parts) {
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

    if (error) {
      this.input.assistantMessage.error = MessageV2.fromError(error, {
        providerID: this.input.model.providerID,
      })
    }

    this.input.assistantMessage.time.completed = Date.now()
    await Session.updateMessage(this.input.assistantMessage)
    await this.ensureAnalysisFallbackText()
    if (result === "stop" || (typeof result === "object" && result.type === "repair")) {
      return
    }
  }

  private normalizeToolInput(input: unknown): Record<string, unknown> {
    if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Record<string, unknown>
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input)
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {}
      return { _raw: input, _parseError: "Invalid JSON" }
    }
    return { _raw: String(input), _parseError: "Unexpected input type" }
  }

  private createTextPart(providerMetadata?: Record<string, unknown>) {
    return {
      id: Identifier.ascending("part"),
      messageID: this.input.assistantMessage.id,
      sessionID: this.input.assistantMessage.sessionID,
      type: "text" as const,
      text: "",
      time: {
        start: Date.now(),
      },
      metadata: providerMetadata,
    }
  }

  private async finalizeText(providerMetadata?: Record<string, unknown>) {
    if (!this.currentText) return
    this.currentText.text = this.currentText.text.trimEnd()
    const textOutput = await Plugin.trigger(
      "experimental.text.complete",
      {
        sessionID: this.input.sessionID,
        messageID: this.input.assistantMessage.id,
        partID: this.currentText.id,
      },
      { text: this.currentText.text },
    )
    this.currentText.text = textOutput.text

    const analysisWindow = await this.collectAnalysisWindow()
    const currentTurnTools = analysisWindow.tools
    const latestUserText = analysisWindow.latestUserText
    const sanitized = sanitizeAnalysisAssistantText({
      text: this.currentText.text,
      tools: currentTurnTools,
      latestUserText,
    })
    this.currentText.text = sanitized.text

    const evidence = await this.collectTurnNumericEvidence(analysisWindow.tools)
    const recovery = await recoverNumericSnapshots({
      snapshots: evidence.snapshots,
      trustedArtifactPaths: evidence.trustedArtifactPaths,
      explicitReadPaths: evidence.explicitReadPaths,
    })
    let grounding = validateNumericGrounding({
      text: this.currentText.text,
      snapshots: recovery.snapshots,
    })
    grounding = {
      ...grounding,
      trustedSourcePaths: recovery.trustedSourcePaths,
      recovered: recovery.recovered,
    }
    if (grounding.status !== "pass" && grounding.status !== "not_applicable") {
      this.currentText.text = rewriteGroundedText({
        text: this.currentText.text,
        grounding,
      })
      const postGroundingSanitized = sanitizeAnalysisAssistantText({
        text: this.currentText.text,
        tools: currentTurnTools,
        latestUserText,
      })
      this.currentText.text = postGroundingSanitized.text
    }
    this.currentText.time = {
      start: this.currentText.time?.start ?? Date.now(),
      end: Date.now(),
    }
    if (providerMetadata) this.currentText.metadata = providerMetadata
    this.currentText.metadata = {
      ...(this.currentText.metadata ?? {}),
      numericGroundingStatus:
        grounding.status === "pass"
          ? grounding.recovered
            ? "auto_recovered"
            : "grounded"
          : grounding.status === "partial"
            ? "partially_grounded"
            : grounding.status === "fail"
              ? "numeric_grounding_failed"
              : "not_applicable",
      grounding,
    }
    await Session.updatePart(this.currentText)
    this.currentText = undefined
  }

  private async ensureAnalysisFallbackText() {
    const parts = await MessageV2.parts(this.input.assistantMessage.id)
    const finalToolIndex = this.latestFinalAnalysisToolIndex(parts)
    if (finalToolIndex < 0) return

    const analysisWindow = await this.collectAnalysisWindow()
    const fallback = maybeBuildAnalysisUserViewText({
      tools: analysisWindow.tools,
      latestUserText: analysisWindow.latestUserText,
    })
    if (!fallback) return
    const fallbackText = fallback.text.trim()
    if (!fallbackText) return

    const visibleAfterFinalTool = this.visibleAnalysisTextAfterIndex({
      parts,
      afterIndex: finalToolIndex,
      tools: analysisWindow.tools,
      latestUserText: analysisWindow.latestUserText,
    })
    if (visibleAfterFinalTool.length > 0) return

    const now = Date.now()
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: this.input.assistantMessage.id,
      sessionID: this.input.assistantMessage.sessionID,
      type: "text",
      text: fallbackText,
      time: {
        start: now,
        end: now,
      },
      metadata: {
        analysisUserView: fallback.view,
        fallbackReason: "missing_visible_analysis_result_text",
      },
    })
  }

  private latestFinalAnalysisToolIndex(parts: MessageV2.Part[]) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index]
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (FINAL_ANALYSIS_RESULT_TOOLS.has(part.tool)) return index
    }
    return -1
  }

  private visibleAnalysisTextAfterIndex(input: {
    parts: MessageV2.Part[]
    afterIndex: number
    tools: AnalysisToolPartLike[]
    latestUserText?: string
  }) {
    return input.parts.slice(input.afterIndex + 1).flatMap((part) => {
      if (part.type !== "text" || part.synthetic) return []
      const text = sanitizeAnalysisAssistantText({
        text: part.text,
        tools: input.tools,
        latestUserText: input.latestUserText,
      }).text.trim()
      return text ? [text] : []
    })
  }

  private async collectAnalysisWindow() {
    const tools: AnalysisToolPartLike[] = []
    const visited = new Set<string>()
    let latestUserText: string | undefined
    let cursorID: string | undefined = this.input.assistantMessage.id

    while (cursorID && !visited.has(cursorID)) {
      visited.add(cursorID)
      const loadedMessage = await MessageV2.get({
        sessionID: this.input.sessionID,
        messageID: cursorID,
      }).catch((): unknown => undefined)
      const message = loadedMessage as MessageV2.WithParts | undefined
      if (!message) break

      if (message.info.role === "assistant") {
        for (const part of message.parts) {
          if (part.type !== "tool" || part.state.status !== "completed") continue
          tools.unshift({
            tool: part.tool,
            state: part.state,
          })
        }
      }

      const parentID: string | undefined = message.info.role === "assistant" ? message.info.parentID : undefined
      if (!parentID) break
      const loadedParent = await MessageV2.get({
        sessionID: this.input.sessionID,
        messageID: parentID,
      }).catch((): unknown => undefined)
      const parent = loadedParent as MessageV2.WithParts | undefined
      if (!parent) break
      if (parent.info.role === "user") {
        latestUserText =
          parent.parts
            .filter(
              (part: MessageV2.Part): part is MessageV2.TextPart =>
                part.type === "text" && !part.synthetic && !part.ignored,
            )
            .map((part: MessageV2.TextPart) => part.text.trim())
            .filter(Boolean)
            .join("\n") || undefined
        break
      }
      cursorID = parent.info.id
    }

    return {
      tools,
      latestUserText,
    }
  }

  private async collectTurnNumericEvidence(tools: AnalysisToolPartLike[]) {
    const snapshots = []
    const trustedArtifactPaths = new Set<string>()
    const explicitReadPaths = new Set<string>()
    const seenSnapshotPaths = new Set<string>()

    for (const part of tools) {
      for (const snapshot of await collectNumericSnapshotsFromToolMetadata(part.state.metadata)) {
        const snapshotPath = snapshot.snapshotPath ?? JSON.stringify(snapshot)
        if (seenSnapshotPaths.has(snapshotPath)) continue
        seenSnapshotPaths.add(snapshotPath)
        snapshots.push(snapshot)
      }
      for (const artifactPath of await collectTrustedArtifactPathsFromToolMetadata(part.state.metadata)) {
        trustedArtifactPaths.add(artifactPath)
      }
      if (part.tool === "read" && typeof part.state.input?.filePath === "string") {
        explicitReadPaths.add(part.state.input.filePath)
      }
    }

    return {
      snapshots,
      trustedArtifactPaths: [...trustedArtifactPaths],
      explicitReadPaths: [...explicitReadPaths],
    }
  }
}
