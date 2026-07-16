import z from "zod"
import fs from "fs"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { ensureRuntimePythonReady, formatRuntimePythonSetupError } from "@/killstata/runtime-config"
import { assertDatasetStageReadyForEstimation } from "@/runtime/workflow"
import {
  appendArtifact,
  buildFileStamp,
  inferRunId,
  publishVisibleOutput,
  reportOutputPath,
  resolveArtifactInput,
} from "./analysis-state"
import { relativeWithinProject } from "./analysis-path"
import { analysisArtifact, analysisMetric, createToolAnalysisView } from "./analysis-user-view"
import { refreshExperimentLog } from "./analysis-experiment-log"
import { runPyfixestBackend, type PyfixestPayload } from "./pyfixest-backend"

const ColumnName = z.string().trim().min(1, "变量名不能为空")

const CanonicalStageFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空"),
  stageId: z.string().trim().min(1, "stageId 不能为空"),
}

function uniqueColumns(values: string[], path: (string | number)[], ctx: z.RefinementCtx) {
  if (new Set(values).size === values.length) return
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: "变量列表不能包含重复项",
  })
}

const HdfeInputSchema = z.object({
  ...CanonicalStageFields,
  runId: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  dependentVar: ColumnName,
  treatmentVar: ColumnName,
  covariates: z.array(ColumnName).max(100).default([]),
  fixedEffects: z.array(ColumnName).min(1).max(8),
  clusterVars: z.array(ColumnName).max(2).default([]),
  covariance: z.enum(["HC1", "CRV1", "CRV3"]).optional(),
}).strict().superRefine((value, ctx) => {
  uniqueColumns(value.covariates, ["covariates"], ctx)
  uniqueColumns(value.fixedEffects, ["fixedEffects"], ctx)
  uniqueColumns(value.clusterVars, ["clusterVars"], ctx)

  const regressors = [value.treatmentVar, ...value.covariates]
  if (regressors.includes(value.dependentVar)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependentVar"],
      message: "因变量不能同时作为解释变量",
    })
  }
  if (new Set(regressors).size !== regressors.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["covariates"],
      message: "核心解释变量不能在控制变量中重复出现",
    })
  }
  if (value.clusterVars.length === 0 && value.covariance && value.covariance !== "HC1") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["covariance"],
      message: "CRV1/CRV3 必须同时提供聚类变量",
    })
  }
  if (value.clusterVars.length > 0 && value.covariance === "HC1") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["covariance"],
      message: "提供聚类变量时协方差方法必须为 CRV1 或 CRV3",
    })
  }
})

const Did2sInputSchema = z.object({
  ...CanonicalStageFields,
  runId: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  dependentVar: ColumnName,
  treatmentVar: ColumnName,
  relativeTimeVar: ColumnName,
  entityVar: ColumnName,
  timeVar: ColumnName,
  clusterVar: ColumnName.optional(),
  covariates: z.array(ColumnName).max(100).default([]),
  referencePeriod: z.number().finite().default(-1),
}).strict().superRefine((value, ctx) => {
  uniqueColumns(value.covariates, ["covariates"], ctx)
  const designColumns = [
    value.dependentVar,
    value.treatmentVar,
    value.relativeTimeVar,
    value.entityVar,
    value.timeVar,
  ]
  if (new Set(designColumns).size !== designColumns.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "DID2S 的因变量、处理变量、相对时期、个体和时间变量必须彼此不同",
    })
  }
  if (value.covariates.some((item) => designColumns.includes(item))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["covariates"],
      message: "控制变量不能与 DID2S 设计变量重复",
    })
  }
})

const DidStaticInputSchema = z.object({
  ...CanonicalStageFields,
  runId: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  dependentVar: ColumnName,
  groupVar: ColumnName,
  postVar: ColumnName,
  covariates: z.array(ColumnName).max(100).default([]),
  covariance: z.literal("HC1").default("HC1"),
}).strict().superRefine((value, ctx) => {
  uniqueColumns(value.covariates, ["covariates"], ctx)
  const designColumns = [value.dependentVar, value.groupVar, value.postVar]
  if (new Set(designColumns).size !== designColumns.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "传统 DID 的因变量、处理组变量和政策后变量必须彼此不同",
    })
  }
  if (value.covariates.some((item) => designColumns.includes(item))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["covariates"],
      message: "控制变量不能与传统 DID 设计变量重复",
    })
  }
})

