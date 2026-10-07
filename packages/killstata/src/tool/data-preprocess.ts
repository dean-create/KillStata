import fs from "fs"
import path from "path"
import crypto from "crypto"
import { ensureRuntimePythonReady, formatRuntimePythonSetupError } from "@/killstata/runtime-config"
import { assertDatasetStageReadyForPreprocess } from "@/runtime/workflow"
import {
  appendArtifact,
  appendStage,
  buildFileStamp,
  datasetRoot,
  inferRunId,
  nextStageId,
  publishVisibleOutput,
  reportOutputPath,
  stageMetaPaths,
  stageOutputPath,
} from "./analysis-state"
import { relativeWithinProject, resolveDatasetStagePath, resolveManagedProjectPath, resolveToolPath } from "./analysis-path"
import { analysisArtifact, analysisMetric, createToolAnalysisView } from "./analysis-user-view"
import { refreshExperimentLog } from "./analysis-experiment-log"
import {
  PREPROCESS_METHOD_IDS,
  runDataPreprocessBackend,
  type DataPreprocessBackendResult,
  type DataPreprocessPayload,
  type PreprocessMethod,
} from "./data-preprocess-backend"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import { pythonCapabilityInput } from "./python-capability-schema"

const METHOD_LABELS: Record<PreprocessMethod, string> = {
  listwise_deletion: "删除含缺失值的行",
  mean_impute: "均值填补",
  median_impute: "中位数填补",
  knn_impute: "KNN 填补",
  zscore_detect: "Z-Score 异常值检测",
  iqr_detect: "IQR 异常值检测",
  winsorize: "缩尾处理",
  trim: "截尾处理",
  zscore_standardize: "Z-Score 标准化",
  minmax_scale: "Min-Max 缩放",
  robust_scale: "稳健缩放",
  log_transform: "对数变换",
  boxcox_transform: "Box-Cox 变换",
  yeojohnson_transform: "Yeo-Johnson 变换",
  fill_constant: "常数值填补",
  forward_fill: "前向填充（LOCF）",
  backward_fill: "后向填充（NOCB）",
  linear_interpolate: "线性插值",
  group_linear_interpolate: "分组线性插值",
  regression_impute: "回归插补",
  create_dummies: "生成虚拟变量（独热编码）",
  combine_columns: "组合列",
  filter: "筛选样本",
  create_column: "条件列创建（根据比较表达式生成 0/1 指示列）",
  create_relative_time: "构造已确认的 DID2S 相对时期",
  coerce_numeric: "按明确缺失标记转换数值文本",
}

/** data_preprocess 中会改变数据、创建新阶段的方法（区别于 zscore_detect/iqr_detect 只读诊断）。
 *  导出供 revert-dataset 派生撤销锚点集，避免两处硬编码漂移。 */
export const MUTATING_METHODS = new Set<PreprocessMethod>([
  "listwise_deletion",
  "mean_impute",
  "median_impute",
  "knn_impute",
  "winsorize",
  "trim",
  "zscore_standardize",
  "minmax_scale",
  "robust_scale",
  "log_transform",
  "boxcox_transform",
  "yeojohnson_transform",
  "fill_constant",
  "forward_fill",
  "backward_fill",
  "linear_interpolate",
  "group_linear_interpolate",
  "regression_impute",
  "create_dummies",
  "combine_columns",
  "filter",
  "create_column",
  "create_relative_time",
  "coerce_numeric",
])

type PreprocessParams = Record<string, any>
const PreprocessInputSchema = pythonCapabilityInput<PreprocessParams>()

