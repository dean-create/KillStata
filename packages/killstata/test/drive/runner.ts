/**
 * drive harness 场景执行器：模拟用户在隔离目录里跑一个真实会话（真实模型 + 真实数据 +
 * 真实工具链 + 真实 workflow 状态机），整轮结束后收集结构化诊断并跑场景行为断言。
 *
 * 复用 session-drive.ts 的核心模式（会话创建、权限预置、question 自动回复、超时取消、
 * 工具错误收集、stage 链收集），但按场景矩阵重构：每场景独立临时目录、每场景可自定义
 * 用户话术与断言、问题弹窗按场景策略回复。
 */
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { getActiveWorkflowRun } from "@/runtime/workflow"
import { MessageV2 } from "@/session/message-v2"
import type { StageNode, WorkflowRun } from "@/runtime/types"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { Question } from "@/question"
import { PermissionNext } from "@/permission/next"
import { Bus } from "@/bus"
import { RuntimeEvents } from "@/runtime/events"
import type { DriveScenario, DriveAssertion, ScenarioAssertionContext } from "./scenarios"
import { coreUxAssertions, driveRepoRoot } from "./scenarios"
import { driveOutcome } from "./compare"
import { filterRealErrors } from "./ux-checks"
import { isWorkflowEstimateTool } from "@/runtime/tool-catalog"
import { withTimeout } from "../helpers/with-timeout"
import { pruneDriveDiagnostics, writeDriveFailureDiagnostics } from "./diagnostics"

export interface RunOptions {
  /** 模型 id；裸 id 跟随当前配置 provider，完整 provider/model 可显式切换 provider。 */
  modelID?: string
  /** 推理档位；真实验证默认使用 medium，与当前 KillStata 默认配置一致。 */
  variant?: string
  /** 单轮硬超时（毫秒），默认 5 分钟 */
  timeoutMs?: number
  /**
   * question 自动回复策略：
   *   - "first-option"（默认）：每个问题选第一个选项（模拟用户快速确认）
   *   - "second-option" / "third-option"：选择对应选项（模拟用户改变数据或研究设计）
   *   - "none"：不自动回复（模拟无人工值守，Question 会挂起直到超时）
   */
  questionPolicy?: DriveQuestionPolicy
  /** 可选：按所有 Question 题目的全局序号指定选项下标，0-based；未指定时使用 questionPolicy。 */
  questionOptionIndexes?: number[]
  /** 失败诊断包的父目录；未传时写入 test/sandbox/drive-report/failures。 */
  diagnosticsRoot?: string
  /** 同一场景多次运行时用于区分诊断目录的名称。 */
  diagnosticsKey?: string
}

export type DriveQuestionPolicy = "first-option" | "second-option" | "third-option" | "none"

/** 把问题策略转换为一组可提交给 Question.reply 的答案；越界时保持未回答。 */
export function answerDriveQuestion(options: readonly string[], policy: DriveQuestionPolicy, optionIndex?: number): string[] {
  if (policy === "none") return []
  const index = optionIndex ?? (policy === "first-option" ? 0 : policy === "second-option" ? 1 : 2)
  return options[index] ? [options[index]!] : []
}

