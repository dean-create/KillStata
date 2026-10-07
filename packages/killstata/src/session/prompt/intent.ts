import type { InputGraphNode, WorkflowInputIntent } from "@/runtime/types"
import {
  MODEL_ADMITTED_ECONOMETRICS_DIAGNOSTIC_TOOL_IDS,
  MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS,
  MODEL_ADMITTED_PSM_ESTIMATOR_TOOL_IDS,
} from "@/runtime/econometrics-admission"
import { PromptInput } from "./types"
import {
  isInheritedAnalysisConfirmation,
  isNegatedWorkflowRequest,
  isSmallTalkOnly,
  isWorkflowConsultation,
  looksLikeConceptQuestion,
} from "@/runtime/input-intent"

/**
 * 数据准备/查看意图的统一词汇表（模块级唯一真相源）：
 *   - detectInputIntent 用它判 ingest；
 *   - hasPositiveDataIntent 用它判"部分否定"（见下）。
 * 两处共用同一正则，改词只需动这一处（此前 POSITIVE_DATA_INTENT 复制了一份，
 * 已出现 `数据清理`/`回到…` 漏词的漂移，2026-08-11 simplify 审查）。
 */
const DATA_PREP_INTENT =
  /数据质量|质量检查|质检|数据检查|检查数据|数据清洗|清洗数据|数据清理|清理数据|去重|重复(?:值|记录|观测|样本|行|项)|缺失值|空值|异常值|描述(?:性)?统计|统计描述|相关性|相关系数|相关分析|预处理|数据筛选|平衡面板|面板结构|数据画像|数据概览|数据摘要|撤销|回滚|退回|还原|回到(?:上一?个?)?(?:阶段|步骤|版本|状态)|导出|导成|输出成|保存为|存成|另存|筛掉|筛选|剔除|过滤|只保留|(?:看|查看|展示|显示|看看|瞧瞧)(?:一下|下)?(?:这?(?:份|个|张))?(?:数据|变量|分布|样本|缺失|相关)|数据长(?:什么|啥)样|有多少(?:行|列|条|个|样本|观测|变量)|变量(?:都)?有哪些|有哪些变量/

const STATUS_QUERY_CLAUSE = /^(?:请问|请|那)?(?:帮我)?(?:(?:看|查询)(?:一下|下)?)?(?:当前)?(?:进度|状态)(?:如何|怎么样|怎样)?$|^(?:跑完了吗|完成了吗|结果出来了吗|还在(?:运行|执行|分析)吗|现在到哪(?:一步)?了)$/iu

