import { relativeWithinProject } from "./analysis-path"

export type PresentationStatus = "success" | "warn" | "blocked" | "failed"
export type PresentationTone = "neutral" | "positive" | "caution" | "critical"

export type PresentationMetric = {
  label: string
  value: string
  tone?: PresentationTone
  explain?: string
}

export type PresentationArtifact = {
  label: string
  path: string
}

export type PresentationArtifactGroup = {
  label: string
  items: PresentationArtifact[]
}

export type ToolPresentation = {
  kind: "data_prep" | "econometrics"
  title: string
  headline: string
  status: PresentationStatus
  summary?: string[]
  keyMetrics?: PresentationMetric[]
  highlights?: string[]
  risks?: string[]
  nextActions?: string[]
  artifactGroups?: PresentationArtifactGroup[]
}

function normalizeLines(input?: Array<string | undefined | null | false>) {
  return (input ?? []).filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function normalizeArtifacts(input?: Array<PresentationArtifact | undefined | null | false>) {
  return (input ?? []).filter(
    (item): item is PresentationArtifact =>
      Boolean(item && typeof item.label === "string" && item.label.trim() && typeof item.path === "string" && item.path.trim()),
  )
}

function normalizeArtifactGroups(input?: Array<PresentationArtifactGroup | undefined | null | false>) {
  return (input ?? [])
    .map((group) => {
      if (!group || typeof group.label !== "string" || !group.label.trim()) return undefined
      const items = normalizeArtifacts(group.items)
      if (!items.length) return undefined
      return {
        label: group.label.trim(),
        items,
      }
    })
    .filter((group): group is PresentationArtifactGroup => Boolean(group))
}

export function createPresentation(input: {
  kind: ToolPresentation["kind"]
  title: string
  headline: string
  status: PresentationStatus
  summary?: Array<string | undefined | null | false>
  keyMetrics?: Array<PresentationMetric | undefined | null | false>
  highlights?: Array<string | undefined | null | false>
  risks?: Array<string | undefined | null | false>
  nextActions?: Array<string | undefined | null | false>
  artifactGroups?: Array<PresentationArtifactGroup | undefined | null | false>
}): ToolPresentation {
  return {
    kind: input.kind,
    title: input.title.trim(),
    headline: input.headline.trim(),
    status: input.status,
    summary: normalizeLines(input.summary),
    keyMetrics: (input.keyMetrics ?? []).filter(
      (item): item is PresentationMetric =>
        Boolean(item && typeof item.label === "string" && item.label.trim() && typeof item.value === "string" && item.value.trim()),
    ),
    highlights: normalizeLines(input.highlights),
    risks: normalizeLines(input.risks),
    nextActions: normalizeLines(input.nextActions),
    artifactGroups: normalizeArtifactGroups(input.artifactGroups),
  }
}

export function presentationMetric(
  label: string,
  value: string | number | undefined,
  options?: {
    tone?: PresentationTone
    explain?: string
  },
): PresentationMetric | undefined {
  if (value === undefined || value === null || value === "") return undefined
  return {
    label,
    value: typeof value === "number" ? String(value) : value,
    tone: options?.tone,
    explain: options?.explain,
  }
}

export function presentationArtifact(label: string, filePath?: string): PresentationArtifact | undefined {
  if (!filePath) return undefined
  return {
    label,
    path: toPresentationPath(filePath),
  }
}

export function artifactGroup(
  label: string,
  items: Array<PresentationArtifact | undefined | null | false>,
): PresentationArtifactGroup | undefined {
  const normalized = normalizeArtifacts(items)
  if (!normalized.length) return undefined
  return {
    label,
    items: normalized,
  }
}

export function toPresentationPath(filePath: string) {
  if (!filePath) return filePath
  try {
    return relativeWithinProject(filePath)
  } catch {
    return filePath
  }
}

export function derivePresentationStatus(input: {
  success?: boolean
  qaGateStatus?: string
  warnings?: string[]
  blockingErrors?: string[]
}): PresentationStatus {
  if (input.success === false) return "failed"
  if ((input.blockingErrors?.length ?? 0) > 0 || input.qaGateStatus === "block") return "blocked"
  if ((input.warnings?.length ?? 0) > 0 || input.qaGateStatus === "warn") return "warn"
  return "success"
}
