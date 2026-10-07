import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { PoissonRegressionTool } from "../fixtures/legacy/tool/count"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

/**
 * 端到端：走真实注册工具 PoissonRegressionTool.execute()，经 canonical stage 门禁 →
 * 受管 Python 后端 → 中文结果摘要。CLAUDE.md 铁律那一关——只有在真实数据集上跑通的
 * 计量方法才算有效工具。
 */

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-count-tool-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("count-data model-facing execution", () => {
  test("poisson_regression returns a Chinese result with IRR and no internal leakage", async () => {
    const previousPython = process.env.KILLSTATA_PYTHON
    process.env.KILLSTATA_PYTHON = previousPython?.trim() || path.join(os.homedir(), ".killstata", "venv", "bin", "python")

    // 构造有真实信号的计数结果：visits ~ Poisson(exp(η))，η 由 insured + age 决定
    const dataPath = path.join(tempDir, "clinic.csv")
    const rows = ["visits,insured,age,chronic"]
    for (let i = 0; i < 300; i += 1) {
      const insured = i % 2
      const age = 20 + (i % 40)
      const chronic = i % 3 === 0 ? 1 : 0
      const eta = 0.4 + 0.5 * insured + 0.02 * (age - 40) + 0.3 * chronic
      // 确定性地把期望值取整成计数，保证可复现
      const mu = Math.exp(eta)
      const visits = Math.max(0, Math.round(mu + ((i % 5) - 2) * 0.4))
      rows.push(`${visits},${insured},${age},${chronic}`)
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    try {
      await Instance.provide({
        directory: tempDir,
        fn: async () => {
          const source = registerCanonicalDataset({
            sessionID: "count-poisson-tool-test",
            sourcePath: dataPath,
            datasetId: "dataset_count_poisson",
          })
          const tool = await PoissonRegressionTool.init()
          const result = await tool.execute(
            {
              ...source,
              dependentVar: "visits",
              treatmentVar: "insured",
              covariates: ["age", "chronic"],
              covariance: "nonrobust",
            },
            {
              sessionID: "count-poisson-tool-test",
              messageID: "message",
              callID: "call",
              agent: "analyst",
              abort: new AbortController().signal,
              metadata: () => undefined,
              ask: async () => undefined,
            } as never,
          )

          // 中文结果、明确给出发生率比与计数尺度边际效应
          expect(result.output).toContain("Poisson 回归已完成")
          expect(result.output).toContain("后端：statsmodels")
          expect(result.output).toContain("发生率比")
          expect(result.output).toContain("平均边际效应")
          // 不泄露内部别名 v_、公式、traceback
          expect(result.output).not.toContain("v_")
          expect(result.output).not.toContain("Traceback")
          expect(result.output).not.toContain("get_margeff")
          // 结构化结果：primary 锁定核心解释变量、IRR = exp(系数)、Poisson 无 alpha
          const view = result.metadata.analysisView as { kind: string; step: string }
          expect(view.kind).toBe("econometrics")
          expect(view.step).toBe("poisson_regression")
          const backend = result.metadata.result as {
            primary?: { term?: string; estimate?: number }
            primaryIrr?: { estimate?: number; irr?: number }
            rowsUsed?: number
            alpha?: number | null
          }
          expect(backend.primary?.term).toBe("insured")
          expect(backend.rowsUsed).toBe(300)
          expect(backend.alpha).toBeNull()
          // IRR 必须等于 exp(系数)
          expect(backend.primaryIrr!.irr!).toBeCloseTo(Math.exp(backend.primary!.estimate!), 4)
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
    }
  }, 30_000)
})
