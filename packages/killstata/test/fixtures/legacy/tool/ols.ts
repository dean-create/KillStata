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
import { runOlsBackend, type OlsPayload } from "./ols-backend"
import { type PrincipleChecks, buildPrincipleChecks, standardDiagnosticStatus } from "../../../../src/runtime/principle-checks"
import { createEconometricsNumericSnapshot } from "../../../../src/tool/analysis-grounding"

const METHOD = "ols_regression" as const
const TOOL_LABEL = "OLS 回归"

const ColumnName = z.string().trim().min(1, "变量名不能为空")
const CanonicalStageFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空").describe("由 data_import 返回的当前会话数据集 ID。"),
  stageId: z.string().trim().min(1, "stageId 不能为空").describe("已通过 数据质量检查 且属于 datasetId 的估计输入阶段 ID。"),
  runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
  branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
}

const OlsInputSchema = z
  .object({
    ...CanonicalStageFields,
    dependentVar: ColumnName.describe("连续结果变量列名（必须是数据中真实存在的列，如 'income'；不确定时先 profile 确认）"),
    treatmentVar: ColumnName.describe("核心解释变量列名（如 'education'；必须是数据中真实存在的列）"),
    covariates: z.array(ColumnName).max(100, "控制变量最多 100 个").default([]).describe("研究设计确认的控制变量列名。"),
    covariance: z
      .enum(["nonrobust", "HC1", "HC2", "HC3"])
      .default("HC1")
      .describe("推断协方差：nonrobust=普通, HC1=稳健(默认), HC2/HC3=小样本校正"),
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
type OlsParams = z.infer<typeof OlsInputSchema>

function formatValidationError(error: z.ZodError) {
  const detail = error.issues.map((i) => `${i.path.join(".") || "参数"}：${i.message}`).join("；")
  return `计量工具参数不合法：${detail}`
}

async function executeOls(params: OlsParams, ctx: Tool.Context) {
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
    patterns: [`${runtime.executable} *ols*`],
    always: [`${runtime.executable} *ols*`],
    metadata: { description: `执行${TOOL_LABEL}`, managedRuntime: true },
  })

  const result = await runOlsBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    sessionID: ctx.sessionID,
    payload: buildPayload(params, dataPath, outputDir),
    abort: ctx.abort,
  })
  if (!result.resultPath || !result.coefficientsPath) throw new Error("OLS 已完成估计，但没有生成完整结果文件")

  let visibleResultPath = result.resultPath,
    visibleCoefficientsPath = result.coefficientsPath
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

  // 估计器的用户可见文本不能成为唯一数值来源；核验器读取同一结果目录下的快照，
  // 将模型表述与后端实际产物绑定，避免合法系数被当作未核验文本删掉。
  const numericSnapshot = createEconometricsNumericSnapshot({
    outputDir,
    methodName: METHOD,
    result: result as unknown as Record<string, unknown>,
    coefficientsPath: result.coefficientsPath,
    datasetId: manifest?.datasetId ?? params.datasetId,
    stageId: params.stageId ?? stage?.stageId,
    runId,
  })

  const primary = result.primary
  const output = [
    `${TOOL_LABEL}已完成。`,
    `后端：statsmodels ${result.statsmodelsVersion ?? "版本未知"}`,
    result.covariance === "nonrobust" ? "推断方式：常规标准误" : `推断方式：${result.covariance} 标准误`,
    `有效样本：${result.rowsUsed ?? "未提供"}；结果变量均值：${numberText(result.outcomeMean, 3)}`,
    `R²：${numberText(result.rSquared, 4)}；调整 R²：${numberText(result.rSquaredAdj, 4)}`,
    result.fStatistic !== null && result.fStatistic !== undefined
      ? `F 统计量：${numberText(result.fStatistic, 3)}（p = ${numberText(result.fPValue)}）`
      : "",
    ...(result.warnings ?? []).map((w) => `提示：${w}`),
    "",
    "系数表：",
    renderCoefficientTable(result.coefficients ?? []),
    "",
    (result.vif ?? []).filter((v) => v.term === params.treatmentVar).map((v) => `核心解释变量 VIF：${numberText(v.vif, 2)}`),
    "",
    ARTIFACT_SAVED_NOTICE,
  ]
    .filter((l) => l !== "")
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
      numericSnapshotPath: numericSnapshot.snapshotPath,
      analysisView: createToolAnalysisView({
        kind: "econometrics",
        step: METHOD,
        datasetId: manifest?.datasetId ?? params.datasetId,
        stageId: params.stageId ?? stage?.stageId,
        results: [
          analysisMetric(
            `${params.treatmentVar} 系数`,
            primary?.estimate !== null && primary?.estimate !== undefined ? numberText(primary.estimate) : undefined,
          ),
          analysisMetric(
            "p 值",
            primary?.pValue !== null && primary?.pValue !== undefined ? numberText(primary.pValue) : undefined,
          ),
          analysisMetric("N", result.rowsUsed),
          analysisMetric(
            "R²",
            result.rSquared !== null && result.rSquared !== undefined ? numberText(result.rSquared, 4) : undefined,
          ),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(visibleResultPath), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(visibleCoefficientsPath), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: `${TOOL_LABEL}已完成，系数为结果尺度上的边际效应。`,
      }),
    },
  }
}

function buildPayload(params: OlsParams, dataPath: string, outputDir: string): OlsPayload {
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

export const OlsRegressionTool = Tool.define(METHOD, Tool.Execution.managedFilesystem, ToolModel.forTool(METHOD), {
  description:
    "使用 statsmodels 对连续结果变量做普通最小二乘(OLS)线性回归，返回系数、R²、F 检验与多重共线性(VIF)诊断。推荐默认 HC1 稳健标准误。不适用：结果变量为计数 → 用 count_*；核心解释变量内生 → 用 iv_2sls；数据为面板结构 → 用 panel_fe_regression 或 panel_random_effects；只关心分布分位 → 用 quantile_regression。",
  parameters: OlsInputSchema,
  formatValidationError,
  execute: executeOls,
})

export const OlsEconometricsTools = [OlsRegressionTool] as const
// @ts-nocheck
