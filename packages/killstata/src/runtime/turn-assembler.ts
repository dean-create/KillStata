import { Identifier } from "@/id/id"
import { MessageV2 } from "@/session/message-v2"
import { ToolUseLoopFailureError } from "@/runtime/engine/types"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import type { Provider } from "@/provider/provider"
import type { QueryEvent, QueryRuntimeResult, WorkflowInputIntent } from "./types"
import { maybeBuildAnalysisUserViewTexts } from "./analysis-user-view"
import { isAnalysisTurn } from "./analysis-user-view"
import {
  collectTrustedArtifactPathsFromToolMetadata,
  collectNumericSnapshotsFromToolMetadata,
  numericSnapshotFromAnalysisView,
  recoverNumericSnapshots,
  rewriteGroundedText,
  validateNumericGrounding,
  type NumericSnapshotDocument,
} from "@/tool/analysis-grounding"
import {
  containsEngineInternalData,
  sanitizeAnalysisAssistantText,
  userFacingAnalysisErrorText,
  type AnalysisToolPartLike,
} from "./analysis-text-sanitizer"
import { WORKFLOW_ANALYSIS_TOOL_IDS } from "./tool-catalog"
import { readToolAnalysisView } from "@/tool/analysis-user-view"
import { isWorkflowConsultation } from "@/runtime/input-intent"

// 注意：这里含 regression_table / research_brief / paper_draft / slide_generator 以及
// 已下线的 mega 工具 econometrics —— 它们当前都没有实现，也不在 TOOL_MANIFEST 里。
// 保留是因为本集合按 tool name 匹配**历史消息**做渲染：删掉会让老会话的工具卡片
// 退化成裸 ID，而且没有任何测试会失败（仓库里没有历史会话 fixture）。
// 这是展示层的历史兼容名单，不代表这些工具当前可被调度。
const FINAL_ANALYSIS_RESULT_TOOLS = new Set([
  ...WORKFLOW_ANALYSIS_TOOL_IDS,
  "econometrics_execute",
  "econometrics",
  "regression_table",
  "heterogeneity_runner",
  "research_brief",
  "paper_draft",
  "slide_generator",
])

export function isFinalAnalysisResultTool(toolName: string) {
  return FINAL_ANALYSIS_RESULT_TOOLS.has(toolName)
}

const IMPORT_SHEET_DISCLOSURE_LINE = /^已确认工作表[：:].*（本次导入）。?$/
const ANALYSIS_DISCLOSURE_LINE = /^已核验的(?:核心回归结果|.+回归(?:结果|补充)|面板设定)[：:].*$/

function comparableAnalysisDisclosure(line: string) {
  return line.trim().replace(/\s+/g, "").replace(/[。！？.!?]+$/u, "")
}

function isStrictAnalysisDisclosurePrefix(shorter: string, longer: string) {
  const shortText = comparableAnalysisDisclosure(shorter)
  const longText = comparableAnalysisDisclosure(longer)
  return longText.length > shortText.length && longText.startsWith(shortText)
}

/**
 * 一个 assistant message 可能包含多段短进度。每段都会看到同一个 data_import 事实，
 * 如果逐段补充工作表说明，用户会连续看到相同的“已确认工作表”。只在持久化边界
 * 去掉同一 assistant message 中已经出现过的完全相同说明，不影响不同工作表或其他正文。
 */
function removeRepeatedImportSheetDisclosure(text: string, previousTexts: string[]) {
  const seen = new Set<string>()
  for (const previous of previousTexts) {
    for (const line of previous.split(/\r?\n/)) {
      const normalized = line.trim().replace(/\s/g, "")
      if (IMPORT_SHEET_DISCLOSURE_LINE.test(normalized)) seen.add(normalized)
    }
  }

  return text
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim().replace(/\s/g, "")
      if (!IMPORT_SHEET_DISCLOSURE_LINE.test(normalized)) return true
      if (seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
    .join("\n")
}

/**
 * 同一 assistant 消息可能跨多个模型回合，甚至在同一个流式文本片段内重复生成
 * 相同的结构化核验摘要。跨回合的重复摘要全部跳过；当前文本首次出现的摘要保留，
 * 后续完全相同的行跳过。不同方法、不同数值和完整报告正文保持不变。
 */
function removeRepeatedAnalysisDisclosure(text: string, previousTexts: string[]) {
  const previousSeen = new Set<string>()
  for (const previous of previousTexts) {
    for (const line of previous.split(/\r?\n/)) {
      const normalized = line.trim()
      if (ANALYSIS_DISCLOSURE_LINE.test(normalized)) previousSeen.add(normalized)
    }
  }

  const seen = new Set<string>()
  const currentDisclosureLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => ANALYSIS_DISCLOSURE_LINE.test(line))
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim()
      if (!ANALYSIS_DISCLOSURE_LINE.test(normalized)) return true
      if (previousSeen.has(normalized) || seen.has(normalized)) return false
      // 模型有时先输出“系数”，再输出同一方法附带样本量的更完整版本；只删除
      // 严格被当前文本中更长事实覆盖的短行，不合并不同数值或不同规格。
      if (currentDisclosureLines.some((candidate) => isStrictAnalysisDisclosurePrefix(normalized, candidate))) return false
      seen.add(normalized)
      return true
    })
    .join("\n")
}

