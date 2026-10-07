import z from "zod"
import fs from "fs"
import path from "path"
import { assertDatasetStageReadyForEstimation } from "../../../../src/runtime/workflow"
import { Tool } from "../../../../src/tool/tool"
import { ToolModel } from "../../../../src/tool/model-contracts"
import { Instance } from "../../../../src/project/instance"
import { ensureRuntimePythonReady, formatRuntimePythonSetupError } from "../../../../src/killstata/runtime-config"
import {
  type PrincipleChecks,
  buildPrincipleChecks,
  mergePrincipleStatus,
  standardDiagnosticStatus,
} from "../../../../src/runtime/principle-checks"
import {
  appendArtifact,
  buildFileStamp,
  inferRunId,
  publishVisibleOutput,
  reportOutputPath,
  resolveArtifactInput,
} from "../../../../src/tool/analysis-state"
import { relativeWithinProject } from "../../../../src/tool/analysis-path"
import { analysisArtifact, analysisMetric, createToolAnalysisView } from "../../../../src/tool/analysis-user-view"
import { refreshExperimentLog } from "../../../../src/tool/analysis-experiment-log"
import { numberText } from "../../../../src/util/number-text"
import { EconometricsRecommendTool } from "../../../../src/tool/auto-recommend"
import { runPsmBackend } from "./psm-backend"
import {
  classifyPsmDiagnosticPrecondition,
  formatPsmDiagnosticPreconditionMessage,
  isPsmDiagnosticBlockedResult,
} from "./psm-backend"
import type { PsmAteResult, PsmConstructionResult, PsmMatchingResult, PsmMethod, PsmVisualizeResult, PsmBackendResult, PsmDiagnosticBlockedResult } from "./psm-backend"

const columnName = z.string().trim().min(1, "列名不能为空")
const canonicalDataSourceFields = {
  datasetId: z.string().trim().min(1, "datasetId 不能为空").describe("由 data_import 返回的当前会话数据集 ID，不能自行编造。"),
  stageId: z.string().trim().min(1, "stageId 不能为空").describe("由 data_import/data_preprocess 返回且属于 datasetId 的阶段 ID。"),
}

function validateColumnRoles(
  value: {
    covariates?: string[]
    [key: string]: unknown
  },
  ctx: z.RefinementCtx,
  roleKeys: string[],
) {
  const roles = roleKeys
    .map((key) => [key, value[key]] as const)
    .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string")
  const seen = new Map<string, string>()

  for (const [key, rawName] of roles) {
    const name = rawName.trim()
    const previous = seen.get(name)
    if (previous) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} 不能与 ${previous} 使用同一列`,
      })
    } else {
      seen.set(name, key)
    }
  }

  const covariates = value.covariates ?? []
  if (new Set(covariates).size !== covariates.length) {
    ctx.addIssue({ code: "custom", path: ["covariates"], message: "控制变量不能重复" })
  }
  for (const covariate of covariates) {
    const role = seen.get(covariate)
    if (role) {
      ctx.addIssue({
        code: "custom",
        path: ["covariates"],
        message: `控制变量 ${covariate} 已被用作 ${role}`,
      })
    }
  }
}

function formatValidationError(error: z.ZodError) {
  const details = error.issues.map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`).join("；")
  return `计量工具参数不合法：${details}`
}

const PSM_ESTIMATOR_TOOL_IDS = ["psm_matching", "psm_ipw", "psm_regression", "psm_double_robust"] as const

/** 诊断成功后是否已经有用户明确要求的后续 PSM 估计器。 */
export function psmDiagnosticRequiresUserDecision(input: { requestedToolIDs?: readonly string[] }) {
  const requested = new Set(input.requestedToolIDs ?? [])
  return !PSM_ESTIMATOR_TOOL_IDS.some((toolID) => requested.has(toolID))
}

