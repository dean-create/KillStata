import { isAnalysisTurn, wantsRawAnalysisDetail, type AnalysisToolPartLike } from "./analysis-user-view"

const LEGACY_ANALYSIS_FALLBACK_TEXT = "正在继续分析，稍后给出结果。"
const PARQUET_STAGE_FALLBACK_TEXT = "该文件是内部 Parquet 工作层，系统已自动改用结构化结果文件继续分析。"
const BINARY_FILE_FALLBACK_TEXT = "该文件是结构化二进制数据，系统已自动改用可读取的结果文件继续分析。"
const TOOL_UNAVAILABLE_FALLBACK_TEXT = "分析工具调用失败，系统正在回退到可执行路径。"

const NOISE_LINE_PATTERNS = [
  /^Thinking:/i,
  /^Let me /i,
  /^I need to /i,
  /^I'll /i,
  /^I will /i,
  /^Now I /i,
  /^Next,? I /i,
  /^Called the Read tool with the following input:/i,
  /^Read tool failed to read .*$/i,
  /^Do not execute mutating tools\./i,
  /^Validate only the provided stage and artifacts\./i,
  /^You are a fresh-run verifier/i,
  /^Audit this workflow stage\./i,
  /^Return only a JSON object inside/i,
  /^Exact statistical values are omitted here because .*$/i,
  /^Some statistical values were omitted/i,
  /^Unverified statistics omitted: .*$/i,
  /^This directional or significance claim is omitted because .*$/i,
  /^Model tried to call unavailable tool .*$/i,
  /^System\.Management\.Automation\.RemoteException$/i,
  /^Reused existing .* stage/i,
  /source file fingerprint is unchanged/i,
  /^QA gate warning\(s\):/i,
  /^\[baseline-browser-mapping\].*$/i,
  /^.*workflow \[action=.*\]$/i,
  /^"artifactRefs":\s*\[$/i,
  /^"latestTrustedArtifacts":\s*\[$/i,
  /^"verifierReport":/i,
  /^"verifierEnvelope":/i,
  /^"workflowRunId":/i,
  /^"stageId":/i,
  /^"stageKind":/i,
  /^"replayInput":/i,
  /^"metadata":\s*\{/i,
  /^"instruction":/i,
  /^"qaGateStatus":/i,
  /^"qaGateReason":/i,
  /^"qaSource":/i,
  /^"deliveryBundleDir":/i,
  /^"publishedFiles":/i,
  /^"finalOutputsPath":/i,
  /^"internalFinalOutputsPath":/i,
  /^"presentation":\s*\{/i,
  /^"analysisView":\s*\{/i,
  /^"display":\s*\{/i,
  /^"truncated":/i,
  /^\(End of file - total/i,
  /^\(Output truncated at/i,
  /^Stata dataset is a structured binary format/i,
  /^Cannot read Stata dataset as text/i,
  /^Cannot read canonical parquet stage as text/i,
  /^Cannot read Excel workbook as text/i,
  /^Cannot read binary file/i,
  /^Excel workbook is a structured binary format/i,
  /^This file is the canonical working dataset/i,
  /^Do not use the read tool on canonical parquet/i,
  /^Recommended alternatives:/i,
  /^Use datasetId\/stageId with data_import or econometrics instead\.$/i,
  /^- use data_import with action=/i,
  /^- use exported inspection/i,
  /^- use results\.json/i,
  /^- use datasetId\/stageId/i,
  /^- inspection CSV\/XLSX/i,
  /^- diagnostics\.json for/i,
  /^- model_metadata\.json for/i,
  /^- numeric_snapshot\.json for/i,
]

const ENGINE_INTERNAL_MARKERS = [
  "<file>",
  "Called the Read tool with the following input:",
  "Read tool failed to read ",
  "You are a fresh-run verifier for killstata.",
  "Exact statistical values are omitted",
  "Unverified statistics omitted",
  "This directional or significance claim is omitted",
  "System.Management.Automation.RemoteException",
  "Model tried to call unavailable tool",
  "[baseline-browser-mapping]",
  "Some statistical values were omitted",
  '"workflowRunId"',
  '"artifactRefs"',
  '"latestTrustedArtifacts"',
  '"replayInput"',
  '"stageKind"',
  '"qaGateStatus"',
  '"finalOutputsPath"',
  '"internalFinalOutputsPath"',
  '"presentation"',
  '"analysisView"',
  "Audit this workflow stage.",
  "Cannot read Stata dataset as text",
  "Cannot read canonical parquet stage as text",
  "Cannot read Excel workbook as text",
  "Cannot read binary file",
  "Stata dataset is a structured binary format",
  "Use datasetId/stageId with data_import or econometrics instead.",
]

function stripVerifierBlocks(text: string) {
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  let inVerifier = false
  let braceDepth = 0

  for (const line of lines) {
    if (!inVerifier && line.includes("You are a fresh-run verifier for killstata.")) {
      inVerifier = true
      braceDepth = 0
      continue
    }

    if (inVerifier) {
      for (const ch of line) {
        if (ch === "{") braceDepth += 1
        if (ch === "}") braceDepth -= 1
      }
      if (braceDepth <= 0) inVerifier = false
      continue
    }

    kept.push(line)
  }

  return kept.join("\n")
}

function stripFileBodies(text: string) {
  return text.replace(/<file>[\s\S]*?<\/file>/g, "")
}

function stripRawJsonBlocks(text: string) {
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  let inJson = false
  let braceDepth = 0
  let jsonBuffer: string[] = []

  const isJsonStart = (line: string) => {
    const trimmed = line.trim()
    return (
      trimmed === "{" ||
      trimmed.startsWith('{ "') ||
      trimmed.startsWith('{"') ||
      /^\{\s*"(workflowRunId|result|schema|variable_labels|quality|column_info|replayInput|metadata|stageId|artifactRefs)"/.test(
        trimmed,
      )
    )
  }

  for (const line of lines) {
    if (!inJson && isJsonStart(line)) {
      inJson = true
      braceDepth = 0
      jsonBuffer = []
    }

    if (inJson) {
      jsonBuffer.push(line)
      for (const ch of line) {
        if (ch === "{") braceDepth += 1
        if (ch === "}") braceDepth -= 1
      }

      if (braceDepth <= 0) {
        inJson = false
        if (jsonBuffer.length <= 5) {
          const content = jsonBuffer.join("\n")
          const hasInternalKeys =
            content.includes('"workflowRunId"') ||
            content.includes('"artifactRefs"') ||
            content.includes('"stageKind"') ||
            content.includes('"replayInput"') ||
            content.includes('"qaGateStatus"') ||
            content.includes('"presentation"') ||
            content.includes('"analysisView"')
          if (!hasInternalKeys) kept.push(...jsonBuffer)
        }
        jsonBuffer = []
      }
      continue
    }

    kept.push(line)
  }

  return kept.join("\n")
}

function stripNoiseLines(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (/^0{2,}\d+\|/.test(trimmed)) return false
      if (/^"([A-Za-z]:\\\\|\.\/{0,2})/.test(trimmed)) return false
      if (/^[A-Z]:\\[^ ]*$/.test(trimmed)) return false
      if (/^[\[\]{},]+$/.test(trimmed)) return false
      if (/^\d{4},/.test(trimmed) && (trimmed.match(/,/g) ?? []).length > 10) return false
      return !NOISE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))
    })
    .join("\n")
}

function collapseWhitespace(text: string) {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
}

function fallbackMessagesForInternalErrors(text: string) {
  const messages: string[] = []

  if (/Cannot read canonical parquet stage as text/i.test(text)) {
    messages.push(PARQUET_STAGE_FALLBACK_TEXT)
  } else if (/Cannot read binary file/i.test(text)) {
    messages.push(BINARY_FILE_FALLBACK_TEXT)
  }

  if (/Model tried to call unavailable tool/i.test(text)) {
    messages.push(TOOL_UNAVAILABLE_FALLBACK_TEXT)
  }

  return [...new Set(messages)]
}

export function userFacingAnalysisErrorText(text?: string) {
  if (!text) return undefined
  const normalized = text.trim()
  if (!normalized) return undefined
  const messages = fallbackMessagesForInternalErrors(normalized)
  return messages.length > 0 ? messages.join("\n") : undefined
}

export function containsEngineInternalData(text: string) {
  return ENGINE_INTERNAL_MARKERS.some((marker) => text.includes(marker))
}

export { type AnalysisToolPartLike } from "./analysis-user-view"

export function sanitizeAnalysisAssistantText(input: {
  text: string
  tools: AnalysisToolPartLike[]
  latestUserText?: string
}) {
  if (wantsRawAnalysisDetail(input.latestUserText)) {
    return {
      text: input.text,
      sanitized: false,
    }
  }

  const normalized = input.text.trim()
  if (normalized === LEGACY_ANALYSIS_FALLBACK_TEXT) {
    return {
      text: "",
      sanitized: true,
    }
  }

  const hasInternalData = containsEngineInternalData(normalized)
  const analysisTurn = isAnalysisTurn(input.tools, input.latestUserText)
  const hasNoise =
    hasInternalData ||
    /workflow \[action=.*\]/i.test(normalized) ||
    /0{2,}\d+\|/.test(normalized) ||
    normalized.length > 800 ||
    normalized.split(/\r?\n/).length > 16

  const needsSanitization = analysisTurn || hasInternalData

  // Non-analysis answers should not be sanitized just because they are long.
  if (!needsSanitization) {
    return {
      text: input.text,
      sanitized: false,
    }
  }

  const stripped = collapseWhitespace(
    stripNoiseLines(stripRawJsonBlocks(stripFileBodies(stripVerifierBlocks(normalized)))),
  )
  const fallbackMessages = userFacingAnalysisErrorText(normalized)?.split("\n") ?? []

  if (!analysisTurn) {
    if (stripped && !containsEngineInternalData(stripped)) {
      return {
        text: stripped,
        sanitized: stripped !== normalized,
      }
    }

    if (fallbackMessages.length > 0) {
      return {
        text: fallbackMessages.join("\n"),
        sanitized: true,
      }
    }

    return {
      text: input.text,
      sanitized: false,
    }
  }

  if (stripped && !containsEngineInternalData(stripped)) {
    return {
      text: stripped,
      sanitized: true,
    }
  }

  if (stripped && stripped.length > 0 && stripped !== normalized) {
    return {
      text: stripped,
      sanitized: true,
    }
  }

  if (fallbackMessages.length > 0) {
    return {
      text: fallbackMessages.join("\n"),
      sanitized: true,
    }
  }

  if (hasInternalData || (hasNoise && !stripped)) {
    return {
      text: "",
      sanitized: true,
    }
  }

  return {
    text: input.text,
    sanitized: false,
  }
}
