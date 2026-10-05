import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { readDatasetManifest, getStage } from "../runtime/dataset-state"
import { buildExperimentEntries } from "../tool/analysis-experiment-log"
import { isDataFile } from "../tool/data-file"
import { readWorkflowSession } from "../runtime/workflow"
import { getActiveWorkflowRun, activeOrLatestStage } from "@/runtime/workflow/state"
import { reduceContextCapsule, renderContextCapsule, type ContextCapsuleInput } from "@/runtime/context-capsule"
import { formatStoredDataReadinessForModel, readStoredDataReadinessState } from "@/runtime/data-readiness"

// 模型每一轮都在对着一个只知道 cwd 和日期的环境块工作——它不知道当前数据集是哪个、
// 活跃阶段是哪个、已经试过几组设定。这些事实全部已经落盘在 manifest / dataset index 里，
// 只是从没被喂给模型。于是模型只能靠翻对话历史去"回忆"自己在哪，压缩之后连这个都没了。
//
// 这个模块把已落盘的事实拼成一个 <data-context> 块。它不新增任何真相来源——纯粹是把
// analysis-state 里已有的东西读出来，因此任何时候重建都和事实一致。
export namespace DataContext {
  const log = Log.create({ service: "session.data-context" })

  /** 扫工作目录顶层，列出用户放进来的原始数据文件（.killstata 内部产物不算） */
  function dataFilesInWorkdir(): string[] {
    try {
      return fs
        .readdirSync(Instance.directory)
        .filter((name) => isDataFile(name))
        .sort()
        .slice(0, 8)
    } catch {
      return []
    }
  }

  /**
   * 本会话是否已经有可分析的数据集。用于意图分类的上下文感知兜底。
   *
   * 会话隔离：只认**本会话真正操作过**的数据集（workflow run 里带 datasetId）。
   * dataset index 是项目级共享的，别的会话导入的数据对本会话不算"在场"——
   * 否则新窗口第一轮就被 `hasActiveDataset && 非闲聊 → ingest` 兜底推向旧数据，
   * 与"干净、隔离的新窗口"诉求冲突（2026-08-08 用户明确要求）。
   */
  export function hasActiveDataset(sessionID: string): boolean {
    try {
      return readWorkflowSession(sessionID).runs.some((run) => typeof run.datasetId === "string")
    } catch {
      return false
    }
  }

