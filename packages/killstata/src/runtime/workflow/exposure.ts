import type {
  ToolAvailabilityExplanation,
  ToolAvailabilityPolicy,
  ToolAvailabilityResolution,
  WorkflowStageKind,
} from "../types"
import { WORKFLOW_ANALYSIS_CONTROL_TOOL_IDS, WORKFLOW_ANALYSIS_TOOL_IDS, WORKFLOW_DATA_METHOD_TOOL_IDS, WORKFLOW_DIAGNOSTIC_TOOL_IDS, WORKFLOW_ESTIMATE_TOOL_IDS, WORKFLOW_IMPORT_TOOL_IDS, WORKFLOW_INPUT_INTENT_TOOL_BUNDLES, WORKFLOW_READ_CORE_TOOL_IDS, WORKFLOW_RECOMMEND_TOOL_IDS, WORKFLOW_REPORT_TOOL_IDS, WORKFLOW_RUNNER_TOOL_IDS, uniqueToolIDs } from "../tool-catalog"
import { activeOrLatestStage, getActiveWorkflowRun, latestStageExcludingKinds } from "./state"
import { getExecutionMode } from "@/runtime/execution-mode"

// 修复模式的"修复手段"工具集：估计器失败（如缺 profile/数据质量检查）的 repairAction 指向
// profile/clean 阶段，必须允许模型调用 recommend/data_import/data_preprocess 完成
// 前置条件后原样重试估计器。模块作用域常量避免每次 resolveToolAvailability 调用重建。
const REPAIR_ENABLER_TOOL_IDS = new Set([
  ...WORKFLOW_IMPORT_TOOL_IDS,
  ...WORKFLOW_DATA_METHOD_TOOL_IDS,
  ...WORKFLOW_RECOMMEND_TOOL_IDS,
  ...WORKFLOW_ANALYSIS_CONTROL_TOOL_IDS,
])

// 系统工具不参与计量方法的认知预算。只要当前运行环境允许，它们每轮都直接暴露，
// 让模型始终能导入/查看数据、做 数据质量检查、搜索方法和管理工作流。
const ALWAYS_VISIBLE_SYSTEM_TOOL_IDS = new Set([
  ...WORKFLOW_READ_CORE_TOOL_IDS,
  ...WORKFLOW_IMPORT_TOOL_IDS,
  ...WORKFLOW_DATA_METHOD_TOOL_IDS,
  ...WORKFLOW_RECOMMEND_TOOL_IDS,
])

const QUALITY_INSPECTION_HIDDEN_TOOL_IDS = new Set([
  "read", "list", "glob", "grep", "pipeline", "skill",
  "analysis_prepare",
  "todoread", "todowrite", "task", "bash", "shell", "edit", "write", "webfetch",
  "econometrics_execute",
  ...WORKFLOW_ANALYSIS_TOOL_IDS,
  ...WORKFLOW_DATA_METHOD_TOOL_IDS,
])
const PSM_DIAGNOSTIC_TOOL_IDS = new Set(
  WORKFLOW_DIAGNOSTIC_TOOL_IDS.filter((toolID) => toolID.startsWith("psm_")),
)
const PSM_METHOD_TOOL_IDS = new Set([
  ...PSM_DIAGNOSTIC_TOOL_IDS,
  ...WORKFLOW_ESTIMATE_TOOL_IDS.filter((toolID) => toolID.startsWith("psm_")),
])

// 方法推荐轮的硬边界：数据画像可以读取/导入，推荐可以给出候选；预处理、估计和
// 通用工作流执行都可能改变研究含义或直接产出结果，必须等用户明确采纳/授权后再见。
const RECOMMENDATION_ONLY_ALLOWED_TOOL_IDS = new Set([
  "question", "read", "list", "glob", "grep", "tool_search",
  ...WORKFLOW_IMPORT_TOOL_IDS,
  ...WORKFLOW_RECOMMEND_TOOL_IDS,
])

/** 各阶段可选用的预制工具包；由 resolveToolAvailability 在调用点构造后传入策略表。 */
type StageBundles = {
  ingestWithDataMethod: string[]
  estimate: string[]
  verify: string[]
  report: string[]
}

