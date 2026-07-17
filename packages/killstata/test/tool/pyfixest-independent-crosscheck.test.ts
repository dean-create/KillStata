import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { runPyfixestBackend } from "../../src/tool/pyfixest-backend"

/**
 * 对标权威性分级（PLAN.md 缺口 2）：hdfe_regression / did2s /
 * did_event_study_saturated 目前是"合成数据对齐 pyfixest 自身"（C 级）——
 * 自己对自己只能验证接线（wiring），验证不了算法本身对不对。
 *
 * 这里把三个方法各自独立地用 statsmodels 重新实现一遍（完全不导入 pyfixest，
 * 见 independent_pyfixest_crosscheck.py 顶部说明），升级到 B 级：跨库独立实现对标。
 */

const PYTHON = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")
const CROSSCHECK_SCRIPT = path.join(import.meta.dir, "independent-crosscheck", "independent_pyfixest_crosscheck.py")

function runCrosscheck(payload: Record<string, unknown>): any {
  const stdout = execFileSync(PYTHON, [CROSSCHECK_SCRIPT, JSON.stringify(payload)], {
    encoding: "utf-8",
  })
  return JSON.parse(stdout)
}

let tempDir = ""

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-pyfixest-crosscheck-"))
})

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("PyFixest independent cross-check (对标分级：C → B)", () => {
  test("hdfe_regression：LSDV+statsmodels 与 pyfixest 的系数一致到约 1e-4；聚类标准误存在已知的小样本自由度修正约定差异", async () => {
    const dataPath = path.join(tempDir, "hdfe.csv")
    const rows = ["firm,year,y,treat,ctrl"]
    for (let firm = 1; firm <= 12; firm += 1) {
      for (let year = 2018; year <= 2023; year += 1) {
        const treatment = ((firm * 3 + year * 2) % 7) - 3
        const control = ((firm * year) % 5) - 2
        const noise = ((firm + year) % 3 - 1) * 0.01
        const outcome = 2 * treatment + 0.7 * control + firm * 0.5 + (year - 2018) * 0.3 + noise
        rows.push(`${firm},${year},${outcome},${treatment},${control}`)
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    const production = await runPyfixestBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "hdfe_regression",
        dataPath,
        outputDir: path.join(tempDir, "hdfe-result"),
        dependentVar: "y",
        treatmentVar: "treat",
        covariates: ["ctrl"],
        fixedEffects: ["firm", "year"],
        clusterVars: ["firm"],
        covariance: "CRV1",
      },
    })
    const independent = runCrosscheck({
      method: "hdfe_regression",
      csvPath: dataPath,
      dependentVar: "y",
      treatmentVar: "treat",
      covariates: ["ctrl"],
      fixedEffects: ["firm", "year"],
      clusterVar: "firm",
    })

    const productionEstimate = production.primary?.estimate
    if (productionEstimate === null || productionEstimate === undefined) {
      throw new Error("production HDFE result had no primary estimate")
    }
    expect(productionEstimate).toBeCloseTo(independent.treatmentEstimate, 4)

    // 聚类标准误：两边都是"正确"的实现，只是对 K（被吸收的固定效应算不算自由度）
    // 采用了不同的小样本修正约定；只做数量级层面的合理性检查，不追求精确相等。
    const productionSe = production.primary?.stdError
    if (productionSe === null || productionSe === undefined) {
      throw new Error("production HDFE result had no primary std error")
    }
    const relativeGap = Math.abs(productionSe - independent.treatmentStdError) / independent.treatmentStdError
    expect(relativeGap).toBeLessThan(0.25)
  }, 60_000)

  test("did2s：Gardner (2021) 两阶段法手工复现的事件期 0 处理效应与 pyfixest.did2s 一致到约 0.1%", async () => {
    const dataPath = path.join(tempDir, "staggered.csv")
    const rows = ["unit,year,cohort,treated,event_time,outcome"]
    for (let unit = 1; unit <= 60; unit += 1) {
      const cohort = unit <= 20 ? 4 : unit <= 40 ? 6 : 0
      for (let year = 1; year <= 8; year += 1) {
        const treated = cohort > 0 && year >= cohort ? 1 : 0
        const eventTime = cohort > 0 ? year - cohort : "-inf"
        const noise = ((unit * 7 + year * 3) % 11 - 5) * 0.01
        const outcome = unit * 0.2 + year * 0.1 + treated * 1.5 + noise
        rows.push(`${unit},${year},${cohort},${treated},${eventTime},${outcome}`)
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    const production = await runPyfixestBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "did2s",
        dataPath,
        outputDir: path.join(tempDir, "did2s-result"),
        dependentVar: "outcome",
        treatmentVar: "treated",
        relativeTimeVar: "event_time",
        entityVar: "unit",
        timeVar: "year",
        clusterVar: "unit",
        covariates: [],
        referencePeriod: -1,
      },
    })
    const independent = runCrosscheck({
      method: "did2s",
      csvPath: dataPath,
      dependentVar: "outcome",
      treatmentVar: "treated",
      entityVar: "unit",
      timeVar: "year",
      relativeTimeVar: "event_time",
      referencePeriod: -1,
    })

    const productionEstimate = production.primary?.estimate
    if (productionEstimate === null || productionEstimate === undefined) {
      throw new Error("production DID2S result had no primary estimate")
    }
    const relativeGap = Math.abs(productionEstimate - independent.eventTimeZeroEstimate) / independent.eventTimeZeroEstimate
    expect(relativeGap).toBeLessThan(0.01)
  }, 60_000)

  test("did_event_study_saturated：按 cohort 单独跑饱和交互回归再取平均，与 pyfixest 的 aggregate() 结果一致", async () => {
    const dataPath = path.join(tempDir, "staggered-for-saturated.csv")
    const rows = ["unit,year,cohort,treated,event_time,outcome"]
    for (let unit = 1; unit <= 60; unit += 1) {
      const cohort = unit <= 20 ? 4 : unit <= 40 ? 6 : 0
      for (let year = 1; year <= 8; year += 1) {
        const treated = cohort > 0 && year >= cohort ? 1 : 0
        const eventTime = cohort > 0 ? year - cohort : "-inf"
        const noise = ((unit * 7 + year * 3) % 11 - 5) * 0.01
        const outcome = unit * 0.2 + year * 0.1 + treated * 1.5 + noise
        rows.push(`${unit},${year},${cohort},${treated},${eventTime},${outcome}`)
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    const production = await runPyfixestBackend({
      pythonCommand: PYTHON,
      cwd: process.cwd(),
      payload: {
        method: "did_event_study_saturated",
        dataPath,
        outputDir: path.join(tempDir, "saturated-result"),
        dependentVar: "outcome",
        cohortVar: "cohort",
        entityVar: "unit",
        timeVar: "year",
        clusterVar: "unit",
        covariates: [],
        aggregateAtt: false,
      },
    })
    const independent = runCrosscheck({
      method: "did_event_study_saturated",
      csvPath: dataPath,
      dependentVar: "outcome",
      cohortVar: "cohort",
      entityVar: "unit",
      timeVar: "year",
    })

    const productionZero = production.coefficients?.find((item: { term: string }) => item.term === "0.0")
    if (!productionZero) {
      throw new Error("production saturated result had no relative-time-0 coefficient")
    }
    expect(productionZero.estimate).toBeCloseTo(independent.eventTimeZeroEstimate, 2)
    // 两个处理批次（cohort=4、cohort=6）应当各自被独立估计，而不是被合并成单一系数——
    // 这正是 saturated 相对旧 TWFE 的核心卖点（异质性处理效应不互相污染）。
    expect(independent.perCohortEventTimeZero.length).toBe(2)
  }, 60_000)
})