/**
 * 多模型正文已经按小节完整展开时，前置的“已核验摘要”只是同一轮的重复回声。
 * 仅在同时识别到 OLS 与面板小节时移除正文前的核验行；单模型或无法确认正文
 * 完整性的文本仍保留即时核验提示。
 */
function removeRedundantAnalysisLeadIns(text: string) {
  const lines = text.split(/\r?\n/)
  const firstHeading = lines.findIndex((line) => /^#{1,6}\s+/.test(line.trim()))
  const firstBodyHeading = firstHeading >= 0
    ? firstHeading
    : lines.findIndex((line) => /^\s*\*{2}[^\n]+\*{2}\s*$/.test(line))
  if (firstBodyHeading < 0) return text
  const body = lines.slice(firstBodyHeading).join("\n")
  const hasOlsSection =
    /(?:^|\n)#{1,6}\s+[^\n]*(?:OLS|普通最小二乘)/i.test(body) ||
    /(?:^|\n)\s*\*{2}[^\n]*(?:OLS|普通最小二乘)[^\n]*\*{2}\s*(?:\n|$)/i.test(body)
  const hasPanelSection =
    /(?:^|\n)#{1,6}\s+[^\n]*(?:双向固定效应|面板固定效应)/i.test(body) ||
    /(?:^|\n)\s*\*{2}[^\n]*(?:双向固定效应|面板固定效应)[^\n]*\*{2}\s*(?:\n|$)/i.test(body)
  if (!hasOlsSection || !hasPanelSection) return text
  return lines
    .filter((line, index) => index >= firstBodyHeading || !ANALYSIS_DISCLOSURE_LINE.test(line.trim()))
    .join("\n")
}

/**
 * 模型有时在生成多模型汇报时，已经写出开头和小节标题，却在正文前提前结束。
 * 这不是“没有正文”，因此仅检查文本是否为空会错过结构化结果兜底；只把明显停在
 * 标题/进度句的分析文本判为不完整，避免覆盖正常的简短结论。
 */
function isIncompleteAnalysisText(text: string) {
  const normalized = text.trim()
  if (!normalized) return true

  const lastLine = normalized.split(/\r?\n/).filter((line) => line.trim()).at(-1)?.trim() ?? ""
  const hasMetric = /系数|标准误|p\s*值|有效样本|样本|\bN\s*=|R²/i.test(normalized)
  const lastLineHasMetric = /系数|标准误|p\s*值|有效样本|样本|\bN\s*=|R²/i.test(lastLine)
  const isSectionHeading =
    /^(?:\*{1,3}\s*)?\d+[.、]\s*/.test(lastLine) &&
    /OLS|回归|模型|固定效应|双重差分|工具变量|倾向得分|断点/i.test(lastLine) &&
    !lastLineHasMetric
  const isStandaloneBoldHeading = /^\*\*(?!\*)[^*\n]+(?<!\*)\*\*$/.test(lastLine)

  if (isSectionHeading || /^#{1,6}\s+/.test(lastLine) || isStandaloneBoldHeading) return true

  // 只有进度/完成句而没有任何可交付统计量时，也交给结构化结果生成最小摘要。
  return normalized.length < 180 && !hasMetric && /回归|估计|计量分析|分析结果/.test(normalized)
}

/**
 * 工具失败后模型可能只留下“我先尝试……”之类的进度句。它不是最终结论，
 * 不能挡住框架生成的可操作失败停点；已有事实、结果或明确停点则必须保留。
 */
function isProgressOnlyFailureText(text: string) {
  const normalized = text.trim()
  if (normalized.length === 0 || normalized.length > 280) return false
  if (!/^(?:理解|我先|先|正在|开始|好的|收到)/.test(normalized)) return false
  return !/(?:完成|结果|失败|错误|无法|不满足|四格|请确认|停止|样本|系数|标准误|p\s*值|R²)/i.test(normalized)
}

function isMethodSwitchProgressText(text: string) {
  const normalized = text.trim()
  if (normalized.length === 0 || normalized.length > 600) return false
  if (!/(?:需要[^。\n]*(?:构造|检查)|先[^。\n]*(?:检查|构造)|正在[^。\n]*(?:执行|构造)|准备[^。\n]*(?:执行|调用))/i.test(normalized)) return false
  return !/(?:已生成|已完成估计|估计结果|系数|p\s*值|标准误|样本量)/i.test(normalized)
}

export class TurnAssembler {
  private toolcalls: Record<string, MessageV2.ToolPart> = {}
  private reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
  private currentText: MessageV2.TextPart | undefined

  constructor(
    private readonly input: {
      assistantMessage: MessageV2.Assistant
      sessionID: string
      model: Provider.Model
      inputIntent?: WorkflowInputIntent
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
            modelOutput: event.output.modelOutput,
            outputReference: event.output.outputReference,
            metadata: event.output.metadata,
            title: event.output.title,
            attachments: event.output.attachments as MessageV2.FilePart[] | undefined,
            modelAttachments: event.output.modelAttachments as MessageV2.FilePart[] | undefined,
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
            metadata: {
              ...(match.state.metadata ?? {}),
              ...(event.metadata ?? {}),
              ...(event.blocked ? { blocked: true } : {}),
              ...(event.skipped ? { skipped: true } : {}),
            },
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
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: this.input.assistantMessage.id,
          sessionID: this.input.sessionID,
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
          messageID: this.input.assistantMessage.id,
          sessionID: this.input.assistantMessage.sessionID,
          type: "step-finish",
          tokens: usage.tokens,
          cost: usage.cost,
        })
        await Session.updateMessage(this.input.assistantMessage)
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

    const parts = await MessageV2.parts(this.input.assistantMessage.id)
    const skippedAfterPriorToolFailure = typeof result === "object" && result.type === "repair"
    const toolLoopFailure = error instanceof ToolUseLoopFailureError ? error : undefined
    const skippedAfterUserDecision = parts.some(
      (part) => part.type === "tool" && part.state.status === "completed" && part.state.metadata?.requiresUserDecision === true,
    )
    for (const part of parts) {
      if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
        const unconfirmedByLoopFailure = Boolean(
          toolLoopFailure && (!toolLoopFailure.callIDs.length || toolLoopFailure.callIDs.includes(part.callID)),
        )
        await Session.updatePart({
          ...part,
          state: {
            ...part.state,
            status: "error",
            error: skippedAfterPriorToolFailure
              ? "本批次工具调用未执行：前序工具失败，已交由下一轮重新规划。"
              : skippedAfterUserDecision
                ? "本批次工具调用未执行：前一项操作需要用户决定，已按用户选择暂停。"
                : unconfirmedByLoopFailure
                  ? `工具执行循环在 ${toolLoopFailure!.stage} 阶段中断；该调用结果状态未确认。请先核对当前阶段和产物，再决定是否继续。`
                : "Tool execution aborted",
            metadata: {
              ...(part.state.status === "running" ? part.state.metadata : {}),
              ...(skippedAfterPriorToolFailure ? { skippedAfterPriorToolFailure: true } : {}),
              ...(skippedAfterUserDecision ? { skippedAfterUserDecision: true } : {}),
              ...(unconfirmedByLoopFailure && toolLoopFailure
                ? { unconfirmed: true, failureStage: toolLoopFailure.stage }
                : {}),
            },
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          },
        })
      }
    }

    // compact 是框架要求切换到摘要阶段的控制信号，不是用户可见的模型故障。
    if (error && result !== "compact") {
      this.input.assistantMessage.error = MessageV2.fromError(error, {
        providerID: this.input.model.providerID,
      })
    }

    this.input.assistantMessage.time.completed = Date.now()
    await Session.updateMessage(this.input.assistantMessage)
    // Compaction summaries are internal context artifacts, not user-facing analysis text.
    // Running user-visible fallback generators here can append unrelated analysis prose to
    // the model summary even after its XML has been finalized.
    if (this.input.assistantMessage.mode === "compaction") return
    await this.ensureUserDecisionFallbackText()
    await this.ensureExportFallbackText()
    await this.ensureConsultationFallbackText()
    await this.ensureAnalysisFallbackText()
    await this.ensureMethodSwitchFallbackText()
    await this.ensureStatusFallbackText()
    // repair 是会话内部的中间态：外层 dispatch 还会把修复上下文交给模型继续
    // 执行。此时写入“本轮操作未完成”会把可恢复波折错误展示成终止结果，随后又
    // 出现成功结果，用户体验和 drive 诊断都会被污染；只有真正 stop 才生成失败停点。
    if (!(typeof result === "object" && result.type === "repair")) {
      await this.ensureFailureFallbackText(error, result === "stop")
    }
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
    const rawStreamedText = this.currentText.text.trim()
    if (this.input.assistantMessage.mode === "compaction") {
      this.currentText.text = rawStreamedText
      this.currentText.time = {
        start: this.currentText.time?.start ?? Date.now(),
        end: Date.now(),
      }
      if (providerMetadata) this.currentText.metadata = providerMetadata
      await Session.updatePart(this.currentText)
      this.currentText = undefined
      return
    }
    const internalVerifierEnvelope = this.input.assistantMessage.agent === "verifier"
      ? /<verifier_result>\s*[\s\S]*?<\/verifier_result>/i.exec(rawStreamedText)?.[0]
      : undefined
    const analysisWindow = await this.collectAnalysisWindow()
    const currentTurnTools = (await MessageV2.parts(this.input.assistantMessage.id)).flatMap((part) =>
      part.type === "tool" && part.state.status === "completed"
        ? [{ tool: part.tool, state: part.state } satisfies AnalysisToolPartLike]
        : [],
    )
    const analysisTools = analysisWindow.tools
    const latestUserText = analysisWindow.latestUserText
    const analysisTurn = isAnalysisTurn(analysisTools, latestUserText)
    const sanitized = sanitizeAnalysisAssistantText({
      text: this.currentText.text,
      tools: analysisTools,
      currentTurnTools,
      latestUserText,
    })
    this.currentText.text = sanitized.text
    if (internalVerifierEnvelope) {
      this.currentText.text = ""
      this.currentText.metadata = {
        ...(this.currentText.metadata ?? {}),
        internalVerifierEnvelope,
      }
    }

    let grounding = {
      status: "not_applicable",
      issues: [],
      snapshotPaths: [],
      trustedSourcePaths: [],
      redactions: [],
      unverifiedMetrics: [],
      recovered: false,
    } as ReturnType<typeof validateNumericGrounding>

    if (analysisTurn) {
      const evidence = await this.collectTurnNumericEvidence(analysisTools)
      const recovery = await recoverNumericSnapshots({
        snapshots: evidence.snapshots,
        trustedArtifactPaths: evidence.trustedArtifactPaths,
        explicitReadPaths: evidence.explicitReadPaths,
      })
      grounding = validateNumericGrounding({
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
          tools: analysisTools,
          currentTurnTools,
          latestUserText,
        })
        this.currentText.text = postGroundingSanitized.text
      }
    }

    const finalText = this.currentText.text.trim()
    if (!analysisTurn && !finalText && rawStreamedText && !containsEngineInternalData(rawStreamedText)) {
      this.currentText.text = rawStreamedText
      this.currentText.metadata = {
        ...(this.currentText.metadata ?? {}),
        finalizeFallback: "preserve_non_analysis_stream_text",
      }
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
    const previousTexts = (await MessageV2.parts(this.input.assistantMessage.id))
      .filter((part): part is MessageV2.TextPart => part.type === "text" && part.id !== this.currentText?.id)
      .map((part) => part.text)
    this.currentText.text = removeRepeatedImportSheetDisclosure(this.currentText.text, previousTexts)
    this.currentText.text = removeRepeatedAnalysisDisclosure(this.currentText.text, previousTexts)
    this.currentText.text = removeRedundantAnalysisLeadIns(this.currentText.text)
    await Session.updatePart(this.currentText)
    this.currentText = undefined
  }

  private async ensureAnalysisFallbackText() {
    const parts = await MessageV2.parts(this.input.assistantMessage.id)
    const finalToolIndex = this.latestFinalAnalysisToolIndex(parts)
    if (finalToolIndex < 0) return

    const analysisWindow = await this.collectAnalysisWindow()
    const fallbacks = maybeBuildAnalysisUserViewTexts({
      tools: analysisWindow.tools,
      latestUserText: analysisWindow.latestUserText,
    })
    if (fallbacks.length === 0) return
    const fallbackText = sanitizeAnalysisAssistantText({
      text: fallbacks.map((fallback) => fallback.text.trim()).filter(Boolean).join("\n\n"),
      tools: analysisWindow.tools,
      latestUserText: analysisWindow.latestUserText,
    }).text.trim()
    if (!fallbackText) return

    const visibleTextParts = parts.slice(finalToolIndex + 1).filter(
      (part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic,
    )
    const latestVisibleText = visibleTextParts.at(-1)
    const finalTool = parts[finalToolIndex]
    const isMethodRecommendation = finalTool?.type === "tool" && finalTool.tool === "econometrics_recommend"
    const incompleteVisibleText = latestVisibleText && !isMethodRecommendation
      ? isIncompleteAnalysisText(latestVisibleText.text)
      : false
    const visibleAfterFinalTool = this.visibleAnalysisTextAfterIndex({
      parts,
      afterIndex: finalToolIndex,
      tools: analysisWindow.tools,
      latestUserText: analysisWindow.latestUserText,
    })
    if (visibleAfterFinalTool.length > 0 && !incompleteVisibleText) return

    if (latestVisibleText && incompleteVisibleText) {
      await Session.updatePart({
        ...latestVisibleText,
        text: fallbackText,
        time: {
          start: latestVisibleText.time?.start ?? Date.now(),
          end: Date.now(),
        },
        metadata: {
          ...(latestVisibleText.metadata ?? {}),
          analysisUserView: fallbacks[0]?.view,
          ...(fallbacks.length > 1 ? { fallbackAnalysisUserViews: fallbacks.map((fallback) => fallback.view) } : {}),
          fallbackReason: "incomplete_visible_analysis_result_text",
        },
      })
      return
    }

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
        analysisUserView: fallbacks[0]?.view,
        ...(fallbacks.length > 1 ? { fallbackAnalysisUserViews: fallbacks.map((fallback) => fallback.view) } : {}),
        fallbackReason: "missing_visible_analysis_result_text",
      },
    })
  }

  /**
   * 用户明确要求切换计量方法时，模型可能只完成了几次只读检查就结束本轮。
   * 这类轮次没有最终估计工具可供 analysisView 兜底，但也不能留下空白气泡；
   * 只在没有真实工具错误时说明“尚未生成结果”和缺失的研究设计前提。
   */
  private async ensureMethodSwitchFallbackText() {
    const parts = await MessageV2.parts(this.input.assistantMessage.id)
    const visibleText = parts.findLast(
      (part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && part.text.trim().length > 0,
    )
    if (visibleText && !isProgressOnlyFailureText(visibleText.text) && !isMethodSwitchProgressText(visibleText.text)) return
    if (parts.some((part) =>
      part.type === "tool" &&
      part.state.status === "error" &&
      typeof part.state.error === "string" &&
      !/Tool execution aborted|已停止本次工具执行|用户已停止本次工具执行/i.test(part.state.error),
    )) return

    const analysisWindow = await this.collectAnalysisWindow()
    const latestUserText = analysisWindow.latestUserText ?? ""
    if (!/(?:did2s|两阶段双重差分|交错(?:处理)?|错位(?:处理)?)/i.test(latestUserText)) return
    if (!parts.some((part) => part.type === "tool" && part.state.status === "completed" && part.tool === "data_import")) return

    const now = Date.now()
    const text = "已收到切换到两阶段双重差分的请求。本轮已完成数据检查，但尚未生成新的两阶段双重差分结果；相对时期或首次处理时期编码仍需确认。请确认研究设计后再继续。"
    if (visibleText) {
      await Session.updatePart({
        ...visibleText,
        text,
        time: { start: visibleText.time?.start ?? now, end: now },
        metadata: { ...(visibleText.metadata ?? {}), fallbackReason: "progress_replaced_by_method_switch_text" },
      })
      return
    }
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: this.input.assistantMessage.id,
      sessionID: this.input.sessionID,
      type: "text",
      text,
      time: { start: now, end: now },
      metadata: { fallbackReason: "missing_visible_method_switch_text" },
    } satisfies MessageV2.TextPart)
  }

  /**
   * 工具可以“正常返回”但要求用户决定下一步（例如列名不存在、面板键不唯一）。
   * 这不是工具 error，因而不能依赖失败兜底；如果模型没有生成正文，直接把经过
   * 同一展示净化的决策说明交给用户，避免被更早的数据导入摘要覆盖。
   */
  private async ensureUserDecisionFallbackText() {
    const parts = await MessageV2.parts(this.input.assistantMessage.id)
    const hasVisibleText = parts.some(
      (part) => part.type === "text" && !part.synthetic && part.text.trim().length > 0,
    )
    if (hasVisibleText) return

    const decisionPart = [...parts].reverse().find(
      (part) =>
        part.type === "tool" &&
        part.state.status === "completed" &&
        part.state.metadata?.requiresUserDecision === true &&
        typeof part.state.output === "string" &&
        part.state.output.trim().length > 0,
    )
    if (!decisionPart || decisionPart.type !== "tool" || decisionPart.state.status !== "completed") return
    const decisionOutput = decisionPart.state.output
    if (typeof decisionOutput !== "string" || !decisionOutput.trim()) return

    const analysisWindow = await this.collectAnalysisWindow()
    const sanitized = sanitizeAnalysisAssistantText({
      text: decisionOutput,
      tools: analysisWindow.tools,
      latestUserText: analysisWindow.latestUserText,
    }).text.trim()
    if (!sanitized || containsEngineInternalData(sanitized)) return

    const now = Date.now()
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: this.input.assistantMessage.id,
      sessionID: this.input.sessionID,
      type: "text",
      text: sanitized,
      time: { start: now, end: now },
      metadata: { fallbackReason: "missing_visible_user_decision" },
    } satisfies MessageV2.TextPart)
  }

  /**
   * 咨询轮通常不需要工具，但仍必须有文字回答。若 Provider 返回空正文，复用上一
   * 用户动作的已核验结果，并明确本轮没有执行新的稳健性检验，避免把咨询误变成空白。
   */
  /**
   * 结果交付是用户请求的一部分。模型可能在查询可信产物后因流中断或提前结束而
   * 没有生成正文；此时至少要明确“找到但尚未交付”，避免空白气泡被误读为成功。
   * 若交付工具已经完成，则直接展示其用户可读的成功回执，不能要求模型再猜一次。
   */
  private async ensureExportFallbackText() {
    const parts = await MessageV2.parts(this.input.assistantMessage.id)
    if (parts.some((part) => part.type === "text" && !part.synthetic && part.text.trim().length > 0)) return
    const analysisWindow = await this.collectAnalysisWindow()
    const latestUserText = analysisWindow.latestUserText ?? ""
    if (!/(?:导出.*(?:回归|结果)|(?:回归|结果).*导出)/i.test(latestUserText)) return

    const completedPipelineTools = parts.filter(
      (part): part is Extract<typeof part, { type: "tool" }> =>
        part.type === "tool" && part.state.status === "completed" && part.tool === "pipeline",
    )
    const delivery = completedPipelineTools.find((part) => part.state.input?.action === "export_artifact")
    const artifactLookup = completedPipelineTools.some((part) => part.state.input?.action === "artifacts")
    if (!delivery && !artifactLookup) return

    const deliveryOutput = delivery && delivery.state.status === "completed" ? delivery.state.output : undefined
    const raw = deliveryOutput?.trim() || "已找到可信的回归结果文件，但本轮尚未完成结果文件交付。"
    const text = sanitizeAnalysisAssistantText({
      text: raw,
      tools: analysisWindow.tools,
      latestUserText,
    }).text.trim()
    if (!text || containsEngineInternalData(text)) return
    const now = Date.now()
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: this.input.assistantMessage.id,
      sessionID: this.input.sessionID,
      type: "text",
      text,
      time: { start: now, end: now },
      metadata: { fallbackReason: delivery ? "missing_visible_export_success" : "missing_visible_export_progress" },
    } satisfies MessageV2.TextPart)
  }

  private async ensureConsultationFallbackText() {
    const currentParts = await MessageV2.parts(this.input.assistantMessage.id)
    if (currentParts.some((part) => part.type === "text" && !part.synthetic && part.text.trim())) return

    const currentWindow = await this.collectAnalysisWindow()
    const latestUserText = currentWindow.latestUserText ?? await this.latestUserTextByMessageOrder()
    if (!latestUserText || !isWorkflowConsultation(latestUserText)) return

    const previousTools: AnalysisToolPartLike[] = []
    let reachedCurrentAssistant = false
    let reachedCurrentUser = false
    for await (const message of MessageV2.streamSinceCompactBoundary(this.input.sessionID)) {
      if (!reachedCurrentAssistant) {
        if (message.info.id === this.input.assistantMessage.id) reachedCurrentAssistant = true
        continue
      }
      if (!reachedCurrentUser) {
        if (message.info.role === "user") {
          reachedCurrentUser = true
        }
        continue
      }
      if (message.info.role === "user") break
      if (message.info.role !== "assistant") continue
      for (const part of message.parts) {
        if (part.type === "tool" && part.state.status === "completed") {
          previousTools.push({ tool: part.tool, state: part.state })
        }
      }
    }
    // 真实 repair 流可能插入 synthetic user/assistant 消息，导致上面的 parent 链
    // 不再经过上一轮结果 assistant。此时按持久化消息的时间顺序回溯到当前用户消息
    // 之前，补取最近已完成的计量工具；这是只读展示兜底，不会重新执行任何工具。
    if (previousTools.length === 0) {
      const orderedMessages = await Session.messages({ sessionID: this.input.sessionID })
      const currentAssistantIndex = orderedMessages.findIndex((message) => message.info.id === this.input.assistantMessage.id)
      const currentAssistant = currentAssistantIndex >= 0 ? orderedMessages[currentAssistantIndex] : undefined
      const currentAssistantParentID = currentAssistant?.info.role === "assistant"
        ? currentAssistant.info.parentID
        : undefined
      const currentUserIndex = currentAssistantParentID
        ? orderedMessages.findIndex((message) => message.info.id === currentAssistantParentID)
        : currentAssistantIndex
      const cutoff = currentUserIndex >= 0 ? currentUserIndex : currentAssistantIndex
      for (const message of orderedMessages.slice(0, cutoff)) {
        if (message.info.role !== "assistant") continue
        for (const part of message.parts) {
          if (part.type === "tool" && part.state.status === "completed") {
            previousTools.push({ tool: part.tool, state: part.state })
          }
        }
      }
    }
    const fallback = maybeBuildAnalysisUserViewTexts({
      tools: previousTools,
      latestUserText,
    })[0]
    if (!fallback?.text.trim()) return

    const text = [
      sanitizeAnalysisAssistantText({
        text: fallback.text.trim(),
        tools: previousTools,
        latestUserText,
      }).text.trim(),
      "关于当前问题：仅凭上述一次估计不能确认结果是否稳健；本轮尚未执行新的稳健性检验。若要继续，请先确认具体方案，我再按选择执行。",
    ].join("\n\n")
    const now = Date.now()
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: this.input.assistantMessage.id,
      sessionID: this.input.sessionID,
      type: "text",
      text,
      time: { start: now, end: now },
      metadata: { fallbackReason: "missing_visible_consultation_text", analysisUserView: fallback.view },
    } satisfies MessageV2.TextPart)
  }

  /**
   * 状态查询有时只调用 pipeline(status) 就以 tool-calls 结束，模型没有生成任何正文。
   * 状态工具返回的是内部结构，不能直接展示；这里仅依据稳定事实生成最小中文回复，
   * 让“跑完了吗”不会变成空白气泡，也不会把 workflow/dataset 字段泄漏给用户。
   */
  private async ensureStatusFallbackText() {
    if (this.input.inputIntent !== "status") return
    const parts = await MessageV2.parts(this.input.assistantMessage.id)
    const hasSubstantiveStatusText = parts.some((part) => {
      if (part.type !== "text" || part.synthetic) return false
      const text = part.text.trim()
      if (text.length < 40) return false
      return !/^(?:我先|先查询|正在查询|查询当前|我来查询|正在查看)/.test(text)
    })
    // “我先查询……”这类进度句已经落盘，但不包含状态事实；如果把它当作正文，
    // pipeline(status) 的真实结果就不会触发兜底，用户看到的仍是一句空话。
    if (hasSubstantiveStatusText) return

    const statusPart = [...parts].reverse().find((part) =>
      part.type === "tool" &&
      part.tool === "pipeline" &&
      part.state.status === "completed" &&
      part.state.input?.action === "status",
    )
    if (!statusPart || statusPart.type !== "tool") return
    if (statusPart.state.status !== "completed") return

    let parsed: unknown
    try {
      parsed = JSON.parse(statusPart.state.output ?? "")
    } catch {
      parsed = undefined
    }
    const record = (value: unknown): Record<string, unknown> | undefined =>
      value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    const workflow = record(record(parsed)?.workflowState)
    const verifier = record(workflow?.verifier)
    const checklist = record(workflow?.currentChecklistItem)
    const activeNode = record(workflow?.activeWorkflowNode)
    const nodeStatus = activeNode?.status
    const trustedArtifactCount = verifier?.trustedArtifactCount
    const text = workflow?.latestFailure
      ? "当前任务在上一阶段暂停，原因已记录；未完成的内容不会被当作成功结果。请根据上方提示确认下一步。"
      : checklist?.status === "pending" && checklist?.label === "结果报告" && Number(trustedArtifactCount) > 0
        ? "前面的数据处理和计量估计已完成，结果已经生成；正式报告文档尚未整理。"
        : nodeStatus === "running"
          ? "当前任务仍在执行中，系统会在本轮完成后继续汇报。"
          : "当前任务状态已核验，暂未发现新的阻断；请告诉我下一步要继续哪项分析。"

    const now = Date.now()
    const progressText = parts.findLast(
      (part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic,
    )
    if (progressText) {
      await Session.updatePart({
        ...progressText,
        text,
        time: { start: progressText.time?.start ?? now, end: now },
        metadata: { ...(progressText.metadata ?? {}), fallbackReason: "missing_status_response_text" },
      })
      return
    }
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: this.input.assistantMessage.id,
      sessionID: this.input.sessionID,
      type: "text",
      text,
      time: { start: now, end: now },
      metadata: { fallbackReason: "missing_status_response_text" },
    } satisfies MessageV2.TextPart)
  }

  /**
   * 不可恢复错误可能让模型只留下 tool-error，没有任何正文。此时不能把空白气泡
   * 交给用户，也不能把内部错误原样展示；生成一条安全停点，明确“已停止”和下一步。
   * 取消没有 error，不进入此兜底，避免把用户主动停止说成故障。
   */
  private async ensureFailureFallbackText(error?: unknown, terminalStop = false) {
    const parts = await MessageV2.parts(this.input.assistantMessage.id)
    // 工具错误可能通过 AgentEngine 的 stop 决策结束本轮，未作为 processor 的 error
    // 参数透传；此时仍要从已经落盘的失败工具中提取可行动原因，不能让用户看到空白。
    const failedTool = [...parts].reverse().find((part) =>
      part.type === "tool" && part.state.status === "error" &&
      typeof part.state.error === "string" &&
      !/Tool execution aborted|已停止本次工具执行|用户已停止本次工具执行/i.test(part.state.error),
    )
    const effectiveError = error ?? (
      failedTool?.type === "tool" && failedTool.state.status === "error"
        ? new Error(failedTool.state.error)
        : undefined
    )
    if (!effectiveError) return

    const visibleText = parts.findLast(
      (part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && part.text.trim().length > 0,
    )
    const raw = effectiveError instanceof Error ? effectiveError.message : String(effectiveError)
    const text = effectiveError instanceof Session.TimeoutError
      ? `本轮等待超过${effectiveError.timeoutMs}毫秒，已停止继续执行；已完成的数据和结果会保留。请确认下一步处理方式。`
      : userFacingAnalysisErrorText(raw) ?? "本轮操作未完成，系统已停止自动尝试；已有数据和结果不会被覆盖。请确认下一步处理方式。"
    const isFourCellDesignStop = /传统\s*(?:2[×x*]2\s*)?DID[^。\n]*(?:四个样本单元|四格样本结构)/i.test(raw)
    // 只有明显的进度句，或已确认的“四格不足”终止错误但正文没有该事实时，才
    // 替换现有文字。正常成功结果即使同一轮曾有过可恢复错误，也必须原样保留。
    if (
      visibleText &&
      !isProgressOnlyFailureText(visibleText.text) &&
      !(terminalStop && isFourCellDesignStop && !/(?:四格|四个样本单元|传统 2×2 DID)/.test(visibleText.text))
    ) return
    const now = Date.now()
    if (visibleText) {
      await Session.updatePart({
        ...visibleText,
        text,
        time: { start: visibleText.time?.start ?? now, end: now },
        metadata: { ...(visibleText.metadata ?? {}), fallbackReason: "progress_replaced_by_failure_text" },
      })
      return
    }
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: this.input.assistantMessage.id,
      sessionID: this.input.sessionID,
      type: "text",
      text,
      time: { start: now, end: now },
      metadata: { fallbackReason: "missing_visible_failure_text" },
    } satisfies MessageV2.TextPart)
  }

  private latestFinalAnalysisToolIndex(parts: MessageV2.Part[]) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index]
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (isFinalAnalysisResultTool(part.tool)) return index
      // 只读数据检查结果会关闭下一轮工具，只给模型一次文字收尾机会；如果
      // Provider 返回空正文，仍要让统一的结构化分析视图兜底交付质量事实。
      if (
        part.tool === "data_import" &&
        part.state.metadata?.finalizeTextOnly === true
      ) return index
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
      let loadedMessage: unknown
      try {
        loadedMessage = await MessageV2.get({
          sessionID: this.input.sessionID,
          messageID: cursorID,
        })
      } catch {
        loadedMessage = undefined
      }
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
      let loadedParent: unknown
      try {
        loadedParent = await MessageV2.get({
          sessionID: this.input.sessionID,
          messageID: parentID,
        })
      } catch {
        loadedParent = undefined
      }
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

    // repair/verifier/synthetic 消息可能让 parentID 指向旧 assistant；消息流的时间顺序
    // 仍然可靠，因此用当前 assistant 之前最近的真实 user 校正本轮用户文本。
    const orderedUserText = await this.latestUserTextByMessageOrder()
    if (orderedUserText) latestUserText = orderedUserText

    return {
      tools,
      latestUserText,
    }
  }

  private async latestUserTextByMessageOrder() {
    let reachedCurrentAssistant = false
    for await (const message of MessageV2.streamSinceCompactBoundary(this.input.sessionID)) {
      if (!reachedCurrentAssistant) {
        if (message.info.id === this.input.assistantMessage.id) reachedCurrentAssistant = true
        continue
      }
      if (message.info.role !== "user") continue
      const text = message.parts
        .filter(
          (part: MessageV2.Part): part is MessageV2.TextPart =>
            part.type === "text" && !part.synthetic && !part.ignored,
        )
        .map((part: MessageV2.TextPart) => part.text.trim())
        .filter(Boolean)
        .join("\n")
      if (text) return text
    }
    return undefined
  }

  private async collectTurnNumericEvidence(tools: AnalysisToolPartLike[]) {
    const snapshots: NumericSnapshotDocument[] = []
    const trustedArtifactPaths = new Set<string>()
    const explicitReadPaths = new Set<string>()
    const seenSnapshotPaths = new Set<string>()

    for (const part of tools) {
      const view = readToolAnalysisView(part.state.metadata)
      const candidateSnapshots = [
        ...(await collectNumericSnapshotsFromToolMetadata(part.state.metadata)),
        ...(view ? [numericSnapshotFromAnalysisView({ tool: part.tool, view })] : []),
      ]
      for (const snapshot of candidateSnapshots) {
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
