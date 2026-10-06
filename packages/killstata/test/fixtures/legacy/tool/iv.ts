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
import { runIvBackend, type IvPayload } from "./iv-backend"
import {
  type PrincipleChecks,
  buildPrincipleChecks,
  mergePrincipleStatus,
  standardDiagnosticStatus,
} from "../../../../src/runtime/principle-checks"

const METHOD = "iv_2sls" as const,
  TOOL_LABEL = "工具变量 IV-2SLS 回归"
const Col = z.string().trim().min(1, "变量名不能为空")
const Input = z
  .object({
    datasetId: z.string().trim().min(1).describe("由 data_import 返回的当前会话数据集 ID。"),
    stageId: z.string().trim().min(1).describe("已通过 数据质量检查 且属于 datasetId 的估计输入阶段 ID。"),
    runId: z.string().trim().min(1).optional().describe("通常省略；仅复用上游工具或用户明确提供的运行 ID，不得自行编造。"),
    branch: z.string().trim().min(1).optional().describe("通常省略；仅复用上游返回或用户明确要求的结果分支，不得自行把报告标题或模型名称当作分支。"),
    dependentVar: Col.describe("连续因变量（数据中真实存在的列，如 'wage'；不确定先 profile）"),
    treatmentVar: Col.describe("内生解释变量（如 'education'；数据中真实存在的列）"),
    covariates: z.array(Col).max(100).default([]).describe("外生控制变量列名，不能与内生变量或工具变量重复。"),
    instrumentVars: z
      .array(Col)
      .min(1, "至少需要一个工具变量")
      .max(10, "最多 10 个工具变量")
      .describe("工具变量列名列表（如 ['near4']；必须是数据中真实存在的列，1-10 个）"),
    // 工具变量的有效性不能由列名推断，必须由用户/研究设计显式给出依据。
    // 这是准入时固化的安全门，拆分独立 runner 时曾遗漏，此处恢复。
    instrumentJustification: z
      .string()
      .trim()
      .min(10, "必须说明工具变量的相关性、外生性与排除限制依据")
      .describe("用户或研究设计提供的工具变量识别依据；不能根据列名猜测"),
    covariance: z.enum(["robust", "unadjusted"]).default("robust").describe("推断协方差，默认 robust 稳健标准误。"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.covariates).size !== v.covariates.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["covariates"], message: "控制变量不能重复" })
    const rs = [v.treatmentVar, ...v.covariates]
    if (rs.includes(v.dependentVar))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dependentVar"], message: "因变量不能同时做解释变量" })
    if (v.covariates.includes(v.treatmentVar))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["covariates"], message: "核心解释变量不能在控制变量中重复" })
    // 工具变量不能与解释变量重复
    for (const iv of v.instrumentVars) {
      if (iv === v.dependentVar)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instrumentVars"], message: "工具变量不能与因变量相同" })
      if (iv === v.treatmentVar)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instrumentVars"], message: "工具变量不能与内生变量相同" })
      if (rs.includes(iv))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instrumentVars"], message: "工具变量不能同时做回归变量" })
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
    patterns: [`${runtime.executable} *iv*`],
    always: [`${runtime.executable} *iv*`],
    metadata: { description: `执行${TOOL_LABEL}`, managedRuntime: true },
  })
  const r = await runIvBackend({
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
      instrumentVars: params.instrumentVars,
      instrumentJustification: params.instrumentJustification,
      covariance: params.covariance,
    },
    abort: ctx.abort,
  })
  if (!r.resultPath || !r.coefficientsPath) throw new Error("IV 未生成完整结果文件")
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
      metadata: { backend: "linearmodels.iv", rowsUsed: r.rowsUsed, covariance: r.covariance, spec: params },
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
  const p = r.primary,
    ff = r.firstStageF
  const o = [
    `${TOOL_LABEL}已完成。`,
    `后端：linearmodels ${r.linearmodelsVersion ?? ""}`,
    `有效样本：${r.rowsUsed}`,
    ff !== null && ff !== undefined ? `第一阶段 F 统计量：${nt(ff, 3)}（>10 提示工具强相关）` : "",
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
    // 通用：warning/blocking_errors
    const standard = standardDiagnosticStatus(r)
    let diagnosticsStatus = standard.status
    const findings = [...standard.findings]

    // IV 弱工具变量 F 检验
    const firstStageF = (r as { firstStageF?: number | null }).firstStageF
    if (typeof firstStageF !== "number") {
      diagnosticsStatus = mergePrincipleStatus(diagnosticsStatus, "warn")
      findings.push("IV 结果缺少弱工具变量诊断，结论只能降级为受限证据。")
    } else if (firstStageF < 10) {
      // Staiger-Stock 经验法则 F<10 视为弱工具，但阈值只是参考；样本量、研究设计、
      // Anderson-Rubin 稳健推断等都可能让弱工具下的 IV 估计仍可报告。降为受限证据
      // (restricted)，由模型判断是否仍能给出 IV 估计及附带何种警告（2026-08-08 用户反馈：
      // 硬阈值会剥夺模型对结果的判断空间）。
      diagnosticsStatus = mergePrincipleStatus(diagnosticsStatus, "warn")
      findings.push(`弱工具变量诊断提示 first-stage F=${firstStageF.toFixed(2)}（<10 经验阈值）。该 IV 估计只能作为受限证据，是否仍报告、如何措辞由你判断。`)
    }

    ;(r as { principle_checks?: PrincipleChecks }).principle_checks = buildPrincipleChecks({
      method: METHOD,
      prereqStatus: "pass",
      diagnosticsStatus,
      findings,
    })
  }
  return {
    title: TOOL_LABEL,
    output: o,
    metadata: {
      method: METHOD,
      backend: "linearmodels.iv",
      datasetId: mf?.datasetId ?? params.datasetId,
      stageId: params.stageId ?? st?.stageId,
      runId: rid,
      result: r,
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
          analysisMetric("第一阶段 F", ff !== null && ff !== undefined ? nt(ff, 2) : undefined),
          analysisMetric("N", r.rowsUsed),
        ],
        artifacts: [analysisArtifact(relativeWithinProject(vrp)), analysisArtifact(relativeWithinProject(vcp))],
        warnings: r.warnings,
        conclusion: `${TOOL_LABEL}已完成，工具变量估计量；弱工具检验请检查第一阶段 F 统计量。`,
      }),
    },
  }
}
export const IvTool = Tool.define(METHOD, Tool.Execution.managedFilesystem, ToolModel.forTool(METHOD), {
  description:
    "使用 linearmodels IV2SLS 对内生解释变量做两阶段最小二乘(2SLS)工具变量估计，返回系数与第一阶段 F 统计量。调用前必须在 instrumentJustification 里说明工具变量的相关性/排他性理由；识别理由不足时先用 econometrics_recommend 设计识别策略，不要直接调用。",
  parameters: Input,
  formatValidationError: fmt,
  execute: exec,
})
export const IvEconometricsTools = [IvTool] as const
// @ts-nocheck
