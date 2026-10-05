import crypto from "crypto"
import path from "path"
import type { FailureType, ToolReflection } from "@/tool/analysis-reflection"
import type { RepairHandler, StageFailureCode, StageFailureRecord, StageNode, StageStatus, WorkflowRun, WorkflowStageKind } from "../types"
import type { WorkflowSessionState } from "./state"
import { Log } from "@/util/log"
import { ANALYSIS_CHECKLIST_TEMPLATE, DEFAULT_STAGE_SEQUENCE, activeOrLatestStage, activeRuntimeTaskId, computeKindDownstream, createWorkflowCheckpoint, findStage, getActiveWorkflowRun, nextStage, normalizeArtifactCandidate, normalizeRecord, nowIso, publishWorkflowState, readWorkflowSession, refreshWorkflowRunDerivedState, stageNeedsVerifier, upsertStage, writeWorkflowSession } from "./state"
import { MessageV2 } from "@/session/message-v2"
import { RuntimeTaskLedger } from "../task-ledger"
import { detectWorkflowLocaleFromText, inferWorkflowLocaleFromSession, type WorkflowLocale, workflowApprovalStatusLabel, workflowApprovalTitle, workflowChecklistLabel, workflowChecklistStatusLabel, workflowLocaleLabel, workflowPlanTitle, workflowStageLabel } from "../workflow-locale"
import { filterVerifierReadableArtifactRefs, isWorkflowArtifactRef } from "./artifact"

const log = Log.create({ service: "workflow.stage" })
import { getStage, projectRoot, readDatasetManifest } from "@/runtime/dataset-state"
import { isWorkflowDiagnosticTool, isWorkflowEstimateTool, isWorkflowRecommendTool } from "../tool-catalog"
import { validateWorkflowResultContract, WorkflowResultContractError } from "../analysis-contract"

/**
 * 阶段生命周期：成功/失败记录、修复处理器、分析计划与清单、数据集就绪门禁。
 */

const DEFAULT_STAGE_EDGES = DEFAULT_STAGE_SEQUENCE.slice(0, -1).map((kind, index) => ({
  from: kind,
  to: DEFAULT_STAGE_SEQUENCE[index + 1],
}))

const STAGE_DEPENDENCIES: Record<WorkflowStageKind, WorkflowStageKind[]> = {
  healthcheck: [],
  import: ["healthcheck"],
  profile_or_schema_check: ["import"],
  validate: ["profile_or_schema_check"],
  preprocess_or_filter: ["validate"],
  profile_or_diagnostics: ["preprocess_or_filter"],
  baseline_estimate: ["profile_or_diagnostics"],
  verifier: ["baseline_estimate"],
  report: ["verifier"],
}

// data_import(profile) 记录为 profile_or_diagnostics；推荐工具记录为
// profile_or_schema_check。两者都包含同一数据阶段的画像事实，预处理门禁都应接受。
const PREPROCESS_PROFILE_KINDS = new Set<WorkflowStageKind>([
  "profile_or_schema_check",
  "profile_or_diagnostics",
])

/**
 * 把产物引用解析成绝对路径写盘，基准固定为 projectRoot()（= Instance.worktree，
 * .killstata 的挂载点）。无 ALS 上下文时原样返回，由读侧多基准解析兜底。
 */
function absoluteArtifactRef(ref: string) {
  if (path.isAbsolute(ref)) return ref
  try {
    return path.resolve(projectRoot(), ref)
  } catch {
    return ref
  }
}

function stableHash(value: string) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 10)
}

function levenshtein(left: string, right: string) {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) rows[i][0] = i
  for (let j = 0; j <= b.length; j++) rows[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
    }
  }
  return rows[a.length][b.length]
}

function similarColumns(input: string, columns: string[]) {
  return [...new Set(columns)]
    .map((column) => ({
      column,
      score: Math.min(
        levenshtein(input, column),
        column.toLowerCase().includes(input.toLowerCase()) || input.toLowerCase().includes(column.toLowerCase())
          ? 0
          : 99,
      ),
    }))
    .sort((a, b) => a.score - b.score || a.column.localeCompare(b.column))
    .slice(0, 5)
    .map((entry) => entry.column)
}

async function latestNonSyntheticUserText(sessionID: string) {
  for await (const message of MessageV2.stream(sessionID)) {
    if (message.info.role !== "user") continue
    const text = message.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
    if (text) return text
  }
  return undefined
}

async function resolveWorkflowLocale(sessionID: string, fallback: WorkflowLocale = "en") {
  const latestUserText = await latestNonSyntheticUserText(sessionID)
  if (latestUserText) return detectWorkflowLocaleFromText(latestUserText)
  return inferWorkflowLocaleFromSession(sessionID, fallback)
}

function createWorkflowRunId(input: { sessionID: string; datasetId?: string; runId?: string; branch: string; nonce?: string }) {
  const seed = [input.sessionID, input.datasetId ?? "session", input.runId ?? "run", input.branch, input.nonce ?? "stable"].join("::")
  return `workflow_${stableHash(seed)}`
}

function emptyRun(input: { sessionID: string; datasetId?: string; runId?: string; branch: string; nonce?: string }): WorkflowRun {
  const createdAt = nowIso()
  return {
    workflowRunId: createWorkflowRunId(input),
    sessionID: input.sessionID,
    workflowMode: "econometrics",
    workflowLocale: "zh-CN",
    datasetId: input.datasetId,
    runId: input.runId,
    branch: input.branch,
    activeStage: DEFAULT_STAGE_SEQUENCE[0],
    stageSequence: [...DEFAULT_STAGE_SEQUENCE],
    edges: [...DEFAULT_STAGE_EDGES],
    stages: [],
    trustedArtifacts: [],
    analysisChecklist: ANALYSIS_CHECKLIST_TEMPLATE.map((item) => ({
      id: item.id,
      label: workflowChecklistLabel("zh-CN", item.id),
      status: item.id === "data_readiness" ? "in_progress" : "pending",
    })),
    createdAt,
    updatedAt: createdAt,
  }
}