function isStatusOnlyQuery(text: string) {
  const clauses = text
    .split(/[，。；！？!?…]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
  return clauses.length > 0 && clauses.every((clause) => STATUS_QUERY_CLAUSE.test(clause))
}

/**
 * 正向数据操作意图：整句里是否存在"用户要做数据工作"的信号（导入/查看/清洗/质检/
 * 变量/缺失等）。用于区分"整体否定"（"不分析了"→conversation）与"部分否定"
 * （"帮我看数据，不用做回归"→主请求仍是数据工作，继续推进）。
 *
 * **刻意不含"回归/分析/计量"这类词**：它们正是被否定的常见对象（"不用做回归"），
 * 若算作正向信号，否定拦截永远失效。复用 DATA_PREP_INTENT 词汇 + 导入/变换词。
 */
export function hasPositiveDataIntent(text: string): boolean {
  return (
    DATA_PREP_INTENT.test(text) ||
    /导入|读取数据|上传数据|数据文件|(?:缩尾|截尾|中位数填补|标准化|对数变换|熵权|topsis|综合评价)/.test(text)
  )
}

/**
 * 输入意图识别：把用户这一轮的输入判成 conversation / ingest / analysis / …
 *
 * 判错的代价是不对称的——多暴露一个用不到的工具几乎无害，漏掉却会造成硬死锁
 * （见 2026-07-18 的 5/5 真实会话事故）。改这里的正则前先跑
 * `test/session/input-intent.test.ts`，它锁着历史事故案例。
 */

export function detectInputIntent(
  parts: PromptInput["parts"],
  explicitIntent?: WorkflowInputIntent,
  hasActiveDataset = false,
  analysisInProgress = false,
): WorkflowInputIntent {
  if (explicitIntent) return explicitIntent

  const text = parts
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "file" && !part.mime?.startsWith("image/")) {
        return [part.filename, part.url, part.source?.type === "file" ? part.source.path : ""].join(" ")
      }
      return ""
    })
    .join("\n")
    .toLowerCase()

  const explicitMethodComparison = /(?:比较|对比|分别|同时|两个都|都跑|都做)[^。！？\n]{0,30}(?:logit|probit|回归|模型)|(?:logit|probit)[\s\S]{0,40}(?:两个都|都跑|分别跑|同时跑|跑一下|跑一遍|执行|做一下|做一遍)/i.test(text)
  if (explicitMethodComparison) return "analysis"
  if (isWorkflowConsultation(text)) return "conversation"

  // 否定请求拦截（"别跑了""取消""不分析了"）→ conversation，避免推进工作流。
  // 但"不用做回归分析"这类**部分否定**（主请求仍是看数据/清洗，只是排除回归这一步）
  // 不能被误判成整体取消——否则用户"帮我看下数据、不用做回归"会落到空工具包，
  // 模型连 data_import 都看不到（2026-08-11 drive data-inspect-only 实测）。
  // 判定：整句存在正向数据操作意图（导入/查看/清洗/质检）时，"不用做 X"是范围限定，
  // 仍按正向意图推进；只有整句纯否定（无任何正向数据动词）才拦截。
  if (isNegatedWorkflowRequest(text) && !hasPositiveDataIntent(text)) return "conversation"

  // 只要当前会话已有数据，纯进度追问都走只读 status 工具包；不能把它绑定到
  // analysisInProgress。任务停在阻断/收尾阶段时该信号可能已变成 false，原实现会
  // 把“跑完了吗”降级成 ingest，模型随后重新质检甚至重启估计。
  if (hasActiveDataset && isStatusOnlyQuery(text)) return "status"

  if (/[?？]/.test(text) && /你能|可以|能否|会不会|什么是|是什么/.test(text)) return "conversation"

  // 方法推荐后的承接句是明确的执行授权，即使没有重复方法名也不能落到 ingest。
  // 否则“先推荐、再按你说的跑”会把估计器从本轮工具池收窄掉，模型只能反复查资料。
  if (hasActiveDataset && isInheritedAnalysisConfirmation(text)) return "analysis"

  // “probit 会不会更合适？两个都跑一下对比”这类多方法比较既包含咨询语气，
  // 又包含明确执行动作。不能因为前半句像问题就落到 conversation，否则第二个
  // 估计器不会进入工具池，用户看到的只是空白或重复读取上一轮结果。
  // 如果用户已经明确要做回归或计量分析，这是“导入 + 估计”的复合任务；
  // analysis 工具包会同时暴露 data_import 与 econometrics，避免导入后回归工具被延迟。
  if (
    /\b(regression|econometric|econometrics|panel_fe|auto_recommend|did|ols|2sls|iv|psm|rdd)\b/.test(text) ||
    /计量|回归|固定效应|面板|基准模型|双重差分|工具变量|倾向得分|控制变量|稳健性|再分析|重新回归|再估计/.test(text)
  )
    return "analysis"

  // 只有动词 + 已准入方法才进入分析工具包。泛泛的“清洗数据”仍走 ingest，
  // 而“你能不能做缩尾”已在 consultation 分支被截为 conversation，不会误执行。
  const EXPLICIT_DATA_METHOD_REQUEST =
    /(缩尾|截尾|中位数填补|z[ -]?score标准化|对数变换|熵权|topsis|综合(?:发展)?指数|综合评价).*(处理|执行|构建|计算|生成|做|跑)|(?:处理|执行|构建|计算|生成|做|跑).*(缩尾|截尾|中位数填补|z[ -]?score标准化|对数变换|熵权|topsis|综合(?:发展)?指数|综合评价)|把.*(?:缩尾|截尾|中位数填补|标准化|对数变换)/
  if (EXPLICIT_DATA_METHOD_REQUEST.test(text)) return "analysis"

  // Excel/CSV/DTA 这类原始表格输入必须先走 intake 阶段，避免模型跳过 data_import 直接回归。
  // 此外，data_import 的全部动作族（profile/validate/frequency/correlation/rollback/export）
  // 的自然语言都必须归入 ingest 以暴露 data_import——否则会落到 conversation（空工具包），
  // 模型想修数据 / 去重 / 撤销却无工具可用。这正是 2000-2022 面板"先做数据质量检查"触发
  // "工具调用失败"死锁的根因。查看类词汇一律锚定数据名词（数据/变量/分布/样本/缺失/相关），
  // 避免"看看这段话""看看这个模型"这类非数据请求被误判。
  if (
    parts.some((part) => part.type === "file" && !part.mime?.startsWith("image/")) ||
    /\.(xlsx|xls|csv|dta|sav)\b/.test(text) ||
    /\b(excel|spreadsheet|workbook|import|export|undo)\b/.test(text) ||
    /导入|读取数据|上传数据|数据文件/.test(text) ||
    DATA_PREP_INTENT.test(text)
  )
    return "ingest"

  // 分析已经在进行中（workflow 活跃阶段已越过 数据质量检查、进入分析链）时，后续推进性消息
  // （"怎么不动了""接着做""再跑一次"）几乎不含回归关键词，但它们延续的是同一个分析
  // 任务。若在此把意图降级到 ingest，estimator 会被 resolveToolAvailability 的
  // stage∩intent 收窄挡掉，造成"工具调用中途消失"死锁（2026-07-18，5/5 真实会话命中）。
  // 闲聊/概念咨询/否定已在前面拦成 conversation，故这里保底升到 analysis 是安全的：
  // analysis 是工具超集（含 data_import），最终仍由 stage 决定实际暴露的工具。
  if (analysisInProgress && !isSmallTalkOnly(text) && !looksLikeConceptQuestion(text)) return "analysis"

  // 上下文感知兜底：关键词白名单本质无法穷尽（"把那几个离群的弄掉""换一列再算一次"
  // 永远补不完）。但一旦数据集已经导入，用户几乎一定在谈这份数据——除非是纯寒暄/致谢/
  // 单字确认，或纯概念咨询问句（"什么是内生性""这个方法靠谱吗"），否则保底走 ingest
  // 放行 data_import。这样"数据在场 + 非闲聊"这个稳定信号取代了对措辞的穷举。
  // 安全性来自不对称：多暴露一个用不到的 data_import 几乎无害，漏掉它却会造成硬死锁。
  if (hasActiveDataset && !isSmallTalkOnly(text) && !looksLikeConceptQuestion(text)) return "ingest"

  // Small talk, questions, and unrelated short replies are a first-class mode.
  // They must not continue an unfinished empirical workflow.
  return "conversation"
}