/**
 * 每个 workflow 阶段的工具面声明。
 *
 * - `bundle`：该阶段的基础工具包。
 * - `searchableEstimators`：是否把估计器补进**可搜索**面（第二层 deferred，不是 direct）。
 *   早期阶段必须为 true，否则 OLS 等在 baseline_estimate 之前完全搜不到，模型会反复空搜。
 *
 *   ⚠️ `false` 对 baseline_estimate/verifier/report 三个阶段的实际效力并不对等：
 *   baseline_estimate 是真正生效的——estimateBundle 本身已经把估计器铺进 bundle，不需要
 *   再补。verifier/report 的 `false` **不会**让估计器彻底不可搜索：本函数末尾有一段独立
 *   的 `if (agent !== "verifier") { bundle = [...bundle, ...WORKFLOW_ESTIMATE_TOOL_IDS...] }`
 *   （为 2026-08-11/12 mid-course-correction 死锁而保留：分析完成停在 verifier/report 后，
 *   用户追加"重跑/加控制变量"仍要能找到估计器，删掉它会让那个死锁复现），对非 verifier
 *   agent 无条件把全部估计器重新并回可搜索面。因此 verifier/report 的 `false` 只在
 *   agent==="verifier"（核验子 Agent 本身，与 stage==="verifier" 是两个不同维度）时才
 *   真正生效；其余 agent 在这两个 stage 仍能搜到全部估计器。改这两处任一处前，先跑
 *   `test/runtime/exposure-matrix.test.ts` 确认改动范围符合预期。
 *
 * 收拢成一张表的原因：这两项此前分散成一条七分支 if-else 链和一个**否定式列举**
 * （`stage !== "baseline_estimate" && stage !== "verifier" && stage !== "report"`）。
 * 否定式列举意味着新增一个阶段会**默认落进**"早期阶段补估计器"分支，而没有任何提示；
 * 改成 Record<WorkflowStageKind, …> 后，新增阶段不在表里就是类型错误。
 */
type StageToolPolicy = {
  bundle: (b: StageBundles) => string[]
  searchableEstimators: boolean
}

const STAGE_TOOL_POLICY: Record<WorkflowStageKind, StageToolPolicy> = {
  healthcheck: { bundle: (b) => b.ingestWithDataMethod, searchableEstimators: true },
  import: { bundle: (b) => b.ingestWithDataMethod, searchableEstimators: true },
  validate: { bundle: (b) => b.ingestWithDataMethod, searchableEstimators: true },
  profile_or_schema_check: {
    bundle: (b) => uniqueToolIDs([...b.ingestWithDataMethod, ...WORKFLOW_RECOMMEND_TOOL_IDS]),
    searchableEstimators: true,
  },
  preprocess_or_filter: {
    bundle: (b) => uniqueToolIDs([...b.ingestWithDataMethod, ...WORKFLOW_ANALYSIS_TOOL_IDS]),
    searchableEstimators: true,
  },
  profile_or_diagnostics: {
    bundle: (b) => uniqueToolIDs([...b.ingestWithDataMethod, ...WORKFLOW_ANALYSIS_TOOL_IDS]),
    searchableEstimators: true,
  },
  baseline_estimate: { bundle: (b) => b.estimate, searchableEstimators: false },
  verifier: { bundle: (b) => b.verify, searchableEstimators: false },
  report: { bundle: (b) => b.report, searchableEstimators: false },
}

/**
 * 第一层（模型本轮可调用）分为常驻系统面与滑动方法窗口：
 * - 系统工具不设认知数量上限，始终保留数据导入、数据质量检查、问题澄清和方法发现闭环；
 * - 具体计量诊断/估计方法最多 10 个，可由新搜索结果替换未确认的旧方法。
 *
 * 这样用户/模型已经确认 did2s 后，不会因为系统工具较多而被重新塞回延迟目录；
 * 同时也不会把整个方法注册表的 schema 全部放进上下文。
 */
export const MODEL_TOOL_POOL_LIMITS = {
  method: 10,
} as const

const CONCRETE_METHOD_TOOL_IDS = new Set([
  ...WORKFLOW_DIAGNOSTIC_TOOL_IDS,
  ...WORKFLOW_ESTIMATE_TOOL_IDS,
])

export function isConcreteMethodTool(toolID: string) {
  return CONCRETE_METHOD_TOOL_IDS.has(toolID)
}

export function modelToolPoolCounts(toolIDs: Iterable<string>) {
  let system = 0
  let method = 0
  for (const toolID of toolIDs) {
    if (isConcreteMethodTool(toolID)) method++
    else system++
  }
  return { system, method }
}

/**
 * 工具可见性决策：把 workflow 阶段 + 输入意图 + agent + 平台能力
 * 解析成"本轮请求模型能看到哪些工具"。
 *
 * 唯一的工具清单来源是 `runtime/tool-manifest.ts`（经 tool-catalog 派生），
 * 本模块只负责按策略做交并集，不自己维护工具名表。
 */

