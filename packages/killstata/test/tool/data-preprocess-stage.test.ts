import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { createDatasetManifest, appendStage, readDatasetManifest } from "@/tool/analysis-state"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { DataPreprocessTool } from "../../src/tool/data-preprocess"

function context(sessionID: string) {
  return {
    sessionID,
    messageID: "msg_preprocess",
    callID: "call_preprocess",
    agent: "econometrics",
    abort: new AbortController().signal,
    metadata: async () => undefined,
    ask: async () => undefined,
  }
}

function setup(root: string, datasetId: string, sessionID: string) {
  const sourcePath = path.join(root, "source.csv")
  fs.writeFileSync(sourcePath, "id,income\na,1\nb,2\nc,100\nd,\n", "utf-8")
  const manifest = createDatasetManifest({ datasetId, sourcePath, sourceFormat: "csv" })
  appendStage(manifest, {
    stageId: "stage_000",
    branch: "main",
    action: "import",
    workingPath: sourcePath,
    workingFormat: "parquet",
    createdAt: new Date().toISOString(),
  })
  recordWorkflowStageSuccess({ sessionID, toolName: "econometrics_recommend", args: { datasetId, stageId: "stage_000" }, metadata: { datasetId, stageId: "stage_000" } })
}

describe("data_preprocess child-stage lineage", () => {
  test("省略可选 options 的删除缺失行方法可执行并创建新阶段", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-stage-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "preprocess_default_options"
        const sessionID = "ses_preprocess_default_options"
        setup(root, datasetId, sessionID)
        const tool = await DataPreprocessTool.init()
        const result = await tool.execute({ datasetId, stageId: "stage_000", method: "listwise_deletion", columns: ["income"] }, context(sessionID) as never)
        expect(result.metadata.stageId).toBe("stage_001")
        expect(readDatasetManifest(datasetId).stages).toHaveLength(2)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("省略 options 的无效条件列规则由 Python 校验拒绝", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-stage-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "preprocess_missing_rule"
        const sessionID = "ses_preprocess_missing_rule"
        setup(root, datasetId, sessionID)
        const tool = await DataPreprocessTool.init()
        await expect(tool.execute({ datasetId, stageId: "stage_000", method: "create_column", columns: ["income"] }, context(sessionID) as never)).rejects.toThrow(/INVALID_ARGUMENT|operator|right_value|output_column/)
        expect(readDatasetManifest(datasetId).stages).toHaveLength(1)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("a mutating operation creates an immutable child stage pointing at the new parquet", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-stage-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "preprocess_stage"
        const sessionID = "ses_preprocess_stage"
        setup(root, datasetId, sessionID)
        const tool = await DataPreprocessTool.init()
        const result = await tool.execute({ datasetId, stageId: "stage_000", method: "winsorize", columns: ["income"], options: { lower: 0.25, upper: 0.25 } }, context(sessionID) as never)
        const manifest = readDatasetManifest(datasetId)
        expect(manifest.stages).toHaveLength(2)
        const child = manifest.stages[1]!
        expect(child.parentStageId).toBe("stage_000")
        expect(child.workingPath).not.toBe(manifest.stages[0]!.workingPath)
        expect(fs.existsSync(child.workingPath)).toBe(true)
        expect(result.metadata.stageId).toBe(child.stageId)
        expect(manifest.finalOutputs).toHaveLength(0)
        expect(result.output).not.toContain("结果文件：")
        expect(result.output).not.toContain("runtime/delivery")
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("a backend rejection leaves the manifest without a half-created child stage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-stage-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "preprocess_reject"
        const sessionID = "ses_preprocess_reject"
        setup(root, datasetId, sessionID)
        const tool = await DataPreprocessTool.init()
        await expect(tool.execute({ datasetId, stageId: "stage_000", method: "log_transform", columns: ["income"], options: { offset: -2 } }, context(sessionID) as never)).rejects.toThrow(/INVALID_DOMAIN|positive/)
        expect(readDatasetManifest(datasetId).stages).toHaveLength(1)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("Python Registry receives all model fields and rejects an unknown field before creating a stage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-stage-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "preprocess_unknown_field"
        const sessionID = "ses_preprocess_unknown_field"
        setup(root, datasetId, sessionID)
        const tool = await DataPreprocessTool.init()
        await expect(tool.execute({
          datasetId,
          stageId: "stage_000",
          method: "winsorize",
          columns: ["income"],
          options: { lower: 0.25, upper: 0.25 },
          action: "profile",
        }, context(sessionID) as never)).rejects.toThrow(/INVALID_ARGUMENT|未定义字段|未声明|extra_forbidden/)
        expect(readDatasetManifest(datasetId).stages).toHaveLength(1)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("重建已存在的post时回到未含post的父阶段，不以列冲突阻断用户纠正", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-post-rebuild-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "post_rebuild"
        const sessionID = "ses_post_rebuild"
        const sourcePath = path.join(root, "did.csv")
        fs.writeFileSync(sourcePath, "id,year,time,y\na,2012,2012,1\na,2013,2012,2\nb,2012,,3\nb,2013,,4\n", "utf-8")
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
        const tool = await DataPreprocessTool.init()
        await tool.execute({
          datasetId,
          stageId: "stage_000",
          method: "create_column",
          columns: ["year"],
          options: { operator: "gte", right_column: "time", output_column: "post" },
        }, context(sessionID) as never)

        const rebuilt = await tool.execute({
          datasetId,
          stageId: "stage_001",
          method: "create_column",
          columns: ["year"],
          options: { operator: "gte", right_value: 2013, output_column: "post" },
        }, context(sessionID) as never)

        const stages = readDatasetManifest(datasetId).stages
        expect(stages).toHaveLength(3)
        expect(stages[2]?.parentStageId).toBe("stage_000")
        expect(rebuilt.metadata.stageId).toBe("stage_002")
        expect(rebuilt.output).toContain("父阶段 stage_000")
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("a filter producing zero rows is rejected before creating an empty child stage", async () => {
    const managedPython = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    if (!fs.existsSync(managedPython)) {
      console.warn("[data-preprocess-stage] 受管 Python 不可用，跳过空筛选 stage 回归")
      return
    }
    const previousPython = process.env.KILLSTATA_PYTHON
    process.env.KILLSTATA_PYTHON = managedPython
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-stage-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "preprocess_empty_filter"
        const sessionID = "ses_preprocess_empty_filter"
        setup(root, datasetId, sessionID)
        const tool = await DataPreprocessTool.init()
        await expect(tool.execute({
          datasetId,
          stageId: "stage_000",
          method: "filter",
          columns: [],
          options: { rules: [{ column: "income", operator: "gt", value: 10_000, caseSensitive: false }] },
        }, context(sessionID) as never)).rejects.toThrow(/筛选结果为空/)
        expect(readDatasetManifest(datasetId).stages).toHaveLength(1)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
    }
  }, 60_000)

  test("a non-mutating diagnostic keeps its user-visible report without creating a child stage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-stage-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "preprocess_diagnostic"
        const sessionID = "ses_preprocess_diagnostic"
        setup(root, datasetId, sessionID)
        const tool = await DataPreprocessTool.init()
        await tool.execute(
          { datasetId, stageId: "stage_000", method: "zscore_detect", columns: ["income"], options: { threshold: 3 } },
          context(sessionID) as never,
        )
        const manifest = readDatasetManifest(datasetId)
        expect(manifest.stages).toHaveLength(1)
        expect(manifest.finalOutputs).toHaveLength(1)
        expect(fs.existsSync(manifest.finalOutputs[0]!.path)).toBe(true)
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("拒绝把诊断报告写入受管 reports 目录指向的外部 symlink", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-report-symlink-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-report-external-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "preprocess_report_symlink"
        const sessionID = "ses_preprocess_report_symlink"
        setup(root, datasetId, sessionID)
        const reports = path.join(root, ".killstata", "datasets", datasetId, "reports")
        fs.rmSync(reports, { recursive: true, force: true })
        fs.symlinkSync(external, reports, "dir")
        const tool = await DataPreprocessTool.init()
        await expect(tool.execute(
          { datasetId, stageId: "stage_000", method: "zscore_detect", columns: ["income"], options: { threshold: 3 } },
          context(sessionID) as never,
        )).rejects.toThrow(/受管数据目录之外|符号链接/)
        expect(readDatasetManifest(datasetId).stages).toHaveLength(1)
        expect(fs.readdirSync(external)).toEqual([])
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  }, 60_000)

  test("拒绝把 mutation summary 和 log 写入受管 audit 目录指向的外部 symlink", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-audit-symlink-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-audit-external-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "preprocess_audit_symlink"
        const sessionID = "ses_preprocess_audit_symlink"
        setup(root, datasetId, sessionID)
        const audit = path.join(root, ".killstata", "datasets", datasetId, "audit")
        fs.rmSync(audit, { recursive: true, force: true })
        fs.symlinkSync(external, audit, "dir")
        const tool = await DataPreprocessTool.init()
        await expect(tool.execute(
          { datasetId, stageId: "stage_000", method: "winsorize", columns: ["income"], options: { lower: 0.25, upper: 0.25 } },
          context(sessionID) as never,
        )).rejects.toThrow(/受管数据目录之外|符号链接/)
        expect(readDatasetManifest(datasetId).stages).toHaveLength(1)
        expect(fs.readdirSync(external)).toEqual([])
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  }, 60_000)

  test("用户确认等待期间 audit 目录被替换为 symlink 时，在调用 Python 前取消", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-audit-race-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-preprocess-audit-race-external-"))
    try {
      await Instance.provide({ directory: root, fn: async () => {
        const datasetId = "preprocess_audit_race"
        const sessionID = "ses_preprocess_audit_race"
        setup(root, datasetId, sessionID)
        const audit = path.join(root, ".killstata", "datasets", datasetId, "audit")
        let swapped = false
        const tool = await DataPreprocessTool.init()
        await expect(tool.execute(
          { datasetId, stageId: "stage_000", method: "winsorize", columns: ["income"], options: { lower: 0.25, upper: 0.25 } },
          {
            ...context(sessionID),
            ask: async () => {
              if (swapped) return
              swapped = true
              fs.rmSync(audit, { recursive: true, force: true })
              fs.symlinkSync(external, audit, "dir")
            },
          } as never,
        )).rejects.toThrow(/符号链接|受管数据目录之外/)
        expect(swapped).toBe(true)
        expect(readDatasetManifest(datasetId).stages).toHaveLength(1)
        expect(fs.readdirSync(external)).toEqual([])
      } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  }, 60_000)
})
