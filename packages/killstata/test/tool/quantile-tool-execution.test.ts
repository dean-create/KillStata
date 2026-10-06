import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { QuantileRegressionTool } from "../fixtures/legacy/tool/quantile"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

/**
 * 端到端：走真实注册工具 QuantileRegressionTool.execute()，经 canonical stage 门禁 →
 * 受管 Python 后端 → 中文结果摘要。CLAUDE.md 铁律那一关——真实数据集上跑通。
 */

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-quantile-tool-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("quantile-regression model-facing execution", () => {
  test("quantile_regression returns a Chinese result with a per-quantile effect path", async () => {
    const previousPython = process.env.KILLSTATA_PYTHON
    process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")

    // 构造有分布异质性的连续结果：wage 的方差随 union 放大 -> 高分位处 union 溢价更大
    const dataPath = path.join(tempDir, "wage.csv")
    const rows = ["wage,union,experience"]
    for (let i = 0; i < 300; i += 1) {
      const union = i % 2
      const experience = 1 + (i % 30)
      // 确定性伪残差，保证可复现且有足够变异
      const pseudo = ((i * 37) % 101) / 101 - 0.5
      const spread = 1 + 1.5 * union
      const wage = 10 + 2.0 * union + 0.3 * experience + pseudo * 8 * spread
      rows.push(`${wage.toFixed(3)},${union},${experience}`)
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    try {
      await Instance.provide({
        directory: tempDir,
        fn: async () => {
          const source = registerCanonicalDataset({
            sessionID: "quantile-tool-test",
            sourcePath: dataPath,
            datasetId: "dataset_quantile",
          })
          const tool = await QuantileRegressionTool.init()
          const result = await tool.execute(
            {
              ...source,
              dependentVar: "wage",
              treatmentVar: "union",
              covariates: ["experience"],
              quantiles: [0.25, 0.5, 0.75],
              covariance: "robust",
            },
            {
              sessionID: "quantile-tool-test",
              messageID: "message",
              callID: "call",
              agent: "analyst",
              abort: new AbortController().signal,
              metadata: () => undefined,
              ask: async () => undefined,
            } as never,
          )

          // 中文结果、给出分位效应路径与主报告分位点
          expect(result.output).toContain("分位数回归已完成")
          expect(result.output).toContain("后端：statsmodels")
          expect(result.output).toContain("分位效应路径")
          // 不泄露内部别名 v_、traceback
          expect(result.output).not.toContain("v_")
          expect(result.output).not.toContain("Traceback")
          // 结构化结果：三个分位点、primary 在 0.5、路径长度 = 分位点数
          const view = result.metadata.analysisView as { kind: string; step: string }
          expect(view.kind).toBe("econometrics")
          expect(view.step).toBe("quantile_regression")
          const backend = result.metadata.result as {
            fits?: unknown[]
            primaryTau?: number
            primary?: { term?: string }
            treatmentPath?: unknown[]
            rowsUsed?: number
          }
          expect(backend.rowsUsed).toBe(300)
          expect(backend.fits?.length).toBe(3)
          expect(backend.treatmentPath?.length).toBe(3)
          expect(backend.primaryTau).toBe(0.5)
          expect(backend.primary?.term).toBe("union")
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
    }
  }, 30_000)
})
