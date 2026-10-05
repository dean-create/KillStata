import {
  duplicatePanelKeyMessage,
  displayStepLabel,
  isAnalysisTurn,
  wantsRawAnalysisDetail,
  type AnalysisToolPartLike,
} from "./analysis-user-view"
import { readToolAnalysisView } from "@/tool/analysis-user-view"
import { ProviderTransform } from "@/provider/transform"
import { isWorkflowConsultation } from "@/runtime/input-intent"

const LEGACY_ANALYSIS_FALLBACK_TEXT = "正在继续分析，稍后给出结果。"
const PARQUET_STAGE_FALLBACK_TEXT = "该文件是内部 Parquet 工作层，系统已自动改用结构化结果文件继续分析。"
const BINARY_FILE_FALLBACK_TEXT = "该文件是结构化二进制数据，系统已自动改用可读取的结果文件继续分析。"
const TOOL_UNAVAILABLE_FALLBACK_TEXT = "当前分析功能在本轮不可用，已停止执行；不会猜测或自动改用其他工具。"
const TOOL_INVALID_ARGS_FALLBACK_TEXT = "这一步的参数不符合要求，系统只会修正报错字段后重试当前调用。"

const NOISE_LINE_PATTERNS = [
  /^Thinking:/i,
  /^Let me /i,
  /^I need to /i,
  /^I'll /i,
  /^I will /i,
  /^Now I /i,
  /^Next,? I /i,
  /^我来帮您.*$/,
  /^首先让我.*$/,
  /^阶段[一二三四五六七八九十\d]+[：:].*$/,
  /^现在(创建|开始|运行|进行|更新|查看|完成|导入|执行|切换|读取|检查|生成).*$/,
  /^让我(修正|运行|查看|读取|检查|确认).*$/,
  /^根据您的指令.*$/,
  /^最后(查看|检查|整理|生成).*$/,
  /^\d+[.、]\s*(检查|导入|数据|筛选|使用|分析|执行).*$/,
  /^Called the Read tool with the following input:/i,
  /^Read tool failed to read .*$/i,
  /^Do not execute mutating tools\./i,
  /^Validate only the provided stage and artifacts\./i,
  /^You are a fresh-run verifier/i,
  /^你是 KillStata 的独立核验 Agent。?$/,
  /^不得执行修改性工具；只核验提供的阶段和产物。?$/,
  /^核验此工作流阶段。/,
  /^Audit this workflow stage\./i,
  /^Return only a JSON object inside/i,
  /^Exact statistical values are omitted here because .*$/i,
  /^Some statistical values were omitted/i,
  /^Unverified statistics omitted: .*$/i,
  /^This directional or significance claim is omitted because .*$/i,
  /^Model tried to call unavailable tool .*$/i,
  /^System\.Management\.Automation\.RemoteException$/i,
  /^Reused existing .* stage/i,
  /source file fingerprint is unchanged/i,
  /^(?:QA gate|数据质量检查) warning\(s\):/i,
  /^\[baseline-browser-mapping\].*$/i,
  /^.*workflow \[action=.*\]$/i,
  /^"artifactRefs":\s*\[$/i,
  /^"latestTrustedArtifacts":\s*\[$/i,
  /^"verifierReport":/i,
  /^"verifierEnvelope":/i,
  /^"workflowRunId":/i,
  /^"stageId":/i,
  /^"stageKind":/i,
  /^"replayInput":/i,
  /^"metadata":\s*\{/i,
  /^"instruction":/i,
  /^"qaGateStatus":/i,
  /^"qaGateReason":/i,
  /^"qaSource":/i,
  /^"deliveryBundleDir":/i,
  /^"publishedFiles":/i,
  /^"finalOutputsPath":/i,
  /^"internalFinalOutputsPath":/i,
  /^"presentation":\s*\{/i,
  /^"analysisView":\s*\{/i,
  /^"display":\s*\{/i,
  /^"truncated":/i,
  /^\(End of file - total/i,
  /^\(Output truncated at/i,
  /^Stata dataset is a structured binary format/i,
  /^Cannot read Stata dataset as text/i,
  /^Cannot read canonical parquet stage as text/i,
  /^Cannot read Excel workbook as text/i,
  /^不能将(?:规范 )?Parquet .*按文本读取[：:]/,
  /^不能将(?:Stata 数据集|Excel 工作簿|二进制数据文件)按文本读取[：:]/,
  /^Cannot read binary file/i,
  /^Excel workbook is a structured binary format/i,
  /^This file is the canonical working dataset/i,
  /^Do not use the read tool on canonical parquet/i,
  /^Recommended alternatives:/i,
  /^可用替代方式：/,
  /^Use datasetId\/stageId with data_import or econometrics instead\.$/i,
  /^- use data_import with action=/i,
  /^- use exported inspection/i,
  /^- use results\.json/i,
  /^- use datasetId\/stageId/i,
  /^- inspection CSV\/XLSX/i,
  /^- diagnostics\.json for/i,
  /^- model_metadata\.json for/i,
  /^- numeric_snapshot\.json for/i,
  /^<\/?[|｜]+\s*DSML\s*[|｜]+/i,
  /^<\/?tool_calls>/i,
  /^<\/?tool_call>/i,
  /^<\/?function=/i,
  /^<\/?parameter(?:=|>)/i,
  /^<\/?verifier_result>/i,
]

const INTERNAL_TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "data-readiness": "数据就绪检查",
  econometrics_recommend: "计量方法推荐",
  tool_search: "方法加载",
  data_import: "数据导入",
  data_preprocess: "数据预处理",
  econometrics_execute: "计量执行",
  ols_regression: "OLS回归",
  panel_fe_regression: "面板固定效应回归",
  panel_random_effects: "面板随机效应回归",
  hdfe_regression: "高维固定效应回归",
  did_static: "传统双重差分",
  did2s: "两阶段双重差分",
  did_event_study_saturated: "交错处理事件研究",
  iv_2sls: "工具变量回归",
  logit_regression: "Logit回归",
  probit_regression: "Probit回归",
  poisson_regression: "Poisson回归",
  negbin_regression: "负二项回归",
  quantile_regression: "分位数回归",
  rdd_sharp: "锐性断点回归",
  rdd_fuzzy: "模糊断点回归",
  multinomial_logit: "多分类Logit回归",
  robust_regression: "稳健回归",
  wls_regression: "加权最小二乘回归",
})

const ENGINE_INTERNAL_MARKERS = [
  "<file>",
  "Called the Read tool with the following input:",
  "Read tool failed to read ",
  "You are a fresh-run verifier for killstata.",
  "你是 KillStata 的独立核验 Agent。",
  "不得执行修改性工具；只核验提供的阶段和产物。",
  "Exact statistical values are omitted",
  "Unverified statistics omitted",
  "This directional or significance claim is omitted",
  "repeated_cross_section",
  "preTreatmentAggregation",
  "System.Management.Automation.RemoteException",
  "Model tried to call unavailable tool",
  ...Object.keys(INTERNAL_TOOL_DISPLAY_NAMES),
  "工作流核验",
  "verifier=",
  "可信产物",
  "[baseline-browser-mapping]",
  "Some statistical values were omitted",
  '"workflowRunId"',
  '"artifactRefs"',
  '"latestTrustedArtifacts"',
  '"replayInput"',
  '"stageKind"',
  '"qaGateStatus"',
  '"finalOutputsPath"',
  '"internalFinalOutputsPath"',
  '"presentation"',
  '"analysisView"',
  "Audit this workflow stage.",
  "Cannot read Stata dataset as text",
  "Cannot read canonical parquet stage as text",
  "Cannot read Excel workbook as text",
  "不能将规范 Parquet 数据阶段按文本读取：",
  "不能将Stata 数据集按文本读取：",
  "不能将Excel 工作簿按文本读取：",
  "Cannot read binary file",
  "Stata dataset is a structured binary format",
  "Use datasetId/stageId with data_import or econometrics instead.",
  "<| DSML |",
  "<tool_calls>",
  "<tool_call>",
  "<function=",
  "<parameter",
  "<verifier_result>",
  '"trustedArtifacts"',
  '"blockingFindings"',
  '"repairHints"',
]

function stripVerifierBlocks(text: string) {
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  let inVerifier = false
  let braceDepth = 0

  for (const line of lines) {
    if (!inVerifier && /<verifier_result>/i.test(line)) {
      inVerifier = !/<\/verifier_result>/i.test(line)
      braceDepth = 0
      continue
    }

    if (inVerifier && /<\/verifier_result>/i.test(line)) {
      inVerifier = false
      braceDepth = 0
      continue
    }

    if (
      !inVerifier &&
      (line.includes("You are a fresh-run verifier for killstata.") || line.includes("你是 KillStata 的独立核验 Agent。"))
    ) {
      inVerifier = true
      braceDepth = 0
      continue
    }

    if (inVerifier) {
      for (const ch of line) {
        if (ch === "{") braceDepth += 1
        if (ch === "}") braceDepth -= 1
      }
      if (braceDepth <= 0) inVerifier = false
      continue
    }

    kept.push(line)
  }

  return kept.join("\n")
}

function stripFileBodies(text: string) {
  return text.replace(/<file>[\s\S]*?<\/file>/g, "")
}

/**
 * 部分 OpenAI 兼容中转模型会把内部工具协议当作普通文本输出，并用 Minimax
 * 分隔符包住调用。该协议已经由 Harness 解析/执行，用户只应看到执行后的事实。
 */
function stripLegacyToolProtocol(text: string) {
  return text
    .replace(/\]<\]minimax\[>[\s\S]*?<\/tool_call>\s*/gi, "")
    .replace(/\]<\]minimax\[>/g, "")
}

// 兜底：模型若违反硬规则把内部工作区路径写进回复（如 …/.killstata/…/xxx.json），
// 把整条路径替换为中性描述，保证用户在任何渲染（TUI、转录导出）里都感知不到内部结构。
// 负后视断言：.killstata 前不能是字母/数字/下划线/反斜杠（避免误伤 foo.killstata/x 这类文件名），
// 但允许 /、空白、中文等——否则 packages/killstata/.killstata/… 这种模型转述形态会漏网。
// 两个实例分工明确：带 /g 的只给 replace（replace 每次从 0 开始，不受 lastIndex 影响），
// 不带 /g 的只给 test（共享 /g 实例做 test 会推进 lastIndex，交替调用必漏匹配）。
const INTERNAL_WORKSPACE_PATH_RE = /(?<![A-Za-z0-9_\\])(?:\.{0,2}[\\/])*\.killstata[\\/][^\s`"'，。；）】\]]*/
const INTERNAL_WORKSPACE_PATH_RE_G = new RegExp(INTERNAL_WORKSPACE_PATH_RE.source, "g")
const TEMP_WORKSPACE_PATH_RE = /\/(?:private\/)?(?:var\/folders|tmp|private\/tmp)\/[^\s`"'，。；）】\]]+/g
const INTERNAL_RUNTIME_IDENTIFIER_RE =
  /\b[a-z][a-z0-9-]{0,31}_[a-f0-9]{8}\b|\bstage_\d+(?:__[A-Za-z0-9_-]+)*\b|\bworkflow_[a-f0-9]{12}\b|\bchk_[a-f0-9]{12}\b|\bses_[A-Za-z0-9]{16,}\b|\brun_\d{8}-\d{6}(?:_[A-Za-z0-9]{6,})?\b/i
const INTERNAL_RUNTIME_FIELD_RE = /\b(?:sessionID|datasetId|stageId|runId|workflowRunId|checkpointId|canonicalDataStage|workflowState|covariates|covariance)\s*(?:[:=]|\/\s*(?:datasetId|stageId)\b)/i
const INTERNAL_RUNTIME_IDENTIFIER_RE_G = new RegExp(INTERNAL_RUNTIME_IDENTIFIER_RE.source, "g")

// 该正则无字面前缀可锚定（负后视 + 起始量词），引擎会逐位置回溯重试：实测 1KB 文本
// 单次 test 约 33µs，而这条路径在流式渲染里每个 delta 都要跑数次。`.killstata` 是任何
// 匹配的必要子串，用它做前置过滤零漏判，命中前的开销降到约 1/500。
function stripInternalWorkspacePaths(text: string) {
  let stripped = text
  if (stripped.includes(".killstata")) {
    stripped = stripped.replace(INTERNAL_WORKSPACE_PATH_RE_G, "分析结果文件（已保存）")
  }
  // drive/TUI 的隔离会话目录可能被模型从运行环境中读到；用户只需要知道文件名，
  // 不需要看到机器临时目录。只处理明确的临时根，避免误伤普通文本中的 URL 或变量值。
  return stripped.replace(TEMP_WORKSPACE_PATH_RE, (value) => value.split(/[\\/]/).filter(Boolean).pop() ?? "临时文件")
}

/** Provider 偶尔把 <think> 块作为普通文本流出；它不是用户请求的分析正文，必须在
 * 所有展示分支之前移除。未闭合的块也一并截断，避免流中断时泄漏半段内部推理。 */
function stripHiddenThinking(text: string) {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/think\s*>/gi, "")
}

function stripInternalRuntimeIdentifiers(text: string) {
  if (!INTERNAL_RUNTIME_IDENTIFIER_RE.test(text)) return text
  // ID 脱敏会留下“数据集 ，阶段 ，”这类空壳；必须在移除 ID 后再做一次
  // 语法清理，否则用户会看到内部结构被挖空后的半句话。
  return stripEmptyDisplayPathFragments(text.replace(INTERNAL_RUNTIME_IDENTIFIER_RE_G, ""))
}

function stripInternalRuntimeStatus(text: string) {
  return text
    .replace(
      /当前会话状态：没有任何活动的数据阶段或工作流状态。/g,
      "当前会话已取消，尚未产生可继续使用的数据或分析结果。",
    )
    .replace(/\b(?:datasetId|stageId|runId|workflowRunId|checkpointId|canonicalDataStage|workflowState)\s*[:=]\s*[^\s，。；;]*/gi, "")
    .replace(/[（(]\s*datasetId\s*\/\s*stageId[^）)]*[）)]/gi, "")
    .replace(/\bdatasetId\s*\/\s*stageId\b/gi, "")
    .replace(/(?:活跃)?stage\s*[:=]\s*[^\s，。；;]*/gi, "")
    .replace(/\bpreTreatmentAggregation\s*[:=]\s*[^\s，。；;）)]*/gi, "")
    .replace(/\bcovariates\s*[:=]\s*(?:空|\[\]|none|无)/gi, "未加入控制变量")
    .replace(/\bcovariance\s*[:=]\s*(HC1|CRV1|CRV3)/gi, "$1稳健标准误")
    .replace(/工作流状态\s*`?[^。\n]*(?:verifier|核验)[^。\n]*(?:。|(?=\n|$))/gi, "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      return !/^(?:[-*]\s*)?(?:会话ID|sessionID|规范化数据阶段|canonicalDataStage|工作流状态|workflowState|datasetId|stageId|runId|workflowRunId|checkpointId)\s*[:：=（(]/i.test(trimmed)
    })
    .join("\n")
}

/** 删除内部结构枚举名，但保留同一行中对用户有用的后续说明。 */
function stripInternalStructureLabels(text: string) {
  return text
    .replace(/(?:数据)?结构识别为重复截面\s*(?:[（(]\s*repeated_cross_section\s*[）)])?\s*[。.!！]?/gi, "")
    .replace(/[（(]\s*repeated_cross_section\s*[）)]/gi, "")
    .replace(/\brepeated_cross_section\b/gi, "")
}

/** 内部工具名只用于编排和诊断；用户看到的是对应的中文能力名称。 */
function localizeInternalToolNames(text: string) {
  let localized = text
  for (const [name, label] of Object.entries(INTERNAL_TOOL_DISPLAY_NAMES)) {
    localized = localized.replace(new RegExp(`\\b${name}\\b`, "gi"), label)
  }
  return localized
}

/** 把工作流内部状态改写成用户真正关心的结果状态。 */
function localizeInternalWorkflowStatus(text: string) {
  return text
    .replace(/\bSE\b/g, "标准误")
    .replace(/双重机器学习\s*[（(]\s*DML\s*[）)]|双重机器学习|\bDML\b/gi, "未加载的方法")
    .replace(/(?:工作流\s*)?\breporting\s*项?\s*待生成/gi, "正式报告尚未整理")
    .replace(/影响尚未评估执行/g, "影响尚未评估")
    .replace(/无线性依赖/g, "未发现完全线性依赖")
    .replace(/计量方法推荐\s*返回结构\s*[，,]?/g, "计量方法推荐结果，")
    .replace(
      /工作流显示估计节点已完成，verifier状态为warn（[^）]*）[^。\n]*(?:。|(?=\n|$))/g,
      "结果已生成；辅助核验有一条非阻断提示，不影响已交付结果。",
    )
    .replace(
      /Pipeline\s+verifier[^。\n]*结果报告[^。\n]*pending[^。\n]*(?:。|(?=\n|$))/gi,
      "结果已生成；辅助核验未完成，不影响已交付的估计结果。",
    )
    .replace(
      /内部清单里[“\"]?结果报告[”\"]?一项仍标记为pending，指正式产物化报告尚未生成；这不影响已在上一步交付的对话结果(?:。|(?=\n|$))/g,
      "估计结果已生成；如需正式报告文档，可另行整理。",
    )
    .replace(/工作流核验已完成（verifier=[^）]*）/g, "结果核验已完成，当前没有阻断性问题")
    .replace(
      /当前唯一标记为\s*pending\s*的是“结果报告”清单项，即正式的带依据报告文件尚未生成；这不影响上述已交付的估计结果。/gi,
      "估计结果已生成；如需正式报告文档，可另行整理。",
    )
    .replace(/\bverifier=(?:warn|pass|failed|error)\b/gi, "结果核验状态已记录")
    .replace(/可信产物\s*\d+\s*个/g, "已保存可核验结果")
}

/** 路径脱敏后若只剩“：/，”，清理空壳，避免把内部处理痕迹展示给用户。 */
function stripEmptyDisplayPathFragments(text: string) {
  return text
    .replace(/[，,]\s*[。．]/g, "。")
    .replace(/数据集\s*[:：]\s*``\s*[，,]\s*``\s*[，,；;]?\s*/g, "")
    .replace(/(?:\*\*)?数据集(?:\*\*)?\s*[:：]\s*``\s*\/\s*stage\s*``\s*/gi, "")
    .replace(/^\s*(?:[-*]\s*)?数据集\s*[:：]\s*[，,。；;]\s*$/gm, "")
    .replace(/当前\s*``\s*(?:中|里|内)\s*/g, "当前数据中")
    .replace(/（\s*[，,；;、]\s*）/g, "")
    .replace(/[（(]\s*\/\s*[）)]/g, "")
    .replace(/（\s*）/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/生成（\s*(\d+(?:\.\d+)?)\s*(行|列)\s*）/g, "生成了$1$2")
    .replace(/生成(?:了)?新阶段\s*[。．]/g, "生成了新的数据阶段。")
    .replace(/(数据(?:已)?导入|文件已导入|已导入数据)\s*[:：]\s*\/\s*(?=[，,。；;])/g, "$1")
    .replace(/数据集\s*[，,]\s*阶段\s*[，,]\s*/g, "")
    .replace(/数据集\s*(?:[，,]\s*)+(?=(?:阶段|工作表|文件|共|已|\d|$))/g, "")
    .replace(/数据集\s*[，,]\s*(?=(?:工作表|文件|共|已))/g, "")
    .replace(/(把)\s+的\s+/g, "$1规范化数据集的 ")
}

/** 模型恢复轮可能把被隐藏的字段值留下成粗体空字段或孤立项目符号；这些行
 * 没有任何事实，保留它们只会让用户误以为导入结果缺了一部分。 */
function stripEmptyDisplayRows(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim().replace(/^[-*+]\s*[，,、]\s*/, "")
      if (/^[-*+]\s*$/.test(trimmed)) return false
      // 只清理结构化展示字段，不能把“我来做稳健性检验：”这类自然语言计划
      // 当成空字段删除，否则会绕过咨询轮的“尚未执行”兜底。
      return !/^(?:[-*+]\s*)?(?:\*\*)?(?:数据集|数据文件|文件|导入状态|数据质量|面板键|规模|工作表|结果|当前状态)(?:\*\*)?\s*[:：]\s*(?:[，,。；;、]\s*)?$/i.test(trimmed)
    })
    .map((line) => line.replace(/^(\s*[-*+]\s*)[，,、]\s*/, "$1"))
    .join("\n")
}

/** 模型有时把内部编排过程写成“工具调用事实”清单。工具卡片和进度事件已经
 * 向用户展示过这些动作，分析正文只保留结果、质量事实和下一步，避免脱敏后的
 * dataset/stage 占位符再次形成空反引号或半截调用语法。 */
function stripInternalToolFactNarrative(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (/^(?:\*{0,2})(?:工具调用事实|已执行的\s*tool-call\s*事实|真实工具调用)[：:]?(?:\*{0,2})\s*$/i.test(trimmed)) return false
      if (/^\s*\d+[.)、]\s*(?:调用\s*)?`?(?:数据导入|数据预处理|计量方法推荐|工具搜索|econometrics_execute|tool_search)\s*\([^\n]*(?:→|->)/i.test(line)) return false
      if (/^(?:按要求先尝试用|我先尝试用|先尝试用).*调用\s*(?:profile|validate|frequency|correlation)\b/i.test(trimmed)) return false
      if (/(?:按错误反馈|阶段不存在).*(?:did_[A-Za-z0-9_-]+|stage_\d+)/i.test(trimmed)) return false
      return true
    })
    .join("\n")
    .replace(/``/g, "")
    .replace(/获取了规范化数据集\s*[，,]/g, "已完成数据画像，")
}

/** 组内 R² 是整体模型拟合度；不能把它改写成单个解释变量的解释比例。 */
function sanitizeUnsupportedFitAttribution(tools: AnalysisToolPartLike[], text: string) {
  const variableNames = new Set<string>(["该变量", "该解释变量", "核心解释变量"])
  for (const part of tools) {
    if (part.tool !== "panel_fe_regression" || part.state.status !== "completed") continue
    const treatmentVar = part.state.input?.treatmentVar
    if (typeof treatmentVar === "string" && treatmentVar.trim()) variableNames.add(treatmentVar.trim())
  }
  const names = [...variableNames]
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  if (!names.length) return text
  const pattern = new RegExp(`(?:${names.join("|")})\\s*解释了([^。\\n]{0,40}?的?)组内变异`, "g")
  return text.replace(pattern, "模型整体解释了$1组内变异")
}

/** 已有成功产物时，不能把同一轮较早的错误规格描述成“未产生结果”。 */
function sanitizeUnsupportedFailureClaims(tools: AnalysisToolPartLike[], text: string) {
  const completedPanelCalls = tools.filter((part) => {
    if (part.tool !== "panel_fe_regression" || part.state.status !== "completed") return false
    return typeof part.state.input?.entityVar === "string" && typeof part.state.input?.timeVar === "string"
  })
  const distinctSpecs = new Set(completedPanelCalls.map((part) => `${part.state.input?.entityVar}×${part.state.input?.timeVar}`))
  if (completedPanelCalls.length < 2 || distinctSpecs.size < 2) return text
  return text.replace(
    /第一次[^。\n]*(?:拒绝|失败)[^。\n]*(?:未产生|没有产生|未生成|没有生成)[^。\n]*[。；;]/g,
    "第一次尝试使用了规格错误的实体/时间设定，已由后续按更正后的设定替代。",
  )
}

/** QA 只提供统计事实；阻止模型把异常值来源或样本处理说成已确定结论。 */
function sanitizeUnsupportedQualityClaims(text: string) {
  return text
    .replace(
      /[^。\n]*(?:异常值|极端值|高z值)[^。\n]*(?:，|,)\s*(?:属于|是)(?:正常分布特征|正常分布)[^。\n]*(?:，|,)\s*(?:不影响|未影响)(?:本次|当前)?(?:结论|结果)[。．]?/gi,
      "异常值仅表示统计上偏离，不能仅凭此判断其现实来源；异常值对估计结果的影响尚未评估。",
    )
    .replace(
      /([^。\n]*(?:缩尾|winsorize|对数(?:变换|处理))[^。\n]*?)(?:降低|减弱|缓解|减少)[^。\n]*(?:异常值|极端值)[^。\n]*(?:影响|干扰)[^。\n]*[。．]?/gi,
      (_match, prefix: string) => `${prefix}但异常值对估计结果的影响尚未评估。`,
    )
    .replace(
      /((?:time列|time字段|处理时间)[^。\n]*?)(?:[，,]\s*)?(?:这)?(?:很可能|大概率|可能是)[^。\n]*[。．]?/gi,
      "$1。缺失原因和研究含义未由本次质检确定，需结合研究设计确认。",
    )
    .replace(/((?:time列|time字段|处理时间)[^。\n]*?)(?:可能与|可能因)[^。\n]*有关[^。\n]*[。．]?/gi, "$1。缺失原因和研究含义未由本次质检确定，需结合研究设计确认。")
    .replace(/(?:缺失情况|缺失信息)\s*[：:]\s*本次导入未显示(?:有)?严重缺失问题[。．]?/g, "")
    .replace(
      /[^。\n]*(?:异常值|极端值|高z值)[^。\n]*(?:很可能|大概率|很有可能)反映[^。\n]*(?:真实差异|规模差异|城市间)[^。\n]*[。．]?/gi,
      "不能仅凭统计异常推断其现实来源，需结合变量含义和诊断核实。",
    )
    .replace(/[^。\n]*(?:异常值|极端值|高z值)[^。\n]*可能(?:是|为)[^。\n]*[。．]?/gi, "不能仅凭统计异常推断其现实来源，需结合变量含义和诊断核实。")
    .replace(
      /（[^）]*(?:例如|比如)[^）]*(?:天然|真实差异|规模差异|城市间)[^）]*）/g,
      "",
    )
    .replace(
      /((?:异常值|极端值)[^。\n]{0,100}?)(?:未影响|不影响)(?:本次|当前)?(估计|回归)(?:结果|运行)?/g,
      (_match, prefix: string, operation: string) => `${prefix}未阻断本次${operation}执行，但对${operation}结果的影响尚未评估`,
    )
    .replace(
      /([^。\n]*(?:异常值|极端值|高z值)[^。\n]*?)(?:，|,)?\s*(?:但|因此)?\s*不影响(?:本次|本|当前)?(?:回归|估计)(?:的)?(?:核心变量|结果)?[。．]?/gi,
      (_match, prefix: string) => `${prefix}，未阻断本次回归执行，但异常值对估计结果的影响尚未评估。`,
    )
    .replace(
      /((?:这些列|这些变量|异常值列)[^。\n]{0,30}(?:未进入|未纳入)[^。\n]{0,20})(?:不影响|未影响)(?:本次|当前|本模型)?估计(?:结果)?([。．，,]?)/g,
      (_match, prefix: string, punctuation: string) =>
        `${prefix}未改变本次模型变量的直接计算，但遗漏变量影响仍未评估${punctuation === "，" || punctuation === "," ? "" : "。"}${punctuation}`,
    )
    .replace(
      /([^。\n]*(?:异常值|极端值|潜在异常值)[^。\n]*(?:未使用|未进入|未纳入)[^。\n]*?)(?:因此[，,]?\s*)?(?:不影响|未影响)(?:上述|本次|当前)?(?:(?:\d+|[一二两三四五六七八九十]+)个)?(?:回归|估计)(?:结果)?/gi,
      (_match, prefix: string) => `${prefix}未改变本次模型变量的直接计算，但异常值对估计结果的影响尚未评估`,
    )
    .replace(
      /异常值(?:为|是)结构性分布而非录入错误[。．]?/g,
      "异常值仅表示统计上偏离，不能仅凭此判断是结构性差异还是录入错误。",
    )
    .replace(
      /(?:这(?:些|些指标)|异常值列)大概率反映[^。\n]*(?:真实差距|真实差异)[^。\n]*[。．]?/g,
      "不能仅凭统计异常推断其现实来源，需结合变量含义和诊断核实。",
    )
    .replace(
      /[^。\n]*(?:异常值|极端值|高z值)[^。\n]*(?:可能反映|可能包含|也可能)[^。\n]*(?:真实|录入|规模|差异|误差)[^。\n]*[。．]?/gi,
      "不能仅凭统计异常推断其现实来源，需结合变量含义和诊断核实。",
    )
    .replace(
      /[^。\n]*(?:异常值|极端值|高z值)[^。\n]*(?:通常|一般|大多|多为)?(?:属于|是)[^。\n]*(?:真实|录入|结构性|规模|差异|错误)[^。\n]*(?:而非|不是|而不是)[^。\n]*[。．]?/gi,
      "不能仅凭统计异常推断其现实来源，需结合变量含义和诊断核实。",
    )
    .replace(
      /([^。\n]*(?:缺失|缺少|空值|NaN)[^。\n]*?)(?:按列表删除即可|可以忽略|可忽略)[。．]?/g,
      "$1是否删除、填补或保留需结合模型设定确认。",
    )
    .replace(
      /异常值[^。\n]{0,30}不代表(?:会|不会)影响(?:后续|本次|当前)?估计(?:结果)?[。．]?/gi,
      "异常值对估计结果的影响尚未评估。",
    )
}

/** 用户确认列名替换后，模型正文仍可能复述旧名称；以已完成结果中的系数标签校正角色说明。 */
function sanitizeConfirmedVariableRoleNames(tools: AnalysisToolPartLike[], text: string) {
  let sanitized = text
  for (const part of tools) {
    if (part.state.status !== "completed") continue
    const requested = typeof part.state.input?.treatmentVar === "string" ? part.state.input.treatmentVar.trim() : ""
    if (!requested) continue
    const view = readToolAnalysisView(part.state.metadata)
    const coefficient = view?.results?.find((item) => isCoefficientResultLabel(item.label) && !/^const\b/i.test(item.label))
    const actual = coefficient?.label.replace(/\s*(?:系数|coefficient)\s*$/i, "").trim()
    if (!actual || actual === requested || !sanitized.includes(requested)) continue
    const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const boundary = "(?![一-鿿A-Za-z0-9_])"
    sanitized = sanitized.replace(
      new RegExp(`((?:因变量|核心解释变量|解释变量|处理变量|自变量)\\s*[:：=]?\\s*)${escaped}${boundary}`, "g"),
      `$1${actual}`,
    )
    sanitized = sanitized.replace(
      new RegExp(`${escaped}(?=(?:的)?(?:系数|估计值?|效应))`, "g"),
      actual,
    )
  }
  return sanitized
}

/** RLM 的降权比例是诊断事实，不能单独推出“结果可靠/稳健”。 */
function sanitizeUnsupportedRobustClaims(tools: AnalysisToolPartLike[], text: string) {
  const hasCompletedRobustRegression = tools.some(
    (part) => part.tool === "robust_regression" && part.state.status === "completed",
  )
  // 文本片段可能先于工具窗口落盘；“降权观测/Huber/M估计”本身足以识别这类
  // RLM 结论，不能因为当前片段暂时没有工具状态而放行过度解读。
  if (!hasCompletedRobustRegression && !/(?:降权|Huber\s*M|M估计)/i.test(text)) return text

  return text
    .replace(
      /([^。\n]*(?:降权|权重)[^。\n]*)(?:说明|表明)[^。\n]*(异常值|极端值)[^。\n]*未主导([^。\n]*)[。．]?/gi,
      (_match, diagnosis: string, subject: string, target: string) => `${diagnosis.replace(/[，,]\s*$/, "")}。该降权诊断不能单独证明${subject}未主导${target}，仍需与 OLS 或其他设定比较。`,
    )
    .replace(
      /([^。\n]*(?:降权|权重)[^。\n]*)(?:说明|表明)[^。\n]*(?:异常值|极端值)[^。\n]*(?:干扰|影响)[^。\n]*(?:很小|不大|有限)[^。\n]*[。．]?/gi,
      (_match, diagnosis: string) => `${diagnosis.replace(/[，,]\s*$/, "")}。该降权诊断不能单独证明异常值影响有限，仍需与 OLS 或其他设定比较。`,
    )
    .replace(
      /((?:本次|当前)?[^。\n]*(?:Huber|M估计|稳健回归)[^。\n]*)结果稳健[。．]?/gi,
      (_match, statement: string) => `${statement.replace(/[，,]\s*$/, "")}。本次结果可作为稳健性对照，仍需与 OLS 或其他设定比较。`,
    )
}

/** 用户明确要求停下时，修正模型偶发的否定词反转，避免把停点写成继续执行。 */
function sanitizeContradictoryStopClaim(text: string, latestUserText?: string) {
  if (!latestUserText || !/(?:不要|不应|请勿)[^。\n]{0,40}(?:继续)?试错/.test(latestUserText) || !/停止|停下/.test(latestUserText)) {
    return text
  }
  return text.replace(/不停止(?:自动)?试错/g, "停止试错")
}

/** 没有控制变量时，明确说明遗漏变量影响尚未被本模型评估，避免把“未控制”读成“无影响”。 */
function addOmittedVariableDisclosure(text: string, tools: AnalysisToolPartLike[]) {
  if (/遗漏(?:变量|因素)[^。\n]{0,40}(?:未评估|未被[^。\n]{0,12}评估|影响|偏误)/.test(text)) return text
  const disclosure = "- 本次未纳入控制变量，遗漏变量影响未被本模型评估。"
  const sentence =
    text.match(/(?:本次|当前)?(?:未加入|未控制|没有|无)(?:任何)?控制变量[^。\n]*。?/) ??
    text.match(/未控制遗漏变量[^。\n]*。?/)
  if (sentence) return text.replace(sentence[0], `${sentence[0]}\n- 遗漏变量影响未被本模型评估。`)

  const hasExplicitNoCovariates = tools.some((part) => {
    if (part.state.status !== "completed" || !["ols_regression", "panel_fe_regression"].includes(part.tool)) {
      return false
    }
    return Array.isArray(part.state.input?.covariates) && part.state.input.covariates.length === 0
  })
  if (!hasExplicitNoCovariates) return text

  // 模型常在正文末尾追加“如需继续/请告知”的邀请。限制说明属于结果解读，
  // 应先于行动邀请出现，避免用户把它误读成上一段之后的无关尾注。
  const lines = text.split(/\r?\n/)
  const invitationIndex = lines.findIndex((line) =>
    /^(?:如需|若需|若要|如果(?:还)?需要)[^。\n]*(?:请告知|告诉我|可以继续|可继续)[。．]?\s*$/.test(line.trim()),
  )
  if (invitationIndex >= 0) {
    lines.splice(invitationIndex, 0, disclosure)
    return lines.join("\n")
  }
  return `${text}\n${disclosure}`
}

/** 历史版本可能已经追加过同一条限制；正文已有等价说明时删除独立重复行。 */
function stripRedundantOmittedVariableDisclosure(text: string) {
  const standalone = /^\s*[-*]?\s*遗漏变量影响未被本模型评估。?\s*$/
  const hasOtherDisclosure = text
    .split(/\r?\n/)
    .some((line) => !standalone.test(line) && /遗漏(?:变量|因素)[^。\n]{0,40}(?:未评估|未被[^。\n]{0,12}评估|影响|偏误)/.test(line))
  if (!hasOtherDisclosure) return text
  return text.split(/\r?\n/).filter((line) => !standalone.test(line)).join("\n")
}

function stripInternalGroundingPlaceholders(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      return !/^(?:(?:[-*]|\d+[.)、])\s*)?(?:未核验的精确统计数值已省略|未核验的统计量：.+|该方向或显著性表述与已核验结果不一致，已省略|部分统计(?:表述|数值)无法与(?:结果产物|已核验产物)(?:直接)?对应，已(?:不纳入本次结论|省略))。?$/.test(trimmed)
    })
    .join("\n")
}

