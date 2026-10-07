import MAX_STEPS from "../../session/prompt/max-steps.txt"
import path from "path"
import type { QueuedSessionAction, RuntimeFailureDecision, RuntimeTaskRecord, WorkflowInputIntent } from "@/runtime/types"
import { AUTOMATIC_TOOL_REPAIR_LIMIT, PromptInput, log, shouldAutomaticallyRepairTool } from "./types"
import { Agent } from "../../agent/agent"
import { DataContext } from "@/session/data-context"
import { isDataFile } from "@/tool/data-file"
import { Identifier } from "../../id/id"
import { Instance } from "../../project/instance"
import { Memory } from "@/runtime/memory"
import { MessageV2 } from "../message-v2"
import { PermissionNext } from "@/permission/next"
import { Provider } from "../../provider/provider"
import { Session } from "../session-state"
import { SessionCompaction } from "../compaction"
import { SessionProcessor } from "../processor"
import { SessionRevert } from "../revert"
import { SessionRunCoordinator } from "../run-state"
import { SessionStatus } from "../status"
import { SessionSummary } from "../summary"
import { SystemPrompt } from "../system"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { cleanupSessions } from "@/runtime/retention"
import { clone } from "remeda"
import { actionMessageID, completedReplyForAction, enqueueAction, nextQueuedAction, resolveCallbacks, waitForAction } from "./queue"
import { createUserMessage, ensureTitle } from "./message"
import { defer } from "../../util/defer"
import { fn } from "@killstata/util/fn"
import { detectInputIntent, detectToolFocus, inputGraphFromParts, methodDisplayName } from "./intent"
import { detectWorkflowThrashing, userRequestedResearchDesignStop } from "./thrashing"
import { insertReminders } from "./reminder"
import { getActiveWorkflowRun, isAnalysisWorkflowActive, resumePendingAutomaticVerifiers } from "@/runtime/workflow"
import { repairHistoryNotice } from "@/runtime/failure-reflection"
import { publishToolProgress, resolveTools } from "./tools"
import { tool } from "ai"
import { ulid } from "ulid"
import { ContextService } from "@/runtime/services/context-service"
import { shouldStopContextCompaction } from "@/runtime/context-preflight"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { needsAnalysisCompletion, needsAnalysisPreparation } from "@/runtime/analysis-request"
import {
  expectedEstimateMethodIDs as expectedEstimateMethodIDsForRequest,
  hasCompletedRequiredEstimateMethods,
  missingRequiredEstimateMethodIDs,
} from "@/runtime/analysis-lifecycle"
import { canonicalDataStageForWorkflow } from "@/runtime/workflow/state"
import { Question } from "@/question"
import { shouldReplanAfterRepairText } from "./repair-continuation"
import { isWorkflowAnalysisTool, isWorkflowEstimateCompletionTool } from "@/runtime/tool-catalog"

function persistTerminalFailure(sessionID: string, decision: RuntimeFailureDecision) {
  try {
    const ledger = RuntimeTaskLedger.listTasks(sessionID)
    const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
    RuntimeTaskLedger.appendEvent({
      sessionID,
      kind: "failure",
      message: `${decision.scope} failure stop: ${decision.category}`,
      failureDecision: { ...decision, checkpointId: decision.checkpointId ?? task?.latestCheckpointId },
    })
    return true
  } catch {
    return false
  }
}

function workflowAnalysisCompletedForAction(sessionID: string, userCreatedAt: number) {
  try {
    const run = getActiveWorkflowRun(sessionID)
    const baseline = [...(run?.stages ?? [])]
      .reverse()
      .find((stage) => stage.kind === "baseline_estimate")
    const verifier = [...(run?.stages ?? [])]
      .reverse()
      .find((stage) => stage.kind === "verifier")
    if (!baseline || baseline.status !== "completed" || !verifier || verifier.status !== "completed") return false
    const baselineAt = Date.parse(baseline.createdAt)
    const verifierAt = Date.parse(verifier.createdAt)
    return Number.isFinite(baselineAt) && Number.isFinite(verifierAt) &&
      baselineAt >= userCreatedAt && verifierAt >= baselineAt
  } catch {
    return false
  }
}

const REQUIRED_METHOD_CONTINUATION_LIMIT = 2

export function missingRequiredMethodIDs(
  requiredToolIDs: unknown,
  messages: MessageV2.WithParts[],
  userMessageID: string,
) {
  if (!Array.isArray(requiredToolIDs)) return []
  const required = requiredToolIDs.filter((id): id is string => typeof id === "string" && id.length > 0)
  if (required.length === 0) return []
  const completed = new Set(
    messages
      .filter((message) => message.info.role === "assistant" && message.info.parentID === userMessageID)
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" &&
          part.state.status === "completed" &&
          part.state.metadata?.requiresUserDecision !== true
            ? [
                part.tool === "econometrics_execute"
                  ? (() => {
                      const input = part.state.input && typeof part.state.input === "object"
                        ? part.state.input as Record<string, unknown>
                        : {}
                      const metadata = part.state.metadata
                      const result = metadata?.result && typeof metadata.result === "object"
                        ? metadata.result as Record<string, unknown>
                        : {}
                      if (result.success !== true) return undefined
                      const methodID = input.methodID ?? metadata?.method ?? result.method ?? result.method_id
                      return typeof methodID === "string" ? methodID : undefined
                    })()
                  : part.tool,
              ]
            : [],
        ).filter((id): id is string => typeof id === "string"),
      ),
  )
  return required.filter((toolID) => !completed.has(toolID))
}

const REQUIRED_METHOD_PROGRESS_TOOL_IDS = new Set([
  "analysis_request",
  "analysis_prepare",
  "data_import",
  "data_preprocess",
  "econometrics_execute",
  "econometrics_recommend",
  "composite_evaluation",
  "heterogeneity_runner",
])

export function requiredMethodProgressSignature(messages: MessageV2.WithParts[], userMessageID: string) {
  const latestProgressPart = messages
    .filter((message) => message.info.role === "assistant" && message.info.parentID === userMessageID)
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.ToolPart =>
      part.type === "tool" &&
      REQUIRED_METHOD_PROGRESS_TOOL_IDS.has(part.tool) &&
      (part.state.status === "completed" || part.state.status === "error"),
    )
    .at(-1)
  if (!latestProgressPart) return ""

  const state = latestProgressPart.state
  const input = state.input && typeof state.input === "object" && !Array.isArray(state.input)
    ? state.input as Record<string, unknown>
    : {}
  const metadata = state.status === "completed" ? state.metadata : undefined
  const result = metadata?.result && typeof metadata.result === "object" && !Array.isArray(metadata.result)
    ? metadata.result as Record<string, unknown>
    : {}
  return JSON.stringify({
    tool: latestProgressPart.tool,
    status: state.status,
    operation: input.methodID ?? metadata?.method ?? result.method ?? result.method_id ?? input.action ?? input.method ?? "",
    arguments: input.arguments ?? input.options ?? {},
    specId: input.specId ?? "",
    success: result.success === true,
    stageId: metadata?.stageId ?? input.stageId ?? "",
    error: state.status === "error" ? String(state.error) : undefined,
  })
}

export function unresolvedMethodDecisionIDs(messages: MessageV2.WithParts[], userMessageID: string) {
  const latestState = new Map<string, boolean>()
  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.parentID !== userMessageID) continue
    for (const part of message.parts) {
      if (
        part.type !== "tool" ||
        (part.tool !== "analysis_prepare" && part.tool !== "econometrics_execute") ||
        part.state.status !== "completed"
      ) continue
      const input = part.state.input && typeof part.state.input === "object" && !Array.isArray(part.state.input)
        ? part.state.input as Record<string, unknown>
        : {}
      const metadata = (part.state.metadata ?? {}) as Record<string, unknown>
      const result = metadata.result && typeof metadata.result === "object" && !Array.isArray(metadata.result)
        ? metadata.result as Record<string, unknown>
        : {}
      const methodID = input.methodID ?? metadata.method ?? result.method ?? result.method_id
      if (typeof methodID !== "string") continue

      if (part.tool === "analysis_prepare") {
        if (metadata.requiresUserDecision === true) latestState.set(methodID, true)
        else if (metadata.analysisSpecStatus === "ready" || metadata.analysisSpecStatus === "preflight_ready") {
          latestState.set(methodID, false)
        }
        continue
      }

      if (metadata.requiresUserDecision === true) latestState.set(methodID, true)
      else if (result.success === true) latestState.set(methodID, false)
    }
  }
  return [...latestState].filter(([, pending]) => pending).map(([methodID]) => methodID)
}

export function pendingEstimateMethodsForTask(task: RuntimeTaskRecord, sourceMessageID: string) {
  const request = task.analysisRequest
  const lifecycle = task.analysisLifecycle
  if (
    !request ||
    request.kind !== "estimate" ||
    request.sourceMessageId !== sourceMessageID ||
    task.messageID !== sourceMessageID ||
    lifecycle?.requestId !== request.requestId ||
    lifecycle.status !== "waiting_user" ||
    lifecycle.issueCode !== "ESTIMATE_REQUEST_INCOMPLETE"
  ) return []

  const methodIDs = [
    ...(Array.isArray(task.metadata?.requiredToolIDs)
      ? task.metadata.requiredToolIDs.filter((id): id is string => typeof id === "string")
      : []),
    ...(Array.isArray(task.metadata?.confirmedToolIDs)
      ? task.metadata.confirmedToolIDs.filter((id): id is string => typeof id === "string")
      : []),
  ].filter(isWorkflowEstimateCompletionTool)
  const expected = expectedEstimateMethodIDsForRequest(methodIDs, lifecycle, request.requestId)
  return missingRequiredEstimateMethodIDs(expected, lifecycle, request.requestId)
}

