import fs from "fs"
import path from "path"
import crypto from "crypto"
import { ensureRuntimePythonReady, formatRuntimePythonSetupError } from "@/killstata/runtime-config"
import type { RuntimePythonStatus } from "@/killstata/runtime-config"
import { assertDatasetStageReadyForPreprocess } from "@/runtime/workflow"
import { appendArtifact, appendStage, buildFileStamp, datasetRoot, inferRunId, nextStageId, publishVisibleOutput, stageMetaPaths, stageOutputPath } from "./analysis-state"
import { relativeWithinProject, resolveDatasetStagePath, resolveManagedProjectPath } from "./analysis-path"
import { analysisArtifact, analysisMetric, createToolAnalysisView } from "./analysis-user-view"
import { refreshExperimentLog } from "./analysis-experiment-log"
import { runCompositeEvaluationBackend, type CompositeEvaluationBackendResult, type CompositeEvaluationPayload, type McdaMethod } from "./composite-evaluation-backend"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import { pythonCapabilityInput } from "./python-capability-schema"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import type { AnalysisToolRunRecord } from "@/runtime/types"

type Params = Record<string, any>
const InputSchema = pythonCapabilityInput<Params>()

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8")
}

function provenance(sourcePath: string, params: Params) {
  return {
    sourceFileHash: crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"),
    parameterFingerprint: crypto.createHash("sha256").update(JSON.stringify(params)).digest("hex"),
  }
}

function dataDiagnosisFingerprint(stage: unknown, stageId: string) {
  if (!stage || typeof stage !== "object" || Array.isArray(stage)) return undefined
  const value = stage as { stageId?: unknown; metadata?: unknown }
  if (value.stageId !== stageId || !value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)) return undefined
  const diagnosis = (value.metadata as Record<string, unknown>).dataDiagnosis
  if (!diagnosis || typeof diagnosis !== "object" || Array.isArray(diagnosis)) return undefined
  const report = diagnosis as Record<string, unknown>
  return report.stage_id === stageId && typeof report.data_fingerprint === "string" && /^sha256:[0-9a-f]{64}$/.test(report.data_fingerprint)
    ? report.data_fingerprint
    : undefined
}

function fingerprintValue(value: unknown) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function formatRows(rows: Array<Record<string, string | number>>) {
  return rows.map((row, index) => {
    const values = Object.entries(row).map(([key, value]) => `${key}=${value}`).join("；")
    return `${index + 1}. ${values}`
  })
}

function formatTopPreview(result: CompositeEvaluationBackendResult) {
  if (result.scope === "by_group" && result.topByGroup) {
    return [
      "各组内排名预览（得分仅在同组内可比较）：",
      ...Object.entries(result.topByGroup).flatMap(([group, rows]) => [
        `${group} 前五名：`,
        ...formatRows(rows),
      ]),
    ]
  }
  return result.top.length ? ["前五名：", ...formatRows(result.top)] : []
}

