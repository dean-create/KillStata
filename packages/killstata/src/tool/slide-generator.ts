import fs from "fs"
import path from "path"
import z from "zod"
import DESCRIPTION from "./slide-generator.txt"
import { Tool } from "./tool"
import { generatedArtifactRoot, loadResultBundle, readJsonFile, resolvePublishedJsonPath } from "./analysis-artifacts"
import { finalOutputsPath, inferRunId, publishVisibleOutput, readDatasetManifest } from "./analysis-state"
import { relativeWithinProject, resolveToolPath, resolveWorkspacePath } from "./analysis-path"

export const SlideGeneratorInputSchema = z.object({
  datasetId: z.string().optional(),
  researchBriefPath: z.string().optional(),
  researchBriefOutputKey: z.string().optional(),
  paperDraftPath: z.string().optional(),
  paperDraftOutputKey: z.string().optional(),
  baselineResultDir: z.string().optional(),
  baselineOutputKey: z.string().optional(),
  directResultPath: z.string().optional(),
  heterogeneityBundlePath: z.string().optional(),
  heterogeneityBundleOutputKey: z.string().optional(),
  tablePaths: z.array(z.string()).default([]),
  figurePaths: z.array(z.string()).default([]),
  slideCount: z.number().int().min(8).max(12).default(10),
  audience: z.string().default("academic_seminar"),
  outputLanguage: z.string().default("zh-CN"),
  runId: z.string().optional(),
  branch: z.string().default("main"),
  outputDir: z.string().optional(),
})

export type SlideDeckResult = {
  audience: string
  language: string
  slides: Array<{
    slide_number: number
    slide_title: string
    key_claims: string[]
    grounded_numbers: Array<{ label: string; value: number | undefined; source: string }>
    source_artifacts: string[]
    recommended_visual: string
    speaker_notes_ref: string
  }>
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
  return resolvePublishedJsonPath({ datasetId: input.datasetId, outputKey: input.outputKey }).path
}