function ensureRun(
  sessionState: WorkflowSessionState,
  input: { datasetId?: string; runId?: string; branch?: string; forceNew?: boolean },
): WorkflowRun {
  const branch = input.branch ?? "main"
  const scopedRun = sessionState.runs.find(
    (run) =>
      run.branch === branch &&
      (input.datasetId ? run.datasetId === input.datasetId : true) &&
      (input.runId ? run.runId === input.runId : true),
  )
  // 同 dataset 已存在"未指定 runId"的 run（画像工具 econometrics_recommend 创建，它们
  // 不带 runId）时，后续带 runId 的操作（data_import 从 manifest 继承 runId）应接管并
  // 补充 runId，而不是新建隔离 run——否则画像与 数据质量检查/估计分裂到两个 run，估计门禁在
  // active run 找不到 profile 而拒绝（2026-08-05 did.xlsx 真实数据测试三次撞上：
  // recommend 在 run A，数据质量检查/panel_fe 在 run B，panel_fe 连续报"必须先完成数据画像"）。
  // 显式传入新 dataset/run 时必须新建隔离的 workflow run，不能把 active run 改名后继承旧 stages。
  const runIdLessMatch = input.datasetId
    ? sessionState.runs.find((run) => run.branch === branch && run.datasetId === input.datasetId && !run.runId)
    : undefined
  const existing = input.forceNew
    ? undefined
    : scopedRun ??
      runIdLessMatch ??
      (!input.datasetId && !input.runId && sessionState.activeRunId
        ? sessionState.runs.find((run) => run.workflowRunId === sessionState.activeRunId)
        : undefined)

  if (existing) {
    // 已知限制：多个 runId-less run 共存时，find 只返回第一个，后续带 runId 操作会接管它；
    // 其余 runId-less run 的 stages 不会被引用，只能靠跨 run 兜底（findProfileAcrossRuns）。
    if (existing === runIdLessMatch) {
      log.warn("ensureRun took over a runId-less workflow run", {
        workflowRunId: existing.workflowRunId,
        takenOverRunId: input.runId,
        datasetId: input.datasetId,
      })
    }
    existing.datasetId = input.datasetId ?? existing.datasetId
    existing.runId = input.runId ?? existing.runId
    existing.branch = branch
    existing.workflowLocale = "zh-CN"
    existing.updatedAt = nowIso()
    sessionState.activeRunId = existing.workflowRunId
    return existing
  }

  const run = emptyRun({
    sessionID: sessionState.sessionID,
    datasetId: input.datasetId,
    runId: input.runId,
    branch,
    nonce: input.forceNew ? crypto.randomUUID() : undefined,
  })
  sessionState.runs.push(run)
  sessionState.activeRunId = run.workflowRunId
  return run
}

function resolveWorkflowStageId(input: {
  run: WorkflowRun
  branch: string
  kind: WorkflowStageKind
  preferredStageId: string
  cacheKey?: string
}) {
  const initial = findStage(input.run, input.preferredStageId, input.branch)
  if (!initial) return input.preferredStageId
  if (initial.kind === input.kind && initial.cacheKey === input.cacheKey) return input.preferredStageId

  const base = `${input.preferredStageId}__${input.kind}`
  let candidate = base
  let index = 1

  while (true) {
    const existing = findStage(input.run, candidate, input.branch)
    if (!existing) return candidate
    if (existing.kind === input.kind && existing.cacheKey === input.cacheKey) return candidate
    candidate = `${base}_${index.toString().padStart(3, "0")}`
    index += 1
  }
}

function collectArtifactRefs(metadata?: Record<string, unknown>) {
  if (!metadata) return []
  const refs = new Set<string>()
  const visit = (value: unknown, key?: string) => {
    if (typeof value === "string") {
      if (isWorkflowArtifactRef(value, key)) refs.add(normalizeArtifactCandidate(value) ?? value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key))
      return
    }
    if (!value || typeof value !== "object") return
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (/artifact|path|report|snapshot|schema|label|inspection|output/i.test(nestedKey)) {
        visit(nestedValue, nestedKey)
        continue
      }
      if (nestedKey === "reflection") continue
      visit(nestedValue, nestedKey)
    }
  }
  visit(metadata)
  return [...refs]
}

function collectColumnCandidates(...values: Array<Record<string, unknown> | undefined>) {
  const candidates = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === "string") return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== "object") return
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/columns?|variables?|schema|label|field/i.test(key)) {
        if (typeof nested === "string") candidates.add(nested)
        if (Array.isArray(nested)) nested.forEach((item) => typeof item === "string" && candidates.add(item))
      }
      visit(nested)
    }
  }
  values.forEach((value) => visit(value))
  return [...candidates]
}

function dependsOnKinds(kind: WorkflowStageKind) {
  return STAGE_DEPENDENCIES[kind] ?? []
}

function stageCacheKey(kind: WorkflowStageKind, args: Record<string, unknown>, metadata?: Record<string, unknown>) {
  return `${kind}_${stableHash(JSON.stringify({ args, metadata: metadata ?? {} }))}`
}

function latestStageForKind(run: WorkflowRun, branch: string, kind: WorkflowStageKind) {
  return [...run.stages].reverse().find((stage) => stage.branch === branch && stage.kind === kind)
}

function deriveParentStage(
  run: WorkflowRun,
  branch: string,
  kind: WorkflowStageKind,
  metadata?: Record<string, unknown>,
) {
  const explicitParentStageId = typeof metadata?.parentStageId === "string" ? metadata.parentStageId : undefined
  if (explicitParentStageId) {
    return run.stages.find((stage) => stage.branch === branch && stage.stageId === explicitParentStageId)
  }
  const parentKinds = dependsOnKinds(kind)
  for (let i = parentKinds.length - 1; i >= 0; i--) {
    const parent = latestStageForKind(run, branch, parentKinds[i]!)
    if (parent) return parent
  }
  return undefined
}

function computeDependsOn(
  run: WorkflowRun,
  branch: string,
  kind: WorkflowStageKind,
  metadata?: Record<string, unknown>,
) {
  const parent = deriveParentStage(run, branch, kind, metadata)
  return parent ? [parent.stageId] : []
}

function stageKindFromTool(
  toolName: string,
  args: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): WorkflowStageKind {
  if (toolName === "data_import") {
    const action =
      typeof args.action === "string" ? args.action : typeof metadata?.action === "string" ? metadata.action : ""
    if (action === "healthcheck") return "healthcheck"
    if (action === "import") return "import"
    if (action === "validate" || action === "qa") return "validate"
    if (action === "preprocess" || action === "filter" || action === "rollback") return "preprocess_or_filter"
    if (action === "profile" || action === "describe" || action === "correlation" || action === "diagnostics") return "profile_or_diagnostics"
    // export 是数据导出（数据集 → CSV/Excel），不是报告产出（narrative/paper）。
    // 映射到 report 会让 workflow 跳到收尾 stage，工具面收窄到 readCore，后续
    // 预处理/估计全不可见——模型中途导出数据后想继续分析就 unavailable 卡死
    //（2026-08-11 status-check 实测：模型 turn1 调 export 后 workflow 停在 report，
    // 再调 data_preprocess 报 unavailable → preprocess_or_filter failed）。
    if (action === "export") return "profile_or_diagnostics"
    return "profile_or_schema_check"
  }

  if (toolName === "data_preprocess" || toolName === "composite_evaluation") return "preprocess_or_filter"

  if (isWorkflowRecommendTool(toolName)) return "profile_or_schema_check"
  if (isWorkflowDiagnosticTool(toolName)) return "profile_or_diagnostics"
  if (isWorkflowEstimateTool(toolName)) return "baseline_estimate"
  return "report"
}