export interface ScenarioRunReport {
  scenarioID: string
  scenarioLabel: string
  pass: boolean
  /** 功能完成与零错误稳定性分别报告；旧 pass 保持功能完成语义。 */
  functionalPass?: boolean
  stabilityPass?: boolean
  recoveredErrors?: ScenarioRunReport["toolErrors"]
  unrecoveredErrors?: ScenarioRunReport["toolErrors"]
  timedOut: boolean
  questionCount: number
  /** question 弹窗内容（UX 提问质量断言用） */
  questionEvents: Array<{ prompt: string; options: string[] }>
  toolErrors: Array<{
    tool: string
    error: string
    reflection?: { failureType?: string; retryStage?: string; repairAction?: string }
  }>
  /** 会话级错误（例如 Provider 认证/配额失败）；与工具执行错误分开记录。 */
  sessionErrors?: string[]
  toolCalls: Array<{ tool: string; status: string; callID?: string; pattern?: string; args?: string; reused?: boolean; requiresUserDecision?: boolean }>
  activeStage: string | undefined
  stageChain: string[]
  latestFailure:
    | { code: string | undefined; toolName: string | undefined; retryStage: string | undefined; message: string }
    | undefined
  resultFiles: string[]
  /** 行为断言明细（含硬 pass 项；UX 断言带 category="ux"） */
  assertions: DriveAssertion[]
  elapsedMs: number
  /** 会话内模型所有用户可见文本（按时间序，完整文本；UX 报告质量/进度断言用） */
  assistantTexts: string[]
  /** 每轮用户可见文本（按轮次分组；多轮场景追问断言用） */
  turnTexts: string[][]
  /** 每轮工具调用（按轮次分组；多轮场景行为断言用） */
  turnToolCalls?: Array<Array<{ tool: string; status: string; args?: string; reused?: boolean }>>
  /** 最后一轮全部用户可见文本（多轮场景的"最终回答"） */
  lastTurnAssistantText: string
  /** 最后一段完整文本（报告质量断言用） */
  finalAssistantText: string
  /** 会话内模型最后一段用户可见文本（供人工复查） */
  assistantTail: string
  /** 最终模型 usage 汇总（来自实际 assistant message，不以模型自述为准）。 */
  usage?: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    estimatedCost: number
  }
  /** 本次运行的稳定 manifest，供 baseline/candidate 对照。 */
  manifest?: {
    schemaVersion: 1
    scenarioID: string
    modelID: string
    inputHash: string
    runKey: string
  }
  /** 失败时保留的有界诊断包路径；成功运行时为空。 */
  diagnosticsDir?: string
}

/** Drive 的 UX 断言必须覆盖本轮实际展示给用户的全部文本，不能把后续短停点误当作完整报告。 */
export function visibleTurnText(texts: string[]) {
  return texts.map((text) => text.trim()).filter(Boolean).join("\n")
}

/**
 * 多轮会话的异步 verifier 可能在下一轮收集时才落盘。它会携带原工具的 callID，
 * 因此按 tool+callID 去重，防止同一次 GF 导入/估计被报告成两次；没有 callID 的
 * 记录保持原样，避免错误合并两个独立调用。
 */