/**
 * 从当前用户消息提取“明确的方法族”和“明确委派”线索，只用于收窄本轮工具池。
 * 无线索时返回空列表，由工作流阶段保留完整准入兜底，避免关键词漏判造成工具死锁。
 */
/**
 * file part 的 url 只在它是可读的路径引用时才算方法线索。
 *
 * 客户端（Desktop）以 data URL 内联附件，一个 3.8 MB 的 xlsx 会变成约 1.4 MB 的 base64。
 * 这段 base64 不含任何空白字符，直接喂给下面剥离文件引用的正则会触发灾难性回溯：
 * `[^\s，,;；、]*` 在每个起始位置贪婪吃掉剩余全部字符再回溯找 `.xlsx`，失败后右移一位
 * 重来，复杂度 O(n²)。实测 Core 会在此处 98% CPU 空转、永不返回，表现为"发送带数据的
 * 问题后界面一直转圈"。base64 内容本身也不是方法线索，且可能偶然含 "did"、"json"
 * 等子串造成误判——直接丢弃。
 */
const MAX_FILE_REFERENCE_LENGTH = 512
const PSM_EFFECT_ESTIMATOR_IDS = new Set(MODEL_ADMITTED_PSM_ESTIMATOR_TOOL_IDS)
const PSM_DIAGNOSTIC_TOOL_IDS = new Set(
  MODEL_ADMITTED_ECONOMETRICS_DIAGNOSTIC_TOOL_IDS.filter((toolID) => toolID.startsWith("psm_")),
)
const EXPLICIT_PSM_DIAGNOSTIC_ONLY_SCOPE = /(?:只|仅)\s*(?:做|进行|开展|执行|运行|查看|检查)\s*(?:(?:倾向得分|PSM)[^。！？!?\n]{0,24}(?:构造|诊断|可视化|分布|共同支撑)|[^。！？!?\n]{0,12}(?:倾向得分|PSM)[^。！？!?\n]{0,24}(?:构造|诊断|可视化|分布|共同支撑))/i

function psmScopeFilterFromText(text: string) {
  const column = "([A-Za-z_\\u4e00-\\u9fff][A-Za-z0-9_\\u4e00-\\u9fff]*)"
  const value = "(-?\\d+(?:\\.\\d+)?|[A-Za-z_\\u4e00-\\u9fff][A-Za-z0-9_\\u4e00-\\u9fff]*)"
  const patterns = [
    new RegExp(`(?:筛选|过滤|只保留)\\s*(?:按\\s*)?${column}\\s*(?:=|等于|为)\\s*${value}`, "iu"),
    new RegExp(`${column}\\s*(?:=|等于|为)\\s*${value}[^。！？!?\\n]{0,12}(?:筛选|过滤|只保留)`, "iu"),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (!match) continue
    const precedingText = text.slice(Math.max(0, match.index - 24), match.index)
    if (/(?:不要|别|勿|不允许|不需要|无需|先不|先别)[^。！？!?\\n]{0,8}$/.test(precedingText)) return undefined
    const numericValue = Number(match[2])
    return {
      column: match[1]!,
      value: Number.isFinite(numericValue) ? numericValue : match[2]!,
    }
  }
  return undefined
}

