import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { createUserMessage } from "@/session/prompt/message"
import { MessageV2 } from "@/session/message-v2"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-excel-attachment-"))

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe("Excel attachment context boundary", () => {
  test("persists only a local file reference and a bounded import instruction", async () => {
    const filepath = path.join(root, "survey.xlsx")
    fs.writeFileSync(filepath, Buffer.from("PK\\x03\\x04"))
    const message = await Instance.provide({
      directory: root,
      fn: () =>
        createUserMessage({
          sessionID: "ses_excel_attachment",
          agent: "analyst",
          parts: [
            {
              type: "file",
              mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              filename: "survey.xlsx",
              url: `file://${filepath}`,
            },
          ],
        } as any),
    })

    const serialized = JSON.stringify(message)
    expect(serialized).not.toContain("base64")
    expect(serialized).not.toContain("UEsDB")
    expect(serialized).toContain("survey.xlsx")
    expect(serialized).toContain("data_import")
    expect(serialized).toContain("action=\\\"import\\\"")
    expect(serialized).toContain("inputPath")
    expect(message.parts.some((part) => part.type === "file" && part.url.startsWith("file://"))).toBe(true)
    const filePart = message.parts.find((part) => part.type === "file")
    expect(filePart?.url).not.toContain("data:")
  })

  test("materializes an inline workbook once, then omits it from ModelMessage file parts", async () => {
    const payload = Buffer.from("PK\x03\x04 inline workbook").toString("base64")
    const message = await Instance.provide({
      directory: root,
      fn: () =>
        createUserMessage({
          sessionID: "ses_excel_inline",
          agent: "analyst",
          parts: [
            {
              type: "file",
              mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              filename: "inline.xlsx",
              url: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${payload}`,
            },
          ],
        } as any),
    })
    expect(JSON.stringify(message)).not.toContain(payload)
    expect(JSON.stringify(message)).toContain(".killstata/attachments/")
    const restored = message.parts.find((part) => part.type === "file")
    expect(restored?.url).toMatch(/^file:\/\//)

    const modelMessages = MessageV2.toModelMessages([message], {
      providerID: "deepseek",
      id: "deepseek-v4-flash",
    } as never)
    const modelPayload = JSON.stringify(modelMessages)
    expect(modelPayload).toContain("data_import")
    expect(modelPayload).not.toContain("inline workbook")
    expect(modelPayload).not.toContain("application/vnd.openxmlformats")
    expect(modelPayload).not.toContain("type\":\"file")
  })

  test("keeps CSV uploads as file references so their canonical dataset can be linked to this message", async () => {
    const filepath = path.join(root, "firms.csv")
    fs.writeFileSync(filepath, "firm_id\n00123\n")
    const message = await Instance.provide({
      directory: root,
      fn: () =>
        createUserMessage({
          sessionID: "ses_csv_attachment",
          agent: "analyst",
          parts: [{ type: "file", mime: "text/csv", filename: "firms.csv", url: `file://${filepath}` }],
        } as any),
    })

    const file = message.parts.find((part) => part.type === "file")
    expect(file?.url).toBe(`file://${filepath}`)
    expect(JSON.stringify(message)).toContain("data_import")
    expect(JSON.stringify(message)).toContain('action=\\"import\\"')
  })
})
