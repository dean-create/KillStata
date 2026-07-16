import { describe, expect, test } from "bun:test"
import { ModelStreamAdapter } from "@/runtime/model-stream-adapter"

const DSML_CALL = [
  "<｜｜DSML｜｜tool_calls>",
  '<｜｜DSML｜｜invoke name="econometrics">',
  '<｜｜DSML｜｜parameter name="methodName" string="true">ols_regression<｜｜DSML｜｜parameter>',
  '<｜｜DSML｜｜parameter name="covariates" string="false">"final_news_value_score"<｜｜DSML｜｜parameter>',
  '<｜｜DSML｜｜parameter name="options" string="false">{"robust_se":true}<｜｜DSML｜｜parameter>',
  "</｜｜DSML｜｜invoke>",
  "</｜｜DSML｜｜tool_calls>",
].join("\n")

describe("model stream adapter", () => {
  test("streams ordinary assistant text before the provider closes the text block", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    async function* stream() {
      yield { type: "text-start" }
      yield { type: "text-delta", text: "正在整理结果" }
      await gate
      yield { type: "text-end" }
    }

    const normalized = ModelStreamAdapter.normalize(stream())
    const first = await Promise.race([
      normalized.next(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ])

    expect(first).not.toBe("timeout")
    expect(first).toMatchObject({ value: { type: "text-start" } })
    release()
    await normalized.return(undefined)
  })

  test("flushes ordinary text when the provider omits text-end", async () => {
    async function* stream() {
      yield { type: "text-start" }
      yield { type: "text-delta", text: "结果已经生成" }
    }

    const events = []
    for await (const event of ModelStreamAdapter.normalize(stream())) events.push(event)

    expect(events.map((event) => event.type)).toEqual(["text-start", "text-delta", "text-end"])
    expect(events[1]).toMatchObject({ text: "结果已经生成" })
  })

  test("never turns legacy DSML text into an executable tool call", async () => {
    async function* stream() {
      yield { type: "text-start" }
      yield { type: "text-delta", text: DSML_CALL }
      yield { type: "text-end" }
    }

    const events = []
    for await (const event of ModelStreamAdapter.normalize(stream())) events.push(event)

    expect(events.some((event) => event.type === "tool-call")).toBe(false)
    expect(events.map((event) => event.type)).toEqual(["text-start", "text-delta", "text-end"])
    expect(events[1]).toMatchObject({ text: DSML_CALL })
  })

  test("passes through native OpenAI tool-call events without rewriting their format", async () => {
    async function* stream() {
      yield { type: "tool-input-start", id: "call_1", toolName: "ols_regression" }
      yield {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "ols_regression",
        input: { datasetId: "dataset_1", stageId: "stage_001" },
      }
    }

    const events = []
    for await (const event of ModelStreamAdapter.normalize(stream())) events.push(event)

    expect(events.map((event) => event.type)).toEqual(["tool-input-start", "tool-call"])
    expect(events[1]).toMatchObject({
      toolCallId: "call_1",
      toolName: "ols_regression",
      input: { datasetId: "dataset_1", stageId: "stage_001" },
    })
  })
})
