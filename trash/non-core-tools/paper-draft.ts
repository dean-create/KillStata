import fs from "fs"
import path from "path"
import z from "zod"
import DESCRIPTION from "./paper-draft.txt"
import { Tool } from "./tool"
import { generatedArtifactRoot, loadResultBundle, readJsonFile, resolvePublishedJsonPath } from "./analysis-artifacts"
import { finalOutputsPath, inferRunId, publishVisibleOutput, readDatasetManifest } from "./analysis-state"
import { relativeWithinProject, resolveToolPath, resolveWorkspacePath } from "./analysis-path"
import { createToolDisplay } from "./analysis-display"
import { analysisArtifact, analysisMetric, createToolAnalysisView } from "./analysis-user-view"

export const PaperDraftInputSchema = z.object({
  datasetId: z.string().optional(),
  researchBriefPath: z.string().optional(),
  researchBriefOutputKey: z.string().optional(),
  baselineResultDir: z.string().optional(),
  baselineOutputKey: z.string().optional(),
  directResultPath: z.string().optional(),
  heterogeneityBundlePath: z.string().optional(),
  heterogeneityBundleOutputKey: z.string().optional(),
  tablePaths: z.array(z.string()).default([]),
  figurePaths: z.array(z.string()).default([]),
  targetTemplate: z.string().default("empirical_cn_journal"),
  outputLanguage: z.string().default("zh-CN"),
  runId: z.string().optional(),
  branch: z.string().default("main"),
  outputDir: z.string().optional(),
})

export type PaperSectionTrace = {
  section: string
  grounded: boolean
  sources: string[]
  numeric_sources: string[]
}

export type PaperDraftResult = {
  template: string
  language: string
  sections: PaperSectionTrace[]
}

function resolveJsonPath(input: { datasetId?: string; directPath?: string; outputKey?: string }) {
  if (input.directPath) {
    const normalized = resolveWorkspacePath(input.directPath)
    if (path.extname(normalized).toLowerCase() === ".md") {
      const sibling = normalized.replace(/\.md$/i, ".json")
      if (fs.existsSync(sibling)) return sibling
    }
    return normalized
  }
  if (!input.datasetId || !input.outputKey) return undefined
  return resolvePublishedJsonPath({
    datasetId: input.datasetId,
    outputKey: input.outputKey,
  }).path
}

function textSection(title: string, body: string[]) {
  return [`## ${title}`, ...body, ""].join("\n")
}

