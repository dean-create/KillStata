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

export function decideNonInteractivePermission(input: {
  workspaceRoot: string
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

  const allowedRoots = workspaceCandidates(normalizeAbsolute(input.workspaceRoot, input.workspaceRoot))
  const candidates = candidateTargets(input.request, input.workspaceRoot)
  const safe = candidates.length > 0 && candidates.every((candidate) => allowedRoots.some((root) => isWithinRoot(candidate, root)))

  if (safe) {
    return {
      response: "once",
      auto: true,
      reason: "auto_allow_workspace_external_directory",
    }
  }

  return {
    response: "reject",
    auto: true,
    reason: "auto_reject_external_directory_outside_workspace",
  }
}
