import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Bus } from "@/bus"
import type {
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

const AUTO_VERIFY_STAGES = new Set<WorkflowStageKind>([
  "import",
  "qa_gate",
  "preprocess_or_filter",
  "baseline_estimate",
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
  repair: ["workflow", "read", "glob", "grep", "skill", "data_import", "econometrics", "regression_table"],
  report: ["workflow", "read", "research_brief", "paper_draft", "slide_generator", "regression_table"],
  analysis: ["workflow", "read", "glob", "grep", "skill", "data_import", "econometrics", "regression_table"],
} as const

const WORKFLOW_EXECUTION_POLICY = {
  autoVerifyStages: [...AUTO_VERIFY_STAGES],
  freshVerifierAgent: "verifier",
  repairOnlyBundles: {
    healthcheck: ["workflow", "read", "glob", "grep", "skill", "data_import"],
    import: ["workflow", "read", "glob", "grep", "skill", "data_import"],
    profile_or_schema_check: ["workflow", "read", "glob", "grep", "skill", "data_import"],
    qa_gate: ["workflow", "read", "glob", "grep", "skill", "data_import"],
    preprocess_or_filter: ["workflow", "read", "glob", "grep", "skill", "data_import"],
    describe_or_diagnostics: ["workflow", "read", "glob", "grep", "skill", "data_import"],
    baseline_estimate: ["workflow", "read", "glob", "grep", "skill", "data_import", "econometrics", "regression_table"],
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
        column.toLowerCase().includes(input.toLowerCase()) || input.toLowerCase().includes(column.toLowerCase()) ? 0 : 99,
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
  return {
    version: 1,
    sessionID,
    activeRunId: parsed.activeRunId,
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
  }
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
    datasetId: input.datasetId,
    runId: input.runId,
    branch: input.branch,
    activeStage: DEFAULT_STAGE_SEQUENCE[0],
    stageSequence: [...DEFAULT_STAGE_SEQUENCE],
    edges: [...DEFAULT_STAGE_EDGES],
    stages: [],
    trustedArtifacts: [],
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
    (sessionState.activeRunId ? sessionState.runs.find((run) => run.workflowRunId === sessionState.activeRunId) : undefined)

  if (existing) {
    existing.datasetId = input.datasetId ?? existing.datasetId
    existing.runId = input.runId ?? existing.runId
    existing.branch = branch
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

function upsertStage(run: WorkflowRun, stage: StageNode) {
  const existing = findStage(run, stage.stageId, stage.branch)
  if (existing) {
    Object.assign(existing, stage, { createdAt: existing.createdAt, updatedAt: nowIso() })
    return existing
  }
  run.stages.push(stage)
  return stage
}

function collectArtifactRefs(metadata?: Record<string, unknown>) {
  if (!metadata) return []
  const refs = new Set<string>()
  const visit = (value: unknown, key?: string) => {
    if (typeof value === "string") {
      const looksLikePath = value.includes("\\") || value.includes("/") || /\.(json|md|xlsx|csv|dta|parquet|txt)$/i.test(value)
      if (looksLikePath) refs.add(value)
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

function deriveParentStage(run: WorkflowRun, branch: string, kind: WorkflowStageKind, metadata?: Record<string, unknown>) {
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

function computeDependsOn(run: WorkflowRun, branch: string, kind: WorkflowStageKind, metadata?: Record<string, unknown>) {
  const parent = deriveParentStage(run, branch, kind, metadata)
  return parent ? [parent.stageId] : []
}

function computeDownstream(run: WorkflowRun, branch: string, kind: WorkflowStageKind) {
  const downstream = new Set<string>()
  for (const stageKind of downstreamKinds(kind)) {
    for (const stage of run.stages) {
      if (stage.branch === branch && stage.kind === stageKind) downstream.add(stage.stageId)
    }
  }
  return [...downstream]
}

function stageNeedsVerifier(kind: WorkflowStageKind) {
  return AUTO_VERIFY_STAGES.has(kind)
}

function publishWorkflowState(sessionID: string, run?: WorkflowRun, rerunTargetStageId?: string) {
  const workflow = run ?? getActiveWorkflowRun(sessionID)
  const activeStage =
    workflow?.activeNodeId ? workflow.stages.find((stage) => stage.nodeId === workflow.activeNodeId) : activeOrLatestStage(workflow)
  Bus.publish(RuntimeEvents.WorkflowState, {
    sessionID,
    workflowRunId: workflow?.workflowRunId,
    branch: workflow?.branch,
    activeStage: workflow?.activeStage,
    activeStageId: activeStage?.stageId,
    repairOnly: workflow?.repairOnly ?? false,
    latestFailureCode: workflow?.latestFailure?.code,
    verifierStatus: workflow?.latestVerifier?.status,
    trustedArtifacts: workflow?.trustedArtifacts ?? [],
    rerunTargetStageId,
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
    latestTrustedArtifacts: input.workflow.trustedArtifacts,
    metadata: input.stage.metadata ?? {},
    instruction:
      "Audit this workflow stage. Return only a JSON object inside <verifier_result> tags with keys status, checks, blockingFindings, repairHints, trustedArtifacts, summary, findings.",
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
    ...input.stage.artifactRefs
      .filter((artifact) => fs.existsSync(artifact))
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
    repairHints: ["Verifier fallback: runtime report will be used because the fresh-run verifier output was not parseable."],
    trustedArtifacts: input.stage.artifactRefs.filter((artifact) => fs.existsSync(artifact)),
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
  return {
    status: envelope.status ?? report.status,
    checks,
    blockingFindings,
    repairHints: envelope.repairHints.length > 0 ? envelope.repairHints : report.repairHints,
    trustedArtifacts: envelope.trustedArtifacts.length > 0 ? envelope.trustedArtifacts : report.trustedArtifacts,
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

function stageKindFromTool(toolName: string, args: Record<string, unknown>, metadata?: Record<string, unknown>): WorkflowStageKind {
  if (toolName === "data_import") {
    const action = typeof args.action === "string" ? args.action : typeof metadata?.action === "string" ? metadata.action : ""
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
    Partial<Pick<StageFailureRecord, "createdAt" | "maxRetries" | "autoRepairAllowed" | "requiresVerifier" | "repairMetadata">>,
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
      .filter((value) => /var|column|outcome|dependent|independent|entity|time|treat|id/i.test(value) || value.includes("_"))
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
    repairAction: "Deduplicate or aggregate the entity-time keys, rerun QA, then rerun the failed estimation stage only.",
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

function applyRepairHandler(input: {
  failure: StageFailureRecord
  stage?: StageNode
  workflow?: WorkflowRun
}) {
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

export function getActiveWorkflowRun(sessionID: string) {
  const session = readWorkflowSession(sessionID)
  if (!session.activeRunId) return session.runs.at(-1)
  return session.runs.find((run) => run.workflowRunId === session.activeRunId) ?? session.runs.at(-1)
}

export function workflowPromptSummary(sessionID: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) return []
  const stage =
    (run.activeNodeId ? run.stages.find((item) => item.nodeId === run.activeNodeId) : undefined) ?? activeOrLatestStage(run)
  const base = [
    "Workflow runtime summary:",
    `- workflowRunId: ${run.workflowRunId}`,
    `- branch: ${run.branch}`,
    run.datasetId ? `- datasetId: ${run.datasetId}` : undefined,
    run.runId ? `- runId: ${run.runId}` : undefined,
    run.activeStage ? `- active stage: ${run.activeStage}${stage ? ` (${stage.stageId}, status=${stage.status})` : ""}` : undefined,
    run.repairOnly ? `- repair-only mode: enabled` : `- repair-only mode: disabled`,
    run.latestFailure
      ? `- last failure: ${run.latestFailure.code}; retry stage=${run.latestFailure.retryStage}; repair=${run.latestFailure.repairAction}`
      : undefined,
    run.latestVerifier ? `- latest verifier: ${run.latestVerifier.status}` : undefined,
  ].filter(Boolean)
  const stagePolicy = stage
    ? [
        "Workflow stage policy:",
        `- current stage kind: ${stage.kind}`,
        `- depends on: ${(stage.dependsOn ?? []).join(", ") || "none"}`,
        `- downstream stages: ${(stage.downstream ?? []).join(", ") || "none"}`,
        `- replayable: ${stage.replayable === false ? "no" : "yes"}`,
        `- recommended skill bundle: ${recommendedSkillBundle(stage.kind).join(", ")}`,
      ]
    : []
  const verifierPolicy = [
    "Verifier policy:",
    `- auto verifier required: ${stage && stageNeedsVerifier(stage.kind) ? "yes" : "no"}`,
    run.latestVerifier?.status === "block"
      ? "- verifier is blocking progress; do not continue to narrative/report, repair the failed stage only."
      : "- continue only if artifacts and stage assumptions remain valid.",
  ]
  const memory = [
    "Workflow memory:",
    run.trustedArtifacts.length ? `- trusted artifacts: ${run.trustedArtifacts.slice(-6).join(", ")}` : "- trusted artifacts: none yet",
  ]
  return [base.join("\n"), stagePolicy.join("\n"), verifierPolicy.join("\n"), memory.join("\n")].filter(
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
  const branch = typeof metadata.branch === "string" ? metadata.branch : typeof input.args.branch === "string" ? input.args.branch : "main"
  const run = ensureRun(sessionState, {
    datasetId: typeof metadata.datasetId === "string" ? metadata.datasetId : typeof input.args.datasetId === "string" ? input.args.datasetId : undefined,
    runId: typeof metadata.runId === "string" ? metadata.runId : typeof input.args.runId === "string" ? input.args.runId : undefined,
    branch,
  })
  const kind = stageKindFromTool(input.toolName, input.args, metadata)
  const stageId =
    (typeof metadata.stageId === "string" ? metadata.stageId : undefined) ??
    (typeof input.args.stageId === "string" ? input.args.stageId : undefined) ??
    `${kind}_${run.stages.filter((stage) => stage.kind === kind).length.toString().padStart(3, "0")}`
  const stageStatus: StageStatus =
    metadata.qaGateStatus === "block" ? "blocked" : metadata.qaGateStatus === "warn" ? "completed" : "completed"
  const artifacts = collectArtifactRefs(metadata)
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
    downstream: computeDownstream(run, branch, kind),
    cacheKey: stageCacheKey(kind, input.args, metadata),
    replayable: true,
    executionMode: "normal",
    toolName: input.toolName,
    replayInput: normalizeReplayInput(input.args),
    artifactRefs: artifacts,
    trustedArtifacts: stageNeedsVerifier(kind) ? [] : artifacts,
    metadata,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  stage.failure = undefined
  stage.verifierReport = undefined
  run.activeNodeId = stage.nodeId
  run.activeStage = stageStatus === "blocked" ? kind : stageNeedsVerifier(kind) ? "verifier" : nextStage(kind) ?? kind
  run.repairOnly = stageStatus === "blocked"
  run.blockedStageId = stageStatus === "blocked" ? stage.stageId : undefined
  run.activeCoordinatorAgent = stageNeedsVerifier(kind) ? "verifier" : "general"
  run.updatedAt = nowIso()
  if (!stageNeedsVerifier(kind)) {
    run.trustedArtifacts = [...new Set([...run.trustedArtifacts, ...artifacts])]
  }
  if (stageStatus !== "blocked") {
    run.latestFailure = undefined
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
  const branch = typeof input.args.branch === "string" ? input.args.branch : "main"
  const run = ensureRun(sessionState, {
    datasetId: typeof input.args.datasetId === "string" ? input.args.datasetId : undefined,
    runId: typeof input.args.runId === "string" ? input.args.runId : undefined,
    branch,
  })
  const kind = stageKindFromTool(input.toolName, input.args)
  const stageId = typeof input.args.stageId === "string" ? input.args.stageId : `${kind}_failed`
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
    downstream: computeDownstream(run, branch, kind),
    cacheKey: stageCacheKey(kind, input.args),
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
  run.activeCoordinatorAgent = failure.code === "STAGE_NOT_RESOLVED" || failure.code === "ARTIFACT_MISSING" ? "explore" : "general"
  run.latestFailure = failure
  run.updatedAt = nowIso()
  writeWorkflowSession(sessionState)
  publishWorkflowState(input.sessionID, run)
  return { workflowRun: run, stage }
}

export function latestFailedStage(sessionID: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) return undefined
  return [...run.stages].reverse().find((stage) => stage.status === "failed" || stage.status === "blocked")
}

export function buildRerunPlan(sessionID: string, stageId?: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) {
    return {
      blocked: true,
      reason: "No workflow run is recorded for this session yet.",
    } as {
      blocked: boolean
      reason?: string
      workflowRun?: WorkflowRun
      target?: StageNode
      toolName?: string
      replayInput?: Record<string, unknown>
      repairAction?: string
    }
  }

  const target =
    (stageId ? run.stages.find((stage) => stage.stageId === stageId) : undefined) ??
    latestFailedStage(sessionID) ??
    activeOrLatestStage(run)

  if (!target) {
    return {
      blocked: true,
      reason: "No stage is available to rerun.",
      workflowRun: run,
    } as {
      blocked: boolean
      reason?: string
      workflowRun?: WorkflowRun
      target?: StageNode
      toolName?: string
      replayInput?: Record<string, unknown>
      repairAction?: string
    }
  }

  if (!target.replayInput || !target.toolName) {
    return {
      blocked: true,
      reason: `Stage ${target.stageId} has no recorded replay input.`,
      target,
      workflowRun: run,
    } as {
      blocked: boolean
      reason?: string
      workflowRun?: WorkflowRun
      target?: StageNode
      toolName?: string
      replayInput?: Record<string, unknown>
      repairAction?: string
    }
  }

  const downstreamTargets = computeDownstream(run, target.branch, target.kind)
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
  } as {
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
  publishWorkflowState(sessionID, run, target.stageId)
  return result
}

export async function executeRerunPlan(input: {
  sessionID: string
  stageId?: string
  ctx?: unknown
}) {
  const rerunPlan = buildRerunPlan(input.sessionID, input.stageId)
  return {
    ...rerunPlan,
    executed: false,
    note:
      rerunPlan.blocked
        ? rerunPlan.reason ?? "No runnable rerun target is available."
        : "Automated stage replay is not wired in the runtime yet; use the rerun plan to replay only the failed stage.",
    verifier: undefined,
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
  const stage =
    (input.stageId ? run?.stages.find((item) => item.stageId === input.stageId) : undefined) ?? activeOrLatestStage(run)
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
  const trustedArtifacts = stage.artifactRefs.filter((artifact) => fs.existsSync(artifact))
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
  run.activeStage = report.status === "block" ? stage.kind : nextStage(stage.kind) ?? "report"
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
  run.trustedArtifacts = report.status === "block" ? run.trustedArtifacts : [...new Set([...run.trustedArtifacts, ...trustedArtifacts])]
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
  const stage =
    (input.stageId ? run?.stages.find((item) => item.stageId === input.stageId) : undefined) ?? activeOrLatestStage(run)
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
    }
  }
  const activeStage =
    (run.activeNodeId ? run.stages.find((stage) => stage.nodeId === run.activeNodeId) : undefined) ?? activeOrLatestStage(run)
  return {
    sessionID,
    workflow: run,
    activeStage,
    failedStage: latestFailedStage(sessionID),
  }
}

export function workflowStageDetails(sessionID: string, stageId?: string) {
  const run = getActiveWorkflowRun(sessionID)
  if (!run) return { workflow: null, stage: null }
  const stage =
    (stageId ? run.stages.find((item) => item.stageId === stageId || item.nodeId === stageId) : undefined) ??
    (run.activeNodeId ? run.stages.find((item) => item.nodeId === run.activeNodeId) : undefined) ??
    activeOrLatestStage(run)
  return { workflow: run, stage }
}

export function workflowArtifactList(sessionID: string, stageId?: string) {
  const { workflow, stage } = workflowStageDetails(sessionID, stageId)
  const artifacts = stage?.artifactRefs ?? workflow?.trustedArtifacts ?? []
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
    repairOnly: input.repairOnly ?? run?.repairOnly ?? run?.latestVerifier?.status === "block",
  } satisfies ToolAvailabilityPolicy
}

export function filterToolsForWorkflow(input: {
  policy: ToolAvailabilityPolicy
  toolIDs: string[]
}) {
  const allowed = new Set(input.toolIDs)
  const stage = input.policy.currentStage
  const status = input.policy.currentStageStatus
  const agent = input.policy.agent
  const inputIntent = input.policy.inputIntent
  const repairOnly = input.policy.repairOnly === true

  if (!stage) return [...allowed]

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
    "bash",
  ]

  const importBundle = [...readCore, "data_import"]
  const estimateBundle = [...readCore, "econometrics", "regression_table"]
  const verifyBundle = [...readCore, "regression_table"]
  const reportBundle = [...readCore, "regression_table", "research_brief", "paper_draft", "slide_generator"]

  const repairBundle = [...readCore, "data_import", "econometrics", "regression_table"]
  let bundle = readCore
  if (stage === "healthcheck" || stage === "import" || stage === "profile_or_schema_check" || stage === "qa_gate" || stage === "preprocess_or_filter" || stage === "describe_or_diagnostics") {
    bundle = importBundle
  } else if (stage === "baseline_estimate") {
    bundle = estimateBundle
  } else if (stage === "verifier") {
    bundle = verifyBundle
  } else if (stage === "report") {
    bundle = reportBundle
  }

  if (status === "blocked" || status === "failed" || repairOnly) {
    bundle = stage === "baseline_estimate" ? repairBundle : [...readCore, "data_import"]
  }

  if (agent === "verifier") {
    bundle = [...readCore, "regression_table"]
  } else if (agent === "explore") {
    bundle = [...readCore, "workflow"]
  } else if (agent === "general") {
    bundle = [...new Set([...bundle, "workflow"])]
  }

  if (inputIntent) {
    bundle = [...new Set([...bundle.filter((tool) => INPUT_INTENT_TOOL_BUNDLES[inputIntent].includes(tool as never)), "workflow"])]
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
    bundle = bundle.filter((tool) => !["bash", "edit", "write", "apply_patch"].includes(tool))
  }

  return bundle.filter((tool) => allowed.has(tool))
}

export function datasetStageSnapshot(datasetId: string, stageId?: string) {
  const manifest = readDatasetManifest(datasetId)
  const stage = getStage(manifest, stageId)
  return {
    manifest,
    stage,
  }
}
