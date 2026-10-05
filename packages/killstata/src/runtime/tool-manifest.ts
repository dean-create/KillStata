import type { WorkflowInputIntent } from "./types"
import {
  ECONOMETRICS_ADMISSIONS,
  MODEL_ADMITTED_ECONOMETRICS_DIAGNOSTIC_TOOL_IDS,
  MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS,
} from "./econometrics-admission"
import { MODEL_ADMITTED_DATA_TOOL_IDS } from "./data-method-admission"

/**
 * 工具清单：**模型可见面的唯一真相源**。
 *
 * 此前"一个工具何时对模型可见"分散在四处各写一遍（tool-catalog 的手写数组、
 * workflow 的 bundle 拼装、提示词里的硬编码工具名、analysis-user-view 的展示映射），
 * 工具改名要同时改五六处，漏一处就是"提示词说能用、调用却不存在"。
 *
 * 现在的分工：
 *   - `tool/registry.ts`     → 工具**实现**在哪（注册表，与可见性正交）
 *   - `econometrics-admission.ts` / `data-method-admission.ts` → 人工可见性 allowlist
 *   - `tool/*.ts`            → 工具 schema、执行逻辑与安全契约（风险/并发/副作用）
 *   - 本文件                  → **何时可见**（family / intent），从准入结论派生
 *
 * 因此本文件不重抄准入名单，也不保存调度安全属性，只补充曝光元数据。准入表增删一项，
 * 这里自动跟随；只有"核心工具"（read/glob/... 这些与计量无关的）在此首次定义。
 */

export type ToolFamily =
  | "read_core" // 只读检查与会话管理，几乎所有意图都开放
  | "import" // 数据入库
  | "data_method" // 数据处理方法（预处理 / 综合评价）
  | "recommend" // 方法推荐路由
  | "diagnostic" // 计量诊断（出检验统计量，不出回归表）
  | "estimator" // 计量估计器
  | "report" // 报告与实验记录
  | "runner" // 派生分析执行器（异质性等）
  | "analysis_control" // 请求登记后的规格校验与数据前置评估
  | "system" // 工作流自身控制
  | "filesystem" // 通用文件工具（bash/edit/shell/write）：不进任何计量意图包

export type ToolManifestEntry = {
  id: string
  family: ToolFamily
  /** 该工具在哪些输入意图下参与工具包组装。空数组表示不进任何意图包（仅历史 replay）。 */
  intents: readonly WorkflowInputIntent[]
}

const READ_CORE_INTENTS = ["status", "verify", "repair", "report", "analysis", "ingest"] as const
const ANALYSIS_ONLY = ["analysis"] as const
const ANALYSIS_AND_INGEST = ["analysis", "ingest"] as const
const ANALYSIS_AND_REPAIR = ["analysis", "repair"] as const
const ANALYSIS_REQUEST_INTENTS = ["analysis", "ingest", "repair"] as const

/**
 * 核心工具：与计量准入无关，可见性只由意图决定。
 * 顺序即 `WORKFLOW_READ_CORE_TOOL_IDS` 的对外顺序，改动会影响提示词里的目录排列。
 */
const CORE_ENTRIES: readonly ToolManifestEntry[] = [
  { id: "question", family: "read_core", intents: READ_CORE_INTENTS },
  { id: "read", family: "read_core", intents: READ_CORE_INTENTS },
  { id: "list", family: "read_core", intents: READ_CORE_INTENTS },
  { id: "glob", family: "read_core", intents: READ_CORE_INTENTS },
  { id: "grep", family: "read_core", intents: READ_CORE_INTENTS },
  { id: "skill", family: "read_core", intents: READ_CORE_INTENTS },
  { id: "pipeline", family: "system", intents: READ_CORE_INTENTS },
  { id: "analysis_request", family: "system", intents: ANALYSIS_REQUEST_INTENTS },
  { id: "analysis_prepare", family: "analysis_control", intents: ANALYSIS_REQUEST_INTENTS },
  { id: "tool_search", family: "system", intents: READ_CORE_INTENTS },
  { id: "econometrics_execute", family: "system", intents: READ_CORE_INTENTS },
  { id: "webfetch", family: "read_core", intents: READ_CORE_INTENTS },
  { id: "todoread", family: "read_core", intents: READ_CORE_INTENTS },
  { id: "todowrite", family: "read_core", intents: READ_CORE_INTENTS },
  // bash/shell/edit/write：有实现但刻意不进任何意图包（计量 workflow 中模型拿不到），
  // family 用独立的 filesystem——若放进 system 会被 WORKFLOW_READ_CORE_TOOL_IDS 带进所有
  // 意图包。intents 留空 + 独立 family，仅保留曝光分类；安全契约由工具定义自身携带。
  { id: "bash", family: "filesystem", intents: [] },
  { id: "shell", family: "filesystem", intents: [] },
  { id: "edit", family: "filesystem", intents: [] },
  { id: "write", family: "filesystem", intents: [] },

  { id: "data_import", family: "import", intents: ANALYSIS_AND_INGEST },
  { id: "econometrics_recommend", family: "recommend", intents: ANALYSIS_AND_REPAIR },
  { id: "experiment_log", family: "report", intents: ["report"] },
  { id: "heterogeneity_runner", family: "runner", intents: ANALYSIS_ONLY },
  { id: "task", family: "system", intents: [] },
]

