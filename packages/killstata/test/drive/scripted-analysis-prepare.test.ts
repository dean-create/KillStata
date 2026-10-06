import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { methodSchemaIDsVisibleToModel } from "@/runtime/tool-schema-provenance"
import { readDatasetManifest } from "@/tool/analysis-state"
import { AnalysisIntent } from "@/tool/analysis-intent"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const spies: Array<{ mockRestore(): void }> = []

afterEach(async () => {
  while (spies.length) spies.pop()?.mockRestore()
  await Instance.disposeAll()
})

type ScriptedToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

function completeText(text: string) {
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

function completeTools(calls: ScriptedToolCall[]) {
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

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (!value || typeof value !== "object") return []
  return Object.values(value).flatMap(strings)
}

describe("scripted real-data analysis preparation", () => {
  test.skipIf(!hasLocalRealData("did.xlsx"))("registers, imports and diagnoses did.xlsx, loads Python OLS Schema, and prepares without executing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-analysis-prepare-e2e-"))
    const source = path.join(root, "did.xlsx")
    fs.copyFileSync(localRealDataPath("did.xlsx"), source)
    const visibleByRound: string[][] = []
    const schemaIDsByRound: string[][] = []
    const modelTurns: string[][] = []
    const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute")
    const validateSpy = spyOn(EconometricsEngineClient.prototype, "validate")
    spies.push(executeSpy)
    spies.push(validateSpy)
    const preflightSpy = spyOn(EconometricsEngineClient.prototype, "preflight")
    spies.push(preflightSpy)

    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        let mainRound = 0

        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          if (request.small) return { fullStream: completeText("会话标题") } as never
          mainRound += 1
          visibleByRound.push(Object.keys(request.tools?.definitions ?? {}).sort())
          schemaIDsByRound.push([...methodSchemaIDsVisibleToModel(request.messages)])
          if (mainRound === 1) {
            modelTurns.push(["analysis_request"])
            return { fullStream: completeTools([{
              toolName: "analysis_request",
              toolCallId: "call_register_inspect_request",
              input: {
                kind: "inspect",
                researchGoal: "检查 OLS 在当前数据上的参数和适用条件，不运行估计",
                constraints: ["本轮只做前置检查，不运行估计"],
              },
            }]) } as never
          }
          if (mainRound === 2) {
            const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.analysisRequest?.kind === "inspect")
            if (!task?.analysisRequest) throw new Error("请求账本中没有登记 inspect 请求")
            modelTurns.push(["data_import:import", "analysis_prepare:before_search"])
            return { fullStream: completeTools([
              {
                toolName: "data_import",
                toolCallId: "call_import_readable_sheet_for_preflight",
                input: {
                  action: "import",
                  inputPath: source,
                  preserveLabels: true,
                  sheetPolicy: { mode: "named_sheet", sheetName: "Data_可读" },
                },
              },
              {
                toolName: "analysis_prepare",
                toolCallId: "call_prepare_ols_before_schema_search",
                input: {
                  requestId: task.analysisRequest.requestId,
                  methodID: "ols_regression",
                  arguments: {
                    dependentVar: "高质量发展指数",
                    treatmentVar: "did",
                    covariates: ["人口规模", "人均GDP", "金融发展程度"],
                    covariance: "HC1",
                  },
                },
              },
            ]) } as never
          }
          if (mainRound === 3) {
            modelTurns.push(["tool_search:ols_regression"])
            return { fullStream: completeTools([{
              toolName: "tool_search",
              toolCallId: "call_search_ols_for_preflight",
              input: { query: "ols_regression", limit: 1 },
            }]) } as never
          }
          if (mainRound === 4) {
            const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.analysisRequest?.kind === "inspect")
            if (!task?.analysisRequest) throw new Error("请求账本中没有登记 inspect 请求")
            modelTurns.push(["analysis_prepare"])
            return { fullStream: completeTools([{
              toolName: "analysis_prepare",
              toolCallId: "call_prepare_ols_preflight",
              input: {
                requestId: task.analysisRequest.requestId,
                methodID: "ols_regression",
                arguments: {
                  dependentVar: "高质量发展指数",
                  treatmentVar: "did",
                  covariates: ["人口规模", "人均GDP", "金融发展程度"],
                  covariance: "HC1",
                },
              },
            }]) } as never
          }
          return { fullStream: completeText("OLS 的参数和数据前置条件已完成只读检查；本轮没有运行估计。若要执行，请明确提出后再继续。") } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: `请导入 ${source} 的 Data_可读 工作表，检查 OLS 参数和数据前置条件，不运行估计。因变量为高质量发展指数，核心解释变量为 did，控制人口规模、人均GDP、金融发展程度，采用 HC1。` }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const messages = await Session.messages({ sessionID: session.id })
        const ledger = RuntimeTaskLedger.listTasks(session.id)
        const task = ledger.tasks.find((item) => item.analysisRequest?.kind === "inspect")
        expect(modelTurns).toEqual([
          ["analysis_request"],
          ["data_import:import", "analysis_prepare:before_search"],
          ["tool_search:ols_regression"],
          ["analysis_prepare"],
        ])
        expect(visibleByRound[0]).toEqual(["analysis_request"])
        expect(visibleByRound[1]).toContain("analysis_prepare")
        expect(visibleByRound[1]).toContain("data_import")
        expect(visibleByRound[1]).toContain("tool_search")
        expect(schemaIDsByRound[3]).toContain("ols_regression")
        const parts = messages.flatMap((message) => message.parts)
        const schemaRequired = parts.find((part): part is MessageV2.ToolPart =>
          part.type === "tool" &&
          part.tool === "analysis_prepare" &&
          part.state.status === "completed" &&
          part.state.metadata.analysisSpecStatus === "schema_not_sent",
        )
        expect(schemaRequired).toBeDefined()
        if (!schemaRequired || schemaRequired.state.status !== "completed") throw new Error("缺少方法 Schema 时没有返回明确的恢复提示")
        expect(schemaRequired.state.output).toContain("tool_search")
        const searchResult = parts.find((part): part is MessageV2.ToolPart =>
          part.type === "tool" && part.tool === "tool_search" && part.state.status === "completed",
        )
        expect(searchResult).toBeDefined()
        if (!searchResult || searchResult.state.status !== "completed") throw new Error("OLS 方法 Schema 搜索未完成")
        expect(searchResult.state.output).toContain("参数 Schema：")
        if (!task?.analysisSpecs?.length) {
          const relevantParts = parts.filter((part): part is MessageV2.ToolPart =>
            part.type === "tool" && part.tool === "analysis_prepare",
          ).map((part) => ({ status: part.state.status, output: part.state.status === "completed" ? part.state.output.slice(0, 240) : undefined, error: part.state.status === "error" ? String(part.state.error).slice(0, 240) : undefined }))
          const searchOutput = parts.filter((part): part is MessageV2.ToolPart =>
            part.type === "tool" && part.tool === "tool_search",
          ).map((part) => ({ status: part.state.status, error: part.state.status === "error" ? String(part.state.error).slice(0, 200) : undefined, output: part.state.status === "completed" ? part.state.output.slice(0, 200) : undefined }))
          throw new Error(`analysis_prepare 未保存规格：${JSON.stringify({ relevantParts, searchOutput, turns: modelTurns, schemaIDsByRound })}`)
        }
        expect(task.analysisSpecs.at(-1)).toMatchObject({
          methodID: "ols_regression",
          status: "preflight_ready",
          datasetId: expect.any(String),
          stageId: "stage_000",
        })
        expect(task.preparedSpec).toBeUndefined()
        expect(executeSpy.mock.calls.filter(([payload]) =>
          Boolean(payload && typeof payload === "object" && (payload as Record<string, unknown>).method_id === "ols_regression"),
        )).toHaveLength(0)
        const importPart = parts.find((part): part is MessageV2.ToolPart =>
          part.type === "tool" && part.tool === "data_import" && part.state.status === "completed",
        )
        expect(importPart).toBeDefined()
        if (!importPart || importPart.state.status !== "completed") throw new Error("Data_可读 导入没有完成")
        const importedMetadata = importPart.state.metadata
        const stage = readDatasetManifest(String(importedMetadata.datasetId)).stages.find((item) =>
          item.stageId === importedMetadata.stageId,
        )
        expect(stage?.metadata?.dataDiagnosis).toMatchObject({ version: 1, stage_id: "stage_000" })

        const preparePart = parts.find((part): part is MessageV2.ToolPart =>
          part.type === "tool" &&
          part.tool === "analysis_prepare" &&
          part.state.status === "completed" &&
          part.state.metadata.analysisSpecStatus === "preflight_ready",
        )
        expect(preparePart).toBeDefined()
        if (!preparePart || preparePart.state.status !== "completed") throw new Error("analysis_prepare 没有完成")
        expect(preparePart.state.metadata).toMatchObject({
          analysisSpecStatus: "preflight_ready",
          estimateExecuted: false,
        })
        const visible = strings(preparePart.state.output)
        expect(visible.join("\n")).toContain("没有运行估计")
        expect(visible.join("\n")).not.toContain("datasetId")
        expect(visible.join("\n")).not.toContain("stageId")
        expect(validateSpy).toHaveBeenCalledTimes(1)
        expect(preflightSpy).toHaveBeenCalledTimes(1)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test("an estimate request cannot be marked complete by assistant prose before specification preparation or a stop", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-analysis-prepare-required-"))
    const visibleByRound: string[][] = []
    let mainRound = 0
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const session = await Session.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
        AnalysisIntent.markAnalystPlanApproval(session.id, true)
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
          if (request.small) return { fullStream: completeText("会话标题") } as never
          mainRound += 1
          visibleByRound.push(Object.keys(request.tools?.definitions ?? {}).sort())
          if (mainRound === 1) {
            return { fullStream: completeTools([{
              toolName: "analysis_request",
              toolCallId: "call_register_required_estimate",
              input: {
                kind: "estimate",
                researchGoal: "根据已上传 did.xlsx 估计回归关系",
                constraints: [],
              },
            }]) } as never
          }
          return { fullStream: completeText("变量角色还没有确认，我还没有做估计。") } as never
        }))

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: "请对 data/did.xlsx 做回归分析，变量角色还没有说明。" }],
          model: { providerID: model.providerID, modelID: model.id },
          agent: "analyst",
        })

        const messages = await Session.messages({ sessionID: session.id })
        const task = RuntimeTaskLedger.listTasks(session.id).tasks.find((item) => item.analysisRequest?.kind === "estimate")
        expect(mainRound).toBeGreaterThan(2)
        expect(visibleByRound[0]).toEqual(["analysis_request"])
        expect(visibleByRound[1]).toContain("analysis_prepare")
        expect(task?.preparedSpec).toBeUndefined()
        const visibleText = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
          .map((part) => part.text)
          .join("\n")
        expect(visibleText).toContain("本轮估计请求尚未完成")
        expect(visibleText).toContain("没有覆盖全部请求方法且通过结果契约核验的估计结果")
        expect(visibleText).not.toContain("估计结果已生成")
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
