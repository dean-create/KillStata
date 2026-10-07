import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { readDatasetManifest } from "@/runtime/dataset-state"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { createUserMessage } from "@/session/prompt/message"
import { DataImportTool } from "@/tool/data-import"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const ctx = {
  sessionID: "ses_canonical_source",
  messageID: "msg_canonical_source",
  callID: "call_canonical_source",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
}

async function withProject<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-canonical-source-"))
  const priorPython = process.env.KILLSTATA_PYTHON
  if (!priorPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    if (priorPython === undefined) delete process.env.KILLSTATA_PYTHON
    else process.env.KILLSTATA_PYTHON = priorPython
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("canonical source import", () => {
  test("fresh import ignores a stale datasetId hint when inputPath is authoritative", async () => {
    await withProject(async (root) => {
      const sourcePath = path.join(root, "stale-hint.csv")
      fs.writeFileSync(sourcePath, "id,outcome\nA,1\nB,2\n", "utf-8")

      const imported = await (await DataImportTool.init()).execute({
        action: "import",
        inputPath: sourcePath,
        datasetId: "dataset_stale_hint",
        preserveLabels: true,
      }, ctx as never)

      expect(imported.metadata.datasetId).not.toBe("dataset_stale_hint")
      expect(imported.metadata.stageId).toBe("stage_000")
      expect((imported.metadata.analysisView as { foundInputFile?: string }).foundInputFile).toBe("stale-hint.csv")
      expect(readDatasetManifest(imported.metadata.datasetId!)).toBeDefined()
    })
  }, 30_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("imports the repository DID workbook through the complete managed tool chain", async () => {
    await withProject(async () => {
      const sourcePath = localRealDataPath("did.xlsx")
      const started = performance.now()
      const tool = await DataImportTool.init()
      const imported = await tool.execute({ action: "import", inputPath: sourcePath, preserveLabels: true }, ctx as never)

      expect((imported.metadata.result as { rows_after?: number }).rows_after).toBe(4709)
      expect(imported.metadata.datasetId).toBeString()
      expect(imported.metadata.stageId).toBe("stage_000")
      const manifest = readDatasetManifest(imported.metadata.datasetId!)
      const stage = manifest.stages.find((item) => item.stageId === imported.metadata.stageId)
      expect(stage?.workingPath && fs.existsSync(stage.workingPath)).toBe(true)
      expect(stage?.schemaPath && fs.existsSync(stage.schemaPath)).toBe(true)
      expect(performance.now() - started).toBeLessThan(20_000)
    })
  }, 30_000)

  test("imports the managed source snapshot and records its schema receipt", async () => {
    await withProject(async (root) => {
      const sourcePath = path.join(root, "firms.csv")
      fs.writeFileSync(sourcePath, "firm_id,amount,literal\n00123,1200,NA\n00124,1300,-\n")
      const python = process.env.KILLSTATA_PYTHON!
      execFileSync(python, ["-c", "import pandas, pyarrow"], { stdio: ["ignore", "pipe", "pipe"] })

      const upload = await createUserMessage({
        sessionID: ctx.sessionID,
        agent: "analyst",
        parts: [{ type: "file", mime: "text/csv", filename: "firms.csv", url: `file://${sourcePath}` }],
      } as never)
      const attachment = upload.parts.find((part) => part.type === "file")!

      const tool = await DataImportTool.init()
      const imported = await tool.execute({ action: "import", inputPath: sourcePath, preserveLabels: true }, ctx as never)
      const manifest = readDatasetManifest(imported.metadata.datasetId!)
      const stage = manifest.stages.find((item) => item.stageId === imported.metadata.stageId)

      expect(manifest.sourceAsset?.sourceId).toMatch(/^[a-f0-9]{64}$/)
      if (!manifest.sourceAsset) throw new Error("source asset missing from imported manifest")
      expect(manifest.sourcePath).toBe(manifest.sourceAsset.managedPath)
      expect(fs.existsSync(manifest.sourceAsset.managedPath)).toBe(true)
      expect(manifest.origin).toMatchObject({ sessionID: ctx.sessionID, messageID: upload.info.id, attachmentPartID: attachment.id })
      expect(stage?.importReceiptPath).toBeTruthy()
      const receipt = JSON.parse(fs.readFileSync(stage!.importReceiptPath!, "utf-8"))
      expect(receipt).toMatchObject({
        sourceId: manifest.sourceAsset?.sourceId,
        sourceFormat: "csv",
        readerPolicy: "conservative_schema_normalization_v1",
      })

      const rows = JSON.parse(
        execFileSync(python, ["-c", "import json,pandas as pd,sys; print(json.dumps(pd.read_parquet(sys.argv[1]).to_dict(orient='list')))", stage!.workingPath], { encoding: "utf-8" }),
      ) as Record<string, unknown[]>
      expect(rows.firm_id).toEqual(["00123", "00124"])
      expect(rows.literal).toEqual(["NA", "-"])
      const messages = await Session.messages({ sessionID: ctx.sessionID })
      const record = messages
        .flatMap((message) => message.parts)
        .find(
          (part): part is MessageV2.TextPart =>
            part.type === "text" && part.metadata?.datasetOrigin?.datasetId === manifest.datasetId,
        )
      expect(record?.text).toContain(`datasetId=${manifest.datasetId}`)
    })
  }, 120_000)

  test("restores Excel zero-padded identifiers before writing canonical Parquet", async () => {
    await withProject(async (root) => {
      const sourcePath = path.join(root, "firms.xlsx")
      const python = process.env.KILLSTATA_PYTHON!
      execFileSync(
        python,
        [
          "-c",
          "from openpyxl import Workbook; import sys; wb=Workbook(); ws=wb.active; ws.title='Sheet1'; ws.append(['firm_id','amount']); ws.append([123,1200]); ws['A2'].number_format='00000'; wb.save(sys.argv[1])",
          sourcePath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      )

      const tool = await DataImportTool.init()
      const imported = await tool.execute({ action: "import", inputPath: sourcePath, preserveLabels: true }, ctx as never)
      const manifest = readDatasetManifest(imported.metadata.datasetId!)
      const stage = manifest.stages.find((item) => item.stageId === imported.metadata.stageId)!
      const rows = JSON.parse(
        execFileSync(python, ["-c", "import json,pandas as pd,sys; print(json.dumps(pd.read_parquet(sys.argv[1]).to_dict(orient='list')))", stage.workingPath], { encoding: "utf-8" }),
      ) as Record<string, unknown[]>

      expect(rows.firm_id).toEqual(["00123"])
      const receipt = JSON.parse(fs.readFileSync(stage.importReceiptPath!, "utf-8")) as {
        normalization: { columns: Array<{ name: string; decision: string }> }
      }
      expect(receipt.normalization.columns.find((column) => column.name === "firm_id")).toMatchObject({
        decision: "restore_excel_zero_padded_identifier",
      })
    })
  }, 120_000)
})
