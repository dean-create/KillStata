import path from "path"
import fs from "fs"
import z from "zod"
import type { StageFailureRecord, StageNode, StageReuseRecord, VerifierCheck, VerifierReport, VerifierTaskEnvelope, WorkflowCoordinatorDecision, WorkflowRun } from "../types"
import { AUTO_VERIFY_STAGES, DEFAULT_STAGE_SEQUENCE, activeOrLatestStage, activeRuntimeTaskId, canonicalDataStageForWorkflow, collectDependentStageIds, createWorkflowCheckpoint, getActiveWorkflowRun, latestFailedStage, nextStage, normalizeRecord, nowIso, publishWorkflowState, readWorkflowSession, refreshWorkflowRunDerivedState, requestedStage, stageNeedsVerifier, upsertStage, workflowStageDetails, writeWorkflowSession } from "./state"
import { AgentControl } from "../agent-control"
import { MessageV2 } from "@/session/message-v2"
import { RuntimeTaskLedger } from "../task-ledger"
import { WORKFLOW_REPAIR_ONLY_BUNDLES } from "../tool-catalog"
import { admissionForEconometricsTool } from "@/runtime/econometrics-admission"
import { applyRepairHandler, recordWorkflowStageFailure, recordWorkflowStageSuccess } from "./stage"
import {
  filterVerifierReadableArtifactRefs,
  isVerifierReadableArtifactCandidate,
  resolveArtifactPathForRead,
  sanitizeVerifierPromptMetadata,
  diagnoseArtifactRefs,
} from "./artifact"
import { datasetRoot } from "@/runtime/dataset-state"
import { withTimeout } from "@/util/timeout"
import { Log } from "@/util/log"

/**
 * 重跑与验证：重跑计划构建、阶段重放执行、verifier 报告与门禁。
 */

/**
 * verifier 可读产物的来源清单。
 *
 * 此前各处写的是 `stage.readableArtifactRefs ?? stage.artifactRefs`——`??` 只对
 * undefined 生效，一旦 readableArtifactRefs 被**误算成空数组**并落盘（见 artifact.ts
 * 里 workspace 根解析失败的说明），后续每次校验都短路到这个空数组，stage 被永久毒化：
 * 产物明明在磁盘上，artifacts_present 却永远 block。改为空数组也回落到 artifactRefs
 * 重算，让已经写坏的历史会话在下一次校验时自愈。
 */
function verifierReadableSource(stage: Pick<StageNode, "readableArtifactRefs" | "artifactRefs">) {
  // 返回并集而不是"readable 非空就只用 readable"。
  //
  // readable 列表可能被历史 bug 写坏成**非空但全部指向不存在的路径**（曾把相对引用按
  // Instance.directory 解析成 packages/killstata/.killstata/…）。只要它非空，旧写法就永远
  // 不回落到 artifactRefs，坏会话再怎么重跑 / restore 都自愈不了（2026-08-08 用户实测：
  // 两次 rerun、一次 restore、两次 verify 全部阻塞）。并集交给 filter 按真实存在性裁决，
  // 坏引用被自然滤掉、好引用被重新捡回，历史会话下一次校验即自愈。
  return [...new Set([...(stage.readableArtifactRefs ?? []), ...(stage.artifactRefs ?? [])])]
}

const WORKFLOW_EXECUTION_POLICY = {
  autoVerifyStages: [...AUTO_VERIFY_STAGES],
  freshVerifierAgent: "verifier",
  repairOnlyBundles: WORKFLOW_REPAIR_ONLY_BUNDLES,
} as const

// 新鲜 verifier 子会话的硬超时（毫秒）。旧同步 postTool 路径曾使主会话
// 流空闲超时并误杀已成功工具；当前延迟核验先交付结果，超时后保留待核验状态。
const VERIFIER_FRESH_RUN_TIMEOUT_MS = 90_000
const log = Log.create({ service: "workflow.verifier" })

function verifierRun(state: ReturnType<typeof readWorkflowSession>, workflowRunId?: string) {
  if (workflowRunId) return state.runs.find((run) => run.workflowRunId === workflowRunId)
  return state.runs.find((run) => run.workflowRunId === state.activeRunId) ?? state.runs.at(-1)
}

function activeVerifierRunId(state: ReturnType<typeof readWorkflowSession>) {
  return verifierRun(state)?.workflowRunId
}

function verifierTarget(run: WorkflowRun | undefined, stageId?: string, branch?: string) {
  if (!branch) return requestedStage(run, stageId)
  return run?.stages.find((stage) => stage.branch === branch && (stage.stageId === stageId || stage.nodeId === stageId))
}

function workflowStageIsCurrent(run: WorkflowRun, target: StageNode, activeRunId?: string) {
  if (activeRunId !== undefined && activeRunId !== run.workflowRunId) return false
  const active = run.activeNodeId ? run.stages.find((stage) => stage.nodeId === run.activeNodeId) : undefined
  const activeTarget = active?.kind === "verifier" && active.parentStageId
    ? run.stages.find((stage) => stage.stageId === active.parentStageId && stage.branch === active.branch)
    : active ?? activeOrLatestStage(run)
  return activeTarget?.stageId === target.stageId && activeTarget.branch === target.branch
}

function verifierTimelineTaskId(sessionID: string, run: WorkflowRun, updateActiveState: boolean) {
  const activeTaskId = activeRuntimeTaskId(sessionID)
  const taskId = run.activeTaskId ?? (updateActiveState ? activeTaskId : undefined)
  return !updateActiveState && taskId === activeTaskId ? undefined : taskId
}

function publishVerifierWorkflowState(state: ReturnType<typeof readWorkflowSession>, run: WorkflowRun, stageId?: string) {
  if (state.activeRunId === run.workflowRunId) publishWorkflowState(state.sessionID, run, stageId)
}

async function syncVerifierToolPart(input: {
  sessionID: string
  stage: StageNode
  report?: VerifierReport
  pending: boolean
  failure?: string
}) {
  const source = normalizeRecord(input.stage.metadata?.verifierSource)
  const additional = Array.isArray(input.stage.metadata?.verifierSources)
    ? input.stage.metadata.verifierSources.map(normalizeRecord)
    : []
  const sources = [source, ...additional].filter((item) =>
    typeof item.messageID === "string" && typeof item.callID === "string")
  const notice = input.report?.status === "block"
    ? "独立核验未通过；估计结果保留，但不可作为最终结论。"
    : input.report?.status === "warn"
      ? "独立核验完成，存在诊断提醒；请查看核验结果。"
      : "独立核验通过。"
  const replacePendingNotice = (value: string) => {
    const base = value.replace(
      /\n\n(?:提示：估计结果已生成，状态：待核验；核验完成前请勿将其作为最终结论。|提示：当前步骤已完成，独立核验待完成；这不表示计量估计已完成。|提示：独立核验未完成[^\r\n]*|独立核验通过。|独立核验完成，存在诊断提醒；请查看核验结果。|独立核验未通过；估计结果保留，但不可作为最终结论。)/g,
      "",
    )
    if (input.pending) return input.failure ? `${base}\n\n提示：${input.failure}` : value
    return `${base}\n\n${notice}`
  }
  const { Session } = await import("@/session/session-state")
  const updated = new Set<string>()
  for (const item of sources) {
    const key = `${item.messageID}:${item.callID}`
    if (updated.has(key)) continue
    updated.add(key)
    const part = (await MessageV2.parts(item.messageID as string)).find(
      (candidate) => candidate.type === "tool" && candidate.callID === item.callID,
    )
    if (part?.type !== "tool" || part.state.status !== "completed" || part.sessionID !== input.sessionID) continue
    const metadata = { ...(part.state.metadata ?? {}) }
    delete metadata.verifierPending
    delete metadata.verifierFailure
    if (input.pending) {
      metadata.verifierPending = true
      if (input.failure) metadata.verifierFailure = input.failure
    } else {
      metadata.verifierStatus = input.report?.status ?? "warn"
    }
    await Session.updatePart({
      ...part,
      state: {
        ...part.state,
        metadata,
        output: replacePendingNotice(part.state.output),
        modelOutput: part.state.modelOutput ? replacePendingNotice(part.state.modelOutput) : undefined,
      },
    })
  }
}

export async function withVerifierCancellationOnTimeout<T>(
  task: Promise<T>,
  cancel: () => void,
  timeoutMs: number,
): Promise<T> {
  try {
    return await withTimeout(task, timeoutMs)
  } catch (error) {
    cancel()
    // 取消后给 dispatch 一个有界收敛窗口，避免 cleanup 与仍在写入的 child 竞态。
    await withTimeout(task, Math.min(1_000, Math.max(10, timeoutMs))).catch(() => undefined)
    throw error
  }
}

function createCoordinatorDecision(input: {
  agent: "explore" | "general" | "verifier"
  why: string
  inputSlice: Record<string, unknown>
  expectedOutputContract: string
  linkedStageId?: string
}): WorkflowCoordinatorDecision {
  return {
    agent: input.agent,
    why: input.why,
    inputSlice: input.inputSlice,
    expectedOutputContract: input.expectedOutputContract,
    linkedStageId: input.linkedStageId,
    createdAt: nowIso(),
  }
}

function extractTaggedJson<T>(text: string, tag: string) {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i").exec(text)
  if (!match?.[1]) return undefined
  try {
    return JSON.parse(match[1]) as T
  } catch {
    return undefined
  }
}

const VerifierCheckSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["pass", "warn", "block"]),
  message: z.string().trim().min(4, "检查需要具体说明"),
  evidence: z.record(z.string(), z.unknown()).optional(),
}).strict()

const FreshVerifierPayloadSchema = z.object({
  status: z.enum(["pass", "warn", "block"]),
  checks: z.array(VerifierCheckSchema),
  blockingFindings: z.array(z.string().trim().min(4)),
  repairHints: z.array(z.string().trim().min(4)),
  trustedArtifacts: z.array(z.string()),
  summary: z.string().trim().min(4),
  findings: z.array(z.string().trim().min(4)),
}).strict().superRefine((value, ctx) => {
  const hasReviewEvidence = value.checks.length > 0 || value.findings.length > 0 ||
    (value.status === "block" && value.blockingFindings.length > 0)
  if (!hasReviewEvidence) {
    ctx.addIssue({ code: "custom", path: ["checks"], message: "核验结论必须包含至少一项可审查检查或具体发现。" })
  }
  if (value.status === "block" && value.blockingFindings.length === 0 && !value.checks.some((check) => check.status === "block")) {
    ctx.addIssue({ code: "custom", path: ["blockingFindings"], message: "阻断结论必须说明具体阻断发现。" })
  }
})

