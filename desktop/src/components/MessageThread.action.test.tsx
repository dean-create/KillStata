import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test } from "vitest"
import { MessageThread } from "./MessageThread"

afterEach(() => cleanup())

describe("MessageThread result actions", () => {
  test("does not add copy or export controls to the conversation", () => {
    render(() => (
      <MessageThread
        messages={[{ kind: "assistant", id: 1, document: "result", resultExportable: true }]}
        renderBlocks={() => [{ kind: "paragraph", text: "result" }]}
      />
    ))

    expect(screen.queryByRole("button", { name: "复制结果" })).toBeNull()
    expect(screen.queryByRole("button", { name: "导出 Markdown" })).toBeNull()
  })

  test("keeps streaming reasoning collapsed by default while showing the reply immediately", async () => {
    const user = userEvent.setup()
    const first = { kind: "assistant" as const, id: 7, document: "回复正文", reasoning: "第一段思考", streaming: true }
    const [messages, setMessages] = createSignal([first])
    render(() => (
      <MessageThread
        messages={messages()}
        renderBlocks={(document) => [{ kind: "paragraph", text: document }]}
      />
    ))

    expect(screen.getByText("展开思考过程")).toBeTruthy()
    expect(screen.queryByText("第一段思考")).toBeNull()
    expect(screen.getByText("回复正文")).toBeTruthy()

    await user.click(screen.getByText("展开思考过程"))
    expect(screen.getByText("第一段思考")).toBeTruthy()
    expect(screen.getByText("收起思考过程")).toBeTruthy()

    setMessages([{ ...first, reasoning: "第二段思考仍在流式追加", streaming: true }])

    expect(screen.getByText("第二段思考仍在流式追加")).toBeTruthy()

    await user.click(screen.getByText("收起思考过程"))
    setMessages([{ ...first, reasoning: "第三段思考仍在流式追加", streaming: true }])
    expect(screen.getByText("展开思考过程")).toBeTruthy()
    expect(screen.queryByText("第三段思考仍在流式追加")).toBeNull()

    setMessages([{ ...first, reasoning: "完整思考过程", streaming: false }])
    expect(screen.getByText("展开思考过程")).toBeTruthy()
    expect(screen.queryByText("完整思考过程")).toBeNull()
    expect(screen.getByText("回复正文")).toBeTruthy()
  })
})