/** 共享的 PSM 执行骨架：数据解析 → 调后端 → 归档产物 → 返回原始结果 */
async function executePsmTool(input: {
  method: PsmMethod
  dependentVar?: string
  treatmentVar: string
  covariates: string[]
  analysisUnitVar?: string
  preTreatmentAggregation?: "not_applicable" | "baseline" | "pre_treatment_mean"
  datasetId: string
  stageId: string
  branch?: string
  runId?: string
  ctx: Tool.Context
  permissionPattern: string
  permissionLabel: string
}): Promise<PsmBackendResult | PsmDiagnosticBlockedResult> {
  assertDatasetStageReadyForEstimation({
    sessionID: input.ctx.sessionID,
    datasetId: input.datasetId,
    stageId: input.stageId,
  })
  const runtime = await ensureRuntimePythonReady()
  if (!runtime.ok || runtime.missing.length) throw new Error(formatRuntimePythonSetupError(input.method, runtime))

  const artifactInput = resolveArtifactInput({ datasetId: input.datasetId, stageId: input.stageId })
  const dataPath = artifactInput.resolvedInputPath
  if (!dataPath || !fs.existsSync(dataPath)) throw new Error("找不到数据文件")

  const manifest = artifactInput.manifest
  const stage = artifactInput.stage
  // 分支和运行 ID 是工作流血缘字段，不是模型可以自由命名的研究参数。
  // 只要当前 stage 存在，就沿用其规范值，避免模型把 psm_main 等标题写成新分支。
  const branch = stage?.branch ?? input.branch ?? "main"
  const runId = inferRunId({ requestedRunId: input.runId, stage, source: "model" })
  const outputDir = manifest
    ? reportOutputPath({
        datasetId: manifest.datasetId,
        action: input.method,
        stageId: input.stageId ?? stage?.stageId,
        branch,
        format: "json",
        stamp: buildFileStamp(),
      }).replace(/\.json$/, "")
    : path.join(Instance.directory, "analysis", `${input.method}_${buildFileStamp()}`)
  fs.mkdirSync(outputDir, { recursive: true })

  await input.ctx.ask({
    permission: "bash",
    patterns: [input.permissionPattern],
    always: [input.permissionPattern],
    metadata: { description: input.permissionLabel, managedRuntime: true },
  })

  let result: PsmBackendResult | PsmDiagnosticBlockedResult
  try {
    result = await runPsmBackend({
      pythonCommand: runtime.executable,
      cwd: Instance.directory,
      sessionID: input.ctx.sessionID,
      payload: {
        method: input.method,
        dataPath,
        outputDir,
        dependentVar: input.dependentVar,
        treatmentVar: input.treatmentVar,
        covariates: input.covariates,
        analysisUnitVar: input.analysisUnitVar,
        preTreatmentAggregation: input.preTreatmentAggregation,
      },
      abort: input.ctx.abort,
    })
  } catch (error) {
    const diagnosticMethod = input.method === "psm_construction" || input.method === "psm_visualize" ? input.method : undefined
    const precondition = diagnosticMethod ? classifyPsmDiagnosticPrecondition(String(error)) : undefined
    if (!diagnosticMethod || !precondition) throw error
    return {
      success: false,
      method: diagnosticMethod,
      precondition,
      message: formatPsmDiagnosticPreconditionMessage(input.treatmentVar),
    }
  }

  if (isPsmDiagnosticBlockedResult(result)) return result

  if (manifest) {
    appendArtifact(manifest, {
      artifactId: `${input.method}_${Date.now()}`,
      runId,
      stageId: input.stageId ?? stage?.stageId,
      branch,
      action: input.method,
      outputPath: result.resultPath,
      summaryPath: result.resultPath,
      createdAt: new Date().toISOString(),
      metadata: { backend: "psm_runner", rowsUsed: result.rowsUsed, spec: { method: input.method, dependentVar: input.dependentVar, treatmentVar: input.treatmentVar, covariates: input.covariates } },
    })
    publishVisibleOutput({
      manifest,
      key: `${input.method}_result`,
      label: `PSM(${input.method})结果`,
      sourcePath: result.resultPath,
      runId,
      branch: path.join("econometrics", input.method),
      stageId: input.stageId ?? stage?.stageId,
    })
    refreshExperimentLog(manifest.datasetId)
  }

  // ── 声明上限：PSM 工具的共同支撑/加权平衡/有效样本诊断 ──
  {
    const r = result as {
      warnings?: string[]
      method: string
      shareInSupport?: number | null
      weightedMaxAbsSmd?: number
      treatmentEss?: number
      controlEss?: number
    }
    const standard = standardDiagnosticStatus(r)
    let diagnosticsStatus = standard.status
    const findings = [...standard.findings]

    // 共同支撑不足 → block
    if (typeof r.shareInSupport === "number" && r.shareInSupport < 0.9) {
      diagnosticsStatus = mergePrincipleStatus(diagnosticsStatus, "block")
      findings.push(`PSM 共同支撑占比过低（${(r.shareInSupport * 100).toFixed(1)}%），当前结果不能作为可靠因果证据。`)
    }
    // 加权后最大绝对 SMD 超过 0.1 → block
    if (typeof r.weightedMaxAbsSmd === "number" && r.weightedMaxAbsSmd > 0.1) {
      diagnosticsStatus = mergePrincipleStatus(diagnosticsStatus, "block")
      findings.push(`PSM 加权后最大绝对 SMD=${r.weightedMaxAbsSmd.toFixed(4)} 超过 0.1。`)
    }
    // 有效样本量不足（处理组或对照组 < 30）→ warn
    if (typeof r.treatmentEss === "number" && r.treatmentEss < 30) {
      diagnosticsStatus = mergePrincipleStatus(diagnosticsStatus, "warn")
      findings.push(`处理组有效样本量（${r.treatmentEss.toFixed(1)}）小于 30。`)
    }
    if (typeof r.controlEss === "number" && r.controlEss < 30) {
      diagnosticsStatus = mergePrincipleStatus(diagnosticsStatus, "warn")
      findings.push(`对照组有效样本量（${r.controlEss.toFixed(1)}）小于 30。`)
    }

    ;(result as { principle_checks?: PrincipleChecks }).principle_checks = buildPrincipleChecks({
      method: r.method,
      prereqStatus: "pass",
      diagnosticsStatus,
      findings,
    })
  }

  return result
}

