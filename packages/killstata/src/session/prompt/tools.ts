import path from "path"
import fs from "fs"
import crypto from "crypto"
import { fileURLToPath } from "bun"
import type {
  AnalysisToolOperationIdentity,
  AnalysisToolRunRecord,
  PreparedSpecRecord,
  ToolAvailabilityPolicy,
  WorkflowInputIntent,
} from "@/runtime/types"
import z from "zod"
import { Agent } from "../../agent/agent"
import { Flag } from "../../flag/flag"
import { PermissionNext } from "@/permission/next"
import { Provider } from "../../provider/provider"
import { ProviderTransform } from "../../provider/transform"
import { Session } from "../session-state"
import { MessageV2 } from "../message-v2"
import { DataContext } from "../data-context"
import type { SessionProcessor } from "../processor"
import { Tool } from "@/tool/tool"
import { isDataFile } from "@/tool/data-file"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "../../tool/registry"
import { command } from "./command"
import { jsonSchema, tool, type Tool as AITool } from "ai"
import { log } from "./types"
import { prepareToolMetadata } from "@/runtime/tool-result-policy"
import { Bus } from "@/bus"
import { RuntimeEvents } from "@/runtime/events"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { needsAnalysisRequestRegistration } from "@/runtime/analysis-request"
import {
  analysisSpecArgumentsEqual,
  prepareAnalysisSpec as prepareAnalysisSpecService,
  resolvePreparedSpecForExecution,
} from "@/runtime/services/analysis-spec-service"
import { TOOL_MANIFEST } from "@/runtime/tool-manifest"
import { ConfirmedMethods } from "@/runtime/confirmed-methods"
import { isConcreteMethodTool, MODEL_TOOL_POOL_LIMITS, modelToolPoolCounts } from "@/runtime/workflow/exposure"
import {
  WORKFLOW_DATA_METHOD_TOOL_IDS,
  WORKFLOW_DIAGNOSTIC_TOOL_IDS,
  WORKFLOW_ESTIMATE_TOOL_IDS,
  WORKFLOW_RECOMMEND_TOOL_IDS,
  WORKFLOW_RUNNER_TOOL_IDS,
} from "@/runtime/tool-catalog"
import { EconometricsExecuteInput } from "@/tool/econometrics-execute"
import { descriptorForTypeScriptTool, type UnifiedToolDescriptor } from "@/tool/tool-descriptor"
import { pythonCapabilityReference } from "@/tool/python-capability-tool"
import { dataDiagnosisFingerprintMismatch, readStoredDataReadinessState } from "@/runtime/data-readiness"
import { Question } from "@/question"
import { isInheritedAnalysisConfirmation } from "@/runtime/input-intent"
import { flushDeferredAutomaticVerifiers } from "@/runtime/workflow"
import { activeOrLatestStage, canonicalDataStageForWorkflow, getActiveWorkflowRun } from "@/runtime/workflow/state"
import { EconometricsEngineError, sessionEconometricsEngine } from "@/runtime/services/econometrics-engine-client"
import { buildEngineToolResult } from "@/runtime/services/econometrics-engine-result"
import { econometricsEngineRoot, ensureRuntimePythonReady, formatRuntimePythonSetupError, resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { Token } from "@/util/token"
import { resolveDatasetStagePath, resolveManagedProjectPath } from "@/tool/analysis-path"
import {
  appendArtifact,
  datasetRoot,
  inferBranch,
  inferRunId,
  publishVisibleOutput,
  readDatasetManifest,
  reportOutputPath,
  resolveArtifactInput,
} from "@/tool/analysis-state"

/** 只读质量体检的运行时边界；明确清洗、导出或查看完整明细时不启用。 */
export function isQualityInspectionOnlyRequest(text?: string) {
  // 只匹配质量请求短语，不匹配变量名中的裸“质量”（例如“高质量发展指数”）。
  // 否则一个正常的 OLS/面板任务会被误收窄成只读质量体检，连 tool_search 都不可见。
  if (!text) return false
  // 用户明确点名专用文件工具时，不能因为同时说了“本轮不要回归”就把它隐藏。
  // 这类请求的目标可能正是验证错误路径并根据工具反馈重规划；若先进入质量体检
  // 模式，read/glob 会被裁掉，模型只能误称“工具不存在”，既没有真实失败也没有
  // 后续换工具的机会。
  const hasExplicitFileToolRequest = /(?:\b(?:read|glob|list|grep)\b\s*工具|(?:调用|使用|通过)\s+\b(?:read|glob|list|grep)\b|\buse\s+(?:read|glob|list|grep)\b)/i.test(text)
  if (hasExplicitFileToolRequest) return false
  const methodTerms = "(?:交错事件研究|事件研究|双向固定效应|面板固定效应|高维固定效应|固定效应|随机效应|Panel\\s*(?:FE|RE)|\\b(?:FE|RE|HDFE|WLS|Poisson|PPML|NegBin|MNL|IV)\\b|动态DID|交错DID|DID2S|双重差分|DID|倾向得分匹配|最近邻匹配|PSM|IPW|AIPW|双重稳健|工具变量(?:回归)?|2SLS|加权最小二乘|泊松|负二项|多项Logit|分位数|熵权|TOPSIS|综合评价|断点回归|RDD|Logit|Probit|OLS|普通最小二乘回归|回归分析|回归)"
  const methodAction = "(?:做|跑|运行|拟合|比较|估计|执行|进行|开展|采用|使用|用|需要)"
  const clauses = text
    .split(/[，,。！？!?；;\n]/u)
    .flatMap((clause) => clause.split(/(?:但是|不过|而是|可是|但)/u))
  const hasPositiveMethodAction = clauses.some((clause) => {
    const negativeMethod = new RegExp(
      `(?:不要|别做|不做|不跑|不进行|不用|无需|不需要|不想|暂不|先不|是否|要不要|能否|可否|如果|若)[^。！？!?\\n]{0,20}${methodAction}?[^。！？!?\\n]{0,12}${methodTerms}`,
      "iu",
    ).test(clause)
    if (negativeMethod) return false
    return new RegExp(
      `(?:请|我(?:想|希望|要)|希望|需要|帮我|直接)?[^。！？!?\\n]{0,80}${methodAction}[^。！？!?\\n]{0,12}${methodTerms}`,
      "iu",
    ).test(clause)
  })
  if (hasPositiveMethodAction) return false
  const hasQualityPhrase = /(?:数据质量|质量(?:检查|体检|问题|状况|情况)|质检|重复|缺失|异常值|异常)/.test(text)
  const hasExplicitNoEstimation = /(?:本轮|当前|先)?\s*(?:不要|不做|不用|无需|不需要)(?:做|进行)?\s*(?:回归分析|回归|估计)/.test(text)
  const hasInspectionAction = /(?:导入|画像|概况|结构|变量|检查|查看|了解)/.test(text)
  if (!hasQualityPhrase && !(hasExplicitNoEstimation && hasInspectionAction)) return false
  // “不用做回归”是只读范围限定，不应关闭 qualityInspectionOnly；但“做回归”
  // 或“检查后回归”仍然意味着分析任务。先移除明确被否定的估计动作，再检查其余
  // 是否包含会改变数据或要求完整明细的词，避免把保护开关交给模型自行解释。
  const withoutNegatedEstimation = text.replace(
    /(?:不用|不做|不要|无需|不需要)[^。！？\n]{0,12}(?:回归分析|回归|估计)/g,
    "",
  )
  return !/(?:清洗|变换|缩尾|截尾|填补|标准化|对数|筛选|删除|导出|回归|估计|预处理|生成|构造|完整(?:报告|明细)|原始(?:明细|内容)|详细(?:报告|明细))/.test(withoutNegatedEstimation)
}

/** import 已返回变量清单、缺失和就绪摘要；只有用户明确要求画像/profile 时才追加 profile。 */
export function requiresPostImportProfile(text?: string) {
  return /(?:画像|\bprofile\b)/i.test(text ?? "")
}

/**
 * 首次附件的导入是系统已知事实，不应要求模型先猜 datasetId。
 *
 * 模型偶尔会忽略附件提示而先发 profile/validate；这些动作只对已导入 stage 有意义，
 * 直接执行只会得到“datasetId 不存在”，再诱发 pipeline/profile 循环。仅在本会话尚未
 * 有数据集、且当前附件是受支持表格时，将这类只读动作收口为同一份附件的一次 import。
 * filter/export/rollback 等会改变阶段或交付物的动作不在此自动改写范围内。
 */
export function initialAttachmentImportArgs(input: {
  action: unknown
  hasActiveDataset: boolean
  inputPath?: string
  worksheetName?: string
}) {
  if (input.hasActiveDataset || !input.inputPath) return undefined
  if (!(["profile", "validate", "correlation", "frequency"] as const).includes(input.action as never)) return undefined
  const sheetName = input.worksheetName?.trim()
  return {
    action: "import" as const,
    inputPath: input.inputPath,
    preserveLabels: true,
    ...(sheetName ? { sheetPolicy: { mode: "named_sheet" as const, sheetName } } : {}),
  }
}

/**
 * profile/validate 等数据动作不属于研究规格；模型不应携带或回读内部血缘 ID。
 * 一旦当前会话已有规范化 stage，Harness 以权威 stage 覆盖模型的旧值、脱敏值或遗漏值。
 */
export function injectCurrentDataImportLineage(
  args: unknown,
  currentData?: { datasetId: string; stageId: string } | null,
) {
  if (!args || typeof args !== "object" || Array.isArray(args) || !currentData) return args
  const input = args as Record<string, unknown>
  const action = input.action
  if (action === "rollback") {
    return {
      ...input,
      datasetId: currentData.datasetId,
      ...(typeof input.rollbackStageId === "string" ? { stageId: input.rollbackStageId } : {}),
    }
  }
  if (!(["profile", "validate", "correlation", "frequency", "export"] as const).includes(action as never)) return input
  return {
    ...input,
    datasetId: currentData.datasetId,
    stageId: currentData.stageId,
  }
}

const ENGLISH_DATA_PATH_ACTION = String.raw`\b(?:import|read|open|analy[sz]e|export)\b`
const USER_DATA_PATH_ACTION = new RegExp(`(?:导入|读取|分析|使用|打开|查看|导出|${ENGLISH_DATA_PATH_ACTION})`, "i")
const NEGATED_DATA_PATH_ACTION = /(?:不要|不需要|不想|不(?:再)?|别|勿|do\s+not|don't|avoid)\s*(?:(?:再|帮我|please)\s*)*(?:导入|读取|分析|使用|打开|查看|导出|\b(?:import|read|open|analy[sz]e|export)\b)/gi
const isExplicitDataPath = (value: string) => isDataFile(value) || path.extname(value).toLowerCase() === ".parquet"
const SUPPORTED_DATA_PATH_MENTION = /(?:^|[\s"'`(:,=])[^\s"'`<>|，。！？,;]*\.(?:xlsx?|csv|dta|parquet)(?=$|[\s"'`<>|，。！？,;])/iu
const ATTACHMENT_DATA_REQUEST = /(?:(?:分析|读取|导入|使用|查看|回归|估计|清洗|探索|检查|描述|打开|导出)[^。！？!?；;\n]{0,32}(?:附件|上传(?:的)?(?:文件|数据|表格)?|数据集|数据|表格|文件)|(?:附件|上传(?:的)?(?:文件|数据|表格)?|数据集|数据|表格|文件)[^。！？!?；;\n]{0,32}(?:分析|读取|导入|使用|查看|回归|估计|清洗|探索|检查|描述|打开|导出)|(?:analy[sz]e|read|import|use|view|inspect|regress|estimate|clean|describe|open|export)[^.!?;\n]{0,48}(?:attached|attachment|uploaded|spreadsheet|dataset|data|file)|(?:attached|attachment|uploaded|spreadsheet|dataset|data|file)[^.!?;\n]{0,48}(?:analy[sz]e|read|import|use|view|inspect|regress|estimate|clean|describe|open|export))/iu

function removeQuotedMarkdownBlocks(text: string) {
  let fence: { character: string; length: number } | undefined
  let inBlockQuote = false
  let inIndentedCode = false
  return text.split(/(?<=\n)/u).map((line) => {
    const content = line.replace(/\r?\n$/u, "")
    const fenceStart = content.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1]
    if (fence) {
      const closingFence = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[\\t ]*$`, "u").test(content)
      if (closingFence) fence = undefined
      return " ".repeat(line.length)
    }
    if (fenceStart) {
      fence = { character: fenceStart[0]!, length: fenceStart.length }
      return " ".repeat(line.length)
    }
    if (/^(?: {4,}|\t)/u.test(content)) {
      inIndentedCode = true
      return " ".repeat(line.length)
    }
    if (inIndentedCode) {
      if (!content.trim()) return " ".repeat(line.length)
      inIndentedCode = false
    }
    if (/^ {0,3}>/u.test(content)) {
      inBlockQuote = true
      return " ".repeat(line.length)
    }
    if (inBlockQuote) {
      if (!content.trim()) inBlockQuote = false
      return " ".repeat(line.length)
    }
    return line
  }).join("")
}

