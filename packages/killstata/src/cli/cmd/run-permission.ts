import path from "path"

export type RunPermissionRequest = {
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
}

export type RunPermissionDecision = {
  response: "once" | "always" | "reject"
  auto: boolean
  reason: string
}

export type RunQuestionRequest = {
  questions: Array<{
    header: string
    question: string
  }>
}

export type RunQuestionDecision = {
  action: "reply" | "reject"
  answers?: string[][]
  reason: string
}

function normalizeAbsolute(target: string, baseDir: string) {
  return path.normalize(path.isAbsolute(target) ? target : path.resolve(baseDir, target))
}

function isWithinRoot(targetPath: string, rootPath: string) {
  const relative = path.relative(rootPath, targetPath)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function workspaceCandidates(rootPath: string) {
  return [rootPath, path.join(rootPath, ".killstata"), path.join(rootPath, "killstata_outputs")]
}

function stripWildcard(pattern: string) {
  if (pattern.endsWith("\\*") || pattern.endsWith("/*")) return pattern.slice(0, -2)
  return pattern
}

function candidateTargets(request: RunPermissionRequest, baseDir: string) {
  const candidates = new Set<string>()
  const metadata = request.metadata ?? {}

  for (const key of ["filepath", "parentDir"]) {
    const value = metadata[key]
    if (typeof value === "string" && value.trim()) {
      candidates.add(normalizeAbsolute(value, baseDir))
    }
  }

  for (const pattern of request.patterns) {
    if (!pattern.trim()) continue
    candidates.add(normalizeAbsolute(stripWildcard(pattern), baseDir))
  }

  return [...candidates]
}

export function shouldAutoHandleRunPermissions(input: {
  format: "default" | "json"
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
}) {
  return input.format === "json" || !input.stdinIsTTY || !input.stdoutIsTTY
}

function readAccessRoots(workspaceRoot: string, projectRoot?: string) {
  const roots = [...workspaceCandidates(normalizeAbsolute(workspaceRoot, workspaceRoot))]
  if (projectRoot) {
    const normalizedProjectRoot = normalizeAbsolute(projectRoot, workspaceRoot)
    roots.push(normalizedProjectRoot)
    roots.push(path.join(normalizedProjectRoot, "test"))
    roots.push(path.join(normalizedProjectRoot, "modelpctest"))
  }
  return [...new Set(roots)]
}

function parsePathAccessQuestion(question: string) {
  const match = /wants (read|write) access to project-external path:\s*([\s\S]+?)\s*Allow this access/i.exec(question)
  if (!match?.[1] || !match[2]) return undefined
  return {
    mode: match[1].toLowerCase() as "read" | "write",
    targetPath: match[2].trim(),
  }
}

export function decideNonInteractiveQuestion(input: {
  workspaceRoot: string
  projectRoot?: string
  request: RunQuestionRequest
}): RunQuestionDecision {
  const primary = input.request.questions[0]
  if (!primary) {
    return {
      action: "reject",
      reason: "auto_reject_empty_question",
    }
  }

  if (primary.header !== "Path Access") {
    if (primary.header === "Analysis Plan") {
      return {
        action: "reply",
        answers: [["No"]],
        reason: "auto_skip_analysis_plan_question",
      }
    }
    return {
      action: "reject",
      reason: "auto_reject_noninteractive_question",
    }
  }

  const parsed = parsePathAccessQuestion(primary.question)
  if (!parsed) {
    return {
      action: "reject",
      reason: "auto_reject_unparsed_path_access_question",
    }
  }

  const targetPath = normalizeAbsolute(parsed.targetPath, input.workspaceRoot)
  const allowedRoots =
    parsed.mode === "read"
      ? readAccessRoots(input.workspaceRoot, input.projectRoot)
      : workspaceCandidates(normalizeAbsolute(input.workspaceRoot, input.workspaceRoot))
  const allowed = allowedRoots.some((root) => isWithinRoot(targetPath, root))

  if (allowed) {
    return {
      action: "reply",
      answers: [["Yes"]],
      reason: parsed.mode === "read" ? "auto_allow_workspace_or_project_read_question" : "auto_allow_workspace_write_question",
    }
  }

  return {
    action: "reject",
    reason: parsed.mode === "read" ? "auto_reject_read_question_outside_project" : "auto_reject_write_question_outside_workspace",
  }
}

export function decideNonInteractivePermission(input: {
  workspaceRoot: string
  projectRoot?: string
  request: RunPermissionRequest
}): RunPermissionDecision {
  if (input.request.permission === "read") {
    return {
      response: "once",
      auto: true,
      reason: "auto_allow_low_risk_read",
    }
  }

  if (input.request.permission !== "external_directory") {
    return {
      response: "reject",
      auto: true,
      reason: "auto_reject_noninteractive_permission",
    }
  }

  const allowedRoots = readAccessRoots(input.workspaceRoot, input.projectRoot)
  const candidates = candidateTargets(input.request, input.workspaceRoot)
  const safe = candidates.length > 0 && candidates.every((candidate) => allowedRoots.some((root) => isWithinRoot(candidate, root)))

  if (safe) {
    return {
      response: "once",
      auto: true,
      reason: "auto_allow_workspace_or_project_external_directory",
    }
  }

  return {
    response: "reject",
    auto: true,
    reason: "auto_reject_external_directory_outside_workspace",
  }
}
