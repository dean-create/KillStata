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
  const managedRuntime = request.metadata?.managedRuntime === true
  const knownAnalysisTask = managedRuntime || /^Run econometric method:/i.test(description) || /^Data pipeline action:/i.test(description)
  // 受管方法工具使用 *ols*、*panel_fe*、*did2s* 等 capability pattern；
  // 只要 metadata 明确来自 managedRuntime 且 pattern 是单一 capability，就沿用
  // PermissionNext 的同一安全边界。普通 Bash 没有 managedRuntime 标记，仍拒绝。
  const knownRuntimePattern = managedRuntime
    ? /\*[A-Za-z0-9_-]+\*/.test(patterns)
    : /\*(econometrics|data|mcda)\*/i.test(patterns)
  return knownAnalysisTask && knownRuntimePattern
}

function isAnalysisPlanQuestion(header: string) {
  return header === "Analysis Plan" || header === "分析计划"
}

function analysisPlanAnswer(header: string) {
  return header === "分析计划" ? "是" : "Yes"
}

// P1-B：非交互 `killstata run` 是一次性命令，用户不在场无法回答澄清问题。
// 原先系统直接 reject，模型收到"用户已取消"并被 blocked=stop 终止整轮，任务半途而废
// 且没有恢复出路。改为回复一段合成指引，让模型明白当前无人可答、应基于最合理默认假设
// 自主继续，并在最终结论中说明所做假设——复用现成的 reply 链路，绕开 turn 生命周期的 stop。
const NON_INTERACTIVE_CLARIFICATION_REPLY =
  "当前处于非交互批处理模式，无法向用户提问。请基于数据本身和最合理的默认假设直接继续分析，" +
  "并在最终结论中明确列出你所做的关键假设，以及用户后续可以如何修正。"

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
    // 其余均为模型主动发起的研究设计澄清：回复统一的自主继续指引，每个问题给同一条答案。
    return {
      action: "reply",
      answers: input.request.questions.map(() => [NON_INTERACTIVE_CLARIFICATION_REPLY]),
      reason: "auto_reply_noninteractive_clarification",
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
