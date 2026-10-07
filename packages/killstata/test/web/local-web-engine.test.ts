import { afterEach, describe, expect, test, vi } from "bun:test"
import type { CoreApplication } from "../../src/core/application"
import { GlobalBus } from "../../src/bus/global"
import type { LocalWebCore } from "../../src/web/local-web-engine"
import { createLocalWebEngineApi, createLocalWebEngineApiFromCore } from "../../src/web/local-web-engine"

function fakeCore(options: {
  onPrompt?: (emit: (event: unknown) => void) => void
  onAbort?: (sessionID: string) => Promise<void>
  onQuestionReply?: (requestID: string, answers: string[][]) => Promise<void>
  onLoadSession?: () => Promise<Awaited<ReturnType<LocalWebCore["loadSession"]>>>
  sessionExists?: (sessionID: string) => Promise<boolean>
  sessionStatus?: (sessionID: string) => Promise<{ type: string }>
  pendingQuestion?: (sessionID: string) => Promise<unknown | undefined>
  pendingPermission?: (sessionID: string) => Promise<unknown | undefined>
  onCreateSession?: (index: number) => Promise<string>
} = {}): LocalWebCore & {
  emit(event: unknown, directory?: string): void
  calls: { created: unknown[]; prompts: unknown[]; commands: unknown[]; sessionOps: unknown[]; aborted: string[]; questionReplies: unknown[]; permissionReplies: unknown[] }
} {
  const handlers = new Set<(event: unknown) => void>()
  const calls = { created: [] as unknown[], prompts: [] as unknown[], commands: [] as unknown[], sessionOps: [] as unknown[], aborted: [] as string[], questionReplies: [] as unknown[], permissionReplies: [] as unknown[] }
  let sessionSequence = 0
  return {
    directory: "/test/project",
    health: async () => ({ version: "test-core", healthy: true }),
    commands: async () => [],
    subscribeEvents(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    emit(event, directory = "/test/project") {
      for (const handler of handlers) handler({ directory, payload: event })
    },
    async createSession(input) {
      calls.created.push(input)
      sessionSequence += 1
      return options.onCreateSession ? options.onCreateSession(sessionSequence) : "session-1"
    },
    async prompt(input) {
      calls.prompts.push(input)
      const emit = (event: unknown) => this.emit(event)
      if (options.onPrompt) options.onPrompt(emit)
      else {
        emit({
          type: "message.part.updated",
          properties: {
            sessionID: "session-1",
            part: { type: "text", messageID: "message-1", text: "正文已到达", synthetic: false, ignored: false },
          },
        })
        emit({ type: "session.idle", properties: { sessionID: "session-1" } })
      }
    },
    async command(input) { calls.commands.push(input) },
    async abort(sessionID) { calls.aborted.push(sessionID); await options.onAbort?.(sessionID) },
    async loadSession() { return options.onLoadSession ? options.onLoadSession() : [] },
    async sessionExists(sessionID) { return options.sessionExists ? options.sessionExists(sessionID) : sessionID === "session-1" },
    async sessionStatus(sessionID) { return options.sessionStatus ? options.sessionStatus(sessionID) : { type: "idle" } },
    async pendingQuestion(sessionID) { return options.pendingQuestion?.(sessionID) },
    async pendingPermission(sessionID) { return options.pendingPermission?.(sessionID) },
    async context(sessionID) { calls.sessionOps.push({ operation: "context", sessionID }); return { budget: 12 } },
    async summarize(sessionID, model, instructions) { calls.sessionOps.push({ operation: "summarize", sessionID, model, instructions }) },
    async updateTitle(sessionID, title) { calls.sessionOps.push({ operation: "title", sessionID, title }) },
    async revert(sessionID, messageID) { calls.sessionOps.push({ operation: "revert", sessionID, messageID }) },
    async revertLatest(sessionID) { calls.sessionOps.push({ operation: "undo", sessionID }) },
    async unrevert(sessionID) { calls.sessionOps.push({ operation: "redo", sessionID }) },
    async replyPermission(requestID, reply) { calls.permissionReplies.push({ requestID, reply }) },
    async replyQuestion(requestID, answers) { calls.questionReplies.push({ requestID, answers }); await options.onQuestionReply?.(requestID, answers) },
    async rejectQuestion() {},
    calls,
  }
}

describe("local Web Engine Protocol run API", () => {
  const apis: Array<ReturnType<typeof createLocalWebEngineApi>> = []
  afterEach(() => {
    for (const api of apis.splice(0)) api.dispose()
  })

  test("submits a prompt to Core and replays events produced before the browser opens SSE", async () => {
    const core = fakeCore()
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const start = await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "解释处理效应",
        model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        effort: "high",
      }),
    }))

    expect(start.status).toBe(200)
    expect(await start.json()).toEqual({ protocolVersion: "v2", runId: "session-1" })
    expect(core.calls.created).toEqual([{ title: "解释处理效应", permission: undefined }])
    expect(core.calls.prompts).toEqual([{
      sessionID: "session-1",
      text: "解释处理效应",
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
      variant: "high",
      worksheetName: undefined,
      files: undefined,
    }])

    const stream = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    const reader = stream.body!.getReader()
    const chunks: string[] = []
    while (!chunks.join("").includes('"type":"completed"')) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    await reader.cancel()
    const events = chunks.join("")
    expect(events).toContain('"type":"assistant_delta","text":"正文已到达"')
    expect(events).toContain('"type":"completed"')
  })

  test("hides internal compaction summaries from live Web events and restored run results", async () => {
    let loadedMessages: Awaited<ReturnType<LocalWebCore["loadSession"]>> = [
      { info: { id: "message-00", sessionID: "session-1", role: "user" }, parts: [] },
    ] as never
    const core = fakeCore({
      onPrompt(emit) {
        emit({
          type: "message.updated",
          properties: { info: { id: "message-summary", sessionID: "session-1", role: "assistant", mode: "compaction", summary: true } },
        })
        emit({
          type: "message.part.updated",
          properties: {
            sessionID: "session-1",
            part: {
              type: "text", messageID: "message-summary", text: "<summary>datasetId=private</summary>", synthetic: false, ignored: false,
            },
          },
        })
        emit({
          type: "message.part.updated",
          properties: {
            sessionID: "session-1",
            part: {
              type: "reasoning", messageID: "message-summary", text: "内部压缩草稿：用户要求先检查参数。",
            },
          },
        })
        emit({
          type: "message.part.updated",
          properties: {
            sessionID: "session-1",
            part: { type: "text", messageID: "message-answer", text: "可见的分析结果", synthetic: false, ignored: false },
          },
        })
        emit({ type: "session.idle", properties: { sessionID: "session-1" } })
        loadedMessages = [
          { info: { id: "message-00", sessionID: "session-1", role: "user" }, parts: [] },
          {
            info: { id: "message-01", sessionID: "session-1", role: "assistant", mode: "analyst", summary: false },
            parts: [{ type: "text", messageID: "message-01", text: "可见的分析结果", synthetic: false, ignored: false }],
          },
          {
            info: { id: "message-02", sessionID: "session-1", role: "assistant", mode: "compaction", summary: true },
            parts: [{ type: "text", messageID: "message-02", text: "<summary>datasetId=private</summary>", synthetic: false, ignored: false }],
          },
        ] as never
      },
      onLoadSession: async () => loadedMessages,
    })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "继续", model: { providerID: "deepseek", modelID: "deepseek-v4-flash" } }),
    }))

    const eventsResponse = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    const reader = eventsResponse.body!.getReader()
    const chunks: string[] = []
    while (!chunks.join("").includes('"type":"completed"')) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    await reader.cancel()
    const stream = chunks.join("")
    expect(stream).not.toContain("内部恢复摘要")
    expect(stream).toContain("可见的分析结果")

    const resultResponse = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/result"))
    expect(await resultResponse.json()).toMatchObject({ document: "可见的分析结果" })
  })

  test("routes credential settings requests through the injected local profile store", async () => {
    const core = fakeCore()
    const credentialHandler = vi.fn(async (request: Request) => request.url.endsWith("/profiles")
      ? Response.json({ profiles: [], defaultProfileId: null })
      : undefined)
    const api = createLocalWebEngineApi(core, credentialHandler)
    apis.push(api)

    const response = await api(new Request("http://127.0.0.1/api/v2/credentials/profiles"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ profiles: [], defaultProfileId: null })
    expect(credentialHandler).toHaveBeenCalledTimes(1)
  })

  test("reports busy runs and attached event streams before a workspace Core can be evicted", async () => {
    const idleApi = createLocalWebEngineApi(fakeCore())
    const busyApi = createLocalWebEngineApi(fakeCore({ onPrompt() {} }))
    apis.push(idleApi, busyApi)

    expect(idleApi.isIdle()).toBe(true)
    await busyApi(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "等待中的分析" }),
    }))
    expect(busyApi.isIdle()).toBe(false)

    const eventStream = await idleApi(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    expect(eventStream.status).toBe(200)
    expect(idleApi.isIdle()).toBe(false)
    await eventStream.body?.cancel()
    expect(idleApi.isIdle()).toBe(true)
  })

  test("routes runtime inspection and confirmed installation through a fixed local adapter", async () => {
    const core = fakeCore()
    const runtimeHandler = vi.fn(async (request: Request) => request.url.endsWith("/runtime")
      ? Response.json({ python: { status: "ready" }, packages: [] })
      : Response.json({ python: { status: "ready" }, packages: [] }))
    const api = createLocalWebEngineApi(core, undefined, runtimeHandler)
    apis.push(api)

    const inspection = await api(new Request("http://127.0.0.1/api/v2/runtime"))
    const install = await api(new Request("http://127.0.0.1/api/v2/runtime/install", { method: "POST" }))

    expect(inspection.status).toBe(200)
    expect(install.status).toBe(200)
    expect(runtimeHandler).toHaveBeenCalledTimes(2)
  })

  test("ignores a Core event envelope from another project directory", async () => {
    const core = fakeCore({ onPrompt() {} })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "开始分析" }),
    }))
    core.emit({ type: "session.error", properties: { sessionID: "session-1", error: { data: { message: "foreign failure" } } } }, "/other/project")
    core.emit({ type: "message.part.updated", properties: {
      sessionID: "session-1", part: { type: "text", messageID: "message-1", text: "本项目正文" },
    } })
    const result = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/result"))

    expect(await result.json()).toMatchObject({ status: "running", document: "本项目正文" })
  })

  test("production CoreApplication wiring consumes wrapped GlobalBus events", async () => {
    const application = {
      directory: "/managed/project",
      async fetch(request: Request) {
        const route = new URL(request.url).pathname
        if (route === "/session") return Response.json({ id: "session-core-1" })
        if (route === "/session/session-core-1/prompt_async") return Response.json({})
        if (route === "/session/session-core-1/message") return Response.json([{ info: { id: "message-1", role: "assistant" }, parts: [{ type: "text", text: "来自生产形状事件" }] }])
        return new Response("Not Found", { status: 404 })
      },
      async dispose() {},
    } satisfies CoreApplication
    const api = createLocalWebEngineApiFromCore(application)
    apis.push(api)
    const started = await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "解释结果" }),
    }))
    const { runId } = await started.json()
    GlobalBus.emit("event", { directory: "/managed/project", payload: {
      type: "message.part.updated",
      properties: { sessionID: "session-core-1", part: { type: "text", messageID: "message-1", text: "来自生产形状事件" } },
    } })
    GlobalBus.emit("event", { directory: "/managed/project", payload: {
      type: "session.idle", properties: { sessionID: "session-core-1" },
    } })
    const result = await api(new Request(`http://127.0.0.1/api/v2/runs/${runId}/result`))

    expect(started.status).toBe(200)
    expect(await result.json()).toMatchObject({ status: "completed", document: "来自生产形状事件" })
  })

  test("restores a completed Core session after a Web API process restart", async () => {
    const document = "已保存的研究结果"
    const core = fakeCore({
      async onLoadSession() {
        return [{ info: { id: "message-1", role: "assistant" }, parts: [{ type: "text", text: document }] }]
      },
    })
    const api = createLocalWebEngineApi(core)
    apis.push(api)

    const result = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/result"))
    const stream = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    const reader = stream.body!.getReader()
    const chunks: string[] = []
    while (!chunks.join("").includes('"type":"completed"')) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    await reader.cancel()

    expect(await result.json()).toMatchObject({ status: "completed", document })
    expect(chunks.join("")).toContain(document)
    expect(chunks.join("")).toContain('"type":"completed"')
  })

  test("does not lose a Core terminal event while restoring an active session", async () => {
    let allowSessionLookup!: () => void
    let sessionLookupStarted!: () => void
    const sessionLookupStartedPromise = new Promise<void>((resolve) => { sessionLookupStarted = resolve })
    const sessionLookupGate = new Promise<void>((resolve) => { allowSessionLookup = resolve })
    const core = fakeCore({
      sessionExists: async () => {
        sessionLookupStarted()
        await sessionLookupGate
        return true
      },
      sessionStatus: async () => ({ type: "busy" }),
      async onLoadSession() {
        return [{ info: { id: "message-1", role: "assistant" }, parts: [{ type: "text", text: "恢复后的完整结果" }] }]
      },
    })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const streamResponse = api(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    await sessionLookupStartedPromise
    core.emit({ type: "session.idle", properties: { sessionID: "session-1" } })
    allowSessionLookup()
    const stream = await streamResponse
    const reader = stream.body!.getReader()
    const chunks: string[] = []
    while (!chunks.join("").includes('"type":"completed"')) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    await reader.cancel()
    const result = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/result"))

    expect(chunks.join("")).toContain("恢复后的完整结果")
    expect(chunks.join("")).toContain('"type":"completed"')
    expect(await result.json()).toMatchObject({ status: "completed" })
  })

  test("keeps the per-run SSE stream open for a Core title that arrives after completion", async () => {
    const core = fakeCore({ onPrompt(emit) {
      emit({ type: "message.part.updated", properties: { sessionID: "session-1", part: { type: "text", messageID: "message-1", text: "分析结果" } } })
      emit({ type: "session.idle", properties: { sessionID: "session-1" } })
      emit({ type: "session.updated", properties: { info: { id: "session-1", title: "政策评估" } } })
    } })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "分析" }),
    }))
    const stream = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    const reader = stream.body!.getReader()
    const chunks: string[] = []
    while (!chunks.join("").includes('"type":"title"')) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    await reader.cancel()

    expect(chunks.join("")).toContain('"type":"completed"')
    expect(chunks.join("")).toContain('"type":"title","title":"政策评估"')
  })

  test("rejects an invalid prompt before creating a Core session", async () => {
    const core = fakeCore()
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const response = await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: " " }),
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ protocolVersion: "v2" })
    expect(core.calls.created).toHaveLength(0)
    expect(core.calls.prompts).toHaveLength(0)
  })

  test("keeps an uploaded file in bounded app memory and attaches it only once per Core session", async () => {
    const core = fakeCore()
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const file = new File(["x,y\n1,2\n"], "policy.csv", { type: "text/csv" })
    const form = new FormData()
    form.append("file", file)
    const upload = await api(new Request("http://127.0.0.1/api/v2/datasets", { method: "POST", body: form }))
    const dataset = await upload.json()
    const submit = (sessionID?: string) => api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "查看数据", ...(sessionID ? { sessionID } : {}), dataset }),
    }))

    expect(upload.status).toBe(200)
    expect(dataset).toMatchObject({ protocolVersion: "v2", name: "policy.csv", format: "CSV", bytes: file.size })
    expect((await submit()).status).toBe(200)
    expect((await submit("session-1")).status).toBe(200)
    const prompts = core.calls.prompts as Array<{ files?: Array<{ filename?: string; url: string }> }>
    expect(prompts).toHaveLength(2)
    expect(prompts[0].files?.[0].filename).toBe("policy.csv")
    expect(prompts[0].files?.[0].url).toBe(`data:text/csv;base64,${btoa("x,y\n1,2\n")}`)
    expect(prompts[1].files).toBeUndefined()
  })

  test("passes an explicit Engine Protocol slash command and permission rules to Core", async () => {
    const core = fakeCore()
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const permission = [{ permission: "workspace_write", pattern: "*", action: "ask" }]
    const response = await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "/results summary",
        command: { name: "results", arguments: "summary" },
        model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        permission,
        effort: "high",
      }),
    }))

    expect(response.status).toBe(200)
    expect(core.calls.created).toEqual([{ title: "/results summary", permission }])
    expect(core.calls.commands).toEqual([{
      sessionID: "session-1", command: "results", arguments: "summary",
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" }, variant: "high",
      worksheetName: undefined, files: undefined,
    }])
    expect(core.calls.prompts).toHaveLength(0)
  })

  test("supports shared context, summarize, title, undo, and redo session operations", async () => {
    const core = fakeCore()
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const context = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/context"))
    const bodyRequest = (path: string, method: string, body?: unknown) => new Request(`http://127.0.0.1/api/v2/runs/session-1/${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    })

    expect(await context.json()).toEqual({ protocolVersion: "v2", context: { budget: 12 } })
    expect((await api(bodyRequest("summarize", "POST", { model: { providerID: "deepseek", modelID: "deepseek-v4-flash" }, instructions: "保留研究设定" }))).status).toBe(200)
    expect((await api(bodyRequest("title", "PATCH", { title: "政策评估" }))).status).toBe(200)
    expect((await api(bodyRequest("revert", "POST", { messageID: "message-1" }))).status).toBe(200)
    expect((await api(bodyRequest("undo", "POST"))).status).toBe(200)
    expect((await api(bodyRequest("redo", "POST"))).status).toBe(200)
    expect(core.calls.sessionOps).toEqual([
      { operation: "context", sessionID: "session-1" },
      { operation: "summarize", sessionID: "session-1", model: { providerID: "deepseek", modelID: "deepseek-v4-flash" }, instructions: "保留研究设定" },
      { operation: "title", sessionID: "session-1", title: "政策评估" },
      { operation: "revert", sessionID: "session-1", messageID: "message-1" },
      { operation: "undo", sessionID: "session-1" },
      { operation: "redo", sessionID: "session-1" },
    ])
  })

  test("rejects a stale or forged dataset reference before creating a Core session", async () => {
    const core = fakeCore()
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const response = await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "查看数据", dataset: { id: "unknown", name: "secret.csv", bytes: 10 } }),
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "dataset_expired" })
    expect(core.calls.created).toHaveLength(0)
  })

  test("reserves upload slots before reading concurrent file bodies", async () => {
    const core = fakeCore()
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const uploads = Array.from({ length: 33 }, (_, index) => {
      const form = new FormData()
      form.append("file", new File([String(index)], `dataset-${index}.csv`, { type: "text/csv" }))
      return api(new Request("http://127.0.0.1/api/v2/datasets", { method: "POST", body: form }))
    })
    const responses = await Promise.all(uploads)

    expect(responses.filter((response) => response.status === 200)).toHaveLength(32)
    expect(responses.filter((response) => response.status === 413)).toHaveLength(1)
  })

  test("accepts a pending question once and rejects a replayed answer", async () => {
    const core = fakeCore({ onPrompt(emit) {
      emit({
        type: "question.asked",
        properties: {
          id: "question-1",
          sessionID: "session-1",
          questions: [{ header: "因变量", question: "选择结果变量", multiple: false, custom: false, options: [{ label: "GDP", description: "地区产出" }] }],
        },
      })
    } })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const started = await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "运行分析" }),
    }))
    const result = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/result"))
    const answerRequest = () => new Request("http://127.0.0.1/api/v2/runs/session-1/interactions/question-1/answer", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected: ["0"] }),
    })

    expect(started.status).toBe(200)
    expect(await result.json()).toMatchObject({ status: "waiting", interaction: { kind: "question", question: { requestId: "question-1" } } })
    const answers = await Promise.all([api(answerRequest()), api(answerRequest())])
    expect(answers.map((response) => response.status).sort()).toEqual([200, 409])
    expect(core.calls.questionReplies).toEqual([{ requestID: "question-1", answers: [["GDP"]] }])
  })

  test("requires an explicit one-time decision for permission requests", async () => {
    const core = fakeCore({ onPrompt(emit) {
      emit({ type: "permission.asked", properties: {
        id: "permission-1", sessionID: "session-1", permission: "workspace_write", patterns: ["*.csv"], metadata: {}, always: [],
      } })
    } })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "更新数据" }),
    }))
    const answerRequest = (body: unknown) => new Request("http://127.0.0.1/api/v2/runs/session-1/interactions/permission-1/answer", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    const deny = new Request("http://127.0.0.1/api/v2/runs/session-1/interactions/permission-1/deny", { method: "POST" })

    expect((await api(answerRequest({}))).status).toBe(400)
    expect(core.calls.permissionReplies).toHaveLength(0)
    expect((await api(answerRequest({ allowed: true }))).status).toBe(200)
    expect((await api(deny)).status).toBe(409)
    expect(core.calls.permissionReplies).toEqual([{ requestID: "permission-1", reply: "once" }])
  })

  test("confirms cancellation through Core and returns the cancelled terminal state", async () => {
    const core = fakeCore({ onPrompt() {} })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "开始长任务" }),
    }))

    const cancelRequest = () => new Request("http://127.0.0.1/api/v2/runs/session-1/cancel", { method: "POST" })
    const cancellations = await Promise.all([api(cancelRequest()), api(cancelRequest())])
    const result = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/result"))

    expect(await Promise.all(cancellations.map((response) => response.json()))).toEqual([
      { protocolVersion: "v2", cancelled: true }, { protocolVersion: "v2", cancelled: true },
    ])
    expect(core.calls.aborted).toEqual(["session-1"])
    expect(await result.json()).toMatchObject({ status: "cancelled", document: null })
  })

  test("does not report concurrent cancellation as successful when Core abort fails", async () => {
    let rejectAbort!: (error: Error) => void
    let abortStarted!: () => void
    const abortStartedPromise = new Promise<void>((resolve) => { abortStarted = resolve })
    const core = fakeCore({ onPrompt() {}, onAbort: () => {
      abortStarted()
      return new Promise<void>((_resolve, reject) => { rejectAbort = reject })
    } })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "开始长任务" }),
    }))
    const cancelRequest = () => new Request("http://127.0.0.1/api/v2/runs/session-1/cancel", { method: "POST" })
    const first = api(cancelRequest())
    const second = api(cancelRequest())
    await abortStartedPromise
    rejectAbort(new Error("simulated abort failure"))
    const responses = await Promise.all([first, second])
    const result = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/result"))

    expect(responses.map((response) => response.status)).toEqual([503, 503])
    expect(core.calls.aborted).toEqual(["session-1"])
    expect(await result.json()).toMatchObject({ status: "running" })
  })

  test("does not let an in-flight answer overwrite a confirmed cancellation", async () => {
    let finishReply!: () => void
    let replyStarted!: () => void
    const replyStartedPromise = new Promise<void>((resolve) => { replyStarted = resolve })
    const core = fakeCore({
      onPrompt(emit) {
        emit({ type: "question.asked", properties: { id: "question-1", sessionID: "session-1", questions: [{ header: "目标", question: "选择目标", options: [{ label: "产出", description: "" }] }] } })
      },
      onQuestionReply: () => {
        replyStarted()
        return new Promise<void>((resolve) => { finishReply = resolve })
      },
    })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "开始分析" }),
    }))
    const answer = api(new Request("http://127.0.0.1/api/v2/runs/session-1/interactions/question-1/answer", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected: ["0"] }),
    }))
    await replyStartedPromise
    const cancelled = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/cancel", { method: "POST" }))
    finishReply()
    await answer
    const result = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/result"))

    expect(await cancelled.json()).toEqual({ protocolVersion: "v2", cancelled: true })
    expect(await result.json()).toMatchObject({ status: "cancelled" })
  })

  test("reserves a reused session before asynchronous restoration to reject duplicate prompt posts", async () => {
    const core = fakeCore()
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const postRun = (sessionID?: string) => api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "继续研究", ...(sessionID ? { sessionID } : {}) }),
    }))
    await postRun()
    const followUps = await Promise.all([postRun("session-1"), postRun("session-1")])

    expect(followUps.map((response) => response.status).sort()).toEqual([200, 409])
    expect(core.calls.prompts).toHaveLength(2)
  })

  test("reserves new active-run capacity before asynchronous Core session creation", async () => {
    const core = fakeCore({ onPrompt() {}, onCreateSession: async (index) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return `session-${index}`
    } })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const requests = Array.from({ length: 33 }, () => api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "并行研究" }),
    })))
    const responses = await Promise.all(requests)

    expect(responses.filter((response) => response.status === 200)).toHaveLength(32)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1)
    expect(core.calls.created).toHaveLength(32)
  })

  test("reserves active capacity while concurrently restoring Core sessions", async () => {
    const core = fakeCore({
      sessionExists: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); return true },
      sessionStatus: async () => ({ type: "busy" }),
    })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const requests = Array.from({ length: 33 }, (_, index) => api(new Request(`http://127.0.0.1/api/v2/runs/session-existing-${index}/events`)))
    const responses = await Promise.all(requests)

    expect(responses.filter((response) => response.status === 200)).toHaveLength(32)
    expect(responses.filter((response) => response.status === 404)).toHaveLength(1)
  })

  test("does not let a previous turn terminal event or SSE replay finish a reused session", async () => {
    let turn = 0
    const core = fakeCore({ onPrompt(emit) {
      turn += 1
      if (turn === 1) {
        emit({ type: "message.part.updated", properties: { sessionID: "session-1", part: { type: "text", messageID: "message-1", text: "旧轮次正文" } } })
        emit({ type: "session.idle", properties: { sessionID: "session-1" } })
        return
      }
      emit({ type: "session.idle", properties: { sessionID: "session-1" } })
      emit({ type: "message.part.updated", properties: { sessionID: "session-1", part: { type: "text", messageID: "message-2", text: "新轮次正文" } } })
      emit({ type: "session.idle", properties: { sessionID: "session-1" } })
    } })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    const postRun = (sessionID?: string) => api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "继续研究", ...(sessionID ? { sessionID } : {}) }),
    }))
    await postRun()
    await postRun("session-1")
    const stream = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    const reader = stream.body!.getReader()
    const chunks: string[] = []
    while (!chunks.join("").includes('"type":"completed"')) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    await reader.cancel()
    const payload = chunks.join("")

    expect(payload).toContain("新轮次正文")
    expect(payload).not.toContain("旧轮次正文")
    expect(payload.match(/"type":"completed"/g)).toHaveLength(1)
  })

  test("does not expose raw Core error messages that contain a local filesystem path", async () => {
    const core = fakeCore({ onPrompt(emit) {
      emit({ type: "session.error", properties: { sessionID: "session-1", error: { data: { message: "cannot read /Users/researcher/.killstata/auth.json" } } } })
    } })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "开始分析" }),
    }))
    const stream = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    const reader = stream.body!.getReader()
    const chunks: string[] = []
    while (!chunks.join("").includes('"type":"failed"')) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    await reader.cancel()

    expect(chunks.join("")).toContain("分析核心执行失败")
    expect(chunks.join("")).not.toContain("/Users/researcher")
    expect(chunks.join("")).not.toContain("auth.json")
  })

  test("filters temporary paths and explicit secrets out of reasoning events", async () => {
    const core = fakeCore({ onPrompt(emit) {
      emit({ type: "message.part.updated", properties: {
        sessionID: "session-1", part: { type: "reasoning", messageID: "message-1", text: "inspect /tmp/private.csv; OPENAI_API_KEY=sk-private-value" },
      } })
      emit({ type: "message.part.updated", properties: {
        sessionID: "session-1", part: { type: "text", messageID: "message-1", text: "回归完成" },
      } })
      emit({ type: "session.idle", properties: { sessionID: "session-1" } })
    } })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "分析" }),
    }))
    const stream = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    const reader = stream.body!.getReader()
    const chunks: string[] = []
    while (!chunks.join("").includes('"type":"completed"')) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    await reader.cancel()
    const events = chunks.join("")

    expect(events).toContain("回归完成")
    expect(events).not.toContain("reasoning_delta")
    expect(events).not.toContain("/tmp/private.csv")
    expect(events).not.toContain("sk-private-value")
  })

  test("scrubs local paths and explicit secret values from assistant text and restored results", async () => {
    const document = "结果保存在 /Users/researcher/.killstata/private.json。 OPENAI_API_KEY=sk-private-value"
    const core = fakeCore({
      onPrompt(emit) {
        emit({ type: "message.part.updated", properties: { sessionID: "session-1", part: { type: "text", messageID: "message-1", text: document } } })
      },
      async onLoadSession() {
        return [{ info: { id: "message-1", role: "assistant" }, parts: [{ type: "text", text: document }] }]
      },
    })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "分析" }),
    }))
    const stream = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    const reader = stream.body!.getReader()
    const chunks: string[] = []
    while (!chunks.join("").includes("凭据已隐藏")) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    await reader.cancel()
    const result = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/result"))
    const resultBody = await result.text()

    expect(chunks.join("")).toContain("结果保存在 [本机路径]")
    expect(chunks.join("")).not.toContain("/Users/researcher")
    expect(chunks.join("")).not.toContain("sk-private-value")
    expect(resultBody).not.toContain("/Users/researcher")
    expect(resultBody).not.toContain("sk-private-value")
  })

  test("publishes completed-run verifier updates on the separate session-level SSE stream", async () => {
    const core = fakeCore({ onPrompt(emit) {
      emit({ type: "message.part.updated", properties: {
        sessionID: "session-1",
        part: {
          type: "tool", messageID: "message-1", callID: "call-1", tool: "econometrics_execute",
          state: { status: "completed", input: {}, metadata: { verifierStatus: "pass" } },
        },
      } })
      emit({ type: "session.idle", properties: { sessionID: "session-1" } })
    } })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "运行核验" }),
    }))
    const stream = await api(new Request("http://127.0.0.1/api/v2/verification/events"))
    const reader = stream.body!.getReader()
    const event = await reader.read()
    await reader.cancel()

    expect(new TextDecoder().decode(event.value)).toContain('"type":"verification"')
    expect(new TextDecoder().decode(event.value)).toContain('"message":"独立核验通过。"')
    expect(new TextDecoder().decode(event.value)).toContain('"sessionID":"session-1"')
  })

  test("keeps the idle verifier stream alive inside the local Web server timeout", async () => {
    const api = createLocalWebEngineApi(fakeCore())
    apis.push(api)
    const response = await api(new Request("http://127.0.0.1/api/v2/verification/events"))
    const reader = response.body!.getReader()
    const timedOut = Symbol("timed out")
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), 8_000) }),
      ])
      if (chunk === timedOut) throw new Error("verifier SSE heartbeat exceeded the local server idle timeout margin")
      expect(new TextDecoder().decode(chunk.value)).toBe(": keep-alive\n\n")
    } finally {
      clearTimeout(timer)
      await reader.cancel()
    }
  }, 10_000)

  test("recovers an oversized text snapshot from Core before the browser opens SSE", async () => {
    const document = "统计结论。".repeat(120_000)
    const core = fakeCore({
      onPrompt(emit) {
        emit({ type: "message.part.updated", properties: { sessionID: "session-1", part: { type: "text", messageID: "message-1", text: document } } })
        emit({ type: "session.idle", properties: { sessionID: "session-1" } })
      },
      async onLoadSession() {
        return [{ info: { id: "message-1", role: "assistant" }, parts: [{ type: "text", text: document }] }]
      },
    })
    const api = createLocalWebEngineApi(core)
    apis.push(api)
    await api(new Request("http://127.0.0.1/api/v2/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "分析" }),
    }))
    const stream = await api(new Request("http://127.0.0.1/api/v2/runs/session-1/events"))
    const reader = stream.body!.getReader()
    const chunks: string[] = []
    while (!chunks.join("").includes('"type":"completed"')) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(new TextDecoder().decode(next.value))
    }
    await reader.cancel()

    expect(chunks.join("")).toContain('"type":"assistant_delta"')
    expect(chunks.join("")).toContain(document)
    expect(chunks.join("")).toContain('"type":"completed"')
  })
})
