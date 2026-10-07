import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { readStoredDataReadinessState } from "@/runtime/data-readiness"
import { setAnalysisPlanApproval } from "@/runtime/workflow"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { Question } from "@/question"
import { MessageV2 } from "@/session/message-v2"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"
import { readDatasetManifest } from "@/tool/analysis-state"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  await Instance.disposeAll()
})

function completeTextStream(text: string) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "text-start" }
    yield { type: "text-delta", text }
    yield { type: "text-end" }
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

function completeToolBatchStream(calls: Array<{ toolName: string; toolCallId: string; input: Record<string, unknown> }>) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    for (const call of calls) {
      yield { type: "tool-input-start", id: call.toolCallId, toolName: call.toolName }
      yield { type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }
    }
    yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
    yield { type: "finish" }
  })()
}

function modelVisibleText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(modelVisibleText).join("\n")
  if (value && typeof value === "object") return Object.values(value).map(modelVisibleText).join("\n")
  return ""
}

function latestToolResultText(messages: unknown, toolName: string) {
  if (!Array.isArray(messages)) return ""
  const results = messages.flatMap((message) => {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "tool") return []
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return []
    return content
      .filter((part) => part && typeof part === "object" &&
        (part as { type?: unknown }).type === "tool-result" &&
        (part as { toolName?: unknown }).toolName === toolName)
      .map((part) => modelVisibleText((part as { output?: unknown }).output))
  })
  return results.at(-1) ?? ""
}

function localPanelVerifierStream() {
  return completeTextStream([
    "<verifier_result>",
    JSON.stringify({
      status: "pass",
      checks: [{ key: "test-datasets-panel-fe", label: "复合键 Panel FE 产物", status: "pass", message: "估计使用当前复合实体 stage 与用户确认的变量规格。" }],
      blockingFindings: [],
      repairHints: [],
      trustedArtifacts: [],
      summary: "本地脚本化复合键 Panel FE 核验完成。",
      findings: [],
    }),
    "</verifier_result>",
  ].join("\n"))
}