function blockedPsmDiagnosticResponse(input: {
  title: string
  step: "psm_construction" | "psm_visualize"
  datasetId: string
  stageId: string
  result: PsmDiagnosticBlockedResult
}) {
  return {
    title: `${input.title}未执行`,
    output: input.result.message,
    metadata: {
      method: input.step,
      datasetId: input.datasetId,
      stageId: input.stageId,
      requiresUserDecision: true,
      groundingScope: "diagnostic",
      analysisView: createToolAnalysisView({
        kind: "econometrics",
        step: input.step,
        datasetId: input.datasetId,
        stageId: input.stageId,
        warnings: [input.result.message],
        conclusion: "诊断前提不满足，未生成倾向得分或分布图；请选择包含处理组和对照组的数据阶段。",
      }),
    },
  }
}

const propensityScoreParameters = z
  .object({
    ...canonicalDataSourceFields,
    treatmentVar: columnName.describe("严格以 0/1 编码的处理变量列名"),
    covariates: z.array(columnName).min(1, "至少需要一个处理前协变量").describe("用于估计处理概率的处理前协变量列名"),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateColumnRoles(value, ctx, ["treatmentVar"])
  })

const psmPreTreatmentAggregation = z
  .enum(["not_applicable", "baseline", "pre_treatment_mean"])
  .describe(
    "当前 stage 如何已被整理为每个分析单位一行：横截面填 not_applicable；面板只能填 baseline 或 pre_treatment_mean。工具会验证一行一个单位，但单行数据本身无法自动证明协变量发生在处理前",
  )

const psmMatchingParameters = z
  .object({
    ...canonicalDataSourceFields,
    dependentVar: columnName.describe("结果变量列名"),
    treatmentVar: columnName.describe("严格以 0/1 编码的处理变量列名"),
    covariates: z
      .array(columnName)
      .min(1, "至少需要一个处理前协变量")
      .describe("用于倾向得分和匹配后平衡检查的处理前协变量列名"),
    analysisUnitVar: columnName.describe("分析单位唯一标识列；当前 stage 必须已整理为每个单位一行"),
    preTreatmentAggregation: psmPreTreatmentAggregation,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateColumnRoles(value, ctx, ["dependentVar", "treatmentVar", "analysisUnitVar"])
  })

const psmCausalEstimatorParameters = z
  .object({
    ...canonicalDataSourceFields,
    dependentVar: columnName.describe("结果变量列名"),
    treatmentVar: columnName.describe("严格以 0/1 编码的处理变量列名"),
    covariates: z
      .array(columnName)
      .min(1, "至少需要一个处理前协变量")
      .describe("用于倾向得分和加权平衡检查的处理前协变量列名"),
    analysisUnitVar: columnName.describe("分析单位唯一标识列；当前 stage 必须已整理为每个单位一行"),
    preTreatmentAggregation: psmPreTreatmentAggregation,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateColumnRoles(value, ctx, ["dependentVar", "treatmentVar", "analysisUnitVar"])
  })

