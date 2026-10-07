import { describe, expect, test, vi } from "vitest"
import { CoreSessionClient, corePromptPayload } from "./client"

describe("Core prompt payload", () => {
  test("keeps the researcher's text clean while passing the selected worksheet structurally", () => {
    const payload = corePromptPayload({
      text: "跑 OLS 回归",
      worksheetName: "Data_可读",
    })

    expect(payload.parts).toEqual([{ type: "text", text: "跑 OLS 回归" }])
    expect(payload.queueMetadata).toEqual({ desktopWorksheetName: "Data_可读" })
  })

  test("routes runtime inspection and confirmed runtime installation through the authenticated Core client", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = []
    const report = {
      python: { label: "Python 3.12.13", status: "ready", detail: "managed", suggestion: "" },
      packages: [{ label: "pydantic", status: "ready", detail: "已安装。", suggestion: "" }],
    }
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined
      const body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : undefined
      requests.push({ url: request?.url ?? String(input), method: init?.method ?? request?.method ?? "GET", body })
      return Response.json(report)
    }) as typeof fetch
    const client = new CoreSessionClient({ fetch: fetcher })

    await expect(client.runtimeDiagnostics()).resolves.toEqual(report)
    await expect(client.installRuntimePackages()).resolves.toEqual(report)

    expect(requests).toEqual([
      { url: "http://killstata.core/runtime", method: "GET", body: undefined },
      { url: "http://killstata.core/runtime/install", method: "POST", body: undefined },
    ])
  })

  test("exposes real session operations for Desktop slash commands", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined
      const body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : undefined
      requests.push({ url: request?.url ?? String(input), method: init?.method ?? request?.method ?? "GET", body })
      return new Response(JSON.stringify({ id: "ses_test", title: "新标题" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    const client = new CoreSessionClient({ fetch: fetcher })

    await client.summarize("ses_test", { providerID: "deepseek", modelID: "deepseek-v4-flash" })
    await client.updateTitle("ses_test", "新标题")
    await client.revert("ses_test", "msg_1")
    await client.unrevert("ses_test")
    await client.context("ses_test")
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST http://killstata.core/session/ses_test/summarize",
      "PATCH http://killstata.core/session/ses_test",
      "POST http://killstata.core/session/ses_test/revert",
      "POST http://killstata.core/session/ses_test/unrevert",
      "GET http://killstata.core/session/ses_test/context",
    ])
  })

  test("sends Core commands through the command endpoint instead of prompt", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined
      const body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : undefined
      requests.push({ url: request?.url ?? String(input), method: init?.method ?? request?.method ?? "GET", body })
      return new Response(JSON.stringify({ info: { id: "msg_1" }, parts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    const client = new CoreSessionClient({ fetch: fetcher })

    await client.command({
      sessionID: "ses_test", command: "doctor", arguments: "",
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    })

    expect(requests).toEqual([{
      url: "http://killstata.core/session/ses_test/command",
      method: "POST",
      body: JSON.stringify({ command: "doctor", arguments: "", model: "deepseek/deepseek-v4-flash" }),
    }])
  })

  test("sends the selected model with a Core prompt", async () => {
    let body: string | undefined
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined
      body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : undefined
      return new Response(null, { status: 204 })
    }) as typeof fetch
    const client = new CoreSessionClient({ fetch: fetcher })

    await client.prompt({
      sessionID: "ses_test",
      text: "继续分析",
      model: { providerID: "custom", modelID: "agnes-2.5-flash" },
    })

    expect(JSON.parse(body ?? "{}")).toMatchObject({
      model: { providerID: "custom", modelID: "agnes-2.5-flash" },
      parts: [{ type: "text", text: "继续分析" }],
    })
  })

  test("undo and redo advance the Core revert cursor one user message at a time", async () => {
    const client = new CoreSessionClient({ fetch: fetch as typeof fetch })
    const messages = ["msg_1", "msg_3", "msg_5"].map((id) => ({
      info: { id, role: "user" },
      parts: [{ type: "text", text: "研究问题" }],
    })) as unknown as Awaited<ReturnType<typeof client.loadSession>>
    vi.spyOn(client, "loadSessionInfo").mockResolvedValue({ id: "ses_test", revert: { messageID: "msg_3" } } as never)
    vi.spyOn(client, "loadAllSessionMessages").mockResolvedValue(messages)
    const revert = vi.spyOn(client, "revert").mockResolvedValue({ id: "ses_test" } as never)
    const unrevert = vi.spyOn(client, "unrevert").mockResolvedValue({ id: "ses_test" } as never)

    await client.revertLatest("ses_test")
    expect(revert).toHaveBeenCalledWith("ses_test", "msg_1")

    vi.spyOn(client, "loadSessionInfo").mockResolvedValue({ id: "ses_test", revert: { messageID: "msg_1" } } as never)
    await client.redo("ses_test")
    expect(revert).toHaveBeenLastCalledWith("ses_test", "msg_3")
    expect(unrevert).not.toHaveBeenCalled()

    vi.spyOn(client, "loadSessionInfo").mockResolvedValue({ id: "ses_test", revert: { messageID: "msg_5" } } as never)
    await client.redo("ses_test")
    expect(unrevert).toHaveBeenCalledWith("ses_test")
  })

  test("undo and redo search past the latest 100 messages for the adjacent Core user message", async () => {
    const client = new CoreSessionClient({ fetch: fetch as typeof fetch })
    const messages = Array.from({ length: 150 }, (_, index) => ({
      info: { id: `msg_${String(index + 1).padStart(3, "0")}`, role: "user" },
      parts: [{ type: "text", text: "研究问题" }],
    })) as unknown as Awaited<ReturnType<typeof client.loadAllSessionMessages>>
    vi.spyOn(client, "loadAllSessionMessages").mockResolvedValue(messages)
    vi.spyOn(client, "loadSessionInfo").mockResolvedValue({ id: "ses_test", revert: { messageID: "msg_050" } } as never)
    const revert = vi.spyOn(client, "revert").mockResolvedValue({ id: "ses_test" } as never)
    vi.spyOn(client, "unrevert").mockResolvedValue({ id: "ses_test" } as never)

    await client.revertLatest("ses_test")
    expect(revert).toHaveBeenCalledWith("ses_test", "msg_049")

    vi.spyOn(client, "loadSessionInfo").mockResolvedValue({ id: "ses_test", revert: { messageID: "msg_001" } } as never)
    await client.redo("ses_test")
    expect(revert).toHaveBeenLastCalledWith("ses_test", "msg_002")
  })

  test("undo and redo skip internal compaction messages that are absent from the Desktop thread", async () => {
    const client = new CoreSessionClient({ fetch: fetch as typeof fetch })
    const messages = [
      { info: { id: "msg_01", role: "user" }, parts: [{ type: "text", text: "前一条可见问题" }] },
      { info: { id: "msg_02", role: "assistant" }, parts: [{ type: "text", text: "前一条回答" }] },
      { info: { id: "msg_03", role: "user" }, parts: [{ type: "compaction", auto: false }] },
      { info: { id: "msg_04", role: "assistant" }, parts: [{ type: "text", text: "压缩摘要" }] },
    ] as unknown as Awaited<ReturnType<typeof client.loadAllSessionMessages>>
    vi.spyOn(client, "loadSessionInfo").mockResolvedValue({ id: "ses_test" } as never)
    vi.spyOn(client, "loadAllSessionMessages").mockResolvedValue(messages)
    const revert = vi.spyOn(client, "revert").mockResolvedValue({ id: "ses_test" } as never)
    const unrevert = vi.spyOn(client, "unrevert").mockResolvedValue({ id: "ses_test" } as never)

    await client.revertLatest("ses_test")
    expect(revert).toHaveBeenCalledWith("ses_test", "msg_01")

    vi.spyOn(client, "loadSessionInfo").mockResolvedValue({ id: "ses_test", revert: { messageID: "msg_01" } } as never)
    await client.redo("ses_test")
    expect(unrevert).toHaveBeenCalledWith("ses_test")
    expect(revert).toHaveBeenCalledTimes(1)
  })

  test("textResult excludes assistant compaction summaries", async () => {
    const client = new CoreSessionClient({ fetch: fetch as typeof fetch })
    vi.spyOn(client, "loadSession").mockResolvedValue([
      {
        info: { id: "msg_answer", role: "assistant", mode: "analyst", summary: false },
        parts: [{ type: "text", text: "用户可见的结果" }],
      },
      {
        info: { id: "msg_summary", role: "assistant", mode: "compaction", summary: true },
        parts: [{ type: "text", text: "<summary>内部恢复摘要</summary>" }],
      },
    ] as never)

    await expect(client.textResult("ses_text_result")).resolves.toBe("用户可见的结果")
  })
})