function visibleAssistantText(messages: MessageV2.WithParts[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
}

function activeAnalysisRequestID(sessionID: string) {
  const ledger = RuntimeTaskLedger.listTasks(sessionID)
  const requestId = ledger.tasks.find((task) => task.taskId === ledger.activeTaskId)?.analysisRequest?.requestId
  if (!requestId) throw new Error("脚本模型未找到当前 AnalysisRequest")
  return requestId
}

function activePreparedSpecID(sessionID: string) {
  const ledger = RuntimeTaskLedger.listTasks(sessionID)
  const specId = ledger.tasks.find((task) => task.taskId === ledger.activeTaskId)?.preparedSpec?.specId
  if (!specId) throw new Error("脚本模型未找到当前已准备规格")
  return specId
}

describe("test_datasets.xlsx 稳定计量工具真实会话", () => {
  test.skipIf(!hasLocalRealData("test_datasets.xlsx"))(
    "重复地区年份经已授权复合键修复后完成 Panel FE，并经异质性工具分析全部省份",
    async () => {
      if (!process.env.KILLSTATA_PYTHON) {
        throw new Error("该真实数据工具回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python Registry 执行")
      }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-composite-panel-"))
      const source = path.join(root, "test_datasets.xlsx")
      fs.copyFileSync(localRealDataPath("test_datasets.xlsx"), source)

      let mainRound = 0
      let verifierSessionID: string | undefined
      let verifierCompleted!: () => void
      const verifierCompletedPromise = new Promise<void>((resolve) => { verifierCompleted = resolve })
      let verifierTimeout: ReturnType<typeof setTimeout> | undefined
      let methodSchemaVisible = false
      let readinessRepairReachedNextTurn = false
      let stableToolsAtSearch: string[] = []
      let heterogeneityToolVisible = false
      let heterogeneitySchemaVisible = false
      let heterogeneityApprovalPersisted = false
      let heterogeneitySummaryReachedModel = false
      let heterogeneitySummaryText = ""
      const requestedTools: string[] = []
      const userQuestions: string[] = []

      try {
        await Instance.provide({ directory: root, fn: async () => {
          const session = await Session.create({
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
          const unsubscribeCreated = Bus.subscribe(Session.Event.Created, (event) => {
            const info = event.properties.info
            if (info.parentID === session.id && info.title.startsWith("工作流核验 - ")) verifierSessionID = info.id
          })
          const unsubscribeStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
            if (event.properties.sessionID === verifierSessionID && event.properties.status.type === "idle") {
              verifierCompleted()
            }
          })
          const unsubscribeQuestion = Bus.subscribe(Question.Event.Asked, (event) => {
            userQuestions.push(String(event.properties.questions[0]?.question ?? ""))
            Question.reply({
              requestID: event.properties.id,
              answers: [["我已明确授权使用省份+地区作为复合个体键，保留全部观测继续同一面板固定效应。"]],
            }).catch(() => {})
          })

          spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
          if (request.agent.name === "verifier") return { fullStream: localPanelVerifierStream() } as never
          if (request.small) return { fullStream: completeTextStream("本地会话摘要") } as never
          if (request.textOnly === true) {
            const history = await Session.messages({ sessionID: session.id })
            const completedBaseline = history.some((message) => message.parts.some((part) =>
              part.type === "tool" &&
              part.tool === "econometrics_execute" &&
              part.state.status === "completed" &&
              (part.state.metadata.result as { success?: unknown } | undefined)?.success === true,
            ))
            const completedHeterogeneity = history.some((message) => message.parts.some((part) =>
              part.type === "tool" && part.tool === "heterogeneity_runner" && part.state.status === "completed",
            ))
            if (completedHeterogeneity) {
              heterogeneitySummaryText = latestToolResultText(request.messages, "heterogeneity_runner")
              heterogeneitySummaryReachedModel = heterogeneitySummaryText.includes("异质性分析部分完成") &&
                Number(heterogeneitySummaryText.match(/成功规格：(\d+)/)?.[1]) > 0 &&
                Number(heterogeneitySummaryText.match(/失败或跳过规格：(\d+)/)?.[1]) > 0
            }
            if (completedBaseline && !completedHeterogeneity && !heterogeneityApprovalPersisted) {
              // 模拟用户在基准完成后明确批准已在请求中说明的批量异质性扩展。
              const run = setAnalysisPlanApproval({ sessionID: session.id, approvalStatus: "approved" })
              heterogeneityApprovalPersisted = run.approvalStatus === "approved"
            }
            return { fullStream: completeTextStream(completedHeterogeneity
              ? "已按省份完成全部可用分组的异质性分析，保留成功、失败和跳过状态；结果只作条件关联解释。"
              : completedBaseline
                ? "复合实体键 Panel FE 基准已完成，正在继续用户明确要求的省份异质性分析。"
                : "当前回合只整理已完成进度，不调用工具。") } as never
          }

          mainRound += 1
            const text = modelVisibleText(request.messages)
            if (mainRound === 1) {
              requestedTools.push("data_import:import")
              return { fullStream: completeToolStream("data_import", "call_composite_import", {
                action: "import",
                inputPath: source,
                preserveLabels: true,
                sheetPolicy: { mode: "named_sheet", sheetName: "Sheet1" },
              }) } as never
            }
            if (mainRound === 2) {
              requestedTools.push("data_import:profile:source")
              return { fullStream: completeToolStream("data_import", "call_composite_profile_source", { action: "profile" }) } as never
            }
            if (mainRound === 3) {
              requestedTools.push("data_import:validate:source")
              return { fullStream: completeToolStream("data_import", "call_composite_validate_source", { action: "validate" }) } as never
            }
            if (mainRound === 4) {
              requestedTools.push("tool_search:panel_fe_regression")
              stableToolsAtSearch = Object.keys(request.tools?.definitions ?? {})
              return { fullStream: completeToolStream("tool_search", "call_composite_panel_search", {
                query: "panel_fe_regression",
                limit: 1,
              }) } as never
            }
            if (mainRound === 5) {
              requestedTools.push("analysis_prepare:panel_fe_duplicate_key")
              methodSchemaVisible = text.includes("参数 Schema：") &&
                text.includes('"entityVar"') && text.includes('"timeVar"')
              return { fullStream: completeToolStream("analysis_prepare", "call_composite_panel_source_key", {
                requestId: activeAnalysisRequestID(request.sessionID),
                methodID: "panel_fe_regression",
                arguments: {
                  dependentVar: "数字普惠金融指数",
                  treatmentVar: "每百人互联网用户数",
                  covariates: [],
                  entityVar: "地区",
                  timeVar: "年份",
                  covariance: "clustered",
                },
              }) } as never
            }
            if (mainRound === 6) {
              const readinessResult = latestToolResultText(request.messages, "analysis_prepare")
              readinessRepairReachedNextTurn =
                /combine_columns|省份.*地区|复合实体/.test(readinessResult) && /重复/.test(readinessResult)
              if (!readinessRepairReachedNextTurn) {
                throw new Error(`Panel FE preflight feedback did not reach the authorized repair turn: ${readinessResult}`)
              }
              requestedTools.push("data_preprocess:combine_columns")
              return { fullStream: completeToolStream("data_preprocess", "call_composite_key", {
                method: "combine_columns",
                columns: ["省份", "地区"],
                options: { output_column: "省份_地区", separator: "_" },
              }) } as never
            }
            if (mainRound === 7) {
              requestedTools.push("data_import:profile:composite")
              return { fullStream: completeToolStream("data_import", "call_composite_profile_new", { action: "profile" }) } as never
            }
            if (mainRound === 8) {
              requestedTools.push("data_import:validate:composite")
              return { fullStream: completeToolStream("data_import", "call_composite_validate_new", { action: "validate" }) } as never
            }
            if (mainRound === 9) {
              requestedTools.push("tool_search:panel_fe_composite_key")
              return { fullStream: completeToolStream("tool_search", "call_composite_panel_search_new", {
                query: "panel_fe_regression",
                limit: 1,
              }) } as never
            }
            if (mainRound === 10) {
              requestedTools.push("analysis_prepare:panel_fe_composite_key")
              return { fullStream: completeToolStream("analysis_prepare", "call_composite_panel_prepare_new", {
                requestId: activeAnalysisRequestID(request.sessionID),
                methodID: "panel_fe_regression",
                arguments: {
                  dependentVar: "数字普惠金融指数",
                  treatmentVar: "每百人互联网用户数",
                  covariates: [],
                  entityVar: "省份_地区",
                  timeVar: "年份",
                  covariance: "clustered",
                },
              }) } as never
            }
            if (mainRound === 11) {
              requestedTools.push("econometrics_execute:panel_fe_composite_key")
              return { fullStream: completeToolStream("econometrics_execute", "call_composite_panel_estimate", {
                specId: activePreparedSpecID(request.sessionID),
              }) } as never
            }
            if (mainRound === 12) {
              requestedTools.push("heterogeneity_runner:all_provinces")
              heterogeneityToolVisible = Object.keys(request.tools?.definitions ?? {}).includes("heterogeneity_runner")
              const heterogeneityDefinition = JSON.stringify(request.tools?.definitions?.heterogeneity_runner)
              heterogeneitySchemaVisible = heterogeneityToolVisible &&
                heterogeneityDefinition.includes("heterogeneityVars") &&
                heterogeneityDefinition.includes("所有非缺失类别") &&
                heterogeneityDefinition.includes("中位数")
              return { fullStream: completeToolStream("heterogeneity_runner", "call_composite_panel_heterogeneity", {
                methodFamily: "fe",
                dependentVar: "数字普惠金融指数",
                treatmentVar: "每百人互联网用户数",
                entityVar: "省份_地区",
                timeVar: "年份",
                clusterVar: "省份_地区",
                covariates: [],
                heterogeneityVars: ["省份"],
                mechanismVars: [],
                alternativeSpecifications: [],
              }) } as never
            }
            if (mainRound === 13) {
              heterogeneitySummaryText = latestToolResultText(request.messages, "heterogeneity_runner")
              heterogeneitySummaryReachedModel = heterogeneitySummaryText.includes("异质性分析部分完成") &&
                Number(heterogeneitySummaryText.match(/成功规格：(\d+)/)?.[1]) > 0 &&
                Number(heterogeneitySummaryText.match(/失败或跳过规格：(\d+)/)?.[1]) > 0
              return { fullStream: completeTextStream(
                "复合实体键 Panel FE 基准已完成；省份子组估计已运行，另有交互规格因类别变量形状不支持而跳过，因此扩展部分完成。未删除或去重观测，所有结果仅作条件关联解释。",
              ) } as never
            }
            throw new Error(`Unexpected scripted main-model round ${mainRound}`)
          }))

          try {
            await SessionPrompt.prompt({
              sessionID: session.id,
              parts: [{
                type: "text",
                text: `导入 ${source}，做双向固定效应面板回归：实体=地区，时间=年份，被解释变量=数字普惠金融指数，核心解释变量=每百人互联网用户数。如果地区×年份键因跨省同名地区而重复，不要删除、去重或丢弃任何观测；用省份和地区构造复合实体键，重新画像和质检后继续同一双向固定效应分析。基准完成后，请执行按省份分组的异质性分析，全部省份都要列出，失败或跳过的组也要报告；只解释条件关联，不作因果结论。`,
              }],
              model: { providerID: model.providerID, modelID: model.id },
              agent: "analyst",
            })

            const messages = await Session.messages({ sessionID: session.id })
          const preparationParts = messages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "analysis_prepare")
          const estimateParts = messages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "econometrics_execute")
            const preprocessPart = messages
              .filter((message) => message.info.role === "assistant")
              .flatMap((message) => message.parts)
              .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "data_preprocess" && part.state.status === "completed")
            const preprocessMetadata = preprocessPart?.state.status === "completed"
              ? preprocessPart.state.metadata as Record<string, unknown>
              : undefined
            const transformedDatasetId = typeof preprocessMetadata?.datasetId === "string" ? preprocessMetadata.datasetId : undefined
            const transformedStageId = typeof preprocessMetadata?.stageId === "string" ? preprocessMetadata.stageId : undefined
            const transformedReadiness = transformedDatasetId && transformedStageId
              ? readStoredDataReadinessState(transformedDatasetId, transformedStageId)
              : undefined
            const compositeCandidates = transformedReadiness?.report?.panelCandidates
              .filter((candidate) => candidate.entityVars.length === 1 && candidate.entityVars[0] === "省份_地区" && candidate.timeVar === "年份")
              .map((candidate) => ({ unique: candidate.unique, duplicateRows: candidate.duplicateRows, entityMissingCount: candidate.entityMissingCount, timeMissingCount: candidate.timeMissingCount })) ?? []
          const successfulEstimate = [...estimateParts].reverse().find(
            (part) => part.state.status === "completed" && (part.state.metadata.result as { success?: unknown } | undefined)?.success === true,
          )
          if (!successfulEstimate || successfulEstimate.state.status !== "completed") {
            const preparationStates = messages
              .filter((message) => message.info.role === "assistant")
              .flatMap((message) => message.parts)
              .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "analysis_prepare")
              .map((part) => part.state.status === "completed"
                ? { status: part.state.status, input: part.state.input, output: part.state.output, metadata: part.state.metadata }
                : { status: part.state.status, input: part.state.input, error: part.state.status === "error" ? part.state.error : undefined })
            const panelOutputs = estimateParts.map((part) =>
              part.state.status === "error" ? part.state.error : part.state.status === "completed" ? part.state.output : part.state.status,
            )
            throw new Error(
              `Composite Panel FE did not complete; rounds=${mainRound}; tools=${requestedTools.join(",")}; ` +
              `preparations=${JSON.stringify(preparationStates)}; questions=${userQuestions.join(" | ")}; transformedStage=${transformedStageId}; stale=${transformedReadiness?.stale}; ` +
              `compositeCandidates=${JSON.stringify(compositeCandidates)}; panelOutputs=${panelOutputs.join(" / ")}`,
            )
            }
            expect(transformedReadiness?.stale).toBe(false)
            expect(compositeCandidates).toEqual([
              { unique: true, duplicateRows: 0, entityMissingCount: 0, timeMissingCount: 0 },
            ])
            if (successfulEstimate.state.metadata.verifierPending === true) {
              await Promise.race([
                verifierCompletedPromise,
                new Promise<never>((_, reject) => {
                  verifierTimeout = setTimeout(() => reject(new Error("本地复合键 Panel FE verifier Session 未收尾")), 10_000)
                }),
              ])
            }
          } finally {
            if (verifierTimeout) clearTimeout(verifierTimeout)
            unsubscribeCreated()
            unsubscribeStatus()
            unsubscribeQuestion()
          }

          const messages = await Session.messages({ sessionID: session.id })
          const visible = visibleAssistantText(messages)
          const toolParts = messages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part): part is MessageV2.ToolPart => part.type === "tool")
          const preparationParts = toolParts.filter((part) => part.tool === "analysis_prepare")
          const estimateParts = toolParts.filter((part) => part.tool === "econometrics_execute")
          const panelReadinessAttempt = preparationParts[0]
          const completedEstimates = estimateParts.filter((part) =>
            part.state.status === "completed" && (part.state.metadata.result as { success?: unknown } | undefined)?.success === true,
          )
          const completed = completedEstimates.at(-1)
          if (!completed || completed.state.status !== "completed") throw new Error("复合实体键 Panel FE 未生成真实计量结果")

          const result = completed.state.metadata.result as {
            method?: string
            rowsUsed?: number
            resultPath?: string
            coefficientsPath?: string
          } | undefined
          const resultFile = typeof result?.resultPath === "string" ? path.resolve(root, result.resultPath) : ""
          const coefficientsFile = typeof result?.coefficientsPath === "string" ? path.resolve(root, result.coefficientsPath) : ""
          const preprocess = toolParts.find((part) => part.tool === "data_preprocess" && part.state.status === "completed")
          const preprocessResult = preprocess?.state.status === "completed"
            ? preprocess.state.metadata.result as { rowsBefore?: number; rowsAfter?: number; newColumns?: string[] } | undefined
            : undefined
          const heterogeneityPart = toolParts.find((part) => part.tool === "heterogeneity_runner")
          const heterogeneityOutput = heterogeneityPart?.state.status === "completed"
            ? heterogeneityPart.state.metadata.combinedBundlePath
            : undefined
          const resultDatasetId = preprocess?.state.status === "completed" && typeof preprocess.state.metadata.datasetId === "string"
            ? preprocess.state.metadata.datasetId
            : undefined
          const resultStageId = preprocess?.state.status === "completed" && typeof preprocess.state.metadata.stageId === "string"
            ? preprocess.state.metadata.stageId
            : undefined
          const resultManifest = resultDatasetId ? readDatasetManifest(resultDatasetId) : undefined
          const panelBaselineOutput = resultManifest?.finalOutputs.find((item) =>
            item.key === "panel_fe_regression_result" && item.stageId === resultStageId,
          )
          expect(panelBaselineOutput?.metadata?.methodSpecification).toMatchObject({
            methodID: "panel_fe_regression",
            arguments: {
              dependentVar: "数字普惠金融指数",
              treatmentVar: "每百人互联网用户数",
              covariates: [],
              entityVar: "省份_地区",
              timeVar: "年份",
            },
          })
          if (heterogeneityPart?.state.status !== "completed" || typeof heterogeneityOutput !== "string") {
            const currentDatasetId = preprocess?.state.status === "completed"
              ? preprocess.state.metadata.datasetId
              : undefined
            const currentStageId = preprocess?.state.status === "completed"
              ? preprocess.state.metadata.stageId
              : undefined
            const currentManifest = typeof currentDatasetId === "string"
              ? readDatasetManifest(currentDatasetId)
              : undefined
            const currentStage = currentManifest?.stages.find((stage) => stage.stageId === currentStageId)
            const publishedOutputs = currentManifest?.finalOutputs?.map((item) => ({
              key: item.key,
              stageId: item.stageId,
              branch: item.branch,
              runId: item.runId,
            }))
            const detail = heterogeneityPart?.state.status === "error"
              ? heterogeneityPart.state.error
              : heterogeneityPart?.state.status === "completed"
                ? heterogeneityPart.state.output
                : heterogeneityPart?.state.status ?? "未收到工具结果"
            const estimateTrace = estimateParts.map((part) => ({
              status: part.state.status,
              methodID: part.state.input?.methodID,
              stageId: part.state.status === "completed" ? part.state.metadata.stageId : undefined,
              runId: part.state.status === "completed" ? part.state.metadata.runId : undefined,
              success: part.state.status === "completed" ? (part.state.metadata.result as { success?: unknown } | undefined)?.success : undefined,
            }))
            throw new Error(`省份异质性 AgentLoop 未完成：round=${mainRound}; tools=${requestedTools.join(",")}; visible=${heterogeneityToolVisible}; approved=${heterogeneityApprovalPersisted}; stage=${JSON.stringify({ stageId: currentStage?.stageId, branch: currentStage?.branch })}; questions=${userQuestions.join(" | ")}; estimates=${JSON.stringify(estimateTrace)}; published=${JSON.stringify(publishedOutputs)}; detail=${detail}`)
          }
          const heterogeneityBundle = JSON.parse(fs.readFileSync(path.resolve(root, heterogeneityOutput), "utf-8")) as {
            specs?: Array<{ spec_id?: string; spec_type?: string; status?: string; changed_specification?: string }>
          }
          const provinceSpecs = heterogeneityBundle.specs?.filter((spec) => spec.spec_id?.startsWith("heter_split_")) ?? []
          const groupedProvinces = new Set(provinceSpecs.map((spec) => spec.changed_specification?.match(/省份=([^;]+)/)?.[1]).filter(Boolean))
          const successfulProvinceSpecs = provinceSpecs.filter((spec) => spec.status === "success")
          const unsuccessfulProvinceSpecs = provinceSpecs.filter((spec) => spec.status !== "success")
          const heterogeneityMetrics = (heterogeneityPart!.state.status === "completed"
            ? heterogeneityPart!.state.metadata.analysisView as { results?: Array<{ label?: string; value?: unknown }> }
            : undefined)?.results ?? []
          const successfulSpecCount = Number(heterogeneityMetrics.find((item) => item.label === "成功规格")?.value)
          const unsuccessfulSpecCount = Number(heterogeneityMetrics.find((item) => item.label === "失败或跳过规格")?.value)
          if (successfulProvinceSpecs.length === 0) {
            throw new Error(`省份子组没有成功规格：${JSON.stringify(provinceSpecs.map((spec) => ({ id: spec.spec_id, status: spec.status, warning: (spec as any).warning, error: (spec as any).error, changed: spec.changed_specification })))}`)
          }

          expect(requestedTools).toEqual([
            "data_import:import",
            "data_import:profile:source",
            "data_import:validate:source",
            "tool_search:panel_fe_regression",
            "analysis_prepare:panel_fe_duplicate_key",
            "data_preprocess:combine_columns",
            "data_import:profile:composite",
            "data_import:validate:composite",
            "tool_search:panel_fe_composite_key",
            "analysis_prepare:panel_fe_composite_key",
            "econometrics_execute:panel_fe_composite_key",
            "heterogeneity_runner:all_provinces",
          ])
          expect(stableToolsAtSearch).toContain("tool_search")
          expect(stableToolsAtSearch).toContain("econometrics_execute")
          expect(stableToolsAtSearch).not.toContain("panel_fe_regression")
          expect(methodSchemaVisible).toBe(true)
          expect(heterogeneityToolVisible).toBe(true)
          expect(heterogeneitySchemaVisible).toBe(true)
          expect(heterogeneityApprovalPersisted).toBe(true)
          if (!heterogeneitySummaryReachedModel) {
            throw new Error(`异质性工具摘要未到达后续模型请求：${JSON.stringify(heterogeneitySummaryText).slice(0, 1200)}`)
          }
          expect(readinessRepairReachedNextTurn).toBe(true)
          expect(userQuestions).toEqual([])
          expect(preparationParts).toHaveLength(2)
          expect(estimateParts).toHaveLength(1)
          expect(panelReadinessAttempt?.state.status).toBe("completed")
          if (panelReadinessAttempt?.state.status === "completed") {
            expect(panelReadinessAttempt.state.output).toContain("估计器没有运行")
            expect(panelReadinessAttempt.state.output).toContain("combine_columns")
            expect(panelReadinessAttempt.state.metadata.authorizedRepair).toEqual({
              method: "combine_columns",
              columns: ["省份", "地区"],
            })
            expect(panelReadinessAttempt.state.metadata.result).toBeUndefined()
          }
          expect(preprocess).toBeDefined()
          expect(preprocess?.state.status === "completed" && preprocess.state.output).toContain("未删除行")
          expect(preprocessResult).toMatchObject({ rowsBefore: 9_683, rowsAfter: 9_683, newColumns: ["省份_地区"] })
          expect(result).toMatchObject({ method: "panel_fe_regression" })
          expect(result?.rowsUsed).toBeGreaterThan(9_000)
          expect(provinceSpecs).toHaveLength(31)
          expect(groupedProvinces).toHaveLength(31)
          expect(successfulProvinceSpecs.length + unsuccessfulProvinceSpecs.length).toBe(31)
          expect(successfulSpecCount + unsuccessfulSpecCount).toBe(heterogeneityBundle.specs?.length ?? 0)
          expect(successfulSpecCount).toBeGreaterThan(0)
          expect(heterogeneityPart?.state.status === "completed" && heterogeneityPart.state.output).toContain("异质性分析部分完成")
          expect(visible).toContain("仅 31 个规格成功")
          expect(visible).toContain("不能将本批次视为全部完成")
          expect(visible).toContain("本轮已暂停")
          expect(visible).not.toContain("全部省份异质性规格")
          expect(fs.existsSync(resultFile)).toBe(true)
          expect(fs.existsSync(coefficientsFile)).toBe(true)
          expect(visible).toContain("省份+地区")
          expect(visible).not.toContain("datasetId")
          expect(visible).not.toContain("stageId")
        } })
      } finally {
        await Instance.disposeAll()
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
      180_000,
    )

  test.skipIf(!hasLocalRealData("test_datasets.xlsx"))(
    "重复面板键未获授权时拦截模型擅自生成复合实体键",
    async () => {
      if (!process.env.KILLSTATA_PYTHON) {
        throw new Error("该真实数据工具回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python Registry 执行")
      }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-unapproved-composite-panel-"))
      const source = path.join(root, "test_datasets.xlsx")
      fs.copyFileSync(localRealDataPath("test_datasets.xlsx"), source)
      let mainRound = 0
      const requestedTools: string[] = []
      const userQuestions: string[] = []

      try {
        await Instance.provide({ directory: root, fn: async () => {
          const session = await Session.create({
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          AnalysisIntent.markAnalystPlanApproval(session.id, true)
          const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
          const unsubscribeQuestion = Bus.subscribe(Question.Event.Asked, (event) => {
            userQuestions.push(String(event.properties.questions[0]?.question ?? ""))
            Question.reply({ requestID: event.properties.id, answers: [["先停止，解释可选方案，等我决定。"]] }).catch(() => {})
          })

          spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          const registration = await scriptedAnalysisRequestResponse(request)
          if (registration) return registration as never
if (request.small) return { fullStream: completeTextStream("本地会话摘要") } as never
          if (request.textOnly === true) return { fullStream: completeTextStream("当前回合只返回文字，不调用工具。") } as never
          mainRound += 1
            if (mainRound === 1) {
              requestedTools.push("data_import:import")
              return { fullStream: completeToolStream("data_import", "call_unapproved_import", {
                action: "import", inputPath: source, preserveLabels: true,
                sheetPolicy: { mode: "named_sheet", sheetName: "Sheet1" },
              }) } as never
            }
            if (mainRound === 2) {
              requestedTools.push("data_import:profile")
              return { fullStream: completeToolStream("data_import", "call_unapproved_profile", { action: "profile" }) } as never
            }
            if (mainRound === 3) {
              requestedTools.push("data_import:validate")
              return { fullStream: completeToolStream("data_import", "call_unapproved_validate", { action: "validate" }) } as never
            }
            if (mainRound === 4) {
              requestedTools.push("tool_search:panel_fe_regression")
              return { fullStream: completeToolStream("tool_search", "call_unapproved_panel_search", {
                query: "panel_fe_regression", limit: 1,
              }) } as never
            }
            if (mainRound === 5) {
              requestedTools.push("analysis_prepare:duplicate-panel-key", "data_preprocess:unauthorized-combine_columns")
              return { fullStream: completeToolBatchStream([
                {
                  toolName: "analysis_prepare",
                  toolCallId: "call_unapproved_panel",
                  input: {
                    requestId: activeAnalysisRequestID(request.sessionID),
                    methodID: "panel_fe_regression",
                    arguments: {
                      dependentVar: "数字普惠金融指数",
                      treatmentVar: "每百人互联网用户数",
                      covariates: [],
                      entityVar: "地区",
                      timeVar: "年份",
                      covariance: "clustered",
                    },
                  },
                },
                {
                  toolName: "data_preprocess",
                  toolCallId: "call_unapproved_combine",
                  input: {
                    method: "combine_columns",
                    columns: ["省份", "地区"],
                    options: { output_column: "省份_地区", separator: "_" },
                  },
                },
              ]) } as never
            }
            if (mainRound === 6) {
              return { fullStream: completeTextStream("地区×年份存在115行重复键。是否改用省份+地区作为复合个体键需要你确认；当前未改数据、未更换方法、未删除观测。") } as never
            }
            throw new Error(`Unexpected scripted model round ${mainRound}`)
          }))

          try {
            await SessionPrompt.prompt({
              sessionID: session.id,
              parts: [{
                type: "text",
                text: `导入 ${source}，做面板固定效应回归：实体=地区，时间=年份，因变量=数字普惠金融指数，核心解释变量=每百人互联网用户数。`,
              }],
              model: { providerID: model.providerID, modelID: model.id },
              agent: "analyst",
            })
          } finally {
            unsubscribeQuestion()
          }

          const messages = await Session.messages({ sessionID: session.id })
          const visible = visibleAssistantText(messages)
          const toolParts = messages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part): part is MessageV2.ToolPart => part.type === "tool")
          const importPart = toolParts.find((part) => part.tool === "data_import" && part.state.status === "completed")
          if (!importPart || importPart.state.status !== "completed") throw new Error("真实 test_datasets.xlsx 未完成导入")
          const datasetId = importPart.state.metadata.datasetId
          expect(typeof datasetId).toBe("string")
          const manifest = readDatasetManifest(datasetId as string)
          expect(manifest.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])

          const panelParts = toolParts.filter((part) =>
            part.tool === "analysis_prepare" && part.state.input?.methodID === "panel_fe_regression",
          )
          expect(panelParts).toHaveLength(1)
          expect(panelParts[0]?.state.status).toBe("completed")
          if (panelParts[0]?.state.status === "completed") {
            expect(panelParts[0].state.metadata.requiresUserDecision).toBe(true)
            expect(panelParts[0].state.metadata.result).toBeUndefined()
          }
          const suppressedPreprocess = toolParts.find((part) => part.tool === "data_preprocess")
          expect(suppressedPreprocess).toBeDefined()
          expect(suppressedPreprocess?.state.status).toBe("error")
          if (suppressedPreprocess?.state.status === "error") {
            expect(suppressedPreprocess.state.error).toContain("ToolCallSkippedError")
          }
          expect(userQuestions).toEqual([])
          expect(requestedTools).toEqual([
            "data_import:import",
            "data_import:profile",
            "data_import:validate",
            "tool_search:panel_fe_regression",
            "analysis_prepare:duplicate-panel-key",
            "data_preprocess:unauthorized-combine_columns",
          ])
          expect(visible).toContain("地区×年份存在115行重复键")
          expect(visible).toContain("没有继续执行被阻断的估计")
          expect(visible).toContain("没有擅自更换计量方法")
          expect(visible).not.toContain("已完成面板固定效应")
        } })
      } finally {
        await Instance.disposeAll()
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