const psmIpwParameters = psmCausalEstimatorParameters
const psmOutcomeAdjustmentParameters = psmCausalEstimatorParameters

const olsParameters = z
  .object({
    ...canonicalDataSourceFields,
    dependentVar: columnName.describe("结果变量列名"),
    treatmentVar: columnName.describe("核心解释变量列名"),
    covariates: z.array(columnName).optional().describe("控制变量列名；不包含结果变量或核心解释变量"),
    covariance: z.enum(["HC1", "HC2", "HC3", "nonrobust"]).default("HC1").describe("标准误类型，默认 HC1"),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateColumnRoles(value, ctx, ["dependentVar", "treatmentVar"])
  })

export const PropensityScoreConstructionTool = Tool.define("psm_construction", Tool.Execution.managedFilesystem, ToolModel.forTool("psm_construction"), async () => ({
  description:
    "估计每行样本接受处理的倾向得分，并检查得分范围与共同支撑。只用于研究设计诊断；不估计因果效应，不输出 ATE、ATT 或显著性结论。",
  parameters: propensityScoreParameters,
  formatValidationError,
    execute: async (params, ctx) => {
      const result = await executePsmTool({
      method: "psm_construction",
      treatmentVar: params.treatmentVar,
      covariates: params.covariates,
      datasetId: params.datasetId,
      stageId: params.stageId,
      ctx,
      permissionPattern: "*psm*",
        permissionLabel: "执行倾向得分诊断",
      })
      if (isPsmDiagnosticBlockedResult(result)) {
        return blockedPsmDiagnosticResponse({
          title: "倾向得分诊断",
          step: "psm_construction",
          datasetId: params.datasetId,
          stageId: params.stageId,
          result,
        })
      }
      const r = result as PsmConstructionResult
    return {
      title: "倾向得分诊断",
      output: [
        "倾向得分估计完成。",
        `有效样本：${r.rowsUsed}`,
        `得分范围：${numberText(r.scoreMin)} 至 ${numberText(r.scoreMax)}`,
        `处理组均值：${numberText(r.meanTreated)}；对照组均值：${numberText(r.meanControl)}`,
        `极端得分占比：${(r.extremeScoreShare * 100).toFixed(1)}%`,
        r.shareInSupport !== null ? `共同支撑占比：${(r.shareInSupport * 100).toFixed(1)}%` : "",
        ...r.warnings.map((w) => `提示：${w}`),
        "",
        "本步骤不是因果效应估计。",
      ]
        .filter((l) => l !== "")
        .join("\n"),
      metadata: {
        method: "psm_construction" as const,
        backend: "psm_runner",
        datasetId: params.datasetId,
        stageId: params.stageId,
        // 诊断是研究设计检查点，不自动把结果升级成匹配/加权估计；用户明确
        // 下一步后再继续，避免模型在同一轮重复导入或擅自切换估计目标。
        requiresUserDecision: psmDiagnosticRequiresUserDecision({
          requestedToolIDs: [
            ...(Array.isArray(ctx.extra?.preferredToolIDs) ? ctx.extra.preferredToolIDs : []),
            ...(Array.isArray(ctx.extra?.confirmedToolIDs) ? ctx.extra.confirmedToolIDs : []),
          ],
        }),
        groundingScope: "diagnostic",
        result: r,
        analysisView: createToolAnalysisView({
          kind: "econometrics",
          step: "psm_construction",
          datasetId: params.datasetId,
          stageId: params.stageId,
          results: [
            analysisMetric("N", r.rowsUsed),
            analysisMetric("得分范围", `${numberText(r.scoreMin)}–${numberText(r.scoreMax)}`),
            analysisMetric("共同支撑占比", r.shareInSupport !== null ? `${(r.shareInSupport * 100).toFixed(1)}%` : undefined),
          ],
          artifacts: [
            analysisArtifact(relativeWithinProject(r.resultPath), { label: "逐行倾向得分", visibility: "user_collapsed" }),
          ],
          warnings: r.warnings,
          conclusion: "已完成处理分配与共同支撑诊断；本步骤不是因果效应估计。",
        }),
      },
    }
  },
}))

