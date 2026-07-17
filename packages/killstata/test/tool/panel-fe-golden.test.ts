import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { PanelFeRegressionTool } from "../../src/tool/econometrics-method-tools"
import { resolveRuntimePythonCommand } from "../../src/killstata/runtime-config"
import { Instance } from "../../src/project/instance"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "killstata-panel-fe-golden-"))
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = makeTempDir()
  try {
    return await Instance.provide({
      directory: root,
      fn: async () => fn(root),
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function supportsEconometricsRuntime() {
  try {
    const pythonCommand = await resolveRuntimePythonCommand()
    execFileSync(pythonCommand, ["-c", "import statsmodels.api as sm; import linearmodels; import scipy; print('ok')"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return true
  } catch {
    return false
  }
}

const EXPECTED = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "golden", "grunfeld_fe_expected.json"), "utf-8"),
)

describe("tool.econometrics panel_fe_regression golden test (Grunfeld, linearmodels ground truth)", () => {
  test("panel_fe_regression on Grunfeld matches linearmodels PanelOLS to a tight tolerance", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const csvPath = path.join(root, "grunfeld.csv")
      fs.copyFileSync(path.join(process.cwd(), "test", "fixtures", "golden", "grunfeld.csv"), csvPath)
      const source = registerCanonicalDataset({
        sessionID: ctx.sessionID,
        sourcePath: csvPath,
        datasetId: "dataset_grunfeld_fe",
      })

      const tool = await PanelFeRegressionTool.init()
      const result = await tool.execute(
        {
          ...source,
          dependentVar: "invest",
          treatmentVar: "value",
          covariates: ["capital"],
          entityVar: "firm",
          timeVar: "year",
        },
        ctx as any,
      )

      const r = result.metadata.result!
      expect(r.rows_used).toBe(EXPECTED.n)

      // Point estimates are unbiased regardless of the SE/R^2 bugs this migration fixes,
      // so this assertion already holds against the pre-migration numpy backend too.
      expect(r.coefficient).toBeCloseTo(EXPECTED.coefficient, 4)

      // These two are the ones B4/B5 fix: pre-migration they land on legacy_numpy's values
      // (std_error ~0.011447, r_squared ~0.774756) instead of linearmodels' ground truth.
      expect(r.std_error).toBeCloseTo(EXPECTED.std_error_clustered, 4)
      expect(r.r_squared).toBeCloseTo(EXPECTED.r_squared_within, 3)
    })
  }, 20_000)
})
