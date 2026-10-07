import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { readDatasetManifest } from "@/runtime/dataset-state"
import { DataImportTool } from "@/tool/data-import"
import { appendStage } from "@/tool/analysis-state"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"

const ctx = {
  sessionID: "ses_data_readiness_import",
  messageID: "msg_data_readiness_import",
  callID: "call_data_readiness_import",
  agent: "econometrics",
  abort: new AbortController().signal,
  metadata: async () => undefined,
  ask: async () => undefined,
}

describe("上传后的静默数据就绪检查", () => {
  test("导入完成时生成方法候选和可追溯的结构性问题报告", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-data-readiness-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[data-readiness-import] KILLSTATA_PYTHON 未设置，跳过需要受管 Python 的真实导入断言")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    try {
      const source = path.join(root, "gf-like.csv")
      fs.writeFileSync(
        source,
        [
          "province,region,year,outcome,credit,investment,insurance,bond,support,fund,equity",
          ...Array.from({ length: 12 }, (_, index) => {
            const province = index % 2 === 0 ? "A" : "B"
            const region = index % 2 === 0 ? "North" : "South"
            const year = 2020 + Math.floor(index / 2)
            const investment = (index % 3) + 1
            const insurance = (index % 2) + 1
            const bond = (index % 4) + 1
            const support = ((index * 3) % 5) + 1
            const credit = investment + insurance + bond + support
            const outcome = 10 + ((index * index + 3 * index) % 17)
            const fund = 3 + ((index * 5 + 1) % 11)
            const equity = 4 + ((index * 7 + 2) % 13)
            return `${province},${region},${year},${outcome},${credit},${investment},${insurance},${bond},${support},${fund},${equity}`
          }),
        ].join("\n"),
        "utf-8",
      )

      await Instance.provide({ directory: root, fn: async () => {
        const imported = await (await DataImportTool.init()).execute({ action: "import", inputPath: source, preserveLabels: true }, ctx as never)
        const result = imported.metadata.result as {
          readiness?: {
            candidateMethods: Array<{ methodID: string }>
            exactLinearDependencies: Array<{ relation: string }>
          }
          autoQa?: { status: string; warnings: string[]; blockingErrors: string[] }
        }
        expect(result.readiness?.candidateMethods.map((item) => item.methodID)).toContain("ols_regression")
        expect(result.readiness?.exactLinearDependencies.map((item) => item.relation)).toContain(
          "credit = investment + insurance + bond + support",
        )

        const manifest = readDatasetManifest(imported.metadata.datasetId!)
        const stage = manifest.stages.find((item) => item.stageId === imported.metadata.stageId)
        expect(stage?.metadata?.dataReadiness).toMatchObject({ version: 1, rowCount: 12 })
        expect(stage?.metadata?.autoQa).toMatchObject({ status: "pass", blockingErrors: [] })
        expect(result.autoQa?.status).toBe("pass")
        const qualitySummaryIndex = imported.output.indexOf("质量体检摘要")
        const variableSummaryIndex = imported.output.indexOf("- 变量：")
        expect(qualitySummaryIndex).toBeGreaterThanOrEqual(0)
        expect(variableSummaryIndex).toBeGreaterThan(qualitySummaryIndex)
        expect(variableSummaryIndex - qualitySummaryIndex).toBeLessThan(320)
        expect(imported.output.slice(variableSummaryIndex, variableSummaryIndex + 240)).toContain("province")
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test("数据导出使用同一规范数据阶段并只写入用户指定的受控目标", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-data-export-stage-"))
    if (!process.env.KILLSTATA_PYTHON) {
      fs.rmSync(root, { recursive: true, force: true })
      throw new Error("真实导出回归必须设置受管 KILLSTATA_PYTHON，不能静默跳过")
    }
    try {
      const source = path.join(root, "input.csv")
      fs.writeFileSync(source, "id,outcome\nA,1\nB,2\n", "utf-8")
      await Instance.provide({ directory: root, fn: async () => {
        const tool = await DataImportTool.init()
        const imported = await tool.execute({ action: "import", inputPath: source, preserveLabels: true }, ctx as never)
        const destination = path.join(root, "exports", "result.csv")
        const exported = await tool.execute({
          action: "export",
          datasetId: imported.metadata.datasetId,
          stageId: imported.metadata.stageId,
          format: "csv",
          outputPath: destination,
        }, ctx as never)

        expect(fs.existsSync(destination)).toBe(true)
        expect(fs.readFileSync(destination, "utf-8")).toContain("id,outcome")
        expect(exported.output).toContain("数据导出已完成")
        expect(exported.metadata.datasetId).toBe(imported.metadata.datasetId)
        expect(exported.metadata.stageId).toBe(imported.metadata.stageId)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("导入时拒绝 Python 返回受管数据根外的数据或 schema 路径", async () => {
    if (!process.env.KILLSTATA_PYTHON) throw new Error("路径返回值回归必须使用受管 Python 配置")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-data-import-forged-output-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-data-import-external-output-"))
    const source = path.join(root, "input.csv")
    fs.writeFileSync(source, "id,value\nA,1\nB,2\n", "utf-8")
    const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(async (payload) => ({
      payload: {
        success: true,
        input_path: payload.data_path,
        dataPath: path.join(external, "private.parquet"),
        schemaPath: path.join(external, "schema.json"),
        resultPath: path.join(external, "results.json"),
        rows: 2,
        columns: 2,
        variables: ["id", "value"],
      },
    } as never))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const tool = await DataImportTool.init()
        await expect(tool.execute({ action: "import", inputPath: source, preserveLabels: true }, ctx as never))
          .rejects.toThrow(/受管数据目录之外|路径与 Harness 预定目标不一致/)
      } })
      expect(executeSpy).toHaveBeenCalledTimes(1)
    } finally {
      executeSpy.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  }, 60_000)

  test("只有表头没有观测时，导入仍可完成但自动 QA 阻断估计", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-empty-readiness-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[data-readiness-import] KILLSTATA_PYTHON 未设置，跳过空数据自动 QA 断言")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    try {
      const source = path.join(root, "empty.csv")
      fs.writeFileSync(source, "outcome,treatment\n", "utf-8")
      await Instance.provide({ directory: root, fn: async () => {
        const imported = await (await DataImportTool.init()).execute({ action: "import", inputPath: source, preserveLabels: true }, ctx as never)
        const result = imported.metadata.result as {
          readiness?: { usableObservationCount?: number }
          autoQa?: { status: string; blockingErrors: string[] }
        }
        const presentation = imported.metadata.presentation as { highlights?: string[]; nextActions?: string[] }
        expect(result.readiness?.usableObservationCount).toBe(0)
        expect(result.autoQa?.status).toBe("block")
        expect(result.autoQa?.blockingErrors.join(" ")).toMatch(/观测|数据|空/i)
        expect(JSON.stringify(presentation)).toContain("暂不能估计")
        expect(presentation.nextActions?.join(" ")).toMatch(/处理|修复/)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test("对派生 stage 做 describe 后写回该 stage 的新鲜就绪报告", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-refresh-readiness-"))
    if (!process.env.KILLSTATA_PYTHON) {
      console.warn("[data-readiness-import] KILLSTATA_PYTHON 未设置，跳过派生 stage 刷新断言")
      fs.rmSync(root, { recursive: true, force: true })
      return
    }
    try {
      const source = path.join(root, "derived.csv")
      fs.writeFileSync(source, ["outcome,treatment", "1,0", "2,1", "3,0", "4,1"].join("\n"), "utf-8")
      await Instance.provide({ directory: root, fn: async () => {
        const imported = await (await DataImportTool.init()).execute({ action: "import", inputPath: source, preserveLabels: true }, ctx as never)
        const manifest = readDatasetManifest(imported.metadata.datasetId!)
        const importedStage = manifest.stages.find((stage) => stage.stageId === imported.metadata.stageId)!
        appendStage(manifest, {
          stageId: "stage_001",
          parentStageId: imported.metadata.stageId,
          branch: "main",
          action: "filter",
          workingPath: importedStage.workingPath,
          workingFormat: "parquet",
          createdAt: new Date().toISOString(),
        })
        const described = await (await DataImportTool.init()).execute({
          action: "profile",
          preserveLabels: true,
          datasetId: imported.metadata.datasetId,
          stageId: "stage_001",
          variables: ["outcome", "treatment"],
        }, ctx as never)
        const refreshed = readDatasetManifest(imported.metadata.datasetId!).stages.find((stage) => stage.stageId === "stage_001")
        expect((described.metadata.result as { readiness?: { rowCount: number } }).readiness?.rowCount).toBe(4)
        expect(refreshed?.metadata?.dataReadiness).toMatchObject({ version: 1, sourceStageId: "stage_001", rowCount: 4 })
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