function failureCodeFromType(failureType: FailureType): StageFailureCode {
  switch (failureType) {
    case "file_not_found":
      return "FILE_NOT_FOUND"
    case "path_resolution_error":
      return "STAGE_NOT_RESOLVED"
    case "column_not_found":
      return "COLUMN_NOT_FOUND"
    case "panel_integrity_failure":
      return "PANEL_KEY_DUPLICATED"
    case "python_missing":
    case "dependency_broken":
      return "DEPENDENCY_MISSING"
    case "validate_blocked":
      return "VALIDATE_BLOCKED"
    case "schema_mismatch":
    case "tool_contract_failure":
    case "planning_failure":
      return "MODEL_SPEC_INVALID"
    case "result_contract_failure":
      return "RESULT_CONTRACT_INVALID"
    case "estimation_failure":
    case "process_timeout":
      return "ESTIMATION_FAILED"
    default:
      return "ARTIFACT_MISSING"
  }
}

function failureFromReflection(reflection: ToolReflection): StageFailureRecord {
  const code = failureCodeFromType(reflection.failureType)
  return {
    code,
    toolName: reflection.toolName,
    message: reflection.rootCause,
    retryStage: reflection.retryStage,
    repairAction: reflection.repairAction,
    autoRepairAllowed: !["VALIDATE_BLOCKED", "MODEL_SPEC_INVALID", "RESULT_CONTRACT_INVALID"].includes(code),
    requiresVerifier: !["FILE_NOT_FOUND", "STAGE_NOT_RESOLVED", "DEPENDENCY_MISSING", "RESULT_CONTRACT_INVALID"].includes(code),
    maxRetries: 3,
    reflectionPath: reflection.reflectionPath,
    createdAt: reflection.createdAt,
  }
}

const REPAIR_HANDLERS: Partial<Record<StageFailureCode, RepairHandler>> = {
  COLUMN_NOT_FOUND: ({ failure, stage }) => {
    const replay = normalizeRecord(stage?.replayInput)
    const requested = Object.entries(replay)
      .filter(([, value]) => typeof value === "string")
      .map(([, value]) => value as string)
      .filter(
        (value) => /var|column|outcome|dependent|independent|entity|time|treat|id/i.test(value) || value.includes("_"),
      )
    const columnCandidates = collectColumnCandidates(normalizeRecord(stage?.metadata), replay)
    const suggestions = requested.flatMap((name) => similarColumns(name, columnCandidates))
    return {
      retryStage: "profile_or_schema_check",
      repairAction: "先运行画像或 schema 检查，解析准确列名，再只重试失败阶段。",
      autoApply: true,
      requiresVerifier: true,
      repairMetadata: {
        requestedColumns: requested,
        candidateColumns: [...new Set(suggestions)].slice(0, 8),
        nextCommand: "/doctor",
      },
    }
  },
  PANEL_KEY_DUPLICATED: () => ({
    retryStage: "validate",
    repairAction:
      "先核验实体—时间键；确认是真实重复后再去重或聚合，重新运行 数据质量检查，随后只重试失败的估计阶段。",
    autoApply: true,
    requiresVerifier: true,
    repairMetadata: {
      strategy: ["dedup", "aggregate"],
      blocksEstimate: true,
    },
  }),
  DEPENDENCY_MISSING: () => ({
    retryStage: "healthcheck",
    repairAction: "运行 doctor/healthcheck，安装或指向缺失依赖，再重试被阻断阶段。",
    autoApply: true,
    requiresVerifier: false,
    repairMetadata: {
      nextCommand: "/doctor",
      installHint: true,
    },
  }),
  VALIDATE_BLOCKED: ({ stage }) => ({
    retryStage: stage?.kind === "preprocess_or_filter" ? "preprocess_or_filter" : "validate",
    repairAction: "先修复 数据质量检查 阻断项；数据质量检查通过前，叙述和报告阶段必须保持阻断。",
    autoApply: false,
    requiresVerifier: true,
    repairMetadata: {
      blocksReport: true,
      repairOnly: true,
    },
  }),
  STAGE_NOT_RESOLVED: ({ workflow, stage }) => ({
    retryStage: "import",
    repairAction: "解析最新数据集 manifest 与产物血缘，再只重试失败阶段。",
    autoApply: true,
    requiresVerifier: false,
    repairMetadata: {
      datasetId: workflow?.datasetId ?? stage?.datasetId,
      latestTrustedArtifacts: workflow?.trustedArtifacts ?? [],
    },
  }),
  ARTIFACT_MISSING: ({ workflow, stage, failure }) => ({
    // 检查缺失产物的类型，做精确归因（2026-07-21 修复）。
    // baseline_estimate 上缺 profile 产物不应指到 import——与
    // #profile-lineage 同理，profile 可在父 stage 重跑完成。
    // 元数据里 missingArtifactKind 由调用方（reflection/tool-runner）
    // 设置；无此信息时回退到旧按 stage 猜的逻辑。
    retryStage: (() => {
      const meta = normalizeRecord(failure.repairMetadata)
      const kind = String(meta.missingArtifactKind ?? "")
      if (kind === "profile") return "profile_or_schema_check"
      if (kind === "validate" || kind === "qa") return "validate"
      if (kind === "profile_or_diagnostics" || kind === "describe" || kind === "diagnostics") return "profile_or_diagnostics"
      return stage?.kind === "baseline_estimate" ? "profile_or_diagnostics" : "import"
    })(),
    repairAction: (() => {
      const meta = normalizeRecord(failure.repairMetadata)
      const kind = String(meta.missingArtifactKind ?? "")
      if (kind === "profile")
        return "当前 stage 缺少数据画像（profile）产物；请在前述 stage 上重新运行数据画像，再继续执行。"
      if (kind === "validate") return "当前 stage 缺少 数据质量检查 质检结果；请在当前 stage 上重新运行数据 数据质量检查，再继续。"
      return "根据最新 manifest 血缘重新生成缺失产物，再继续后续阶段。"
    })(),
    autoApply: true,
    requiresVerifier: true,
    repairMetadata: {
      latestTrustedArtifacts: workflow?.trustedArtifacts ?? [],
      targetStageId: stage?.stageId,
    },
  }),
}

export function applyRepairHandler(input: { failure: StageFailureRecord; stage?: StageNode; workflow?: WorkflowRun }) {
  const handler = REPAIR_HANDLERS[input.failure.code]
  if (!handler) return input.failure
  const result = handler(input)
  return {
    ...input.failure,
    retryStage: result.retryStage,
    repairAction: result.repairAction,
    autoRepairAllowed: result.autoApply,
    requiresVerifier: result.requiresVerifier,
    repairMetadata: result.repairMetadata,
  } satisfies StageFailureRecord
}