/** 只从当前用户原文恢复明确路径；附件路径由 FilePart 解析，模型参数本身不是路径授权来源。 */
export function explicitUserDataPaths(userText?: string) {
  if (!userText) return []
  const actionableText = removeQuotedMarkdownBlocks(userText)
  const quotedSpans = /(["'`])[^"'`\r\n]*\1|“[^”\r\n]*”|‘[^’\r\n]*’/gu
  const unquotedText = actionableText.replace(quotedSpans, (quotedValue) => " ".repeat(quotedValue.length))
  const paths: Array<{ value: string; index: number }> = []
  const hasAffirmativeAction = (index: number, pathEnd: number) => {
    const preceding = unquotedText.slice(0, index)
    const clauseSeparators = ["。", "！", "？", "!", "?", "；", ";", "，", ",", "\n"]
    const clauseStart = Math.max(...clauseSeparators.map((separator) => preceding.lastIndexOf(separator)))
    const clause = preceding.slice(clauseStart + 1)
    const actions = [...clause.matchAll(new RegExp(USER_DATA_PATH_ACTION.source, "gi"))]
    const last = actions.at(-1)
    if (last && last.index !== undefined) {
      const actionEnd = last.index + last[0].length
      if ([...preceding.matchAll(NEGATED_DATA_PATH_ACTION)].some(
        (negative) => negative.index !== undefined && negative.index >= clauseStart + 1 && negative.index + negative[0].length === clauseStart + 1 + actionEnd,
      )) return false
      const actionContext = clause.slice(actionEnd)
      return !/^\s*(?:这句|这段|示例|下面|下文)/u.test(actionContext)
        && !/^\s*(?:(?:this|the following)\s+(?:sentence|example|path)\b)/iu.test(actionContext)
    }

    // 也接受“从文件 /path.xlsx 导入”这类动作在路径之后的自然语序。
    // 否定或示例语境仍不构成路径授权；按标点限制在当前分句内，不能借用后文指令。
    const afterPath = unquotedText.slice(pathEnd)
    const clauseEnd = Math.min(...clauseSeparators.map((separator) => {
      const next = afterPath.indexOf(separator)
      return next < 0 ? afterPath.length : next
    }))
    const afterPathClause = afterPath.slice(0, clauseEnd)
    const nextAction = new RegExp(USER_DATA_PATH_ACTION.source, "i").exec(afterPathClause)
    if (!nextAction) return false
    const contextBeforeAction = unquotedText.slice(clauseStart + 1, pathEnd + nextAction.index)
    if (/(?:^|[\s，,])(?:请\s*)?(?:不要|不需要|不想|不再|不应|不能|别|勿|do\s+not|does\s+not|don't|avoid)\s*(?:从|用|使用|通过|open|read|import|analy[sz]e)/iu.test(contextBeforeAction)) return false
    if (/(?:^|\s)(?:不要|不需要|不想|不再|不应|不能|不|别|勿|do\s+not|does\s+not|don't|avoid)\s*$/iu.test(contextBeforeAction)) return false
    if (/(?:示例|引用|仅作|example|quoted|mention|reference)/iu.test(contextBeforeAction)) return false
    return true
  }
  const quotedPath = (candidate: string) => {
    const absoluteOrDotRelative = /^(?:[A-Za-z]:[\\/]|\/|~[\\/]|\.{1,2}[\\/])/.test(candidate)
    const relativePath = /^(?:[^\\/\s]+[\\/])+[^\\/]+\.(?:xlsx?|csv|dta|parquet)$/iu.test(candidate)
    const bareFilename = /^[^\\/\s]+\.(?:xlsx?|csv|dta|parquet)$/iu.test(candidate)
    return absoluteOrDotRelative || relativePath || bareFilename
  }
  const quotedAsciiPath = /(["'`])([^"'`\r\n]+?\.(?:xlsx?|csv|dta|parquet))\1/giu
  const quotedChinesePath = /[“‘]([^”’\r\n]+?\.(?:xlsx?|csv|dta|parquet))[”’]/gu
  for (const match of actionableText.matchAll(quotedAsciiPath)) {
    const candidate = match[2]!
    if (quotedPath(candidate) && isExplicitDataPath(candidate) && hasAffirmativeAction(match.index, match.index + match[0].length)) {
      paths.push({ value: candidate, index: match.index })
    }
  }
  for (const match of actionableText.matchAll(quotedChinesePath)) {
    const candidate = match[1]!
    if (quotedPath(candidate) && isExplicitDataPath(candidate) && hasAffirmativeAction(match.index, match.index + match[0].length)) {
      paths.push({ value: candidate, index: match.index })
    }
  }
  const unquotedPath = /(?:^|[\s"'`(:,=])([^\s"'`<>|，。！？,;]*\.(?:xlsx?|csv|dta|parquet))(?=$|[\s"'`<>|，。！？,;])/giu
  for (const match of unquotedText.matchAll(unquotedPath)) {
    const candidate = match[1]!
    const index = match.index + match[0].indexOf(candidate)
    if (isExplicitDataPath(candidate) && hasAffirmativeAction(index, index + candidate.length)) paths.push({ value: candidate, index })
  }
  return [...new Set(paths.sort((left, right) => left.index - right.index).map((item) => item.value))]
}

async function latestPendingDataAttachmentPath(sessionID: string) {
  const messages = await Session.messages({ sessionID })
  for (const message of [...messages].reverse()) {
    if (message.info.role !== "user") continue
    for (const part of message.parts) {
      if (part.type !== "file" || !part.url.startsWith("file:")) continue
      const filename = part.filename ?? ""
      if (!isDataFile(filename)) continue
      try {
        return fileURLToPath(part.url)
      } catch {
        // 不是一个可本地读取的 file URL，不能把它当作导入源猜测。
      }
    }
  }
  return undefined
}

/** Explicitly declined import wins over the implicit attachment fallback; a later explicit file path still wins. */
export function selectDataImportSource(input: {
  userText?: string
  explicitSourcePaths: string[]
  attachmentPath?: string
}) {
  if (input.explicitSourcePaths.length > 0) return input.explicitSourcePaths[0]
  if (!input.attachmentPath || !input.userText) return input.attachmentPath

  const actionableText = removeQuotedMarkdownBlocks(input.userText)
  const unquotedText = actionableText.replace(/(["'`])[^"'`\r\n]*\1|“[^”\r\n]*”|‘[^’\r\n]*’/gu, (value) => " ".repeat(value.length))
  const nonActionablePathContext = /(?:\b(?:this|the following)\s+(?:sentence|example|path)\b|\b(?:thread|message)\s+mentions?\s+(?:the\s+)?path\b|\bpath\s+(?:is\s+)?(?:only\s+)?(?:an?\s+)?example\b|(?:这句|这段|下面(?:的)?(?:示例|例子)|(?:示例|例子|引用)[^。！？\n]{0,16}(?:路径|文件)|(?:路径|文件)[^。！？\n]{0,16}(?:示例|引用|仅作)))/iu
  if (nonActionablePathContext.test(unquotedText)) return undefined
  if (SUPPORTED_DATA_PATH_MENTION.test(actionableText)) {
    const taskText = unquotedText.replace(new RegExp(SUPPORTED_DATA_PATH_MENTION.source, "giu"), " ")
    if (!ATTACHMENT_DATA_REQUEST.test(taskText)) return undefined
  }
  const imports = [...unquotedText.matchAll(/导入|\bimport\b/giu)]
  const lastImport = imports.at(-1)
  if (!lastImport || lastImport.index === undefined) return input.attachmentPath

  const beforeImport = unquotedText.slice(0, lastImport.index)
  const refusalPrefix = /(?:不要|不需要|不想|不(?:再)?|别|勿)\s*(?:(?:再|帮我|please)\s*)*$|\b(?:do\s+not|don't|avoid)\s*$/iu
  return refusalPrefix.test(beforeImport) ? undefined : input.attachmentPath
}

/**
 * “按推荐执行”是对上一轮推荐的承接，不是更换识别策略的授权。
 * 模型仍然可能从历史文本里挑出另一个方法；返回结构化指引让它回到推荐方法，
 * 只有用户明确说“改用/换成某方法”时才允许重新选择。
 */
export function recommendationMethodMismatch(input: {
  userText?: string
  recommendedMethod?: string
  requestedMethod?: string
}) {
  if (!input.recommendedMethod || !input.requestedMethod || input.recommendedMethod === input.requestedMethod) return undefined
  if (!isInheritedAnalysisConfirmation(input.userText ?? "")) return undefined
  return {
    title: "请沿用已确认的推荐方法",
    output: [
      `用户上一轮采纳的是推荐方法“${input.recommendedMethod}”，当前调用的是“${input.requestedMethod}”。`,
      "这不是同一研究方法，系统没有执行当前调用，也没有构造 post 或改变数据。",
      `请加载并执行已推荐的方法“${input.recommendedMethod}”；如果要改用其他方法，先向用户说明识别含义变化并请求明确确认。`,
    ].join("\n"),
    metadata: {
      recommendationMethodMismatch: true,
      recommendedMethod: input.recommendedMethod,
      requestedMethod: input.requestedMethod,
    },
  }
}

export function recommendationOnlyMethodBlock(recommendationOnly: boolean, toolName: string) {
  if (!recommendationOnly || !(toolName === "econometrics_execute" || isConcreteMethodTool(toolName))) return undefined
  return {
    title: "本轮只生成方法建议",
    output: "本轮用户请求的是方法建议，尚未授权执行计量估计；已忽略这次误发起的估计调用。请先交付候选方法和适用条件，等待用户明确采纳后再执行。",
    metadata: {
      recommendationOnly: true,
      suppressedEstimate: true,
      finalizeTextOnly: true,
      noNewInformation: true,
    },
  }
}

export function workflowRerunReadOnlyBlock(input: {
  action: unknown
  analysisRequestKind?: "inspect" | "estimate" | "explain" | "repair"
  qualityInspectionOnly: boolean
  recommendationOnly: boolean
}) {
  if (input.action !== "rerun") return undefined
  const reason = input.qualityInspectionOnly
    ? "本轮明确只做数据质量检查"
    : input.recommendationOnly
      ? "本轮只请求方法推荐"
      : input.analysisRequestKind === "inspect"
        ? "当前 AnalysisRequest 是只读检查"
        : input.analysisRequestKind === "explain"
          ? "当前 AnalysisRequest 只解释已有结果"
          : !input.analysisRequestKind
            ? "当前消息没有绑定有效的 AnalysisRequest"
            : undefined
  if (!reason) return undefined
  return {
    title: "当前请求不允许运行历史工作流",
    output: `${reason}；pipeline.rerun 会按历史输入重放阶段，可能再次运行估计。本轮没有重跑，也没有调用估计器。若需修复或重新估计，请由用户发起新的相应请求，并按当前数据阶段重新确认规格。`,
    metadata: {
      requiresUserDecision: true,
      suppressedEstimate: true,
      estimateExecuted: false,
      analysisRequestKind: input.analysisRequestKind,
    },
  }
}

const PSM_DIAGNOSTIC_METHOD_IDS = new Set(
  WORKFLOW_DIAGNOSTIC_TOOL_IDS.filter((toolID) => toolID.startsWith("psm_")),
)
const PSM_METHOD_IDS = new Set([
  ...PSM_DIAGNOSTIC_METHOD_IDS,
  ...WORKFLOW_ESTIMATE_TOOL_IDS.filter((toolID) => toolID.startsWith("psm_")),
])

export function psmMethodSearchAllowed(scope: "diagnostics_only" | "blocked" | undefined, methodID: string) {
  if (scope === "blocked") return !PSM_METHOD_IDS.has(methodID)
  if (scope === "diagnostics_only") return PSM_DIAGNOSTIC_METHOD_IDS.has(methodID)
  return true
}

export function psmToolScopeBlock(
  scope: "diagnostics_only" | "blocked" | undefined,
  toolID: string,
  args?: unknown,
  approvedFilter?: { column: string; value: string | number },
) {
  if (!scope) return undefined
  const authorizedFilter = (() => {
    if (toolID !== "data_preprocess" || !approvedFilter || !args || typeof args !== "object" || Array.isArray(args)) {
      return false
    }
    const record = args as Record<string, unknown>
    if (record.method !== "filter" || !Array.isArray(record.columns) || record.columns.length !== 0) return false
    const options = record.options
    if (!options || typeof options !== "object" || Array.isArray(options)) return false
    const rules = (options as Record<string, unknown>).rules
    if (!Array.isArray(rules) || rules.length !== 1 || !rules[0] || typeof rules[0] !== "object" || Array.isArray(rules[0])) return false
    const rule = rules[0] as Record<string, unknown>
    if (rule.column !== approvedFilter.column || rule.operator !== "eq") return false
    const value = rule.value
    return value === approvedFilter.value || String(value) === String(approvedFilter.value)
  })()
  const blocked = scope === "blocked"
    ? PSM_METHOD_IDS.has(toolID)
    : WORKFLOW_ESTIMATE_TOOL_IDS.includes(toolID) ||
      (WORKFLOW_DIAGNOSTIC_TOOL_IDS.includes(toolID) && !PSM_DIAGNOSTIC_METHOD_IDS.has(toolID)) ||
      (WORKFLOW_DATA_METHOD_TOOL_IDS.includes(toolID) && !authorizedFilter) ||
      WORKFLOW_RECOMMEND_TOOL_IDS.includes(toolID) ||
      WORKFLOW_RUNNER_TOOL_IDS.includes(toolID)
  if (!blocked) return undefined
  return {
    title: scope === "blocked" ? "遵守本轮 PSM 工具限制" : "遵守本轮 PSM 诊断范围",
    output: scope === "blocked"
      ? "本轮用户只要求解释 PSM 方法或明确要求不执行 PSM 工具；没有调用任何 PSM 工具。"
      : "本轮只允许倾向得分构造诊断和分布可视化；未执行其他数据变换、方法推荐或效应估计器，也未计算 ATT/ATE。请继续完成已请求的 PSM 诊断；如需其他分析，请另行明确提出。",
    metadata: {
      psmToolScopeBlocked: true,
      suppressedTool: true,
      finalizeTextOnly: true,
    },
  }
}

/**
 * 显式切换到 did2s 后，探查相对时期/首次处理时点只保留一个必要频数检查。
 * 这是运行时的兜底，不依赖模型是否遵守系统提示词；超过一次就把设计决定交还用户。
 */
export function isExplicitDid2sRequest(text?: string) {
  if (!text) return false
  const staggeredTerms = "(?:交错\\s*(?:DID|双重差分|事件研究)|交错处理|分期处理|错位实施)"
  if (new RegExp(`(?:不要|别|不(?:要|用|改)|不适用|不属于|不考虑|无需|不必|避免)[^。！？\\n]{0,40}(?:did2s|did\\s*2s|两阶段\\s*(?:双重差分|DID)|${staggeredTerms})`, "i").test(text)) {
    return false
  }
  const directTwoStage = /(?:改用|换成|切换到|使用|采用|执行|跑|做|选择|请[^。！？\n]{0,20}(?:改用|使用|执行|跑|做))\s*(?:did2s|did\s*2s|两阶段\s*(?:双重差分|DID))/i
  const directStaggered = new RegExp(`(?:改用|换成|切换到|使用|采用|执行|选择|做|跑|进行)[^。！？\\n]{0,20}${staggeredTerms}`, "i")
  return directTwoStage.test(text) || directStaggered.test(text)
}

export function shouldStopAfterDid2sFrequency(input: { userText?: string; frequencyChecks: number }) {
  return isExplicitDid2sRequest(input.userText) && input.frequencyChecks >= 1
}

/** 只请求方法建议时，推荐工具应在交付候选后收束本轮，不替用户直接跑模型。 */
export function isRecommendationOnlyRequest(text?: string) {
  if (!text || !/(?:不知道|不确定|推荐|建议)[^。！？\n]{0,30}(?:方法|模型|计量)/.test(text)) return false
  return !/(?:直接|执行|跑(?:一下|回归|模型)?|估计|回归|用你(?:说|推荐)的|采纳)/.test(text)
}

function explicitlyRequestsCompositeEntityPanelKey(text: string) {
  const waitsForConsent = /(?:先问我|(?:问|询问)我是否|请先确认|确认是否|先确认(?:后|再)|等我(?:确认|决定|选择)|等待我(?:确认|决定|选择)|由我(?:决定|选择)|待我确认|征求(?:我的)?(?:确认|同意)|确认后再)/.test(text)
  if (waitsForConsent) return false
  const compositeReference = "(?:复合实体(?:键|标识)|省份\\s*[+＋和、]\\s*地区|地区\\s*[+＋和、]\\s*省份)"
  const negation = "(?:不要|别|不应该|不应|不需要|不想|不使用|不用|禁止|避免|不能|不得)"
  const action = "(?:使用|采用|构造|组合|合并|生成|创建|用|把|选择|指定)"
  const negatedBefore = new RegExp(
    `${negation}\\s*(?:(?:直接|再|继续|自行)\\s*)*${action}[^，,；;。！？\\n]{0,12}${compositeReference}`,
    "u",
  ).test(text)
  const negatedAfter = new RegExp(
    `${compositeReference}[^，,；;。！？\\n]{0,8}${negation}\\s*(?:(?:直接|再|继续|自行)\\s*)*${action}`,
    "u",
  ).test(text)
  if (negatedBefore || negatedAfter) return false
  return /(?:组合|合并|复合实体(?:键|标识)|省份\s*[+＋和、]\s*地区|地区\s*[+＋和、]\s*省份)/.test(text) &&
    /(?:省份|上级地区)/.test(text) && /(?:地区|实体)/.test(text)
}

/** 只有结构化数据事实证明存在重复实体—时间键，且用户明确授权复合键时才可继续。 */
export function allowsExplicitCompositePanelRepair(input: { userText?: string; duplicateEntityTimeKey: boolean }) {
  return input.duplicateEntityTimeKey && explicitlyRequestsCompositeEntityPanelKey(input.userText ?? "")
}

/**
 * 用户明确授权复合键修复后，新的 combine_columns stage 上的唯一派生键优先于原始列名；
 * 不能再把它纠错回旧列。授权必须同时有父阶段重复证据、精确预处理血缘、新阶段唯一性
 * 与完整键证据，且确认变换前后观测数未改变。
 */
function hasAuthorizedCompositeEntityStage(input: {
  userText?: string
  datasetId: string
  stageId: string
  originalEntityVar: string
  compositeEntityVar: string
  timeVar: string
  report: NonNullable<ReturnType<typeof readStoredDataReadinessState>["report"]>
}) {
  const userText = input.userText ?? ""
  if (!explicitlyRequestsCompositeEntityPanelKey(userText)) return false

  const manifest = readDatasetManifest(input.datasetId)
  const stage = manifest.stages.find((item) => item.stageId === input.stageId)
  const parent = stage?.parentStageId
    ? manifest.stages.find((item) => item.stageId === stage.parentStageId)
    : undefined
  if (!stage || !parent || stage.rowCount === undefined || stage.rowCount !== parent.rowCount) return false
  if (stage.metadata?.method !== "combine_columns") return false

  const sourceColumns = Array.isArray(stage.metadata.columns)
    ? stage.metadata.columns.filter((column): column is string => typeof column === "string")
    : []
  const options = stage.metadata.options && typeof stage.metadata.options === "object" && !Array.isArray(stage.metadata.options)
    ? stage.metadata.options as Record<string, unknown>
    : {}
  if (
    sourceColumns.length < 2 ||
    !sourceColumns.includes(input.originalEntityVar) ||
    !sourceColumns.every((column) => userText.includes(column)) ||
    options.output_column !== input.compositeEntityVar
  ) return false

  const parentReadiness = readStoredDataReadinessState(input.datasetId, parent.stageId)
  if (parentReadiness.stale || !parentReadiness.report) return false
  const duplicateEntityTimeKey = parentReadiness.report.panelCandidates.some((candidate) =>
    candidate.timeVar === input.timeVar &&
    candidate.entityVars.length === 1 &&
    candidate.entityVars[0] === input.originalEntityVar &&
    !candidate.unique &&
    candidate.duplicateRows > 0 &&
    candidate.entityMissingCount === 0 &&
    candidate.timeMissingCount === 0,
  )
  if (!allowsExplicitCompositePanelRepair({ userText, duplicateEntityTimeKey })) return false

  return input.report.panelCandidates.some((candidate) =>
    candidate.timeVar === input.timeVar &&
    candidate.entityVars.length === 1 &&
    candidate.entityVars[0] === input.compositeEntityVar &&
    candidate.unique &&
    candidate.entityMissingCount === 0 &&
    candidate.timeMissingCount === 0,
  )
}

/**
 * post 是研究设计变量，不是普通清洗列。只要用户没有给出固定阈值，就不能让
 * 模型通过 create_column 静默决定政策前后；工具端必须再确认一次，避免只依赖
 * system prompt（真实回放曾直接执行 year>=time）。
 */
export function needsPolicyConstructionConfirmation(input: { userText?: string; args: unknown }) {
  if (!input.args || typeof input.args !== "object" || Array.isArray(input.args)) return false
  const args = input.args as Record<string, unknown>
  if (args.method !== "create_column") return false
  const options = args.options && typeof args.options === "object" && !Array.isArray(args.options)
    ? args.options as Record<string, unknown>
    : {}
  const outputColumn = options.output_column ?? args.output_column
  if (typeof outputColumn !== "string" || outputColumn.trim().toLowerCase() !== "post") return false
  const text = input.userText ?? ""
  const hasFixedRule =
    /(?:post|政策后)[^。\n]{0,80}(?:year|年份|time|时间)\s*(?:>=|≥|>|等于|之后|起)\s*(?:\d{4}|year|年份|time|时间)/i.test(text) ||
    /(?:year|年份|time|时间)\s*(?:>=|≥|>|等于|之后|起)\s*(?:\d{4}|year|年份|time|时间)[^。\n]{0,80}(?:post|政策后)/i.test(text)
  return !hasFixedRule
}

/** 相对时期会直接决定 DID2S 的事件期编码，只能在用户确认精确列/公式/sentinel 后生成。 */
export function needsRelativeTimeConstructionConfirmation(input: { userText?: string; args: unknown }) {
  if (!input.args || typeof input.args !== "object" || Array.isArray(input.args)) return false
  const args = input.args as Record<string, unknown>
  if (args.method !== "create_relative_time") return false
  const options = args.options && typeof args.options === "object" && !Array.isArray(args.options)
    ? args.options as Record<string, unknown>
    : {}
  const fields = ["entity_var", "time_var", "cohort_var", "treatment_var", "output_column"]
  const columns = Object.fromEntries(fields.map((field) => [field, options[field]]))
  if (fields.some((field) => typeof columns[field] !== "string" || !(columns[field] as string).trim())) return true

  const text = input.userText ?? ""
  if (/(?:先问我|先向我确认|等我确认|等我同意|不要(?:自动)?(?:生成|构造|创建|执行|继续)|先别(?:自动)?(?:生成|构造|创建|执行|继续)|请勿(?:自动)?(?:生成|构造|创建|执行|继续)|暂缓(?:执行|生成|构造|创建)?|暂停(?:执行|生成|构造|创建)?|撤回(?:这项|该)?(?:确认|同意|授权)|未授权|未经确认|我不(?:确认|同意|授权)|停止(?:生成|构造|创建|执行|继续))/u.test(text)) return true

  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const identifierPattern = (value: string) => /^[A-Za-z0-9_]+$/u.test(value)
    ? `(?<![A-Za-z0-9_])${escapeRegex(value)}(?![A-Za-z0-9_])`
    : `[\\x60"'“‘「『]${escapeRegex(value)}[\\x60"'”’」』]`
  const hasIdentifier = (value: string) => new RegExp(identifierPattern(value), "iu").test(text)
  const entityName = String(columns.entity_var)
  const hasEntity = hasIdentifier(entityName) || new RegExp(
    `每个${escapeRegex(entityName)}(?=(?:构造|生成|计算|写入|添加|按|时|内|上|中|的|单位|实体|列|[，。；,;:\\s]|$))`,
    "u",
  ).test(text) || new RegExp(
    `(?:分析单位|实体)(?:列)?(?:为|是|[:：=])${escapeRegex(entityName)}(?=(?:[，。；,;:\\s]|$))`,
    "u",
  ).test(text)
  const affirmative = /(?:我(?:明确)?(?:确认|同意|授权|批准)|(?:确认|同意|授权|批准)(?:按|采用|使用|照此))/u.test(text)
  const timePattern = identifierPattern(String(columns.time_var))
  const cohortPattern = identifierPattern(String(columns.cohort_var))
  const formula = new RegExp(`${timePattern}\\s*-\\s*${cohortPattern}`, "iu").test(text)
  const treatmentPattern = identifierPattern(String(columns.treatment_var))
  const timingRule = `${timePattern}\\s*(?:>=|≥)\\s*${cohortPattern}`
  const treatmentRuleDenied = new RegExp(
    `${treatmentPattern}[^。；;\\n]{0,40}(?:不应|不必|不需要|不得|不能|不等于|不符合|不一致|不要|而非)[^。；;\\n]{0,20}${timingRule}`,
    "iu",
  ).test(text)
  const treatmentRule = !treatmentRuleDenied && new RegExp(
    `${treatmentPattern}[^。；;\\n]{0,20}(?:必须|需要|应当|应|须)[^。；;\\n]{0,20}${timingRule}`,
    "iu",
  ).test(text)
  const sentinelPattern = "(?:-inf(?![A-Za-z0-9_])|负无穷)"
  const neverTreated = "(?:从未处理(?:组|单位|个体)?|未处理组|never.?treated)"
  const sentinelDenied = new RegExp(
    `${neverTreated}[^。；;\\n]{0,30}(?:不要|不应|不得|不能|而非|不是)[^。；;\\n]{0,20}${sentinelPattern}`,
    "iu",
  ).test(text)
  const hasNeverTreatedSentinel = !sentinelDenied && new RegExp(
    `${neverTreated}[^。；;\\n]{0,20}(?:设为|编码为|记为|置为|取值为|使用)\\s*${sentinelPattern}`,
    "iu",
  ).test(text)
  return !(
    affirmative &&
    formula &&
    hasEntity &&
    hasIdentifier(String(columns.treatment_var)) &&
    treatmentRule &&
    hasIdentifier(String(columns.output_column)) &&
    hasNeverTreatedSentinel
  )
}

/** Cohort 缺失不能仅凭模型参数解释为 never-treated；只允许显式确认后做内存编码。 */
export function needsEventStudyNeverTreatedConfirmation(input: {
  methodID: string
  userText?: string
  args: unknown
}) {
  if (input.methodID !== "did_event_study_saturated" || !input.args || typeof input.args !== "object" || Array.isArray(input.args)) return false
  const args = input.args as Record<string, unknown>
  if (args.neverTreatedCohortValue !== 0) return false
  const cohort = args.cohortVar
  const time = args.timeVar
  const treatment = args.treatmentVar
  if (![cohort, time, treatment].every((value) => typeof value === "string" && value.trim())) return true

  const text = input.userText ?? ""
  if (/(?:先问我|先向我确认|等我确认|不要(?:自动)?(?:编码|映射|转换|估计|执行)|不要[^。；;\n]{0,8}(?:0|零)[^。；;\n]{0,8}(?:编码|映射|设为|处理)|先别(?:编码|映射|转换|估计|执行)|请勿(?:编码|映射|转换|估计|执行)|暂停|暂缓|撤回(?:这项|该)?(?:确认|同意|授权)|我不(?:确认|同意|授权)|停止(?:编码|映射|转换|估计|执行))/u.test(text)) return true
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const identifier = (value: string) => /^[A-Za-z0-9_]+$/u.test(value)
    ? `(?<![A-Za-z0-9_])${escapeRegex(value)}(?![A-Za-z0-9_])`
    : `[\\x60\"'“‘「『]${escapeRegex(value)}[\\x60\"'”’」』]`
  const affirmative = /(?:我(?:明确)?(?:确认|同意|授权|批准)|(?:确认|同意|授权|批准)(?:按|采用|使用|照此))/u.test(text)
  const cohortName = String(cohort)
  const timeName = String(time)
  const treatmentName = String(treatment)
  const missingMeansNeverTreated = new RegExp(
    `(?:cohort\\s*=\\s*${identifier(cohortName)}|${identifier(cohortName)})[^。；;\\n]{0,24}(?:缺失|missing)[^。；;\\n]{0,30}(?:从未处理|never.?treated)|(?:从未处理|never.?treated)[^。；;\\n]{0,30}(?:缺失|missing)[^。；;\\n]{0,24}${identifier(cohortName)}`,
    "iu",
  ).test(text)
  const zeroSentinel = /(?:按|映射为|编码为|设为)\s*0|cohort\s*=\s*0/iu.test(text)
  const treatmentRuleDenied = new RegExp(
    `${identifier(treatmentName)}[^。；;\\n]{0,40}(?:不应|不必|不需要|不能|不得|不等于|不符合|不一致|不要)[^。；;\\n]{0,20}${identifier(cohortName)}\\s*>\\s*0[^。；;\\n]{0,15}(?:且|and)?\\s*${identifier(timeName)}\\s*>=\\s*${identifier(cohortName)}`,
    "iu",
  ).test(text)
  const treatmentRule = !treatmentRuleDenied && new RegExp(
    `${identifier(treatmentName)}[^。；;\\n]{0,30}(?:等于|符合|满足)[^。；;\\n]{0,20}${identifier(cohortName)}\\s*>\\s*0[^。；;\\n]{0,15}(?:且|and)?\\s*${identifier(timeName)}\\s*>=\\s*${identifier(cohortName)}`,
    "iu",
  ).test(text)
  const missingOrZeroDenied = /(?:不代表|不表示|不能表示|不是|不属于|不等于|不要|别|不应|不得|不能|不想)[^。；;\n]{0,30}(?:从未处理|never.?treated|(?:映射|编码|按|设为)\s*0|(?:cohort\s*=\s*)?0)|(?:不要|别|不应|不得|不能)[^。；;\n]{0,20}(?:缺失|missing)[^。；;\n]{0,20}(?:从未处理|never.?treated|0)/iu.test(text)
  return !(affirmative && missingMeansNeverTreated && zeroSentinel && treatmentRule && !missingOrZeroDenied)
}

/**
 * 中位数分组会改变样本划分，不能把模型临时猜出的 right_value 当成中位数。
 * 当前 data_preprocess 没有分组统计算子；用户未提供阈值或现成分类列时，
 * 工具端必须在写入 child stage 前停下。
 */
export function needsMedianGroupingConfirmation(input: { userText?: string; args: unknown }) {
  if (!input.args || typeof input.args !== "object" || Array.isArray(input.args)) return false
  const args = input.args as Record<string, unknown>
  if (args.method !== "create_column") return false
  const options = args.options && typeof args.options === "object" && !Array.isArray(args.options)
    ? args.options as Record<string, unknown>
    : {}
  const outputColumn = options.output_column ?? args.output_column
  const text = input.userText ?? ""
  const asksMedianGrouping = /中位数|median/i.test(text) && /分组|高低组|高低两组|分类列/i.test(text)
  if (!asksMedianGrouping) return false
  // 只有用户明确提供阈值，或明确指定现成分类列时，才允许继续；模型自行填入
  // right_value 不构成用户确认。
  const hasExplicitThreshold = /(?:中位数|阈值)[^。\n]{0,20}(?:为|是|=|:|：)\s*-?\d+(?:\.\d+)?/i.test(text)
  const hasExistingClassification = typeof outputColumn === "string" && /(?:组|分类|分组)/.test(outputColumn) &&
    /(?:已有|现成|提供)[^。\n]{0,30}(?:列|变量)/.test(text)
  return !hasExplicitThreshold && !hasExistingClassification
}

/** 只有具体规则或明确确认词才算接受post定义；窗口选择、逐行比较等泛化回答不算。 */
export function confirmsPolicyConstructionAnswer(answer: string) {
  const text = answer.trim()
  if (!text || /其他|停止|取消|不创建/.test(text)) return false
  return (
    /确认|同意|按此规则|按当前规则/.test(text) ||
    /按个体时点构造/.test(text) ||
    /固定(?:政策)?年\s*\d{4}/.test(text) ||
    /(?:year|年份|time|时间)\s*(?:>=|≥|>|等于|之后|起)\s*\d{4}/i.test(text)
  )
}

/** Question 确认后给下一轮模型一个可执行的收束信号，避免继续探查同一事实。 */
export function policyConstructionFollowUpNotice(answer: string) {
  if (!confirmsPolicyConstructionAnswer(answer)) return ""
  return "已确认政策后规则；若 post 尚不存在，下一步直接调用 data_preprocess 的 create_column 按已确认规则构造，不要再次用 frequency/profile 探查同一事实。"
}

/**
 * 工具解析：把注册表里的工具按本轮策略过滤，转成模型可用的 schema 与执行端口。
 *
 * schema discovery 与 AI SDK 的 execute 闭包必须分离：前者属于工具层，后者只是模型
 * 服务适配。这样 AgentEngine 接管循环时能直接复用同一个 port，而不是把具体工具执行
 * 藏在 streamText 的回调里。
 */

export type ModelToolDefinition = {
  id: string
  modelNamespace: Tool.ModelNamespace
  execution: Tool.ExecutionPolicy
  description: string
  inputSchema: ReturnType<typeof jsonSchema>
  descriptor?: UnifiedToolDescriptor
}

export type MethodToolReference = {
  toolID: string
  modelNamespace: Tool.ModelNamespace
  description: string
  inputSchema: unknown
  descriptor?: UnifiedToolDescriptor
}

type ToolPortCall = {
  id: string
  name: string
  input: unknown
  abort: AbortSignal
  schemaSentToolIDs?: readonly string[]
  batchSize?: number
  batchIndex?: number
}

export type ResolvedToolSet = {
  definitions: Record<string, ModelToolDefinition>
  setRequestAllowlist(toolIDs: readonly string[]): void
  refreshToolPool(): Promise<void>
  commitDeferredTools(): Promise<void>
  /** 在同一模型批次的工具结果全部准备好后，启动延后的后台核验。 */
  flushDeferredVerifiers?(abortSignal?: AbortSignal): void
  methodReferences(): MethodToolReference[]
  deferredToolSummary(): Array<{ modelNamespace: Tool.ModelNamespace; count: number }>
  toolPoolSnapshot(): {
    visibleToolIDs: string[]
    visibleCount: number
    systemToolCount: number
    methodToolCount: number
    schemaTokens: number
    deferredCount: number
    deferredByNamespace: Array<{ modelNamespace: Tool.ModelNamespace; count: number }>
  }
  port: {
    execute(call: ToolPortCall): Promise<unknown>
  }
}

/**
 * `preserveLabels` 只影响 data_import 读写 DTA 时的标签保留。部分模型会在紧随导入
 * 的估计调用中机械复制该无语义字段；移除这一项不会改变任何估计规格。
 *
 * 这里刻意不做通用“未知字段容错”：其余字段仍由各工具的 strict Zod schema 拒绝，
 * 以免掩盖变量、模型或识别设定错误。
 */
export function normalizeKnownCrossToolFields(toolName: string, args: unknown): unknown {
  // econometrics_execute 的外层对象必须保持 strict；preserveLabels 只能在真实
  // 估计器参数兼容层被移除，不能让它绕过稳定路由自己的 envelope 校验。
  if (toolName === "data_import" || toolName === "econometrics_execute" || !args || typeof args !== "object" || Array.isArray(args)) return args
  const source = args as Record<string, unknown>
  const { preserveLabels: _preserveLabels, ...rest } = source

  if (toolName === "data_preprocess") {
    for (const field of ["operator", "right_column", "right_value", "output_column"]) {
      if (rest[field] === "" || rest[field] === null) delete rest[field]
    }
    if (rest.options && typeof rest.options === "object" && !Array.isArray(rest.options)) {
      const options = { ...(rest.options as Record<string, unknown>) }
      for (const field of ["operator", "right_column", "right_value", "output_column"]) {
        if (options[field] === "" || options[field] === null) delete options[field]
      }
      rest.options = options
    }
  }
  return rest
}

/**
 * 兼容模型把稳定计量路由的 envelope 错套到已经加载的具体方法名上的情况。
 *
 * 这是无损的调用形状修复，不替换方法、不修改研究参数：只有当 methodID 与当前
 * 具体工具名完全一致、且对象恰好只有 methodID/arguments 两个字段时才解包；其余
 * 情况继续交给具体方法的 strict schema 报错，避免把真实的未知字段或方法切换吞掉。
 */
export function normalizeDirectMethodEnvelope(toolName: string, args: unknown): unknown {
  if (!isConcreteMethodTool(toolName) || !args || typeof args !== "object" || Array.isArray(args)) return args
  const source = args as Record<string, unknown>
  if (
    Object.keys(source).length !== 2 ||
    source.methodID !== toolName ||
    !source.arguments ||
    typeof source.arguments !== "object" ||
    Array.isArray(source.arguments)
  ) {
    return args
  }
  return source.arguments
}

/**
 * 解释性追问仍保留系统工具的可见性，但不应让模型用 read/list/glob/grep 猜测
 * 内部结果路径。一次安全短路比抛错更合适：它给模型明确的收尾信号，同时保留
 * “如果用户明确要求文件，再进入 ingest”这条正常路径。
 */
export function consultationToolBlock(toolName: string, consultationOnly: boolean) {
  if (!consultationOnly || !["read", "list", "glob", "grep"].includes(toolName)) return undefined
  return {
    title: "当前问题无需读取文件",
    output: "当前是对已完成结果的解释性追问；本轮不读取内部文件，也不启动新的估计。请直接依据已核验的结果回答；若需要查看具体文件，请等待用户明确指定文件或产物。",
    metadata: {
      noNewInformation: true,
      consultationGuard: true,
    },
  }
}

/**
 * 识别用户明确点名的时间变量是否被模型换成了另一个列名。
 *
 * 只读取“时间=xxx / 时间变量为xxx / timeVar: xxx”这类明确字段，不对自然语言
 * 中偶然出现的“时间”做推断。变量替换可能改变研究设定，即使候选列看起来只是
 * 中英文名称对应，也必须先让用户确认。
 */
export type VariableSubstitutionField = "dependentVar" | "treatmentVar" | "entityVar" | "timeVar"

const EXPLICIT_VARIABLE_LABELS: Record<VariableSubstitutionField, string> = {
  dependentVar: "因变量|被解释变量|结果变量",
  treatmentVar: "核心解释变量|处理变量|解释变量|自变量",
  entityVar: "实体|个体|面板个体|entityVar",
  timeVar: "时间变量|时间列|时间|timeVar|time\\s+variable",
}
const VARIABLE_FIELD_LABELS: Record<VariableSubstitutionField, string> = {
  dependentVar: "因变量",
  treatmentVar: "核心解释变量",
  entityVar: "实体变量",
  timeVar: "时间变量",
}

/** 返回用户在正向变量角色规格中明确指定的列名；否定句中的示例不构成规格。 */
export function explicitUserVariableValue(input: {
  userText?: string
  field: VariableSubstitutionField
}) {
  if (!input.userText) return undefined
  const token = "([A-Za-z_][A-Za-z0-9_]*|[一-鿿][一-鿿A-Za-z0-9_]*)"
  const match = new RegExp(
    "(?<![一-鿿A-Za-z0-9_])(?:" + EXPLICIT_VARIABLE_LABELS[input.field] + ")\\s*(?:是|为|=|:|：)\\s*[“\\\"'`]?" + token,
    "i",
  ).exec(input.userText)
  const value = match?.[1]?.trim()
  if (!match || !value) return undefined
  const clauseStart = Math.max(
    input.userText.lastIndexOf("，", match.index),
    input.userText.lastIndexOf(",", match.index),
    input.userText.lastIndexOf("；", match.index),
    input.userText.lastIndexOf(";", match.index),
    input.userText.lastIndexOf("。", match.index),
    input.userText.lastIndexOf(".", match.index),
    input.userText.lastIndexOf("\n", match.index),
  )
  const prefix = input.userText.slice(clauseStart + 1, match.index).trim()
  const suffix = input.userText.slice(match.index + match[0].length).split(/[。.!?！？\n]/u, 1)[0]
  const negatedBefore = /(?:不要|别|不应|不需要|不使用|不用|禁止|避免|不能|不得)(?:\s*(?:使用|采用|选择|指定|设置|把|将|用))?\s*[：:]?\s*$/u.test(prefix)
  const negative = "(?:不要|别|不应|不需要|不使用|不用|禁止|避免|不能|不得)"
  const columnReference = `(?:${value}|(?:这|该|此|这个)(?:一)?(?:列|变量)|它)`
  const negatedAfter = new RegExp(
    `${negative}[^，,；;]{0,12}${columnReference}|${columnReference}[^，,；;]{0,8}${negative}`,
    "u",
  ).test(suffix)
  if (negatedBefore || negatedAfter) {
    return undefined
  }
  return value
}

function explicitUserCovarianceValue(userText?: string) {
  if (!userText) return undefined
  const pattern = /(?:协方差(?:口径)?\s*(?:是|为|=|:|：)?\s*|(?:采用|使用|按)\s*)(HC[123]|robust|nonrobust)\b/giu
  const separators = ["。", "；", ";", "，", ",", "\n"]
  const values: string[] = []
  for (const match of userText.matchAll(pattern)) {
    const index = match.index ?? 0
    const clauseStart = Math.max(...separators.map((separator) => userText.lastIndexOf(separator, index)))
    const prefix = userText.slice(clauseStart + 1, index).trim()
    if (/(?:不要|别|不应|不需要|不使用|不采用|不用|不得|禁止|避免|不能|not|without)(?:\s*(?:使用|采用|按|选择|指定|设置|用))?\s*$/iu.test(prefix)) continue
    const value = match[1]?.trim()
    if (value) values.push(value)
  }
  const normalized = [...new Set(values.map((value) => value.toLowerCase()))]
  return normalized.length === 1 ? values[0] : undefined
}

function covarianceSpecKey(methodID: string, value: string) {
  const normalized = value.trim().toLowerCase()
  return ["ols_regression", "wls_regression"].includes(methodID) && normalized === "robust"
    ? "hc1"
    : normalized
}

export function detectExplicitVariableSubstitution(input: {
  userText?: string
  field: VariableSubstitutionField
  actualValue: string
}) {
  if (!input.userText || !input.actualValue.trim()) return undefined
  const requestedValue = explicitUserVariableValue({ userText: input.userText, field: input.field })
  if (!requestedValue || requestedValue === input.actualValue.trim()) return undefined
  return { field: input.field, requestedValue, actualValue: input.actualValue.trim() }
}

/**
 * 识别模型通过 question 工具提出的变量替换确认，并在用户选择替代列后返回同一替换事实。
 * 需要同时匹配用户原始变量角色，避免把普通“是否使用某列”的问题误记成研究授权。
 */
export function detectConfirmedVariableSubstitution(input: {
  userText?: string
  question: string
  answer: string
}) {
  const token = "([A-Za-z_][A-Za-z0-9_]*|[一-鿿][一-鿿A-Za-z0-9_]*)"
  const directPair = new RegExp(
    `(?:${Object.values(EXPLICIT_VARIABLE_LABELS).join("|")})\\s*[“「'‘]?${token}[”」'’"]?[^。\\n]{0,60}?(?:名为|实际存在|准备使用|有|用)\\s*[“「'‘]?${token}[”」'’"]?`,
    "i",
  ).exec(input.question)
  // “使用哪一列”中的“用”可能被宽松模式误识别为已给出 actual 列名；只有
  // 该列名确实出现在用户选择答案里，才允许 directPair 覆盖其他问法的解析。
  const confirmedDirectPair = directPair && input.answer.includes(directPair[2]?.trim() ?? "") ? directPair : undefined
  const reversePair = new RegExp(
    `(?:${Object.values(EXPLICIT_VARIABLE_LABELS).join("|")})[^。\\n]{0,60}?(?:列名为|显示为|实际(?:存在|列名)?为|名称为|名为)\\s*[“「'‘]?${token}[”」'’"]?[^。\\n]{0,30}?(?:没有|无|不存在|不是)\\s*[“「'‘]?${token}[”」'’"]?`,
    "i",
  ).exec(input.question)
  const reversePairAfter = new RegExp(
    `(?:当前|本)?数据中[^。\\n]{0,20}?(?:列名为|显示为|实际(?:存在|列名)?为|名称为|名为)\\s*[“「'‘]?${token}[”」'’"]?[^。\\n]{0,30}?(?:没有|无|不存在|不是)\\s*[“「'‘]?${token}[”」'’"]?`,
    "i",
  ).exec(input.question)
  // 兼容“数据中无旧列，但有新列”的旧问题格式；研究角色仍由 userText 校验。
  const unlabelledPair = new RegExp(
    `(?:无|没有|不存在)\\s*[“「'‘]?${token}[”」'’"]?[^。\\n]{0,30}?(?:有|实际存在|名为)\\s*[“「'‘]?${token}[”」'’"]?`,
    "i",
  ).exec(input.question)
  const missingColumnQuestion = new RegExp(
    `(?:${Object.values(EXPLICIT_VARIABLE_LABELS).join("|")})\\s*[“「'‘]?${token}[”」'’"]?[^。\\n]{0,40}?(?:未找到|未发现|不存在|没有)`,
    "i",
  ).exec(input.question)
  // 正向问题先出现用户写法，反向问题先出现真实列名；统一成 requested/actual。
  const requestedValue = confirmedDirectPair?.[1]?.trim() ?? reversePair?.[2]?.trim() ?? reversePairAfter?.[2]?.trim() ?? unlabelledPair?.[1]?.trim() ?? missingColumnQuestion?.[1]?.trim()
  const answerPair = input.answer.match(new RegExp(`(?:使用|用|选择|替换为|替代为|改为)\\s*[“「'‘]?${token}[”」'’"]?`, "i"))
  const answerTokens = input.answer.match(/[一-鿿][一-鿿A-Za-z0-9_]*/g) ?? []
  const answerActual = answerPair?.[1]?.trim() ?? answerTokens.toReversed().find((value) => value !== requestedValue && value.length > 1)
  const actualValue = confirmedDirectPair?.[2]?.trim() ?? reversePair?.[1]?.trim() ?? reversePairAfter?.[1]?.trim() ?? unlabelledPair?.[2]?.trim() ?? (missingColumnQuestion ? answerActual : undefined)
  if (requestedValue && actualValue && input.answer.includes(actualValue)) {
    for (const field of Object.keys(EXPLICIT_VARIABLE_LABELS) as VariableSubstitutionField[]) {
      const substitution = detectExplicitVariableSubstitution({
        userText: input.userText,
        field,
        actualValue,
      })
      if (substitution?.requestedValue === requestedValue) return substitution
    }
  }

  // 模型有时只复述真实列名，例如“核心解释变量在数据中显示为城镇化水平”，
  // 不会把用户原始写法再次放进问题。仍以用户原始角色和用户回答为准，恢复同一
  // 替换事实，避免下一层的参数门禁再次询问同一件事。
  for (const field of Object.keys(EXPLICIT_VARIABLE_LABELS) as VariableSubstitutionField[]) {
    const actualOnly = new RegExp(
      `(?:${EXPLICIT_VARIABLE_LABELS[field]})[^。\\n]{0,60}?(?:显示为|列名为|实际(?:存在|列名)?为|名称为|名为)\\s*[“「'‘]?${token}[”」'’"]?`,
      "i",
    ).exec(input.question)
    const actual = actualOnly?.[1]?.trim()
    if (!actual || !input.answer.includes(actual)) continue
    const substitution = detectExplicitVariableSubstitution({
      userText: input.userText,
      field,
      actualValue: actual,
    })
    if (substitution) return substitution
  }
  return undefined
}

export type VariableSubstitution = {
  field: VariableSubstitutionField
  requestedValue: string
  actualValue: string
}

export function variableSubstitutionConfirmationKey(input: VariableSubstitution) {
  return `${input.field}:${input.requestedValue}\u0000${input.actualValue}`
}

/**
 * 为不存在的列找“只供用户确认”的候选，不负责静默改名。
 * 别名只覆盖无歧义的常见中英文写法；其他候选要求字符相似度足够高且必须唯一，
 * 像 post 这样的研究设计变量没有候选就保持空值，避免模型凭空构造政策规则。
 */
export function suggestColumnReplacement(requested: string, availableColumns: readonly string[]) {
  const source = requested.trim()
  const columns = [...new Set(availableColumns.map((column) => column.trim()).filter(Boolean))]
  if (!source || columns.length === 0) return undefined

  const aliases: Record<string, string[]> = {
    year: ["年份", "年度"],
    time: ["时间", "年份", "年度"],
    entity: ["实体", "个体"],
  }
  const aliasMatches = columns.filter((column) => aliases[source.toLowerCase()]?.includes(column))
  if (aliasMatches.length === 1) return aliasMatches[0]

  const sourceChars = new Set([...source].filter((char) => /[一-鿿A-Za-z0-9_]/.test(char)))
  if (sourceChars.size < 2) return undefined
  const ranked = columns
    .map((column) => {
      const candidateChars = new Set([...column].filter((char) => /[一-鿿A-Za-z0-9_]/.test(char)))
      const overlap = [...sourceChars].filter((char) => candidateChars.has(char)).length
      let prefix = 0
      while (prefix < source.length && prefix < column.length && source[prefix] === column[prefix]) prefix += 1
      return { column, score: overlap / Math.max(sourceChars.size, candidateChars.size), prefix }
    })
    .sort((left, right) => right.score - left.score || right.prefix - left.prefix)
  const best = ranked[0]
  const second = ranked[1]
  if (!best || best.score < 0.6 || (second && best.score === second.score)) return undefined
  return best.column
}

export function shouldAskVariableSubstitution(input: {
  substitution?: VariableSubstitution
  confirmed: ReadonlySet<string>
}) {
  return Boolean(input.substitution && !input.confirmed.has(variableSubstitutionConfirmationKey(input.substitution)))
}

export function emptyToolSet(): ResolvedToolSet {
  return {
    definitions: {},
    setRequestAllowlist() {},
    async refreshToolPool() {},
    async commitDeferredTools() {},
    flushDeferredVerifiers() {},
    methodReferences: () => [],
    deferredToolSummary: () => [],
    toolPoolSnapshot: () => ({
      visibleToolIDs: [],
      visibleCount: 0,
      systemToolCount: 0,
      methodToolCount: 0,
      schemaTokens: 0,
      deferredCount: 0,
      deferredByNamespace: [],
    }),
    port: {
      async execute() {
        throw new Error("No tools are available in this model request.")
      },
    },
  }
}

function boundedProgressMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) return undefined
  const prepared = prepareToolMetadata(metadata)
  return Object.fromEntries(
    Object.entries(prepared)
      .slice(0, 12)
      .map(([key, value]) => {
        if (typeof value === "string") return [key, value.slice(0, 2_000)]
        if (value === null || typeof value === "number" || typeof value === "boolean") return [key, value]
        try {
          return [key, JSON.stringify(value).slice(0, 2_000)]
        } catch {
          return [key, String(value).slice(0, 2_000)]
        }
      }),
  )
}

export function publishToolProgress(input: {
  sessionID: string
  callID: string
  toolName: string
  message: string
  metadata?: Record<string, unknown>
}) {
  Bus.publish(RuntimeEvents.ToolProgress, {
    ...input,
    message: input.message.slice(0, 240),
    metadata: boundedProgressMetadata(input.metadata),
  })
}

export function bindToolPort(input: ResolvedToolSet): Record<string, AITool> {
  return Object.fromEntries(
    Object.entries(input.definitions).map(([name, definition]) => [
      name,
      tool({
        id: definition.id as any,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }),
    ]),
  )
}

/** Serialize only the schema surface sent to the Provider; do not count Harness descriptors or runtime metadata. */
export function providerToolSchemaText(definitions: Record<string, ModelToolDefinition>) {
  return Object.entries(definitions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, definition]) => JSON.stringify({
      type: "function",
      function: {
        name: id,
        description: definition.description,
        parameters: (definition.inputSchema as unknown as { jsonSchema?: unknown }).jsonSchema,
      },
    }))
    .join("\n")
}

export function buildModelToolJsonSchema(
  parameters: z.ZodType,
  inputExamples?: readonly Record<string, unknown>[],
) {
  if (!parameters || typeof parameters !== "object" || !("_zod" in parameters)) {
    throw new Error("工具参数 schema 必须使用 Zod 4 定义；不接受未经验证的原始 JSON Schema 对象。")
  }
  const converted = z.toJSONSchema(parameters, { unrepresentable: "any" })
  if (!inputExamples?.length) return converted
  return {
    ...converted,
    examples: inputExamples.slice(0, 2),
  }
}

export async function resolveTools(input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  tools?: Record<string, boolean>
  processor: SessionProcessor.Info
  intent?: WorkflowInputIntent
  hasImageInput?: boolean
  hasDataAttachment?: boolean
  repairToolName?: string
  preferredToolIDs?: string[]
  requiredToolIDs?: string[]
  psmToolScope?: "diagnostics_only" | "blocked"
  psmScopeFilter?: { column: string; value: string | number }
  confirmedToolIDs?: string[]
  allowTask?: boolean
  /** 当前真实用户消息；仅用于在研究变量被替换前触发确认。 */
  userText?: string
  sourceUserMessageId?: string
  /** 当前用户动作内已经确认过的研究变量替换；新用户动作由调用方传入新 Set。 */
  confirmedVariableSubstitutions?: Set<string>
  /** 当前用户消息是压缩后自动续接消息；从 TaskLedger 恢复原 AnalysisRequest。 */
  resumeAnalysisRequest?: boolean
  confirmedPolicyConstruction?: { value: boolean }
  userDecisionStop?: { value: boolean }
  /** Desktop 选择的 Excel sheet，属于受管请求元数据，不能拼进用户/模型正文。 */
  worksheetName?: string
}) {
  using _ = log.time("resolveTools")
  if (input.resumeAnalysisRequest) {
    const ledger = RuntimeTaskLedger.listTasks(input.session.id)
    const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId)
    const request = task?.analysisRequest
    if (task && request) {
      const sourceMessage = await MessageV2.get({ sessionID: input.session.id, messageID: request.sourceMessageId }).catch(() => undefined)
      const originalUserText = sourceMessage?.parts
        .map((part) => part.type === "text" && !part.synthetic && !part.ignored ? part.text.trim() : "")
        .filter(Boolean)
        .join("\n")
      const stringArray = (value: unknown) => Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : undefined
      const savedIntent = task.metadata?.intent
      const validIntents = new Set<WorkflowInputIntent>(["conversation", "ingest", "status", "verify", "repair", "report", "analysis"])
      const savedPsmScope = task.metadata?.psmToolScope
      const savedPsmFilter = task.metadata?.psmScopeFilter
      input = {
        ...input,
        ...(typeof savedIntent === "string" && validIntents.has(savedIntent as WorkflowInputIntent)
          ? { intent: savedIntent as WorkflowInputIntent }
          : {}),
        hasDataAttachment: input.hasDataAttachment ?? DataContext.hasActiveDataset(input.session.id),
        sourceUserMessageId: request.sourceMessageId,
        userText: originalUserText || request.researchGoal,
        preferredToolIDs: input.preferredToolIDs?.length ? input.preferredToolIDs : stringArray(task.metadata?.preferredToolIDs),
        requiredToolIDs: input.requiredToolIDs?.length ? input.requiredToolIDs : stringArray(task.metadata?.requiredToolIDs),
        confirmedToolIDs: input.confirmedToolIDs?.length ? input.confirmedToolIDs : stringArray(task.metadata?.confirmedToolIDs),
        ...(savedPsmScope === "diagnostics_only" || savedPsmScope === "blocked" ? { psmToolScope: savedPsmScope } : {}),
        ...(savedPsmFilter && typeof savedPsmFilter === "object" && !Array.isArray(savedPsmFilter)
          ? { psmScopeFilter: savedPsmFilter as { column: string; value: string | number } }
          : {}),
        allowTask: input.allowTask ?? task.metadata?.allowTask === true,
      }
    }
  }
  const definitions: Record<string, ModelToolDefinition> = {}
  const resolvedIntent: WorkflowInputIntent = input.intent ?? "conversation"
  const psmToolScope = input.psmToolScope
  const recommendedMethod = getActiveWorkflowRun(input.session.id)?.lastRecommendationMethod
  const qualityInspectionOnly = isQualityInspectionOnlyRequest(input.userText)
  const requiresPostImportProfileAfterImport = requiresPostImportProfile(input.userText)
  const recommendationOnly = isRecommendationOnlyRequest(input.userText)
  const sourceUserMessageId = input.sourceUserMessageId ?? input.processor.message.parentID
  const dataWorkIntent = ["analysis", "ingest", "repair"].includes(resolvedIntent)
  const hasExplicitDataSource = explicitUserDataPaths(input.userText).some(isDataFile)
  const dataBearingRequest = input.agent.name === "analyst" && (
    input.hasDataAttachment === true ||
    hasExplicitDataSource ||
    (dataWorkIntent && DataContext.hasActiveDataset(input.session.id))
  )
  const sourceTask = sourceUserMessageId
    ? RuntimeTaskLedger.listTasks(input.session.id).tasks.find((item) => item.messageID === sourceUserMessageId)
    : undefined
  const registeredRequest = sourceTask && sourceUserMessageId &&
    sourceTask.analysisRequest?.sourceMessageId === sourceUserMessageId
    ? sourceTask.analysisRequest
    : undefined
  const needsRequestRegistration = () => {
    if (!dataBearingRequest || !sourceUserMessageId) return false
    return needsAnalysisRequestRegistration({
      agent: input.agent.name,
      intent: resolvedIntent,
      userMessageId: sourceUserMessageId,
      hasDataAttachment: input.hasDataAttachment === true,
      hasExplicitDataSource,
      hasActiveDataset: dataWorkIntent && DataContext.hasActiveDataset(input.session.id),
      request: registeredRequest,
    })
  }
  const analysisRequestRequired = needsRequestRegistration()
  const permissionDisabled = PermissionNext.disabled(
    TOOL_MANIFEST.map((entry) => entry.id),
    PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
  )
  const isToolEnabled = (toolID: string) => {
    if (permissionDisabled.has(toolID)) return false
    if (input.tools?.[toolID] === false) return false
    if (toolID === "shell" && input.tools?.bash === false) return false
    if (toolID === "bash" && input.tools?.shell === false) return false
    return true
  }

  const extractKeyedValue = (input: string, key: string): string | undefined => {
    const match = new RegExp(`\\b${key}\\s*[:=]\\s*([^\\n\\r}]+)`, "i").exec(input)
    if (!match) return undefined
    return match[1]
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .replace(/[},]+$/g, "")
      .trim()
  }

  const isShellCommandTool = (toolName: string) => toolName === "bash" || toolName === "shell"

  const mapStringToolInput = (toolName: string, value: string): Record<string, unknown> | undefined => {
    if (isShellCommandTool(toolName)) {
      const extracted = extractKeyedValue(value, "command")
      if (extracted) return { command: extracted }
      return { command: value.trim() }
    }
    if (toolName === "glob") {
      const extracted = extractKeyedValue(value, "pattern")
      if (extracted) return { pattern: extracted }
      return { pattern: value.trim() }
    }
    return undefined
  }

  const normalizeToolArgs = (toolName: string, args: unknown): unknown => {
    const finalize = (value: unknown) => normalizeKnownCrossToolFields(toolName, normalizeDirectMethodEnvelope(toolName, value))
    if (typeof args !== "string") return finalize(args)
    try {
      const parsed = JSON.parse(args)
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return finalize(parsed)
      }
      if (typeof parsed === "string") {
        const mapped = mapStringToolInput(toolName, parsed)
        if (mapped) return finalize(mapped)
      }
    } catch {
      // fall through to raw string mapping
    }
    if (isShellCommandTool(toolName)) {
      const command = extractKeyedValue(args, "command")
      const workdir = extractKeyedValue(args, "workdir")
      const description = extractKeyedValue(args, "description")
      const timeoutRaw = extractKeyedValue(args, "timeout")
      const timeout = timeoutRaw ? Number(timeoutRaw) : undefined
      if (command) {
        return finalize({
          command,
          ...(workdir ? { workdir } : {}),
          ...(description ? { description } : {}),
          ...(Number.isFinite(timeout) ? { timeout } : {}),
        })
      }
    }
    if (toolName === "glob") {
      const pattern = extractKeyedValue(args, "pattern")
      const path = extractKeyedValue(args, "path")
      if (pattern) return finalize({ pattern, ...(path ? { path } : {}) })
    }
    return finalize(mapStringToolInput(toolName, args) ?? args)
  }

  let searchDeferredTools: ((input: { query: string; limit: number }) => Promise<{
    matches: Array<{
      toolID: string
      description: string
      inputSchema?: unknown
      useWhen?: string
      doNotUseWhen?: string
      inputRequirements?: string[]
      diagnosticRequirements?: string[]
      descriptor?: UnifiedToolDescriptor
    }>
    loadedToolIDs: string[]
    blockedReason?: "visible_tool_budget_full" | "recommendation_only"
  }>) | undefined

  const context = (args: any, call: ToolPortCall): Tool.Context => {
    const updateMetadata = async (val: { title?: string; metadata?: any }) => {
      const match = input.processor.partFromToolCall(call.id)
      if (match && match.state.status === "running") {
        await Session.updatePart({
          ...match,
          state: {
            title: val.title ?? match.state.title,
            metadata: prepareToolMetadata({ ...(match.state.metadata ?? {}), ...(val.metadata ?? {}) }),
            status: "running",
            input: args,
            time: {
              start: match.state.time.start,
            },
          },
        })
      }
    }
    const toolContext: Tool.Context = {
      sessionID: input.session.id,
      abort: call.abort,
      messageID: input.processor.message.id,
      callID: call.id,
      extra: {
        model: input.model,
        sourceUserMessageId,
        inputIntent: resolvedIntent,
        preferredToolIDs: input.preferredToolIDs,
        authorizedMethodIDs: [...new Set([...(input.requiredToolIDs ?? []), ...effectiveConfirmedToolIDs()])],
        confirmedToolIDs: input.confirmedToolIDs,
        qualityInspectionOnly,
        requiresPostImportProfile: requiresPostImportProfileAfterImport,
        recommendationOnly,
        toolSearch: async (searchInput: { query: string; limit: number }) => {
          if (!searchDeferredTools) throw new Error("当前运行时没有提供延迟工具加载器")
          return searchDeferredTools(searchInput)
        },
      },
      agent: input.agent.name,
      metadata: updateMetadata,
      progress(val) {
        publishToolProgress({
          sessionID: input.session.id,
          callID: call.id,
          toolName: call.name,
          message: val.message,
          metadata: val.metadata,
        })
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: call.id },
          ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
        })
      },
    }
    toolContext.extra!.prepareAnalysisSpec = async (params: {
      requestId: string
      methodID: string
      arguments: Record<string, unknown>
    }) => {
      if (!call.schemaSentToolIDs?.includes(params.methodID)) {
        return {
          status: "schema_not_sent" as const,
          message: `方法“${params.methodID}”的完整参数 Schema 尚未进入当前模型上下文；本次没有校验参数、读取数据或运行估计。请先调用 tool_search 搜索该精确方法 ID，再按完整参数 Schema 重新准备。`,
        }
      }
      if (!isConcreteMethodTool(params.methodID) || !activeMethodToolIDs.has(params.methodID)) {
        throw new Tool.InputValidationError("目标方法不是当前任务中已搜索并准入的方法；请先 tool_search 获取当前 Python Registry 方法定义。")
      }
      if (!sourceUserMessageId) {
        throw new Tool.InputValidationError("Harness 没有当前用户消息引用，未准备分析规格。")
      }
      const ledger = RuntimeTaskLedger.listTasks(input.session.id)
      const task = ledger.tasks.find((item) => item.taskId === ledger.activeTaskId && item.messageID === sourceUserMessageId)
      if (!task) {
        throw new Tool.InputValidationError("当前活动任务没有与本轮用户消息匹配的账本记录；未准备分析规格。")
      }
      const workflow = getActiveWorkflowRun(input.session.id)
      const currentData = workflow
        ? canonicalDataStageForWorkflow(workflow, activeOrLatestStage(workflow))
        : null
      if (!currentData) {
        throw new Tool.InputValidationError("当前会话没有已导入的规范化数据阶段；请先导入并诊断数据，再准备计量规格。")
      }
      const artifactInput = resolveArtifactInput(currentData)
      if (!artifactInput.resolvedInputPath) {
        throw new Tool.InputValidationError("当前数据阶段没有可读取的规范化文件；没有准备规格或运行估计。请重新检查当前数据阶段。")
      }
      const dataPath = await resolveDatasetStagePath({
        datasetId: currentData.datasetId,
        filePath: artifactInput.resolvedInputPath,
        toolName: "analysis_prepare",
        sessionID: input.session.id,
        messageID: input.processor.message.id,
        callID: call.id,
        ask: toolContext.ask,
      })
      const argumentsForPreparation = { ...params.arguments }
      const userSpecifiedCorrections: Array<{ field: string; modelValue: string; userValue: string }> = []
      const readinessState = readStoredDataReadinessState(currentData.datasetId, currentData.stageId)
      const persistedReadiness = artifactInput.stage?.metadata?.dataReadiness
      const persistedReadinessRecord = persistedReadiness && typeof persistedReadiness === "object" && !Array.isArray(persistedReadiness)
        ? persistedReadiness as Record<string, unknown>
        : undefined
      const persistedColumns = persistedReadinessRecord?.sourceStageId === currentData.stageId && Array.isArray(persistedReadinessRecord.columns)
        ? persistedReadinessRecord.columns.flatMap((column) =>
            column && typeof column === "object" && !Array.isArray(column) && typeof (column as Record<string, unknown>).name === "string"
              ? [(column as Record<string, unknown>).name as string]
              : [],
          )
        : []
      const readinessColumns = readinessState.report && !readinessState.stale
        ? readinessState.report.columns.map((column) => column.name)
        : persistedColumns
      if (readinessColumns.length) {
        for (const field of ["dependentVar", "treatmentVar", "entityVar", "timeVar"] as const) {
          const modelValue = argumentsForPreparation[field]
          const userValue = explicitUserVariableValue({ userText: input.userText, field })
          const authorizedCompositeEntity = field === "entityVar" &&
            typeof modelValue === "string" &&
            typeof argumentsForPreparation.timeVar === "string" &&
            userValue &&
            readinessState.report &&
            !readinessState.stale &&
            hasAuthorizedCompositeEntityStage({
              userText: input.userText,
              datasetId: currentData.datasetId,
              stageId: currentData.stageId,
              originalEntityVar: userValue,
              compositeEntityVar: modelValue,
              timeVar: argumentsForPreparation.timeVar,
              report: readinessState.report,
            })
          if (
            !authorizedCompositeEntity &&
            typeof modelValue === "string" &&
            userValue &&
            userValue !== modelValue &&
            readinessColumns.includes(userValue)
          ) {
            userSpecifiedCorrections.push({ field, modelValue, userValue })
          }
        }
      }
      if (userSpecifiedCorrections.length === 1) {
        const correction = userSpecifiedCorrections[0]!
        const taskState = RuntimeTaskLedger.listTasks(input.session.id).tasks
          .find((item) => item.taskId === task.taskId)?.analysisLifecycle
        if (
          taskState?.status === "waiting_user" &&
          taskState.issueCode === "DATA_COLUMN_MISSING" &&
          task.analysisRequest
        ) {
          RuntimeTaskLedger.transitionAnalysis({
            sessionID: input.session.id,
            taskId: task.taskId,
            event: {
              type: "decision_approved",
              requestId: task.analysisRequest.requestId,
              issueCode: "DATA_COLUMN_MISSING",
              resumeAs: "spec_pending",
              choice: correction.userValue,
              decisionMessageId: sourceUserMessageId,
            },
          })
        }
        argumentsForPreparation[correction.field] = correction.userValue
      } else {
        userSpecifiedCorrections.length = 0
      }
      RuntimeTaskLedger.transitionAnalysis({
        sessionID: input.session.id,
        taskId: task.taskId,
        event: { type: "spec_assessment_started", requestId: params.requestId, methodID: params.methodID },
      })
      try {
        const prepared = await prepareAnalysisSpecService({
          sessionID: input.session.id,
          taskId: task.taskId,
          sourceMessageId: sourceUserMessageId,
          requestId: params.requestId,
          methodID: params.methodID,
          arguments: argumentsForPreparation,
          ...(userSpecifiedCorrections.length
            ? { userSpecifiedFields: userSpecifiedCorrections.map((item) => item.field) }
            : {}),
          currentData: {
            ...currentData,
            dataPath,
            stageMetadata: artifactInput.stage?.metadata,
          },
          engine: engineClient,
          signal: call.abort,
        })
        const duplicateKeyIssue = prepared.spec?.preflight?.issues.find((issue) =>
          issue.code === "DATA_PANEL_KEY_NOT_UNIQUE" && typeof issue.summary_zh === "string",
        )
        const persistedPanelCandidates = persistedReadinessRecord && Array.isArray(persistedReadinessRecord.panelCandidates)
          ? persistedReadinessRecord.panelCandidates
          : []
        const panelCandidates = readinessState.report && !readinessState.stale
          ? readinessState.report.panelCandidates
          : persistedPanelCandidates
        const issueEvidence = duplicateKeyIssue?.evidence && typeof duplicateKeyIssue.evidence === "object" && !Array.isArray(duplicateKeyIssue.evidence)
          ? duplicateKeyIssue.evidence as Record<string, unknown>
          : undefined
        const issueTimeVar = typeof issueEvidence?.timeVar === "string" ? issueEvidence.timeVar : undefined
        const explicitlyRequestedCompositeCandidates = panelCandidates.filter((candidate) => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false
          const value = candidate as Record<string, unknown>
          const entityVars = Array.isArray(value.entityVars)
            ? value.entityVars.filter((name): name is string => typeof name === "string")
            : []
          return entityVars.length >= 2 &&
            value.unique === true &&
            value.entityMissingCount === 0 &&
            value.timeMissingCount === 0 &&
            (!issueTimeVar || value.timeVar === issueTimeVar) &&
            entityVars.every((name) => Boolean(input.userText?.includes(name)))
        })
        const authorizedRepair = duplicateKeyIssue &&
          allowsExplicitCompositePanelRepair({
            userText: input.userText,
            duplicateEntityTimeKey: duplicateKeyIssue.code === "DATA_PANEL_KEY_NOT_UNIQUE",
          }) &&
          explicitlyRequestedCompositeCandidates.length === 1
          ? {
              method: "combine_columns" as const,
              columns: (explicitlyRequestedCompositeCandidates[0] as Record<string, unknown>).entityVars as string[],
            }
          : undefined
        if (authorizedRepair && task.analysisRequest) {
          const lifecycle = RuntimeTaskLedger.listTasks(input.session.id).tasks
            .find((item) => item.taskId === task.taskId)?.analysisLifecycle
          if (lifecycle?.status === "waiting_user" && lifecycle.issueCode === "DATA_PANEL_KEY_NOT_UNIQUE") {
            RuntimeTaskLedger.transitionAnalysis({
              sessionID: input.session.id,
              taskId: task.taskId,
              event: {
                type: "decision_approved",
                requestId: task.analysisRequest.requestId,
                issueCode: "DATA_PANEL_KEY_NOT_UNIQUE",
                resumeAs: "repairing",
                choice: `combine_columns:${authorizedRepair.columns.join("+")}`,
                decisionMessageId: sourceUserMessageId,
              },
            })
          }
        }
        return {
          ...prepared,
          ...(userSpecifiedCorrections.length ? { userSpecifiedCorrections } : {}),
          ...(authorizedRepair ? {
            authorizedRepair,
            message: [
              prepared.message,
              `本条用户消息已明确授权按 ${authorizedRepair.columns.join("+" )} 构造复合实体键并保留观测。请调用 data_preprocess 的 combine_columns，生成新数据阶段后重新 profile/validate，再准备当前方法；估计器尚未运行。`,
            ].join("\n"),
          } : {}),
        }
      } catch (error) {
        const failureCode = error instanceof EconometricsEngineError ? error.code : "ANALYSIS_PREPARATION_FAILED"
        if (call.abort.aborted) {
          RuntimeTaskLedger.transitionAnalysis({
            sessionID: input.session.id,
            taskId: task.taskId,
            event: { type: "cancelled", requestId: params.requestId, outcomeConfirmed: true, failureCode },
          })
        } else {
          const modelCanCorrect = error instanceof EconometricsEngineError && (
            error.retryable || ["INVALID_ARGUMENT", "METHOD_NOT_FOUND", "SCHEMA_NOT_FOUND"].includes(error.code)
          )
          RuntimeTaskLedger.transitionAnalysis({
            sessionID: input.session.id,
            taskId: task.taskId,
            event: {
              type: "assessment_failed",
              requestId: params.requestId,
              failureCode,
              recovery: modelCanCorrect ? "model_correction" : "stop",
            },
          })
        }
        throw error
      }
    }
    return toolContext
  }

  // question / failure hook 已确认的方法必须在解析第一层工具池**之前**合并进 policy。
  // 若等 direct 工具先占满固定槽位再补加载，第三个方法会被截断，造成“已选方法不可调用”。
  const confirmedFromHook = ConfirmedMethods.peek(input.session.id)
  const activeConfirmedToolIDs = new Set([...(input.confirmedToolIDs ?? []), ...confirmedFromHook])
  const effectiveConfirmedToolIDs = () => [...activeConfirmedToolIDs]
  const toolAvailability: ToolAvailabilityPolicy = {
    sessionID: input.session.id,
    agent: input.agent.name,
    inputIntent: resolvedIntent,
    analysisRequestRequired,
    analysisRequestKind: registeredRequest?.kind,
    repairToolName: input.repairToolName,
    preferredToolIDs: input.preferredToolIDs,
    psmToolScope,
    psmScopeFilter: input.psmScopeFilter,
    confirmedToolIDs: effectiveConfirmedToolIDs(),
    qualityInspectionOnly,
    recommendationOnly,
    allowTask: input.allowTask,
    platformCapabilities: {
      // 只影响 MCP sidecar 的准入判定（explainMcpToolForWorkflow，供 pipeline 的
      // diagnostics 展示）。此前它还会顺带关掉 websearch——那意味着 KILLSTATA_ENABLE_EXA
      // 这个开关永远拧不动；websearch 已整体删除，本字段不再有这层副作用。
      mcp: false,
      images: input.hasImageInput ?? false,
      remote: Flag.KILLSTATA_CLIENT !== "cli",
    },
    modelCapabilities: {
      supportsTools: true,
      supportsImages: /vision|vl|omni|gpt-4o|gpt-5/i.test(input.model.api.id),
    },
  }

  let pool = await ToolRegistry.resolvePool(
    { modelID: input.model.api.id, providerID: input.model.providerID },
    input.agent,
    toolAvailability,
  )
  const directImplementations = await pool.load((pool.resolution.directToolIDs ?? []).filter(isToolEnabled))
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok || runtime.missing.length > 0) {
    throw new Error(formatRuntimePythonSetupError("计量引擎", runtime))
  }
  const engineClient = sessionEconometricsEngine(input.session.id, {
    command: await resolveRuntimePythonCommand(),
    cwd: Instance.directory,
    pythonPath: path.join(econometricsEngineRoot(), "src"),
    methodRoot: path.join(econometricsEngineRoot(), "python"),
    onProgress: ({ requestID, event }) => {
      const label = typeof event.label_zh === "string" ? event.label_zh : "计量引擎正在处理当前请求"
      publishToolProgress({
        sessionID: input.session.id,
        callID: requestID,
        toolName: "econometrics_engine",
        message: label,
        metadata: { status: event.status },
      })
    },
  })
  const engineHealth = await engineClient.health()
  if (engineHealth.registry_version !== 2) {
    throw new Error(`计量引擎 Registry 版本不兼容：当前为 ${engineHealth.registry_version}，需要版本 2。`)
  }
  const engineCatalog = await engineClient.catalog()
  const engineCapabilityIDs = new Set(
    engineCatalog.methods
      .map((item) => item.method_id)
      .filter((methodID): methodID is string => typeof methodID === "string"),
  )
  const engineMethodIDs = new Set(
    [...engineCapabilityIDs].filter(isConcreteMethodTool),
  )
  type InitializedTool = (typeof directImplementations)[number]
  // 计量方法与系统工具分开管理：系统工具每轮固定，方法引用受 method=10 的滑动窗口约束；
  // 方法Schema只进入动态对话后缀，definitions始终只保留稳定系统工具。
  const methodImplementations = new Map(
    directImplementations.filter((item) => isConcreteMethodTool(item.id)).map((item) => [item.id, item]),
  )
  const activeMethodToolIDs = new Set(methodImplementations.keys())
  const implementations = new Map(
    directImplementations.filter((item) => !isConcreteMethodTool(item.id)).map((item) => [item.id, item]),
  )
  let baseToolIDs = new Set(implementations.keys())
  let baseMethodToolIDs = new Set(methodImplementations.keys())
  let dynamicToolIDs = new Set<string>()
  // 初始直接方法也属于可滑动的“计量方法窗口”。只有用户/门禁确认的方法和当前
  // repair 目标不可被搜索替换；其余直接方法可在同一任务内被更相关的方法顶替。
  const suppressedBaseMethodToolIDs = new Set<string>()
  type PendingMethodSearch = {
    matchIDs: string[]
    evictionIDs: string[]
    tools?: InitializedTool[]
  }
  // 同一模型响应可能连续发出多个 tool_search。每次搜索先占位，再在下一轮统一提交，
  // 不能用单个 pending 槽位让后一次搜索覆盖前一次。
  const pendingMethodSearches: PendingMethodSearch[] = []
  let requestAllowlist = new Set<string>()

  const hasCapacityFor = (toolID: string, visibleToolIDs: Iterable<string>) => {
    if (!isConcreteMethodTool(toolID)) return true
    const counts = modelToolPoolCounts(visibleToolIDs)
    return counts.method < MODEL_TOOL_POOL_LIMITS.method
  }

  const protectedMethodToolIDs = () => new Set(
    [...effectiveConfirmedToolIDs(), input.repairToolName]
      .filter((toolID): toolID is string => typeof toolID === "string" && isConcreteMethodTool(toolID)),
  )

  const projectedPendingMethodToolIDs = () => {
    const projected = new Set(activeMethodToolIDs)
    for (const pending of pendingMethodSearches) {
      for (const toolID of pending.evictionIDs) projected.delete(toolID)
      for (const toolID of pending.matchIDs) projected.add(toolID)
    }
    return projected
  }

  const modelSchemas = new Map<string, unknown>()
  const engineMethodReferences = new Map<string, MethodToolReference>()
  const pythonCapabilityReferences = new Map<string, NonNullable<ReturnType<typeof pythonCapabilityReference>>>()
  const describedSystemCapabilities = await Promise.all(
    [...implementations.values()]
      .filter((item) => engineCapabilityIDs.has(item.id))
      .map(async (item) => {
        const described = await engineClient.describe(item.id)
        const reference = pythonCapabilityReference(described, item.model.namespace)
        if (!reference) throw new Error(`Python Registry 未返回有效的 ${item.id} 描述。`)
        return reference
      }),
  )
  for (const reference of describedSystemCapabilities) pythonCapabilityReferences.set(reference.toolID, reference)
  const modelSchemaFor = (item: InitializedTool): unknown => {
    const cached = modelSchemas.get(item.id)
    if (cached) return cached
    let schema
    try {
      // 安全地转换 Zod schema 为 JSON Schema
      // 示例属于工具 schema 的动态部分，只给复杂工具注入 1～2 个最小有效输入。
      // 不把示例复制进全局 system prompt，避免每轮重复消耗两份 token。
      const jsonSchemaResult = buildModelToolJsonSchema(item.parameters, item.model.inputExamples)
      schema = ProviderTransform.schema(input.model, jsonSchemaResult as any)
    } catch (error) {
      console.error(`[ERROR] Failed to convert schema for tool: ${item.id}`, {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        parametersType: typeof item.parameters,
        parametersDef: (item.parameters as any)?._def?.typeName,
      })
      throw new Error(`工具“${item.id}”的 schema 转换失败：${error instanceof Error ? error.message : error}`)
    }
    modelSchemas.set(item.id, schema)
    return schema
  }

  const definitionFor = (item: InitializedTool): ModelToolDefinition => {
    const pythonReference = pythonCapabilityReferences.get(item.id)
    if (pythonReference) {
      const schema = ProviderTransform.schema(input.model, pythonReference.inputSchema as any)
      return {
        id: item.id as any,
        modelNamespace: item.model.namespace,
        execution: item.execution,
        description: pythonReference.description,
        inputSchema: jsonSchema(schema as any),
        descriptor: pythonReference.descriptor,
      }
    }
    const schema = modelSchemaFor(item)
    return {
      id: item.id as any,
      modelNamespace: item.model.namespace,
      execution: item.execution,
      description: item.description,
      inputSchema: jsonSchema(schema as any),
      descriptor: descriptorForTypeScriptTool({
        toolID: item.id,
        name: item.id,
        description: item.description,
        inputSchema: schema,
        outputSchema: z.toJSONSchema(item.outputSchema ?? Tool.OutputSchema, { unrepresentable: "any" }),
        modelNamespace: item.model.namespace,
        execution: item.execution,
      }),
    }
  }

  const methodReferenceFor = (item: InitializedTool): MethodToolReference => {
    const engineReference = engineMethodReferences.get(item.id)
    if (engineReference) return engineReference
    return {
      toolID: item.id,
      modelNamespace: item.model.namespace,
      description: item.description,
      // 方法引用进入 tool_search 的结果消息，而不是稳定 Provider tools 前缀。
      // 这里必须保留普通 JSON Schema，不能把 AI SDK 的 jsonSchema 包装对象泄漏给模型。
      inputSchema: modelSchemaFor(item),
      descriptor: engineMethodReferences.get(item.id)?.descriptor,
    }
  }

  // Python Registry 是方法契约的唯一真相源。这里仅创建一个不可直接暴露给模型的
  // 内部适配对象，供稳定 econometrics_execute 复用现有 SessionProcessor 的门禁、
  // 权限和结果生命周期；它不再拥有独立的方法级 Tool schema。
  const engineMethodToolFor = (reference: MethodToolReference): InitializedTool => {
    engineMethodReferences.set(reference.toolID, reference)
    return {
      id: reference.toolID,
      model: {
        namespace: reference.modelNamespace,
        useWhen: reference.description,
        doNotUseWhen: "变量角色、样本单位或方法前置条件不满足时不要调用。",
        returns: "结构化估计结果、诊断信息和受控产物引用。",
        failureRecovery: "先阅读字段级错误；参数错误修正参数，研究设定冲突交还用户确认。",
      },
      execution: Tool.Execution.managedFilesystem,
      init: async () => ({
        description: reference.description,
        parameters: z.record(z.string(), z.unknown()),
        execute: async () => {
          throw new Error(`方法 ${reference.toolID} 必须通过 econometrics_execute 稳定路由执行。`)
        },
      }),
    } as unknown as InitializedTool
  }

  const engineNamespaceFor = (method: Record<string, unknown>): Tool.ModelNamespace =>
    method.family === "diagnostic" ? "econometrics_diagnostic" : "econometrics_estimator"

  const pythonDescriptorFor = (method: unknown): UnifiedToolDescriptor | undefined => {
    try {
      return pythonCapabilityReference(method, engineNamespaceFor(method as Record<string, unknown>))?.descriptor
    } catch {
      // 兼容仍未升级的测试 double/旧引擎响应；它们不能宣称 descriptor 完整性。
      return undefined
    }
  }

  /**
   * 清理旧方法定义，保证 Provider 前缀只包含稳定系统工具。
   *
   * 具体方法的完整 Schema 由 Python Registry 返回，并以内联引用进入当前对话；
   * 它们不回写 definitions，也不改变稳定 tools → system → messages 前缀。
   */
  const syncMethodDefinitions = () => {
    // 计量方法采用 deferred reference：完整方法定义追加到 tool_search 的结果消息，
    // 不回写 Provider tools 前缀。这样新增/替换方法不会破坏稳定工具和系统提示词缓存。
    for (const toolID of Object.keys(definitions)) {
      if (isConcreteMethodTool(toolID)) delete definitions[toolID]
    }
  }

  for (const item of implementations.values()) definitions[item.id] = definitionFor(item)
  syncMethodDefinitions()
  // allowlist 必须跟着 definitions 走。此前它初始化成 implementations.keys()（只有系统
  // 工具），方法不进 definitions 时被第一道检查挡住、问题看不出来；方法进入工具面后
  // 就会命中第二道 allowlist 检查，表现为“模型看得见 ols_regression 却报 not available”。
  requestAllowlist = new Set(Object.keys(definitions))

  // 绝大多数已确认方法已被 policy 直接加入 base。这里仅是阶段刚变化时的兼容补位；
  // 系统工具不计入窗口，具体计量方法最多 10 个。
  const loadableIds = new Set([...pool.direct.map((tool) => tool.id), ...pool.searchable.map((tool) => tool.id)])
  const confirmedToolIDs: string[] = []
  const confirmedMethodIDs: string[] = []
  const projectedConfirmedToolIDs = new Set([...baseToolIDs, ...activeMethodToolIDs])
  for (const toolID of effectiveConfirmedToolIDs()) {
    if (!isToolEnabled(toolID) || implementations.has(toolID) || methodImplementations.has(toolID)) continue
    if (isConcreteMethodTool(toolID)) {
      if (psmToolScopeBlock(psmToolScope, toolID)) continue
      if (hasCapacityFor(toolID, projectedConfirmedToolIDs)) {
        confirmedMethodIDs.push(toolID)
        projectedConfirmedToolIDs.add(toolID)
      }
      continue
    }
    if (!loadableIds.has(toolID)) continue
    if (!hasCapacityFor(toolID, projectedConfirmedToolIDs)) continue
    confirmedToolIDs.push(toolID)
    projectedConfirmedToolIDs.add(toolID)
  }
  // 用户在当前请求中明确点名的方法同样需要即时加载其 Registry 引用；“加载”只影响
  // 当前稳定路由的可执行窗口，不会把方法 Schema 写入 Provider tools 前缀。
  for (const toolID of [...(input.preferredToolIDs ?? []), input.repairToolName]) {
    if (!toolID || !isToolEnabled(toolID) || !isConcreteMethodTool(toolID) || methodImplementations.has(toolID)) continue
    if (psmToolScopeBlock(psmToolScope, toolID)) continue
    if (!hasCapacityFor(toolID, projectedConfirmedToolIDs)) continue
    confirmedMethodIDs.push(toolID)
    projectedConfirmedToolIDs.add(toolID)
  }
  if (confirmedMethodIDs.length) {
    const describedMethods = await Promise.all(confirmedMethodIDs.map(async (methodID) => {
      const described = await engineClient.describe(methodID)
      return engineMethodToolFor({
        toolID: methodID,
        modelNamespace: engineNamespaceFor(described),
        description: typeof described.description_zh === "string" ? described.description_zh : "已登记的计量方法。",
        inputSchema: described.input_schema,
        descriptor: pythonDescriptorFor(described),
      })
    }))
    for (const item of describedMethods) {
      methodImplementations.set(item.id, item)
      activeMethodToolIDs.add(item.id)
    }
  }
  if (confirmedToolIDs.length) {
    const confirmedImplementations = await pool.load(confirmedToolIDs)
    for (const item of confirmedImplementations) {
      if (isConcreteMethodTool(item.id)) {
        methodImplementations.set(item.id, item)
        activeMethodToolIDs.add(item.id)
      } else {
        implementations.set(item.id, item)
        definitions[item.id] = definitionFor(item)
      }
    }
    dynamicToolIDs = new Set(confirmedImplementations.map((item) => item.id))
    syncMethodDefinitions()
    requestAllowlist = new Set(Object.keys(definitions))
  }
  // 已消费的 hook 确认方法不再常驻到无关后续任务；阶段未到而不可加载时同样消费，
  // 避免同一个失败建议在每轮重复注入。
  if (confirmedFromHook.length) ConfirmedMethods.consume(input.session.id)

  const refreshToolPool = async () => {
    // AgentEngine 的每次“工具结果 → 下一次模型请求”都复用同一个 ResolvedToolSet。
    // 因而不能只在首次建池时读取 ConfirmedMethods；question 刚得到的选择必须在此刻
    // 合并并保留到本用户轮结束，供当前任务继续调用。
    const confirmedFromRefreshHook = ConfirmedMethods.peek(input.session.id)
    for (const toolID of confirmedFromRefreshHook) activeConfirmedToolIDs.add(toolID)
    const refreshed = await ToolRegistry.resolvePool(
      { modelID: input.model.api.id, providerID: input.model.providerID },
      input.agent,
      { ...toolAvailability, confirmedToolIDs: effectiveConfirmedToolIDs() },
    )
    const refreshedDirect = await refreshed.load((refreshed.resolution.directToolIDs ?? []).filter(isToolEnabled))
    for (const toolID of baseToolIDs) {
      delete definitions[toolID]
      implementations.delete(toolID)
    }
    const protectedMethods = protectedMethodToolIDs()
    const refreshedMethodIDs = new Set(
      refreshedDirect
        .filter((item) => isConcreteMethodTool(item.id))
        .filter((item) => !suppressedBaseMethodToolIDs.has(item.id) || protectedMethods.has(item.id))
        .map((item) => item.id),
    )
    // 只有系统工具属于稳定定义区；具体计量方法始终留在方法窗口，不能因为
    // refresh 走了 direct 路径，就重新进入 Provider 的 tools 前缀。
    baseToolIDs = new Set(
      refreshedDirect.filter((item) => !isConcreteMethodTool(item.id)).map((item) => item.id),
    )
    for (const toolID of baseMethodToolIDs) {
      if (refreshedMethodIDs.has(toolID) || dynamicToolIDs.has(toolID) || protectedMethods.has(toolID)) continue
      activeMethodToolIDs.delete(toolID)
      methodImplementations.delete(toolID)
    }
    baseMethodToolIDs = refreshedMethodIDs
    for (const item of refreshedDirect) {
      if (isConcreteMethodTool(item.id)) {
        if (suppressedBaseMethodToolIDs.has(item.id) && !protectedMethods.has(item.id)) continue
        methodImplementations.set(item.id, item)
        activeMethodToolIDs.add(item.id)
        dynamicToolIDs.delete(item.id)
      } else {
        implementations.set(item.id, item)
        definitions[item.id] = definitionFor(item)
      }
    }

    // question 在当前用户动作内新增确认的方法不会进入 ToolRegistry 的 direct pool；
    // 通过 Registry describe 加载引用即可，仍不把方法定义写回 Provider tools 前缀。
    const newlyConfirmedMethods = [...activeConfirmedToolIDs]
      .filter((toolID) => isConcreteMethodTool(toolID) && isToolEnabled(toolID) && !activeMethodToolIDs.has(toolID))
    if (newlyConfirmedMethods.length) {
      const described = await Promise.all(newlyConfirmedMethods.map(async (methodID) => {
        const item = await engineClient.describe(methodID)
        return engineMethodToolFor({
          toolID: methodID,
          modelNamespace: engineNamespaceFor(item),
          description: typeof item.description_zh === "string" ? item.description_zh : "已登记的计量方法。",
          inputSchema: item.input_schema,
          descriptor: pythonDescriptorFor(item),
        })
      }))
      for (const item of described) {
        methodImplementations.set(item.id, item)
        activeMethodToolIDs.add(item.id)
      }
    }

    // 被同一任务内的 tool_search 替换过的初始方法，不能在每次 refresh 又悄悄回来。
    // 新的用户消息会创建新的 ResolvedToolSet，因此下一任务仍会按最新意图重新组装。
    for (const toolID of [...suppressedBaseMethodToolIDs]) {
      if (protectedMethods.has(toolID)) {
        suppressedBaseMethodToolIDs.delete(toolID)
        continue
      }
      delete definitions[toolID]
      implementations.delete(toolID)
      baseToolIDs.delete(toolID)
      activeMethodToolIDs.delete(toolID)
      methodImplementations.delete(toolID)
      baseMethodToolIDs.delete(toolID)
    }

    const searchable = new Set(refreshed.searchable.filter((item) => isToolEnabled(item.id)).map((item) => item.id))
    const retainedDynamicToolIDs = new Set<string>()
    for (const toolID of dynamicToolIDs) {
      if (baseToolIDs.has(toolID)) continue
      // dynamicToolIDs 已由 commitDeferredTools 控制在 method=10 以内；此处如果把
      // 它本身也算进 projectedToolIDs 再检查容量，会把恰好第 10 个方法错误删掉。
      if (!searchable.has(toolID) && !engineMethodReferences.has(toolID)) {
        if (protectedMethods.has(toolID)) continue
        delete definitions[toolID]
        implementations.delete(toolID)
        activeMethodToolIDs.delete(toolID)
        methodImplementations.delete(toolID)
        continue
      }
      retainedDynamicToolIDs.add(toolID)
    }
    dynamicToolIDs = retainedDynamicToolIDs
    pool = refreshed
    if (confirmedFromRefreshHook.length) ConfirmedMethods.consume(input.session.id)
    // refresh 会替换 definitions；若不同时刷新 allowlist，下一轮虽然看见了新工具，
    // ToolPort 仍按上一轮集合拒绝它，表现为“工具不存在”。
    syncMethodDefinitions()
    requestAllowlist = new Set(Object.keys(definitions))
  }

  searchDeferredTools = async (searchInput) => {
    if (recommendationOnly) {
      // 推荐轮允许模型询问方法目录，但不把具体估计器加载进当前会话；这样即使模型
      // 误用 tool_search，也得到可解释的空结果，而不是“工具不可用”错误或动态打开
      // 估计能力。下一条明确采纳消息会重新建立正常方法窗口。
      return { matches: [], loadedToolIDs: [], availableToolIDs: [], blockedReason: "recommendation_only" as const }
    }
    // Estimate tools must be searchable even in early stages (import/validate) so tool_search can discover OLS before baseline_estimate.
    // Execution still requires a current AnalysisRequest and Python Registry preflight.
    // 候选来自 searchable + direct：已经直接加载的方法仍应能被再次查询，避免用户确认后
    // tool_search 反而返回“未找到”。两者都已经过阶段/权限/能力过滤；这里只保留计量方法。
    // 此前这里还会为不在 searchable 里的估计器合成假候选（namespace 用了非法的
    // "econometrics"，useWhen 直接等于裸 ID）。合成项一旦被选中，pool.load 会因为它不在
    // loadable 集合里抛"工具不可通过工具搜索加载"——plan 模式把估计器全过滤掉时必然触发。
    // 曝光策略已保证估计器在早期阶段也进入 searchable，这层兜底只剩副作用，删掉。
    const engineMatches = (await engineClient.search(searchInput)).methods
    const matches = engineMatches
      .filter((item) => typeof item.method_id === "string" && isConcreteMethodTool(item.method_id) &&
        isToolEnabled(item.method_id) && psmMethodSearchAllowed(psmToolScope, item.method_id))
      .map((item) => ({
        toolID: String(item.method_id),
        description: typeof item.description_zh === "string" ? item.description_zh : "已登记的计量方法。",
        namespace: engineNamespaceFor(item),
        score: 1,
        inputSchema: item.input_schema,
        outputSchema: item.output_schema,
        descriptor: pythonDescriptorFor(item),
        useWhen: typeof item.use_when_zh === "string" ? item.use_when_zh : undefined,
        doNotUseWhen: typeof item.do_not_use_when_zh === "string" ? item.do_not_use_when_zh : undefined,
        inputRequirements: Array.isArray(item.input_requirements_zh)
          ? item.input_requirements_zh.filter((value): value is string => typeof value === "string")
          : undefined,
        diagnosticRequirements: Array.isArray(item.diagnostic_requirements_zh)
          ? item.diagnostic_requirements_zh.filter((value): value is string => typeof value === "string")
          : undefined,
      }))
    // “目录中没有匹配项”和“匹配项因常驻预算不可装载”是两种不同失败。
    // 前者返回当前可加载方法的全量清单，让模型一轮内改用正确 ID，而不是换个词再猜。
    if (!matches.length) {
      const catalog = (await engineClient.catalog()).methods
      return {
        matches: [],
        loadedToolIDs: [],
        availableToolIDs: catalog
          .filter((item) => typeof item.method_id === "string" && isConcreteMethodTool(item.method_id) &&
            isToolEnabled(item.method_id) && psmMethodSearchAllowed(psmToolScope, item.method_id))
          .map((item) => ({
            toolID: String(item.method_id),
            description: typeof item.description_zh === "string" ? item.description_zh : "已登记的计量方法。",
          })),
      }
    }
    // 方法窗口不是“一次填满即冻结”。新命中优先占空槽；没有空槽时，按倒序替换
    // 未确认的旧方法。confirmed/repair 方法始终保留，避免用户刚选择的路线被挤掉。
    const protectedMethods = protectedMethodToolIDs()
    const visibleMethodToolIDs = [...projectedPendingMethodToolIDs()]
    const projectedMethodToolIDSet = new Set(visibleMethodToolIDs)
    const evictableMethodToolIDs = visibleMethodToolIDs.filter((toolID) => !protectedMethods.has(toolID))
    const plannedMethodToolIDs = new Set(visibleMethodToolIDs)
    const evictionIDs: string[] = []
    const loadableMatches = matches.filter((item) => {
      if (!isConcreteMethodTool(item.toolID) || plannedMethodToolIDs.has(item.toolID)) return false
      if (plannedMethodToolIDs.size >= MODEL_TOOL_POOL_LIMITS.method) {
        const victim = evictableMethodToolIDs.pop()
        if (!victim) return false
        plannedMethodToolIDs.delete(victim)
        evictionIDs.push(victim)
      }
      plannedMethodToolIDs.add(item.toolID)
      return true
    })
    if (!loadableMatches.length) {
      const alreadyAvailableMatches = matches.filter(
        (item) => isConcreteMethodTool(item.toolID) && projectedMethodToolIDSet.has(item.toolID),
      )
      if (alreadyAvailableMatches.length) {
        const availableItems = new Map<string, InitializedTool>()
        for (const item of methodImplementations.values()) availableItems.set(item.id, item)
        for (const pending of pendingMethodSearches) {
          for (const item of pending.tools ?? []) availableItems.set(item.id, item)
        }
        return {
          matches: alreadyAvailableMatches.map((item) => ({
            toolID: item.toolID,
            description: item.description,
            useWhen: item.useWhen,
            doNotUseWhen: item.doNotUseWhen,
            inputRequirements: item.inputRequirements,
            diagnosticRequirements: item.diagnosticRequirements,
            inputSchema: availableItems.get(item.toolID)
              ? methodReferenceFor(availableItems.get(item.toolID)!).inputSchema
              : undefined,
            outputSchema: item.descriptor?.output_schema,
            descriptor: item.descriptor,
          })),
          loadedToolIDs: alreadyAvailableMatches.map((item) => item.toolID),
        }
      }
      return {
        matches: [],
        loadedToolIDs: [...dynamicToolIDs],
        blockedReason: "visible_tool_budget_full" as const,
      }
    }
    const pending: PendingMethodSearch = {
      matchIDs: loadableMatches.map((item) => item.toolID),
      evictionIDs,
    }
    pendingMethodSearches.push(pending)
    try {
      pending.tools = loadableMatches.map((item) => engineMethodToolFor({
        toolID: item.toolID,
        modelNamespace: item.namespace,
        description: item.description,
        inputSchema: item.inputSchema,
        descriptor: item.descriptor,
      }))
    } catch (error) {
      const index = pendingMethodSearches.indexOf(pending)
      if (index >= 0) pendingMethodSearches.splice(index, 1)
      throw error
    }
    const references = new Map(
      pending.tools.map((item) => [item.id, methodReferenceFor(item)]),
    )
    return {
      matches: loadableMatches.map((item) => ({
        toolID: item.toolID,
        description: item.description,
        useWhen: item.useWhen,
        doNotUseWhen: item.doNotUseWhen,
        inputRequirements: item.inputRequirements,
        diagnosticRequirements: item.diagnosticRequirements,
        inputSchema: references.get(item.toolID)?.inputSchema,
        outputSchema: item.descriptor?.output_schema,
        descriptor: item.descriptor,
      })),
      loadedToolIDs: pending.tools.map((item) => item.id),
    }
  }

  const commitDeferredTools = async () => {
    if (pendingMethodSearches.length === 0) return
    const searches = pendingMethodSearches.splice(0)
    for (const pending of searches) {
      for (const toolID of pending.evictionIDs) {
        delete definitions[toolID]
        implementations.delete(toolID)
        methodImplementations.delete(toolID)
        activeMethodToolIDs.delete(toolID)
        dynamicToolIDs.delete(toolID)
        if (baseMethodToolIDs.has(toolID)) suppressedBaseMethodToolIDs.add(toolID)
      }
      for (const item of pending.tools ?? []) {
        methodImplementations.set(item.id, item)
        activeMethodToolIDs.add(item.id)
        dynamicToolIDs.add(item.id)
      }
    }
    // commit 也会替换 definitions；同步 allowlist，避免本轮已加载的工具仍被
    // 上一次 model request 的 requestAllowlist 拒绝。
    syncMethodDefinitions()
    requestAllowlist = new Set(Object.keys(definitions))
    const loadedToolIDs = [...dynamicToolIDs]
    RuntimeTaskLedger.appendEventBestEffort({
      sessionID: input.session.id,
      kind: "tool.pool",
      message: "tool search committed",
      metadata: {
        matchedToolIDs: searches.flatMap((pending) => pending.matchIDs),
        loadedToolIDs,
        ...toolPoolSnapshot(),
      },
    })
  }

  const deferredToolSummary = () => Tool.ModelNamespaceOrder.flatMap((namespace) => {
    const count = namespace === "econometrics_estimator" || namespace === "econometrics_diagnostic"
      ? [...engineMethodIDs].filter((id) => isToolEnabled(id) && !activeMethodToolIDs.has(id)).length
      : pool.searchable.filter(
        (item) => isToolEnabled(item.id) && item.model.namespace === namespace && !activeMethodToolIDs.has(item.id),
      ).length
    return count > 0 ? [{ modelNamespace: namespace, count }] : []
  })
  const toolPoolSnapshot = () => {
    const deferredByNamespace = deferredToolSummary()
    const visibleToolIDs = [...new Set([...Object.keys(definitions), ...activeMethodToolIDs])].sort()
    const counts = modelToolPoolCounts(visibleToolIDs)
    const schemaTokens = Token.estimate(providerToolSchemaText(definitions))
    return {
      visibleToolIDs,
      visibleCount: visibleToolIDs.length,
      systemToolCount: counts.system,
      methodToolCount: counts.method,
      schemaTokens,
      deferredCount: deferredByNamespace.reduce((total, item) => total + item.count, 0),
      deferredByNamespace,
    }
  }
  const setRequestAllowlist = (toolIDs: readonly string[]) => {
    requestAllowlist = new Set(toolIDs.filter((toolID) => Boolean(definitions[toolID])))
  }
  const loadPreparedMethod = async (methodID: string): Promise<InitializedTool | undefined> => {
    if (!engineMethodIDs.has(methodID) || !isToolEnabled(methodID) || !psmMethodSearchAllowed(psmToolScope, methodID)) return undefined
    const info = await ToolRegistry.byID(methodID)
    if (!info) return undefined
    return {
      id: info.id,
      model: info.model,
      execution: info.execution,
      ...(await info.init({ agent: input.agent })),
    } as InitializedTool
  }

  const port = createToolPort({
    input: {
      processor: input.processor,
      session: input.session,
      userText: input.userText,
      sourceUserMessageId,
      worksheetName: input.worksheetName,
      consultationOnly: resolvedIntent === "conversation",
      analysisRequestKind: registeredRequest?.kind,
      qualityInspectionOnly,
      recommendationOnly,
      psmToolScope,
      psmScopeFilter: input.psmScopeFilter,
    },
    needsRequestRegistration,
    recommendedMethod,
    implementations,
    methodImplementations,
    loadPreparedMethod,
    definitions,
    authorizedMethodIDs: [...new Set([...(input.requiredToolIDs ?? []), ...effectiveConfirmedToolIDs()])],
    requestAllowlist: () => requestAllowlist,
    normalizeToolArgs,
    context,
    econometricsEngine: engineClient,
    runtimeInjectedFields: (toolID) => {
      const value = (definitions[toolID]?.descriptor ?? pythonCapabilityReferences.get(toolID)?.descriptor ?? engineMethodReferences.get(toolID)?.descriptor) as (UnifiedToolDescriptor & { runtime_injected_fields?: unknown }) | undefined
      return Array.isArray(value?.runtime_injected_fields)
        ? value.runtime_injected_fields.filter((field): field is string => typeof field === "string")
        : []
    },
    modelVisibleFields: (toolID) => {
      const value = (definitions[toolID]?.descriptor ?? pythonCapabilityReferences.get(toolID)?.descriptor ?? engineMethodReferences.get(toolID)?.descriptor) as (UnifiedToolDescriptor & { input_schema?: unknown; accepted_input_aliases?: unknown }) | undefined
      const schema = value?.input_schema
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined
      const properties = (schema as Record<string, unknown>).properties
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined
      const fields = [
        ...Object.keys(properties),
        ...(Array.isArray(value.accepted_input_aliases)
          ? value.accepted_input_aliases.filter((field): field is string => typeof field === "string")
          : []),
      ]
      return fields.length ? fields : undefined
    },
    acceptedInputAliases: (toolID) => {
      const value = (definitions[toolID]?.descriptor ?? pythonCapabilityReferences.get(toolID)?.descriptor ?? engineMethodReferences.get(toolID)?.descriptor) as (UnifiedToolDescriptor & { accepted_input_aliases?: unknown }) | undefined
      return Array.isArray(value?.accepted_input_aliases)
        ? value.accepted_input_aliases.filter((field): field is string => typeof field === "string")
        : []
    },
    confirmedVariableSubstitutions: input.confirmedVariableSubstitutions,
    confirmedPolicyConstruction: input.confirmedPolicyConstruction,
    userDecisionStop: input.userDecisionStop,
  })

  // TEMP-DEBUG drive: what the model actually receives
  if (process.env.KILLSTATA_DRIVE_DEBUG) {
    console.log(
      `[tools-final-debug] intent=${resolvedIntent} repair=${input.repairToolName ?? "-"} final=${Object.keys(definitions).join(",")}`,
    )
  }

  return {
    definitions,
    port,
    setRequestAllowlist,
    refreshToolPool,
    commitDeferredTools,
    flushDeferredVerifiers: (abortSignal) => flushDeferredAutomaticVerifiers(input.session.id, input.processor.message.id, abortSignal),
    methodReferences: () => [...activeMethodToolIDs].flatMap((toolID) => {
      const item = methodImplementations.get(toolID)
      return item ? [methodReferenceFor(item)] : []
    }),
    deferredToolSummary,
    toolPoolSnapshot,
  } satisfies ResolvedToolSet
}

