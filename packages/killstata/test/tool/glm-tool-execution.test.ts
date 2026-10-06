import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { LogitRegressionTool } from "../fixtures/legacy/tool/glm"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

/**
 * 端到端：走真实注册工具 LogitRegressionTool.execute()，经 canonical stage 门禁 →
 * 受管 Python 后端 → 中文结果摘要。这是 CLAUDE.md 的铁律"只有在真实数据集上跑通
 * 的计量方法才可作为有效工具"对应的那一关，不是只测后端或契约。
 */

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-glm-tool-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("GLM model-facing execution", () => {
  test("logit_regression returns a Chinese result with marginal effects and no internal leakage", async () => {
    const previousPython = process.env.KILLSTATA_PYTHON
    process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")

    // 构造有真实信号的二元结果：employed 由 train + age 通过 logistic 生成
    const dataPath = path.join(tempDir, "employment.csv")
    const rows = ["employed,train,age,education"]
    for (let i = 0; i < 200; i += 1) {
      const train = i % 2
      const age = 20 + (i % 30)
      const education = 8 + (i % 9)
      const logit = -2.5 + 1.4 * train + 0.05 * (age - 35) + 0.15 * (education - 12)
      const p = 1 / (1 + Math.exp(-logit))
      // 确定性阈值，保证可复现且两类都出现
      const employed = p > (i % 10) / 10 ? 1 : 0
      rows.push(`${employed},${train},${age},${education}`)
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    try {
      await Instance.provide({
        directory: tempDir,
        fn: async () => {
          const source = registerCanonicalDataset({
            sessionID: "glm-logit-tool-test",
            sourcePath: dataPath,
            datasetId: "dataset_glm_logit",
          })
          const tool = await LogitRegressionTool.init()
          const result = await tool.execute(
            {
              ...source,
              dependentVar: "employed",
              treatmentVar: "train",
              covariates: ["age", "education"],
              covariance: "nonrobust",
            },
            {
              sessionID: "glm-logit-tool-test",
              messageID: "message",
              callID: "call",
              agent: "analyst",
              abort: new AbortController().signal,
              metadata: () => undefined,
              ask: async () => undefined,
            } as never,
          )

          // 中文结果、明确区分对数几率系数与概率尺度边际效应
          expect(result.output).toContain("Logit 回归已完成")
          expect(result.output).toContain("后端：statsmodels")
          expect(result.output).toContain("平均边际效应")
          // 不泄露内部别名 v_、公式、traceback
          expect(result.output).not.toContain("v_")
          expect(result.output).not.toContain("Traceback")
          expect(result.output).not.toContain("get_margeff")
          // 结构化结果里 primary 锁定核心解释变量、AME 尺度小于对数几率系数
          const view = result.metadata.analysisView as { kind: string; step: string }
          expect(view.kind).toBe("econometrics")
          expect(view.step).toBe("logit_regression")
          const backend = result.metadata.result as {
            primary?: { term?: string; estimate?: number }
            primaryMarginalEffect?: { estimate?: number }
            rowsUsed?: number
          }
          expect(backend.primary?.term).toBe("train")
          expect(backend.rowsUsed).toBe(200)
          expect(Math.abs(backend.primaryMarginalEffect!.estimate!)).toBeLessThan(Math.abs(backend.primary!.estimate!))
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
    }
  }, 30_000)
})