const METHOD_DECISION_CONTINUATION_CUE = /(?:我(?:已|已经)?(?:确认|核对|同意)|确认(?:后|使用|采用)|同意|继续|接着|按(?:上述|此|这个|这一)|照此|依照|coerce_numeric|重编码|数值化|缺失标记|派生阶段|保留原阶段)/i
const METHOD_DECISION_DECLINE = /(?:不同意|拒绝|不接受)|(?:不|不要|别|先别|先不|暂不)(?:再)?(?:继续|执行|运行|估计|回归|分析)|(?:停止|取消)(?:本次|本轮)?(?:任务|分析|估计|回归|执行|继续)?/i

export function isMethodDecisionDeclined(text: string) {
  const clauses = text
    .split(/[，,。；;！？!?\n]+|\b(?:but|however)\b|但是|不过|但|并(?:且)?/i)
    .map((clause) => clause.trim())
    .filter(Boolean)
  const hasDecline = clauses.some((clause) => METHOD_DECISION_DECLINE.test(clause))
  if (!hasDecline) return false
  const hasPositiveContinuation = clauses.some((clause) =>
    METHOD_DECISION_CONTINUATION_CUE.test(clause) && !METHOD_DECISION_DECLINE.test(clause),
  )
  return !hasPositiveContinuation
}

async function carryPendingMethodDecision(input: {
  sessionID: string
  currentMessage: MessageV2.WithParts
  agent?: string
  intent: WorkflowInputIntent
  text: string
  focus: ReturnType<typeof detectToolFocus>
}): Promise<{ toolIDs: string[]; psmToolScope?: "diagnostics_only" }> {
  const explicitlyDeclined = isMethodDecisionDeclined(input.text)
  if (
    input.agent === "verifier" ||
    input.intent === "status" ||
    input.focus.psmToolScope === "blocked" ||
    input.currentMessage.parts.some((part) => part.type === "file" && !part.mime?.startsWith("image/")) ||
    /\b[^\s,，;；。！？!?]*\.(?:xlsx?|csv|dta|sav|parquet)\b/i.test(input.text)
  ) return { toolIDs: [] }
  if (!explicitlyDeclined && !METHOD_DECISION_CONTINUATION_CUE.test(input.text)) return { toolIDs: [] }

  const messages = await Session.messages({ sessionID: input.sessionID, limit: 50 })
  const currentIndex = messages.findIndex((message) => message.info.id === input.currentMessage.info.id)
  if (currentIndex <= 0) return { toolIDs: [] }
  const previousUser = messages
    .slice(0, currentIndex)
    .reverse()
    .find((message) => message.info.role === "user" && message.parts.some(
      (part) => part.type === "text" && part.synthetic !== true && !part.ignored,
    ))
  if (!previousUser || previousUser.info.role !== "user") return { toolIDs: [] }

  const ledger = RuntimeTaskLedger.listTasks(input.sessionID)
  const transcriptPendingMethods = unresolvedMethodDecisionIDs(messages, previousUser.info.id)
  const lifecyclePendingMethods = ledger.tasks.flatMap((task) =>
    pendingEstimateMethodsForTask(task, previousUser.info.id),
  )
  const pendingMethods = [...new Set([...transcriptPendingMethods, ...lifecyclePendingMethods])]
  if (!pendingMethods.length) return { toolIDs: [] }
  if (explicitlyDeclined) {
    for (const task of ledger.tasks) {
      const lifecycle = task.analysisLifecycle
      const taskPendingMethods = pendingEstimateMethodsForTask(task, previousUser.info.id)
      if (
        task.analysisRequest?.sourceMessageId !== previousUser.info.id ||
        !lifecycle ||
        lifecycle.status !== "waiting_user" ||
        !pendingMethods.some((methodID) =>
          taskPendingMethods.includes(methodID) ||
          (lifecycle.methodID === methodID && transcriptPendingMethods.includes(methodID)),
        )
      ) continue
      RuntimeTaskLedger.transitionAnalysis({
        sessionID: input.sessionID,
        taskId: task.taskId,
        event: {
          type: "cancelled",
          requestId: task.analysisRequest.requestId,
          outcomeConfirmed: true,
          failureCode: "USER_DECLINED_PENDING_METHOD",
        },
      })
    }
    return { toolIDs: [] }
  }
  const explicitlyRequested = input.focus.requiredToolIDs ?? []
  const toolIDs = explicitlyRequested.length > 0
    ? pendingMethods.filter((methodID) => explicitlyRequested.includes(methodID))
    : pendingMethods
  // 明确点名另一个方法时，不能把旧方法授权带过去；点名待决方法时则延续该决策，
  // 即使意图分类器把“确认/继续”误落为闲聊。
  if (explicitlyRequested.length > 0 && toolIDs.length === 0) return { toolIDs: [] }
  if (toolIDs.length === 0) return { toolIDs: [] }
  const previousPromptParts = previousUser.parts.filter(
    (part) => part.type === "text" || part.type === "file" || part.type === "agent" || part.type === "subtask",
  ) as PromptInput["parts"]
  const previousFocus = detectToolFocus(previousPromptParts)
  const continuesPsmDiagnostics = toolIDs.some((methodID) =>
    methodID === "psm_construction" || methodID === "psm_visualize",
  ) && previousFocus.psmToolScope === "diagnostics_only"
  return {
    toolIDs,
    ...(continuesPsmDiagnostics ? { psmToolScope: "diagnostics_only" as const } : {}),
  }
}

async function injectRequiredMethodReminder(input: {
  sessionID: string
  user: MessageV2.User
  requiredToolIDs: string[]
  missingToolIDs: string[]
  analysisOutcomePending?: boolean
  attempt: number
}) {
  const analysisPreparationPending = input.missingToolIDs.includes("analysis_prepare")
  const explicitMethods = input.requiredToolIDs.filter((toolID) => toolID !== "analysis_prepare")
  const reminder: MessageV2.User = {
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    time: { created: Date.now() },
    agent: input.user.agent,
    model: input.user.model,
    role: "user",
  }
  await Session.updateMessage(reminder)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: reminder.id,
    sessionID: input.sessionID,
    type: "text",
    synthetic: true,
    text: [
      "<system-reminder>",
      ...(analysisPreparationPending
        ? ["当前任务已登记为估计请求，但还没有与当前数据阶段绑定、通过 Python Registry 校验的规格。不要仅用普通文本收尾。先导入/诊断当前数据，调用 tool_search 获取完整方法 Schema，再调用 analysis_prepare 做只读预检；缺少研究角色时用 question 澄清，前置条件不满足时明确停在诊断状态。"]
        : []),
      ...(input.analysisOutcomePending
        ? ["当前 estimate 请求还没有成功估计结果或明确的用户决策停点。PreparedSpec 只表示技术预检通过，不代表估计已经运行；如果规格已获授权，请用 econometrics_execute({specId}) 执行当前规格。若方法选择或研究设定仍需用户决定，请用 question 建立等待确认停点；不得仅用文字声称分析完成。"]
        : []),
      ...(explicitMethods.length
        ? ["用户本轮明确要求执行：" + explicitMethods.map(methodDisplayName).join("、") + "。"]
        : []),
      ...(input.missingToolIDs.length
        ? ["已完成的工具结果不能重复执行；当前尚未满足：" + input.missingToolIDs.map(methodDisplayName).join("、") + "。"]
        : []),
      "如果研究设计或数据条件不满足，必须明确说明原因，不得伪造结果或擅自改变研究含义。",
      `这是完成度提醒 ${input.attempt}/${REQUIRED_METHOD_CONTINUATION_LIMIT}。`,
      "</system-reminder>",
    ].join("\n"),
  } satisfies MessageV2.TextPart)
}

async function injectRepairReplanReminder(input: {
  sessionID: string
  user: MessageV2.User
  toolName?: string
  attempt: number
}) {
  const reminder: MessageV2.User = {
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    time: { created: Date.now() },
    agent: input.user.agent,
    model: input.user.model,
    role: "user",
  }
  await Session.updateMessage(reminder)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: reminder.id,
    sessionID: input.sessionID,
    type: "text",
    synthetic: true,
    text: [
      "<system-reminder>",
      `上一个修复轮${input.toolName ? `针对 ${input.toolName}` : "针对失败工具"}只返回了文字，尚未证明问题已解决。`,
      "不要把未执行的分析或未生成的结果写成已完成。请重新判断失败原因，并选择正确的已注册工具；必要时先调用 tool_search、glob、list 或 read 定位真实路径和 schema，再执行修复动作。",
      "如果下一步会改变研究设计、样本、变量角色或计量方法，改用 question 或普通中文向用户确认；不要猜测、不要原样重试失败调用。",
      `这是修复后的重新规划机会 ${input.attempt}/${AUTOMATIC_TOOL_REPAIR_LIMIT}。`,
      "</system-reminder>",
    ].join("\n"),
  } satisfies MessageV2.TextPart)
}

async function persistUserRequestedResearchStop(input: {
  sessionID: string
  parentID: string
  user: MessageV2.User
}) {
  const created = Date.now()
  const message = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    parentID: input.parentID,
    role: "assistant",
    mode: input.user.agent,
    agent: input.user.agent,
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: input.user.model.modelID,
    providerID: input.user.model.providerID,
    time: { created, completed: created },
    finish: "stop",
    sessionID: input.sessionID,
  })) as MessageV2.Assistant
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID: input.sessionID,
    type: "text",
    text: "已按你的要求停止。当前工具无法安全构造事件研究所需的 cohort/relative_time 变量；没有猜测阈值、修改数据或继续估计。请提供这两列，或确认明确的构造规则后再继续。",
  } satisfies MessageV2.TextPart)
}

