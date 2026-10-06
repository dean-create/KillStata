import z from "zod"
import fs from "fs"
import path from "path"
import { Tool } from "../../../../src/tool/tool"
import { ToolModel } from "../../../../src/tool/model-contracts"
import { Instance } from "../../../../src/project/instance"
import { ensureRuntimePythonReady, formatRuntimePythonSetupError } from "../../../../src/killstata/runtime-config"
import { assertDatasetStageReadyForEstimation } from "../../../../src/runtime/workflow"
import {
  appendArtifact, buildFileStamp, inferBranch, inferRunId, publishVisibleOutput,
  reportOutputPath, resolveArtifactInput,
} from "../../../../src/tool/analysis-state"
import { relativeWithinProject } from "../../../../src/tool/analysis-path"
import { ARTIFACT_SAVED_NOTICE, analysisArtifact, analysisMetric, createToolAnalysisView } from "../../../../src/tool/analysis-user-view"
import { refreshExperimentLog } from "../../../../src/tool/analysis-experiment-log"
import { numberText } from "../../../../src/util/number-text"
import { renderCoefficientTable } from "../../../../src/util/coefficient-table"
import { runWlsBackend, type WlsPayload } from "./wls-backend"
import { type PrincipleChecks, buildPrincipleChecks, standardDiagnosticStatus } from "../../../../src/runtime/principle-checks"

const ColumnName = z.string().trim().min(1, "变量名不能为空")

const CanonicalStageFields = {
  datasetId: z.string().trim().min(1).describe("由 data_import 返回的当前会话数据集 ID。"),
  stageId: z.string().trim().min(1).describe("已通过 数据质量检查 且属于 datasetId 的估计输入阶段 ID。"),
  runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
  branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
}

const WlsInputSchema = z
  .object({
    ...CanonicalStageFields,
    dependentVar: ColumnName.describe("连续结果变量列名"),
    treatmentVar: ColumnName.describe("核心解释变量列名"),
    covariates: z.array(ColumnName).max(100).default([]).describe("研究设计确认的控制变量列名。"),
    weightsVar: ColumnName.describe("权重列名：必须由用户提供的正数列，模型无权生成权重"),
    covariance: z.enum(["nonrobust", "robust"]).default("nonrobust").describe("推断协方差；robust 使用稳健标准误。"),
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
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["covariates"], message: "核心解释变量不能在控制变量中重复出现" })
    }
    if (regressors.includes(value.weightsVar)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weightsVar"], message: "权重列不能同时作为解释变量" })
    }
    if (value.weightsVar === value.dependentVar) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weightsVar"], message: "权重列不能与因变量相同" })
    }
  })

type WlsParams = z.infer<typeof WlsInputSchema>

const TOOL_LABEL = "加权最小二乘（WLS）"

function formatValidationError(error: z.ZodError) {
  const detail = error.issues.map((i) => `${i.path.join(".") || "参数"}：${i.message}`).join("；")
  return `计量工具参数不合法：${detail}`
}

function buildPayload(params: WlsParams, dataPath: string, outputDir: string): WlsPayload {
  return {
    method: "wls_regression", dataPath, outputDir,
    dependentVar: params.dependentVar, treatmentVar: params.treatmentVar,
    covariates: params.covariates, weightsVar: params.weightsVar, covariance: params.covariance,
  }
}

