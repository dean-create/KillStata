import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

const ROOT = process.cwd()
const HOST = "127.0.0.1"
const PORT = 4096
const BASE_URL = `http://${HOST}:${PORT}`
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-")
const LOG_ROOT = path.join(ROOT, ".tmp-e2e-logs", RUN_STAMP)
const DATASET = path.resolve(ROOT, "..", "test", "did高质量发展.dta")
const SESSION_TIMEOUT_MS = 15 * 60 * 1000

type ToolCallLog = {
  partID: string
  tool: string
  status: string
  title?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
  attachments?: string[]
}

type SessionRecord = {
  name: string
  sessionID: string
  toolCalls: ToolCallLog[]
  permissions: Array<Record<string, unknown>>
  questions: Array<Record<string, unknown>>
  errors: string[]
  idleResolve: () => void
  idlePromise: Promise<void>
}

type SessionResult = {
  name: string
  sessionID: string
  assistantText: string
  assistantError?: unknown
  toolCalls: ToolCallLog[]
  permissions: Array<Record<string, unknown>>
  questions: Array<Record<string, unknown>>
  errors: string[]
  artifactPaths: string[]
  logDir: string
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeText(filePath: string, content: string) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, "utf-8")
}

function writeJson(filePath: string, value: unknown) {
  writeText(filePath, JSON.stringify(value, null, 2))
}

function sanitizeName(value: string) {
  return value.replace(/[<>:"/\\|?*\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
}

function extractWindowsPaths(text: string) {
  const matches = text.match(/[A-Za-z]:\\[^\r\n"'<>|]+/g) ?? []
  return Array.from(new Set(matches))
}

function renderAssistantText(messages: Array<{ info: { role: string; error?: unknown }; parts: Array<any> }>) {
  const assistant = [...messages].reverse().find((message) => message.info.role === "assistant")
  if (!assistant) return { text: "", error: undefined }
  const text = assistant.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim()
  return {
    text,
    error: assistant.info.error,
  }
}

function chooseQuestionAnswers(request: { questions: Array<{ header: string; question: string; options: Array<{ label: string }> }> }) {
  return request.questions.map((item) => {
    const prompt = `${item.header}\n${item.question}`
    if (/list a concise plan first/i.test(prompt) || /list a plan first/i.test(prompt)) return ["No"]
    if (/deletion-like data operation/i.test(prompt) || /Do you want to continue/i.test(prompt)) return ["Yes"]
    const noOption = item.options.find((option) => option.label === "No")
    if (noOption) return ["No"]
    const yesOption = item.options.find((option) => option.label === "Yes")
    if (yesOption) return ["Yes"]
    return item.options[0] ? [item.options[0].label] : []
  })
}

async function startServer() {
  ensureDir(LOG_ROOT)
  const stdoutPath = path.join(LOG_ROOT, "server.stdout.log")
  const stderrPath = path.join(LOG_ROOT, "server.stderr.log")
  const proc = spawn("bun", ["dev", "serve", `--hostname=${HOST}`, `--port=${PORT}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    stdio: "pipe",
  })

  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  let ready = false

  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString()
    stdoutChunks.push(text)
    fs.appendFileSync(stdoutPath, text)
    if (!ready && text.includes(`killstata server listening on ${BASE_URL}`)) {
      ready = true
    }
  })

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString()
    stderrChunks.push(text)
    fs.appendFileSync(stderrPath, text)
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for dev server. stdout:\n${stdoutChunks.join("")}\n\nstderr:\n${stderrChunks.join("")}`,
        ),
      )
    }, 30000)

    const checkReady = setInterval(() => {
      if (!ready) return
      clearTimeout(timeout)
      clearInterval(checkReady)
      resolve()
    }, 100)

    proc.once("error", (error) => {
      clearTimeout(timeout)
      clearInterval(checkReady)
      reject(error)
    })

    proc.once("exit", (code, signal) => {
      clearTimeout(timeout)
      clearInterval(checkReady)
      reject(
        new Error(
          `Dev server exited before becoming ready. code=${code} signal=${signal}\nstdout:\n${stdoutChunks.join("")}\n\nstderr:\n${stderrChunks.join("")}`,
        ),
      )
    })
  })

  return {
    proc,
    stdoutPath,
    stderrPath,
    close() {
      proc.kill()
    },
  }
}

