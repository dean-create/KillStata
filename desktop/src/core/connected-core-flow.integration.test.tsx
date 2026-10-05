import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Event } from "@killstata/sdk/v2/client"
import App from "../App"
import type { CoreSessionClient } from "./client"
import { createCoreEngineAdapter } from "./engine-adapter"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("connected Desktop Core conversation flow", () => {
  test("uses the shared App and workspace adapter for file-backed analysis, collapsed reasoning, question/answer, and result", async () => {
    const user = userEvent.setup()
    const subscribers = new Set<(event: Event) => void>()
    const messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
    const prompts: Array<Record<string, unknown>> = []
    const workspaceFilePickerIDs: string[] = []
    const receivedAnswers: Array<{ requestID: string; answers: string[][] }> = []
    const abortedSessions: string[] = []
    let sessionSequence = 0
    let messageSequence = 0
    const publish = (event: unknown) => {
      for (const listener of [...subscribers]) listener(event as Event)
    }
    const core = {
      subscribe(listener: (event: Event) => void) {
        subscribers.add(listener)
        return () => subscribers.delete(listener)
      },
      whenEventStreamReady: async () => {},
      health: async () => ({ data: { version: "integration-core", healthy: true } }),
      commands: async () => ({ data: [] }),
      createSession: async () => ({ id: `session-${++sessionSequence}` }),
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        const sessionID = String(input.sessionID)
        if (prompts.length > 1) {
          const info = { id: `assistant-${++messageSequence}`, sessionID, role: "assistant", mode: "analyst", summary: false }
          const text = { id: `text-${messageSequence}`, sessionID, messageID: info.id, type: "text", text: "第二轮仍在执行。", synthetic: false, ignored: false }
          messages.push({ info, parts: [text] })
          publish({ type: "message.updated", properties: { info } })
          publish({ type: "message.part.updated", properties: { part: text } })
          return
        }
        const info = { id: `assistant-${++messageSequence}`, sessionID, role: "assistant", mode: "analyst", summary: false }
        const reasoning = { id: `reasoning-${messageSequence}`, sessionID, messageID: info.id, type: "reasoning", text: "先检查核心变量关系" }
        const text = { id: `text-${messageSequence}`, sessionID, messageID: info.id, type: "text", text: "已经整理好分析思路。", synthetic: false, ignored: false }
        messages.push({ info, parts: [reasoning, text] })
        publish({ type: "message.updated", properties: { info } })
        publish({ type: "message.part.updated", properties: { part: reasoning } })
        publish({ type: "message.part.updated", properties: { part: text } })
        publish({
          type: "question.asked",
          properties: {
            id: "question-outcome",
            sessionID,
            questions: [{ header: "选择结果变量", question: "结果变量是哪一列？", options: [{ label: "outcome" }], multiple: false, custom: false }],
          },
        })
      },
      replyQuestion: async (requestID: string, answers: string[][]) => {
        const sessionID = "session-1"
        const info = { id: `assistant-${++messageSequence}`, sessionID, role: "assistant", mode: "analyst", summary: false }
        const text = { id: `text-${messageSequence}`, sessionID, messageID: info.id, type: "text", text: `结果变量 ${answers[0]?.[0]}，回归分析已完成。`, synthetic: false, ignored: false }
        messages.push({ info, parts: [text] })
        publish({ type: "message.updated", properties: { info } })
        publish({ type: "message.part.updated", properties: { part: text } })
        publish({ type: "session.idle", properties: { sessionID } })
        receivedAnswers.push({ requestID, answers })
      },
      loadSession: async () => messages,
      abort: async (sessionID: string) => { abortedSessions.push(sessionID) },
    } as unknown as CoreSessionClient
    const engine = createCoreEngineAdapter(core)
    const credentials = {
      hasApiKey: async () => true,
      prepareEngineForAnalysis: async () => {},
    }
    render(() => <App
      engine={engine}
      credentials={credentials}
      initialUiPreferences={{ reasoningEffort: "high" }}
      mode="connected"
      requireApiKey
      workspacePicker={async () => ({ id: "tauri-workspace-native-7", name: "policy-lab" })}
      workspaceFilePicker={async (workspaceID) => {
        workspaceFilePickerIDs.push(String(workspaceID))
        const contents = "id,outcome\n1,2\n"
        const file = new File([contents], "panel.csv", { type: "text/csv" })
        Object.defineProperty(file, "arrayBuffer", {
          value: async () => new TextEncoder().encode(contents).buffer as ArrayBuffer,
        })
        return file
      }}
    />)
    await waitFor(() => expect(screen.getByRole("status", { name: "分析核心就绪" })).toBeTruthy())
    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    const prompt = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement
    await user.type(prompt, "解释核心变量关系 @")
    await user.click(screen.getByRole("button", { name: "从工作区选择文件" }))
    await waitFor(() => expect(screen.getByRole("status", { name: "已选择数据文件" }).textContent).toContain("panel.csv"))
    expect(workspaceFilePickerIDs).toEqual(["tauri-workspace-native-7"])
    expect(prompt.value).toBe("解释核心变量关系 @panel.csv ")
    await user.click(screen.getByRole("button", { name: "发送" }))

    expect(await screen.findByText("已经整理好分析思路。")).toBeTruthy()
    expect(screen.getByText("展开思考过程")).toBeTruthy()
    expect(screen.queryByText("先检查核心变量关系")).toBeNull()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ text: "解释核心变量关系 @panel.csv", variant: "high" })
    const attachedFile = (prompts[0]?.files as Array<Record<string, unknown>> | undefined)?.[0]
    expect(attachedFile).toMatchObject({ type: "file", mime: "text/csv", filename: "panel.csv" })
    expect(attachedFile?.url).toBe(`data:text/csv;base64,${btoa("id,outcome\n1,2\n")}`)

    await user.click(screen.getByText("展开思考过程"))
    expect(screen.getByText("先检查核心变量关系")).toBeTruthy()
    expect(await screen.findByRole("region", { name: "选择结果变量" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "outcome" }))
    await user.click(screen.getByRole("button", { name: "继续分析" }))
    await waitFor(() => expect(receivedAnswers).toEqual([{ requestID: "question-outcome", answers: [["outcome"]] }]))
    expect(await screen.findByText("结果变量 outcome，回归分析已完成。")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "新对话" }))
    await user.type(screen.getByRole("textbox", { name: "研究问题" }), "检查取消操作")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await screen.findByRole("button", { name: "停止分析" })
    await user.click(screen.getByRole("button", { name: "停止分析" }))
    await waitFor(() => expect(abortedSessions).toEqual(["session-2"]))
    expect(await screen.findByText("已停止分析。", { exact: true })).toBeTruthy()
  })
})
