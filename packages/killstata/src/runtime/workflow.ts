import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Bus } from "@/bus"
import { MessageV2 } from "@/session/message-v2"
import type {
  AnalysisChecklistItem,
  RepairHandler,
  RepairHandlerResult,
  StageFailureCode,
  StageFailureRecord,
  StageReuseRecord,
  StageNode,
  StageStatus,
  ToolAvailabilityPolicy,
  ToolAvailabilityResolution,
  VerifierCheck,
  VerifierReport,
  VerifierTaskEnvelope,
  WorkflowCoordinatorDecision,
  WorkflowRun,
  WorkflowStageKind,
} from "./types"
import { RuntimeEvents } from "./events"
import {
  detectWorkflowLocaleFromText,
  inferWorkflowLocaleFromSession,
  workflowAnalysisPlanHeader,
  workflowApprovalStatusLabel,
  workflowChecklistLabel,
  workflowChecklistIntro,
  workflowChecklistApprovalPrompt,
  workflowChecklistOptions,
  workflowChecklistStatusLabel,
  workflowLocaleLabel,
  workflowPlanTitle,
  workflowStageLabel,
  workflowStageTitle,
  workflowApprovalTitle,
  type WorkflowLocale,
} from "./workflow-locale"
import type { FailureType, ToolReflection } from "@/tool/analysis-reflection"
import { getStage, projectStateRoot, readDatasetManifest } from "@/tool/analysis-state"

type WorkflowSessionState = {
  version: 1
  sessionID: string
  activeRunId?: string
  runs: WorkflowRun[]
}

const DEFAULT_STAGE_SEQUENCE: WorkflowStageKind[] = [
  "healthcheck",
  "import",
  "profile_or_schema_check",
  "qa_gate",
  "preprocess_or_filter",
  "describe_or_diagnostics",
  "baseline_estimate",
  "verifier",
  "report",
]

const DEFAULT_STAGE_EDGES = DEFAULT_STAGE_SEQUENCE.slice(0, -1).map((kind, index) => ({
  from: kind,
  to: DEFAULT_STAGE_SEQUENCE[index + 1],
}))

const ANALYSIS_CHECKLIST_TEMPLATE = [
  { id: "data_readiness" },
  { id: "identification" },
  { id: "baseline_model" },
  { id: "diagnostics" },
  { id: "reporting" },
] as const satisfies ReadonlyArray<Pick<AnalysisChecklistItem, "id">>

const AUTO_VERIFY_STAGES = new Set<WorkflowStageKind>([
  "import",
  "qa_gate",
  "preprocess_or_filter",
  "baseline_estimate",
])

const WORKFLOW_ARTIFACT_EXTENSIONS = new Set([
  ".csv",
  ".docx",
  ".dta",
  ".json",
  ".log",
  ".md",
  ".parquet",
  ".tex",
  ".txt",
  ".xls",
  ".xlsx",
])

const VERIFIER_READABLE_ARTIFACT_EXTENSIONS = new Set([".csv", ".json", ".log", ".md", ".tex", ".txt"])

const NON_ARTIFACT_PATH_KEYS = [
  "install_command",
  "installcommand",
  "python_command",
  "pythoncommand",
  "python_executable",
  "pythonexecutable",
  "resolved_python_executable",
  "resolvedpythonexecutable",
  "interpreter",
  "executable",
]

const NON_ARTIFACT_EXTENSIONS = new Set([
  ".bat",
  ".bin",
  ".cmd",
  ".dll",
  ".exe",
  ".msi",
  ".node",
  ".pyc",
  ".so",
  ".wasm",
])

const STAGE_DEPENDENCIES: Record<WorkflowStageKind, WorkflowStageKind[]> = {
  healthcheck: [],
  import: ["healthcheck"],
  profile_or_schema_check: ["import"],
  qa_gate: ["profile_or_schema_check"],
  preprocess_or_filter: ["qa_gate"],
  describe_or_diagnostics: ["preprocess_or_filter"],
  baseline_estimate: ["describe_or_diagnostics"],
  verifier: ["baseline_estimate"],
  report: ["verifier"],
}

const INPUT_INTENT_TOOL_BUNDLES = {
  status: ["workflow", "read", "glob", "grep", "skill"],
  verify: ["workflow", "read", "glob", "grep", "regression_table", "skill"],
  repair: ["workflow", "read", "glob", "grep", "skill", "data_import", "data_batch", "econometrics", "regression_table"],
  report: ["workflow", "read", "research_brief", "paper_draft", "slide_generator", "regression_table"],
  analysis: ["workflow", "read", "glob", "grep", "skill", "data_import", "data_batch", "econometrics", "regression_table"],
} as const

const WORKFLOW_EXECUTION_POLICY = {
  autoVerifyStages: [...AUTO_VERIFY_STAGES],
  freshVerifierAgent: "verifier",
  repairOnlyBundles: {
    healthcheck: ["workflow", "read", "glob", "grep", "skill", "data_import", "data_batch"],
    import: ["workflow", "read", "glob", "grep", "skill", "data_import", "data_batch"],
    profile_or_schema_check: ["workflow", "read", "glob", "grep", "skill", "data_import", "data_batch"],
    qa_gate: ["workflow", "read", "glob", "grep", "skill", "data_import", "data_batch"],
    preprocess_or_filter: ["workflow", "read", "glob", "grep", "skill", "data_import", "data_batch"],
    describe_or_diagnostics: ["workflow", "read", "glob", "grep", "skill", "data_import", "data_batch"],
    baseline_estimate: ["workflow", "read", "glob", "grep", "skill", "data_import", "data_batch", "econometrics", "regression_table"],
    verifier: ["workflow", "read", "glob", "grep", "skill", "regression_table"],
    report: ["workflow", "read", "glob", "grep", "skill"],
  },
} as const

function nowIso() {
  return new Date().toISOString()
}

function stableHash(value: string) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 10)
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
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

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