export const CompositeEvaluationTool = Tool.define<typeof InputSchema, Record<string, any>>("composite_evaluation", Tool.Execution.managedFilesystem, ToolModel.forTool("composite_evaluation"), {
  description:
    "在已核验的 datasetId/stageId 上按明确指标构建可复现综合得分和排名。entropy_weight 只生成熵权综合指数；用户要求熵权 TOPSIS 时必须 method=topsis 且 weightSource=entropy。调用前必须由用户或研究设计明确 idColumns、每个指标的 benefit/cost 方向、global/by_group 范围和权重来源；by_group 还需 groupColumns，manual 权重必须与指标一一对应且和为 1。当前实现拒绝指标缺失、ID/指标/分组列重叠和未说明方向，不得替用户猜测。成功后创建含得分与排名的新 stage，并返回权重、头尾排名与结构化产物；失败时修复数据或参数，不静默删样本。",
  parameters: InputSchema,
  async execute(params: Params, ctx) {
    const extra = ctx.extra as Record<string, unknown> | undefined
    const modelInvocation = Boolean(extra?.model)
    const sourceUserMessageId = typeof extra?.sourceUserMessageId === "string" ? extra.sourceUserMessageId : undefined
    const ledger = RuntimeTaskLedger.listTasks(ctx.sessionID)
    const analysisTask = sourceUserMessageId
      ? ledger.tasks.find((item) =>
          item.taskId === ledger.activeTaskId &&
          item.messageID === sourceUserMessageId &&
          item.analysisRequest?.sourceMessageId === sourceUserMessageId,
        )
      : undefined
    const authorizedToolIDs = [
      ...(Array.isArray(analysisTask?.metadata?.requiredToolIDs)
        ? analysisTask.metadata.requiredToolIDs.filter((id): id is string => typeof id === "string")
        : []),
      ...(Array.isArray(analysisTask?.metadata?.confirmedToolIDs)
        ? analysisTask.metadata.confirmedToolIDs.filter((id): id is string => typeof id === "string")
        : []),
    ]
    if (modelInvocation && (
      analysisTask?.analysisRequest?.kind !== "estimate" ||
      !authorizedToolIDs.includes("composite_evaluation") ||
      extra?.qualityInspectionOnly === true ||
      extra?.recommendationOnly === true
    )) {
      const reason = extra?.qualityInspectionOnly === true
        ? "本轮只请求数据质量检查"
        : extra?.recommendationOnly === true
          ? "本轮只请求方法推荐"
          : analysisTask?.analysisRequest?.kind === "estimate"
            ? "当前用户请求没有明确选择或确认综合评价"
            : "当前用户请求不是已登记的估计任务"
      return {
        title: "当前请求不允许运行综合评价",
        output: `综合评价尚未运行：${reason}。如需构建得分或排名，请由用户明确确认分析目标和指标方向。`,
        metadata: { requiresUserDecision: true, estimateExecuted: false, requestKind: analysisTask?.analysisRequest?.kind },
      }
    }
    const ready = assertDatasetStageReadyForPreprocess({ sessionID: ctx.sessionID, datasetId: params.datasetId, stageId: params.stageId })
    const stageFingerprint = dataDiagnosisFingerprint(ready.stage, params.stageId)
    if (!stageFingerprint) {
      throw new Tool.InputValidationError("当前数据阶段缺少有效的数据诊断指纹；尚未运行综合评价。请先重新检查当前数据阶段，再继续分析。")
    }
    if (modelInvocation && (
      analysisTask?.analysisRequest?.kind !== "estimate" ||
      analysisTask.analysisLifecycle?.requestId !== analysisTask.analysisRequest.requestId ||
      analysisTask.analysisLifecycle.datasetId !== params.datasetId ||
      analysisTask.analysisLifecycle.stageId !== params.stageId ||
      analysisTask.analysisLifecycle.stageFingerprint !== stageFingerprint
    )) {
      throw new Tool.InputValidationError("当前请求的诊断数据集、阶段或内容指纹与综合评价输入不一致；尚未运行 Python。请先刷新当前阶段诊断或重新提交本次分析请求。")
    }
    const pythonOverride = ctx.extra?.pythonCommand as string | undefined
    const runtime: RuntimePythonStatus = pythonOverride
      ? { executable: pythonOverride, source: "env", ok: true, missing: [], installCommand: "" }
      : await ensureRuntimePythonReady()
    if (!runtime.ok || runtime.missing.length) throw new Error(formatRuntimePythonSetupError("composite_evaluation", runtime))
    const dataPath = await resolveDatasetStagePath({
      datasetId: params.datasetId,
      filePath: ready.stage.workingPath,
      toolName: "composite_evaluation",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      ask: ctx.ask,
    })
    if (!fs.existsSync(dataPath)) throw new Error("找不到当前数据阶段的文件")
    const lineage = provenance(dataPath, params)

    const stageId = nextStageId(ready.manifest)
    const stamp = buildFileStamp()
    const action = `mcda_${params.method}`
    const metaPaths = stageMetaPaths({ datasetId: params.datasetId, stageId, action, stamp })
    let safeMetaPaths = {
      ...metaPaths,
      summaryPath: resolveManagedProjectPath({ filePath: metaPaths.summaryPath, managedRoot: datasetRoot(params.datasetId) }),
      logPath: resolveManagedProjectPath({ filePath: metaPaths.logPath, managedRoot: datasetRoot(params.datasetId) }),
    }
    const outputPath = resolveManagedProjectPath({
      filePath: stageOutputPath({ datasetId: params.datasetId, stageId, action, stamp }),
      managedRoot: datasetRoot(params.datasetId),
    })
    const outputDir = resolveManagedProjectPath({
      filePath: `${outputPath}.mcda`,
      managedRoot: datasetRoot(params.datasetId),
    })
    await ctx.ask({ permission: "bash", patterns: [`${runtime.executable} *mcda*`], always: [`${runtime.executable} *mcda*`], metadata: { description: "综合评价", managedRuntime: true } })
    const sourcePathAfterConfirmation = await resolveDatasetStagePath({
      datasetId: params.datasetId,
      filePath: ready.stage.workingPath,
      toolName: "composite_evaluation",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      ask: ctx.ask,
    })
    if (sourcePathAfterConfirmation !== dataPath) {
      throw new Tool.InputValidationError("等待确认期间当前数据阶段路径发生变化；为避免读取不同文件，操作已取消。")
    }
    const readyAfterConfirmation = assertDatasetStageReadyForPreprocess({ sessionID: ctx.sessionID, datasetId: params.datasetId, stageId: params.stageId })
    if (readyAfterConfirmation.stage.stageId !== ready.stage.stageId ||
        dataDiagnosisFingerprint(readyAfterConfirmation.stage, params.stageId) !== stageFingerprint ||
        provenance(sourcePathAfterConfirmation, params).sourceFileHash !== lineage.sourceFileHash) {
      throw new Tool.InputValidationError("等待用户确认期间当前数据阶段或内容指纹发生变化；综合评价已取消，请重新诊断并确认当前阶段。")
    }
    const operationId = typeof ctx.callID === "string" && ctx.callID.trim()
      ? ctx.callID
      : `composite_${ctx.messageID}_${stageFingerprint.slice(-12)}`
    const inputFingerprint = fingerprintValue({ params, lineage, stageFingerprint })
    const analysisOperationIdentity = modelInvocation && analysisTask?.analysisRequest?.kind === "estimate"
      ? {
          requestId: analysisTask.analysisRequest.requestId,
          operationId,
          toolID: "composite_evaluation",
          datasetId: params.datasetId,
          stageId: params.stageId,
          stageFingerprint,
          inputFingerprint,
          authorizationMessageId: analysisTask.analysisRequest.sourceMessageId,
        }
      : undefined
    resolveManagedProjectPath({ filePath: outputPath, managedRoot: datasetRoot(params.datasetId) })
    resolveManagedProjectPath({ filePath: outputDir, managedRoot: datasetRoot(params.datasetId) })
    safeMetaPaths = {
      ...safeMetaPaths,
      summaryPath: resolveManagedProjectPath({ filePath: safeMetaPaths.summaryPath, managedRoot: datasetRoot(params.datasetId) }),
      logPath: resolveManagedProjectPath({ filePath: safeMetaPaths.logPath, managedRoot: datasetRoot(params.datasetId) }),
    }
    const result = await runCompositeEvaluationBackend({
      pythonCommand: runtime.executable,
      cwd: path.dirname(dataPath),
      payload: {
        datasetId: ready.manifest.datasetId,
        stageId: ready.stage.stageId,
        expectedDataFingerprint: stageFingerprint,
        method: params.method,
        dataPath,
        outputDir,
        idColumns: params.idColumns,
        indicators: params.indicators,
        scope: params.scope,
        groupColumns: params.groupColumns,
        weightSource: params.weightSource,
        manualWeights: params.manualWeights,
      } satisfies CompositeEvaluationPayload,
      sessionID: ctx.sessionID,
      abort: ctx.abort,
      beforeExecute: () => {
        if (!analysisOperationIdentity) return
        const begin = extra?.beginAnalysisToolRun
        if (typeof begin !== "function") {
          throw new Tool.InputValidationError("Harness 没有登记综合评价运行状态；为避免未跟踪的计算，已停止执行。")
        }
        ;(begin as (operation: typeof analysisOperationIdentity) => void)(analysisOperationIdentity)
      },
    })
    const readyAfterExecution = assertDatasetStageReadyForPreprocess({ sessionID: ctx.sessionID, datasetId: params.datasetId, stageId: params.stageId })
    if (readyAfterExecution.stage.stageId !== ready.stage.stageId ||
        dataDiagnosisFingerprint(readyAfterExecution.stage, params.stageId) !== stageFingerprint ||
        provenance(dataPath, params).sourceFileHash !== lineage.sourceFileHash) {
      throw new Tool.InputValidationError("综合评价执行期间当前数据阶段或内容指纹发生变化；拒绝发布过期结果。")
    }
    for (const [filePath, label] of [
      [result.scoresPath, "综合得分文件"],
      [result.weightsPath, "综合权重文件"],
      [result.resultPath, "综合评价结果文件"],
    ] as const) {
      const returnedPath = resolveManagedProjectPath({ filePath, managedRoot: datasetRoot(params.datasetId) })
      const expectedPath = resolveManagedProjectPath({ filePath: path.join(outputDir, path.basename(filePath)), managedRoot: datasetRoot(params.datasetId) })
      if (returnedPath !== expectedPath) throw new Tool.InputValidationError(`Python 返回的${label}不在 Harness 预定输出目录。`)
    }
    // runner 固定将表写为 scores.parquet；为保证 manifest 路径可预测，原子地发布到 stage 路径。
    const safeStageOutputPath = resolveManagedProjectPath({ filePath: outputPath, managedRoot: datasetRoot(params.datasetId) })
    fs.renameSync(result.scoresPath, safeStageOutputPath)
    const meta = {
      ...safeMetaPaths,
      summaryPath: resolveManagedProjectPath({ filePath: safeMetaPaths.summaryPath, managedRoot: datasetRoot(params.datasetId) }),
      logPath: resolveManagedProjectPath({ filePath: safeMetaPaths.logPath, managedRoot: datasetRoot(params.datasetId) }),
    }
    writeJson(meta.summaryPath, {
      method: params.method,
      scope: params.scope,
      weights: result.weights,
      groupWeights: result.groupWeights,
      top: result.top,
      bottom: result.bottom,
      topByGroup: result.topByGroup,
    })
    fs.mkdirSync(path.dirname(meta.logPath), { recursive: true })
    fs.writeFileSync(meta.logPath, `综合评价：${params.method}\n父阶段：${ready.stage.stageId}\n`, "utf-8")
    const runId = inferRunId({ stage: ready.stage })
    appendStage(ready.manifest, {
      stageId,
      runId,
      parentStageId: ready.stage.stageId,
      branch: ready.stage.branch,
      action,
      label: "综合评价",
      workingPath: safeStageOutputPath,
      workingFormat: "parquet",
      rowCount: result.rowsUsed,
      columnCount: ready.stage.columnCount ? ready.stage.columnCount + 2 : undefined,
      summaryPath: meta.summaryPath,
      logPath: meta.logPath,
      createdAt: new Date().toISOString(),
      metadata: { method: params.method, indicators: params.indicators, scope: params.scope, weightSource: result.weightSource, ...lineage },
    })
    appendArtifact(ready.manifest, {
      artifactId: `${action}_${stamp}_weights`,
      runId,
      stageId,
      branch: ready.stage.branch,
      action,
      outputPath: result.weightsPath,
      summaryPath: result.resultPath,
      createdAt: new Date().toISOString(),
      metadata: {
        weights: result.weights,
        groupWeights: result.groupWeights,
        top: result.top,
        bottom: result.bottom,
        topByGroup: result.topByGroup,
        ...lineage,
      },
    })
    refreshExperimentLog(params.datasetId)
    const visible = publishVisibleOutput({ manifest: ready.manifest, key: `${action}_${stageId}`, label: "综合评价结果", sourcePath: safeStageOutputPath, runId, branch: ready.stage.branch, stageId })
    if (analysisOperationIdentity) {
      const complete = extra?.completeAnalysisToolRun
      if (typeof complete !== "function") {
        throw new Tool.InputValidationError("Harness 没有完成综合评价运行状态登记；结果将保持未确认。")
      }
      ;(complete as (operation: AnalysisToolRunRecord) => void)({
        ...analysisOperationIdentity,
        status: "completed",
        resultId: `composite:${runId}:${stageId}:${operationId}`,
        artifactRefs: [...new Set([
          relativeWithinProject(safeStageOutputPath),
          relativeWithinProject(result.weightsPath),
          relativeWithinProject(result.resultPath),
          relativeWithinProject(visible),
        ])],
        resultContractStatus: "pass",
        subResults: [],
        updatedAt: new Date().toISOString(),
      })
    }
    const topPreview = formatTopPreview(result)
    return {
      title: "综合评价完成",
      output: [
        "## 综合评价完成",
        `方法：${params.method}`,
        "已创建含综合得分与排名的新数据阶段。",
        `得分列：${result.scoreColumn}`,
        topPreview.length ? topPreview.join("\n") : "",
        "结果文件已生成，已保存为本次分析产物。",
        "本轮结果已交付；如需筛选、导出或继续分析，请由用户明确提出下一步。",
      ].filter(Boolean).join("\n"),
      metadata: {
        datasetId: params.datasetId,
        stageId,
        parentStageId: ready.stage.stageId,
        runId,
        requiresUserDecision: true,
        result: { ...result, outputPath },
        analysisView: createToolAnalysisView({
          kind: "composite_evaluation",
          step: action,
          datasetId: params.datasetId,
          stageId,
          results: [analysisMetric("样本量", result.rowsUsed), analysisMetric("指标数", params.indicators.length)],
          artifacts: [analysisArtifact(relativeWithinProject(visible), { visibility: "user_default" })],
          conclusion: "已创建含综合得分与排名的新数据阶段。",
        }),
      },
    }
  },
})