export function workflowToolPolicy(input: ToolAvailabilityPolicy) {
  if (!input.sessionID) return input
  const run = getActiveWorkflowRun(input.sessionID)
  const activeNode = run?.activeNodeId ? run.stages.find((stage) => stage.nodeId === run.activeNodeId) : undefined
  const stage = activeNode ?? activeOrLatestStage(run)
  // 上一轮分析已完成（baseline_estimate completed 且 activeStage 停在收尾的
  // verifier/report）后，后续轮次用户追加需求（重跑/换变量/加控制变量）语义是
  // "继续分析"——工具面应回到最近完成的分析 stage（baseline_estimate 的
  // estimateBundle），而不是收尾 bundle（只有 readCore，估计器/data_import 全
  // 不可见，2026-08-11 mid-course-correction 实测：turn2 调 ols 报 unavailable
  // → REPAIR 守卫拒绝原样重试 → 修复死锁）。不能复用 activeOrLatestStage——它
  // 优先返回 activeNodeId 指向的节点（完成后是 verifier），不走到非 verifier 兜底。
  const baselineDone = (run?.stages ?? []).some(
    (item) => item.kind === "baseline_estimate" && item.status === "completed",
  )
  const atTail = run?.activeStage === "verifier" || run?.activeStage === "report"
  // 只回落到分析链 stage（排除 verifier **和 report**）：report 也是收尾 bundle
  //（readCore + report 工具，intent 收窄后剩 readCore），若 workflow 已完整跑到
  // report（存在 report 节点），find 会先命中 report 而非 baseline_estimate——
  // 多轮"重跑/加控制变量"仍会 unavailable 死锁（2026-08-12 review 发现，与
  // 2026-08-11 修的 mid-course-correction 死锁同构）。对 report 意图的后续请求
  // 不受影响：estimateBundle ∩ report bundle = readCore + report 工具，与
  // reportBundle ∩ report bundle 等价，intent 收窄仍保留 report 工具。
  const continuedStage = baselineDone && atTail
    ? latestStageExcludingKinds(run, ["verifier", "report"])
    : undefined
  const continuedEstimator =
    typeof continuedStage?.toolName === "string" && WORKFLOW_ESTIMATE_TOOL_IDS.includes(continuedStage.toolName as never)
      ? continuedStage.toolName
      : undefined
  const preferredToolIDs = input.preferredToolIDs?.length
    ? input.preferredToolIDs
    : input.inputIntent === "analysis" && continuedEstimator
      ? [continuedEstimator]
      : input.preferredToolIDs
  const repairOnly = input.repairOnly ?? run?.repairOnly ?? run?.latestVerifier?.status === "block"
  return {
    ...input,
    preferredToolIDs,
    workflowMode: run?.workflowMode,
    currentStage: continuedStage?.kind ?? (run?.activeStage ?? stage?.kind),
    currentStageStatus: continuedStage?.status ?? stage?.status,
    approvalStatus: input.approvalStatus ?? run?.approvalStatus,
    repairOnly,
    allowFileDiscoveryDuringRepair: input.allowFileDiscoveryDuringRepair ?? (
      repairOnly && run?.latestFailure?.code === "FILE_NOT_FOUND"
    ),
    executionMode: input.executionMode ?? getExecutionMode(),
  } satisfies ToolAvailabilityPolicy
}

