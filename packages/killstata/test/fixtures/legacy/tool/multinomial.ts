import z from "zod"
import fs from "fs"
import path from "path"
import { Tool } from "../../../../src/tool/tool"
import { ToolModel } from "../../../../src/tool/model-contracts"
import { Instance } from "../../../../src/project/instance"
import { ensureRuntimePythonReady, formatRuntimePythonSetupError } from "../../../../src/killstata/runtime-config"
import { assertDatasetStageReadyForEstimation } from "../../../../src/runtime/workflow"
import {
  appendArtifact,
  buildFileStamp,
  inferBranch,
  inferRunId,
  publishVisibleOutput,
  reportOutputPath,
  resolveArtifactInput,
} from "../../../../src/tool/analysis-state"
import { relativeWithinProject } from "../../../../src/tool/analysis-path"
import { ARTIFACT_SAVED_NOTICE, analysisArtifact, analysisMetric, createToolAnalysisView } from "../../../../src/tool/analysis-user-view"
import { refreshExperimentLog } from "../../../../src/tool/analysis-experiment-log"
import { numberText } from "../../../../src/util/number-text"
import { formatEstimate, formatPValue, renderCoefficientTable } from "../../../../src/util/coefficient-table"
import { runMultinomialBackend, type MultinomialPayload } from "./multinomial-backend"
import { type PrincipleChecks, buildPrincipleChecks, standardDiagnosticStatus } from "../../../../src/runtime/principle-checks"

const METHOD = "multinomial_logit" as const
const TOOL_LABEL = "多分类 Logit 回归"

const ColumnName = z.string().trim().min(1, "变量名不能为空")

const CanonicalStageFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空").describe("由 data_import 返回的当前会话数据集 ID。"),
  stageId: z.string().trim().min(1, "stageId 不能为空").describe("已通过 数据质量检查 且属于 datasetId 的估计输入阶段 ID。"),
  runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
  branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
}

const MultinomialInputSchema = z
  .object({
    ...CanonicalStageFields,
    dependentVar: ColumnName.describe("多类别结果变量列名，必须为整数编码（如 0/1/2，或 1/2/3）"),
    treatmentVar: ColumnName.describe("核心解释变量列名"),
    covariates: z.array(ColumnName).max(100, "控制变量最多 100 个").default([]).describe("研究设计确认的控制变量列名。"),
    covariance: z.enum(["nonrobust", "robust"]).default("nonrobust").describe("推断协方差：robust 使用 HC1 稳健标准误"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.covariates).size !== value.covariates.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["covariates"], message: "控制变量列表不能包含重复项" })
    }
    const regressors = [value.treatmentVar, ...value.covariates]
    if (regressors.includes(value.dependentVar)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dependentVar"], message: "因变量不能同时作为解释变量" })
    }
    if (value.covariates.includes(value.treatmentVar)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["covariates"],
        message: "核心解释变量不能在控制变量中重复出现",
      })
    }
  })

type MultinomialParams = z.infer<typeof MultinomialInputSchema>

function formatValidationError(error: z.ZodError) {
  return "计量工具参数不合法：" + error.issues.map((i) => `${i.path.join(".") || "参数"}：${i.message}`).join("；")
}

function buildPayload(params: MultinomialParams, dataPath: string, outputDir: string): MultinomialPayload {
  return {
    method: METHOD,
    dataPath,
    outputDir,
    dependentVar: params.dependentVar,
    treatmentVar: params.treatmentVar,
    covariates: params.covariates,
    covariance: params.covariance,
  }
}

