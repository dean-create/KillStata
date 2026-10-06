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
import { renderCoefficientTable } from "../../../../src/util/coefficient-table"
import { runPanelFeBackend, type PanelFePayload } from "./panel-fe-backend"
import { type PrincipleChecks, buildPrincipleChecks, standardDiagnosticStatus } from "../../../../src/runtime/principle-checks"
import { createEconometricsNumericSnapshot } from "../../../../src/tool/analysis-grounding"

const METHOD = "panel_fe_regression" as const,
  TOOL_LABEL = "面板固定效应回归"
const Col = z.string().trim().min(1, "变量名不能为空")
const blankAsUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => typeof value === "string" && value.trim() === "" ? undefined : value, schema)
const Input = z
  .object({
    datasetId: z.string().trim().min(1).describe("由 data_import 返回的当前会话数据集 ID。"),
    stageId: z.string().trim().min(1).describe("已通过 数据质量检查 且属于 datasetId 的面板阶段 ID。"),
    runId: blankAsUndefined(z.string().trim().min(1).optional()).describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造；空字符串按未提供处理。"),
    branch: blankAsUndefined(z.string().trim().min(1).optional()).describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支；空字符串按未提供处理。"),
    dependentVar: Col.describe("面板因变量（数据中真实存在的列，如 'y'；不确定先 profile）"),
    treatmentVar: Col.describe("核心解释变量（如 'x'；数据中真实存在的列）"),
    covariates: z.array(Col).max(100).default([]).describe("控制变量列名列表"),
    entityVar: Col.describe("个体索引列（如 'firm_id'；每个个体唯一取值）"),
    timeVar: Col.describe("时间索引列（如 'year'；每个时期唯一取值）"),
    clusterVar: blankAsUndefined(Col.optional()).describe("单维聚类列；省略或传空字符串时按个体索引聚类"),
    covariance: z.enum(["clustered", "robust", "unadjusted"]).default("clustered").describe("推断协方差，默认按 clusterVar 或 entityVar 聚类。"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.covariates).size !== v.covariates.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["covariates"], message: "控制变量不能重复" })
    for (const f of [v.entityVar, v.timeVar, ...(v.clusterVar ? [v.clusterVar] : [])]) {
      if ([v.treatmentVar, ...v.covariates].includes(f))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${f} 是索引列，不能同时做回归变量` })
      if (f === v.dependentVar)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${f} 是索引列，不能同时做因变量` })
    }
  })
type P = z.infer<typeof Input>

function fmt(e: z.ZodError) {
  return `计量工具参数不合法：${e.issues.map((i) => `${i.path.join(".") || "参数"}：${i.message}`).join("；")}`
}
function nt(v: number | null | undefined, d = 4) {
  return typeof v === "number" ? v.toFixed(d) : "未提供"
}

