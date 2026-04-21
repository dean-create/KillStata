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

export function shouldAutoHandleRunPermissions(input: {
  format: "default" | "json"
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
}) {
  return input.format === "json" || !input.stdinIsTTY || !input.stdoutIsTTY
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

  return {
    action: "reply",
    answers: [["Yes"]],
    reason: parsed.mode === "read" ? "auto_allow_external_read_question" : "auto_allow_external_write_question",
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

  return {
    response: "once",
    auto: true,
    reason: "auto_allow_external_directory",
  }
}