async function latestNonSyntheticUserText(sessionID: string) {
  for await (const message of MessageV2.stream(sessionID)) {
    if (message.info.role !== "user") continue
    const text = message.parts
      .filter(
        (part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored,
      )
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

function latestStageByKinds(run: WorkflowRun | undefined, kinds: WorkflowStageKind[]) {
  if (!run) return undefined
  const wanted = new Set(kinds)
  return [...run.stages].reverse().find((stage) => wanted.has(stage.kind))
}

function latestStageForChecklist(
  run: WorkflowRun | undefined,
  itemID: AnalysisChecklistItem["id"],
): StageNode | undefined {
  switch (itemID) {
    case "data_readiness":
      return latestStageByKinds(run, [
        "healthcheck",
        "import",
        "profile_or_schema_check",
        "qa_gate",
        "preprocess_or_filter",
        "describe_or_diagnostics",
      ])
    case "identification":
      return latestStageByKinds(run, ["baseline_estimate", "verifier", "report"])
    case "baseline_model":
      return latestStageByKinds(run, ["baseline_estimate", "verifier", "report"])
    case "diagnostics":
      return latestStageByKinds(run, ["verifier", "report"])
    case "reporting":
      return latestStageByKinds(run, ["report"])
  }
}

function checklistStatusForDataReadiness(run: WorkflowRun): AnalysisChecklistItem["status"] {
  const prepStages = run.stages.filter((stage) =>
    [
      "healthcheck",
      "import",
      "profile_or_schema_check",
      "qa_gate",
      "preprocess_or_filter",
      "describe_or_diagnostics",
    ].includes(stage.kind),
  )
  if (prepStages.some((stage) => stage.status === "blocked" || stage.status === "failed")) return "blocked"
  if (
    prepStages.some((stage) => stage.kind === "describe_or_diagnostics" && stage.status === "completed") ||
    run.stages.some((stage) => ["baseline_estimate", "verifier", "report"].includes(stage.kind))
  ) {
    return "completed"
  }
  if (
    prepStages.some((stage) => stage.status === "completed" || stage.status === "running") ||
    [
      "healthcheck",
      "import",
      "profile_or_schema_check",
      "qa_gate",
      "preprocess_or_filter",
      "describe_or_diagnostics",
    ].includes(run.activeStage ?? "")
  ) {
    return "in_progress"
  }
  return "pending"
}

function checklistSummary(run: WorkflowRun, itemID: AnalysisChecklistItem["id"]) {
  const locale = run.workflowLocale
  const stage = latestStageForChecklist(run, itemID)
  if (itemID === "data_readiness") {
    if (run.datasetId && stage?.stageId) {
      return locale === "zh-CN" ? `复用 ${run.datasetId} / ${stage.stageId}` : `Reusing ${run.datasetId} / ${stage.stageId}`
    }
    if (run.datasetId) return locale === "zh-CN" ? `当前数据集：${run.datasetId}` : `Current dataset: ${run.datasetId}`
    return stage
      ? locale === "zh-CN"
        ? `最近准备阶段：${stage.stageId}`
        : `Latest prep stage: ${stage.stageId}`
      : locale === "zh-CN"
        ? "等待导入与 QA"
        : "Waiting for import and QA"
  }
  if (itemID === "identification") {
    const baselineStage = latestStageByKinds(run, ["baseline_estimate"])
    if (baselineStage?.replayInput) {
      const dependentVar = typeof baselineStage.replayInput["dependentVar"] === "string"
        ? baselineStage.replayInput["dependentVar"]
        : undefined
      const treatmentVar = typeof baselineStage.replayInput["treatmentVar"] === "string"
        ? baselineStage.replayInput["treatmentVar"]
        : undefined
      if (dependentVar || treatmentVar) {
        return [dependentVar ? `Y=${dependentVar}` : undefined, treatmentVar ? `T=${treatmentVar}` : undefined]
          .filter(Boolean)
          .join(", ")
      }
    }
    return run.approvalStatus === "required"
      ? locale === "zh-CN"
        ? "等待执行审批"
        : "Waiting for execution approval"
      : locale === "zh-CN"
        ? "需要明确核心变量与识别策略"
        : "Need core variables and identification strategy"
  }
  if (itemID === "baseline_model") {
    return stage
      ? `${stage.stageId} (${workflowChecklistStatusLabel(locale, stage.status === "running" ? "in_progress" : stage.status === "completed" ? "completed" : stage.status === "blocked" || stage.status === "failed" ? "blocked" : "pending")})`
      : locale === "zh-CN"
        ? "基准模型尚未运行"
        : "Baseline model has not run yet"
  }
  if (itemID === "diagnostics") {
    if (run.latestVerifier?.status) {
      return locale === "zh-CN"
        ? `核验器=${workflowLocaleLabel(locale, {
            en: run.latestVerifier.status,
            zh:
              run.latestVerifier.status === "pass"
                ? "通过"
                : run.latestVerifier.status === "warn"
                  ? "警告"
                  : "阻塞",
          })}`
        : `verifier=${run.latestVerifier.status}`
    }
    return stage
      ? `${stage.stageId} (${workflowChecklistStatusLabel(locale, stage.status === "running" ? "in_progress" : stage.status === "completed" ? "completed" : stage.status === "blocked" || stage.status === "failed" ? "blocked" : "pending")})`
      : locale === "zh-CN"
        ? "诊断与稳健性检查尚未运行"
        : "Diagnostics and robustness checks have not run yet"
  }
  return stage
    ? `${stage.stageId} (${workflowChecklistStatusLabel(locale, stage.status === "running" ? "in_progress" : stage.status === "completed" ? "completed" : stage.status === "blocked" || stage.status === "failed" ? "blocked" : "pending")})`
    : locale === "zh-CN"
      ? "带依据的结果报告尚未生成"
      : "Grounded report has not been generated yet"
}

function workflowChecklistSummary(run: WorkflowRun, itemID: AnalysisChecklistItem["id"]) {
  const locale = run.workflowLocale
  const stage = latestStageForChecklist(run, itemID)
  if (itemID === "data_readiness") {
    if (run.datasetId && stage?.stageId) {
      return locale === "zh-CN" ? `复用 ${run.datasetId} / ${stage.stageId}` : `Reusing ${run.datasetId} / ${stage.stageId}`
    }
    if (run.datasetId) return locale === "zh-CN" ? `当前数据集：${run.datasetId}` : `Current dataset: ${run.datasetId}`
    return stage
      ? locale === "zh-CN"
        ? `最近准备阶段：${stage.stageId}`
        : `Latest prep stage: ${stage.stageId}`
      : locale === "zh-CN"
        ? "等待导入与 QA"
        : "Waiting for import and QA"
  }
  if (itemID === "identification") {
    const baselineStage = latestStageByKinds(run, ["baseline_estimate"])
    if (baselineStage?.replayInput) {
      const dependentVar =
        typeof baselineStage.replayInput["dependentVar"] === "string"
          ? baselineStage.replayInput["dependentVar"]
          : undefined
      const treatmentVar =
        typeof baselineStage.replayInput["treatmentVar"] === "string"
          ? baselineStage.replayInput["treatmentVar"]
          : undefined
      if (dependentVar || treatmentVar) {
        return [dependentVar ? `Y=${dependentVar}` : undefined, treatmentVar ? `T=${treatmentVar}` : undefined]
          .filter(Boolean)
          .join(", ")
      }
    }
    return run.approvalStatus === "required"
      ? locale === "zh-CN"
        ? "等待执行审批"
        : "Waiting for execution approval"
      : locale === "zh-CN"
        ? "需要明确核心变量与识别策略"
        : "Need core variables and identification strategy"
  }
  if (itemID === "baseline_model") {
    return stage
      ? `${stage.stageId} (${workflowChecklistStatusLabel(
          locale,
          stage.status === "running"
            ? "in_progress"
            : stage.status === "completed"
              ? "completed"
              : stage.status === "blocked" || stage.status === "failed"
                ? "blocked"
                : "pending",
        )})`
      : locale === "zh-CN"
        ? "基准模型尚未运行"
        : "Baseline model has not run yet"
  }
  if (itemID === "diagnostics") {
    if (run.latestVerifier?.status) {
      return locale === "zh-CN"
        ? `校验器=${workflowLocaleLabel(locale, {
            en: run.latestVerifier.status,
            zh:
              run.latestVerifier.status === "pass"
                ? "通过"
                : run.latestVerifier.status === "warn"
                  ? "警告"
                  : "阻塞",
          })}`
        : `verifier=${run.latestVerifier.status}`
    }
    return stage
      ? `${stage.stageId} (${workflowChecklistStatusLabel(
          locale,
          stage.status === "running"
            ? "in_progress"
            : stage.status === "completed"
              ? "completed"
              : stage.status === "blocked" || stage.status === "failed"
                ? "blocked"
                : "pending",
        )})`
      : locale === "zh-CN"
        ? "诊断与稳健性检查尚未运行"
        : "Diagnostics and robustness checks have not run yet"
  }
  return stage
    ? `${stage.stageId} (${workflowChecklistStatusLabel(
        locale,
        stage.status === "running"
          ? "in_progress"
          : stage.status === "completed"
            ? "completed"
            : stage.status === "blocked" || stage.status === "failed"
              ? "blocked"
              : "pending",
      )})`
    : locale === "zh-CN"
      ? "带依据的结果报告尚未生成"
      : "Grounded report has not been generated yet"
}

function refreshAnalysisChecklist(run: WorkflowRun) {
  const dataReadiness = checklistStatusForDataReadiness(run)
  const baselineStage = latestStageByKinds(run, ["baseline_estimate"])
  const verifierStage = latestStageByKinds(run, ["verifier"])
  const reportStage = latestStageByKinds(run, ["report"])

  const identificationStatus: AnalysisChecklistItem["status"] =
    dataReadiness === "blocked"
      ? "blocked"
      : reportStage || verifierStage || baselineStage
        ? "completed"
        : run.planGeneratedAt
          ? "in_progress"
          : "pending"

  const baselineStatus: AnalysisChecklistItem["status"] =
    baselineStage?.status === "blocked" || baselineStage?.status === "failed"
      ? "blocked"
      : reportStage || verifierStage || (baselineStage && baselineStage.status === "completed")
        ? "completed"
        : run.activeStage === "baseline_estimate"
          ? "in_progress"
          : "pending"

  const diagnosticsStatus: AnalysisChecklistItem["status"] =
    run.latestVerifier?.status === "block" || verifierStage?.status === "blocked" || verifierStage?.status === "failed"
      ? "blocked"
      : reportStage || run.latestVerifier?.status === "pass" || run.latestVerifier?.status === "warn"
        ? "completed"
        : run.activeStage === "verifier"
          ? "in_progress"
          : "pending"

  const reportingStatus: AnalysisChecklistItem["status"] =
    reportStage?.status === "blocked" || reportStage?.status === "failed"
      ? "blocked"
      : reportStage?.status === "completed"
        ? "completed"
        : run.activeStage === "report"
          ? "in_progress"
          : "pending"

  const statusMap: Record<AnalysisChecklistItem["id"], AnalysisChecklistItem["status"]> = {
    data_readiness: dataReadiness,
    identification: identificationStatus,
    baseline_model: baselineStatus,
    diagnostics: diagnosticsStatus,
    reporting: reportingStatus,
  }

  run.analysisChecklist = ANALYSIS_CHECKLIST_TEMPLATE.map((item) => {
    const linkedStage = latestStageForChecklist(run, item.id)
    return {
      id: item.id,
      label: workflowChecklistLabel(run.workflowLocale, item.id),
      status: statusMap[item.id],
      linkedStageId: linkedStage?.stageId,
      summary: workflowChecklistSummary(run, item.id),
    }
  })
}

function currentChecklistItem(run?: WorkflowRun) {
  if (!run) return undefined
  return (
    run.analysisChecklist.find((item) => item.status === "blocked") ??
    run.analysisChecklist.find((item) => item.status === "in_progress") ??
    run.analysisChecklist.find((item) => item.status === "pending")
  )
}

function refreshWorkflowRunDerivedState(run: WorkflowRun) {
  refreshWorkflowRunGraph(run)
  refreshAnalysisChecklist(run)
  return run
}

function workflowRoot() {
  return path.join(projectStateRoot(), "workflows")
}

function workflowSessionPath(sessionID: string) {
  return path.join(workflowRoot(), `${sessionID}.json`)
}

function ensureWorkflowRoot() {
  fs.mkdirSync(workflowRoot(), { recursive: true })
}

function emptySessionState(sessionID: string): WorkflowSessionState {
  return {
    version: 1,
    sessionID,
    runs: [],
  }
}

export function readWorkflowSession(sessionID: string): WorkflowSessionState {
  ensureWorkflowRoot()
  const filePath = workflowSessionPath(sessionID)
  if (!fs.existsSync(filePath)) return emptySessionState(sessionID)
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<WorkflowSessionState>
  const state: WorkflowSessionState = {
    version: 1,
    sessionID,
    activeRunId: parsed.activeRunId,
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
  }
  state.runs.forEach((run) => refreshWorkflowRunDerivedState(run))
  return state
}

export function writeWorkflowSession(state: WorkflowSessionState) {
  ensureWorkflowRoot()
  fs.writeFileSync(workflowSessionPath(state.sessionID), JSON.stringify(state, null, 2), "utf-8")
}

function createWorkflowRunId(input: { sessionID: string; datasetId?: string; runId?: string; branch: string }) {
  const seed = [input.sessionID, input.datasetId ?? "session", input.runId ?? "run", input.branch].join("::")
  return `workflow_${stableHash(seed)}`
}

function emptyRun(input: { sessionID: string; datasetId?: string; runId?: string; branch: string }): WorkflowRun {
  const createdAt = nowIso()
  return {
    workflowRunId: createWorkflowRunId(input),
    sessionID: input.sessionID,
    workflowMode: "econometrics",
    workflowLocale: "en",
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
      label: workflowChecklistLabel("en", item.id),
      status: item.id === "data_readiness" ? "in_progress" : "pending",
    })),
    createdAt,
    updatedAt: createdAt,
  }
}