async function executeMlogit(params: MultinomialParams, ctx: Tool.Context) {
  assertDatasetStageReadyForEstimation({
    sessionID: ctx.sessionID,
    datasetId: params.datasetId,
    stageId: params.stageId,
  })
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok || runtime.missing.length) throw new Error(formatRuntimePythonSetupError(METHOD, runtime))

  const artifactInput = resolveArtifactInput({ datasetId: params.datasetId, stageId: params.stageId })
  const dataPath = artifactInput.resolvedInputPath
  if (!dataPath || !fs.existsSync(dataPath)) throw new Error("找不到要分析的数据文件")

  const manifest = artifactInput.manifest
  const stage = artifactInput.stage
  const branch = inferBranch({ requestedBranch: params.branch, stage, source: "model" })
  const runId = inferRunId({ requestedRunId: params.runId, stage, source: "model" })
  const outputDir = manifest
    ? reportOutputPath({
        datasetId: manifest.datasetId,
        action: METHOD,
        stageId: params.stageId ?? stage?.stageId,
        branch,
        format: "json",
        stamp: buildFileStamp(),
      }).replace(/\.json$/, "")
    : path.join(Instance.directory, "analysis", `${METHOD}_${buildFileStamp()}`)
  fs.mkdirSync(outputDir, { recursive: true })

  await ctx.ask({
    permission: "bash",
    patterns: [`${runtime.executable} *multinomial*`],
    always: [`${runtime.executable} *multinomial*`],
    metadata: { description: `执行${TOOL_LABEL}`, managedRuntime: true },
  })

  const result = await runMultinomialBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    sessionID: ctx.sessionID,
    payload: buildPayload(params, dataPath, outputDir),
    abort: ctx.abort,
  })
  if (!result.resultPath || !result.coefficientsPath) throw new Error("多分类 Logit 已完成估计，但没有生成完整结果文件")

  let visibleResultPath = result.resultPath
  let visibleCoefficientsPath = result.coefficientsPath
  if (manifest) {
    appendArtifact(manifest, {
      artifactId: `${METHOD}_${Date.now()}`,
      runId,
      stageId: params.stageId ?? stage?.stageId,
      branch,
      action: METHOD,
      outputPath: result.resultPath,
      summaryPath: result.coefficientsPath,
      createdAt: new Date().toISOString(),
      metadata: {
        backend: "statsmodels",
        statsmodelsVersion: result.statsmodelsVersion,
        rowsUsed: result.rowsUsed,
        covariance: result.covariance,
        spec: params,
      },
    })
    visibleResultPath = publishVisibleOutput({
      manifest,
      key: `${METHOD}_result`,
      label: `${TOOL_LABEL}结果`,
      sourcePath: result.resultPath,
      runId,
      branch: path.join("econometrics", METHOD),
      stageId: params.stageId ?? stage?.stageId,
    })
    visibleCoefficientsPath = publishVisibleOutput({
      manifest,
      key: `${METHOD}_coefficients`,
      label: `${TOOL_LABEL}系数表`,
      sourcePath: result.coefficientsPath,
      runId,
      branch: path.join("econometrics", METHOD),
      stageId: params.stageId ?? stage?.stageId,
    })
    refreshExperimentLog(manifest.datasetId)
  }

  const pathTable = renderCoefficientTable(
    (result.treatmentPath ?? []).map((p) => ({ term: `类别 ${p.category}`, estimate: p.estimate, pValue: p.pValue, rrr: p.rrr })),
    [
      { header: "类别", value: (row) => row.term },
      { header: "系数", value: (row) => formatEstimate(row.estimate) },
      { header: "RRR", value: (row) => formatEstimate(row.rrr) },
      { header: "p 值", value: (row) => formatPValue(row.pValue) },
    ],
  )

  const output = [
    `${TOOL_LABEL}已完成。`,
    `后端：statsmodels ${result.statsmodelsVersion ?? "版本未知"}`,
    `有效样本：${result.rowsUsed ?? "未提供"}（${result.nCategories} 个类别，基准类别 = ${result.baselineCategory}）`,
    `伪 R²（McFadden）：${numberText(result.pseudoRSquared, 4)}；预测准确率：${numberText(result.accuracy, 3)}`,
    result.covariance === "HC1" ? "推断方式：HC1 稳健标准误" : "推断方式：常规最大似然标准误",
    ...(result.warnings ?? []).map((w) => `提示：${w}`),
    "",
    `核心解释变量 ${params.treatmentVar} 在各非基准类别上的效应（vs 基准类别 ${result.baselineCategory}）：`,
    pathTable,
    result.primary
      ? `\n最显著类别（类别 ${result.primary.category}）：系数 ${numberText(result.primary.estimate)}，RRR ${numberText(result.primaryRrr?.rrr)}`
      : "",
    "\n解释指引：系数为对数几率尺度（vs 基准），正系数表示相对基准更可能选该类；RRR = exp(系数)，>1 表示概率上升的倍数。",
    "",
    ARTIFACT_SAVED_NOTICE,
  ]
    .filter(Boolean)
    .join("\n")

  // ── 声明上限：模型对结果的措辞强度 ──
  {
    const standard = standardDiagnosticStatus(result)
    ;(result as { principle_checks?: PrincipleChecks }).principle_checks = buildPrincipleChecks({
      method: METHOD,
      prereqStatus: "pass",
      diagnosticsStatus: standard.status,
      findings: standard.findings,
    })
  }

  return {
    title: TOOL_LABEL,
    output,
    metadata: {
      method: METHOD,
      backend: "statsmodels",
      statsmodelsVersion: result.statsmodelsVersion,
      datasetId: manifest?.datasetId ?? params.datasetId,
      stageId: params.stageId ?? stage?.stageId,
      runId,
      result,
      analysisView: createToolAnalysisView({
        kind: "econometrics",
        step: METHOD,
        datasetId: manifest?.datasetId ?? params.datasetId,
        stageId: params.stageId ?? stage?.stageId,
        results: [
          analysisMetric(
            `${params.treatmentVar} 最显著类别效应`,
            result.primary?.estimate !== null ? numberText(result.primary!.estimate) : undefined,
          ),
          analysisMetric("伪 R²", numberText(result.pseudoRSquared)),
          analysisMetric("准确率", numberText(result.accuracy)),
          analysisMetric("类别数", result.nCategories),
          analysisMetric("N", result.rowsUsed),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(visibleResultPath), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(visibleCoefficientsPath), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: `${TOOL_LABEL}已完成，类别 ${result.baselineCategory} 为基准；各系数为相对于基准的对数几率，RRR 为倍数比。`,
      }),
    },
  }
}

export const MultinomialLogitTool = Tool.define(METHOD, Tool.Execution.managedFilesystem, ToolModel.forTool(METHOD), {
  description:
    "使用 statsmodels 对多类别（>2）无序结果变量执行 Multinomial Logit（MNL）最大似然估计，返回各非基准类别相对于基准类别的系数与相对风险比（RRR）。系数为对数几率尺度（正=更可能选该类 vs 基准），RRR 为倍数比。默认以最小取值的类别为基准。",
  parameters: MultinomialInputSchema,
  formatValidationError,
  execute: executeMlogit,
})

export const MultinomialEconometricsTools = [MultinomialLogitTool] as const
// @ts-nocheck
