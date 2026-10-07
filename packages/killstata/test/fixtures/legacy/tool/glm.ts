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
import { runGlmBackend, type GlmMethod, type GlmPayload } from "./glm-backend"
import { type PrincipleChecks, buildPrincipleChecks, standardDiagnosticStatus } from "../../../../src/runtime/principle-checks"
import { createEconometricsNumericSnapshot } from "../../../../src/tool/analysis-grounding"

const ColumnName = z.string().trim().min(1, "变量名不能为空")

const CanonicalStageFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空").describe("由 data_import 返回的当前会话数据集 ID。"),
  stageId: z.string().trim().min(1, "stageId 不能为空").describe("已通过 数据质量检查 且属于 datasetId 的估计输入阶段 ID。"),
  runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
  branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
}

// Logit 与 Probit 共用同一份契约：二元因变量 + 一个核心解释变量 + 可选控制变量。
const GlmInputSchema = z
  .object({
    ...CanonicalStageFields,
    dependentVar: ColumnName.describe("二元结果变量列名，必须严格以 0/1 编码"),
    treatmentVar: ColumnName.describe("核心解释变量列名"),
    covariates: z.array(ColumnName).max(100, "控制变量最多 100 个").default([]).describe("研究设计确认的控制变量列名，不能与核心变量重复。"),
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

type GlmParams = z.infer<typeof GlmInputSchema>

const TOOL_LABELS: Record<GlmMethod, string> = {
  logit_regression: "Logit 回归",
  probit_regression: "Probit 回归",
}

function formatValidationError(error: z.ZodError) {
  const detail = error.issues.map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`).join("；")
  return `计量工具参数不合法：${detail}`
}

function buildPayload(method: GlmMethod, params: GlmParams, dataPath: string, outputDir: string): GlmPayload {
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

async function executeGlm(method: GlmMethod, params: GlmParams, ctx: Tool.Context) {
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
  // branch/runId 是工作流内部路由字段，不是模型可以自由设计的研究参数。
  // 模型有时会把 logit_main、probit_main 等标题误填进去；已有 stage 时以其规范值为准，
  // 避免合法估计被错误路由拦截。显式创建新分支仍必须走工作流动作。
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
    patterns: [`${runtime.executable} *glm*`],
    always: [`${runtime.executable} *glm*`],
    metadata: { description: `执行${TOOL_LABELS[method]}`, managedRuntime: true },
  })

  const result = await runGlmBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    sessionID: ctx.sessionID,
    payload: buildPayload(method, params, dataPath, outputDir),
    abort: ctx.abort,
  })
  if (!result.resultPath || !result.coefficientsPath) {
    throw new Error("GLM 已完成估计，但没有生成完整结果文件")
  }

  // 将系数表绑定到核验快照，避免后续 verifier 因结果文本过长或模型改写而
  // 省略本来可以从后端产物核验的系数、p 值和平均边际效应。
  const numericSnapshot = createEconometricsNumericSnapshot({
    outputDir,
    methodName: method,
    result: result as unknown as Record<string, unknown>,
    coefficientsPath: result.coefficientsPath,
    datasetId: manifest?.datasetId ?? params.datasetId,
    stageId: params.stageId ?? stage?.stageId,
    runId,
  })

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
  const primaryMargin = result.primaryMarginalEffect
  const marginTable = renderCoefficientTable(result.marginalEffects ?? [], [
    { header: "变量", value: (row) => row.term },
    { header: "平均边际效应", value: (row) => formatEstimate(row.estimate) },
    { header: "p 值", value: (row) => formatPValue(row.pValue) },
  ])
  const output = [
    `${TOOL_LABELS[method]}已完成。`,
    `后端：statsmodels ${result.statsmodelsVersion ?? "版本未知"}`,
    `有效样本：${result.rowsUsed ?? "未提供"}；结果变量为 1 的比例：${numberText(result.outcomeRate, 3)}`,
    `伪 R²（McFadden）：${numberText(result.pseudoRSquared, 4)}；对数似然：${numberText(result.logLikelihood, 3)}`,
    result.covariance === "HC1" ? "推断方式：HC1 稳健标准误" : "推断方式：常规最大似然标准误",
    ...(result.warnings ?? []).map((warning) => `提示：${warning}`),
    "",
    `核心解释变量 ${params.treatmentVar}：系数 ${numberText(primary?.estimate)}（对数几率/潜变量尺度），`,
    `  平均边际效应 ${numberText(primaryMargin?.estimate)}（概率尺度），p 值 ${numberText(primary?.pValue)}`,
    "",
    "平均边际效应（概率尺度，对应 Stata margins, dydx）：",
    marginTable,
    "",
    ARTIFACT_SAVED_NOTICE,
  ].join("\n")

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
      numericSnapshotPath: numericSnapshot.snapshotPath,
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
            "伪 R²",
            result.pseudoRSquared !== null && result.pseudoRSquared !== undefined
              ? numberText(result.pseudoRSquared, 4)
              : undefined,
          ),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(visibleResultPath), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(visibleCoefficientsPath), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: `${TOOL_LABELS[method]}已完成，系数为对数几率/潜变量尺度，处理效应请以概率尺度的平均边际效应解读。`,
      }),
    },
  }
}

export const LogitRegressionTool = Tool.define("logit_regression", Tool.Execution.managedFilesystem, ToolModel.forTool("logit_regression"), {
  description:
    "使用 statsmodels 对二元 0/1 结果变量执行 Logit（逻辑回归）最大似然估计，返回系数与平均边际效应；系数是对数几率尺度，处理效应应以概率尺度的平均边际效应解读。不适用：结果不是二元 0/1 → 连续用 ols_regression，计数用 count_*；需要更少分布假设的二元模型 → probit_regression。",
  parameters: GlmInputSchema,
  formatValidationError,
  execute: (params, ctx) => executeGlm("logit_regression", params, ctx),
})

export const ProbitRegressionTool = Tool.define("probit_regression", Tool.Execution.managedFilesystem, ToolModel.forTool("probit_regression"), {
  description:
    "使用 statsmodels 对二元 0/1 结果变量执行 Probit 最大似然估计，返回系数与平均边际效应；系数是潜变量尺度，处理效应应以概率尺度的平均边际效应解读。不适用：结果不是二元 0/1 → 连续用 ols_regression，计数用 count_*；Logit 与 Probit 结论通常接近，选 Logit 更常见。",
  parameters: GlmInputSchema,
  formatValidationError,
  execute: (params, ctx) => executeGlm("probit_regression", params, ctx),
})

export const GlmEconometricsTools = [LogitRegressionTool, ProbitRegressionTool] as const
// @ts-nocheck
