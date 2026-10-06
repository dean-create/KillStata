import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { EconometricsEngineClient } from "../../src/runtime/services/econometrics-engine-client"
import { PanelRandomEffectsTool } from "../fixtures/legacy/tool/panel"
import { validatePanelBackendResult } from "../fixtures/legacy/tool/panel-backend"
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

function panelBackendResult(preferred: "undetermined" | "fixed_effects" | "random_effects" = "undetermined") {
  const coefficient = {
    term: "training",
    estimate: 1,
    stdError: 0.1,
    statistic: 10,
    pValue: 0.001,
    confLow: 0.8,
    confHigh: 1.2,
  }
  return {
    success: true,
    method: "panel_random_effects",
    backend: "linearmodels",
    statsmodelsVersion: "0.14.0",
    linearmodelsVersion: "7.0",
    rowsInput: 300,
    rowsUsed: 300,
    droppedRows: 0,
    covariance: "robust",
    entityVar: "firm_id",
    timeVar: "year",
    nEntities: 30,
    nPeriods: 10,
    randomEffects: { coefficients: [coefficient], primary: coefficient, sigmaEntity: 1 },
    fixedEffects: { coefficients: [coefficient], primary: coefficient },
    hausman: { statistic: null, df: 0, pValue: null, alpha: 0.05, rejectRe: null },
    recommendation: { preferred, reason: "Hausman 检验不可判定" },
    warnings: [],
    resultPath: "analysis/results.json",
    coefficientsPath: "analysis/coefficients.csv",
  }
}

describe("legacy panel backend result contract", () => {
  test("accepts an explicitly undetermined Hausman recommendation", () => {
    const result = validatePanelBackendResult(panelBackendResult())

    expect(result.hausman).toMatchObject({ statistic: null, df: 0, pValue: null, rejectRe: null })
    expect(result.recommendation?.preferred).toBe("undetermined")
  })

  test("accepts FE/RE recommendations that agree with a determinate Hausman result", () => {
    for (const [rejectRe, preferred, pValue] of [
      [true, "fixed_effects", 0.01],
      [false, "random_effects", 0.3],
    ] as const) {
      const result = validatePanelBackendResult({
        ...panelBackendResult(preferred),
        hausman: { statistic: 1, df: 1, pValue, alpha: 0.05, rejectRe },
      })
      expect(result.recommendation?.preferred).toBe(preferred)
    }
  })

  test("rejects a Hausman decision flag that disagrees with p-value and alpha", () => {
    expect(() => validatePanelBackendResult({
      ...panelBackendResult("fixed_effects"),
      hausman: { statistic: 1, df: 1, pValue: 0.3, alpha: 0.05, rejectRe: true },
    })).toThrow("面板随机效应结果结构不完整")
  })

  test("rejects a random-effects recommendation when Hausman is indeterminate", () => {
    expect(() => validatePanelBackendResult(panelBackendResult("random_effects")))
      .toThrow("面板随机效应结果结构不完整")
  })

  test("rejects a Hausman rejection flag when its test statistics are missing", () => {
    expect(() => validatePanelBackendResult({
      ...panelBackendResult(),
      hausman: { statistic: null, df: 0, pValue: null, alpha: 0.05, rejectRe: false },
    })).toThrow("面板随机效应结果结构不完整")
  })
})

describe("panel random effects model-facing execution", () => {
  test("does not present RE when session Hausman statistics or recommendation conflict", async () => {
    const previousPython = process.env.KILLSTATA_PYTHON
    process.env.KILLSTATA_PYTHON = previousPython?.trim() || path.join(os.homedir(), ".killstata", "venv", "bin", "python")
    const dataPath = path.join(tempDir, "undetermined_panel.csv")
    fs.writeFileSync(dataPath, "firm_id,year,sales,training,size,age\n1,1,10,1,2,3\n", "utf-8")
    const invalidHausmanResults = [
      {
        hausman: { statistic: null, df: 0, pValue: null, alpha: 0.05, rejectRe: null },
        message: "Hausman 检验不可判定",
      },
      {
        hausman: { statistic: -1, df: 1.5, pValue: 1.2, alpha: 0.05, rejectRe: false },
        message: "Hausman 检验不可判定",
      },
      {
        hausman: { statistic: 1, df: 1, pValue: 0.3, alpha: 0.05, rejectRe: true },
        message: "Hausman 检验不可判定",
      },
      {
        hausman: { statistic: 1, df: 1, pValue: 0.01, alpha: 0.05, rejectRe: true },
        message: "Hausman 检验结果与模型推荐不一致",
      },
    ] as const
    let responseIndex = 0
    const validateSpy = spyOn(EconometricsEngineClient.prototype, "validate").mockImplementation(async (methodID, arguments_) => ({
      registry_version: 1,
      method_id: methodID,
      arguments: arguments_,
    }))
    const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(async (payload) => {
      fs.mkdirSync(payload.output_dir, { recursive: true })
      const resultPath = path.join(payload.output_dir, "results.json")
      const coefficientsPath = path.join(payload.output_dir, "coefficients.csv")
      const result = {
        ...panelBackendResult("random_effects"),
        hausman: invalidHausmanResults[responseIndex++]!.hausman,
        recommendation: { preferred: "random_effects", reason: "Hausman 检验不显著，推荐随机效应（RE）" },
        resultPath,
        coefficientsPath,
      }
      fs.writeFileSync(resultPath, JSON.stringify(result), "utf-8")
      fs.writeFileSync(coefficientsPath, "term,estimate\ntraining,1\n", "utf-8")
      return { payload: result } as never
    })

    try {
      await Instance.provide({ directory: tempDir, fn: async () => {
        const tool = await PanelRandomEffectsTool.init()
        for (let index = 0; index < invalidHausmanResults.length; index += 1) {
          const sessionID = `panel-undetermined-result-test-${index}`
          const source = registerCanonicalDataset({
            sessionID,
            sourcePath: dataPath,
            datasetId: `dataset_panel_undetermined_${index}`,
          })
          const result = await tool.execute({
            ...source,
            dependentVar: "sales",
            treatmentVar: "training",
            covariates: ["size", "age"],
            entityVar: "firm_id",
            timeVar: "year",
            covariance: "robust",
          }, {
            sessionID,
            messageID: "message",
            callID: "call",
            agent: "analyst",
            abort: new AbortController().signal,
            metadata: () => undefined,
            ask: async () => undefined,
          } as never)

          expect(result.output).toContain(invalidHausmanResults[index]!.message)
          expect(result.output).toContain("推荐模型：暂不可判定")
          expect(result.output).not.toContain("推荐模型：随机效应（RE）")
          expect(result.output).not.toContain("推荐理由：Hausman 检验不显著")
          expect(result.metadata.analysisView.conclusion).toContain("不能据此选择 FE 或 RE")
          expect(result.metadata.analysisView.results?.find((item) => item.label === "Hausman p 值")?.value).toBeUndefined()
        }
        expect(validateSpy).toHaveBeenCalledTimes(invalidHausmanResults.length)
        expect(executeSpy).toHaveBeenCalledTimes(invalidHausmanResults.length)
      } })
    } finally {
      validateSpy.mockRestore()
      executeSpy.mockRestore()
      if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
      else process.env.KILLSTATA_PYTHON = previousPython
    }
  }, 60_000)

  test("panel_random_effects returns a Chinese result with Hausman + recommendation", async () => {
    const previousPython = process.env.KILLSTATA_PYTHON
    process.env.KILLSTATA_PYTHON = previousPython?.trim() || path.join(os.homedir(), ".killstata", "venv", "bin", "python")

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