/** 模型偶尔漏掉有序列表的第一项，直接从“2.”开始；仅在同一连续列表中归一编号，
 * 不处理代码围栏，避免把用户可复制的代码内容改写成另一段代码。 */
function normalizeOrphanedOrderedLists(text: string) {
  const lines = text.split(/\r?\n/)
  const result: string[] = []
  let inFence = false
  let inList = false
  let nextNumber = 1

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      inList = false
      result.push(line)
      continue
    }
    if (inFence) {
      result.push(line)
      continue
    }

    const match = line.match(/^(\s*)(\d+)([.)、])(\s+)(.*)$/)
    if (!match) {
      inList = false
      nextNumber = 1
      result.push(line)
      continue
    }

    if (!inList) {
      inList = true
      nextNumber = 1
    }
    result.push(`${match[1]}${nextNumber}${match[3]}${match[4]}${match[5]}`)
    nextNumber += 1
  }

  return result.join("\n")
}

function isInternalRuntimeStatus(text: string) {
  return INTERNAL_RUNTIME_FIELD_RE.test(text) || INTERNAL_RUNTIME_IDENTIFIER_RE.test(text)
}

function hasInternalWorkspacePath(text: string) {
  return text.includes(".killstata") && INTERNAL_WORKSPACE_PATH_RE.test(text)
}

