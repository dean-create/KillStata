import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { Bus } from "../../packages/killstata/src/bus"
import { Instance } from "../../packages/killstata/src/project/instance"
import { RuntimeEvents } from "../../packages/killstata/src/runtime/events"
import { recordWorkflowStageSuccess } from "../../packages/killstata/src/runtime/workflow"
import { Session } from "../../packages/killstata/src/session"
import { SessionProcessor } from "../../packages/killstata/src/session/processor"
import { DataImportTool } from "../../packages/killstata/src/tool/data-import"
import { EconometricsRecommendTool, PanelFeRegressionTool } from "../../packages/killstata/src/tool/econometrics-method-tools"
import { HdfeRegressionTool } from "../../packages/killstata/src/tool/pyfixest"
import { compareNumericResult } from "./numeric"
import { runPanelFeOracle } from "./panel-fe-oracle"

const ROOT = path.resolve(import.meta.dir, "..", "..")
const DID_PATH = "/Users/cw/Desktop/ks/test/did.xlsx"
const DID_SHEET = "Data_原始编码"
const DID_SHA256 = "1f906de3652b904a1436b1e5169a049ac2bbc948001b072bb2b349b92c7bd5db"
const CONTROLS = [
  "人口密度",
  "金融发展程度",
  "城镇化水平",
  "产业结构整体升级",
  "产业结构高级化",
  "教育水平支出",
  "人力资本",
]

type PanelResult = {
  coefficient: number
  std_error: number
  rows_used: number
}

export type PanelFeCoreArgs = {
  dependentVar: string
  treatmentVar: string
  covariates: string[]
  entityVar: string
  timeVar: string
  clusterVar: string
}

function sha256(filePath: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

function loadFrozenBaseline() {
  const calibration = JSON.parse(
    fs.readFileSync(path.join(ROOT, "test", "real-paper-chain", "backend-results.json"), "utf-8"),
  ) as {
    panelFe: { results: Array<{ kind: string; coefficient: number; stdError: number; rowsUsed: number }> }
  }
  const baseline = calibration.panelFe.results.find((item) => item.kind === "baseline")
  if (!baseline) throw new Error("真实论文基准结果缺少 baseline")
  return baseline
}

function temporaryProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "killstata-acceptance-pilot-"))
}

