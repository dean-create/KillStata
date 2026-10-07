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
import { runCountBackend, type CountMethod, type CountPayload } from "./count-backend"
import { type PrincipleChecks, buildPrincipleChecks, standardDiagnosticStatus } from "../../../../src/runtime/principle-checks"

const ColumnName = z.string().trim().min(1, "变量名不能为空")

const CanonicalStageFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空").describe("由 data_import 返回的当前会话数据集 ID。"),
  stageId: z.string().trim().min(1, "stageId 不能为空").describe("已通过 数据质量检查 且属于 datasetId 的估计输入阶段 ID。"),
  runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
  branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
}

// Poisson 与负二项共用同一份契约：非负计数因变量 + 一个核心解释变量 + 可选控制变量。
const CountInputSchema = z
  .object({
    ...CanonicalStageFields,
    dependentVar: ColumnName.describe("计数结果变量列名，必须非负（次数/数量/非负金额；允许连续非负做 PPML）"),
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

type CountParams = z.infer<typeof CountInputSchema>

const TOOL_LABELS: Record<CountMethod, string> = {
  poisson_regression: "Poisson 回归",
  negbin_regression: "负二项回归",
}

function formatValidationError(error: z.ZodError) {
  const detail = error.issues.map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`).join("；")
  return `计量工具参数不合法：${detail}`
}

function buildPayload(method: CountMethod, params: CountParams, dataPath: string, outputDir: string): CountPayload {
  return {
    method,
    dataPath,
    outputDir,
    dependentVar: params.dependentVar,
    treatmentVar: params.treatmentVar,
    covariates: params.covariates,
    covariance: params.covariance,
  }
}

async function executeCount(method: CountMethod, params: CountParams, ctx: Tool.Context) {
  assertDatasetStageReadyForEstimation({
    sessionID: ctx.sessionID,
    datasetId: params.datasetId,
    stageId: params.stageId,
  })
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok || runtime.missing.length) {
    throw new Error(formatRuntimePythonSetupError(method, runtime))
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
        action: method,
        stageId: params.stageId ?? stage?.stageId,
        branch,
        format: "json",
        stamp: buildFileStamp(),
      }).replace(/\.json$/, "")
    : path.join(Instance.directory, "analysis", `${method}_${buildFileStamp()}`)
  fs.mkdirSync(outputDir, { recursive: true })

  await ctx.ask({
    permission: "bash",
    patterns: [`${runtime.executable} *count*`],
    always: [`${runtime.executable} *count*`],
    metadata: { description: `执行${TOOL_LABELS[method]}`, managedRuntime: true },
  })

  const result = await runCountBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    sessionID: ctx.sessionID,
    payload: buildPayload(method, params, dataPath, outputDir),
    abort: ctx.abort,
  })
  if (!result.resultPath || !result.coefficientsPath) {
    throw new Error("计数模型已完成估计，但没有生成完整结果文件")
  }

  let visibleResultPath = result.resultPath
  let visibleCoefficientsPath = result.coefficientsPath
  if (manifest) {
    appendArtifact(manifest, {
      artifactId: `${method}_${Date.now()}`,
      runId,
      stageId: params.stageId ?? stage?.stageId,
      branch,
      action: method,
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
      key: `${method}_result`,
      label: `${TOOL_LABELS[method]}结果`,
      sourcePath: result.resultPath,
      runId,
      branch: path.join("econometrics", method),
      stageId: params.stageId ?? stage?.stageId,
    })
    visibleCoefficientsPath = publishVisibleOutput({
      manifest,
      key: `${method}_coefficients`,
      label: `${TOOL_LABELS[method]}系数表`,
      sourcePath: result.coefficientsPath,
      runId,
      branch: path.join("econometrics", method),
      stageId: params.stageId ?? stage?.stageId,
    })
    refreshExperimentLog(manifest.datasetId)
  }

  const primary = result.primary
  const primaryIrr = result.primaryIrr
  const primaryMargin = result.primaryMarginalEffect
  const irrTable = renderCoefficientTable(
    (result.incidenceRateRatios ?? [])
      .filter((item) => item.term !== "const")
      .map((item) => ({ term: item.term, estimate: item.irr, pValue: item.pValue, confLow: item.confLow, confHigh: item.confHigh })),
    [
      { header: "变量", value: (row) => row.term },
      { header: "发生率比 IRR", value: (row) => formatEstimate(row.estimate) },
      { header: "p 值", value: (row) => formatPValue(row.pValue) },
    ],
  )
  const output = [
    `${TOOL_LABELS[method]}已完成。`,
    `后端：statsmodels ${result.statsmodelsVersion ?? "版本未知"}`,
    `有效样本：${result.rowsUsed ?? "未提供"}；结果变量均值：${numberText(result.meanOutcome, 3)}${result.isPureCount ? "" : "（含非整数，按 PPML 处理）"}`,
    `伪 R²（McFadden）：${numberText(result.pseudoRSquared, 4)}；对数似然：${numberText(result.logLikelihood, 3)}`,
    `Pearson 离散度：${numberText(result.dispersion, 3)}（Poisson 假设均值=方差，显著大于 1 即过度离散）`,
    method === "negbin_regression"
      ? `过度离散参数 alpha：${numberText(result.alpha, 4)}（越接近 0 越接近 Poisson）`
      : "",
    result.covariance === "HC1" ? "推断方式：HC1 稳健标准误" : "推断方式：常规最大似然标准误",
    ...(result.warnings ?? []).map((warning) => `提示：${warning}`),
    "",
    `核心解释变量 ${params.treatmentVar}：系数 ${numberText(primary?.estimate)}（对数尺度），`,
    `  发生率比 IRR ${numberText(primaryIrr?.irr)}（期望计数变为原来的这个倍数），`,
    `  平均边际效应 ${numberText(primaryMargin?.estimate)}（计数尺度），p 值 ${numberText(primary?.pValue)}`,
    "",
    "发生率比（IRR = exp(系数)，>1 表示提升计数，<1 表示降低）：",
    irrTable,
    "",
    ARTIFACT_SAVED_NOTICE,
  ]
    .filter((line) => line !== "")
    .join("\n")

  // ── 声明上限：模型对结果的措辞强度 ──
  {
    const standard = standardDiagnosticStatus(result)
    ;(result as { principle_checks?: PrincipleChecks }).principle_checks = buildPrincipleChecks({
      method,
      prereqStatus: "pass",
      diagnosticsStatus: standard.status,
      findings: standard.findings,
    })
  }

  return {
    title: TOOL_LABELS[method],
    output,
    metadata: {
      method,
      backend: "statsmodels",
      statsmodelsVersion: result.statsmodelsVersion,
      datasetId: manifest?.datasetId ?? params.datasetId,
      stageId: params.stageId ?? stage?.stageId,
      runId,
      result,
      analysisView: createToolAnalysisView({
        kind: "econometrics",
        step: method,
        datasetId: manifest?.datasetId ?? params.datasetId,
        stageId: params.stageId ?? stage?.stageId,
        results: [
          analysisMetric(
            `${params.treatmentVar} 系数`,
            primary?.estimate !== null && primary?.estimate !== undefined ? numberText(primary.estimate) : undefined,
          ),
          analysisMetric(
            "发生率比 IRR",
            primaryIrr?.irr !== null && primaryIrr?.irr !== undefined ? numberText(primaryIrr.irr) : undefined,
          ),
          analysisMetric(
            "平均边际效应",
            primaryMargin?.estimate !== null && primaryMargin?.estimate !== undefined
              ? numberText(primaryMargin.estimate)
              : undefined,
          ),
          analysisMetric(
            "p 值",
            primary?.pValue !== null && primary?.pValue !== undefined ? numberText(primary.pValue) : undefined,
          ),
          analysisMetric("N", result.rowsUsed),
          analysisMetric(
            "离散度",
            result.dispersion !== null && result.dispersion !== undefined
              ? numberText(result.dispersion, 3)
              : undefined,
          ),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(visibleResultPath), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(visibleCoefficientsPath), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: `${TOOL_LABELS[method]}已完成，系数为对数尺度，倍数效应请以发生率比（IRR）解读，绝对增量请以计数尺度的平均边际效应解读。`,
      }),
    },
  }
}

export const PoissonRegressionTool = Tool.define("poisson_regression", Tool.Execution.managedFilesystem, ToolModel.forTool("poisson_regression"), {
  description:
    "使用 statsmodels 对非负计数结果变量执行 Poisson 回归，返回系数、发生率比（IRR）与平均边际效应，并做过度离散诊断；也支持连续非负结果的 Poisson 伪极大似然（PPML）。系数是对数尺度，倍数效应看 IRR。不适用：结果变量为连续(非计数)且关注均值 → 用 ols_regression；计数过度离散(Pearson 离散度远大于 1) → 用 negbin_regression。",
  parameters: CountInputSchema,
  formatValidationError,
  execute: (params, ctx) => executeCount("poisson_regression", params, ctx),
})

export const NegativeBinomialRegressionTool = Tool.define("negbin_regression", Tool.Execution.managedFilesystem, ToolModel.forTool("negbin_regression"), {
  description:
    "使用 statsmodels 对过度离散的非负计数结果变量执行负二项回归，返回系数、发生率比（IRR）、平均边际效应与过度离散参数 alpha；当 Poisson 的 Pearson 离散度远大于 1 时应改用本工具。不适用：计数无明显过度离散 → 用 poisson_regression（更高效）。",
  parameters: CountInputSchema,
  formatValidationError,
  execute: (params, ctx) => executeCount("negbin_regression", params, ctx),
})

export const CountEconometricsTools = [PoissonRegressionTool, NegativeBinomialRegressionTool] as const
// @ts-nocheck