async function exec(params: P, ctx: Tool.Context) {
  assertDatasetStageReadyForEstimation({
    sessionID: ctx.sessionID,
    datasetId: params.datasetId,
    stageId: params.stageId,
  })
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok || runtime.missing.length) throw new Error(formatRuntimePythonSetupError(METHOD, runtime))
  const ai = resolveArtifactInput({ datasetId: params.datasetId, stageId: params.stageId })
  const dp = ai.resolvedInputPath
  if (!dp || !fs.existsSync(dp)) throw new Error("找不到数据文件")
  const mf = ai.manifest,
    st = ai.stage,
    br = inferBranch({ requestedBranch: params.branch, stage: st, source: "model" })
  const rid = inferRunId({ requestedRunId: params.runId, stage: st, source: "model" })
  const od = mf
    ? reportOutputPath({
        datasetId: mf.datasetId,
        action: METHOD,
        stageId: params.stageId ?? st?.stageId,
        branch: br,
        format: "json",
        stamp: buildFileStamp(),
      }).replace(/\.json$/, "")
    : path.join(Instance.directory, "analysis", `${METHOD}_${buildFileStamp()}`)
  fs.mkdirSync(od, { recursive: true })
  await ctx.ask({
    permission: "bash",
    patterns: [`${runtime.executable} *panel_fe*`],
    always: [`${runtime.executable} *panel_fe*`],
    metadata: { description: `执行${TOOL_LABEL}`, managedRuntime: true },
  })
  const r = await runPanelFeBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    sessionID: ctx.sessionID,
    payload: {
      method: METHOD,
      dataPath: dp,
      outputDir: od,
      dependentVar: params.dependentVar,
      treatmentVar: params.treatmentVar,
      covariates: params.covariates,
      entityVar: params.entityVar,
      timeVar: params.timeVar,
      clusterVar: params.clusterVar ?? params.entityVar,
      covariance: params.covariance,
    },
    abort: ctx.abort,
  })
  if (!r.resultPath || !r.coefficientsPath) throw new Error("FE 未生成完整结果文件")
  let vrp = r.resultPath,
    vcp = r.coefficientsPath
  if (mf) {
    appendArtifact(mf, {
      artifactId: `${METHOD}_${Date.now()}`,
      runId: rid,
      stageId: params.stageId ?? st?.stageId,
      branch: br,
      action: METHOD,
      outputPath: r.resultPath,
      summaryPath: r.coefficientsPath,
      createdAt: new Date().toISOString(),
      metadata: { backend: "linearmodels", rowsUsed: r.rowsUsed, covariance: r.covariance, spec: params },
    })
    vrp = publishVisibleOutput({
      manifest: mf,
      key: `${METHOD}_result`,
      label: `${TOOL_LABEL}结果`,
      sourcePath: r.resultPath,
      runId: rid,
      branch: path.join("econometrics", METHOD),
      stageId: params.stageId ?? st?.stageId,
    })
    vcp = publishVisibleOutput({
      manifest: mf,
      key: `${METHOD}_coefficients`,
      label: `${TOOL_LABEL}系数表`,
      sourcePath: r.coefficientsPath,
      runId: rid,
      branch: path.join("econometrics", METHOD),
      stageId: params.stageId ?? st?.stageId,
    })
    refreshExperimentLog(mf.datasetId)
  }
  const numericSnapshot = createEconometricsNumericSnapshot({
    outputDir: od,
    methodName: METHOD,
    result: r as unknown as Record<string, unknown>,
    coefficientsPath: r.coefficientsPath,
    datasetId: mf?.datasetId ?? params.datasetId,
    stageId: params.stageId ?? st?.stageId,
    runId: rid,
  })
  const p = r.primary
  const o = [
    `${TOOL_LABEL}已完成。`,
    `后端：linearmodels ${r.linearmodelsVersion ?? ""}`,
    `有效样本：${r.rowsUsed}（个体 ${r.nEntities}，时间 ${r.nPeriods}）`,
    `组内 R²：${nt(r.rSquaredWithin, 4)}`,
    r.covariance === "clustered"
      ? `推断方式：按 ${params.clusterVar ?? params.entityVar} 聚类稳健标准误`
      : r.covariance === "robust"
        ? "推断方式：稳健标准误"
        : "推断方式：常规标准误",
    ...(r.warnings ?? []).map((w) => `提示：${w}`),
    "",
    "系数表：",
    renderCoefficientTable(r.coefficients ?? []),
    "",
    ARTIFACT_SAVED_NOTICE,
  ]
    .filter((l) => l)
    .join("\n")
  // ── 声明上限：模型对结果的措辞强度 ──
  {
    const standard = standardDiagnosticStatus(r)
    ;(r as { principle_checks?: PrincipleChecks }).principle_checks = buildPrincipleChecks({
      method: METHOD,
      prereqStatus: "pass",
      diagnosticsStatus: standard.status,
      findings: standard.findings,
    })
  }

  return {
    title: TOOL_LABEL,
    output: o,
    metadata: {
      method: METHOD,
      backend: "linearmodels",
      datasetId: mf?.datasetId ?? params.datasetId,
      stageId: params.stageId ?? st?.stageId,
      runId: rid,
      result: r,
      numericSnapshotPath: numericSnapshot.snapshotPath,
      analysisView: createToolAnalysisView({
        kind: "econometrics",
        step: METHOD,
        datasetId: mf?.datasetId ?? params.datasetId,
        stageId: params.stageId ?? st?.stageId,
        results: [
          analysisMetric(
            `${params.treatmentVar} 系数`,
            p?.estimate !== null && p?.estimate !== undefined ? nt(p.estimate) : undefined,
          ),
          analysisMetric("标准误", p?.stdError !== null && p?.stdError !== undefined ? nt(p.stdError) : undefined),
          analysisMetric("p 值", p?.pValue !== null && p?.pValue !== undefined ? nt(p.pValue) : undefined),
          analysisMetric("组内 R²", r.rSquaredWithin !== null && r.rSquaredWithin !== undefined ? nt(r.rSquaredWithin) : undefined),
          analysisMetric("N", r.rowsUsed),
        ],
        artifacts: [analysisArtifact(relativeWithinProject(vrp)), analysisArtifact(relativeWithinProject(vcp))],
        warnings: r.warnings,
        conclusion: `${TOOL_LABEL}已完成，系数为结果尺度上的边际效应。`,
      }),
    },
  }
}

export const PanelFeTool = Tool.define(METHOD, Tool.Execution.managedFilesystem, ToolModel.forTool(METHOD), {
  description:
    "使用 linearmodels PanelOLS 对面板数据做双向固定效应回归（个体+时间效应），返回系数与组内 R²。组内 R²表示整体模型拟合度，不是某个解释变量单独解释的比例；没有增量R²或部分R²时不要这样表述。不适用：个体效应与解释变量不相关（分层抽样）→ 用 panel_random_effects 并参考 Hausman 检验；数据不是面板结构 → 用 ols_regression。",
  parameters: Input,
  formatValidationError: fmt,
  execute: exec,
})
export const PanelFeEconometricsTools = [PanelFeTool] as const
// @ts-nocheck
