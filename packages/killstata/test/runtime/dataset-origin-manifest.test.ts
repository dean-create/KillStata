import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { readDatasetManifest } from "@/runtime/dataset-state"
import { createDatasetManifest, writeDatasetManifest } from "@/tool/analysis-state"

describe("DatasetManifest conversation origin", () => {
  test("persists the upload conversation that owns an imported workbook", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-origin-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const origin = {
            sessionID: "ses_excel_owner",
            messageID: "msg_excel_upload",
            attachmentPartID: "prt_excel_upload",
            importedAt: "2026-08-22T00:00:00.000Z",
          }
          const manifest = createDatasetManifest({
            datasetId: "ds_excel_owner",
            sourcePath: path.join(root, "survey.xlsx"),
            sourceFormat: "xlsx",
            origin,
          })
          writeDatasetManifest(manifest)

          expect(manifest.origin).toEqual(origin)
          expect(readDatasetManifest(manifest.datasetId).origin).toEqual(origin)
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