export function parseVerifierEnvelope(text: string): Omit<VerifierTaskEnvelope, "sessionID" | "agent" | "mode" | "createdAt"> | undefined {
  const raw = extractTaggedJson<unknown>(text, "verifier_result")
  const parsed = FreshVerifierPayloadSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

async function inferSessionModel(sessionID: string, fallback?: { providerID: string; modelID: string }) {
  const { MessageV2 } = await import("@/session/message-v2")
  const { Provider } = await import("@/provider/provider")
  for await (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) {
      return item.info.model
    }
  }
  return fallback ?? (await Provider.defaultModel())
}

/**
 * 交给 verifier 子会话的可读产物——**一律解析成绝对路径**。
 *
 * 子会话是独立进程上下文，cwd 是启动目录（dev 下 `packages/killstata`），而产物挂在
 * projectRoot()（= worktree）下。给相对引用它一律读不到，而 `.killstata` 又在 ripgrep
 * 默认忽略清单里，glob 也搜不到——2026-08-08 实测子 agent 为找一个存在的 数据质量报告烧掉
 * ~35 次工具调用，最后靠读 killstata 源码才推断出数据在哪。给绝对路径直接消灭这段浪费。
 */
function verifierReadableAbsolutePaths(stage: StageNode) {
  return filterVerifierReadableArtifactRefs(verifierReadableSource(stage))
    .map((ref) => resolveArtifactPathForRead(ref))
    .filter((ref): ref is string => typeof ref === "string")
}

export async function freshVerifierToolOverrides() {
  const { ToolRegistry } = await import("@/tool/registry")
  return Object.fromEntries((await ToolRegistry.ids()).map((toolID) => [toolID, false]))
}

const FRESH_VERIFIER_MAX_EVIDENCE_BYTES = 256 * 1024

export function prepareFreshVerifierEvidence(stage: StageNode) {
  const expectedRefs = verifierReadableSource(stage).filter(isVerifierReadableArtifactCandidate).slice(0, 8)
  if (expectedRefs.length === 0) return undefined
  const sections: string[] = []
  const readableRefs: string[] = []
  const skippedRefs: string[] = []
  let totalBytes = 0
  for (const ref of expectedRefs) {
    const absolutePath = resolveArtifactPathForRead(ref)
    if (!absolutePath) { skippedRefs.push(ref); continue }
    let stat: fs.Stats
    try { stat = fs.statSync(absolutePath) } catch { skippedRefs.push(ref); continue }
    if (!stat.isFile() || stat.size <= 0 || totalBytes + stat.size > FRESH_VERIFIER_MAX_EVIDENCE_BYTES) {
      skippedRefs.push(ref)
      continue
    }
    try {
      const content = fs.readFileSync(absolutePath, "utf-8")
      totalBytes += Buffer.byteLength(content, "utf-8")
      readableRefs.push(ref)
      sections.push(`## ${path.basename(absolutePath)}\n${content}`)
    } catch { skippedRefs.push(ref) }
  }
  if (readableRefs.length === 0) return undefined
  return { refs: readableRefs, skippedRefs, totalBytes, text: sections.join("\n\n") }
}

export function freshVerifierPrompt(input: { stage: StageNode; workflow: WorkflowRun }) {
  const prompt = {
    workflowRunId: input.workflow.workflowRunId,
    stageId: input.stage.stageId,
    stageKind: input.stage.kind,
    branch: input.stage.branch,
    replayInput: input.stage.replayInput ?? {},
    artifactRefs: input.stage.artifactRefs,
    readableArtifactRefs: verifierReadableAbsolutePaths(input.stage),
    // 数据集根目录：产物不在 cwd 下，且 .killstata 被 ripgrep 默认忽略，子会话无法靠
    // glob/grep 自行发现。显式给出根目录，省掉"满文件系统找自己的数据"这一整段。
    datasetRoot: input.stage.datasetId ? datasetRoot(input.stage.datasetId) : undefined,
    latestTrustedArtifacts: input.workflow.trustedArtifacts,
    metadata: sanitizeVerifierPromptMetadata(input.stage.metadata ?? {}),
    instruction:
      "核验此工作流阶段。可读产物已作为附件注入当前请求，不得调用任何工具、搜索路径或重复读取。请在单次文本响应中，只用附件和本消息内的结构化信息完成核验。二进制产物只能依据已有 datasetId/stageId 与结构化元数据。结论必须有可审查依据：至少提供一项带具体 message 的 checks，或一条具体 findings；空数组和只有‘通过’的 summary 不算完成核验。只在 <verifier_result> 标签内返回 JSON 对象，键为 status、checks、blockingFindings、repairHints、trustedArtifacts、summary、findings。",
  }
  return [
    "你是 KillStata 的独立核验 Agent。",
    "不得执行修改性工具；只核验提供的阶段和产物。",
    JSON.stringify(prompt, null, 2),
  ].join("\n\n")
}

async function runFreshVerifierTask(input: {
  sessionID: string
  stage: StageNode
  workflow: WorkflowRun
  model?: { providerID: string; modelID: string }
  abortSignal?: AbortSignal
  onSessionCreated?: (sessionID: string) => void
}) {
  if (input.abortSignal?.aborted) return undefined
  const [{ Session }, { SessionPrompt }, { Agent }] = await Promise.all([
    import("@/session"),
    import("@/session/prompt"),
    import("@/agent/agent"),
  ])
  const verifier = await Agent.get(WORKFLOW_EXECUTION_POLICY.freshVerifierAgent)
  if (!verifier) return undefined
  const evidence = prepareFreshVerifierEvidence(input.stage)
  if (!evidence) return undefined
  const effectiveModel = verifier.model ?? (await inferSessionModel(input.sessionID, input.model))
  const session = await Session.create({
    parentID: input.sessionID,
    title: `工作流核验 - ${input.stage.stageId}`,
    permission: [
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "todoread", pattern: "*", action: "deny" },
    ],
  })
  const abortHandler = () => {
    void SessionPrompt.cancel(session.id)
  }
  input.abortSignal?.addEventListener("abort", abortHandler, { once: true })
  input.onSessionCreated?.(session.id)
  if (input.abortSignal?.aborted) {
    abortHandler()
    input.abortSignal.removeEventListener("abort", abortHandler)
    return undefined
  }
  const parts = [
    {
      type: "text" as const,
      text: `${freshVerifierPrompt(input)}\n\n${evidence.skippedRefs.length ? `# 以下证据无法读取，仅依据其余附件核验：${evidence.skippedRefs.join("、")}\n\n` : ""}# 已核验读取的附件证据\n${evidence.text}`,
    },
  ]
  try {
    if (input.abortSignal?.aborted) return undefined
    const result = await SessionPrompt.prompt({
    sessionID: session.id,
    // 不能把**父会话的 messageID** 传进子会话：createUserMessage 直接拿它当消息 ID
    //（`id: input.messageID ?? Identifier.ascending("message")`），而 part 按 messageID 归档，
    // 于是子会话那条 5380 字符的 verifier 指令会写进父消息、原样渲染给用户
    //（2026-08-08 实测：主会话助手消息里躺着 "You are a fresh-run verifier for killstata…"，
    // synthetic=None，用户在"展开分析过程"里全看得到）。消息 ID 必须每条唯一，留空自动生成。
    model: effectiveModel,
    agent: verifier.name,
    tools: await freshVerifierToolOverrides(),
    parts,
    noReply: false,
    queueActionType: "repair",
    queuePriority: 80,
    queueMetadata: {
      workflowRunId: input.workflow.workflowRunId,
      stageId: input.stage.stageId,
      verifierFreshRun: true,
    },
    intent: "verify",
    })
    const finalTextPart = result.parts.findLast((part) => part.type === "text")
    const internalEnvelope = finalTextPart?.type === "text"
      ? finalTextPart.metadata?.internalVerifierEnvelope
      : undefined
    const text = typeof internalEnvelope === "string" ? internalEnvelope : finalTextPart?.text ?? ""
    const parsed = parseVerifierEnvelope(text)
    if (parsed) {
      return {
        ...parsed,
        sessionID: session.id,
        agent: "verifier" as const,
        mode: "fresh-run" as const,
        createdAt: nowIso(),
      }
    }
    return undefined
  } finally {
    input.abortSignal?.removeEventListener("abort", abortHandler)
  }
}

export function mergeVerifierEnvelope(report: VerifierReport, envelope?: VerifierTaskEnvelope): VerifierReport {
  if (!envelope) return report
  const severity = { pass: 0, warn: 1, block: 2 } as const
  const checks = [...report.checks]
  for (const candidate of envelope.checks) {
    const index = checks.findIndex((check) => check.key === candidate.key)
    if (index < 0) checks.push(candidate)
    else if (severity[candidate.status] > severity[checks[index]!.status]) checks[index] = candidate
  }
  const blockingFindings = [...new Set([
    ...report.blockingFindings,
    ...envelope.blockingFindings,
    ...checks.filter((check) => check.status === "block").map((check) => check.message),
  ])]
  const status = blockingFindings.length > 0 || report.status === "block" || envelope.status === "block"
    ? "block"
    : checks.some((check) => check.status === "warn") || report.status === "warn" || envelope.status === "warn"
      ? "warn"
      : "pass"
  const envelopeTrustedArtifacts = filterVerifierReadableArtifactRefs(envelope.trustedArtifacts)
  const trustedArtifacts = envelopeTrustedArtifacts.length > 0
    ? report.trustedArtifacts.filter((artifact) => envelopeTrustedArtifacts.includes(artifact))
    : report.trustedArtifacts
  return {
    status,
    checks,
    blockingFindings,
    repairHints: [...new Set([...report.repairHints, ...envelope.repairHints])],
    trustedArtifacts: status === "block" ? [] : trustedArtifacts,
    createdAt: report.createdAt,
  }
}

