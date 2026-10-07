import path from "path"
import { isInternalWorkspacePath, relativeWithinProject } from "./analysis-path"

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

// 内部工作区（.killstata）路径对用户隐身：任何用户可见渲染（TUI 展开分析过程、
// 工具 summary/details、转录导出）都只显示文件名，不暴露内部目录结构。
// 用户自己放进来的文件（data/*.xlsx 等）走相对路径正常显示——区分"内部细节不可见"
// 但不伤害"用户文件可追踪"。
//
// 判定函数定义在 analysis-path（路径解析要用它选根，而本模块依赖 analysis-path 的
// relativeWithinProject，定义留在这里会成环）；此处重新导出，既有调用点无需改动。
export { isInternalWorkspacePath }

export function displayPath(filePath: string, mode: PathMode = "relative") {
  const normalized = path.normalize(filePath)
  if (mode === "name") return path.basename(normalized)
  if (isInternalWorkspacePath(normalized)) {
    // 只留末段文件名/目录名；.killstata 目录本身无文件名可暴露，返回空
    const tail = path.basename(normalized)
    return tail === ".killstata" ? "" : tail
  }
  if (!path.isAbsolute(normalized)) return normalized
  try {
    return relativeWithinProject(normalized)
  } catch {
    return normalized
  }
}

/**
 * glob 模式串的用户可见形式。
 *
 * pattern 不是路径，`displayPath` 那套（取 basename）会把 `**\/*.json` 这类通配结构毁掉，
 * 但它同样可能带内部路径前缀——模型找自己的产物时会写 `.killstata/datasets/gf_68825014/**`，
 * 原样渲染就把内部目录和数据集 ID 一起暴露给用户了（2026-08-12 gf.xlsx 会话实况）。
 * 这里只在命中内部工作区时折叠成统一措辞，普通 pattern 原样返回。
 */
export function displayGlobPattern(pattern: string) {
  return isInternalWorkspacePath(pattern) ? "内部产物" : pattern
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
    artifacts: (input.artifacts ?? []).filter((item): item is DisplayArtifact =>
      Boolean(item && item.label && item.path),
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
