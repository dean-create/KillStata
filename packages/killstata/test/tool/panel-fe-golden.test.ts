import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { resolveRuntimePythonCommand } from "@/killstata/runtime-config"

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "killstata-panel-fe-golden-"))
}

function engine() {
  const managedPython = process.platform === "win32"
    ? path.join(os.homedir(), ".killstata", "venv", "Scripts", "python.exe")
    : path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  return new EconometricsEngineClient({
    command: process.env.KILLSTATA_PYTHON ?? managedPython,
    cwd: path.resolve(process.cwd(), "../.."),
    pythonPath: path.resolve(process.cwd(), "../killstata-econometrics-engine/src"),
  })
}

async function supportsEconometricsRuntime() {
  const configuredPython = process.env.KILLSTATA_PYTHON?.trim()
  try {
    const pythonCommand = configuredPython ?? await resolveRuntimePythonCommand()
    const processResult = Bun.spawnSync([pythonCommand, "-c", "import linearmodels, scipy; print('ok')"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (processResult.exitCode !== 0) throw new Error(new TextDecoder().decode(processResult.stderr))
    return true
  } catch (error) {
    if (configuredPython) throw error
    return false
  }
}

const EXPECTED = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "golden", "grunfeld_fe_expected.json"), "utf-8"),
)

describe("Python Registry panel_fe_regression golden test (Grunfeld, linearmodels ground truth)", () => {
  test("two-way FE result and clustered standard errors match the independent oracle", async () => {
    if (!(await supportsEconometricsRuntime())) {
      console.warn("[panel-fe-golden] 计量运行时不可用，跳过真实数值断言")
      return
    }

    const root = makeTempDir()
    const client = engine()
    try {
      const response = await client.execute({
        method_id: "panel_fe_regression",
        data_path: path.join(process.cwd(), "test", "fixtures", "golden", "grunfeld.csv"),
        output_dir: path.join(root, "result"),
        arguments: {
          dependentVar: "invest",
          treatmentVar: "value",
          covariates: ["capital"],
          entityVar: "firm",
          timeVar: "year",
          clusterVar: "firm",
          covariance: "clustered",
        },
      })
      const result = response.payload as Record<string, any>

      expect(result.rowsUsed).toBe(EXPECTED.n)
      expect(result.covariance).toBe("clustered")
      expect(result.primary?.term).toBe("value")
      expect(result.primary?.estimate).toBeCloseTo(EXPECTED.coefficient, 4)
      expect(result.primary?.stdError).toBeCloseTo(EXPECTED.std_error_clustered, 4)
      expect(result.rSquaredWithin).toBeCloseTo(EXPECTED.r_squared_within, 3)
      expect(fs.existsSync(result.resultPath)).toBe(true)
      expect(fs.existsSync(result.coefficientsPath)).toBe(true)
    } finally {
      await client.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})