export const PaperDraftTool = Tool.define("paper_draft", {
  description: DESCRIPTION,
  parameters: PaperDraftInputSchema,
  async execute(params, ctx) {
    const briefJsonPath = resolveJsonPath({
      datasetId: params.datasetId,
      directPath: params.researchBriefPath,
      outputKey: params.researchBriefOutputKey,
    })
    if (!briefJsonPath || !fs.existsSync(briefJsonPath)) {
      throw new Error("paper_draft requires researchBriefPath or researchBriefOutputKey.")
    }

    const baseline = loadResultBundle({
      datasetId: params.datasetId,
      resultDir: params.baselineResultDir,
      outputKey: params.baselineOutputKey,
      directResultPath: params.directResultPath,
      runId: params.runId,
    })
    const brief = readJsonFile<Record<string, any>>(briefJsonPath)

    const heterogeneityBundlePath = resolveJsonPath({
      datasetId: params.datasetId ?? baseline.datasetId,
      directPath: params.heterogeneityBundlePath,
      outputKey: params.heterogeneityBundleOutputKey,
    })
    const heterogeneityBundle =
      heterogeneityBundlePath && fs.existsSync(heterogeneityBundlePath)
        ? readJsonFile<Record<string, any>>(heterogeneityBundlePath)
        : undefined

    const datasetId = params.datasetId ?? baseline.datasetId
    const manifest = datasetId ? readDatasetManifest(datasetId) : baseline.manifest
    const runId = inferRunId({ requestedRunId: params.runId ?? baseline.runId })
    const outputDir = params.outputDir
      ? await resolveToolPath({
          filePath: params.outputDir,
          mode: "write",
          toolName: "paper_draft",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
      : generatedArtifactRoot({ module: "paper_draft", runId, branch: params.branch })
    fs.mkdirSync(outputDir, { recursive: true })

    const coeff = typeof baseline.results.coefficient === "number" ? baseline.results.coefficient : undefined
    const pValue = typeof baseline.results.p_value === "number" ? baseline.results.p_value : undefined
    const r2 = typeof baseline.results.r_squared === "number" ? baseline.results.r_squared : undefined
    const rows = typeof baseline.results.rows_used === "number" ? baseline.results.rows_used : baseline.metadata?.rows_used
    const heterogeneitySpecs = Array.isArray(heterogeneityBundle?.specs)
      ? heterogeneityBundle.specs.filter((item: any) => item.spec_type === "heterogeneity" && item.status === "success")
      : []
    const mechanismSpecs = Array.isArray(heterogeneityBundle?.specs)
      ? heterogeneityBundle.specs.filter((item: any) => item.spec_type === "mechanism" && item.status === "success")
      : []

    const sections: Array<{ title: string; markdown: string }> = []
    const traces: PaperSectionTrace[] = []
    const pushSection = (title: string, body: string[], grounded: boolean, sources: string[], numericSources: string[]) => {
      sections.push({ title, markdown: textSection(title, body) })
      traces.push({ section: title, grounded, sources, numeric_sources: numericSources })
    }

    pushSection(
      "标题与摘要",
      [
        `建议标题：${brief.core_question ?? brief.idea ?? "待补充标题"}`,
        "",
        `摘要：本文围绕“${brief.core_question ?? brief.idea ?? "待补充研究问题"}”展开研究，基于${brief.preferred_design?.name ?? "基准识别设计"}构建经验策略。当前基准结果显示核心处理效应系数为 ${coeff?.toFixed(6) ?? "待补充"}，p-value 为 ${pValue?.toFixed(6) ?? "待补充"}。后续将围绕机制、稳健性与异质性进一步展开。`,
      ],
      coeff !== undefined,
      [relativeWithinProject(briefJsonPath), relativeWithinProject(baseline.resultPath)],
      [relativeWithinProject(baseline.resultPath)],
    )
    pushSection(
      "研究背景与问题提出",
      [
        brief.idea ?? "待补充研究背景",
        brief.core_question ?? "待补充核心问题",
      ],
      false,
      [relativeWithinProject(briefJsonPath)],
      [],
    )
    pushSection(
      "理论机制与研究假说",
      [
        ...(Array.isArray(brief.theory_and_mechanisms)
          ? brief.theory_and_mechanisms.map((item: any) => `- ${item.name}: ${item.rationale}`)
          : ["- 待补充理论机制"]),
        ...(Array.isArray(brief.testable_hypotheses) ? ["", ...brief.testable_hypotheses.map((item: string) => `- ${item}`)] : []),
      ],
      false,
      [relativeWithinProject(briefJsonPath)],
      [],
    )
    pushSection(
      "制度背景与政策脉络",
      [
        "本节基于 research brief 中的制度与公开背景线索撰写，正式交稿前应补充人工核对后的制度细节与文献综述。",
        brief.context ?? "待补充制度背景",
      ],
      false,
      [relativeWithinProject(briefJsonPath)],
      [],
    )
    pushSection(
      "数据、变量与描述性统计",
      [
        `样本单位：${brief.required_data?.target_units ?? "待补充"}`,
        `时间范围：${brief.required_data?.time_span ?? "待补充"}`,
        `核心变量：结果变量 ${brief.variable_blueprint?.outcome ?? "待补充"}，处理变量 ${brief.variable_blueprint?.treatment ?? "待补充"}。`,
        `当前基准回归使用样本量 ${rows ?? "待补充"}。`,
      ],
      rows !== undefined,
      [relativeWithinProject(briefJsonPath), relativeWithinProject(baseline.resultPath)],
      [relativeWithinProject(baseline.resultPath)],
    )
    pushSection(
      "识别策略与模型设定",
      [
        `推荐设计：${brief.preferred_design?.name ?? "待补充"}`,
        `识别假设：${Array.isArray(brief.preferred_design?.identifying_assumptions) ? brief.preferred_design.identifying_assumptions.join("；") : "待补充"}`,
        `最小数据要求：${Array.isArray(brief.preferred_design?.minimum_data_requirements) ? brief.preferred_design.minimum_data_requirements.join("；") : "待补充"}`,
      ],
      false,
      [relativeWithinProject(briefJsonPath)],
      [],
    )
    pushSection(
      "基准结果",
      [
        `基准结果显示，核心处理效应系数为 ${coeff?.toFixed(6) ?? "待补充"}，p-value 为 ${pValue?.toFixed(6) ?? "待补充"}，R-squared 为 ${r2?.toFixed(6) ?? "待补充"}。`,
        `当前结果文件：${relativeWithinProject(baseline.resultPath)}。`,
      ],
      coeff !== undefined,
      [relativeWithinProject(baseline.resultPath)],
      [relativeWithinProject(baseline.resultPath)],
    )
    pushSection(
      "稳健性检验",
      [
        heterogeneityBundle
          ? `已读取扩展 bundle：${relativeWithinProject(heterogeneityBundlePath!)}。placebo 或替代口径结果可在附属摘要中查看。`
          : "待补充：尚未提供 placebo 或替代口径扩展 bundle。",
      ],
      Boolean(heterogeneityBundle),
      heterogeneityBundlePath ? [relativeWithinProject(heterogeneityBundlePath)] : [],
      heterogeneityBundlePath ? [relativeWithinProject(heterogeneityBundlePath)] : [],
    )
    pushSection(
      "异质性与机制分析",
      heterogeneityBundle
        ? [
            heterogeneitySpecs.length
              ? `异质性分析已完成 ${heterogeneitySpecs.length} 个成功规格。`
              : "待补充：异质性规格尚未成功执行。",
            mechanismSpecs.length
              ? `机制分析已完成 ${mechanismSpecs.length} 个成功规格。`
              : "待补充：机制规格尚未成功执行。",
          ]
        : ["待补充：尚未提供异质性或机制分析 bundle。"],
      Boolean(heterogeneityBundle),
      heterogeneityBundlePath ? [relativeWithinProject(heterogeneityBundlePath)] : [],
      heterogeneityBundlePath ? [relativeWithinProject(heterogeneityBundlePath)] : [],
    )
    pushSection(
      "结论与政策含义",
      [
        "基于当前 research brief 与基准估计结果，可以先形成一个保守结论：核心处理变量与结果变量之间存在待进一步验证的经验关系。",
        "正式定稿前应补足稳健性、异质性和机制证据后，再上升到政策含义。",
      ],
      coeff !== undefined,
      [relativeWithinProject(briefJsonPath), relativeWithinProject(baseline.resultPath)],
      coeff !== undefined ? [relativeWithinProject(baseline.resultPath)] : [],
    )
    pushSection(
      "局限性与后续工作",
      [
        ...(Array.isArray(brief.validity_risks) ? brief.validity_risks.map((item: string) => `- ${item}`) : ["- 待补充局限性"]),
        "后续工作包括：补充稳健性、异质性、机制证据，以及正式文献综述。",
      ],
      false,
      [relativeWithinProject(briefJsonPath)],
      [],
    )

    const paperDraftPath = path.join(outputDir, "paper_draft.md")
    const paperDraftJsonPath = path.join(outputDir, "paper_draft.json")
    const appendixPath = path.join(outputDir, "paper_appendix_outline.md")
    const assetManifestPath = path.join(outputDir, "paper_asset_manifest.json")

    const paperMarkdown = ["# 论文初稿", "", ...sections.map((item) => item.markdown)].join("\n")
    fs.writeFileSync(paperDraftPath, paperMarkdown, "utf-8")
    fs.writeFileSync(
      paperDraftJsonPath,
      JSON.stringify(
        {
          template: params.targetTemplate,
          language: params.outputLanguage,
          research_brief_path: relativeWithinProject(briefJsonPath),
          baseline_result_path: relativeWithinProject(baseline.resultPath),
          heterogeneity_bundle_path: heterogeneityBundlePath ? relativeWithinProject(heterogeneityBundlePath) : undefined,
          sections: traces,
        },
        null,
        2,
      ),
      "utf-8",
    )
    fs.writeFileSync(
      appendixPath,
      ["# Appendix Outline", "", "- Data dictionary", "- Variable construction details", "- Additional robustness tables", "- Heterogeneity appendix", "- Mechanism appendix", ""].join("\n"),
      "utf-8",
    )
    fs.writeFileSync(
      assetManifestPath,
      JSON.stringify(
        {
          table_paths: params.tablePaths.map((item) => relativeWithinProject(resolveWorkspacePath(item))),
          figure_paths: params.figurePaths.map((item) => relativeWithinProject(resolveWorkspacePath(item))),
          baseline_result_path: relativeWithinProject(baseline.resultPath),
          research_brief_path: relativeWithinProject(briefJsonPath),
          heterogeneity_bundle_path: heterogeneityBundlePath ? relativeWithinProject(heterogeneityBundlePath) : undefined,
        },
        null,
        2,
      ),
      "utf-8",
    )

    const visibleOutputs: Array<{ label: string; relativePath: string }> = []
    if (manifest) {
      const publish = (key: string, label: string, sourcePath: string) => {
        const visiblePath = publishVisibleOutput({
          manifest,
          key,
          label,
          sourcePath,
          runId,
          branch: path.join("paper_draft", params.branch),
          metadata: { template: params.targetTemplate },
        })
        visibleOutputs.push({ label, relativePath: relativeWithinProject(visiblePath) })
      }
      publish("paper_draft_markdown", "paper_draft_markdown", paperDraftPath)
      publish("paper_draft_json", "paper_draft_json", paperDraftJsonPath)
      publish("paper_appendix_outline_md", "paper_appendix_outline_md", appendixPath)
      publish("paper_asset_manifest_json", "paper_asset_manifest_json", assetManifestPath)
    }

    const manifestPath = manifest ? finalOutputsPath(manifest.sourcePath, runId) : undefined
    return {
      title: "Paper Draft",
      output: [
        "## Paper Draft Generated",
        "",
        `Run ID: ${runId}`,
        `Markdown: ${relativeWithinProject(paperDraftPath)}`,
        `JSON: ${relativeWithinProject(paperDraftJsonPath)}`,
        `Appendix: ${relativeWithinProject(appendixPath)}`,
        manifestPath ? `Final outputs manifest: ${relativeWithinProject(manifestPath)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        datasetId,
        runId,
        outputDir: relativeWithinProject(outputDir),
        paperDraftPath: relativeWithinProject(paperDraftPath),
        paperDraftJsonPath: relativeWithinProject(paperDraftJsonPath),
        appendixPath: relativeWithinProject(appendixPath),
        assetManifestPath: relativeWithinProject(assetManifestPath),
        visibleOutputs,
        finalOutputsPath: manifestPath ? relativeWithinProject(manifestPath) : undefined,
        analysisView: createToolAnalysisView({
          kind: "paper_draft",
          step: "paper_draft",
          datasetId,
          stageId: baseline.stageId,
          results: [
            analysisMetric("template", params.targetTemplate),
            analysisMetric("sections", traces.length),
            analysisMetric("grounded sections", traces.filter((item) => item.grounded).length),
          ],
          artifacts: [
            analysisArtifact(relativeWithinProject(paperDraftPath), {
              label: "paper_draft.md",
              visibility: "user_default",
            }),
            analysisArtifact(relativeWithinProject(paperDraftJsonPath), {
              label: "paper_draft.json",
              visibility: "user_collapsed",
            }),
            analysisArtifact(relativeWithinProject(appendixPath), {
              label: "paper_appendix_outline.md",
              visibility: "user_collapsed",
            }),
            ...visibleOutputs.map((item) =>
              analysisArtifact(item.relativePath, {
                label: item.label,
                visibility: "user_collapsed",
              }),
            ),
          ],
          conclusion: "论文草稿已生成，建议先查看 paper_draft.md，再补充稳健性、异质性和正式文献综述。",
        }),
        display: createToolDisplay({
          summary: `paper_draft generated using template ${params.targetTemplate}`,
          details: [
            `Run ID: ${runId}`,
            `Baseline result: ${relativeWithinProject(baseline.resultPath)}`,
            heterogeneityBundlePath ? `Heterogeneity bundle: ${relativeWithinProject(heterogeneityBundlePath)}` : undefined,
          ],
          artifacts: visibleOutputs.map((item) => ({
            label: item.label,
            path: item.relativePath,
            visibility: "user_collapsed" as const,
          })),
        }),
      },
    }
  },
})