const MULTINOMIAL_LOGIT_MENTION = /多项(?:式)?\s*logit|多分类\s*logit|多项式逻辑回归|\bmultinomial(?:_logit)?\b/i

const REQUIRED_METHOD_MENTIONS = [
  { id: "ols_regression", label: "OLS 回归", pattern: /普通最小二乘(?:回归)?|\bols(?:回归)?\b|ols_regression/i },
  { id: "panel_fe_regression", label: "面板固定效应回归", pattern: /双向固定效应|面板固定效应(?:回归)?|固定效应面板回归|\bpanel[_ -]?fe(?:_regression)?\b/i },
  { id: "panel_random_effects", label: "面板随机效应回归", pattern: /随机效应(?:面板)?|\bpanel_random_effects\b|\brandom effects?\b/i },
  { id: "hdfe_regression", label: "高维固定效应回归", pattern: /高维固定效应|吸收固定效应|\bhdfe(?:_regression)?\b/i },
  { id: "iv_2sls", label: "两阶段最小二乘估计", pattern: /两阶段最小二乘|工具变量回归|\b2sls\b|\biv_2sls\b/i },
  { id: "iv_test", label: "工具变量诊断", pattern: /工具变量(?:强度|诊断|检验)|弱工具(?:检验|诊断)|内生性(?:检验|诊断)|过度识别(?:检验|诊断)|第一阶段(?:检验|诊断)|\biv_test\b/i },
  { id: "did_static", label: "传统双重差分估计", pattern: /传统双重差分|传统\s*(?:2\s*[×x]\s*2\s*)?did|静态\s*did|两组两期\s*did|\bdid_static\b/i },
  { id: "did2s", label: "两阶段 DID", pattern: /gardner\s*(?:两阶段\s*)?did|两阶段\s*did|交错\s*did|错位\s*did|\bdid2s\b/i },
  { id: "did_event_study_saturated", label: "事件研究估计", pattern: /事件研究|动态\s*did|\bdid_event_study_saturated\b/i },
  { id: "psm_construction", label: "倾向得分构造与诊断", pattern: /构造倾向得分|倾向得分构造|倾向得分诊断|倾向得分重叠|\bpsm\s*(?:倾向得分)?(?:构造)?诊断|\bpsm_construction\b/i },
  { id: "psm_visualize", label: "倾向得分分布与共同支撑图", pattern: /倾向得分分布|分布可视化|共同支撑图|\bpsm\s*(?:分布|可视化|分布图)|\bpsm_visualize\b/i },
  { id: "psm_matching", label: "倾向得分匹配", pattern: /倾向得分匹配|最近邻.{0,8}匹配|匹配估计|\bpsm_matching\b/i },
  { id: "psm_ipw", label: "倾向得分逆概率加权", pattern: /逆概率加权|\bipw\b|加权平均处理效应|\bpsm_ipw\b/i },
  { id: "psm_regression", label: "倾向得分回归调整", pattern: /倾向得分回归调整|倾向得分回归|\bpsm_regression\b/i },
  { id: "psm_double_robust", label: "AIPW 双重稳健估计", pattern: /双重稳健|\baipw\b|\bpsm_double_robust\b/i },
  { id: "logit_regression", label: "二元 Logit 回归", pattern: /二元\s*logit|\blogit(?:\s*回归|\s*分析)?\b|(?<!多项式)逻辑回归|\blogit_regression\b/i },
  { id: "probit_regression", label: "Probit 回归", pattern: /\bprobit\b|probit\s*回归|probit\s*模型|\bprobit_regression\b/i },
  { id: "poisson_regression", label: "Poisson/PPML 回归", pattern: /\bpoisson\b|泊松回归|\bppml\b|\bpoisson_regression\b/i },
  { id: "negbin_regression", label: "负二项回归", pattern: /负二项回归|negative\s*binomial(?:回归)?|\bnegbin_regression\b/i },
  { id: "quantile_regression", label: "分位数回归", pattern: /分位数回归|分位回归|\bquantile_regression\b/i },
  { id: "rdd_sharp", label: "锐性断点回归", pattern: /锐性断点(?:回归)?|sharp\s*rdd|\brdd_sharp\b/i },
  { id: "rdd_fuzzy", label: "模糊断点回归", pattern: /模糊断点(?:回归)?|fuzzy\s*rdd|\brdd_fuzzy\b/i },
  { id: "multinomial_logit", label: "多项 Logit 回归", pattern: MULTINOMIAL_LOGIT_MENTION },
  { id: "robust_regression", label: "M 估计稳健回归", pattern: /稳健回归|m估计回归|\brlm\b|\brobust_regression\b/i },
  { id: "wls_regression", label: "加权最小二乘回归", pattern: /加权最小二乘|\bwls\b|\bwls_regression\b/i },
  { id: "composite_evaluation", label: "熵权 TOPSIS 综合评价", pattern: /熵权(?:法)?\s*topsis|topsis(?:综合评价|综合排名)?|综合评价/i },
  { id: "heterogeneity_runner", label: "异质性分析扩展", pattern: /异质性(?:分析|检验|效应)|\bheterogeneity_runner\b|subgroup analysis/i },
] as const

