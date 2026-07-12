import path from "path"
import { relativeWithinProject } from "./analysis-path"

export type DisplayVisibility = "user_default" | "user_collapsed" | "internal_only"

export type DisplayArtifact = {
  label: string
  path: string
  visibility?: DisplayVisibility
}

export type ToolDisplay = {
  visibility: DisplayVisibility
  summary: string
  details?: string[]
  artifacts?: DisplayArtifact[]
}

type PathMode = "name" | "relative"

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeVisibility(value: unknown): DisplayVisibility | undefined {
  return value === "user_default" || value === "user_collapsed" || value === "internal_only" ? value : undefined
}

export function displayPath(filePath: string, mode: PathMode = "relative") {
  const normalized = path.normalize(filePath)
  if (mode === "name") return path.basename(normalized)
  if (!path.isAbsolute(normalized)) return normalized
  try {
    return relativeWithinProject(normalized)
  } catch {
    return normalized
  }
}

export function createToolDisplay(input: {
  summary: string
  details?: Array<string | undefined | null | false>
  artifacts?: Array<DisplayArtifact | undefined | null | false>
  visibility?: DisplayVisibility
}): ToolDisplay {
  return {
    visibility: input.visibility ?? "user_default",
    summary: input.summary.trim(),
    details: (input.details ?? []).filter((item): item is string => typeof item === "string" && item.trim().length > 0),
    artifacts: (input.artifacts ?? []).filter(
      (item): item is DisplayArtifact => Boolean(item && item.label && item.path),
    ),
  }
}

export function readToolDisplay(metadata?: Record<string, unknown>): ToolDisplay | undefined {
  if (!metadata) return undefined
  const display = metadata.display
  if (!isObject(display)) return undefined
  const summary = typeof display.summary === "string" ? display.summary.trim() : ""
  if (!summary) return undefined
  const visibility = normalizeVisibility(display.visibility) ?? "user_default"
  const details = Array.isArray(display.details)
    ? display.details.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined
  const artifacts = Array.isArray(display.artifacts)
    ? (() => {
        const normalizedArtifacts: DisplayArtifact[] = []
        for (const item of display.artifacts) {
          if (!isObject(item)) continue
          const label = typeof item.label === "string" ? item.label.trim() : ""
          const artifactPath = typeof item.path === "string" ? item.path.trim() : ""
          const artifactVisibility = normalizeVisibility(item.visibility) ?? "user_collapsed"
          if (!label || !artifactPath) continue
          normalizedArtifacts.push({
            label,
            path: artifactPath,
            visibility: artifactVisibility,
          })
        }
        return normalizedArtifacts
      })()
    : undefined
  return {
    visibility,
    summary,
    details,
    artifacts,
  }
}

export function renderToolDisplay(
  metadata?: Record<string, unknown>,
  options?: {
    includeDetails?: boolean
    includeArtifacts?: boolean
    pathMode?: PathMode
    artifactVisibility?: DisplayVisibility[]
  },
) {
  const display = readToolDisplay(metadata)
  if (!display) return undefined
  const lines = [display.summary]
  if (options?.includeDetails && display.details?.length) {
    lines.push(...display.details)
  }
  if (options?.includeArtifacts && display.artifacts?.length) {
    const allow = new Set(options.artifactVisibility ?? ["user_default", "user_collapsed"])
    const artifactLines = display.artifacts
      .filter((item) => allow.has(item.visibility ?? "user_collapsed"))
      .map((item) => `- ${item.label}: ${displayPath(item.path, options?.pathMode ?? "relative")}`)
    if (artifactLines.length) lines.push(...artifactLines)
  }
  return lines.join("\n").trim()
}