function stripRawToolCallLines(text: string) {
  const kept: string[] = []
  let inToolCall = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (/^<tool_calls?>$/i.test(trimmed)) {
      inToolCall = !/^<\/tool_calls?>$/i.test(trimmed)
      continue
    }
    if (inToolCall) {
      if (/^<\/tool_calls?>$/i.test(trimmed)) inToolCall = false
      continue
    }
    if (/^<\/?[|｜]+\s*DSML\s*[|｜]+/i.test(trimmed)) continue
    kept.push(line)
  }
  return kept.join("\n")
}

const UNEXECUTED_CONVERSATION_PLAN_RE =
  /(?:\*{1,3})?(?:我来|让我(?:先)?|我先)(?:做|跑|执行)(?:几个(?:关键的)?|几项(?:关键的)?|一些(?:关键的)?|关键的)?稳健性检验|(?:至少|先)跑(?:几个关键的|三个|三项|一些)?稳健性检验/

/** 咨询轮没有执行工具时，不能把模型拟定的稳健性计划说成已开始。 */
function sanitizeUnexecutedConversationPlan(text: string, latestUserText: string | undefined, tools: AnalysisToolPartLike[]) {
  if (isAnalysisTurn(tools, latestUserText) || !latestUserText || !isWorkflowConsultation(latestUserText)) return text
  const marker = text.search(UNEXECUTED_CONVERSATION_PLAN_RE)
  if (marker < 0) return text
  const prefix = text.slice(0, marker).trim()
  return `${prefix ? `${prefix}\n\n` : ""}稳健性检验可以进行，但本轮尚未执行。请先选择具体方案；确认后我再按所选方案运行。`
}

