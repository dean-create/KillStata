import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Did2sTool, HdfeRegressionTool } from "../../src/tool/pyfixest"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

let tempDir = ""

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-pyfixest-tool-"))
})

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("PyFixest model-facing execution", () => {
  test("returns a Chinese HDFE result without exposing formulas or internal aliases", async () => {
    const previousPython = process.env.KILLSTATA_PYTHON
    process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    const dataPath = path.join(tempDir, "panel.csv")
    const rows = ["firm,year,y,x"]
    for (let firm = 1; firm <= 10; firm += 1) {
      for (let year = 1; year <= 6; year += 1) {
        const x = ((firm * 5 + year * 2) % 9) - 4
        const y = 1.25 * x + firm * 0.4 + year * 0.2 + ((firm + year) % 2) * 0.01
        rows.push(`${firm},${year},${y},${x}`)
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    try {
      await Instance.provide({
        directory: tempDir,
        fn: async () => {
        const source = registerCanonicalDataset({
          sessionID: "pyfixest-tool-test",
          sourcePath: dataPath,
          datasetId: "dataset_pyfixest_hdfe",
        })
        const tool = await HdfeRegressionTool.init()
        const result = await tool.execute(
          {
            ...source,
            dependentVar: "y",
            treatmentVar: "x",
            covariates: [],
            fixedEffects: ["firm", "year"],
            clusterVars: ["firm"],
          },
          {
            sessionID: "pyfixest-tool-test",
            messageID: "message",
            callID: "call",
            agent: "analyst",
            abort: new AbortController().signal,
            metadata: () => undefined,
            ask: async () => undefined,
          },
        )

        expect(result.output).toContain("高维固定效应回归已完成")
        expect(result.output).toContain("后端：PyFixest 0.60.0")
        expect(result.output).not.toContain("v_")
        expect(result.output).not.toContain("Traceback")
        expect(result.metadata.analysisView.kind).toBe("econometrics")
        expect(result.metadata.analysisView.step).toBe("hdfe_regression")
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
    }
  }, 30_000)

  test("returns an actual DID effect with inference in the user summary", async () => {
    const previousPython = process.env.KILLSTATA_PYTHON
    process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    const dataPath = path.join(tempDir, "did2s-panel.csv")
    const rows = ["unit,year,treated,event_time,outcome"]
    for (let unit = 1; unit <= 60; unit += 1) {
      const cohort = unit <= 30 ? 4 : 0
      for (let year = 1; year <= 8; year += 1) {
        const treated = cohort > 0 && year >= cohort ? 1 : 0
        const eventTime = cohort > 0 ? year - cohort : "-inf"
        const outcome = unit * 0.2 + year * 0.1 + treated * 1.5 + ((unit + year) % 3) * 0.01
        rows.push(`${unit},${year},${treated},${eventTime},${outcome}`)
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    try {
      await Instance.provide({
        directory: tempDir,
        fn: async () => {
          const source = registerCanonicalDataset({
            sessionID: "pyfixest-did2s-tool-test",
            sourcePath: dataPath,
            datasetId: "dataset_pyfixest_did2s",
          })
          const tool = await Did2sTool.init()
          const result = await tool.execute(
            {
              ...source,
              dependentVar: "outcome",
              treatmentVar: "treated",
              relativeTimeVar: "event_time",
              entityVar: "unit",
              timeVar: "year",
              covariates: [],
              referencePeriod: -1,
            },
            {
              sessionID: "pyfixest-did2s-tool-test",
              messageID: "message",
              callID: "call",
              agent: "analyst",
              abort: new AbortController().signal,
              metadata: () => undefined,
              ask: async () => undefined,
            },
          )

          const metrics = Object.fromEntries(
            (result.metadata.analysisView.results ?? []).map((item: { label: string; value: string }) => [item.label, item.value]),
          )
          expect(result.output).toContain("两阶段双重差分已完成")
          expect(metrics["event_time::0.0"]).toBeDefined()
          expect(metrics["标准误"]).toBeDefined()
          expect(metrics["p 值"]).toBeDefined()
          expect(metrics["95% 置信区间"]).toMatch(/^\[/)
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
    }
  }, 30_000)
})