export function applyMergedVerifierReport(run: WorkflowRun, targetStage: StageNode, report: VerifierReport, activeRunId?: string) {
  const updateActiveState = workflowStageIsCurrent(run, targetStage, activeRunId ?? run.workflowRunId)
  const verifierStage = run.stages.find(
    (candidate) => candidate.kind === "verifier" && candidate.branch === targetStage.branch && candidate.parentStageId === targetStage.stageId,
  )
  targetStage.verifierReport = report
  targetStage.trustedArtifacts = report.status === "block" ? [] : report.trustedArtifacts
  if (verifierStage) {
    verifierStage.status = report.status === "block" ? "blocked" : "completed"
    verifierStage.verifierReport = report
    verifierStage.trustedArtifacts = report.status === "block" ? [] : report.trustedArtifacts
    verifierStage.artifactRefs = report.status === "block" ? [] : report.trustedArtifacts
    verifierStage.updatedAt = nowIso()
    if (updateActiveState) run.activeNodeId = verifierStage.nodeId
  }
  if (updateActiveState) {
    run.latestVerifier = report
    run.activeCoordinatorAgent = "verifier"
    run.repairOnly = report.status === "block"
    run.blockedStageId = report.status === "block" ? targetStage.stageId : undefined
    run.activeStage = report.status === "block" ? targetStage.kind : (nextStage(targetStage.kind) ?? "report")
  }
  if (report.status === "block") {
    run.trustedArtifacts = run.trustedArtifacts.filter((artifact) => !targetStage.artifactRefs.includes(artifact))
    const failure = targetStage.failure ?? applyRepairHandler({
      failure: stageFailure({
        code: "MODEL_SPEC_INVALID",
        toolName: targetStage.toolName ?? "pipeline",
        message: report.blockingFindings.join("；") || "Fresh verifier blocked the stage.",
        retryStage: targetStage.kind,
        repairAction: report.repairHints[0] ?? "修复核验阻断项后只重跑当前阶段。",
      }),
      stage: targetStage,
      workflow: run,
    })
    targetStage.failure = failure
    if (updateActiveState) run.latestFailure = failure
  } else {
    targetStage.failure = undefined
    if (updateActiveState) run.latestFailure = undefined
    run.trustedArtifacts = [...new Set([...run.trustedArtifacts, ...report.trustedArtifacts])]
  }
}

function cacheSourceForStage(run: WorkflowRun, stage: StageNode) {
  if (!stage.cacheKey) return undefined
  return run.stages.find(
    (candidate) =>
      candidate.nodeId !== stage.nodeId &&
      candidate.cacheKey === stage.cacheKey &&
      candidate.status === "completed" &&
      (candidate.trustedArtifacts?.length ?? 0) > 0,
  )
}

function stageFailure(
  partial: Omit<StageFailureRecord, "createdAt" | "maxRetries" | "autoRepairAllowed" | "requiresVerifier"> &
    Partial<
      Pick<StageFailureRecord, "createdAt" | "maxRetries" | "autoRepairAllowed" | "requiresVerifier" | "repairMetadata">
    >,
): StageFailureRecord {
  return {
    maxRetries: 3,
    autoRepairAllowed: true,
    requiresVerifier: true,
    createdAt: nowIso(),
    ...partial,
  }
}

function missingRequestedStageReason(stageId: string, action: string) {
  return `Requested stage ${stageId} was not found in the active workflow run for ${action}.`
}

type RerunPlanResult = {
  blocked: boolean
  reason?: string
  workflowRun?: WorkflowRun
  target?: StageNode
  toolName?: string
  replayInput?: Record<string, unknown>
  repairAction?: string
  downstreamTargets?: string[]
  repairContext?: Record<string, unknown>
  cacheHit?: boolean
  cachedArtifacts?: string[]
}

const REPLAY_TRANSPORT_FIELDS = new Set([
  "datasetId", "dataset_id", "stageId", "stage_id", "runId", "run_id", "branch", "branch_id",
  "inputPath", "input_path", "outputPath", "output_path", "outputDir", "output_dir",
  "dataPath", "data_path", "runtime", "expected_data_fingerprint", "expectedDataFingerprint",
  "methodID", "method_id", "specId", "spec_id", "requestId", "request_id",
])

export function stableEstimatorRerunHandoff(input: {
  methodID: string
  replayInput: Record<string, unknown>
}) {
  const replayInput = normalizeRecord(input.replayInput)
  if (typeof replayInput.methodID === "string" && replayInput.methodID !== input.methodID) {
    throw new Error("workflow rerun 的历史方法标识与目标阶段不一致；拒绝构造稳定执行规格。")
  }
  const wrappedArguments = normalizeRecord(replayInput.arguments)
  const source = replayInput.methodID === input.methodID && Object.hasOwn(replayInput, "arguments")
    ? wrappedArguments
    : replayInput
  const arguments_ = Object.fromEntries(
    Object.entries(source).filter(([key]) => !REPLAY_TRANSPORT_FIELDS.has(key)),
  )
  return {
    methodID: input.methodID,
    arguments: arguments_,
  }
}

export function buildRerunPlan(sessionID: string, stageId?: string): RerunPlanResult {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) {
    return {
      blocked: true,
      reason: "No workflow run is recorded for this session yet.",
    }
  }

  if (stageId && !requestedStage(run, stageId)) {
    return {
      blocked: true,
      reason: missingRequestedStageReason(stageId, "rerun"),
      workflowRun: run,
    }
  }

  const target = requestedStage(run, stageId) ?? latestFailedStage(sessionID) ?? activeOrLatestStage(run)

  if (!target) {
    return {
      blocked: true,
      reason: "No stage is available to rerun.",
      workflowRun: run,
    }
  }

  if (!target.replayInput || !target.toolName) {
    return {
      blocked: true,
      reason: `Stage ${target.stageId} has no recorded replay input.`,
      target,
      workflowRun: run,
    }
  }

  const downstreamTargets = collectDependentStageIds(run, target)
  const cachedArtifacts = target.cacheKey
    ? run.stages.find(
        (stage) =>
          stage.nodeId !== target.nodeId &&
          stage.cacheKey === target.cacheKey &&
          stage.status === "completed" &&
          (stage.trustedArtifacts?.length ?? 0) > 0,
      )?.trustedArtifacts
    : undefined

  const result = {
    blocked: false,
    workflowRun: run,
    target,
    toolName: target.toolName,
    replayInput: target.replayInput,
    repairAction: target.failure?.repairAction,
    downstreamTargets,
    repairContext: target.failure?.repairMetadata,
    cacheHit: Boolean(cachedArtifacts?.length),
    cachedArtifacts: cachedArtifacts ?? [],
  }
  publishWorkflowState(sessionID, run, target.stageId)
  return result
}

/**
 * 取重跑某个历史阶段所需的工具实现。
 *
 * 这里刻意**不**再维护一张 toolID→Tool 的 switch 表：那张表是工具名的第二真相源，
 * 与 `runtime/tool-manifest.ts` / 准入表各写各的，准入表新增估计器（logit、rdd、
 * quantile 等）后表里没有对应分支，重跑该阶段会直接抛 "No executable workflow tool
 * is registered"。改为向注册表按 ID 查询——注册表本来就是工具**实现**的真相源。
 *
 * 动态 import 保留：registry 静态依赖 `@/runtime/workflow`，静态引入会成环。
 */
async function loadWorkflowExecutableTool(toolName: string) {
  const { ToolRegistry } = await import("@/tool/registry")
  return ToolRegistry.byID(toolName)
}

async function executeWorkflowStageTool(input: {
  stage: StageNode
  ctx: {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    callID?: string
    extra?: Record<string, unknown>
    metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void
    ask: (input: any) => Promise<void>
  }
  coordinatorDecision: WorkflowCoordinatorDecision
}) {
  if (!input.stage.toolName || !input.stage.replayInput) {
    throw new Error(`Stage ${input.stage.stageId} has no executable tool replay.`)
  }

  if (input.stage.kind === "verifier") {
    return {
      skipped: true as const,
      metadata: {
        targetStageId: input.stage.parentStageId ?? input.stage.stageId,
      },
    }
  }

  const tool = await loadWorkflowExecutableTool(input.stage.toolName)
  if (!tool) {
    throw new Error(`No executable workflow tool is registered for ${input.stage.toolName}.`)
  }

  const { Agent } = await import("@/agent/agent")
  const initAgent = await Agent.get(input.coordinatorDecision.agent === "explore" ? "explore" : "general")
  const initialized: any = await tool.init({ agent: initAgent ?? undefined })
  const result = await initialized.execute(input.stage.replayInput as any, input.ctx as any)
  return {
    skipped: false as const,
    metadata: normalizeRecord(result.metadata),
    output: result.output,
    title: result.title,
  }
}

function recordStageReuse(input: {
  sessionID: string
  workflowRunId: string
  stageId: string
  branch: string
  source: StageNode
}) {
  const sessionState = readWorkflowSession(input.sessionID)
  const run =
    sessionState.runs.find((item) => item.workflowRunId === input.workflowRunId) ??
    sessionState.runs.find((item) => item.sessionID === input.sessionID)
  if (!run) return undefined
  const stage = run.stages.find((item) => item.stageId === input.stageId && item.branch === input.branch)
  if (!stage) return undefined
  stage.status = "completed"
  stage.executionMode = "reuse"
  stage.reusedArtifacts = [...(input.source.trustedArtifacts ?? input.source.artifactRefs)]
  stage.reuseSourceStageId = input.source.stageId
  stage.artifactRefs = [...input.source.artifactRefs]
  stage.readableArtifactRefs = filterVerifierReadableArtifactRefs(
    verifierReadableSource(input.source),
  )
  stage.trustedArtifacts = [...(input.source.trustedArtifacts ?? stage.readableArtifactRefs)]
  stage.failure = undefined
  stage.updatedAt = nowIso()
  stage.metadata = {
    ...(stage.metadata ?? {}),
    reuse: {
      sourceStageId: input.source.stageId,
      cacheKey: input.source.cacheKey,
      artifactRefs: [...(input.source.trustedArtifacts ?? stage.readableArtifactRefs)],
    },
  }
  run.activeNodeId = stage.nodeId
  run.activeStage = stage.kind
  run.updatedAt = nowIso()
  run.activeCoordinatorAgent = "general"
  run.trustedArtifacts = [...new Set([...(run.trustedArtifacts ?? []), ...(stage.trustedArtifacts ?? [])])]
  refreshWorkflowRunDerivedState(run)
  writeWorkflowSession(sessionState)
  publishWorkflowState(input.sessionID, run, stage.stageId)
  return {
    stage,
    reuse: {
      stageId: stage.stageId,
      sourceStageId: input.source.stageId,
      artifactRefs: [...(stage.trustedArtifacts ?? [])],
      cacheKey: input.source.cacheKey ?? "",
    } satisfies StageReuseRecord,
  }
}

