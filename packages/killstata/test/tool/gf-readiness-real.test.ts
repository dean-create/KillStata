import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { readDatasetManifest } from "@/runtime/dataset-state"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { DataImportTool } from "@/tool/data-import"
import { PanelFeTool } from "../../../../trash/killstata-legacy-econometrics/tool/panel-fe"
import { EconometricsRecommendTool } from "@/tool/auto-recommend"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { resolveTools } from "@/session/prompt/tools"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { Bus } from "@/bus"
import { Question } from "@/question"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const ctx = {
  sessionID: "ses_gf_readiness_real",
  messageID: "msg_gf_readiness_real",
  callID: "call_gf_readiness_real",
  agent: "econometrics",
  abort: new AbortController().signal,
  metadata: async () => undefined,
  ask: async () => undefined,
}

async function prepareGfAnalysis(sessionID: string, sourcePath: string) {
  const imported = await (await DataImportTool.init()).execute(
    { action: "import", inputPath: sourcePath, preserveLabels: true },
    { ...ctx, sessionID } as never,
  )
  recordWorkflowStageSuccess({
    sessionID,
    toolName: "data_import",
    args: { action: "import", inputPath: sourcePath },
    metadata: imported.metadata,
  })
  const recommended = await (await EconometricsRecommendTool.init()).execute({
    datasetId: imported.metadata.datasetId!,
    stageId: imported.metadata.stageId!,
    entityVar: "地区",
    timeVar: "年份",
    dependentVar: "绿色金融指数",
    treatmentVar: "绿色信贷",
  }, { ...ctx, sessionID } as never)
  recordWorkflowStageSuccess({
    sessionID,
    toolName: "econometrics_recommend",
    args: { datasetId: imported.metadata.datasetId!, stageId: imported.metadata.stageId! },
    metadata: recommended.metadata,
  })
  return imported
}

function registerPanelEstimate(sessionID: string, researchGoal: string) {
  const taskId = `task_${sessionID}`
  RuntimeTaskLedger.recordQueued({
    id: taskId,
    sessionID,
    type: "prompt",
    priority: 10,
    createdAt: Date.now(),
    metadata: { messageID: ctx.messageID, intent: "analysis", requiredToolIDs: ["panel_fe_regression"] },
  })
  return RuntimeTaskLedger.recordAnalysisRequest({
    sessionID,
    taskId,
    sourceMessageId: ctx.messageID,
    kind: "estimate",
    researchGoal,
    constraints: [],
  })
}

async function loadPanelSchema(resolved: Awaited<ReturnType<typeof resolveTools>>) {
  await resolved.port.execute({
    id: "call_gf_panel_schema_search",
    name: "tool_search",
    input: { query: "panel_fe_regression", limit: 1 },
    abort: new AbortController().signal,
  })
  const loadedMethodIDs = resolved.methodReferences().map((reference) => reference.toolID)
  if (!loadedMethodIDs.includes("panel_fe_regression")) {
    throw new Error(`tool_search 未加载 panel_fe_regression Schema：${loadedMethodIDs.join(", ")}`)
  }
  return loadedMethodIDs
}

