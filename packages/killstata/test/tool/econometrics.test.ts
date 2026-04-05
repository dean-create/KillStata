import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { EconometricsTool } from "../../src/tool/econometrics"
import { resolveRuntimePythonCommand } from "../../src/killstata/runtime-config"
import { Instance } from "../../src/project/instance"

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "killstata-econometrics-"))
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
    execFileSync(
      pythonCommand,
      ["-c", "import statsmodels.api as sm; import scipy; print('ok')"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    )
    return true
  } catch {
    return false
  }
}

describe("tool.econometrics", () => {
  test("requires panel keys for DID-family methods", async () => {
    await withInstance(async () => {
      const tool = await EconometricsTool.init()
      for (const methodName of ["did_static", "did_staggered", "did_event_study", "did_event_study_viz"] as const) {
        await expect(
          tool.execute(
            {
              methodName,
              dataPath: "missing.csv",
              dependentVar: "y",
              options: {
                treatment_entity_dummy: "treated_entity",
                treatment_finished_dummy: "treated_finished",
              },
            },
            ctx as any,
          ),
        ).rejects.toThrow("entityVar and timeVar")
      }
    })
  })

  test("does not require relative_time_variable at validation time", async () => {
    await withInstance(async () => {
      const tool = await EconometricsTool.init()
      await expect(
        tool.execute(
          {
            methodName: "did_event_study",
            dataPath: "missing.csv",
            dependentVar: "y",
            entityVar: "entity",
            timeVar: "year",
            options: {
              treatment_entity_dummy: "treated_entity",
              treatment_finished_dummy: "treated_finished",
            },
          },
          ctx as any,
        ),
      ).rejects.not.toThrow("relative_time_variable")
    })
  })

  test("persists common output helpers and parameter mappings in source", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "econometrics.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")
    expect(source).toContain("persist_common_outputs")
    expect(source).toContain("scalar_coefficient_table")
    expect(source).toContain('result["summary_path"]')
    expect(source).toContain("running_variable_cutoff=cutoff")
    expect(source).toContain("running_variable_bandwidth=options.get(\"bandwidth\", None)")
    expect(source).toContain("max_order=polynomial_degree")
    expect(source).toContain("target_type = options.get(\"target_type\", \"ATE\")")
  })

  test("configures econometric_algorithm for headless matplotlib imports", () => {
    const sourcePath = path.join(process.cwd(), "python", "econometrics", "econometric_algorithm.py")
    const source = fs.readFileSync(sourcePath, "utf-8")
    expect(source).toContain('matplotlib.use("Agg")')
    expect(source).toContain("def propensity_score_visualize_propensity_score_distribution")
    expect(source).toContain("from matplotlib import pyplot as plt")
    expect(source).toContain("def Staggered_Diff_in_Diff_Event_Study_visualization")
  })

  test("auto downgrades panel FE to pooled OLS when duplicate panel keys remain", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const csvPath = path.join(root, "panel_duplicates.csv")
      const rows = [
        "firm_id,year,did,y",
        "1,2020,0,1.0",
        "1,2020,0,1.2",
        "1,2021,1,2.4",
        "2,2020,0,1.5",
        "2,2021,1,2.8",
        "3,2020,0,0.9",
        "3,2021,1,2.2",
      ]
      fs.writeFileSync(csvPath, rows.join("\n"), "utf-8")

      const tool = await EconometricsTool.init()
      const result = await tool.execute(
        {
          methodName: "panel_fe_regression",
          dataPath: "panel_duplicates.csv",
          dependentVar: "y",
          treatmentVar: "did",
          entityVar: "firm_id",
          timeVar: "year",
          outputDir: "outputs/panel_duplicate_case",
        },
        ctx as any,
      )

      expect(result.metadata.result).toBeDefined()
      expect(result.metadata.result!.degraded_from).toBe("panel_fe_regression")
      expect(result.metadata.result!.effective_method).toBe("pooled_ols")
      expect(result.metadata.result!.effective_covariance).toBe("HC1")
      expect(result.metadata.result!.decision_trace?.some((item: any) => String(item.message).includes("duplicate entity-time rows"))).toBe(true)
    })
  })

  test("auto upgrades OLS inference to HC1 under strong heteroskedasticity", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const csvPath = path.join(root, "heteroskedastic.csv")
      const rows = ["x,y"]
      for (let i = 1; i <= 300; i += 1) {
        const shock = (i % 2 === 0 ? 1 : -1) * i * 0.35
        const y = 1 + 2 * i + shock
        rows.push(`${i},${y}`)
      }
      fs.writeFileSync(csvPath, rows.join("\n"), "utf-8")

      const tool = await EconometricsTool.init()
      const result = await tool.execute(
        {
          methodName: "ols_regression",
          dataPath: "heteroskedastic.csv",
          dependentVar: "y",
          treatmentVar: "x",
          outputDir: "outputs/heteroskedastic_case",
        },
        ctx as any,
      )

      expect(result.metadata.result).toBeDefined()
      expect(result.metadata.result!.effective_covariance).toBe("HC1")
      expect(result.metadata.result!.decision_trace?.some((item: any) => String(item.message).includes("heteroskedasticity"))).toBe(true)
    })
  })

  test("smart_baseline executes the recommended baseline and preserves planning trace", async () => {
    if (!(await supportsEconometricsRuntime())) return
    await withInstance(async (root) => {
      const csvPath = path.join(root, "smart_panel.csv")
      const rows = ["firm_id,year,did,y"]
      for (let firm = 1; firm <= 8; firm += 1) {
        for (let year = 2018; year <= 2021; year += 1) {
          const did = year >= 2020 ? 1 : 0
          const y = 1 + firm * 0.4 + year * 0.02 + did * 1.5
          rows.push(`${firm},${year},${did},${y.toFixed(4)}`)
        }
      }
      fs.writeFileSync(csvPath, rows.join("\n"), "utf-8")

      const tool = await EconometricsTool.init()
      const result = await tool.execute(
        {
          methodName: "smart_baseline",
          dataPath: "smart_panel.csv",
          dependentVar: "y",
          treatmentVar: "did",
          entityVar: "firm_id",
          timeVar: "year",
          outputDir: "outputs/smart_baseline_case",
        },
        ctx as any,
      )

      expect(result.metadata.recommendation).toBeDefined()
      expect(result.metadata.recommendation!.recommendedMethod).toBe("panel_fe_regression")
      expect(result.metadata.result?.effective_method).toBeDefined()
      expect(result.metadata.result?.decision_trace?.length).toBeGreaterThan(0)
      expect(result.output).toContain("Executed method:")
      expect(result.output).toContain("Planning trace:")
    })
  })
})