export function rerunVerifierGateInput(input: {
  sessionID: string
  workflowRunId: string
  stageId: string
  ctx: { messageID: string; agent: string; abort: AbortSignal }
}): VerifierGateInput {
  return {
    sessionID: input.sessionID,
    workflowRunId: input.workflowRunId,
    stageId: input.stageId,
    messageID: input.ctx.messageID,
    agent: input.ctx.agent,
    abortSignal: input.ctx.abort,
    preferFreshRun: true,
  }
}

export async function executeRerunPlan(input: {
  sessionID: string
  stageId?: string
  ctx: {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    callID?: string
    extra?: Record<string, unknown>
    metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void
    ask: (input: any) => Promise<void>
  }
}) {
  const plan = buildRerunPlan(input.sessionID, input.stageId)
  if (plan.blocked || !plan.workflowRun || !plan.target) {
    return {
      ...plan,
      execution: {
        executedStageIds: [],
        reusedStageIds: [],
      },
    }
  }

  const sessionState = readWorkflowSession(input.sessionID)
  const run = sessionState.runs.find((item) => item.workflowRunId === plan.workflowRun?.workflowRunId)
  const activeRun = sessionState.runs.find((item) => item.workflowRunId === sessionState.activeRunId) ?? sessionState.runs.at(-1)
  if (!run || activeRun?.workflowRunId !== run.workflowRunId) {
    return {
      ...plan,
      blocked: true,
      reason: "The active workflow changed before rerun execution could start.",
    }
  }

  run.lastRerunPlan = {
    targetStageId: plan.target.stageId,
    downstreamTargets: plan.downstreamTargets ?? [],
    repairContext: plan.repairContext ?? {},
    cacheHit: plan.cacheHit ?? false,
    cachedArtifacts: plan.cachedArtifacts ?? [],
    createdAt: nowIso(),
  }
  run.activeCoordinatorAgent = "general"
  run.updatedAt = nowIso()
  refreshWorkflowRunDerivedState(run)
  writeWorkflowSession(sessionState)
  publishWorkflowState(input.sessionID, run, plan.target.stageId)

  const stageIds = [plan.target.stageId, ...(plan.downstreamTargets ?? [])]
  const stageQueue = stageIds
    .map((stageId) => run.stages.find((item) => item.stageId === stageId && item.branch === plan.target?.branch))
    .filter((item): item is StageNode => Boolean(item))
    .sort((left, right) => {
      const leftIndex = DEFAULT_STAGE_SEQUENCE.indexOf(left.kind)
      const rightIndex = DEFAULT_STAGE_SEQUENCE.indexOf(right.kind)
      return leftIndex - rightIndex || left.createdAt.localeCompare(right.createdAt)
    })

  const executedStageIds: string[] = []
  const reusedStageIds: string[] = []
  const reuseRecords: StageReuseRecord[] = []
  let verifier: Awaited<ReturnType<typeof runVerifierGate>> | undefined
  const interrupted = (state: ReturnType<typeof readWorkflowSession>, reason: string) => ({
    ...plan,
    blocked: true,
    reason,
    workflowRun: state.runs.find((item) => item.workflowRunId === state.activeRunId) ?? state.runs.at(-1),
    execution: {
      status: "interrupted",
      executedStageIds: [...executedStageIds],
      reusedStageIds: [...reusedStageIds],
      reuseRecords: [...reuseRecords],
    },
    verifier,
  })

  for (const stage of stageQueue) {
    const currentState = readWorkflowSession(input.sessionID)
    const currentRun = currentState.runs.find((item) => item.workflowRunId === run.workflowRunId)
    const activeRun = currentState.runs.find((item) => item.workflowRunId === currentState.activeRunId) ?? currentState.runs.at(-1)
    if (!currentRun || activeRun?.workflowRunId !== run.workflowRunId) {
      return interrupted(currentState, "活动工作流已切换；为避免重跑到另一研究轮，剩余阶段已停止。")
    }
    const currentStage = currentRun.stages.find((item) => item.stageId === stage.stageId && item.branch === stage.branch)
    if (!currentStage) return interrupted(currentState, `原工作流阶段 ${stage.stageId} 已不存在，剩余阶段已停止。`)
    const currentFailureCode = currentStage.failure?.code
    const taskLedger = RuntimeTaskLedger.listTasks(input.sessionID)
    const replayRecord = normalizeRecord(currentStage.replayInput)
    const recordedSpecId = currentStage.toolName === "econometrics_execute" && typeof replayRecord.specId === "string"
      ? replayRecord.specId
      : undefined
    const historicalSpec = recordedSpecId
      ? taskLedger.tasks.flatMap((task) => [
          ...(task.preparedSpec?.specId === recordedSpecId ? [task.preparedSpec] : []),
          ...(task.analysisSpecs ?? []).filter((spec) => spec.specId === recordedSpecId),
        ])[0]
      : undefined
    const stableMethodID = currentStage.toolName === "econometrics_execute"
      ? historicalSpec?.methodID
      : currentStage.toolName && admissionForEconometricsTool(currentStage.toolName)
      ? currentStage.toolName
      : undefined
    const stableEstimatorStage = currentStage.toolName === "econometrics_execute" || Boolean(stableMethodID)
    const coordinatorDecision = createCoordinatorDecision({
      agent:
        currentFailureCode === "STAGE_NOT_RESOLVED" || currentFailureCode === "ARTIFACT_MISSING"
          ? "explore"
          : "general",
      why:
        currentFailureCode === "STAGE_NOT_RESOLVED" || currentFailureCode === "ARTIFACT_MISSING"
          ? "Workflow rerun needs missing artifact or schema lineage resolved before replay."
          : stableEstimatorStage
            ? "A historical estimator must be prepared against the current estimate request and executed through a fresh PreparedSpec."
            : currentStage.toolName === "heterogeneity_runner"
              ? "A historical composite runner is not replayed until its batch specification has a stable authorization contract."
              : "Workflow rerun needs the recorded stage replay to execute with the stored contract.",
      inputSlice: {
        stageId: currentStage.stageId,
        kind: currentStage.kind,
        toolName: currentStage.toolName,
        replayInput: currentStage.replayInput ?? {},
        repairContext: currentStage.failure?.repairMetadata ?? plan.repairContext ?? {},
      },
      expectedOutputContract: stableEstimatorStage
        ? "Do not execute stored methodID/arguments. Return the current request-bound method arguments for analysis_prepare and econometrics_execute(specId)."
        : currentStage.toolName === "heterogeneity_runner"
          ? "Do not replay this composite runner until its multi-spec authorization and lifecycle contract is available."
          : "Execute the recorded non-estimator stage replay, preserve structured metadata, and return produced artifacts for verifier/audit use.",
      linkedStageId: currentStage.stageId,
    })
    AgentControl.recordDecision({
      sessionID: input.sessionID,
      decision: coordinatorDecision,
      forkMode: coordinatorDecision.agent === "explore" ? "workflow_slice" : "minimal_context",
    })

    // Estimator and composite-stage reuse would bypass this turn's AnalysisRequest/PreparedSpec
    // admission just as surely as replaying the legacy executor, so only non-analysis stages use
    // the workflow artifact cache here.
    const reusable = stableEstimatorStage || currentStage.toolName === "heterogeneity_runner"
      ? undefined
      : cacheSourceForStage(currentRun ?? run, currentStage)
    if (reusable && (reusable.trustedArtifacts?.length ?? 0) > 0) {
      const reused = recordStageReuse({
        sessionID: input.sessionID,
        workflowRunId: run.workflowRunId,
        stageId: currentStage.stageId,
        branch: currentStage.branch,
        source: reusable,
      })
      if (reused) {
        reusedStageIds.push(currentStage.stageId)
        reuseRecords.push(reused.reuse)
      }
      continue
    }

    if (currentStage.toolName === "heterogeneity_runner") {
      const sessionState = readWorkflowSession(input.sessionID)
      const sessionRun = sessionState.runs.find((item) => item.workflowRunId === run.workflowRunId)
      if (sessionRun) {
        sessionRun.lastRerunExecution = {
          targetStageId: plan.target.stageId,
          status: "awaiting_composite_spec_contract",
          completedAt: nowIso(),
        }
        sessionRun.updatedAt = nowIso()
        refreshWorkflowRunDerivedState(sessionRun)
        writeWorkflowSession(sessionState)
        publishWorkflowState(input.sessionID, sessionRun, plan.target.stageId)
      }
      return {
        blocked: true,
        rerunHandoff: {
          status: "composite_runner_not_replayed",
          message_zh: "历史异质性阶段包含一批扩展规格，当前批次尚未绑定本轮的规格与审批；本次没有重放该 runner。请等待复合规格审批契约确定后再继续。",
        },
        execution: { status: "awaiting_composite_spec_contract" },
      }
    }

    if (stableEstimatorStage) {
      const sourceUserMessageId = input.ctx.extra?.sourceUserMessageId
      const task = typeof sourceUserMessageId === "string"
        ? taskLedger.tasks.find((item) =>
            item.taskId === taskLedger.activeTaskId &&
            item.messageID === sourceUserMessageId &&
            item.analysisRequest?.sourceMessageId === sourceUserMessageId,
          )
        : undefined
      const request = task?.analysisRequest
      const replay = historicalSpec
        ? { methodID: historicalSpec.methodID, arguments: historicalSpec.arguments }
        : replayRecord
      const replayDatasetId = historicalSpec?.datasetId ?? (typeof replayRecord.datasetId === "string"
        ? replayRecord.datasetId
        : currentStage.datasetId ?? currentRun.datasetId)
      const replayStageId = historicalSpec?.stageId ?? (typeof replayRecord.stageId === "string"
        ? replayRecord.stageId
        : typeof currentStage.metadata?.stageId === "string"
          ? currentStage.metadata.stageId
          : typeof currentStage.metadata?.targetStageId === "string"
            ? currentStage.metadata.targetStageId
            : undefined)
      const currentData = canonicalDataStageForWorkflow(currentRun, activeOrLatestStage(currentRun))
      let blockReason: string | undefined
      if (currentStage.toolName === "econometrics_execute" && !historicalSpec) {
        blockReason = "历史 econometrics_execute 只记录了 specId，但对应的 PreparedSpec 已不在任务账本中；不能从回归产物猜回方法参数，也不会调用旧执行器。请重新提交当前研究目标并准备新规格。"
      } else if (!stableMethodID) {
        blockReason = "历史 PreparedSpec 中的方法已不在当前准入目录；本次没有重放估计。请先查询当前可用方法，再按本轮请求准备新规格。"
      } else if (!request || request.kind !== "estimate") {
        blockReason = request
          ? `当前请求登记为“${request.kind}”，不能自动重放历史 estimator ${stableMethodID}；如需重新估计，请由用户另行明确提出。`
          : `当前历史 estimator ${stableMethodID} 没有绑定到本轮有效 estimate 请求；拒绝重放。`
      } else if (!currentData || !replayDatasetId || !replayStageId) {
        blockReason = "历史 estimator 缺少可与本轮绑定的 canonical 数据阶段；拒绝猜测数据来源。请先恢复或重新导入诊断数据，再按当前请求准备规格。"
      } else if (replayDatasetId !== currentData.datasetId || replayStageId !== currentData.stageId) {
        blockReason = "历史 estimator 指向的数据集或阶段已不是当前 canonical 数据阶段；为避免换样本执行，未重放。请先明确选择要使用的数据阶段，再准备新规格。"
      }
      if (blockReason || !stableMethodID) {
        return {
          blocked: true,
          rerunHandoff: {
            status: "estimate_request_required",
            ...(stableMethodID ? { methodID: stableMethodID } : {}),
            message_zh: blockReason ?? "无法确认历史估计方法；本次没有重放估计。请重新选择并准备当前规格。",
          },
          execution: { status: "awaiting_user" },
        }
      }

      const handoff = stableEstimatorRerunHandoff({
        methodID: stableMethodID,
        replayInput: replay,
      })
      const sessionState = readWorkflowSession(input.sessionID)
      const sessionRun = sessionState.runs.find((item) => item.workflowRunId === run.workflowRunId)
      if (sessionRun) {
        sessionRun.lastRerunExecution = {
          targetStageId: plan.target.stageId,
          status: "awaiting_prepared_spec",
          requestId: request!.requestId,
          methodID: stableMethodID,
          completedAt: nowIso(),
        }
        sessionRun.updatedAt = nowIso()
        refreshWorkflowRunDerivedState(sessionRun)
        writeWorkflowSession(sessionState)
        publishWorkflowState(input.sessionID, sessionRun, plan.target.stageId)
      }
      return {
        blocked: false,
        stableExecutionHandoff: {
          ...handoff,
          message_zh: "历史 estimator 没有直接重放。请先 tool_search 加载该方法完整 Schema，再用当前运行时上下文中的 requestId 调 analysis_prepare；只有当前数据阶段预检通过并获得方法授权后，才可通过 econometrics_execute(specId) 执行。",
        },
        execution: {
          status: "awaiting_prepared_spec",
          executedStageCount: executedStageIds.length,
          reusedStageCount: reusedStageIds.length,
        },
      }
    }

    try {
      const executed = await executeWorkflowStageTool({
        stage: currentStage,
        ctx: input.ctx,
        coordinatorDecision,
      })
      const postExecutionState = readWorkflowSession(input.sessionID)
      const activeAfterExecution = postExecutionState.runs.find((item) => item.workflowRunId === postExecutionState.activeRunId) ?? postExecutionState.runs.at(-1)
      if (activeAfterExecution?.workflowRunId !== run.workflowRunId) {
        return interrupted(postExecutionState, "执行期间活动工作流已切换；结果未登记到另一研究轮，剩余阶段已停止。")
      }
      if (executed.skipped) {
        if (currentStage.kind === "verifier") {
          verifier = await runVerifierGate(rerunVerifierGateInput({
            sessionID: input.sessionID,
            workflowRunId: run.workflowRunId,
            stageId: currentStage.parentStageId ?? plan.target.stageId,
            ctx: input.ctx,
          }))
          if (verifier.pending) break
        }
        continue
      }

      const success = recordWorkflowStageSuccess({
        sessionID: input.sessionID,
        toolName: currentStage.toolName ?? plan.toolName ?? "pipeline",
        args: currentStage.replayInput ?? plan.replayInput ?? {},
        metadata: {
          ...executed.metadata,
          coordinatorDecision,
        },
      })
      const rerunSessionState = readWorkflowSession(input.sessionID)
      const rerunRun =
        rerunSessionState.runs.find((item) => item.workflowRunId === success.workflowRun.workflowRunId) ??
        rerunSessionState.runs.at(-1)
      const rerunStage =
        rerunRun?.stages.find(
          (item) => item.stageId === success.stage.stageId && item.branch === success.stage.branch,
        ) ?? success.stage
      if (rerunRun && rerunStage) {
        rerunStage.executionMode = "rerun"
        rerunStage.reusedArtifacts = []
        rerunStage.reuseSourceStageId = undefined
        rerunStage.metadata = {
          ...(rerunStage.metadata ?? {}),
          coordinatorDecision,
        }
        rerunRun.activeCoordinatorAgent = "general"
        rerunRun.updatedAt = nowIso()
        refreshWorkflowRunDerivedState(rerunRun)
        writeWorkflowSession(rerunSessionState)
        publishWorkflowState(input.sessionID, rerunRun, rerunStage.stageId)
      }
      executedStageIds.push(currentStage.stageId)

      if (stageNeedsVerifier(currentStage.kind)) {
        verifier = await runVerifierGate(rerunVerifierGateInput({
          sessionID: input.sessionID,
          workflowRunId: run.workflowRunId,
          stageId: currentStage.stageId,
          ctx: input.ctx,
        }))
        if (verifier.report.status === "block" || verifier.pending) break
      }
    } catch (error) {
      const { classifyToolFailure } = await import("@/tool/analysis-reflection")
      const failureState = readWorkflowSession(input.sessionID)
      const activeAfterFailure = failureState.runs.find((item) => item.workflowRunId === failureState.activeRunId) ?? failureState.runs.at(-1)
      if (activeAfterFailure?.workflowRunId !== run.workflowRunId) {
        return interrupted(failureState, "执行期间活动工作流已切换；失败结果未登记到另一研究轮，剩余阶段已停止。")
      }
      const reflection = classifyToolFailure({
        toolName: currentStage.toolName ?? plan.toolName ?? "pipeline",
        error: error instanceof Error ? error.message : String(error),
        input: currentStage.replayInput ?? plan.replayInput ?? {},
        sessionId: input.sessionID,
      })
      const failureResult = recordWorkflowStageFailure({
        sessionID: input.sessionID,
        toolName: currentStage.toolName ?? plan.toolName ?? "pipeline",
        args: currentStage.replayInput ?? plan.replayInput ?? {},
        reflection,
      })
      const failureSessionState = readWorkflowSession(input.sessionID)
      const failureRun = failureSessionState.runs.find((item) => item.workflowRunId === run.workflowRunId)
      if (failureRun) {
        failureRun.lastRerunExecution = {
          targetStageId: plan.target.stageId,
          executedStageIds,
          reusedStageIds,
          failedStageId: currentStage.stageId,
          coordinatorDecision,
          repairContext: failureResult.stage.failure?.repairMetadata ?? plan.repairContext ?? {},
          completedAt: nowIso(),
          status: "failed",
        }
        failureRun.updatedAt = nowIso()
        refreshWorkflowRunDerivedState(failureRun)
        writeWorkflowSession(failureSessionState)
        publishWorkflowState(input.sessionID, failureRun, currentStage.stageId)
      }
      return {
        ...plan,
        blocked: true,
        reason: reflection.userVisibleExplanation,
        workflowRun: getActiveWorkflowRun(input.sessionID),
        target: workflowStageDetails(input.sessionID, currentStage.stageId).stage ?? currentStage,
        execution: {
          status: "failed",
          executedStageIds,
          reusedStageIds,
          reuseRecords,
          failedStageId: currentStage.stageId,
        },
        verifier,
      }
    }
  }

  const finalState = readWorkflowSession(input.sessionID)
  const finalRun = finalState.runs.find((item) => item.workflowRunId === run.workflowRunId)
  if (finalRun) {
    finalRun.lastRerunExecution = {
      targetStageId: plan.target.stageId,
      executedStageIds,
      reusedStageIds,
      reuseRecords,
      verifierStatus: verifier?.pending ? undefined : verifier?.report.status,
      completedAt: nowIso(),
      status: verifier?.pending ? "pending" : verifier?.report.status === "block" ? "blocked" : "completed",
    }
    finalRun.updatedAt = nowIso()
    refreshWorkflowRunDerivedState(finalRun)
    writeWorkflowSession(finalState)
    publishWorkflowState(input.sessionID, finalRun, plan.target.stageId)
  }

  return {
    ...plan,
    workflowRun: getActiveWorkflowRun(input.sessionID),
    target: workflowStageDetails(input.sessionID, plan.target.stageId).stage ?? plan.target,
    execution: {
      status: verifier?.pending ? "pending" : verifier?.report.status === "block" ? "blocked" : "completed",
      executedStageIds,
      reusedStageIds,
      reuseRecords,
    },
    verifier,
  }
}

