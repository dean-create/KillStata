import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { linkDatasetToConversation } from "@/session/dataset-origin"
import { MessageV2 } from "@/session/message-v2"
import { createUserMessage } from "@/session/prompt/message"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-dataset-origin-message-"))

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe("dataset conversation origin", () => {
  test("writes the imported dataset and canonical artifacts back to its upload message", async () => {
    const sourcePath = path.join(root, "survey.xlsx")
    fs.writeFileSync(sourcePath, Buffer.from("PK\\x03\\x04"))
    const sessionID = "ses_dataset_origin"

    await Instance.provide({
      directory: root,
      fn: async () => {
        const upload = await createUserMessage({
          sessionID,
          agent: "analyst",
          parts: [
            {
              type: "file",
              mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              filename: "survey.xlsx",
              url: `file://${sourcePath}`,
            },
          ],
        } as any)
        const attachment = upload.parts.find((part) => part.type === "file")!

        const origin = await linkDatasetToConversation({
          sessionID,
          sourcePath,
          datasetId: "ds_survey",
          stageId: "stage_000",
          artifactPaths: [
            path.join(root, ".killstata", "datasets", "ds_survey", "stages", "stage_000", "data.parquet"),
            path.join(root, ".killstata", "datasets", "ds_survey", "stages", "stage_000", "schema.json"),
          ],
        })

        expect(origin).toEqual({ messageID: upload.info.id, attachmentPartID: attachment.id })
        const stored = await Session.messages({ sessionID })
        const record = stored[0]!.parts.find(
          (part): part is MessageV2.TextPart =>
            part.type === "text" && part.metadata?.datasetOrigin?.datasetId === "ds_survey",
        )
        expect(record?.text).toContain("<dataset-record>")
        expect(record?.text).toContain("manifest=.killstata/datasets/ds_survey/manifest.json")
        expect(record?.text).toContain("stageId=stage_000")
        expect(record?.text).toContain("artifacts=.killstata/datasets/ds_survey/stages/stage_000/data.parquet")
      },
    })
  })

  test("refreshes the original upload record after import switches to a managed source snapshot", async () => {
    const sourcePath = path.join(root, "managed-source.csv")
    const managedPath = path.join(root, ".killstata", "sources", "hash", "original.csv")
    fs.mkdirSync(path.dirname(managedPath), { recursive: true })
    fs.writeFileSync(sourcePath, "firm_id\n00123\n")
    fs.copyFileSync(sourcePath, managedPath)
    const sessionID = "ses_dataset_origin_managed"

    await Instance.provide({
      directory: root,
      fn: async () => {
        const upload = await createUserMessage({
          sessionID,
          agent: "analyst",
          parts: [{ type: "file", mime: "text/csv", filename: "managed-source.csv", url: `file://${sourcePath}` }],
        } as any)
        const attachment = upload.parts.find((part) => part.type === "file")!

        const origin = await linkDatasetToConversation({
          sessionID,
          sourcePath: managedPath,
          messageID: upload.info.id,
          attachmentPartID: attachment.id,
          datasetId: "ds_managed_source",
          stageId: "stage_001",
        })

        expect(origin).toEqual({ messageID: upload.info.id, attachmentPartID: attachment.id })
        const stored = await Session.messages({ sessionID })
        expect(stored[0]!.parts.some((part) => part.type === "text" && part.text.includes("stageId=stage_001"))).toBe(true)
      },
    })
  })
})