async function run() {
  if (!fs.existsSync(DATASET)) {
    throw new Error(`Dataset not found: ${DATASET}`)
  }

  const server = await startServer()
  const client = createOpencodeClient({ baseUrl: BASE_URL, directory: ROOT })
  const eventStream = await client.event.subscribe({ directory: ROOT })
  const sessions = new Map<string, SessionRecord>()

  const eventLoop = (async () => {
    for await (const event of eventStream.stream) {
      if (event.type === "permission.asked") {
        const request = event.properties
        const record = sessions.get(request.sessionID)
        if (!record) continue
        record.permissions.push({
          requestID: request.id,
          permission: request.permission,
          patterns: request.patterns,
          always: request.always,
          metadata: request.metadata,
        })
        await client.permission.reply({
          requestID: request.id,
          directory: ROOT,
          reply: "always",
        })
        continue
      }

      if (event.type === "question.asked") {
        const request = event.properties
        const record = sessions.get(request.sessionID)
        if (!record) continue
        const answers = chooseQuestionAnswers(request)
        record.questions.push({
          requestID: request.id,
          questions: request.questions,
          answers,
        })
        await client.question.reply({
          requestID: request.id,
          directory: ROOT,
          answers,
        })
        continue
      }

      if (event.type === "session.error") {
        const request = event.properties
        const record = sessions.get(request.sessionID)
        if (!record) continue
        const payload = request.error
        const message =
          payload && typeof payload === "object" && "data" in payload && payload.data && typeof payload.data === "object"
            ? String((payload.data as Record<string, unknown>).message ?? payload.name)
            : JSON.stringify(payload)
        record.errors.push(message)
        continue
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part
        const record = sessions.get(part.sessionID)
        if (!record || part.type !== "tool") continue
        const attachments = (part.state.attachments ?? []).map((item: { url: string }) => item.url)
        const nextItem: ToolCallLog = {
          partID: part.id,
          tool: part.tool,
          status: part.state.status,
          title: part.state.title,
          input: part.state.input,
          output: part.state.status === "completed" ? part.state.output : undefined,
          error: part.state.status === "error" ? part.state.error : undefined,
          attachments,
        }
        const idx = record.toolCalls.findIndex((item) => item.partID === part.id)
        if (idx >= 0) record.toolCalls[idx] = nextItem
        else record.toolCalls.push(nextItem)
        continue
      }

      if (event.type === "session.idle") {
        const record = sessions.get(event.properties.sessionID)
        if (!record) continue
        record.idleResolve()
      }
    }
  })()

  async function runPrompt(name: string, prompt: string) {
    const created = await client.session.create({ title: name })
    const sessionID = created.data?.id
    if (!sessionID) throw new Error(`Failed to create session for ${name}`)

    let idleResolve = () => {}
    const idlePromise = new Promise<void>((resolve) => {
      idleResolve = resolve
    })

    const record: SessionRecord = {
      name,
      sessionID,
      toolCalls: [],
      permissions: [],
      questions: [],
      errors: [],
      idleResolve,
      idlePromise,
    }
    sessions.set(sessionID, record)

    await client.session.prompt({
      sessionID,
      directory: ROOT,
      parts: [{ type: "text", text: prompt }],
    })

    await Promise.race([
      idlePromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`Session timed out after ${SESSION_TIMEOUT_MS}ms: ${name}`)), SESSION_TIMEOUT_MS),
      ),
    ])

    const messagesResponse = await client.session.messages({
      sessionID,
      directory: ROOT,
      limit: 200,
    })
    const messages = messagesResponse.data ?? []
    const rendered = renderAssistantText(messages as any)
    const rawText = [
      rendered.text,
      ...record.toolCalls.map((item) => item.output ?? ""),
      ...record.errors,
    ]
      .filter(Boolean)
      .join("\n")
    const artifactPaths = extractWindowsPaths(rawText)

    const logDir = path.join(LOG_ROOT, sanitizeName(name))
    ensureDir(logDir)
    writeJson(path.join(logDir, "messages.json"), messages)
    writeJson(path.join(logDir, "tool-calls.json"), record.toolCalls)
    writeJson(path.join(logDir, "permissions.json"), record.permissions)
    writeJson(path.join(logDir, "questions.json"), record.questions)
    writeJson(path.join(logDir, "result.json"), {
      name,
      sessionID,
      assistantText: rendered.text,
      assistantError: rendered.error,
      errors: record.errors,
      artifactPaths,
    })
    writeText(path.join(logDir, "assistant.txt"), rendered.text)

    const result: SessionResult = {
      name,
      sessionID,
      assistantText: rendered.text,
      assistantError: rendered.error,
      toolCalls: record.toolCalls,
      permissions: record.permissions,
      questions: record.questions,
      errors: record.errors,
      artifactPaths,
      logDir,
    }

    if (record.errors.length) {
      throw new Error(`${name} failed:\n${record.errors.join("\n")}\nLogs: ${logDir}`)
    }

    const toolErrors = record.toolCalls.filter((item) => item.status === "error")
    if (toolErrors.length) {
      throw new Error(
        `${name} has tool errors:\n${toolErrors.map((item) => `${item.tool}: ${item.error ?? "unknown error"}`).join("\n")}\nLogs: ${logDir}`,
      )
    }

    return result
  }

  const scenarioA = `
请对数据集 ${DATASET} 做一次端到端工具调用测试，必须实际调用工具，不要只做口头描述。

任务 1：
1. 导入这份 dta 数据。
2. 在导入后的数据上，按“省份”列删除所有“黑龙江省”的观测。
3. 对筛选后的数据做描述性统计，至少覆盖 year、did、经济发展水平、地区、省份。

执行要求：
- 每一步都要保存可检查的表格或工件，尤其是导入检查表、筛选后检查表、描述性统计表。
- 回复里必须明确写出 datasetId、stageId、每一步的输出文件路径和检查文件路径。
- 如果发现任何数据问题或工具失败，直接如实报告失败步骤和报错，不要编造成功。
`.trim()

  const scenarioB = `
请使用同一个原始数据集 ${DATASET} 做一次固定效应基准回归测试，必须实际调用工具，不要只做口头描述。

任务 2：
- 使用原始数据，不要删除黑龙江省数据。
- 做固定效应基准回归。
- 被解释变量：经济发展水平
- 解释变量：did
- 地区固定效应：地区
- 时间固定效应：year
- 不加入任何控制变量

执行要求：
- 必须保存回归结果表、系数表、诊断文件、叙述性报告等可检查工件。
- 回复里必须明确写出回归使用的数据路径、方法名、系数、标准误、p 值、R²、样本量和所有输出文件路径。
- 如果工具失败，直接如实报告失败步骤和报错。
`.trim()

  try {
    const results = []
    results.push(await runPrompt("scenario-a-filter-describe", scenarioA))
    results.push(await runPrompt("scenario-b-fe-regression", scenarioB))
    writeJson(path.join(LOG_ROOT, "summary.json"), results)
    console.log(JSON.stringify({ ok: true, logRoot: LOG_ROOT, results }, null, 2))
  } finally {
    server.close()
    await eventLoop.catch(() => {})
  }
}

await run()