function stripRawJsonBlocks(text: string) {
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  let inJson = false
  let braceDepth = 0
  let jsonBuffer: string[] = []

  const isJsonStart = (line: string) => {
    const trimmed = line.trim()
    return (
      trimmed === "{" ||
      trimmed.startsWith('{ "') ||
      trimmed.startsWith('{"') ||
      /^\{\s*"(workflowRunId|result|schema|variable_labels|quality|column_info|replayInput|metadata|stageId|artifactRefs)"/.test(
        trimmed,
      )
    )
  }

  for (const line of lines) {
    if (!inJson && isJsonStart(line)) {
      inJson = true
      braceDepth = 0
      jsonBuffer = []
    }

    if (inJson) {
      jsonBuffer.push(line)
      for (const ch of line) {
        if (ch === "{") braceDepth += 1
        if (ch === "}") braceDepth -= 1
      }

      if (braceDepth <= 0) {
        inJson = false
        if (jsonBuffer.length <= 5) {
          const content = jsonBuffer.join("\n")
          const hasInternalKeys =
            content.includes('"workflowRunId"') ||
            content.includes('"artifactRefs"') ||
            content.includes('"stageKind"') ||
            content.includes('"replayInput"') ||
            content.includes('"qaGateStatus"') ||
            content.includes('"presentation"') ||
            content.includes('"analysisView"')
          if (!hasInternalKeys) kept.push(...jsonBuffer)
        }
        jsonBuffer = []
      }
      continue
    }

    kept.push(line)
  }

  return kept.join("\n")
}

function stripNoiseLines(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (/^0{2,}\d+\|/.test(trimmed)) return false
      if (/^"([A-Za-z]:\\\\|\.\/{0,2})/.test(trimmed)) return false
      if (/^[A-Z]:\\[^ ]*$/.test(trimmed)) return false
      if (/^[\[\]{},]+$/.test(trimmed)) return false
      if (/^\d{4},/.test(trimmed) && (trimmed.match(/,/g) ?? []).length > 10) return false
      return !NOISE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))
    })
    .join("\n")
}

function collapseWhitespace(text: string) {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
}

/** 模型偶尔在内容生成前先吐出一个空标题；删除末尾空标题，保留已有正文，
 * 但不替模型编造缺失的结论。 */
function stripTrailingEmptyMarkdownHeadings(text: string) {
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop()
  while (lines.length > 0 && /^#{1,6}\s+\S.*$/.test(lines.at(-1)!.trim())) {
    lines.pop()
    while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop()
  }
  return lines.join("\n").trim()
}

