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
import { runIvTestBackend } from "./iv-test-backend"
import { type PrincipleChecks, buildPrincipleChecks, standardDiagnosticStatus } from "../../../../src/runtime/principle-checks"

const METHOD = "iv_test" as const
const TOOL_LABEL = "工具变量诊断（弱工具 / 内生性 / 过度识别）"
const Col = z.string().trim().min(1, "变量名不能为空")

const Input = z
  .object({
    datasetId: z.string().trim().min(1).describe("由 data_import 返回的当前会话数据集 ID。"),
    stageId: z.string().trim().min(1).describe("已通过 数据质量检查 且属于 datasetId 的诊断输入阶段 ID。"),
    runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
    branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
    dependentVar: Col.describe("结果变量列名"),
    treatmentVar: Col.describe("被怀疑内生的解释变量列名"),
    covariates: z.array(Col).max(100).default([]).describe("外生控制变量列名"),
    instrumentVars: z
      .array(Col)
      .min(1, "至少需要一个工具变量")
      .max(10, "最多 10 个工具变量")
      .describe("排除性工具变量列名列表；只有给出 2 个及以上时才能做过度识别检验"),
    // 与 iv_2sls 同一道安全门：工具变量有效性不能由列名推断。
    instrumentJustification: z
      .string()
      .trim()
      .min(10, "必须说明工具变量的相关性、外生性与排除限制依据")
      .describe("用户或研究设计提供的工具变量识别依据；不能根据列名猜测"),
    covariance: z.enum(["robust", "unadjusted"]).default("robust").describe("推断的协方差类型，默认稳健"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.covariates).size !== value.covariates.length)
      ctx.addIssue({ code: "custom", path: ["covariates"], message: "控制变量不能重复" })
    if (new Set(value.instrumentVars).size !== value.instrumentVars.length)
      ctx.addIssue({ code: "custom", path: ["instrumentVars"], message: "工具变量不能重复" })
    const regressors = [value.treatmentVar, ...value.covariates]
    if (regressors.includes(value.dependentVar))
      ctx.addIssue({ code: "custom", path: ["dependentVar"], message: "结果变量不能同时做解释变量" })
    if (value.covariates.includes(value.treatmentVar))
      ctx.addIssue({ code: "custom", path: ["covariates"], message: "内生解释变量不能在控制变量中重复" })
    for (const instrument of value.instrumentVars) {
      if (instrument === value.dependentVar)
        ctx.addIssue({ code: "custom", path: ["instrumentVars"], message: "工具变量不能与结果变量相同" })
      if (regressors.includes(instrument))
        ctx.addIssue({ code: "custom", path: ["instrumentVars"], message: "工具变量不能同时做回归变量" })
    }
  })

type Params = z.infer<typeof Input>

function formatValidationError(error: z.ZodError) {
  return `计量工具参数不合法：${error.issues.map((i) => `${i.path.join(".") || "参数"}：${i.message}`).join("；")}`
}

