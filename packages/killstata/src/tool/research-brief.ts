import fs from "fs"
import path from "path"
import z from "zod"
import DESCRIPTION from "./research-brief.txt"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { generatedArtifactRoot, maybeDatasetManifestFromSourcePath } from "./analysis-artifacts"
import {
  finalOutputsPath,
  publishVisibleOutput,
  readDatasetManifest,
  resolveArtifactInput,
  type DatasetManifest,
} from "./analysis-state"
import { relativeWithinProject, resolveToolPath } from "./analysis-path"

const log = Log.create({ service: "research-brief-tool" })

type WebSource = {
  title: string
  url: string
  snippet?: string
  query: string
}

type MechanismItem = {
  name: string
  rationale: string
  observable_implications: string[]
}

type StrategyItem = {
  name: string
  suitable_for: string
  core_assumption: string
  required_data: string[]
  main_risks: string[]
  recommended: boolean
}

export type ResearchBriefJson = {
  grounding_mode: "web_enhanced" | "offline_requested" | "offline_fallback"
  generated_at: string
  language: string
  idea: string
  core_question: string
  testable_hypotheses: string[]
  theory_and_mechanisms: MechanismItem[]
  candidate_identification_strategies: StrategyItem[]
  preferred_design: {
    name: string
    rationale: string
    identifying_assumptions: string[]
    minimum_data_requirements: string[]
    diagnostics_to_run: string[]
  }
  required_data: {
    target_units: string
    time_span: string
    minimum_fields: string[]
    desirable_fields: string[]
    likely_sources: string[]
  }
  variable_blueprint: {
    outcome: string
    treatment: string
    mechanisms: string[]
    controls: string[]
    fixed_effects: string[]
    clustering: string
  }
  feasibility_risks: string[]
  validity_risks: string[]
  next_actions: string[]
}

export type ResearchBriefMetadata = {
  datasetId?: string
  stageId?: string
  runId: string
  groundingMode: ResearchBriefJson["grounding_mode"]
  outputDir: string
  briefPath: string
  briefJsonPath: string
  sourcesPath: string
  finalOutputsPath?: string
  visibleOutputs: Array<{ label: string; relativePath: string }>
}

export type ResearchBriefResult = {
  brief: ResearchBriefJson
  metadata: ResearchBriefMetadata
}

const ResearchBriefInputSchema = z.object({
  idea: z.string().min(3),
  researchQuestion: z.string().optional(),
  context: z.string().optional(),
  targetOutcome: z.string().optional(),
  candidateTreatment: z.union([z.string(), z.array(z.string())]).optional(),
  candidateMechanisms: z.array(z.string()).optional(),
  candidateDesigns: z.array(z.string()).optional(),
  dataHints: z
    .object({
      sourcePath: z.string().optional(),
      sources: z.array(z.string()).optional(),
      timeRange: z.string().optional(),
      unitLevel: z.string().optional(),
      keyFields: z.array(z.string()).optional(),
      controls: z.array(z.string()).optional(),
      fixedEffects: z.array(z.string()).optional(),
      notes: z.string().optional(),
    })
    .passthrough()
    .optional(),
  datasetId: z.string().optional(),
  stageId: z.string().optional(),
  useWeb: z.boolean().default(true),
  outputLanguage: z.string().default("zh-CN"),
  runId: z.string().optional(),
  branch: z.string().default("main"),
  outputDir: z.string().optional(),
})

function nowIso() {
  return new Date().toISOString()
}