/** 计量诊断与估计器：ID 全部来自准入表，本文件只补充调度属性。 */
const ADMITTED_ECONOMETRICS_ENTRIES: readonly ToolManifestEntry[] = [
  ...MODEL_ADMITTED_ECONOMETRICS_DIAGNOSTIC_TOOL_IDS.map(
    (id): ToolManifestEntry => ({
      id,
      family: "diagnostic",
      intents: ANALYSIS_AND_REPAIR,
    }),
  ),
  ...MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS.map(
    (id): ToolManifestEntry => ({
      id,
      family: "estimator",
      intents: ANALYSIS_AND_REPAIR,
    }),
  ),
]

/** 数据处理方法工具：ID 来自方法级准入表。 */
const ADMITTED_DATA_METHOD_ENTRIES: readonly ToolManifestEntry[] = MODEL_ADMITTED_DATA_TOOL_IDS.map(
  (id): ToolManifestEntry => ({
    id,
    family: "data_method",
    intents: ANALYSIS_ONLY,
  }),
)

export const TOOL_MANIFEST: readonly ToolManifestEntry[] = [
  ...CORE_ENTRIES,
  ...ADMITTED_ECONOMETRICS_ENTRIES,
  ...ADMITTED_DATA_METHOD_ENTRIES,
]

const manifestIDs = new Set(TOOL_MANIFEST.map((entry) => entry.id))

export function toolIDsByFamily(...families: ToolFamily[]): string[] {
  const wanted = new Set(families)
  return TOOL_MANIFEST.filter((entry) => wanted.has(entry.family)).map((entry) => entry.id)
}

export function toolIDsForIntent(intent: WorkflowInputIntent): string[] {
  return TOOL_MANIFEST.filter((entry) => entry.intents.includes(intent)).map((entry) => entry.id)
}

/**
 * 提示词里可以点名的工具。
 *
 * 提示词此前把 `ols_regression` 这类 ID 当散文字符串写死，TypeScript 无从校验，
 * 改名后 typecheck 全绿但运行时模型照着提示词调一个不存在的工具。改为从这里取值后，
 * 工具改名会让引用点直接产生类型错误。
 *
 * 只收录方法论层真正需要点名的工具——不是全部工具都该出现在提示词里。
 */
export const PROMPT_TOOL_NAMES = {
  analysisRequest: "analysis_request",
  analysisPrepare: "analysis_prepare",
  recommend: "econometrics_recommend",
  dataImport: "data_import",
  dataPreprocess: "data_preprocess",
  compositeEvaluation: "composite_evaluation",
  methodSearch: "tool_search",
  heterogeneity: "heterogeneity_runner",
} as const satisfies Record<string, string>

/**
 * 提示词点名的工具必须都在清单内，**并且至少在一个输入意图下可达**。
 *
 * 无法只靠类型做这件事：manifest 的 id 由准入表在运行时派生，是 `string` 而非字面量
 * 联合。所以用一个显式校验函数，由 harness 不变量测试调用——某个估计器被移出准入表而
 * 提示词还在引用时，测试立刻失败，而不是等线上模型调用一个不存在的工具。
 *
 * 可达性检查是后补的：此前只校验"在不在 manifest"，于是 heterogeneity_runner 以
 * `intents: []` 留在清单里、提示词照旧点名它，模型却永远拿不到——「提示词说能用、
 * 调用却不存在」这类问题正好从这个缺口漏过去（2026-08-28 审查发现）。
 */
export function assertPromptToolNamesRegistered(): void {
  const missing = Object.values(PROMPT_TOOL_NAMES).filter((id) => !manifestIDs.has(id))
  if (missing.length > 0) {
    throw new Error(`PROMPT_TOOL_NAMES 引用了不在 TOOL_MANIFEST 中的工具: ${missing.join(", ")}`)
  }
  const unreachable = Object.values(PROMPT_TOOL_NAMES).filter(
    (id) => (TOOL_MANIFEST.find((entry) => entry.id === id)?.intents.length ?? 0) === 0,
  )
  if (unreachable.length > 0) {
    throw new Error(
      `PROMPT_TOOL_NAMES 引用了 intents 为空、模型永远拿不到的工具: ${unreachable.join(", ")}。` +
        `要么给它配置可达的 intents，要么把它从提示词里摘掉。`,
    )
  }
}

/** 可见性条目的只读转发。 */
export function econometricsAdmissionEvidence(toolID: string) {
  return ECONOMETRICS_ADMISSIONS.find((item) => item.toolID === toolID)
}
