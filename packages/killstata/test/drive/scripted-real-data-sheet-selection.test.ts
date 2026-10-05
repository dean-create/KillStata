import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { ModelGateway } from "@/runtime/services/model-gateway"
import { scriptedAnalysisRequestResponse } from "../helpers/scripted-analysis-request"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { readDatasetManifest } from "@/tool/analysis-state"
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
    yield { type: "text-start", id: "sheet-selection-text" }
    yield { type: "text-delta", id: "sheet-selection-text", text }
    yield { type: "text-end", id: "sheet-selection-text" }
    yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function completeImport(inputPath: string, sheetName: string, callID: string) {
  return (async function* () {
    yield { type: "start" }
    yield { type: "start-step" }
    yield { type: "tool-input-start", id: callID, toolName: "data_import" }
    yield {
      type: "tool-call",
      toolCallId: callID,
      toolName: "data_import",
      input: {
        action: "import",
        inputPath,
        preserveLabels: true,
        sheetPolicy: { mode: "named_sheet", sheetName },
      },
    }
    yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: "finish" }
  })()
}

function completeToolCall(toolName: string, toolCallId: string, input: Record<string, unknown>) {
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

function latestNamedToolResultText(messages: unknown, toolName: string): string {
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

function assistantText(messages: MessageV2.WithParts[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

test.skipIf(!hasLocalRealData("did.xlsx"))("真实导入必须读取用户指定的第二张 Data_原始编码 工作表", async () => {
  if (!process.env.KILLSTATA_PYTHON) {
    throw new Error("该真实工作表选择回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python 执行")
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-real-sheet-selection-"))
  const source = path.join(root, "did.xlsx")
  fs.copyFileSync(localRealDataPath("did.xlsx"), source)
  let userTurn = 1
  let turnModelRound = 0
  const importAttempts: string[] = []
  let sheetRepairContext = ""
  let importTurnModelContext = ""
  let outputReference = ""
  let readResult = ""
  const sessionErrors: string[] = []
  let unsubscribeSessionError: (() => void) | undefined
  const engineSheetNames: unknown[] = []
  const enginePayloads: Record<string, unknown>[] = []

  try {
    await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      unsubscribeSessionError = Bus.subscribe(Session.Event.Error, (event) => {
        const error = event.properties.error
        if (event.properties.sessionID === session.id && error) {
          sessionErrors.push(String(error.data?.message ?? error.name))
        }
      })
      AnalysisIntent.markAnalystPlanApproval(session.id, true)
      const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
      const originalExecute = EconometricsEngineClient.prototype.execute
      spies.push(spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(async function (this: EconometricsEngineClient, payload, signal) {
        const arguments_ = asRecord(asRecord(payload)?.arguments)
        const sheetPolicy = asRecord(arguments_?.sheetPolicy)
        engineSheetNames.push(sheetPolicy?.sheetName)
        const response = await originalExecute.call(this, payload, signal)
        const responsePayload = asRecord(response.payload)
        if (responsePayload) enginePayloads.push(responsePayload)
        return response
      }))
      spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
        const registration = await scriptedAnalysisRequestResponse(request)
        if (registration) return registration as never
if (String(request.agent.name).toLowerCase() === "verifier") {
          return { fullStream: completeTextStream("<verifier_result>{\"status\":\"pass\",\"checks\":[],\"blockingFindings\":[],\"repairHints\":[],\"trustedArtifacts\":[],\"summary\":\"导入核验完成。\",\"findings\":[]}</verifier_result>") } as never
        }
        if (request.small) return { fullStream: completeTextStream("本地摘要") } as never
        turnModelRound += 1
        if (userTurn === 1 && turnModelRound === 1) {
          importAttempts.push("Data_原始")
          return { fullStream: completeImport(source, "Data_原始", "call_import_wrong_sheet") } as never
        }
        if (userTurn === 1 && turnModelRound === 2) {
          sheetRepairContext = modelVisibleText(request.messages)
          importAttempts.push("Data_原始编码")
          return { fullStream: completeImport(source, "Data_原始编码", "call_import_correct_sheet") } as never
        }
        if (userTurn === 1 && turnModelRound >= 3) {
          if (!importTurnModelContext) {
            importTurnModelContext = modelVisibleText(request.messages)
            outputReference = importTurnModelContext.match(/tool-output:tool_[0-9A-Za-z]+/)?.[0] ?? ""
          }
          return { fullStream: completeTextStream("已导入 Data_原始编码 工作表；完整字段清单保留在导入结果中。") } as never
        }
        if (userTurn === 2 && turnModelRound === 1) {
          const context = modelVisibleText(request.messages)
          const reference = context.match(/tool-output:tool_[0-9A-Za-z]+/)?.[0] ?? outputReference
          return {
            fullStream: completeToolCall("read", "call_read_raw_sheet_output", {
              filePath: reference,
              offset: 18,
              limit: 8,
            }),
          } as never
        }
        if (userTurn === 2 && turnModelRound === 2) {
          readResult = latestNamedToolResultText(request.messages, "read")
          return {
            fullStream: completeTextStream(readResult.includes("city")
              ? "已从 Data_原始编码 的完整导入结果确认存在 city 列；没有运行回归。"
            : "已读取导入结果，但没有找到 city 列。"),
          } as never
        }
        if (userTurn === 3 && turnModelRound === 1) {
          return { fullStream: completeImport(source, "Data_可读", "call_import_readable_sheet_after_raw") } as never
        }
        if (userTurn === 3 && turnModelRound >= 2) {
          return { fullStream: completeTextStream("已从同一文件另行导入 Data_可读 工作表；先前的 Data_原始编码 阶段仍保留。") } as never
        }
        if (userTurn === 4 && turnModelRound === 1) {
          return { fullStream: completeImport(source, "Data_可读", "call_import_readable_sheet_again") } as never
        }
        if (userTurn === 4 && turnModelRound >= 2) {
          return { fullStream: completeTextStream("Data_可读 已有可复用的导入阶段，未重复执行 Python 导入。") } as never
        }
        throw new Error(`工作表旅程出现未预期的模型轮次：turn=${userTurn} round=${turnModelRound}`)
      }))

      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: `请导入 ${source} 的 Data_原始编码 工作表，只检查数据结构和真实列名，不做回归。` }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })

      const messages = await Session.messages({ sessionID: session.id })
      const importParts = messages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.ToolPart => part.type === "tool" &&
          part.tool === "data_import" && part.state.input?.action === "import")
      const failedImportPart = importParts.find((part) => part.state.status === "error")
      const importPart = importParts.find((part) => part.state.status === "completed")
      expect(turnModelRound).toBeGreaterThanOrEqual(3)
      expect(importAttempts).toEqual(["Data_原始", "Data_原始编码"])
      expect(engineSheetNames).toEqual(["Data_原始", "Data_原始编码"])
      expect(failedImportPart?.state.status).toBe("error")
      expect(failedImportPart?.state.status === "error" ? String(failedImportPart.state.error) : "")
        .toContain("可用工作表")
      expect(sheetRepairContext).toContain("Data_原始")
      expect(sheetRepairContext).toContain("Data_原始编码")
      expect(sheetRepairContext).toMatch(/可用工作表|not found|does not exist/i)
      expect(importPart?.state.status).toBe("completed")
      if (!importPart || importPart.state.status !== "completed") throw new Error("指定工作表导入没有成功完成")
      const result = importPart.state.metadata.result as Record<string, unknown>
      expect(result.columns_before).toBe(35)
      expect(result.rows_before).toBe(4709)
      expect(result.variables).toContain("city")
      expect(enginePayloads[0]?.sheet_info).toMatchObject({ selected: "Data_原始编码" })
      const datasetId = typeof importPart.state.metadata.datasetId === "string" ? importPart.state.metadata.datasetId : undefined
      const stageId = importPart.state.metadata.stageId
      const manifest = datasetId ? readDatasetManifest(datasetId) : undefined
      const importedStage = manifest?.stages.find((stage) => stage.stageId === stageId)
      expect(manifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000"])
      if (!importedStage?.metadata) throw new Error("导入阶段没有持久化工作表来源信息")
      expect(importedStage.metadata.sheetInfo).toEqual({
        names: ["Data_可读", "Data_原始编码", "变量标签", "数值标签映射"],
        selected: "Data_原始编码",
      })
      expect(importPart.state.output).toContain("Data_原始编码（本次导入）")
      expect(result.sheet_info).toEqual({
        names: ["Data_可读", "Data_原始编码", "变量标签", "数值标签映射"],
        selected: "Data_原始编码",
      })
      expect(importTurnModelContext).toContain("Data_原始编码")
      expect(outputReference).toMatch(/^tool-output:tool_[0-9A-Za-z]+$/)

      userTurn = 2
      turnModelRound = 0
      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "请用 Read 工具分页检查刚才导入的完整输出，确认是否包含 city 列；不要运行回归。" }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })
      const continuedMessages = await Session.messages({ sessionID: session.id })
      expect(turnModelRound).toBe(2)
      expect(readResult).toContain("city")
      expect(assistantText(continuedMessages)).toContain("已从 Data_原始编码 的完整导入结果确认存在 city 列")
      expect(assistantText(continuedMessages)).not.toContain(outputReference)
      expect(continuedMessages.some((message) => message.info.role === "assistant" &&
        message.parts.some((part) => part.type === "tool" && part.tool === "econometrics_execute"))).toBe(false)

      userTurn = 3
      turnModelRound = 0
      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: `请从同一个文件 ${source} 另外导入 Data_可读 工作表，保留之前导入的工作表阶段，不做回归。` }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })
      const switchedSheetMessages = await Session.messages({ sessionID: session.id })
      const completedImports = switchedSheetMessages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted } => part.type === "tool" &&
          part.tool === "data_import" && part.state.status === "completed" && part.state.input?.action === "import")
      const rawSheetImport = completedImports.find((part) =>
        asRecord(part.state.metadata.result)?.sheet_info &&
        asRecord(asRecord(part.state.metadata.result)?.sheet_info)?.selected === "Data_原始编码",
      )
      const readableSheetImport = completedImports.find((part) =>
        asRecord(asRecord(part.state.metadata.result)?.sheet_info)?.selected === "Data_可读",
      )
      expect(turnModelRound).toBe(2)
      expect(sessionErrors).toEqual([])
      expect(engineSheetNames).toEqual(["Data_原始", "Data_原始编码", "Data_可读"])
      expect(enginePayloads.map((payload) => asRecord(payload.sheet_info)?.selected))
        .toEqual(["Data_原始编码", "Data_可读"])
      expect(rawSheetImport).toBeDefined()
      expect(readableSheetImport).toBeDefined()
      if (!rawSheetImport || !readableSheetImport) throw new Error("同一工作簿的两个成功工作表导入均应保留在会话中")
      const rawResult = asRecord(rawSheetImport.state.metadata.result)
      const readableResult = asRecord(readableSheetImport.state.metadata.result)
      expect(rawResult?.columns_before).toBe(35)
      expect(asRecord(rawResult?.sheet_info)?.selected).toBe("Data_原始编码")
      expect(readableResult?.columns_before).toBe(34)
      expect(readableResult?.rows_before).toBe(4709)
      expect(readableResult?.variables).not.toContain("city")
      expect(asRecord(readableResult?.sheet_info)?.selected).toBe("Data_可读")
      expect(readableSheetImport.state.metadata.datasetId).toBe(rawSheetImport.state.metadata.datasetId)
      expect(readableSheetImport.state.metadata.stageId).toBe("stage_001")
      expect(rawSheetImport.state.metadata.stageId).toBe("stage_000")
      const switchedDatasetId = typeof readableSheetImport.state.metadata.datasetId === "string"
        ? readableSheetImport.state.metadata.datasetId
        : undefined
      const switchedManifest = switchedDatasetId ? readDatasetManifest(switchedDatasetId) : undefined
      expect(switchedManifest?.stages.map((stage) => stage.stageId)).toEqual(["stage_000", "stage_001"])
      expect(switchedManifest?.stages.map((stage) => stage.metadata?.sourceSheet)).toEqual([
        "named_sheet::Data_原始编码::0",
        "named_sheet::Data_可读::0",
      ])
      expect(switchedManifest?.stages.map((stage) => stage.metadata?.sheetInfo)).toEqual([
        { names: ["Data_可读", "Data_原始编码", "变量标签", "数值标签映射"], selected: "Data_原始编码" },
        { names: ["Data_可读", "Data_原始编码", "变量标签", "数值标签映射"], selected: "Data_可读" },
      ])
      expect(assistantText(switchedSheetMessages)).toContain("另行导入 Data_可读 工作表")
      expect(switchedSheetMessages.some((message) => message.info.role === "assistant" &&
        message.parts.some((part) => part.type === "tool" && part.tool === "econometrics_execute"))).toBe(false)

      userTurn = 4
      turnModelRound = 0
      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: `请再次从同一文件 ${source} 导入 Data_可读，复用已导入的数据，不做回归。` }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })
      const repeatedSheetMessages = await Session.messages({ sessionID: session.id })
      const repeatedSheetImports = repeatedSheetMessages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted } => part.type === "tool" &&
          part.tool === "data_import" && part.state.status === "completed" && part.state.input?.action === "import" &&
          asRecord(asRecord(part.state.metadata.result)?.sheet_info)?.selected === "Data_可读")
      expect(turnModelRound).toBe(2)
      expect(sessionErrors).toEqual([])
      expect(repeatedSheetImports).toHaveLength(2)
      expect(repeatedSheetImports.map((part) => part.state.metadata.stageId)).toEqual(["stage_001", "stage_001"])
      expect(engineSheetNames).toEqual(["Data_原始", "Data_原始编码", "Data_可读"])
      expect(enginePayloads.map((payload) => asRecord(payload.sheet_info)?.selected))
        .toEqual(["Data_原始编码", "Data_可读"])
      const repeatedSheetImport = repeatedSheetImports.at(-1)
      if (!repeatedSheetImport) throw new Error("重复导入没有保留已完成的工作表结果")
      const repeatedResult = asRecord(repeatedSheetImport.state.metadata.result)
      expect(repeatedResult?.columns_before).toBe(34)
      expect(asRecord(repeatedResult?.sheet_info)?.selected).toBe("Data_可读")
      expect(repeatedResult?.warnings).toContain("Reused existing import stage because the source file fingerprint is unchanged.")
      const finalDatasetId = typeof repeatedSheetImport.state.metadata.datasetId === "string"
        ? repeatedSheetImport.state.metadata.datasetId
        : undefined
      expect(finalDatasetId).toBe(switchedDatasetId)
      if (!finalDatasetId) throw new Error("重复导入结果缺少当前数据集血缘")
      expect(readDatasetManifest(finalDatasetId).stages.map((stage) => stage.stageId))
        .toEqual(["stage_000", "stage_001"])
      expect(assistantText(repeatedSheetMessages)).toContain("已有可复用的导入阶段")
      expect(repeatedSheetMessages.some((message) => message.info.role === "assistant" &&
        message.parts.some((part) => part.type === "tool" && part.tool === "econometrics_execute"))).toBe(false)
    } })
  } finally {
    unsubscribeSessionError?.()
    await Instance.disposeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

test.skipIf(!hasLocalRealData("did.xlsx") || !hasLocalRealData("gf.xlsx"))("真实数据路径错误且候选不唯一时等待用户选择再导入", async () => {
  if (!process.env.KILLSTATA_PYTHON) {
    throw new Error("该真实路径恢复回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python 执行")
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-real-missing-path-recovery-"))
  const dataDirectory = path.join(root, "data")
  fs.mkdirSync(dataDirectory, { recursive: true })
  const source = path.join(dataDirectory, "did.xlsx")
  const secondCandidate = path.join(dataDirectory, "gf.xlsx")
  const missingSource = path.join(dataDirectory, "diid.xlsx")
  fs.copyFileSync(localRealDataPath("did.xlsx"), source)
  fs.copyFileSync(localRealDataPath("gf.xlsx"), secondCandidate)
  let userTurn = 1
  let turnModelRound = 0
  let failedPathContext = ""
  let globOutput = ""
  let userConfirmationContext = ""
  const engineMethods: string[] = []
  const sessionErrors: string[] = []
  let unsubscribeSessionError: (() => void) | undefined

  try {
    await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      unsubscribeSessionError = Bus.subscribe(Session.Event.Error, (event) => {
        const error = event.properties.error
        if (event.properties.sessionID === session.id && error) {
          sessionErrors.push(String(error.data?.message ?? error.name))
        }
      })
      AnalysisIntent.markAnalystPlanApproval(session.id, true)
      const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
      const originalExecute = EconometricsEngineClient.prototype.execute
      spies.push(spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(async function (this: EconometricsEngineClient, payload, signal) {
        const methodID = asRecord(payload)?.method_id
        if (typeof methodID === "string") engineMethods.push(methodID)
        return originalExecute.call(this, payload, signal)
      }))
      spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
        const registration = await scriptedAnalysisRequestResponse(request)
        if (registration) return registration as never
if (String(request.agent.name).toLowerCase() === "verifier") {
          return { fullStream: completeTextStream("<verifier_result>{\"status\":\"pass\",\"checks\":[],\"blockingFindings\":[],\"repairHints\":[],\"trustedArtifacts\":[],\"summary\":\"导入核验完成。\",\"findings\":[]}</verifier_result>") } as never
        }
        if (request.small) return { fullStream: completeTextStream("本地摘要") } as never
        turnModelRound += 1
        if (userTurn === 1 && turnModelRound === 1) {
          return { fullStream: completeImport(missingSource, "Data_可读", "call_import_missing_path") } as never
        }
        if (userTurn === 1 && turnModelRound === 2) {
          failedPathContext = modelVisibleText(request.messages)
          return {
            fullStream: completeToolCall("glob", "call_locate_correct_data", { pattern: "data/*.xlsx" }),
          } as never
        }
        if (userTurn === 1 && turnModelRound === 3) {
          globOutput = latestNamedToolResultText(request.messages, "glob")
          return {
            fullStream: completeTextStream(globOutput.includes("data/did.xlsx") && globOutput.includes("data/gf.xlsx")
              ? "路径 `data/diid.xlsx` 不存在。我找到两个候选文件 `data/did.xlsx` 和 `data/gf.xlsx`。为避免选错，请告诉我确认导入哪一个；目前尚未导入任何候选文件。"
              : "指定路径不存在，工作区也没有找到匹配的数据文件；我尚未导入任何数据。请提供正确路径。"),
          } as never
        }
        if (userTurn === 2 && turnModelRound === 1) {
          userConfirmationContext = modelVisibleText(request.messages)
          return { fullStream: completeImport(source, "Data_可读", "call_import_user_confirmed_path") } as never
        }
        if (userTurn === 2 && turnModelRound >= 2) {
          return { fullStream: completeTextStream("已按你确认的路径导入 Data_可读 工作表并完成数据画像；没有运行回归。") } as never
        }
        throw new Error(`路径恢复回放出现未预期模型轮次：turn=${userTurn} round=${turnModelRound}`)
      }))

      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: `请导入 ${missingSource} 的 Data_可读 工作表，完成数据画像，不要回归。` }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })
      const beforeConfirmation = await Session.messages({ sessionID: session.id })
      const firstTurnImports = beforeConfirmation
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "data_import" && part.state.input?.action === "import")
      const missingImport = firstTurnImports.find((part) => part.state.status === "error")
      const locationCall = beforeConfirmation
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .find((part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted } =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
        )
      expect(turnModelRound).toBe(3)
      expect(missingImport?.state.status).toBe("error")
      expect(missingImport?.state.status === "error" ? missingImport.state.error : "").toMatch(/找不到输入文件|文件不存在|File not found/i)
      expect(failedPathContext).toContain(missingSource)
      expect(globOutput).toContain("data/did.xlsx")
      expect(globOutput).toContain("data/gf.xlsx")
      expect(locationCall?.state.output).toContain("data/did.xlsx")
      expect(locationCall?.state.output).toContain("data/gf.xlsx")
      expect(engineMethods).toEqual([])
      expect(assistantText(beforeConfirmation)).toContain("尚未导入")
      expect(assistantText(beforeConfirmation)).toContain("请告诉我确认导入哪一个")
      expect(beforeConfirmation.some((message) => message.info.role === "assistant" &&
        message.parts.some((part) => part.type === "tool" && part.tool === "econometrics_execute"))).toBe(false)

      userTurn = 2
      turnModelRound = 0
      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: `我确认选择 data/did.xlsx；请导入 ${source} 的 Data_可读 工作表并完成数据画像，不要回归。` }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })
      const confirmedMessages = await Session.messages({ sessionID: session.id })
      const successfulImport = confirmedMessages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .find((part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted } =>
          part.type === "tool" && part.tool === "data_import" && part.state.status === "completed" &&
          part.state.input?.action === "import" &&
          asRecord(asRecord(part.state.metadata.result)?.sheet_info)?.selected === "Data_可读",
        )
      expect(turnModelRound).toBe(2)
      expect(sessionErrors).toEqual([])
      expect(userConfirmationContext).toContain(source)
      expect(engineMethods).toEqual(["data_import"])
      expect(successfulImport).toBeDefined()
      if (!successfulImport) throw new Error("用户确认的有效路径没有导入成功")
      expect(successfulImport.state.metadata.datasetId).toBeTruthy()
      expect(successfulImport.state.metadata.stageId).toBe("stage_000")
      expect(asRecord(successfulImport.state.metadata.result)?.rows_before).toBe(4709)
      expect(asRecord(successfulImport.state.metadata.result)?.columns_before).toBe(34)
      expect(asRecord(asRecord(successfulImport.state.metadata.result)?.sheet_info)?.selected).toBe("Data_可读")
      expect(assistantText(confirmedMessages)).toContain("按你确认的路径导入 Data_可读")
      expect(confirmedMessages.some((message) => message.info.role === "assistant" &&
        message.parts.some((part) => part.type === "tool" && part.tool === "econometrics_execute"))).toBe(false)
      expect(sessionErrors).toEqual([])
    } })
  } finally {
    unsubscribeSessionError?.()
    await Instance.disposeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

test.skipIf(!hasLocalRealData("did.xlsx"))("真实数据路径错误且没有候选时停下询问，用户补充路径后继续导入", async () => {
  if (!process.env.KILLSTATA_PYTHON) {
    throw new Error("该真实路径恢复回放要求显式设置 KILLSTATA_PYTHON；禁止静默跳过 Python 执行")
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-real-no-path-candidate-"))
  const incomingDirectory = path.join(root, "incoming")
  const archiveDirectory = path.join(root, "archive")
  fs.mkdirSync(incomingDirectory, { recursive: true })
  fs.mkdirSync(archiveDirectory, { recursive: true })
  const source = path.join(archiveDirectory, "did.xlsx")
  const missingSource = path.join(incomingDirectory, "did.xlsx")
  fs.copyFileSync(localRealDataPath("did.xlsx"), source)
  let userTurn = 1
  let turnModelRound = 0
  let failedPathContext = ""
  let globOutput = ""
  let confirmationContext = ""
  const engineMethods: string[] = []
  const sessionErrors: string[] = []
  let unsubscribeSessionError: (() => void) | undefined

  try {
    await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      unsubscribeSessionError = Bus.subscribe(Session.Event.Error, (event) => {
        const error = event.properties.error
        if (event.properties.sessionID === session.id && error) {
          sessionErrors.push(String(error.data?.message ?? error.name))
        }
      })
      AnalysisIntent.markAnalystPlanApproval(session.id, true)
      const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
      const originalExecute = EconometricsEngineClient.prototype.execute
      spies.push(spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(async function (this: EconometricsEngineClient, payload, signal) {
        const methodID = asRecord(payload)?.method_id
        if (typeof methodID === "string") engineMethods.push(methodID)
        return originalExecute.call(this, payload, signal)
      }))
      spies.push(spyOn(ModelGateway, "stream").mockImplementation(async (request) => {
        const registration = await scriptedAnalysisRequestResponse(request)
        if (registration) return registration as never
if (String(request.agent.name).toLowerCase() === "verifier") {
          return { fullStream: completeTextStream("<verifier_result>{\"status\":\"pass\",\"checks\":[],\"blockingFindings\":[],\"repairHints\":[],\"trustedArtifacts\":[],\"summary\":\"导入核验完成。\",\"findings\":[]}</verifier_result>") } as never
        }
        if (request.small) return { fullStream: completeTextStream("本地摘要") } as never
        turnModelRound += 1
        if (userTurn === 1 && turnModelRound === 1) {
          return { fullStream: completeImport(missingSource, "Data_可读", "call_import_no_candidate") } as never
        }
        if (userTurn === 1 && turnModelRound === 2) {
          failedPathContext = modelVisibleText(request.messages)
          return {
            fullStream: completeToolCall("glob", "call_search_empty_incoming", { pattern: "incoming/*.xlsx" }),
          } as never
        }
        if (userTurn === 1 && turnModelRound === 3) {
          globOutput = latestNamedToolResultText(request.messages, "glob")
          return {
            fullStream: completeTextStream(globOutput.includes("No files found")
              ? "`incoming/did.xlsx` 不存在，指定目录中也没有候选文件。我没有从其它目录自动选文件，也没有导入；请提供正确路径后我再继续。"
              : "指定目录没有返回可验证的文件结果，我没有导入数据。请提供正确路径后我再继续。"),
          } as never
        }
        if (userTurn === 2 && turnModelRound === 1) {
          confirmationContext = modelVisibleText(request.messages)
          return { fullStream: completeImport(source, "Data_可读", "call_import_user_supplied_path") } as never
        }
        if (userTurn === 2 && turnModelRound >= 2) {
          return { fullStream: completeTextStream("已按你补充的正确路径导入 Data_可读 工作表并完成数据画像；没有运行回归。") } as never
        }
        throw new Error(`无候选路径恢复回放出现未预期模型轮次：turn=${userTurn} round=${turnModelRound}`)
      }))

      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: `请导入 ${missingSource} 的 Data_可读 工作表，完成数据画像，不要回归。` }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })
      const beforeCorrection = await Session.messages({ sessionID: session.id })
      const importPartsBeforeCorrection = beforeCorrection
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "data_import" && part.state.input?.action === "import")
      const failedImport = importPartsBeforeCorrection.find((part) => part.state.status === "error")
      const successfulImports = importPartsBeforeCorrection.filter((part) => part.state.status === "completed")
      const globPart = beforeCorrection
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .find((part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted } =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
        )
      expect(turnModelRound).toBe(3)
      expect(failedImport?.state.status).toBe("error")
      expect(failedImport?.state.status === "error" ? failedImport.state.error : "").toMatch(/找不到输入文件|文件不存在|File not found/i)
      expect(failedPathContext).toContain(missingSource)
      expect(globOutput).toContain("No files found")
      expect(globPart?.state.input.pattern).toBe("incoming/*.xlsx")
      expect(successfulImports).toHaveLength(0)
      expect(engineMethods).toEqual([])
      expect(assistantText(beforeCorrection)).toContain("目录中也没有候选文件")
      expect(assistantText(beforeCorrection)).toContain("请提供正确路径")
      expect(assistantText(beforeCorrection)).not.toMatch(/已完成(?:导入|回归|分析)/)
      expect(beforeCorrection.some((message) => message.info.role === "assistant" &&
        message.parts.some((part) => part.type === "tool" && part.tool === "econometrics_execute"))).toBe(false)

      userTurn = 2
      turnModelRound = 0
      await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: `请导入 ${source} 的 Data_可读 工作表并完成数据画像，不要回归。` }],
        model: { providerID: model.providerID, modelID: model.id },
        agent: "analyst",
      })
      const correctedMessages = await Session.messages({ sessionID: session.id })
      const correctedImport = correctedMessages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .find((part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted } =>
          part.type === "tool" && part.tool === "data_import" && part.state.status === "completed" &&
          part.state.input?.action === "import" &&
          asRecord(asRecord(part.state.metadata.result)?.sheet_info)?.selected === "Data_可读",
        )
      expect(turnModelRound).toBe(2)
      expect(sessionErrors).toEqual([])
      expect(confirmationContext).toContain(source)
      expect(engineMethods).toEqual(["data_import"])
      expect(correctedImport).toBeDefined()
      if (!correctedImport) throw new Error("用户补充正确路径后没有完成真实导入")
      expect(correctedImport.state.metadata.stageId).toBe("stage_000")
      expect(asRecord(correctedImport.state.metadata.result)?.rows_before).toBe(4709)
      expect(asRecord(correctedImport.state.metadata.result)?.columns_before).toBe(34)
      expect(asRecord(asRecord(correctedImport.state.metadata.result)?.sheet_info)?.selected).toBe("Data_可读")
      expect(assistantText(correctedMessages)).toContain("按你补充的正确路径导入 Data_可读")
      expect(correctedMessages.some((message) => message.info.role === "assistant" &&
        message.parts.some((part) => part.type === "tool" && part.tool === "econometrics_execute"))).toBe(false)
      expect(sessionErrors).toEqual([])
    } })
  } finally {
    unsubscribeSessionError?.()
    await Instance.disposeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
