import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"
import { SessionCompaction } from "@/session/compaction"
import { Provider } from "@/provider/provider"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { canonicalDataStageForWorkflow, getActiveWorkflowRun } from "@/runtime/workflow"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { Bus } from "@/bus"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  await Instance.disposeAll()
})

function completeTextStream(text: string) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "text-start", id: "compaction-text" }
    yield { type: "text-delta", id: "compaction-text", text }
    yield { type: "text-end", id: "compaction-text" }
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function completeToolStream(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "tool-input-start", id: toolCallId, toolName }
    yield { type: "tool-call", toolCallId, toolName, input }
    yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(visibleText).join("\n")
  if (value && typeof value === "object") return Object.values(value).map(visibleText).join("\n")
  return ""
}

function currentWorkflowLineage(sessionID: string) {
  const workflow = getActiveWorkflowRun(sessionID)
  const lineage = workflow ? canonicalDataStageForWorkflow(workflow) : null
  if (!lineage) throw new Error("Harness 没有从当前 workflow 恢复 canonical datasetId/stageId")
  return { datasetId: lineage.datasetId, stageId: lineage.stageId }
}

function toolResultText(messages: unknown, toolName: string) {
  if (!Array.isArray(messages)) return ""
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "tool") return []
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return []
    return content
      .filter((part) => part && typeof part === "object" &&
        (part as { type?: unknown }).type === "tool-result" &&
        (part as { toolName?: unknown }).toolName === toolName)
      .map((part) => visibleText((part as { output?: unknown }).output))
  }).join("\n")
}

function localVerifierStream() {
  return completeTextStream([
    "<verifier_result>",
    JSON.stringify({
      status: "pass",
      checks: [{ key: "compacted-did-ols", label: "did.xlsx OLS", status: "pass", message: "估计使用当前数据阶段与用户指定的 HC1 协方差。" }],
      blockingFindings: [], repairHints: [], trustedArtifacts: [],
      summary: "压缩后恢复的 OLS 结果已核验。", findings: [],
    }),
    "</verifier_result>",
  ].join("\n"))
}

const compactSummary = `<summary>
1. 主要请求和意图：导入并诊断 did.xlsx；本轮只检查 OLS 参数契约，用户明确说暂不运行估计器
2. 关键技术与计量概念：OLS、HC1 稳健标准误、Python Registry 参数 Schema
3. 文件、数据与代码位置：真实 did.xlsx 的 Data_可读 工作表已经导入
4. 错误、根因与修复：第一次 analysis_prepare 的 covariance=clustered 不属于 Schema 枚举，没有准备出可执行规格，也没有运行估计器；用户原定协方差是 HC1
5. 问题解决过程：完成导入、画像、质量检查和 OLS 方法搜索；参数检查错误已返回模型
6. 所有真实用户消息：导入 did.xlsx 并完成数据画像和质量检查，本轮先不做计量估计；按当前 OLS Registry Schema 检查参数、不运行估计器：因变量为高质量发展指数，核心解释变量为 did，控制人口规模、人均GDP、金融发展程度，协方差传 clustered；用户预定值是 HC1
7. 待完成任务：重新搜索 OLS Schema，按用户原定 HC1 完成只读规格预检；等待用户另行明确授权估计
8. 当前工作：数据阶段仍是已导入的 did.xlsx；参数预检曾因 covariance=clustered 被拒绝，尚无 OLS 结果
9. 可选下一步：展示 HC1 规格预检结果并询问是否执行，不改样本、变量或估计方法
</summary>`

