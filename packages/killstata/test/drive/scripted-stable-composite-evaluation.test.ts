import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { readDatasetManifest } from "@/tool/analysis-state"
import { relativeWithinProject } from "@/tool/analysis-path"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  await Instance.disposeAll()
})

function textStream(text: string) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "text-start", id: "scripted-summary" }
    yield { type: "text-delta", id: "scripted-summary", text }
    yield { type: "text-end", id: "scripted-summary" }
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function toolStream(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "tool-input-start", id: toolCallId, toolName }
    yield { type: "tool-call", toolCallId, toolName, input }
    yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
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

function visibleAssistantText(messages: MessageV2.WithParts[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
}

describe("test_datasets.xlsx 熵权 TOPSIS AgentLoop", () => {
  test.skipIf(!hasLocalRealData("test_datasets.xlsx"))(
    "修正 TOPSIS 漏传权重来源后按年分组完成真实评价，保留全样本且不混排跨年得分",
    async () => {
      if (!process.env.KILLSTATA_PYTHON) {
        throw new Error("该真实数据 AgentLoop 回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python 执行")
      }

      const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-scripted-composite-evaluation-"))
      const source = path.join(root, "test_datasets.xlsx")
      fs.copyFileSync(localRealDataPath("test_datasets.xlsx"), source)
      const requestedTools: string[] = []
      const stableToolsAtMethodCall: string[] = []
      let mainRound = 0
      let textOnlyRounds = 0
      let repairedFromWeightError = false
      let groupedScoreBoundaryVisible = false

      try {
        await Instance.provide({ directory: root, fn: async () => {
          const session = await Session.create({
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          AnalysisIntent.markAnalystPlanApproval(session.id, true)
          const model = await Provider.getModel("deepseek", "deepseek-v4-flash")

          spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
            const registration = await scriptedAnalysisRequestResponse(request)
            if (registration) return registration as never
if (request.small) return { fullStream: textStream("本地会话摘要") } as never
            if (request.textOnly === true) {
              textOnlyRounds += 1
              return { fullStream: textStream("当前回合只整理已完成的综合评价，不调用工具。") } as never
            }
            mainRound += 1

            if (mainRound === 1) {
              requestedTools.push("data_import:import")
              return { fullStream: toolStream("data_import", "call_mcda_import", {
                action: "import",
                inputPath: source,
                preserveLabels: true,
                sheetPolicy: { mode: "named_sheet", sheetName: "Sheet1" },
              }) } as never
            }
            if (mainRound === 2) {
              requestedTools.push("data_import:profile")
              return { fullStream: toolStream("data_import", "call_mcda_profile", { action: "profile" }) } as never
            }
            if (mainRound === 3) {
              requestedTools.push("data_import:validate")
              return { fullStream: toolStream("data_import", "call_mcda_validate", { action: "validate" }) } as never
            }
            if (mainRound === 4) {
              requestedTools.push("composite_evaluation:missing_weight_source")
              stableToolsAtMethodCall.push(...Object.keys(request.tools?.definitions ?? {}))
              groupedScoreBoundaryVisible = modelVisibleText(request.tools?.definitions ?? {})
                .includes("分组得分仅在同组内可比较")
              return { fullStream: toolStream("composite_evaluation", "call_mcda_missing_weight_source", {
                method: "topsis",
                idColumns: ["省份", "地区"],
                indicators: [
                  { column: "每百人互联网用户数", direction: "benefit" },
                  { column: "计算机服务和软件从业人员占比", direction: "benefit" },
                  { column: "人均电信业务总量", direction: "benefit" },
                  { column: "每百人移动电话用户数", direction: "benefit" },
                ],
                scope: "by_group",
                groupColumns: ["年份"],
              }) } as never
            }
            if (mainRound === 5) {
              requestedTools.push("composite_evaluation:corrected_entropy_weight")
              const previousError = latestToolResultText(request.messages, "composite_evaluation")
              repairedFromWeightError = /weightSource|权重来源|明确.*权重/.test(previousError)
              if (!repairedFromWeightError) {
                throw new Error(`TOPSIS 权重字段错误没有返回模型上下文：${previousError}`)
              }
              return { fullStream: toolStream("composite_evaluation", "call_mcda_valid", {
                method: "topsis",
                idColumns: ["省份", "地区"],
                indicators: [
                  { column: "每百人互联网用户数", direction: "benefit" },
                  { column: "计算机服务和软件从业人员占比", direction: "benefit" },
                  { column: "人均电信业务总量", direction: "benefit" },
                  { column: "每百人移动电话用户数", direction: "benefit" },
                ],
                scope: "by_group",
                groupColumns: ["年份"],
                weightSource: "entropy",
              }) } as never
            }
            throw new Error(`unexpected model round ${mainRound}`)
          }))

          await SessionPrompt.prompt({
            sessionID: session.id,
            parts: [{
              type: "text",
              text: `导入 ${source}，用每百人互联网用户数、计算机服务和软件从业人员占比、人均电信业务总量、每百人移动电话用户数构建熵权 TOPSIS 综合排名。四项均为正向指标；评价单元=省份+地区，每个年份单独计算权重和排名；保留所有行。输出各年份前五名，得分只能在同一年内比较。`,
            }],
            model: { providerID: model.providerID, modelID: model.id },
            agent: "analyst",
          })

          const messages = await Session.messages({ sessionID: session.id })
          const parts = messages
            .filter((message) => message.info.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part): part is MessageV2.ToolPart => part.type === "tool")
          const mcdaParts = parts.filter((part) => part.tool === "composite_evaluation")
          const failed = mcdaParts.find((part) => part.state.status === "error")
          const completed = mcdaParts.find((part) => part.state.status === "completed")
          expect(failed).toBeDefined()
          if (!completed) {
            const ledger = RuntimeTaskLedger.listTasks(session.id)
            const estimateTask = ledger.tasks.find((task) => task.analysisRequest?.kind === "estimate")
            throw new Error(`综合评价 ToolPort lifecycle 未闭环：${JSON.stringify({
              toolParts: mcdaParts.map((part) => ({ status: part.state.status, error: part.state.status === "error" ? part.state.error : undefined })),
              lifecycle: estimateTask?.analysisLifecycle,
              requestedTools,
            })}`)
          }
          if (!completed || completed.state.status !== "completed") throw new Error("修正后的综合评价没有完成")
          expect(repairedFromWeightError).toBe(true)
          expect(textOnlyRounds).toBeGreaterThan(0)
          expect(mainRound).toBe(5)
          expect(requestedTools).toEqual([
            "data_import:import",
            "data_import:profile",
            "data_import:validate",
            "composite_evaluation:missing_weight_source",
            "composite_evaluation:corrected_entropy_weight",
          ])
          expect(stableToolsAtMethodCall).toContain("composite_evaluation")
          expect(groupedScoreBoundaryVisible).toBe(true)
          expect(mcdaParts.filter((part) => part.state.status === "completed")).toHaveLength(1)

          const metadata = completed.state.metadata as Record<string, unknown>
          const result = metadata.result as Record<string, unknown>
          const groups = result.topByGroup as Record<string, unknown[]>
          expect(result.success).toBe(true)
          expect(result.rowsInput).toBe(9683)
          expect(result.rowsUsed).toBe(9683)
          expect(result.groupCount).toBe(23)
          expect(Object.keys(groups)).toHaveLength(23)
          const top2021 = groups["年份=2021"] as Array<Record<string, unknown>>
          expect(top2021).toHaveLength(5)
          expect(top2021.map((row) => `${row["省份"]}/${row["地区"]}`)).toEqual([
            "上海市/普陀区",
            "上海市/长宁区",
            "上海市/嘉定区",
            "黑龙江省/哈尔滨市",
            "上海市/静安区",
          ])
          expect(top2021.map((row) => Number(row["ks_topsis_rank"]))).toEqual([1, 2, 3, 4, 5])
          const expectedScores2021 = [0.965632, 0.947010, 0.914352, 0.896159, 0.891730]
          for (const [index, expected] of expectedScores2021.entries()) {
            expect(Number(top2021[index]?.["ks_topsis_score"])).toBeCloseTo(expected, 5)
          }
          const weights2021 = result.groupWeights as Record<string, Array<{ column: string; weight: number }>>
          const weightMap2021 = Object.fromEntries(weights2021["年份=2021"]!.map(({ column, weight }) => [column, weight]))
          expect(weightMap2021["每百人互联网用户数"]).toBeCloseTo(0.2451406712, 8)
          expect(weightMap2021["计算机服务和软件从业人员占比"]).toBeCloseTo(0.2558410493, 8)
          expect(weightMap2021["人均电信业务总量"]).toBeCloseTo(0.2529991111, 8)
          expect(weightMap2021["每百人移动电话用户数"]).toBeCloseTo(0.2460191684, 8)
          expect(result.top).toEqual([])
          expect(result.bottom).toEqual([])
          expect(metadata.requiresUserDecision).toBe(true)

          const visibleText = visibleAssistantText(messages) + "\n" + mcdaParts.map((part) => part.state.status === "completed" ? part.state.output : "").join("\n")
          expect(visibleText).toContain("各组内排名预览")
          expect(visibleText).toContain("得分仅在同组内可比较")
          expect(visibleText).toContain("年份=2021 前五名")
          expect(visibleText).not.toContain("全局前五名")
          expect(visibleText).not.toContain("datasetId")
          expect(visibleText).not.toContain("stageId")

          const stageId = String(metadata.stageId)
          const manifest = readDatasetManifest(String(metadata.datasetId))
          expect(manifest.stages.map((stage) => stage.stageId)).toEqual(["stage_000", stageId])
          expect(manifest.stages[1]?.parentStageId).toBe("stage_000")
          expect(manifest.stages[1]?.rowCount).toBe(9683)
          const compositeArtifact = manifest.artifacts.find((artifact) => artifact.action === "mcda_topsis")
          expect(compositeArtifact).toBeDefined()
          expect(fs.existsSync(String(manifest.stages[1]?.workingPath))).toBe(true)
          expect(fs.existsSync(String(compositeArtifact?.outputPath))).toBe(true)

          const estimateTask = RuntimeTaskLedger.listTasks(session.id).tasks.find((task) =>
            task.analysisRequest?.kind === "estimate" &&
            task.analysisLifecycle?.requestId === task.analysisRequest.requestId,
          )
          const compositeRun = estimateTask?.analysisLifecycle?.toolRuns?.find((run) => run.toolID === "composite_evaluation")
          expect(compositeRun).toMatchObject({
            requestId: estimateTask?.analysisRequest?.requestId,
            operationId: "call_mcda_valid",
            datasetId: metadata.datasetId,
            stageId: "stage_000",
            stageFingerprint: estimateTask?.analysisLifecycle?.stageFingerprint,
            status: "completed",
            resultContractStatus: "pass",
          })
          expect(compositeRun?.startedAt).toBeString()
          expect(estimateTask?.analysisLifecycle?.toolRuns).toHaveLength(1)
          expect(compositeRun?.artifactRefs).toContain(relativeWithinProject(String(manifest.stages[1]?.workingPath)))
        } })
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
