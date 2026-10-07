/**
 * 会话隔离：指纹复用必须按会话过滤。
 *
 * 同一源文件在会话 A 导入过，会话 B 再导入同一文件时必须新建独立数据集，
 * 不允许复用 A 的 manifest/stages（2026-08-08 用户诉求：干净的新窗口）。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import {
  createDatasetId,
  createDatasetManifest,
  findDatasetForSource,
  fingerprintSourceFile,
  upsertDatasetIndexEntry,
  appendStage,
} from "@/tool/analysis-state"
import { readDatasetIndex, writeDatasetIndex, projectInternalRoot } from "@/runtime/dataset-state"

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-fp-iso-"))
  // 给 source 文件一个真实大小 + mtime，保证 fingerprint 稳定
  const sourcePath = path.join(root, "did.xlsx")
  fs.writeFileSync(sourcePath, "x,y\n1,2\n")
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/** 模拟"已 import 完成"：写 manifest + index，让 findDatasetForSource 拿到 manifest */
function seedImported(sourcePath: string, datasetId: string, sessionID: string) {
  const fp = fingerprintSourceFile(sourcePath)
  fs.mkdirSync(path.join(projectInternalRoot(), "datasets", datasetId), { recursive: true })
  const manifest = createDatasetManifest({ datasetId, sourcePath, sourceFormat: path.extname(sourcePath).replace(/^\./, "") as "xlsx" })
  appendStage(manifest, {
    stageId: "stage_000",
    branch: "main",
    action: "import",
    workingPath: sourcePath,
    workingFormat: "parquet",
    createdAt: new Date().toISOString(),
  })
  fs.writeFileSync(
    path.join(projectInternalRoot(), "datasets", datasetId, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  )
  upsertDatasetIndexEntry({ datasetId, sourcePath, fingerprint: fp, sessionID })
}

describe("findDatasetForSource 会话隔离", () => {
  test("同一指纹在不同会话生成不同 datasetId", async () => {
    await withInstance(async (root) => {
      const sourcePath = path.join(root, "did.xlsx")
      const fingerprint = fingerprintSourceFile(sourcePath)
      expect(createDatasetId(sourcePath, fingerprint.key, "ses_a")).not.toBe(
        createDatasetId(sourcePath, fingerprint.key, "ses_b"),
      )
    })
  })

  test("同会话内：指纹命中且 createdBySessionID 匹配 → 复用", async () => {
    await withInstance(async (root) => {
      const sourcePath = path.join(root, "did.xlsx")
      seedImported(sourcePath, "ds_mine", "ses_a")
      const r = findDatasetForSource(sourcePath, "ses_a")
      expect(r.manifest).toBeDefined()
      expect(r.manifest?.datasetId).toBe("ds_mine")
    })
  })

  test("跨会话：指纹命中但 createdBySessionID 属于别会话 → 不复用，新会话得到无 manifest", async () => {
    await withInstance(async (root) => {
      const sourcePath = path.join(root, "did.xlsx")
      seedImported(sourcePath, "ds_legacy", "ses_legacy")
      const r = findDatasetForSource(sourcePath, "ses_fresh")
      expect(r.manifest).toBeUndefined()
      // fingerprint 仍然返回，调用方据此新建数据集
      expect(r.fingerprint.key).toBeTruthy()
    })
  })

  test("A→B→A 交错导入时两个会话都能复用自己的数据集", async () => {
    await withInstance(async (root) => {
      const sourcePath = path.join(root, "did.xlsx")
      seedImported(sourcePath, "ds_a", "ses_a")
      seedImported(sourcePath, "ds_b", "ses_b")

      expect(findDatasetForSource(sourcePath, "ses_a").manifest?.datasetId).toBe("ds_a")
      expect(findDatasetForSource(sourcePath, "ses_b").manifest?.datasetId).toBe("ds_b")
      expect(Object.values(readDatasetIndex().entries).map((entry) => entry.datasetId).sort()).toEqual(["ds_a", "ds_b"])
    })
  })

  test("历史条目无 createdBySessionID（旧版本写入）：新会话不复用", async () => {
    await withInstance(async (root) => {
      const sourcePath = path.join(root, "did.xlsx")
      // 写入 manifest（模拟真正"导入过"），但 index 条目不带 createdBySessionID
      const fp = fingerprintSourceFile(sourcePath)
      fs.mkdirSync(path.join(projectInternalRoot(), "datasets", "ds_orphan"), { recursive: true })
      const manifest = createDatasetManifest({ datasetId: "ds_orphan", sourcePath, sourceFormat: "xlsx" })
      appendStage(manifest, {
        stageId: "stage_000",
        branch: "main",
        action: "import",
        workingPath: sourcePath,
        workingFormat: "parquet",
        createdAt: new Date().toISOString(),
      })
      fs.writeFileSync(
        path.join(projectInternalRoot(), "datasets", "ds_orphan", "manifest.json"),
        JSON.stringify(manifest, null, 2),
      )
      fs.mkdirSync(projectInternalRoot(), { recursive: true })
      writeDatasetIndex({
        version: 1,
        entries: {
          [fp.key]: {
            datasetId: "ds_orphan",
            sourcePath,
            fingerprint: fp,
            updatedAt: new Date().toISOString(),
            // 没有 createdBySessionID —— 旧版本写入的条目
          },
        },
      })
      const r = findDatasetForSource(sourcePath, "ses_anyone")
      expect(r.manifest).toBeUndefined()
    })
  })

  test("不传 sessionID 时走旧行为（向后兼容，index 内部一致性自检等场景）", async () => {
    await withInstance(async (root) => {
      const sourcePath = path.join(root, "did.xlsx")
      seedImported(sourcePath, "ds_x", "ses_a")
      // 不传 sessionID：仍然复用（向后兼容；data_import 路径现已强制传 sessionID）
      const r = findDatasetForSource(sourcePath)
      expect(r.manifest?.datasetId).toBe("ds_x")
    })
  })
})
