import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import * as DatasetState from "@/runtime/dataset-state"
import { createDatasetManifest, readDatasetManifest, writeDatasetManifest } from "@/tool/analysis-state"

describe("dataset import receipts", () => {
  test("persists the source, sheet decision, and canonical stage as one receipt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-import-receipt-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const writeImportReceipt = (DatasetState as any).writeImportReceipt
          expect(writeImportReceipt).toBeFunction()

          const receiptPath = path.join(root, ".killstata", "datasets", "ds_firms", "meta", "stage_000_import_receipt.json")
          writeImportReceipt({
            datasetId: "ds_firms",
            receiptPath,
            receipt: {
              sourceId: "sha256_firms",
              sourceFormat: "xlsx",
              sheetPolicy: { mode: "named_sheet", sheetName: "Sheet1", headerRow: 1 },
              readerPolicy: "conservative_schema_normalization_v1",
              canonicalStagePath: ".killstata/datasets/ds_firms/stages/stage_000.parquet",
              schemaPath: ".killstata/datasets/ds_firms/meta/stage_000_schema.json",
              normalization: { columns: [], warnings: [] },
            },
          })

          expect(JSON.parse(fs.readFileSync(receiptPath, "utf-8"))).toMatchObject({
            sourceId: "sha256_firms",
            sourceFormat: "xlsx",
            sheetPolicy: { sheetName: "Sheet1", headerRow: 1 },
            canonicalStagePath: ".killstata/datasets/ds_firms/stages/stage_000.parquet",
          })
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("拒绝通过 meta 目录 symlink 把导入收据写出当前数据集", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-import-receipt-symlink-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-import-receipt-external-"))
    const datasetId = "ds_receipt_symlink"
    try {
      await Instance.provide({
        directory: root,
        fn: () => {
          const datasetRoot = path.join(root, ".killstata", "datasets", datasetId)
          fs.mkdirSync(datasetRoot, { recursive: true })
          fs.symlinkSync(external, path.join(datasetRoot, "meta"), "dir")
          expect(() => DatasetState.writeImportReceipt({
            datasetId,
            receiptPath: path.join(datasetRoot, "meta", "receipt.json"),
            receipt: {
              sourceId: "sha256_receipt",
              sourceFormat: "csv",
              sheetPolicy: { mode: "first_sheet" },
              readerPolicy: "conservative_schema_normalization_v1",
              canonicalStagePath: `.killstata/datasets/${datasetId}/stages/stage_000.parquet`,
              normalization: { columns: [], warnings: [] },
            },
          })).toThrow(/符号链接|数据产物路径指向当前数据集之外|受管状态路径指向项目之外/)
          expect(fs.readdirSync(external)).toEqual([])
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })

  test("拒绝通过 manifest.json symlink 把数据阶段写入项目外", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-manifest-symlink-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-manifest-external-"))
    const datasetId = "ds_manifest_symlink"
    try {
      await Instance.provide({
        directory: root,
        fn: () => {
          const sourcePath = path.join(root, "source.csv")
          fs.writeFileSync(sourcePath, "id,value\na,1\n", "utf-8")
          const manifest = createDatasetManifest({ datasetId, sourcePath, sourceFormat: "csv" })
          const externalManifest = path.join(external, "manifest.json")
          fs.writeFileSync(externalManifest, "keep me", "utf-8")
          fs.symlinkSync(externalManifest, DatasetState.datasetManifestPath(datasetId))
          expect(() => writeDatasetManifest(manifest)).toThrow(/符号链接|数据产物路径指向当前数据集之外|受管状态路径指向项目之外/)
          expect(fs.readFileSync(externalManifest, "utf-8")).toBe("keep me")
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })

  test("读取 manifest 时拒绝跟随指向项目外的 symlink", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-manifest-read-symlink-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-manifest-read-external-"))
    const datasetId = "ds_manifest_read_symlink"
    try {
      await Instance.provide({
        directory: root,
        fn: () => {
          const sourcePath = path.join(root, "source.csv")
          fs.writeFileSync(sourcePath, "id,value\na,1\n", "utf-8")
          const manifest = createDatasetManifest({ datasetId, sourcePath, sourceFormat: "csv" })
          writeDatasetManifest(manifest)
          const externalManifest = path.join(external, "manifest.json")
          fs.writeFileSync(externalManifest, JSON.stringify({ datasetId }), "utf-8")
          fs.rmSync(DatasetState.datasetManifestPath(datasetId))
          fs.symlinkSync(externalManifest, DatasetState.datasetManifestPath(datasetId))
          expect(() => readDatasetManifest(datasetId)).toThrow(/符号链接|受管状态路径指向项目之外/)
          expect(fs.readFileSync(externalManifest, "utf-8")).toBe(JSON.stringify({ datasetId }))
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })

  test("legacy 名称迁移不能跟随 manifest symlink 改写外部文件", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-manifest-migration-symlink-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-manifest-migration-external-"))
    const datasetId = "ds_manifest_migration_symlink"
    const legacyBundleName = "killstata_ouput_202609241230"
    try {
      await Instance.provide({
        directory: root,
        fn: () => {
          DatasetState.ensureInternalLayout()
          const datasetRoot = DatasetState.datasetRoot(datasetId)
          fs.mkdirSync(datasetRoot, { recursive: true })
          const externalManifest = path.join(external, "manifest.json")
          const original = JSON.stringify({ datasetId, note: legacyBundleName })
          fs.writeFileSync(externalManifest, original, "utf-8")
          fs.symlinkSync(externalManifest, DatasetState.datasetManifestPath(datasetId))
          fs.mkdirSync(path.join(root, legacyBundleName), { recursive: true })
          expect(() => readDatasetManifest(datasetId)).toThrow(/符号链接|受管状态路径指向项目之外/)
          expect(fs.readFileSync(externalManifest, "utf-8")).toBe(original)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })

  test("legacy delivery manifests symlink 指向外部时不重命名外部目录", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-delivery-migration-symlink-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-delivery-migration-external-"))
    const legacyName = "killstata_ouput_202609241230"
    try {
      await Instance.provide({
        directory: root,
        fn: () => {
          DatasetState.ensureInternalLayout()
          const manifests = path.join(DatasetState.deliveryStateRoot(), "manifests")
          fs.symlinkSync(external, manifests, "dir")
          fs.mkdirSync(path.join(external, legacyName), { recursive: true })
          expect(() => DatasetState.ensureInternalLayout()).toThrow(/符号链接|受管状态路径指向项目之外/)
          expect(fs.existsSync(path.join(external, legacyName))).toBe(true)
          expect(fs.existsSync(path.join(external, "killstata_output_20260924_1230"))).toBe(false)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })

  test("createDatasetManifest 在数据集根 symlink 指向外部时不创建目录", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-root-symlink-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-root-external-"))
    const datasetId = "ds_root_symlink"
    try {
      await Instance.provide({
        directory: root,
        fn: () => {
          const sourcePath = path.join(root, "source.csv")
          fs.writeFileSync(sourcePath, "id,value\na,1\n", "utf-8")
          const datasets = path.join(root, ".killstata", "datasets")
          fs.mkdirSync(datasets, { recursive: true })
          fs.symlinkSync(external, path.join(datasets, datasetId), "dir")
          expect(() => createDatasetManifest({ datasetId, sourcePath, sourceFormat: "csv" })).toThrow(/符号链接|数据集目录与其规范 ID|受管状态路径指向项目之外/)
          expect(fs.readdirSync(external)).toEqual([])
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })
})