describe("真实数据压缩后的工具与参数错误恢复", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("did.xlsx：压缩后重载 OLS Schema，修复参数并完成真实估计", async () => {
    if (!process.env.KILLSTATA_PYTHON) {
      throw new Error("该真实数据压缩恢复回放要求显式设置 KILLSTATA_PYTHON")
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-did-compact-recovery-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)

    let phase: "prepare-data" | "schema-error" | "after-compact" | "approved-execute" = "prepare-data"
    let phaseRound = 0
    let afterCompactRound = 0
    let approvedExecuteRound = 0
    let approvedExecuteNeedsSchemaReload = false
    let failureReachedModel = false
    let preCompactLineage: { datasetId: string; stageId: string } | undefined
    let restoredLineage: { datasetId: string; stageId: string } | undefined
    let compactedFailureAndGoalVisible = false
    let schemaReloadedAfterCompact = false
    let compactionRequests = 0
    const requestKinds: string[] = []
    const verifierSessionIDs = new Set<string>()
    const idleVerifierSessionIDs = new Set<string>()

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const activeAnalysisTask = () => {
          const ledger = RuntimeTaskLedger.listTasks(session.id)
          return ledger.tasks.find((item) => item.taskId === ledger.activeTaskId && item.analysisRequest)
        }
        const unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
          const info = event.properties.info
          if (info.parentID === session.id && info.title.startsWith("工作流核验 - ")) verifierSessionIDs.add(info.id)
        })
        const unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (verifierSessionIDs.has(event.properties.sessionID) && event.properties.status.type === "idle") {
            idleVerifierSessionIDs.add(event.properties.sessionID)
          }
        })
        const waitForVerifiers = async () => {
          const deadline = Date.now() + 15_000
          while (Date.now() < deadline && (
            verifierSessionIDs.size === 0 ||
            [...verifierSessionIDs].some((id) => !idleVerifierSessionIDs.has(id))
          )) await new Promise((resolve) => setTimeout(resolve, 25))
          if (verifierSessionIDs.size === 0 || [...verifierSessionIDs].some((id) => !idleVerifierSessionIDs.has(id))) {
            const task = activeAnalysisTask()
            const messages = await Session.messages({ sessionID: session.id })
            const toolStates = messages.filter((message) => message.info.role === "assistant")
              .flatMap((message) => message.parts)
              .filter((part): part is MessageV2.ToolPart => part.type === "tool")
              .map((part) => ({ tool: part.tool, input: part.state.input, status: part.state.status,
                error: part.state.status === "error" ? part.state.error : undefined,
                output: part.state.status === "completed" ? String(part.state.output).slice(0, 180) : undefined }))
            throw new Error(`本地 OLS verifier 子会话未收尾：sessions=${JSON.stringify([...verifierSessionIDs])} idle=${JSON.stringify([...idleVerifierSessionIDs])} requests=${requestKinds.join(" | ")} taskMeta=${JSON.stringify({ intent: task?.metadata?.intent, required: task?.metadata?.requiredToolIDs, activeTaskId: RuntimeTaskLedger.listTasks(session.id).activeTaskId })} lifecycle=${JSON.stringify(task?.analysisLifecycle)} tools=${JSON.stringify(toolStates)}`)
          }
        }

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          requestKinds.push(`${request.agent.name}:${request.contextPolicy ?? "default"}:${request.small ? "small" : "main"}:textOnly=${request.textOnly === true}`)
          if (request.agent.name === "verifier") return { fullStream: localVerifierStream() } as never
          if (request.contextPolicy === "compaction") {
            compactionRequests += 1
            return { fullStream: completeTextStream(compactSummary) } as never
          }
          if (request.small) return { fullStream: completeTextStream("did.xlsx OLS 参数恢复回放") } as never

          if (phase !== "after-compact" && phase !== "approved-execute") phaseRound += 1
          if (phase === "prepare-data") {
            if (phaseRound === 1) {
              return { fullStream: completeToolStream("data_import", "call_compact_import", {
                action: "import", inputPath: source, preserveLabels: true,
                sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
              }) } as never
            }
            const lineage = currentWorkflowLineage(session.id)
            if (phaseRound === 2) {
              preCompactLineage = lineage
              return { fullStream: completeToolStream("data_import", "call_compact_profile", { action: "profile", ...lineage }) } as never
            }
            if (phaseRound === 3) return { fullStream: completeToolStream("data_import", "call_compact_validate", { action: "validate", ...lineage }) } as never
            return { fullStream: completeTextStream("did.xlsx 已导入并完成画像与质量检查；当前尚未运行回归。") } as never
          }

          if (phase === "schema-error") {
            if (phaseRound === 1) return { fullStream: completeToolStream("tool_search", "call_compact_search_initial", { query: "ols_regression", limit: 1 }) } as never
            if (phaseRound === 2) {
              const task = activeAnalysisTask()
              if (!task?.analysisRequest) throw new Error("参数预检缺少当前 AnalysisRequest")
              return { fullStream: completeToolStream("analysis_prepare", "call_compact_ols_invalid", {
                requestId: task.analysisRequest.requestId,
                methodID: "ols_regression",
                arguments: {
                  dependentVar: "高质量发展指数",
                  treatmentVar: "did",
                  covariates: ["人口规模", "人均GDP", "金融发展程度"],
                  covariance: "clustered",
                },
              }) } as never
            }
            if (phaseRound === 3) {
              const errorText = toolResultText(request.messages, "analysis_prepare")
              failureReachedModel ||= /covariance|协方差/i.test(errorText) && errorText.length > 0
              return { fullStream: completeTextStream("OLS 参数校验失败；没有运行估计器，保留 HC1 用户设定。") } as never
            }
            return { fullStream: completeTextStream("当前仍未运行估计器。") } as never
          }

          if (phase === "after-compact") {
            afterCompactRound += 1
            const modelView = { system: request.system, messages: request.messages }
            const viewText = visibleText(modelView)
            if (afterCompactRound === 1) {
              compactedFailureAndGoalVisible = /clustered/.test(viewText) &&
                /高质量发展指数/.test(viewText) && /HC1/.test(viewText) && /不运行估计器/.test(viewText)
              restoredLineage = currentWorkflowLineage(session.id)
              return { fullStream: completeToolStream("tool_search", "call_compact_search_restored", { query: "ols_regression", limit: 1 }) } as never
            }
            if (afterCompactRound === 2) {
              const task = activeAnalysisTask()
              if (!task?.analysisRequest) throw new Error("压缩后规格重验缺少当前 AnalysisRequest")
              return { fullStream: completeToolStream("analysis_prepare", "call_compact_ols_repaired", {
                requestId: task.analysisRequest.requestId,
                methodID: "ols_regression",
                arguments: {
                  dependentVar: "高质量发展指数",
                  treatmentVar: "did",
                  covariates: ["人口规模", "人均GDP", "金融发展程度"],
                  covariance: "HC1",
                },
              }) } as never
            }
            if (afterCompactRound === 3) {
              schemaReloadedAfterCompact = /完整.*Schema|tool_search|重新搜索/i.test(toolResultText(request.messages, "analysis_prepare"))
              return { fullStream: completeToolStream("tool_search", "call_compact_search_after_not_sent", { query: "ols_regression", limit: 1 }) } as never
            }
            if (afterCompactRound === 4) {
              schemaReloadedAfterCompact = /参数 Schema/.test(viewText) &&
                /dependentVar/.test(viewText) && /covariance/.test(viewText)
              const task = activeAnalysisTask()
              if (!task?.analysisRequest) throw new Error("重新加载 OLS Schema 后缺少 AnalysisRequest")
              return { fullStream: completeToolStream("analysis_prepare", "call_compact_ols_repaired_after_search", {
                requestId: task.analysisRequest.requestId,
                methodID: "ols_regression",
                arguments: {
                  dependentVar: "高质量发展指数",
                  treatmentVar: "did",
                  covariates: ["人口规模", "人均GDP", "金融发展程度"],
                  covariance: "HC1",
                },
              }) } as never
            }
            if (afterCompactRound === 5) return { fullStream: completeTextStream("压缩后 HC1 参数预检通过，估计器仍未运行；如需现在估计，请明确确认。") } as never
            throw new Error(`压缩恢复后出现意外主模型轮次：${afterCompactRound}`)
          }

          if (phase === "approved-execute") {
            approvedExecuteRound += 1
            if (approvedExecuteRound === 1) return { fullStream: completeToolStream("tool_search", "call_compact_search_authorized", { query: "ols_regression", limit: 1 }) } as never
            if (approvedExecuteRound === 2) {
              const task = activeAnalysisTask()
              if (!task?.analysisRequest) throw new Error("用户授权的估计缺少新 AnalysisRequest")
              return { fullStream: completeToolStream("analysis_prepare", "call_compact_ols_authorized_prepare", {
                requestId: task.analysisRequest.requestId,
                methodID: "ols_regression",
                arguments: {
                  dependentVar: "高质量发展指数",
                  treatmentVar: "did",
                  covariates: ["人口规模", "人均GDP", "金融发展程度"],
                  covariance: "HC1",
                },
              }) } as never
            }
            if (approvedExecuteRound === 3) {
              approvedExecuteNeedsSchemaReload = /完整.*Schema|tool_search|重新搜索/i.test(toolResultText(request.messages, "analysis_prepare"))
              if (approvedExecuteNeedsSchemaReload) {
                return { fullStream: completeToolStream("tool_search", "call_compact_search_execute_after_not_sent", { query: "ols_regression", limit: 1 }) } as never
              }
              const prepared = activeAnalysisTask()?.preparedSpec
              if (!prepared || prepared.methodID !== "ols_regression") throw new Error("授权后 OLS 没有生成 PreparedSpec")
              return { fullStream: completeToolStream("econometrics_execute", "call_compact_ols_authorized_execute", { specId: prepared.specId }) } as never
            }
            if (approvedExecuteRound === 4) {
              if (approvedExecuteNeedsSchemaReload) {
                const task = activeAnalysisTask()
                if (!task?.analysisRequest) throw new Error("OLS Schema 恢复后缺少 AnalysisRequest")
                return { fullStream: completeToolStream("analysis_prepare", "call_compact_ols_authorized_prepare_after_search", {
                  requestId: task.analysisRequest.requestId,
                  methodID: "ols_regression",
                  arguments: {
                    dependentVar: "高质量发展指数",
                    treatmentVar: "did",
                    covariates: ["人口规模", "人均GDP", "金融发展程度"],
                    covariance: "HC1",
                  },
                }) } as never
              }
              return { fullStream: completeTextStream("你已明确授权，压缩恢复后按原定 HC1 完成 did.xlsx OLS。") } as never
            }
            if (approvedExecuteRound === 5) {
              const prepared = activeAnalysisTask()?.preparedSpec
              if (!prepared || prepared.methodID !== "ols_regression") throw new Error("重新加载 Schema 后 OLS 没有 PreparedSpec")
              return { fullStream: completeToolStream("econometrics_execute", "call_compact_ols_authorized_execute_after_search", { specId: prepared.specId }) } as never
            }
            if (approvedExecuteRound === 6) return { fullStream: completeTextStream("你已明确授权，压缩恢复后按原定 HC1 完成 did.xlsx OLS。") } as never
            throw new Error(`授权后 OLS 出现意外主模型轮次：${approvedExecuteRound}`)
          }
          throw new Error(`未知压缩恢复阶段：${phase}`)
        }))

        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: `导入 ${source} 并完成数据画像和质量检查，本轮先不做计量估计。` }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })

          phase = "schema-error"
          phaseRound = 0
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{
              type: "text",
              text: "请按当前 OLS Registry Schema 检查参数是否有效，不运行估计器：因变量为高质量发展指数，核心解释变量为 did，控制人口规模、人均GDP、金融发展程度，协方差传 clustered；用户预定值是 HC1。",
            }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })

          const beforeCompact = await Session.messages({ sessionID: session.id })
          const invalidCall = beforeCompact
            .flatMap((message) => message.info.role === "assistant" ? message.parts : [])
            .find((part): part is MessageV2.ToolPart =>
              part.type === "tool" && part.tool === "analysis_prepare" && part.state.status === "error",
            )
          if (!invalidCall || invalidCall.state.status !== "error") throw new Error("非法 covariance 没有形成可恢复的规格校验失败")
          expect(invalidCall.state.error).toMatch(/covariance|协方差/i)
          expect(failureReachedModel).toBe(true)
          expect(beforeCompact.flatMap((message) => message.info.role === "assistant" ? message.parts : [])
            .filter((part) => part.type === "tool" && part.tool === "econometrics_execute")).toHaveLength(0)
          await SessionCompaction.create({
            sessionID: session.id,
            agent: "analyst",
            model: { providerID: model.providerID, modelID: model.id },
            auto: true,
            reason: "threshold",
          })
          phase = "after-compact"
          afterCompactRound = 0
          phaseRound = 0
          // 走正式 dispatcher 处理 pending compaction 并在同一循环中续接主模型，
          // 不直接调用 process()，也不另开新用户轮次模拟“恢复”。
          await SessionPrompt.loop(session.id)

          const compactedMessages = await Session.messages({ sessionID: session.id })
          expect(compactedMessages.some((message) => message.parts.some((part) => part.type === "compaction-restore"))).toBe(true)
          const restoreText = compactedMessages
            .flatMap((message) => message.parts)
            .find((part): part is MessageV2.CompactionRestorePart => part.type === "compaction-restore")?.text ?? ""
          const activeWorkflowID = getActiveWorkflowRun(session.id)?.workflowRunId
          const activeTaskID = RuntimeTaskLedger.listTasks(session.id).activeTaskId
          expect(restoreText).toContain("工作流状态已恢复")
          for (const internalValue of [
            restoredLineage?.datasetId,
            restoredLineage?.stageId,
            activeWorkflowID,
            activeTaskID,
            root,
            source,
            ".killstata/datasets/",
            "activeStageId",
            "datasetId",
            "stageId",
            "workflowRunId",
          ].filter((value): value is string => Boolean(value))) {
            expect(restoreText).not.toContain(internalValue)
          }
          expect(compactionRequests).toBeGreaterThan(0)
          const persistedSummary = compactedMessages
            .findLast((message) => message.info.role === "assistant" && message.info.summary === true)
            ?.parts.filter((part): part is MessageV2.TextPart => part.type === "text")
            .map((part) => part.text).join("\n") ?? ""
          const compactionRestoreSource = compactedMessages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "compaction-restore")
            .findLast((part) => true)?.summarySource
          expect(compactionRestoreSource).toBe("model")
          expect(persistedSummary).toContain("主要请求和意图")
          expect(persistedSummary).toContain("协方差传 clustered")
          expect(persistedSummary).toContain("HC1")
          const preAuthorizationMessages = await Session.messages({ sessionID: session.id })
          const preparedAfterCompact = preAuthorizationMessages
            .flatMap((message) => message.info.role === "assistant" ? message.parts : [])
            .find((part): part is MessageV2.ToolPart => part.type === "tool" &&
              part.tool === "analysis_prepare" && part.state.status === "completed" &&
              part.state.input?.methodID === "ols_regression" &&
              part.state.metadata.analysisSpecStatus === "preflight_ready")
          if (!preparedAfterCompact) {
            const task = activeAnalysisTask()
            const preparationStates = preAuthorizationMessages
              .filter((message) => message.info.role === "assistant")
              .flatMap((message) => message.parts)
              .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "analysis_prepare")
              .map((part) => ({ input: part.state.input, status: part.state.status, error: part.state.status === "error" ? part.state.error : undefined, output: part.state.status === "completed" ? part.state.output : undefined, metadata: part.state.status === "completed" ? part.state.metadata : undefined }))
            throw new Error(`压缩后规格检查没有完成：round=${afterCompactRound}; request=${JSON.stringify(task?.analysisRequest)}; lifecycle=${JSON.stringify(task?.analysisLifecycle)}; prepared=${JSON.stringify(task?.preparedSpec)}; preparations=${JSON.stringify(preparationStates)}; requests=${requestKinds.join(" | ")}`)
          }
          expect(preAuthorizationMessages.flatMap((message) => message.info.role === "assistant" ? message.parts : [])
            .filter((part) => part.type === "tool" && part.tool === "econometrics_execute")).toHaveLength(0)
          expect(preAuthorizationMessages.flatMap((message) => message.info.role === "assistant" ? message.parts : [])
            .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
            .map((part) => part.text).join("\n"))
            .toContain("估计器仍未运行")

          phase = "approved-execute"
          approvedExecuteRound = 0
          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: "现在确认执行刚才已通过预检的 OLS；保持我原先指定的 HC1 协方差和全部变量不变。" }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })
          await waitForVerifiers()

          const finalMessages = await Session.messages({ sessionID: session.id })
          const toolParts = finalMessages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part): part is MessageV2.ToolPart => part.type === "tool")
          const executableSpecs = activeAnalysisTask()?.analysisSpecs?.filter((spec) =>
            spec.methodID === "ols_regression" && spec.status === "ready",
          ) ?? []
          const estimates = toolParts.filter((part) => part.tool === "econometrics_execute" &&
            executableSpecs.some((spec) => spec.specId === part.state.input?.specId))
          const completed = estimates.find((part) => part.state.status === "completed")
          if (!completed || completed.state.status !== "completed") {
            throw new Error(`压缩后修正的真实 OLS 没有完成；轮次=${afterCompactRound}；执行状态=${estimates.map((part) => part.state.status === "error" ? part.state.error : part.state.status).join(" | ")}；请求=${requestKinds.join(",")}`)
          }
          const result = completed.state.metadata.result as { method?: string; rowsUsed?: number; resultPath?: string; coefficientsPath?: string } | undefined
          const resultFile = typeof result?.resultPath === "string" ? path.resolve(root, result.resultPath) : ""
          const coefficientsFile = typeof result?.coefficientsPath === "string" ? path.resolve(root, result.coefficientsPath) : ""
          const visible = finalMessages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
            .map((part) => part.text)
            .join("\n")

          expect(compactedFailureAndGoalVisible).toBe(true)
          expect(compactionRequests).toBeGreaterThan(0)
          expect(restoredLineage).toEqual(preCompactLineage)
          expect(schemaReloadedAfterCompact).toBe(true)
          expect(estimates.map((part) => part.state.status)).toEqual(["completed"])
          expect(result).toMatchObject({ method: "ols_regression" })
          expect(result?.rowsUsed).toBeGreaterThan(4_000)
          expect(fs.existsSync(resultFile)).toBe(true)
          expect(fs.existsSync(coefficientsFile)).toBe(true)
          expect(visible).toContain("你已明确授权，压缩恢复后按原定 HC1 完成 did.xlsx OLS")
        } finally {
          unsubscribeCreated()
          unsubscribeStatus()
        }
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
