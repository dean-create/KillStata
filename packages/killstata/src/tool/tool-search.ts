import z from "zod"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import { getExecutionMode } from "@/runtime/execution-mode"
import { ToolResultProjection } from "@/runtime/tool-result-projection"
import type { UnifiedToolDescriptor } from "./tool-descriptor"

export type ToolSearchCandidate = Pick<Tool.Info, "id" | "model">

export type ToolSearchMatch = {
  toolID: string
  description: string
  namespace: Tool.ModelNamespace
  score: number
  /** 延迟加载成功后由工具池补充；静态目录搜索阶段不持有 Schema。 */
  inputSchema?: unknown
  outputSchema?: unknown
  /** 内部统一描述；不会直接序列化进模型可见文本。 */
  descriptor?: UnifiedToolDescriptor
}

/**
 * 兼容历史测试与内部展示的确定性查表：优先按方法 ID 匹配，同时支持产品维护的明确别名。
 *
 * 这里不对任意中文描述做模糊相似度计算。每个别名都绑定到唯一方法 ID，
 * 用来覆盖真实对话中“面板固定效应”“普通最小二乘”“两阶段最小二乘”这类
 * 稳定说法；没有明确别名时仍返回空结果，避免把相近方法错误地推给模型。
 * 正式运行时不使用此函数；模型搜索统一调用独立 Python Registry。保留它仅用于历史
 * 消息回放和旧版目录单元测试，避免把旧消息当成可执行方法入口。
 */

const METHOD_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  psm_construction: ["倾向得分构造", "倾向得分诊断", "倾向得分重叠"],
  psm_visualize: ["倾向得分分布", "共同支撑图"],
  iv_test: ["工具变量检验", "弱工具检验", "内生性检验", "过度识别检验"],
  psm_matching: ["倾向得分匹配", "最近邻匹配", "匹配估计"],
  psm_ipw: ["逆概率加权", "IPW", "加权平均处理效应"],
  psm_regression: ["倾向得分回归调整", "倾向得分回归"],
  psm_double_robust: ["双重稳健", "AIPW"],
  did_static: ["传统双重差分", "静态DID", "两组两期DID"],
  did2s: ["两阶段DID", "交错DID", "错位DID", "Gardner DID"],
  did_event_study_saturated: ["事件研究", "动态DID", "事件研究法"],
  ols_regression: ["普通最小二乘", "OLS回归", "基准回归"],
  panel_fe_regression: ["面板固定效应", "双向固定效应", "固定效应面板回归"],
  iv_2sls: ["两阶段最小二乘", "工具变量回归", "2SLS"],
  hdfe_regression: ["高维固定效应", "吸收固定效应", "HDFE"],
  logit_regression: ["Logit回归", "逻辑回归", "二元Logit"],
  probit_regression: ["Probit回归", "Probit模型"],
  poisson_regression: ["Poisson回归", "泊松回归"],
  negbin_regression: ["负二项回归", "Negative Binomial回归"],
  quantile_regression: ["分位数回归", "分位回归"],
  panel_random_effects: ["随机效应", "随机效应面板"],
  rdd_sharp: ["锐性断点", "Sharp RDD"],
  rdd_fuzzy: ["模糊断点", "Fuzzy RDD"],
  multinomial_logit: ["多项Logit", "多分类Logit", "多项式逻辑回归"],
  robust_regression: ["稳健回归", "M估计回归", "RLM"],
  wls_regression: ["加权最小二乘", "WLS回归"],
})
function idTokens(value: string) {
  // 只保留 ID 字面量可能出现的字符；中文、空格、标点一律作为分隔符。
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/** 分数只用于排序，不代表相关度置信；四档从"完全等于 ID"递减到"ID 子串"。 */
const ID_MATCH_SCORE = Object.freeze({
  exact: 100,
  segment: 40,
  prefix: 30,
  substring: 20,
})

const ALIAS_MATCH_SCORE = 120

function aliasMatchScore(id: string, query: string) {
  const aliases = METHOD_SEARCH_ALIASES[id] ?? []
  const normalizedQuery = query.toLowerCase().trim()
  return aliases.reduce((best, alias) => {
    const normalizedAlias = alias.toLowerCase()
    if (!normalizedAlias || !normalizedQuery) return best
    if (normalizedQuery.includes(normalizedAlias)) {
      return Math.max(best, ALIAS_MATCH_SCORE + normalizedAlias.length)
    }
    return best
  }, 0)
}

export function searchToolCatalog(
  catalog: readonly ToolSearchCandidate[],
  input: { query: string; limit: number },
): ToolSearchMatch[] {
  const tokens = idTokens(input.query)
  const scored = catalog
    .map((candidate, index) => {
      const id = candidate.id.toLowerCase()
      const segments = id.split("_")
      const idScore = tokens.reduce((total, token) => {
        if (id === token) return total + ID_MATCH_SCORE.exact
        if (segments.includes(token)) return total + ID_MATCH_SCORE.segment
        if (id.startsWith(token)) return total + ID_MATCH_SCORE.prefix
        if (id.includes(token)) return total + ID_MATCH_SCORE.substring
        return total
      }, 0)
      const aliasScore = aliasMatchScore(candidate.id, input.query)
      return {
        toolID: candidate.id,
        description: candidate.model.useWhen,
        namespace: candidate.model.namespace,
        score: Math.max(idScore, aliasScore),
        aliasScore,
        index,
      }
    })
    .filter((item) => item.score > 0)

  // 别名命中即短路：只返回别名匹配到的方法，不把 ID 片段匹配到的同族方法一起带出来。
  //
  // 中文别名里往往嵌着方法族的英文缩写（"交错DID"→ idTokens 会剥出 "did"），该缩写又能
  // 以 ID 片段命中同族其他方法。结果是"交错DID"同时返回 did2s(别名 125)、did_static(片段 40)
  // 和 did_event_study_saturated(片段 40)：排序虽然正确，但 tool_search 的 limit 默认为 3，
  // 三个方法会被 pool.load() 一起装进方法窗口，模型手上凭空多出两个可直接调用的近似方法，
  // 正是三级披露要消除的"方法摇摆"。别名是产品维护的一对一精确映射，命中它就说明用户/模型
  // 说的是那一个方法，没有理由再把同族兄弟塞进来。
  const aliasHits = scored.filter((item) => item.aliasScore > 0)
  const pool = aliasHits.length > 0 ? aliasHits : scored

  return pool
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, Math.min(10, input.limit)))
    .map(({ index: _index, aliasScore: _aliasScore, ...item }) => item)
}

