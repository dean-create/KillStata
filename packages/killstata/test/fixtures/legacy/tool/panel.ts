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
import { runPanelBackend, type PanelMethod, type PanelPayload } from "./panel-backend"
import { type PrincipleChecks, buildPrincipleChecks, standardDiagnosticStatus } from "../../../../src/runtime/principle-checks"

const METHOD = "panel_random_effects" as const
const TOOL_LABEL = "面板随机效应 + Hausman 检验"

const ColumnName = z.string().trim().min(1, "变量名不能为空")

const CanonicalStageFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空").describe("由 data_import 返回的当前会话数据集 ID。"),
  stageId: z.string().trim().min(1, "stageId 不能为空").describe("已通过 数据质量检查 且属于 datasetId 的面板阶段 ID。"),
  runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
  branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
}

const PanelInputSchema = z
  .object({
    ...CanonicalStageFields,
    dependentVar: ColumnName.describe("面板因变量列名（连续）"),
    treatmentVar: ColumnName.describe("核心解释变量列名"),
    covariates: z.array(ColumnName).max(100, "控制变量最多 100 个").default([]).describe("研究设计确认的控制变量列名。"),
    entityVar: ColumnName.describe("个体索引列名（如省份、企业 ID），同一面板必须唯一识别"),
    timeVar: ColumnName.describe("时间索引列名（如年份、季度）"),
    covariance: z
      .enum(["robust", "unadjusted"])
      .default("robust")
      .describe("推断协方差：robust 使用稳健标准误（默认），unadjusted 假设误差同分布"),
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
    // 面板索引不能与回归变量重合
    for (const forbidden of [value.entityVar, value.timeVar]) {
      if (regressors.includes(forbidden)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [forbidden === value.entityVar ? "entityVar" : "timeVar"],
          message: `${forbidden} 是${forbidden === value.entityVar ? "个体" : "时间"}索引列，不能同时作为回归变量`,
        })
      }
      if (forbidden === value.dependentVar) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dependentVar"],
          message: `${forbidden} 是索引列，不能同时作为因变量`,
        })
      }
    }
    // 索引列本身不能互相重合
    if (value.entityVar === value.timeVar) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeVar"],
        message: "个体索引与时间索引不能是同一列",
      })
    }
  })

type PanelParams = z.infer<typeof PanelInputSchema>

function formatValidationError(error: z.ZodError) {
  const detail = error.issues.map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`).join("；")
  return `计量工具参数不合法：${detail}`
}

function buildPayload(params: PanelParams, dataPath: string, outputDir: string): PanelPayload {
  return {
    method: METHOD,
    dataPath,
    outputDir,
    dependentVar: params.dependentVar,
    treatmentVar: params.treatmentVar,
    covariates: params.covariates,
    entityVar: params.entityVar,
    timeVar: params.timeVar,
    covariance: params.covariance,
  }
}

async function executePanel(params: PanelParams, ctx: Tool.Context) {
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
    patterns: [`${runtime.executable} *panel*`],
    always: [`${runtime.executable} *panel*`],
    metadata: { description: `执行${TOOL_LABEL}`, managedRuntime: true },
  })

  const result = await runPanelBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    sessionID: ctx.sessionID,
    payload: buildPayload(params, dataPath, outputDir),
    abort: ctx.abort,
  })
  if (!result.resultPath || !result.coefficientsPath) {
    throw new Error("面板随机效应已完成估计，但没有生成完整结果文件")
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
        backend: "linearmodels",
        linearmodelsVersion: result.linearmodelsVersion,
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

  const primaryRe = result.randomEffects?.primary
  const primaryFe = result.fixedEffects?.primary
  const hausman = result.hausman
  const rec = result.recommendation
  const hausmanUndetermined = rec?.preferred === "undetermined"
    || hausman?.df === 0
    || hausman?.statistic === null
    || hausman?.statistic === undefined
    || hausman?.pValue === null
    || hausman?.pValue === undefined
  const recommendedModel = rec?.preferred === "fixed_effects"
    ? "固定效应（FE）"
    : rec?.preferred === "random_effects"
      ? "随机效应（RE）"
      : "暂不可判定"

  const output = [
    `${TOOL_LABEL}已完成。`,
    `后端：linearmodels ${result.linearmodelsVersion ?? "版本未知"}`,
    `有效样本：${result.rowsUsed ?? "未提供"}（个体 ${result.nEntities ?? "?"} 个，时间 ${result.nPeriods ?? "?"} 期）`,
    result.covariance === "robust" ? "推断方式：稳健标准误" : "推断方式：常规标准误",
    ...(result.warnings ?? []).map((warning) => `提示：${warning}`),
    "",
    `核心解释变量 ${params.treatmentVar}（RE vs FE 对比）：`,
    renderCoefficientTable([
      { term: "随机效应 RE", estimate: primaryRe?.estimate ?? null, stdError: primaryRe?.stdError, pValue: primaryRe?.pValue },
      { term: "固定效应 FE", estimate: primaryFe?.estimate ?? null, stdError: primaryFe?.stdError, pValue: primaryFe?.pValue },
    ]),
    "",
    hausmanUndetermined
      ? `Hausman 检验不可判定（df = ${hausman?.df ?? 0}）`
      : `Hausman 检验：H = ${numberText(hausman?.statistic, 3)}（df = ${hausman?.df ?? 0}），p = ${numberText(hausman?.pValue)}`,
    `推荐模型：${recommendedModel}`,
    `推荐理由：${rec?.reason ?? "无"}`,
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
      backend: "linearmodels",
      linearmodelsVersion: result.linearmodelsVersion,
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
            `${params.treatmentVar} RE 系数`,
            primaryRe?.estimate !== null && primaryRe?.estimate !== undefined
              ? numberText(primaryRe.estimate)
              : undefined,
          ),
          analysisMetric(
            `${params.treatmentVar} FE 系数`,
            primaryFe?.estimate !== null && primaryFe?.estimate !== undefined
              ? numberText(primaryFe.estimate)
              : undefined,
          ),
          analysisMetric(
            "Hausman p 值",
            hausman?.pValue !== null && hausman?.pValue !== undefined ? numberText(hausman.pValue) : undefined,
          ),
          analysisMetric("N", result.rowsUsed),
          analysisMetric("个体数", result.nEntities),
          analysisMetric("期数", result.nPeriods),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(visibleResultPath), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(visibleCoefficientsPath), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: hausmanUndetermined
          ? `${TOOL_LABEL}已完成；Hausman 检验不可判定，不能据此选择 FE 或 RE；推荐模型暂不可判定。`
          : `${TOOL_LABEL}已完成；Hausman ${hausman?.rejectRe ? "显著拒绝 RE" : "未拒绝 RE"}，推荐使用${recommendedModel}。`,
      }),
    },
  }
}

export const PanelRandomEffectsTool = Tool.define(METHOD, Tool.Execution.managedFilesystem, ToolModel.forTool(METHOD), {
  description:
    "使用 linearmodels 对面板数据做随机效应估计（Swamy-Arora GLS），同时给出固定效应估计与 Hausman 检验，辅助在 FE/RE 之间选择。返回 RE 与 FE 系数、个体效应方差、Hausman 统计量与模型推荐。不适用：个体效应与解释变量相关（Hausman 拒绝 RE）→ 用 panel_fe_regression；数据不是面板结构 → 用 ols_regression。",
  parameters: PanelInputSchema,
  formatValidationError,
  execute: executePanel,
})

export const PanelEconometricsTools = [PanelRandomEffectsTool] as const
// @ts-nocheck