function addCheck(checks: VerifierCheck[], check: VerifierCheck) {
  checks.push(check)
}

export function buildVerifierReport(input: { sessionID: string; workflowRunId?: string; stageId?: string; branch?: string; deferSemantic?: boolean }) {
  const sessionState = readWorkflowSession(input.sessionID)
  const run = verifierRun(sessionState, input.workflowRunId)
  const requested = verifierTarget(run, input.stageId, input.branch)
  if (input.stageId && !requested) {
    const report: VerifierReport = {
      status: "block",
      checks: [
        {
          key: "stage_exists",
          label: "Stage exists",
          status: "block",
          message: missingRequestedStageReason(input.stageId, "verification"),
        },
      ],
      blockingFindings: [missingRequestedStageReason(input.stageId, "verification")],
      repairHints: ["Choose an existing workflow stage before requesting verification."],
      trustedArtifacts: [],
      createdAt: nowIso(),
    }
    return { workflowRun: run, stage: undefined, report }
  }
  const stage = requested ?? activeOrLatestStage(run)
  if (!run || !stage) {
    const report: VerifierReport = {
      status: "block",
      checks: [
        {
          key: "stage_exists",
          label: "Stage exists",
          status: "block",
          message: "No stage is available to verify.",
        },
      ],
      blockingFindings: ["No stage is available to verify."],
      repairHints: ["Run import or estimation first so the workflow has a concrete stage to audit."],
      trustedArtifacts: [],
      createdAt: nowIso(),
    }
    return { workflowRun: run, stage, report }
  }

  const checks: VerifierCheck[] = []
  const sourceRefs = verifierReadableSource(stage)
  const trustedArtifacts = filterVerifierReadableArtifactRefs(sourceRefs)
  if (trustedArtifacts.length > 0) {
    addCheck(checks, {
      key: "artifacts_present",
      label: "Artifacts present",
      status: "pass",
      message: `Found ${trustedArtifacts.length} workflow artifact(s).`,
      evidence: {
        artifactCount: trustedArtifacts.length,
      },
    })
  } else {
    // block 时直接告诉模型/用户根因：路径解析错位还是产物真不存在。
    // 不再只输出"No saved artifacts were found"——这种空报错让模型陷入
    // verify/status/artifacts/doctor/rerun/restore 死循环（2026-08-08 did.xlsx
    // 真实测试，助手 5+ 步瞎试同一类工具无果）。通过列出每个 ref 的解析基准与
    // 磁盘命中，模型/用户立刻能区分"路径错位"vs"产物缺失"。
    const diagnostics = diagnoseArtifactRefs(sourceRefs)
    const anyExistsOnDisk = diagnostics.some((d) => d.existsOnDisk.length > 0)
    const messageParts = ["No saved artifacts resolved for this stage."]
    if (anyExistsOnDisk) {
      messageParts.push(
        "产物实际存在于磁盘上但解析基准未命中——可能是 Instance.worktree 与产物根目录不一致：",
      )
      for (const d of diagnostics) {
        if (d.existsOnDisk.length > 0) {
          messageParts.push(`- ${d.ref} EXISTS AT ${d.existsOnDisk.join(", ")}`)
        } else {
          messageParts.push(`- ${d.ref} not found (tried worktree=${d.resolvedByWorktree ?? "<unset>"}, directory=${d.resolvedByDirectory ?? "<unset>"}, cwd=${d.resolvedByCwd})`)
        }
      }
    } else {
      messageParts.push(
        "产物在磁盘上也不存在，需重跑对应阶段（rerun import）重新生成。",
      )
      for (const d of diagnostics) {
        messageParts.push(`- ${d.ref} not found (tried worktree=${d.resolvedByWorktree ?? "<unset>"}, directory=${d.resolvedByDirectory ?? "<unset>"}, cwd=${d.resolvedByCwd})`)
      }
    }
    addCheck(checks, {
      key: "artifacts_present",
      label: "Artifacts present",
      status: "block",
      message: messageParts.join("\n"),
      evidence: {
        artifactCount: 0,
        diagnostics,
      },
    })
  }

  const stageMetadata = normalizeRecord(stage.metadata)
  const rowsBefore = typeof stageMetadata.rowsBefore === "number" ? stageMetadata.rowsBefore : undefined
  const rowsAfter = typeof stageMetadata.rowsAfter === "number" ? stageMetadata.rowsAfter : undefined
  addCheck(checks, {
    key: "row_drop_audit",
    label: "Row-drop audit",
    status:
      rowsAfter === undefined || rowsBefore === undefined
        ? "warn"
        : rowsAfter <= 0
          ? "block"
          : rowsAfter < rowsBefore
            ? "warn"
            : "pass",
    message:
      rowsAfter === undefined || rowsBefore === undefined
        ? "Row counts were not fully captured for this stage."
        : rowsAfter <= 0
          ? "The stage left zero usable rows."
          : rowsAfter < rowsBefore
            ? `Rows dropped from ${rowsBefore} to ${rowsAfter}; inspect the audit output.`
            : `Row count remained stable at ${rowsAfter}.`,
    evidence: {
      rowsBefore,
      rowsAfter,
    },
  })

  const duplicateFailure = stage.failure?.code === "PANEL_KEY_DUPLICATED"
  addCheck(checks, {
    key: "panel_key_duplicates",
    label: "Panel-key duplication",
    status: duplicateFailure ? "block" : "pass",
    message: duplicateFailure
      ? "Duplicate panel keys were recorded for this stage."
      : "No duplicate-panel-key failure is recorded for this stage.",
  })

  if (stage.status === "blocked" || normalizeRecord(stage.metadata).qaGateStatus === "block") {
    addCheck(checks, {
      key: "stage_gate",
      label: "Stage gate",
      status: "block",
      message: "数据质量门禁仍处于阻断状态；该阶段不能标记为核验通过。",
    })
  }

  if (stage.kind === "baseline_estimate") {
    const replay = normalizeRecord(stage.replayInput)
    const needsFe = typeof replay.methodName === "string" && /(panel_fe|baseline|did_)/i.test(replay.methodName)
    const hasFeKeys = typeof replay.entityVar === "string" && typeof replay.timeVar === "string"
    addCheck(checks, {
      key: "fe_specification",
      label: "FE specification",
      status: needsFe && !hasFeKeys ? "block" : "pass",
      message:
        needsFe && !hasFeKeys
          ? "The estimation stage requires entityVar and timeVar, but one or both are missing."
          : "The fixed-effects specification is consistent with the recorded replay input.",
      evidence: {
        methodName: replay.methodName,
        entityVar: replay.entityVar,
        timeVar: replay.timeVar,
      },
    })
  }

  if (run.latestFailure && run.latestFailure.code !== "VALIDATE_BLOCKED" && stage.kind !== "verifier") {
    addCheck(checks, {
      key: "latest_failure",
      label: "Latest failure",
      status: "warn",
      message: `Workflow still remembers a recent failure: ${run.latestFailure.code}.`,
    })
  }

  const blockingFindings = checks.filter((check) => check.status === "block").map((check) => check.message)
  const repairHints = [
    ...new Set(
      [
        stage.failure?.repairAction,
        checks.find((check) => check.key === "artifacts_present" && check.status === "block")
          ? "重新生成缺失产物后，再继续生成报告。"
          : undefined,
        checks.find((check) => check.key === "row_drop_audit" && check.status === "block")
          ? "先修复数据准备阶段，再重新运行估计。"
          : undefined,
        checks.find((check) => check.key === "stage_gate")
          ? "先处理原始质检阻断项，再核验当前阶段。"
          : undefined,
      ].filter(Boolean) as string[],
    ),
  ]

  const report: VerifierReport = {
    status: blockingFindings.length > 0 ? "block" : checks.some((check) => check.status === "warn") ? "warn" : "pass",
    checks,
    blockingFindings,
    repairHints,
    trustedArtifacts,
    createdAt: nowIso(),
  }
  const updateActiveState = workflowStageIsCurrent(run, stage, activeVerifierRunId(sessionState))
  const semanticPending = input.deferSemantic === true && report.status !== "block" &&
    needsSemanticVerifier({ report, stage })

  const verifierNodeId = `${stage.branch}:${stage.stageId}__verifier`
  upsertStage(run, {
    nodeId: verifierNodeId,
    stageId: `${stage.stageId}__verifier`,
    kind: "verifier",
    status: report.status === "block" ? "blocked" : semanticPending ? "pending" : "completed",
    branch: stage.branch,
    datasetId: stage.datasetId,
    runId: stage.runId,
    parentStageId: stage.stageId,
    parentNodeId: stage.nodeId,
    toolName: "pipeline",
    replayInput: {
      action: "verify",
      stageId: stage.stageId,
    },
    artifactRefs: semanticPending ? [] : trustedArtifacts,
    readableArtifactRefs: semanticPending ? [] : trustedArtifacts,
    metadata: {
      targetStageId: stage.stageId,
      ...(semanticPending ? { verifierPending: true } : {}),
    },
    verifierReport: semanticPending ? undefined : report,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  stage.verifierReport = semanticPending ? undefined : report
  stage.trustedArtifacts = report.status === "block" || semanticPending ? [] : trustedArtifacts
  if (semanticPending) stage.metadata = { ...(stage.metadata ?? {}), verifierPending: true }
  if (updateActiveState) run.latestVerifier = semanticPending ? undefined : report
  if (semanticPending) {
    const stageArtifacts = new Set(stage.artifactRefs)
    run.trustedArtifacts = run.trustedArtifacts.filter((artifact) => !stageArtifacts.has(artifact))
  }
  if (updateActiveState) {
    run.activeNodeId = verifierNodeId
    run.activeStage = semanticPending ? "verifier" : report.status === "block" ? stage.kind : (nextStage(stage.kind) ?? "report")
    run.repairOnly = report.status === "block"
    run.blockedStageId = report.status === "block" ? stage.stageId : undefined
  }
  if (report.status === "block") {
    const artifactFailure = checks.some((check) => check.key === "artifacts_present" && check.status === "block")
    const feFailure = checks.some((check) => check.key === "fe_specification" && check.status === "block")
    const duplicateFailure = checks.some((check) => check.key === "panel_key_duplicates" && check.status === "block")
    const failure = applyRepairHandler({
      failure: stageFailure({
        code: artifactFailure ? "ARTIFACT_MISSING" : duplicateFailure ? "PANEL_KEY_DUPLICATED" : "MODEL_SPEC_INVALID",
        toolName: stage.toolName ?? "pipeline",
        message: blockingFindings.join(" | "),
        retryStage: artifactFailure ? "import" : duplicateFailure ? "validate" : stage.kind,
        repairAction: repairHints[0] ?? "先修复失败阶段，再继续后续工作。",
        autoRepairAllowed: !feFailure,
        requiresVerifier: true,
      }),
      stage,
      workflow: run,
    })
    stage.failure = failure
    if (updateActiveState) run.latestFailure = failure
  } else {
    if (updateActiveState) run.latestFailure = undefined
  }
  run.updatedAt = nowIso()
  if (report.status !== "block" && !semanticPending) {
    run.trustedArtifacts = [...new Set([...run.trustedArtifacts, ...trustedArtifacts])]
  }
  refreshWorkflowRunDerivedState(run)
  writeWorkflowSession(sessionState)
  publishVerifierWorkflowState(sessionState, run)
  const refreshedSession = readWorkflowSession(input.sessionID)
  const refreshedRun = verifierRun(refreshedSession, run.workflowRunId)
  return { workflowRun: refreshedRun, stage: stage, report }
}

/**
 * 是否值得为这个阶段起一个 LLM 校验子会话。
 *
 * `buildVerifierChecks` 里的三项检查（artifacts_present / row_drop_audit /
 * panel_key_duplicates）全是纯机械判断，本地代码已经给出确定答案，再交给模型复读一遍
 * 没有任何增量信息——2026-08-08 实测一晚烧掉 13 个子会话、219 条消息、540 次工具调用，
 * 全部只为回答"产物文件在不在"。
 *
 * 只有两种情况真正需要语义判断：
 *   1. 本地检查已经 block——需要模型读产物、定位原因、给可执行的修复建议；
 *   2. baseline_estimate——回归结果是否合理（系数量级、样本损失、诊断项）本地无从判断。
 * 其余情况直接用本地报告收工。
 */
export function needsSemanticVerifier(input: { report: VerifierReport; stage: StageNode }) {
  if (input.report.status === "block") return true
  return input.stage.kind === "baseline_estimate"
}

function recordVerifierAttempt(input: { sessionID: string; workflowRunId: string; stageId: string; branch: string }) {
  const sessionState = readWorkflowSession(input.sessionID)
  const run = verifierRun(sessionState, input.workflowRunId)
  const target = verifierTarget(run, input.stageId, input.branch)
  if (!run || !target) return 0
  const attempts = Number.isInteger(target.metadata?.verifierAttempts)
    ? Number(target.metadata?.verifierAttempts) + 1
    : 1
  target.metadata = { ...(target.metadata ?? {}), verifierAttempts: attempts }
  target.updatedAt = nowIso()
  run.updatedAt = target.updatedAt
  writeWorkflowSession(sessionState)
  publishVerifierWorkflowState(sessionState, run, target.stageId)
  return attempts
}

async function recordVerifierIncomplete(input: { sessionID: string; workflowRunId?: string; stageId: string; branch?: string; failure: string }) {
  const sessionState = readWorkflowSession(input.sessionID)
  const run = verifierRun(sessionState, input.workflowRunId)
  const target = verifierTarget(run, input.stageId, input.branch)
  if (!run || !target || target.status === "blocked") return
  const updateActiveState = workflowStageIsCurrent(run, target, activeVerifierRunId(sessionState))
  const verifier = run.stages.find((item) => item.kind === "verifier" && item.parentStageId === target.stageId && item.branch === target.branch)
  for (const item of [target, verifier]) {
    if (!item) continue
    item.metadata = { ...(item.metadata ?? {}), verifierPending: true, verifierFailure: input.failure }
    item.verifierReport = undefined
    item.updatedAt = nowIso()
  }
  if (verifier) {
    verifier.status = "pending"
    if (updateActiveState) run.activeNodeId = verifier.nodeId
  }
  if (updateActiveState) {
    run.latestVerifier = undefined
    run.activeStage = "verifier"
  }
  run.updatedAt = nowIso()
  refreshWorkflowRunDerivedState(run)
  const taskId = verifierTimelineTaskId(input.sessionID, run, updateActiveState)
  if (taskId) {
    RuntimeTaskLedger.appendEventBestEffort({
      sessionID: input.sessionID, taskId, kind: "verifier",
      stageId: target.stageId, workflowRunId: run.workflowRunId,
      message: "verifier pending", metadata: { verifierPending: true, verifierFailure: input.failure },
    })
  }
  writeWorkflowSession(sessionState)
  publishVerifierWorkflowState(sessionState, run, target.stageId)
  await syncVerifierToolPart({ sessionID: input.sessionID, stage: target, pending: true, failure: input.failure })
}

type VerifierGateInput = {
  sessionID: string
  workflowRunId?: string
  stageId?: string
  branch?: string
  messageID?: string
  callID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  abortSignal?: AbortSignal
  preferFreshRun?: boolean
}

async function runVerifierGateOnce(input: VerifierGateInput) {
  const built = buildVerifierReport({
    sessionID: input.sessionID,
    workflowRunId: input.workflowRunId,
    stageId: input.stageId,
    branch: input.branch,
    deferSemantic: input.preferFreshRun !== false,
  })
  const workflowRun = built.workflowRun
  const stage = built.stage
  if (!workflowRun || !stage) return { ...built, envelope: undefined, pending: false }

  const decision = createCoordinatorDecision({
    agent: "verifier",
    why: stageNeedsVerifier(stage.kind)
      ? "This stage is part of the auto-verify policy and must be audited before workflow continuation."
      : "Explicit workflow verification was requested.",
    inputSlice: {
      stageId: stage.stageId,
      kind: stage.kind,
      artifactRefs: stage.artifactRefs,
      replayInput: stage.replayInput ?? {},
    },
    expectedOutputContract:
      "Return VerifierTaskEnvelope with status, checks, blockingFindings, repairHints, trustedArtifacts, summary, findings.",
    linkedStageId: stage.stageId,
  })
  const forkFreshVerifier = input.preferFreshRun !== false && needsSemanticVerifier({ report: built.report, stage })
  if (forkFreshVerifier && built.report.status !== "block") {
    markVerifierPending({ sessionID: input.sessionID, workflowRunId: workflowRun.workflowRunId, branch: stage.branch, stageId: stage.stageId, messageID: input.messageID, callID: input.callID })
  }
  // 只在真的要 fork 时才记录 fork 决策。此前无条件记录——本地检查全过、根本没起子会话
  // 的阶段也会在 AgentControl 里留下一条"已派发 verifier"的假记录。
  if (forkFreshVerifier) {
    recordVerifierAttempt({
      sessionID: input.sessionID, workflowRunId: workflowRun.workflowRunId,
      stageId: stage.stageId, branch: stage.branch,
    })
    AgentControl.recordDecision({
      sessionID: input.sessionID,
      decision,
      forkMode: "minimal_context",
    })
  }

  let envelope: VerifierTaskEnvelope | undefined
  if (forkFreshVerifier) {
    try {
      // 超时或无效回复都不能把本地报告当作独立核验已完成。取消子会话后
      // 保留估计产物和待核验阶段，让后续从这一阶段继续。
      let verifierSessionID: string | undefined
      const verifierTask = runFreshVerifierTask({
        sessionID: input.sessionID,
        stage,
        workflow: workflowRun,
        model: input.model,
        abortSignal: input.abortSignal,
        onSessionCreated: (sessionID) => {
          verifierSessionID = sessionID
        },
      })
      envelope = await withVerifierCancellationOnTimeout(
        verifierTask,
        () => {
          if (!verifierSessionID) return
          void import("@/session/prompt").then(({ SessionPrompt }) => SessionPrompt.cancel(verifierSessionID!))
        },
        VERIFIER_FRESH_RUN_TIMEOUT_MS,
      ).catch(() => undefined)
    } catch {
      envelope = undefined
    }
  }

  // 估计结果已经落盘，但独立语义核验没有返回 envelope 时，不能把阶段伪装成
  // 已完成，也不能回滚或重复估计。保留结果并在 workflow metadata 记录待核验原因，
  // 让下一轮从 verifier 阶段恢复。
  if (forkFreshVerifier && !envelope && built.report.status !== "block") {
    await recordVerifierIncomplete({
      sessionID: input.sessionID, workflowRunId: workflowRun.workflowRunId, branch: stage.branch, stageId: stage.stageId,
      failure: "独立核验未完成；已生成的估计结果保留为待核验状态，可从核验阶段继续。",
    })
  }

  const report = mergeVerifierEnvelope(built.report, envelope)
  if (stage.kind === "baseline_estimate" && stage.datasetId &&
    !(forkFreshVerifier && !envelope && built.report.status !== "block")) {
    RuntimeTaskLedger.recordAnalysisVerificationForStage({
      sessionID: input.sessionID,
      stageId: stage.stageId,
      datasetId: stage.datasetId,
      methodID: stage.toolName,
      status: report.status,
    })
  }
  if (envelope) {
    AgentControl.recordMessage({
      sessionID: input.sessionID,
      fromAgent: "verifier",
      toAgent: "general",
      stageId: stage.stageId,
      envelope: {
        summary: envelope.summary,
        findings: envelope.findings,
        producedArtifacts: envelope.trustedArtifacts,
        nextStepRecommendation: envelope.repairHints[0] ?? "continue",
      },
    })
  }
  if (envelope) {
    const sessionState = readWorkflowSession(input.sessionID)
    const run =
      sessionState.runs.find((item) => item.workflowRunId === workflowRun.workflowRunId) ?? sessionState.runs.at(-1)
    const targetStage = verifierTarget(run, stage.stageId, stage.branch)
    if (run && targetStage) {
      const activeRunId = activeVerifierRunId(sessionState)
      const updateActiveState = workflowStageIsCurrent(run, targetStage, activeRunId)
      applyMergedVerifierReport(run, targetStage, report, activeRunId)
      targetStage.readableArtifactRefs = filterVerifierReadableArtifactRefs(
        verifierReadableSource(targetStage),
      )
      targetStage.metadata = {
        ...(targetStage.metadata ?? {}),
        freshVerifier: {
          sessionID: envelope.sessionID,
          summary: envelope.summary,
          findings: envelope.findings,
          mode: envelope.mode,
        },
        coordinatorDecision: decision,
      }
      if (updateActiveState) run.activeTaskId = activeRuntimeTaskId(input.sessionID) ?? run.activeTaskId
      const taskId = verifierTimelineTaskId(input.sessionID, run, updateActiveState)
      if (taskId) {
        RuntimeTaskLedger.appendEvent({
          sessionID: input.sessionID,
          taskId,
          kind: "verifier",
          stageId: targetStage.stageId,
          workflowRunId: run.workflowRunId,
          message: `verifier ${report.status}`,
          metadata: { blockingFindings: report.blockingFindings, repairHints: report.repairHints },
        })
      }
      if (report.status !== "block" && updateActiveState) {
        const checkpoint = createWorkflowCheckpoint({ sessionID: input.sessionID, run, stage: targetStage })
        run.lastCheckpointId = checkpoint.checkpointId
      }
      run.updatedAt = nowIso()
      refreshWorkflowRunDerivedState(run)
      writeWorkflowSession(sessionState)
      publishVerifierWorkflowState(sessionState, run)
    }
  }

  const pending = forkFreshVerifier && !envelope && built.report.status !== "block"
  if (!pending) {
    const sessionState = readWorkflowSession(input.sessionID)
    const run = sessionState.runs.find((item) => item.workflowRunId === workflowRun.workflowRunId)
    const target = run?.stages.find((item) => item.stageId === stage.stageId && item.branch === stage.branch)
    const verifier = run?.stages.find(
      (item) => item.kind === "verifier" && item.parentStageId === stage.stageId && item.branch === stage.branch,
    )
    if (run && target) {
      for (const item of [target, verifier]) {
        if (!item?.metadata) continue
        delete item.metadata.verifierPending
        delete item.metadata.verifierFailure
      }
      writeWorkflowSession(sessionState)
      publishVerifierWorkflowState(sessionState, run)
    }
  }
  const finalState = readWorkflowSession(input.sessionID)
  const finalRun = verifierRun(finalState, workflowRun.workflowRunId)
  const updated = verifierTarget(finalRun, stage.stageId, stage.branch)
  if (updated && !pending) await syncVerifierToolPart({
    sessionID: input.sessionID,
    stage: updated,
    report,
    pending,
  })

  return {
    workflowRun: finalRun,
    stage: updated,
    report,
    envelope,
    pending,
    coordinatorDecision: decision,
  }
}

type VerifierGateResult = Awaited<ReturnType<typeof runVerifierGateOnce>>
const activeVerifierRuns = new Map<string, {
  promise: Promise<VerifierGateResult>
  abortSignal?: AbortSignal
}>()

export function runVerifierGate(input: VerifierGateInput): Promise<VerifierGateResult> {
  const run = verifierRun(readWorkflowSession(input.sessionID), input.workflowRunId)
  const stage = verifierTarget(run, input.stageId, input.branch)
  const key = `${input.sessionID}:${run?.workflowRunId ?? input.workflowRunId ?? "active"}:${stage?.branch ?? input.branch ?? "main"}:${stage?.stageId ?? input.stageId ?? "latest"}`
  const active = activeVerifierRuns.get(key)
  if (active) {
    if (stage && run && (input.messageID || input.callID)) {
      markVerifierPending({ ...input, workflowRunId: run.workflowRunId, branch: stage.branch, stageId: stage.stageId })
    }
    const canContinueIndependently = () => active.abortSignal?.aborted === true && input.abortSignal?.aborted !== true
    return active.promise.then(
      (result) => {
        // If the first caller was cancelled, an independent caller may continue
        // the verifier with its own signal. Ordinary invalid replies stay pending
        // and rely on the bounded retry/user decision path.
        if (result.pending && canContinueIndependently()) return runVerifierGate(input)
        return result
      },
      (error) => canContinueIndependently() ? runVerifierGate(input) : Promise.reject(error),
    )
  }
  const execution = runVerifierGateOnce(input).finally(() => {
    if (activeVerifierRuns.get(key)?.promise === execution) activeVerifierRuns.delete(key)
  })
  activeVerifierRuns.set(key, { promise: execution, abortSignal: input.abortSignal })
  return execution
}

export async function runAutomaticVerifier(input: {
  sessionID: string
  workflowRunId?: string
  stageId?: string
  branch?: string
  messageID?: string
  callID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  abortSignal?: AbortSignal
}) {
  const run = verifierRun(readWorkflowSession(input.sessionID), input.workflowRunId)
  if (input.stageId && !verifierTarget(run, input.stageId, input.branch)) return undefined
  const stage = verifierTarget(run, input.stageId, input.branch) ?? activeOrLatestStage(run)
  if (!stage || !stageNeedsVerifier(stage.kind)) return undefined
  return runVerifierGate({
    ...input,
    preferFreshRun: true,
  })
}

type DeferredVerifierInput = Parameters<typeof runAutomaticVerifier>[0]
const deferredVerifierQueue = new Map<string, DeferredVerifierInput[]>()
const activeDeferredStages = new Set<string>()

function markVerifierPending(input: DeferredVerifierInput) {
  const sessionState = readWorkflowSession(input.sessionID)
  const run = verifierRun(sessionState, input.workflowRunId)
  const target = verifierTarget(run, input.stageId, input.branch)
  if (!run || !target) return
  const updateActiveState = workflowStageIsCurrent(run, target, activeVerifierRunId(sessionState))
  const source = input.messageID && input.callID
    ? { messageID: input.messageID, callID: input.callID, agent: input.agent, model: input.model }
    : normalizeRecord(target.metadata?.verifierSource)
  const sources = Array.isArray(target.metadata?.verifierSources)
    ? target.metadata.verifierSources.map(normalizeRecord)
    : []
  if (typeof source.messageID === "string" && typeof source.callID === "string" &&
    !sources.some((item) => item.messageID === source.messageID && item.callID === source.callID)) {
    sources.push(source)
  }
  const sourceMetadata = { verifierSource: source, verifierSources: sources.slice(-8) }
  const stageArtifacts = new Set(target.artifactRefs)
  run.trustedArtifacts = run.trustedArtifacts.filter((artifact) => !stageArtifacts.has(artifact))
  target.trustedArtifacts = []
  if (target.status === "blocked") {
    target.metadata = { ...(target.metadata ?? {}), ...sourceMetadata }
    writeWorkflowSession(sessionState)
    return
  }
  target.metadata = { ...(target.metadata ?? {}), verifierPending: true, ...sourceMetadata }
  const verifierStage = upsertStage(run, {
    nodeId: `${target.branch}:${target.stageId}__verifier`,
    stageId: `${target.stageId}__verifier`,
    kind: "verifier",
    status: "pending",
    branch: target.branch,
    datasetId: target.datasetId,
    runId: target.runId,
    parentStageId: target.stageId,
    parentNodeId: target.nodeId,
    toolName: "pipeline",
    replayInput: { action: "verify", stageId: target.stageId },
    artifactRefs: [],
    readableArtifactRefs: [],
    trustedArtifacts: [],
    metadata: { targetStageId: target.stageId, verifierPending: true },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  if (updateActiveState) {
    run.activeNodeId = verifierStage.nodeId
    run.activeStage = "verifier"
    run.activeCoordinatorAgent = "verifier"
    run.latestVerifier = undefined
  }
  run.updatedAt = nowIso()
  refreshWorkflowRunDerivedState(run)
  writeWorkflowSession(sessionState)
  publishVerifierWorkflowState(sessionState, run)
}

/**
 * 多工具模型响应的 verifier 延迟队列。工具结果已经完成且可供模型继续判断，
 * verifier 只在本批工具全部返回后后台按序执行，避免多个估计器逐个阻塞主循环。
 */
export function deferAutomaticVerifier(input: DeferredVerifierInput) {
  markVerifierPending(input)
  const key = `${input.sessionID}:${input.messageID ?? ""}`
  const queue = deferredVerifierQueue.get(key) ?? []
  if (!queue.some((item) => item.workflowRunId === input.workflowRunId && item.branch === input.branch && item.stageId === input.stageId)) queue.push(input)
  deferredVerifierQueue.set(key, queue)
}

export function flushDeferredAutomaticVerifiers(sessionID: string, messageID: string, abortSignal?: AbortSignal) {
  const key = `${sessionID}:${messageID}`
  const queue = deferredVerifierQueue.get(key)
  if (!queue?.length) return
  deferredVerifierQueue.delete(key)
  return (async () => {
    for (const input of queue) {
      if (abortSignal?.aborted) break
      const stageKey = `${sessionID}:${input.workflowRunId ?? "active"}:${input.branch ?? "main"}:${input.stageId}`
      if (activeDeferredStages.has(stageKey)) continue
      activeDeferredStages.add(stageKey)
      try {
        await runAutomaticVerifier({ ...input, abortSignal })
      } catch (error) {
        log.warn("deferred verifier failed", {
          sessionID,
          stageId: input.stageId,
          error: error instanceof Error ? error.message : String(error),
        })
        if (input.stageId) {
          await recordVerifierIncomplete({
            sessionID, workflowRunId: input.workflowRunId, branch: input.branch, stageId: input.stageId,
            failure: "独立核验未完成：后台执行异常；估计结果已保留，请从核验阶段继续。",
          }).catch((persistError) => {
            log.warn("deferred verifier failure state could not be saved", { sessionID, stageId: input.stageId, error: persistError })
          })
        }
      } finally {
        activeDeferredStages.delete(stageKey)
      }
    }
  })()
}

/** 新用户轮从工作流落盘状态恢复核验；只重跑 verifier，不重跑估计器。 */
export function resumePendingAutomaticVerifiers(sessionID: string, abortSignal?: AbortSignal) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) return Promise.resolve()
  const queueKey = `${sessionID}:resume`
  const queue = deferredVerifierQueue.get(queueKey) ?? []
  for (const stage of run.stages) {
    // 网络/取消/模型格式等失败最多自动恢复一次。之后等待模型或用户通过
    // pipeline verify 明确重试，避免每条普通消息都重复烧 verifier 请求。
    if (stage.kind === "verifier" || stage.metadata?.verifierPending !== true) continue
    const attempts = Number.isInteger(stage.metadata.verifierAttempts) ? Number(stage.metadata.verifierAttempts) : 0
    if (attempts >= 2) continue
    const source = normalizeRecord(stage.metadata?.verifierSource)
    if (queue.some((item) => item.workflowRunId === run.workflowRunId && item.branch === stage.branch && item.stageId === stage.stageId)) continue
    queue.push({
      sessionID,
      workflowRunId: run.workflowRunId,
      branch: stage.branch,
      stageId: stage.stageId,
      messageID: typeof source.messageID === "string" ? source.messageID : undefined,
      callID: typeof source.callID === "string" ? source.callID : undefined,
      agent: typeof source.agent === "string" ? source.agent : undefined,
      model: source.model && typeof source.model === "object"
        ? source.model as { providerID: string; modelID: string }
        : undefined,
    })
  }
  if (queue.length === 0) return Promise.resolve()
  deferredVerifierQueue.set(queueKey, queue)
  return flushDeferredAutomaticVerifiers(sessionID, "resume", abortSignal) ?? Promise.resolve()
}