/** 模型偶尔只生成一个限制标题、却没有对应内容；删除标题本身，避免用户看到空章节。 */
function stripEmptyPresentationHeadings(text: string) {
  return text
    .replace(/^\*\*需注意的限制\*\*\s*\n+(?=如需继续)/gm, "")
    .replace(/^\*\*[^\n]+\*\*\s*\n+(?=(?:下一步|需要(?:的话)?|如需继续))/gm, "")
    .replace(/^##\s*数据质量提示\s*\n+(?=(?:下一步|如需继续|##\s))/gim, "")
    .replace(/^##\s*结论与局限\s*\n+(?=下一步)/gim, "")
    .replace(/^\*\*[^*\n]+\*\*\s*\n+(?=(?:\*\*[^*\n]+\*\*|#{1,6}\s+))/gm, "")
    .replace(/^#{1,6}\s+[^\n]+\s*\n+(?=(?:#{1,6}\s+|下一步|如需继续))/gim, "")
}

const VERIFIED_COMPOSITE_KEY_RE = /verified:\s*combining '([^']+)' with column '([^']+)'/i

/**
 * 复合面板键是用户数据语义的重要事实，不能只留在工具错误或诊断产物里。
 * 模型有时能正确修复数据，却在最终报告中漏掉“没有删行”；从已验证的工具元数据/错误
 * 中提取事实，作为最终分析说明的最小兜底，避免用户误以为系统做了去重。
 */
function verifiedCompositeKeyDisclosure(tools: AnalysisToolPartLike[], text: string) {
  if (!/(?:结果|回归|估计|系数|样本|模型|R²|R2)/i.test(text) || /正在|准备|接下来|下一步/.test(text)) {
    return undefined
  }

  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const part = tools[index]
    const view = readToolAnalysisView(part.state.metadata)
    const candidates = [
      ...(view?.warnings ?? []),
      typeof part.state.error === "string" ? part.state.error : "",
    ]
    for (const candidate of candidates) {
      const match = candidate.match(VERIFIED_COMPOSITE_KEY_RE)
      if (!match) continue
      const [, entityVar, resolvingColumn] = match
      return `已核验：已用“${resolvingColumn}+${entityVar}”构造复合实体键，重复键已消失；本次保留全部观测，不会删除任何行。`
    }
  }
  return undefined
}

/** PSM 结果必须同时带有效样本/重叠/平衡门槛，不能只给一个 ATE 让用户误以为已完成因果核验。 */
function verifiedPsmDisclosure(tools: AnalysisToolPartLike[], text: string) {
  if (!/(?:ATE|倾向得分|IPW|AIPW)/i.test(text) || /SMD|平衡|共同支撑/.test(text)) return undefined

  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const part = tools[index]
    if (!/^psm_(?:regression|ipw|double_robust)$/.test(part.tool)) continue
    const view = readToolAnalysisView(part.state.metadata)
    const metric = view?.results?.find((item) => /SMD|平衡|共同支撑/.test(item.label))
    if (metric) return `已核验的PSM诊断：${metric.label}为${metric.value}；结果已通过工具的重叠、有效样本量与平衡性门槛。`
    if (view?.conclusion && /通过|达标/.test(view.conclusion)) return `已核验的PSM诊断：${view.conclusion}`
  }
  return undefined
}

/** 回归正文被 grounding 过度裁剪时，按已完成的估计器逐个恢复可信核心结果。 */
function verifiedRegressionDisclosures(tools: AnalysisToolPartLike[], text: string) {
  // 工具结果返回后，模型常先发送“接下来运行……”这类短进度。此时只保留进度本身，
  // 不把已核验摘要重复前置；只有文本已经包含结构化结果或完整报告信号时才补事实。
  const hasProgressCue = /接下来|下一步|正在|开始|先导入|先查看|准备运行|继续运行/.test(text)
  const hasStructuredResult = /(?:有效样本|样本量|系数\s*[=:：]|p\s*值\s*[=:：]|R²\s*[=:：]|结果如下|方法设定|模型设定)/i.test(text)
  if (hasProgressCue && !hasStructuredResult) return []

  const views = tools.flatMap((part) => {
    if (part.state.status !== "completed") return []
    const view = readToolAnalysisView(part.state.metadata)
    if (view?.kind !== "econometrics") return []
    const coefficients = view.results?.filter((item) => item.visibility !== "internal_only" && isCoefficientResultLabel(item.label)) ?? []
    if (!coefficients.length) return []
    if (view.step === "quantile_regression") {
      return coefficients.flatMap((coefficient, coefficientIndex) => {
        const tau = coefficient.label.match(/τ\s*=\s*([0-9]+(?:\.[0-9]+)?)/)?.[1]
        if (!tau) return []
        const belongsToTau = (item: { label: string }) => item.label.match(/τ\s*=\s*([0-9]+(?:\.[0-9]+)?)/)?.[1] === tau
        const pValue = view.results?.find((item) =>
          item.visibility !== "internal_only" && belongsToTau(item) && /p\s*值|p[- ]?value/i.test(item.label),
        )
        const supporting = view.results?.filter((item) =>
          item.visibility !== "internal_only" && (
            (belongsToTau(item) && /标准误|standard\s*error|95%.*(?:置信区间|CI)|confidence\s*interval/i.test(item.label)) ||
            (coefficientIndex === 0 && item.label === "N")
          ),
        ) ?? []
        return [{ view, coefficient, pValue, supporting }]
      })
    }
    const coefficient = coefficients[0]
    const pValue = view.results?.find((item) => item.visibility !== "internal_only" && /p\s*值|p[- ]?value/i.test(item.label))
    const supportingPattern = view.step === "robust_regression"
      ? /标准误|standard\s*error|M 估计函数|残差尺度|低权重观测|协方差|^N$/i
      : view.step === "logit_regression" || view.step === "probit_regression"
        ? /系数标准误|系数 95% 置信区间|平均边际效应|因变量 1 比例|McFadden 伪 R²|协方差|^N$/i
        : /标准误|standard\s*error|^N$|组内\s*R²|within\s*R²|\bR²\b|\bR2\b/i
    const supporting = view.results?.filter((item) =>
      item.visibility !== "internal_only" && supportingPattern.test(item.label),
    ) ?? []
    return [{ view, coefficient, pValue, supporting }]
  })
  const unique = views.filter((item, index) =>
    views.findIndex(
      (candidate) =>
        candidate.view.step === item.view.step &&
        candidate.coefficient.label === item.coefficient.label &&
        candidate.coefficient.value === item.coefficient.value,
    ) === index,
  )

  return unique.flatMap(({ view, coefficient, pValue, supporting }, index) => {
    // 模型已经在同一行给出该方法的核心系数时，不重复追加；但不能因为OLS已有
    // 一行结果就漏掉同一轮请求的Panel FE/RE等其他估计器。
    const term = coefficient.label.replace(/\s*(?:系数|coefficient)\s*$/i, "").trim()
    // 多个估计器的全文里经常共享 N、R² 或 p 值（尤其是相同样本），不能用全文
    // `includes` 判断某个方法是否已经报告了这些指标；只在该方法核心系数附近
    // 判断，避免用 OLS 的数字误充 Panel FE 的完整结果。
    // 同一系数可能在标题、表格和解释段落里出现多次；选择包含最多相关指标的
    // 窗口，而不是盲取最后一次出现，避免已写出的p值被再次补充。
    let evidenceWindow = ""
    let supportingEvidenceWindow = ""
    let bestEvidenceScore = -1
    let coefficientIndex = text.indexOf(coefficient.value)
    while (coefficientIndex >= 0) {
      const candidate = text.slice(Math.max(0, coefficientIndex - 240), coefficientIndex + 520)
      const candidateScore = [
        term,
        pValue?.value,
        ...supporting.map((item) => item.value),
      ].filter((value) => Boolean(value && candidate.includes(value))).length
      if (candidateScore > bestEvidenceScore) {
        bestEvidenceScore = candidateScore
        evidenceWindow = candidate
        supportingEvidenceWindow = text.slice(coefficientIndex, coefficientIndex + 520)
      }
      coefficientIndex = text.indexOf(coefficient.value, coefficientIndex + coefficient.value.length)
    }
    const corePresent = Boolean(
      term &&
      evidenceWindow.includes(term) &&
      hasExplicitCoefficientValue(evidenceWindow, term, coefficient.value),
    )
    // 支撑指标只能从核心系数之后的同一方法片段取证；窗口前部可能包含上一模型的
    // N/R²，不能因为数值相同就把它算给当前方法。
    const missingPValue = pValue && !supportingEvidenceWindow.includes(pValue.value) ? [pValue] : []
    const missingSupporting = supporting.filter((item) => !supportingEvidenceWindow.includes(item.value))
    if (corePresent && missingPValue.length === 0 && missingSupporting.length === 0) return []
    const methodLabel = displayStepLabel(view.step) ?? "计量回归"
    if (corePresent) {
      const supplement = `已核验的${methodLabel}补充：${[...missingPValue, ...missingSupporting].map((item) => `${item.label}=${item.value}`).join("，")}。`
      return text.includes(supplement) ? [] : [supplement]
    }
    const prefix = unique.length === 1 && index === 0 ? "已核验的核心回归结果" : `已核验的${methodLabel}结果`
    const missingCore = pValue && !evidenceWindow.includes(pValue.value) ? `，${pValue.label}=${pValue.value}` : ""
    const supportingText = missingSupporting.length
      ? `；${missingSupporting.map((item) => `${item.label}=${item.value}`).join("，")}`
      : ""
    return [`${prefix}：${coefficient.label}=${coefficient.value}${missingCore}${supportingText}。`]
  })
}

/** 对比句中的“0.8502 vs 0.8555”只是比较证据，不是某个方法的结构化系数行。 */
function hasExplicitCoefficientValue(window: string, term: string, value: string) {
  const escape = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const termPattern = escape(term)
  const valuePattern = escape(value)
  return new RegExp(
    `(?:${termPattern}\\s*)?(?:系数|估计(?:值)?)\\s*(?:=|:|：|为)\\s*${valuePattern}`,
  ).test(window)
}

function isCoefficientResultLabel(label: string) {
  return /系数|coefficient/i.test(label) && !/^系数项$|系数(?:项数|数量|个数)|number\s+of\s+coefficients/i.test(label)
}

function hasVerifiedRegressionEvidence(tools: AnalysisToolPartLike[]) {
  return tools.some((part) => {
    if (part.state.status !== "completed") return false
    const view = readToolAnalysisView(part.state.metadata)
    return view?.kind === "econometrics" && Boolean(view.results?.some((item) => item.visibility !== "internal_only" && isCoefficientResultLabel(item.label)))
  })
}

/** 面板结果必须明确展示实际执行的个体与时间列，避免模型用“地区和时间因素”泛化带过。 */
function verifiedPanelSpecDisclosure(tools: AnalysisToolPartLike[], text: string) {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const part = tools[index]
    if (part.tool !== "panel_fe_regression" || part.state.status !== "completed") continue
    const entityVar = typeof part.state.input?.entityVar === "string" ? part.state.input.entityVar.trim() : ""
    const timeVar = typeof part.state.input?.timeVar === "string" ? part.state.input.timeVar.trim() : ""
    if (!entityVar || !timeVar) continue
    const compact = text.replace(/\s/g, "")
    const entityMentioned = compact.includes(`实体=${entityVar}`) || compact.includes(`个体=${entityVar}`)
    const timeMentioned = compact.includes(`时间=${timeVar}`) || compact.includes(`时间变量=${timeVar}`) || compact.includes(`时间列=${timeVar}`)
    if (!entityMentioned || !timeMentioned) return `已核验的面板设定：实体=${entityVar}，时间=${timeVar}。`
    return undefined
  }
  return undefined
}

/**
 * 面板键中的列名是数据事实，不能把常见约定名（如 year）当成当前数据的真实列名。
 * 只在导入快照明确给出唯一时间列时做确定性改写；无法确定时保留原文，避免净化器
 * 自己替用户选择面板键。
 */
function sanitizeUnsupportedPanelKeyNames(tools: AnalysisToolPartLike[], text: string) {
  const timeVarsByEntity = new Map<string, Set<string>>()
  const verifiedPanelKeys = new Set<string>()
  for (const part of tools) {
    const view = readToolAnalysisView(part.state.metadata)
    for (const candidate of view?.panelCandidates ?? []) {
      verifiedPanelKeys.add(`${candidate.entityVars.join("+")}×${candidate.timeVar}`)
      for (const entityVar of candidate.entityVars) {
        const timeVars = timeVarsByEntity.get(entityVar) ?? new Set<string>()
        timeVars.add(candidate.timeVar)
        timeVarsByEntity.set(entityVar, timeVars)
      }
    }

    const rawVerifiedPanelKeys = part.state.metadata?.verifiedPanelKeys
    if (typeof rawVerifiedPanelKeys === "string") {
      for (const key of rawVerifiedPanelKeys.split("；")) {
        const separator = key.lastIndexOf("×")
        if (separator <= 0 || separator === key.length - 1) continue
        const entityVars = key.slice(0, separator).split("+").map((item) => item.trim()).filter(Boolean)
        const timeVar = key.slice(separator + 1).trim()
        verifiedPanelKeys.add(`${entityVars.join("+")}×${timeVar}`)
        for (const entityVar of entityVars) {
          const timeVars = timeVarsByEntity.get(entityVar) ?? new Set<string>()
          timeVars.add(timeVar)
          timeVarsByEntity.set(entityVar, timeVars)
        }
      }
    }
  }

  let sanitized = text
  const uniqueTimeVars = new Set<string>()
  for (const timeVars of timeVarsByEntity.values()) {
    for (const timeVar of timeVars) uniqueTimeVars.add(timeVar)
  }
  for (const [entityVar, timeVars] of timeVarsByEntity) {
    const timeVar = timeVars.size === 1 ? [...timeVars][0] : undefined
    if (!timeVar || timeVar.toLowerCase() === "year") continue
    const escapedEntity = entityVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(`${escapedEntity}\\s*[×x*]\\s*year\\b`, "gi")
    sanitized = sanitized.replace(pattern, `${entityVar}×${timeVar}`)
  }
  if (uniqueTimeVars.size === 1) {
    const timeVar = [...uniqueTimeVars][0]
    if (timeVar && timeVar.toLowerCase() !== "year") {
      sanitized = sanitized.replace(
        /((?:存在|含有?|包含|包括|列有)\s*)year\b/gi,
        `$1${timeVar}`,
      )
      // 只改写结构语境中的 year；用户原始变量名/提问内容不经过这条展示净化路径。
      sanitized = sanitized.replace(
        /\byear\s*(?=(?:标识|固定效应|时间列|时间变量|时期|结构|、|，|,|等))/gi,
        timeVar,
      )
    }
  }
  const preferredPanelKey = [...verifiedPanelKeys].find((key) => !key.slice(0, key.lastIndexOf("×")).includes("+"))
  if (preferredPanelKey) {
    const keyPattern = /[\u3400-\u9fffA-Za-z_][\u3400-\u9fffA-Za-z0-9_+]*\s*[×x*]\s*[\u3400-\u9fffA-Za-z_][\u3400-\u9fffA-Za-z0-9_]*/g
    sanitized = sanitized.split(/\r?\n/).map((line) => {
      if (!/(?:固定效应|面板键|面板结构|面板数据)/.test(line) || /(?:如果|若|错误|重复|不适用|不能)/.test(line)) return line
      return line.replace(keyPattern, (match) => {
        const normalized = match.replace(/\s/g, "").replace(/[x*]/g, "×")
        return verifiedPanelKeys.has(normalized) ? match : preferredPanelKey
      })
    }).join("\n")
  }
  // 模型有时把已核验键再次与时间列拼接，形成“地区×年份 × 年份”；
  // 这是展示重复，不是新的三维面板结构。
  sanitized = sanitized.replace(
    /([\u3400-\u9fffA-Za-z_][\u3400-\u9fffA-Za-z0-9_+]*?)\s*[×x*]\s*([\u3400-\u9fffA-Za-z_][\u3400-\u9fffA-Za-z0-9_]*)\s*[×x*]\s*\2/gi,
    "$1×$2",
  )
  return sanitized
}

/** 用户询问缺失/结构时，以导入阶段已核验的有界质量事实为准，纠正模型的否定复述。 */
function verifiedImportQualityDisclosure(tools: AnalysisToolPartLike[], text: string, latestUserText?: string) {
  if (!latestUserText || !/(?:缺失|质量|面板|结构|重复)/.test(latestUserText)) return undefined
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const part = tools[index]
    if (part.tool !== "data_import" || part.state.status !== "completed" || part.state.input?.action !== "import") continue
    const facts = readToolAnalysisView(part.state.metadata)?.qualityFacts
    if (!facts) return undefined
    const missingFact = facts.match(/缺失：[^；。]+/)?.[0]
    if (missingFact && text.includes(missingFact)) return undefined
    return facts
  }
  return undefined
}

/**
 * 已核验面板键存在时，修正模型把同一数据说成“重复截面”或把错误实体列带入
 * 固定效应建议的展示表述。只改用户文本，不改工具参数；没有结构证据时保持原文。
 */
function sanitizeUnsupportedStructureClaims(tools: AnalysisToolPartLike[], text: string) {
  let verifiedKey: string | undefined
  for (const part of tools) {
    const raw = part.state.metadata?.verifiedPanelKeys
    if (typeof raw === "string" && raw.trim()) {
      verifiedKey = raw.split("；").map((item) => item.trim()).find(Boolean)
      if (verifiedKey) break
    }
    const view = readToolAnalysisView(part.state.metadata)
    const candidate = view?.panelCandidates?.find((item) => item.entityVars.length > 0 && item.timeVar)
    if (candidate) {
      verifiedKey = `${candidate.entityVars.join("+")}×${candidate.timeVar}`
      break
    }
  }
  if (!verifiedKey) return text

  const separator = verifiedKey.lastIndexOf("×")
  const entity = separator > 0 ? verifiedKey.slice(0, separator) : undefined
  const time = separator > 0 ? verifiedKey.slice(separator + 1) : undefined
  let sanitized = text.replace(
    /数据结构\s*(?:为|是)\s*重复截面/gi,
    `数据结构为面板数据（已核验面板键：${verifiedKey}）`,
  )
  sanitized = sanitized.replace(
    /重复截面结构(?:\s*[（(][^）)]*[）)])?/gi,
    `面板数据（已核验面板键：${verifiedKey}）`,
  )
  sanitized = sanitized.replace(
    /(?:数据|时间)结构[^。\n]{0,20}重复截面(?:特征|数据)?/gi,
    `数据结构为面板数据（已核验面板键：${verifiedKey}）`,
  )
  // OLS 报告有时把“横截面/合并面板”混写成一种不确定的数据结构。
  // 已有面板键证据时，明确说明本次 OLS 没有吸收固定效应，避免用户误解估计对象。
  sanitized = sanitized.replace(
    /(?:横截面\s*\/\s*合并面板结构|横截面结构|合并面板结构)[^。\n]{0,20}为均值效应估计(?:[，,]?\s*不宣称因果识别)?/gi,
    `OLS未吸收已核验的面板固定效应（${verifiedKey}），结果仅表示样本内统计相关关系，不作因果识别解释`,
  )
  sanitized = sanitized.replace(
    /横截面\s*\/\s*合并面板回归/gi,
    `合并面板OLS（未吸收已核验的面板固定效应：${verifiedKey}）`,
  )
  sanitized = sanitized.replace(
    /横截面\s*\/\s*合并面板(?:基准)?(?:均值)?(?:模型|回归)/gi,
    `合并面板OLS（未吸收已核验的面板固定效应：${verifiedKey}）`,
  )
  sanitized = sanitized.replace(/(?:若|如果)数据为面板结构/gi, "数据已核验为面板结构")
  if (entity === "地区" && time === "year") {
    sanitized = sanitized.replace(/省份固定效应/g, "地区固定效应")
    sanitized = sanitized.replace(/年份固定效应/g, "year固定效应")
  }
  return sanitized
}

/**
 * 完全线性依赖是已核验的数据事实，不应只靠模型记住提示词。
 * 如果下一步建议把依赖关系中的分项直接加入控制变量，改成研究设计确认点；
 * 这里只改用户展示文本，不自动替用户删除、保留或替换变量。
 */
function sanitizeCollinearControlRecommendations(tools: AnalysisToolPartLike[], text: string) {
  const relations: Array<{ columns: string[]; relation: string }> = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || !value || typeof value !== "object") return
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1))
      return
    }
    const record = value as Record<string, unknown>
    const dependencies = record.exactLinearDependencies
    if (Array.isArray(dependencies)) {
      for (const dependency of dependencies) {
        if (!dependency || typeof dependency !== "object") continue
        const item = dependency as Record<string, unknown>
        const columns = Array.isArray(item.columns)
          ? item.columns.filter((column): column is string => typeof column === "string" && column.trim().length > 0)
          : []
        const relation = typeof item.relation === "string" ? item.relation.trim() : ""
        if (columns.length >= 2) relations.push({ columns, relation: relation || columns.join("、") })
      }
    }
    Object.values(record).forEach((nested) => visit(nested, depth + 1))
  }
  for (const part of tools) {
    if (part.state.status === "completed") visit(part.state.metadata, 0)
  }
  const unique = new Map<string, { columns: string[]; relation: string }>()
  relations.forEach((relation) => unique.set(relation.columns.slice().sort().join("\u0000"), relation))
  if (unique.size === 0) return text

  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!/(?:加入|增加|纳入)控制变量/.test(line)) return line
      const dependency = [...unique.values()].find((item) => item.columns.some((column) => line.includes(column)))
      if (!dependency) return line
      const prefix = line.match(/^(\s*[-*]\s*)/)?.[1] ?? ""
      return `${prefix}当前数据存在已核验完全线性依赖（${dependency.relation}），不能直接把相关分项加入同一模型；如需扩展规格，请先确认保留或替换哪一项。`
    })
    .map((line) => {
      if (!/(?:同时引入|同时纳入)[^。\n]*(?:之一|任一)/.test(line)) return line
      const dependency = [...unique.values()].find((item) => item.columns.filter((column) => line.includes(column)).length >= 2)
      if (!dependency) return line
      const prefix = line.match(/^(\s*[-*]\s*)/)?.[1] ?? ""
      const remainder = dependency.columns.length - 1
      const remainderText = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][remainder] ?? String(remainder)
      const dependencyGroup = `同时纳入${dependency.columns[0]}与其余${remainderText}个子项`
      return `${prefix}已核验完全线性依赖（${dependency.relation}）：${dependencyGroup}时才会形成该完全共线，单独加入一个分项不能据此判为不可用；如需扩展规格，请先确认变量取舍。`
    })
    .join("\n")
}

