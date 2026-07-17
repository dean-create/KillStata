import fs from "fs"
import path from "path"

export type BenchmarkDataset = {
  id: string
  kind: "user_real_excel" | "linearmodels_builtin" | "authoritative_external"
  path?: string
  sha256?: string
  sheet?: string
  source?: string
  sourceUrl?: string
  methodFamilies: string[]
  capabilities: string[]
  forbiddenSubstitutes?: string[]
}

export type BenchmarkCatalog = {
  schemaVersion: number
  datasets: BenchmarkDataset[]
  toolDefaults: Record<string, string>
}

const catalogPath = path.resolve(import.meta.dir, "..", "fixtures", "benchmark-catalog.json")

export function loadBenchmarkCatalog(): BenchmarkCatalog {
  return JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as BenchmarkCatalog
}

export function resolveDatasetForTool(catalog: BenchmarkCatalog, toolId: string, requestedDatasetId?: string) {
  const defaultId = catalog.toolDefaults[toolId]
  if (!defaultId) throw new Error(`工具 ${toolId} 尚未配置验收数据集`)
  if (requestedDatasetId && requestedDatasetId !== defaultId) {
    throw new Error(`${toolId} 的验收数据集固定为 ${defaultId}；${requestedDatasetId} 不能替代它`)
  }
  const dataset = catalog.datasets.find((item) => item.id === defaultId)
  if (!dataset) throw new Error(`验收目录缺少数据集 ${defaultId}`)
  return dataset
}
