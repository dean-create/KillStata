/**
 * data_import(action="correlation") 回归测试。
 *
 * 背景：内联 Python 的 correlation 分支漏了 emit(result)，stdout 全空，
 * parsePythonResult 抛 "Python produced no parseable output" → 该 action 必失败。
 * 这个测试锁死"correlation 必须返回可解析结果并写出相关系数 CSV/工作簿"。
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
import { readDatasetManifest } from "@/runtime/dataset-state"

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "golden", "did.csv")

const ctx = {
  sessionID: "data-import-correlation",
  messageID: "",
  callID: "",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-corr-"))
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
    throw new Error(`data_import artifact contract requires the managed Python runtime: ${String(error)}`)
  }
}

describe("data_import correlation", () => {
  test("ignores the legacy inspection flag and does not duplicate the imported table", async () => {
    await withInstance(async () => {
      await requireRuntime()
      const tool = await (await ToolRegistry.byID("data_import"))!.init()
      const parsed = tool.parameters.parse({
        action: "import",
        inputPath: FIXTURE,
        createInspectionArtifacts: true,
      }) as Record<string, unknown>
      // TS tool parameters are only the generic transport envelope; the production model
      // schema comes from Python Registry. DataImportTool must project only declared fields
      // into its Pydantic request, so this legacy caller flag stays local and cannot affect it.
      expect(parsed).toHaveProperty("createInspectionArtifacts", true)

      const result = await tool.execute(
        { action: "import", inputPath: FIXTURE, createInspectionArtifacts: true } as never,
        ctx as never,
      )
      const meta = result.metadata as { datasetId?: string; stageId?: string }
      const manifest = readDatasetManifest(meta.datasetId!)
      const stage = manifest?.stages.find((item) => item.stageId === meta.stageId)

      expect(stage?.inspectionPath).toBeUndefined()
      expect(stage?.inspectionWorkbookPath).toBeUndefined()
      const inspectionDir = path.resolve(path.dirname(stage!.workingPath), "..", "inspection")
      expect(fs.existsSync(inspectionDir)).toBe(false)
    })
  }, 120_000)

  test("returns a parseable result and writes the correlation matrix", async () => {
    await withInstance(async (root) => {
      await requireRuntime()
      const { datasetId, stageId } = registerCanonicalDataset({ sessionID: ctx.sessionID, sourcePath: FIXTURE })
      const tool = await (await ToolRegistry.byID("data_import"))!.init()
      const result = await tool.execute(
        { action: "correlation", datasetId, stageId, variables: ["高质量发展指数", "人均GDP", "人口规模"], preserveLabels: true },
        ctx as never,
      )
      const meta = result.metadata as {
        result?: { output_path?: string; workbook_path?: string; variables?: string[] }
      }
      // metadata 里的路径已被 prepareToolMetadata 相对化到项目根，断言时要拼回 Instance 目录。
      const abs = (p?: string) => (p ? path.resolve(root, p) : undefined)
      expect(meta.result?.output_path).toBeTruthy()
      expect(fs.existsSync(abs(meta.result!.output_path)!)).toBe(true)
      // 减法：correlation 不再生成 xlsx 工作簿（只写 csv + summary.json）
      expect(meta.result?.workbook_path).toBeUndefined()
      expect(meta.result?.variables?.length).toBeGreaterThan(0)
    })
  }, 120_000)
})
