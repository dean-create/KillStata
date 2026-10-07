import path from "node:path"
import type { CoreApplication } from "../../src/core/application"
import type { LocalWebCore } from "../../src/web/local-web-engine"
import { createLocalWebEngineApi } from "../../src/web/local-web-engine"
import { startLocalWebHost } from "../../src/web/local-web-host"
import { createLocalWebWorkspaceEngine } from "../../src/web/local-web-workspace-engine"
import { createLocalWebWorkspaceRegistry } from "../../src/web/local-web-workspaces"

type FakeSession = {
  id: string
  index: number
  status: "idle" | "busy" | "waiting"
  question?: { id: string; questions: Array<{ header: string; question: string; options: Array<{ label: string }> }> }
  messages: Array<{ info: { id: string; role: string }; parts: Array<Record<string, unknown>> }>
}

type FakeCore = LocalWebCore & CoreApplication & {
  prompts: Array<{ sessionID: string; text: string; files: Array<{ filename?: string }> }>
  answers: Array<{ requestID: string; answers: string[][] }>
  aborted: string[]
}

const cores = new Map<string, FakeCore>()

function createFakeCore(directory: string): FakeCore {
  const listeners = new Set<(event: unknown) => void>()
  const sessions = new Map<string, FakeSession>()
  const healthy = process.env.KILLSTATA_FAKE_CORE_UNAVAILABLE !== "true"
  const core: FakeCore = {
    directory,
    prompts: [],
    answers: [],
    aborted: [],
    async fetch() { return new Response("Not Found", { status: 404 }) },
    async dispose() { listeners.clear() },
    async health() { return { version: "fake-core", healthy } },
    async commands() { return [] },
    subscribeEvents(handler) { listeners.add(handler); return () => listeners.delete(handler) },
    async createSession() {
      const id = `fake-session-${sessions.size + 1}`
      sessions.set(id, { id, index: 0, status: "idle", messages: [] })
      return id
    },
    async prompt(input) {
      const session = sessions.get(input.sessionID)
      if (!session) throw new Error("fake Core session missing")
      core.prompts.push({ sessionID: session.id, text: input.text, files: input.files?.map((file) => ({ filename: file.filename })) ?? [] })
      session.status = "busy"
      publishPart(session, "reasoning", "先读取所选 CSV，再核对结果变量。")
      if (input.text.includes("停止这一轮")) {
        publishPart(session, "text", "已开始第二轮分析，等待停止请求。")
        return
      }
      publishPart(session, "text", "已读取所选数据，正在确认结果变量。")
      session.status = "waiting"
      session.question = {
        id: "fake-question-1",
        questions: [{ header: "选择结果变量", question: "结果变量是哪一列？", options: [{ label: "outcome" }] }],
      }
      emit(session.id, "question.asked", session.question)
    },
    async command() {},
    async abort(sessionID) {
      const session = sessions.get(sessionID)
      if (!session) throw new Error("fake Core session missing")
      core.aborted.push(sessionID)
      session.status = "idle"
      emit(sessionID, "session.idle", {})
    },
    async loadSession(sessionID) { return sessions.get(sessionID)?.messages ?? [] },
    async sessionExists(sessionID) { return sessions.has(sessionID) },
    async sessionStatus(sessionID) { return { type: sessions.get(sessionID)?.status ?? "idle" } },
    async pendingQuestion(sessionID) { return sessions.get(sessionID)?.question },
    async pendingPermission() { return undefined },
    async context() { return { usage: { usedTokens: 0, inputBudget: 1000, remainingTokens: 1000 } } },
    async summarize() {},
    async updateTitle() {},
    async revert() {},
    async revertLatest() {},
    async unrevert() {},
    async replyPermission() {},
    async replyQuestion(requestID, answers) {
      const session = [...sessions.values()].find((item) => item.question?.id === requestID)
      if (!session) throw new Error("fake Core question missing")
      core.answers.push({ requestID, answers })
      session.question = undefined
      publishPart(session, "text", "## 回归结果\n\n| 变量 | 系数 |\n|---|---:|\n| outcome | 1.25 |")
      session.status = "idle"
      emit(session.id, "session.idle", {})
    },
    async rejectQuestion() {},
  }

  function emit(sessionID: string, type: string, properties: Record<string, unknown>) {
    for (const handler of [...listeners]) handler({ directory, payload: { type, properties: { sessionID, ...properties } } })
  }

  function publishPart(session: FakeSession, type: string, text: string) {
    session.index += 1
    const messageID = `fake-message-${String(session.index).padStart(4, "0")}`
    const part = { type, text, messageID, synthetic: false, ignored: false }
    if (type === "text") session.messages.push({ info: { id: messageID, role: "assistant" }, parts: [part] })
    emit(session.id, "message.part.updated", { part })
  }

  return core
}

const fakeProfile = {
  id: "fake-profile",
  displayName: "Fake Core profile",
  provider: "deepseek",
  model: "deepseek/deepseek-v4-flash",
  configured: true,
  isDefault: true,
}

const credentialHandler = async (request: Request) => {
  const url = new URL(request.url)
  if (url.pathname === "/api/v2/credentials/profiles" && request.method === "GET") {
    return Response.json({ protocolVersion: "v2", profiles: [fakeProfile], defaultProfileId: fakeProfile.id })
  }
  if (url.pathname === "/api/v2/credentials/activate" && request.method === "POST") {
    return Response.json({ protocolVersion: "v2", activated: true })
  }
  if (url.pathname === "/api/v2/test/summary" && request.method === "GET") {
    const events = [...cores.values()].flatMap((core) => [
      ...core.prompts.map((prompt) => ({ type: "prompt", ...prompt })),
      ...core.answers.map((answer) => ({ type: "answer", ...answer })),
      ...core.aborted.map((sessionID) => ({ type: "abort", sessionID })),
    ])
    return Response.json({ protocolVersion: "v2", events })
  }
  return undefined
}

const registry = createLocalWebWorkspaceRegistry({ launchDirectory: process.cwd() })
const engine = createLocalWebWorkspaceEngine({
  registry,
  async createCore({ directory }) {
    const core = createFakeCore(directory)
    cores.set(directory, core)
    return core
  },
  createApi(application, runtimeHandler) {
    return createLocalWebEngineApi(application as FakeCore, undefined, runtimeHandler)
  },
  createRuntimeHandler() { return async () => undefined },
  credentialHandler,
})

await engine.warmup()
const assetsDirectory = path.resolve(import.meta.dir, "../../../../desktop/dist-web")
const host = await startLocalWebHost({ assetsDirectory, api: engine, port: 0 })
process.stdout.write(`KillStata Web: ${host.launchUrl}\n`)

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve)
  process.once("SIGTERM", resolve)
})
await host.stop()
await engine.shutdown()
