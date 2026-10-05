import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { runWlsBackend } from "../../../../trash/killstata-legacy-econometrics/tool/wls-backend"

const PYTHON = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")
const WLS_SIM = path.join(import.meta.dir, "..", "fixtures", "golden", "wls_sim.csv")

let tempDir = ""
beforeAll(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-wls-")) })
afterAll(() => { fs.rmSync(tempDir, { recursive: true, force: true }) })

describe("WLS golden", () => {
  test("wls with two weight groups recovers OLS-like coefficients with different SE", async () => {
    const result = await runWlsBackend({
      pythonCommand: PYTHON, cwd: process.cwd(),
      payload: {
        method: "wls_regression", dataPath: WLS_SIM, outputDir: path.join(tempDir, "w"),
        dependentVar: "y", treatmentVar: "x", covariates: [], weightsVar: "sample_weight", covariance: "nonrobust",
      },
    })
    expect(result.success).toBe(true)
    expect(result.rowsUsed).toBe(200)
    expect(result.primary?.term).toBe("x")
    expect(result.primary?.estimate!).toBeCloseTo(0.778, 2)
    expect(result.weightSummary?.minWeight).toBe(1.0)
    expect(result.weightSummary?.maxWeight).toBe(2.0)
    expect(result.weightSummary?.zeroCount).toBe(0)
  }, 60_000)

  test("robust covariance changes SE but not point estimate", async () => {
    const nr = await runWlsBackend({
      pythonCommand: PYTHON, cwd: process.cwd(),
      payload: {
        method: "wls_regression", dataPath: WLS_SIM, outputDir: path.join(tempDir, "nr"),
        dependentVar: "y", treatmentVar: "x", covariates: [], weightsVar: "sample_weight", covariance: "nonrobust",
      },
    })
    const rb = await runWlsBackend({
      pythonCommand: PYTHON, cwd: process.cwd(),
      payload: {
        method: "wls_regression", dataPath: WLS_SIM, outputDir: path.join(tempDir, "rb"),
        dependentVar: "y", treatmentVar: "x", covariates: [], weightsVar: "sample_weight", covariance: "robust",
      },
    })
    expect(rb.covariance).toBe("HC1")
    expect(rb.primary?.estimate!).toBeCloseTo(nr.primary!.estimate!, 6)
    // SE 通常不同（HC1 ≠ nonrobust）
    expect(rb.primary?.stdError!).not.toBeCloseTo(nr.primary!.stdError!, 4)
  }, 60_000)
})