type ToolSearchCallback = (input: { query: string; limit: number }) => Promise<{
  matches: Array<{
      toolID: string
      description: string
      inputSchema?: unknown
      outputSchema?: unknown
      useWhen?: string
      doNotUseWhen?: string
      inputRequirements?: string[]
      diagnosticRequirements?: string[]
      descriptor?: UnifiedToolDescriptor
  }>
  loadedToolIDs: string[]
  blockedReason?: "visible_tool_budget_full" | "recommendation_only"
  /** 没有命中时给出的"当前阶段可加载方法"全量清单，让模型一轮内改用正确 ID，而不是换词再猜。 */
  availableToolIDs?: Array<{ toolID: string; description: string }>
}>

type ToolSearchMetadata = {
  loadedToolIDs: string[]
  matchCount: number
  blockedReason?: "visible_tool_budget_full" | "recommendation_only"
  availableCount?: number
  requiresUserDecision?: boolean
}

// tool 结果还会经过 Truncate.output（50KB 字节）和模型投影；给尾部说明留出空间，
// 这里按 UTF-8 字节而不是 JavaScript 字符数限制，中文 Schema 不会绕过上限。
export const MAX_RENDERED_TOOL_REFERENCE_BYTES = ToolResultProjection.TOOL_SEARCH_SCHEMA_MAX_INLINE_TOKENS

export function renderToolSchema(schema: unknown) {
  if (schema === undefined) return "未提供；下一轮仍会由执行端按方法 Schema 严格校验。"
  try {
    const serialized = JSON.stringify(schema)
    if (!serialized) return "未提供；下一轮仍会由执行端按方法 Schema 严格校验。"
    // Schema 是执行契约，不能删除嵌套约束；外层按完整方法块控制总字节数。
    return serialized
  } catch {
    return "未提供；下一轮仍会由执行端按方法 Schema 严格校验。"
  }
}

function singleLine(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
}

