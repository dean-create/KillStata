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
import { COLUMNS_WITH_CI, renderCoefficientTable } from "../../../../src/util/coefficient-table"
import { runRddBackend, type RddMethod, type RddPayload } from "./rdd-backend"
import {
  type PrincipleChecks,
  buildPrincipleChecks,
  mergePrincipleStatus,
  standardDiagnosticStatus,
} from "../../../../src/runtime/principle-checks"

const ColumnName = z.string().trim().min(1, "变量名不能为空")

const CanonicalStageFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空").describe("由 data_import 返回的当前会话数据集 ID。"),
  stageId: z.string().trim().min(1, "stageId 不能为空").describe("已通过 数据质量检查 且属于 datasetId 的断点估计输入阶段 ID。"),
  runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
  branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
}

const RddSchema = z
  .object({
    ...CanonicalStageFields,
    dependentVar: ColumnName.describe("结果变量列名（连续）"),
    runningVar: ColumnName.describe("驱动变量/配置变量列名，其相对断点的位置决定处理分配"),
    cutoff: z.number().finite().default(0).describe("断点阈值：驱动变量跨过该值时处理状态发生跳变，默认 0"),
    covariates: z.array(ColumnName).max(100, "控制变量最多 100 个").default([]).describe("断点局部估计中预先指定的控制变量列名。"),
    fuzzyVar: ColumnName.optional().describe("模糊断点专用：实际接受处理的二分变量；不传时为锐性 RD"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.covariates).size !== value.covariates.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["covariates"], message: "控制变量列表不能包含重复项" })
    }
    if (value.runningVar === value.dependentVar) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runningVar"], message: "驱动变量不能同时作为结果变量" })
    }
    if (value.covariates.includes(value.dependentVar)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["covariates"], message: "结果变量不能在控制变量中重复出现" })
    }
    if (value.covariates.includes(value.runningVar)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["covariates"], message: "驱动变量不能在控制变量中重复出现" })
    }
  })

type RddParams = z.infer<typeof RddSchema>