async function persistUserDecisionStop(input: {
  sessionID: string
  parentID: string
  user: MessageV2.User
}) {
  const created = Date.now()
  const message = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    parentID: input.parentID,
    role: "assistant",
    mode: input.user.agent,
    agent: input.user.agent,
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: input.user.model.modelID,
    providerID: input.user.model.providerID,
    time: { created, completed: created },
    finish: "stop",
    sessionID: input.sessionID,
  })) as MessageV2.Assistant
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID: input.sessionID,
    type: "text",
    text: "本轮已暂停。当前方法或数据规格需要你确认，框架没有继续执行被阻断的估计，也没有擅自更换计量方法。请根据上方的具体诊断选择下一步。",
  } satisfies MessageV2.TextPart)
}

async function persistRuntimeFailureStop(input: {
  sessionID: string
  parentID: string
  user: MessageV2.User
  decision: RuntimeFailureDecision
}) {
  const created = Date.now()
  const message = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    parentID: input.parentID,
    role: "assistant",
    mode: input.user.agent,
    agent: input.user.agent,
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: input.user.model.modelID,
    providerID: input.user.model.providerID,
    time: { created, completed: created },
    finish: "stop",
    sessionID: input.sessionID,
  })) as MessageV2.Assistant
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID: input.sessionID,
    type: "text",
    text: `${input.decision.userVisibleMessage}\n\n本轮自动执行已停止，未将未完成的分析写成成功结果。你可以根据上述原因调整研究设定或数据后，从失败阶段继续。`,
  } satisfies MessageV2.TextPart)
}

async function persistRequiredMethodStop(input: {
  sessionID: string
  parentID: string
  user: MessageV2.User
  completedToolIDs: string[]
  missingToolIDs: string[]
}) {
  const created = Date.now()
  const message = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    parentID: input.parentID,
    role: "assistant",
    mode: input.user.agent,
    agent: input.user.agent,
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: input.user.model.modelID,
    providerID: input.user.model.providerID,
    time: { created, completed: created },
    finish: "stop",
    sessionID: input.sessionID,
  })) as MessageV2.Assistant
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID: input.sessionID,
    type: "text",
    text: `本轮已完成${input.completedToolIDs.map(methodDisplayName).join("、")}，但尚未实际执行${input.missingToolIDs.map(methodDisplayName).join("、")}；未将未执行的方法写成结果。请确认是否继续执行未完成的方法。`,
  } satisfies MessageV2.TextPart)
}

async function persistIncompleteEstimateStop(input: {
  sessionID: string
  parentID: string
  user: MessageV2.User
  taskId: string
  requestId: string
  completedMethodIDs: string[]
  pendingMethodIDs: string[]
}) {
  RuntimeTaskLedger.transitionAnalysis({
    sessionID: input.sessionID,
    taskId: input.taskId,
    event: {
      type: "decision_required",
      requestId: input.requestId,
      issueCode: "ESTIMATE_REQUEST_INCOMPLETE",
      pendingMethodIDs: input.pendingMethodIDs,
    },
  })
  const created = Date.now()
  const message = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    parentID: input.parentID,
    role: "assistant",
    mode: input.user.agent,
    agent: input.user.agent,
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: input.user.model.modelID,
    providerID: input.user.model.providerID,
    time: { created, completed: created },
    finish: "stop",
    sessionID: input.sessionID,
  })) as MessageV2.Assistant
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID: input.sessionID,
    type: "text",
    text: [
      input.completedMethodIDs.length
        ? `本轮已完成${[...new Set(input.completedMethodIDs)].map(methodDisplayName).join("、")}；`
        : "本轮估计请求尚未完成：",
      `尚未实际执行${[...new Set(input.pendingMethodIDs.filter(isWorkflowEstimateCompletionTool))].map(methodDisplayName).join("、") || "计量估计"}。`,
      "当前没有覆盖全部请求方法且通过结果契约核验的估计结果。已准备的规格不等于估计完成。",
      "为避免把未完成的分析误显示为完整结果，本轮已暂停；请确认是否继续剩余方法，或补充需要确认的研究设定。",
    ].join(""),
  } satisfies MessageV2.TextPart)
}

function methodMentioned(text: string, methodID: string) {
  const aliases = new Set([
    methodID,
    methodID.replace(/_regression$/, "").replace(/_/g, " "),
    methodDisplayName(methodID),
  ])
  if (methodID === "ols_regression") aliases.add("OLS")
  if (methodID === "panel_fe_regression") aliases.add("双向固定效应")
  if (methodID === "robust_regression") aliases.add("RLM")
  const normalized = text.toLowerCase()
  return [...aliases].some((alias) => alias && normalized.includes(alias.toLowerCase()))
}

export function claimsEstimateSuccessWithoutEvidence(
  text: string,
  pendingMethodIDs: readonly string[] = [],
  completedMethodIDs: readonly string[] = [],
) {
  const clauses = text
    .split(/[，,。；;！？!?\n]+|\b(?:but|however)\b|但是|不过|但/i)
    .map((clause) => clause.trim())
    .filter(Boolean)
  return clauses.some((clause) => {
    const claimsSuccess = /(?:已完成|已经完成|成功完成|已成功|跑完|完成了|结果(?:已生成|显示|表明|显著|如下)|系数\s*[:：=]|标准误\s*[:：=]|\bp\s*[<≤=]|R²\s*[:：=]|\bN\s*[:：=]|\bsignificant\b|\bcoefficient\s*[:：=]|\b(?:completed|finished|successfully|estimated|fitted)\b)/i.test(clause)
    if (!claimsSuccess) return false

    const explicitlyIncomplete = /(?:未|尚未|还没|没有|并未|未能|不能)(?:实际)?(?:执行|运行|估计|回归|完成|生成|计算)|\b(?:not|never|hasn't|isn't)\s+(?:yet\s+)?(?:been\s+)?(?:completed|executed|run|estimated|fitted|generated)\b/i.test(clause)
    if (explicitlyIncomplete) return false

    const claimsWholeRequest = /(?:所有|全部|均|都|整组|整个分析|本轮分析|整体(?:分析)?|两种(?:方法|模型)?|两个模型|both|all(?:\s+requested)?|entire(?:\s+analysis|\s+comparison)?|overall)/i.test(clause)
    if (claimsWholeRequest) return true
    if (pendingMethodIDs.some((methodID) => methodMentioned(clause, methodID))) return true

    const namesCompletedMethod = completedMethodIDs.some((methodID) => methodMentioned(clause, methodID))
    if (namesCompletedMethod) return false
    // If no successful method can be attributed to this statement, a generic success
    // claim is unsupported while the estimate request remains incomplete.
    return true
  })
}

async function hideEstimateSuccessClaimWithoutResult(
  message: MessageV2.WithParts,
  pendingMethodIDs: readonly string[],
  completedMethodIDs: readonly string[],
) {
  const parts = await MessageV2.parts(message.info.id)
  let hidden = false
  for (const part of parts) {
    if (
      part.type !== "text" || part.synthetic || part.ignored ||
      !claimsEstimateSuccessWithoutEvidence(part.text, pendingMethodIDs, completedMethodIDs)
    ) continue
    await Session.updatePart({ ...part, ignored: true })
    hidden = true
  }
  return hidden
}

/**
 * 主调度循环：消费队列、驱动模型轮次、处理压缩与自动修复。
 *
 * `dispatch` 与 `startDispatch` 互相调用（dispatch 收尾会 queueMicrotask 回
 * startDispatch），是同一个循环的两半，必须留在同一模块，拆开必然成环。
 */

export function startDispatch(sessionID: string) {
  void dispatch(sessionID).catch((error) => {
    // 用户主动中断（点击停止 / esc）：cancel() 已优雅收尾并把会话置为 cancelled。
    // in-flight 请求随后会以取消错误 unwind 到这里——这不是故障，静默结束即可，
    // 否则会把 "Session prompt cancelled" 的堆栈当失败 log 到界面。
    if (error instanceof Session.CancelledError || (error instanceof Error && error.name === "AbortError")) {
      log.info("dispatch cancelled", { sessionID })
      return
    }
    log.error("dispatch failed", { sessionID, error })
    SessionRunCoordinator.fail(sessionID, error)
  })
}

export const prompt = fn(PromptInput, async (input) => {
  log.info("prompt start", {
    sessionID: input.sessionID,
    messageID: input.messageID,
    noReply: input.noReply,
    partCount: input.parts.length,
  })
  const session = await Session.get(input.sessionID)
  await SessionRevert.cleanup(session)

  const message = await createUserMessage(input)
  log.info("prompt user message created", {
    sessionID: input.sessionID,
    messageID: message.info.id,
    partCount: message.parts.length,
  })
  await Session.touch(input.sessionID)

  // this is backwards compatibility for allowing `tools` to be specified when
  // prompting
  const permissions: PermissionNext.Ruleset = []
  for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
    permissions.push({
      permission: tool,
      action: enabled ? "allow" : "deny",
      pattern: "*",
    })
  }
  if (permissions.length > 0) {
    session.permission = permissions
    await Session.update(session.id, (draft) => {
      draft.permission = permissions
    })
  }

  if (input.noReply === true) {
    log.info("prompt noReply returning", {
      sessionID: input.sessionID,
      messageID: message.info.id,
    })
    return message
  }

  const detectedIntent = detectInputIntent(
    input.parts,
    input.intent,
    DataContext.hasActiveDataset(input.sessionID),
    isAnalysisWorkflowActive(input.sessionID),
  )
  const toolFocus = detectToolFocus(input.parts)
  const currentUserText = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
  const carriedMethodDecision = await carryPendingMethodDecision({
    sessionID: input.sessionID,
    currentMessage: message,
    agent: message.info.agent,
    intent: detectedIntent,
    text: currentUserText,
    focus: toolFocus,
  })
  const effectiveIntent = carriedMethodDecision.toolIDs.length > 0 ? "analysis" : detectedIntent

  const delivery = input.queueMetadata?.delivery === "steer" ? "steer" : "queued"
  const queued = await enqueueAction(input.sessionID, {
    type: input.queueActionType ?? "prompt",
    priority: input.queuePriority ?? (delivery === "steer" ? 30 : 10),
    metadata: {
      messageID: message.info.id,
      intent: effectiveIntent,
      hasImageInput: input.parts.some((part) => part.type === "file" && part.mime?.startsWith("image/")),
      hasDataAttachment: input.parts.some((part) =>
        part.type === "file" && isDataFile(part.filename ?? (part.source?.type === "file" ? part.source.path : "")),
      ),
      inputGraph: inputGraphFromParts(input.parts, effectiveIntent),
      preferredToolIDs: [...new Set([...(toolFocus.preferredToolIDs ?? []), ...carriedMethodDecision.toolIDs])],
      psmToolScope: toolFocus.psmToolScope ?? carriedMethodDecision.psmToolScope,
      psmScopeFilter: toolFocus.psmScopeFilter,
      // Verifier 的输入正文会包含被核验的方法名和执行指令，但其工具集被显式禁用；
      // 不应把父任务的完成门禁套到这个只读子会话上，否则它会被反复要求执行被禁止的估计器。
      requiredToolIDs: input.agent === "verifier" ? [] : [...new Set([...(toolFocus.requiredToolIDs ?? []), ...carriedMethodDecision.toolIDs])],
      confirmedToolIDs: toolFocus.confirmedToolIDs,
      allowTask: toolFocus.allowTask,
      ...(input.queueMetadata ?? {}),
      delivery,
    },
  })
  const completion = waitForAction(input.sessionID, queued.id)

  log.info("prompt entering loop", {
    sessionID: input.sessionID,
    messageID: message.info.id,
  })
  startDispatch(input.sessionID)
  return completion
})

