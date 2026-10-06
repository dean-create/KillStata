import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { RobustRegressionTool } from "../fixtures/legacy/tool/rlm"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-rlm-tool-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("RLM model-facing execution", () => {
  test("robust_regression returns a Chinese result with down-weight diagnostics", async () => {
    const previousPython = process.env.KILLSTATA_PYTHON
    process.env.KILLSTATA_PYTHON = previousPython?.trim() || path.join(os.homedir(), ".killstata", "venv", "bin", "python")

    const dataPath = path.join(tempDir, "test_rlm.csv")
    const rows = ["y,x1,x2"]
    for (let i = 0; i < 200; i += 1) {
      const x1 = (i - 100) / 50
      const x2 = (i % 10) / 5
      const y = 1 + 0.5 * x1 + 0.2 * x2 + (i % 10 === 0 ? 20 : (i % 5 - 2) * 0.3)
      rows.push(`${y.toFixed(4)},${x1.toFixed(4)},${x2.toFixed(4)}`)
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    try {
      await Instance.provide({
        directory: tempDir,
        fn: async () => {
          const source = registerCanonicalDataset({
            sessionID: "rlm-tool-test",
            sourcePath: dataPath,
            datasetId: "dataset_rlm",
          })
          const tool = await RobustRegressionTool.init()
          const result = await tool.execute(
            {
              ...source,
              dependentVar: "y",
              treatmentVar: "x1",
              covariates: ["x2"],
              psi: "huber",
            },
            {
              sessionID: "rlm-tool-test",
              messageID: "message",
              callID: "call",
              agent: "analyst",
              abort: new AbortController().signal,
              metadata: () => undefined,
              ask: async () => undefined,
            } as never,
          )

          expect(result.output).toContain("稳健回归（RLM）已完成")
          expect(result.output).toContain("后端：statsmodels")
          expect(result.output).toContain("Psi 函数")
          expect(result.output).not.toContain("Traceback")
          expect(result.output).not.toContain("v_")

          const view = result.metadata.analysisView as { kind: string; step: string }
          expect(view.kind).toBe("econometrics")
          expect(view.step).toBe("robust_regression")
          const backend = result.metadata.result as {
            primary?: { term?: string; estimate?: number }
            rowsUsed?: number
            psi?: string
          }
          expect(backend.primary?.term).toBe("x1")
          expect(backend.rowsUsed).toBe(200)
          expect(backend.psi).toBe("huber")
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
    }
  }, 30_000)
})
