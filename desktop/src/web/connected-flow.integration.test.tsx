import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"
import App from "../App"
import { HttpEngineClient } from "../engine/client"

type CapturedRequest = { url: URL; method: string; headers: Headers; body?: BodyInit | null }
type FakeEventSource = {
  url: URL
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: (() => void) | null
  close: ReturnType<typeof vi.fn>
}

function sendEvent(source: FakeEventSource | undefined, event: Record<string, unknown>) {
  if (!source?.onmessage) throw new Error("Run EventSource is not attached")
  source.onmessage(new MessageEvent("message", { data: JSON.stringify({ protocolVersion: "v2", ...event }) }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("connected Web conversation flow", () => {
  test("uploads data, streams collapsed reasoning, answers a question, exports the result, and cancels the next run", async () => {
    const user = userEvent.setup()
    const requests: CapturedRequest[] = []
    const sources: FakeEventSource[] = []
    const startedRuns: Array<{ runId: string; body: Record<string, unknown> }> = []
    const answers: Array<{ runId: string; requestId: string; body: unknown }> = []
    const cancellations: string[] = []
    let workspaceID = "__unassigned__"
    let runNumber = 0
    let downloadedFilename: string | undefined

    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input), "http://localhost")
      const method = init?.method ?? "GET"
      requests.push({ url, method, headers: new Headers(init?.headers), body: init?.body })

      if (url.pathname === "/api/v2/health") return Response.json({
        protocolVersion: "v2", engineVersion: "integration-core", status: "ready",
        capabilities: { structuredSteps: true, interactive: true },
      })
      if (url.pathname === "/api/v2/commands") return Response.json({ protocolVersion: "v2", commands: [] })
      if (url.pathname === "/api/v2/datasets" && method === "POST") {
        const form = init?.body as FormData
        const file = form.get("file") as File
        return Response.json({ protocolVersion: "v2", id: "dataset-web-1", name: file.name, format: "CSV", bytes: file.size })
      }
      if (url.pathname === "/api/v2/runs" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        const runId = `run-${++runNumber}`
        startedRuns.push({ runId, body })
        return Response.json({ protocolVersion: "v2", runId })
      }
      const answerMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/interactions\/([^/]+)\/answer$/)
      if (answerMatch && method === "POST") {
        answers.push({ runId: answerMatch[1], requestId: answerMatch[2], body: JSON.parse(String(init?.body)) })
        return Response.json({ protocolVersion: "v2" })
      }
      const cancelMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/cancel$/)
      if (cancelMatch && method === "POST") {
        cancellations.push(cancelMatch[1])
        return Response.json({ protocolVersion: "v2", cancelled: true })
      }
      const resultMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/result$/)
      if (resultMatch && method === "GET") return Response.json({
        protocolVersion: "v2", runId: resultMatch[1], status: "completed",
        document: "## 回归结果\n\n| 变量 | 系数 |\n|---|---:|\n| outcome | 1.25 |",
      })
      return Response.json({ protocolVersion: "v2", code: "not_found", message: `Unhandled integration route: ${url.pathname}` }, { status: 404 })
    }

    const engine = new HttpEngineClient("/api", fetcher, undefined, (url) => {
      const source: FakeEventSource = { url, onmessage: null, onerror: null, close: vi.fn() }
      sources.push(source)
      return source
    }, "v2", () => workspaceID)
    const createObjectURL = vi.fn(() => "blob:connected-result")
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFilename = this.download
    })

    render(() => <App
      engine={engine}
      mode="connected"
      credentials={{ hasApiKey: async () => true }}
      workspacePicker={async () => ({ id: "workspace-web-e2e", name: "e2e-study" })}
      workspaceContextChanged={(id) => { workspaceID = id }}
    />)

    await waitFor(() => expect(screen.getByRole("status", { name: "分析核心就绪" })).toBeTruthy())
    await user.click(screen.getByRole("button", { name: "选择本地工作区" }))
    fireEvent.change(screen.getByLabelText("数据文件选择器"), {
      target: { files: [new File(["id,outcome\n1,2\n"], "panel.csv", { type: "text/csv" })] },
    })
    const composer = screen.getByRole("textbox", { name: "研究问题" })
    await user.type(composer, "估计处理效应")
    await user.click(screen.getByRole("button", { name: "发送" }))

    await waitFor(() => expect(startedRuns).toHaveLength(1))
    await waitFor(() => expect(sources.some((source) => source.url.pathname.endsWith("/runs/run-1/events"))).toBe(true))
    const firstRun = sources.find((source) => source.url.pathname.endsWith("/runs/run-1/events"))
    expect(firstRun?.url.searchParams.get("workspaceId")).toBe("workspace-web-e2e")
    expect(firstRun?.onmessage).toBeTypeOf("function")
    await screen.findByRole("button", { name: "停止分析" })
    expect(new Headers(requests.find((request) => request.url.pathname.endsWith("/datasets"))?.headers).get("x-killstata-workspace-id"))
      .toBe("workspace-web-e2e")
    expect(startedRuns[0]?.body).toMatchObject({ prompt: "估计处理效应", dataset: { id: "dataset-web-1", name: "panel.csv" } })

    sendEvent(firstRun, { type: "reasoning_delta", text: "先检查数据结构" })
    sendEvent(firstRun, { type: "assistant_delta", text: "先核对数据结构，再完成估计。" })
    await waitFor(() => expect(screen.getByRole("log", { name: "分析对话" }).textContent).toContain("先核对数据结构，再完成估计。"))
    expect(screen.getByText("展开思考过程")).toBeTruthy()
    expect(screen.getByText("先核对数据结构，再完成估计。")).toBeTruthy()
    expect(screen.queryByText("先检查数据结构")).toBeNull()
    await user.click(screen.getByText("展开思考过程"))
    expect(screen.getByText("先检查数据结构")).toBeTruthy()
    await user.click(screen.getByText("收起思考过程"))
    expect(screen.queryByText("先检查数据结构")).toBeNull()

    sendEvent(firstRun, {
      type: "question",
      message: "分析等待你的回答。",
      interaction: {
        kind: "question",
        question: {
          requestId: "question-variable",
          title: "选择结果变量",
          prompt: "结果变量是哪一列？",
          mode: "single",
          options: [{ id: "outcome", label: "outcome" }],
          allowSkip: false,
        },
      },
    })
    expect(await screen.findByRole("region", { name: "选择结果变量" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "outcome" }))
    await user.click(screen.getByRole("button", { name: "继续分析" }))
    await waitFor(() => expect(answers).toEqual([{ runId: "run-1", requestId: "question-variable", body: { selected: ["outcome"] } }]))

    sendEvent(firstRun, { type: "assistant_delta", text: "## 回归结果\n\n| 变量 | 系数 |\n|---|---:|\n| outcome | 1.25 |" })
    sendEvent(firstRun, { type: "completed", message: "分析已完成。" })
    expect(await screen.findByRole("heading", { name: "回归结果" })).toBeTruthy()
    expect(screen.getByRole("cell", { name: "1.25" })).toBeTruthy()
    await user.type(screen.getByRole("textbox", { name: "研究问题" }), "/export")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => expect(downloadedFilename).toBe("killstata-analysis-result.md"))
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledOnce()

    await user.click(screen.getByRole("button", { name: "新对话" }))
    await user.type(screen.getByRole("textbox", { name: "研究问题" }), "检查取消操作")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => expect(startedRuns).toHaveLength(2))
    const secondRun = sources.find((source) => source.url.pathname.endsWith("/runs/run-2/events"))
    sendEvent(secondRun, { type: "progress", message: "分析仍在运行。" })
    await user.click(await screen.findByRole("button", { name: "停止分析" }))
    await waitFor(() => expect(cancellations).toEqual(["run-2"]))
    expect(requests.find((request) => request.url.pathname.endsWith("/runs/run-2/cancel"))?.method).toBe("POST")
    const workspaceRequests = requests.filter((request) => request.url.pathname.endsWith("/datasets") || request.url.pathname.endsWith("/runs"))
    expect(workspaceRequests.every((request) => request.headers.get("x-killstata-workspace-id") === "workspace-web-e2e")).toBe(true)
  })
})