/** OLS/Panel FE 本身不提供因果识别；没有DID、IV、RDD或PSM证据时，收紧“效应”措辞。 */
function sanitizeUnverifiedCausalClaims(tools: AnalysisToolPartLike[], text: string) {
  const completed = tools.filter((part) => part.state.status === "completed")
  const hasObservationalRegression = completed.some((part) =>
    ["ols_regression", "panel_fe_regression", "panel_random_effects", "robust_regression", "quantile_regression"].includes(part.tool),
  )
  const hasIdentificationMethod = completed.some((part) =>
    ["did_static", "did2s", "did_event_study_saturated", "iv_2sls", "rdd_sharp", "rdd_fuzzy", "psm_matching", "psm_ipw", "psm_regression", "psm_double_robust"].includes(part.tool),
  )
  if (!hasObservationalRegression || hasIdentificationMethod) return text
  return text
    .replace(/识别更接近因果|更接近因果识别/g, "不能单独视为因果识别")
    .replace(/更干净的因果识别/g, "更充分地控制面板结构差异")
    .replace(/控制([^，。；;）)]{1,60})后\s*无遗漏变量偏误/g, "控制$1后仍不能据此排除遗漏变量偏误")
    .replace(/无遗漏变量偏误/g, "不能据此排除遗漏变量偏误")
    .replace(/正向效应/g, "正向统计关系")
    .replace(/负向效应/g, "负向统计关系")
}

