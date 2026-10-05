import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { createDatasetManifest, appendStage, readDatasetManifest } from "@/tool/analysis-state"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { readStoredDataReadinessState } from "@/runtime/data-readiness"
import { DataPreprocessTool } from "../../src/tool/data-preprocess"

/**
 * combine_columns 生成的复合实体键，其 unique/duplicateRows 只有对新 stage 重算才准确。
 * 沿父链继承父报告无法证明新列的唯一性——而面板门禁恰恰以此判定。
 *
 * 真实事故（2026-08-28 did.xlsx 会话）：模型正确诊断「省份×year 有 4267 行重复」，
 * 正确用 combine_columns 造出「省份_地区」，但新 stage 没有 readiness 报告，
 * 面板方法永远 needs_user_decision，用户三次追问「结果呢」都拿不到回归。
 */
function context(sessionID: string) {
  return {
    sessionID,
    messageID: "msg_readiness",
    callID: "call_readiness",
    agent: "econometrics",
    abort: new AbortController().signal,
    metadata: async () => undefined,
    ask: async () => undefined,
  }
}

/** 同名地区分属不同省份：单用「地区」有重复键，「省份+地区」可消解——与真实 did.xlsx 同构。 */
function setupDuplicateRegionPanel(root: string, datasetId: string, sessionID: string) {
  const sourcePath = path.join(root, "panel.csv")
  const rows = ["省份,地区,year,创新指数"]
  for (const province of ["江苏", "浙江"]) {
    for (const region of ["城区", "郊区"]) {
      for (const year of [2010, 2011, 2012]) {
        rows.push(`${province},${region},${year},${(rows.length * 0.11).toFixed(3)}`)
      }
    }
  }
  fs.writeFileSync(sourcePath, rows.join("\n") + "\n", "utf-8")
  const manifest = createDatasetManifest({ datasetId, sourcePath, sourceFormat: "csv" })
  appendStage(manifest, {
    stageId: "stage_000",
    branch: "main",
    action: "import",
    workingPath: sourcePath,
    workingFormat: "parquet",
    createdAt: new Date().toISOString(),
  })
  recordWorkflowStageSuccess({
    sessionID,
    toolName: "econometrics_recommend",
    args: { datasetId, stageId: "stage_000" },
    metadata: { datasetId, stageId: "stage_000" },
  })
  return sourcePath
}

describe("data_preprocess 新 stage 的数据就绪报告", () => {
  test("combine_columns 生成复合键后，新 stage 自带重算过的 readiness 且复合键唯一", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-readiness-"))
    const previousPython = process.env.KILLSTATA_PYTHON
    if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const datasetId = "preprocess_readiness"
          const sessionID = "ses_preprocess_readiness"
          setupDuplicateRegionPanel(root, datasetId, sessionID)
          const tool = await DataPreprocessTool.init()
          const result = await tool.execute(
            {
              datasetId,
              stageId: "stage_000",
              method: "combine_columns",
              columns: ["省份", "地区"],
              options: { output_column: "省份_地区", separator: "_" },
            },
            context(sessionID) as never,
          )

          const childStageId = result.metadata.stageId as string
          expect(childStageId).not.toBe("stage_000")

          // 1) 新 stage 必须自带 readiness，且归属正确
          const manifest = readDatasetManifest(datasetId)
          const child = manifest.stages.find((stage) => stage.stageId === childStageId)!
          const readiness = child.metadata?.dataReadiness as { sourceStageId?: string } | undefined
          expect(readiness).toBeDefined()
          expect(readiness?.sourceStageId).toBe(childStageId)

          // 2) 通过公开读取路径也必须拿得到，且不是 stale
          const state = readStoredDataReadinessState(datasetId, childStageId)
          expect(state.report).toBeDefined()
          expect(state.stale).toBe(false)

          // 3) 新复合列必须出现在重算后的 columns 里——继承父报告拿不到这一列
          const columnNames = state.report!.columns.map((column) => column.name)
          expect(columnNames).toContain("省份_地区")

          // 4) 复合键对 year 必须判定为唯一：这是面板门禁放行的依据
          const composite = state.report!.panelCandidates.find(
            (candidate) => candidate.entityVars.length === 1 && candidate.entityVars[0] === "省份_地区",
          )
          expect(composite).toBeDefined()
          expect(composite!.duplicateRows).toBe(0)
          expect(composite!.unique).toBe(true)

          // 5) 用户也可能采用中文语义名称；名称不含“省/地区/id”时仍必须识别为实体候选。
          const semanticResult = await tool.execute(
            {
              datasetId,
              stageId: "stage_000",
              method: "combine_columns",
              columns: ["省份", "地区"],
              options: { output_column: "复合实体键", separator: "_" },
            },
            context(sessionID) as never,
          )
          const semanticStageId = semanticResult.metadata.stageId as string
          const semanticState = readStoredDataReadinessState(datasetId, semanticStageId)
          const semanticComposite = semanticState.report?.panelCandidates.find(
            (candidate) => candidate.entityVars.length === 1 && candidate.entityVars[0] === "复合实体键",
          )
          expect(semanticComposite).toBeDefined()
          expect(semanticComposite?.unique).toBe(true)
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
