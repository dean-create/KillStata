import fs from "fs"
import path from "path"
import crypto from "crypto"
import { projectReflectionRoot } from "./dataset-state"
import { isWorkflowDataMethodTool, isWorkflowDiagnosticTool, isWorkflowEstimateTool, isWorkflowRecommendTool } from "./tool-catalog"
import { prepareToolMetadata, sanitizeToolRecord, summarizeToolError } from "./tool-result-policy"
import { Log } from "@/util/log"

const log = Log.create({ service: "failure-reflection" })

export type FailureType =
  | "file_not_found"
  | "path_resolution_error"
  | "column_not_found"
  | "encoding_or_locale_error"
  | "python_missing"
  | "dependency_broken"
  | "schema_mismatch"
  | "panel_integrity_failure"
  | "estimation_failure"
  | "validate_blocked"
  | "data_snapshot_failure"
  | "tool_contract_failure"
  | "result_contract_failure"
  | "process_timeout"
  | "planning_failure"
  | "unknown_failure"

export type ToolReflection = {
  toolName: string
  failureType: FailureType
  rootCause: string
  blocking: boolean
  retryStage: string
  repairAction: string
  userVisibleExplanation: string
  createdAt: string
  input?: Record<string, unknown>
  error: string
  qaGateStatus?: string
  qaGateReason?: string
  qaSource?: string
  reflectionPath?: string
  sessionId?: string
}

type FailurePattern = {
  pattern: string
  fix: string
}

/**
 * duplicate entity-time 的修复指引有两种，取决于 build_quality_report（Python 侧）
 * 有没有验证出重复能被某一列消解：
 *   - 能消解：Python 已经确定性算出"加哪一列、消解后有多少唯一实体"，直接把结论转成
 *     可执行指令，不留"是否真实重复"给模型/用户猜——那正是 2026-08-12 gf.xlsx 事故的
 *     根因：数据质量检查 报了模糊的"可能同名重复"建议，模型没有验证就采信，用户据此选择删除
 *     115 行，而这些行分属 6 个不同省份的"其他"地区，是完全合法的独立观测（复合实体 ID
 *     后重复数为 0）。若真删除，会静默损毁数据。
 *   - 不能消解：真正的重复记录，维持原有措辞（先核实是否真实重复，再去重/合并）。
 * 两种情形共用一套判定：消息里含 "Verified: combining" 即为已验证可消解
 *（与 python/econometrics/data_preprocess.py 的 _find_duplicate_key_resolution 同步）。
 */
const DUPLICATE_KEY_RESOLVED_MARKER = /verified: combining '([^']+)' with column '([^']+)'/i
const DUPLICATE_ENTITY_TIME_AMBIGUOUS_FIX =
  "先检查实体标识是否完整；若怀疑同名实体跨上级区域重复（如‘地区’在多个‘省份’下重名），先用 data_preprocess 的 combine_columns 把候选的上级标识列与实体列组合成复合 ID 并验证是否能让重复归零——不要在没有验证的情况下假设是重复或建议删除。只有在无法用任何现有列消解、且确认属于真实重复记录后，才去重或合并。"

function duplicateEntityTimeRepairAction(error: string) {
  const resolved = error.match(DUPLICATE_KEY_RESOLVED_MARKER)
  if (resolved) {
    const [, entityVar, resolvingColumn] = resolved
    return `这不是真实重复：'${entityVar}' 缺了一层身份信息，已验证组合 '${resolvingColumn}' 列可让重复完全消解。用 data_preprocess 的 combine_columns 合并 '${resolvingColumn}' 与 '${entityVar}' 生成复合实体列，用该列作为 entityVar 重跑质检。不要删除这些行——它们是不同的观测单位。`
  }
  return DUPLICATE_ENTITY_TIME_AMBIGUOUS_FIX
}

const DEFAULT_FAILURE_PATTERNS: FailurePattern[] = [
  { pattern: "missing columns in dataset", fix: "读取已导入数据的 schema，使用准确列名改写参数后，只重试失败调用。" },
  { pattern: "panel identifiers not found", fix: "对当前工作数据运行 数据质量检查，确认实体与时间标识后，只重试估计阶段。" },
  { pattern: "no usable rows remain", fix: "检查缺失值和筛选条件，修复数据准备阶段后再运行原模型。" },
  { pattern: "failed to import econometric_algorithm", fix: "先运行 healthcheck，核验 Python 环境并修复依赖，再重试失败阶段。" },
  { pattern: "weak instrument", fix: "弱工具变量提示：first-stage F 偏低，可考虑 Anderson-Rubin 稳健推断或在报告中明确受限证据，是否仍报告 IV 估计由你判断。" },
  { pattern: "parallel trends", fix: "平行趋势诊断提示不通过：DID 因果解释的稳健性受质疑，可考虑 PSM-DID / 安慰剂 / 加控制变量等稳健性检验，或在报告中明确说明该限制。" },
]

function nowIso(): string {
  return new Date().toISOString()
}

function safeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function walk(value: unknown, visitor: (node: Record<string, unknown>) => void) {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visitor))
    return
  }
  if (!value || typeof value !== "object") return
  const node = value as Record<string, unknown>
  visitor(node)
  Object.values(node).forEach((item) => walk(item, visitor))
}