const REQUIRED_METHOD_LABELS = new Map<string, string>(REQUIRED_METHOD_MENTIONS.map(({ id, label }) => [id, label]))

export function methodDisplayName(toolID: string) {
  if (toolID === "analysis_prepare") return "分析规格预检"
  return REQUIRED_METHOD_LABELS.get(toolID) ?? toolID
}

function fileReferenceHint(url: string) {
  if (url.startsWith("data:")) return ""
  return url.length > MAX_FILE_REFERENCE_LENGTH ? url.slice(0, MAX_FILE_REFERENCE_LENGTH) : url
}

function explicitlyRequestsMethodExecution(text: string, match: RegExpExecArray, methodID: string) {
  const before = text.slice(Math.max(0, match.index - 64), match.index)
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 128)
  const beforeClause = before.split(/[，,。！？?；;\n]|然后|接着|之后|同时|并且|但是|不过|然而|但|再|就|则|的话/).at(-1)?.trim() ?? ""
  const afterClause = after.split(/[，,。！？?；;\n]|然后|接着|之后|同时|并且|但是|不过|然而|但/)[0].trim()
  const action = /做|跑|运行|执行|进行|调用|估计|拟合|回归|用|使用|采用|构造|生成|绘制|画出|查看|检查|诊断|计算|匹配|评分|评估|复现|要求|run|fit|estimate|regress|execute|construct|plot/i
  const sequenceAction = /比较|对比|分别|同时|都(?:跑|做|执行|估计)|换成|换为|改成|改用|切换到/i
  const followupAction = /^\s*(?:(?:回归|估计|拟合|检验|诊断|分析).{0,10})?(?:再|然后|并且|同时)?\s*(?:做|跑|运行|执行|估计|拟合|使用|采用|构造|生成|绘制|检查|诊断|计算)/i
  const futureAuthorizedAction = /(?:等我|待我|等用户|待用户|等你|待你)[^。！？!?\n]{0,20}(?:确认|同意|授权)[^。！？!?\n]{0,16}(?:后|之后|再)[^。！？!?\n]{0,16}(?:做|运行|执行|估计|使用|采用|匹配|加权)\s*$/i.test(before)
  const actionInMethodAlias = /^(?:构造|生成|绘制|画出|查看|检查|诊断|计算|匹配|评分|评估)/i.test(match[0])
  const negativeCue = /(?:(?:不想|不希望|不打算|不准备|暂时不|不需要|没必要|不要求|不允许|不要|无需|不必|请勿|勿|不|暂不|先别|请别|你别|禁止|停止|取消)\s*(?:再)?(?:对|把|针对|继续|接着|做|跑|运行|执行|进行|调用|估计|拟合|回归|用|使用|采用|要求)?|(?:^|[\s，,。；;])别\s*(?:再)?(?:对|把|针对|继续|接着|做|跑|运行|执行|进行|调用|估计|拟合|回归|用|使用|采用|要求)?)\s*$/
  const psmDiagnostic = methodID === "psm_construction" || methodID === "psm_visualize"
  const excludesTreatmentEffect = (clause: string) => psmDiagnostic &&
    /^(?:暂不|先不|不|不要|无需|不需要)\s*估计\s*(?:ATT|ATE|平均处理效应|处理效应|因果效应|处理效果|因果效果)(?:\s*(?:\/|、|或)\s*(?:ATT|ATE|作因果结论|因果解释|因果效应|处理效应))*[。.!?？]?$/i.test(clause.trim())
  const trailingNegativeAction = after
    .split(/[，,。！？?；;\n]|然后|接着|之后|同时|并且|但是|不过|然而|但/)
    .slice(1)
    .some((clause) => {
      const normalized = clause.trim()
      // 限制结果的外推/解释范围不会撤销估计请求；明确的执行否定仍需生效。
      const inferenceLimitOnly = /^(?:不|不要|不能|不必|无需)\s*(?:再)?(?:用|使用|拿|以)[^。！？!?\n]{0,32}(?:推断|外推|代表|因果解释|因果结论)/i.test(normalized) &&
        !/(?:运行|执行|调用|估计|拟合|回归)/i.test(normalized)
      return !excludesTreatmentEffect(normalized) && !inferenceLimitOnly &&
        /^(?:不想|不希望|不打算|不准备|暂时不|不需要|没必要|不要求|不允许|不要|无需|不必|请勿|勿|不|先不要|先别|别|禁止|停止|取消)\s*(?:再)?(?:继续|接着|做|跑|运行|执行|进行|调用|估计|拟合|回归|用|使用|采用|构造|生成|绘制|画出|查看|检查|诊断|计算|匹配|评分|评估|复现|要求)/i.test(normalized)
    })
  const scopedNegationBeforeMethod = /(?:不想|不希望|不打算|不准备|暂时不|不需要|没必要|不要求|不允许|不要|无需|不必|请勿|勿|禁止|停止|取消)[^，,。！？?；;\n]{0,48}$/.test(beforeClause)
  const negated =
    negativeCue.test(beforeClause) ||
    scopedNegationBeforeMethod ||
    trailingNegativeAction ||
    /^\s*(?:不想|不希望|不打算|不准备|暂时不|不需要|没必要|不要求|不允许|不要|无需|不必|请勿|勿|不|别|暂不|先别|禁止|停止|取消)\s*(?:再)?(?:对|把|针对|继续|接着|做|跑|运行|执行|进行|调用|估计|拟合|回归|用|使用|采用|要求)?/.test(afterClause)
  const conceptualMethodComparison = /(?:比较|对比).{0,48}(?:方法|模型).{0,12}(?:的)?(?:区别|差异|优缺点|原理)|(?:比较|对比).{0,48}(?:哪种|哪个|何种).{0,8}(?:更适合|适用)/i.test(text)
  const explanationOnly = text
    .split(/[，,。！？!?；;\n]|但是|不过|然而|但|而是/)
    .some((clause) => /(?:只|仅)\s*(?:解释|介绍|说明)(?:一下)?[^。！？!?\n]{0,64}(?:方法|原理|适用条件)$/i.test(clause.trim()))
  const whyQuestion = /(?:为什么|为何)[^。！？!?\n]{0,80}(?:仍然|还(?:要|需要)?|需要|必要)[^。！？!?\n]{0,40}[?？]?$/.test(text.trim())
  const consultative =
    conceptualMethodComparison ||
    explanationOnly ||
    whyQuestion ||
    futureAuthorizedAction ||
    /(?:是否|是不是|要不要|能否|能不能|可不可以|可否|适不适合|如何|怎么|怎样|不知道|不确定|建议|推荐|适合|可行|哪个|哪种).{0,18}$/.test(beforeClause) ||
    /^\s*(?:(?:回归|估计|拟合|检验|诊断).{0,12})?(?:是否|是不是|要不要|能否|能不能|可不可以|可否|适不适合|如何|怎么|怎样|建议|推荐|适合|可行|哪个|哪种|是什么|吗|呢|[?？])/.test(afterClause)
  const continuationAction = /(?:继续|接着)\s*(?:(?:执行|估计|拟合|跑|做|运行|使用|采用)\s*)?$/i.test(beforeClause)

  return (action.test(beforeClause) || action.test(afterClause) || actionInMethodAlias || sequenceAction.test(beforeClause) || followupAction.test(afterClause) || continuationAction) &&
    !negated &&
    !consultative
}