async function executeWls(params: WlsParams, ctx: Tool.Context) {
  assertDatasetStageReadyForEstimation({ sessionID: ctx.sessionID, datasetId: params.datasetId, stageId: params.stageId })
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok || runtime.missing.length) throw new Error(formatRuntimePythonSetupError("wls_regression", runtime))
  const artifactInput = resolveArtifactInput({ datasetId: params.datasetId, stageId: params.stageId })
  const dataPath = artifactInput.resolvedInputPath
  if (!dataPath || !fs.existsSync(dataPath)) throw new Error("找不到要分析的数据文件")
  const manifest = artifactInput.manifest
  const stage = artifactInput.stage
  const branch = inferBranch({ requestedBranch: params.branch, stage, source: "model" })
  const runId = inferRunId({ requestedRunId: params.runId, stage, source: "model" })
  const outputDir = manifest
    ? reportOutputPath({ datasetId: manifest.datasetId, action: "wls_regression", stageId: params.stageId ?? stage?.stageId, branch, format: "json", stamp: buildFileStamp() }).replace(/\.json$/, "")
    : path.join(Instance.directory, "analysis", `wls_regression_${buildFileStamp()}`)
  fs.mkdirSync(outputDir, { recursive: true })
  await ctx.ask({
    permission: "bash", patterns: [`${runtime.executable} *wls*`], always: [`${runtime.executable} *wls*`],
    metadata: { description: `执行${TOOL_LABEL}`, managedRuntime: true },
  })
  const result = await runWlsBackend({
    pythonCommand: runtime.executable, cwd: Instance.directory, sessionID: ctx.sessionID,
    payload: buildPayload(params, dataPath, outputDir), abort: ctx.abort,
  })
  if (!result.resultPath || !result.coefficientsPath) throw new Error("加权最小二乘已完成估计但没有生成完整结果文件")
  let vp = result.resultPath; let vc = result.coefficientsPath
  if (manifest) {
    appendArtifact(manifest, {
      artifactId: `wls_regression_${Date.now()}`, runId, stageId: params.stageId ?? stage?.stageId, branch,
      action: "wls_regression", outputPath: result.resultPath, summaryPath: result.coefficientsPath,
      createdAt: new Date().toISOString(), metadata: { backend: "statsmodels", statsmodelsVersion: result.statsmodelsVersion, rowsUsed: result.rowsUsed, spec: params },
    })
    vp = publishVisibleOutput({ manifest, key: "wls_regression_result", label: `${TOOL_LABEL}结果`, sourcePath: result.resultPath, runId, branch: path.join("econometrics", "wls_regression"), stageId: params.stageId ?? stage?.stageId })
    vc = publishVisibleOutput({ manifest, key: "wls_regression_coefficients", label: `${TOOL_LABEL}系数表`, sourcePath: result.coefficientsPath, runId, branch: path.join("econometrics", "wls_regression"), stageId: params.stageId ?? stage?.stageId })
    refreshExperimentLog(manifest.datasetId)
  }
  const p = result.primary
  const ws = result.weightSummary
  const output = [
    `${TOOL_LABEL}已完成。`,
    `后端：statsmodels ${result.statsmodelsVersion ?? "版本未知"}`,
    `有效样本：${result.rowsUsed}；R²：${numberText(result.rsquared, 4)}；Adj R²：${numberText(result.adjRsquared, 4)}`,
    `权重列摘要：最小 ${numberText(ws?.minWeight)} ~ 最大 ${numberText(ws?.maxWeight)}，中位 ${numberText(ws?.medianWeight)}，零权 ${ws?.zeroCount ?? 0} 个`,
    result.covariance === "HC1" ? "推断方式：HC1 稳健标准误" : "推断方式：常规 OLS 标准误（假设同方差）",
    ...(result.warnings ?? []).map((w) => `提示：${w}`),
    "",
    "系数表：",
    renderCoefficientTable(result.coefficients ?? []),
    "",
    ARTIFACT_SAVED_NOTICE,
  ].join("\n")
  // ── 声明上限：模型对结果的措辞强度 ──
  {
    const standard = standardDiagnosticStatus(result)
    ;(result as { principle_checks?: PrincipleChecks }).principle_checks = buildPrincipleChecks({
      method: "wls_regression",
      prereqStatus: "pass",
      diagnosticsStatus: standard.status,
      findings: standard.findings,
    })
  }
  return {
    title: TOOL_LABEL, output,
    metadata: {
      method: "wls_regression", backend: "statsmodels", statsmodelsVersion: result.statsmodelsVersion,
      datasetId: manifest?.datasetId ?? params.datasetId, stageId: params.stageId ?? stage?.stageId, runId,
      result,
      analysisView: createToolAnalysisView({
        kind: "econometrics", step: "wls_regression",
        datasetId: manifest?.datasetId ?? params.datasetId, stageId: params.stageId ?? stage?.stageId,
        results: [
          analysisMetric(`${params.treatmentVar} 系数`, p?.estimate != null ? numberText(p.estimate) : undefined),
          analysisMetric("p 值", p?.pValue != null ? numberText(p.pValue) : undefined),
          analysisMetric("N", result.rowsUsed), analysisMetric("R²", result.rsquared != null ? numberText(result.rsquared, 4) : undefined),
          analysisMetric("权重范围", ws ? `${numberText(ws.minWeight)} ~ ${numberText(ws.maxWeight)}` : undefined),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(vp), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(vc), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: `${TOOL_LABEL}已完成，系数与 OLS 同尺度可直接比较；权重由用户提供的 ${params.weightsVar} 列指定。`,
      }),
    },
  }
}

export const WlsRegressionTool = Tool.define("wls_regression", Tool.Execution.managedFilesystem, ToolModel.forTool("wls_regression"), {
  description:
    "使用 statsmodels 对连续结果变量执行加权最小二乘（WLS），通过用户显式提供的权重列处理异方差——权重代表对每个观测的信任程度（大权重 = 小方差）。权重必须由用户提供，模型无权生成。返回系数（与 OLS 同一尺度）、R²、权重摘要。支持 nonrobust 与 HC1 稳健标准误。不适用：只是想要稳健标准误而无需显式权重 → 用 ols_regression 的 HC1 即可，不要用本工具。",
  parameters: WlsInputSchema,
  formatValidationError,
  execute: (params, ctx) => executeWls(params, ctx),
})

export const WlsEconometricsTools = [WlsRegressionTool] as const
// @ts-nocheck
