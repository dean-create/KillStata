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
import { renderCoefficientTable } from "../../../../src/util/coefficient-table"
import { runQuantileBackend, type QuantilePayload } from "./quantile-backend"
import { type PrincipleChecks, buildPrincipleChecks, standardDiagnosticStatus } from "../../../../src/runtime/principle-checks"

const METHOD = "quantile_regression" as const
const TOOL_LABEL = "分位数回归"

const ColumnName = z.string().trim().min(1, "变量名不能为空")

const CanonicalStageFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空").describe("由 data_import 返回的当前会话数据集 ID。"),
  stageId: z.string().trim().min(1, "stageId 不能为空").describe("已通过 数据质量检查 且属于 datasetId 的估计输入阶段 ID。"),
  runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
  branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
}

const QuantileInputSchema = z
  .object({
    ...CanonicalStageFields,
    dependentVar: ColumnName.describe("连续结果变量列名"),
    treatmentVar: ColumnName.describe("核心解释变量列名"),
    covariates: z.array(ColumnName).max(100, "控制变量最多 100 个").default([]).describe("研究设计确认的控制变量列名。"),
    quantiles: z
      .array(z.number().gt(0, "分位点必须大于 0").lt(1, "分位点必须小于 1"))
      .min(1, "至少需要一个分位点")
      .max(9, "分位点最多 9 个")
      .default([0.25, 0.5, 0.75])
      .describe("要估计的分位点，取值在 0 和 1 之间（开区间）；默认 [0.25, 0.5, 0.75]"),
    covariance: z
      .enum(["robust", "iid"])
      .default("robust")
      .describe("推断协方差：robust 使用核估计的稳健标准误（默认），iid 假设误差同分布"),
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
    if (new Set(value.quantiles).size !== value.quantiles.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["quantiles"], message: "分位点列表不能包含重复值" })
    }
  })

type QuantileParams = z.infer<typeof QuantileInputSchema>

function formatValidationError(error: z.ZodError) {
  const detail = error.issues.map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`).join("；")
  return `计量工具参数不合法：${detail}`
}

function buildPayload(params: QuantileParams, dataPath: string, outputDir: string): QuantilePayload {
  return {
    method: METHOD,
    dataPath,
    outputDir,
    dependentVar: params.dependentVar,
    treatmentVar: params.treatmentVar,
    covariates: params.covariates,
    quantiles: params.quantiles,
    covariance: params.covariance,
  }
}

async function executeQuantile(params: QuantileParams, ctx: Tool.Context) {
  assertDatasetStageReadyForEstimation({
    sessionID: ctx.sessionID,
    datasetId: params.datasetId,
    stageId: params.stageId,
  })
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok || runtime.missing.length) {
    throw new Error(formatRuntimePythonSetupError(METHOD, runtime))
  }

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
    patterns: [`${runtime.executable} *quantile*`],
    always: [`${runtime.executable} *quantile*`],
    metadata: { description: `执行${TOOL_LABEL}`, managedRuntime: true },
  })

  const result = await runQuantileBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    sessionID: ctx.sessionID,
    payload: buildPayload(params, dataPath, outputDir),
    abort: ctx.abort,
  })
  if (!result.resultPath || !result.coefficientsPath) {
    throw new Error("分位数回归已完成估计，但没有生成完整结果文件")
  }

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

  const primary = result.primary
  const pathTable = renderCoefficientTable(
    (result.treatmentPath ?? []).map((point) => ({ term: `分位点 ${point.tau}`, estimate: point.estimate, stdError: point.stdError, pValue: point.pValue })),
  )
  const output = [
    `${TOOL_LABEL}已完成。`,
    `后端：statsmodels ${result.statsmodelsVersion ?? "版本未知"}`,
    `有效样本：${result.rowsUsed ?? "未提供"}；估计分位点：${(result.quantiles ?? []).join("、")}`,
    result.covariance === "iid" ? "推断方式：iid 标准误" : "推断方式：核估计稳健标准误",
    ...(result.warnings ?? []).map((warning) => `提示：${warning}`),
    "",
    `核心解释变量 ${params.treatmentVar} 的分位效应路径（系数即该分位点上的边际效应）：`,
    pathTable,
    "",
    `主报告分位点 ${result.primaryTau}（最接近中位数）：${params.treatmentVar} 系数 ${numberText(primary?.estimate)}，`,
    `  p 值 ${numberText(primary?.pValue)}`,
    "",
    ARTIFACT_SAVED_NOTICE,
  ].join("\n")

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
            `${params.treatmentVar} 中位效应`,
            primary?.estimate !== null && primary?.estimate !== undefined ? numberText(primary.estimate) : undefined,
          ),
          analysisMetric(
            "分位效应区间",
            (() => {
              const est = (result.treatmentPath ?? [])
                .map((p) => p.estimate)
                .filter((v): v is number => typeof v === "number")
              if (est.length < 2) return undefined
              return `${numberText(Math.min(...est))} ~ ${numberText(Math.max(...est))}`
            })(),
          ),
          analysisMetric(
            "p 值",
            primary?.pValue !== null && primary?.pValue !== undefined ? numberText(primary.pValue) : undefined,
          ),
          analysisMetric("N", result.rowsUsed),
          analysisMetric("分位点数", (result.quantiles ?? []).length),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(visibleResultPath), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(visibleCoefficientsPath), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: `${TOOL_LABEL}已完成，各系数是对应分位点上的边际效应；核心解释变量的效应随分位点变化即为分布异质性，OLS 均值效应无法体现。`,
      }),
    },
  }
}

export const QuantileRegressionTool = Tool.define(METHOD, Tool.Execution.managedFilesystem, ToolModel.forTool(METHOD), {
  description:
    "使用 statsmodels QuantReg 对连续结果变量做分位数回归（可一次估计多个分位点），返回各分位点的系数与核心解释变量的分位效应路径；系数即该分位点上的边际效应，用于揭示 OLS 均值效应掩盖的分布异质性。默认分位点 [0.25, 0.5, 0.75]。不适用：只需要平均效应 → 用 ols_regression；结果变量为计数 → 用 count_*。",
  parameters: QuantileInputSchema,
  formatValidationError,
  execute: executeQuantile,
})

export const QuantileEconometricsTools = [QuantileRegressionTool] as const
// @ts-nocheck