  /** 当前会话实际关联过的数据集，供工具层做唯一对象的无损 ID 纠错。 */
  export function datasetIDs(sessionID: string): string[] {
    try {
      return [...new Set(readWorkflowSession(sessionID).runs
        .map((run) => run.datasetId)
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0))]
    } catch {
      return []
    }
  }

  /** 当前数据集优先跟随 activeRunId；缺失时才回退到最后一个带 datasetId 的 run。 */
  function currentDatasetId(sessionID: string): string | undefined {
    try {
      const state = readWorkflowSession(sessionID)
      const active = state.activeRunId
        ? state.runs.find((run) => run.workflowRunId === state.activeRunId)
        : undefined
      if (typeof active?.datasetId === "string") return active.datasetId
      return [...state.runs].reverse().find((run) => typeof run.datasetId === "string")?.datasetId
    } catch {
      return undefined
    }
  }

  /** 当前数据集上传后生成的结构事实，供每轮模型请求重建；没有快照时不猜测。 */
  export function readiness(sessionID: string): string | undefined {
    const datasetId = currentDatasetId(sessionID)
    if (!datasetId) return undefined
    try {
      const workflow = getActiveWorkflowRun(sessionID)
      const stage = activeOrLatestStage(workflow)
      return formatStoredDataReadinessForModel(readStoredDataReadinessState(datasetId, stage?.stageId)) || undefined
    } catch {
      return undefined
    }
  }

  /**
   * 构建 <data-context> 块。没有任何已导入数据集时返回 undefined——
   * 此时不该往系统提示里塞一个空壳，徒增噪音。
   *
   * 会话隔离：本会话没碰过任何数据集时，**绝不把别的会话的数据集喂给模型**——
   * 只提示工作目录里可导入的原始文件（中立信息，不指向任何历史会话状态）。
   * 只有本会话真正操作过数据集，才构建完整的"当前数据集/活跃阶段/阶段链"块。
   */
  export function build(sessionID: string): string | undefined {
    const dataFiles = dataFilesInWorkdir()
    const datasetId = currentDatasetId(sessionID)

    if (!datasetId) {
      if (dataFiles.length === 0) return undefined
      return ["<data-context>", `  可导入的数据文件: ${dataFiles.join(", ")}`, "</data-context>"].join("\n")
    }

    try {
      const manifest = readDatasetManifest(datasetId)
      const workflow = getActiveWorkflowRun(sessionID)
      const activeStage = activeOrLatestStage(workflow)
      const stageId = activeStage?.stageId
      const stage = stageId
        ? manifest.stages.find(
            (item) =>
              item.stageId === stageId &&
              item.branch === activeStage?.branch &&
              (!activeStage?.runId || !item.runId || item.runId === activeStage.runId),
          )
        : undefined
      const experiments = buildExperimentEntries(manifest)
      const evidence: ContextCapsuleInput["evidence"] = [
        stage?.schemaPath ? { kind: "schema" as const, ref: stage.schemaPath, datasetId, stageId: stage.stageId, scope: "full_stage" as const, rows: stage.rowCount } : undefined,
        stage?.summaryPath ? { kind: "profile" as const, ref: stage.summaryPath, datasetId, stageId: stage.stageId, scope: "full_stage" as const, rows: stage.rowCount } : undefined,
        ...manifest.artifacts.filter((artifact) => artifact.stageId === stage?.stageId).slice(-8).map((artifact) => ({
          kind: artifact.action === "validate" ? ("validate" as const) : ("estimate" as const),
          ref: artifact.outputPath,
          datasetId,
          stageId: artifact.stageId,
          runId: artifact.runId,
          branch: artifact.branch,
          qualityStatus: artifact.action === "validate" ? ("pass" as const) : undefined,
          scope: "full_stage" as const,
        })),
      ].filter((item): item is NonNullable<typeof item> => Boolean(item))
      const input: ContextCapsuleInput = {
        dataset: {
          datasetId,
          sourceFormat: manifest.sourceFormat,
          sourcePath: manifest.sourcePath,
          updatedAt: manifest.updatedAt,
          panelIdentifiers: manifest.panelIdentifiers,
          origin: manifest.origin?.sessionID === sessionID ? manifest.origin : undefined,
        },
        workflow: workflow
          ? {
              workflowRunId: workflow.workflowRunId,
              datasetId: workflow.datasetId,
              runId: workflow.runId,
              branch: workflow.branch,
              activeStageKind: workflow.activeStage,
              activeNode: activeStage
                ? {
                    nodeId: activeStage.nodeId,
                    stageId: activeStage.stageId,
                    branch: activeStage.branch,
                    kind: activeStage.kind,
                    status: activeStage.status,
                    runId: activeStage.runId,
                  }
                : undefined,
              repairOnly: workflow.repairOnly,
              latestFailureCode: workflow.latestFailure?.code,
              latestVerifierStatus: workflow.latestVerifier?.status,
              trustedArtifacts: workflow.trustedArtifacts,
              checklist: workflow.analysisChecklist.map((item) => `${item.label}: ${item.status}`),
            }
          : undefined,
        datasetStage: stage,
        attempts: experiments,
        evidence,
        sideEffectReceipts: workflow?.stages.filter((item) => item.executionMode === "reuse").map((item) => `${item.kind}:${item.stageId}:reused`) ?? [],
        capturedAt: new Date().toISOString(),
      }
      return renderContextCapsule(reduceContextCapsule(input))
    } catch (error) {
      log.warn("failed to build data-context", { error: String(error) })
      return undefined
    }
  }
}