function createToolPort(input: {
  input: {
    processor: SessionProcessor.Info
    session: Session.Info
    userText?: string
    sourceUserMessageId?: string
    worksheetName?: string
    consultationOnly: boolean
    analysisRequestKind?: "inspect" | "estimate" | "explain" | "repair"
    qualityInspectionOnly: boolean
    recommendationOnly: boolean
    psmToolScope?: "diagnostics_only" | "blocked"
    psmScopeFilter?: { column: string; value: string | number }
  }
  needsRequestRegistration(): boolean
  implementations: Map<string, Awaited<ReturnType<typeof ToolRegistry.tools>>[number]>
  methodImplementations: Map<string, Awaited<ReturnType<typeof ToolRegistry.tools>>[number]>
  recommendedMethod?: string
  authorizedMethodIDs: string[]
  loadPreparedMethod(toolID: string): Promise<Awaited<ReturnType<typeof ToolRegistry.tools>>[number] | undefined>
  definitions: Record<string, ModelToolDefinition>
  requestAllowlist(): ReadonlySet<string>
  normalizeToolArgs(toolName: string, args: unknown): unknown
  context(args: any, call: ToolPortCall): Tool.Context
  econometricsEngine: ReturnType<typeof sessionEconometricsEngine>
  runtimeInjectedFields(toolID: string): string[]
  modelVisibleFields(toolID: string): string[] | undefined
  acceptedInputAliases(toolID: string): string[]
  confirmedVariableSubstitutions?: Set<string>
  confirmedPolicyConstruction?: { value: boolean }
  userDecisionStop?: { value: boolean }
}) {
  const schemaNotSentError = (methodID: string, call: ToolPortCall | undefined, error: unknown) => {
    if (
      call &&
      !call.schemaSentToolIDs?.includes(methodID) &&
      error instanceof EconometricsEngineError &&
      error.code === "INVALID_ARGUMENT"
    ) {
      return new Tool.SchemaNotSentError(methodID, error.message, { cause: error })
    }
    return error
  }
  // 一个模型响应里的工具调用可能会并发到达。若其中一个调用已经发现规格需要用户
  // 决策，剩余调用不能继续读写或探查内部路径；这个状态只属于当前 port（即当前模型轮），
  // 下一条用户消息会重新构造 port，不会把会话永久锁住。
  let stoppedForUserDecision = false
  let did2sFrequencyChecks = 0
  let did2sFrequencyInFlight = 0
  let confirmedPolicyConstruction = input.confirmedPolicyConstruction?.value === true
  const confirmedVariableSubstitutions = input.confirmedVariableSubstitutions ?? new Set<string>()
  const analysisToolRunAbortHandlers = new Map<string, {
    taskId: string
    requestId: string
    dispose: () => void
  }>()
  const userSpecifiedVariableCorrections = new Map<string, Array<{
    field: VariableSubstitutionField
    modelValue: string
    userValue: string
  }>>()
  const currentAnalysisTask = () => {
    const sourceMessageId = input.input.sourceUserMessageId
    if (!sourceMessageId) return undefined
    const ledger = RuntimeTaskLedger.listTasks(input.input.session.id)
    return ledger.tasks.find((task) =>
      task.taskId === ledger.activeTaskId &&
      task.messageID === sourceMessageId &&
      task.analysisRequest?.sourceMessageId === sourceMessageId,
    )
  }
  const analysisToolRunKey = (callID: string) => `${input.input.session.id}:${callID}`
  const removeAnalysisToolRunAbortHandler = (callID: string) => {
    const active = analysisToolRunAbortHandlers.get(analysisToolRunKey(callID))
    if (!active) return
    active.dispose()
    analysisToolRunAbortHandlers.delete(analysisToolRunKey(callID))
  }
  const terminateAnalysisToolRun = (inputValue: {
    callID: string
    taskId: string
    requestId: string
    outcome: "failed" | "cancelled" | "unconfirmed"
    failureCode: string
  }) => {
    try {
      const ledger = RuntimeTaskLedger.listTasks(input.input.session.id)
      const task = ledger.tasks.find((item) => item.taskId === inputValue.taskId)
      const run = task?.analysisLifecycle?.toolRuns?.find((item) => item.operationId === inputValue.callID)
      if (run?.status === "running") {
        RuntimeTaskLedger.transitionAnalysis({
          sessionID: input.input.session.id,
          taskId: inputValue.taskId,
          event: {
            type: "tool_run_terminated",
            requestId: inputValue.requestId,
            operationId: inputValue.callID,
            outcome: inputValue.outcome,
            failureCode: inputValue.failureCode,
          },
        })
      }
    } finally {
      removeAnalysisToolRunAbortHandler(inputValue.callID)
    }
  }
  const addAnalysisToolRunLifecycle = (
    toolID: string,
    call: ToolPortCall,
    toolContext: Tool.Context,
  ) => {
    if (toolID !== "heterogeneity_runner" && toolID !== "composite_evaluation") return
    const extra = (toolContext.extra ?? {}) as Record<string, unknown>
    const begin = (identity: AnalysisToolOperationIdentity) => {
      const task = currentAnalysisTask()
      const request = task?.analysisRequest
      if (!task || !request || request.kind !== "estimate" || request.sourceMessageId !== input.input.sourceUserMessageId) {
        throw new Tool.InputValidationError("当前估计工具没有匹配的 AnalysisRequest；未启动执行。")
      }
      const authorizedToolIDs = [
        ...(Array.isArray(task.metadata?.requiredToolIDs) ? task.metadata.requiredToolIDs.filter((id): id is string => typeof id === "string") : []),
        ...(Array.isArray(task.metadata?.confirmedToolIDs) ? task.metadata.confirmedToolIDs.filter((id): id is string => typeof id === "string") : []),
      ]
      if (!authorizedToolIDs.includes(toolID)) {
        throw new Tool.InputValidationError("当前用户请求没有明确授权运行该估计工具；未启动执行。")
      }
      if (call.abort.aborted) throw new Tool.InputValidationError("工具在启动前已取消；没有运行估计，也没有写入结果。")
      if (identity.operationId !== call.id || identity.toolID !== toolID || identity.requestId !== request.requestId ||
          identity.authorizationMessageId !== request.sourceMessageId ||
          task.analysisLifecycle?.datasetId !== identity.datasetId ||
          task.analysisLifecycle?.stageId !== identity.stageId ||
          task.analysisLifecycle?.stageFingerprint !== identity.stageFingerprint) {
        throw new Tool.InputValidationError("估计工具的请求、授权、调用或数据阶段与 Harness 当前状态不一致；未启动执行。")
      }
      if (analysisToolRunAbortHandlers.has(analysisToolRunKey(call.id))) {
        throw new Tool.InputValidationError("同一工具调用已经登记为运行中；拒绝重复启动。")
      }
      RuntimeTaskLedger.transitionAnalysis({
        sessionID: input.input.session.id,
        taskId: task.taskId,
        event: { type: "tool_run_started", operation: identity },
      })
      const dispose = RuntimeTaskLedger.watchAnalysisToolRunAbort({
        sessionID: input.input.session.id,
        taskId: task.taskId,
        requestId: request.requestId,
        operationId: call.id,
        signal: call.abort,
        onError: (error) => log.warn("could not mark cancelled analysis tool outcome unconfirmed", { toolID, callID: call.id, error }),
      })
      analysisToolRunAbortHandlers.set(analysisToolRunKey(call.id), {
        taskId: task.taskId,
        requestId: request.requestId,
        dispose,
      })
      if (call.abort.aborted) {
        throw new Tool.InputValidationError("用户已取消当前估计；输出状态保持未确认，系统不会自动重跑。")
      }
    }
    const complete = (operation: AnalysisToolRunRecord) => {
      const active = analysisToolRunAbortHandlers.get(analysisToolRunKey(call.id))
      if (!active) throw new Tool.InputValidationError("工具结果没有活动的生命周期运行记录；结果不能登记为完成。")
      RuntimeTaskLedger.completeAnalysisToolRun({
        sessionID: input.input.session.id,
        taskId: active.taskId,
        signal: call.abort,
        operation,
        onError: (error) => log.warn("could not persist cancelled analysis tool state before result commit", { toolID, callID: call.id, error }),
      })
      active.dispose()
      analysisToolRunAbortHandlers.delete(analysisToolRunKey(call.id))
    }
    extra.beginAnalysisToolRun = begin
    extra.completeAnalysisToolRun = complete
    toolContext.extra = extra
  }
  const failAnalysisToolRunIfActive = (toolID: string, call: ToolPortCall, error: unknown) => {
    if (toolID !== "heterogeneity_runner" && toolID !== "composite_evaluation") return
    const active = analysisToolRunAbortHandlers.get(analysisToolRunKey(call.id))
    if (!active) return
    const errorCode = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : call.abort.aborted ? "TOOL_ABORTED_UNCONFIRMED" : "TOOL_EXECUTION_UNCONFIRMED"
    try {
      terminateAnalysisToolRun({
        callID: call.id,
        taskId: active.taskId,
        requestId: active.requestId,
        outcome: "unconfirmed",
        failureCode: errorCode,
      })
    } catch (terminationError) {
      log.warn("could not persist analysis tool failure lifecycle", { toolID, callID: call.id, error: terminationError })
    }
  }
  const startCurrentDataDiagnosis = () => {
    const task = currentAnalysisTask()
    if (!task?.analysisRequest) return undefined
    RuntimeTaskLedger.transitionAnalysis({
      sessionID: input.input.session.id,
      taskId: task.taskId,
      event: { type: "diagnosis_started", requestId: task.analysisRequest.requestId },
    })
    return task.taskId
  }
  const completeCurrentDataDiagnosis = (taskId: string, result: unknown) => {
    const task = currentAnalysisTask()
    if (!task?.analysisRequest || task.taskId !== taskId) return
    const workflow = getActiveWorkflowRun(input.input.session.id)
    const currentData = workflow
      ? canonicalDataStageForWorkflow(workflow, activeOrLatestStage(workflow))
      : null
    if (!currentData) return
    const artifactInput = resolveArtifactInput(currentData)
    const diagnosis = artifactInput.stage?.metadata?.dataDiagnosis
    if (!diagnosis || typeof diagnosis !== "object" || Array.isArray(diagnosis)) return
    const diagnosisRecord = diagnosis as Record<string, unknown>
    const fingerprint = diagnosisRecord.data_fingerprint
    if (
      diagnosisRecord.stage_id !== currentData.stageId ||
      typeof fingerprint !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(fingerprint)
    ) return
    const issues = Array.isArray(diagnosisRecord.issues)
      ? diagnosisRecord.issues.filter((issue): issue is Record<string, unknown> =>
          Boolean(issue && typeof issue === "object" && !Array.isArray(issue)),
        )
      : []
    const blockingIssue = issues.find((issue) => issue.severity === "blocking")
    const resultMetadata = result && typeof result === "object" && !Array.isArray(result)
      ? (result as { metadata?: unknown }).metadata
      : undefined
    const qaGateStatus = resultMetadata && typeof resultMetadata === "object" && !Array.isArray(resultMetadata)
      ? (resultMetadata as Record<string, unknown>).qaGateStatus
      : undefined
    const code = typeof blockingIssue?.code === "string"
      ? blockingIssue.code
      : qaGateStatus === "block"
        ? "DATA_QUALITY_BLOCKED"
        : undefined
    RuntimeTaskLedger.transitionAnalysis({
      sessionID: input.input.session.id,
      taskId: task.taskId,
      event: {
        type: "diagnosis_completed",
        requestId: task.analysisRequest.requestId,
        datasetId: currentData.datasetId,
        stageId: currentData.stageId,
        stageFingerprint: fingerprint,
        ...(code ? { blockingIssueCode: code } : {}),
      },
    })
  }
  const modelArgumentsForTool = (toolID: string, value: unknown) => {
    const normalized = input.normalizeToolArgs(toolID, value)
    const runtimeFields = input.runtimeInjectedFields(toolID)
    const harnessOwnedFields = new Set([
      ...runtimeFields,
      "datasetId", "dataset_id", "stageId", "stage_id", "runId", "run_id", "branch", "branch_id",
      "inputPath", "input_path", "outputPath", "output_path", "outputDir", "output_dir", "dataPath", "data_path", "runtime",
      "baselineResultDir", "directResultPath",
    ])
    const record = normalized && typeof normalized === "object" && !Array.isArray(normalized)
      ? normalized as Record<string, unknown>
      : undefined
    const modelFields = input.modelVisibleFields(toolID)
    if (modelFields) {
      if (!record) throw new Tool.InputValidationError(`工具 ${toolID} 的参数必须是 JSON 对象。`)
      const allowedFields = new Set([...modelFields, ...runtimeFields])
      const unknownFields = Object.keys(record).filter((field) => !allowedFields.has(field) && !harnessOwnedFields.has(field))
      if (unknownFields.length) {
        throw new Tool.InputValidationError(
          `工具 ${toolID} 包含 Python Registry 未声明的参数：${unknownFields.join("、")}。请按当前工具 Schema 修正后重试。`,
        )
      }
    }
    if (!isConcreteMethodTool(toolID) && runtimeFields.length === 0) return normalized
    const modelRecord = record ?? {}
    const result = { ...modelRecord }
    for (const field of harnessOwnedFields) delete result[field]
    return result
  }
  const markUserDecisionStop = () => {
    stoppedForUserDecision = true
    if (input.userDecisionStop) input.userDecisionStop.value = true
  }

  const executeEngineMethod = async (
    methodID: string,
    args: Record<string, unknown>,
    call: ToolPortCall,
    executionContext?: Tool.Context,
    preparedSpec?: PreparedSpecRecord,
  ) => {
    const datasetId = typeof args.datasetId === "string" ? args.datasetId : undefined
    const stageId = typeof args.stageId === "string" ? args.stageId : undefined
    if (!datasetId || !stageId) {
      throw new Tool.InputValidationError(`${methodID} 缺少当前会话的 datasetId 或 stageId，不能启动计量引擎。`)
    }
    const artifactInput = resolveArtifactInput({ datasetId, stageId })
    if (!artifactInput.resolvedInputPath) throw new Error(`${methodID} 找不到当前数据阶段的输入文件。`)
    const context = executionContext ?? input.context(args, call)
    const dataPath = await resolveDatasetStagePath({
      datasetId,
      filePath: artifactInput.resolvedInputPath,
      toolName: methodID,
      sessionID: input.input.session.id,
      messageID: input.input.processor.message.id,
      callID: call.id,
      ask: context.ask,
    })
    const outputDir = resolveManagedProjectPath({
      managedRoot: datasetRoot(datasetId),
      filePath: reportOutputPath({
      datasetId,
      action: methodID,
      stageId,
      branch: "main",
      format: "json",
      stamp: `${Date.now()}_${crypto.randomUUID()}`,
      }).replace(/\.json$/, ""),
    })
    const runtimeFields = new Set(input.runtimeInjectedFields(methodID))
    const trustedRuntimeValues: Record<string, unknown> = {
      datasetId,
      stageId,
      inputPath: dataPath,
      outputDir,
      runId: inferRunId({ requestedRunId: undefined, stage: artifactInput.stage, source: "model" }),
      branch: inferBranch({ requestedBranch: undefined, stage: artifactInput.stage, source: "model" }),
    }
    const unsupportedRuntimeFields = [...runtimeFields].filter((field) => trustedRuntimeValues[field] === undefined)
    if (unsupportedRuntimeFields.length) {
      throw new Tool.InputValidationError(
        `${methodID} 的 Harness 运行时字段缺少可信来源：${unsupportedRuntimeFields.join("、")}。`,
      )
    }
    const runtime = Object.fromEntries([...runtimeFields].map((field) => [field, trustedRuntimeValues[field]]))
    const engineArguments = { ...args }
    // Canonical lineage selects the controlled data_path in TypeScript. Only Python methods
    // whose Pydantic contract explicitly declares runtime fields receive them in `runtime`;
    // never copy those values from the model-provided argument object.
    for (const field of [
      "datasetId", "dataset_id", "stageId", "stage_id", "runId", "run_id", "branch", "branch_id",
      "inputPath", "input_path", "outputPath", "output_path", "outputDir", "output_dir",
      "dataPath", "data_path", "runtime",
      ...runtimeFields,
    ]) delete engineArguments[field]
    const invalidatePreparedSpec = (message: string) => {
      markUserDecisionStop()
      if (preparedSpec) {
        RuntimeTaskLedger.transitionAnalysis({
          sessionID: input.input.session.id,
          taskId: RuntimeTaskLedger.listTasks(input.input.session.id).activeTaskId ?? "",
          event: {
            type: "decision_required",
            requestId: preparedSpec.requestId,
            issueCode: "PREPARED_SPEC_INVALIDATED",
          },
        })
      }
      return {
        title: "PreparedSpec 已失效",
        output: `${message} 尚未调用估计器。请基于当前数据和方法 Schema 重新准备规格；系统不会自动重绑定旧 specId。`,
        metadata: {
          requiresUserDecision: true,
          preparedSpecInvalidated: true,
          specId: preparedSpec?.specId,
          methodID,
          datasetId,
          stageId,
        },
      }
    }
    if (preparedSpec) {
      if (
        preparedSpec.methodID !== methodID ||
        preparedSpec.datasetId !== datasetId ||
        preparedSpec.stageId !== stageId ||
        !analysisSpecArgumentsEqual(preparedSpec.arguments, engineArguments)
      ) {
        return invalidatePreparedSpec("执行参数、方法或数据阶段与当前 PreparedSpec 不一致。")
      }
      const [health, description] = await Promise.all([
        input.econometricsEngine.health(call.abort),
        input.econometricsEngine.describe(methodID, call.abort),
      ])
      if (
        health.registry_version !== preparedSpec.registryVersion ||
        description.schema_version !== preparedSpec.schemaVersion ||
        description.method_id !== methodID
      ) {
        return invalidatePreparedSpec("Python Registry 或方法 Schema 版本在规格准备后发生变化。")
      }
    }
    let preflight
    try {
      preflight = await input.econometricsEngine.preflight({
        method_id: methodID,
        data_path: dataPath,
        arguments: engineArguments,
        runtime,
      }, call.abort)
    } catch (error) {
      throw schemaNotSentError(methodID, call, error)
    }
    if (preparedSpec && (
      !preflight.executable ||
      preflight.status !== "ready" ||
      preflight.data_fingerprint !== preparedSpec.stageFingerprint ||
      !analysisSpecArgumentsEqual(preflight.normalized_arguments, preparedSpec.arguments)
    )) {
      return invalidatePreparedSpec("当前数据内容、参数规范化结果或 preflight 状态已不同于准备规格时的证据。")
    }
    if (!preflight.executable) {
      const summary = preflight.issues
        .map((issue) => typeof issue.summary_zh === "string" ? issue.summary_zh : "当前方法前置条件未满足。")
        .join("；") || "当前方法前置条件未满足。"
      if (preflight.status === "requires_user_decision" || preflight.status === "incompatible" || preflight.status === "repairable") {
        markUserDecisionStop()
        if (preparedSpec) {
          RuntimeTaskLedger.transitionAnalysis({
            sessionID: input.input.session.id,
            taskId: RuntimeTaskLedger.listTasks(input.input.session.id).activeTaskId ?? "",
            event: {
              type: "decision_required",
              requestId: preparedSpec.requestId,
              issueCode: typeof preflight.issues[0]?.code === "string" ? preflight.issues[0].code : "PREFLIGHT_BLOCKED",
            },
          })
        }
        const repairSuggestions = preflight.repair_plan
          .map((option) => {
            const label = typeof option.label_zh === "string" ? option.label_zh : "确认下一步方案"
            const description = typeof option.description_zh === "string" ? option.description_zh : ""
            return description ? `${label}：${description}` : label
          })
        const requestedWeight = typeof args.weightsVar === "string" ? args.weightsVar : ""
        const missingWeightColumn = methodID === "wls_regression" && preflight.issues.some((issue) => {
          if (issue.code !== "DATA_COLUMN_MISSING" || !issue.evidence || typeof issue.evidence !== "object") return false
          const columns = (issue.evidence as Record<string, unknown>).columns
          return Array.isArray(columns) && columns.includes(requestedWeight)
        })
        return {
          title: `需要确认 ${methodID} 与当前数据的适配`,
          output: [
            `尚未执行 ${methodID}。`,
            summary,
            ...repairSuggestions,
            missingWeightColumn
              ? `WLS 权重必须来自当前数据中真实存在、由用户提供的观测权重列。请提供权重来源或确认是否改用其他方法；系统不会自动生成权重或切换为 OLS。`
              : "这里需要你确认研究设定或提供真实数据列；系统不会自动更换方法、编造变量或修改数据。",
          ].join("\n"),
          metadata: {
            requiresUserDecision: true,
            preflightStatus: preflight.status,
            issues: preflight.issues,
            repairPlan: preflight.repair_plan,
          },
        }
      }
      throw new EconometricsEngineError(
        "PREFLIGHT_BLOCKED",
        `${summary} 请先根据修复方案确认数据或研究设定。`,
        {
          method_id: methodID,
          preflight_status: preflight.status,
          issues: preflight.issues,
          repair_plan: preflight.repair_plan,
        },
      )
    }
    const diagnosisMismatch = dataDiagnosisFingerprintMismatch(
      artifactInput.stage?.metadata?.dataDiagnosis,
      stageId,
      preflight.data_fingerprint,
    )
    if (diagnosisMismatch) {
      const storedDiagnosis = artifactInput.stage?.metadata?.dataDiagnosis
      const storedDiagnosisRecord = storedDiagnosis && typeof storedDiagnosis === "object" && !Array.isArray(storedDiagnosis)
        ? storedDiagnosis as Record<string, unknown>
        : undefined
      log.warn("econometrics execution rejected stale data diagnosis", {
        methodID,
        datasetId,
        stageId,
        reason: diagnosisMismatch,
        diagnosisStageId: storedDiagnosisRecord?.stage_id,
        diagnosisFingerprint: storedDiagnosisRecord?.data_fingerprint,
        preflightFingerprint: preflight.data_fingerprint,
      })
      if (preparedSpec) {
        RuntimeTaskLedger.transitionAnalysis({
          sessionID: input.input.session.id,
          taskId: RuntimeTaskLedger.listTasks(input.input.session.id).activeTaskId ?? "",
          event: { type: "diagnosis_started", requestId: preparedSpec.requestId },
        })
      }
      const mismatchMessage = {
        missing_report: "当前数据阶段没有已保存的数据诊断报告",
        unsupported_version: "当前数据诊断报告版本不受支持",
        stage_mismatch: "数据诊断报告属于另一个数据阶段",
        fingerprint_missing: "当前数据诊断报告缺少内容指纹",
        fingerprint_invalid: "当前数据诊断报告的内容指纹格式无效",
        content_mismatch: "当前数据诊断报告与规范数据内容不一致",
      }[diagnosisMismatch]
      throw new Tool.InputValidationError(
        `${mismatchMessage}，尚未执行 ${methodID}。` +
        "请先调用 data_import 的 profile 或 validate 刷新当前阶段诊断；确认数据与报告匹配后，再按原规格继续。",
      )
    }
    const inputPathBeforeExecute = await resolveDatasetStagePath({
      datasetId,
      filePath: artifactInput.resolvedInputPath,
      toolName: methodID,
      sessionID: input.input.session.id,
      messageID: input.input.processor.message.id,
      callID: call.id,
      ask: context.ask,
    })
    const outputDirBeforeExecute = resolveManagedProjectPath({
      filePath: outputDir,
      managedRoot: datasetRoot(datasetId),
    })
    if (inputPathBeforeExecute !== dataPath || outputDirBeforeExecute !== outputDir) {
      throw new Tool.InputValidationError("计量执行前数据阶段或输出目录发生变化；为避免读写不同产物，已取消执行。")
    }
    const normalizedEngineArguments = preflight.normalized_arguments
    const outputDirExistedBeforeExecution = fs.existsSync(outputDir)
    if (preparedSpec) {
      const latestLedger = RuntimeTaskLedger.listTasks(input.input.session.id)
      const task = latestLedger.tasks.find((item) =>
        item.taskId === latestLedger.activeTaskId &&
        item.analysisRequest?.requestId === preparedSpec.requestId &&
        item.preparedSpec?.specId === preparedSpec.specId,
      )
      if (!task) throw new Tool.InputValidationError("PreparedSpec 所属任务已失效；估计器没有运行。请重新登记当前请求并准备规格。")
      const authorizedIDs = new Set([
        ...input.authorizedMethodIDs,
        ...(Array.isArray(task.metadata?.requiredToolIDs)
          ? task.metadata.requiredToolIDs.filter((id): id is string => typeof id === "string")
          : []),
        ...(Array.isArray(task.metadata?.confirmedToolIDs)
          ? task.metadata.confirmedToolIDs.filter((id): id is string => typeof id === "string")
          : []),
      ])
      if (!task.analysisLifecycle?.authorization) {
        if (!authorizedIDs.has(preparedSpec.methodID)) {
          throw new Tool.InputValidationError("当前规格没有来自用户明确选择或确认的执行授权；估计器没有运行。")
        }
        RuntimeTaskLedger.transitionAnalysis({
          sessionID: input.input.session.id,
          taskId: task.taskId,
          event: {
            type: "user_decision",
            requestId: preparedSpec.requestId,
            specId: preparedSpec.specId,
            revision: preparedSpec.revision,
            stageFingerprint: preparedSpec.stageFingerprint,
            decision: "approve",
            decisionMessageId: input.input.sourceUserMessageId ?? task.messageID ?? "",
          },
        })
      }
      RuntimeTaskLedger.transitionAnalysis({
        sessionID: input.input.session.id,
        taskId: task.taskId,
        event: {
          type: "execution_started",
          requestId: preparedSpec.requestId,
          specId: preparedSpec.specId,
          stageFingerprint: preparedSpec.stageFingerprint,
        },
      })
    }
    let response: Awaited<ReturnType<typeof input.econometricsEngine.execute>>
    try {
      response = await input.econometricsEngine.execute({
        method_id: methodID,
        data_path: dataPath,
        output_dir: outputDir,
        arguments: normalizedEngineArguments,
        runtime,
        ...(preparedSpec ? { expected_data_fingerprint: preparedSpec.stageFingerprint } : {}),
      }, call.abort)
    } catch (error) {
      if (!outputDirExistedBeforeExecution) {
        try {
          const outputDirToClean = resolveManagedProjectPath({
            filePath: outputDir,
            managedRoot: datasetRoot(datasetId),
          })
          fs.rmSync(outputDirToClean, { recursive: true, force: true })
        } catch (cleanupError) {
          log.warn("failed to clean up unregistered econometrics output after execution failure", {
            methodID,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          })
        }
      }
      if (preparedSpec) {
        const failureCode = error instanceof EconometricsEngineError ? error.code : "ENGINE_EXECUTION_ERROR"
        const outcomeUnknown = !(error instanceof EconometricsEngineError) || error.retryable ||
          ["ENGINE_TIMEOUT", "ENGINE_ABORTED", "ENGINE_CRASHED", "ENGINE_CLOSED"].includes(failureCode)
        const task = RuntimeTaskLedger.listTasks(input.input.session.id).tasks.find((item) =>
          item.analysisRequest?.requestId === preparedSpec.requestId,
        )
        if (task) {
          RuntimeTaskLedger.transitionAnalysis({
            sessionID: input.input.session.id,
            taskId: task.taskId,
            event: outcomeUnknown
              ? { type: "execution_unconfirmed", requestId: preparedSpec.requestId, specId: preparedSpec.specId, failureCode }
              : { type: "execution_failed", requestId: preparedSpec.requestId, specId: preparedSpec.specId, failureCode, retryable: false },
          })
        }
      }
      throw error
    }
    if (preparedSpec && (
      response.success !== true ||
      response.method_id !== methodID ||
      !response.payload || typeof response.payload !== "object" || Array.isArray(response.payload)
    )) {
      const task = RuntimeTaskLedger.listTasks(input.input.session.id).tasks.find((item) =>
        item.analysisRequest?.requestId === preparedSpec.requestId,
      )
      if (task) {
        RuntimeTaskLedger.transitionAnalysis({
          sessionID: input.input.session.id,
          taskId: task.taskId,
          event: {
            type: "execution_unconfirmed",
            requestId: preparedSpec.requestId,
            specId: preparedSpec.specId,
            failureCode: "RESULT_CONTRACT_INVALID",
          },
        })
      }
      throw new EconometricsEngineError("RESULT_CONTRACT_INVALID", "计量引擎已返回，但结果契约不完整或方法标识不匹配；结果尚未验证，请先检查当前产物，系统不会自动重跑。")
    }
    try {
    const latestInput = resolveArtifactInput({ datasetId, stageId })
    if (!latestInput.resolvedInputPath) {
      throw new Tool.InputValidationError("计量执行期间当前数据阶段已不可用；拒绝登记本次结果。")
    }
    const latestInputPath = await resolveDatasetStagePath({
      datasetId,
      filePath: latestInput.resolvedInputPath,
      toolName: methodID,
      sessionID: input.input.session.id,
      messageID: input.input.processor.message.id,
      callID: call.id,
      ask: context.ask,
    })
    if (latestInputPath !== dataPath) {
      throw new Tool.InputValidationError("计量执行期间当前数据阶段发生变化；拒绝把结果登记到旧血缘。")
    }
    const outputDirAfterExecution = resolveManagedProjectPath({
      filePath: outputDir,
      managedRoot: datasetRoot(datasetId),
    })
    if (outputDirAfterExecution !== outputDir) {
      throw new Tool.InputValidationError("计量引擎执行期间输出目录发生变化；拒绝读取或发布非预定产物。")
    }
    const payload = response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)
      ? response.payload as Record<string, unknown>
      : {}
    const rawArtifacts = Array.isArray(response.artifacts)
      ? response.artifacts.filter((item): item is { kind: string; path: string } =>
          Boolean(item && typeof item === "object" && typeof (item as any).kind === "string" && typeof (item as any).path === "string"),
        )
      : []
    const manifest = artifactInput.manifest
    const stage = artifactInput.stage
    const runId = inferRunId({ requestedRunId: undefined, stage, source: "model" })
    const branch = inferBranch({ requestedBranch: undefined, stage, source: "model" })
    const visibleArtifacts: Array<{ kind: string; path: string }> = []
    for (const artifact of rawArtifacts) {
      const sourcePath = resolveManagedProjectPath({ filePath: artifact.path, managedRoot: outputDir })
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue
      const visiblePath = manifest
        ? publishVisibleOutput({
            manifest,
            key: `${methodID}_${artifact.kind}`,
            label: `${methodID}_${artifact.kind}`,
            sourcePath,
            runId,
            branch: path.join("econometrics", methodID),
            stageId,
            metadata: artifact.kind === "result"
              ? { methodSpecification: { methodID, arguments: normalizedEngineArguments } }
              : undefined,
          })
        : sourcePath
      if (manifest) {
        appendArtifact(manifest, {
          artifactId: `${methodID}_${artifact.kind}_${Date.now()}`,
          runId,
          stageId,
          branch,
          action: methodID,
          outputPath: sourcePath,
          summaryPath: sourcePath,
          createdAt: new Date().toISOString(),
        })
      }
      visibleArtifacts.push({ kind: artifact.kind, path: visiblePath })
    }
    const toolResult = buildEngineToolResult({
      methodID,
      datasetId,
      stageId,
      methodArguments: normalizedEngineArguments,
      payload,
      artifacts: visibleArtifacts,
    })
    if (preparedSpec) {
      const task = RuntimeTaskLedger.listTasks(input.input.session.id).tasks.find((item) =>
        item.analysisRequest?.requestId === preparedSpec.requestId,
      )
      if (task) {
        const resultId = `${runId}:${methodID}:${path.basename(outputDir)}`
        RuntimeTaskLedger.transitionAnalysis({
          sessionID: input.input.session.id,
          taskId: task.taskId,
          event: {
            type: "execution_result",
            requestId: preparedSpec.requestId,
            specId: preparedSpec.specId,
            resultId,
            artifactRefs: visibleArtifacts.map((artifact) => artifact.path),
          },
        })
        const resultRecord = toolResult.metadata?.result
        const contractValid = Boolean(
          resultRecord && typeof resultRecord === "object" && !Array.isArray(resultRecord) && visibleArtifacts.length > 0,
        )
        RuntimeTaskLedger.transitionAnalysis({
          sessionID: input.input.session.id,
          taskId: task.taskId,
          event: {
            type: "result_contract_verified",
            requestId: preparedSpec.requestId,
            specId: preparedSpec.specId,
            resultId,
            status: contractValid ? "pass" : "block",
          },
        })
        if (!contractValid) {
          throw new EconometricsEngineError("RESULT_CONTRACT_INVALID", "计量结果缺少结构化结果或已登记的结果文件；没有向用户报告成功，且不会自动重跑。")
        }
      }
    }
    return toolResult
    } catch (error) {
      if (preparedSpec) {
        const ledger = RuntimeTaskLedger.listTasks(input.input.session.id)
        const task = ledger.tasks.find((item) => item.analysisRequest?.requestId === preparedSpec.requestId)
        if (task?.analysisLifecycle?.status === "running" ||
          (task?.analysisLifecycle?.status === "verifying" && task.analysisLifecycle.resultId)) {
          try {
            RuntimeTaskLedger.transitionAnalysis({
              sessionID: input.input.session.id,
              taskId: task.taskId,
              event: task.analysisLifecycle.status === "running"
                ? {
                    type: "execution_unconfirmed",
                    requestId: preparedSpec.requestId,
                    specId: preparedSpec.specId,
                    failureCode: error instanceof EconometricsEngineError ? error.code : "RESULT_PERSISTENCE_FAILED",
                  }
                : {
                    type: "result_contract_verified",
                    requestId: preparedSpec.requestId,
                    specId: preparedSpec.specId,
                    resultId: task.analysisLifecycle.resultId!,
                    status: "block",
                  },
            })
          } catch {
            // Preserve the original artifact/contract error; failed state persistence must not imply execution success.
          }
        }
      }
      throw error
    }
  }

  const pausedAfterUserDecision = () => ({
    title: "已暂停后续操作",
    output: did2sFrequencyChecks > 0
      ? "两阶段 DID 仍缺少已核验的 cohortVar（首次处理时期）或 relativeTimeVar（相对时期），上一项操作需要用户确认；当前模型轮已暂停，等待你提供真实列名和编码规则后再继续。"
      : "上一项操作需要用户确认，当前模型轮已暂停；等待用户确认后再继续。",
    metadata: {
      requiresUserDecision: true,
      suppressedAfterUserDecision: true,
    },
  })

  const resultRequiresUserDecision = (value: unknown) =>
    Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { metadata?: { requiresUserDecision?: unknown } }).metadata?.requiresUserDecision === true,
    )

  const annotateUserSpecifiedVariableCorrections = (call: ToolPortCall, result: {
    output: string
    metadata?: Record<string, unknown>
  }) => {
    const corrections = userSpecifiedVariableCorrections.get(call.id) ?? []
    userSpecifiedVariableCorrections.delete(call.id)
    const payload = result.metadata?.result
    if (
      corrections.length === 0 ||
      !payload || typeof payload !== "object" || Array.isArray(payload) ||
      (payload as Record<string, unknown>).success !== true
    ) return result

    const correctionNote = corrections.map((item) =>
      `${VARIABLE_FIELD_LABELS[item.field]}从模型参数“${item.modelValue}”恢复为你本轮明确指定且数据中存在的“${item.userValue}”`,
    ).join("；")
    return {
      ...result,
      output: `${result.output}\n\n参数恢复：${correctionNote}；估计方法和其他变量角色未改变。`,
      metadata: {
        ...result.metadata,
        userSpecifiedParameterCorrections: corrections,
      },
    }
  }

  const injectCurrentDataLineage = (methodID: string, args: unknown) => {
    const modelArguments = args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {}
    const workflow = getActiveWorkflowRun(input.input.session.id)
    const currentData = workflow
      ? canonicalDataStageForWorkflow(workflow, activeOrLatestStage(workflow))
      : null
    if (!currentData) {
      throw new Tool.InputValidationError(
        `计量方法“${methodID}”找不到当前会话可执行的规范化数据阶段；请先完成数据导入与质量检查。`,
      )
    }
    return {
      ...modelArguments,
      // 兼容调用可能夹带旧血缘；当前会话事实始终最后覆盖，不能借此切换数据集。
      datasetId: currentData.datasetId,
      stageId: currentData.stageId,
    }
  }

  const policyConstructionSpec = (args: Record<string, unknown>) => {
    const options = args.options && typeof args.options === "object" && !Array.isArray(args.options)
      ? args.options as Record<string, unknown>
      : {}
    const columns = Array.isArray(args.columns) ? args.columns.filter((value): value is string => typeof value === "string") : []
    const left = columns[0] ?? "当前列"
    const operator = typeof options.operator === "string" ? options.operator : typeof args.operator === "string" ? args.operator : "比较"
    const right = options.right_value ?? options.right_column ?? args.right_value ?? args.right_column
    return `${left} ${operator} ${right === undefined ? "右侧条件" : String(right)}`
  }

  const confirmPolicyConstruction = async (args: Record<string, unknown>, call: ToolPortCall) => {
    if (confirmedPolicyConstruction || !needsPolicyConstructionConfirmation({ userText: input.input.userText, args })) return undefined
    const recommendationMismatch = recommendationMethodMismatch({
      userText: input.input.userText,
      recommendedMethod: input.recommendedMethod,
      requestedMethod: "did_static",
    })
    if (recommendationMismatch) return recommendationMismatch
    const proposedRule = policyConstructionSpec(args)
    const answers = await Question.ask({
      sessionID: input.input.session.id,
      tool: { messageID: input.input.processor.message.id, callID: call.id },
      questions: [{
        header: "确认post构造",
        question: `模型准备按“${proposedRule}”构造post（政策后指示变量）。这会改变DID的样本划分，是否确认？`,
        options: [
          { label: "确认按此规则构造", description: "仅执行当前显示的规则，不改变因变量、处理组或估计方法。" },
          { label: "我提供其他规则", description: "先暂停，等待你提供固定政策年份或明确的处理时点规则。" },
          { label: "停止本次分析", description: "不创建post，保留当前数据和研究设定。" },
        ],
        custom: true,
      }],
    })
    const answer = answers[0]?.join(" ").trim() ?? ""
    const confirmed = confirmsPolicyConstructionAnswer(answer)
    if (confirmed) {
      confirmedPolicyConstruction = true
      if (input.confirmedPolicyConstruction) input.confirmedPolicyConstruction.value = true
      return undefined
    }
    stoppedForUserDecision = true
    return {
      title: "等待确认post构造规则",
      output: `尚未构造post。当前拟用规则为“${proposedRule}”，它会改变DID的政策前后划分；未获得用户确认，已暂停后续分析。`,
      metadata: {
        requiresUserDecision: true,
        policyConstructionConfirmation: true,
        proposedRule,
      },
    }
  }

  const medianGroupingBlock = (args: Record<string, unknown>) => {
    if (!needsMedianGroupingConfirmation({ userText: input.input.userText, args })) return undefined
    return {
      title: "无法安全构造中位数分组",
      output: "尚未执行中位数分组。当前数据预处理工具不能自动计算中位数；模型提供的分组阈值未经用户确认，已停止写入分组列或继续估计。请提供中位数数值，或提供已有的高低组分类列后再继续。",
      metadata: {
        requiresUserDecision: true,
        medianGroupingConfirmation: true,
      },
    }
  }

  /**
   * PreparedSpec 稳定执行路径上的用户语义门禁。方法 Schema 和数据适配条件由 Python
   * Registry/Pydantic 与 preflight 决定；此处只处理用户明确变量角色、推断口径等决策。
   * 未准备规格的具体方法调用会在直接工具分支立即拒绝。
   */
  const methodReadinessBlock = async (
    methodID: string,
    args: unknown,
    call?: ToolPortCall,
  ) => {
    const recommendationMismatch = recommendationMethodMismatch({
      userText: input.input.userText,
      recommendedMethod: input.recommendedMethod,
      requestedMethod: methodID,
    })
    if (recommendationMismatch) return recommendationMismatch
    const targetArguments = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>
    const acceptedAliases = input.acceptedInputAliases(methodID)
    const providedAliases = Object.keys(targetArguments).filter((field) => acceptedAliases.includes(field))
    const userCovariance = explicitUserCovarianceValue(input.input.userText)
    if (call) {
      // 先由 Python Registry 校验模型已经提交的值；只有缺少必填研究角色时才继续走下方用户决策。
      const registryRuntimeFields = input.runtimeInjectedFields(methodID)
      const runtime = Object.fromEntries(
        registryRuntimeFields
          .filter((field) => targetArguments[field] !== undefined)
          .map((field) => [field, targetArguments[field]]),
      )
      const methodArguments = { ...targetArguments }
      for (const field of [
        ...registryRuntimeFields,
        "datasetId", "dataset_id", "stageId", "stage_id", "runId", "run_id", "branch", "branch_id",
        "inputPath", "input_path", "outputPath", "output_path", "outputDir", "output_dir", "dataPath", "data_path", "runtime",
      ]) delete methodArguments[field]
      let validated: Awaited<ReturnType<typeof input.econometricsEngine.validate>> | undefined
      try {
        validated = await input.econometricsEngine.validate(methodID, methodArguments, {
          signal: call.abort,
          runtime,
        })
      } catch (error) {
        const validationErrors = error instanceof EconometricsEngineError
          ? error.details?.validation_errors
          : undefined
        const onlyMissingRequiredFields = Array.isArray(validationErrors) &&
          validationErrors.length > 0 &&
          validationErrors.every((issue) =>
            Boolean(issue && typeof issue === "object" && (issue as Record<string, unknown>).type === "missing"),
          )
        if (!onlyMissingRequiredFields || !call.schemaSentToolIDs?.includes(methodID)) {
          throw schemaNotSentError(methodID, call, error)
        }
      }
      if (validated && providedAliases.length > 0) {
        for (const alias of providedAliases) delete targetArguments[alias]
        Object.assign(targetArguments, validated.arguments)
      }
    }

    const modelCovariance = typeof targetArguments.covariance === "string" ? targetArguments.covariance : undefined
    if (
      call &&
      userCovariance &&
      modelCovariance &&
      covarianceSpecKey(methodID, userCovariance) !== covarianceSpecKey(methodID, modelCovariance)
    ) {
      const approvedLabel = `确认改为 ${modelCovariance}`
      const answers = await Question.ask({
        sessionID: input.input.session.id,
        tool: { messageID: input.input.processor.message.id, callID: call.id },
        questions: [{
          header: "确认协方差口径",
          question: `你本轮明确指定“${userCovariance}”，当前计量调用却使用“${modelCovariance}”。这会改变标准误、p 值和置信区间；是否确认更改？`,
          options: [
            { label: `保持 ${userCovariance} 并停止本次估计`, description: "保留你的原推断口径；此前失败的同一参数组合不会被原样重试。" },
            { label: approvedLabel, description: "确认改变本次标准误与统计推断口径。" },
          ],
          custom: false,
        }],
      })
      const answer = answers[0]?.length === 1 ? answers[0][0]?.trim() : undefined
      if (answer !== approvedLabel) {
        markUserDecisionStop()
        return {
          title: "等待确认协方差口径",
          output: `尚未执行 ${methodID}。你原指定“${userCovariance}”，模型改成了“${modelCovariance}”；该改动会改变推断口径。未获得确认，因此没有切换到新口径或重试估计。`,
          metadata: {
            requiresUserDecision: true,
            covarianceChange: { requested: userCovariance, proposed: modelCovariance },
          },
        }
      }
    }

    if (call && needsEventStudyNeverTreatedConfirmation({
      methodID,
      userText: input.input.userText,
      args: targetArguments,
    })) {
      markUserDecisionStop()
      const cohortVar = typeof targetArguments.cohortVar === "string" ? targetArguments.cohortVar : "首次处理时期列"
      const treatmentVar = typeof targetArguments.treatmentVar === "string" ? targetArguments.treatmentVar : "处理指示列"
      const timeVar = typeof targetArguments.timeVar === "string" ? targetArguments.timeVar : "时期列"
      return {
        title: "等待确认从未处理组的 cohort 编码",
        output: `尚未执行 ${methodID}。若 ${cohortVar} 缺失表示从未处理，PyFixest 需要 cohort=0；这只会在估计计算副本中映射，不会改动原始数据。请确认该缺失含义、0编码及 ${treatmentVar} 必须逐行满足 cohort>0 且 ${timeVar}>=cohort 的规则；否则请提供完整 cohort 列或选择其他设计。`,
        metadata: { requiresUserDecision: true, eventStudyNeverTreatedConfirmation: true },
      }
    }

    const readinessState = readStoredDataReadinessState(
      typeof targetArguments.datasetId === "string" ? targetArguments.datasetId : "",
      typeof targetArguments.stageId === "string" ? targetArguments.stageId : undefined,
    )
    let preserveAuthorizedCompositeEntity = false
    if (call && readinessState.report && !readinessState.stale) {
      const availableColumns = new Set(readinessState.report.columns.map((column) => column.name))
      const fields: VariableSubstitutionField[] = ["dependentVar", "treatmentVar", "entityVar", "timeVar"]
      const originalEntityVar = explicitUserVariableValue({ userText: input.input.userText, field: "entityVar" })
      const modelEntityVar = targetArguments.entityVar
      const datasetId = targetArguments.datasetId
      const stageId = targetArguments.stageId
      const timeVar = targetArguments.timeVar
      preserveAuthorizedCompositeEntity = Boolean(
        call &&
        originalEntityVar &&
        typeof modelEntityVar === "string" &&
        typeof datasetId === "string" &&
        typeof stageId === "string" &&
        typeof timeVar === "string" &&
        hasAuthorizedCompositeEntityStage({
          userText: input.input.userText,
          datasetId,
          stageId,
          originalEntityVar,
          compositeEntityVar: modelEntityVar,
          timeVar,
          report: readinessState.report,
        }),
      )
      for (const field of fields) {
        const modelValue = targetArguments[field]
        const userValue = explicitUserVariableValue({ userText: input.input.userText, field })
        // Restore only an exact, user-declared column that the current fresh readiness report
        // confirms exists. This is not a research-design substitution: the model drifted from
        // the user's explicit specification. If the user's column is absent, keep the existing
        // confirmation/stop path below.
        if (field === "entityVar" && preserveAuthorizedCompositeEntity && modelValue === modelEntityVar) continue
        if (typeof modelValue !== "string" || !userValue || userValue === modelValue || !availableColumns.has(userValue)) continue
        targetArguments[field] = userValue
        const corrections = userSpecifiedVariableCorrections.get(call.id) ?? []
        if (!corrections.some((item) => item.field === field && item.modelValue === modelValue && item.userValue === userValue)) {
          corrections.push({ field, modelValue, userValue })
          userSpecifiedVariableCorrections.set(call.id, corrections)
        }
      }
    }

    const substitution = ([
      ["dependentVar", targetArguments.dependentVar],
      ["treatmentVar", targetArguments.treatmentVar],
      ["entityVar", targetArguments.entityVar],
      ["timeVar", targetArguments.timeVar],
    ] as const)
      .filter((entry): entry is [VariableSubstitutionField, string] => typeof entry[1] === "string")
      .map(([field, actualValue]) => detectExplicitVariableSubstitution({
        userText: input.input.userText,
        field,
        actualValue,
      }))
      .find((value): value is VariableSubstitution => Boolean(value))
    const authorizedCompositeEntitySubstitution =
      substitution?.field === "entityVar" && preserveAuthorizedCompositeEntity
    if (
      substitution &&
      !authorizedCompositeEntitySubstitution &&
      call &&
      shouldAskVariableSubstitution({ substitution, confirmed: confirmedVariableSubstitutions })
    ) {
      const fieldLabel = VARIABLE_FIELD_LABELS[substitution.field]
      const answers = await Question.ask({
        sessionID: input.input.session.id,
        tool: { messageID: input.input.processor.message.id, callID: call.id },
        questions: [{
          header: `确认${fieldLabel}`,
          question: `用户指定的${fieldLabel}“${substitution.requestedValue}”不在当前数据中，本次调用准备使用“${substitution.actualValue}”。是否确认替换？`,
          options: [
            { label: `用“${substitution.actualValue}”替代（推荐）`, description: "仅确认本次使用的真实列名，不自动改变其他变量角色或估计方法。" },
            { label: "停止本次分析", description: `保留当前研究设定，等待你提供正确的${fieldLabel}。` },
          ],
          custom: false,
        }],
      })
      const answer = answers[0]?.join(" ") ?? ""
      if (!answer.includes(substitution.actualValue)) {
        markUserDecisionStop()
        return {
          title: `等待确认${fieldLabel}`,
          output: `尚未执行${methodID}。用户指定的${fieldLabel}“${substitution.requestedValue}”不存在，当前候选列为“${substitution.actualValue}”；未获得替换确认。`,
          metadata: {
            requiresUserDecision: true,
            variableSubstitution: substitution,
          },
        }
      }
      confirmedVariableSubstitutions.add(variableSubstitutionConfirmationKey(substitution))
    }

    return undefined
  }

  // 兼容旧模型/历史消息偶尔直接发出方法 ID：方法没有进入 Provider tools，因此不会污染
  // 稳定前缀；如果该方法已通过 Registry 加载，仍把它导入同一个 readiness + engine
  // 执行链，而不是把一次可恢复的协议误用直接升级成“工具不存在”。
  const executePreparedMethod = async (
    target: Awaited<ReturnType<typeof ToolRegistry.tools>>[number],
    args: unknown,
    call: ToolPortCall,
    preparedSpec: PreparedSpecRecord,
  ) => {
    const methodArguments = injectCurrentDataLineage(target.id, modelArgumentsForTool(target.id, args))
    const result = await input.input.processor.executeTool<Record<string, unknown>>(target.id, methodArguments, {
      callID: call.id,
      execution: target.execution,
      deferVerification: true,
      beforeRun: async (finalArgs) => {
        const blocked = await methodReadinessBlock(target.id, finalArgs, call)
        if (blocked && resultRequiresUserDecision(blocked)) markUserDecisionStop()
        if (blocked) return blocked
        const finalMethodArguments = modelArgumentsForTool(target.id, finalArgs)
        if (
          !finalMethodArguments ||
          typeof finalMethodArguments !== "object" ||
          Array.isArray(finalMethodArguments) ||
          !analysisSpecArgumentsEqual(finalMethodArguments as Record<string, unknown>, preparedSpec.arguments)
        ) {
          markUserDecisionStop()
          return {
            title: "PreparedSpec 参数已变化",
            output: `方法 ${target.id} 的最终参数与已准备规格不同；本次没有运行估计。请根据当前参数重新调用 analysis_prepare，不能静默覆盖规格。`,
            metadata: { requiresUserDecision: true, preparedSpecInvalidated: true, specId: preparedSpec.specId },
          }
        }
        return undefined
      },
      run: async (finalArgs) => Tool.executeWithPolicyTimeout({
        execution: target.execution,
        args: finalArgs,
        context: input.context(finalArgs, call),
        execute: (timedContext) => executeEngineMethod(
              target.id,
              finalArgs as Record<string, unknown>,
              { ...call, abort: timedContext?.abort ?? call.abort },
              timedContext,
              preparedSpec,
            ),
      }),
    }).catch((error) => {
      userSpecifiedVariableCorrections.delete(call.id)
      throw error
    })
    const routedResult = annotateUserSpecifiedVariableCorrections(call, result)
    if (resultRequiresUserDecision(routedResult)) markUserDecisionStop()
    return routedResult
  }

  return {
    async execute(call: ToolPortCall) {
      // 仅 preflight 决策返回允许进入下一轮模型解释/提问；相同响应里的后续调用仍
      // 会被拦截。其它用户审批停点仍由 userDecisionStop 终止整个请求。
      if (stoppedForUserDecision && call.batchIndex === 0) stoppedForUserDecision = false
      if (input.needsRequestRegistration() && call.name !== "analysis_request") {
        throw new Tool.InputValidationError(
          "当前数据任务尚未登记为 AnalysisRequest；该工具调用没有执行。请先调用 analysis_request 登记本条用户消息，再由 Harness 重新组装后续工具池。",
        )
      }
      const pipelineArgs = call.name === "pipeline" ? input.normalizeToolArgs(call.name, call.input) : undefined
      const pipelineAction = pipelineArgs && typeof pipelineArgs === "object" && !Array.isArray(pipelineArgs)
        ? (pipelineArgs as Record<string, unknown>).action
        : undefined
      const rerunBlock = workflowRerunReadOnlyBlock({
        action: pipelineAction,
        analysisRequestKind: input.input.analysisRequestKind,
        qualityInspectionOnly: input.input.qualityInspectionOnly,
        recommendationOnly: input.input.recommendationOnly,
      })
      if (rerunBlock) return rerunBlock
      const recommendationOnlyBlock = recommendationOnlyMethodBlock(input.input.recommendationOnly, call.name)
      if (recommendationOnlyBlock) return recommendationOnlyBlock
      const directScopeArgs = call.name === "data_preprocess"
        ? input.normalizeToolArgs(call.name, call.input)
        : call.input
      const directPsmToolScopeBlock = psmToolScopeBlock(
        input.input.psmToolScope,
        call.name,
        directScopeArgs,
        input.input.psmScopeFilter,
      )
      if (directPsmToolScopeBlock) return directPsmToolScopeBlock
      const consultationBlock = consultationToolBlock(call.name, input.input.consultationOnly)
      if (consultationBlock) return consultationBlock
      // 规格工具本身仍允许返回一次自己的门禁说明；但 read/list/glob 等旁路探查必须立即
      // 抑制，避免把同一轮的决策阻断变成一串无关的文件不存在错误。
      if (stoppedForUserDecision) {
        return pausedAfterUserDecision()
      }
      if (isConcreteMethodTool(call.name)) {
        throw new Tool.InputValidationError(
          `计量方法“${call.name}”不是本轮可直接调用的工具；该调用未执行。请先用 tool_search 获取完整方法 Schema，` +
          "再用当前 requestId 调 analysis_prepare 校验当前数据阶段，最后仅通过 econometrics_execute(specId) 执行。",
        )
      }
      if (!input.definitions[call.name] || !input.requestAllowlist().has(call.name)) {
        throw new Error(`Tool ${call.name} is not available in this request.`)
      }

      // 模型只提交 Harness 签发的 specId。方法参数、请求来源与数据血缘全部从账本恢复，
      // 并在复用既有 SessionProcessor/方法执行策略前重新核对当前 stage 和用户授权。
      if (call.name === "econometrics_execute") {
        const normalizedArgs = input.normalizeToolArgs(call.name, call.input)
        const parsed = EconometricsExecuteInput.safeParse(normalizedArgs)
        if (!parsed.success) {
          throw new Tool.InputValidationError(
            `工具 econometrics_execute 参数不合法：${Tool.formatZodErrorChinese(parsed.error)}\n` +
            "修复建议：只传 analysis_prepare 返回的 specId；不要传 methodID、arguments 或数据血缘。",
            { cause: parsed.error },
          )
        }
        if (!input.input.sourceUserMessageId) {
          markUserDecisionStop()
          return {
            title: "无法确认分析请求来源",
            output: "当前稳定计量调用没有对应的原始用户消息，拒绝执行该 specId。请从当前研究问题重新登记请求并准备规格。",
            metadata: { requiresUserDecision: true, estimateExecuted: false, specId: parsed.data.specId },
          }
        }
        const ledger = RuntimeTaskLedger.listTasks(input.input.session.id)
        const task = ledger.tasks.find((item) =>
          item.taskId === ledger.activeTaskId && item.messageID === input.input.sourceUserMessageId,
        )
        const workflow = getActiveWorkflowRun(input.input.session.id)
        const currentDataLineage = workflow
          ? canonicalDataStageForWorkflow(workflow, activeOrLatestStage(workflow))
          : null
        if (!task || !currentDataLineage) {
          markUserDecisionStop()
          return {
            title: "当前请求或数据阶段已失效",
            output: "找不到与 specId 绑定的当前 estimate 请求或规范化数据阶段；未运行估计。请重新登记当前任务、导入诊断数据并准备新规格。",
            metadata: { requiresUserDecision: true, estimateExecuted: false, specId: parsed.data.specId },
          }
        }
        const artifactInput = resolveArtifactInput(currentDataLineage)
        if (!artifactInput.resolvedInputPath) {
          markUserDecisionStop()
          return {
            title: "当前数据阶段不可读取",
            output: "specId 指向的数据阶段没有可读取的规范化文件；未运行估计。请先恢复或重新导入当前数据阶段，再准备新规格。",
            metadata: { requiresUserDecision: true, estimateExecuted: false, specId: parsed.data.specId },
          }
        }
        const currentData = {
          ...currentDataLineage,
          dataPath: artifactInput.resolvedInputPath,
          stageMetadata: artifactInput.stage?.metadata,
        }
        const contextForAuthorization = input.context(normalizedArgs, call)
        const authorizedMethodIDs = Array.isArray(contextForAuthorization.extra?.authorizedMethodIDs)
          ? contextForAuthorization.extra!.authorizedMethodIDs.filter((id: unknown): id is string => typeof id === "string")
          : []
        const resolution = resolvePreparedSpecForExecution({
          sessionID: input.input.session.id,
          taskId: task.taskId,
          sourceMessageId: input.input.sourceUserMessageId,
          requestId: task.analysisRequest?.requestId ?? "",
          specId: parsed.data.specId,
          currentData,
          authorizedMethodIDs,
        })
        if (resolution.status !== "ready") {
          markUserDecisionStop()
          if (resolution.status === "authorization_required" && task.analysisRequest && task.preparedSpec) {
            RuntimeTaskLedger.transitionAnalysis({
              sessionID: input.input.session.id,
              taskId: task.taskId,
              event: {
                type: "authorization_requested",
                requestId: task.analysisRequest.requestId,
                specId: task.preparedSpec.specId,
                revision: task.preparedSpec.revision,
                stageFingerprint: task.preparedSpec.stageFingerprint,
              },
            })
          }
          return {
            title: resolution.status === "authorization_required" ? "需要用户确认计量方法" : "PreparedSpec 已失效",
            output: resolution.message,
            metadata: {
              requiresUserDecision: true,
              estimateExecuted: false,
              specId: parsed.data.specId,
              preparedSpecStatus: resolution.status,
            },
          }
        }
        const preparedSpec = resolution.preparedSpec
        const psmMethodScopeBlock = psmToolScopeBlock(input.input.psmToolScope, preparedSpec.methodID)
        if (psmMethodScopeBlock) {
          if (resultRequiresUserDecision(psmMethodScopeBlock)) markUserDecisionStop()
          return psmMethodScopeBlock
        }
        if (!isConcreteMethodTool(preparedSpec.methodID)) {
          markUserDecisionStop()
          return {
            title: "方法已不再准入",
            output: `PreparedSpec 中的方法“${preparedSpec.methodID}”当前不在准入目录；未运行估计。请重新推荐并准备规格。`,
            metadata: { requiresUserDecision: true, estimateExecuted: false, specId: preparedSpec.specId },
          }
        }
        const target = input.methodImplementations.get(preparedSpec.methodID) ??
          await input.loadPreparedMethod(preparedSpec.methodID)
        if (!target) {
          markUserDecisionStop()
          return {
            title: "方法当前不可执行",
            output: `方法“${preparedSpec.methodID}”已不在当前准入/权限范围；未运行估计。请重新搜索可用方法并准备规格。`,
            metadata: { requiresUserDecision: true, estimateExecuted: false, specId: preparedSpec.specId },
          }
        }
        const methodArguments = injectCurrentDataLineage(preparedSpec.methodID, preparedSpec.arguments)
        return executePreparedMethod(target, methodArguments, call, preparedSpec)
      }

      const item = input.implementations.get(call.name)
      if (!item) throw new Error(`Tool ${call.name} is not available in this request.`)
      // 规范化工具参数：兼容 JSON 字符串或纯字符串输入
      let normalizedArgs = modelArgumentsForTool(item.id, call.input)
      if (item.id === "econometrics_recommend") {
        normalizedArgs = injectCurrentDataLineage(item.id, normalizedArgs)
      }
      const frequencyReservation = item.id === "data_import" &&
        (normalizedArgs as { action?: unknown }).action === "frequency" &&
        isExplicitDid2sRequest(input.input.userText)

      // did2s 的 cohort/relative-time 是研究设计输入，不是可以无限探查后猜出的普通列名。
      // 显式切换 did2s 后最多允许一次必要 frequency；后续探查直接暂停并交还用户，避免
      // Agnes 这类模型在缺少首次处理时点时循环组合 groupBy/profile 或创建伪 cohort。
      if (item.id === "data_import") {
        const dataImportRecord = normalizedArgs as Record<string, unknown>
        const action = typeof dataImportRecord.action === "string" ? dataImportRecord.action : undefined
        const explicitPaths = explicitUserDataPaths(input.input.userText)
        const explicitSourcePaths = explicitPaths.filter(isDataFile)
        const attachmentPath = await latestPendingDataAttachmentPath(input.input.session.id)
        const hasActiveDataset = DataContext.hasActiveDataset(input.input.session.id)
        const currentUserDataPath = selectDataImportSource({
          userText: input.input.userText,
          explicitSourcePaths,
          attachmentPath,
        })

        if ((action === "import" || (!hasActiveDataset && ["profile", "validate", "correlation", "frequency"].includes(action ?? ""))) && explicitSourcePaths.length > 1) {
          markUserDecisionStop()
          return {
            title: "需要确认数据文件",
            output: `当前消息中有多个候选数据文件：${explicitSourcePaths.join("、")}。一次只能导入一个文件，请用户明确选择后再继续。`,
            metadata: { requiresUserDecision: true, dataPathChoices: explicitSourcePaths },
          }
        }
        if (action === "export" && explicitPaths.length > 1) {
          markUserDecisionStop()
          return {
            title: "需要确认导出目标",
            output: `当前消息中有多个文件路径：${explicitPaths.join("、")}。为避免把结果写入错误位置，请用户明确提供唯一导出目标。`,
            metadata: { requiresUserDecision: true, exportPathChoices: explicitPaths },
          }
        }

        if (action === "import") {
          if (!currentUserDataPath) {
            markUserDecisionStop()
            return {
              title: "需要数据文件",
              output: "本轮没有上传可导入的数据文件，也未在当前消息中识别出明确的数据文件路径。请上传文件或直接提供路径；系统没有读取任何本地文件。",
              metadata: { requiresUserDecision: true, missingDataSource: true },
            }
          }
          normalizedArgs = { ...dataImportRecord, inputPath: currentUserDataPath }
        } else if (action === "export" && explicitPaths.length > 0) {
          // 唯一导出目标由用户原文恢复，并仍经过 DataImportTool 的写路径授权；不接受模型单独给出的路径。
          normalizedArgs = { ...dataImportRecord, outputPath: explicitPaths[0] }
        }
        const initialImport = initialAttachmentImportArgs({
          action,
          hasActiveDataset,
          inputPath: currentUserDataPath,
          worksheetName: input.input.worksheetName,
        })
        if (initialImport) {
          normalizedArgs = initialImport
          // 只在首次附件、无现有 dataset 时发生；回给模型的结果会包含真实血缘，
          // 后续 profile/validate 必须复用该血缘，不再重复导入。
        } else {
          const workflow = getActiveWorkflowRun(input.input.session.id)
          const currentData = workflow
            ? canonicalDataStageForWorkflow(workflow, activeOrLatestStage(workflow))
            : null
          if (action === "rollback") {
            const currentManifest = currentData
              ? resolveArtifactInput({ datasetId: currentData.datasetId, stageId: currentData.stageId }).manifest
              : undefined
            const availableStageIDs = currentManifest?.stages
              .filter((stage) => stage.stageId !== currentData?.stageId)
              .map((stage) => stage.stageId) ?? []
            const requestedStageID = typeof dataImportRecord.rollbackStageId === "string"
              ? dataImportRecord.rollbackStageId
              : undefined
            if (!currentData || !requestedStageID || !availableStageIDs.includes(requestedStageID)) {
              markUserDecisionStop()
              return {
                title: "需要确认回滚阶段",
                output: availableStageIDs.length
                  ? `只能回滚到当前数据集已有的历史阶段：${availableStageIDs.join("、")}。请询问用户明确选择哪个阶段；没有写入任何新阶段。`
                  : "当前会话没有可回滚的历史数据阶段。请保留现有数据，或先完成新的数据预处理阶段。",
                metadata: { requiresUserDecision: true, rollbackStageChoices: availableStageIDs },
              }
            }
            normalizedArgs = injectCurrentDataImportLineage({
              ...dataImportRecord,
              rollbackStageId: requestedStageID,
            }, currentData)
          } else {
            normalizedArgs = injectCurrentDataImportLineage(normalizedArgs, currentData)
          }
        }
        if (frequencyReservation && shouldStopAfterDid2sFrequency({
          userText: input.input.userText,
          frequencyChecks: did2sFrequencyChecks + did2sFrequencyInFlight,
        })) {
          markUserDecisionStop()
          return {
            title: "两阶段 DID 需要确认研究设计",
            output: "已完成一次必要的分布检查，但当前对话仍未确认 cohortVar（首次处理时期）或 relativeTimeVar（相对时期）。系统不会继续组合分组条件、猜测首次处理时点或创建伪变量；请提供真实列名和编码规则后再继续 did2s。",
            metadata: {
              requiresUserDecision: true,
              did2sDesignProbeLimit: true,
            },
          }
        }
        if (frequencyReservation) did2sFrequencyInFlight += 1
      }
      if (item.id === "data_preprocess" || item.id === "composite_evaluation" || item.id === "heterogeneity_runner") {
        normalizedArgs = injectCurrentDataLineage(item.id, normalizedArgs)
      }

      // 模型可能在已经得到用户确认后再次提出同一列名问题。不要再次弹窗，
      // 也不要把“用户已确认”误判成新的研究决策；把已确认事实作为工具结果
      // 回给模型，让它继续当前任务。只有整批问题都能被已确认事实覆盖时才抑制，
      // 混合问题仍交给用户正常回答。
      if (item.id === "question") {
        const questionInput = normalizedArgs as { questions?: Array<{ question?: unknown; options?: Array<{ label?: unknown }> }> }
        const questions = Array.isArray(questionInput.questions) ? questionInput.questions : []
        const substitutions = questions.map((question) => {
          const answerHint = (question.options ?? [])
            .map((option) => String(option.label ?? ""))
            .join(" ")
          const substitution = detectConfirmedVariableSubstitution({
            userText: input.input.userText,
            question: String(question.question ?? ""),
            answer: answerHint,
          })
          return substitution && confirmedVariableSubstitutions.has(variableSubstitutionConfirmationKey(substitution))
            ? substitution
            : undefined
        })
        if (questions.length > 0 && substitutions.every(Boolean)) {
          const answers = substitutions.map((substitution) => [`已确认使用“${substitution!.actualValue}”`])
          return {
            title: "已复用变量确认",
            output: `该用户动作已确认变量替换：${substitutions.map((substitution) => `${substitution!.requestedValue}→${substitution!.actualValue}`).join("、")}。请继续当前分析，不要再次提问。`,
            metadata: { answers, suppressedDuplicateQuestion: true },
          }
        }
      }

      // 直调路径同样要过就绪门禁：否则模型跳过 econometrics_execute 就能绕开
      // “变量角色未确认不许跑回归”。
      if (item.id === "data_preprocess") {
        if (needsRelativeTimeConstructionConfirmation({ userText: input.input.userText, args: normalizedArgs })) {
          markUserDecisionStop()
          const options = (normalizedArgs as Record<string, unknown>).options as Record<string, unknown> | undefined
          const timeVar = typeof options?.time_var === "string" ? options.time_var : "真实时间列"
          const cohortVar = typeof options?.cohort_var === "string" ? options.cohort_var : "真实首次处理时期列"
          const entityVar = typeof options?.entity_var === "string" ? options.entity_var : "分析单位"
          const treatmentVar = typeof options?.treatment_var === "string" ? options.treatment_var : "处理指示列"
          const outputColumn = typeof options?.output_column === "string" ? options.output_column : "relative_time"
          return {
            title: "等待确认 DID2S 相对时期构造",
            output: `尚未生成 ${outputColumn}，当前数据阶段未修改。请明确确认是否按 ${timeVar}−${cohortVar} 为每个 ${entityVar} 构造已处理单位的相对时期，并将从未处理单位编码为 -inf；${treatmentVar} 必须逐行符合 cohort 与时期关系。确认后会先校验编码一致、实体×时期唯一，再写入新的可回退数据阶段。`,
            metadata: { requiresUserDecision: true, relativeTimeConstructionConfirmation: true },
          }
        }
        const medianBlocked = medianGroupingBlock(normalizedArgs as Record<string, unknown>)
        if (medianBlocked) {
          markUserDecisionStop()
          return medianBlocked
        }
        const blocked = await confirmPolicyConstruction(normalizedArgs as Record<string, unknown>, call)
        if (blocked) {
          if (resultRequiresUserDecision(blocked)) markUserDecisionStop()
          return blocked
        }
      }
      const dataImportAction = item.id === "data_import" && normalizedArgs && typeof normalizedArgs === "object" && !Array.isArray(normalizedArgs)
        ? (normalizedArgs as Record<string, unknown>).action
        : undefined
      const diagnosisTaskId =
        typeof dataImportAction === "string" && ["import", "profile", "validate"].includes(dataImportAction)
          ? startCurrentDataDiagnosis()
          : undefined
      const result = await input.input.processor.executeTool(item.id, normalizedArgs, {
        callID: call.id,
        execution: item.execution,
        deferVerification: true,
        beforeRun: item.id === "econometrics_recommend"
          ? async (finalArgs) => {
              const canonicalArgs = injectCurrentDataLineage(item.id, finalArgs)
              const target = finalArgs as Record<string, unknown>
              Object.assign(target, canonicalArgs)
              const { datasetId, stageId, ...modelArguments } = target
              const validated = await input.econometricsEngine.validate(item.id, modelArguments, {
                signal: call.abort,
                runtime: { datasetId, stageId },
              })
              Object.assign(target, validated.arguments)
              return undefined
          }
          : undefined,
        run: async (finalArgs) => {
          const execute = item.execute as unknown as (args: unknown, ctx: Tool.Context) => Promise<unknown>
          const toolContext = input.context(finalArgs, call)
          addAnalysisToolRunLifecycle(item.id, call, toolContext)
          try {
            return await execute(finalArgs, toolContext) as any
          } catch (error) {
            failAnalysisToolRunIfActive(item.id, call, error)
            throw error
          }
        },
      }).then((value) => {
        if (frequencyReservation) {
          did2sFrequencyInFlight = Math.max(0, did2sFrequencyInFlight - 1)
          did2sFrequencyChecks += 1
        }
        return value
      }).catch((error) => {
        if (frequencyReservation) did2sFrequencyInFlight = Math.max(0, did2sFrequencyInFlight - 1)
        throw error
      })
      if (diagnosisTaskId && typeof dataImportAction === "string") {
        completeCurrentDataDiagnosis(diagnosisTaskId, result)
      }
      if (item.id === "question") {
        const questionInput = normalizedArgs as { questions?: Array<{ question?: unknown }> }
        const questions = Array.isArray(questionInput.questions) ? questionInput.questions : []
        const answers = (result.metadata as { answers?: string[][] } | undefined)?.answers ?? []
        if (answers.some((answer) => /(?:不同意|拒绝|停止本次分析|取消本次分析|do not proceed|stop this analysis)/i.test(answer.join(" ")))) {
          const task = currentAnalysisTask()
          if (task?.analysisRequest && task.analysisLifecycle?.status === "waiting_user") {
            RuntimeTaskLedger.transitionAnalysis({
              sessionID: input.input.session.id,
              taskId: task.taskId,
              event: {
                type: "cancelled",
                requestId: task.analysisRequest.requestId,
                outcomeConfirmed: true,
                failureCode: "USER_DECLINED_PENDING_METHOD",
              },
            })
          }
        }
        for (const [index, question] of questions.entries()) {
          const answer = answers[index]?.join(" ") ?? ""
          const substitution = detectConfirmedVariableSubstitution({
            userText: input.input.userText,
            question: String(question.question ?? ""),
            answer,
          })
          if (substitution) {
            confirmedVariableSubstitutions.add(variableSubstitutionConfirmationKey(substitution))
            const task = currentAnalysisTask()
            if (
              task?.analysisRequest &&
              task.analysisLifecycle?.status === "waiting_user" &&
              task.analysisLifecycle.issueCode === "DATA_COLUMN_MISSING"
            ) {
              RuntimeTaskLedger.transitionAnalysis({
                sessionID: input.input.session.id,
                taskId: task.taskId,
                event: {
                  type: "decision_approved",
                  requestId: task.analysisRequest.requestId,
                  issueCode: "DATA_COLUMN_MISSING",
                  resumeAs: "spec_pending",
                  choice: substitution.actualValue,
                  decisionMessageId: input.input.sourceUserMessageId ?? task.messageID ?? "",
                },
              })
            }
          }
        }
        const repairTask = currentAnalysisTask()
        const repairAnswer = answers.map((answer) => answer.join(" ")).join(" ")
        if (
          repairTask?.analysisRequest &&
          repairTask.analysisLifecycle?.status === "waiting_user" &&
          repairTask.analysisLifecycle.issueCode === "DATA_PANEL_KEY_NOT_UNIQUE" &&
          /省份\s*\+\s*地区|省份.*地区.*复合/i.test(repairAnswer) &&
          !/(?:不同意|拒绝|停止本次分析|取消本次分析)/i.test(repairAnswer)
        ) {
          RuntimeTaskLedger.transitionAnalysis({
            sessionID: input.input.session.id,
            taskId: repairTask.taskId,
            event: {
              type: "decision_approved",
              requestId: repairTask.analysisRequest.requestId,
              issueCode: "DATA_PANEL_KEY_NOT_UNIQUE",
              resumeAs: "repairing",
              choice: "省份+地区",
              decisionMessageId: input.input.sourceUserMessageId ?? repairTask.messageID ?? "",
            },
          })
        }
        const confirmedPost = questions.some(
          (question, index) =>
            /post|政策后/.test(String(question.question)) &&
            answers[index]?.length &&
            confirmsPolicyConstructionAnswer(answers[index].join(" ")),
        )
        if (confirmedPost) {
          confirmedPolicyConstruction = true
          if (input.confirmedPolicyConstruction) input.confirmedPolicyConstruction.value = true
        }
        const followUp = answers
          .map((answer) => policyConstructionFollowUpNotice(answer.join(" ")))
          .find(Boolean)
        if (confirmedPost && followUp) {
          return { ...result, output: `${result.output}\n${followUp}` }
        }
      }
      if (resultRequiresUserDecision(result)) {
        if (call.name === "analysis_prepare") stoppedForUserDecision = true
        else markUserDecisionStop()
      }
      return result
    },
  }
}