export const PropensityScoreVisualizationTool = Tool.define("psm_visualize", Tool.Execution.managedFilesystem, ToolModel.forTool("psm_visualize"), async () => ({
  description:
    "绘制处理组与对照组的倾向得分分布，检查重叠和共同支撑。只在用户要求查看分布或重叠诊断时调用；不估计因果效应，不输出 ATE、ATT 或显著性结论。",
  parameters: propensityScoreParameters,
  formatValidationError,
    execute: async (params, ctx) => {
      const result = await executePsmTool({
      method: "psm_visualize",
      treatmentVar: params.treatmentVar,
      covariates: params.covariates,
      datasetId: params.datasetId,
      stageId: params.stageId,
      ctx,
      permissionPattern: "*psm*",
        permissionLabel: "执行倾向得分分布诊断",
      })
      if (isPsmDiagnosticBlockedResult(result)) {
        return blockedPsmDiagnosticResponse({
          title: "倾向得分分布诊断",
          step: "psm_visualize",
          datasetId: params.datasetId,
          stageId: params.stageId,
          result,
        })
      }
      const r = result as PsmVisualizeResult
    return {
      title: "倾向得分分布诊断",
      output: [
        "倾向得分分布图已生成。",
        `有效样本：${r.rowsUsed}`,
        `得分范围：${numberText(r.scoreMin)} 至 ${numberText(r.scoreMax)}`,
        `处理组均值：${numberText(r.meanTreated)}；对照组均值：${numberText(r.meanControl)}`,
        `共同支撑占比：${r.shareInSupport !== null ? `${(r.shareInSupport * 100).toFixed(1)}%` : "未知"}`,
        ...r.warnings.map((w) => `提示：${w}`),
        "",
        "分布图已生成，已保存为本次分析产物。",
      ]
        .filter((l) => l !== "")
        .join("\n"),
      metadata: {
        method: "psm_visualize" as const,
        backend: "psm_runner",
        datasetId: params.datasetId,
        stageId: params.stageId,
        // 诊断是研究设计检查点，不自动把结果升级成匹配/加权估计；用户明确
        // 下一步后再继续，避免模型在同一轮重复导入或擅自切换估计目标。
        requiresUserDecision: psmDiagnosticRequiresUserDecision({
          requestedToolIDs: [
            ...(Array.isArray(ctx.extra?.preferredToolIDs) ? ctx.extra.preferredToolIDs : []),
            ...(Array.isArray(ctx.extra?.confirmedToolIDs) ? ctx.extra.confirmedToolIDs : []),
          ],
        }),
        groundingScope: "diagnostic",
        result: r,
        analysisView: createToolAnalysisView({
          kind: "econometrics",
          step: "psm_visualize",
          datasetId: params.datasetId,
          stageId: params.stageId,
          results: [
            analysisMetric("N", r.rowsUsed),
            analysisMetric("得分范围", `${numberText(r.scoreMin)}–${numberText(r.scoreMax)}`),
            analysisMetric("共同支撑占比", r.shareInSupport !== null ? `${(r.shareInSupport * 100).toFixed(1)}%` : undefined),
          ],
          artifacts: [
            analysisArtifact(relativeWithinProject(r.plotPath), { label: "倾向得分分布图", visibility: "user_default" }),
          ],
          warnings: r.warnings,
          conclusion: "已完成处理分配与重叠诊断；本步骤不是因果效应估计。",
        }),
      },
    }
  },
}))