export const ToolSearchTool = Tool.define("tool_search", Tool.Execution.readOnlySerial, ToolModel.forTool("tool_search"), {
  description: "按方法 ID、明确中文方法名或方法族搜索 Python Registry。搜索结果会返回当前方法的完整参数 Schema、适用边界和诊断要求；先通过 analysis_prepare 校验规格与当前数据前提，随后仅凭其返回且仍有效的 specId 调用 econometrics_execute。系统工具始终直接可用，不需要搜索。",
  parameters: z.object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(240)
      .describe(
        "方法 ID、明确的常用中文方法名或方法族，例如 ols_regression、面板固定效应、普通最小二乘；Python Registry 只返回已登记方法。不要用它搜索文件或目录。",
      ),
    limit: z.number().int().min(1).max(10).default(3).describe("本次最多加载的具体计量方法数量，取值 1—10，默认 3；已加载方法可保留；窗口最多10个，容量不足时动态替换未受保护的旧方法。"),
  }),
  async execute(params, ctx) {
    const search = ctx.extra?.toolSearch as ToolSearchCallback | undefined
    if (!search) throw new Error("当前运行时没有提供延迟工具加载器")
    const result = await search(params)
    if (result.blockedReason === "visible_tool_budget_full") {
      return {
        title: "工具池已满",
        metadata: {
          loadedToolIDs: result.loadedToolIDs,
          matchCount: 0,
          blockedReason: result.blockedReason,
        } as ToolSearchMetadata,
        output: "当前 10 个方法槽位都被不可替换的已确认方法占用，无法自动替换。请使用当前已确认方法，或向用户说明需要切换哪一种方法；不要猜测隐藏工具。",
      }
    }
    if (result.blockedReason === "recommendation_only") {
      return {
        title: "当前仅讨论方法",
        metadata: { loadedToolIDs: [], matchCount: 0, blockedReason: result.blockedReason },
        output: "当前请求仅讨论或推荐方法，尚未授权执行估计。这不是数据导入或质量检查失败；请根据已有数据事实完成推荐，说明适用条件，等待用户采纳后再搜索并执行。不要为此重复导入或质检。",
      }
    }
    const lines = ["工具搜索结果："]
    const unsupportedDataOperation =
      !result.matches.length && /分箱|分位数分组|离散化|qcut|quantile\s*bin|binning/i.test(params.query)
    if (!result.matches.length) {
      // 返回空会让模型换个词再搜一轮，真实回放里出现过连续空搜耗尽修复预算。
      // 直接把"当前能加载的方法"全列出来，模型一轮内就能改用正确 ID。
      lines.push(`- 没有方法 ID 匹配“${singleLine(params.query)}”。`)
      const available = result.availableToolIDs ?? []
      if (available.length) {
        lines.push("当前阶段可加载的方法如下，请从中选定 ID 后重新搜索：")
        for (const item of available) lines.push(`  - ${item.toolID}：${singleLine(item.description)}`)
      } else if (unsupportedDataOperation) {
        lines.push(
          "当前已准入工具没有安全的分位数分箱/离散化方法。请让用户提供已分好组的分类列，或明确确认新增并验收该数据变换；不要用 create_column 猜阈值，也不要继续换关键词搜索。",
        )
      } else if (getExecutionMode() === "plan") {
        // Plan 模式下估计器可见性与 Auto 一致；真的一个候选都没有，说明当前阶段/意图确实还没解锁。
        // 但更常见的是模型只是想在计划里引用方法——别让它以为要去重推数据阶段。
        lines.push(
          "当前是 Plan 只读规划模式，且此刻没有可加载的计量方法。若只是要在方案里写明用哪个方法，" +
            "直接按系统提示词“计量方法索引”里的 ID 写进计划即可（如 panel_fe_regression、ols_regression），" +
            "并说明切到 Auto 后执行；不要反复搜索或重跑数据阶段。",
        )
      } else {
        lines.push(
          "当前搜索没有返回可加载的方法。空搜索结果不能证明数据前提不足；不要为此重复导入或质检。请说明方法目录或当前可用性限制；只有执行端明确返回数据前提缺失时才修复对应数据阶段。",
        )
      }
    } else {
      let renderedBytes = new TextEncoder().encode(lines[0]).length
      const omittedIDs: string[] = []
      for (const item of result.matches) {
        const inputSchemaText = renderToolSchema(item.inputSchema)
        const block = [
        `- 方法：${item.toolID}`,
        `  适用：${singleLine(item.description)}`,
        ...(item.useWhen ? [`  适用条件：${singleLine(item.useWhen)}`] : []),
        ...(item.doNotUseWhen ? [` 不能用于：${singleLine(item.doNotUseWhen)}`] : []),
        ...(item.inputRequirements?.length ? [` 运行前提：${singleLine(item.inputRequirements.join("；"))}`] : []),
        ...(item.diagnosticRequirements?.length ? [` 诊断要求：${singleLine(item.diagnosticRequirements.join("；"))}`] : []),
        `  参数 Schema：${inputSchemaText}`,
        `  返回 Schema：${renderToolSchema(item.outputSchema)}`,
      ]
        const blockBytes = new TextEncoder().encode(`${block.join("\n")}\n`).length
        if (renderedBytes + blockBytes > MAX_RENDERED_TOOL_REFERENCE_BYTES) {
          omittedIDs.push(item.toolID)
          continue
        }
        lines.push(...block)
        renderedBytes += blockBytes
      }
      if (omittedIDs.length) {
        lines.push(`- 其余方法的 Schema 因搜索结果大小上限未展开：${omittedIDs.join("、")}。下一轮动态方法引用会优先保留已加载项；仍需细节时重新搜索。`)
      }
    }
    return {
      title: result.loadedToolIDs.length ? `已加载 ${result.loadedToolIDs.length} 个计量方法引用` : "未加载计量方法",
      metadata: {
        loadedToolIDs: result.loadedToolIDs,
        matchCount: result.matches.length,
        availableCount: result.availableToolIDs?.length,
        ...(unsupportedDataOperation ? { requiresUserDecision: true } : {}),
      } as ToolSearchMetadata,
      output: [
        ...lines,
        "",
        result.loadedToolIDs.length
          ? `已加载：${result.loadedToolIDs.join("、")}。下一步先调用 analysis_prepare(requestId, methodID, arguments)；只有返回可执行 specId 后，才调用 econometrics_execute(specId)。不要把方法 ID 当作独立工具名调用。`
          : unsupportedDataOperation
            ? "当前搜索已停止在用户决策点；先补充分类列或确认数据变换方案，再继续多项 Logit。"
            : "请用上面清单中的方法 ID 重新搜索；系统工具无需搜索，直接使用当前目录即可。",
      ].join("\n"),
    }
  },
})