function inferFailureType(error: string, errorCode?: string): FailureType {
  const message = error.toLowerCase()
  // 结构化错误码优先于文本匹配：文案可能被人改动，code 是稳定契约。
  // PROCESS_ABORTED 是用户主动取消，不归入需要修复的类型（blocking=false）。
  // 结果契约失败发生在工具已经返回后：不能把伪成功当作普通估计失败重跑，必须先检查
  // 适配器/产物契约。结构化 code 优先，文案只是兼容旧调用方。
  if (errorCode === "RESULT_CONTRACT_INVALID" || errorCode === "RESULT_LINEAGE_MISMATCH" || errorCode === "RESULT_NONFINITE" || errorCode === "RESULT_PATH_INVALID" || errorCode === "RESULT_PATH_MISSING" || errorCode === "CLAIM_CEILING_BLOCKED") {
    return "result_contract_failure"
  }
  if (errorCode === "PROCESS_TIMEOUT") return "process_timeout"
  if (errorCode === "TOOL_EXECUTION_TIMEOUT") return "process_timeout"
  if (errorCode === "TOOL_OUTPUT_INVALID") return "result_contract_failure"
  if (errorCode === "TOOL_SCHEMA_NOT_SENT") return "tool_contract_failure"
  if (errorCode === "PROCESS_SPAWN_FAILED") return "python_missing"
  if (errorCode === "PROCESS_CWD_DENIED" || errorCode === "PROCESS_COMMAND_DENIED") return "tool_contract_failure"
  if (errorCode === "TOOL_INPUT_INVALID") return "tool_contract_failure"
  if (errorCode === "COLUMN_NOT_FOUND" || errorCode === "DATA_COLUMN_MISSING") return "column_not_found"
  if (errorCode === "DATA_PANEL_KEY_NOT_UNIQUE") return "panel_integrity_failure"
  if (errorCode === "DATA_SNAPSHOT_FAILED" || errorCode === "DATA_SNAPSHOT_UNSTABLE") return "data_snapshot_failure"
  if (errorCode === "DATA_NO_USABLE_ROWS") return "schema_mismatch"
  if (errorCode === "PREFLIGHT_BLOCKED") return "validate_blocked"
  if (errorCode === "DATA_FORMAT_UNSUPPORTED") return "schema_mismatch"
  if (errorCode === "DATA_NO_VARIATION" || errorCode === "DATA_TOO_FEW_ROWS") return "validate_blocked"
  if (errorCode === "METHOD_INPUT_INVALID" || errorCode === "INVALID_ARGUMENT") return "tool_contract_failure"
  if (errorCode === "METHOD_EXECUTION_FAILED") return "estimation_failure"
  if (errorCode === "INVALID_METHOD_RESULT") return "result_contract_failure"
  if (errorCode === "DEPENDENCY_MISSING" || errorCode === "ENGINE_ASSET_MISSING") return "python_missing"
  if (errorCode === "ENGINE_TIMEOUT") return "process_timeout"
  if (errorCode === "ENGINE_ABORTED") return "unknown_failure"
  if (errorCode === "PROCESS_ABORTED") return "unknown_failure"
  // 模型规格问题发生在估计器真正写入结果之前，应回到“修正/确认规格”路径，不能被
  // 当作未知副作用失败触发幂等阻断。中文和结构化错误码都保留，兼容不同后端。
  if (errorCode === "MODEL_SPEC_INVALID" || message.includes("设计矩阵秩亏") || message.includes("完全共线性") || message.includes("matrix is singular")) {
    return "tool_contract_failure"
  }
  if (message.includes("process_timeout") || message.includes("计量分析超过") || message.includes("harness 已终止")) return "process_timeout"
  if (
    message.includes("input file not found") ||
    message.includes("data file not found") ||
    message.includes("filenotfounderror") ||
    message.includes("enoent") ||
    message.includes("找不到输入文件") ||
    message.includes("找不到文件") ||
    message.includes("文件不存在") ||
    message.includes("路径不存在")
  ) return "file_not_found"
  if (message.includes("manifest not found") || message.includes("stage not found")) return "path_resolution_error"
  if (
    message.includes("variables not found") ||
    message.includes("column not found") ||
    message.includes("columns not found") ||
    message.includes("not in df.columns") ||
    message.includes("数据中找不到变量") ||
    message.includes("找不到以下变量") ||
    message.includes("不存在的变量")
  ) return "column_not_found"
  if (message.includes("unicode") || message.includes("encoding") || message.includes("gbk") || message.includes("utf-8")) return "encoding_or_locale_error"
  if (message.includes("failed to launch python") || message.includes("python was not found")) return "python_missing"
  if (message.includes("no module named") || message.includes("failed to import")) return "dependency_broken"
  if (message.includes("qa gate") || message.includes("blocking_errors") ||
      message.includes("ipw overlap failure") || message.includes("ipw effective sample size failure") ||
      message.includes("ipw failed weighted balance") ||
      // "分析单位重复"的真实拒绝文案是中文（python/psm/runner.py：
      // "分析单位 ... 存在 ... 行重复；PSM 要求每个分析单位一行..."）。此前这里只匹配
      // 英文 "requires exactly one row per analysis unit"，与实现从未对上过——这类
      // 失败一直落进 unknown_failure 兜底，拿到的是通用"最小修复"建议而不是明确指向
      // 数据质量检查/聚合步骤的修复动作。旧测试只覆盖过英文，曾掩盖实现中的中文文案；
      // 当前回归位于正式 failure-reflection 测试。message 已 toLowerCase()，中文不受影响。
      message.includes("每个分析单位一行") ||
      message.includes("psm matching failed post-match balance") || message.includes("psm matching found no treated observation") ||
      message.includes("propensity-score design matrix is rank deficient") || message.includes("propensity-score logit did not converge") ||
      message.includes("propensity-score logit has perfect separation") || message.includes("propensity-score logit returned boundary scores") ||
      message.includes("aipw") || message.includes("requires a full column rank") ||
      // 估计门禁的"数据质量检查已执行但被判定为阻断"新文案（stage.ts:502-512）。此前落入
      // unknown_failure，retryStage 被错指回 estimate，模型在 validate 阻断循环里
      // 反复重跑估计器（2026-08-05 did.xlsx 第三轮真实数据测试）。归入 validate_blocked
      // 后 retryStage=qa、repairAction 明确为"修复 数据质量检查 阻断项"。
      message.includes("数据质量检查已经执行过") || message.includes("被判定为阻断")) return "validate_blocked"
  if (
    message.includes("treatment must be binary") ||
    message.includes("contain missing values") ||
    message.includes("covariates must vary") ||
    message.includes("must be of a numeric type") ||
    message.includes("必须是数值型") ||
    message.includes("可转换为数值的时期编码") ||
    message.includes("id 列组合在评价范围内存在重复") ||
    message.includes("结果变量没有变异") ||
    message.includes("取值全相同")
  ) return "validate_blocked"
  // “数据质量检查尚未执行”与“数据质量检查已执行但阻断”都必须回到 qa 阶段；若落入下面更宽泛的
  // planning_failure，估计器会被错误送回 profile，重复画像仍无法满足门禁。
  if (
    (message.includes("计量估计前必须") && message.includes("validate")) ||
    message.includes("当前 canonical stage 通过 qa")
  ) return "validate_blocked"
  if (message.includes("requires inputpath") || message.includes("invalid arguments") || message.includes("unavailable tool") ||
      message.includes("no such tool") || message.includes("requires entityvar") || message.includes("计量工具参数不合法") ||
      message.includes("工具调用参数不符合契约")) return "tool_contract_failure"
  // read 工具拒绝读取原始大数据集（>1MB 文本切片不可信），模型应改用 data_import profile
  // 查看变量和取值，而不是重试 read（2026-08-25 status-check 真实场景：模型读 2.3MB CSV
  // 被拒后停滞，不知道该用 data_import profile 替代）。
  if (message.includes("拒绝将") && message.includes("原始数据集按文本读取")) return "tool_contract_failure"
  if (message.includes("这是原始数据而不是分析产物")) return "tool_contract_failure"
  if (message.includes("tool_output_reference_denied")) return "tool_contract_failure"
  // create_column 的列比较若误把列名放进 right_value，后端会明确提示“右值不是
  // 数值”。这是可确定修正的参数语义错误，必须回到当前预处理调用改用
  // right_column，不能落入未知失败后触发幂等凭证熔断。
  if (
    message.includes("create_column") &&
    (message.includes("right value") && message.includes("not numeric") ||
      message.includes("右值") && message.includes("不是数值"))
  ) return "tool_contract_failure"
  if (message.includes("duplicate entity-time") || message.includes("panel identifiers not found")) return "panel_integrity_failure"
  // 估计器/预处理的前置条件缺失（必须先画像/数据质量检查）：修复动作是"先完成前置阶段再重试估计器"，
  // 与 planning_failure 的修复语义一致。此规则必须在 estimation_failure 之前——错误文案
  // 以"计量估计前必须"开头，虽含"估计"却并非估计本身失败（2026-08-05 真实数据测试
  // 中该错误此前落入 unknown_failure，retryStage=estimate 指向错误，模型只能瞎猜修复）。
  if (
    message.includes("计量估计前必须") ||
    message.includes("数据预处理前必须") ||
    message.includes("必须先完成当前 canonical stage")
  )
    return "planning_failure"
  if (message.includes("singular") || message.includes("rank deficient") || message.includes("perfect separation") ||
      message.includes("did not converge") || message.includes("estimation") || message.includes("regression") ||
      message.includes("std. error") ||
      // DID 估计器参数校验失败（缺处理组/对照组/政策前后），归入 estimation_failure 允许重试
      message.includes("传统 DID") || message.includes("必须同时包含处理组")) return "estimation_failure"
  if (message.includes("schema")) return "schema_mismatch"
  // 宽泛的 plan/workflow 兜底**不再归入 planning_failure**：planning_failure 的
  // repairAction 明确指向"先跑 econometrics_recommend 画像"（前置缺失类），而
  // "plan/workflow" 字样可能来自 workflow 系统错误、规划失败等完全不同的根因——
  // 给它们硬编码 recommend 指令会让模型照做后再失败一次并耗掉修复配额
  //（2026-08-11 review F7：两个来源共用一条 repairAction，兜底来源拿到错误指令）。
  // 这些归入 unknown_failure，走通用"最小修复"建议，不误导。
  return "unknown_failure"
}