export const PsmMatchingTool = Tool.define("psm_matching", Tool.Execution.managedFilesystem, ToolModel.forTool("psm_matching"), async () => ({
  description:
    "运行固定规则的 1:1 倾向得分最近邻匹配，估计已匹配处理组的 ATT。仅在用户明确要求匹配、已确认处理变量/结果变量/处理前协变量，且当前 stage 已按分析单位整理为一行一个单位时调用；面板原始逐期行不得直接匹配。工具会验证一行一个单位，但需由用户/上游数据证明协变量确实发生在处理前。工具固定 caliper 与匹配规则，不接受自定义比例或阈值。只在匹配后协变量平衡达标时返回效应；不输出 p 值、置信区间或显著性结论。",
  parameters: psmMatchingParameters,
  formatValidationError,
  execute: async (params, ctx) => {
    const result = await executePsmTool({
      method: "psm_matching",
      dependentVar: params.dependentVar,
      treatmentVar: params.treatmentVar,
      covariates: params.covariates,
      analysisUnitVar: params.analysisUnitVar,
      preTreatmentAggregation: params.preTreatmentAggregation,
      datasetId: params.datasetId,
      stageId: params.stageId,
      ctx,
      permissionPattern: "*psm*",
      permissionLabel: "执行倾向得分匹配",
    })
    const r = result as PsmMatchingResult
    return {
      title: "倾向得分最近邻匹配",
      output: [
        "倾向得分匹配完成。",
        `ATT（已匹配处理组）：${numberText(r.att)}`,
        `已匹配处理组：${r.matchedTreatedCount}/${r.treatedCount}`,
        `未匹配处理组（超出 caliper）：${r.unmatchedTreatedCount}`,
        `匹配后最大绝对 SMD：${numberText(r.postMatchMaxAbsSmd, 4)}（阈值 ≤ 0.1000）`,
        ...r.warnings.map((w) => `提示：${w}`),
        "",
        "未输出标准误、p 值、置信区间或显著性结论。",
      ]
        .filter((l) => l !== "")
        .join("\n"),
      metadata: {
        method: "psm_matching",
        backend: "psm_runner",
        datasetId: params.datasetId,
        stageId: params.stageId,
        // 标注证据口径：匹配类结果只覆盖已匹配处理组，不可当作全样本效应解读。
        groundingScope: "matching",
        result: r,
        analysisView: createToolAnalysisView({
          kind: "econometrics",
          step: "psm_matching",
          datasetId: params.datasetId,
          stageId: params.stageId,
          results: [
            analysisMetric("ATT（已匹配处理组）", numberText(r.att)),
            analysisMetric("已匹配处理组", r.matchedTreatedCount),
            analysisMetric("未匹配处理组", r.unmatchedTreatedCount),
            analysisMetric("匹配后最大绝对 SMD", numberText(r.postMatchMaxAbsSmd, 4)),
          ],
          artifacts: [
            analysisArtifact(relativeWithinProject(r.resultPath), { label: "匹配结果", visibility: "user_collapsed" }),
          ],
          warnings: r.warnings,
          conclusion: "固定规则的最近邻匹配已通过协变量平衡阈值；该结果只对应已匹配处理组，且不包含显著性推断。",
        }),
      },
    }
  },
}))

export const PsmIpwTool = Tool.define("psm_ipw", Tool.Execution.managedFilesystem, ToolModel.forTool("psm_ipw"), async () => ({
  description:
    "运行固定规则的 Hájek 逆概率加权，估计 ATE。仅在用户明确要求 IPW/逆概率加权、已确认处理变量/结果变量/处理前协变量，且当前 stage 已按分析单位整理为一行一个单位时调用；面板原始逐期行不得直接加权。工具会验证一行一个单位，但需由用户/上游数据证明协变量确实发生在处理前。不接受自定义目标效应、截尾、裁剪或权重公式。只有所有倾向得分处于固定重叠区间、两组有效样本量均达标且加权协变量平衡达标时才返回效应；不输出 p 值、置信区间或显著性结论。",
  parameters: psmIpwParameters,
  formatValidationError,
  execute: async (params, ctx) => {
    const result = await executePsmTool({
      method: "psm_ipw",
      dependentVar: params.dependentVar,
      treatmentVar: params.treatmentVar,
      covariates: params.covariates,
      analysisUnitVar: params.analysisUnitVar,
      preTreatmentAggregation: params.preTreatmentAggregation,
      datasetId: params.datasetId,
      stageId: params.stageId,
      ctx,
      permissionPattern: "*psm*",
      permissionLabel: "执行逆概率加权（IPW）",
    })
    const r = result as PsmAteResult
    return {
      title: "逆概率加权（IPW）",
      output: [
        "逆概率加权（IPW）完成。",
        `ATE：${numberText(r.ate)}（固定为 Hájek 归一化 ATE）`,
        `有效样本量：处理组 ${numberText(r.treatmentEss, 2)}；对照组 ${numberText(r.controlEss, 2)}`,
        `加权后最大绝对 SMD：${numberText(r.weightedMaxAbsSmd, 4)}（阈值 ≤ 0.1000）`,
        ...r.warnings.map((w) => `提示：${w}`),
        "",
        "未输出标准误、p 值、置信区间或显著性结论。",
      ]
        .filter((l) => l !== "")
        .join("\n"),
      metadata: {
        method: "psm_ipw",
        backend: "psm_runner",
        datasetId: params.datasetId,
        stageId: params.stageId,
        groundingScope: "weighting",
        result: r,
        analysisView: createToolAnalysisView({
          kind: "econometrics",
          step: "psm_ipw",
          datasetId: params.datasetId,
          stageId: params.stageId,
          results: [
            analysisMetric("ATE", numberText(r.ate)),
            analysisMetric("处理组有效样本量", numberText(r.treatmentEss, 2)),
            analysisMetric("对照组有效样本量", numberText(r.controlEss, 2)),
            analysisMetric("加权后最大绝对 SMD", numberText(r.weightedMaxAbsSmd, 4)),
          ],
          artifacts: [
            analysisArtifact(relativeWithinProject(r.resultPath), { label: "加权结果", visibility: "user_collapsed" }),
          ],
          warnings: r.warnings,
          conclusion: "固定 Hájek 逆概率加权已通过重叠、有效样本量与协变量平衡阈值；当前不包含显著性推断。",
        }),
      },
    }
  },
}))