export function cancel(sessionID: string, error: Session.CancelledError = new Session.CancelledError(sessionID)) {
  log.info("cancel", { sessionID })
  SessionRunCoordinator.cancel(sessionID, error)
  return
}

export const loop = fn(Identifier.schema("session"), async (sessionID) => {
  const completion = waitForAction(sessionID)
  startDispatch(sessionID)
  return completion
})

export async function dispatch(sessionID: string) {
  const begun = SessionRunCoordinator.tryBeginDispatch(sessionID)
  if (!begun) {
    return
  }
  const { generation, abort } = begun
  if (!SessionRunCoordinator.startDispatch(sessionID, generation)) {
    SessionRunCoordinator.cancelDispatch(sessionID, generation)
    return
  }
  let activeAction: QueuedSessionAction | undefined

  using _ = defer(() => {
    SessionRunCoordinator.finishDispatch(sessionID, generation)
    // 自动钩子：会话结束清掉**本会话**的 verifier/task 子会话（已完成审计 + 临时子进程
    // 留下来的 process 一直占 storage，不清理会逐年膨胀——参考 2026-07 累积 767 个子会话）。
    // scopeSessionID 必须传：不清 scope 会全项目扫，新窗口一条消息退出就误删别的会话的
    // child verifier（2026-08-08 会话隔离修复）。仅清子会话，顶层会话不删。
    cleanupSessions({ childSessionsOnly: true, scopeSessionID: sessionID }).catch((error) => {
      log.error("auto child-session cleanup failed", { sessionID, error })
    })
    if (SessionRunCoordinator.pending(sessionID) > 0) {
      queueMicrotask(() => startDispatch(sessionID))
    }
  })

  let step = 0
  let automaticToolRepairs = 0
  let contextCompactionAttempts = 0
  let activeRepairToolName: string | undefined
  let activeRepairInputSignature: string | undefined
  // 工具失败后的 repair 轮不能因为模型先输出一段普通文字就直接收尾；
  // 但它也不能无限自转。该状态只覆盖当前用户动作，并受同一个三次预算保护。
  let repairContinuationPending = false
  let repairContinuationToolName: string | undefined
  // 合成 replan 提醒写入后，下一轮必须先请求模型；不能再次拿同一个旧的
  // text-only assistant 结果触发第二次提醒。
  let repairReplanAwaitingModel = false
  let requiredMethodReplanAwaitingModel = false
  let thrashingReminderInjected = false
  let requiredMethodContinuationAttempts = 0
  let requiredMethodProgressAtLastContinuation = ""
  // 用户拒绝变量替换/研究设计后，停止状态必须跨模型回合保留；否则下一轮模型
  // 可能拿着候选列继续调用估计器，越过刚刚的用户决定。
  let userDecisionStop = { value: false }
  // 研究变量替换的确认只在当前用户动作内有效；下一条用户消息会重新建立这份状态，
  // 避免一次“year→年份”的授权蔓延到后续不同分析。
  let confirmedVariableSubstitutions = new Set<string>()
  // post 构造规则同样只在当前用户动作内有效；参数修复会重建工具 port，
  // 所以用可变引用跨 repair 回合保留用户刚确认的规则。
  let confirmedPolicyConstruction = { value: false }
  // 同一用户动作可能跨多个模型回合（工具结果→verifier→继续请求）。成功结果在这个
  // dispatch 生命周期内可复用，避免模型误读产物后重复跑同规格估计；动作完成/切换后清空，
  // 因此用户发起显式重跑不会被旧结果拦截。
  let successfulToolResults = new Map<string, unknown>()
  let resumedAnalysisTaskId: string | undefined
  const session = await Session.get(sessionID)
  while (true) {
    SessionStatus.set(sessionID, { type: "busy" })
    log.info("loop", { step, sessionID })
    if (abort.aborted) break
    if (!activeAction && SessionRunCoordinator.pending(sessionID) > 0) {
      activeAction = nextQueuedAction(sessionID)
      resumedAnalysisTaskId = undefined
      successfulToolResults = new Map<string, unknown>()
      confirmedVariableSubstitutions = new Set<string>()
      confirmedPolicyConstruction = { value: false }
      requiredMethodContinuationAttempts = 0
      requiredMethodProgressAtLastContinuation = ""
      repairContinuationPending = false
      repairContinuationToolName = undefined
      repairReplanAwaitingModel = false
      requiredMethodReplanAwaitingModel = false
      userDecisionStop = { value: false }
    }
    // 从最近 compact_boundary 之后加载：边界之前的消息不再读盘（磁盘仍是 append-only 全量）。
    let msgs = await MessageV2.filterCompacted(MessageV2.streamSinceCompactBoundary(sessionID))

    let lastUser: MessageV2.User | undefined
    let lastUserText: string | undefined
    let lastAssistant: MessageV2.Assistant | undefined
    let lastFinished: MessageV2.Assistant | undefined
    let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
    const activeMessageID = actionMessageID(activeAction)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!lastUser && msg.info.role === "user" && (!activeMessageID || msg.info.id === activeMessageID)) {
        lastUser = msg.info as MessageV2.User
        lastUserText = msg.parts
          .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
          .map((part) => part.text.trim())
          .filter(Boolean)
          .join("\n") || undefined
      }
      if (
        !lastAssistant &&
        msg.info.role === "assistant" &&
        (!activeMessageID || msg.info.parentID === activeMessageID)
      )
        lastAssistant = msg.info as MessageV2.Assistant
      if (
        !lastFinished &&
        msg.info.role === "assistant" &&
        msg.info.finish &&
        (!activeMessageID || msg.info.parentID === activeMessageID)
      )
        lastFinished = msg.info as MessageV2.Assistant
      if (lastUser && lastFinished) break
      const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
      if (task && !lastFinished) {
        tasks.push(...task)
      }
    }

    const lastUserMessage = lastUser ? msgs.find((message) => message.info.id === lastUser!.id) : undefined
    const hasAnalysisContinuationMarker = Boolean(lastUserMessage?.parts.some((part) =>
      part.type === "text" && part.synthetic && part.text.includes("<killstata-analysis-continuation>"),
    ))
    if (hasAnalysisContinuationMarker) resumedAnalysisTaskId = RuntimeTaskLedger.listTasks(sessionID).activeTaskId
    const resumesAnalysisAfterCompaction = Boolean(resumedAnalysisTaskId)
    const resumedLedger = resumesAnalysisAfterCompaction ? RuntimeTaskLedger.listTasks(sessionID) : undefined
    const resumedTask = resumedLedger?.tasks.find((item) => item.taskId === resumedAnalysisTaskId)
    const savedTaskMetadata = resumedTask?.metadata ?? {}
    const asStringList = (value: unknown) => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : []
    const resumedIntentValue = savedTaskMetadata.intent
    const resumedIntent = typeof resumedIntentValue === "string" &&
      ["conversation", "ingest", "status", "verify", "repair", "report", "analysis"].includes(resumedIntentValue)
      ? resumedIntentValue as WorkflowInputIntent
      : undefined
    const activeInputIntent = (activeAction?.metadata?.intent as WorkflowInputIntent | undefined) ?? resumedIntent
    const requiredToolIDs = asStringList(activeAction?.metadata?.requiredToolIDs).length
      ? asStringList(activeAction?.metadata?.requiredToolIDs)
      : asStringList(savedTaskMetadata.requiredToolIDs)
    const preferredToolIDs = asStringList(activeAction?.metadata?.preferredToolIDs).length
      ? asStringList(activeAction?.metadata?.preferredToolIDs)
      : asStringList(savedTaskMetadata.preferredToolIDs)
    const confirmedToolIDs = asStringList(activeAction?.metadata?.confirmedToolIDs).length
      ? asStringList(activeAction?.metadata?.confirmedToolIDs)
      : asStringList(savedTaskMetadata.confirmedToolIDs)
    const resumedSourceUserMessageId = resumesAnalysisAfterCompaction
      ? resumedTask?.analysisRequest?.sourceMessageId
      : undefined
    let effectiveUserText = lastUserText
    if (resumedSourceUserMessageId) {
      try {
        const originalMessage = await MessageV2.get({ sessionID, messageID: resumedSourceUserMessageId })
        effectiveUserText = originalMessage.parts
          .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
          .map((part) => part.text.trim())
          .filter(Boolean)
          .join("\n") || resumedTask?.analysisRequest?.researchGoal || lastUserText
      } catch {
        effectiveUserText = resumedTask?.analysisRequest?.researchGoal || lastUserText
      }
    }

    // ─── workflow thrashing 防护（2026-08-08 did.xlsx 真实测试死循环）───
    // 模型在 ARTIFACT_MISSING 这类无法靠工具调用解决的问题前反复试同一类 workflow
    // 工具（verify/status/artifacts/doctor/rerun_plan/restore），5+ 步无果且 workflow
    // 状态不变。检测到 thrashing 后注入 synthetic 提醒让它停下向用户汇报，而不是
    // 继续消耗 token 盲试。
    // 注入的消息必须沿用真实用户消息的 agent/model（不能 system/reminder）：dispatch
    // 下一轮会把最后一条 user 消息当 lastUser 去 getModel，synthetic 的
    // providerID="system" 会直接崩溃（2026-08-09 drive did-direct 实测）。
    const thrashing = detectWorkflowThrashing(msgs, { userText: lastUserText })
    const reminderWasAlreadyInjected = thrashingReminderInjected
    if (thrashing.thrashing && !reminderWasAlreadyInjected && !abort.aborted) {
      thrashingReminderInjected = true
      await injectThrashingReminder(sessionID, activeRepairToolName, thrashing, lastUser)
      // synthetic reminder 必须进入本次 API 请求；否则首次检测只会写入磁盘，模型仍会
      // 用旧消息继续探索，浪费一整轮甚至触发新的工具调用。
      msgs = await MessageV2.filterCompacted(MessageV2.streamSinceCompactBoundary(sessionID))
    }
    // 提醒后模型仍继续发起同类只读查询时，不能再把希望寄托在模型一定会听话：
    // 当前动作必须有一个可交付的停点，否则后续用户消息会一直卡在队列里直到超时。
    // 只对仍以 tool-calls 结束的上一轮生效；正常文本收尾不被误截断。
    if (
      thrashing.thrashing &&
      reminderWasAlreadyInjected &&
      lastUser &&
      lastAssistant &&
      !abort.aborted
    ) {
      if (thrashing.researchDesign && userRequestedResearchDesignStop(lastUserText)) {
        await persistUserRequestedResearchStop({ sessionID, parentID: lastUser.id, user: lastUser })
      } else if (lastAssistant.finish === "tool-calls") {
        await persistThrashingStop({
          sessionID,
          parentID:
            typeof activeAction?.metadata?.["messageID"] === "string"
              ? activeAction.metadata["messageID"]
              : lastUser.id,
          user: lastUser,
        })
      } else {
        // 普通文本收尾已经是模型的停点，不能额外覆盖它。
        break
      }
      break
    }
    const currentTask = activeAction
      ? RuntimeTaskLedger.listTasks(sessionID).tasks.find((item) => item.taskId === activeAction?.id)
      : resumedTask
    const currentWorkflow = getActiveWorkflowRun(sessionID)
    const currentData = currentWorkflow ? canonicalDataStageForWorkflow(currentWorkflow) : null
    const currentUserMessages = lastUser
      ? msgs.filter((message) => message.info.role === "assistant" && message.info.parentID === lastUser!.id)
      : []
    const activeAnalysisRequest = currentTask?.analysisRequest && (
      currentTask.analysisRequest.sourceMessageId === lastUser?.id || resumesAnalysisAfterCompaction
    ) ? currentTask.analysisRequest : undefined
    const activeAnalysisLifecycle = activeAnalysisRequest &&
      currentTask?.analysisLifecycle?.requestId === activeAnalysisRequest.requestId
      ? currentTask.analysisLifecycle
      : undefined
    const lifecycleDecisionStop = activeAnalysisLifecycle &&
      ["waiting_user", "failed", "cancelled", "unconfirmed"].includes(activeAnalysisLifecycle.status)
    const hasDecisionStop = userDecisionStop.value ||
      Boolean(lifecycleDecisionStop) ||
      currentUserMessages.some((message) =>
      message.parts.some((part) =>
        part.type === "tool" && part.state.status === "completed" && part.state.metadata?.requiresUserDecision === true,
      ),
    )
    const requiredActionToolIDs = [...new Set([...requiredToolIDs, ...confirmedToolIDs])]
    const requiredEstimateMethodIDs = requiredActionToolIDs.filter(isWorkflowEstimateCompletionTool)
    const expectedEstimateMethodIDs = activeAnalysisRequest
      ? expectedEstimateMethodIDsForRequest(requiredEstimateMethodIDs, activeAnalysisLifecycle, activeAnalysisRequest.requestId)
      : requiredEstimateMethodIDs
    const hasSuccessfulEstimate = Boolean(activeAnalysisRequest && hasCompletedRequiredEstimateMethods(
      requiredEstimateMethodIDs,
      activeAnalysisLifecycle,
      activeAnalysisRequest.requestId,
    ))
    const analysisCompletionPending = needsAnalysisCompletion({
      request: activeAnalysisRequest,
      hasDecisionStop,
      hasSuccessfulEstimate,
    })
    const analysisPreparationPending = lastUser
      ? needsAnalysisPreparation({
          request: activeAnalysisRequest,
          preparedSpec: currentTask?.preparedSpec,
          currentData,
          hasDecisionStop,
          hasSuccessfulEstimate,
        })
      : false
    const lifecycleCompletedMethods = new Set(
      activeAnalysisLifecycle?.specRuns
        .filter((run) =>
          run.requestId === activeAnalysisRequest?.requestId &&
          run.status === "completed" &&
          run.resultContractStatus === "pass",
        )
        .map((run) => run.methodID) ?? [],
    )
    const pendingRequiredToolIDs = resumesAnalysisAfterCompaction
      ? requiredActionToolIDs.filter((toolID) => !lifecycleCompletedMethods.has(toolID))
      : requiredActionToolIDs
    const requiredMethodGaps = (activeAction || resumesAnalysisAfterCompaction) && lastUser
      ? [
          ...missingRequiredMethodIDs(
            activeAnalysisRequest?.kind === "estimate"
              ? pendingRequiredToolIDs.filter((toolID) => !isWorkflowEstimateCompletionTool(toolID))
              : pendingRequiredToolIDs,
            msgs,
            lastUser.id,
          ),
          ...(activeAnalysisRequest?.kind === "estimate" && activeAnalysisRequest.requestId
            ? missingRequiredEstimateMethodIDs(
                expectedEstimateMethodIDs,
                activeAnalysisLifecycle,
                activeAnalysisRequest.requestId,
              )
            : []),
        ]
      : []
    const requiredGap = [
      ...requiredMethodGaps,
      ...(analysisPreparationPending ? ["analysis_prepare"] : []),
    ]
    // repair 尚未收敛时，模型的一段普通文字不能把用户动作提前标记为完成；
    // 否则会绕过下面的 repair continuation，正是“错误一次、文字收尾、直接拉倒”的根因。
    const completedAction = activeAction && !repairContinuationPending && requiredGap.length === 0 && !analysisCompletionPending
      ? completedReplyForAction(activeAction, msgs)
      : undefined
    if (completedAction) {
      resolveCallbacks(sessionID, completedAction, activeAction?.id)
      activeAction = undefined
      successfulToolResults = new Map<string, unknown>()
      if (SessionRunCoordinator.pending(sessionID) > 0) continue
    }

    if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
    const lastAssistantMessage = lastAssistant
      ? msgs.find((message) => message.info.id === lastAssistant.id)
      : undefined
    const lastAssistantHasToolError = Boolean(
      lastAssistantMessage?.parts.some(
        (part) => part.type === "tool" && part.state.status === "error",
      ),
    )
    const lastAssistantHasCompletedTool = Boolean(
      lastAssistantMessage?.parts.some(
        (part) => part.type === "tool" && part.state.status === "completed",
      ),
    )
    if (
      repairContinuationPending &&
      lastAssistant?.finish === "tool-calls" &&
      lastAssistantHasCompletedTool &&
      !lastAssistantHasToolError
    ) {
      repairContinuationPending = false
      repairContinuationToolName = undefined
    }
    let lastAssistantText = lastAssistantMessage?.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n") ?? ""
    if (activeAnalysisRequest?.kind === "estimate" && !hasSuccessfulEstimate && lastAssistantMessage) {
      const missingEstimateMethodIDs = activeAnalysisRequest.requestId
        ? missingRequiredEstimateMethodIDs(
            expectedEstimateMethodIDs,
            activeAnalysisLifecycle,
            activeAnalysisRequest.requestId,
          )
        : []
      const completedEstimateMethodIDs = expectedEstimateMethodIDs.filter((methodID) => lifecycleCompletedMethods.has(methodID))
      const hidden = await hideEstimateSuccessClaimWithoutResult(
        lastAssistantMessage,
        missingEstimateMethodIDs,
        completedEstimateMethodIDs,
      )
      if (hidden) lastAssistantText = ""
    }
    const skipRepeatedRepairTextCheck = repairReplanAwaitingModel
    repairReplanAwaitingModel = false
    const skipRepeatedRequiredMethodTextCheck = requiredMethodReplanAwaitingModel
    requiredMethodReplanAwaitingModel = false
    const textOnlyRepair =
      !skipRepeatedRepairTextCheck &&
      !skipRepeatedRequiredMethodTextCheck &&
      repairContinuationPending &&
      lastAssistant?.finish &&
      !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
      lastUser.id < lastAssistant.id
    if (
      textOnlyRepair &&
        shouldReplanAfterRepairText({
          repairPending: true,
          attempts: automaticToolRepairs,
          text: lastAssistantText,
          latestUserText: lastUserText,
        })
    ) {
      automaticToolRepairs += 1
      await injectRepairReplanReminder({
        sessionID,
        user: lastUser,
        toolName: repairContinuationToolName,
        attempt: automaticToolRepairs,
      })
      repairReplanAwaitingModel = true
      continue
    }
    if (
      !skipRepeatedRepairTextCheck &&
      !skipRepeatedRequiredMethodTextCheck &&
      lastAssistant?.finish &&
      !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
      lastUser.id < lastAssistant.id
    ) {
      if (
        (requiredGap.length > 0 || analysisCompletionPending) &&
        (activeAction || resumesAnalysisAfterCompaction || activeAnalysisRequest?.kind === "estimate") &&
        !abort.aborted
      ) {
        if (hasDecisionStop) {
          // analysis_prepare 的结构化阻断已经是明确停点。不能再注入“本轮已完成但未执行”
          // 的必完成提醒；它会把等待研究者选择误写成一次普通的未完成方法重试。
          await persistUserDecisionStop({ sessionID, parentID: lastUser.id, user: lastUser })
          break
        }
        const currentProgress = requiredMethodProgressSignature(msgs, lastUser.id)
        if (currentProgress !== requiredMethodProgressAtLastContinuation) {
          requiredMethodContinuationAttempts = 0
          requiredMethodProgressAtLastContinuation = currentProgress
          // 数据准备、质量检查或派生阶段已有新结果时，直接允许下一次工具调用；
          // 这不是一次“模型无进展”的重试，不应插入必完成提醒或消耗有限提醒预算。
          requiredMethodReplanAwaitingModel = true
          continue
        }
        if (requiredMethodContinuationAttempts < REQUIRED_METHOD_CONTINUATION_LIMIT) {
          requiredMethodContinuationAttempts += 1
          if (analysisCompletionPending && requiredGap.length === 0) {
            await injectRequiredMethodReminder({
              sessionID,
              user: lastUser,
              requiredToolIDs: [],
              missingToolIDs: [],
              analysisOutcomePending: true,
              attempt: requiredMethodContinuationAttempts,
            })
          } else {
            await injectRequiredMethodReminder({
              sessionID,
              user: lastUser,
              requiredToolIDs: Array.isArray(requiredToolIDs)
                ? requiredToolIDs.filter((id): id is string => typeof id === "string")
                : [],
              missingToolIDs: requiredGap,
              analysisOutcomePending: analysisCompletionPending,
              attempt: requiredMethodContinuationAttempts,
            })
          }
          requiredMethodReplanAwaitingModel = true
          continue
        }
        if (analysisCompletionPending && activeAnalysisRequest && currentTask) {
          await persistIncompleteEstimateStop({
            sessionID,
            parentID: lastUser.id,
            user: lastUser,
            taskId: currentTask.taskId,
            requestId: activeAnalysisRequest.requestId,
            completedMethodIDs: expectedEstimateMethodIDs.filter((methodID) => lifecycleCompletedMethods.has(methodID)),
            pendingMethodIDs: [
              ...expectedEstimateMethodIDs.filter((methodID) => !lifecycleCompletedMethods.has(methodID)),
              ...(currentTask.preparedSpec?.methodID && !lifecycleCompletedMethods.has(currentTask.preparedSpec.methodID)
                ? [currentTask.preparedSpec.methodID]
                : []),
              ...(currentTask.analysisLifecycle?.methodID && !lifecycleCompletedMethods.has(currentTask.analysisLifecycle.methodID)
                ? [currentTask.analysisLifecycle.methodID]
                : []),
            ].filter(Boolean),
          })
        } else {
          await persistRequiredMethodStop({
            sessionID,
            parentID: lastUser.id,
            user: lastUser,
            completedToolIDs: Array.isArray(requiredToolIDs)
              ? requiredToolIDs.filter((id): id is string => typeof id === "string" && !requiredGap.includes(id))
              : [],
            missingToolIDs: requiredGap,
          })
        }
      }
      log.info("exiting loop", { sessionID })
      break
    }

    step++
    if (step === 1)
      ensureTitle({
        session,
        modelID: lastUser.model.modelID,
        providerID: lastUser.model.providerID,
        history: msgs,
      })

    const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
    const task = tasks.pop()

    // pending subtask：用户通过 @/命令显式创建的任务仍作为普通 task 工具执行，
    // 统一经过 execution policy、权限、串行调度和生命周期事件，不保留直调旁路。
    if (task?.type === "subtask") {
      const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
      const callerAgent = await Agent.get(lastUser.agent)
      const taskTool = await TaskTool.init({ agent: callerAgent })
      const assistantMessage = (await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: {
          created: Date.now(),
        },
      })) as MessageV2.Assistant
      let part = (await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: {
            start: Date.now(),
          },
        },
      })) as MessageV2.ToolPart
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      let executionError: Error | undefined
      const taskCtx: Tool.Context = {
        agent: callerAgent.name,
        messageID: assistantMessage.id,
        sessionID: sessionID,
        abort,
        callID: part.callID,
        // 仅证明用户明确授权了这一次 task 调用；不会跳过 task 内部工具或文件权限。
        extra: { userInitiatedTask: { ...taskArgs } },
        async metadata(input) {
          part = (await Session.updatePart({
            ...part,
            type: "tool",
            state: {
              ...part.state,
              ...input,
            },
          } satisfies MessageV2.ToolPart)) as MessageV2.ToolPart
        },
        progress(input) {
          publishToolProgress({
            sessionID,
            callID: part.callID,
            toolName: TaskTool.id,
            message: input.message,
            metadata: input.metadata,
          })
        },
        async ask(req) {
          await PermissionNext.ask({
            ...req,
            sessionID: sessionID,
            tool: { messageID: assistantMessage.id, callID: part.callID },
            ruleset: PermissionNext.merge(callerAgent.permission, session.permission ?? []),
          })
        },
      }
      const subtaskProcessor = SessionProcessor.create({
        assistantMessage,
        sessionID,
        model: taskModel,
        abort,
      })
      const result = await subtaskProcessor.executeTool(TaskTool.id, taskArgs, {
        callID: part.callID,
        execution: TaskTool.execution,
        run: (finalArgs) => taskTool.execute(finalArgs as typeof taskArgs, taskCtx),
      }).catch((error) => {
        executionError = error
        log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
        return undefined
      })
      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      await Session.updateMessage(assistantMessage)
      if (result && part.state.status === "running") {
        await Session.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments: result.attachments,
            time: {
              ...part.state.time,
              end: Date.now(),
            },
          },
        } satisfies MessageV2.ToolPart)
      }
      if (!result) {
        await Session.updatePart({
          ...part,
          state: {
            status: "error",
            error: executionError ? `工具执行失败：${executionError.message}` : "工具执行失败",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.metadata,
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
      }

      if (task.command) {
        // Add synthetic user message to prevent certain reasoning models from erroring
        // If we create assistant messages w/ out user ones following mid loop thinking signatures
        // will be missing and it can cause errors for models like gemini for example
        const summaryUserMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID,
          role: "user",
          time: {
            created: Date.now(),
          },
          agent: lastUser.agent,
          model: lastUser.model,
        }
        await Session.updateMessage(summaryUserMsg)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: summaryUserMsg.id,
          sessionID,
          type: "text",
          text: "请用中文提炼上方子任务工具的可信结果，并按当前用户目标继续执行；不要未经核验地照抄子 Agent 结论。",
          synthetic: true,
        } satisfies MessageV2.TextPart)
      }

      continue
    }

    // pending compaction
    if (task?.type === "compaction") {
      const result = await SessionCompaction.process({
        messages: msgs,
        parentID: lastUser.id,
        abort,
        sessionID,
        auto: task.auto,
        reason: task.reason,
        customInstructions: task.customInstructions,
      })
      if (result === "stop") break
      continue
    }

    // normal processing
    const agent = await Agent.get(lastUser.agent)
    const maxSteps = agent.steps ?? Infinity
    const isLastStep = step >= maxSteps
    msgs = await insertReminders({
      messages: msgs,
      agent,
      session,
    })

    const sessionMessages = clone(msgs)
    const progressive = await ContextService.projectForModel({
      sessionID,
      messages: sessionMessages,
      inputIntent: activeInputIntent,
      model,
    })
    if (progressive.summaryRequired && lastFinished?.summary !== true) {
      await SessionCompaction.create({
        sessionID,
        agent: lastUser.agent,
        model: lastUser.model,
        auto: true,
        reason: "threshold",
      })
      continue
    }
    const preparedMessages = progressive.messages

    const processor = SessionProcessor.create({
      assistantMessage: (await Session.updateMessage({
        id: Identifier.ascending("message"),
        parentID: lastUser.id,
        role: "assistant",
        mode: agent.name,
        agent: agent.name,
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
        sessionID,
      })) as MessageV2.Assistant,
      sessionID: sessionID,
      model,
      abort,
      inputIntent: activeInputIntent,
      repairToolName: activeRepairToolName,
      repairInputSignature: activeRepairInputSignature,
      onRepairToolSucceeded: () => {
        activeRepairToolName = undefined
        activeRepairInputSignature = undefined
      },
      successfulToolResults,
    })

    if (step === 1) {
      // 恢复的是上轮已经落盘的核验阶段，不会重新执行原计量方法。
      void resumePendingAutomaticVerifiers(sessionID, abort).catch((error) => {
        log.warn("pending verifier resume failed", { sessionID, error })
      })
    }
    const tools = await resolveTools({
      agent,
      session,
      model,
      tools: lastUser.tools,
      processor,
      intent: activeInputIntent,
      hasImageInput: Boolean(activeAction?.metadata?.["hasImageInput"]),
      hasDataAttachment: Boolean(activeAction?.metadata?.["hasDataAttachment"] ?? resumesAnalysisAfterCompaction),
      repairToolName: activeRepairToolName,
      preferredToolIDs,
      requiredToolIDs,
      psmToolScope: (activeAction?.metadata?.["psmToolScope"] ?? savedTaskMetadata.psmToolScope) as "diagnostics_only" | "blocked" | undefined,
      psmScopeFilter: (activeAction?.metadata?.["psmScopeFilter"] ?? savedTaskMetadata.psmScopeFilter) as { column: string; value: string | number } | undefined,
      confirmedToolIDs,
      allowTask: activeAction?.metadata?.["allowTask"] === true || savedTaskMetadata.allowTask === true,
      resumeAnalysisRequest: resumesAnalysisAfterCompaction,
      worksheetName: typeof (activeAction?.metadata?.["desktopWorksheetName"] ?? savedTaskMetadata.desktopWorksheetName) === "string"
        ? String(activeAction?.metadata?.["desktopWorksheetName"] ?? savedTaskMetadata.desktopWorksheetName)
        : undefined,
      sourceUserMessageId: resumedSourceUserMessageId ?? actionMessageID(activeAction),
      userText: effectiveUserText,
      confirmedVariableSubstitutions,
      confirmedPolicyConstruction,
      userDecisionStop,
    })

    if (step === 1) {
      SessionSummary.summarize({
        sessionID: sessionID,
        messageID: lastUser.id,
      })
    }

    const result = await processor.process({
      user: lastUser,
      agent,
      abort,
      sessionID,
      system: [
        ...(await SystemPrompt.environment({
          sessionID,
          messages: msgs,
          inputIntent: activeInputIntent,
          confirmedToolIDs: activeAction?.metadata?.["confirmedToolIDs"] as string[] | undefined,
          analysisRequestId: activeAnalysisRequest?.requestId,
        })),
        ...progressive.system,
      ].filter((item): item is string => typeof item === "string"),
      customSystem: await SystemPrompt.custom(),
      messages: [
        ...MessageV2.toModelMessages(preparedMessages, model),
        ...(isLastStep
          ? [
              {
                role: "assistant" as const,
                content: MAX_STEPS,
              },
            ]
          : []),
      ],
      tools,
      model,
      inputIntent: activeInputIntent,
    })
    if (userDecisionStop.value && lastUser) {
      await persistUserDecisionStop({ sessionID, parentID: lastUser.id, user: lastUser })
      SessionStatus.set(sessionID, { type: "idle" })
      break
    }
    if (result === "stop") {
      const analysisRequestRegistered = (await MessageV2.parts(processor.message.id)).some(
        (part) => part.type === "tool" &&
          part.tool === "analysis_request" &&
          part.state.status === "completed" &&
          part.state.metadata?.analysisRequestRefreshPool === true,
      )
      if (analysisRequestRegistered && activeAction && !abort.aborted) {
        log.info("analysis request registered; rebuilding tool pool for the same user action", {
          sessionID,
          messageID: lastUser?.id,
        })
        continue
      }
      const task = (() => {
        try {
          const ledger = RuntimeTaskLedger.listTasks(sessionID)
          return ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
        } catch {
          return undefined
        }
      })()
      const decision = task?.latestFailureDecision
      if (decision && decision.category !== "user_cancelled" && lastUser) {
        await persistRuntimeFailureStop({
          sessionID,
          parentID: lastUser.id,
          user: lastUser,
          decision,
        })
      }
      break
    }
    if (typeof result === "object" && result.type === "repair") {
      // 估计和 verifier 已经在当前用户动作内完成时，后续 read/pipeline 验证波折
      // 不能再把整个动作锁在 repair 循环里。保留已交付结果，明确说明验证缺口，
      // 让用户决定是否继续诊断；绝不重复估计或把成功说成失败。
      if (lastUser && workflowAnalysisCompletedForAction(sessionID, Number(lastUser.time.created))) {
        const currentAssistant = msgs.findLast(
          (message) => message.info.role === "assistant" && message.info.parentID === lastUser.id,
        )
        if (currentAssistant) {
          const hasVisibleText = currentAssistant.parts.some(
            (part) => part.type === "text" && !part.synthetic && part.text.trim().length > 0,
          )
          if (!hasVisibleText) {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: currentAssistant.info.id,
              sessionID,
              type: "text",
              text: "基准计量估计已经完成并保留结果，但后续验证或结果读取未完成；本轮没有重新估计。若需继续诊断或做稳健性检验，请确认具体方案。",
              time: { start: Date.now(), end: Date.now() },
            } satisfies MessageV2.TextPart)
          }
          resolveCallbacks(sessionID, currentAssistant, activeAction?.id)
        }
        activeAction = undefined
        repairContinuationPending = false
        repairContinuationToolName = undefined
        successfulToolResults = new Map<string, unknown>()
        if (SessionRunCoordinator.pending(sessionID) > 0) continue
        break
      }
      if (shouldAutomaticallyRepairTool(automaticToolRepairs)) {
        if (userRequestedResearchDesignStop(lastUserText) && lastUser) {
          await persistUserRequestedResearchStop({
            sessionID,
            parentID: lastUser.id,
            user: lastUser,
          })
          SessionStatus.set(sessionID, { type: "idle" })
          break
        }
        automaticToolRepairs += 1
        repairContinuationPending = true
        const explicitlyRequestedMethods = requiredToolIDs.filter(isWorkflowAnalysisTool)
        const requestedAlternative = result.lockTool !== false &&
          isWorkflowAnalysisTool(result.toolName) &&
          !explicitlyRequestedMethods.includes(result.toolName) &&
          !activeRepairToolName
          ? explicitlyRequestedMethods[0]
          : undefined
        // 已确认的方法切换（did_static 四格缺失 → did2s）优先于旧方法的锁：
        // 此时不应继续锁定 did_static，否则下一轮 did2s 会被 REPAIR_TOOL_MISMATCH 拦截。
        if (result.confirmedToolIDs?.length) {
          activeRepairToolName = result.confirmedToolIDs[0]
          activeRepairInputSignature = undefined
        } else if (requestedAlternative) {
          // 模型误选了本轮明确要求列表以外的方法时，修复目标回到用户原本点名的方法。
          // 这不是允许模型改研究方法：候选只来自本条请求的 requiredToolIDs，且后续仍受
          // PreparedSpec、方法授权和 Python preflight 门禁约束。
          activeRepairToolName = requestedAlternative
          activeRepairInputSignature = undefined
        } else if (result.lockTool !== false) {
          activeRepairToolName ??= result.toolName
          if (activeRepairToolName === result.toolName) {
            activeRepairInputSignature = result.failedInputSignature
          }
        }
        const repairToolName = activeRepairToolName ?? result.toolName
        repairContinuationToolName = repairToolName

        // 查询本会话该工具的失败历史，按根因给出针对性修复方向（不再一律"换一种参数组合"）。
        // 会话隔离：显式传 sessionID 只看本会话历史——不传会被 Memory.priorReflections 拒收。
        const priorFailures = await Memory.priorReflections(repairToolName, 3, { sessionID }).catch(() => [])
        const historyNotice = repairHistoryNotice(repairToolName, priorFailures)
        const failureDiagnosis = result.failureDiagnosis
        const diagnosisContext = failureDiagnosis
          ? [
              `结构化故障代码：${failureDiagnosis.failureCode}`,
              `失败阶段：${failureDiagnosis.stage}`,
              `是否可安全原样重试：${failureDiagnosis.safeToRetry ? "是（仍受有界预算约束）" : "否；先定位根因并形成具体修复，禁止盲目重复"}`,
              `诊断摘要：${failureDiagnosis.summary_zh}`,
              ...failureDiagnosis.repairOptions.slice(0, 3).map((option) =>
                `可选处理：${option.label_zh}；${option.description_zh}${option.requires_confirmation ? "；执行前需要用户确认" : "；无需用户确认"}`,
              ),
              `无法安全恢复时的用户兜底：${failureDiagnosis.user_fallback_zh}`,
            ].join("\n")
          : ""

        SessionStatus.set(sessionID, {
          type: "repair",
          tool: repairToolName,
          retryStage: result.retryStage,
          message: result.repairAction,
        })
        const repairMessage: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: lastUser.agent,
          model: lastUser.model,
        }
        await Session.updateMessage(repairMessage)

        // ── 数据质量检查 verified fix：先询问用户确认再执行 ──
        // 当 数据质量检查 检测到 duplicate entity-time 并验证了可消解的列组合时（如"组合省份+地区"），
        // 主动向用户展示修复方案并请求确认，而不是直接让模型自行修复——模型可能误判列名
        // 或误删数据（2026-08-12 gf.xlsx 事故根因）。
        const DUPLICATE_KEY_RESOLVED = /verified: combining '([^']+)' with column '([^']+)'/i
        const verifiedFix = result.repairAction.match(DUPLICATE_KEY_RESOLVED)
        if (verifiedFix && result.retryStage === "validate") {
          const [, entityCol, resolvingCol] = verifiedFix
          try {
            const answers = await Question.ask({
              sessionID,
              questions: [{
                header: "实体标识修复",
                question: `数据质量检查检测到 '${entityCol}' 存在重复行，已验证组合 '${entityCol}'+'${resolvingCol}' 可让重复完全消解（得到唯一实体）。是否按此方案自动修复？`,
                options: [
                  { label: "自动修复", description: `用 combine_columns 合并 '${resolvingCol}'+'${entityCol}' 生成复合实体列，然后重新数据质量检查` },
                  { label: "跳过修复", description: "不执行自动修复，由我手动处理" },
                ],
              }],
            })
            const answer = answers[0]?.[0]
            if (answer === "跳过修复") {
              // 用户选择跳过：停止自动修复，让用户手动处理
              SessionStatus.set(sessionID, { type: "idle" })
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: processor.message.id,
                sessionID,
                type: "text",
                text: `已跳过自动修复。你可以手动决定如何处理 '${entityCol}' 的重复行问题。`,
              } satisfies MessageV2.TextPart)
              break
            }
            // 用户确认：继续执行修复（fall through to system-reminder injection below）
          } catch (error) {
            // Question 被取消：视为用户拒绝，停止自动修复，避免在无交互环境下静默执行
            if (error instanceof Question.RejectedError) {
              SessionStatus.set(sessionID, { type: "idle" })
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: processor.message.id,
                sessionID,
                type: "text",
                text: `自动修复已取消（用户未确认）。你可以手动决定如何处理 '${entityCol}' 的重复行问题。`,
              } satisfies MessageV2.TextPart)
              break
            }
            // 其他错误（超时等）：继续执行修复（不阻断流程）
          }
        }

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: repairMessage.id,
          sessionID,
          type: "text",
          synthetic: true,
          text: [
            "<system-reminder>",
            `上一步 ${repairToolName} 执行失败。`,
            `只修复阶段 ${result.retryStage}：${result.repairAction}`,
            result.lockTool === false
              ? "根据上一条脱敏错误选择已注册工具并生成合法参数。"
              : requestedAlternative
                ? `上一步误选的方法“${result.toolName}”不在用户明确请求列表中；本轮只允许恢复到用户已点名的“${requestedAlternative}”，不要再尝试其他方法。`
              : "根据工具参数描述和上一条脱敏错误重写参数；不得更换计量方法，不得原样重复失败参数。",
            diagnosisContext ? `结构化失败诊断：\n${diagnosisContext}` : "",
            `这是自动修复 ${automaticToolRepairs}/${AUTOMATIC_TOOL_REPAIR_LIMIT}。`,
            historyNotice,
            "</system-reminder>",
          ].join("\n"),
        } satisfies MessageV2.TextPart)
        // 把已确认方法（did2s / 事件研究）记到当前 action metadata，下一轮 resolveTools 会
        // 优先加载而不是依赖模型再次 tool_search（2026-08-26 did-direct 第三轮实拍）。
        if (activeAction) {
          activeAction.metadata = {
            ...(activeAction.metadata ?? {}),
            ...(result.confirmedToolIDs?.length
              ? { confirmedToolIDs: result.confirmedToolIDs }
              : {}),
          }
        }
        continue
      }

      SessionStatus.set(sessionID, { type: "idle" })
      const completedBaselineInCurrentAction = (() => {
        try {
          const run = getActiveWorkflowRun(sessionID)
          const latestBaseline = [...(run?.stages ?? [])]
            .reverse()
            .find((stage) => stage.kind === "baseline_estimate")
          if (!latestBaseline || latestBaseline.status !== "completed") return false
          const createdAt = Date.parse(latestBaseline.createdAt)
          const userCreatedAt = Number(lastUser.time.created)
          return Number.isFinite(createdAt) && Number.isFinite(userCreatedAt) && createdAt >= userCreatedAt
        } catch {
          return false
        }
      })()
      const exhaustedMessage = completedBaselineInCurrentAction
        ? "基准估计已经完成并保留了结果，但后续验证或结果读取连续失败，系统已停止继续探查；本轮没有重新估计。你可以直接使用已交付结果，或确认具体诊断方案后再继续。"
        : result.failureDiagnosis?.user_fallback_zh
          ? result.failureDiagnosis.user_fallback_zh
          : `这一步连续修复 ${AUTOMATIC_TOOL_REPAIR_LIMIT} 次仍未完成，已停止执行，避免重复消耗。你可以调整数据或模型设定后再继续。`
      const failurePersisted = persistTerminalFailure(sessionID, {
        scope: "tool",
        category: "attempt_budget_exhausted",
        disposition: "stop",
        reason: `自动修复达到 ${AUTOMATIC_TOOL_REPAIR_LIMIT} 次`,
        userVisibleMessage: exhaustedMessage,
        attempt: automaticToolRepairs,
        maxConsecutiveFailures: AUTOMATIC_TOOL_REPAIR_LIMIT,
        toolName: result.toolName,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: processor.message.id,
        sessionID,
        type: "text",
        text: `${exhaustedMessage}${failurePersisted ? "" : " 注意：本地断点记录写入失败，请保留当前会话。"}`,
      } satisfies MessageV2.TextPart)
      break
    }
    if (result === "compact") {
      contextCompactionAttempts += 1
      if (shouldStopContextCompaction(contextCompactionAttempts)) {
        SessionStatus.set(sessionID, { type: "idle" })
        const failurePersisted = persistTerminalFailure(sessionID, {
          scope: "compaction",
          category: "context_compaction_exhausted",
          disposition: "stop",
          reason: `上下文整理达到 ${contextCompactionAttempts} 次仍超预算`,
          userVisibleMessage: "上下文连续整理后仍超过输入预算，已停止继续请求。",
          attempt: contextCompactionAttempts,
          maxConsecutiveFailures: contextCompactionAttempts,
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: processor.message.id,
          sessionID,
          type: "text",
          text: `上下文连续整理后仍超过模型输入预算，已停止继续请求以避免循环消耗。请运行 /compact、缩短任务，或切换更大上下文窗口的模型。${failurePersisted ? "" : " 注意：本地断点记录写入失败，请保留当前会话。"}`,
        } satisfies MessageV2.TextPart)
        break
      }
      await SessionCompaction.create({
        sessionID,
        agent: lastUser.agent,
        model: lastUser.model,
        auto: true,
        reason: "threshold",
      })
      continue
    }
    contextCompactionAttempts = 0
    continue
  }
  for await (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user") continue
    resolveCallbacks(sessionID, item, activeAction?.id)
    return item
  }
  throw new Error("Impossible")
}