describe("gf.xlsx 真实上传就绪检查", () => {
  test.skipIf(!hasLocalRealData("gf.xlsx"))("导入后识别可适配方法、地区复合面板键和完全共线分项", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-gf-readiness-real-"))
    const sourcePath = localRealDataPath("gf.xlsx")
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[gf-readiness-real] KILLSTATA_PYTHON 未设置，跳过真实 Excel 导入断言")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const imported = await (await DataImportTool.init()).execute({ action: "import", inputPath: sourcePath, preserveLabels: true }, ctx as never)
        const readiness = (imported.metadata.result as { readiness?: {
          rowCount: number
          columnCount: number
          panelCandidates: Array<{ entityVars: string[]; timeVar: string; unique: boolean }>
          exactLinearDependencies: Array<{ relation: string }>
          candidateMethods: Array<{ methodID: string; status: string }>
        } }).readiness
        expect(readiness).toMatchObject({ rowCount: 9_545, columnCount: 11 })
        expect(readiness?.candidateMethods.filter((item) => item.status === "candidate").map((item) => item.methodID)).toEqual(
          expect.arrayContaining(["ols_regression", "panel_fe_regression"]),
        )
        expect(readiness?.candidateMethods.filter((item) => item.status === "candidate").map((item) => item.methodID)).not.toEqual(
          expect.arrayContaining(["poisson_regression", "negbin_regression"]),
        )
        const manifest = readDatasetManifest(imported.metadata.datasetId!)
        const persistedReadiness = manifest.stages.find((stage) => stage.stageId === imported.metadata.stageId)?.metadata?.dataReadiness as typeof readiness
        expect(persistedReadiness?.panelCandidates.some((candidate) =>
          candidate.timeVar === "年份" &&
          candidate.unique &&
          (candidate.entityVars.includes("地区") || candidate.entityVars.includes("省份"))
        )).toBe(true)
        expect(readiness?.exactLinearDependencies.map((item) => item.relation)).toContain(
          "绿色信贷 = 绿色投资 + 绿色保险 + 绿色债券 + 绿色支持",
        )
        const analysisView = (imported.metadata.analysisView as { warnings?: string[] } | undefined)
        expect(analysisView?.warnings?.some((warning) => warning.includes("绿色信贷 = 绿色投资 + 绿色保险 + 绿色债券 + 绿色支持"))).toBe(true)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("did.xlsx"))("方法推荐优先使用上传阶段已验证的唯一面板键，而不是第一列实体候选", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-recommend-panel-key-real-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[recommend-panel-key-real] KILLSTATA_PYTHON 未设置，跳过真实推荐断言")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    try {
      const sourcePath = localRealDataPath("did.xlsx")
      await Instance.provide({ directory: root, fn: async () => {
        const sessionID = `ses_recommend_panel_key_${Date.now()}`
        const imported = await (await DataImportTool.init()).execute(
          { action: "import", inputPath: sourcePath, preserveLabels: true },
          { ...ctx, sessionID } as never,
        )
        const recommended = await (await EconometricsRecommendTool.init()).execute(
          {
            datasetId: imported.metadata.datasetId!,
            stageId: imported.metadata.stageId!,
            dependentVar: "创新指数",
            treatmentVar: "did",
          },
          { ...ctx, sessionID } as never,
        )
        const recommendation = (recommended.metadata as { recommendation?: {
          recommendedMethod?: string
          preferredEntityVar?: string
          preferredTimeVar?: string
        } }).recommendation
        const profile = (recommended.metadata as { profile?: {
          duplicatePanelKeys?: number
          explicitEntityVar?: string
          explicitTimeVar?: string
        } }).profile

        expect(recommendation?.recommendedMethod).toBe("panel_fe_regression")
        expect(recommendation?.preferredEntityVar).toBe("地区")
        expect(recommendation?.preferredTimeVar).toBe("year")
        expect(profile?.explicitEntityVar).toBe("地区")
        expect(profile?.explicitTimeVar).toBe("year")
        expect(profile?.duplicatePanelKeys).toBe(0)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("gf.xlsx"))("质量体检导入的真实结果标记仅文字收尾，普通导入不标记", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-gf-quality-finalize-real-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[gf-quality-finalize-real] KILLSTATA_PYTHON 未设置，跳过真实质量收尾标记断言")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    try {
      const sourcePath = localRealDataPath("gf.xlsx")
      await Instance.provide({ directory: root, fn: async () => {
        const qualityResult = await (await DataImportTool.init()).execute(
          { action: "import", inputPath: sourcePath, preserveLabels: true },
          { ...ctx, extra: { qualityInspectionOnly: true } } as never,
        )
        const normalResult = await (await DataImportTool.init()).execute(
          { action: "import", inputPath: sourcePath, preserveLabels: true },
          ctx as never,
        )
        expect(qualityResult.metadata.finalizeTextOnly).toBe(true)
        expect(normalResult.metadata.finalizeTextOnly).toBeUndefined()
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("gf.xlsx"))("gf.xlsx 分项恒等式进入同一规格时拒绝完全共线回归", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-gf-collinear-real-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[gf-collinear-real] KILLSTATA_PYTHON 未设置，跳过真实共线拒绝断言")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    try {
      const sourcePath = localRealDataPath("gf.xlsx")
      await Instance.provide({ directory: root, fn: async () => {
        const sessionID = `ses_gf_collinear_${Date.now()}`
        const imported = await prepareGfAnalysis(sessionID, sourcePath)
        const collinear = await (await PanelFeTool.init()).execute({
          datasetId: imported.metadata.datasetId!,
          stageId: imported.metadata.stageId!,
          dependentVar: "绿色金融指数",
          treatmentVar: "绿色信贷",
          covariates: ["绿色投资", "绿色保险", "绿色债券", "绿色支持", "绿色基金", "绿色权益"],
          entityVar: "地区",
          timeVar: "年份",
          covariance: "clustered",
        }, { ...ctx, sessionID } as never).catch((error) => error)

        expect(collinear).toBeInstanceOf(Error)
        const message = String((collinear as Error).message)
        expect(message).toMatch(/共线|线性依赖|秩|rank|full column/i)
        expect(message).toContain("修复建议")
        expect(message).toMatch(/不要|不能|不建议|先|移除|重新指定/)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("gf.xlsx"))("真实 gf.xlsx 使用年份列执行面板固定效应并交付结果文件", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-gf-panel-real-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[gf-panel-real] KILLSTATA_PYTHON 未设置，跳过真实面板估计断言")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    try {
      const sourcePath = localRealDataPath("gf.xlsx")
      await Instance.provide({ directory: root, fn: async () => {
        const imported = await prepareGfAnalysis(ctx.sessionID, sourcePath)
        const estimate = await (await PanelFeTool.init()).execute({
          datasetId: imported.metadata.datasetId!,
          stageId: imported.metadata.stageId!,
          dependentVar: "绿色金融指数",
          treatmentVar: "绿色信贷",
          covariates: [],
          entityVar: "地区",
          timeVar: "年份",
          covariance: "clustered",
        }, ctx as never)

        expect(estimate.output).toContain("绿色信贷")
        expect(estimate.output).toMatch(/N=|有效样本|样本量|观测数/)
        expect(estimate.metadata.datasetId!).toBe(imported.metadata.datasetId!)
        expect(estimate.metadata.stageId!).toBe(imported.metadata.stageId!)
        const analysisView = estimate.metadata.analysisView as { artifacts?: unknown[] }
        expect(analysisView.artifacts?.length).toBeGreaterThan(0)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("gf.xlsx"))("模型误用 year 时先询问用户，确认后只执行真实年份列", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-gf-year-recovery-real-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[gf-year-recovery-real] KILLSTATA_PYTHON 未设置，跳过真实纠错回放")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const sessionID = `ses_gf_year_recovery_${Date.now()}`
    const methodExecutions: string[] = []
    let restoreExecuteSpy: (() => void) | undefined
    try {
      const sourcePath = localRealDataPath("gf.xlsx")
      await Instance.provide({ directory: root, fn: async () => {
        const execute = EconometricsEngineClient.prototype.execute
        const executionSpy = spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(function (
          this: EconometricsEngineClient,
          payload,
          signal,
        ) {
          methodExecutions.push(payload.method_id)
          return execute.call(this, payload, signal)
        })
        restoreExecuteSpy = () => executionSpy.mockRestore()
        await prepareGfAnalysis(sessionID, sourcePath)
        const request = registerPanelEstimate(sessionID, "双向固定效应面板回归：实体=地区，时间=year，被解释变量=绿色金融指数，核心解释变量=绿色信贷")

        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_gf_year_recovery" },
          partFromToolCall: () => undefined,
          executeTool: async (toolName: string, args: unknown, options: {
            beforeRun?: (input: unknown) => Promise<unknown>
            run(input: unknown): Promise<unknown>
          }) => {
            const blocked = await options.beforeRun?.(args)
            if (blocked) return blocked
            return options.run(args)
          },
        }
        const resolved = await resolveTools({
          agent,
          model,
          session: {
            id: sessionID,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } as never,
          processor: processor as never,
          intent: "analysis",
          preferredToolIDs: ["panel_fe_regression"],
          requiredToolIDs: ["panel_fe_regression"],
          userText: "导入 gf.xlsx，做双向固定效应面板回归：实体=地区，时间=year，被解释变量=绿色金融指数，核心解释变量=绿色信贷。",
          sourceUserMessageId: ctx.messageID,
        })

        let asked: { question: string; options: string[] } | undefined
        const unsubscribe = Bus.subscribe(Question.Event.Asked, (event) => {
          const question = event.properties.questions[0]
          asked = {
            question: String(question?.question ?? ""),
            options: (question?.options ?? []).map((option) => String(option.label)),
          }
          Question.reply({ requestID: event.properties.id, answers: [["用“年份”替代（推荐）"]] }).catch(() => {})
        })
        try {
          const schemaSentToolIDs = await loadPanelSchema(resolved)
          const prepared = await resolved.port.execute({
            id: "call_gf_year_recovery",
            name: "analysis_prepare",
            input: {
              requestId: request.requestId,
              methodID: "panel_fe_regression",
              arguments: {
                dependentVar: "绿色金融指数",
                treatmentVar: "绿色信贷",
                covariates: [],
                entityVar: "地区",
                timeVar: "年份",
                covariance: "clustered",
              },
            },
            abort: new AbortController().signal,
            schemaSentToolIDs,
          }) as { output: string; metadata?: Record<string, unknown> }
          const specId = RuntimeTaskLedger.listTasks(sessionID).tasks.find((item) => item.analysisRequest?.requestId === request.requestId)?.preparedSpec?.specId
          if (typeof specId !== "string") throw new Error(`确认列名后没有准备出 Panel FE 规格：${String(prepared.output)}`)
          const result = await resolved.port.execute({
            id: "call_gf_year_recovery_execute",
            name: "econometrics_execute",
            input: { specId },
            abort: new AbortController().signal,
          }) as { output: string; metadata?: Record<string, unknown> }

          expect(asked?.question).toContain("year")
          expect(asked?.question).toContain("年份")
          expect(asked?.options.join(" ")).toContain("年份")
          expect(methodExecutions.filter((methodID) => methodID === "panel_fe_regression")).toHaveLength(1)
          expect(result.output).toContain("绿色信贷")
          expect(result.output).toContain("有效样本")
        } finally {
          unsubscribe()
        }
      } })
    } finally {
      restoreExecuteSpy?.()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(!hasLocalRealData("gf.xlsx"))("用户拒绝替换 year 时停在确认点，不执行 Panel FE", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-gf-year-reject-real-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[gf-year-reject-real] KILLSTATA_PYTHON 未设置，跳过真实拒绝回放")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const sessionID = `ses_gf_year_reject_${Date.now()}`
    const methodExecutions: string[] = []
    let restoreExecuteSpy: (() => void) | undefined
    try {
      const sourcePath = localRealDataPath("gf.xlsx")
      await Instance.provide({ directory: root, fn: async () => {
        const execute = EconometricsEngineClient.prototype.execute
        const executionSpy = spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(function (
          this: EconometricsEngineClient,
          payload,
          signal,
        ) {
          methodExecutions.push(payload.method_id)
          return execute.call(this, payload, signal)
        })
        restoreExecuteSpy = () => executionSpy.mockRestore()
        await prepareGfAnalysis(sessionID, sourcePath)
        const request = registerPanelEstimate(sessionID, "双向固定效应面板回归：实体=地区，时间=year，被解释变量=绿色金融指数，核心解释变量=绿色信贷")
        const model = await Provider.getModel("deepseek", "deepseek-v4-flash")
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_gf_year_reject" },
          partFromToolCall: () => undefined,
          executeTool: async (toolName: string, args: unknown, options: {
            beforeRun?: (input: unknown) => Promise<unknown>
            run(input: unknown): Promise<unknown>
          }) => {
            const blocked = await options.beforeRun?.(args)
            if (blocked) return blocked
            return options.run(args)
          },
        }
        const resolved = await resolveTools({
          agent,
          model,
          session: {
            id: sessionID,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } as never,
          processor: processor as never,
          intent: "analysis",
          preferredToolIDs: ["panel_fe_regression"],
          requiredToolIDs: ["panel_fe_regression"],
          userText: "导入 gf.xlsx，做双向固定效应面板回归：实体=地区，时间=year，被解释变量=绿色金融指数，核心解释变量=绿色信贷。",
          sourceUserMessageId: ctx.messageID,
        })

        let asked = false
        const unsubscribe = Bus.subscribe(Question.Event.Asked, (event) => {
          asked = true
          Question.reply({ requestID: event.properties.id, answers: [["停止本次分析"]] }).catch(() => {})
        })
        try {
          const schemaSentToolIDs = await loadPanelSchema(resolved)
          await resolved.port.execute({
            id: "call_gf_year_reject_prepare",
            name: "analysis_prepare",
            input: {
              requestId: request.requestId,
              methodID: "panel_fe_regression",
              arguments: {
                dependentVar: "绿色金融指数",
                treatmentVar: "绿色信贷",
                covariates: [],
                entityVar: "地区",
                timeVar: "年份",
                covariance: "clustered",
              },
            },
            abort: new AbortController().signal,
            schemaSentToolIDs,
          })
          const specId = RuntimeTaskLedger.listTasks(sessionID).tasks.find((item) => item.analysisRequest?.requestId === request.requestId)?.preparedSpec?.specId
          if (typeof specId !== "string") throw new Error("拒绝替换回放没有准备出待授权 Panel FE 规格")
          const result = await resolved.port.execute({
            id: "call_gf_year_reject_execute",
            name: "econometrics_execute",
            input: { specId },
            abort: new AbortController().signal,
          }) as { output: string; metadata?: { requiresUserDecision?: boolean } }

          expect(asked, String(result.output)).toBe(true)
          expect(result.metadata?.requiresUserDecision).toBe(true)
          expect(result.output).toContain("尚未执行")
          expect(methodExecutions.filter((methodID) => methodID === "panel_fe_regression")).toHaveLength(0)
        } finally {
          unsubscribe()
        }
      } })
    } finally {
      restoreExecuteSpy?.()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
