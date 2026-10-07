/**
 * drive harness 场景矩阵：把历轮真实测试踩过的交互模式固化成"用户话术 + 断言"。
 *
 * 每个场景 = 一个真实用户消息（可含数据文件路径）+ 一组行为断言。
 * 断言分两类：
 *   - **硬 pass**（每个场景都查）：无 tool error、baseline_estimate completed、有结果文件
 *   - **行为断言**（场景可选，对应历史 bug 的具体交互模式）
 */

import type { MessageV2 } from "@/session/message-v2"
import type { StageNode, WorkflowRun } from "@/runtime/types"
import { isWorkflowEstimateTool } from "@/runtime/tool-catalog"
import { calledEstimator, hasProgressNotes, hasUnsupportedTimeClaim, reportQuality, turnHasSubstance } from "./ux-checks"
import fs from "fs"
import path from "path"

/** 场景行为断言（drive 报告的一行） */
export interface DriveAssertion {
  label: string
  pass: boolean
  detail: string
  /**
   * 断言维度。run.ts 的 UX 汇总靠它过滤（此前用 label.includes("UX") 魔法字符串，
   * 改 label 文案即静默失效，2026-08-11 simplify 审查）。缺省 = 场景行为断言。
   */
  category?: "ux"
}

export interface DriveScenario {
  /** 唯一 id，`--only <id>` 用 */
  id: string
  /** 人类可读标签（报告表格列） */
  label: string
  /** data/ 下的数据文件名；null = 场景不带数据文件（用户只说话，测"先追问"） */
  dataFile: string | null
  /**
   * 额外数据集（多数据集场景，如 two-datasets）：调用方复制到隔离目录，
   * 路径经 userMessages 第二参数传入。dataFile 里的主数据也会复制。
   */
  extraDataFiles?: string[]
  /**
   * 该场景是否要求跑完估计（baseline_estimate completed + 结果文件）。
   * false = 场景预期只追问/澄清（vague-request/no-file），硬 pass 不查估计与产物。
   */
  expectEstimate: boolean
  /**
   * 用户话术（单轮场景用；多轮场景用 userMessages，二者必居其一）。
   * dataPath 是隔离目录里数据的绝对路径（dataFile 为 null 时为 undefined），
   * 调用方保证 dataFile 非 null 时该文件已复制到隔离目录。
   */
  userMessage?: (dataPath: string | undefined, extraDataPaths?: string[]) => string
  /**
   * 多轮话术（第三轮起：真实用户是多轮对话）。每轮等整轮完成后再发下一条；
   * 缺省退化为 [userMessage(dataPath)]，17 个旧场景零改动。
   */
  userMessages?: (dataPath: string | undefined, extraDataPaths?: string[]) => string[]
  /** 行为断言；返回 { label, pass, detail } 列表，全部通过才算 PASS */
  behavior: (ctx: ScenarioAssertionContext) => DriveAssertion[]
}

/** 场景断言上下文：runner 在整轮对话结束后构造，供 behavior 断言查询 */
export interface ScenarioAssertionContext {
  /** 会话里所有工具调用（含 error/pending），按时间序；估计器带 args（截断 JSON） */
  toolCalls: Array<{ tool: string; status: string; callID?: string; pattern?: string; args?: string; reused?: boolean; requiresUserDecision?: boolean }>
  /** 工具错误（含 reflection 分类） */
  toolErrors: Array<{
    tool: string
    error: string
    reflection?: { failureType?: string; retryStage?: string; repairAction?: string }
  }>
  /** 每轮新增工具调用，供多轮场景确认咨询轮没有越权执行。 */
  turnToolCalls?: Array<Array<{ tool: string; status: string; args?: string; reused?: boolean; requiresUserDecision?: boolean }>>
  /** 会话级错误（例如 Provider 认证/配额失败），供诊断断言按需查看。 */
  sessionErrors?: string[]
  /** 整轮是否超时 */
  timedOut: boolean
  /** workflow run（可能未创建） */
  run: WorkflowRun | undefined
  /** 隔离目录里产出的结果文件（绝对路径） */
  resultFiles: string[]
  /** 本轮 Question 弹窗触发次数 */
  questionCount: number
  /** question 弹窗内容（UX 提问质量断言用） */
  questionEvents: Array<{ prompt: string; options: string[] }>
  /** 会话里所有用户可读文本（拼接，用于断言模型有没有向用户解释/追问） */
  assistantText: string
  /** 全部用户可见文本（按时间序，完整；UX 进度断言用） */
  assistantTexts: string[]
  /** runtime.tool.progress 事件同样是 TUI 用户可见进度；模型可能没有额外文字。 */
  toolProgress?: string[]
  /** 每轮用户可见文本（按轮次分组；多轮追问断言用） */
  turnTexts: string[][]
  /** 最后一轮全部用户可见文本（多轮场景的"最终回答"，报告质量断言用） */
  lastTurnAssistantText: string
  /** 最后一段完整文本（UX 报告质量断言用） */
  finalAssistantText: string
}

/** 核心真实场景统一检查报告可读性，再分别检查方法所需的研究解释。 */
export function coreUxAssertions(id: string, ctx: ScenarioAssertionContext): DriveAssertion[] {
  if (!["data-inspect-only", "ols-basic", "gf-panel", "staggered-did", "psm-matching-basic"].includes(id)) return []
  const text = ctx.finalAssistantText
  const common: DriveAssertion[] = [
    { label: "有中文实质回应", category: "ux", pass: turnHasSubstance([text]) && /[一-鿿]/.test(text), detail: text.slice(0, 200) },
    { label: "不泄漏内部状态", category: "ux", pass: !/(?:datasetId|stageId|workflowRunId|analysisView|\.killstata|\/Users\/|Traceback|stack trace)/i.test(ctx.assistantText), detail: ctx.assistantText.slice(0, 200) },
  ]
  const specific: Record<string, DriveAssertion> = {
    "data-inspect-only": { label: "数据检查说明真实规模", category: "ux", pass: /4,?709/.test(text) && /34/.test(text) && /变量|列/.test(text), detail: text.slice(0, 250) },
    "ols-basic": { label: "OLS 同时报估计与非因果边界", category: "ux", pass: /OLS|最小二乘/i.test(text) && /系数/.test(text) && /标准误|置信区间|p\s*值/i.test(text) && /相关|不能.*因果|无法.*因果|非因果/.test(text), detail: text.slice(0, 300) },
    "gf-panel": { label: "面板报告规格、数值和质量限制", category: "ux", pass: /固定效应/.test(text) && /地区/.test(text) && /年份/.test(text) && /绿色信贷/.test(text) && /系数/.test(text) && /异常值|极端值/.test(text) && /线性依赖|共线/.test(text), detail: text.slice(0, 300) },
    "staggered-did": { label: "DID 停点说明所需列", category: "ux", pass: /cohort|首次处理年份/i.test(text) && /relative[_ -]?time|相对时期/i.test(text) && /提供|需要|补充/.test(text) && !/动态效应(?:为|=)\s*[-+]?\d/.test(text), detail: text.slice(0, 300) },
    "psm-matching-basic": { label: "PSM 报告匹配质量及识别限制", category: "ux", pass: /ATT|处理效应/i.test(text) && /SMD|平衡/.test(text) && /共同支撑|重叠/.test(text) && /可忽略|未观测|选择偏差|识别假设|仅依赖处理前协变量/.test(text), detail: text.slice(0, 300) },
  }
  return [...common, specific[id]!]
}

/** 是否到达某 stage 且 completed */
export function stageCompleted(run: WorkflowRun | undefined, kind: string): boolean {
  return (run?.stages ?? []).some((s: StageNode) => s.kind === kind && s.status === "completed")
}

/** 工具是否被调用过（任意状态） */
export function calledTool(ctx: ScenarioAssertionContext, toolName: string): boolean {
  return ctx.toolCalls.some((t) => t.tool === toolName)
}

/** 工具被调用的次数（多轮场景"第二次估计真的发生了"用） */
export function callCount(ctx: ScenarioAssertionContext, toolName: string): number {
  return ctx.toolCalls.filter((t) => t.tool === toolName).length
}

/** 同类只读工具连续调用次数（thrashing 检测） */
export function maxConsecutive(ctx: ScenarioAssertionContext, tools: string[]): number {
  let max = 0
  let current = 0
  for (const call of ctx.toolCalls) {
    if (tools.includes(call.tool)) {
      current += 1
      max = Math.max(max, current)
    } else {
      current = 0
    }
  }
  return max
}

/**
 * 预处理链共享断言（winsorize-clean / winsorize-log 复用）：
 * data_preprocess 被调用 + preprocess_or_filter stage 完成（第八轮死锁回归）。
 */
function preprocessChainAssertions(ctx: ScenarioAssertionContext): DriveAssertion[] {
  return [
    {
      label: "data_preprocess 被调用（预处理链）",
      pass: calledTool(ctx, "data_preprocess"),
      detail: `data_preprocess=${calledTool(ctx, "data_preprocess")}`,
    },
    {
      label: "新 stage 后 profile/QA 衔接（第八轮死锁回归）",
      pass: stageCompleted(ctx.run, "preprocess_or_filter"),
      detail: JSON.stringify((ctx.run?.stages ?? []).map((s) => `${s.kind}=${s.status}`)),
    },
  ]
}

// ── 场景表 ──────────────────────────────────────────────────────
// 每行都对应至少一个历轮真实 bug 的交互模式（见 label 注释）