export const PsmRegressionTool = Tool.define("psm_regression", Tool.Execution.managedFilesystem, ToolModel.forTool("psm_regression"), async () => ({
  description:
    "运行固定的线性倾向得分回归调整，估计 ATE。仅在用户明确要求倾向得分回归调整、已确认处理变量/结果变量/处理前协变量，且当前 stage 已按分析单位整理为一行一个单位时调用。工具会验证一行一个单位，但需由用户/上游数据证明协变量确实发生在处理前。工具固定为 Y ~ 1 + T + e(X)，不接受函数形式、协方差或输出目录等选项；只有重叠、有效样本量和加权平衡均达标时返回点估计，不输出 p 值、置信区间或显著性结论。",
  parameters: psmOutcomeAdjustmentParameters,
  formatValidationError,
  execute: async (params, ctx) => {
    const result = await executePsmTool({
      method: "psm_regression",
      dependentVar: params.dependentVar,
      treatmentVar: params.treatmentVar,
      covariates: params.covariates,
      analysisUnitVar: params.analysisUnitVar,
      preTreatmentAggregation: params.preTreatmentAggregation,
      datasetId: params.datasetId,
      stageId: params.stageId,
      ctx,
      permissionPattern: "*psm*",
      permissionLabel: "执行倾向得分回归调整",
    })
    const r = result as PsmAteResult
    return {
      title: "倾向得分回归调整",
      output: [
        "倾向得分回归调整完成。",
        `ATE：${numberText(r.ate)}`,
        `有效样本量：处理组 ${numberText(r.treatmentEss, 2)}；对照组 ${numberText(r.controlEss, 2)}`,
        `加权后最大绝对 SMD：${numberText(r.weightedMaxAbsSmd, 4)}（阈值 ≤ 0.1000）`,
        ...r.warnings.map((w) => `提示：${w}`),
        "",
        "未输出标准误、p 值、置信区间或显著性结论。",
        "识别假设：协变量必须在处理前形成，且已满足条件独立性与重叠性。",
      ]
        .filter((l) => l !== "")
        .join("\n"),
      metadata: {
        method: "psm_regression",
        backend: "psm_runner",
        datasetId: params.datasetId,
        stageId: params.stageId,
        groundingScope: "outcome_adjustment",
        result: r,
        analysisView: createToolAnalysisView({
          kind: "econometrics",
          step: "psm_regression",
          datasetId: params.datasetId,
          stageId: params.stageId,
          results: [
            analysisMetric("ATE", numberText(r.ate)),
            analysisMetric("处理组有效样本量", numberText(r.treatmentEss, 2)),
            analysisMetric("对照组有效样本量", numberText(r.controlEss, 2)),
            analysisMetric("加权后最大绝对 SMD", numberText(r.weightedMaxAbsSmd, 4)),
          ],
          artifacts: [
            analysisArtifact(relativeWithinProject(r.resultPath), { label: "倾向得分调整结果", visibility: "user_collapsed" }),
          ],
          warnings: r.warnings,
          conclusion: "固定线性倾向得分回归调整已通过重叠、有效样本量和加权平衡门；当前不包含显著性推断。",
        }),
      },
    }
  },
}))