function ensureRun(
  sessionState: WorkflowSessionState,
  input: { datasetId?: string; runId?: string; branch?: string },
): WorkflowRun {
  const branch = input.branch ?? "main"
  const existing =
    sessionState.runs.find(
      (run) =>
        run.branch === branch &&
        (input.datasetId ? run.datasetId === input.datasetId : true) &&
        (input.runId ? run.runId === input.runId : true),
    ) ??
    (sessionState.activeRunId
      ? sessionState.runs.find((run) => run.workflowRunId === sessionState.activeRunId)
      : undefined)

  if (existing) {
    existing.datasetId = input.datasetId ?? existing.datasetId
    existing.runId = input.runId ?? existing.runId
    existing.branch = branch
    existing.workflowLocale = existing.workflowLocale ?? "en"
    existing.updatedAt = nowIso()
    sessionState.activeRunId = existing.workflowRunId
    return existing
  }

  const run = emptyRun({
    sessionID: sessionState.sessionID,
    datasetId: input.datasetId,
    runId: input.runId,
    branch,
  })
  sessionState.runs.push(run)
  sessionState.activeRunId = run.workflowRunId
  return run
}

function findStage(run: WorkflowRun, stageId: string, branch: string) {
  return run.stages.find((stage) => stage.stageId === stageId && stage.branch === branch)
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

function upsertStage(run: WorkflowRun, stage: StageNode) {
  const existing = findStage(run, stage.stageId, stage.branch)
  if (existing) {
    Object.assign(existing, stage, { createdAt: existing.createdAt, updatedAt: nowIso() })
    refreshBranchDownstream(run, stage.branch)
    return existing
  }
  run.stages.push(stage)
  refreshBranchDownstream(run, stage.branch)
  return stage
}

function normalizeArtifactCandidate(value: string) {
  const trimmed = value.trim().replace(/^file:\/\//i, "")
  if (!trimmed) return undefined
  if (/[\r\n]/.test(trimmed)) return undefined
  return trimmed
}

function hasCommandSyntax(value: string) {
  return /\s-(?:m|c|I|u)\b/i.test(value) || /\s+(?:pip|conda|uv|bun|npm|pnpm|yarn)\s+/i.test(value)
}

function artifactKeyIsRuntimeOnly(key?: string) {
  const normalized = key?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? ""
  if (!normalized) return false
  return NON_ARTIFACT_PATH_KEYS.some((item) => normalized.includes(item.replace(/[^a-z0-9]/gi, "")))
}

function existingPathIsDirectory(value: string) {
  try {
    return fs.existsSync(value) && fs.statSync(value).isDirectory()
  } catch {
    return false
  }
}

export function isWorkflowArtifactRef(value: string, key?: string) {
  const candidate = normalizeArtifactCandidate(value)
  if (!candidate) return false

  const normalized = candidate.replace(/\\/g, "/").toLowerCase()
  const ext = path.extname(candidate).toLowerCase()
  const nestedKey = key?.toLowerCase() ?? ""

  if (artifactKeyIsRuntimeOnly(key)) return false
  if (nestedKey.includes("reflection")) return false
  if (normalized.includes("/.killstata/runtime/health/")) return false
  if (normalized.includes("/inspection/") && /\.(xlsx|xls|csv)$/i.test(candidate)) return false
  if (hasCommandSyntax(candidate)) return false
  if (NON_ARTIFACT_EXTENSIONS.has(ext)) return false
  if (!WORKFLOW_ARTIFACT_EXTENSIONS.has(ext)) return false
  if (existingPathIsDirectory(candidate)) return false
  return true
}

export function isVerifierReadableArtifactRef(value: string) {
  const candidate = normalizeArtifactCandidate(value)
  if (!candidate) return false
  const ext = path.extname(candidate).toLowerCase()
  if (!VERIFIER_READABLE_ARTIFACT_EXTENSIONS.has(ext)) return false
  if (existingPathIsDirectory(candidate)) return false
  return fs.existsSync(candidate)
}

export function filterVerifierReadableArtifactRefs(values: string[]) {
  return [...new Set(values.filter(isVerifierReadableArtifactRef))]
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

export function sanitizeVerifierPromptMetadata(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (artifactKeyIsRuntimeOnly(key)) return undefined
    if (hasCommandSyntax(value)) return undefined
    if (value.replace(/\\/g, "/").toLowerCase().includes("/.killstata/runtime/health/")) return undefined
    if (isWorkflowArtifactRef(value, key) || isVerifierReadableArtifactRef(value))
      return normalizeArtifactCandidate(value)
    const ext = path.extname(value).toLowerCase()
    if (NON_ARTIFACT_EXTENSIONS.has(ext)) return undefined
    return value
  }
  if (Array.isArray(value)) {
    const filtered = value.map((item) => sanitizeVerifierPromptMetadata(item, key)).filter((item) => item !== undefined)
    return filtered
  }
  if (!value || typeof value !== "object") return value

  const result: Record<string, unknown> = {}
  for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (artifactKeyIsRuntimeOnly(nestedKey) || nestedKey === "reflection") continue
    const sanitized = sanitizeVerifierPromptMetadata(nestedValue, nestedKey)
    if (sanitized !== undefined) result[nestedKey] = sanitized
  }
  return result
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

function downstreamKinds(kind: WorkflowStageKind) {
  const index = DEFAULT_STAGE_SEQUENCE.indexOf(kind)
  return index === -1 ? [] : DEFAULT_STAGE_SEQUENCE.slice(index + 1)
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

function computeKindDownstream(run: WorkflowRun, branch: string, kind: WorkflowStageKind) {
  const downstream = new Set<string>()
  for (const stageKind of downstreamKinds(kind)) {
    for (const stage of run.stages) {
      if (stage.branch === branch && stage.kind === stageKind) downstream.add(stage.stageId)
    }
  }
  return [...downstream]
}

function branchHasDependencyGraph(run: WorkflowRun, branch: string) {
  return run.stages.some(
    (stage) => stage.branch === branch && ((stage.dependsOn?.length ?? 0) > 0 || typeof stage.parentStageId === "string"),
  )
}

function collectDependentStageIds(run: WorkflowRun, target: StageNode) {
  if (!branchHasDependencyGraph(run, target.branch)) {
    return computeKindDownstream(run, target.branch, target.kind)
  }

  const visited = new Set<string>([target.stageId])
  const ordered: string[] = []
  const queue = [target.stageId]

  while (queue.length > 0) {
    const currentStageId = queue.shift()!
    const dependents = run.stages
      .filter((stage) => {
        if (stage.branch !== target.branch) return false
        if (visited.has(stage.stageId)) return false
        if (stage.parentStageId === currentStageId) return true
        return (stage.dependsOn ?? []).includes(currentStageId)
      })
      .sort((left, right) => {
        const leftIndex = DEFAULT_STAGE_SEQUENCE.indexOf(left.kind)
        const rightIndex = DEFAULT_STAGE_SEQUENCE.indexOf(right.kind)
        return leftIndex - rightIndex || left.createdAt.localeCompare(right.createdAt)
      })

    for (const stage of dependents) {
      visited.add(stage.stageId)
      ordered.push(stage.stageId)
      queue.push(stage.stageId)
    }
  }

  return ordered
}

function refreshBranchDownstream(run: WorkflowRun, branch: string) {
  run.stages
    .filter((stage) => stage.branch === branch)
    .forEach((stage) => {
      stage.downstream = collectDependentStageIds(run, stage)
    })
}

function refreshWorkflowRunGraph(run: WorkflowRun) {
  const branches = [...new Set(run.stages.map((stage) => stage.branch))]
  branches.forEach((branch) => refreshBranchDownstream(run, branch))
  return run
}

function stageNeedsVerifier(kind: WorkflowStageKind) {
  return AUTO_VERIFY_STAGES.has(kind)
}

function publishWorkflowState(sessionID: string, run?: WorkflowRun, rerunTargetStageId?: string) {
  const workflow = run ? refreshWorkflowRunDerivedState(run) : getActiveWorkflowRun(sessionID)
  const activeStage = workflow?.activeNodeId
    ? workflow.stages.find((stage) => stage.nodeId === workflow.activeNodeId)
    : activeOrLatestStage(workflow)
  const checklistItem = currentChecklistItem(workflow)
  Bus.publish(RuntimeEvents.WorkflowState, {
    sessionID,
    workflowRunId: workflow?.workflowRunId,
    workflowLocale: workflow?.workflowLocale,
    branch: workflow?.branch,
    activeStage: workflow?.activeStage,
    activeStageId: activeStage?.stageId,
    activeCoordinatorAgent: workflow?.activeCoordinatorAgent,
    repairOnly: workflow?.repairOnly ?? false,
    latestFailureCode: workflow?.latestFailure?.code,
    verifierStatus: workflow?.latestVerifier?.status,
    trustedArtifacts: workflow?.trustedArtifacts ?? [],
    rerunTargetStageId,
    approvalStatus: workflow?.approvalStatus,
    currentChecklistItem: checklistItem
      ? {
          id: checklistItem.id,
          label: checklistItem.label,
          status: checklistItem.status,
        }
      : undefined,
    analysisChecklist: workflow?.analysisChecklist ?? [],
  })
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

function verifierPrompt(input: { stage: StageNode; workflow: WorkflowRun }) {
  const prompt = {
    workflowRunId: input.workflow.workflowRunId,
    stageId: input.stage.stageId,
    stageKind: input.stage.kind,
    branch: input.stage.branch,
    replayInput: input.stage.replayInput ?? {},
    artifactRefs: input.stage.artifactRefs,
    readableArtifactRefs: filterVerifierReadableArtifactRefs(
      input.stage.readableArtifactRefs ?? input.stage.artifactRefs,
    ),
    latestTrustedArtifacts: input.workflow.trustedArtifacts,
    metadata: sanitizeVerifierPromptMetadata(input.stage.metadata ?? {}),
    instruction:
      "Audit this workflow stage. Read only readableArtifactRefs directly; use datasetId/stageId or structured tool outputs for binary artifacts. Return only a JSON object inside <verifier_result> tags with keys status, checks, blockingFindings, repairHints, trustedArtifacts, summary, findings.",
  }
  return [
    "You are a fresh-run verifier for killstata.",
    "Do not execute mutating tools. Validate only the provided stage and artifacts.",
    JSON.stringify(prompt, null, 2),
  ].join("\n\n")
}

async function runFreshVerifierTask(input: {
  sessionID: string
  messageID?: string
  stage: StageNode
  workflow: WorkflowRun
  model?: { providerID: string; modelID: string }
}) {
  const [{ Session }, { SessionPrompt }, { Agent }] = await Promise.all([
    import("@/session"),
    import("@/session/prompt"),
    import("@/agent/agent"),
  ])
  const verifier = await Agent.get(WORKFLOW_EXECUTION_POLICY.freshVerifierAgent)
  if (!verifier) return undefined
  const effectiveModel = verifier.model ?? (await inferSessionModel(input.sessionID, input.model))
  const session = await Session.create({
    parentID: input.sessionID,
    title: `Workflow verifier - ${input.stage.stageId}`,
    permission: [
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "todoread", pattern: "*", action: "deny" },
    ],
  })
  const parts = [
    {
      type: "text" as const,
      text: verifierPrompt(input),
    },
    ...filterVerifierReadableArtifactRefs(input.stage.readableArtifactRefs ?? input.stage.artifactRefs)
      .slice(0, 8)
      .map((artifact) => ({
        type: "file" as const,
        url: `file://${artifact}`,
        filename: path.basename(artifact),
        mime: "text/plain",
      })),
  ]
  const result = await SessionPrompt.prompt({
    sessionID: session.id,
    messageID: input.messageID,
    model: effectiveModel,
    agent: verifier.name,
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
  const text = result.parts.findLast((part) => part.type === "text")?.text ?? ""
  const parsed = extractTaggedJson<VerifierTaskEnvelope>(text, "verifier_result")
  if (parsed) {
    return {
      ...parsed,
      sessionID: session.id,
      agent: "verifier" as const,
      mode: "fresh-run" as const,
      createdAt: parsed.createdAt ?? nowIso(),
    }
  }
  return {
    status: "warn" as const,
    checks: [],
    blockingFindings: [],
    repairHints: [
      "Verifier fallback: runtime report will be used because the fresh-run verifier output was not parseable.",
    ],
    trustedArtifacts: filterVerifierReadableArtifactRefs(input.stage.readableArtifactRefs ?? input.stage.artifactRefs),
    summary: text,
    findings: text ? [text] : [],
    sessionID: session.id,
    agent: "verifier" as const,
    mode: "fresh-run" as const,
    createdAt: nowIso(),
  }
}

function mergeVerifierEnvelope(report: VerifierReport, envelope?: VerifierTaskEnvelope): VerifierReport {
  if (!envelope) return report
  const checks = envelope.checks.length > 0 ? envelope.checks : report.checks
  const blockingFindings = envelope.blockingFindings.length > 0 ? envelope.blockingFindings : report.blockingFindings
  const envelopeTrustedArtifacts = filterVerifierReadableArtifactRefs(envelope.trustedArtifacts)
  return {
    status: envelope.status ?? report.status,
    checks,
    blockingFindings,
    repairHints: envelope.repairHints.length > 0 ? envelope.repairHints : report.repairHints,
    trustedArtifacts: envelopeTrustedArtifacts.length > 0 ? envelopeTrustedArtifacts : report.trustedArtifacts,
    createdAt: report.createdAt,
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
    if (action === "qa") return "qa_gate"
    if (action === "preprocess" || action === "filter" || action === "rollback") return "preprocess_or_filter"
    if (action === "describe" || action === "correlation") return "describe_or_diagnostics"
    if (action === "export") return "report"
    return "profile_or_schema_check"
  }

  if (toolName === "econometrics") return "baseline_estimate"
  return "report"
}

function nextStage(kind: WorkflowStageKind) {
  const index = DEFAULT_STAGE_SEQUENCE.indexOf(kind)
  return index >= 0 ? DEFAULT_STAGE_SEQUENCE[index + 1] : undefined
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
    case "qa_gate_blocked":
      return "QA_BLOCKED"
    case "schema_mismatch":
    case "tool_contract_failure":
    case "planning_failure":
      return "MODEL_SPEC_INVALID"
    case "estimation_failure":
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
    autoRepairAllowed: !["QA_BLOCKED", "MODEL_SPEC_INVALID"].includes(code),
    requiresVerifier: !["FILE_NOT_FOUND", "STAGE_NOT_RESOLVED", "DEPENDENCY_MISSING"].includes(code),
    maxRetries: 3,
    reflectionPath: reflection.reflectionPath,
    createdAt: reflection.createdAt,
  }
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
      repairAction: "Run profile/schema check first, resolve exact column names, then retry only the failed stage.",
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
    retryStage: "qa_gate",
    repairAction:
      "Deduplicate or aggregate the entity-time keys, rerun QA, then rerun the failed estimation stage only.",
    autoApply: true,
    requiresVerifier: true,
    repairMetadata: {
      strategy: ["dedup", "aggregate"],
      blocksEstimate: true,
    },
  }),
  DEPENDENCY_MISSING: () => ({
    retryStage: "healthcheck",
    repairAction: "Run doctor/healthcheck, install or point to the missing dependency, then retry the blocked stage.",
    autoApply: true,
    requiresVerifier: false,
    repairMetadata: {
      nextCommand: "/doctor",
      installHint: true,
    },
  }),
  QA_BLOCKED: ({ stage }) => ({
    retryStage: stage?.kind === "preprocess_or_filter" ? "preprocess_or_filter" : "qa_gate",
    repairAction: "Repair the QA blocker before continuing. Narrative/report stages must stay blocked until QA passes.",
    autoApply: false,
    requiresVerifier: true,
    repairMetadata: {
      blocksReport: true,
      repairOnly: true,
    },
  }),
  STAGE_NOT_RESOLVED: ({ workflow, stage }) => ({
    retryStage: "import",
    repairAction: "Resolve the latest dataset manifest and artifact lineage, then retry only the failed stage.",
    autoApply: true,
    requiresVerifier: false,
    repairMetadata: {
      datasetId: workflow?.datasetId ?? stage?.datasetId,
      latestTrustedArtifacts: workflow?.trustedArtifacts ?? [],
    },
  }),
  ARTIFACT_MISSING: ({ workflow, stage }) => ({
    retryStage: stage?.kind === "baseline_estimate" ? "describe_or_diagnostics" : "import",
    repairAction: "Regenerate the missing artifacts from the latest manifest lineage before continuing.",
    autoApply: true,
    requiresVerifier: true,
    repairMetadata: {
      latestTrustedArtifacts: workflow?.trustedArtifacts ?? [],
      targetStageId: stage?.stageId,
    },
  }),
}

function applyRepairHandler(input: { failure: StageFailureRecord; stage?: StageNode; workflow?: WorkflowRun }) {
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

function activeOrLatestStage(run?: WorkflowRun) {
  if (!run) return undefined
  if (run.activeNodeId) {
    const active = run.stages.find((stage) => stage.nodeId === run.activeNodeId)
    if (active) return active
  }
  return [...run.stages].reverse().find((stage) => stage.kind !== "verifier")
}

function requestedStage(run: WorkflowRun | undefined, stageId?: string) {
  if (!run || !stageId) return undefined
  return run.stages.find((stage) => stage.stageId === stageId || stage.nodeId === stageId)
}

function missingRequestedStageReason(stageId: string, action: string) {
  return `Requested stage ${stageId} was not found in the active workflow run for ${action}.`
}

export function getActiveWorkflowRun(sessionID: string) {
  const session = readWorkflowSession(sessionID)
  if (!session.activeRunId) return session.runs.at(-1)
  return session.runs.find((run) => run.workflowRunId === session.activeRunId) ?? session.runs.at(-1)
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
          zh:
            run.latestVerifier.status === "pass"
              ? "通过"
              : run.latestVerifier.status === "warn"
                ? "警告"
                : "阻塞",
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
      (item) => `- ${item.label}: ${workflowChecklistStatusLabel(locale, item.status)}${item.summary ? ` (${item.summary})` : ""}`,
    ),
    run.approvalStatus
      ? `- ${workflowApprovalTitle(locale).toLowerCase()}: ${workflowApprovalStatusLabel(locale, run.approvalStatus)}`
      : undefined,
  ].filter(Boolean)
  return [base.join("\n"), stagePolicy.join("\n"), verifierPolicy.join("\n"), memory.join("\n"), checklist.join("\n")].filter(
    (item) => item.trim().length > 0,
  )
}

export function recommendedSkillBundle(kind: WorkflowStageKind) {
  switch (kind) {
    case "healthcheck":
    case "import":
    case "profile_or_schema_check":
    case "qa_gate":
    case "preprocess_or_filter":
      return ["data-prep", "qa-repair"]
    case "describe_or_diagnostics":
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
  const branch =
    typeof metadata.branch === "string"
      ? metadata.branch
      : typeof input.args.branch === "string"
        ? input.args.branch
        : "main"
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
  const stageStatus: StageStatus =
    metadata.qaGateStatus === "block" ? "blocked" : metadata.qaGateStatus === "warn" ? "completed" : "completed"
  const artifacts = collectArtifactRefs(metadata)
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
    readableArtifactRefs: readableArtifacts,
    trustedArtifacts: stageNeedsVerifier(kind) ? [] : readableArtifacts,
    metadata,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  stage.failure = undefined
  stage.verifierReport = undefined
  run.activeNodeId = stage.nodeId
  run.activeStage = stageStatus === "blocked" ? kind : stageNeedsVerifier(kind) ? "verifier" : (nextStage(kind) ?? kind)
  run.repairOnly = stageStatus === "blocked"
  run.blockedStageId = stageStatus === "blocked" ? stage.stageId : undefined
  run.activeCoordinatorAgent = stageNeedsVerifier(kind) ? "verifier" : "general"
  run.updatedAt = nowIso()
  if (!stageNeedsVerifier(kind)) {
    run.trustedArtifacts = [...new Set([...run.trustedArtifacts, ...readableArtifacts])]
  }
  if (stageStatus !== "blocked") {
    run.latestFailure = undefined
  }
  refreshWorkflowRunDerivedState(run)
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
  const branch = typeof input.args.branch === "string" ? input.args.branch : "main"
  const run = ensureRun(sessionState, {
    datasetId: typeof input.args.datasetId === "string" ? input.args.datasetId : undefined,
    runId: typeof input.args.runId === "string" ? input.args.runId : undefined,
    branch,
  })
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
    status: failure.code === "QA_BLOCKED" ? "blocked" : "failed",
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
  refreshWorkflowRunDerivedState(run)
  writeWorkflowSession(sessionState)
  publishWorkflowState(input.sessionID, run)
  return { workflowRun: run, stage }
}

export function latestFailedStage(sessionID: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) return undefined
  return [...run.stages].reverse().find((stage) => stage.status === "failed" || stage.status === "blocked")
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

  const target =
    requestedStage(run, stageId) ??
    latestFailedStage(sessionID) ??
    activeOrLatestStage(run)

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

async function loadWorkflowExecutableTool(toolName: string) {
  switch (toolName) {
    case "data_import": {
      const { DataImportTool } = await import("@/tool/data-import")
      return DataImportTool
    }
    case "econometrics": {
      const { EconometricsTool } = await import("@/tool/econometrics")
      return EconometricsTool
    }
    case "regression_table": {
      const { RegressionTableTool } = await import("@/tool/regression-table")
      return RegressionTableTool
    }
    case "workflow": {
      const { WorkflowTool } = await import("@/tool/workflow")
      return WorkflowTool
    }
    default:
      return undefined
  }
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
    input.source.readableArtifactRefs ?? input.source.artifactRefs,
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
  const run =
    sessionState.runs.find((item) => item.workflowRunId === plan.workflowRun?.workflowRunId) ?? sessionState.runs.at(-1)
  if (!run) {
    return {
      ...plan,
      blocked: true,
      reason: "No active workflow run is available for rerun execution.",
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

  for (const stage of stageQueue) {
    const currentRun = getActiveWorkflowRun(input.sessionID)
    const currentStage =
      currentRun?.stages.find((item) => item.stageId === stage.stageId && item.branch === stage.branch) ?? stage
    const currentFailureCode = currentStage.failure?.code
    const coordinatorDecision = createCoordinatorDecision({
      agent:
        currentFailureCode === "STAGE_NOT_RESOLVED" || currentFailureCode === "ARTIFACT_MISSING"
          ? "explore"
          : "general",
      why:
        currentFailureCode === "STAGE_NOT_RESOLVED" || currentFailureCode === "ARTIFACT_MISSING"
          ? "Workflow rerun needs missing artifact or schema lineage resolved before replay."
          : "Workflow rerun needs the recorded stage replay to execute with the stored contract.",
      inputSlice: {
        stageId: currentStage.stageId,
        kind: currentStage.kind,
        toolName: currentStage.toolName,
        replayInput: currentStage.replayInput ?? {},
        repairContext: currentStage.failure?.repairMetadata ?? plan.repairContext ?? {},
      },
      expectedOutputContract:
        "Execute the recorded stage replay, preserve structured metadata, and return produced artifacts for verifier/audit use.",
      linkedStageId: currentStage.stageId,
    })

    const reusable = cacheSourceForStage(currentRun ?? run, currentStage)
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

    try {
      const executed = await executeWorkflowStageTool({
        stage: currentStage,
        ctx: input.ctx,
        coordinatorDecision,
      })
      if (executed.skipped) {
        if (currentStage.kind === "verifier") {
          verifier = await runVerifierGate({
            sessionID: input.sessionID,
            stageId: currentStage.parentStageId ?? plan.target.stageId,
            messageID: input.ctx.messageID,
            agent: input.ctx.agent,
            preferFreshRun: true,
          })
        }
        continue
      }

      const success = recordWorkflowStageSuccess({
        sessionID: input.sessionID,
        toolName: currentStage.toolName ?? plan.toolName ?? "workflow",
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
        verifier = await runVerifierGate({
          sessionID: input.sessionID,
          stageId: currentStage.stageId,
          messageID: input.ctx.messageID,
          agent: input.ctx.agent,
          preferFreshRun: true,
        })
        if (verifier.report.status === "block") break
      }
    } catch (error) {
      const { classifyToolFailure } = await import("@/tool/analysis-reflection")
      const reflection = classifyToolFailure({
        toolName: currentStage.toolName ?? plan.toolName ?? "workflow",
        error: error instanceof Error ? error.message : String(error),
        input: currentStage.replayInput ?? plan.replayInput ?? {},
        sessionId: input.sessionID,
      })
      const failureResult = recordWorkflowStageFailure({
        sessionID: input.sessionID,
        toolName: currentStage.toolName ?? plan.toolName ?? "workflow",
        args: currentStage.replayInput ?? plan.replayInput ?? {},
        reflection,
      })
      const failureSessionState = readWorkflowSession(input.sessionID)
      const failureRun =
        failureSessionState.runs.find((item) => item.workflowRunId === failureResult.workflowRun.workflowRunId) ??
        failureSessionState.runs.at(-1)
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
  const finalRun = finalState.runs.find((item) => item.workflowRunId === run.workflowRunId) ?? finalState.runs.at(-1)
  if (finalRun) {
    finalRun.lastRerunExecution = {
      targetStageId: plan.target.stageId,
      executedStageIds,
      reusedStageIds,
      reuseRecords,
      verifierStatus: verifier?.report.status,
      completedAt: nowIso(),
      status: verifier?.report.status === "block" ? "blocked" : "completed",
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
      status: verifier?.report.status === "block" ? "blocked" : "completed",
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

export function buildVerifierReport(input: { sessionID: string; stageId?: string }) {
  const sessionState = readWorkflowSession(input.sessionID)
  const run =
    (sessionState.activeRunId
      ? sessionState.runs.find((item) => item.workflowRunId === sessionState.activeRunId)
      : undefined) ?? sessionState.runs.at(-1)
  const requested = requestedStage(run, input.stageId)
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
  const trustedArtifacts = filterVerifierReadableArtifactRefs(stage.readableArtifactRefs ?? stage.artifactRefs)
  addCheck(checks, {
    key: "artifacts_present",
    label: "Artifacts present",
    status: trustedArtifacts.length > 0 ? "pass" : "block",
    message:
      trustedArtifacts.length > 0
        ? `Found ${trustedArtifacts.length} workflow artifact(s).`
        : "No saved artifacts were found for the current stage.",
    evidence: {
      artifactCount: trustedArtifacts.length,
    },
  })

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

  if (run.latestFailure && run.latestFailure.code !== "QA_BLOCKED" && stage.kind !== "verifier") {
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
          ? "Regenerate the missing artifacts before continuing to report generation."
          : undefined,
        checks.find((check) => check.key === "row_drop_audit" && check.status === "block")
          ? "Repair the data-preparation stage before rerunning the estimate."
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

  const verifierNodeId = `${stage.branch}:${stage.stageId}__verifier`
  upsertStage(run, {
    nodeId: verifierNodeId,
    stageId: `${stage.stageId}__verifier`,
    kind: "verifier",
    status: report.status === "block" ? "blocked" : "completed",
    branch: stage.branch,
    datasetId: stage.datasetId,
    runId: stage.runId,
    parentStageId: stage.stageId,
    parentNodeId: stage.nodeId,
    toolName: "workflow",
    replayInput: {
      action: "verify",
      stageId: stage.stageId,
    },
    artifactRefs: trustedArtifacts,
    readableArtifactRefs: trustedArtifacts,
    metadata: {
      targetStageId: stage.stageId,
    },
    verifierReport: report,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  stage.verifierReport = report
  stage.trustedArtifacts = report.status === "block" ? [] : trustedArtifacts
  run.latestVerifier = report
  run.activeNodeId = verifierNodeId
  run.activeStage = report.status === "block" ? stage.kind : (nextStage(stage.kind) ?? "report")
  run.repairOnly = report.status === "block"
  run.blockedStageId = report.status === "block" ? stage.stageId : undefined
  if (report.status === "block") {
    const artifactFailure = checks.some((check) => check.key === "artifacts_present" && check.status === "block")
    const feFailure = checks.some((check) => check.key === "fe_specification" && check.status === "block")
    const duplicateFailure = checks.some((check) => check.key === "panel_key_duplicates" && check.status === "block")
    const failure = applyRepairHandler({
      failure: stageFailure({
        code: artifactFailure ? "ARTIFACT_MISSING" : duplicateFailure ? "PANEL_KEY_DUPLICATED" : "MODEL_SPEC_INVALID",
        toolName: stage.toolName ?? "workflow",
        message: blockingFindings.join(" | "),
        retryStage: artifactFailure ? "import" : duplicateFailure ? "qa_gate" : stage.kind,
        repairAction: repairHints[0] ?? "Repair the failed stage before continuing.",
        autoRepairAllowed: !feFailure,
        requiresVerifier: true,
      }),
      stage,
      workflow: run,
    })
    stage.failure = failure
    run.latestFailure = failure
  } else {
    run.latestFailure = undefined
  }
  run.updatedAt = nowIso()
  run.trustedArtifacts =
    report.status === "block" ? run.trustedArtifacts : [...new Set([...run.trustedArtifacts, ...trustedArtifacts])]
  refreshWorkflowRunDerivedState(run)
  writeWorkflowSession(sessionState)
  publishWorkflowState(input.sessionID, run)
  const refreshedSession = readWorkflowSession(input.sessionID)
  const refreshedRun =
    refreshedSession.runs.find((item) => item.workflowRunId === run.workflowRunId) ?? refreshedSession.runs.at(-1)
  return { workflowRun: refreshedRun, stage: stage, report }
}

export async function runVerifierGate(input: {
  sessionID: string
  stageId?: string
  messageID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  preferFreshRun?: boolean
}) {
  const built = buildVerifierReport({
    sessionID: input.sessionID,
    stageId: input.stageId,
  })
  const workflowRun = built.workflowRun
  const stage = built.stage
  if (!workflowRun || !stage) return { ...built, envelope: undefined }

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

  let envelope: VerifierTaskEnvelope | undefined
  if (input.preferFreshRun !== false) {
    try {
      envelope = await runFreshVerifierTask({
        sessionID: input.sessionID,
        messageID: input.messageID,
        stage,
        workflow: workflowRun,
        model: input.model,
      })
    } catch {
      envelope = undefined
    }
  }

  const report = mergeVerifierEnvelope(built.report, envelope)
  if (envelope) {
    const sessionState = readWorkflowSession(input.sessionID)
    const run =
      sessionState.runs.find((item) => item.workflowRunId === workflowRun.workflowRunId) ?? sessionState.runs.at(-1)
    const targetStage = run?.stages.find((item) => item.stageId === stage.stageId && item.branch === stage.branch)
    if (run && targetStage) {
      targetStage.verifierReport = report
      targetStage.trustedArtifacts = report.status === "block" ? [] : report.trustedArtifacts
      targetStage.readableArtifactRefs = filterVerifierReadableArtifactRefs(
        targetStage.readableArtifactRefs ?? targetStage.artifactRefs,
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
      run.latestVerifier = report
      run.activeCoordinatorAgent = "verifier"
      run.repairOnly = report.status === "block"
      run.blockedStageId = report.status === "block" ? targetStage.stageId : undefined
      run.updatedAt = nowIso()
      refreshWorkflowRunDerivedState(run)
      writeWorkflowSession(sessionState)
      publishWorkflowState(input.sessionID, run)
    }
  }

  return {
    workflowRun: getActiveWorkflowRun(input.sessionID),
    stage: workflowStageDetails(input.sessionID, stage.stageId).stage,
    report,
    envelope,
    coordinatorDecision: decision,
  }
}

export async function runAutomaticVerifier(input: {
  sessionID: string
  stageId?: string
  messageID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
}) {
  const run = getActiveWorkflowRun(input.sessionID)
  if (input.stageId && !requestedStage(run, input.stageId)) return undefined
  const stage = requestedStage(run, input.stageId) ?? activeOrLatestStage(run)
  if (!stage || !stageNeedsVerifier(stage.kind)) return undefined
  return runVerifierGate({
    ...input,
    preferFreshRun: true,
  })
}

export function workflowStatusSummary(sessionID: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) {
    return {
      sessionID,
      workflow: null,
      activeStage: null,
      failedStage: null,
      currentChecklistItem: null,
    }
  }
  const activeStage =
    (run.activeNodeId ? run.stages.find((stage) => stage.nodeId === run.activeNodeId) : undefined) ??
    activeOrLatestStage(run)
  return {
    sessionID,
    workflow: run,
    activeStage,
    failedStage: latestFailedStage(sessionID),
    currentChecklistItem: currentChecklistItem(run) ?? null,
  }
}

export function workflowStageDetails(sessionID: string, stageId?: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) return { workflow: null, stage: null }
  if (stageId && !requestedStage(run, stageId)) {
    return { workflow: run, stage: null }
  }
  const stage =
    requestedStage(run, stageId) ??
    (run.activeNodeId ? run.stages.find((item) => item.nodeId === run.activeNodeId) : undefined) ??
    activeOrLatestStage(run)
  return { workflow: run, stage }
}

export function workflowArtifactList(sessionID: string, stageId?: string) {
  const { workflow, stage } = workflowStageDetails(sessionID, stageId)
  const artifacts = stage ? stage.artifactRefs : stageId ? [] : workflow?.trustedArtifacts ?? []
  return {
    workflow,
    stage,
    artifacts,
  }
}

export function workflowToolPolicy(input: ToolAvailabilityPolicy) {
  if (!input.sessionID) return input
  const run = getActiveWorkflowRun(input.sessionID)
  const activeNode = run?.activeNodeId ? run.stages.find((stage) => stage.nodeId === run.activeNodeId) : undefined
  const stage = activeNode ?? activeOrLatestStage(run)
  return {
    ...input,
    workflowMode: run?.workflowMode,
    currentStage: run?.activeStage ?? stage?.kind,
    currentStageStatus: stage?.status,
    approvalStatus: input.approvalStatus ?? run?.approvalStatus,
    repairOnly: input.repairOnly ?? run?.repairOnly ?? run?.latestVerifier?.status === "block",
  } satisfies ToolAvailabilityPolicy
}

export function resolveToolAvailability(input: {
  policy: ToolAvailabilityPolicy
  toolIDs: string[]
}): ToolAvailabilityResolution {
  const allowed = new Set(input.toolIDs)
  const stage = input.policy.currentStage
  const status = input.policy.currentStageStatus
  const agent = input.policy.agent
  const inputIntent = input.policy.inputIntent
  const repairOnly = input.policy.repairOnly === true
  const approvalStatus = input.policy.approvalStatus

  const readCore = [
    "invalid",
    "question",
    "read",
    "list",
    "glob",
    "grep",
    "skill",
    "workflow",
    "webfetch",
    "websearch",
    "codesearch",
    "task",
    "todo_read",
    "todoread",
    "todowrite",
  ]

  const importBundle = [...readCore, "data_import", "data_batch"]
  const estimateBundle = [...readCore, "econometrics", "regression_table"]
  const verifyBundle = [...readCore, "regression_table"]
  const reportBundle = [...readCore, "regression_table", "research_brief", "paper_draft", "slide_generator"]

  const repairBundle = [...readCore, "data_import", "data_batch", "econometrics", "regression_table"]
  let bundle = readCore
  if (!stage) {
    bundle =
      input.policy.workflowMode === "econometrics" || inputIntent === "analysis" || inputIntent === "repair"
        ? inputIntent === "analysis" || inputIntent === "repair"
          ? [...new Set([...readCore, "data_import", "data_batch", "econometrics", "regression_table"])]
          : [...readCore, "data_import", "data_batch"]
        : readCore
    if (agent === "explorer") {
      bundle = [...new Set([...readCore, "data_import", "data_batch", "workflow"])]
    }
    if (agent === "analyst" && approvalStatus !== "approved") {
      const allowRegressionTable =
        stage === "baseline_estimate" ||
        stage === "verifier" ||
        stage === "report" ||
        inputIntent === "verify" ||
        inputIntent === "report"
      bundle = bundle.filter(
        (tool) =>
          ![
            "heterogeneity_runner",
            "paper_draft",
            "slide_generator",
          ].includes(tool) && (tool !== "regression_table" || allowRegressionTable),
      )
    }
    return {
      policy: input.policy,
      bundle,
      allowedToolIDs: bundle.filter((tool) => allowed.has(tool)),
    }
  }

  if (
    stage === "healthcheck" ||
    stage === "import" ||
    stage === "profile_or_schema_check" ||
    stage === "qa_gate" ||
    stage === "preprocess_or_filter" ||
    stage === "describe_or_diagnostics"
  ) {
    bundle = importBundle
    if (
      (stage === "qa_gate" || stage === "preprocess_or_filter" || stage === "describe_or_diagnostics") &&
      input.policy.workflowMode === "econometrics" &&
      (inputIntent === "analysis" || inputIntent === "repair" || agent === "general" || agent === "analyst")
    ) {
      bundle = [...new Set([...importBundle, "econometrics", "regression_table"])]
    }
  } else if (stage === "baseline_estimate") {
    bundle = estimateBundle
  } else if (stage === "verifier") {
    bundle = verifyBundle
  } else if (stage === "report") {
    bundle = reportBundle
  }

  if (status === "blocked" || status === "failed" || repairOnly) {
      bundle = stage === "baseline_estimate" ? repairBundle : [...readCore, "data_import", "data_batch"]
  }

  if (agent === "verifier") {
    bundle = [...readCore, "regression_table"]
  } else if (agent === "explorer") {
    bundle = [...new Set([...readCore, "data_import", "data_batch", "workflow"])]
  } else if (agent === "explore") {
    bundle =
      input.policy.workflowMode === "econometrics" ? [...new Set([...bundle, "workflow"])] : [...readCore, "workflow"]
  } else if (agent === "general") {
    bundle = [...new Set([...bundle, "workflow"])]
  }

  if (agent === "analyst" && approvalStatus !== "approved") {
    const allowRegressionTable =
      stage === "baseline_estimate" ||
      stage === "verifier" ||
      stage === "report" ||
      inputIntent === "verify" ||
      inputIntent === "report"
    bundle = bundle.filter(
      (tool) =>
        ![
          "heterogeneity_runner",
          "paper_draft",
          "slide_generator",
        ].includes(tool) && (tool !== "regression_table" || allowRegressionTable),
    )
  }

  if (inputIntent) {
    bundle = [
      ...new Set([
        ...bundle.filter((tool) => INPUT_INTENT_TOOL_BUNDLES[inputIntent].includes(tool as never)),
        "workflow",
      ]),
    ]
  }

  if (input.policy.modelCapabilities?.supportsTools === false) {
    bundle = bundle.filter((tool) => ["workflow", "read", "glob", "grep", "skill"].includes(tool))
  }

  if (input.policy.modelCapabilities?.supportsImages === false) {
    bundle = bundle.filter((tool) => !["slide_generator"].includes(tool))
  }

  if (input.policy.platformCapabilities?.mcp === false) {
    bundle = bundle.filter((tool) => tool !== "codesearch" && tool !== "websearch")
  }

  if (input.policy.platformCapabilities?.remote) {
    bundle = bundle.filter((tool) => !["bash", "shell", "edit", "write", "apply_patch"].includes(tool))
  }

  return {
    policy: input.policy,
    bundle,
    allowedToolIDs: bundle.filter((tool) => allowed.has(tool)),
  }
}

export function filterToolsForWorkflow(input: { policy: ToolAvailabilityPolicy; toolIDs: string[] }) {
  return resolveToolAvailability(input).allowedToolIDs
}

export function allowMcpToolForWorkflow(input: { toolName: string; policy: ToolAvailabilityPolicy }) {
  const stage = input.policy.currentStage
  const repairOnly = input.policy.repairOnly === true
  const agent = input.policy.agent

  if (input.toolName.startsWith("context7_")) return false
  if (input.toolName.startsWith("stata_")) return false
  if (repairOnly) return false
  if (agent === "verifier") return false
  if (stage === "healthcheck" || stage === "import" || stage === "profile_or_schema_check" || stage === "qa_gate") {
    return false
  }

  return false
}

export function datasetStageSnapshot(datasetId: string, stageId?: string) {
  const manifest = readDatasetManifest(datasetId)
  const stage = getStage(manifest, stageId)
  return {
    manifest,
    stage,
  }
}
