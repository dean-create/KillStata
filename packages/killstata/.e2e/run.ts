import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { DataImportTool } from "@/tool/data-import"
import { EconometricsTool } from "@/tool/econometrics"
import { experimentLogPath } from "@/tool/analysis-experiment-log"

const ctx = {
  sessionID: "e2e", messageID: "", callID: "", agent: "explorer",
  abort: AbortSignal.any([]), metadata: async () => undefined, ask: async () => undefined,
} as any

const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-e2e-"))
const csv = path.join(root, "grunfeld.csv")
fs.copyFileSync("test/fixtures/golden/grunfeld.csv", csv)

await Instance.provide({ directory: root, fn: async () => {
  const di = await DataImportTool.init()
  const eco = await EconometricsTool.init()

  // 实验 1：全样本
  const imp = await di.execute({ action: "import", inputPath: csv } as any, ctx)
  const datasetId = (imp.metadata as any).datasetId
  const baseStage = (imp.metadata as any).stageId
  console.log("导入:", datasetId, "stage:", baseStage)

  await eco.execute({
    methodName: "panel_fe_regression", datasetId,
    dependentVar: "invest", treatmentVar: "value", covariates: ["capital"],
    entityVar: "firm", timeVar: "year", clusterVar: "firm",
  } as any, ctx)
  console.log("实验1 完成（全样本）")

  // 实验 2：剔除早期年份 → 样本变小
  const filtered = await di.execute({
    action: "filter", datasetId, stageId: baseStage,
    filters: [{ column: "year", operator: "gte", value: 1940 }],
  } as any, ctx)
  const stageId = (filtered.metadata as any).stageId
  console.log("过滤后 stage:", stageId)

  await eco.execute({
    methodName: "panel_fe_regression", datasetId, stageId,
    dependentVar: "invest", treatmentVar: "value", covariates: ["capital"],
    entityVar: "firm", timeVar: "year", clusterVar: "firm",
  } as any, ctx)
  console.log("实验2 完成（剔除 1940 前）")

  const logPath = experimentLogPath(datasetId)
  console.log("\n========== 自动生成的 EXPERIMENT_LOG.md ==========\n")
  console.log(fs.readFileSync(logPath, "utf-8"))
}})
fs.rmSync(root, { recursive: true, force: true })