export function resolveToolAvailability(input: {
  policy: ToolAvailabilityPolicy
  toolIDs: string[]
}): ToolAvailabilityResolution {
  const allowed = new Set(input.toolIDs)
  const explain = (eligibleBundle: string[], directBundle: string[]): ToolAvailabilityExplanation[] => {
    const eligibleSet = new Set(eligibleBundle)
    const directSet = new Set(directBundle)
    return input.toolIDs.map((toolID) => {
      const reasons: string[] = []
      if (directSet.has(toolID)) {
        reasons.push("available directly in the current model tool pool")
      } else if (eligibleSet.has(toolID)) {
        reasons.push("eligible in the current workflow and available through tool_search")
      } else {
        reasons.push("not included for the current stage, agent, intent, or capability policy")
      }
      if (input.policy.platformCapabilities?.remote && ["bash", "shell", "edit", "write"].includes(toolID)) {
        reasons.push("blocked for remote platform safety")
      }
      if (
        input.policy.modelCapabilities?.supportsTools === false &&
        !["pipeline", "read", "glob", "grep", "skill"].includes(toolID)
      ) {
        reasons.push("blocked because the selected model does not support rich tool calling")
      }
      const blockedByReason = reasons.some((reason) => reason.startsWith("blocked"))
      const direct = directSet.has(toolID) && !blockedByReason
      const exposure: ToolAvailabilityExplanation["exposure"] = direct
        ? "direct"
        : blockedByReason || !eligibleSet.has(toolID)
          ? "blocked"
          : "deferred"
      return {
        toolID,
        available: direct && allowed.has(toolID),
        exposure,
        reasons,
      }
    })
  }
  const applyCapabilityFilters = (tools: string[]) => {
    let filtered = tools
    if (input.policy.modelCapabilities?.supportsTools === false) {
      filtered = filtered.filter((tool) => ["pipeline", "read", "glob", "grep", "skill"].includes(tool))
    }
    if (input.policy.platformCapabilities?.remote) {
      filtered = filtered.filter((tool) => !["bash", "shell", "edit", "write"].includes(tool))
    }
    return filtered
  }
  const cognitiveDirectBundle = (eligibleBundle: string[]) => {
    const eligible = new Set(eligibleBundle)
    const systemTools: string[] = []
    const methodTools: string[] = []
    const add = (toolID: string) => {
      if (!eligible.has(toolID)) return
      const destination = isConcreteMethodTool(toolID) ? methodTools : systemTools
      if (destination.includes(toolID)) return
      if (!isConcreteMethodTool(toolID) || methodTools.length < MODEL_TOOL_POOL_LIMITS.method) destination.push(toolID)
    }
    // 已确认的方法路线占用独立方法预算：不与导入、数据质量检查、推荐等系统工具竞争。
    for (const toolID of input.policy.confirmedToolIDs ?? []) add(toolID)
    if (input.policy.repairToolName) add(input.policy.repairToolName)
    const confirmed = new Set(input.policy.confirmedToolIDs ?? [])
    for (const toolID of input.policy.preferredToolIDs ?? []) {
      if (!confirmed.has(toolID)) add(toolID)
    }
    // 系统工具不是“候选方法”，不应依赖一张手写小清单被裁掉。把当前阶段/权限允许的
    // 非计量方法全部放进本轮目录；计量诊断与估计器才受 method=10 约束。
    for (const toolID of eligibleBundle) {
      if (!isConcreteMethodTool(toolID)) add(toolID)
    }
    if (input.policy.allowTask) add("task")
    return [...methodTools, ...systemTools]
  }
  const finalize = (bundle: string[]): ToolAvailabilityResolution => {
    if (
      input.policy.allowTask &&
      input.policy.agent === "analyst" &&
      ["analysis", "ingest", "repair"].includes(input.policy.inputIntent ?? "")
    ) {
      bundle = uniqueToolIDs([...bundle, "task"])
    }
    const alwaysVisibleSystemTools = [...ALWAYS_VISIBLE_SYSTEM_TOOL_IDS]
    bundle = applyCapabilityFilters(uniqueToolIDs([...bundle, ...alwaysVisibleSystemTools]))
    if (input.policy.qualityInspectionOnly) {
      // 只读质量体检的事实底稿来自 data_import 的 profile/validate/frequency；
      // 隐藏 read，避免模型把内部 tool-output 或原始数据当成下一步探查目标。若同一请求还
      // 明确要求方法建议，仅保留只读推荐工具；文件缺失的 repair 轮只恢复 glob 定位候选，
      // 不开放读取文件内容或任何写入工具；后续 recommendationOnly 仍会隐藏估计器。
      bundle = bundle.filter((toolID) =>
        !QUALITY_INSPECTION_HIDDEN_TOOL_IDS.has(toolID) ||
        (input.policy.analysisRequestKind === "inspect" && toolID === "analysis_prepare") ||
        (input.policy.allowFileDiscoveryDuringRepair && toolID === "glob") ||
        (input.policy.recommendationOnly && WORKFLOW_RECOMMEND_TOOL_IDS.includes(toolID)),
      )
    }
    if (input.policy.recommendationOnly) {
      bundle = bundle.filter((toolID) => RECOMMENDATION_ONLY_ALLOWED_TOOL_IDS.has(toolID))
    }
    if (input.policy.psmToolScope === "blocked") {
      bundle = bundle.filter((toolID) => !PSM_METHOD_TOOL_IDS.has(toolID))
    } else if (input.policy.psmToolScope === "diagnostics_only") {
      bundle = bundle.filter((toolID) =>
        PSM_DIAGNOSTIC_TOOL_IDS.has(toolID) ||
        (!WORKFLOW_ESTIMATE_TOOL_IDS.includes(toolID) &&
          !WORKFLOW_DIAGNOSTIC_TOOL_IDS.includes(toolID) &&
          (!WORKFLOW_DATA_METHOD_TOOL_IDS.includes(toolID) ||
            (toolID === "data_preprocess" && Boolean(input.policy.psmScopeFilter))) &&
          !WORKFLOW_RECOMMEND_TOOL_IDS.includes(toolID) &&
          !WORKFLOW_RUNNER_TOOL_IDS.includes(toolID)),
      )
    }
    if (input.policy.analysisRequestRequired) {
      bundle = ["analysis_request"]
    } else {
      bundle = bundle.filter((toolID) => toolID !== "analysis_request")
      if (input.policy.analysisRequestKind !== "estimate" && input.policy.analysisRequestKind !== "inspect") {
        bundle = bundle.filter((toolID) => toolID !== "analysis_prepare")
      }
    }
    // Plan 模式**不在这里裁剪可见性**：模型必须照常 tool_search 加载估计方法、看 schema，
    // 才写得出带方法名和参数的方案。只读边界在执行层（session/processor.ts 的
    // PLAN_MODE_EXECUTION_BLOCKED）。可见层裁剪会让 tool_search 永远搜不到估计器——
    // 真实对话 gf.xlsx 里模型因此空转一整轮后被 glob 崩溃硬停，用户放弃分析。
    // 详见 runtime/execution-mode.ts 的模式说明。
    const directBundle = cognitiveDirectBundle(bundle)
    const explanations = explain(bundle, directBundle)
    const directSet = new Set(
      explanations.filter((item) => item.exposure === "direct" && item.available).map((item) => item.toolID),
    )
    const directToolIDs = directBundle.filter((tool) => directSet.has(tool))
    const deferredToolIDs = explanations.filter((item) => item.exposure === "deferred").map((item) => item.toolID)
    const blocked = explanations.filter((item) => item.exposure === "blocked")
    const blockedToolIDs = blocked.map((item) => item.toolID)
    return {
      policy: input.policy,
      bundle,
      allowedToolIDs: directToolIDs,
      directToolIDs,
      deferredToolIDs,
      blockedToolIDs,
      explanations,
      exposurePlan: {
        profile:
          input.policy.inputIntent === "conversation"
            ? "none"
            : (input.policy.confirmedToolIDs?.length ?? 0) > 0 || (input.policy.preferredToolIDs?.length ?? 0) > 0
              ? "focused"
              : "workflow",
        directTools: directToolIDs,
        deferredTools: deferredToolIDs.map((toolID) => ({
          toolID,
          reason: explanations.find((item) => item.toolID === toolID)?.reasons.join("; ") ?? "deferred by policy",
          enableWhen: ["matching stage", "matching agent", "matching model/platform capability"],
          remoteSafe: !["bash", "shell", "edit", "write"].includes(toolID),
          repairOnlyAllowed: true,
        })),
        blockedTools: blocked,
        policy: input.policy,
      },
    }
  }
  const stage = input.policy.currentStage
  const status = input.policy.currentStageStatus
  const agent = input.policy.agent
  const inputIntent = input.policy.inputIntent
  const readOnlyStatusIntent = inputIntent === "status" || inputIntent === "verify" || inputIntent === "report"
  const repairOnly = input.policy.repairOnly === true
  // 修复模式：stage 被阻断/失败，或 repairOnly 显式开启。两处决策共用——
  // ① 换完整修复包；② 跳过 inputIntent 收窄（收窄会把 data_preprocess 等修复手段删掉）。
  //
  // 关于 status/verify/report 的边界，历史上翻过一次：早期为了兜住"修复轮 intent 常被
  // 判成 status/verify"，把这三种意图也算进修复模式；但这让"跑完了吗？""看下结果"这类
  // 纯只读追问也会重新打开完整修复包，可能再次触发数据变换或估计。现在改为排除它们——
  // 真正的修复轮意图是 repair/analysis，有自己的工具包；而 conversation 轮已由下方
  // carryOver 单独保住"正在修复/已确认的方法"，不再依赖 isRepairMode 兜底。
  const isRepairMode = !readOnlyStatusIntent && (status === "blocked" || status === "failed" || repairOnly)
  const approvalStatus = input.policy.approvalStatus

  // Conversation 不会**主动发起**导入、清洗或估计；但它绝不能把已经在进行的分析锁死。
  //
  // 2026-08-28 did.xlsx 真实会话：模型正确诊断出重复键、正确造出复合实体列，
  // 用户接着只追问了一句「？」「结果呢？」。这类追问不含“回归/面板”关键词，intent
  // 落到 conversation（activeAction 被清空后同样回落到这里），空 bundle 让所有估计器
  // 从 direct 和 deferred 同时消失——连正在修复的 hdfe_regression 都进不来
  //（cognitiveDirectBundle 的 add() 要求 toolID ∈ eligible）。于是直调报 tool_not_found、
  // tool_search 返回 availableCount:0，模型只能盲试到熔断，用户三次追问都拿不到结果。
  //
  // 因此闲聊轮保留两类方法：正在修复的目标，以及用户/门禁已确认的方法。二者都不是
  // “模型自己挑的新方法”，而是本会话已经成立的事实；其余方法仍只留在可搜索层。
  if (inputIntent === "conversation") {
    const carryOver = uniqueToolIDs(
      [
        ...(input.policy.confirmedToolIDs ?? []),
        input.policy.repairToolName,
        // “probit 会不会更合适？两个都跑一下”会被意图识别为咨询句，
        // 但 detectToolFocus 已记录用户明确点名的方法。保留这些方法只表示
        // 它们可以被本轮调用，不会让干净闲聊自动暴露估计器。
        ...(input.policy.preferredToolIDs ?? []).filter(isConcreteMethodTool),
      ]
        .filter((toolID): toolID is string => typeof toolID === "string" && allowed.has(toolID)),
    )
    // 只有确实存在"具体某个方法正在进行/待修"时，才把其余方法留在可搜索层供换方法。
    // 不能用 isRepairMode 作为条件——它在 status/verify 这类只读轮同样为真，会把估计器
    // 泄漏进本无分析意图的闲聊轮（exposure 特征化基线里 status intent 被误伤 24 处）。
    const searchableWhileBusy = carryOver.length > 0
      ? WORKFLOW_ESTIMATE_TOOL_IDS.filter((id) => allowed.has(id))
      : []
    return finalize(uniqueToolIDs([...carryOver, ...searchableWhileBusy]))
  }

  const readCore: string[] = [...WORKFLOW_READ_CORE_TOOL_IDS]
  const importBundle: string[] = uniqueToolIDs([
    ...readCore,
    ...WORKFLOW_IMPORT_TOOL_IDS,
    ...WORKFLOW_ANALYSIS_CONTROL_TOOL_IDS,
  ])
  // 导入后紧接着的清洗是最常见流程（一条消息"导入并筛选/清洗"），且 data_import 已不再
  // 接受 filter/preprocess——数据预处理只能走 data_preprocess。因此导入期各阶段（import /
  // validate / profile_or_schema_check / preprocess_or_filter）都必须同时暴露 data_method，
  // 否则 agent 在导入后会被卡死：data_import 拒绝、data_preprocess 又不可见。
  const ingestWithDataMethodBundle: string[] = uniqueToolIDs([...importBundle, ...WORKFLOW_DATA_METHOD_TOOL_IDS])
  // baseline_estimate 阶段保留 data_import：真实计量分析在估计前常需构造派生变量（如 did2s
  // 需要的相对时间 relativeTimeVar、交互项、对数变换、子样本），describe 阶段已同时提供
  // data_import 与估计器。若估计阶段完全拿掉 data_import，模型一旦进入估计阶段就无法回头构造
  // 派生变量，需预构造变量的估计器会死锁（2026-07-21，did.xlsx staggered：模型选对 did2s 后
  // 报 "unavailable tool data_import"）。data_import 有 stage 血缘 / 数据质量检查 / rollback 保护，
  // 估计阶段使用是安全且可追溯的。
  //
  // 同样的推导：β 收敛 / 面板回归需要构造对数/滞后/差分（data_preprocess 提供），
  // 估计器选错后想重选方法（econometrics_recommend 提供）。这两个 family 必须在
  // estimate 阶段可见，否则与 did2s 同样的死锁场景会重现。
  const estimateBundle: string[] = uniqueToolIDs([
    ...readCore,
    ...WORKFLOW_IMPORT_TOOL_IDS,
    ...WORKFLOW_DATA_METHOD_TOOL_IDS,
    ...WORKFLOW_RECOMMEND_TOOL_IDS,
    ...WORKFLOW_ESTIMATE_TOOL_IDS,
    ...WORKFLOW_ANALYSIS_CONTROL_TOOL_IDS,
    // 异质性执行器：基准估计出来之后才有意义，因此只在估计阶段可见；
    // 未批准时仍被下面的 analyst 过滤挡住（它会批量跑多个规格）。
    ...WORKFLOW_RUNNER_TOOL_IDS,
  ])
  const verifyBundle: string[] = uniqueToolIDs([...readCore])
  const reportBundle: string[] = uniqueToolIDs([...readCore, ...WORKFLOW_REPORT_TOOL_IDS])

  const repairBundle: string[] = uniqueToolIDs([
    ...readCore,
    ...WORKFLOW_IMPORT_TOOL_IDS,
    ...WORKFLOW_DATA_METHOD_TOOL_IDS,
    ...WORKFLOW_RECOMMEND_TOOL_IDS,
    ...WORKFLOW_ESTIMATE_TOOL_IDS,
    ...WORKFLOW_ANALYSIS_CONTROL_TOOL_IDS,
  ])
  // 修复模式的"修复手段"工具：数据准备工具（重跑 import/数据质量检查、清洗、画像）是修复前置条件的
  // 必经手段。估计器失败（如缺 profile/数据质量检查）的 repairAction 指向 profile/clean 阶段，必须
  // 允许模型调用 recommend/data_import/data_preprocess 完成前置条件后原样重试估计器。
  // 只对估计器/诊断器按 repairToolName 锁定（不换方法），数据工具永远放行。
  // 已确认的方法切换（confirmedToolIDs，如 did_static 四格缺失后确认的 did2s）是显式例外，
  // 允许从 did_static 切换到 did2s，并由独立方法预算保证其不会回退到 deferred。
  const restrictToFailedTool = (tools: string[]) => {
    if (!input.policy.repairToolName) return tools
    const confirmed = new Set(input.policy.confirmedToolIDs ?? [])
    const preferred = new Set(input.policy.preferredToolIDs ?? [])
    return tools.filter(
      (tool) => readCore.includes(tool) || REPAIR_ENABLER_TOOL_IDS.has(tool) || tool === input.policy.repairToolName || confirmed.has(tool) || preferred.has(tool),
    )
  }
  const bundleForInputIntent = () => {
    if (!inputIntent) return undefined
    // 当还没有 active stage 时，用户意图就是唯一可靠的工具暴露信号；
    // 这里必须直接使用对应意图工具包，不能先给 readCore 再做交集过滤。
    return [...WORKFLOW_INPUT_INTENT_TOOL_BUNDLES[inputIntent]]
  }
  let bundle: string[] = readCore
  if (!stage) {
    bundle =
      inputIntent === "analysis" || inputIntent === "repair"
        ? importBundle
        : (bundleForInputIntent() ??
          (input.policy.workflowMode === "econometrics" ? [...readCore, "data_import"] : readCore))
    if (agent === "analyst" && approvalStatus !== "approved") {
      // 异质性分析会按用户给的分组批量跑多个规格，属于需要显式批准的动作。
      bundle = bundle.filter((tool) => tool !== "heterogeneity_runner")
    }
    bundle = uniqueToolIDs(restrictToFailedTool(bundle))
    // Estimate tools must be discoverable via tool_search even before baseline_estimate stage (import/validate).
    // They remain deferred (not direct) because cognitiveDirectBundle only promotes confirmed/preferred methods;
    // execution readiness is still gated by data-readiness checks. Verifier stays read-only.
    if (agent !== "verifier" && !readOnlyStatusIntent) {
      bundle = uniqueToolIDs([...bundle, ...WORKFLOW_ESTIMATE_TOOL_IDS.filter((id) => allowed.has(id))])
    }
    // plan 模式收窄统一在 finalize() 里做，这里不再重复过滤（重复过滤会被随后的常驻并入抵消）。
    bundle = applyCapabilityFilters(bundle)
    return finalize(bundle)
  }

  const stageBundles: StageBundles = {
    ingestWithDataMethod: ingestWithDataMethodBundle,
    estimate: estimateBundle,
    verify: verifyBundle,
    report: reportBundle,
  }
  const stagePolicy = stage ? STAGE_TOOL_POLICY[stage] : undefined
  if (stagePolicy) bundle = stagePolicy.bundle(stageBundles)

  // 修复模式统一用完整修复包（readCore + 数据工具 + 估计器），由 restrictToFailedTool
  // 按 repairToolName 锁定估计器/诊断器。此前非 baseline_estimate 阶段（如 profile
  // 失败后）只给 readCore+import+data_method，recommend 不可见——而 estimate 失败后
  // 的 repairAction 恰恰指向 profile（需要 recommend），造成"修复动作需要推荐工具但
  // 工具面没有它"的死锁（2026-08-05 真实数据测试，did.xlsx）。
  if (isRepairMode) {
    bundle = repairBundle
  }

  // 早期阶段必须让估计器可被 tool_search 发现（deferred，不是 direct），否则 OLS 等
  // 在 baseline_estimate 之前完全搜不到，模型会反复空搜。是否补由阶段策略表正向声明。
  if (
    !isRepairMode &&
    stagePolicy?.searchableEstimators &&
    agent !== "verifier" &&
    agent !== "explore" &&
    agent !== "general"
  ) {
    bundle = uniqueToolIDs([...bundle, ...WORKFLOW_ESTIMATE_TOOL_IDS.filter((id) => allowed.has(id))])
  }

  if (agent === "verifier") {
    bundle = [...readCore]
  } else if (agent === "explore") {
    bundle =
      input.policy.workflowMode === "econometrics" ? [...new Set([...bundle, "pipeline"])] : [...readCore, "pipeline"]
  } else if (agent === "general") {
    bundle = [...new Set([...bundle, "pipeline"])]
  }

  if (agent === "analyst" && approvalStatus !== "approved") {
    // 异质性分析会按用户给的分组批量跑多个规格，属于需要显式批准的动作。
    bundle = bundle.filter((tool) => tool !== "heterogeneity_runner")
  }

  // 修复模式（status blocked/failed 或 repairOnly）下 bundle 已被换成完整修复包
  //（readCore + import + data_method + recommend + estimate）。此时**不能再按
  // inputIntent 收窄**：修复轮 intent 常被判成 status/verify（模型查阻断原因），
  // 若收窄到 WORKFLOW_INPUT_INTENT_TOOL_BUNDLES[status]（= readCore），
  // data_preprocess/econometrics_recommend 全被删——数据质量检查 blocked 后模型想用
  // combine_columns 修复合键却连 data_preprocess 都看不到（2026-08-11
  // correlation-before / time-missing 实测：available 只剩 question/list/read/
  // glob/grep/.../workflow，修复路径断裂）。修复模式就是"按修复包给全"，intent 不参与。
  if (inputIntent && !isRepairMode) {
    // ingest 是"数据准备"意图，但一条导入消息的循环里模型会推进到 数据质量检查/describe/估计
    //（econometrics-context 的 Mandatory Workflow 是连续动作）。若这里仍按 ingest 收窄，
    // recommend/estimator 会被从 stage bundle 里删掉：模型数据就绪后想画像/估计就死锁
    //（2026-08-05 did.xlsx：数据质量检查/describe 完成后工具目录只剩 read_core+data_import，
    // 模型只能空转 data_import，最终因缺 profile 被估计门禁拒绝且 repair 目录又不含
    // econometrics_recommend，连续 2 次修复失败停止）。ingest 只在"无活跃 stage"时
    // 决定初始工具包（bundleForInputIntent），stage 已推进时跟随 stage bundle。
    if (inputIntent !== "ingest") {
      bundle = [
        ...new Set([
          ...bundle.filter((tool) => WORKFLOW_INPUT_INTENT_TOOL_BUNDLES[inputIntent].includes(tool as never)),
          "pipeline",
        ]),
      ]
    }
  }

  // preferredToolIDs 只影响第一层的优先直出顺序，**不能**从第二层可搜索方法注册表
  // 移除其他准入方法。否则“当前已有 10 个方法 → 搜索第 11 个替换”时根本搜索不到候选，
  // 动态窗口退化成固定清单。方法的最终可见数仍由 cognitiveDirectBundle 的 method=10 限制。
  if (!isRepairMode && input.policy.preferredToolIDs?.length) {
    const preferred = new Set(input.policy.preferredToolIDs)
    // 估计阶段默认工具包偏向估计器；用户明确要求诊断（如 PSM 构造/可视化、弱工具检验）
    // 时补入该方法本身，作为第一层候选，但不裁掉其余可搜索方法。
    bundle = uniqueToolIDs([
      ...bundle,
      ...WORKFLOW_ANALYSIS_TOOL_IDS.filter((tool) => preferred.has(tool)),
    ])
  }

  bundle = restrictToFailedTool(bundle)
  // Ensure estimate tools are always searchable (deferred) even in early stages like import/validate.
  // They will be deferred, not direct, because cognitiveDirectBundle only promotes confirmed/preferred methods.
  // Verifier stays read-only isolated.
  if (agent !== "verifier" && !readOnlyStatusIntent) {
    bundle = uniqueToolIDs([...bundle, ...WORKFLOW_ESTIMATE_TOOL_IDS.filter((id) => allowed.has(id))])
  }
  // Plan 模式不裁剪可见性（只读边界在执行层），此处无需按 executionMode 过滤。
  bundle = applyCapabilityFilters(bundle)

  return finalize(bundle)
}