function defaultRepairAction(failureType: FailureType, toolName: string) {
  switch (failureType) {
    case "file_not_found":
      return toolName === "read"
        ? "read 读取的路径不存在；不要重复读取原路径。先使用工具实际返回的准确路径或最新引用定位；如果要查看数据结构或分布，改用 data_import 的 profile/frequency。"
        : "重新查找文件，并把工具实际返回的准确路径传给失败调用。"
    case "path_resolution_error": return "从最新 manifest 解析 datasetId/stageId，只重试失败阶段。"
    case "column_not_found": return "先运行画像或 数据质量检查，读取准确列名，再用显式列名改写失败调用。"
    case "encoding_or_locale_error": return "保留 Unicode 路径和列名，避免有损 Shell 插值，并使用结构化参数重试。"
    case "python_missing": return "将 KILLSTATA_PYTHON 指向有效解释器，重新运行 healthcheck 后再分析。"
    case "dependency_broken": return "运行 healthcheck，补齐缺失的 Python 依赖，再从失败阶段继续。"
    case "schema_mismatch": return "先通过导入和画像规范化数据，再执行下游操作。"
    // 具体错误文本（含 duplicate entity-time 时是否可消解）由 deriveRepairAction 优先判定；
    // 这里只在拿不到错误文本时（如 repairHistoryNotice 按类型统计历史失败）作为中性兜底。
    case "panel_integrity_failure": return "检查实体与时间标识是否完整；若怀疑同名实体重复，先用 combine_columns 验证组合列能否让重复归零，再决定是否去重。"
    case "estimation_failure": return "先诊断结构化错误及数据/模型前提，不得原样重试。只有找到不改变研究含义的具体修复后，才可重试失败估计；变量、样本、方法或识别设计需要变化时必须先询问用户。无法定位根因时停止并报告具体错误。"
    case "validate_blocked": return "按质检提示修复当前数据阶段，重新质检通过后再继续分析。"
    case "data_snapshot_failure": return "执行快照未能稳定建立，估计器没有运行；检查本地文件是否仍在写入及读取权限/磁盘空间，恢复后刷新诊断并重新准备规格。"
    case "tool_contract_failure": return `根据 ${toolName} 的参数描述修正字段、类型或列名，只重试失败调用。`
    case "result_contract_failure": return "结果契约校验失败：不要把本次结果当作成功重试或报告；先修复后端适配器/产物血缘，再由系统重新验证。"
    case "process_timeout": return "缩小数据范围或简化同一计量设定后，只重试失败阶段；不要自动改用其他估计方法。"
    case "planning_failure": return "前置条件缺失：先调用 econometrics_recommend 完成当前数据集阶段的画像（必要时再跑 data_import 数据质量检查），完成后原样重试失败的 data_preprocess / 估计器。"
    default: return "检查结构化错误记录，采用最小修复，并且只重试失败阶段。"
  }
}