export function formatDataPreprocessOutput(input: {
  datasetId: string
  effectiveStageId: string
  parentStageId: string
  method: PreprocessMethod
  columns: string[]
  mutation: boolean
  visibleDiagnosticPath?: string
  result: Pick<
    DataPreprocessBackendResult,
    | "rowsBefore"
    | "rowsAfter"
    | "columnsBefore"
    | "columnsAfter"
    | "warnings"
    | "createdColumns"
    | "rowsDropped"
    | "convertedNumeric"
    | "missingTokensApplied"
    | "missingTokensConverted"
    | "rowsRetained"
  >
}) {
  const lines: string[] = [`## ${METHOD_LABELS[input.method]}完成`]
  if (input.columns.length) lines.push(`处理列：${input.columns.join("、")}`)
  lines.push(
    `行数：${input.result.rowsBefore} → ${input.result.rowsAfter}`,
    `列数：${input.result.columnsBefore} → ${input.result.columnsAfter}`,
  )
  if (input.mutation) {
    lines.push(
      `已创建新的规范化数据阶段：datasetId=${input.datasetId}，stageId=${input.effectiveStageId}（父阶段 ${input.parentStageId}）。`,
      `后续 describe、数据质量检查 和估计必须原样使用 datasetId=${input.datasetId}、stageId=${input.effectiveStageId}；不要使用 workflow 的内部节点 ID。`,
    )
    if (input.method === "combine_columns") {
      lines.push("本次只新增复合实体列并保留全部原始观测，未删除行、未去重、未改变样本范围。")
    }
    if (input.method === "coerce_numeric") {
      lines.push(`已将以下列按明确规则转换为数值型：${input.result.convertedNumeric?.join("、") ?? input.columns.join("、")}。`)
      const missingTokens = input.result.missingTokensApplied ?? []
      if (missingTokens.length) {
        const counts = Object.entries(input.result.missingTokensConverted ?? {})
          .filter(([, count]) => count > 0)
          .map(([column, count]) => `${column} 中的 ${missingTokens.join("、")} 共 ${count} 个`)
        lines.push(`仅将声明的标记 ${missingTokens.join("、")} 转为缺失值${counts.length ? `（${counts.join("；")}）` : ""}。`)
      }
      lines.push(`保留全部 ${input.result.rowsRetained ?? input.result.rowsAfter} 行；没有插补或删除观测。`)
    }
  } else {
    lines.push(
      "已生成诊断报告，原数据未改变。",
      `后续 describe、数据质量检查 和估计继续使用原数据阶段：datasetId=${input.datasetId}、stageId=${input.parentStageId}；不要使用 workflow 的内部节点 ID。`,
    )
  }
  if (input.visibleDiagnosticPath) lines.push("诊断报告已生成，已保存为本次分析产物。")
  if (input.result.createdColumns?.length) lines.push(`新增列：${input.result.createdColumns.join("、")}`)
  if (input.result.rowsDropped !== undefined) lines.push(`删除行数：${input.result.rowsDropped}`)
  if (input.result.warnings.length) lines.push(`提醒：${input.result.warnings.join("；")}`)
  return lines.join("\n")
}

function writeJson(pathname: string, value: unknown) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true })
  fs.writeFileSync(pathname, JSON.stringify(value, null, 2), "utf-8")
}

function provenance(sourcePath: string, params: PreprocessParams) {
  return {
    sourceFileHash: crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"),
    parameterFingerprint: crypto.createHash("sha256").update(JSON.stringify(params)).digest("hex"),
  }
}

function stageHasColumn(stage: { metadata?: Record<string, unknown> }, columnName: string) {
  const metadata = stage.metadata?.dataReadiness ?? stage.metadata?.readiness
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false
  const columns = (metadata as { columns?: unknown }).columns
  return Array.isArray(columns) && columns.some(
    (column) => column && typeof column === "object" && !Array.isArray(column) && (column as { name?: unknown }).name === columnName,
  )
}

/**
 * 用户纠正post规则时，模型可能把新规则错误地应用到已经含post的子阶段。
 * 回退到真实父阶段可以保留旧分支，同时生成一条新的、可追溯的规则分支；只有
 * 能证明父阶段没有该列时才回退，避免吞掉普通的同名列冲突。
 */