/** 相关回归不能检验“某变量被综合指标吸收”或“变异来自某种来源”等机制解释。 */
function sanitizeUnsupportedMechanismClaims(text: string) {
  return text.replace(
    /可能因为[^。\n]*(?:综合指标|吸收|变异主要来自)[^。\n]*。?/g,
    "该可能原因未由本模型检验，不能据此下结论。",
  )
}

/** 模型偶尔把 p<0.001 误写成“高于0.001显著性水平”；只在同一行有已报告的低 p 值时纠正这类统计语义。 */
function sanitizeMisstatedPValueSignificance(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!/p\s*(?:值)?\s*(?:<|≤)\s*0\.001/i.test(line)) return line
      return line.replace(
        /(?:远|明显|显著)?高于(?:常规的|通常的|常用的)?\s*0\.001\s*(?:的)?显著性水平/g,
        "在1%显著性水平上显著",
      )
    })
    .join("\n")
}

function removeSupersededGroundingPlaceholders(text: string, hasVerifiedRegression: boolean) {
  if (!hasVerifiedRegression) return text
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (/^(?:(?:[-*]|\d+[.)、])\s*)?该方向或显著性表述与已核验结果不一致，已省略。$/.test(trimmed)) return false
      if (/^(?:(?:[-*]|\d+[.)、])\s*)?未核验的精确统计数值已省略。$/.test(trimmed)) return false
      if (/^(?:(?:[-*]|\d+[.)、])\s*)?未核验的统计量：.+$/.test(trimmed)) return false
      if (/^(?:(?:[-*]|\d+[.)、])\s*)?部分统计(?:表述|数值)无法与(?:结果产物|已核验产物)(?:直接)?对应，已(?:不纳入本次结论|省略)。$/.test(trimmed)) return false
      return true
    })
    .join("\n")
}

/** 模型可能先复述完整核验摘要，又追加一条同方法的单指标补充；完整摘要已覆盖时，
 * 删除这条冗余行，避免多段文本净化后出现重复 p 值或标准误。 */
function stripRedundantRegressionSupplements(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.trim().match(/^已核验的(.+?回归)补充：(.+)。$/)
      if (!match) return true
      // 只清理已被完整摘要覆盖的单一 p 值补充；包含标准误、N、R²等额外
      // 信息的补充可能正是我们为模型漏写字段生成的，不能一并删除。
      if (!/^p\s*值\s*=/i.test(match[2].trim())) return true
      const fullPrefix = `已核验的${match[1]}结果：`
      const hasAnyVerifiedResult = /已核验的(?:核心回归结果|.+回归结果)：/.test(text)
      return !(hasAnyVerifiedResult && text.includes(match[2]))
    })
    .join("\n")
}

function verifiedImportSheetDisclosure(tools: AnalysisToolPartLike[], text: string) {
  if (!/(?:导入|画像|检查|数据集)/.test(text) || /工作表|Sheet/i.test(text)) return undefined

  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const part = tools[index]
    if (part.tool !== "data_import" || part.state.input?.action !== "import") continue
    const metadataResult = part.state.metadata?.result
    const sheetInfo =
      metadataResult && typeof metadataResult === "object" && !Array.isArray(metadataResult)
        ? (metadataResult as { sheet_info?: { selected?: unknown } }).sheet_info
        : undefined
    const selectedFromResult = typeof sheetInfo?.selected === "string" ? sheetInfo.selected.trim() : ""
    const policy = part.state.input?.sheetPolicy
    const selectedFromInput =
      policy && typeof policy === "object" && !Array.isArray(policy) && typeof (policy as { sheetName?: unknown }).sheetName === "string"
        ? String((policy as { sheetName: string }).sheetName).trim()
        : ""
    const selected = selectedFromResult || selectedFromInput
    if (selected) return `已确认工作表：“${selected}”（本次导入）。`
  }
  return undefined
}

/** 多数据集会话中，最终结果必须能追溯到用户实际导入的文件；只补文件名，不补内部路径。 */
function verifiedImportFileDisclosure(tools: AnalysisToolPartLike[], text: string) {
  if (!/(?:导入|回归|估计|结果|分析|数据)/.test(text) || /数据\s*[:：]/.test(text)) return undefined

  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const part = tools[index]
    if (part.tool !== "data_import" || part.state.input?.action !== "import") continue
    const file = readToolAnalysisView(part.state.metadata)?.foundInputFile
    if (file) return `数据：${file}`
  }
  return undefined
}

/** 用户明确询问变量时，不能只交付工具摘要里恰好被模型复述的前几列；
 * 从导入阶段的已核验列名补齐清单，不读取原始数据，也不猜测变量含义。 */
function verifiedImportVariableDisclosure(tools: AnalysisToolPartLike[], text: string, latestUserText?: string) {
  if (!latestUserText || !/(?:有哪些|列出|变量名|变量列表|变量清单)/.test(latestUserText)) return undefined
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const part = tools[index]
    if (part.tool !== "data_import" || part.state.status !== "completed" || part.state.input?.action !== "import") continue
    const variables = readToolAnalysisView(part.state.metadata)?.variables ?? []
    if (variables.length === 0 || variables.every((variable) => text.includes(variable))) return undefined
    return `变量：${variables.join("、")}`
  }
  return undefined
}

/** 用户同时询问行数/列数时，从导入分析视图补齐规模，避免变量清单兜底覆盖规模事实。 */
function verifiedImportScaleDisclosure(tools: AnalysisToolPartLike[], latestUserText?: string) {
  if (!latestUserText || !/(?:多少行|多少列|几行|几列|规模)/.test(latestUserText)) return undefined
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const part = tools[index]
    if (part.tool !== "data_import" || part.state.status !== "completed" || part.state.input?.action !== "import") continue
    const view = readToolAnalysisView(part.state.metadata)
    const rows = view?.results?.find((item) => /行数/.test(item.label))?.value.match(/\d[\d,]*/g)?.at(-1)
    const columns = view?.results?.find((item) => /列数/.test(item.label))?.value.match(/\d[\d,]*/g)?.at(-1)
    if (!rows || !columns) return undefined
    return `数据规模：${rows.replace(/,/g, "")}行×${columns.replace(/,/g, "")}列`
  }
  return undefined
}

function datasetReturnDisclosure(text: string, latestUserText?: string) {
  if (
    !latestUserText ||
    !/回到第一份\s*did|回切.*did|第一份.*数据.*继续/i.test(latestUserText) ||
    /回到第一份\s*did|复用.*did|未重新导入/.test(text)
  ) {
    return undefined
  }
  if (!/(?:结果|回归|估计|系数|样本|OLS)/i.test(text)) return undefined
  return "已回到第一份 did 数据，复用已有数据阶段，未重新导入。"
}

function fallbackMessagesForInternalErrors(text: string) {
  const messages: string[] = []

  if (/insufficient balance|insufficient funds|insufficient_quota|out of credits|no credits|quota exceeded|exceeded your current quota|余额不足|额度不足|配额不足|账户欠费|充值/i.test(text)) {
    messages.push(ProviderTransform.BALANCE_OR_QUOTA_ERROR_MESSAGE)
  } else if (/传统\s*(?:2[×x*]2\s*)?DID[^。\n]*(?:四个样本单元|四格样本结构)/i.test(text)) {
    messages.push("当前数据不满足传统 2×2 DID 所需的四格样本结构，已停止自动重试；请确认研究设计，或提供适用于交错处理的相对时期变量。")
  } else if (/Auto recommendation profiling failed/i.test(text)) {
    messages.push("自动推荐未完成，未生成计量方案。请重试当前任务。")
  } else if (/RESULT_(?:CONTRACT|LINEAGE|NONFINITE|PATH)(?:_?(?:INVALID|MISMATCH|MISSING))?|CLAIM_CEILING_BLOCKED/i.test(text)) {
    messages.push("本次分析结果未通过完整性校验，系统没有把它当作成功结果。请重新提交任务；如果持续出现，说明后端或产物血缘需要检查。")
  } else if (/Traceback \(most recent call last\)|\bFile "[^"]+\.py", line \d+/i.test(text)) {
    messages.push("分析未完成，未生成可用结果。请重试当前任务。")
  } else if (/Tool execution aborted/i.test(text)) {
    messages.push("分析已停止，未生成新的结果。")
  } else if (/Data operation failed:|数据动作失败：/i.test(text)) {
    // data_import 后端运行时错误（如参数缺失、清洗失败）：技术原因供模型自动修复用，
    // 对用户只给可读中文，绝不暴露英文原因、Python 解释器路径或安装命令等标签。
    messages.push("数据处理这一步没有成功，系统正在自动调整处理方式重试。")
  } else if (/当前任务不存在可调用的工具|工具\s+\w+\s+is not available in this request/i.test(text)) {
    messages.push("当前分析所需的工具未在本轮启用，系统已停止继续尝试；已有数据结果会保留。")
  } else if (/无法执行未注册的工具/.test(text)) {
    messages.push("当前分析功能未正确加载，请重新提交该任务。")
  } else if (/(runId|branch) 与当前规范化数据阶段不一致|不得由模型创建新的运行身份|新分支必须通过显式工作流动作创建/.test(text)) {
    // 运行身份/分支契约是内部血缘约束，用户不需要也不应该看到 runId、branch 这些字段名。
    messages.push("这一步复用了错误的数据批次标识，系统已阻止它写入当前数据。请重述你要分析的内容，或换一份数据重新开始。")
  } else if (/该方法不在当前活动方法窗口/.test(text)) {
    messages.push("这一步需要的分析方法当前没有加载成功，系统不会猜测替代方法。请重述你要做的分析。")
  }

  // 数据质量检查 门以数据质量为由拦截：这不是"参数错误"，而是数据本身需要先处理。
  // 必须把具体、可操作的原因告诉用户，而不是甩一句"请检查任务参数"。
  const duplicateRows = text.match(/found\s+(\d+)\s+duplicate entity-time rows/i)
  if (duplicateRows) {
    messages.push(duplicatePanelKeyMessage(duplicateRows[1], text))
  } else if (/blocked by (?:QA gate|数据质量检查)|(?:QA gate|数据质量检查) blocked|被 (?:QA gate|数据质量检查)阻断/i.test(text)) {
    messages.push("数据质检未通过，需要先按诊断提示修正数据，再继续分析。")
  }

  if (/Cannot read canonical parquet stage as text|不能将规范 Parquet 数据阶段按文本读取/.test(text)) {
    messages.push(PARQUET_STAGE_FALLBACK_TEXT)
  } else if (/Cannot read binary file/i.test(text)) {
    messages.push(BINARY_FILE_FALLBACK_TEXT)
  }

  if (/Model tried to call unavailable tool/i.test(text)) {
    messages.push(TOOL_UNAVAILABLE_FALLBACK_TEXT)
  } else if (/The arguments provided to the tool are invalid/i.test(text)) {
    messages.push(TOOL_INVALID_ARGS_FALLBACK_TEXT)
  }

  return [...new Set(messages)]
}