export function qaBlockRepairAction(blockingErrors: readonly string[]) {
  const duplicateError = blockingErrors.find((error) => /duplicate entity-time/i.test(error))
  if (duplicateError) {
    return duplicateEntityTimeRepairAction(duplicateError)
  }
  return "按质检提示修复当前数据阶段，重新质检通过后再继续分析。"
}

/**
 * 跨会话失败历史提示。
 *
 * 旧写法把所有历史失败混在一起计数，然后**一律**建议"换一种参数组合"。对 ENOENT
 * （file_not_found）这类失败这是无效甚至有害的指令——路径不存在跟参数组合无关，模型照做
 * 只会开始瞎猜参数（2026-08-08 实测：verifier 子会话被这句话推着连试多组 glob，白耗两轮
 * 修复配额）。而且把 file_not_found 和 tool_contract_failure 的次数加在一起报，本身就是噪声。
 *
 * 现在：按失败类型分组计数，只对**最常见的那一类**给出针对性建议（直接复用
 * defaultRepairAction，与首次失败时给模型的指令保持一致），避免自造第二套说法。
 */
export function repairHistoryNotice(
  toolName: string,
  priorFailures: ReadonlyArray<{ failureType: FailureType }>,
): string {
  if (priorFailures.length === 0) return ""
  const counts = new Map<FailureType, number>()
  for (const item of priorFailures) counts.set(item.failureType, (counts.get(item.failureType) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const dominant = ranked[0]![0]
  const breakdown = ranked.map(([type, count]) => `${type}×${count}`).join("、")
  return `\n该工具在过去跨会话失败过：${breakdown}。最常见的一类（${dominant}）的既定修复方向是：${defaultRepairAction(dominant, toolName)}`
}

export function retryStageForToolFailure(toolName: string, failureType: FailureType) {
  if (failureType === "data_snapshot_failure") return "validate"
  if (toolName === "data_import") {
    if (failureType === "file_not_found" || failureType === "path_resolution_error") return "ingest"
    if (failureType === "column_not_found" || failureType === "schema_mismatch") return "profile"
    if (failureType === "validate_blocked") return "clean"
    return "clean"
  }
  if (isWorkflowRecommendTool(toolName)) return "profile"
  if (isWorkflowDataMethodTool(toolName)) {
    // data_preprocess 缺画像（planning_failure）必须回 profile 而非 verify：
    // 门禁说"先画像"，repairAction 也指向 recommend，模型才能补上画像后重试
    //（2026-08-10 gf-panel 实测：planning_failure 被指回 verify，模型放弃修复）。
    if (failureType === "planning_failure") return "profile"
    if (failureType === "validate_blocked") return "validate"
    return "clean"
  }
  if (isWorkflowDiagnosticTool(toolName)) {
    if (failureType === "column_not_found" || failureType === "schema_mismatch") return "profile"
    return "validate"
  }
  if (isWorkflowEstimateTool(toolName)) {
    if (failureType === "result_contract_failure") return "verify"
    if (failureType === "validate_blocked") return "validate"
    if (failureType === "panel_integrity_failure" || failureType === "column_not_found") return "validate"
    // 前置条件缺失（缺画像）：必须回 profile 而非 estimate，否则修复指令与门禁矛盾——
    // 门禁说"先画像"，repairAction 却说"重试估计阶段"，模型无所适从（2026-08-05 修复）。
    if (failureType === "planning_failure") return "profile"
    return "estimate"
  }
  return "verify"
}

function loadFailurePatterns(): Array<{ pattern: string; fix: string }> {
  const patternsPath = path.join(projectReflectionRoot(), "patterns.json")
  if (!fs.existsSync(patternsPath)) return [...DEFAULT_FAILURE_PATTERNS]
  try {
    const parsed = JSON.parse(fs.readFileSync(patternsPath, "utf-8"))
    if (!Array.isArray(parsed)) return [...DEFAULT_FAILURE_PATTERNS]
    const valid = parsed.filter(
      (item: unknown): item is FailurePattern =>
        !!item && typeof item === "object" &&
        typeof (item as FailurePattern).pattern === "string" &&
        typeof (item as FailurePattern).fix === "string",
    )
    return valid.length > 0 ? valid : [...DEFAULT_FAILURE_PATTERNS]
  } catch { return [...DEFAULT_FAILURE_PATTERNS] }
}

function deriveRepairAction(error: string, fallback: string) {
  if (/设计矩阵秩亏|完全共线性|matrix is singular/i.test(error)) {
    return "当前模型规格存在完全共线或矩阵秩亏。先把冲突变量和研究含义反馈给用户，询问用户应保留/移除哪一项或是否改用其他设计；不要原样重试，也不要为了让回归运行而静默删除变量。"
  }
  // duplicate entity-time 的修复文案依赖消息内容（是否已验证可消解），不是静态映射，
  // 必须先于 loadFailurePatterns 的固定表判定。
  if (/duplicate entity-time/i.test(error)) return duplicateEntityTimeRepairAction(error)
  // read 拒绝读取原始大数据集：明确告诉模型改用 data_import profile，不要重试 read。
  if (/拒绝将.*原始数据集按文本读取|这是原始数据而不是分析产物/i.test(error)) {
    return "read 拒绝读取原始数据集（文件过大或非分析产物）。改用 data_import 的 profile 或 validate action 查看变量和取值，不要用 read 读取原始数据文件。"
  }
  const normalized = error.toLowerCase()
  const match = loadFailurePatterns().find((item) => normalized.includes(item.pattern.toLowerCase()))
  return match?.fix ?? fallback
}

export function classifyToolFailure(input: {
  toolName: string
  error: string
  /** ManagedProcessError.code 等结构化错误码；传入后分类不再依赖错误文案。 */
  errorCode?: string
  input?: Record<string, unknown>
  sessionId?: string
}): ToolReflection {
  const failureType = inferFailureType(input.error, input.errorCode)
  const safeError = summarizeToolError(input.error)
  return {
    toolName: input.toolName,
    failureType,
    rootCause: safeError.split("\n")[0] || safeError,
    blocking: failureType !== "unknown_failure",
    retryStage: retryStageForToolFailure(input.toolName, failureType),
    repairAction: deriveRepairAction(safeError, defaultRepairAction(failureType, input.toolName)),
    userVisibleExplanation: `工具 ${input.toolName} 执行失败（${failureType}）。仅修复失败阶段后再重试。`,
    createdAt: nowIso(),
    input: sanitizeToolRecord(input.input) as Record<string, unknown> | undefined,
    error: safeError,
    sessionId: input.sessionId,
  }
}

export function persistToolReflection(reflection: ToolReflection) {
  const root = projectReflectionRoot()
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  // 去重：同一 sessionId + toolName + failureType 在过去 1 小时内已有 reflection 时跳过
  // 写盘，避免同会话反复重试同一类错误刷屏成百上千个 JSON 文件（2026-08 减法：之前
  // "Model tried to call unavailable tool" 这种已知错误每次重试都写一份，reflection
  // 目录几个月能涨到 300+ 个 90% 是重复）。
  if (reflection.sessionId) {
    const dedupKey = `${reflection.sessionId}::${reflection.toolName}::${reflection.failureType}`
    const cutoff = Date.now() - 60 * 60 * 1000
    const thisTime = new Date(reflection.createdAt).getTime() || Date.now()
    try {
      for (const file of fs.readdirSync(root)) {
        if (!file.endsWith(".json")) continue
        const full = path.join(root, file)
        const stat = fs.statSync(full)
        if (stat.mtimeMs < cutoff) continue
        try {
          const existing = JSON.parse(fs.readFileSync(full, "utf-8"))
          if (
            existing.sessionId === reflection.sessionId &&
            existing.toolName === reflection.toolName &&
            existing.failureType === reflection.failureType
          ) {
            // 只去重"间隔 >1s 的同会话重复失败"（repair 循环反复撞同一错误）；
            // 同一毫秒的并发写必须仍产生独立文件——flag:"wx" 才是防覆盖的硬保证
            //（analysis-reflection.test.ts "never overwrites a concurrent reflection" 锁定该语义）。
            const existingTime = new Date(existing.createdAt ?? 0).getTime() || stat.mtimeMs
            if (Math.abs(thisTime - existingTime) > 1000) {
              log.info("reflection dedup, skip write", { dedupKey, existing: file })
              return full
            }
          }
        } catch {}
      }
    } catch (error) {
      log.warn("reflection dedup scan failed", { error: String(error) })
    }
  }
  const safeReflection = prepareToolMetadata(reflection)
  const safeToolName = reflection.toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "tool"
  const filename = `${safeToolName}_${reflection.createdAt.replace(/[:.]/g, "-")}_${process.pid}_${crypto.randomUUID()}.json`
  const reflectionPath = path.join(root, filename)
  fs.writeFileSync(reflectionPath, JSON.stringify(safeReflection, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" })
  fs.chmodSync(reflectionPath, 0o600)
  return reflectionPath
}
