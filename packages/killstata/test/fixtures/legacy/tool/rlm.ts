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
import { runRlmBackend, type RlmMethod, type RlmPayload } from "./rlm-backend"
import { type PrincipleChecks, buildPrincipleChecks, standardDiagnosticStatus } from "../../../../src/runtime/principle-checks"

const ColumnName = z.string().trim().min(1, "变量名不能为空")

const CanonicalStageFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空").describe("由 data_import 返回的当前会话数据集 ID。"),
  stageId: z.string().trim().min(1, "stageId 不能为空").describe("已通过 数据质量检查 且属于 datasetId 的估计输入阶段 ID。"),
  runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
  branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
}

const RlmInputSchema = z
  .object({
    ...CanonicalStageFields,
    dependentVar: ColumnName.describe("连续结果变量列名"),
    treatmentVar: ColumnName.describe("核心解释变量列名"),
    covariates: z.array(ColumnName).max(100, "控制变量最多 100 个").default([]).describe("研究设计确认的控制变量列名。"),
    psi: z
      .enum(["huber", "hampel", "tukey"])
      .default("huber")
      .describe(
        "M-估计的 psi 函数：huber（默认，L2+L1 混合）、hampel（三段降权，适合强离群）、tukey（双平方，平滑红降权）",
      ),
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

type RlmParams = z.infer<typeof RlmInputSchema>

const TOOL_LABEL = "稳健回归（RLM）"

function formatValidationError(error: z.ZodError) {
  const detail = error.issues.map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`).join("；")
  return `计量工具参数不合法：${detail}`
}

function buildPayload(params: RlmParams, dataPath: string, outputDir: string): RlmPayload {
  return {
    method: "robust_regression",
    dataPath,
    outputDir,
    dependentVar: params.dependentVar,
    treatmentVar: params.treatmentVar,
    covariates: params.covariates,
    psi: params.psi,
    covariance: "robust",
  }
}

async function executeRlm(params: RlmParams, ctx: Tool.Context) {
  assertDatasetStageReadyForEstimation({
    sessionID: ctx.sessionID,
    datasetId: params.datasetId,
    stageId: params.stageId,
  })
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok || runtime.missing.length) {
    throw new Error(formatRuntimePythonSetupError("robust_regression", runtime))
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
        action: "robust_regression",
        stageId: params.stageId ?? stage?.stageId,
        branch,
        format: "json",
        stamp: buildFileStamp(),
      }).replace(/\.json$/, "")
    : path.join(Instance.directory, "analysis", `robust_regression_${buildFileStamp()}`)
  fs.mkdirSync(outputDir, { recursive: true })

  await ctx.ask({
    permission: "bash",
    patterns: [`${runtime.executable} *rlm*`],
    always: [`${runtime.executable} *rlm*`],
    metadata: { description: `执行${TOOL_LABEL}`, managedRuntime: true },
  })

  const result = await runRlmBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    sessionID: ctx.sessionID,
    payload: buildPayload(params, dataPath, outputDir),
    abort: ctx.abort,
  })
  if (!result.resultPath || !result.coefficientsPath) {
    throw new Error("稳健回归已完成估计，但没有生成完整结果文件")
  }

  let visibleResultPath = result.resultPath
  let visibleCoefficientsPath = result.coefficientsPath
  if (manifest) {
    appendArtifact(manifest, {
      artifactId: `robust_regression_${Date.now()}`,
      runId,
      stageId: params.stageId ?? stage?.stageId,
      branch,
      action: "robust_regression",
      outputPath: result.resultPath,
      summaryPath: result.coefficientsPath,
      createdAt: new Date().toISOString(),
      metadata: {
        backend: "statsmodels",
        statsmodelsVersion: result.statsmodelsVersion,
        rowsUsed: result.rowsUsed,
        psi: result.psi,
        spec: params,
      },
    })
    visibleResultPath = publishVisibleOutput({
      manifest,
      key: "robust_regression_result",
      label: `${TOOL_LABEL}结果`,
      sourcePath: result.resultPath,
      runId,
      branch: path.join("econometrics", "robust_regression"),
      stageId: params.stageId ?? stage?.stageId,
    })
    visibleCoefficientsPath = publishVisibleOutput({
      manifest,
      key: "robust_regression_coefficients",
      label: `${TOOL_LABEL}系数表`,
      sourcePath: result.coefficientsPath,
      runId,
      branch: path.join("econometrics", "robust_regression"),
      stageId: params.stageId ?? stage?.stageId,
    })
    refreshExperimentLog(manifest.datasetId)
  }

  const primary = result.primary
  const output = [
    `${TOOL_LABEL}已完成。`,
    `后端：statsmodels ${result.statsmodelsVersion ?? "版本未知"}`,
    `有效样本：${result.rowsUsed ?? "未提供"}；结果变量均值：${numberText(result.meanOutcome, 3)}`,
    `Psi 函数：${result.psi}；残差尺度估计（MAD-based）：${numberText(result.scale, 4)}`,
    "推断方式：HC1 稳健标准误（稳健回归的默认推断）",
    `降权观测：${result.downWeightedCount} 个（${numberText(result.downWeightedPct, 1)}% 权重 < 0.5）`,
    ...(result.warnings ?? []).map((warning) => `提示：${warning}`),
    "",
    "系数表（与 OLS 同一尺度，可直接比较）：",
    renderCoefficientTable(result.coefficients ?? []),
    "",
    ARTIFACT_SAVED_NOTICE,
  ].join("\n")

  // ── 声明上限：模型对结果的措辞强度 ──
  {
    const standard = standardDiagnosticStatus(result)
    ;(result as { principle_checks?: PrincipleChecks }).principle_checks = buildPrincipleChecks({
      method: "robust_regression",
      prereqStatus: "pass",
      diagnosticsStatus: standard.status,
      findings: standard.findings,
    })
  }

  return {
    title: TOOL_LABEL,
    output,
    metadata: {
      method: "robust_regression",
      backend: "statsmodels",
      statsmodelsVersion: result.statsmodelsVersion,
      datasetId: manifest?.datasetId ?? params.datasetId,
      stageId: params.stageId ?? stage?.stageId,
      runId,
      result,
      analysisView: createToolAnalysisView({
        kind: "econometrics",
        step: "robust_regression",
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
          analysisMetric("残差尺度", result.scale !== null ? numberText(result.scale, 4) : undefined),
          analysisMetric("降权观测", (result.downWeightedCount ?? 0) > 0 ? `${result.downWeightedPct}%` : "无"),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(visibleResultPath), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(visibleCoefficientsPath), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: `${TOOL_LABEL}已完成，系数与 OLS 同尺度可直接比较；${(result.downWeightedPct ?? 0) > 5.0 ? `检测到 ${result.downWeightedPct}% 的点被显著降权，建议与 OLS 对照` : "未检测到大规模降权"}`,
      }),
    },
  }
}

export const RobustRegressionTool = Tool.define("robust_regression", Tool.Execution.managedFilesystem, ToolModel.forTool("robust_regression"), {
  description:
    "使用 statsmodels 对连续结果变量执行稳健线性回归（RLM，M-估计），通过迭代重加权最小二乘抑制离群值对系数的影响。返回系数（与 OLS 同一尺度）、psi 函数选择、残差尺度估计（MAD-based）、每个观测的有效性权重诊断。RLM 永远使用 HC1 稳健标准误。psi='huber' 适用于常见的厚尾误差；'hampel' 三段降权适用于有极端离群值的数据；'tukey' 平滑红降权适用于对异常值几乎完全排斥的场景。",
  parameters: RlmInputSchema,
  formatValidationError,
  execute: (params, ctx) => executeRlm(params, ctx),
})

export const RlmEconometricsTools = [RobustRegressionTool] as const
// @ts-nocheck
