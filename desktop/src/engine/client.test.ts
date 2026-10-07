import { describe, expect, test, vi } from "vitest"
import type { EngineRunEvent } from "./client"
import { createDemoEngine, HttpEngineClient } from "./client"

describe("HTTP Engine Protocol v1 client", () => {
  test("requests the versioned health endpoint and validates the response", async () => {
    const requests: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(
        JSON.stringify({ protocolVersion: "v1", engineVersion: "0.1.0", status: "ready" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    const client = new HttpEngineClient("http://127.0.0.1:4318/", fetcher)
    await expect(client.health()).resolves.toMatchObject({ status: "ready", engineVersion: "0.1.0" })
    expect(requests).toEqual(["http://127.0.0.1:4318/v1/health"])
  })

  test("uses the explicit v2 path and capability declaration", async () => {
    const requests: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({
        protocolVersion: "v2",
        engineVersion: "2.0.0",
        status: "ready",
        capabilities: { structuredSteps: true, interactive: true },
      }))
    }) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher, undefined, undefined, "v2")

    await expect(client.health()).resolves.toMatchObject({ protocolVersion: "v2", capabilities: { interactive: true } })
    expect(requests).toEqual(["http://127.0.0.1:4318/v2/health"])
  })

  test("sends v2 answers and denials to explicit interaction endpoints", async () => {
    const requests: Array<{ url: string; body?: string }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined })
      return new Response(JSON.stringify({ protocolVersion: "v2", accepted: true }))
    }) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher, undefined, undefined, "v2")

    await client.answerInteraction?.("run-1", "question-1", { selected: ["outcome"] })
    await client.denyInteraction?.("run-1", "permission-1", "研究者拒绝")

    expect(requests).toEqual([
      { url: "http://127.0.0.1:4318/v2/runs/run-1/interactions/question-1/answer", body: JSON.stringify({ selected: ["outcome"] }) },
      { url: "http://127.0.0.1:4318/v2/runs/run-1/interactions/permission-1/deny", body: JSON.stringify({ reason: "研究者拒绝" }) },
    ])
  })
  test("uses authenticated v2 routes for context and shared session controls", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined })
      return new Response(JSON.stringify({ protocolVersion: "v2", context: { budget: 12 } }))
    }) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher, undefined, undefined, "v2")

    await expect(client.context?.("run-1")).resolves.toEqual({ budget: 12 })
    await client.summarize?.("run-1", { providerID: "deepseek", modelID: "deepseek-v4-flash" }, "保留 DID 设定")
    await client.updateTitle?.("run-1", "政策评估")
    await client.revert?.("run-1", "message-1")
    await client.revertLatest?.("run-1")
    await client.unrevert?.("run-1")

    expect(requests).toEqual([
      { url: "http://127.0.0.1:4318/v2/runs/run-1/context", method: "GET", body: undefined },
      { url: "http://127.0.0.1:4318/v2/runs/run-1/summarize", method: "POST", body: JSON.stringify({ model: { providerID: "deepseek", modelID: "deepseek-v4-flash" }, instructions: "保留 DID 设定" }) },
      { url: "http://127.0.0.1:4318/v2/runs/run-1/title", method: "PATCH", body: JSON.stringify({ title: "政策评估" }) },
      { url: "http://127.0.0.1:4318/v2/runs/run-1/revert", method: "POST", body: JSON.stringify({ messageID: "message-1" }) },
      { url: "http://127.0.0.1:4318/v2/runs/run-1/undo", method: "POST", body: undefined },
      { url: "http://127.0.0.1:4318/v2/runs/run-1/redo", method: "POST", body: undefined },
    ])
  })

  test("parses a v2 question event without closing the stream", () => {
    let source: { onmessage: ((message: MessageEvent<string>) => void) | null; onerror: (() => void) | null; close: ReturnType<typeof vi.fn> } | undefined
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetch, undefined, () => {
      source = { onmessage: null, onerror: null, close: vi.fn() }
      return source
    }, "v2")
    const events: EngineRunEvent[] = []
    client.subscribe("run-1", (event) => events.push(event))

    source!.onmessage!(new MessageEvent("message", { data: JSON.stringify({
      protocolVersion: "v2",
      type: "question",
      message: "请选择结果变量",
      interaction: { kind: "question", question: {
        requestId: "question-1",
        title: "选择结果变量",
        prompt: "结果变量是哪一列？",
        mode: "single",
        options: [{ id: "outcome", label: "outcome" }],
        allowSkip: false,
      } },
    }) }))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "question", question: { requestId: "question-1" } })
    expect(source!.close).not.toHaveBeenCalled()
  })
  test("parses late v2 title events without closing the run stream", () => {
    let source: { onmessage: ((message: MessageEvent<string>) => void) | null; onerror: (() => void) | null; close: ReturnType<typeof vi.fn> } | undefined
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetch, undefined, () => {
      source = { onmessage: null, onerror: null, close: vi.fn() }
      return source
    }, "v2")
    const events: EngineRunEvent[] = []
    client.subscribe("run-1", (event) => events.push(event))

    source!.onmessage!(new MessageEvent("message", { data: JSON.stringify({
      protocolVersion: "v2", type: "completed", message: "分析已完成。",
    }) }))
    source!.onmessage!(new MessageEvent("message", { data: JSON.stringify({
      protocolVersion: "v2", type: "title", title: "政策评估研究",
    }) }))

    expect(events).toEqual([
      { type: "completed", message: "分析已完成。" },
      { type: "title", title: "政策评估研究" },
    ])
    expect(source!.close).not.toHaveBeenCalled()
  })
  test("subscribes to a same-origin v2 verification stream and releases it with the listener", () => {
    let source: { onmessage: ((message: MessageEvent<string>) => void) | null; onerror: (() => void) | null; close: ReturnType<typeof vi.fn> } | undefined
    let sourceURL = ""
    const client = new HttpEngineClient("/api", fetch, undefined, (url) => {
      sourceURL = url.href
      source = { onmessage: null, onerror: null, close: vi.fn() }
      return source
    }, "v2")
    const updates: unknown[] = []
    const unsubscribe = client.subscribeVerification((update) => updates.push(update))

    source!.onmessage!(new MessageEvent("message", { data: JSON.stringify({
      protocolVersion: "v2", type: "verification", sessionID: "run-1", messageID: "message-2",
      callID: "tool-1", status: "pass", message: "独立核验通过。",
    }) }))
    unsubscribe()

    expect(sourceURL).toContain("/api/v2/verification/events")
    expect(updates).toEqual([{ sessionID: "run-1", messageID: "message-2", callID: "tool-1", status: "pass", message: "独立核验通过。" }])
    expect(source!.close).toHaveBeenCalledTimes(1)
  })

  test("binds HTTP and SSE requests to the current opaque Web workspace", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = []
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: new URL(String(input)), init })
      return Response.json({
        protocolVersion: "v2", engineVersion: "test", status: "ready",
        capabilities: { structuredSteps: true, interactive: true },
      })
    }
    let eventURL: URL | undefined
    let eventSource: { onmessage: ((message: MessageEvent<string>) => void) | null; onerror: (() => void) | null; close: ReturnType<typeof vi.fn> } | undefined
    const client = new HttpEngineClient("/api", fetcher, undefined, (url) => {
      eventURL = url
      eventSource = { onmessage: null, onerror: null, close: vi.fn() }
      return eventSource
    }, "v2", () => "workspace-opaque-id")

    await client.health()
    client.subscribe("run-1", () => {})

    expect(new Headers(requests[0]?.init?.headers).get("x-killstata-workspace-id")).toBe("workspace-opaque-id")
    expect(eventURL?.searchParams.get("workspaceId")).toBe("workspace-opaque-id")
  })

  test("moves the verification event stream when the active Web workspace changes", () => {
    let workspaceID = "workspace-one"
    const eventSources: Array<{ url: URL; close: ReturnType<typeof vi.fn> }> = []
    const client = new HttpEngineClient("/api", fetch, undefined, (url) => {
      const source = { onmessage: null, onerror: null, close: vi.fn() }
      eventSources.push({ url, close: source.close })
      return source
    }, "v2", () => workspaceID)
    const unsubscribe = client.subscribeVerification(() => {})

    workspaceID = "workspace-two"
    client.refreshWorkspaceContext()

    expect(eventSources[0]?.url.searchParams.get("workspaceId")).toBe("workspace-one")
    expect(eventSources[0]?.close).toHaveBeenCalledOnce()
    expect(eventSources[1]?.url.searchParams.get("workspaceId")).toBe("workspace-two")

    unsubscribe()
    expect(eventSources[1]?.close).toHaveBeenCalledOnce()
  })
  test("does not accept an interaction event through the v1 client", () => {
    let source: { onmessage: ((message: MessageEvent<string>) => void) | null; onerror: (() => void) | null; close: ReturnType<typeof vi.fn> } | undefined
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetch, undefined, () => {
      source = { onmessage: null, onerror: null, close: vi.fn() }
      return source
    })
    const events: EngineRunEvent[] = []
    client.subscribe("run-1", (event) => events.push(event))

    source!.onmessage!(new MessageEvent("message", { data: JSON.stringify({
      protocolVersion: "v1",
      type: "question",
      message: "不应进入 v1 UI",
      interaction: { kind: "question", question: {
        requestId: "question-v1",
        title: "不应出现",
        prompt: "不应出现",
        mode: "single",
        options: [],
        allowSkip: false,
      } },
    }) }))

    expect(events).toEqual([{ type: "progress", message: "引擎返回了无法读取的进度事件，正在继续等待后续状态。" }])
  })
  test("v1 getResult rejects waiting interactions instead of silently accepting them", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      protocolVersion: "v1",
      runId: "run-1",
      status: "waiting",
      document: null,
      interaction: { kind: "question", question: {
        requestId: "q-1", title: "不应出现", prompt: "不应出现", mode: "single", options: [], allowSkip: false,
      } },
    }))) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher)

    await expect(client.getResult("run-1")).rejects.toThrow("分析结果响应无效")
  })
  test("calls an unbound browser fetch function without changing its receiver", async () => {
    const fetcher = vi.fn(async function (this: unknown) {
      if (this !== undefined) throw new Error("fetch receiver changed")
      return new Response(JSON.stringify({ protocolVersion: "v1", engineVersion: "0.1.0", status: "ready" }))
    }) as unknown as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher)

    await expect(client.health()).resolves.toMatchObject({ status: "ready" })
  })

  test("does not silently accept an unsupported health response", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ protocolVersion: "v3", engineVersion: "0.1.0", status: "ready" }))) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher)

    await expect(client.health()).rejects.toThrow("不兼容的引擎协议")
  })

  test("uploads a selected dataset without putting a local path in the run request", async () => {
    let request: RequestInit | undefined
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = init
      return new Response(JSON.stringify({ protocolVersion: "v1", id: "dataset-1", name: "employment.csv", format: "CSV", bytes: 4 }))
    }) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher)

    await expect(client.uploadDataset(new File(["id,y"], "employment.csv", { type: "text/csv" }))).resolves.toEqual({
      id: "dataset-1",
      name: "employment.csv",
      format: "CSV",
      bytes: 4,
    })
    expect(request?.method).toBe("POST")
    expect(request?.body).toBeInstanceOf(FormData)
  })

  test("preserves an explicitly selected engine command in the run request", async () => {
    let request: RequestInit | undefined
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = init
      return new Response(JSON.stringify({ protocolVersion: "v1", runId: "run-command" }))
    }) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher)

    await client.startRun({
      prompt: "/describe 变量情况",
      dataset: { id: "dataset-1", name: "policy.csv", format: "CSV", bytes: 12 },
      command: { name: "describe", arguments: "变量情况" },
    })

    expect(JSON.parse(String(request?.body))).toMatchObject({
      command: { name: "describe", arguments: "变量情况" },
    })
  })

  test("rejects an unversioned dataset response", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ id: "dataset-1", name: "employment.csv", format: "CSV", bytes: 4 }))) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher)

    await expect(client.uploadDataset(new File(["id,y"], "employment.csv"))).rejects.toThrow("不兼容的引擎协议")
  })

  test("rejects a cancel response that omits the protocol version", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ cancelled: true }))) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher)

    await expect(client.cancelRun("run-1")).rejects.toThrow("不兼容的引擎协议")
  })

  test("rejects a cancel response that does not explicitly confirm cancellation", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ protocolVersion: "v1", cancelled: false }))) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher)

    await expect(client.cancelRun("run-1")).rejects.toThrow("取消确认响应无效")
  })

  test("rejects non-loopback engine addresses before any data can be uploaded", () => {
    expect(() => new HttpEngineClient("https://example.com")).toThrow("本地回环地址")
    expect(() => new HttpEngineClient("http://0.0.0.0:4318")).toThrow("本地回环地址")
    expect(() => new HttpEngineClient("http://localhost:4318")).not.toThrow()
    expect(() => new HttpEngineClient("http://[::1]:4318")).not.toThrow()
  })

  test("accepts a same-origin Web API path and sends same-origin login cookies", async () => {
    vi.stubGlobal("location", { origin: "https://research.example" })
    const requests: Array<{ url: string; credentials?: RequestCredentials }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), credentials: init?.credentials })
      return new Response(JSON.stringify({ protocolVersion: "v1", engineVersion: "web", status: "ready" }))
    }) as typeof fetch

    try {
      const client = new HttpEngineClient("/api/", fetcher)
      await client.health()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(requests).toEqual([{ url: "https://research.example/api/v1/health", credentials: "same-origin" }])
  })

  test("closes a terminal event stream and ignores the close error instead of rewriting success as failure", () => {
    let source: {
      onmessage: ((message: MessageEvent<string>) => void) | null
      onerror: (() => void) | null
      close: ReturnType<typeof vi.fn>
    } | undefined
    const events: string[] = []
    const client = new HttpEngineClient(
      "http://127.0.0.1:4318",
      fetch,
      "local-token",
      () => {
        source = { onmessage: null, onerror: null, close: vi.fn() }
        return source
      },
    )

    client.subscribe("run-1", (event) => events.push(event.type))
    source!.onmessage!(new MessageEvent("message", { data: JSON.stringify({ protocolVersion: "v1", type: "completed", message: "完成" }) }))
    source!.onerror!()

    expect(events).toEqual(["completed"])
    expect(source!.close).toHaveBeenCalledOnce()
  })

  test("preserves an optional structured progress step from v1 SSE", () => {
    let source: {
      onmessage: ((message: MessageEvent<string>) => void) | null
      onerror: (() => void) | null
      close: ReturnType<typeof vi.fn>
    } | undefined
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetch, undefined, () => {
      source = { onmessage: null, onerror: null, close: vi.fn() }
      return source
    })
    const events: Array<unknown> = []
    client.subscribe("run-1", (event) => events.push(event))

    source!.onmessage!(new MessageEvent("message", {
      data: JSON.stringify({
        protocolVersion: "v1",
        type: "progress",
        message: "正在估计 OLS 回归…",
        step: { id: "ols_regression", label: "估计 OLS 回归", phase: "analysis", status: "running" },
      }),
    }))

    expect(events).toEqual([{
      type: "progress",
      message: "正在估计 OLS 回归…",
      step: { id: "ols_regression", label: "估计 OLS 回归", phase: "analysis", status: "running" },
    }])
  })

  test("rejects malformed structured progress steps", () => {
    let source: {
      onmessage: ((message: MessageEvent<string>) => void) | null
      onerror: (() => void) | null
      close: ReturnType<typeof vi.fn>
    } | undefined
    const messages: string[] = []
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetch, undefined, () => {
      source = { onmessage: null, onerror: null, close: vi.fn() }
      return source
    })

    client.subscribe("run-1", (event) => { if ("message" in event) messages.push(event.message) })
    source!.onmessage!(new MessageEvent("message", { data: JSON.stringify({
      protocolVersion: "v1",
      type: "progress",
      message: "正在执行分析步骤…",
      step: { id: "step", label: "步骤", phase: "analysis", status: "unknown" },
    }) }))

    expect(messages).toEqual(["引擎返回了无法读取的进度事件，正在继续等待后续状态。"])
  })

  test("finishes the local demo so users can preview a complete result", async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const unsubscribe = createDemoEngine().subscribe("demo-run", (event) => events.push(event.type))

      await vi.advanceTimersByTimeAsync(1000)

      expect(events).toEqual(["progress", "reasoning_delta", "reasoning_delta", "assistant_delta", "assistant_delta", "completed"])
      expect(events.at(-1)).toBe("completed")
      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  test("surfaces the stable engine message from a v1 error envelope", async () => {
    const fetcher = (async () => new Response(
      JSON.stringify({ protocolVersion: "v1", code: "dataset_too_large", message: "数据文件超过本地会话大小上限", retryable: false }),
      { status: 413, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher)

    await expect(client.uploadDataset(new File(["1234567890"], "large.csv"))).rejects.toThrow("数据文件超过本地会话大小上限")
  })

  test("sends the local engine token on authenticated requests", async () => {
    const requests: Array<{ init?: RequestInit; url: string }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ init, url: String(input) })
      return new Response(JSON.stringify({ protocolVersion: "v1", id: "dataset-token", name: "employment.csv", format: "CSV", bytes: 4 }))
    }) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher, "local-token")

    await client.uploadDataset(new File(["id,y"], "employment.csv", { type: "text/csv" }))

    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer local-token")
  })

  test("rejects a result that belongs to a different run", async () => {
    const fetcher = (async () => new Response(
      JSON.stringify({ protocolVersion: "v1", runId: "run-other", status: "completed", document: "x" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher)

    await expect(client.getResult("run-mine")).rejects.toThrow("分析结果与当前任务不匹配")
  })

  test("confirms the final state after the event stream drops instead of failing immediately", async () => {
    let source: {
      onmessage: ((message: MessageEvent<string>) => void) | null
      onerror: (() => void) | null
      close: ReturnType<typeof vi.fn>
    } | undefined
    const fetcher = (async () => new Response(
      JSON.stringify({ protocolVersion: "v1", runId: "run-1", status: "completed", document: "结果" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch
    const events: string[] = []
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher, undefined, () => {
      source = { onmessage: null, onerror: null, close: vi.fn() }
      return source
    })

    client.subscribe("run-1", (event) => events.push(event.type))
    source!.onerror!()

    await vi.waitFor(() => expect(events).toContain("completed"))
    expect(events[0]).toBe("progress")
    expect(events).toEqual(["progress", "completed"])
  })

  test("断流后先发现任务仍在运行，再确认完成时不产生失败事件", async () => {
    vi.useFakeTimers()
    try {
      let source: {
        onmessage: ((message: MessageEvent<string>) => void) | null
        onerror: (() => void) | null
        close: ReturnType<typeof vi.fn>
      } | undefined
      const results = [
        { protocolVersion: "v1", runId: "run-1", status: "running", document: null },
        { protocolVersion: "v1", runId: "run-1", status: "completed", document: "结果" },
      ]
      const fetcher = vi.fn(async () => new Response(JSON.stringify(results.shift()), { status: 200 })) as unknown as typeof fetch
      const events: EngineRunEvent[] = []
      const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher, undefined, () => {
        source = { onmessage: null, onerror: null, close: vi.fn() }
        return source
      })

      client.subscribe("run-1", (event) => events.push(event))
      source!.onerror!()
      await vi.advanceTimersByTimeAsync(0)
      expect(events.map((event) => event.type)).toEqual(["progress"])

      await vi.advanceTimersByTimeAsync(5_000)

      expect(events.map((event) => event.type)).toEqual(["progress", "completed"])
      expect(events.some((event) => event.type === "failed")).toBe(false)
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test("连续畸形事件达到上限时转入状态恢复，不把任务静默留在运行中", async () => {
    let source: {
      onmessage: ((message: MessageEvent<string>) => void) | null
      onerror: (() => void) | null
      close: ReturnType<typeof vi.fn>
    } | undefined
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      protocolVersion: "v1",
      runId: "run-1",
      status: "completed",
      document: "结果",
    }), { status: 200 })) as unknown as typeof fetch
    const events: EngineRunEvent[] = []
    const client = new HttpEngineClient("http://127.0.0.1:4318", fetcher, undefined, () => {
      source = { onmessage: null, onerror: null, close: vi.fn() }
      return source
    })

    client.subscribe("run-1", (event) => events.push(event))
    for (let index = 0; index < 20; index += 1) {
      source!.onmessage!(new MessageEvent("message", { data: "不是合法 JSON" }))
    }

    await vi.waitFor(() => expect(events).toContainEqual({ type: "completed", message: "分析已完成。" }))
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