export function userFacingAnalysisErrorText(text?: string) {
  if (!text) return undefined
  const normalized = text.trim()
  if (!normalized) return undefined
  const messages = fallbackMessagesForInternalErrors(normalized)
  return messages.length > 0 ? messages.join("\n") : undefined
}

export function containsEngineInternalData(text: string) {
  return (
    ENGINE_INTERNAL_MARKERS.some((marker) => text.includes(marker)) ||
    isInternalRuntimeStatus(text) ||
    // .killstata 作为独立路径段出现才算内部数据；foo.killstata/data.csv 这类
    // 合法文件名（前缀是字母）不算。负后视 + 必须带路径分隔符后缀。
    hasInternalWorkspacePath(text) ||
    /\/(?:private\/)?(?:var\/folders|tmp|private\/tmp)\//.test(text) ||
    /\bdid_[a-f0-9]{8}\b/i.test(text) ||
    /<[|｜]+\s*DSML\s*[|｜]+/i.test(text) ||
    /<\/?verifier_result>/i.test(text)
  )
}

export { type AnalysisToolPartLike } from "./analysis-user-view"

export function sanitizeAnalysisAssistantText(input: {
  text: string
  tools: AnalysisToolPartLike[]
  /** 当前 assistant 消息已完成的工具；tools 可能还包含上一轮历史结果。 */
  currentTurnTools?: AnalysisToolPartLike[]
  latestUserText?: string
}) {
  const rawNormalized = input.text.trim()
  const normalized = stripHiddenThinking(rawNormalized).trim()
  const hiddenThinkingRemoved = normalized !== rawNormalized
  const hasInternalRuntimeStatus = /(?:会话ID|sessionID|规范化数据阶段|canonicalDataStage|工作流状态|workflowState)\s*[:：=（(]/i.test(normalized)
  const hasInternalRuntimeIdentifier = INTERNAL_RUNTIME_IDENTIFIER_RE.test(normalized)
  const hasInternalData = containsEngineInternalData(normalized) || hasInternalRuntimeStatus || hasInternalRuntimeIdentifier
  const hasQualityClaim =
    /数据质量检查|缺失(?:值)?|异常值|极端值/.test(normalized) &&
    /可以忽略|可忽略|按列表删除|结构性分布|录入错误|真实差距|真实差异|可能与|不一定|不影响|未影响/.test(normalized)
  const hasRobustClaim =
    /(?:降权|Huber\s*M|M估计)/i.test(normalized) &&
    /(?:影响有限|影响很小|影响不大|未主导|结果(?:可靠|稳健))/.test(normalized)
  const fallbackText = userFacingAnalysisErrorText(normalized)

  if (fallbackText) {
    return {
      text: fallbackText,
      sanitized: true,
    }
  }

  // “展开分析过程”只展示可读的分析说明，绝不暴露内部协议、JSON 或文件路径。
  if (wantsRawAnalysisDetail(input.latestUserText) && !hasInternalData) {
    return {
      text: normalized,
      sanitized: hiddenThinkingRemoved,
    }
  }

  if (normalized === LEGACY_ANALYSIS_FALLBACK_TEXT) {
    return {
      text: "",
      sanitized: true,
    }
  }

  const analysisTurn = isAnalysisTurn(input.tools, input.latestUserText)
  const hasNoise =
    hasInternalData ||
    /workflow \[action=.*\]/i.test(normalized) ||
    /0{2,}\d+\|/.test(normalized) ||
    normalized.length > 800 ||
    normalized.split(/\r?\n/).length > 16

  const needsSanitization = analysisTurn || hasInternalData || hasQualityClaim || hasRobustClaim || hiddenThinkingRemoved

  const hasUnexecutedConversationPlan =
    !isAnalysisTurn(input.currentTurnTools ?? input.tools, input.latestUserText) &&
    Boolean(input.latestUserText) &&
    isWorkflowConsultation(input.latestUserText ?? "") &&
    UNEXECUTED_CONVERSATION_PLAN_RE.test(normalized)

  if (!needsSanitization && !hasUnexecutedConversationPlan) {
    return {
      text: normalized,
      sanitized: hiddenThinkingRemoved,
    }
  }

  const rawStripped = stripNoiseLines(
    stripInternalRuntimeStatus(
      stripInternalRuntimeIdentifiers(
        stripInternalToolFactNarrative(
          stripEmptyDisplayRows(
            stripEmptyDisplayPathFragments(
              stripInternalStructureLabels(
                localizeInternalToolNames(
                  localizeInternalWorkflowStatus(
                    stripInternalWorkspacePaths(stripRawToolCallLines(stripRawJsonBlocks(stripLegacyToolProtocol(stripFileBodies(stripVerifierBlocks(normalized)))))),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )
  const stripped = stripTrailingEmptyMarkdownHeadings(
    stripEmptyPresentationHeadings(
      collapseWhitespace(
        sanitizeUnsupportedRobustClaims(
          input.tools,
          sanitizeUnsupportedQualityClaims(
            stripRedundantOmittedVariableDisclosure(
            addOmittedVariableDisclosure(
              sanitizeContradictoryStopClaim(
                sanitizeUnsupportedFailureClaims(
                  input.tools,
                    sanitizeUnsupportedFitAttribution(
                      input.tools,
                      sanitizeCollinearControlRecommendations(
                        input.tools,
                        sanitizeUnsupportedStructureClaims(
                          input.tools,
                          sanitizeUnverifiedCausalClaims(
                            input.tools,
                              sanitizeMisstatedPValueSignificance(
                              sanitizeUnsupportedMechanismClaims(
                              sanitizeUnsupportedPanelKeyNames(input.tools, sanitizeConfirmedVariableRoleNames(input.tools, rawStripped)),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                ),
                input.latestUserText,
              ),
              input.tools,
            ),
          ),
          ),
        ),
      ),
    ),
  )
  const userFacingStripped = normalizeOrphanedOrderedLists(
    stripInternalGroundingPlaceholders(
      sanitizeUnexecutedConversationPlan(stripped, input.latestUserText, input.currentTurnTools ?? input.tools),
    ),
  )
  const regressionDisclosures = verifiedRegressionDisclosures(input.tools, stripped)
  const hasVerifiedRegression =
    regressionDisclosures.length > 0 ||
    hasVerifiedRegressionEvidence(input.tools) ||
    /已核验的(?:核心回归结果|.+回归结果)：/.test(stripped)
  const disclosedBase = removeSupersededGroundingPlaceholders(userFacingStripped, hasVerifiedRegression)
  const disclosures = [
    ...regressionDisclosures,
    verifiedPanelSpecDisclosure(input.tools, stripped),
    verifiedCompositeKeyDisclosure(input.tools, stripped),
    verifiedPsmDisclosure(input.tools, stripped),
    verifiedImportFileDisclosure(input.tools, stripped),
    verifiedImportSheetDisclosure(input.tools, stripped),
    verifiedImportScaleDisclosure(input.tools, input.latestUserText),
    verifiedImportVariableDisclosure(input.tools, stripped, input.latestUserText),
    verifiedImportQualityDisclosure(input.tools, stripped, input.latestUserText),
    datasetReturnDisclosure(stripped, input.latestUserText),
  ].filter((value): value is string => Boolean(value))
  // 兜底补出的可信事实属于报告主体，不应被放在模型长篇解释之后变成“尾注”。
  // 先给用户可核验的核心结果，再保留模型对局限和下一步的自然说明。
  const disclosed = stripRedundantRegressionSupplements(
    [...disclosures, disclosedBase].filter(Boolean).join("\n\n"),
  )
  const fallbackMessages = fallbackText?.split("\n") ?? []

  if (!analysisTurn) {
    if (disclosed && !containsEngineInternalData(disclosed)) {
      return {
        text: disclosed,
        sanitized: disclosed !== normalized,
      }
    }

    if (fallbackMessages.length > 0) {
      return {
        text: fallbackMessages.join("\n"),
        sanitized: true,
      }
    }

    if (hasInternalData) {
      return {
        text: "",
        sanitized: true,
      }
    }

    return {
      text: normalized,
      sanitized: hiddenThinkingRemoved,
    }
  }

  if (disclosed && !containsEngineInternalData(disclosed)) {
    return {
      text: disclosed,
      sanitized: disclosed !== normalized || hiddenThinkingRemoved,
    }
  }

  if (stripped && stripped.length > 0 && stripped !== normalized) {
    return {
      text: stripped,
      sanitized: true,
    }
  }

  if (fallbackMessages.length > 0) {
    return {
      text: fallbackMessages.join("\n"),
      sanitized: true,
    }
  }

  if (hasInternalData || (analysisTurn && stripped !== normalized && !stripped) || (hasNoise && !stripped)) {
    return {
      text: "",
      sanitized: true,
    }
  }

  return {
    text: normalized,
    sanitized: hiddenThinkingRemoved,
  }
}
