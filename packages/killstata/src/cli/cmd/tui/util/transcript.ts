import type { AssistantMessage, Part, UserMessage } from "@killstata/sdk/v2"
import { Locale } from "@/util/locale"
import { renderToolDisplay } from "@/tool/analysis-display"
import {
  sanitizeAnalysisAssistantText,
  userFacingAnalysisErrorText,
  type AnalysisToolPartLike,
} from "@/runtime/analysis-text-sanitizer"
import { isAnalysisTurn } from "@/runtime/analysis-user-view"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  pendingAccessMessageIDs?: Set<string>
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

const INTERNAL_ANALYSIS_TRANSCRIPT_TOOLS = new Set([
  "glob",
  "grep",
  "list",
  "read",
  "workflow",
  "skill",
  "invalid",
  "todowrite",
  "todoread",
])

const INTERNAL_ANALYSIS_ERROR_PATTERNS = [
  /Cannot read .* as text/i,
  /Cannot read binary file/i,
  /Model tried to call unavailable tool/i,
  /\bartifactRefs\b/i,
  /\blatestTrustedArtifacts\b/i,
  /\bworkflowRunId\b/i,
  /\btrustedArtifacts\b/i,
  /^Bash \[command=/i,
]

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  let transcript = `# ${session.title}\n\n`
  transcript += `**Session ID:** ${session.id}\n`
  transcript += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  transcript += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  transcript += `---\n\n`

  let latestUserText: string | undefined
  for (const msg of messages) {
    latestUserText = msg.info.role === "user" ? (collectUserText(msg.parts) ?? latestUserText) : latestUserText
    transcript += formatMessage(msg.info, msg.parts, options, latestUserText)
    transcript += `---\n\n`
  }

  return transcript
}

export function formatMessage(
  msg: UserMessage | AssistantMessage,
  parts: Part[],
  options: TranscriptOptions,
  latestUserText?: string,
): string {
  let result = ""
  const assistantTools = msg.role === "assistant" ? collectAssistantTools(parts) : []
  const analysisTurn = isAnalysisTurn(assistantTools, latestUserText)
  const waitingForAccess = msg.role === "assistant" && analysisTurn && options.pendingAccessMessageIDs?.has(msg.id)
  let lastRenderedAssistantText: string | undefined
  let renderedBody = false

  if (msg.role === "user") {
    result += `## User\n\n`
  } else {
    result += formatAssistantHeader(msg, options.assistantMetadata)
  }

  for (const part of parts) {
    if (waitingForAccess && part.type === "reasoning") {
      continue
    }
    if (msg.role === "assistant" && part.type === "reasoning") {
      if (analysisTurn) {
        if (!(options.thinking && options.toolDetails)) continue
      } else if (assistantTools.length > 0) {
        continue
      }
    }
    if (msg.role === "assistant" && part.type === "text" && !part.synthetic) {
      if (waitingForAccess) {
        continue
      }
      const sanitized = sanitizeAnalysisAssistantText({
        text: part.text,
        tools: assistantTools,
        latestUserText,
      }).text.trim()
      if (!sanitized || sanitized === lastRenderedAssistantText) continue
      result += `${sanitized}\n\n`
      lastRenderedAssistantText = sanitized
      renderedBody = true
      continue
    }
    if (msg.role === "assistant" && part.type === "tool" && analysisTurn && !options.toolDetails) {
      const friendlyError = transcriptErrorDisplayText({
        text: part.state.status === "error" ? part.state.error : undefined,
        isAnalysis: analysisTurn,
        showDetails: options.toolDetails,
        waitingForAccess,
      })
      if (INTERNAL_ANALYSIS_TRANSCRIPT_TOOLS.has(part.tool) && !friendlyError) {
        continue
      }
    }
    const formatted = formatPart(part, options, {
      analysisTurn,
      waitingForAccess,
    })
    if (!formatted) continue
    result += formatted
    renderedBody = true
  }

  if (!renderedBody && msg.role === "assistant") {
    const rawMessage = typeof msg.error?.data.message === "string" ? msg.error.data.message : undefined
    const fallbackError = transcriptErrorDisplayText({
      text: rawMessage,
      isAnalysis: analysisTurn,
      showDetails: options.toolDetails,
      waitingForAccess,
    })
    if (fallbackError) {
      result += `${fallbackError}\n\n`
      renderedBody = true
    }
  }

  if (waitingForAccess) {
    result += `正在等待路径权限，获批后会继续分析。\n\n`
  }

  return result
}