function normalizeReplayInput(args: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(args)) as Record<string, unknown>
}

function workflowStageTargetsDatasetStage(stage: StageNode, datasetId: string, stageId: string) {
  const replayInput = normalizeRecord(stage.replayInput)
  const metadata = normalizeRecord(stage.metadata)
  const recordedDatasetId =
    stage.datasetId ??
    (typeof replayInput.datasetId === "string" ? replayInput.datasetId : undefined) ??
    (typeof metadata.datasetId === "string" ? metadata.datasetId : undefined)
  return recordedDatasetId === datasetId && (replayInput.stageId === stageId || metadata.stageId === stageId)
}

/**
 * 估计器只能消费当前会话中已经完成画像和 数据质量检查 的 canonical stage。
 * 这条校验放在后端入口，而不是只写进提示词，防止模型直接拿原始路径绕过数据准备。
 */
export function assertDatasetStageReadyForEstimation(input: { sessionID: string; datasetId: string; stageId: string }) {
  const manifest = readDatasetManifest(input.datasetId)
  const datasetStage = getStage(manifest, input.stageId)
  const sessionState = readWorkflowSession(input.sessionID)
  const activeRun = sessionState.activeRunId
    ? sessionState.runs.find((candidate) => candidate.workflowRunId === sessionState.activeRunId)
    : undefined
  // “回到第一份数据继续分析”是合法的数据上下文切换：当前 activeRun 可能属于后来
  // 导入的另一份文件，但旧数据集的画像/质检仍保存在本会话的历史 run 中。优先复用
  // active run，找不到时再按最近更新时间选同 dataset 的 run，避免把血缘切换误判成
  // 缺少画像。切换成功后同步 activeRunId，后续记录估计阶段才能落在正确 run。
  const run =
    (activeRun?.datasetId === input.datasetId ? activeRun : undefined) ??
    [...sessionState.runs]
      .filter((candidate) => candidate.datasetId === input.datasetId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  if (!run) {
    throw new Error("计量估计前必须先在当前会话完成同一数据集阶段的画像与 数据质量检查。")
  }
  if (sessionState.activeRunId !== run.workflowRunId) {
    sessionState.activeRunId = run.workflowRunId
    writeWorkflowSession(sessionState)
  }

  const matchingStages = run.stages.filter(
    (stage) => stage.status === "completed" && workflowStageTargetsDatasetStage(stage, input.datasetId, input.stageId),
  )
  // 数据质量检查 必须落在当前 stage。filter/preprocess 改变样本语义，数据质量检查 不可代际继承。
  const qaStages = matchingStages.filter((stage) => stage.kind === "validate")
  const datasetMetadata = normalizeRecord(datasetStage?.metadata)
  const autoQa = normalizeRecord(datasetMetadata.autoQa)
  const autoQaStatus = autoQa.status === "pass" || autoQa.status === "warn" || autoQa.status === "block"
    ? autoQa.status
    : undefined
  const automaticQaStage: StageNode | undefined = datasetStage && autoQaStatus && autoQaStatus !== "block"
    ? {
        nodeId: `${input.stageId}:auto-qa`,
        stageId: input.stageId,
        kind: "validate",
        status: "completed",
        branch: datasetStage.branch,
        datasetId: input.datasetId,
        runId: datasetStage.runId,
        toolName: "data_import",
        replayInput: { action: "import", datasetId: input.datasetId, stageId: input.stageId },
        artifactRefs: [],
        trustedArtifacts: [],
        metadata: {
          qaGateStatus: autoQaStatus,
          warnings: Array.isArray(autoQa.warnings) ? autoQa.warnings : [],
          blocking_errors: [],
        },
        createdAt: datasetStage.createdAt,
        updatedAt: datasetStage.createdAt,
      }
    : undefined
  const qa = qaStages.find(
    (stage) =>
      normalizeRecord(stage.metadata).qaGateStatus !== "block" && stage.verifierReport?.status !== "block",
  ) ?? automaticQaStage
  if (!qa) {
    // "数据质量检查 从未跑过"和"数据质量检查 跑过但被拦下"必须给出不同指令。此前两种情况共用一句
    // "请先完成数据质检"——后者的唯一可能反应就是再跑一次 数据质量检查，然后再次被同样的原因
    // 拦下，构成无限死循环（2026-08-05 用户真实测试：panel_fe_regression 连续被拒，
    // 中间模型老老实实重跑了 profile+数据质量检查 且都成功）。这里把真正的阻断原因抛出去。
    const blocked = qaStages.at(-1)
    if (blocked) {
      const reason =
        blocked.verifierReport?.blockingFindings?.join("；") ||
        (typeof normalizeRecord(blocked.metadata).qaGateReason === "string"
          ? String(normalizeRecord(blocked.metadata).qaGateReason)
          : undefined)
      const hint = blocked.verifierReport?.repairHints?.join("；")
      throw new Error(
        [
          `当前 canonical stage 的 数据质量检查已经执行过（${blocked.stageId}），但被判定为阻断，重复运行 数据质量检查 不会改变结果。`,
          reason ? `阻断原因：${reason}` : undefined,
          hint ? `修复建议：${hint}` : undefined,
          "请修复上述阻断项本身；若无法修复，请向用户说明并询问如何继续，不要反复重跑质检。",
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }
    if (autoQaStatus === "block") {
      const reasons = [
        ...(Array.isArray(autoQa.blockingErrors) ? autoQa.blockingErrors : []),
        ...(Array.isArray(autoQa.suggestedRepairs) ? autoQa.suggestedRepairs : []),
      ].filter((item): item is string => typeof item === "string" && item.length > 0)
      throw new Error([
        "上传后的自动 数据质量检查 发现阻断问题，当前估计尚未执行。",
        reasons.length ? `问题：${reasons.join("；")}` : undefined,
        "请先确认数据修正方案，系统不会静默删除样本或跳过质检。",
      ].filter(Boolean).join("\n"))
    }
    throw new Error("计量估计前必须先在当前 canonical stage 通过 数据质量检查；请先完成数据质检。")
  }
  // profile 先看当前 stage，没有则沿 parentStageId 链回溯到最近的可用祖先。
  // filter 只删行不改 schema，父 stage 的画像方法学上仍完全适用（2026-07-18 死锁修复）。
  let profile = matchingStages.find((stage) => stage.kind === "profile_or_schema_check")
  let profileInherited = false
  if (!profile) {
    profile =
      findInheritedProfileStage({
        datasetId: input.datasetId,
        datasetStageId: input.stageId,
        runStages: run.stages,
      }) ?? undefined
    profileInherited = Boolean(profile)
  }
  if (!profile) {
    // 跨 run 兜底：画像可能在旧 workflow run（recommend 创建时未指定 runId，被后续带
    // runId 的操作接管前曾分裂成两个 run；历史会话遗留的 run 结构无法自愈）。估计门禁
    // 只查 active run 会找不到画像而误拒——沿同 datasetId 的所有 run 找画像。
    const acrossRuns = findProfileAcrossRuns({
      sessionID: input.sessionID,
      datasetId: input.datasetId,
      datasetStageId: input.stageId,
    })
    if (acrossRuns) {
      profile = acrossRuns
      profileInherited = true
    }
  }
  if (!profile) {
    const readiness = datasetMetadata.dataReadiness
    const hasReadiness = Boolean(
      readiness &&
        typeof readiness === "object" &&
        !Array.isArray(readiness) &&
        (readiness as Record<string, unknown>).version === 1,
    )
    if (hasReadiness && datasetStage) {
      profile = {
        nodeId: `${input.stageId}:auto-profile`,
        stageId: input.stageId,
        kind: "profile_or_schema_check",
        status: "completed",
        branch: datasetStage.branch,
        datasetId: input.datasetId,
        runId: datasetStage.runId,
        toolName: "data_import",
        replayInput: { action: "import", datasetId: input.datasetId, stageId: input.stageId },
        artifactRefs: [],
        trustedArtifacts: [],
        metadata: { dataReadiness: readiness, automatic: true },
        createdAt: datasetStage.createdAt,
        updatedAt: datasetStage.createdAt,
      }
      profileInherited = true
    }
  }
  if (!profile) {
    throw new Error("计量估计前必须先完成当前 canonical stage（或父 stage）的数据画像；请先分析数据结构。")
  }
  return {
    manifest,
    stage: datasetStage,
    workflowRun: run,
    profileStage: profile,
    qaStage: qa,
    profileInherited,
  }
}

/**
 * 清洗是修复 数据质量检查 阻断的手段，不能错误复用“估计器必须先通过 数据质量检查”的门禁。
 * 它仍要求模型已在当前会话确认同一数据集的画像，避免拿任意路径绕过数据血缘。
 */
export function assertDatasetStageReadyForPreprocess(input: { sessionID: string; datasetId: string; stageId: string }) {
  const manifest = readDatasetManifest(input.datasetId)
  const datasetStage = getStage(manifest, input.stageId)
  const run = getActiveWorkflowRun(input.sessionID)
  if (!run || run.datasetId !== input.datasetId) {
    throw new Error("数据预处理前必须先在当前会话完成同一数据集阶段的画像。")
  }

  const matchingStages = run.stages.filter(
    (stage) => stage.status === "completed" && workflowStageTargetsDatasetStage(stage, input.datasetId, input.stageId),
  )
  let profile = matchingStages.find((stage) => PREPROCESS_PROFILE_KINDS.has(stage.kind))
  let profileInherited = false
  if (!profile) {
    profile =
      findInheritedProfileStage({
        datasetId: input.datasetId,
        datasetStageId: input.stageId,
        runStages: run.stages,
        profileKinds: PREPROCESS_PROFILE_KINDS,
      }) ?? undefined
    profileInherited = Boolean(profile)
  }
  if (!profile) {
    // 与估计门禁同样的跨 run 兜底：画像可能在旧 run（见 findProfileAcrossRuns 注释）。
    const acrossRuns = findProfileAcrossRuns({
      sessionID: input.sessionID,
      datasetId: input.datasetId,
      datasetStageId: input.stageId,
      profileKinds: PREPROCESS_PROFILE_KINDS,
    })
    if (acrossRuns) {
      profile = acrossRuns
      profileInherited = true
    }
  }
  if (!profile) {
    // 最后兜底：同一数据集的任意已完成画像（不限 stageId）。
    // 自动修复场景中，combine_columns 等工具创建新 stage 后立即重跑 数据质量检查/预处理，
    // 新 stage 的 parentStageId 链可能尚未被 findInheritedProfileStage 遍历到
    //（2026-08-25 status-check 真实场景），但同一数据集的画像信息仍然有效。
    const anyProfile = run.stages.find(
      (s) => s.status === "completed" && PREPROCESS_PROFILE_KINDS.has(s.kind) && s.datasetId === input.datasetId,
    )
    if (anyProfile) {
      profile = anyProfile
      profileInherited = true
    }
  }
  if (!profile) {
    throw new Error("数据预处理前必须先完成当前 canonical stage（或父 stage）的数据画像；请先分析数据结构。")
  }

  return {
    manifest,
    stage: datasetStage,
    workflowRun: run,
    profileStage: profile,
    profileInherited,
  }
}

function findInheritedProfileStage(input: {
  datasetId: string
  datasetStageId: string
  runStages: readonly StageNode[]
  profileKinds?: ReadonlySet<WorkflowStageKind>
}): StageNode | undefined {
  // 沿数据集 manifest 的 parentStageId 链回溯，直到找到有 profile 的 stage 或回到链头。
  // 每一步只信任当前会话、当前数据集的 run.stages（同一 datasetId + stageId）。
  const manifest = readDatasetManifest(input.datasetId)
  for (const stageId of iterAncestorStageIds(manifest, input.datasetStageId)) {
    const hit = input.runStages.find(
      (s) =>
        s.status === "completed" &&
        (input.profileKinds ?? new Set<WorkflowStageKind>(["profile_or_schema_check"])).has(s.kind) &&
        workflowStageTargetsDatasetStage(
          s as Parameters<typeof workflowStageTargetsDatasetStage>[0],
          input.datasetId,
          stageId,
        ),
    )
    if (hit) return hit
  }
  return undefined
}

// 沿 manifest parentStageId 链产出 stageId 候选（自身 → 父 → 祖父 → ...）。findInheritedProfileStage
// 与 findProfileAcrossRuns 共用祖先遍历，避免重复实现 IIFE / visited Set / ancestors 数组。
function* iterAncestorStageIds(manifest: { stages: Array<{ stageId: string; parentStageId?: string }> }, fromStageId: string): Generator<string> {
  const visited = new Set<string>()
  yield fromStageId
  let cursor: string | undefined = manifest.stages.find((s) => s.stageId === fromStageId)?.parentStageId
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor)
    yield cursor
    cursor = manifest.stages.find((s) => s.stageId === cursor)?.parentStageId
  }
}

/**
 * 跨 workflow run 的画像兜底：estimate 门禁只查 active run 的 stages，但画像可能
 * 落在另一个 run 里（recommend 创建 run 时未指定 runId，被后续带 runId 的 数据质量检查/估计
 * 接管前曾分裂成两个 run；历史会话遗留的 run 结构无法自愈）。沿同 datasetId 的
 * 所有 run、从当前 stage 沿 manifest 父链回溯，找最近的 completed profile。
 * 与 findInheritedProfileStage 的区别：后者只在当前 run 内找，这里放开到全 run。
 */
function findProfileAcrossRuns(input: {
  sessionID: string
  datasetId: string
  datasetStageId: string
  profileKinds?: ReadonlySet<WorkflowStageKind>
}): StageNode | undefined {
  const sessionState = readWorkflowSession(input.sessionID)
  const manifest = readDatasetManifest(input.datasetId)
  const isProfileForStage = (s: StageNode, stageId: string) =>
    s.status === "completed" &&
    (input.profileKinds ?? new Set<WorkflowStageKind>(["profile_or_schema_check"])).has(s.kind) &&
    workflowStageTargetsDatasetStage(
      s as Parameters<typeof workflowStageTargetsDatasetStage>[0],
      input.datasetId,
      stageId,
    )
  for (const stageId of iterAncestorStageIds(manifest, input.datasetStageId)) {
    for (let r = sessionState.runs.length - 1; r >= 0; r--) {
      const run = sessionState.runs[r]
      if (run.datasetId !== input.datasetId) continue
      const hit = run.stages.find((s) => isProfileForStage(s, stageId))
      if (hit) return hit
    }
  }
  return undefined
}

export async function ensureAnalysisPlan(input: {
  sessionID: string
  datasetId?: string
  runId?: string
  branch?: string
}) {
  const sessionState = readWorkflowSession(input.sessionID)
  const run = ensureRun(sessionState, {
    datasetId: input.datasetId,
    runId: input.runId,
    branch: input.branch,
  })
  run.workflowLocale = await resolveWorkflowLocale(input.sessionID, run.workflowLocale)
  run.planGeneratedAt = run.planGeneratedAt ?? nowIso()
  if (run.approvalStatus !== "approved") run.approvalStatus = "required"
  run.updatedAt = nowIso()
  refreshWorkflowRunDerivedState(run)
  writeWorkflowSession(sessionState)
  publishWorkflowState(input.sessionID, run)
  return run
}

export function setAnalysisPlanApproval(input: {
  sessionID: string
  approvalStatus: "approved" | "declined"
  datasetId?: string
  runId?: string
  branch?: string
}) {
  const sessionState = readWorkflowSession(input.sessionID)
  const run = ensureRun(sessionState, {
    datasetId: input.datasetId,
    runId: input.runId,
    branch: input.branch,
  })
  run.planGeneratedAt = run.planGeneratedAt ?? nowIso()
  run.approvalStatus = input.approvalStatus
  run.updatedAt = nowIso()
  refreshWorkflowRunDerivedState(run)
  writeWorkflowSession(sessionState)
  publishWorkflowState(input.sessionID, run)
  return run
}

export function formatAnalysisChecklist(run?: WorkflowRun) {
  if (!run) return []
  const locale = run.workflowLocale ?? "en"
  return (run.analysisChecklist ?? []).map((item, index) => {
    const detail = item.summary ? ` - ${item.summary}` : ""
    return `${index + 1}. ${item.label} [${workflowChecklistStatusLabel(locale, item.status)}]${detail}`
  })
}

export function workflowPromptSummary(sessionID: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) return []
  const locale = run.workflowLocale ?? "en"
  const stage =
    (run.activeNodeId ? run.stages.find((item) => item.nodeId === run.activeNodeId) : undefined) ??
    activeOrLatestStage(run)
  const base = [
    locale === "zh-CN" ? "工作流运行摘要：" : "Workflow runtime summary:",
    `- workflowRunId: ${run.workflowRunId}`,
    `- branch: ${run.branch}`,
    run.datasetId ? `- datasetId: ${run.datasetId}` : undefined,
    run.runId ? `- runId: ${run.runId}` : undefined,
    run.activeStage
      ? `- ${locale === "zh-CN" ? "当前阶段" : "active stage"}: ${workflowStageLabel(locale, run.activeStage) ?? run.activeStage}${stage ? ` (${stage.stageId}, ${locale === "zh-CN" ? "状态" : "status"}=${workflowChecklistStatusLabel(locale, stage.status === "running" ? "in_progress" : stage.status === "completed" ? "completed" : stage.status === "blocked" || stage.status === "failed" ? "blocked" : "pending")})` : ""}`
      : undefined,
    run.repairOnly
      ? `- ${locale === "zh-CN" ? "仅修复模式" : "repair-only mode"}: ${locale === "zh-CN" ? "开启" : "enabled"}`
      : `- ${locale === "zh-CN" ? "仅修复模式" : "repair-only mode"}: ${locale === "zh-CN" ? "关闭" : "disabled"}`,
    run.latestFailure
      ? `- ${locale === "zh-CN" ? "最近失败" : "last failure"}: ${run.latestFailure.code}; ${locale === "zh-CN" ? "重试阶段" : "retry stage"}=${run.latestFailure.retryStage}; ${locale === "zh-CN" ? "修复动作" : "repair"}=${run.latestFailure.repairAction}`
      : undefined,
    run.latestVerifier
      ? `- ${locale === "zh-CN" ? "最近校验器" : "latest verifier"}: ${workflowLocaleLabel(locale, {
          en: run.latestVerifier.status,
          zh: run.latestVerifier.status === "pass" ? "通过" : run.latestVerifier.status === "warn" ? "警告" : "阻塞",
        })}`
      : undefined,
  ].filter(Boolean)
  const stagePolicy = stage
    ? [
        locale === "zh-CN" ? "工作流阶段策略：" : "Workflow stage policy:",
        `- ${locale === "zh-CN" ? "当前阶段类型" : "current stage kind"}: ${workflowStageLabel(locale, stage.kind) ?? stage.kind}`,
        `- ${locale === "zh-CN" ? "依赖阶段" : "depends on"}: ${(stage.dependsOn ?? []).map((item) => workflowStageLabel(locale, item) ?? item).join(", ") || (locale === "zh-CN" ? "无" : "none")}`,
        `- ${locale === "zh-CN" ? "下游阶段" : "downstream stages"}: ${(stage.downstream ?? []).map((item) => workflowStageLabel(locale, item) ?? item).join(", ") || (locale === "zh-CN" ? "无" : "none")}`,
        `- ${locale === "zh-CN" ? "可回放" : "replayable"}: ${stage.replayable === false ? (locale === "zh-CN" ? "否" : "no") : locale === "zh-CN" ? "是" : "yes"}`,
        `- ${locale === "zh-CN" ? "推荐技能包" : "recommended skill bundle"}: ${recommendedSkillBundle(stage.kind).join(", ")}`,
      ]
    : []
  const verifierPolicy = [
    locale === "zh-CN" ? "校验器策略：" : "Verifier policy:",
    `- ${locale === "zh-CN" ? "是否自动需要校验器" : "auto verifier required"}: ${stage && stageNeedsVerifier(stage.kind) ? (locale === "zh-CN" ? "是" : "yes") : locale === "zh-CN" ? "否" : "no"}`,
    run.latestVerifier?.status === "block"
      ? locale === "zh-CN"
        ? "- 校验器当前阻塞流程；不要继续叙述或报告，只修复失败阶段。"
        : "- verifier is blocking progress; do not continue to narrative/report, repair the failed stage only."
      : locale === "zh-CN"
        ? "- 仅在产物与阶段假设仍然有效时继续。"
        : "- continue only if artifacts and stage assumptions remain valid.",
  ]
  const memory = [
    locale === "zh-CN" ? "工作流记忆：" : "Workflow memory:",
    run.trustedArtifacts.length
      ? `- ${locale === "zh-CN" ? "可信产物" : "trusted artifacts"}: ${run.trustedArtifacts.slice(-6).join(", ")}`
      : `- ${locale === "zh-CN" ? "可信产物" : "trusted artifacts"}: ${locale === "zh-CN" ? "暂无" : "none yet"}`,
  ]
  const checklist = [
    workflowPlanTitle(locale) + ":",
    ...(run.analysisChecklist ?? []).map(
      (item) =>
        `- ${item.label}: ${workflowChecklistStatusLabel(locale, item.status)}${item.summary ? ` (${item.summary})` : ""}`,
    ),
    run.approvalStatus
      ? `- ${workflowApprovalTitle(locale).toLowerCase()}: ${workflowApprovalStatusLabel(locale, run.approvalStatus)}`
      : undefined,
  ].filter(Boolean)
  return [
    base.join("\n"),
    stagePolicy.join("\n"),
    verifierPolicy.join("\n"),
    memory.join("\n"),
    checklist.join("\n"),
  ].filter((item) => item.trim().length > 0)
}