function sourceStageForPolicyRebuild(
  ready: ReturnType<typeof assertDatasetStageReadyForPreprocess>,
  params: PreprocessParams,
) {
  const outputColumn = params.options?.output_column
  if (params.method !== "create_column" || outputColumn?.trim().toLowerCase() !== "post") return ready.stage
  if (!stageHasColumn(ready.stage, "post") || !ready.stage.parentStageId) return ready.stage
  const parent = ready.manifest.stages.find((stage) => stage.stageId === ready.stage.parentStageId)
  if (!parent || stageHasColumn(parent, "post") || !fs.existsSync(parent.workingPath)) return ready.stage
  return parent
}

export const DataPreprocessTool = Tool.define("data_preprocess", Tool.Execution.managedFilesystem, ToolModel.forTool("data_preprocess"), {
  description:
    "对已完成导入、画像和 数据质量检查 的明确 datasetId/stageId 执行一个已准入预处理方法。适用：用户明确要求缺失处理、异常检测、缩尾/截尾、标准化、变换、插值、虚拟变量、组合列、条件列创建、DID2S 相对时期构造、数值文本转换或样本筛选。本工具没有 action 参数，动作只写在 method；不要同时传 action 和 method。只查看分组/四格分布或回答质量体检时使用 data_import 的 profile、validate、frequency，不要自动调用本工具补充细节。只有用户明确要求额外 zscore_detect/iqr_detect 诊断时才调用它们。变更型方法会创建带血缘的新 stage；zscore_detect/iqr_detect 只生成诊断，不改数据；若筛选结果为 0 行，系统不会创建空 stage。filter 的条件必须放在 options.rules（每项含 column/operator/value 或 values，in/not_in 使用 values），不得展平到 options 顶层；create_column 用 columns 指定左侧列，options 传 operator 和 right_value/right_column 生成 0/1 指示列。若生成 post 等政策指示列，必须先获得用户确认或使用用户已明确给出的固定规则，不得猜测阈值或处理时点；create_relative_time 只接受用户确认的 entity/time/cohort/treatment 列，按 time−cohort 生成 treated 相对时期并为 never-treated 写入 -inf，且会验证 treatment 与 cohort/time 一致，不能传任意表达式。coerce_numeric 只转换指定列；只有用户或数据源明确确认含义的 missing_tokens 才能转为缺失，其他无法解析的非空值一律拒绝，不删除原始阶段、行或未指定列。其他方法用 columns 指定列、options 只传该方法 Schema 允许的参数。一次调用只做一个明确变换，完成后重新画像和 数据质量检查；不得自行选择清洗规则、覆盖原 stage，或把检测结果说成已经清洗。失败时只修复当前方法与参数，不改用另一个方法掩盖错误。",
  parameters: PreprocessInputSchema,
  async execute(params: PreprocessParams, ctx) {
    const ready = assertDatasetStageReadyForPreprocess({
      sessionID: ctx.sessionID,
      datasetId: params.datasetId,
      stageId: params.stageId,
    })
    const sourceStage = sourceStageForPolicyRebuild(ready, params)
    const runtime = await ensureRuntimePythonReady()
    if (!runtime.ok || runtime.missing.length) throw new Error(formatRuntimePythonSetupError("data_preprocess", runtime))

    const sourcePath = await resolveDatasetStagePath({
      datasetId: params.datasetId,
      filePath: sourceStage.workingPath,
      toolName: "data_preprocess",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      ask: ctx.ask,
    })
    if (!fs.existsSync(sourcePath)) throw new Error("找不到当前数据阶段的文件")
    const lineage = provenance(sourcePath, params)

    const rawMethod = params.method
    if (typeof rawMethod !== "string" || !Object.prototype.hasOwnProperty.call(METHOD_LABELS, rawMethod)) {
      throw new Tool.InputValidationError("method 必须是 Python Registry 当前准入的预处理方法。")
    }
    const method = rawMethod as PreprocessMethod
    const mutation = MUTATING_METHODS.has(method)
    const stamp = buildFileStamp()
    const childStageId = mutation ? nextStageId(ready.manifest) : undefined
    const action = `preprocess_${method}`
    const outputPath = mutation
      ? resolveManagedProjectPath({
          filePath: stageOutputPath({ datasetId: params.datasetId, stageId: childStageId!, action, stamp }),
          managedRoot: datasetRoot(params.datasetId),
        })
      : await resolveToolPath({
          filePath: path.join(path.dirname(sourcePath), `.killstata_${action}_${stamp}.parquet`),
          mode: "write",
          toolName: "data_preprocess",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
    const managedReportRoot = datasetRoot(params.datasetId)
    const stageMeta = childStageId
      ? stageMetaPaths({ datasetId: params.datasetId, stageId: childStageId, action, stamp })
      : undefined
    let safeStageMeta = stageMeta
      ? {
          ...stageMeta,
          summaryPath: resolveManagedProjectPath({ filePath: stageMeta.summaryPath, managedRoot: managedReportRoot }),
          logPath: resolveManagedProjectPath({ filePath: stageMeta.logPath, managedRoot: managedReportRoot }),
        }
      : undefined
    let diagnosticReportPath = mutation
      ? undefined
      : resolveManagedProjectPath({
          filePath: reportOutputPath({
            datasetId: params.datasetId,
            action,
            stageId: sourceStage.stageId,
            branch: sourceStage.branch,
            format: "json",
            stamp,
          }),
          managedRoot: managedReportRoot,
        })

    await ctx.ask({
      permission: "bash",
      patterns: [`${runtime.executable} *preprocess*`],
      always: [`${runtime.executable} *preprocess*`],
      metadata: { description: `数据预处理：${METHOD_LABELS[method]}`, managedRuntime: true },
    })

    const sourcePathAfterConfirmation = await resolveDatasetStagePath({
      datasetId: params.datasetId,
      filePath: sourceStage.workingPath,
      toolName: "data_preprocess",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      ask: ctx.ask,
    })
    if (sourcePathAfterConfirmation !== sourcePath) {
      throw new Tool.InputValidationError("等待确认期间当前数据阶段路径发生变化；为避免读取不同文件，操作已取消。")
    }
    if (mutation) {
      resolveManagedProjectPath({ filePath: outputPath, managedRoot: managedReportRoot })
    } else {
      const outputPathAfterConfirmation = await resolveToolPath({
        filePath: outputPath,
        mode: "write",
        toolName: "data_preprocess",
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        ask: ctx.ask,
      })
      if (outputPathAfterConfirmation !== outputPath) {
        throw new Tool.InputValidationError("等待确认期间诊断临时输出路径发生变化；为避免写入不同位置，操作已取消。")
      }
    }
    if (safeStageMeta) {
      safeStageMeta = {
        ...safeStageMeta,
        summaryPath: resolveManagedProjectPath({ filePath: safeStageMeta.summaryPath, managedRoot: managedReportRoot }),
        logPath: resolveManagedProjectPath({ filePath: safeStageMeta.logPath, managedRoot: managedReportRoot }),
      }
    }
    if (diagnosticReportPath) {
      diagnosticReportPath = resolveManagedProjectPath({ filePath: diagnosticReportPath, managedRoot: managedReportRoot })
    }

    const result = await runDataPreprocessBackend({
      pythonCommand: runtime.executable,
      cwd: path.dirname(sourcePath),
      sessionID: ctx.sessionID,
      payload: {
        datasetId: params.datasetId,
        stageId: sourceStage.stageId,
        method,
        dataPath: sourcePath,
        outputPath,
        columns: params.columns,
        options: params.options,
        modelArguments: Object.fromEntries(
          Object.entries(params).filter(([field]) => !["datasetId", "stageId", "outputPath"].includes(field)),
        ),
      } satisfies DataPreprocessPayload,
      abort: ctx.abort,
    })
    if (result.mutation) {
      if (!result.outputPath) throw new Tool.InputValidationError("Python 预处理结果缺少受管输出路径。")
      const expectedOutputPath = resolveManagedProjectPath({ filePath: outputPath, managedRoot: datasetRoot(params.datasetId) })
      const returnedOutputPath = resolveManagedProjectPath({ filePath: result.outputPath, managedRoot: datasetRoot(params.datasetId) })
      if (returnedOutputPath !== expectedOutputPath) {
        throw new Tool.InputValidationError("Python 预处理结果路径与 Harness 预定 stage 输出不一致。")
      }
      result.outputPath = returnedOutputPath
    }
    if (result.mutation && result.rowsAfter === 0) {
      // 空筛选不是可用的数据阶段。若继续把它登记为 canonical stage，后续画像和估计
      // 只能围绕 0 行数据反复试错；保留父阶段，让模型回到用户可操作的筛选条件决策。
      if (result.outputPath) fs.rmSync(result.outputPath, { force: true })
      throw new Error("筛选结果为空：没有创建新的数据阶段。请放宽筛选条件或确认是否应保留当前数据。")
    }
    const runId = inferRunId({ stage: sourceStage })
    let resultPath: string
    let effectiveStageId = ready.stage.stageId
    // mutation 分支的可读产物（json summary + md log）需要上报进工具 metadata——
    // 否则 stage.artifactRefs 只含 parquet，verifier 的可读扩展名白名单
    //（.csv/.json/.log/.md/...，**不含 .parquet**）把产物全滤掉 → artifacts_present
    // 空 → ARTIFACT_MISSING（2026-08-12 status-check 实测：data_preprocess 构造列后
    // verifier 报"产物在磁盘 EXISTS AT 但解析未命中"，模型被矛盾信息误导推锅给用户）。
    let mutationReadablePaths: { summaryPath: string; logPath: string } | undefined

    if (result.mutation) {
      if (!childStageId || !result.outputPath) throw new Error("预处理变更没有生成子阶段输出")
      if (!safeStageMeta) throw new Error("预处理阶段缺少已校验的摘要与日志路径")
      const meta = {
        ...safeStageMeta,
        summaryPath: resolveManagedProjectPath({ filePath: safeStageMeta.summaryPath, managedRoot: managedReportRoot }),
        logPath: resolveManagedProjectPath({ filePath: safeStageMeta.logPath, managedRoot: managedReportRoot }),
      }
      mutationReadablePaths = { summaryPath: meta.summaryPath, logPath: meta.logPath }
      writeJson(meta.summaryPath, {
        method,
        parentStageId: sourceStage.stageId,
        rowsBefore: result.rowsBefore,
        rowsAfter: result.rowsAfter,
        columnsBefore: result.columnsBefore,
        columnsAfter: result.columnsAfter,
        createdColumns: result.createdColumns,
        droppedColumns: result.droppedColumns,
        warnings: result.warnings,
      })
      fs.mkdirSync(path.dirname(meta.logPath), { recursive: true })
      fs.writeFileSync(meta.logPath, `${METHOD_LABELS[method]}\n父阶段：${sourceStage.stageId}\n`, "utf-8")
      appendStage(ready.manifest, {
        stageId: childStageId,
        runId,
        parentStageId: sourceStage.stageId,
        branch: sourceStage.branch,
        action,
        label: METHOD_LABELS[method],
        workingPath: result.outputPath,
        workingFormat: "parquet",
        rowCount: result.rowsAfter,
        columnCount: result.columnsAfter,
        summaryPath: meta.summaryPath,
        logPath: meta.logPath,
        createdAt: new Date().toISOString(),
        metadata: {
          method,
          columns: params.columns,
          options: params.options,
          sourceStageId: sourceStage.stageId,
          // 新 stage 的就绪事实由后端基于新数据重算后写入本 stage。缺了它，
          // 当前数据阶段的诊断报告尚未包含此派生列；下游方法预检必须基于新阶段重新读取数据。
          // 的唯一性证据，面板方法会永远停在 needs_user_decision，模型重跑
          // profile/validate 也推不动（2026-08-28 did.xlsx 真实会话的硬死锁）。
          // 这里的 sourceStageId 必须指向**新** stage，与 data-import 的标注方式一致。
          ...(result.readiness
            ? { dataReadiness: { ...result.readiness, sourceStageId: childStageId } }
            : {}),
          ...lineage,
        },
      })
      effectiveStageId = childStageId
      resultPath = result.outputPath
    } else {
      if (!diagnosticReportPath) throw new Error("预处理诊断缺少已校验的报告路径")
      resultPath = resolveManagedProjectPath({ filePath: diagnosticReportPath, managedRoot: managedReportRoot })
      writeJson(resultPath, {
        method,
        stageId: ready.stage.stageId,
        columns: params.columns,
        detected: result.detected ?? {},
        warnings: result.warnings,
      })
    }

    appendArtifact(ready.manifest, {
      artifactId: `${action}_${stamp}`,
      runId,
      stageId: effectiveStageId,
        branch: sourceStage.branch,
      action,
      outputPath: resultPath,
      summaryPath: result.mutation ? ready.manifest.stages.at(-1)?.summaryPath : resultPath,
      createdAt: new Date().toISOString(),
      metadata: { method, columns: params.columns, options: params.options, mutation: result.mutation, ...lineage },
    })
    refreshExperimentLog(params.datasetId)

    const visibleDiagnosticPath = result.mutation
      ? undefined
      : publishVisibleOutput({
          manifest: ready.manifest,
          key: `${action}_${effectiveStageId}`,
          label: `${METHOD_LABELS[method]}结果`,
          sourcePath: resultPath,
          runId,
          branch: sourceStage.branch,
          stageId: effectiveStageId,
        })
    return {
      title: METHOD_LABELS[method],
      output: formatDataPreprocessOutput({
        datasetId: params.datasetId,
        effectiveStageId,
          parentStageId: sourceStage.stageId,
        method,
        columns: params.columns,
        mutation: result.mutation,
        visibleDiagnosticPath,
        result,
      }),
      metadata: {
        datasetId: params.datasetId,
        stageId: effectiveStageId,
        parentStageId: sourceStage.stageId,
        runId,
        method,
        mutation: result.mutation,
        result,
        // verifier 可读产物（json summary / md log）随 mutation 上报，见上方说明
        ...(mutationReadablePaths ?? {}),
        analysisView: createToolAnalysisView({
          kind: "data_preprocess",
          step: action,
          datasetId: params.datasetId,
          stageId: effectiveStageId,
          results: [
            analysisMetric("方法", METHOD_LABELS[method]),
            analysisMetric("处理前行数", result.rowsBefore),
            analysisMetric("处理后行数", result.rowsAfter),
            ...(method === "coerce_numeric" ? [
              analysisMetric("数值化列", result.convertedNumeric?.join("、")),
              analysisMetric("显式缺失标记", result.missingTokensApplied?.join("、")),
              analysisMetric("显式标记转缺失计数", Object.entries(result.missingTokensConverted ?? {}).map(([column, count]) => `${column}=${count}`).join("、")),
            ] : []),
          ],
          artifacts: visibleDiagnosticPath
            ? [analysisArtifact(relativeWithinProject(visibleDiagnosticPath), { visibility: "user_default" })]
            : [],
          conclusion: result.mutation ? "已创建新的数据阶段。" : "仅完成诊断，原数据未修改。",
        }),
      },
    }
  },
})
