import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { readDatasetIndex, readDatasetManifest, getStage } from "../tool/analysis-state"
import { buildExperimentEntries } from "../tool/analysis-experiment-log"
import { isDataFile } from "../tool/data-file"

// 模型每一轮都在对着一个只知道 cwd 和日期的环境块工作——它不知道当前数据集是哪个、
// 活跃阶段是哪个、已经试过几组设定。这些事实全部已经落盘在 manifest / dataset index 里，
// 只是从没被喂给模型。于是模型只能靠翻对话历史去"回忆"自己在哪，压缩之后连这个都没了。
//
// 这个模块把已落盘的事实拼成一个 <data-context> 块。它不新增任何真相来源——纯粹是把
// analysis-state 里已有的东西读出来，因此任何时候重建都和事实一致。
export namespace DataContext {
  const log = Log.create({ service: "session.data-context" })

  /** dataset index 按 fingerprint 存条目，没有"当前"概念，取 updatedAt 最新的那个 */
  function latestDatasetId(): string | undefined {
    const entries = Object.values(readDatasetIndex().entries)
    if (entries.length === 0) return undefined
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].datasetId
  }

  /** 扫工作目录顶层，列出用户放进来的原始数据文件（.killstata 内部产物不算） */
  function dataFilesInWorkdir(): string[] {
    try {
      return fs
        .readdirSync(Instance.directory)
        .filter((name) => isDataFile(name))
        .sort()
        .slice(0, 8)
    } catch {
      return []
    }
  }

  /**
   * 构建 <data-context> 块。没有任何已导入数据集时返回 undefined——
   * 此时不该往系统提示里塞一个空壳，徒增噪音。
   */
  export function build(): string | undefined {
    const datasetId = latestDatasetId()
    const dataFiles = dataFilesInWorkdir()

    // 一个数据集都没导入：顶多提示工作目录里有哪些数据文件可导入
    if (!datasetId) {
      if (dataFiles.length === 0) return undefined
      return ["<data-context>", `  可导入的数据文件: ${dataFiles.join(", ")}`, "</data-context>"].join("\n")
    }

    try {
      const manifest = readDatasetManifest(datasetId)
      const stage = getStage(manifest) // 不传 stageId → 最新阶段
      const experiments = buildExperimentEntries(manifest)

      const lines: string[] = ["<data-context>"]
      lines.push(`  当前数据集: ${datasetId}`)

      const shape =
        stage.rowCount != null && stage.columnCount != null ? ` (${stage.rowCount} 行 × ${stage.columnCount} 列)` : ""
      const label = stage.label ? `: ${stage.label}` : ""
      lines.push(`  活跃阶段: ${stage.stageId} [${stage.action}${label}]${shape}`)

      // 数据的处理链条，让模型知道"现在这份数据是怎么一步步变来的"
      if (manifest.stages.length > 1) {
        const chain = manifest.stages
          .map((s) => `${s.stageId}(${s.action}${s.rowCount != null ? `,${s.rowCount}行` : ""})`)
          .join(" → ")
        lines.push(`  阶段链: ${chain}`)
      }

      if (experiments.length > 0) {
        const significant = experiments.filter((e) => e.pValue != null && e.pValue < 0.05).length
        lines.push(`  已试设定: ${experiments.length} 次（其中 ${significant} 次在 5% 水平显著，详见 EXPERIMENT_LOG.md）`)
      }

      lines.push("</data-context>")
      return lines.join("\n")
    } catch (error) {
      // data-context 是附加价值，绝不能因为它构建失败而让整轮对话报错。
      log.warn("failed to build data-context", { error: String(error) })
      return undefined
    }
  }
}
