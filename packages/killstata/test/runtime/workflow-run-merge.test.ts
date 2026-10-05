import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import {
  assertDatasetStageReadyForEstimation,
  readWorkflowSession,
  recordWorkflowStageSuccess,
} from "@/runtime/workflow"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"

/**
 * workflow run 分裂回归（2026-08-05 did.xlsx 真实数据测试三次撞上）：
 *
 * econometrics_recommend 创建 workflow run 时**不带 runId**（画像工具不传 runId），
 * 而 data_import 从 manifest 继承父 stage 的 runId（如 run_20260803-172203_fajxuc）。
 * 修复前 ensureRun 因 runId 不同把同 dataset 的操作分裂成两个 run：画像在 run A，
 * QA/估计在 run B（active）。估计门禁 assertDatasetStageReadyForEstimation 只查
 * active run，找不到画像 → 连续报"必须先完成数据画像"，模型重跑 profile/QA 无济于事。
 *
 * 修复：ensureRun 在同 dataset 已存在 runId-less run 时接管并补充 runId；门禁再加
 * findProfileAcrossRuns 跨 run 兜底（历史遗留的分裂结构也能自愈）。
 */

const SESSION = "ses_run_merge_test"
const DATASET = "dataset_run_merge"
const STAGE = "stage_000"
const SOURCE = "/tmp/dummy_run_merge.parquet"

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-run-merge-"))
  try {
    return await Instance.provide({ directory: root, fn })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function registerManifestFor(datasetId = DATASET, sourcePath = SOURCE) {
  const manifest = createDatasetManifest({
    datasetId,
    sourcePath,
    sourceFormat: "parquet",
  })
  appendStage(manifest, {
    stageId: STAGE,
    branch: "main",
    action: "import",
    workingPath: SOURCE,
    workingFormat: "parquet",
    createdAt: new Date().toISOString(),
  })
}

function registerManifest() {
  registerManifestFor()
}

describe("workflow run 不分裂（2026-08-05 死锁回归）", () => {
  test("带 runId 的 QA 接管同 dataset 的 runId-less 画像 run，而非新建 run", async () => {
    await withInstance(async () => {
      registerManifest()

      // 1. recommend 画像：不带 runId（画像工具的真实行为）
      recordWorkflowStageSuccess({
        sessionID: SESSION,
        toolName: "econometrics_recommend",
        args: { datasetId: DATASET, stageId: STAGE },
        metadata: { datasetId: DATASET, stageId: STAGE },
      })

      // 2. QA：带 manifest 继承的 runId（data_import 的真实行为）
      recordWorkflowStageSuccess({
        sessionID: SESSION,
        toolName: "data_import",
        args: { action: "validate", datasetId: DATASET, stageId: STAGE },
        metadata: {
          action: "validate",
          datasetId: DATASET,
          stageId: STAGE,
          runId: "run_20260803-172203_abc",
          qaGateStatus: "pass",
        },
      })

      // 3. 必须仍是同一个 run（接管而非分裂），且画像留在其中
      const runs = readWorkflowSession(SESSION).runs.filter((run) => run.datasetId === DATASET)
      expect(runs.length).toBe(1)
      expect(runs[0].runId).toBe("run_20260803-172203_abc")
      expect(runs[0].stages.some((s) => s.kind === "profile_or_schema_check" && s.status === "completed")).toBe(true)

      // 4. 估计门禁通过：画像在 active run 内，不需要跨 run 兜底
      const ready = assertDatasetStageReadyForEstimation({ sessionID: SESSION, datasetId: DATASET, stageId: STAGE })
      expect(ready.profileStage?.kind).toBe("profile_or_schema_check")
    })
  })

  test("历史遗留的分裂 run 结构：门禁跨 run 兜底找到画像", async () => {
    await withInstance(async () => {
      registerManifest()
      const sessionState = readWorkflowSession(SESSION)

      // 手工构造修复前遗留的分裂结构：run A 只有画像（runId 为空），run B 只有 QA（带 runId）
      const runA = {
        workflowRunId: "workflow_legacy_profile",
        sessionID: SESSION,
        workflowMode: "econometrics" as const,
        workflowLocale: "zh-CN" as const,
        datasetId: DATASET,
        branch: "main",
        activeStage: "validate" as const,
        stageSequence: [],
        edges: [],
        stages: [
          {
            nodeId: "main:stage_000",
            stageId: STAGE,
            kind: "profile_or_schema_check" as const,
            status: "completed" as const,
            branch: "main",
            datasetId: DATASET,
            dependsOn: [],
            downstream: [],
            cacheKey: "profile_legacy",
            replayable: true,
            executionMode: "normal" as const,
            toolName: "econometrics_recommend",
            replayInput: { datasetId: DATASET, stageId: STAGE },
            artifactRefs: [],
            readableArtifactRefs: [],
            trustedArtifacts: [],
            metadata: {},
            createdAt: "2026-08-05T00:00:00.000Z",
            updatedAt: "2026-08-05T00:00:00.000Z",
          },
        ],
        trustedArtifacts: [],
        analysisChecklist: [],
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      }
      const runB = {
        workflowRunId: "workflow_legacy_estimate",
        sessionID: SESSION,
        workflowMode: "econometrics" as const,
        workflowLocale: "zh-CN" as const,
        datasetId: DATASET,
        runId: "run_20260803-172203_abc",
        branch: "main",
        activeStage: "baseline_estimate" as const,
        stageSequence: [],
        edges: [],
        stages: [
          {
            nodeId: "main:stage_000",
            stageId: STAGE,
            kind: "validate" as const,
            status: "completed" as const,
            branch: "main",
            datasetId: DATASET,
            dependsOn: [],
            downstream: [],
            cacheKey: "qa_legacy",
            replayable: true,
            executionMode: "normal" as const,
            toolName: "data_import",
            replayInput: { action: "validate", datasetId: DATASET, stageId: STAGE },
            artifactRefs: [],
            readableArtifactRefs: [],
            trustedArtifacts: [],
            metadata: { qaGateStatus: "pass" },
            createdAt: "2026-08-05T00:00:00.000Z",
            updatedAt: "2026-08-05T00:00:00.000Z",
          },
        ],
        trustedArtifacts: [],
        analysisChecklist: [],
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      }
      sessionState.runs = [runA as never, runB as never]
      sessionState.activeRunId = runB.workflowRunId
      const { writeWorkflowSession } = await import("@/runtime/workflow")
      writeWorkflowSession(sessionState)

      // 门禁跨 run 兜底：active run（B）无画像，但 run A 有 → 应通过
      const ready = assertDatasetStageReadyForEstimation({ sessionID: SESSION, datasetId: DATASET, stageId: STAGE })
      expect(ready.profileStage?.kind).toBe("profile_or_schema_check")
      expect(ready.profileInherited).toBe(true)
    })
  })

  test("跨数据集回切时，已就绪的旧数据仍可直接继续估计", async () => {
    await withInstance(async () => {
      const otherDataset = "dataset_run_merge_other"
      registerManifestFor(DATASET, SOURCE)
      registerManifestFor(otherDataset, "/tmp/dummy_run_merge_other.parquet")

      const recordReady = (datasetId: string) => {
        recordWorkflowStageSuccess({
          sessionID: SESSION,
          toolName: "econometrics_recommend",
          args: { datasetId, stageId: STAGE },
          metadata: { datasetId, stageId: STAGE },
        })
        recordWorkflowStageSuccess({
          sessionID: SESSION,
          toolName: "data_import",
          args: { action: "validate", datasetId, stageId: STAGE },
          metadata: { action: "validate", datasetId, stageId: STAGE, qaGateStatus: "pass" },
        })
      }

      recordReady(DATASET)
      recordReady(otherDataset)

      const ready = assertDatasetStageReadyForEstimation({ sessionID: SESSION, datasetId: DATASET, stageId: STAGE })
      expect(ready.workflowRun.datasetId).toBe(DATASET)
      expect(ready.profileStage?.kind).toBe("profile_or_schema_check")
    })
  })
})