export function formatAssistantHeader(msg: AssistantMessage, includeMetadata: boolean): string {
  if (!includeMetadata) {
    return `## Assistant\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  return `## Assistant (${Locale.titlecase(msg.agent)} 路 ${msg.modelID}${duration ? ` 路 ${duration}` : ""})\n\n`
}

export function formatPart(
  part: Part,
  options: TranscriptOptions,
  context?: {
    analysisTurn?: boolean
    waitingForAccess?: boolean
  },
): string {
  if (part.type === "text" && !part.synthetic) {
    return `${part.text}\n\n`
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `_Thinking:_\n\n${part.text}\n\n`
    }
    return ""
  }

  if (part.type === "tool") {
    const suppressAnalysisDetails = part.tool === "data_import" || part.tool === "econometrics"
    const toolMetadata = "metadata" in part.state ? part.state.metadata : undefined
    const summary =
      renderToolDisplay(part.state.status === "pending" ? undefined : toolMetadata, {
        includeDetails: options.toolDetails && !suppressAnalysisDetails,
        includeArtifacts: options.toolDetails && !suppressAnalysisDetails,
        pathMode: options.toolDetails && !suppressAnalysisDetails ? "relative" : "name",
      }) ?? `${part.tool} (${part.state.status})`
    let result = `**Tool:** ${part.tool}\n**Status:** ${part.state.status}\n**Summary:** ${summary}\n`
    if (options.toolDetails && !suppressAnalysisDetails && part.state.input) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
    }
    if (
      options.toolDetails &&
      !suppressAnalysisDetails &&
      part.state.status === "completed" &&
      !renderToolDisplay(toolMetadata, { includeDetails: true, includeArtifacts: true, pathMode: "relative" }) &&
      part.state.output
    ) {
      result += `\n**Output:**\n\`\`\`\n${part.state.output}\n\`\`\`\n`
    }
    if (part.state.status === "error" && part.state.error) {
      const visibleError = transcriptErrorDisplayText({
        text: part.state.error,
        isAnalysis: Boolean(context?.analysisTurn),
        showDetails: options.toolDetails,
        waitingForAccess: context?.waitingForAccess,
      })
      if (visibleError) {
        result += `\n**Error:**\n\`\`\`\n${visibleError}\n\`\`\`\n`
      }
    }
    return `${result}\n`
  }

  return ""
}

function collectAssistantTools(parts: Part[]): AnalysisToolPartLike[] {
  return parts
    .filter(
      (part): part is Extract<Part, { type: "tool" }> => part.type === "tool" && part.state.status === "completed",
    )
    .map((part) => ({
      tool: part.tool,
      state: {
        status: part.state.status,
        input: part.state.input,
        metadata: "metadata" in part.state ? part.state.metadata : undefined,
      },
    }))
}

function transcriptErrorDisplayText(input: {
  text?: string
  isAnalysis: boolean
  showDetails: boolean
  waitingForAccess?: boolean
}) {
  const message = input.text?.trim()
  if (!message) return undefined
  if (!input.isAnalysis || input.showDetails) return message
  if (input.waitingForAccess) return undefined
  return userFacingAnalysisErrorText(message) ?? (isInternalAnalysisErrorText(message) ? undefined : message)
}

function isInternalAnalysisErrorText(text?: string) {
  if (!text) return false
  return INTERNAL_ANALYSIS_ERROR_PATTERNS.some((pattern) => pattern.test(text))
}

function collectUserText(parts: Part[]) {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
}