function formatValidationError(error: z.ZodError) {
  const detail = error.issues.map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`).join("；")
  return `计量工具参数不合法：${detail}`
}

function buildPayload(method: RddMethod, params: RddParams, dataPath: string, outputDir: string): RddPayload {
  return {
    method,
    dataPath,
    outputDir,
    dependentVar: params.dependentVar,
    runningVar: params.runningVar,
    cutoff: params.cutoff,
    covariates: params.covariates,
    fuzzyVar: params.fuzzyVar,
  }
}

async function executeRdd(method: RddMethod, toolLabel: string, params: RddParams, ctx: Tool.Context) {
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
    patterns: [`${runtime.executable} *rdd*`],
    always: [`${runtime.executable} *rdd*`],
    metadata: { description: `执行${toolLabel}`, managedRuntime: true },
  })

  const result = await runRddBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    sessionID: ctx.sessionID,
    payload: buildPayload(method, params, dataPath, outputDir),
    abort: ctx.abort,
  })
  if (!result.resultPath || !result.coefficientsPath) {
    throw new Error("断点回归已完成估计，但没有生成完整结果文件")
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
        backend: "rdrobust",
        rdrobustVersion: result.rdrobustVersion,
        rowsUsed: result.rowsUsed,
        cutoff: result.cutoff,
        spec: params,
      },
    })
    visibleResultPath = publishVisibleOutput({
      manifest,
      key: `${method}_result`,
      label: `${toolLabel}结果`,
      sourcePath: result.resultPath,
      runId,
      branch: path.join("econometrics", method),
      stageId: params.stageId ?? stage?.stageId,
    })
    visibleCoefficientsPath = publishVisibleOutput({
      manifest,
      key: `${method}_coefficients`,
      label: `${toolLabel}系数表`,
      sourcePath: result.coefficientsPath,
      runId,
      branch: path.join("econometrics", method),
      stageId: params.stageId ?? stage?.stageId,
    })
    refreshExperimentLog(manifest.datasetId)
  }

  const primary = result.primary
  const conventional = result.conventional
  const bandwidth = result.bandwidth
  const nEff = result.nEffective

  const output = [
    `${toolLabel}已完成。`,
    `后端：rdrobust ${result.rdrobustVersion ?? "版本未知"}（局部一次多项式 + 三角核 + MSE 最优带宽）`,
    `断点：${result.runningVar} = ${numberText(result.cutoff, 2)}；有效样本：${result.rowsUsed ?? "未提供"}`,
    params.fuzzyVar ? `模糊处理变量：${params.fuzzyVar}` : "(锐性断点)",
    `带宽 h：${numberText(bandwidth?.h)}（左有效样本 ${nEff?.left ?? "?"} / 右有效样本 ${nEff?.right ?? "?"}）`,
    ...(result.warnings ?? []).map((warning) => `提示：${warning}`),
    "",
    `断点处理效应（${result.dependentVar} 在断点的跳跃）：`,
    renderCoefficientTable(
      [
        { term: "点估计 conventional", estimate: conventional?.estimate ?? null },
        {
          term: "稳健推断 robust",
          estimate: primary?.estimate ?? null,
          stdError: primary?.stdError,
          pValue: primary?.pValue,
          confLow: primary?.confLow,
          confHigh: primary?.confHigh,
        },
      ],
      COLUMNS_WITH_CI,
    ),
    "",
    ARTIFACT_SAVED_NOTICE,
  ].join("\n")

  // ── 声明上限：模型对结果的措辞强度 ──
  {
    const standard = standardDiagnosticStatus(result)
    let diagnosticsStatus = standard.status
    const findings = [...standard.findings]

    // RDD 样本量门槛
    const rowsUsed = (result as { rowsUsed?: number }).rowsUsed
    if (typeof rowsUsed === "number" && rowsUsed < 30) {
      // 30 是任意参考阈值；RDD 局部回归精度主要看带宽和断点附近有效样本，
      // 全样本 rowsUsed 小不一定说明 RDD 不可信。降为受限证据，由模型判断。
      diagnosticsStatus = mergePrincipleStatus(diagnosticsStatus, "warn")
      findings.push(`RDD 有效样本 ${rowsUsed} 偏少（<30 经验阈值）。估计精度需要结合带宽、断点附近样本和稳健性检查综合判断，是否仍报告及如何措辞由你决定。`)
    }

    ;(result as { principle_checks?: PrincipleChecks }).principle_checks = buildPrincipleChecks({
      method,
      prereqStatus: "pass",
      diagnosticsStatus,
      findings,
    })
  }

  return {
    title: toolLabel,
    output,
    metadata: {
      method,
      backend: "rdrobust",
      rdrobustVersion: result.rdrobustVersion,
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
            "断点效应（点估计）",
            conventional?.estimate !== null && conventional?.estimate !== undefined
              ? numberText(conventional.estimate)
              : undefined,
          ),
          analysisMetric(
            "稳健 p 值",
            primary?.pValue !== null && primary?.pValue !== undefined ? numberText(primary.pValue) : undefined,
          ),
          analysisMetric(
            "带宽 h",
            bandwidth?.h !== null && bandwidth?.h !== undefined ? numberText(bandwidth.h) : undefined,
          ),
          analysisMetric("有效样本 N", result.rowsUsed),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(visibleResultPath), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(visibleCoefficientsPath), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: `${toolLabel}已完成；断点处 ${result.dependentVar} 的跳跃点估计 ${numberText(conventional?.estimate)}，稳健 p=${numberText(primary?.pValue)}。`,
      }),
    },
  }
}

export const RddSharpTool = Tool.define("rdd_sharp", Tool.Execution.managedFilesystem, ToolModel.forTool("rdd_sharp"), {
  description:
    "使用 rdrobust 对锐性断点回归（Sharp RDD）做局部多项式估计：以 MSE 最优带宽 + 三角核 + 局部一次多项式估计驱动变量跨过断点时结果变量的跳跃（处理效应），并给出偏差矫正的稳健标准误、p 值与置信区间。参数为结果变量、驱动变量、断点阈值与可选控制变量。",
  parameters: RddSchema,
  formatValidationError,
  execute: (params, ctx) => executeRdd("rdd_sharp", "锐性断点回归（Sharp RDD）", params, ctx),
})

export const RddFuzzyTool = Tool.define("rdd_fuzzy", Tool.Execution.managedFilesystem, ToolModel.forTool("rdd_fuzzy"), {
  description:
    "使用 rdrobust 对模糊断点回归（Fuzzy RDD）做局部多项式估计：与锐性 RDD 同调 rdrobust 后端，额外要求一个 fuzzyVar（实际是否接受处理的二分变量），估计驱动变量跨过断点时以模糊分配的概率形成的处理效应（IV 风格），同样返回偏差矫正的稳健推断。",
  parameters: RddSchema,
  formatValidationError,
  execute: (params, ctx) => executeRdd("rdd_fuzzy", "模糊断点回归（Fuzzy RDD）", params, ctx),
})

export const RddEconometricsTools = [RddSharpTool, RddFuzzyTool] as const
// @ts-nocheck