async function execute(params: Params, ctx: Tool.Context) {
  assertDatasetStageReadyForEstimation({
    sessionID: ctx.sessionID,
    datasetId: params.datasetId,
    stageId: params.stageId,
  })
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok || runtime.missing.length) throw new Error(formatRuntimePythonSetupError(METHOD, runtime))

  const artifactInput = resolveArtifactInput({ datasetId: params.datasetId, stageId: params.stageId })
  const dataPath = artifactInput.resolvedInputPath
  if (!dataPath || !fs.existsSync(dataPath)) throw new Error("找不到数据文件")

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
    patterns: [`${runtime.executable} *iv_test*`],
    always: [`${runtime.executable} *iv_test*`],
    metadata: { description: `执行${TOOL_LABEL}`, managedRuntime: true },
  })

  const result = await runIvTestBackend({
    pythonCommand: runtime.executable,
    cwd: Instance.directory,
    sessionID: ctx.sessionID,
    payload: {
      method: METHOD,
      dataPath,
      outputDir,
      dependentVar: params.dependentVar,
      treatmentVar: params.treatmentVar,
      covariates: params.covariates,
      instrumentVars: params.instrumentVars,
      covariance: params.covariance,
    },
    abort: ctx.abort,
  })
  if (!result.resultPath || !result.testsPath) throw new Error("工具变量诊断未生成完整结果文件")

  let visibleResultPath = result.resultPath
  let visibleTestsPath = result.testsPath
  if (manifest) {
    appendArtifact(manifest, {
      artifactId: `${METHOD}_${Date.now()}`,
      runId,
      stageId: params.stageId ?? stage?.stageId,
      branch,
      action: METHOD,
      outputPath: result.resultPath,
      summaryPath: result.testsPath,
      createdAt: new Date().toISOString(),
      metadata: { backend: "linearmodels.iv", rowsUsed: result.rowsUsed, covariance: result.covariance, spec: params },
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
    visibleTestsPath = publishVisibleOutput({
      manifest,
      key: `${METHOD}_tests`,
      label: `${TOOL_LABEL}检验表`,
      sourcePath: result.testsPath,
      runId,
      branch: path.join("econometrics", METHOD),
      stageId: params.stageId ?? stage?.stageId,
    })
    refreshExperimentLog(manifest.datasetId)
  }

  const weak = result.weakInstrument
  const endogeneity = result.endogeneity
  const overid = result.overIdentification
  const comparison = result.comparison

  const output = [
    `${TOOL_LABEL}已完成。`,
    `后端：linearmodels ${result.linearmodelsVersion ?? ""}｜有效样本：${result.rowsUsed}｜协方差：${result.covariance}`,
    `识别状态：${result.identification === "over_identified" ? `过度识别（多出 ${result.overIdentifyingRestrictions} 个约束）` : "恰好识别"}`,
    "",
    `【弱工具】第一阶段 F=${numberText(weak?.firstStageFStat, 3)}，判定阈值 ${weak?.threshold}（Staiger-Stock 经验法则）：${weak?.weak ? "属弱工具" : "工具强度达标"}`,
    `【内生性】主判据 ${endogeneity?.primaryTest}：统计量 ${numberText(
      endogeneity?.primaryTest === "wooldridge_regression"
        ? endogeneity?.wooldridgeRegression?.stat
        : endogeneity?.durbin?.stat,
      4,
    )}，p=${numberText(
      endogeneity?.primaryTest === "wooldridge_regression"
        ? endogeneity?.wooldridgeRegression?.pValue
        : endogeneity?.durbin?.pValue,
      4,
    )} → ${endogeneity?.endogenous === null ? "无法判定" : endogeneity?.endogenous ? "拒绝外生性，支持使用 IV" : "未拒绝外生性，OLS 与 2SLS 无系统差异"}`,
    overid?.applicable
      ? `【过度识别】主判据 ${overid.primaryTest}：统计量 ${numberText(
          overid.primaryTest === "wooldridge_overid" ? overid.wooldridgeOverid?.stat : overid.sargan?.stat,
          4,
        )}，p=${numberText(
          overid.primaryTest === "wooldridge_overid" ? overid.wooldridgeOverid?.pValue : overid.sargan?.pValue,
          4,
        )} → ${overid.instrumentsRejected ? "拒绝，至少一个工具变量的外生性存疑" : "未拒绝，与工具外生性一致"}`
      : `【过度识别】不适用——${overid?.reason}`,
    "",
    `对照：OLS ${params.treatmentVar}=${numberText(comparison?.olsEstimate)}（se ${numberText(comparison?.olsStdError)}）｜2SLS=${numberText(comparison?.ivEstimate)}（se ${numberText(comparison?.ivStdError)}）`,
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
      backend: "linearmodels.iv",
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
          analysisMetric("第一阶段 F", numberText(weak?.firstStageFStat, 3)),
          analysisMetric(
            "内生性 p 值",
            numberText(
              endogeneity?.primaryTest === "wooldridge_regression"
                ? endogeneity?.wooldridgeRegression?.pValue
                : endogeneity?.durbin?.pValue,
              4,
            ),
          ),
          analysisMetric(
            "过度识别 p 值",
            overid?.applicable
              ? numberText(
                  overid.primaryTest === "wooldridge_overid" ? overid.wooldridgeOverid.pValue : overid.sargan.pValue,
                  4,
                )
              : "不适用",
          ),
          analysisMetric("N", result.rowsUsed),
        ],
        artifacts: [
          analysisArtifact(relativeWithinProject(visibleResultPath), { visibility: "user_default" }),
          analysisArtifact(relativeWithinProject(visibleTestsPath), { visibility: "user_default" }),
        ],
        warnings: result.warnings,
        conclusion: result.verdict ?? `${TOOL_LABEL}已完成。`,
      }),
    },
  }
}

export const IvTestTool = Tool.define(METHOD, Tool.Execution.managedFilesystem, ToolModel.forTool(METHOD), {
  description:
    "对已给出识别依据的工具变量设定做三组诊断，只出检验统计量不出回归表（回归请用 iv_2sls）：" +
    "① 弱工具——第一阶段对排除性工具变量的联合 F，按 Staiger-Stock 经验法则 F<10 判为弱工具；" +
    "② 内生性 Durbin-Wu-Hausman——检验该解释变量是否真的内生（即 OLS 与 2SLS 是否有系统差异），稳健设定下用 Wooldridge 回归型稳健得分检验作主判据；" +
    "③ 过度识别 Sargan / Wooldridge 稳健 J——检验工具变量的外生性，**仅当工具变量个数大于内生变量个数时才有自由度**，恰好识别时明确返回不适用而不给数字。" +
    "参数为结果变量、被怀疑内生的解释变量、工具变量列表、外生控制变量与工具变量识别依据。",
  parameters: Input,
  formatValidationError,
  execute,
})

export const IvTestEconometricsTools = [IvTestTool] as const
// @ts-nocheck