const SaturatedEventStudyInputSchema = z.object({
  ...CanonicalStageFields,
  runId: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  dependentVar: ColumnName,
  cohortVar: ColumnName,
  entityVar: ColumnName,
  timeVar: ColumnName,
  clusterVar: ColumnName.optional(),
}).strict().superRefine((value, ctx) => {
  const designColumns = [value.dependentVar, value.cohortVar, value.entityVar, value.timeVar]
  if (new Set(designColumns).size !== designColumns.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "事件研究的因变量、首次处理时期、个体和时间变量必须彼此不同",
    })
  }
})

type HdfeParams = z.infer<typeof HdfeInputSchema>
type DidStaticParams = z.infer<typeof DidStaticInputSchema>
type Did2sParams = z.infer<typeof Did2sInputSchema>
type SaturatedEventStudyParams = z.infer<typeof SaturatedEventStudyInputSchema>
type PyfixestToolParams = HdfeParams | DidStaticParams | Did2sParams | SaturatedEventStudyParams

const TOOL_LABELS: Record<PyfixestPayload["method"], string> = {
  hdfe_regression: "高维固定效应回归",
  did_static: "传统双重差分",
  did2s: "两阶段双重差分",
  did_event_study_saturated: "现代交错处理事件研究",
}

export function resolveHdfeCovariance(input: Pick<HdfeParams, "clusterVars" | "covariance">) {
  return input.covariance ?? (input.clusterVars.length ? "CRV1" as const : "HC1" as const)
}

export function resolveDidCluster(entityVar: string, clusterVar?: string) {
  return clusterVar ?? entityVar
}