export function recommendedSkillBundle(kind: WorkflowStageKind) {
  switch (kind) {
    case "healthcheck":
    case "import":
    case "profile_or_schema_check":
    case "validate":
    case "preprocess_or_filter":
      return ["data-prep", "qa-repair"]
    case "profile_or_diagnostics":
      return ["diagnostics", "inspection"]
    case "baseline_estimate":
      return ["econometrics", "fixed-effects"]
    case "verifier":
      return ["verification", "artifact-audit"]
    case "report":
      return ["reporting", "numeric-grounding"]
  }
}

export function recordWorkflowStageSuccess(input: {
  sessionID: string
  toolName: string
  args: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const sessionState = readWorkflowSession(input.sessionID)
  const metadata = normalizeRecord(input.metadata)
  const contract = validateWorkflowResultContract({
    toolName: input.toolName,
    args: input.args,
    metadata,
  })
  if (!contract.ok) throw new WorkflowResultContractError(contract.issues)
  const metadataBranch = typeof metadata.branch === "string" ? metadata.branch.trim() : ""
  const argumentBranch = typeof input.args.branch === "string" ? input.args.branch.trim() : ""
  const branch = metadataBranch || argumentBranch || "main"
  const run = ensureRun(sessionState, {
    datasetId:
      typeof metadata.datasetId === "string"
        ? metadata.datasetId
        : typeof input.args.datasetId === "string"
          ? input.args.datasetId
          : undefined,
    runId:
      typeof metadata.runId === "string"
        ? metadata.runId
        : typeof input.args.runId === "string"
          ? input.args.runId
          : undefined,
    branch,
  })
  run.activeTaskId = activeRuntimeTaskId(input.sessionID) ?? run.activeTaskId
  const kind = stageKindFromTool(input.toolName, input.args, metadata)
  const cacheKey = stageCacheKey(kind, input.args, metadata)
  const preferredStageId =
    (typeof metadata.stageId === "string" ? metadata.stageId : undefined) ??
    (typeof input.args.stageId === "string" ? input.args.stageId : undefined) ??
    `${kind}_${run.stages
      .filter((stage) => stage.kind === kind)
      .length.toString()
      .padStart(3, "0")}`
  const stageId = resolveWorkflowStageId({
    run,
    branch,
    kind,
    preferredStageId,
    cacheKey,
  })
  const blockedByDecision = metadata.requiresUserDecision === true
  const stageStatus: StageStatus =
    blockedByDecision || metadata.qaGateStatus === "block" ? "blocked" : "completed"
  const artifacts = blockedByDecision ? [] : collectArtifactRefs(metadata)
  const readableArtifacts = filterVerifierReadableArtifactRefs(artifacts)
  const parent = deriveParentStage(run, branch, kind, metadata)
  const stage = upsertStage(run, {
    nodeId: `${branch}:${stageId}`,
    stageId,
    kind,
    status: stageStatus,
    branch,
    datasetId: run.datasetId,
    runId: run.runId,
    parentStageId: parent?.stageId ?? (typeof metadata.parentStageId === "string" ? metadata.parentStageId : undefined),
    parentNodeId: parent?.nodeId,
    dependsOn: computeDependsOn(run, branch, kind, metadata),
    downstream: computeKindDownstream(run, branch, kind),
    cacheKey,
    replayable: true,
    executionMode: "normal",
    toolName: input.toolName,
    replayInput: normalizeReplayInput(input.args),
    artifactRefs: artifacts,
    // 存绝对路径以绕开 postTool 异步续体里的 ALS 上下文丢失，但**基准必须是
    // projectRoot()（= Instance.worktree），不能是 Instance.directory**。
    //
    // dev TUI 下 directory 是 packages/killstata，而 .killstata 挂在 projectRoot() 下；
    // 用 directory 作基准会写出 /…/packages/killstata/.killstata/… 这种不存在的路径，
    // 而绝对路径又会让 artifact.ts 的 artifactPathCandidates 直接短路（isAbsolute 只返回
    // 自身），多基准兜底救不回来——一次写错永久锁死（2026-08-08 真实数据测试：
    // readableArtifactRefs 4 条全部指向不存在的 packages/killstata/.killstata，verifier
    // 连续 block，两次 rerun + 一次 restore 全部无效）。
    // 拿不到 worktree（无 ALS 上下文）时退回原始相对引用，交给读侧多基准解析，
    // 绝不写入一个基准可疑的绝对路径。
    readableArtifactRefs: readableArtifacts.map((ref) => absoluteArtifactRef(ref)),
    trustedArtifacts: stageStatus === "blocked" || stageNeedsVerifier(kind) ? [] : readableArtifacts,
    metadata,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  stage.failure = undefined
  stage.verifierReport = undefined
  const recommendation = normalizeRecord(metadata.recommendation)
  if (input.toolName === "econometrics_recommend" && typeof recommendation.recommendedMethod === "string") {
    run.lastRecommendationMethod = recommendation.recommendedMethod
  }
  // 修复模式判定：进入本函数前 repairOnly 已为 true（上一步失败设置），本次成功是
  // 修复**前置**动作（recommend/data_import/data_preprocess 补齐画像/数据质量检查/清洗）。
  // 此时不能把 activeStage 按正常流程顺延（nextStage(profile)=validate，validate bundle
  // 不含估计器，修复目标 did_static 立刻不可见，重试被拒 unavailable，修复路径断裂——
  // 2026-08-09 drive did-direct 真实会话）。前置动作成功后应保持失败的 stage 与
  // repairOnly，直到修复目标工具本身成功才清 repairOnly、顺延到 verifier。
  const failedStageKind = run.repairOnly === true ? run.activeStage : undefined
  run.activeNodeId = stage.nodeId
  // 优先级顺序写成扁平 if 链而非嵌套三元：这个顺序本身就是语义——修复前置必须排在
  // verifier 之前。data_import / data_preprocess 落到的 import / validate /
  // preprocess_or_filter 全在 AUTO_VERIFY_STAGES 里，先判 verifier 会让保留分支永远
  // 不可达，修复目标被顶掉（activeStage=verifier 却 repairOnly=true）。
  const isRepairPrerequisite = failedStageKind !== undefined && failedStageKind !== kind
  const blocked = stageStatus === "blocked"
  if (blocked) run.activeStage = kind
  else if (isRepairPrerequisite) run.activeStage = failedStageKind
  else if (stageNeedsVerifier(kind)) run.activeStage = "verifier"
  else run.activeStage = nextStage(kind) ?? kind
  run.repairOnly = blocked || isRepairPrerequisite
  run.blockedStageId = blocked ? stage.stageId : undefined
  // 修复前置动作不切 verifier 协调者：activeStage 已保持在修复目标上，协调者跟着走才自洽。
  run.activeCoordinatorAgent = !blocked && !isRepairPrerequisite && stageNeedsVerifier(kind) ? "verifier" : "general"
  run.updatedAt = nowIso()
  if (!blocked && !stageNeedsVerifier(kind)) {
    run.trustedArtifacts = [...new Set([...run.trustedArtifacts, ...readableArtifacts])]
  }
  // 修复前置动作成功不清 latestFailure：TUI 仍显示失败详情，直到修复目标工具本身成功。
  if (!blocked && !isRepairPrerequisite) {
    run.latestFailure = undefined
  }
  refreshWorkflowRunDerivedState(run)
  if (!stageNeedsVerifier(kind) && stageStatus === "completed") {
    const checkpoint = createWorkflowCheckpoint({ sessionID: input.sessionID, run, stage })
    run.lastCheckpointId = checkpoint.checkpointId
  }
  writeWorkflowSession(sessionState)
  publishWorkflowState(input.sessionID, run)
  return { workflowRun: run, stage }
}

export function recordWorkflowStageFailure(input: {
  sessionID: string
  toolName: string
  args: Record<string, unknown>
  reflection: ToolReflection
}) {
  const sessionState = readWorkflowSession(input.sessionID)
  const requestedDatasetId = typeof input.args.datasetId === "string" ? input.args.datasetId : undefined
  const activeRun = sessionState.activeRunId
    ? sessionState.runs.find((candidate) => candidate.workflowRunId === sessionState.activeRunId)
    : sessionState.runs.at(-1)
  const preservedActiveRunId = activeRun?.workflowRunId
  // 模型在一个已经交付估计结果的用户动作中晚到地导入另一个文件时，失败的导入不能
  // 把当前研究切换成一个空的 blocked run。失败仍需落盘供诊断，但活动研究应继续指向
  // 已完成的估计；只有首次导入或用户明确带 datasetId 的失败才接管活动 run。
  const keepCompletedAnalysisActive = Boolean(
    activeRun &&
      !requestedDatasetId &&
      activeRun.stages.some(
        (stage) =>
          ["baseline_estimate", "verifier", "report"].includes(stage.kind) &&
          stage.status === "completed",
      ),
  )
  const reuseActiveRun = Boolean(activeRun && requestedDatasetId && activeRun.datasetId === requestedDatasetId)
  const branch = reuseActiveRun ? activeRun!.branch : "main"
  const run = ensureRun(sessionState, {
    datasetId: requestedDatasetId,
    runId: reuseActiveRun ? activeRun?.runId : undefined,
    branch,
    forceNew: !requestedDatasetId,
  })
  if (keepCompletedAnalysisActive && preservedActiveRunId) sessionState.activeRunId = preservedActiveRunId
  run.activeTaskId = activeRuntimeTaskId(input.sessionID) ?? run.activeTaskId
  const kind = stageKindFromTool(input.toolName, input.args)
  const cacheKey = stageCacheKey(kind, input.args)
  const preferredStageId = typeof input.args.stageId === "string" ? input.args.stageId : `${kind}_failed`
  const stageId = resolveWorkflowStageId({
    run,
    branch,
    kind,
    preferredStageId,
    cacheKey,
  })
  const parent = deriveParentStage(run, branch, kind)
  const failure = applyRepairHandler({
    failure: failureFromReflection(input.reflection),
    stage: parent,
    workflow: run,
  })
  const stage = upsertStage(run, {
    nodeId: `${branch}:${stageId}`,
    stageId,
    kind,
    status: failure.code === "VALIDATE_BLOCKED" ? "blocked" : "failed",
    branch,
    datasetId: run.datasetId,
    runId: run.runId,
    parentStageId: parent?.stageId,
    parentNodeId: parent?.nodeId,
    dependsOn: computeDependsOn(run, branch, kind),
    downstream: computeKindDownstream(run, branch, kind),
    cacheKey,
    replayable: true,
    executionMode: "normal",
    toolName: input.toolName,
    replayInput: normalizeReplayInput(input.args),
    artifactRefs: [],
    trustedArtifacts: [],
    metadata: {},
    failure,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  run.activeNodeId = stage.nodeId
  run.activeStage = kind
  run.repairOnly = true
  run.blockedStageId = stage.stageId
  run.activeCoordinatorAgent =
    failure.code === "STAGE_NOT_RESOLVED" || failure.code === "ARTIFACT_MISSING" ? "explore" : "general"
  run.latestFailure = failure
  run.updatedAt = nowIso()
  RuntimeTaskLedger.appendEvent({
    sessionID: input.sessionID,
    taskId: run.activeTaskId,
    kind: "failure",
    stageId: stage.stageId,
    workflowRunId: run.workflowRunId,
    message: failure.message,
    metadata: { code: failure.code, repairAction: failure.repairAction },
  })
  refreshWorkflowRunDerivedState(run)
  writeWorkflowSession(sessionState)
  const visibleRun = keepCompletedAnalysisActive
    ? sessionState.runs.find((candidate) => candidate.workflowRunId === preservedActiveRunId) ?? run
    : run
  publishWorkflowState(input.sessionID, visibleRun)
  return { workflowRun: visibleRun, stage }
}