export const SlideGeneratorTool = Tool.define("slide_generator", {
  description: DESCRIPTION,
  parameters: SlideGeneratorInputSchema,
  async execute(params, ctx) {
    const briefPath = resolveJsonPath({
      datasetId: params.datasetId,
      directPath: params.researchBriefPath,
      outputKey: params.researchBriefOutputKey,
    })
    if (!briefPath || !fs.existsSync(briefPath)) {
      throw new Error("slide_generator requires researchBriefPath or researchBriefOutputKey.")
    }

    const paperDraftPath = resolveJsonPath({
      datasetId: params.datasetId,
      directPath: params.paperDraftPath,
      outputKey: params.paperDraftOutputKey,
    })
    const baseline = loadResultBundle({
      datasetId: params.datasetId,
      resultDir: params.baselineResultDir,
      outputKey: params.baselineOutputKey,
      directResultPath: params.directResultPath,
      runId: params.runId,
    })

    const brief = readJsonFile<Record<string, any>>(briefPath)
    const paperDraft = paperDraftPath && fs.existsSync(paperDraftPath) ? readJsonFile<Record<string, any>>(paperDraftPath) : undefined
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
          toolName: "slide_generator",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
        })
      : generatedArtifactRoot({ module: "slide_generator", runId, branch: params.branch })
    fs.mkdirSync(outputDir, { recursive: true })

    const coefficient = typeof baseline.results.coefficient === "number" ? baseline.results.coefficient : undefined
    const pValue = typeof baseline.results.p_value === "number" ? baseline.results.p_value : undefined
    const rows = typeof baseline.results.rows_used === "number" ? baseline.results.rows_used : baseline.metadata?.rows_used
    const heterogeneityCount = Array.isArray(heterogeneityBundle?.specs)
      ? heterogeneityBundle.specs.filter((item: any) => item.status === "success" && item.spec_type === "heterogeneity").length
      : 0
    const mechanismCount = Array.isArray(heterogeneityBundle?.specs)
      ? heterogeneityBundle.specs.filter((item: any) => item.status === "success" && item.spec_type === "mechanism").length
      : 0

    const baseSlides = [
      {
        slide_number: 1,
        slide_title: "题目、作者、核心问题",
        key_claims: [brief.core_question ?? brief.idea ?? "待补充"],
        grounded_numbers: [],
        source_artifacts: [relativeWithinProject(briefPath)],
        recommended_visual: "Title slide",
      },
      {
        slide_number: 2,
        slide_title: "研究背景与现实动机",
        key_claims: [brief.idea ?? "待补充研究动机"],
        grounded_numbers: [],
        source_artifacts: [relativeWithinProject(briefPath)],
        recommended_visual: "Context timeline or motivation graphic",
      },
      {
        slide_number: 3,
        slide_title: "文献/制度/政策切入点",
        key_claims: ["从制度背景或政策冲击切入，建立研究问题与识别可行性。"],
        grounded_numbers: [],
        source_artifacts: [relativeWithinProject(briefPath)],
        recommended_visual: "Policy timeline or institutional map",
      },
      {
        slide_number: 4,
        slide_title: "理论机制与研究假说",
        key_claims: Array.isArray(brief.testable_hypotheses) ? brief.testable_hypotheses.slice(0, 3) : ["待补充假说"],
        grounded_numbers: [],
        source_artifacts: [relativeWithinProject(briefPath)],
        recommended_visual: "Mechanism diagram",
      },
      {
        slide_number: 5,
        slide_title: "识别策略与经验设计",
        key_claims: [brief.preferred_design?.name ?? "待补充识别设计"],
        grounded_numbers: [],
        source_artifacts: [relativeWithinProject(briefPath)],
        recommended_visual: "Design flow or identification diagram",
      },
      {
        slide_number: 6,
        slide_title: "数据与变量",
        key_claims: [
          `样本量：${rows ?? "待补充"}`,
          `结果变量：${brief.variable_blueprint?.outcome ?? "待补充"}`,
          `处理变量：${brief.variable_blueprint?.treatment ?? "待补充"}`,
        ],
        grounded_numbers: rows !== undefined ? [{ label: "rows_used", value: rows, source: relativeWithinProject(baseline.resultPath) }] : [],
        source_artifacts: [relativeWithinProject(briefPath), relativeWithinProject(baseline.resultPath)],
        recommended_visual: params.figurePaths[0] ?? "Descriptive table or variable summary",
      },
      {
        slide_number: 7,
        slide_title: "基准结果",
        key_claims: [
          `基准系数：${coefficient?.toFixed(6) ?? "待补充"}`,
          `p-value：${pValue?.toFixed(6) ?? "待补充"}`,
        ],
        grounded_numbers:
          coefficient !== undefined
            ? [
                { label: "coefficient", value: coefficient, source: relativeWithinProject(baseline.resultPath) },
                { label: "p_value", value: pValue, source: relativeWithinProject(baseline.resultPath) },
              ]
            : [],
        source_artifacts: [relativeWithinProject(baseline.resultPath)],
        recommended_visual: params.tablePaths[0] ?? "Regression table",
      },
      {
        slide_number: 8,
        slide_title: "稳健性检验",
        key_claims: [
          heterogeneityBundle ? "已生成扩展稳健性/替代口径 bundle。" : "待补充稳健性 bundle。",
        ],
        grounded_numbers: [],
        source_artifacts: heterogeneityBundlePath ? [relativeWithinProject(heterogeneityBundlePath)] : [],
        recommended_visual: params.tablePaths[1] ?? "Robustness comparison table",
      },
      {
        slide_number: 9,
        slide_title: "异质性与机制分析",
        key_claims: [
          heterogeneityBundle ? `异质性成功规格数：${heterogeneityCount}` : "待补充异质性结果",
          heterogeneityBundle ? `机制成功规格数：${mechanismCount}` : "待补充机制结果",
        ],
        grounded_numbers: heterogeneityBundle
          ? [
              { label: "heterogeneity_specs", value: heterogeneityCount, source: relativeWithinProject(heterogeneityBundlePath!) },
              { label: "mechanism_specs", value: mechanismCount, source: relativeWithinProject(heterogeneityBundlePath!) },
            ]
          : [],
        source_artifacts: heterogeneityBundlePath ? [relativeWithinProject(heterogeneityBundlePath)] : [],
        recommended_visual: params.tablePaths[2] ?? "Heterogeneity summary table",
      },
      {
        slide_number: 10,
        slide_title: "结论、贡献、局限与 Q&A",
        key_claims: [
          "总结核心发现、边界条件与后续工作。",
          paperDraft ? "可与论文初稿叙述保持一致。" : "建议在论文初稿完成后同步更新本页结论口径。",
        ],
        grounded_numbers: [],
        source_artifacts: [
          ...(paperDraftPath ? [relativeWithinProject(paperDraftPath)] : []),
          relativeWithinProject(baseline.resultPath),
        ],
        recommended_visual: "Closing summary slide",
      },
    ]

    const slides = baseSlides.slice(0, params.slideCount).map((item) => ({
      ...item,
      speaker_notes_ref: `notes_${item.slide_number}`,
    }))

    const slidesPath = path.join(outputDir, "slides.md")
    const slidesJsonPath = path.join(outputDir, "slides.json")
    const notesPath = path.join(outputDir, "speaker_notes.md")
    const assetManifestPath = path.join(outputDir, "slide_asset_manifest.json")

    const slidesMarkdown = [
      "# 学术汇报",
      "",
      ...slides.flatMap((slide) => [
        `## ${slide.slide_number}. ${slide.slide_title}`,
        ...slide.key_claims.map((item) => `- ${item}`),
        `- Recommended visual: ${slide.recommended_visual}`,
        "",
      ]),
    ].join("\n")
    fs.writeFileSync(slidesPath, slidesMarkdown, "utf-8")
    fs.writeFileSync(slidesJsonPath, JSON.stringify({ audience: params.audience, language: params.outputLanguage, slides }, null, 2), "utf-8")
    fs.writeFileSync(
      notesPath,
      ["# Speaker Notes", "", ...slides.flatMap((slide) => [`## ${slide.speaker_notes_ref}`, `围绕“${slide.slide_title}”展开，逐条解释当前 grounded claim，并指出待补充部分。`, ""])].join("\n"),
      "utf-8",
    )
    fs.writeFileSync(
      assetManifestPath,
      JSON.stringify(
        {
          table_paths: params.tablePaths.map((item) => relativeWithinProject(resolveWorkspacePath(item))),
          figure_paths: params.figurePaths.map((item) => relativeWithinProject(resolveWorkspacePath(item))),
          research_brief_path: relativeWithinProject(briefPath),
          paper_draft_path: paperDraftPath ? relativeWithinProject(paperDraftPath) : undefined,
          baseline_result_path: relativeWithinProject(baseline.resultPath),
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
          branch: path.join("slide_generator", params.branch),
          metadata: { audience: params.audience, slideCount: params.slideCount },
        })
        visibleOutputs.push({ label, relativePath: relativeWithinProject(visiblePath) })
      }
      publish("slides_markdown", "slides_markdown", slidesPath)
      publish("slides_json", "slides_json", slidesJsonPath)
      publish("speaker_notes_md", "speaker_notes_md", notesPath)
      publish("slide_asset_manifest_json", "slide_asset_manifest_json", assetManifestPath)
    }

    const manifestPath = manifest ? finalOutputsPath(manifest.sourcePath, runId) : undefined
    return {
      title: "Slide Generator",
      output: [
        "## Slide Deck Generated",
        "",
        `Run ID: ${runId}`,
        `Slides: ${relativeWithinProject(slidesPath)}`,
        `Deck spec: ${relativeWithinProject(slidesJsonPath)}`,
        `Speaker notes: ${relativeWithinProject(notesPath)}`,
        manifestPath ? `Final outputs manifest: ${relativeWithinProject(manifestPath)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        datasetId,
        runId,
        outputDir: relativeWithinProject(outputDir),
        slidesPath: relativeWithinProject(slidesPath),
        slidesJsonPath: relativeWithinProject(slidesJsonPath),
        notesPath: relativeWithinProject(notesPath),
        assetManifestPath: relativeWithinProject(assetManifestPath),
        visibleOutputs,
        finalOutputsPath: manifestPath ? relativeWithinProject(manifestPath) : undefined,
      },
    }
  },
})
