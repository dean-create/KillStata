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

function isAllowedAnalysisRuntimeShell(request: RunPermissionRequest) {
  if (request.permission !== "bash") return false

  const description = String(request.metadata?.description ?? "")
  const patterns = request.patterns.join("\n")
  const knownAnalysisTask = /^Run econometric method:/i.test(description) || /^Data pipeline action:/i.test(description)
  const knownRuntimePattern = /\*(econometrics|data)\*/i.test(patterns)
  return knownAnalysisTask && knownRuntimePattern
}

function isAnalysisPlanQuestion(header: string) {
  return header === "Analysis Plan" || header === "分析计划"
}

function analysisPlanAnswer(header: string) {
  return header === "分析计划" ? "是" : "Yes"
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
    if (isAnalysisPlanQuestion(primary.header)) {
      return {
        action: "reply",
        answers: [[analysisPlanAnswer(primary.header)]],
        reason: "auto_accept_analysis_plan_question",
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

  if (isAllowedAnalysisRuntimeShell(input.request)) {
    return {
      response: "once",
      auto: true,
      reason: "auto_allow_analysis_runtime_shell",
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