export function detectToolFocus(parts: PromptInput["parts"]): Pick<
  import("@/runtime/types").ToolAvailabilityPolicy,
  "preferredToolIDs" | "requiredToolIDs" | "confirmedToolIDs" | "allowTask" | "psmToolScope" | "psmScopeFilter"
> {
  const rawText = parts
    .map((part) => (part.type === "text" ? part.text : part.type === "file" ? `${part.filename ?? ""} ${fileReferenceHint(part.url)}` : ""))
    .join("\n")
    .toLowerCase()
  // 数据文件名不是方法线索。真实 fixture 就叫 did.xlsx / rdd_sample.csv，而 `\bdid\b`
  // 在 "/tmp/killstata-drive/did.xlsx" 里被 `/` 和 `.` 界定成合法词边界，会把三个 DID
  // 估计器塞进本轮工具池，挤掉用户真正点名的方法（工具池有数量上限）。
  // 只在方法关键词匹配时剥掉文件引用；委派线索仍看原文。
  const text = rawText.replace(/[^\s，,;；、。！？!?]*\.(?:xlsx?|csv|dta|sav|parquet|json)\b[^\s，,;；、。！？!?]*/g, " ")
  // `did` 既是常见的文件/数据集标签，也可能是双重差分缩写。只有当它不在“did 数据”
  // 这类数据引用里时，才将其作为方法线索；否则一次“回到 did 数据，跑 OLS”会把三个
  // DID 方法塞满方法预算，把用户明确要求的 OLS 推到延迟目录（真实回切旅程，2026-08-26）。
  const methodText = text.replace(/\bdid\s*(?=(?:数据|data(?:set)?|文件|样本|表格?))/g, " ")
  const preferred = new Set<string>()
  const confirmed = new Set<string>()
  const add = (...ids: string[]) => ids.forEach((id) => preferred.add(id))
  const confirm = (...ids: string[]) => {
    ids.forEach((id) => {
      preferred.add(id)
      confirmed.add(id)
    })
  }

  if (/双重差分|事件研究|平行趋势|\b(?:did|did2s)\b/.test(methodText)) {
    add("did_static", "did2s", "did_event_study_saturated")
  }
  if (/交错|分期处理|错位实施|gardner|两阶段did|两阶段 did|相对时期|relative[- ]?time|动态处理效应|平均处理效应att|平均处理效应 att/i.test(text)) {
    confirm("did2s")
  }
  if (/饱和事件研究|事件研究动态效应/.test(text)) {
    confirm("did_event_study_saturated")
  }
  const psmIPW = /逆概率|inverse probability|\bipw\b/.test(text)
  const psmRegression = /回归调整|regression adjustment/.test(text)
  const psmDoubleRobust = /双重稳健|aipw|double robust/.test(text)
  if (psmDoubleRobust) add("psm_construction", "psm_double_robust")
  else if (psmIPW) add("psm_construction", "psm_ipw")
  else if (psmRegression) add("psm_construction", "psm_regression")
  else if (/倾向得分|倾向值|匹配估计|匹配方法|最近邻匹配|核匹配|\bpsm\b/.test(text)) {
    add("psm_construction", "psm_visualize", "psm_matching")
  }
  if (/工具变量|内生性|两阶段最小二乘|\b(?:iv|2sls)\b/.test(text)) add("iv_test", "iv_2sls")
  if (/断点回归|模糊断点|精确断点|\brdd\b/.test(text)) add("rdd_sharp", "rdd_fuzzy")
  if (/固定效应|面板固定|\bpanel[_ -]?fe\b/.test(text)) add("panel_fe_regression", "hdfe_regression")
  if (/随机效应|\brandom effects?\b/.test(text)) add("panel_random_effects")
  if (/负二项|\bnegative binomial\b/.test(text)) add("negbin_regression")
  if (/泊松|\bpoisson\b/.test(text)) add("poisson_regression")
  if (/分位数|\bquantile\b/.test(text)) add("quantile_regression")
  const binaryLogitText = text.replace(new RegExp(MULTINOMIAL_LOGIT_MENTION.source, "gi"), " ")
  if (binaryLogitText !== text || /多分类/.test(text)) add("multinomial_logit")
  if (/probit|概率单位/.test(text)) add("probit_regression")
  if (/(?:二元|二分类).*logit|\blogit\b/.test(binaryLogitText)) add("logit_regression")
  if (/稳健回归|\brobust regression\b/.test(text)) add("robust_regression")
  if (/加权最小二乘|\bwls\b/.test(text)) add("wls_regression")
  if (/普通最小二乘|\bols\b/.test(text)) add("ols_regression")

  // 只有明确的一对一方法别名才建立单方法完成门禁；泛 DID、泛 RDD 等歧义称呼不锁定估计器。
  // Python Registry 仍是方法 Schema 真相源；此处只保留自然语言任务焦点所需的明确别名。
  const requiredCandidates = REQUIRED_METHOD_MENTIONS.map(({ id, pattern }) => ({
    id,
    match: pattern.exec(text),
  }))
    .filter((candidate): candidate is typeof candidate & { match: RegExpExecArray } => candidate.match !== null)
    .sort((left, right) => left.match.index - right.match.index)
  const multinomialMention = requiredCandidates.find((candidate) => candidate.id === "multinomial_logit")
  const unambiguousRequiredCandidates = requiredCandidates.filter((candidate) =>
    candidate.id !== "logit_regression" ||
    !multinomialMention ||
    candidate.match.index < multinomialMention.match.index ||
    candidate.match.index >= multinomialMention.match.index + multinomialMention.match[0].length,
  )
  const explicitlyRequestedCandidates = unambiguousRequiredCandidates.filter((candidate) =>
    explicitlyRequestsMethodExecution(text, candidate.match, candidate.id),
  )
  const requiredToolIDs = explicitlyRequestedCandidates.map((candidate) => candidate.id)
  const psmMentioned = /(?:倾向得分|倾向值|\bpsm\b|\bipw\b|\baipw\b)/i.test(text)
  const psmDiagnosticRequested = explicitlyRequestedCandidates.some((candidate) => PSM_DIAGNOSTIC_TOOL_IDS.has(candidate.id))
  const psmEstimatorRequested = explicitlyRequestedCandidates.some((candidate) => PSM_EFFECT_ESTIMATOR_IDS.has(candidate.id))
  const psmExecutionDenied = /(?:不要|别|不允许|请勿|禁止)[^。！？!?\n]{0,24}(?:执行|调用|运行|使用)[^。！？!?\n]{0,20}(?:诊断工具|PSM|倾向得分)/i.test(text)
  const psmConsultative = /[?？]\s*$|(?:解释|说明|介绍)[^。！？!?\n]{0,60}(?:倾向得分|倾向值|PSM|诊断方法|方法|原理)/i.test(text)
  const psmAwaitingConsent = /(?:等我|待我|等用户|待用户|等你|待你)[^。！？!?\n]{0,24}(?:确认|同意|授权)[^。！？!?\n]{0,24}(?:后|之后|再)/i.test(text)
  const psmEffectExcluded = /(?:暂不|先不|不|不要|不需要|无需)[^。！？!?\n]{0,12}(?:估计|计算|报告|匹配|加权)?[^。！？!?\n]{0,12}(?:ATT|ATE|平均处理效应|处理效应|因果效应|因果效果)/i.test(text)
  const psmDiagnosticsOnly = !psmExecutionDenied && !psmConsultative &&
    (psmDiagnosticRequested || EXPLICIT_PSM_DIAGNOSTIC_ONLY_SCOPE.test(text)) &&
    !explicitlyRequestedCandidates.some((candidate) =>
      MODEL_ADMITTED_ECONOMETRICS_ESTIMATOR_TOOL_IDS.includes(candidate.id),
    )
  const psmToolsBlocked = !psmDiagnosticsOnly && psmMentioned && (
    psmExecutionDenied ||
    (psmConsultative && !psmDiagnosticRequested && !psmEstimatorRequested) ||
    (psmAwaitingConsent && !psmDiagnosticRequested) ||
    (psmEffectExcluded && !psmDiagnosticRequested)
  )
  const psmToolScope = psmDiagnosticsOnly ? "diagnostics_only" : psmToolsBlocked ? "blocked" : undefined
  const finalRequiredToolIDs = psmToolScope === "blocked"
    ? requiredToolIDs.filter((toolID) => !PSM_DIAGNOSTIC_TOOL_IDS.has(toolID) && !PSM_EFFECT_ESTIMATOR_IDS.has(toolID))
    : requiredToolIDs
  const psmScopeFilter = psmScopeFilterFromText(text)
  if (psmToolScope === "diagnostics_only") {
    for (const toolID of PSM_EFFECT_ESTIMATOR_IDS) preferred.delete(toolID)
  } else if (psmToolScope === "blocked") {
    for (const toolID of [...PSM_DIAGNOSTIC_TOOL_IDS, ...PSM_EFFECT_ESTIMATOR_IDS]) preferred.delete(toolID)
  }

  const delegationRequested = /子\s*agent|子代理|分头|委派|并行(?:调查|检查)/i.test(rawText)
  const delegationNegated = /(?:不要|不必|无需|别|禁止|勿)(?:再)?(?:使用|调用|让|启动)?\s*(?:子\s*agent|子代理|分头|委派)/i.test(rawText)

  return {
    preferredToolIDs: [...preferred],
    requiredToolIDs: finalRequiredToolIDs,
    confirmedToolIDs: [...confirmed],
    allowTask: delegationRequested && !delegationNegated,
    psmToolScope,
    psmScopeFilter,
  }
}

export function inputGraphFromParts(parts: PromptInput["parts"], intent?: WorkflowInputIntent): InputGraphNode[] {
  const graph: InputGraphNode[] = []
  if (intent) {
    graph.push({
      id: `intent:${intent}`,
      type: "command",
      label: intent,
      metadata: { intent },
    })
  }
  for (const part of parts) {
    if (part.type === "text") {
      const text = part.text.trim()
      if (!text) continue
      graph.push({
        id: part.id ?? `text:${graph.length}`,
        type: "text",
        label: text.length > 80 ? `${text.slice(0, 77)}...` : text,
      })
      continue
    }
    if (part.type === "file") {
      graph.push({
        id: part.id ?? `file:${graph.length}`,
        type: part.mime?.startsWith("image/") ? "image" : "file",
        label: part.filename,
        ref: part.url,
        mime: part.mime,
      })
    }
  }
  return graph
}