export function filterToolsForWorkflow(input: { policy: ToolAvailabilityPolicy; toolIDs: string[] }) {
  return resolveToolAvailability(input).allowedToolIDs
}

const MCP_SAFE_SIDE_CAR_HINTS =
  /(^|_)(read|get|list|search|fetch|find|query|inspect|lookup|resolve|status|diagnose|diagnostics|metadata|schema)(_|$)/i

const MCP_MUTATING_SIDE_CAR_HINTS =
  /(^|_)(write|create|update|delete|remove|patch|apply|edit|run|exec|execute|shell|bash|command|upload|download|install|publish|deploy|commit|push|merge|restore|rerun)(_|$)/i

function explainMcpSidecarIntent(toolName: string) {
  if (MCP_MUTATING_SIDE_CAR_HINTS.test(toolName)) {
    return "blocked because MCP sidecars are limited to read-only lookup/search/status tools"
  }
  if (!MCP_SAFE_SIDE_CAR_HINTS.test(toolName)) {
    return "blocked because the MCP tool name does not advertise a read-only lookup/search/status intent"
  }
  return undefined
}

export function explainMcpToolForWorkflow(input: {
  toolName: string
  policy: ToolAvailabilityPolicy
}): ToolAvailabilityExplanation {
  const stage = input.policy.currentStage
  const repairOnly = input.policy.repairOnly === true
  const agent = input.policy.agent
  const reasons: string[] = []

  if (input.policy.inputIntent === "conversation") {
    reasons.push("blocked during normal conversation")
  }

  if (input.policy.platformCapabilities?.mcp === false) {
    reasons.push("blocked because MCP/search capability is unavailable")
  }
  if (input.policy.modelCapabilities?.supportsTools === false) {
    reasons.push("blocked because the selected model does not support tool calling")
  }
  if (input.toolName.startsWith("context7_")) {
    reasons.push("blocked because documentation MCP tools are not part of the econometrics workflow")
  }
  const sidecarIntentReason = explainMcpSidecarIntent(input.toolName)
  if (sidecarIntentReason) {
    reasons.push(sidecarIntentReason)
  }
  if (repairOnly) {
    reasons.push("blocked while repairOnly is active")
  }
  if (agent === "verifier") {
    reasons.push("blocked for verifier read-only isolation")
  }
  if (!stage) {
    reasons.push("blocked until the active workflow stage is known")
  }
  if (stage === "healthcheck" || stage === "import" || stage === "profile_or_schema_check" || stage === "validate") {
    reasons.push("blocked during early data-readiness stages")
  }

  if (reasons.length === 0) {
    reasons.push("available as an advanced sidecar after the core workflow has reached a safe stage")
  }

  return {
    toolID: input.toolName,
    available: reasons.length === 1 && reasons[0].startsWith("available"),
    exposure: reasons.length === 1 && reasons[0].startsWith("available") ? "direct" : "blocked",
    reasons,
  }
}

export function allowMcpToolForWorkflow(input: { toolName: string; policy: ToolAvailabilityPolicy }) {
  return explainMcpToolForWorkflow(input).available
}