export async function runFixedPanelFePilot(coreArgs?: PanelFeCoreArgs) {
  if (!fs.existsSync(DID_PATH)) throw new Error(`缺少真实论文数据：${DID_PATH}`)
  if (sha256(DID_PATH) !== DID_SHA256) throw new Error("did.xlsx 哈希已变化，拒绝使用未锁定数据进行验收")

  const root = temporaryProject()
  try {
    return await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({ title: "acceptance-pilot" })
        const ctx = {
          sessionID: session.id,
          messageID: "message_acceptance_pilot",
          callID: "call_acceptance_pilot",
          agent: "econometrics",
          abort: new AbortController().signal,
          metadata: async () => undefined,
          ask: async () => undefined,
        }
        const dataImport = await DataImportTool.init()
        const imported = await dataImport.execute(
          {
            action: "import",
            preserveLabels: true,
            inputPath: DID_PATH,
            sheetPolicy: { mode: "named_sheet", sheetName: DID_SHEET },
            createInspectionArtifacts: false,
          },
          ctx as never,
        )
        const source = { datasetId: imported.metadata.datasetId!, stageId: imported.metadata.stageId! }
        recordWorkflowStageSuccess({
          sessionID: session.id,
          toolName: "data_import",
          args: { action: "import", ...source },
          metadata: { action: "import", ...source },
        })

        const recommend = await EconometricsRecommendTool.init()
        await recommend.execute(
          {
            ...source,
            dependentVar: "经济发展水平",
            treatmentVar: "did",
            entityVar: "city",
            timeVar: "year",
          },
          ctx as never,
        )
        recordWorkflowStageSuccess({
          sessionID: session.id,
          toolName: "econometrics_recommend",
          args: source,
          metadata: source,
        })

        const qa = await dataImport.execute(
          {
            action: "qa",
            preserveLabels: true,
            ...source,
            entityVar: "city",
            timeVar: "year",
            createInspectionArtifacts: false,
          },
          ctx as never,
        )
        if (qa.metadata.qaGateStatus === "block") throw new Error("真实 DID 面板被 QA 错误阻断")
        recordWorkflowStageSuccess({
          sessionID: session.id,
          toolName: "data_import",
          args: { action: "qa", ...source },
          metadata: { action: "qa", ...source, qaGateStatus: qa.metadata.qaGateStatus },
        })

        const params: PanelFeCoreArgs & typeof source = {
          ...source,
          ...(coreArgs ?? {
            dependentVar: "经济发展水平",
            treatmentVar: "did",
            covariates: CONTROLS,
            entityVar: "city",
            timeVar: "year",
            clusterVar: "city",
          }),
        }
        const panelTool = await PanelFeRegressionTool.init()
        const schema = panelTool.parameters.safeParse(params)
        if (!schema.success) throw new Error(`验收参数未通过当前 JSON Schema：${schema.error.message}`)

        const lifecycle: string[] = []
        const unsubscribe = Bus.subscribe(RuntimeEvents.ToolLifecycle, (event) => {
          if (event.properties.sessionID === session.id && event.properties.callID === ctx.callID) {
            lifecycle.push(event.properties.phase)
          }
        })
        let executorCalls = 0
        try {
          const processor = SessionProcessor.create({
            assistantMessage: {
              id: ctx.messageID,
              sessionID: session.id,
              agent: "econometrics",
            } as never,
            sessionID: session.id,
            model: { providerID: "deepseek", id: "deepseek-v4-flash" } as never,
            abort: ctx.abort,
          })
          const executed = await processor.executeTool("panel_fe_regression", params, {
            callID: ctx.callID,
            run: async (finalArgs) => {
              executorCalls += 1
              return panelTool.execute(finalArgs as never, ctx as never)
            },
          })
          const result = executed.metadata.result as PanelResult
          if (!result) throw new Error("Harness 未返回 panel_fe_regression 结构化结果")

          // 独立参考实现必须有自己完整的 workflow 血缘；不能借用 Harness 已推进到
          // verifier 阶段的会话，否则会误把“参考计算”伪装成同一次估计的后续动作。
          const referenceSession = await Session.create({ title: "acceptance-pilot-pyfixest-reference" })
          const referenceCtx = { ...ctx, sessionID: referenceSession.id, messageID: "message_acceptance_reference" }
          for (const [toolName, args, metadata] of [
            ["data_import", { action: "import", ...source }, { action: "import", ...source }],
            ["econometrics_recommend", source, source],
            ["data_import", { action: "qa", ...source }, { action: "qa", ...source, qaGateStatus: "pass" }],
          ] as const) {
            recordWorkflowStageSuccess({ sessionID: referenceSession.id, toolName, args, metadata })
          }
          const hdfeTool = await HdfeRegressionTool.init()
          const hdfe = await hdfeTool.execute(
            {
              ...source,
              dependentVar: "经济发展水平",
              treatmentVar: "did",
              covariates: CONTROLS,
              fixedEffects: ["city", "year"],
              clusterVars: ["city"],
              covariance: "CRV1",
            },
            referenceCtx as never,
          )
          const primary = hdfe.metadata.result?.primary
          if (!primary?.estimate || !hdfe.metadata.result?.rowsUsed) {
            throw new Error("PyFixest 独立交叉实现没有返回完整主结果")
          }

          const frozen = loadFrozenBaseline()
          const independentOracle = runPanelFeOracle()
          return {
            route: { mode: "fixed" as const, toolId: "panel_fe_regression" },
            dataset: { id: "did_real_panel", sha256: DID_SHA256, datasetId: source.datasetId, stageId: source.stageId },
            harness: { schemaAccepted: true, executorCalls, lifecycle },
            result: {
              coefficient: result.coefficient,
              stdError: result.std_error,
              rowsUsed: result.rows_used,
            },
            numeric: {
              independentOracle: {
                engine: "linearmodels.PanelOLS direct workbook oracle",
                reference: independentOracle,
                failures: compareNumericResult(
                  { rowsUsed: result.rows_used, coefficient: result.coefficient, stdError: result.std_error },
                  independentOracle,
                ),
              },
              linearmodelsWiringFailures: compareNumericResult(
                { rowsUsed: result.rows_used, coefficient: result.coefficient, stdError: result.std_error },
                { rowsUsed: frozen.rowsUsed, coefficient: frozen.coefficient, stdError: frozen.stdError },
              ),
              crossEngine: {
                engine: "pyfixest",
                rowsMatch: result.rows_used === hdfe.metadata.result.rowsUsed,
                coefficientGap: Math.abs(result.coefficient - primary.estimate),
                // 两个后端的簇自由度修正不同；报告这个差异，不能伪装成同一 SE oracle。
                stdErrorComparable: false,
                inferenceNote: "PanelOLS 与 PyFixest 的聚类有限样本修正不同；本 pilot 只将系数和样本量作为跨引擎比较。",
              },
            },
          }
        } finally {
          unsubscribe()
        }
      },
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
