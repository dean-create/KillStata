import path from "path"
import { pathToFileURL } from "url"
import type { KillstataClient } from "@killstata/sdk/v2"

export type KausalPromptInput = {
  workspaceRoot: string
  prompt: string
  rawPrompt?: string
  agent: "explorer" | "analyst" | string
  model?: string
  sessionID?: string
  activeFile?: string
  configContent?: string
}

export type KausalRuntimeEvent = {
  type: string
  text?: string
  [key: string]: unknown
}

export async function runKausalPrompt(input: KausalPromptInput, onEvent: (event: KausalRuntimeEvent) => void) {
  process.env.KILLSTATA_CLIENT = process.env.KILLSTATA_CLIENT || "desktop"

  if (input.configContent) {
    process.env.KILLSTATA_CONFIG_CONTENT = input.configContent
  }

  const [{ bootstrap }, { Server }, { createKillstataClient }, { Provider }, permission] = await Promise.all([
    import("../cli/bootstrap"),
    import("../server/server"),
    import("@killstata/sdk/v2"),
    import("../provider/provider"),
    import("../cli/cmd/run-permission"),
  ])

  const workspaceRoot = path.resolve(input.workspaceRoot)
  const model = input.model ? Provider.parseModel(input.model) : undefined
  const fileParts = input.activeFile && isTextAttachable(input.activeFile)
    ? [
        {
          type: "file",
          url: pathToFileURL(path.resolve(workspaceRoot, input.activeFile)).toString(),
          filename: path.basename(input.activeFile),
          mime: "text/plain",
        },
      ]
    : []

  return bootstrap(workspaceRoot, async () => {
    const fetchFn = (async (requestInfo: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(requestInfo, init)
      const headers = new Headers(request.headers)
      headers.set("x-killstata-directory", workspaceRoot)
      return Server.App().fetch(new Request(request, { headers }))
    }) as typeof globalThis.fetch
    const sdk = createKillstataClient({ baseUrl: "http://killstata.internal", fetch: fetchFn })
    const sessionID = await resolveSession(sdk, input.sessionID, input.rawPrompt || input.prompt)
    const result = await streamPrompt({
      sdk,
      sessionID,
      workspaceRoot,
      prompt: input.prompt,
      agent: input.agent,
      model,
      fileParts,
      onEvent,
      permission,
    })
    return result
  })
}

async function createSession(sdk: KillstataClient, prompt: string) {
  const title = prompt.trim().slice(0, 50) || "Killstata 会话"
  const result = await sdk.session.create({
    title,
    permission: [
      {
        permission: "question",
        action: "deny",
        pattern: "*",
      },
    ],
  })
  if (!result.data?.id) throw new Error("Session not found")
  return result.data.id
}

async function resolveSession(sdk: KillstataClient, sessionID: string | undefined, prompt: string) {
  const id = sessionID?.trim()
  if (id) {
    const sessions = await sdk.session.list().catch(() => undefined)
    if (sessions?.data?.some((session) => session.id === id)) return id
  }
  return createSession(sdk, prompt)
}

