import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { PanelRandomEffectsTool } from "../../../../trash/killstata-legacy-econometrics/tool/panel"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

/**
 * 端到端：真实注册工具 PanelRandomEffectsTool.execute() 经 canonical stage 门禁
 * → 受管 Python → 中文结果摘要（Hausman + 推荐模型）。CLAUDE.md 铁律那一关。
 */

let tempDir = ""
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-panel-tool-"))
})
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("panel random effects model-facing execution", () => {
  test("panel_random_effects returns a Chinese result with Hausman + recommendation", async () => {
    const previousPython = process.env.KILLSTATA_PYTHON
    process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")

    // 真实企业销售面板：30 家公司 × 10 年
    // treatment 必须随时间变化, 否则会被个体固定效应完全吸收 → FE 估不出。
    // 业务含义：每年公司是否参加培训项目(逐步推行, 随时间变化)
    const dataPath = path.join(tempDir, "sales_panel.csv")
    const rows = ["firm_id,year,sales,training,size,age"]
    const rng = mulberry32(20260722)
    for (let f = 0; f < 30; f += 1) {
      const a = gauss(rng, 0, 1)
      const treatmentYear = 2015 + (f % 5) // 5 个不同 cohort
      for (let y = 0; y < 10; y += 1) {
        const year_ = 2015 + y
        const treat = year_ >= treatmentYear ? 1 : 0
        const size = gauss(rng, 0, 1)
        const age = gauss(rng, 0, 1)
        const yy = 5.0 + 1.5 * treat + 0.5 * size - 0.2 * age + a + gauss(rng, 0, 0.5)
        rows.push(`${f},${year_},${yy.toFixed(3)},${treat},${size.toFixed(4)},${age.toFixed(4)}`)
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    try {
      await Instance.provide({
        directory: tempDir,
        fn: async () => {
          const source = registerCanonicalDataset({
            sessionID: "panel-tool-test",
            sourcePath: dataPath,
            datasetId: "dataset_panel_re",
          })
          const tool = await PanelRandomEffectsTool.init()
          const result = await tool.execute(
            {
              ...source,
              dependentVar: "sales",
              treatmentVar: "training",
              covariates: ["size", "age"],
              entityVar: "firm_id",
              timeVar: "year",
              covariance: "robust",
            },
            {
              sessionID: "panel-tool-test",
              messageID: "message",
              callID: "call",
              agent: "analyst",
              abort: new AbortController().signal,
              metadata: () => undefined,
              ask: async () => undefined,
            } as never,
          )

          // 中文结果、明确给出 RE/FE 系数与 Hausman + 推荐
          expect(result.output).toContain("面板随机效应")
          expect(result.output).toContain("后端：linearmodels")
          expect(result.output).toContain("Hausman")
          expect(result.output).toContain("推荐模型")
          // 不泄露内部别名 v_、公式、traceback
          expect(result.output).not.toContain("v_")
          expect(result.output).not.toContain("Traceback")
          expect(result.output).not.toContain("get_margeff")
          // 结构化结果：primary 在 RE 和 FE 上都锁定核心解释变量、300 obs
          const view = result.metadata.analysisView as { kind: string; step: string }
          expect(view.kind).toBe("econometrics")
          expect(view.step).toBe("panel_random_effects")
          const backend = result.metadata.result as {
            randomEffects?: { primary?: { term?: string } }
            fixedEffects?: { primary?: { term?: string } }
            hausman?: { statistic?: number | null; df?: number; pValue?: number | null; rejectRe?: boolean | null }
            recommendation?: { preferred?: string }
            rowsUsed?: number
            nEntities?: number
            nPeriods?: number
          }
          expect(backend.randomEffects?.primary?.term).toBe("training")
          expect(backend.fixedEffects?.primary?.term).toBe("training")
          expect(backend.rowsUsed).toBe(300)
          expect(backend.nEntities).toBe(30)
          expect(backend.nPeriods).toBe(10)
          // 协方差差矩阵没有正特征值时，Hausman 不可判定；不能把 p=1 当成 RE 背书。
          expect(backend.hausman).toMatchObject({ statistic: null, df: 0, pValue: null, rejectRe: null })
          expect(backend.recommendation?.preferred).toBe("undetermined")
          expect(result.output).toContain("Hausman 检验不可判定")
          expect(result.output).toContain("推荐模型：暂不可判定")
          expect(result.output).not.toContain("未拒绝 RE")
          expect(result.metadata.analysisView.conclusion).toContain("不能据此选择 FE 或 RE")
        },
      })
    } finally {
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
    }
  }, 60_000)
})

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gauss(rng: () => number, mu: number, sigma: number) {
  const u1 = Math.max(1e-9, rng())
  const u2 = rng()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return mu + sigma * z
}