function normalizeRunId(value?: string) {
  if (!value) return `run_${Date.now()}`
  const normalized = value.replace(/[^a-zA-Z0-9_-]+/g, "_")
  return normalized.startsWith("run_") ? normalized : `run_${normalized}`
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function ensureAbsolutePathLocal(filePath: string) {
  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.join(Instance.directory, filePath)
}

function arrayify(value?: string | string[]) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function sanitizeText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function decodeHtml(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

async function duckDuckGoSearch(query: string, abort: AbortSignal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(url, {
    signal: abort,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  })
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed with ${response.status}`)
  }
  const html = await response.text()
  const regex =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>(.*?)<\/div>)?/g
  const results: WebSource[] = []
  for (const match of html.matchAll(regex)) {
    const href = decodeHtml(match[1] ?? "")
    const title = decodeHtml(match[2] ?? "")
    const snippet = decodeHtml(match[3] ?? match[4] ?? "")
    if (!href || !title) continue
    results.push({
      title,
      url: href,
      snippet: snippet || undefined,
      query,
    })
    if (results.length >= 5) break
  }
  return results
}

function inferCoreQuestion(input: z.infer<typeof ResearchBriefInputSchema>) {
  if (input.researchQuestion?.trim()) return sanitizeText(input.researchQuestion)
  const treatment = arrayify(input.candidateTreatment)[0] ?? "核心处理变量"
  const outcome = input.targetOutcome?.trim() || "核心结果变量"
  return `在给定制度背景与样本范围内，${treatment} 如何影响 ${outcome}，其作用机制与可执行识别路径分别是什么？`
}

function inferMechanisms(input: z.infer<typeof ResearchBriefInputSchema>) {
  const names =
    input.candidateMechanisms?.filter((item) => item.trim()) ?? ["资源配置", "激励约束", "信息传导"]
  return names.map((name) => ({
    name,
    rationale: `${name} 可能是处理变量影响结果变量的重要渠道，后续应尽量寻找可观测代理指标或机制型被解释变量。`,
    observable_implications: [
      `${name} 对应的代理指标应在处理发生后出现方向一致的变化`,
      `将 ${name} 纳入机制检验后，主效应的经济解释应更加清晰`,
    ],
  })) satisfies MechanismItem[]
}

function inferDesigns(input: z.infer<typeof ResearchBriefInputSchema>, coreQuestion: string) {
  const corpus = [input.idea, input.context, coreQuestion, ...(input.candidateDesigns ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

  const hasPolicyTiming = /(政策|试点|改革|冲击|did|event study|post|treated|pilot|intervention)/i.test(corpus)
  const hasCutoff = /(阈值|门槛|cutoff|threshold|score|断点|rdd)/i.test(corpus)
  const hasInstrument = /(工具变量|instrument|iv|2sls|外生冲击)/i.test(corpus)
  const hasPanel = /(panel|firm|city|province|county|year|quarter|month|企业|城市|地区|省份|区县)/i.test(corpus)

  const items: StrategyItem[] = []
  const push = (item: StrategyItem) => {
    if (!items.some((existing) => existing.name === item.name)) items.push(item)
  }

  if (hasPolicyTiming) {
    push({
      name: "DID / Event Study",
      suitable_for: "存在明确政策时点、处理组与对照组，并可观测处理前后多个时期的变化。",
      core_assumption: "平行趋势在处理前近似成立，且没有与处理同时发生并只作用于处理组的系统性冲击。",
      required_data: ["处理组标记", "时间变量", "政策时点", "面板主键"],
      main_risks: ["平行趋势不成立", "政策选择性试点", "同期政策混杂"],
      recommended: true,
    })
  }

  if (hasCutoff) {
    push({
      name: "RDD",
      suitable_for: "处理分配由可观测阈值或打分规则触发。",
      core_assumption: "阈值附近个体的潜在结果连续，且 running variable 不存在精确操纵。",
      required_data: ["running variable", "cutoff", "阈值附近样本", "结果变量"],
      main_risks: ["阈值被操纵", "带宽敏感", "局部外推受限"],
      recommended: false,
    })
  }

  if (hasInstrument) {
    push({
      name: "IV / 2SLS",
      suitable_for: "处理变量可能内生，但存在可信外生工具变量。",
      core_assumption: "工具变量同时满足相关性与排除性限制。",
      required_data: ["工具变量", "处理变量", "结果变量", "第一阶段可检验信息"],
      main_risks: ["弱工具变量", "排除性限制难以论证"],
      recommended: false,
    })
  }

  push({
    name: hasPanel ? "Panel FE Baseline" : "OLS / Pooled Baseline",
    suitable_for: "先建立一个可执行的基准关系，用于验证变量口径、样本结构和主效应方向。",
    core_assumption: hasPanel
      ? "控制个体与时间固定效应后，剩余误差不再与处理系统相关。"
      : "在控制协变量后，遗漏变量偏误处于可接受范围。",
    required_data: hasPanel
      ? ["个体主键", "时间主键", "结果变量", "处理变量", "控制变量"]
      : ["结果变量", "处理变量", "控制变量"],
    main_risks: ["遗漏变量偏误", "变量口径不稳", "标准误设定不当"],
    recommended: !items.some((item) => item.recommended),
  })

  if (!items.some((item) => item.recommended) && items.length > 0) {
    items[0]!.recommended = true
  }
  return items
}

function inferDataRequirements(input: z.infer<typeof ResearchBriefInputSchema>, mechanisms: MechanismItem[]) {
  const treatment = arrayify(input.candidateTreatment)[0] ?? "treatment"
  return {
    target_units: input.dataHints?.unitLevel ?? "优先使用企业、城市、区县或省份等可做面板识别的单位层级。",
    time_span: input.dataHints?.timeRange ?? "至少覆盖处理前后多个时期，以支持基准估计和动态检验。",
    minimum_fields: [input.targetOutcome?.trim() || "outcome", treatment, ...(input.dataHints?.keyFields ?? ["entity_id", "time"])],
    desirable_fields: [
      ...(input.dataHints?.controls ?? ["核心控制变量", "样本筛选变量"]),
      ...mechanisms.map((item) => `${item.name} 指标`),
    ],
    likely_sources: input.dataHints?.sources ?? ["统计年鉴或数据库", "政策文本与制度公告", "企业或地区层级公开数据"],
  }
}

function buildVariableBlueprint(input: z.infer<typeof ResearchBriefInputSchema>, mechanisms: MechanismItem[]) {
  const treatment = arrayify(input.candidateTreatment)[0] ?? "treatment"
  return {
    outcome: input.targetOutcome?.trim() || "outcome",
    treatment,
    mechanisms: mechanisms.map((item) => item.name),
    controls: input.dataHints?.controls ?? ["基础人口或经济控制变量", "财政、产业结构、固定资产等控制变量"],
    fixed_effects: input.dataHints?.fixedEffects ?? ["个体固定效应", "时间固定效应"],
    clustering: input.dataHints?.keyFields?.[0] ?? "按个体层级聚类",
  }
}

function buildHypotheses(input: { treatment: string; outcome: string; mechanisms: MechanismItem[] }) {
  const hypotheses = [`H1: ${input.treatment} 对 ${input.outcome} 存在可识别的平均处理效应。`]
  for (const mechanism of input.mechanisms.slice(0, 2)) {
    hypotheses.push(`H${hypotheses.length + 1}: ${input.treatment} 可能通过 ${mechanism.name} 渠道影响 ${input.outcome}。`)
  }
  return hypotheses
}

function buildRiskList(input: { designs: StrategyItem[]; useWeb: boolean; mechanisms: MechanismItem[] }) {
  const feasibility = [
    "处理变量与结果变量的公开口径可能不一致，需要先统一单位、时间频率与样本范围。",
    "如果关键机制变量无法直接获得，需要提前准备替代指标与缺失处理规则。",
  ]
  if (!input.useWeb) {
    feasibility.push("本次 brief 未完成联网增强，制度背景与公开事实仍需人工核对。")
  }

  const validity = [...new Set(input.designs.flatMap((item) => item.main_risks))]
  if (input.mechanisms.length === 0) {
    validity.push("机制链条仍不清晰，后续可能难以形成完整理论闭环。")
  }
  return { feasibility, validity }
}

function buildNextActions(input: { preferred: ResearchBriefJson["preferred_design"]; requiredData: ResearchBriefJson["required_data"] }) {
  return [
    `先确认最小数据清单：${input.requiredData.minimum_fields.join("、")}`,
    "把样本口径、时间范围与主键字段写成简版数据字典。",
    `围绕 ${input.preferred.name} 预先设计 QA、识别检验与稳健性路径。`,
    "在正式估计前先完成描述统计、缺失值检查与主键完整性检查。",
  ]
}

function renderResearchBriefMarkdown(input: { brief: ResearchBriefJson; sources: WebSource[] }) {
  const preferred = input.brief.preferred_design
  const alternatives = input.brief.candidate_identification_strategies.filter((item) => !item.recommended)
  return [
    "# Research Brief",
    "",
    "## Idea",
    input.brief.idea,
    "",
    "## Core Question",
    input.brief.core_question,
    "",
    "## Testable Hypotheses",
    ...input.brief.testable_hypotheses.map((item) => `- ${item}`),
    "",
    "## Theory And Mechanisms",
    ...input.brief.theory_and_mechanisms.flatMap((item) => [
      `### ${item.name}`,
      `- Rationale: ${item.rationale}`,
      ...item.observable_implications.map((line) => `- Observable implication: ${line}`),
      "",
    ]),
    "## Recommended Design",
    `- Name: ${preferred.name}`,
    `- Rationale: ${preferred.rationale}`,
    `- Identifying assumptions: ${preferred.identifying_assumptions.join("；")}`,
    `- Minimum data requirements: ${preferred.minimum_data_requirements.join("；")}`,
    `- Diagnostics to run: ${preferred.diagnostics_to_run.join("；")}`,
    "",
    "## Alternative Designs",
    ...(alternatives.length
      ? alternatives.flatMap((item) => [
          `### ${item.name}`,
          `- Suitable for: ${item.suitable_for}`,
          `- Core assumption: ${item.core_assumption}`,
          `- Required data: ${item.required_data.join("；")}`,
          `- Main risks: ${item.main_risks.join("；")}`,
          "",
        ])
      : ["- No alternative design was generated for this brief.", ""]),
    "## Required Data",
    `- Target units: ${input.brief.required_data.target_units}`,
    `- Time span: ${input.brief.required_data.time_span}`,
    `- Minimum fields: ${input.brief.required_data.minimum_fields.join("；")}`,
    `- Desirable fields: ${input.brief.required_data.desirable_fields.join("；")}`,
    `- Likely sources: ${input.brief.required_data.likely_sources.join("；")}`,
    "",
    "## Variable Blueprint",
    `- Outcome: ${input.brief.variable_blueprint.outcome}`,
    `- Treatment: ${input.brief.variable_blueprint.treatment}`,
    `- Mechanisms: ${input.brief.variable_blueprint.mechanisms.join("；")}`,
    `- Controls: ${input.brief.variable_blueprint.controls.join("；")}`,
    `- Fixed effects: ${input.brief.variable_blueprint.fixed_effects.join("；")}`,
    `- Clustering: ${input.brief.variable_blueprint.clustering}`,
    "",
    "## Feasibility Risks",
    ...input.brief.feasibility_risks.map((item) => `- ${item}`),
    "",
    "## Validity Risks",
    ...input.brief.validity_risks.map((item) => `- ${item}`),
    "",
    "## Next Actions",
    ...input.brief.next_actions.map((item) => `- ${item}`),
    "",
    "## Grounding",
    `- Mode: ${input.brief.grounding_mode}`,
    ...(input.sources.length
      ? input.sources.map((item) => `- ${item.title} | ${item.url}${item.snippet ? ` | ${item.snippet}` : ""}`)
      : ["- No external sources captured for this run."]),
    "",
  ].join("\n")
}