async function streamPrompt(input: {
  sdk: KillstataClient
  sessionID: string
  workspaceRoot: string
  prompt: string
  agent: string
  model: unknown
  fileParts: any[]
  onEvent: (event: KausalRuntimeEvent) => void
  permission: typeof import("../cli/cmd/run-permission")
}) {
  const eventsAbort = new AbortController()
  const events = await input.sdk.event.subscribe(undefined, {
    signal: eventsAbort.signal,
  })
  let finalText = ""
  let errorText = ""
  const updates: KausalRuntimeEvent[] = []
  const emit = (event: KausalRuntimeEvent) => {
    const normalized = {
      timestamp: Date.now(),
      ...event,
    }
    updates.push(normalized)
    input.onEvent(normalized)
  }

  const eventProcessor = (async () => {
    for await (const event of events.stream) {
      const payload = event as any
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        if (part.sessionID !== input.sessionID) continue

        if (part.type === "text") {
          finalText = part.text || finalText
          emit({
            type: "assistant.text",
            id: part.id,
            text: part.text,
            final: Boolean(part.time?.end),
          })
        }

        if (part.type === "step-start") {
          emit({
            type: "step.started",
            id: part.id,
            text: part.title || part.text || "开始分析步骤",
          })
        }

        if (part.type === "step-finish") {
          emit({
            type: "step.completed",
            id: part.id,
            text: part.title || part.text || "分析步骤完成",
          })
        }

        if (part.type === "tool") {
          emit({
            type: `tool.${part.state?.status || "updated"}`,
            id: part.id,
            tool: part.tool,
            title: part.state?.metadata?.display?.summary || part.state?.title || part.tool,
            input: part.state?.input,
            output: part.state?.output,
            text: part.state?.metadata?.display?.summary || part.state?.title || part.tool,
          })
        }
      }

      if (payload.type === "runtime.workflow.state" && payload.properties?.sessionID === input.sessionID) {
        emit(normalizeWorkflowStateEvent(payload.properties))
      }

      if (payload.type === "session.error" && payload.properties.sessionID === input.sessionID) {
        errorText = readErrorMessage(payload.properties.error)
        emit({ type: "error", text: errorText })
      }

      if (payload.type === "permission.asked" && payload.properties.sessionID === input.sessionID) {
        const request = payload.properties
        const decision = input.permission.decideNonInteractivePermission({
          workspaceRoot: input.workspaceRoot,
          request: {
            permission: request.permission,
            patterns: request.patterns,
            metadata: request.metadata,
          },
        })
        await input.sdk.permission.respond({
          sessionID: input.sessionID,
          permissionID: request.id,
          response: decision.response,
        })
        emit({
          type: decision.response === "reject" ? "permission.auto.rejected" : "permission.auto.allowed",
          text: decision.reason,
          decision,
        })
      }

      if (payload.type === "question.asked" && payload.properties.sessionID === input.sessionID) {
        const question = payload.properties
        const decision = input.permission.decideNonInteractiveQuestion({
          workspaceRoot: input.workspaceRoot,
          request: {
            questions: question.questions.map((item: any) => ({
              header: item.header,
              question: item.question,
            })),
          },
        })
        const kausalDecision = decision.action === "reply" && decision.answers
          ? {
              ...decision,
              answers: normalizeQuestionAnswers(question.questions, decision.answers),
            }
          : {
              action: "reply" as const,
              answers: getDefaultQuestionAnswers(question.questions),
              reason: "kausal_auto_accept_question",
            }
        if (kausalDecision.action === "reply" && kausalDecision.answers) {
          await input.sdk.question.reply({
            requestID: question.id,
            answers: kausalDecision.answers,
          })
        } else {
          await input.sdk.question.reject({
            requestID: question.id,
          })
        }
        emit({
          type: kausalDecision.action === "reply" ? "question.auto.replied" : "question.auto.rejected",
          text: kausalDecision.reason,
          decision: kausalDecision,
        })
      }

      if (payload.type === "session.idle" && payload.properties.sessionID === input.sessionID) {
        eventsAbort.abort()
        break
      }
    }
  })()

  await input.sdk.session.promptAsync({
    sessionID: input.sessionID,
    agent: input.agent,
    model: input.model as any,
    parts: [...input.fileParts, { type: "text", text: input.prompt }],
  })

  await eventProcessor.finally(() => eventsAbort.abort())
  if (errorText) throw new Error(errorText)
  emit({ type: "run.completed", text: "Kausal Agent 已完成。" })
  return {
    command: "embedded-runtime",
    text: finalText || "Kausal Agent 已完成，但没有返回文本结果。",
    updates,
    sessionID: input.sessionID,
    runtimeSessionId: input.sessionID,
  }
}

function normalizeWorkflowStateEvent(properties: any): KausalRuntimeEvent {
  const stage = properties.activeStage
    ? `阶段 ${properties.activeStage}${properties.activeStageId ? ` (${properties.activeStageId})` : ""}`
    : ""
  const approval = properties.approvalStatus ? `审批 ${properties.approvalStatus}` : ""
  const verifier = properties.verifierStatus ? `校验 ${properties.verifierStatus}` : ""
  return {
    type: "workflow.state",
    text: [stage, approval, verifier].filter(Boolean).join(" · ") || "工作流状态已更新",
    ...properties,
  }
}

function isTextAttachable(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  return !new Set([".dta", ".sav", ".xls", ".xlsx", ".parquet", ".feather"]).has(ext)
}

function getDefaultQuestionAnswers(questions: any[]) {
  return questions.map((question) => [question.options?.[0]?.label || "Yes"])
}

function normalizeQuestionAnswers(questions: any[], answers: string[][]) {
  return answers.map((answer, index) => {
    const options = questions[index]?.options?.map((option: any) => option.label) || []
    if (!options.length) return answer
    return answer.filter((item) => options.includes(item)).length ? answer : [options[0]]
  })
}

function readErrorMessage(error: any) {
  if (!error) return "运行失败"
  if (typeof error === "string") return error
  return error.data?.message || error.message || error.name || JSON.stringify(error)
}