function formatValidationError(error: z.ZodError) {
  const detail = error.issues
    .map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`)
    .join("；")
  return `计量工具参数不合法：${detail}`
}

function buildPayload(
  method: PyfixestPayload["method"],
  params: PyfixestToolParams,
  dataPath: string,
  outputDir: string,
): PyfixestPayload {
  const base = {
    method,
    dataPath,
    outputDir,
    dependentVar: params.dependentVar,
  }
  if (method === "hdfe_regression") {
    const input = params as HdfeParams
    return {
      ...base,
      method,
      treatmentVar: input.treatmentVar,
      covariates: input.covariates,
      fixedEffects: input.fixedEffects,
      clusterVars: input.clusterVars,
      covariance: resolveHdfeCovariance(input),
    }
  }
  if (method === "did_static") {
    const input = params as DidStaticParams
    return {
      ...base,
      method,
      groupVar: input.groupVar,
      postVar: input.postVar,
      covariates: input.covariates,
      covariance: input.covariance,
    }
  }
  if (method === "did2s") {
    const input = params as Did2sParams
    return {
      ...base,
      method,
      treatmentVar: input.treatmentVar,
      covariates: input.covariates,
      relativeTimeVar: input.relativeTimeVar,
      entityVar: input.entityVar,
      timeVar: input.timeVar,
      clusterVar: resolveDidCluster(input.entityVar, input.clusterVar),
      referencePeriod: input.referencePeriod,
    }
  }
  const input = params as SaturatedEventStudyParams
  return {
    ...base,
    method,
    cohortVar: input.cohortVar,
    entityVar: input.entityVar,
    timeVar: input.timeVar,
    clusterVar: resolveDidCluster(input.entityVar, input.clusterVar),
    aggregateAtt: false,
  }
}

function numberText(value: number | null | undefined, digits = 4) {
  return typeof value === "number" ? value.toFixed(digits) : "未提供"
}

async function executePyfixest(
  method: PyfixestPayload["method"],
  params: PyfixestToolParams,
  ctx: Tool.Context,
) {
  assertDatasetStageReadyForEstimation({
    sessionID: ctx.sessionID,
    datasetId: params.datasetId,
    stageId: params.stageId,
  })
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok || runtime.missing.length) {
    throw new Error(formatRuntimePythonSetupError(method, runtime))
  }

  const artifactInput = resolveArtifactInput({
    datasetId: params.datasetId,
    stageId: params.stageId,
  })
  const dataPath = artifactInput.resolvedInputPath
  if (!dataPath || !fs.existsSync(dataPath)) throw new Error("找不到要分析的数据文件")

  const manifest = artifactInput.manifest
  const stage = artifactInput.stage
  const branch = params.branch ?? stage?.branch ?? "main"
  const runId = inferRunId({ requestedRunId: params.runId, stage })
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
    patterns: [`${runtime.executable} *pyfixest*`],
    always: [`${runtime.executable} *pyfixest*`],
    metadata: { description: `执行${TOOL_LABELS[method]}` },
  })

  const result = await runPyfixestBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    payload: buildPayload(method, params, dataPath, outputDir),
    abort: ctx.abort,
  })
  if (!result.resultPath || !result.coefficientsPath) {
    throw new Error("PyFixest 已完成估计，但没有生成完整结果文件")
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
        backend: "pyfixest",
        pyfixestVersion: result.pyfixestVersion,
        rowsUsed: result.rowsUsed,
        covariance: result.covariance,
        clusterVars: result.clusterVars,
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

  const coefficients = result.coefficients ?? []
  const estimateLines = coefficients.map((item) =>
    `- ${item.term}：系数 ${numberText(item.estimate)}，标准误 ${numberText(item.stdError)}，p 值 ${numberText(item.pValue)}，95% 置信区间 [${numberText(item.confLow)}, ${numberText(item.confHigh)}]`,
  )
  const output = [
    `${TOOL_LABELS[method]}已完成。`,
    `后端：PyFixest ${result.pyfixestVersion ?? "版本未知"}`,
    `有效样本：${result.rowsUsed ?? "未提供"}；剔除样本：${result.droppedRows ?? "未提供"}`,
    result.clusterVars?.length ? `聚类变量：${result.clusterVars.join("、")}` : "推断方式：HC1 异方差稳健标准误",
    ...(result.warnings ?? []).map((warning) => `提示：${warning}`),
    "",
    "估计结果：",
    ...estimateLines,
    "",
    `完整结果：${relativeWithinProject(visibleResultPath)}`,
    `系数表：${relativeWithinProject(visibleCoefficientsPath)}`,
  ].join("\n")

  const primary = result.primary
  return {
    title: TOOL_LABELS[method],
    output,
    metadata: {
      method,
      backend: "pyfixest",
      pyfixestVersion: result.pyfixestVersion,
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
          analysisMetric(primary?.term ?? "系数项", primary?.estimate !== null && primary?.estimate !== undefined ? numberText(primary.estimate) : coefficients.length),
          analysisMetric("标准误", primary?.stdError !== null && primary?.stdError !== undefined ? numberText(primary.stdError) : undefined),
          analysisMetric("p 值", primary?.pValue !== null && primary?.pValue !== undefined ? numberText(primary.pValue) : undefined),
          analysisMetric(
            "95% 置信区间",
            primary?.confLow !== null && primary?.confLow !== undefined && primary?.confHigh !== null && primary?.confHigh !== undefined
              ? `[${numberText(primary.confLow)}, ${numberText(primary.confHigh)}]`
              : undefined,
          ),
          analysisMetric("N", result.rowsUsed),
          analysisMetric("系数项数", coefficients.length),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(visibleResultPath), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(visibleCoefficientsPath), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: `${TOOL_LABELS[method]}已完成，结果已按 PyFixest ${result.pyfixestVersion ?? "固定版本"} 保存。`,
      }),
    },
  }
}

export const HdfeRegressionTool = Tool.define("hdfe_regression", {
  description: "使用 PyFixest 执行高维固定效应线性回归，支持 HC1 和一维/二维 CRV1、CRV3 聚类推断。",
  parameters: HdfeInputSchema,
  formatValidationError,
  execute: (params, ctx) => executePyfixest("hdfe_regression", params, ctx),
})

export const Did2sTool = Tool.define("did2s", {
  description: "使用 PyFixest 执行 Gardner 两阶段 DID 事件研究；必须显式提供处理变量和相对时期变量。",
  parameters: Did2sInputSchema,
  formatValidationError,
  execute: (params, ctx) => executePyfixest("did2s", params, ctx),
})

export const DidStaticTool = Tool.define("did_static", {
  description: "使用 PyFixest 执行传统 2×2 双重差分，显式接收处理组变量和政策后变量，由后端安全构造交互项。",
  parameters: DidStaticInputSchema,
  formatValidationError,
  execute: (params, ctx) => executePyfixest("did_static", params, ctx),
})

export const SaturatedDidEventStudyTool = Tool.define("did_event_study_saturated", {
  description: "使用 PyFixest saturated estimator 执行适用于交错处理时点的现代事件研究。",
  parameters: SaturatedEventStudyInputSchema,
  formatValidationError,
  execute: (params, ctx) => executePyfixest("did_event_study_saturated", params, ctx),
})

export const PyfixestEconometricsTools = [
  HdfeRegressionTool,
  DidStaticTool,
  Did2sTool,
  SaturatedDidEventStudyTool,
] as const
