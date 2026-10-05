import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { DataImportTool } from "@/tool/data-import"
import { EconometricsRecommendTool } from "@/tool/auto-recommend"
import { PanelFeTool } from "../../../../trash/killstata-legacy-econometrics/tool/panel-fe"
import { OlsRegressionTool } from "../../../../trash/killstata-legacy-econometrics/tool/ols"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { hasLocalRealData, localRealDataPath } from "../helpers/local-real-data"

const context = {
  sessionID: "ses_test_datasets_readiness",
  messageID: "msg_test_datasets_readiness",
  callID: "call_test_datasets_readiness",
  agent: "econometrics",
  abort: new AbortController().signal,
  metadata: async () => undefined,
  ask: async () => undefined,
}

describe("test_datasets.xlsx 真实结构边界", () => {
  test.skipIf(!hasLocalRealData("test_datasets.xlsx"))("重复地区年份时保留 OLS 候选，但拒绝不适用的 Panel FE 规格", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-test-datasets-readiness-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[test-datasets-readiness] KILLSTATA_PYTHON 未设置，跳过真实 Excel 结构边界")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    const sessionID = `ses_test_datasets_${Date.now()}`
    try {
      const sourcePath = localRealDataPath("test_datasets.xlsx")
      await Instance.provide({ directory: root, fn: async () => {
        const imported = await (await DataImportTool.init()).execute(
          { action: "import", inputPath: sourcePath, preserveLabels: true },
          { ...context, sessionID } as never,
        )
        const readiness = imported.metadata.result?.readiness
        const candidateIDs = readiness?.candidateMethods
          ?.filter((item) => item.status === "candidate")
          .map((item) => item.methodID) ?? []
        expect(readiness).toMatchObject({ rowCount: 9683, columnCount: 8 })
        expect(candidateIDs).toContain("ols_regression")

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
          dependentVar: "数字普惠金融指数",
          treatmentVar: "每百人互联网用户数",
        }, { ...context, sessionID } as never)
        recordWorkflowStageSuccess({
          sessionID,
          toolName: "econometrics_recommend",
          args: { datasetId: imported.metadata.datasetId!, stageId: imported.metadata.stageId! },
          metadata: recommended.metadata,
        })

        const result = await (await PanelFeTool.init()).execute({
          datasetId: imported.metadata.datasetId!,
          stageId: imported.metadata.stageId!,
          dependentVar: "数字普惠金融指数",
          treatmentVar: "每百人互联网用户数",
          covariates: [],
          entityVar: "地区",
          timeVar: "年份",
          covariance: "clustered",
        }, { ...context, sessionID } as never).catch((error) => error)

        expect(result).toBeInstanceOf(Error)
        expect(String((result as Error).message)).toMatch(/重复|面板键|面板索引|每个个体.*每期|不适合|不能|需/)

        const ols = await (await OlsRegressionTool.init()).execute({
          datasetId: imported.metadata.datasetId!,
          stageId: imported.metadata.stageId!,
          dependentVar: "数字普惠金融指数",
          treatmentVar: "每百人互联网用户数",
          covariates: [],
          covariance: "HC1",
        }, { ...context, sessionID } as never)
        expect(ols.output).toContain("每百人互联网用户数")
        expect(ols.output).toMatch(/N=|有效样本|样本量|观测数/)
        expect(ols.metadata.datasetId!).toBe(imported.metadata.datasetId!)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