export const DRIVE_SCENARIOS: DriveScenario[] = [
  {
    id: "did-standard",
    label: "传统 DID（标准话术）",
    dataFile: "did.xlsx",
    // did.xlsx 的真实处理结构缺少传统 2×2 DID 所需的四个样本组合；这个场景验证
    // 系统能识别设计不可执行并把决策交还用户，而不是伪造估计或进入重试循环。
    expectEstimate: false,
    userMessage: (p) =>
      `请导入数据文件 ${p}，做传统双重差分 DID：被解释变量=创新指数，处理组变量=did，政策后变量=post（若不存在则先构造：year >= time 时 post=1）。`,
    behavior: (ctx) => [
      {
        label: "导入用的是用户给的文件路径（不 glob 工作目录找数据）",
        // 用户已给路径：模型读 .killstata 内部产物（describe/QA 报告）是正常分析流，
        // 不算越权（2026-08-10 全矩阵：did-standard 读 reports 被误判越权）。
        // 真正的越权 = 在工作目录/仓库根 glob 数据文件（pattern 含 xlsx/csv/dta/sav 扩展名，
        // 且不在 .killstata 内部）——第十三轮 bug 的回归由 vague-request/no-file 覆盖。
        pass: !ctx.toolCalls.some(
          (t) =>
            t.tool === "glob" &&
            typeof t.pattern === "string" &&
            /\.(xlsx|csv|dta|sav|parquet)\b/i.test(t.pattern) &&
            !t.pattern.includes(".killstata"),
        ),
        detail: `glob=${ctx.toolCalls.filter((t) => t.tool === "glob").map((t) => t.pattern ?? "?").join(",")}`,
      },
      {
        label: "传统 DID 设计不足时给出可操作停点，不伪造结果",
        pass: /四格|四个样本|传统.*2×2|相对时期|不满足传统/i.test(
          `${ctx.assistantText}\n${ctx.toolErrors.map((error) => error.error).join("\n")}`,
        ),
        detail: ctx.assistantText.slice(0, 300),
      },
      {
        label: "用户最终看到四格不足的具体原因，而不是通用失败提示",
        category: "ux",
        pass:
          /四格|四个样本单元|传统 2×2 DID/.test(ctx.assistantText) &&
          !/本轮操作未完成，系统已停止自动尝试/.test(ctx.assistantText),
        detail: ctx.assistantText.slice(-360),
      },
      {
        label: "没有围绕空样本无限创建预处理阶段",
        pass: (ctx.toolCalls.filter((call) => call.tool === "data_preprocess").length <= 2) &&
          (ctx.run?.stages ?? []).filter((stage) => stage.kind === "preprocess_or_filter").length <= 2,
        detail: `preprocessCalls=${ctx.toolCalls.filter((call) => call.tool === "data_preprocess").length} stages=${(ctx.run?.stages ?? []).filter((stage) => stage.kind === "preprocess_or_filter").length}`,
      },
    ],
  },
  {
    id: "did-method-change-after-guard",
    label: "传统 DID 失败后由用户确认切换两阶段 DID",
    dataFile: "did.xlsx",
    expectEstimate: false,
    userMessages: (p) => [
      `导入 ${p}，做传统双重差分 DID：被解释变量=创新指数，处理组变量=did，政策后变量=post（若不存在则按 year >= time 构造）。`,
      "上一轮如果提示传统 DID 不满足四格结构，请按我的决定改用两阶段 DID（did2s）重新评估；保留创新指数、did、地区和 year。若缺少相对时期或从未处理组编码，请明确说明并停止，不要猜列或伪造结果。",
    ],
    behavior: (ctx) => [
      {
        label: "第二轮按用户明确选择加载 did2s 或解释其前置缺口",
        pass: (() => {
          const turn2Text = ctx.turnTexts[1]?.join("\n") ?? ""
          const ranDid2s = (ctx.turnToolCalls?.[1] ?? []).some((call) => call.tool === "did2s")
          const explicitDesignStop =
            /相对时期|从未处理/.test(turn2Text) &&
            /缺少|无法|不满足|停止|确认|未生成/.test(turn2Text) &&
            !/正在执行|让我(?:再)?尝试|我(?:将|会)继续|再试一次/.test(turn2Text)
          return ranDid2s || explicitDesignStop
        })(),
        detail: `turn2 tools=${(ctx.turnToolCalls?.[1] ?? []).map((call) => call.tool).join(",")} text=${ctx.lastTurnAssistantText.slice(0, 300)}`,
      },
      {
        label: "方法变化不静默改写研究设计",
        category: "ux",
        pass: /两阶段|did2s|相对时期|从未处理|确认|停止|无法/i.test(ctx.assistantText),
        detail: ctx.assistantText.slice(-500),
      },
      {
        label: "缺少安全相对时期时不伪造估计",
        pass: !calledTool(ctx, "did2s") || /相对时期|从未处理|无法|停止|不满足/i.test(ctx.assistantText),
        detail: `did2s=${calledTool(ctx, "did2s")} errors=${ctx.toolErrors.length}`,
      },
    ],
  },
  {
    id: "did-direct",
    label: "直接跑 DID（第八轮：gate 拒绝后不死锁）",
    dataFile: "did.xlsx",
    // did.xlsx 没有传统 2×2 DID 的四格结构；该场景验证“直接要求”也会安全停在设计门禁，
    // 不把失败的 did_static 当成必须完成的估计任务。
    expectEstimate: false,
    userMessage: (p) =>
      `请直接检查 ${p} 是否满足传统 2×2 DID：被解释变量=创新指数，处理组=did，政策后=post。` +
      `如果缺少 post 或四格样本结构不完整，请明确告诉我传统 DID 不适用并停止；不要构造 post、切换方法或继续试错。`,
    behavior: (ctx) => [
      {
        label: "缺少 post 时先完成画像/质检再给出设计停点",
        pass: (ctx.run?.stages ?? []).some((s) => s.kind === "profile_or_diagnostics" || s.kind === "validate"),
        detail: JSON.stringify((ctx.run?.stages ?? []).map((s) => `${s.kind}=${s.status}`)),
      },
      {
        label: "不死锁：缺少关键设计变量时不继续创建预处理阶段",
        pass: maxConsecutive(ctx, ["pipeline"]) <= 4 && ctx.toolCalls.filter((call) => call.tool === "data_preprocess").length <= 1,
        detail: `workflow 连续调用=${maxConsecutive(ctx, ["pipeline"])} preprocess=${ctx.toolCalls.filter((call) => call.tool === "data_preprocess").length}`,
      },
    ],
  },
  {
    id: "panel-fe",
    label: "双向固定效应面板（真实面板链路）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p} 后做双向固定效应面板回归：实体=地区，时间=year，被解释变量=创新指数，` +
      `核心解释变量=高质量发展指数，控制变量=人口密度、经济发展水平、金融发展程度、城镇化水平、政府干预程度、财政投资力度。`,
    behavior: (ctx) => [
      {
        label: "主键无重复报错（panel 键唯一）",
        // 只匹配重复键错误本体（duplicate entity-time / 主键重复），不匹配工具名
        // panel_fe_regression（2026-08-10 全矩阵：/panel/ 误匹配工具名导致误报）。
        pass: !ctx.toolErrors.some((e) => /duplicate entity-time|主键重复|键冲突|duplicate_panel_keys/.test(e.error)),
        detail: JSON.stringify(ctx.toolErrors.map((e) => e.error.slice(0, 80))),
      },
    ],
  },
  {
    id: "ols-basic",
    label: "OLS 基准回归",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) => `导入 ${p}，做 OLS 基准回归：被解释变量=创新指数，核心解释变量=高质量发展指数。`,
    behavior: (ctx) => [],
  },
  {
    id: "vague-request",
    label: "模糊请求（第十三轮：先追问而非搜目录）",
    dataFile: null,
    expectEstimate: false,
    userMessage: () => "我想做个回归分析。",
    behavior: (ctx) => [
      {
        label: "先追问而非 glob/read/ls 搜目录（question 工具或纯文本追问均可）",
        // 第十三轮要的是"追问而不是搜目录"，不是"必须用 question 工具"。
        // 模型用纯文本追问（更自然）也算通过；只有 glob/read/ls 越权才是失败
        //（2026-08-10 全矩阵：模型纯文本追问，questionCount=0 但行为正确）。
        pass:
          (ctx.questionCount >= 1 || /数据|文件|变量|结果变量|因变量|处理组|政策/.test(ctx.assistantText)) &&
          !calledTool(ctx, "glob") &&
          !calledTool(ctx, "read") &&
          !calledTool(ctx, "ls"),
        detail: `question=${ctx.questionCount} glob=${calledTool(ctx, "glob")} read=${calledTool(ctx, "read")} ls=${calledTool(ctx, "ls")} textLen=${ctx.assistantText.length}`,
      },
    ],
  },
  {
    id: "no-file",
    label: "只说话不给文件（第十三轮：不拿 fixture 当默认数据）",
    dataFile: null,
    expectEstimate: false,
    userMessage: () => "帮我做个 DID。",
    behavior: (ctx) => [
      {
        label: "先追问数据文件而非 glob/read 搜 fixture（question 工具或纯文本追问均可）",
        pass:
          (ctx.questionCount >= 1 || /数据|文件|处理组|政策|post/.test(ctx.assistantText)) &&
          !calledTool(ctx, "glob") &&
          !calledTool(ctx, "read"),
        detail: `question=${ctx.questionCount} glob=${calledTool(ctx, "glob")} read=${calledTool(ctx, "read")} textLen=${ctx.assistantText.length}`,
      },
    ],
  },
  {
    id: "did-raw-sheet",
    label: "DID 指定原始编码工作表",
    dataFile: "did.xlsx",
    expectEstimate: false,
    userMessage: (p) => `导入 ${p} 的 Data_原始编码 工作表，只检查数据结构和真实列名，不做回归。`,
    behavior: (ctx) => {
      const importCall = ctx.toolCalls.find(
        (call) => call.tool === "data_import" && call.status === "completed" && (call.args ?? "").includes('"action":"import"'),
      )
      return [
        {
          label: "使用 named_sheet 精确选择 Data_原始编码",
          pass:
            Boolean(importCall) &&
            (importCall?.args ?? "").includes("named_sheet") &&
            (importCall?.args ?? "").includes("Data_原始编码"),
          detail: importCall?.args ?? "missing import",
        },
        {
          label: "指定 Sheet 后完成画像且不运行估计",
          pass: stageCompleted(ctx.run, "import") && stageCompleted(ctx.run, "profile_or_diagnostics") && !calledEstimator(ctx.toolCalls),
          detail: JSON.stringify((ctx.run?.stages ?? []).map((stage) => `${stage.kind}=${stage.status}`)),
        },
        {
          label: "向用户确认实际工作表（UX）",
          category: "ux",
          pass: /Data_原始编码/.test(ctx.assistantText),
          detail: ctx.assistantText.slice(0, 300),
        },
      ]
    },
  },
  {
    id: "gf-nonempty-sheet",
    label: "绿色金融工作簿空 Sheet 不干扰导入",
    dataFile: "gf.xlsx",
    expectEstimate: false,
    userMessage: (p) => `导入 ${p}，使用有数据的 Sheet1，空工作表忽略；只做画像并告诉我实际行列数。`,
    behavior: (ctx) => [
      {
        label: "Sheet1 导入与画像完成",
        pass:
          ctx.toolCalls.some((call) => call.tool === "data_import" && call.status === "completed" && (call.args ?? "").includes('"action":"import"')) &&
          stageCompleted(ctx.run, "profile_or_diagnostics"),
        detail: JSON.stringify((ctx.run?.stages ?? []).map((stage) => `${stage.kind}=${stage.status}`)),
      },
      {
        label: "空 Sheet 不触发无意义提问或估计",
        pass: ctx.questionCount === 0 && !calledEstimator(ctx.toolCalls),
        detail: `question=${ctx.questionCount} tools=${ctx.toolCalls.map((call) => call.tool).join(",")}`,
      },
      {
        label: "报告实际 Sheet 与 9545×11（UX）",
        category: "ux",
        pass: /Sheet1/.test(ctx.assistantText) && /9,?545|9545/.test(ctx.assistantText) && /11\s*列|×\s*11/.test(ctx.assistantText),
        detail: ctx.assistantText.slice(0, 300),
      },
    ],
  },
  {
    id: "did-csv-bom",
    label: "DID CSV BOM 与 Excel 结构一致性",
    dataFile: "did_stage000.csv",
    expectEstimate: false,
    userMessage: (p) => `导入 ${p}，检查 CSV 的 year 列名没有 BOM 污染，并确认结构为4709行×34列；只做画像。`,
    behavior: (ctx) => [
      {
        label: "CSV 导入与画像完成",
        pass: stageCompleted(ctx.run, "import") && stageCompleted(ctx.run, "profile_or_diagnostics"),
        detail: JSON.stringify((ctx.run?.stages ?? []).map((stage) => `${stage.kind}=${stage.status}`)),
      },
      {
        label: "year 列没有 BOM/列不存在错误",
        pass:
          !ctx.toolErrors.some((error) => /bom|\ufeff|column not found|列不存在|找不到.*year/i.test(error.error)) &&
          !ctx.assistantText.includes("\ufeffyear"),
        detail: JSON.stringify(ctx.toolErrors),
      },
      {
        label: "报告 4709×34 与 year（UX）",
        category: "ux",
        pass: /4,?709|4709/.test(ctx.assistantText) && /34\s*列|×\s*34/.test(ctx.assistantText) && /year/.test(ctx.assistantText),
        detail: ctx.assistantText.slice(0, 300),
      },
    ],
  },
  {
    id: "gf-panel",
    label: "绿色金融面板（第二份真实数据）",
    dataFile: "gf.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，做双向固定效应面板回归：实体=地区，时间=年份，被解释变量=绿色金融指数，核心解释变量=绿色信贷。`,
    behavior: (ctx) => [
      {
        label: "未把 did.xlsx 结构硬编码到 gf.xlsx（列名来自真实 schema）",
        // 只匹配"列不存在"错误本体（Variables not found / 数据中找不到变量），
        // 不匹配 File not found / ENOENT（读产物波折，2026-08-10 全矩阵误报）。
        pass: !ctx.toolErrors.some((e) => /Variables not found|数据中找不到变量|变量不存在/.test(e.error)),
        detail: JSON.stringify(ctx.toolErrors.map((e) => e.error.slice(0, 100))),
      },
    ],
  },
  {
    id: "gf-missing-year-recover",
    label: "gf.xlsx时间列误写为year后的纠正",
    dataFile: "gf.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，做双向固定效应面板回归：实体=地区，时间=year，被解释变量=绿色金融指数，核心解释变量=绿色信贷。`,
    behavior: (ctx) => [
      {
        label: "时间列不存在时先询问是否使用真实列名年份",
        category: "ux",
        pass: ctx.questionEvents.some((q) => {
          const text = `${q.prompt} ${q.options.join(" ")}`
          return text.includes("year") && text.includes("年份")
        }),
        detail: `questions=${JSON.stringify(ctx.questionEvents)}`,
      },
      {
        label: "确认后估计器使用年份而不是不存在的year",
        pass: ctx.toolCalls.some(
          (call) =>
            call.tool === "panel_fe_regression" &&
            (call.args ?? "").includes(`"timeVar":"年份"`) &&
            !(call.args ?? "").includes(`"timeVar":"year"`),
        ),
        detail: ctx.toolCalls
          .filter((call) => call.tool === "panel_fe_regression")
          .map((call) => call.args ?? "")
          .join(" | "),
      },
      {
        label: "最终说明使用真实面板时间列",
        category: "ux",
        pass: /时间[^\n]{0,20}年份|年份[^\n]{0,20}时间/.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.slice(0, 300),
      },
      {
        label: "下一步建议遵守当前线性依赖诊断且不暴露内部结构分类",
        category: "ux",
        pass:
          !ctx.finalAssistantText.includes("repeated_cross_section") &&
          (!/加入控制变量[^。\n]{0,80}(绿色投资|绿色保险|绿色债券|绿色支持)/.test(ctx.finalAssistantText) ||
            /完全线性依赖|完全共线|共线性/.test(ctx.finalAssistantText)),
        detail: ctx.finalAssistantText.match(/下一步[^\n]*[\s\S]{0,500}/)?.[0] ?? ctx.finalAssistantText.slice(0, 300),
      },
    ],
  },
  {
    id: "digi-inclusion",
    label: "数字普惠金融 OLS（第三份真实数据）",
    dataFile: "test_datasets.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，做 OLS 基准回归：被解释变量=数字普惠金融指数，核心解释变量=每百人互联网用户数。`,
    behavior: (ctx) => [
      {
        label: "真实执行 OLS 且未误跑面板固定效应",
        pass:
          ctx.toolCalls.some((call) => call.tool === "ols_regression" && call.status === "completed") &&
          !ctx.toolCalls.some((call) => call.tool === "panel_fe_regression" && call.status === "completed"),
        detail: ctx.toolCalls.map((call) => `${call.tool}:${call.status}`).join(","),
      },
      {
        label: "最终报告包含数字普惠金融变量和数值结果",
        category: "ux",
        pass:
          /数字普惠金融指数|每百人互联网用户数/.test(ctx.finalAssistantText) &&
          /系数|样本|R²|p\s*值/.test(ctx.finalAssistantText) &&
          /\d/.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.slice(0, 500),
      },
    ],
  },
  {
    id: "gf-missing-year-reject",
    label: "gf.xlsx时间列误写且用户拒绝替换",
    dataFile: "gf.xlsx",
    expectEstimate: false,
    userMessage: (p) =>
      `导入 ${p}，做双向固定效应面板回归：实体=地区，时间=year，被解释变量=绿色金融指数，核心解释变量=绿色信贷。`,
    behavior: (ctx) => [
      {
        label: "变量冲突确实进入用户确认",
        category: "ux",
        pass: ctx.questionEvents.some((q) => {
          const text = `${q.prompt} ${q.options.join(" ")}`
          return /year|年份|地区|省份/.test(text) && q.options.some((option) => /停止|换|其他/.test(option))
        }),
        detail: `questions=${JSON.stringify(ctx.questionEvents)}`,
      },
      {
        label: "用户拒绝后不执行 Panel FE",
        pass: !ctx.toolCalls.some(
          (call) => call.tool === "panel_fe_regression" && call.status === "completed" && call.requiresUserDecision !== true,
        ),
        detail: ctx.toolCalls.map((call) => `${call.tool}:${call.status}`).join(","),
      },
      {
        label: "拒绝结果向用户说明已暂停而非虚报完成",
        category: "ux",
        pass:
          ctx.toolCalls.some((call) => call.tool === "panel_fe_regression" && call.requiresUserDecision === true) &&
          ctx.questionEvents.some((q) => q.options.some((option) => /停止|其他变量|换/.test(option))),
        detail: `decisionTool=${ctx.toolCalls.find((call) => call.tool === "panel_fe_regression")?.requiresUserDecision ?? false} questions=${JSON.stringify(ctx.questionEvents)}`,
      },
    ],
  },
  {
    id: "digital-panel-composite-key",
    label: "数字普惠金融面板（同名地区复合实体键修复）",
    dataFile: "test_datasets.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，做双向固定效应面板回归：实体=地区，时间=年份，被解释变量=数字普惠金融指数，` +
      "核心解释变量=每百人互联网用户数。如果跨省同名地区导致主键冲突，不要删除行；请先说明原因，" +
      "再用省份和地区构造复合实体键，重新质检后估计。",
    behavior: (ctx) => {
      const preprocess = ctx.toolCalls.find(
        (call) =>
          call.tool === "data_preprocess" &&
          (call.args ?? "").includes("combine_columns") &&
          (call.args ?? "").includes("省份") &&
          (call.args ?? "").includes("地区"),
      )
      let outputColumn: string | undefined
      try {
        const parsed = JSON.parse(preprocess?.args ?? "{}") as {
          options?: { output_column?: string }
        }
        outputColumn = parsed.options?.output_column
      } catch {}
      const estimateUsesComposite = Boolean(
        outputColumn &&
        ctx.toolCalls.some(
          (call) =>
            (call.tool === "panel_fe_regression" || call.tool === "hdfe_regression") &&
            (call.args ?? "").includes(outputColumn!) &&
            (call.args ?? "").includes("年份"),
        ),
      )
      return [
        {
          label: "用 combine_columns 构造省份+地区复合实体键",
          pass: Boolean(preprocess && outputColumn),
          detail: preprocess?.args ?? "未调用 combine_columns",
        },
        {
          label: "估计器真正使用新复合实体键",
          pass: estimateUsesComposite,
          detail: `outputColumn=${outputColumn ?? "missing"} panelCalls=${ctx.toolCalls
            .filter((call) => call.tool === "panel_fe_regression")
            .map((call) => call.args ?? "")
            .join(" | ")}`,
        },
        {
          label: "预处理、重新 QA 与基准估计均完成",
          pass:
            stageCompleted(ctx.run, "preprocess_or_filter") &&
            stageCompleted(ctx.run, "validate") &&
            stageCompleted(ctx.run, "baseline_estimate"),
          detail: JSON.stringify((ctx.run?.stages ?? []).map((stage) => `${stage.kind}=${stage.status}`)),
        },
        {
          label: "向用户解释同名地区且明确不删行（UX）",
          category: "ux",
          pass:
            /同名|复合实体|复合.*键/.test(ctx.assistantText) &&
            // 「未删除行」与「不删除行」语义相同，此前只认后者，真实回放里模型写
            // 「未删除行，而是用省份和地区构造复合实体键」被判失败（2026-08-29 假阴性）。
            // 仍不接受「已删除/删除了/去重」等真的删了行的措辞。
            /不删|未删除|保留.*观测|不会删除/.test(ctx.assistantText),
          detail: ctx.assistantText.slice(0, 500),
        },
        {
          label: "修复过程中有可理解的进度提示（UX）",
          category: "ux",
          // 该场景的真实流程只有一条中间阶段消息 + 一条最终报告；中间消息已经
          // 明确说明“复合键完成、接下来重新质检”，两条即可证明不是黑箱运行。
          pass:
            hasProgressNotes(ctx.assistantTexts, ctx.toolProgress) ||
            (ctx.assistantTexts.length === 2 && /完成|接下来|重新质检|新阶段/.test(ctx.assistantTexts[0] ?? "")),
          detail: `assistantTexts=${ctx.assistantTexts.length}`,
        },
        {
          label: "QA 修复没有退化为 workflow 查询死循环",
          pass: maxConsecutive(ctx, ["pipeline"]) <= 4,
          detail: `workflow 连续调用=${maxConsecutive(ctx, ["pipeline"])}`,
        },
      ]
    },
  },
  {
    id: "winsorize-clean",
    label: "缩尾后回归（第八轮：data_preprocess 新 stage 衔接）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，先对人口密度做 1% 缩尾，然后做双向固定效应面板回归：实体=地区，时间=year，` +
      `被解释变量=创新指数，核心解释变量=高质量发展指数。`,
    behavior: (ctx) => preprocessChainAssertions(ctx),
  },
  {
    id: "time-missing",
    label: "time 列缺失不阻断（第十轮：QA 缺失走 notes）",
    dataFile: "did.xlsx",
    // 缺失的 time 只应作为说明性 notes，不应被误判为 QA 阻断；但该数据仍不满足
    // 传统 2×2 DID 的四格结构，因此本场景不要求伪造或强行完成传统估计。
    expectEstimate: false,
    userMessage: (p) =>
      `导入 ${p}，做传统 DID：被解释变量=创新指数，处理组=did，政策后=post（若不存在则先构造）。time 列缺失不用管。`,
    behavior: (ctx) => [
      {
        label: "QA 缺失信息未阻断估计（走 notes 而非 blocking）",
        // 只匹配"缺失列"被误判为阻断的错误本体；"blocking" 还出现在 QA gate 的
        // 合法阻断文案里（duplicate rows），不该因此误报（2026-08-10 全矩阵）。
        pass: !ctx.toolErrors.some((e) => /missing|缺失/.test(e.error) && /blocking|阻断/.test(e.error)),
        detail: JSON.stringify(ctx.toolErrors.map((e) => e.error.slice(0, 100))),
      },
    ],
  },
  // ── 第二轮：UX 交互体验场景（2026-08-10）──

  {
    id: "method-switch",
    label: "方法切换（先 OLS 再面板）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，先跑个 OLS：创新指数 ~ 高质量发展指数，然后换成双向固定效应面板再跑一次：实体=地区，时间=year。`,
    behavior: (ctx) => [
      {
        label: "两种方法都被调用了（OLS + 面板）",
        pass: calledTool(ctx, "ols_regression") && calledTool(ctx, "panel_fe_regression"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "最终报告分别给出两个模型的完整核心信息",
        category: "ux",
        pass: (() => {
          const text = ctx.finalAssistantText
          // 净化器可能先前置一条可信数值补充，再保留模型的完整正文；取最后一个
          // 方法段，避免只截到“面板固定效应补充：标准误……”这类短句而误判正文缺失。
          const panelSection = Array.from(
            text.matchAll(/(?:面板固定效应回归|双向固定效应面板)[：:]?[\s\S]{0,900}/gi),
          ).at(-1)?.[0] ?? ""
          const olsSection = Array.from(
            text.matchAll(/(?:OLS回归结果|合并OLS|OLS基准回归|OLS[^\n]{0,20}回归)[：:]?[\s\S]{0,900}/gi),
          ).at(-1)?.[0] ?? ""
          return (
            olsSection.length > 0 &&
            /(?:系数|估计).{0,80}(?:p\s*值|p\s*[=<])/.test(olsSection) &&
            /(?:有效样本|样本|N\s*=|R²)/.test(olsSection) &&
            panelSection.length > 0 &&
            /系数/.test(panelSection) &&
            /(?:p\s*值|p\s*[=<])/.test(panelSection) &&
            /(?:标准误|稳健标准误)/.test(panelSection) &&
            /(?:有效样本|样本|N\s*=|R²)/.test(panelSection)
          )
        })(),
        detail: ctx.finalAssistantText.match(/(?:面板固定效应|双向固定效应)[\s\S]{0,700}/i)?.[0] ?? ctx.finalAssistantText.slice(0, 300),
      },
      {
        label: "时期数量只报告有证据的事实，不使用猜测性日期范围",
        category: "ux",
        pass: !hasUnsupportedTimeClaim(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.match(/(?:结构|数据概况)[\s\S]{0,260}/i)?.[0] ?? ctx.finalAssistantText.slice(0, 300),
      },
      {
        label: "最终回答不以空的Markdown标题结束",
        category: "ux",
        pass: !/\n#{1,6}\s+[^\n]+\s*$/.test(ctx.finalAssistantText.trim()),
        detail: ctx.finalAssistantText.slice(-260),
      },
    ],
  },
  {
    id: "variable-change",
    label: "更换核心解释变量重跑",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，跑 OLS：创新指数 ~ 高质量发展指数；然后换成 人均GDP 作为核心解释变量再跑一次。`,
    behavior: (ctx) => [
      {
        label: "第二次估计用了人均GDP（工具参数里出现）",
        // 收集两次估计的输入，验证后一次含 人均GDP
        pass:
          callCount(ctx, "ols_regression") >= 2 &&
          ctx.toolCalls.some((t) => t.tool === "ols_regression" && (t.args ?? "").includes("人均GDP")),
        detail: `estimate 次数=${callCount(ctx, "ols_regression")}`,
      },
    ],
  },
  {
    id: "data-inspect-only",
    label: "只看数据不分析（不越权）",
    dataFile: "did.xlsx",
    expectEstimate: false,
    userMessage: (p) => `帮我看下 ${p} 这个数据：有哪些变量、多少行、有没有缺失，不用做回归分析。`,
    behavior: (ctx) => [
      {
        label: "没有调用任何估计器（不越权）",
        pass: !calledEstimator(ctx.toolCalls),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "至少做了导入/画像/质检（describe/qa）",
        pass: ctx.toolCalls.some((t) => t.tool === "data_import"),
        detail: `data_import=${ctx.toolCalls.some((t) => t.tool === "data_import")}`,
      },
      {
        label: "用户询问变量时最终回答列出真实变量名",
        category: "ux",
        pass: /变量/.test(ctx.finalAssistantText) && /(?:year|创新指数|高质量发展指数)/.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.slice(0, 500),
      },
      {
        label: "用户询问行数时最终回答真实规模",
        category: "ux",
        pass: /4709/.test(ctx.finalAssistantText) && /34/.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.slice(0, 500),
      },
    ],
  },
  {
    id: "explain-result",
    label: "跑完请解读系数（报告质量）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，跑 OLS：创新指数 ~ 高质量发展指数，跑完请告诉我这个系数怎么解读、意味着什么。`,
    behavior: (ctx) => {
      const quality = reportQuality(ctx.finalAssistantText)
      return [
        {
          label: "最终报告含方法名 + 数字 + 中文（UX 报告质量）",
          category: "ux",
          pass: quality.pass,
          detail: JSON.stringify(quality),
        },
        {
          label: "中途有进度汇报（UX 进度提示）",
          category: "ux",
          pass: hasProgressNotes(ctx.assistantTexts, ctx.toolProgress),
          detail: `texts=${ctx.assistantTexts.length} toolProgress=${ctx.toolProgress?.length ?? 0}`,
        },
      ]
    },
  },
  {
    id: "winsorize-log",
    label: "缩尾 + 取对数 + 面板（多步预处理链）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，先对 人口密度 做 1% 缩尾，再取对数，然后跑双向固定效应面板：实体=地区，时间=year，被解释变量=创新指数，核心解释变量=高质量发展指数。`,
    behavior: (ctx) => preprocessChainAssertions(ctx),
  },
  {
    id: "correlation-before",
    label: "先看相关性再估计（流程合理）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，先看下 创新指数 和 高质量发展指数 的相关性，然后做 OLS 回归：创新指数 ~ 高质量发展指数。`,
    behavior: (ctx) => [
      {
        label: "先看了相关性（data_import 描述/质检）且最终估计完成",
        // 用户要求"先看相关性再跑 OLS"。顺序断言不稳定：模型可能开场先试估计被
        // gate 拦（"必须先画像"）再补 import/QA（2026-08-11 实测：两次 run 一次先
        // correlation、一次先试 ols 被拦）——这是 gate 兜底的正常修复路径。
        // 断言放宽为：① 数据操作确实发生过（data_import 存在）；② 估计最终完成
        //（硬 pass 已覆盖 estimate completed，这里只要求数据操作在前半段存在）。
        pass: ctx.toolCalls.some((t) => t.tool === "data_import" && t.status === "completed"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
    ],
  },
  {
    id: "staggered-did",
    label: "交错 DID 事件研究（缺少安全相对时期构造器）",
    dataFile: "did.xlsx",
    // 当前 data_preprocess 只能做条件比较，不能安全生成 year-time 的数值差作为 relative_time；
    // 真实场景应快速说明能力缺口并交还用户，不允许用 Bash 或 create_column 猜造事件时间。
    expectEstimate: false,
    userMessage: (p) =>
      `导入 ${p}，做个交错 DID：不同地区政策实施年份不同（time 列），用事件研究估计动态效应，被解释变量=创新指数。` +
      `请先检查是否能安全构造 cohort=0/首次处理年份和 relative_time=year-time；如果当前工具不能构造，请直接说明需要我提供这两列并停止，不要用 Bash 或猜阈值反复试错。`,
    behavior: (ctx) => [
      {
        label: "缺少安全相对时期构造器时给出可操作停点，不伪造事件时间",
        pass: /相对时期|relative[_ -]?time|cohort|构造|不能|无法|需要.*列|提供.*列/i.test(ctx.assistantText),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "没有围绕不可逆的事件时间计算无限试错",
        pass: ctx.toolCalls.filter((call) => call.tool === "data_preprocess").length <= 2,
        detail: `data_preprocess=${ctx.toolCalls.filter((call) => call.tool === "data_preprocess").length}`,
      },
    ],
  },
  // ── 第三轮：真实用户旅程（多轮对话 + 语言多样性，2026-08-11）──
  // 此前场景都是一条消息跑完整个流程；真实用户是**多轮对话**——跑完追问、半路
  // 改需求、换数据集、说错变量名。这些场景测"对话延续性"：intent 分类、stage
  // 衔接、结果复用，以及用户说错话时模型是否诚实澄清（不编造）。

  {
    id: "mid-course-correction",
    label: "半路改需求（加控制变量重跑）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessages: (p) => [
      `导入 ${p}，跑 OLS：创新指数 ~ 高质量发展指数`,
      "再加个控制变量 人口密度，重新跑一次",
    ],
    behavior: (ctx) => [
      {
        label: "两次估计都被调用（OLS 重跑）",
        pass: callCount(ctx, "ols_regression") >= 2,
        detail: `ols 次数=${callCount(ctx, "ols_regression")}`,
      },
      {
        label: "后一次估计真的带了人口密度（参数里出现，不是口头答应）",
        pass: ctx.toolCalls.some((t) => t.tool === "ols_regression" && (t.args ?? "").includes("人口密度")),
        detail: ctx.toolCalls
          .filter((t) => t.tool === "ols_regression")
          .map((t) => (t.args ?? "").slice(0, 200))
          .join(" | "),
      },
      {
        label: "turn2 追问得到实质回应（UX）",
        category: "ux",
        pass: turnHasSubstance(ctx.turnTexts[1] ?? []),
        detail: `turn2 texts=${ctx.turnTexts[1]?.length ?? 0}`,
      },
      {
        label: "已核验面板数据不被描述成横截面或不确定的合并面板结构",
        category: "ux",
        pass: !/横截面\s*\/\s*合并面板(?:基准)?(?:均值)?模型/.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.match(/横截面\s*\/\s*合并面板[^。\n]*/)?.[0] ?? "未发现含糊结构表述",
      },
    ],
  },
  {
    id: "explain-followup",
    label: "跑完追问显著性（对话式解读）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessages: (p) => [
      `导入 ${p}，跑 OLS：创新指数 ~ 高质量发展指数，跑完告诉我系数`,
      "这个系数显著吗？p 值多少？",
    ],
    behavior: (ctx) => [
      {
        label: "追问得到实质回答且提到显著/p 值（UX：对话式解读）",
        category: "ux",
        pass:
          turnHasSubstance(ctx.turnTexts[1] ?? []) && /显著|p\s*值|pvalue|p-value|p 值/.test(ctx.lastTurnAssistantText),
        detail: ctx.lastTurnAssistantText.slice(0, 300),
      },
      {
        label: "最终回答含具体数字（系数/p 值，不是空谈）",
        pass: /\d/.test(ctx.finalAssistantText),
        detail: `finalLen=${ctx.finalAssistantText.length}`,
      },
    ],
  },
  {
    id: "export-results",
    label: "导出结果 CSV（探索：导出体验）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessages: (p) => [
      `导入 ${p}，跑 OLS：创新指数 ~ 高质量发展指数`,
      "把回归结果导出成 CSV 文件，放到当前目录",
    ],
    behavior: (ctx) => [
      {
        label: "turn2 有实质回应（UX：给出导出结果或说明做不到）",
        category: "ux",
        pass: turnHasSubstance(ctx.turnTexts[1] ?? []),
        detail: ctx.lastTurnAssistantText.slice(0, 400),
      },
      {
        // 本场景只要求回归系数表；stage 的 export 导出观测数据，改文件名也不改变内容。
        label: "未将原始观测数据当作回归结果导出",
        pass: !(ctx.turnToolCalls?.[1] ?? []).some((call) => {
          if (call.tool !== "data_import" || call.status !== "completed") return false
          try {
            return JSON.parse(call.args ?? "{}").action === "export"
          } catch {
            return false
          }
        }),
        detail: JSON.stringify(ctx.turnToolCalls?.[1] ?? []),
      },
      {
        // 探索性断言：模型若声称"已导出/已保存"，必须真有导出动作（data_import
        // export、pipeline export_artifact 或写文件）；否则视为编造。说"做不到"
        // 是诚实的，算通过。pipeline export_artifact 只允许复制可信结果产物。
        label: "没有编造导出成功（声称导出须有实际动作）",
        // De Morgan：未声称导出 或 确实有导出动作。
        pass:
          !/已导出|导出完成|已保存到|已写入/.test(ctx.lastTurnAssistantText) ||
          ctx.toolCalls.some((t) =>
            /write|save|export/.test(t.tool) ||
            (t.args ?? "").includes("export") ||
            (t.tool === "pipeline" && (() => {
              try {
                return JSON.parse(t.args ?? "{}").action === "export_artifact"
              } catch {
                return false
              }
            })()),
          ),
        detail: `lastTurn=${ctx.lastTurnAssistantText.slice(0, 200)} tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
    ],
  },
  {
    id: "data-quality-report",
    label: "数据质量体检（QA 结论转述）",
    dataFile: "did.xlsx",
    expectEstimate: false,
    userMessage: (p) => `帮我看下 ${p} 这份数据的质量：有没有重复、缺失、异常值？给我个结论。`,
    behavior: (ctx) => {
      const quality = reportQuality(ctx.finalAssistantText)
      return [
        {
          label: "报告提到缺失/重复/异常且有数字（UX：QA 结论转述成人话）",
          category: "ux",
          pass: /缺失|重复|异常/.test(ctx.finalAssistantText) && /\d/.test(ctx.finalAssistantText),
          detail: ctx.finalAssistantText.slice(0, 300),
        },
        {
          label: "没越权调估计器（只做数据体检）",
          pass: !calledEstimator(ctx.toolCalls),
          detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
        },
        {
          label: "质量体检不自动进入预处理或创建新数据阶段",
          pass: !ctx.toolCalls.some((t) => t.tool === "data_preprocess"),
          detail: `data_preprocess=${calledTool(ctx, "data_preprocess")}`,
        },
        {
          label: "QA只报告统计事实，不臆测缺失或异常值来源",
          category: "ux",
          pass: !/(?:很可能|大概率|可能是|有意设计|天然偏高|反映[^。\n]*(?:真实|规模|城市间))/i.test(ctx.finalAssistantText),
          detail: ctx.finalAssistantText.match(/(?:time|异常值|极端值)[^\n]{0,180}/i)?.[0] ?? ctx.finalAssistantText.slice(0, 300),
        },
        {
          label: "最终报告是中文（UX 报告质量）",
          category: "ux",
          pass: quality.isChinese,
          detail: JSON.stringify(quality),
        },
      ]
    },
  },
  {
    id: "nonexistent-variable",
    label: "变量名说错（诚实性：澄清不编造）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    // did.xlsx 实际变量名是"城镇化水平"，没有"城镇化率"——用户记错了。
    // 模型必须先通过 question 澄清（例如“是不是城镇化水平”）；即使查 schema
    // 后发现只有一个相近列，也不能把变量语义替换后直接估计。
    userMessage: (p) => `导入 ${p}，跑 OLS：被解释变量=创新指数，核心解释变量=城镇化率`,
    behavior: (ctx) => [
      {
        label: "模型先询问是否把城镇化率替换为城镇化水平",
        category: "ux",
        pass: ctx.questionEvents.some((q) => [q.prompt, ...q.options].join(" ").includes("城镇化水平")),
        detail: `question=${JSON.stringify(ctx.questionEvents)} text=${ctx.assistantText.slice(0, 300)}`,
      },
      {
        label: "最终报告不把当前日期或已有面板结构臆称为混合截面",
        category: "ux",
        pass:
          !ctx.finalAssistantText.includes("2026年") &&
          !ctx.finalAssistantText.includes("混合截面") &&
          (!/面板键|面板结构/.test(ctx.finalAssistantText) || /合并面板\s*OLS|未吸收(?:个体或时间|个体|地区|时间)固定效应|未利用该结构/.test(ctx.finalAssistantText)),
        detail: ctx.finalAssistantText.match(/数据质量提示[\s\S]{0,800}/)?.[0] ?? ctx.finalAssistantText.slice(0, 300),
      },
      {
        label: "未纳入的变量只说明未参与估计，不声称没有遗漏变量影响",
        category: "ux",
        pass:
          !/(?:未包含这些列|未纳入模型的变量)[^。\n]{0,30}(?:故|因此|所以)\s*不影响/.test(ctx.assistantText) &&
          /遗漏变量影响|遗漏变量偏误|遗漏变量[^。\n]{0,80}(?:未评估|未被本模型评估)|识别偏误未被本模型评估|不能据此判断不影响/.test(ctx.assistantText),
        detail: ctx.assistantText.match(/遗漏变量影响[\s\S]{0,180}/)?.[0] ?? ctx.assistantText.slice(0, 300),
      },
    ],
  },
  {
    id: "subsample-split",
    label: "分组子样本（中位数分高低组对比）",
    dataFile: "did.xlsx",
    // 当前准入预处理没有安全的“按中位数生成高低组”算子；验证系统应说明缺口，
    // 不允许模型读取中位数后猜阈值或把 null 传给 create_column。
    expectEstimate: false,
    userMessage: (p) =>
      `导入 ${p}，我想先跑 OLS：创新指数 ~ 高质量发展指数，然后按 高质量发展指数 的中位数分成高低两组，各跑一次对比。` +
      `请先判断当前工具是否支持安全的中位数分组；如果不支持，请直接说明需要我提供高低组分类列并停止，不要猜阈值、传 null 或反复尝试 create_column。`,
    behavior: (ctx) => [
      {
        label: "中位数分组能力缺失时不伪造子样本估计",
        pass:
          /中位数|分组|分类列|不支持|无法|不能|需要.*列/i.test(ctx.assistantText) &&
          ctx.toolCalls.filter((t) => isWorkflowEstimateTool(t.tool)).length <= 1,
        detail: `估计器调用=${ctx.toolCalls.filter((t) => isWorkflowEstimateTool(t.tool)).length}`,
      },
    ],
  },
  {
    id: "status-check",
    label: "追问进度（intent 分类稳定）",
    dataFile: "did.xlsx",
    // 首轮故意使用缺失严重的 time 构造 post，传统 DID 可能被正确判定为不可识别；
    // 第二轮只测状态查询是否只读、能否解释阻塞原因，不要求状态查询凭空完成估计。
    expectEstimate: false,
    userMessages: (p) => [
      `导入 ${p}，跑传统 DID：被解释变量=创新指数，处理组=did，政策后=post（不存在则先构造）`,
      "跑完了吗？现在到哪一步了？",
    ],
    behavior: (ctx) => [
      {
        label: "turn2 有实质回应（UX：不哑火、不重启）",
        category: "ux",
        pass: turnHasSubstance(ctx.turnTexts[1] ?? []),
        detail: ctx.lastTurnAssistantText.slice(0, 300),
      },
      {
        label: "不死锁：workflow 连续调用 ≤ 4",
        pass: maxConsecutive(ctx, ["pipeline"]) <= 4,
        detail: `workflow 连续调用=${maxConsecutive(ctx, ["pipeline"])}`,
      },
      {
        label: "turn2 纯状态查询不重新估计或处理数据（UX）",
        category: "ux",
        pass: !(ctx.turnToolCalls?.[1] ?? []).some(
          (call) => isWorkflowEstimateTool(call.tool) || ["data_import", "data_preprocess", "econometrics_recommend"].includes(call.tool),
        ),
        detail: `turn2 tools=${(ctx.turnToolCalls?.[1] ?? []).map((call) => call.tool).join(",")}`,
      },
    ],
  },
  {
    id: "two-datasets",
    label: "换数据集做第二段分析（did → gf）",
    dataFile: "did.xlsx",
    extraDataFiles: ["gf.xlsx"],
    expectEstimate: true,
    userMessages: (p, extra) => [
      `导入 ${p}，跑 OLS：创新指数 ~ 高质量发展指数`,
      `换一份数据：${extra?.[0]}，跑 OLS：绿色金融指数 ~ 绿色信贷`,
    ],
    behavior: (ctx) => [
      {
        label: "两个数据集都被导入（data_import ≥ 2）",
        pass: callCount(ctx, "data_import") >= 2,
        detail: `data_import=${callCount(ctx, "data_import")}`,
      },
      {
        label: "第二次估计用了 gf 的变量（绿色信贷出现在估计参数）",
        pass: ctx.toolCalls.some((t) => isWorkflowEstimateTool(t.tool) && (t.args ?? "").includes("绿色信贷")),
        detail: ctx.toolCalls
          .filter((t) => isWorkflowEstimateTool(t.tool))
          .map((t) => (t.args ?? "").slice(0, 150))
          .join(" | "),
      },
    ],
  },
  {
    id: "two-datasets-return",
    label: "两份数据间往返分析（did → gf → did）",
    dataFile: "did.xlsx",
    extraDataFiles: ["gf.xlsx"],
    expectEstimate: true,
    userMessages: (p, extra) => [
      `导入 ${p}，跑 OLS：创新指数 ~ 高质量发展指数`,
      `换一份数据：${extra?.[0]}，跑 OLS：绿色金融指数 ~ 绿色信贷`,
      "回到第一份 did 数据，不要重新导入；继续跑 OLS：创新指数 ~ 高质量发展指数。",
    ],
    behavior: (ctx) => {
      const importCalls = ctx.toolCalls.filter(
        (call) => call.tool === "data_import" && /"action"\s*:\s*"import"/.test(call.args ?? ""),
      )
      const estimators = ctx.toolCalls.filter((call) => isWorkflowEstimateTool(call.tool))
      const estimatorArgs = estimators.map((call) => call.args ?? "")
      return [
        {
          label: "两份源数据各导入一次，回切 did 不重复导入",
          pass: importCalls.length === 2,
          detail: `import=${importCalls.map((call) => call.args ?? "?").join(" | ")}`,
        },
        {
          label: "did → gf → did 三段估计均使用各自真实变量",
          pass:
            estimatorArgs.filter((args) => args.includes("高质量发展指数")).length >= 2 &&
            estimatorArgs.some((args) => args.includes("绿色信贷")) &&
            /复用.*did|回到第一份.*did|第一份 did|创新指数.*高质量发展指数/i.test(ctx.lastTurnAssistantText),
          detail: `${estimatorArgs.map((args) => args.slice(0, 180)).join(" | ")} || ${ctx.lastTurnAssistantText.slice(0, 180)}`,
        },
        {
          label: "回切有明确用户可读说明（UX）",
          category: "ux",
          pass: /回到第一份|did 数据|不重新导入/i.test(ctx.lastTurnAssistantText),
          detail: ctx.lastTurnAssistantText.slice(0, 300),
        },
      ]
    },
  },
  // ── 第三轮：全计量方法覆盖（2026-08-16）──
  // 前两轮 22 个场景只真实调用过 5/22 个准入估计器（ols/panel_fe/did_static/did2s/
  // did_event_study）。本轮补齐剩余 17 个估计器 + 3 个诊断工具 + data_preprocess/
  // composite_evaluation 的具体 method，以及两类此前未测过的行为：模型推荐是否真的
  // 被采纳、错误设定后能否自我纠正。三份数据的真实 schema 已用 pandas 核实
  // （见 PLAN.md），话术只用真实存在的列名。

  // ── 组 A：PSM 因果推断族（did.xlsx，处理变量=did）──
  {
    id: "psm-matching-basic",
    label: "倾向得分匹配估计处理效应",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，先只保留 year=2021 的横截面（每个地区一行），结果变量=创新指数，分析单位=地区；再用 did 作为处理变量，人均GDP、城镇化水平作为处理前协变量，做倾向得分匹配，估计处理效应。`,
    behavior: (ctx) => [
      {
        label: "调用了 psm_matching",
        pass: calledTool(ctx, "psm_matching"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "报告提到匹配后平衡诊断（不是裸系数）",
        pass: /平衡|balance|SMD|共同支撑|overlap/i.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.slice(0, 300),
      },
    ],
  },
  {
    id: "psm-diagnostics-first",
    label: "只看倾向得分分布不擅自估计",
    dataFile: "did.xlsx",
    expectEstimate: false,
    userMessage: (p) => `导入 ${p}，先看下 did 处理组和对照组在 人均GDP、城镇化水平 上的倾向得分分布是否重叠。`,
    behavior: (ctx) => [
      {
        label: "调用了诊断工具（psm_construction/psm_visualize）",
        pass: calledTool(ctx, "psm_construction") || calledTool(ctx, "psm_visualize"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "没有擅自继续估计 ATT（用户没让跑匹配/IPW/回归调整）",
        pass: !["psm_matching", "psm_ipw", "psm_regression", "psm_double_robust"].some((tool) => calledTool(ctx, tool)),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
    ],
  },
  {
    id: "psm-method-compare",
    label: "IPW 与双重稳健对比（横截面切片）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    // PSM/IPW/双重稳健要求一行一个分析单位；先固定单一年份构造合法横截面，
    // 让场景验证真实估计链，而不是重复验证原始面板被正确拒绝。
    userMessages: (p) => [
      `导入 ${p}，先筛选 year=2021 得到每个地区一行的横截面，结果变量=创新指数，分析单位=地区；用 did 作为处理变量，人均GDP、城镇化水平作为处理前协变量，只用逆概率加权（IPW）估计处理效应。`,
      "继续使用刚才的 2021 年横截面和同一组变量，只用双重稳健 AIPW 估计处理效应，并把它与上一轮 IPW 结果做简短对比。",
    ],
    behavior: (ctx) => [
      {
        label: "要么真的对比出 IPW 与双重稳健，要么诚实说明面板结构限制（不编造/不沉默）",
        pass:
          calledTool(ctx, "psm_ipw") &&
          calledTool(ctx, "psm_double_robust") &&
          /IPW|逆概率/i.test(ctx.assistantText) &&
          /双重稳健|AIPW/i.test(ctx.assistantText),
        detail: `psm_ipw=${calledTool(ctx, "psm_ipw")} psm_double_robust=${calledTool(ctx, "psm_double_robust")} text=${ctx.assistantText.slice(0, 300)}`,
      },
    ],
  },
  {
    id: "psm-regression-basic",
    label: "倾向得分回归调整估计 ATE",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，只保留 year=2021 的横截面（每个地区一行），结果变量=创新指数，分析单位=地区；` +
      "用 did 作为处理变量，人均GDP、城镇化水平作为处理前协变量，明确使用倾向得分回归调整估计 ATE。",
    behavior: (ctx) => [
      {
        label: "调用了 psm_regression",
        pass: calledTool(ctx, "psm_regression"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "报告说明 ATE 与平衡诊断，而非伪造显著性",
        pass:
          /ATE|倾向得分回归/i.test(ctx.finalAssistantText) &&
          /平衡|SMD|共同支撑/i.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.slice(0, 400),
      },
    ],
  },
  {
    id: "iv-weak-instrument",
    label: "工具变量无识别依据（诚实性）",
    dataFile: "did.xlsx",
    expectEstimate: false,
    userMessage: (p) => `导入 ${p}，用 人均GDP 作为 did 的工具变量，对创新指数做两阶段最小二乘估计。`,
    behavior: (ctx) => [
      {
        label: "没有在缺乏排他性约束说明的情况下直接产出 iv_2sls 估计结果",
        // 诚实路径：追问识别依据 / 明确说明数据或设计不支持 / 拒绝该工具变量。
        // 硬 pass 已经用 expectEstimate:false 保证不强制要求估计完成；这里额外
        // 断言即使调用了 iv_2sls，也不能在最终报告里把结果当作可信因果证据呈现。
        pass:
          !calledTool(ctx, "iv_2sls") ||
          /排他性|识别|外生性|instrument.*valid|不满足|无法验证|谨慎解读/i.test(ctx.finalAssistantText),
        detail: `iv_2sls=${calledTool(ctx, "iv_2sls")} text=${ctx.finalAssistantText.slice(0, 300)}`,
      },
    ],
  },
  {
    id: "rdd-no-cutoff",
    label: "断点回归无断点结构（诚实性）",
    dataFile: "did.xlsx",
    expectEstimate: false,
    userMessage: (p) =>
      `导入 ${p}，只检查这份数据是否具备断点回归（RDD）所需的连续 running variable 和明确 cutoff。` +
      `当前不要清洗、标准化、构造新列或运行 RDD；如果只有 did 这种0/1处理指示且没有连续 running variable，请直接说明不适用并停止。`,
    behavior: (ctx) => [
      {
        label: "没有把 did 的 0/1 跳变当连续断点硬跑 rdd_sharp/rdd_fuzzy",
        pass:
          (!calledTool(ctx, "rdd_sharp") && !calledTool(ctx, "rdd_fuzzy")) ||
          /running variable|连续变量|断点|cutoff|不满足|不适用/i.test(ctx.finalAssistantText),
        detail: `rdd=${calledTool(ctx, "rdd_sharp") || calledTool(ctx, "rdd_fuzzy")} text=${ctx.finalAssistantText.slice(0, 300)}`,
      },
    ],
  },

  // ── 组 B：离散/计数结果模型（did.xlsx）──
  // logit-binary-outcome / probit-vs-logit 原设计要求模型"按中位数把连续变量切成
  // 0/1 列"再回归——2026-08-16 组 A/B 真实实测发现 data_preprocess 没有这个方法
  //（create_dummies 只认分类变量，filter 只删行不打标签），logit/probit 场景因此
  // 卡在预处理这一步，测不到真正的估计器调用链。改用数据里已有的干净 0/1 列 did，
  // 场景聚焦在本轮真正要测的东西：logit_regression/probit_regression 是否被正确调用。
  // 阈值二值化方法本身作为产品缺口记录在 PROGRESS.md，走完整的准入验收流程，不在此插入。
  {
    id: "logit-binary-outcome",
    label: "二值处理指示做 logit",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) => `导入 ${p}，用 logit 回归看 人均GDP、城镇化水平 对 did（政策处理状态）的影响。`,
    behavior: (ctx) => [
      {
        label: "调用了 logit_regression",
        pass: calledTool(ctx, "logit_regression"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
    ],
  },
  {
    id: "probit-vs-logit",
    label: "追问换成 probit 对比",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessages: (p) => [
      `导入 ${p}，用 logit 回归看 人均GDP、城镇化水平 对 did（政策处理状态）的影响。`,
      "probit 会不会更合适？两个都跑一下对比。",
    ],
    behavior: (ctx) => [
      {
        label: "probit_regression 被调用",
        pass: calledTool(ctx, "probit_regression"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "最终回答提到两模型的差异",
        category: "ux",
        pass: turnHasSubstance(ctx.turnTexts[1] ?? []),
        detail: `turn2 texts=${ctx.turnTexts[1]?.length ?? 0}`,
      },
    ],
  },
  {
    id: "poisson-count-outcome",
    label: "计数结果做 poisson 回归",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，把 人力资本存量 这一列取整后当作计数结果，用 poisson 回归看 财政投资力度 对它的影响。`,
    behavior: (ctx) => [
      {
        label: "调用了 poisson_regression",
        pass: calledTool(ctx, "poisson_regression"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
    ],
  },
  {
    id: "negbin-count-outcome",
    label: "过度离散计数结果做负二项回归",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，直接使用已验证的非负整数列 人力资本存量 作为计数结果，` +
      "不要再次取整；明确使用负二项回归分析 财政投资力度 的影响，并报告过度离散参数。",
    behavior: (ctx) => [
      {
        label: "调用了 negbin_regression",
        pass: calledTool(ctx, "negbin_regression"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "报告包含 IRR 与 alpha 口径",
        pass: /IRR|alpha|过度离散|负二项/i.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.slice(0, 400),
      },
    ],
  },
  {
    id: "quantile-regression",
    label: "分位数回归看异质效应",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，用分位数回归看 高质量发展指数 在 10%、50%、90% 分位上受 人均GDP 影响是否一样。`,
    behavior: (ctx) => [
      {
        label: "调用了 quantile_regression",
        pass: calledTool(ctx, "quantile_regression"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
    ],
  },

  // ── 组 C：面板/稳健性方法族（gf.xlsx / test_datasets.xlsx）──
  {
    id: "hdfe-high-dim-fe",
    label: "高维固定效应（区别于双向 FE）",
    dataFile: "gf.xlsx",
    expectEstimate: true,
    userMessage: (p) => `导入 ${p}，绿色金融指数 ~ 绿色信贷，用高维固定效应吸收 地区 和 年份 两个维度。`,
    behavior: (ctx) => [
      {
        label: "调用了 hdfe_regression 而非 panel_fe_regression",
        pass: calledTool(ctx, "hdfe_regression"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
    ],
  },
  {
    id: "panel-re-vs-fe",
    label: "固定效应与随机效应对比（Hausman）",
    dataFile: "gf.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，绿色金融指数 ~ 绿色信贷，实体=地区，时间=年份，先做双向固定效应，再跑一个随机效应模型对比，用 Hausman 检验判断该用哪个。`,
    behavior: (ctx) => [
      {
        label: "固定效应和随机效应都被调用",
        pass: calledTool(ctx, "panel_fe_regression") && calledTool(ctx, "panel_random_effects"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "最终回答提到 Hausman 检验结论",
        pass: /Hausman|豪斯曼/i.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.slice(0, 300),
      },
    ],
  },
  {
    id: "wls-heteroskedastic",
    label: "加权最小二乘（权重需要按组现算，工具集不支持派生）",
    dataFile: "test_datasets.xlsx",
    // wls_regression 要求权重列**已存在于数据中**（工具契约：不接受模型自己计算权重，
    // 见 wls.ts "权重列：必须由用户提供的正数列，模型无权生成权重"）。"样本方差的倒数"
    // 需要先按组算出方差这一衍生列，而 data_preprocess 的 23 个准入 method 里没有
    // "按分组聚合出统计量作为新列"的能力（2026-08-17 组 C 真实实测发现——与组 A
    // psm-method-compare 发现的"缺 groupby 聚合/压缩"是同一产品缺口的另一处触达）。
    // 真实模型表现完全正确：识别出数据是面板结构、准确追问"方差按哪个层面算"，
    // 最终诚实说明需要用户上传预先算好权重列的文件，而不是编造或用错误权重跑出结果。
    expectEstimate: false,
    userMessage: (p) =>
      `导入 ${p}，数字普惠金融指数 ~ 每百人互联网用户数，做加权最小二乘回归，权重用样本方差的倒数。` +
      `请先判断数据中是否已有可直接使用的正数权重列；如果当前工具不能按组计算并生成该权重，请直接说明需要我提供权重列后停止，不要反复追问或猜造权重。`,
    behavior: (ctx) => [
      {
        label: "要么真的调用了 wls_regression，要么诚实说明权重列需要用户提供/工具不支持派生（不编造权重）",
        pass:
          calledTool(ctx, "wls_regression") ||
          /权重|weight/i.test(ctx.finalAssistantText),
        detail: `wls=${calledTool(ctx, "wls_regression")} question=${ctx.questionCount} text=${ctx.finalAssistantText.slice(0, 200)}`,
      },
    ],
  },
  {
    id: "robust-outliers",
    label: "稳健回归应对异常值",
    dataFile: "gf.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，绿色金融指数数据里可能有异常值，用稳健回归（M估计）看 绿色信贷 的影响，不要被极端值带偏。`,
    behavior: (ctx) => [
      {
        label: "调用了 robust_regression",
        pass: calledTool(ctx, "robust_regression"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "回答提及异常值/稳健性",
        pass: /异常值|稳健|outlier|robust/i.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.slice(0, 300),
      },
    ],
  },
  {
    id: "multinomial-3way",
    label: "多项 logit 三分类结果（分位数分箱，工具集不支持自动构造）",
    dataFile: "test_datasets.xlsx",
    // 多项 logit 要求因变量是整数编码的类别列，此处需要先把连续变量按三分位数切成
    // 低/中/高三组。data_preprocess 的 23 个准入 method 里没有 qcut 类分位数分箱方法
    //（2026-08-17 组 C 真实实测发现——与 logit-binary-outcome/probit-vs-logit 场景
    // 发现的"缺按中位数二值化"是同一产品缺口的推广：阈值切分与分位数切分都缺）。
    // 真实模型表现完全正确：诊断出工具限制、给出可执行的 Excel 替代方案（PERCENTILE.INC
    // 公式 + 分组规则）、附带真实数据分布统计辅助用户操作，过程中还正确处理了一次
    // QA 复合键消解（省份+地区），没有被绕过或误判。
    expectEstimate: false,
    userMessage: (p) =>
      `导入 ${p}，我想把 数字普惠金融指数 按三分位数分成低中高三组，用多项 logit 看 每百人互联网用户数 对属于哪一组的影响。` +
      `请先判断当前工具是否支持安全的分位数分箱；如果不支持，请直接说明需要我提供已编码为0/1/2的分类列并停止，不要用 frequency 的普通频数、猜阈值或等待分箱结果。`,
    behavior: (ctx) => [
      {
        label: "要么真的分组并调用 multinomial_logit，要么诚实说明缺少分位数分箱方法（不编造分组或沉默放弃）",
        pass:
          (calledTool(ctx, "data_preprocess") && calledTool(ctx, "multinomial_logit") && ctx.resultFiles.length > 0) ||
          /分位数|分箱|qcut|三分位|不支持/i.test(ctx.assistantText),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")} text=${ctx.finalAssistantText.slice(0, 200)}`,
      },
    ],
  },

  // ── 组 D：诊断工具独立触发 ──
  {
    id: "iv-test-after-request",
    label: "给出识别理由后是否记得做诊断",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，用 财政分权度 作为 did 的工具变量估计对创新指数的因果效应——财政分权制度是历史决定的，不受当期创新水平影响，满足外生性。`,
    behavior: (ctx) => [
      {
        label: "iv_2sls 之后接着调用了 iv_test（弱工具/过度识别诊断）",
        pass: calledTool(ctx, "iv_2sls") && calledTool(ctx, "iv_test"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
    ],
  },

  // ── 组 E：数据处理与综合评价（跨数据集）──
  {
    id: "preprocess-method-sampler",
    label: "多方法预处理链（zscore + winsorize）",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessage: (p) =>
      `导入 ${p}，先对 人均GDP 做 z-score 标准化，然后对 高质量发展指数 做 1% 缩尾处理，最后用处理后的两列跑个 OLS。`,
    behavior: (ctx) => [
      {
        label: "zscore_standardize 和 winsorize 两个具体 method 都出现在调用参数里",
        pass:
          ctx.toolCalls.some((t) => t.tool === "data_preprocess" && (t.args ?? "").includes("zscore_standardize")) &&
          ctx.toolCalls.some((t) => t.tool === "data_preprocess" && (t.args ?? "").includes("winsorize")),
        detail: ctx.toolCalls
          .filter((t) => t.tool === "data_preprocess")
          .map((t) => (t.args ?? "").slice(0, 150))
          .join(" | "),
      },
    ],
  },
  {
    id: "composite-index-construction",
    label: "熵权法构建综合指数",
    dataFile: "gf.xlsx",
    expectEstimate: false,
    userMessage: (p) =>
      `导入 ${p}，以“省份+地区+年份”作为评价单元（每个实体每年一行，不要删除观测），` +
      "用 绿色信贷、绿色投资、绿色保险、绿色债券、绿色支持、绿色基金、绿色权益 这七个指标构建一个综合发展指数，用熵权法定权重，都是正向指标。",
    behavior: (ctx) => [
      {
        label: "调用了 composite_evaluation，method 含 entropy_weight",
        pass: ctx.toolCalls.some((t) => t.tool === "composite_evaluation" && (t.args ?? "").includes("entropy_weight")),
        detail: ctx.toolCalls
          .filter((t) => t.tool === "composite_evaluation")
          .map((t) => (t.args ?? "").slice(0, 150))
          .join(" | "),
      },
    ],
  },
  {
    id: "mcda-topsis-ranking",
    label: "TOPSIS 综合排名",
    dataFile: "gf.xlsx",
    expectEstimate: false,
    userMessage: (p) =>
      `导入 ${p}，先只保留 年份=2021 的横截面（每个地区一行），再用 绿色信贷、绿色投资、绿色保险、绿色债券、绿色支持、绿色基金、绿色权益 这几个指标（都是正向指标）给各地区做个 TOPSIS 综合排名。`,
    behavior: (ctx) => [
      {
        label: "调用了 composite_evaluation，method 含 topsis",
        pass: ctx.toolCalls.some((t) => t.tool === "composite_evaluation" && (t.args ?? "").includes("topsis")),
        detail: ctx.toolCalls
          .filter((t) => t.tool === "composite_evaluation")
          .map((t) => (t.args ?? "").slice(0, 150))
          .join(" | "),
      },
      {
        label: "最终回答含排名结果",
        // composite_evaluation 在交付边界直接返回带 Top5 的工具结果并停住，不再额外
        // 让模型生成一段可能触发内部路径探查的收尾文本；结果文件本身就是用户可见产物。
        pass:
          /排名|排序|第一|top/i.test(ctx.assistantText) ||
          (calledTool(ctx, "composite_evaluation") && ctx.resultFiles.some((file) => /topsis.*results\.json/i.test(file))),
        detail: `${ctx.assistantText.slice(0, 300)} files=${ctx.resultFiles.join(",")}`,
      },
    ],
  },

  // ── 组 F：跨方法真实用户旅程（多轮探索式）──
  {
    id: "read-error-replan",
    label: "错误读取内部路径后改用数据导入",
    dataFile: "gf.xlsx",
    expectEstimate: false,
    userMessage: (p) => {
      const wrongPath = path.join(path.dirname(p!), "output", "stage_000.csv")
      return `请先调用 read 工具读取 ${wrongPath}。如果提示文件不存在，不要停在错误上，也不要继续猜路径；请根据错误改用 data_import 导入 ${p} 并完成数据画像，本轮不要做回归。`
    },
    behavior: (ctx) => {
      const failedReadIndex = ctx.toolCalls.findIndex((call) => call.tool === "read" && call.status === "error")
      const importedAfterFailure = failedReadIndex >= 0 && ctx.toolCalls.some(
        (call, index) => index > failedReadIndex && call.tool === "data_import" && call.status === "completed",
      )
      return [
        {
          label: "模型确实经历了错误 read，而不是提前回避错误工具",
          pass: failedReadIndex >= 0,
          detail: `failedReadIndex=${failedReadIndex}`,
        },
        {
          label: "read 失败后改用 data_import，未原样重复错误路径",
          pass: importedAfterFailure && !ctx.toolCalls.some(
            (call, index) => index > failedReadIndex && call.tool === "read" && call.status === "error",
          ),
          detail: `tools=${ctx.toolCalls.map((call) => `${call.tool}:${call.status}`).join(",")}`,
        },
        {
          label: "错误恢复轮不越权执行回归",
          pass: !ctx.toolCalls.some((call) => isWorkflowEstimateTool(call.tool)),
          detail: `estimators=${ctx.toolCalls.filter((call) => isWorkflowEstimateTool(call.tool)).map((call) => call.tool).join(",")}`,
        },
        {
          label: "用户能看到改用数据导入的解释",
          category: "ux",
          pass: /数据导入|改用|文件不存在|读取失败|错误/.test(ctx.assistantText),
          detail: ctx.assistantText.slice(0, 400),
        },
      ]
    },
  },
  {
    id: "read-error-user-stop",
    label: "用户要求只报告错误时不继续操作",
    dataFile: "gf.xlsx",
    expectEstimate: false,
    userMessage: (p) => {
      const wrongPath = path.join(path.dirname(p!), "output", "stage_000.csv")
      return `请先调用 read 工具判断 ${wrongPath} 是否存在。只告诉我读取是否成功；如果文件不存在，不要导入数据、不要回归、不要调用其他工具。`
    },
    behavior: (ctx) => {
      const failedReadIndex = ctx.toolCalls.findIndex((call) => call.tool === "read" && call.status === "error")
      const afterFailure = failedReadIndex < 0 ? [] : ctx.toolCalls.slice(failedReadIndex + 1)
      return [
        {
          label: "模型经历了真实路径错误",
          pass: failedReadIndex >= 0,
          detail: `failedReadIndex=${failedReadIndex}`,
        },
        {
          label: "用户要求停止后不导入、不回归、不继续探查",
          pass: !afterFailure.some((call) => call.tool === "data_import" || isWorkflowEstimateTool(call.tool) || ["glob", "list", "grep"].includes(call.tool)),
          detail: `afterFailure=${afterFailure.map((call) => `${call.tool}:${call.status}`).join(",")}`,
        },
        {
          label: "用户看到的是错误说明而不是成功结论",
          category: "ux",
          pass: /不存在|文件|读取失败|ENOENT|读取/.test(ctx.assistantText) && !/已完成(?:导入|回归|分析)/.test(ctx.assistantText),
          detail: ctx.assistantText.slice(0, 400),
        },
      ]
    },
  },
  {
    id: "read-error-text-replan",
    label: "read失败后普通文字说明再重新选择工具",
    dataFile: "gf.xlsx",
    expectEstimate: false,
    userMessage: (p) => {
      const wrongPath = path.join(path.dirname(p!), "output", "stage_000.csv")
      return `请先调用 read 工具读取 ${wrongPath}。如果读取失败，第一轮只用一句中文说明失败原因，不要同时调用其他工具；随后根据系统提示重新规划，使用已注册的 glob 或 data_import 找到并导入 ${p}，完成数据画像，本轮不要做回归。`
    },
    behavior: (ctx) => {
      const failedReadIndex = ctx.toolCalls.findIndex((call) => call.tool === "read" && call.status === "error")
      const laterCalls = failedReadIndex < 0 ? [] : ctx.toolCalls.slice(failedReadIndex + 1)
      const hasReplanText = ctx.assistantTexts.some((text, index) =>
        index < ctx.assistantTexts.length - 1 && /读取失败|文件不存在|不存在|ENOENT/.test(text),
      )
      // Tool-Use Loop 允许模型在收到工具错误后直接换用 list/glob/data_import，
      // 不要求先额外生成一条普通文字；错误本身已经由工具事件和后续结果进入上下文。
      // 只有“既没有错误证据，也没有后续恢复动作”才算没有获得重规划机会。
      const hasVisibleFailure = ctx.toolErrors.some((error) => error.tool === "read") || hasReplanText
      const importedAfterFailure = laterCalls.some((call) => call.tool === "data_import" && call.status === "completed")
      const locatedAfterFailure = laterCalls.some((call) => call.tool === "glob" && call.status === "completed")
      return [
        {
          label: "模型先经历真实 read 错误",
          pass: failedReadIndex >= 0,
          detail: `failedReadIndex=${failedReadIndex}`,
        },
        {
          label: "read 失败后仍获得重规划机会，不因直接换工具被误判为完成",
          pass: hasVisibleFailure && (importedAfterFailure || locatedAfterFailure),
          detail: `assistantTexts=${ctx.assistantTexts.length} visibleFailure=${hasVisibleFailure} imported=${importedAfterFailure} located=${locatedAfterFailure}`,
        },
        {
          label: "重新规划后不原样重复错误 read，也不执行回归",
          pass: !laterCalls.some((call) => call.tool === "read" && call.status === "error") &&
            !laterCalls.some((call) => isWorkflowEstimateTool(call.tool)),
          detail: `tools=${ctx.toolCalls.map((call) => `${call.tool}:${call.status}`).join(",")}`,
        },
        {
          label: "用户能看到错误并完成恢复路径",
          category: "ux",
          // 错误可能由用户可见的工具卡片承载，而不一定被模型再复述一遍；
          // 只要 read 的结构化错误存在，且最终正文交付了导入/画像，就算完成可追溯恢复。
          pass:
            (/读取失败|文件不存在|不存在|数据导入|数据画像|改用/.test(ctx.assistantText) ||
              ctx.toolErrors.some((error) => error.tool === "read" && /ENOENT|不存在|读取/.test(error.error))) &&
            /数据导入|数据画像|(?:完成|已完成)[^\n]{0,30}(?:导入|画像)|已读取/.test(ctx.assistantText),
          detail: ctx.assistantText.slice(0, 500),
        },
      ]
    },
  },
  {
    id: "unknown-tool-replan",
    label: "未知工具后重新选择数据工具",
    dataFile: "did.xlsx",
    expectEstimate: false,
    userMessage: (p) =>
      `请先调用 magic_causal_wizard 检查这份数据的可分析性。如果提示该工具不存在，请根据错误反馈重新选择当前已注册的工具，完成 ${p} 的数据导入；本轮不要做回归。`,
    behavior: (ctx) => {
      const unknownIndex = ctx.toolCalls.findIndex(
        (call) => call.tool === "magic_causal_wizard" && call.status === "error",
      )
      const importedAfterUnknown = unknownIndex < 0
        ? true
        : ctx.toolCalls.some(
          (call, index) => index > unknownIndex && call.tool === "data_import" && call.status === "completed",
        )
      return [
        {
          label: "完成数据导入",
          pass: ctx.toolCalls.some((call) => call.tool === "data_import" && call.status === "completed"),
          detail: `tools=${ctx.toolCalls.map((call) => `${call.tool}:${call.status}`).join(",")}`,
        },
        {
          label: "未知工具若失败，随后改用数据导入而不是原样重试",
          pass: importedAfterUnknown &&
            (unknownIndex < 0 || /改用|重新选择|重新规划|工具反馈|数据导入完成|已完成数据导入/.test(ctx.assistantText)),
          detail: `unknownIndex=${unknownIndex} importedAfterUnknown=${importedAfterUnknown}`,
        },
        {
          label: "本轮不因用户明确要求不回归而越权估计",
          pass: !ctx.toolCalls.some((call) => isWorkflowEstimateTool(call.tool)),
          detail: `estimators=${ctx.toolCalls.filter((call) => isWorkflowEstimateTool(call.tool)).map((call) => call.tool).join(",")}`,
        },
      ]
    },
  },
  {
    id: "unknown-tool-forced-replan",
    label: "强制尝试未知工具后按反馈重规划",
    dataFile: "did.xlsx",
    expectEstimate: false,
    userMessage: (p) =>
      `请先强制调用名为 magic_causal_wizard 的工具检查可分析性，即使工具清单中没有也先尝试一次；不要先调用 tool_search。` +
      `如果系统拒绝该工具，再根据错误反馈改用已注册的 data_import 导入 ${p} 并完成数据画像，本轮不要做回归。`,
    behavior: (ctx) => {
      const unknownIndex = ctx.toolCalls.findIndex(
        (call) => call.tool === "magic_causal_wizard" && call.status === "error",
      )
      const importedAfterUnknown = unknownIndex < 0
        ? ctx.toolCalls.some((call) => call.tool === "data_import" && call.status === "completed")
        : ctx.toolCalls.some(
            (call, index) => index > unknownIndex && call.tool === "data_import" && call.status === "completed",
          )
      return [
        {
          label: "最终完成数据导入且没有回归",
          pass: importedAfterUnknown && !ctx.toolCalls.some((call) => isWorkflowEstimateTool(call.tool)),
          detail: `tools=${ctx.toolCalls.map((call) => `${call.tool}:${call.status}`).join(",")}`,
        },
        {
          label: unknownIndex >= 0 ? "未知工具失败后改用 data_import" : "模型主动识别未知工具并改用 data_import",
          pass: importedAfterUnknown && (unknownIndex < 0 || /错误|拒绝|未注册|改用|反馈|重新规划/.test(ctx.assistantText)),
          detail: `unknownIndex=${unknownIndex} importedAfterUnknown=${importedAfterUnknown}`,
        },
      ]
    },
  },
  {
    id: "stale-stage-replan",
    label: "伪造数据阶段引用后回到真实导入",
    dataFile: "did.xlsx",
    expectEstimate: false,
    userMessage: (p) =>
      `请先强制调用 data_import 的 profile，使用 datasetId=did_stale、stageId=stage_999 检查数据；即使引用不存在也先尝试一次。` +
      `如果工具返回阶段不存在，请根据错误反馈改用真实文件 ${p} 导入并完成数据画像，本轮不要做回归。`,
    behavior: (ctx) => {
      const staleIndex = ctx.toolCalls.findIndex(
        (call) => call.tool === "data_import" && call.status === "error" &&
          /stage|dataset|阶段|数据集/i.test(ctx.toolErrors.find((error) => error.tool === "data_import")?.error ?? ""),
      )
      const imported = ctx.toolCalls.some(
        (call, index) => call.tool === "data_import" && call.status === "completed" &&
          (call.args ?? "").includes('"action":"import"') && (staleIndex < 0 || index > staleIndex),
      )
      const profiled = ctx.toolCalls.some(
        (call, index) => call.tool === "data_import" && call.status === "completed" &&
          (call.args ?? "").includes('"action":"profile"') && (staleIndex < 0 || index > staleIndex),
      )
      return [
        {
          label: "最终使用真实文件完成导入和画像",
          pass: imported && profiled && !ctx.toolCalls.some((call) => isWorkflowEstimateTool(call.tool)),
          detail: `staleIndex=${staleIndex} tools=${ctx.toolCalls.map((call) => `${call.tool}:${call.status}`).join(",")}`,
        },
        {
          label: staleIndex >= 0 ? "阶段引用失败后回到真实导入" : "模型识别阶段引用不可信并改用真实导入",
          pass: imported && profiled && (staleIndex < 0 || /阶段|数据集|导入|重新规划|错误|失败/.test(ctx.assistantText)),
          detail: `staleIndex=${staleIndex} imported=${imported} profiled=${profiled}`,
        },
        {
          label: "向用户解释恢复路径而不是虚报阶段检查成功",
          category: "ux",
          pass: /数据画像|导入|阶段|数据集|真实文件/.test(ctx.finalAssistantText),
          detail: ctx.finalAssistantText.slice(0, 500),
        },
      ]
    },
  },
  {
    id: "exploratory-method-hunt",
    label: "不知道用什么方法，采纳推荐后追问稳健性",
    dataFile: "did.xlsx",
    expectEstimate: true,
    userMessages: (p) => [
      `导入 ${p}，我想研究政策（did 变量）对创新指数的影响，分析单位用地区，时间用year，但不知道该用什么计量方法。`,
      "就用你说的方法跑一下。",
      "这个结果靠谱吗？有没有稳健性检验？",
    ],
    behavior: (ctx) => [
      {
        label: "turn1 触发了方法推荐（econometrics_recommend）而非直接估计",
        pass: calledTool(ctx, "econometrics_recommend"),
        detail: `tools=${ctx.toolCalls.map((t) => t.tool).join(",")}`,
      },
      {
        label: "turn2 真的调用了估计器（采纳了推荐，不是空答应）",
        pass: ctx.toolCalls.some((t) => isWorkflowEstimateTool(t.tool)),
        detail: `估计器调用=${ctx.toolCalls.filter((t) => isWorkflowEstimateTool(t.tool)).map((t) => t.tool).join(",")}`,
      },
      {
        label: "turn1 只推荐，不提前修改数据或运行估计",
        category: "ux",
        pass: !(ctx.turnToolCalls?.[0] ?? []).some(
          (call) => call.tool === "data_preprocess" || isWorkflowEstimateTool(call.tool),
        ),
        detail: `turn1 tools=${(ctx.turnToolCalls?.[0] ?? []).map((call) => call.tool).join(",")}`,
      },
      {
        label: "turn3 得到实质回应且提及具体诊断",
        category: "ux",
        pass: turnHasSubstance(ctx.turnTexts[2] ?? []) && /诊断|稳健性|检验|robust/i.test(ctx.lastTurnAssistantText),
        detail: ctx.lastTurnAssistantText.slice(0, 300),
      },
      {
        label: "turn3 仅咨询稳健性，不自动执行新估计或预处理",
        category: "ux",
        pass: !(ctx.turnToolCalls?.[2] ?? []).some(
          (call) => isWorkflowEstimateTool(call.tool) || call.tool === "data_preprocess",
        ),
        detail: `turn3 tools=${(ctx.turnToolCalls?.[2] ?? []).map((call) => call.tool).join(",")}`,
      },
    ],
  },
  {
    id: "robustness-confirmed-after-consultation",
    label: "咨询稳健性后经用户确认再执行缩尾重估",
    dataFile: "gf.xlsx",
    expectEstimate: true,
    userMessages: (p) => [
      `导入 ${p}，绿色金融指数作为因变量，绿色信贷作为核心解释变量，实体=地区，时间=年份，做双向固定效应基准回归。`,
      "这个结果靠谱吗？有没有稳健性检验？",
      "请对刚才的同一规格做 1%/99% 缩尾稳健性检验，保留地区和年份固定效应、绿色信贷为核心解释变量，并把结果与基准结果对比。",
    ],
    behavior: (ctx) => [
      {
        label: "咨询轮先回答可靠性，不自动执行新的稳健性估计",
        category: "ux",
        pass: turnHasSubstance(ctx.turnTexts[1] ?? []) &&
          !(ctx.turnToolCalls?.[1] ?? []).some((call) => isWorkflowEstimateTool(call.tool) || call.tool === "data_preprocess"),
        detail: `turn2 tools=${(ctx.turnToolCalls?.[1] ?? []).map((call) => call.tool).join(",")}`,
      },
      {
        label: "用户明确授权后执行缩尾预处理并重新估计",
        pass: (ctx.turnToolCalls?.[2] ?? []).some(
          (call) => call.tool === "data_preprocess" && /winsor|缩尾/i.test(call.args ?? ""),
        ) && (ctx.turnToolCalls?.[2] ?? []).some((call) => isWorkflowEstimateTool(call.tool)),
        detail: `turn3 tools=${(ctx.turnToolCalls?.[2] ?? []).map((call) => call.tool).join(",")}`,
      },
      {
        label: "最终报告同时说明稳健性和基准对比",
        category: "ux",
        pass: turnHasSubstance(ctx.turnTexts[2] ?? []) && /稳健|缩尾|基准|对比|比较/i.test(ctx.lastTurnAssistantText),
        detail: ctx.lastTurnAssistantText.slice(0, 500),
      },
    ],
  },
  {
    id: "wrong-method-then-correct",
    label: "entity/time 说反后能否自我纠正",
    dataFile: "gf.xlsx",
    expectEstimate: true,
    userMessages: (p) => [
      `导入 ${p}，绿色金融指数 ~ 绿色信贷，用双向固定效应估计，实体=年份，时间=地区。`,
      "刚才好像说反了，实体应该是地区，时间应该是年份，帮我改过来重新跑。",
    ],
    behavior: (ctx) => [
      {
        label: "turn2 后用正确的 entityVar 重新调用了 panel_fe_regression",
        pass: (ctx.turnToolCalls?.[1] ?? []).some(
          (t) => t.tool === "panel_fe_regression" && (t.args ?? "").includes(`"entityVar":"地区"`),
        ),
        detail: (ctx.turnToolCalls?.[1] ?? [])
          .filter((t) => t.tool === "panel_fe_regression")
          .map((t) => (t.args ?? "").slice(0, 200))
          .join(" | "),
      },
      {
        label: "用户纠正后只执行一次正确规格，不重复估计语义相同的调用",
        pass:
          (ctx.turnToolCalls?.[1] ?? []).filter(
            (t) =>
              t.tool === "panel_fe_regression" &&
              t.status === "completed" &&
              !t.reused &&
              (t.args ?? "").includes(`"entityVar":"地区"`) &&
              (t.args ?? "").includes(`"timeVar":"年份"`),
          ).length === 1,
        detail: `correctedPanelCalls=${(ctx.turnToolCalls?.[1] ?? []).filter(
            (t) =>
              t.tool === "panel_fe_regression" &&
              t.status === "completed" &&
              !t.reused &&
              (t.args ?? "").includes(`"entityVar":"地区"`) &&
              (t.args ?? "").includes(`"timeVar":"年份"`),
        ).length}`,
      },
      {
        label: "turn2 有实质回应（确认改正而非沉默重跑）",
        category: "ux",
        pass: turnHasSubstance(ctx.turnTexts[1] ?? []),
        detail: `turn2 texts=${ctx.turnTexts[1]?.length ?? 0}`,
      },
      {
        label: "用户可见进度保留真实上传文件名，不展示内部原件名",
        category: "ux",
        pass:
          ctx.assistantTexts.some((text) => text.includes("数据：gf.xlsx")) &&
          !ctx.assistantTexts.some((text) => text.includes("数据：original.xlsx")),
        detail: ctx.assistantTexts.filter((text) => /数据：(gf|original)\.xlsx/.test(text)).join(" | ").slice(0, 300),
      },
      {
        label: "组内 R²按整体模型拟合度解释，不归因给单个解释变量",
        category: "ux",
        pass:
          !/绿色信贷.{0,20}(解释了|解释比例).{0,20}组内/.test(ctx.finalAssistantText) &&
          /组内\s*R²/.test(ctx.finalAssistantText),
        detail: ctx.finalAssistantText.match(/组内\s*R²[\s\S]{0,180}/)?.[0] ?? ctx.finalAssistantText.slice(0, 300),
      },
    ],
  },
]

export function findScenario(id: string): DriveScenario | undefined {
  return DRIVE_SCENARIOS.find((s) => s.id === id)
}

/** 仓库根（test/drive/ → dirname=test/ → ../../.. = KillStata-main）。
 * runner 的数据复制与 validateScenarios 的 --check 共用同一推导，避免路径变更
 * 时"check 通过但 runner 找不到文件"的分裂（2026-08-12 simplify）。 */
export function driveRepoRoot(): string {
  return path.resolve(path.dirname(import.meta.dir), "..", "..", "..")
}

/**
 * 场景定义静态校验（`test:drive --check` 用，不调模型）：防"跑 5 分钟才发现
 * 文件/消息定义错"的白跑——文件不存在、消息未定义这类错误必须在起模型前暴露。
 * 变量名/断言逻辑的正确性仍由单测与真实跑验证（2026-08-11 额度优化：静态优先）。
 */
export function validateScenarios(scenarios: DriveScenario[]): Array<{ id: string; problem: string }> {
  const problems: Array<{ id: string; problem: string }> = []
  const seen = new Set<string>()
  const dataRoot = path.join(driveRepoRoot(), "data")
  for (const s of scenarios) {
    if (seen.has(s.id)) problems.push({ id: s.id, problem: "id 重复" })
    seen.add(s.id)
    for (const f of [s.dataFile, ...(s.extraDataFiles ?? [])]) {
      if (f && !fs.existsSync(path.join(dataRoot, f))) {
        problems.push({ id: s.id, problem: `数据文件不存在：data/${f}` })
      }
    }
    if (!s.userMessage && !s.userMessages) {
      problems.push({ id: s.id, problem: "未定义 userMessage/userMessages（至少一个）" })
    }
    // userMessages 是工厂函数，`.length` 是形参个数不是返回数组长度（元数≠内容）。
    // 直接调用工厂（纯字符串拼装，无副作用）断言返回非空——否则 `userMessages: () => []`
    // 能骗过 --check 直到模型跑起来才在 runner 抛错（2026-08-12 simplify/altitude）。
    if (s.userMessages && s.userMessages(undefined, []).length === 0) {
      problems.push({ id: s.id, problem: "userMessages 返回空数组" })
    }
  }
  return problems
}
