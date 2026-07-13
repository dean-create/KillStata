import fs from "fs"
import z from "zod"
import DESCRIPTION from "./experiment-log.txt"
import { Tool } from "./tool"
import { relativeWithinProject } from "./analysis-path"
import { readDatasetIndex, readDatasetManifest } from "./analysis-state"
import { buildExperimentEntries, experimentLogPath, refreshExperimentLog } from "./analysis-experiment-log"

/** 索引按 fingerprint 存条目，没有"当前数据集"的概念，取 updatedAt 最新的那个 */
function latestDatasetId() {
  const entries = Object.values(readDatasetIndex().entries)
  if (entries.length === 0) return undefined
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].datasetId
}

// 日志本身是每次回归后自动写的（见 analysis-experiment-log.refreshExperimentLog）。
// 这个工具只负责让用户和模型能主动把它读出来 —— 典型场景：
//   "我试了几种设定了？" / "剔除那几年之后结果变显著了多少？"
export const ExperimentLogTool = Tool.define("experiment_log", {
  description: DESCRIPTION,
  parameters: z.object({
    datasetId: z.string().optional().describe("Dataset to read the log for. Defaults to the most recent dataset."),
  }),
  async execute(params) {
    const datasetId = params.datasetId ?? latestDatasetId()
    if (!datasetId) {
      throw new Error("No dataset has been imported yet, so there is no experiment log. Import data and run a regression first.")
    }

    // 每次读之前重建一遍：manifest 是唯一真相源，重建保证日志和已落盘的事实一致
    // （比如用户回滚了某个 stage、或某次回归失败了）。
    refreshExperimentLog(datasetId)

    const target = experimentLogPath(datasetId)
    if (!fs.existsSync(target)) {
      throw new Error(
        `No regression has been run on dataset ${datasetId} yet, so the experiment log is empty. Run an estimation first.`,
      )
    }

    const manifest = readDatasetManifest(datasetId)
    const entries = buildExperimentEntries(manifest)
    const content = fs.readFileSync(target, "utf-8")
    const significant = entries.filter((item) => item.pValue !== undefined && item.pValue < 0.05).length

    return {
      title: `实验日志 · ${entries.length} 次实验`,
      output: content,
      metadata: {
        datasetId,
        logPath: relativeWithinProject(target),
        experimentCount: entries.length,
        significantCount: significant,
      },
    }
  },
})