export const PsmDoubleRobustTool = Tool.define("psm_double_robust", Tool.Execution.managedFilesystem, ToolModel.forTool("psm_double_robust"), async () => ({
  description:
    "运行固定的 AIPW 双重稳健估计，估计 ATE。仅在用户明确要求双重稳健/AIPW、已确认处理变量/结果变量/处理前协变量，且当前 stage 已按分析单位整理为一行一个单位时调用。工具会验证一行一个单位，但需由用户/上游数据证明协变量确实发生在处理前。工具固定使用 Logit 倾向得分与处理组/对照组各自的线性结果模型；不接受函数形式、截尾、协方差或输出目录等选项。只有重叠、有效样本量、加权平衡和两个结果模型秩均达标时返回点估计，不输出 p 值、置信区间或显著性结论。",
  parameters: psmOutcomeAdjustmentParameters,
  formatValidationError,
  execute: async (params, ctx) => {
    const result = await executePsmTool({
      method: "psm_double_robust",
      dependentVar: params.dependentVar,
      treatmentVar: params.treatmentVar,
      covariates: params.covariates,
      analysisUnitVar: params.analysisUnitVar,
      preTreatmentAggregation: params.preTreatmentAggregation,
      datasetId: params.datasetId,
      stageId: params.stageId,
      ctx,
      permissionPattern: "*psm*",
      permissionLabel: "执行双重稳健 AIPW",
    })
    const r = result as PsmAteResult
    return {
      title: "双重稳健 AIPW",
      output: [
        "双重稳健 AIPW 完成。",
        `ATE：${numberText(r.ate)}`,
        `有效样本量：处理组 ${numberText(r.treatmentEss, 2)}；对照组 ${numberText(r.controlEss, 2)}`,
        `加权后最大绝对 SMD：${numberText(r.weightedMaxAbsSmd, 4)}（阈值 ≤ 0.1000）`,
        ...r.warnings.map((w) => `提示：${w}`),
        "",
        "未输出标准误、p 值、置信区间或显著性结论。",
        "识别假设：协变量必须在处理前形成，且已满足条件独立性与重叠性。",
      ]
        .filter((l) => l !== "")
        .join("\n"),
      metadata: {
        method: "psm_double_robust",
        backend: "psm_runner",
        datasetId: params.datasetId,
        stageId: params.stageId,
        groundingScope: "outcome_adjustment",
        result: r,
        analysisView: createToolAnalysisView({
          kind: "econometrics",
          step: "psm_double_robust",
          datasetId: params.datasetId,
          stageId: params.stageId,
          results: [
            analysisMetric("ATE", numberText(r.ate)),
            analysisMetric("处理组有效样本量", numberText(r.treatmentEss, 2)),
            analysisMetric("对照组有效样本量", numberText(r.controlEss, 2)),
            analysisMetric("加权后最大绝对 SMD", numberText(r.weightedMaxAbsSmd, 4)),
          ],
          artifacts: [
            analysisArtifact(relativeWithinProject(r.resultPath), { label: "双重稳健结果", visibility: "user_collapsed" }),
          ],
          warnings: r.warnings,
          conclusion: "固定 AIPW 双重稳健估计已通过重叠、有效样本量、加权平衡和结果模型识别门；当前不包含显著性推断。",
        }),
      },
    }
  },
}))

// OLS / 面板 FE / IV 已迁到独立 runner，这里只做别名再导出供既有 import 使用。
// 注意：不能再包一层 Tool.define——那样会产生同名工具（ID 与独立工具重复注册），
// 且包装层没有 parameters，Tool.define 的 parse 会在调用时抛错。
export { EconometricsRecommendTool } from "../../../../src/tool/auto-recommend"
export { OlsRegressionTool } from "./ols"
export { PanelFeTool as PanelFeRegressionTool } from "./panel-fe"
export { IvTool as Iv2slsTool } from "./iv"

// 独立工具由 registry 各自的 *EconometricsTools 数组注册，不重复列在这里。
export const ProductionEconometricsTools = [
  EconometricsRecommendTool,
  PropensityScoreConstructionTool,
  PropensityScoreVisualizationTool,
  PsmMatchingTool,
  PsmIpwTool,
  PsmRegressionTool,
  PsmDoubleRobustTool,
] as const
// @ts-nocheck