export const ResearchBriefTool = Tool.define("research_brief", {
  description: DESCRIPTION,
  parameters: ResearchBriefInputSchema,
  async execute(params, ctx) {
    const runId = normalizeRunId(params.runId)
    const datasetContext = resolveArtifactInput({
      datasetId: params.datasetId,
      stageId: params.stageId,
      inputPath: params.dataHints?.sourcePath,
    })

    let manifest: DatasetManifest | undefined = datasetContext.manifest
    if (!manifest && params.dataHints?.sourcePath) {
      manifest = maybeDatasetManifestFromSourcePath(ensureAbsolutePathLocal(params.dataHints.sourcePath))
    }
    if (!manifest && params.datasetId) {
      manifest = readDatasetManifest(params.datasetId)
    }

    const outputDir = params.outputDir
      ? await resolveToolPath({
          filePath: params.outputDir,
          mode: "write",
          toolName: "research_brief",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
        })
      : generatedArtifactRoot({
          module: "research_brief",
          runId,
          branch: params.branch,
        })
    ensureDir(outputDir)

    const coreQuestion = inferCoreQuestion(params)
    const mechanisms = inferMechanisms(params)
    const strategies = inferDesigns(params, coreQuestion)
    const preferredStrategy = strategies.find((item) => item.recommended) ?? strategies[0]
    const requiredData = inferDataRequirements(params, mechanisms)
    const variableBlueprint = buildVariableBlueprint(params, mechanisms)
    const treatment = arrayify(params.candidateTreatment)[0] ?? variableBlueprint.treatment
    const hypotheses = buildHypotheses({
      treatment,
      outcome: variableBlueprint.outcome,
      mechanisms,
    })

    let groundingMode: ResearchBriefJson["grounding_mode"] = params.useWeb ? "web_enhanced" : "offline_requested"
    let sources: WebSource[] = []

    if (params.useWeb) {
      const query = [params.researchQuestion, params.idea, params.targetOutcome, treatment].filter(Boolean).join(" ")
      try {
        await ctx.ask({
          permission: "websearch",
          patterns: [query],
          always: ["*"],
          metadata: { query, tool: "research_brief" },
        })
        sources = await duckDuckGoSearch(query, ctx.abort)
      } catch (error) {
        groundingMode = "offline_fallback"
        log.warn("research brief web grounding failed", { error: String(error) })
      }
    }

    const risks = buildRiskList({
      designs: strategies,
      useWeb: groundingMode === "web_enhanced",
      mechanisms,
    })

    const briefJson: ResearchBriefJson = {
      grounding_mode: groundingMode,
      generated_at: nowIso(),
      language: params.outputLanguage,
      idea: sanitizeText(params.idea),
      core_question: coreQuestion,
      testable_hypotheses: hypotheses,
      theory_and_mechanisms: mechanisms,
      candidate_identification_strategies: strategies,
      preferred_design: {
        name: preferredStrategy.name,
        rationale: `${preferredStrategy.name} 与当前问题最匹配，因为它同时兼顾可执行性、识别清晰度和后续稳健性检验空间。`,
        identifying_assumptions: [preferredStrategy.core_assumption],
        minimum_data_requirements: preferredStrategy.required_data,
        diagnostics_to_run: [
          "变量口径与时间维度 QA",
          "样本平衡与主键完整性检查",
          preferredStrategy.name.includes("DID") ? "平行趋势与动态效应检验" : "替代口径与稳健性检验",
        ],
      },
      required_data: requiredData,
      variable_blueprint: variableBlueprint,
      feasibility_risks: risks.feasibility,
      validity_risks: risks.validity,
      next_actions: buildNextActions({
        preferred: {
          name: preferredStrategy.name,
          rationale: preferredStrategy.suitable_for,
          identifying_assumptions: [preferredStrategy.core_assumption],
          minimum_data_requirements: preferredStrategy.required_data,
          diagnostics_to_run: ["QA", "稳健性", "识别检验"],
        },
        requiredData,
      }),
    }

    const sourcesDocument = {
      generated_at: nowIso(),
      grounding_mode: groundingMode,
      source_count: sources.length,
      sources,
    }

    const briefPath = path.join(outputDir, "research_brief.md")
    const briefJsonPath = path.join(outputDir, "research_brief.json")
    const sourcesPath = path.join(outputDir, "research_brief_sources.json")
    fs.writeFileSync(briefPath, renderResearchBriefMarkdown({ brief: briefJson, sources }), "utf-8")
    fs.writeFileSync(briefJsonPath, JSON.stringify(briefJson, null, 2), "utf-8")
    fs.writeFileSync(sourcesPath, JSON.stringify(sourcesDocument, null, 2), "utf-8")

    const visibleOutputs: Array<{ label: string; relativePath: string }> = []
    if (manifest) {
      const publish = (key: string, label: string, sourcePath: string) => {
        const visiblePath = publishVisibleOutput({
          manifest,
          key,
          label,
          sourcePath,
          runId,
          branch: path.join("research_brief", params.branch),
          stageId: params.stageId ?? datasetContext.stage?.stageId,
          metadata: {
            module: "research_brief",
            grounding_mode: groundingMode,
          },
        })
        visibleOutputs.push({
          label,
          relativePath: relativeWithinProject(visiblePath),
        })
      }
      publish("research_brief_markdown", "research_brief_markdown", briefPath)
      publish("research_brief_json", "research_brief_json", briefJsonPath)
      publish("research_brief_sources_json", "research_brief_sources_json", sourcesPath)
    }

    const manifestPath = manifest ? finalOutputsPath(manifest.sourcePath, runId) : undefined
    const output = [
      "## Research Brief Generated",
      "",
      `Run ID: ${runId}`,
      manifest?.datasetId ? `Dataset: ${manifest.datasetId}` : "",
      `Grounding mode: ${groundingMode}`,
      `Markdown: ${relativeWithinProject(briefPath)}`,
      `JSON: ${relativeWithinProject(briefJsonPath)}`,
      `Sources: ${relativeWithinProject(sourcesPath)}`,
      manifestPath ? `Final outputs manifest: ${relativeWithinProject(manifestPath)}` : "",
    ]
      .filter(Boolean)
      .join("\n")

    return {
      title: "Research Brief",
      output,
      metadata: {
        datasetId: manifest?.datasetId ?? params.datasetId,
        stageId: params.stageId ?? datasetContext.stage?.stageId,
        runId,
        groundingMode,
        outputDir: relativeWithinProject(outputDir),
        briefPath: relativeWithinProject(briefPath),
        briefJsonPath: relativeWithinProject(briefJsonPath),
        sourcesPath: relativeWithinProject(sourcesPath),
        finalOutputsPath: manifestPath ? relativeWithinProject(manifestPath) : undefined,
        visibleOutputs,
      } satisfies ResearchBriefMetadata,
    }
  },
})
