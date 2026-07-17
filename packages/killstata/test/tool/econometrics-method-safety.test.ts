import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { Instance } from "@/project/instance"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"
import { OlsRegressionTool } from "@/tool/econometrics-method-tools"

async function supportsEconometricsRuntime() {
  try {
    const python = await resolveRuntimePythonCommand()
    execFileSync(python, ["-c", "import statsmodels.api as sm; import linearmodels; import scipy"], {
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}

function registerDataset(
  root: string,
  sessionID: string,
  rows: string[],
  ready: boolean,
  datasetId = `dataset_${sessionID}`,
) {
  const stageId = "stage_000"
  const csvPath = path.join(root, `${datasetId}.csv`)
  fs.writeFileSync(csvPath, rows.join("\n"), "utf-8")
  const manifest = createDatasetManifest({ datasetId, sourcePath: csvPath, sourceFormat: "csv" })
  appendStage(manifest, {
    stageId,
    branch: "main",
    action: "import",
    workingPath: csvPath,
    workingFormat: "parquet",
    rowCount: rows.length - 1,
    columnCount: rows[0]!.split(",").length,
    createdAt: new Date().toISOString(),
  })

  if (ready) {
    recordWorkflowStageSuccess({
      sessionID,
      toolName: "data_import",
      args: { action: "import", datasetId, stageId },
      metadata: { action: "import", datasetId, stageId },
    })
    recordWorkflowStageSuccess({
      sessionID,
      toolName: "econometrics_recommend",
      args: { datasetId, stageId },
      metadata: { datasetId, stageId },
    })
    recordWorkflowStageSuccess({
      sessionID,
      toolName: "data_import",
      args: { action: "qa", datasetId, stageId },
      metadata: { action: "qa", datasetId, stageId, qaGateStatus: "pass" },
    })
  }
  return { datasetId, stageId }
}

function context(sessionID: string) {
  return {
    sessionID,
    messageID: "message_1",
    callID: "call_1",
    agent: "econometrics",
    abort: new AbortController().signal,
    metadata: async () => undefined,
    ask: async () => undefined,
  }
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-method-safety-"))
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("production econometrics method safety", () => {
  test("rejects an estimator call until the same canonical stage has completed profile and QA", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const sessionID = "unprepared"
      const source = registerDataset(root, sessionID, ["y,x", "2,1", "4,2", "6,3"], false)
      const tool = await OlsRegressionTool.init()

      expect(
        tool.execute(
          { ...source, dependentVar: "y", treatmentVar: "x", covariance: "HC1" },
          context(sessionID) as never,
        ),
      ).rejects.toThrow(/画像.*QA|profile.*QA/i)
    })
  })

  test("never reuses profile and QA from another dataset that happens to share stage_000", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const sessionID = "dataset_isolation"
      registerDataset(root, sessionID, ["y,x", "2,1", "4,2", "6,3", "8,4"], true, "dataset_a")
      const sourceB = registerDataset(
        root,
        sessionID,
        ["y,x", "3,1", "6,2", "9,3", "12,4"],
        false,
        "dataset_b",
      )
      recordWorkflowStageSuccess({
        sessionID,
        toolName: "data_import",
        args: { action: "import", ...sourceB },
        metadata: { action: "import", ...sourceB },
      })
      const tool = await OlsRegressionTool.init()

      expect(
        tool.execute(
          { ...sourceB, dependentVar: "y", treatmentVar: "x", covariance: "HC1" },
          context(sessionID) as never,
        ),
      ).rejects.toThrow(/同一数据集|画像.*QA|profile.*QA/i)
    })
  })

  test("blocks an exactly rank-deficient OLS design instead of publishing arbitrary coefficients", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const sessionID = "rank_deficient"
      const rows = ["y,x,control"]
      for (let x = 1; x <= 40; x += 1) rows.push(`${1 + 3 * x},${x},${2 * x}`)
      const source = registerDataset(root, sessionID, rows, true)
      const tool = await OlsRegressionTool.init()

      expect(
        tool.execute(
          { ...source, dependentVar: "y", treatmentVar: "x", covariates: ["control"], covariance: "HC1" },
          context(sessionID) as never,
        ),
      ).rejects.toThrow(/rank deficient|完全共线/i)
    })
  }, 20_000)

  test("includes the treatment in multicollinearity diagnostics and warns on near collinearity", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const sessionID = "near_collinear"
      const rows = ["y,x,control"]
      for (let index = 1; index <= 80; index += 1) {
        // 两个解释变量都已标准化到相近尺度：VIF 很高，但 condition number 低于 30。
        // 这样测试不会被 condition-number 告警“擦边带绿”。
        const x = (index - 40.5) / 23
        const control = x + (index % 2 === 0 ? 0.2 : -0.2)
        rows.push(`${1 + 1.5 * x + 0.2 * control},${x},${control}`)
      }
      const source = registerDataset(root, sessionID, rows, true)
      const tool = await OlsRegressionTool.init()
      const result = await tool.execute(
        { ...source, dependentVar: "y", treatmentVar: "x", covariates: ["control"], covariance: "HC1" },
        context(sessionID) as never,
      )

      const diagnosticsPath = result.metadata.result?.diagnostics_path
      expect(diagnosticsPath).toBeString()
      expect(path.isAbsolute(diagnosticsPath!)).toBe(false)
      const diagnostics = JSON.parse(fs.readFileSync(path.join(root, diagnosticsPath!), "utf-8")) as {
        core?: { vif?: { rows?: Array<{ variable?: string; vif?: number }> } }
      }
      expect(Math.max(...(diagnostics.core?.vif?.rows ?? []).map((row) => row.vif ?? 0))).toBeGreaterThan(10)
      const warnings = (result.metadata.result?.warnings ?? []).join("\n")
      expect(warnings).toMatch(/high VIF|VIF exceeds 10/i)
      expect(warnings).not.toMatch(/condition number/i)
    })
  }, 20_000)
})
