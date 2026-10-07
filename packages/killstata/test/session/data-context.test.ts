/**
 * 会话隔离：data-context 必须只反映本会话真正操作过的数据集，绝不暴露别会话的导入。
 *
 * 用户诉求（2026-08-08）：新会话窗口必须干净、隔离。新会话第一轮不应该看到上一窗口
 * 导入的 did_7f1335de，也不应被 `hasActiveDataset && 非闲聊 → ingest` 兜底推向旧数据。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { DataContext } from "@/session/data-context"
import { writeDatasetIndex, readDatasetManifest, projectInternalRoot } from "@/runtime/dataset-state"
import {
  appendStage,
  createDatasetManifest,
} from "@/tool/analysis-state"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-ctx-iso-"))
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/** 在另一会话（"legacy"）里写入一个完整数据集 + workflow run，模拟"上一窗口导入 did_7f1335de" */
function seedLegacyDataset(root: string, legacySessionID: string, datasetId: string) {
  fs.mkdirSync(projectInternalRoot(), { recursive: true })
  const manifest = createDatasetManifest({ datasetId, sourcePath: path.join(root, "did.xlsx"), sourceFormat: "xlsx" })
  appendStage(manifest, {
    stageId: "stage_000",
    branch: "main",
    action: "import",
    workingPath: path.join(root, "did.xlsx"),
    workingFormat: "parquet",
    createdAt: new Date().toISOString(),
  })
  // 显式写盘：dataset index / manifest 是项目级，新会话建好后读得到
  fs.writeFileSync(path.join(projectInternalRoot(), "datasets", datasetId, "manifest.json"), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(
    path.join(projectInternalRoot(), "datasets", "index.json"),
    JSON.stringify({
      version: 1,
      entries: {
        [`${path.join(root, "did.xlsx")}::1::1`]: {
          datasetId,
          sourcePath: path.join(root, "did.xlsx"),
          fingerprint: { realPath: path.join(root, "did.xlsx"), sizeBytes: 1, mtimeMs: 1, key: `${path.join(root, "did.xlsx")}::1::1` },
          updatedAt: new Date().toISOString(),
          createdBySessionID: legacySessionID,
        },
      },
    }, null, 2),
  )
  // legacy 会话的工作流 session：runs 里有这个 datasetId
  const state = readWorkflowSession(legacySessionID)
  state.runs.push({
    workflowRunId: "wf_legacy",
    sessionID: legacySessionID,
    workflowMode: "econometrics",
    workflowLocale: "zh-CN",
    datasetId,
    branch: "main",
    activeStage: "import",
    stageSequence: [],
    edges: [],
    trustedArtifacts: [],
    analysisChecklist: [],
    stages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  writeWorkflowSession(state)
}

describe("DataContext 会话隔离", () => {
  test("当前会话环境包含上传后保存的数据就绪摘要", async () => {
    await withInstance(async (root) => {
      const sessionID = "ses_readiness_context"
      const datasetId = "dataset_readiness"
      const manifest = createDatasetManifest({ datasetId, sourcePath: path.join(root, "gf.xlsx"), sourceFormat: "xlsx" })
      appendStage(manifest, {
        stageId: "stage_000",
        branch: "main",
        action: "import",
        workingPath: path.join(root, "gf.parquet"),
        workingFormat: "parquet",
        createdAt: new Date().toISOString(),
        metadata: {
          dataReadiness: {
            version: 1,
            rowCount: 10,
            columnCount: 3,
            columns: [],
            panelCandidates: [],
            exactLinearDependencies: [],
            candidateMethods: [{ methodID: "ols_regression", status: "candidate", reason: "数值列", repairSuggestions: [] }],
            warnings: [],
          },
        },
      })
      fs.writeFileSync(path.join(projectInternalRoot(), "datasets", datasetId, "manifest.json"), JSON.stringify(manifest, null, 2))
      const state = readWorkflowSession(sessionID)
      state.runs.push({
        workflowRunId: "wf_readiness_context",
        sessionID,
        workflowMode: "econometrics",
        workflowLocale: "zh-CN",
        datasetId,
        branch: "main",
        activeStage: "import",
        stageSequence: [],
        edges: [],
        trustedArtifacts: [],
        analysisChecklist: [],
        stages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      writeWorkflowSession(state)

      expect(DataContext.readiness(sessionID)).toContain("ols_regression")
      expect(DataContext.readiness(sessionID)).toContain("数据就绪检查")
    })
  })

  test("新会话（没碰过数据集）：hasActiveDataset=false，build 绝不暴露上一会话的 datasetId", async () => {
    await withInstance(async (root) => {
      seedLegacyDataset(root, "ses_legacy", "did_legacy_xxx")
      const newSession = "ses_fresh_a"
      expect(DataContext.hasActiveDataset(newSession)).toBe(false)
      const ctx = DataContext.build(newSession)
      if (ctx !== undefined) {
        expect(ctx).not.toContain("did_legacy_xxx")
        expect(ctx).not.toContain("上次会话遗留")
        expect(ctx).not.toContain("本会话尚未操作过")
      }
    })
  })

  test("本会话碰过数据集：hasActiveDataset=true，build 显示'当前数据集'", async () => {
    await withInstance(async (root) => {
      seedLegacyDataset(root, "ses_legacy", "did_legacy_xxx")
      // 本会话也写一份数据集（不模拟"上一会话"的隔离场景，只验证 build 的正向路径）
      const myDataset = "did_mine_xxx"
      fs.mkdirSync(path.join(projectInternalRoot(), "datasets", myDataset), { recursive: true })
      const manifest = createDatasetManifest({
        datasetId: myDataset,
        sourcePath: path.join(root, "mine.xlsx"),
        sourceFormat: "xlsx",
        origin: {
          sessionID: "ses_legacy",
          messageID: "msg_legacy_upload",
          attachmentPartID: "prt_legacy_upload",
          importedAt: "2026-08-22T00:00:00.000Z",
        },
      })
      appendStage(manifest, {
        stageId: "stage_000",
        branch: "main",
        action: "import",
        workingPath: path.join(root, "mine.xlsx"),
        workingFormat: "parquet",
        createdAt: new Date().toISOString(),
      })
      fs.writeFileSync(
        path.join(projectInternalRoot(), "datasets", myDataset, "manifest.json"),
        JSON.stringify(manifest, null, 2),
      )
      const mySession = "ses_fresh_b"
      const state = readWorkflowSession(mySession)
      state.runs.push({
        workflowRunId: "wf_mine",
        sessionID: mySession,
        workflowMode: "econometrics",
        workflowLocale: "zh-CN",
        datasetId: myDataset,
        branch: "main",
        activeStage: "import",
        stageSequence: [],
        edges: [],
        trustedArtifacts: [],
        analysisChecklist: [],
        stages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      writeWorkflowSession(state)
      expect(DataContext.hasActiveDataset(mySession)).toBe(true)
      const ctx = DataContext.build(mySession) ?? ""
      expect(ctx).toContain("本会话已关联当前数据集")
      expect(ctx).not.toContain(myDataset)
      expect(ctx).not.toContain("did_legacy_xxx")
      expect(ctx).not.toContain("msg_legacy_upload")
    })
  })

  test("无索引条目 + 无数据文件时 build 返回 undefined（不塞空壳）", async () => {
    await withInstance(async () => {
      expect(DataContext.build("ses_empty")).toBeUndefined()
      expect(DataContext.hasActiveDataset("ses_empty")).toBe(false)
    })
  })

  test("A→B 后切回 A 时，build 以 activeRunId 对应的数据集为准", async () => {
    await withInstance(async (root) => {
      const sessionID = "ses_switch"
      for (const datasetId of ["dataset_a", "dataset_b"]) {
        fs.mkdirSync(path.join(projectInternalRoot(), "datasets", datasetId), { recursive: true })
        const manifest = createDatasetManifest({
          datasetId,
          sourcePath: path.join(root, `${datasetId}.csv`),
          sourceFormat: "csv",
        })
        appendStage(manifest, {
          stageId: "stage_000",
          branch: "main",
          action: "import",
          workingPath: path.join(root, `${datasetId}.parquet`),
          workingFormat: "parquet",
          createdAt: new Date().toISOString(),
        })
        fs.writeFileSync(
          path.join(projectInternalRoot(), "datasets", datasetId, "manifest.json"),
          JSON.stringify(manifest, null, 2),
        )
      }

      const state = readWorkflowSession(sessionID)
      const run = (workflowRunId: string, datasetId: string) => ({
        workflowRunId,
        sessionID,
        workflowMode: "econometrics" as const,
        workflowLocale: "zh-CN" as const,
        datasetId,
        branch: "main",
        activeStage: "import" as const,
        stageSequence: [],
        edges: [],
        trustedArtifacts: [],
        analysisChecklist: [],
        stages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      state.runs.push(run("wf_a", "dataset_a"), run("wf_b", "dataset_b"))
      state.activeRunId = "wf_a"
      writeWorkflowSession(state)

      const context = DataContext.build(sessionID) ?? ""
      expect(context).toContain("本会话已关联当前数据集")
      expect(context).not.toContain("dataset_a")
      expect(context).not.toContain("stage_a")
    })
  })
})