async function persistThrashingStop(input: {
  sessionID: string
  parentID: string
  user: MessageV2.User
}) {
  const created = Date.now()
  const message = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    parentID: input.parentID,
    role: "assistant",
    mode: input.user.agent,
    agent: input.user.agent,
    path: {
      cwd: Instance.directory,
      root: Instance.worktree,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: input.user.model.modelID,
    providerID: input.user.model.providerID,
    time: { created, completed: created },
    finish: "stop",
    sessionID: input.sessionID,
  })) as MessageV2.Assistant
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID: input.sessionID,
    type: "text",
    text: "我已完成当前数据结构检查，但连续查询没有产生新的信息。为避免继续猜测或重复操作，先暂停本次分析。请确认缺失变量的构造规则，或提供现成的变量列；确认后我再继续。",
  } satisfies MessageV2.TextPart)
}

async function injectThrashingReminder(
  sessionID: string,
  repairToolName: string | undefined,
  thrashing: { consecutiveCalls: number; lastAction?: string; toolName?: string },
  lastUser: MessageV2.User | undefined,
): Promise<void> {
  // 没有真实 user 消息就不注入：这条提醒必须沿用真实的 agent/model，
  // 编一个默认 provider 会在默认模型变更时静默指向错误的模型，而少注入一次提醒无害。
  if (!lastUser) return
  const repairHint = repairToolName
    ? `当前在自动修复 ${repairToolName} 模式，repair 上限到达前不会再注入修复指令。`
    : ""
  const isQuestion = thrashing.toolName === "question"
  const isDataQuery = thrashing.toolName === "data_import"
  const reminder: MessageV2.User = {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    // 沿用真实用户消息的 agent/model：dispatch 下一轮会把最后一条 user 消息当
    // lastUser 去 getModel，synthetic 的 providerID="system" 会直接崩溃
    //（2026-08-09 drive did-direct 实测 system/reminder 崩溃）。
    agent: lastUser.agent,
    model: lastUser.model,
  }
  await Session.updateMessage(reminder)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: reminder.id,
    sessionID,
    type: "text",
    synthetic: true,
    text: [
      "<system-reminder>",
      isQuestion
        ? `你已连续 ${thrashing.consecutiveCalls} 次调用 question 工具都被 schema 拒绝（通常是 option label 或 header 超过 30 字符）。不要继续用 question 工具重试同一批问题。`
        : isDataQuery
          ? `你已连续 ${thrashing.consecutiveCalls} 次调用 data_import 的画像/频数/质量检查，数据状态没有发生变化。不要继续重复查询，也不要猜测或静默构造会改变研究含义的变量。`
        : `你已连续 ${thrashing.consecutiveCalls} 次调用 workflow [${thrashing.lastAction ?? "?"}] 类只读/查询工具（verify/status/artifacts/doctor/rerun_plan/timeline/tools/skills/diagnostics），workflow 状态没有改变。`,
      `停下来用普通文本向用户汇报：你看到了什么、做了什么、卡在哪里，让用户决定下一步。`,
      isQuestion
        ? `若确实需要向用户确认选项：把每个 option 的 label 缩短到 30 字符以内（放更详细的说明到 description 字段），header 也 ≤30 字符；或者改用普通文本提问，不调 question 工具。`
        : isDataQuery
          ? `如果缺少 post、处理组、面板键或其他研究设计变量，先用普通文本向用户说明真实列名、已检查内容和需要确认的构造规则；不要继续调用工具试探。`
        : `常见卡点：`,
      ...(isQuestion
        ? []
        : [
            `- artifacts_present 报 0 但磁盘上产物存在 → 通常是路径解析错位（产物根目录与 Instance.worktree 不一致），需要告诉用户检查项目根目录配置`,
            `- workflow rerun_plan 提示重跑 import/qa 但重跑仍 block → 不要重复 rerun；这是 verifier / 工作流状态本身的问题，向用户说明`,
            `- 工具持续报 "No saved artifacts" / ARTIFACT_MISSING / ENOENT 等 → 这是系统级 bug，不是数据问题，应当面告知用户`,
          ]),
      repairHint,
      "</system-reminder>",
    ].join("\n"),
  } satisfies MessageV2.TextPart)
}
