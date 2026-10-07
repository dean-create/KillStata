/**
 * data_import(action="frequency") 回归测试。
 *
 * 背景：did×post 等有界分布诊断过去只能依赖 export→read 2.2MB CSV；read 会被安全门禁拒绝。
 * 新增 frequency 动作直接返回每列频数+交叉分组频数，不再生成行级 CSV，避免 read 死锁。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { execFileSync } from "child_process"
import { resolveFrequencyGroupBy, resolveKnownColumnNames, resolveSessionDatasetID } from "../../src/tool/data-import"

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "golden", "did.csv")

const ctx = {
  sessionID: "ses_data_import_frequency",
  messageID: "msg_frequency",
  callID: "call_frequency",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-frequency-"))
  const previousPython = process.env.KILLSTATA_PYTHON
  if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
    else process.env.KILLSTATA_PYTHON = previousPython
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function requireRuntime() {
  try {
    const python = await resolveRuntimePythonCommand()
    execFileSync(python, ["-c", "import pandas, openpyxl"], { stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    throw new Error(`data_import frequency contract requires the managed Python runtime: ${String(error)}`)
  }
}

describe("data_import frequency", () => {
  test("仅在 profile 提供对应真实列时对齐无歧义的中文时间别名", () => {
    expect(resolveFrequencyGroupBy(["年份", "did"], ["year", "did"])).toEqual(["year", "did"])
    expect(resolveFrequencyGroupBy(["年份"], ["period"])).toEqual(["年份"])
    expect(resolveKnownColumnNames(["年份", "did"], ["year", "did"])).toEqual({
      names: ["year", "did"],
      corrections: [{ from: "年份", to: "year" }],
    })
    expect(resolveKnownColumnNames(["年份"], ["年份", "year"])).toEqual({ names: ["年份"], corrections: [] })
    expect(resolveSessionDatasetID("dataset_demo", ["did_1"])).toEqual({
      datasetID: "did_1",
      correctedFrom: "dataset_demo",
    })
    expect(resolveSessionDatasetID("did_2", ["did_1", "did_2"])).toEqual({ datasetID: "did_2" })
    expect(resolveSessionDatasetID("dataset_demo", ["did_1", "did_2"])).toEqual({ datasetID: "dataset_demo" })
  })

  test("returns bounded distributions and crosstab without writing per-row CSV", async () => {
    await withInstance(async (root) => {
      await requireRuntime()
      const { datasetId, stageId } = registerCanonicalDataset({ sessionID: ctx.sessionID, sourcePath: FIXTURE })
      const tool = await (await ToolRegistry.byID("data_import"))!.init()
      const result = await tool.execute(
        { action: "frequency", datasetId, stageId, variables: ["did", "post", "year"], groupBy: ["did", "post"] } as never,
        ctx as never,
      )
      const meta = result.metadata as {
        result?: {
          distributions?: Record<string, Array<{ value: string; count: number; share: number }>>
          distribution_meta?: Record<string, { numeric?: boolean; min?: number; max?: number; distinct_count: number }>
          cross_tab?: Array<{ values: string[]; count: number; share: number }>
          group_by?: string[]
          max_distinct?: number
        }
        action?: string
      }
      expect(meta.action).toBe("frequency")
      expect(meta.result?.distributions?.did?.length).toBeGreaterThan(0)
      expect(meta.result?.distributions?.post?.length).toBeGreaterThan(0)
      expect(meta.result?.group_by).toEqual(["did", "post"])
      expect(meta.result?.cross_tab?.length).toBeGreaterThan(0)
      expect(meta.result?.distribution_meta?.year).toMatchObject({ min: 2005, max: 2021, distinct_count: 17 })
      const allShares = Object.values(meta.result?.distributions ?? {}).flat()
      for (const entry of allShares) {
        expect(entry.share).toBeGreaterThanOrEqual(0)
        expect(entry.share).toBeLessThanOrEqual(1)
      }
      // 不生成行级 csv
      const output = result.output as string
      expect(output).toContain("频数诊断")
      expect(output).not.toMatch(/\.csv"/)
    })
  }, 120_000)

  test("rejects more than two groupBy columns to keep crosstab bounded", async () => {
    await withInstance(async () => {
      await requireRuntime()
      const { datasetId, stageId } = registerCanonicalDataset({ sessionID: ctx.sessionID, sourcePath: FIXTURE })
      const tool = await (await ToolRegistry.byID("data_import"))!.init()
      await expect(
        tool.execute(
          { action: "frequency", datasetId, stageId, variables: ["did"], groupBy: ["did", "post", "year"] } as never,
          ctx as never,
        ),
      ).rejects.toThrow(/groupBy 最多/)
    })
  }, 120_000)

  test("质量体检模式的只读 frequency 结果直接进入文字收尾", async () => {
    await withInstance(async () => {
      await requireRuntime()
      const { datasetId, stageId } = registerCanonicalDataset({ sessionID: ctx.sessionID, sourcePath: FIXTURE })
      const tool = await (await ToolRegistry.byID("data_import"))!.init()
      const result = await tool.execute(
        { action: "frequency", datasetId, stageId, variables: ["did"] } as never,
        { ...ctx, extra: { qualityInspectionOnly: true } } as never,
      )
      expect(result.metadata.finalizeTextOnly).toBe(true)
    })
  }, 120_000)

  test("healthcheck 即使在会话含活动数据集时也不伪造并登记结果文件", async () => {
    await withInstance(async () => {
      await requireRuntime()
      const { datasetId, stageId } = registerCanonicalDataset({ sessionID: ctx.sessionID, sourcePath: FIXTURE })
      const tool = await (await ToolRegistry.byID("data_import"))!.init()
      const result = await tool.execute({
        action: "healthcheck",
        datasetId,
        stageId,
        preserveLabels: true,
      } as never, ctx as never)
      const { readDatasetManifest } = await import("@/tool/analysis-state")
      const manifest = readDatasetManifest(datasetId)
      expect(result.metadata.action).toBe("healthcheck")
      expect(manifest.stages).toHaveLength(1)
      expect(manifest.artifacts).toHaveLength(0)
      expect(JSON.stringify(manifest)).not.toContain("python-environment_")
    })
  }, 120_000)
})