export function dedupeDriveToolCalls(calls: ScenarioRunReport["toolCalls"]): ScenarioRunReport["toolCalls"] {
  const seen = new Set<string>()
  return calls.filter((call) => {
    if (!call.callID) return true
    const key = `${call.tool}:${call.callID}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** MessageV2.stream 按最新到最旧返回；报告和场景断言按用户看到的时间顺序处理。 */
export function restoreChronologicalOrder<T>(items: readonly T[]): T[] {
  return [...items].reverse()
}

/** 只收集属于本轮用户消息的 assistant；没有 parentID 时保持旧调用方兼容。 */
export function belongsToPromptTurn(info: MessageV2.Info, parentID?: string): boolean {
  return !parentID || info.role !== "assistant" || info.parentID === parentID
}

/**
 * 找到本轮 prompt 的真实用户消息。执行过程中可能插入 synthetic user（例如子任务
 * 摘要），不能只取最后一个 user，否则会把本轮 assistant/tool 结果全部过滤掉。
 */
export function findPromptUserMessageID(messages: MessageV2.WithParts[], promptText: string) {
  const normalized = promptText.trim()
  const exact = messages.findLast(
    (message) =>
      message.info.role === "user" &&
      message.parts.some(
        (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim() === normalized,
      ),
  )
  return exact?.info.id ?? messages.findLast((message) => message.info.role === "user")?.info.id
}

/** 隔离目录内查找结果文件（results.json / coefficients.csv） */
function inputHash(scenario: DriveScenario, userMessages: string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    scenario: scenario.id,
    dataFile: scenario.dataFile,
    extraDataFiles: scenario.extraDataFiles ?? [],
    userMessages,
  })).digest("hex")
}

function usageFromMessages(messages: MessageV2.WithParts[]): ScenarioRunReport["usage"] {
  const totals = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0 }
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    totals.inputTokens += message.info.tokens.input
    totals.outputTokens += message.info.tokens.output
    totals.reasoningTokens += message.info.tokens.reasoning
    totals.cacheReadTokens += message.info.tokens.cache.read
    totals.cacheWriteTokens += message.info.tokens.cache.write
    totals.estimatedCost += message.info.cost
  }
  return totals
}

function findResultFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/results\.json$|coefficients\.csv$/.test(entry.name) && !p.includes("__snapshots__")) found.push(p)
    }
  }
  walk(root)
  return found
}

/** 行为回放只保留能证明数据变换/估计选择的参数，避免把所有工具输入写进报告。 */
export function shouldCaptureDriveToolArgs(toolName: string) {
  return (
    isWorkflowEstimateTool(toolName) ||
    toolName === "data_import" ||
    toolName === "data_preprocess" ||
    toolName === "composite_evaluation"
  )
}

/**
 * Provider 看到的是稳定的 econometrics_execute；drive 报告仍按真实方法归档，
 * 这样历史场景可以验证“执行了哪一种计量方法”，同时不破坏模型侧的稳定工具前缀。
 */
export function reportedDriveTool(toolName: string, input: Record<string, unknown>): string {
  if (toolName !== "econometrics_execute") return toolName
  return typeof input.methodID === "string" && input.methodID.trim().length > 0
    ? input.methodID.trim()
    : toolName
}

/** 从 Session.Event.Error 中提取稳定的用户可见错误，避免诊断只剩“无结果”。 */
export function reportedDriveSessionError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "未知会话错误")
  const record = error as { data?: unknown; message?: unknown; name?: unknown }
  if (record.data && typeof record.data === "object") {
    const data = record.data as { message?: unknown }
    if (typeof data.message === "string" && data.message.trim()) return data.message.trim()
  }
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim()
  return typeof record.name === "string" && record.name.trim() ? record.name.trim() : "未知会话错误"
}

/** 会话级 Provider 错误发生在工具链之前，必须阻断 Drive 验收，避免无工具调用假绿。 */
export function hasDriveSessionErrors(errors: readonly string[] | undefined): boolean {
  return (errors?.length ?? 0) > 0
}

function reportedDriveToolInput(toolName: string, input: Record<string, unknown>) {
  if (toolName === "econometrics_execute" && input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)) {
    return input.arguments as Record<string, unknown>
  }
  return input
}

function capturedToolArgs(toolName: string, input: Record<string, unknown>) {
  // data_import 的 sheetPolicy 位于参数后半段；200 字符会在 named_sheet 的
  // sheetName 中间截断，造成真实调用成功但场景断言假阴性。完整保留结构化参数，
  // 仅把路径折叠为 basename，避免诊断包泄漏临时目录或用户路径。
  if (toolName === "data_import") {
    const copy = { ...input }
    for (const key of ["inputPath", "outputPath", "directResultPath"]) {
      if (typeof copy[key] === "string") copy[key] = path.basename(copy[key] as string)
    }
    return JSON.stringify(copy)
  }
  return JSON.stringify(input).slice(0, 800)
}

/** 收集一轮 prompt 后新增的消息（工具调用 / 文本 / 游标推进）。
 *
 * MessageV2.stream 倒序 yield（Storage.list 升序后逆序，最新→最旧）。
 * 因此游标边界一旦命中，更旧的消息都已在之前轮次收过——**break** 而非 continue，
 * 避免每轮把整段历史再 get() 一遍（N 轮 O(N²) 文件读，2026-08-12 simplify）。
 * 同理，第一条处理到的消息（最新）即本轮最大 ID，直接作为下一轮游标。 */
async function collectTurn(
  sessionID: string,
  cursorID: string | undefined,
  promptParentID?: string,
): Promise<{
  toolCalls: ScenarioRunReport["toolCalls"]
  toolErrors: ScenarioRunReport["toolErrors"]
  turnText: string[]
  cursorID: string | undefined
}> {
  type TurnChunk = {
    toolCalls: ScenarioRunReport["toolCalls"]
    toolErrors: ScenarioRunReport["toolErrors"]
    turnText: string[]
  }
  const chunks: TurnChunk[] = []
  let nextCursorID = cursorID
  for await (const msg of MessageV2.stream(sessionID)) {
    if (cursorID !== undefined && msg.info.id <= cursorID) break
    if (!belongsToPromptTurn(msg.info, promptParentID)) continue
    if (nextCursorID === undefined) nextCursorID = msg.info.id
    const toolCalls: ScenarioRunReport["toolCalls"] = []
    const toolErrors: ScenarioRunReport["toolErrors"] = []
    const turnText: string[] = []
    for (const part of msg.parts) {
      if (part.type === "tool") {
        // 记录 glob 的 pattern（越权断言用：判断是否在工作目录找数据文件）
        const input = (part.state.input ?? {}) as Record<string, unknown>
        const reportedToolName = reportedDriveTool(part.tool ?? "unknown", input)
        const capturedInput = reportedDriveToolInput(part.tool ?? "unknown", input)
        toolCalls.push({
          tool: reportedToolName,
          status: part.state.status,
          callID: part.callID,
          pattern: reportedToolName === "glob" && typeof input.pattern === "string" ? input.pattern : undefined,
          // 估计器和数据变换记录参数（截断）：行为断言需要证明模型真的用了新变量、新阶段或
          // 明确方法；不记录 workflow/read 等无关输入，避免诊断报告膨胀或带入敏感内容。
          args:
            shouldCaptureDriveToolArgs(reportedToolName)
              ? capturedToolArgs(reportedToolName, capturedInput)
              : undefined,
          reused:
            "metadata" in part.state && typeof part.state.metadata === "object" && part.state.metadata?.reused === true,
          requiresUserDecision:
            "metadata" in part.state &&
            typeof part.state.metadata === "object" &&
            part.state.metadata?.requiresUserDecision === true,
        })
        if (part.state.status === "error") {
          const meta = (part.state.metadata ?? {}) as {
            reflection?: { failureType?: string; retryStage?: string; repairAction?: string }
            skippedAfterPriorToolFailure?: boolean
            skippedAfterUserDecision?: boolean
          }
          if (meta.skippedAfterPriorToolFailure === true || meta.skippedAfterUserDecision === true) continue
          toolErrors.push({
            tool: reportedToolName,
            error: String(part.state.error ?? "").slice(0, 300),
            ...(meta.reflection
              ? {
                  reflection: {
                    failureType: meta.reflection.failureType,
                    retryStage: meta.reflection.retryStage,
                    repairAction: meta.reflection.repairAction,
                  },
                }
              : {}),
          })
        }
      } else if (part.type === "text" && msg.info.role === "assistant") {
        // 收集模型所有用户可见文本（完整文本，UX 报告质量/进度断言用）。
        // 只收 assistant 回复——user 消息（话术原文）含路径/数字会污染报告质量断言。
        const text = String(part.text ?? "")
        if (text.trim()) turnText.push(text)
      }
    }
    chunks.push({ toolCalls, toolErrors, turnText })
  }
  const ordered = restoreChronologicalOrder(chunks)
  return {
    toolCalls: ordered.flatMap((chunk) => chunk.toolCalls),
    toolErrors: ordered.flatMap((chunk) => chunk.toolErrors),
    // TurnAssembler 已在消息落盘前完成用户文本净化；这里必须读取持久化结果，不能二次净化。
    turnText: ordered.flatMap((chunk) => chunk.turnText),
    cursorID: nextCursorID,
  }
}

/**
 * 跑一个场景：在独立临时目录创建真实会话、发用户消息、等整轮完成、收集诊断、跑断言。
 * 目录与产物在 finally 清理，不污染主项目。
 */
export async function runScenario(scenario: DriveScenario, options: RunOptions = {}): Promise<ScenarioRunReport> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000
  const variant = options.variant ?? "medium"
  const questionPolicy = options.questionPolicy ?? "first-option"
  const diagnosticsRoot = options.diagnosticsRoot ?? path.join(process.cwd(), "test", "sandbox", "drive-report", "failures")
  const diagnosticsKey = options.diagnosticsKey ?? `${scenario.id}-${Date.now()}`
  const started = Date.now()

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `killstata-drive-${scenario.id}-`))
  let timedOut = false
  let questionCount = 0
  const questionEvents: Array<{ prompt: string; options: string[] }> = []
  let report: ScenarioRunReport
  let sessionID: string | undefined

  try {
    report = await Instance.provide({
      directory: tmpRoot,
      fn: async () => {
        // 1. 准备数据：dataFile / extraDataFiles 复制到隔离目录（不碰主项目 .killstata）
        // test/drive/ → dirname=test/ → ../../.. = 项目根 KillStata-main
        const copyDataFile = (name: string): string => {
          const source = path.join(driveRepoRoot(), "data", name)
          if (!fs.existsSync(source)) throw new Error(`数据文件不存在：${source}`)
          const dest = path.join(tmpRoot, name)
          fs.copyFileSync(source, dest)
          return dest
        }
        let dataPath: string | undefined
        if (scenario.dataFile) dataPath = copyDataFile(scenario.dataFile)
        const extraDataPaths = (scenario.extraDataFiles ?? []).map(copyDataFile)

        // 2. 创建会话：全权限（模拟"用户已始终允许"），避免权限弹窗在无 TUI 时挂起
        const session = await Session.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        sessionID = session.id
        // analyst 的 data_import 计划审批预置为已批准（自动化无人工回答）
        AnalysisIntent.markAnalystPlanApproval(session.id, true)

        // 3. question 自动回复（可关）：默认选第一个选项，也可选第二/第三项模拟用户分支；
        // 记录事件内容供 UX 提问质量断言
        let questionOrdinal = 0
        const unsubscribe = Bus.subscribe(Question.Event.Asked, (event) => {
          questionCount += 1
          const request = event.properties
          questionEvents.push({
            prompt: String(request.questions[0]?.question ?? request.questions[0]?.header ?? ""),
            options: (request.questions[0]?.options ?? []).map((o) => String(o.label ?? "")),
          })
          if (questionPolicy === "none") return
          const answers = request.questions.map((q) =>
            answerDriveQuestion(
              q.options.map((option) => String(option.label ?? "")),
              questionPolicy,
              options.questionOptionIndexes?.[questionOrdinal++],
            ),
          )
          Question.reply({ requestID: request.id, answers }).catch(() => {})
        })
        // 权限弹窗自动回复：会话虽预置全权限，但 external_directory（读 .killstata/
        // 下 reports/audit 等内部产物）不在 safetyCheck 的 read 白名单里，会被 ask 拦下；
        // 自动化无人值守，弹窗会永久挂起直到超时（2026-08-10 drive did-direct 实测：
        // 模型读 reports 触发 permission.asked 后无 TUI 可答）。模拟"用户这次允许"。
        // 用 "once" 而非 "always"：always 分支会 Storage.write 把规则持久化进真实项目的
        // permission/<projectID>.json——drive 是临时隔离会话，不该污染用户权限文件
        //（2026-08-11 review F4）。once 只 resolve 当前弹窗，不落盘。
        const unsubscribePermission = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          const request = event.properties as { id: string }
          PermissionNext.reply({ requestID: request.id, reply: "once" }).catch(() => {})
        })
        const toolProgress: string[] = []
        const sessionErrors: string[] = []
        const unsubscribeSessionError = Bus.subscribe(Session.Event.Error, (event) => {
          if (event.properties.sessionID !== session.id) return
          const message = reportedDriveSessionError(event.properties.error)
          if (!sessionErrors.includes(message)) sessionErrors.push(message)
        })
        const unsubscribeProgress = Bus.subscribe(RuntimeEvents.ToolProgress, (event) => {
          const properties = event.properties as { sessionID?: unknown; message?: unknown }
          if (properties.sessionID === session.id && typeof properties.message === "string") {
            toolProgress.push(properties.message)
          }
        })

        // 4. 逐轮发用户消息并等待整轮完成（每轮独立超时；超时 cancel 后停止后续轮）
        const userMessages = scenario.userMessages
          ? scenario.userMessages(dataPath, extraDataPaths)
          : scenario.userMessage
            ? [scenario.userMessage(dataPath, extraDataPaths)]
            : []
        if (userMessages.length === 0) throw new Error(`场景 ${scenario.id} 未定义 userMessage/userMessages`)
        const model = await Provider.resolveModel(options.modelID)
        const modelRef = { providerID: model.providerID, modelID: model.id }
        const toolErrors: ScenarioRunReport["toolErrors"] = []
        const toolCalls: ScenarioRunReport["toolCalls"] = []
        const turnTexts: string[][] = []
        const turnToolCalls: ScenarioRunReport["turnToolCalls"] = []
        // 消息 ID 游标：MessageV2.stream 每轮全量流，用 ID 增量收集避免跨轮重复。
        // 不能用计数游标——消息落盘是异步的，turn0 尾部消息可能晚于 prompt resolve
        // 才可读，计数会错位（2026-08-11 实测：turn1 的 delta 拿到 turn0 首条复述，
        // 多轮追问断言全部误判）。消息 ID 是 ascending 单调时间序，字符串比较可靠。
        let cursorID: string | undefined
        try {
          for (const message of userMessages) {
            try {
              await withTimeout(
                SessionPrompt.prompt({
                  sessionID: session.id,
                  parts: [{ type: "text", text: message }],
                    model: modelRef,
                    agent: "analyst",
                    variant,
                }),
                timeoutMs,
                () => {
                  timedOut = true
                  try {
                    SessionPrompt.cancel(session.id, new Session.TimeoutError(session.id, timeoutMs))
                  } catch {
                    // cancel 失败也要判超时
                  }
                },
              )
            } catch (error) {
              if (!timedOut) throw error
            }
            const currentUserMessageID = findPromptUserMessageID(
              await Session.messages({ sessionID: session.id }),
              message,
            )
            // 5. 收集本轮新增消息（工具调用全局累计；文本按轮分组）
            const collected = await collectTurn(session.id, cursorID, currentUserMessageID)
            cursorID = collected.cursorID
            toolCalls.push(...collected.toolCalls)
            toolErrors.push(...collected.toolErrors)
            turnTexts.push(collected.turnText)
            turnToolCalls.push(
              dedupeDriveToolCalls(collected.toolCalls).map(({ tool, status, args, reused, requiresUserDecision }) => ({
                tool,
                status,
                args,
                reused,
                requiresUserDecision,
              })),
            )
            if (timedOut) break
          }
        } finally {
          // 取消自动回复订阅：无论正常结束还是 prompt 抛错（API/配额错误走 catch
          // 重抛）都必须释放，否则 Bus 订阅泄漏、question/permission 弹窗无人应答
          //（2026-08-12 review 发现：重构前在 finally，重构后误移到循环外）。
          unsubscribe()
          unsubscribePermission()
          unsubscribeSessionError()
          unsubscribeProgress()
        }
        const assistantTexts = turnTexts.flat()
        const runManifest = {
          schemaVersion: 1 as const,
          scenarioID: scenario.id,
          modelID: model.id,
          inputHash: inputHash(scenario, userMessages),
          runKey: diagnosticsKey,
        }

        const run = getActiveWorkflowRun(session.id)
        const results = findResultFiles(tmpRoot).filter((p) => p.startsWith(tmpRoot))

        // 6. 构造断言上下文并跑场景行为断言
        // 多轮场景的"最终回答"是**最后一轮**（用户追问/改需求后关心的最新回答）。
        // 同一轮的多段 assistant 文本都会展示给用户；不能只取最长一段，否则后续的
        // 简短停点会遮住此前已经说清的研究前提，或反过来掩盖已展示的终止说明。
        const lastTurn = turnTexts[turnTexts.length - 1] ?? []
        const lastTurnAssistantText = visibleTurnText(lastTurn)
        const finalAssistantText = lastTurnAssistantText
        const uniqueToolCalls = dedupeDriveToolCalls(toolCalls)
        const ctx: ScenarioAssertionContext = {
          toolCalls: uniqueToolCalls,
          toolErrors,
          sessionErrors,
          timedOut,
          run,
          resultFiles: results,
          questionCount,
          questionEvents,
          assistantText: assistantTexts.join("\n"),
          assistantTexts,
          toolProgress,
          turnTexts,
          turnToolCalls,
          lastTurnAssistantText,
          finalAssistantText,
        }

        const assertions = [...scenario.behavior(ctx), ...coreUxAssertions(scenario.id, ctx)]
        const estimateCompleted = (run?.stages ?? []).some(
          (s: StageNode) => s.kind === "baseline_estimate" && s.status === "completed",
        )
        // 硬 pass 的"无工具错误"判定集中在 ux-checks.ts 的 filterRealErrors：
        // 设计内防护（门禁/read 保护/REPAIR 守卫/unavailable/QA gate）不是系统 bug；
        // ENOENT 只豁免文件系统探索工具（read/list/glob 猜路径），data_import/估计器/
        // verifier 的 ENOENT 一律算失败（路径解析真断，F3 回归保护）。白名单对**所有**
        // 场景一致生效，不按估计完成分叉（F5 修复）——core 语义：drive 测的是"用户能否
        // 完成分析"，不是"模型一步不错"，设计内防护不是失败。详见 ux-checks.ts 注释。
        const realErrors = filterRealErrors(toolErrors, {
          questionCount,
          questionEvents,
          toolCalls,
          estimateCompleted,
          assistantText: assistantTexts.join("\n"),
        })
        const errorFree = realErrors.length === 0
        // 未超时；估计场景还要 estimate completed + 结果文件（追问类场景不要求）
        assertions.unshift(
          { label: "无工具错误（含门禁/保护判定）", pass: errorFree, detail: JSON.stringify(realErrors.map((e) => e.error.slice(0, 120))) },
          { label: "无会话级 Provider 错误", pass: !hasDriveSessionErrors(sessionErrors), detail: sessionErrors.join(" | ") },
          { label: "未超时", pass: !timedOut, detail: `timedOut=${timedOut}` },
        )
        if (scenario.expectEstimate !== false) {
          assertions.push(
            { label: "baseline_estimate 完成", pass: estimateCompleted, detail: `activeStage=${run?.activeStage}` },
            { label: "产出结果文件", pass: results.length > 0, detail: results.map((p) => path.relative(tmpRoot, p)).join(",") },
          )
        }
        const outcome = driveOutcome({
          assertions,
          toolErrors,
          unrecoveredErrors: realErrors,
          sessionErrors,
        })
        const pass = outcome.functionalPass

        const resultReport: ScenarioRunReport = {
          scenarioID: scenario.id,
          scenarioLabel: scenario.label,
          pass,
          ...outcome,
          timedOut,
          questionCount,
          questionEvents,
          toolErrors,
          sessionErrors,
          toolCalls: uniqueToolCalls,
          activeStage: run?.activeStage,
          stageChain: (run?.stages ?? []).map((s: StageNode) => `${s.kind}=${s.status}(${s.toolName ?? "?"})`),
          latestFailure: run?.latestFailure
            ? {
                code: run.latestFailure.code,
                toolName: run.latestFailure.toolName,
                retryStage: run.latestFailure.retryStage,
                message: String(run.latestFailure.message).slice(0, 200),
              }
            : undefined,
          resultFiles: results.map((p) => path.relative(tmpRoot, p)),
          assertions,
          elapsedMs: Date.now() - started,
          assistantTexts,
          turnTexts,
          turnToolCalls,
          lastTurnAssistantText,
          finalAssistantText,
          assistantTail: assistantTexts.slice(-3).join("\n"),
          usage: usageFromMessages(await Session.messages({ sessionID: session.id })),
          manifest: runManifest,
        }
        if (!resultReport.pass || resultReport.timedOut) {
          const outputDir = path.join(diagnosticsRoot, diagnosticsKey.replace(/[^A-Za-z0-9._-]/g, "_") || "run")
          try {
            await writeDriveFailureDiagnostics({
              outputDir,
              scenario,
              sessionID: session.id,
              report: resultReport,
            })
            pruneDriveDiagnostics(diagnosticsRoot)
            resultReport.diagnosticsDir = path.relative(process.cwd(), outputDir)
          } catch (error) {
            console.warn(`[drive] failure diagnostics unavailable: ${String(error)}`)
          }
        }
        return resultReport
      },
    })
  } catch (error) {
    try {
      const outputDir = path.join(diagnosticsRoot, diagnosticsKey.replace(/[^A-Za-z0-9._-]/g, "_") || "run")
      await writeDriveFailureDiagnostics({ outputDir, scenario, sessionID, error })
      pruneDriveDiagnostics(diagnosticsRoot)
    } catch (diagnosticError) {
      console.warn(`[drive] failure diagnostics unavailable: ${String(diagnosticError)}`)
    }
    throw error
  } finally {
    // 一个进程内连续跑多个真实场景时，Instance 不会由 provide 自动销毁；如果只删
    // 临时目录，Provider 请求、队列状态和延迟 verifier 仍可能持有句柄，表现为
    // “会话已经 idle，但 drive 进程不退出”。先在实例上下文内 abort/清空所有运行态，
    // 再删除目录，避免后台任务继续访问已经不存在的工作区。
    await Instance.provide({
      directory: tmpRoot,
      fn: async () => {
        await Instance.dispose()
      },
    }).catch(() => {})
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      // 清理失败不阻塞报告
    }
  }
  return report
}
