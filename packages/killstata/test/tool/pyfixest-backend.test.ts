import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { runPyfixestBackend, validatePyfixestBackendResult } from "../../src/tool/pyfixest-backend"

let tempDir = ""

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-pyfixest-"))
})

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("PyFixest backend", () => {
  test("estimates a traditional two-by-two DID from group and post variables", async () => {
    const dataPath = path.join(tempDir, "traditional-did.csv")
    const outputDir = path.join(tempDir, "traditional-did-result")
    const rows = ["treated,t,fte"]
    for (const treated of [0, 1]) {
      for (const post of [0, 1]) {
        for (let index = 0; index < 20; index += 1) {
          const noise = (index % 5 - 2) * 0.1
          const outcome = 10 + 2 * treated - post + 3 * treated * post + noise
          rows.push(`${treated},${post},${outcome}`)
        }
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    const result = await runPyfixestBackend({
      pythonCommand: process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python"),
      cwd: process.cwd(),
      payload: {
        method: "did_static",
        dataPath,
        outputDir,
        dependentVar: "fte",
        groupVar: "treated",
        postVar: "t",
        covariates: [],
        covariance: "HC1",
      },
    })

    expect(result.success).toBe(true)
    expect(result.method).toBe("did_static")
    expect(result.primary?.term).toBe("treated:t")
    expect(result.primary?.estimate).toBeCloseTo(3, 10)
    expect(result.rowsUsed).toBe(80)
    expect(result.warnings?.join("\n")).toContain("两个时期")
  }, 30_000)

  test("estimates HDFE with clustered inference and safe aliases for non-formula column names", async () => {
    const dataPath = path.join(tempDir, "panel.csv")
    const outputDir = path.join(tempDir, "result")
    const rows = ["公司 编号,年份,结果 变量,v_0,控制\\变量"]
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

    const result = await runPyfixestBackend({
      pythonCommand: process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python"),
      cwd: process.cwd(),
      payload: {
        method: "hdfe_regression",
        dataPath,
        outputDir,
        dependentVar: "结果 变量",
        treatmentVar: "v_0",
        covariates: ["控制\\变量"],
        fixedEffects: ["公司 编号", "年份"],
        clusterVars: ["公司 编号"],
        covariance: "CRV1",
      },
    })

    expect(result.success).toBe(true)
    expect(result.method).toBe("hdfe_regression")
    expect(result.primary?.term).toBe("v_0")
    expect(result.primary?.estimate).toBeCloseTo(2, 2)
    expect(result.coefficients?.find((item) => item.term === "控制\\变量")?.estimate).toBeCloseTo(0.7, 2)
    expect(result.rowsUsed).toBe(72)
    expect(result.pyfixestVersion).toBe("0.60.0")
    expect(result.warnings?.join("\n")).toContain("聚类数量较少")
    expect(fs.existsSync(result.resultPath ?? "")).toBe(true)
    expect(fs.existsSync(result.coefficientsPath ?? "")).toBe(true)
  }, 30_000)

  test("runs DID2S and saturated event study through separate backend methods", async () => {
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
    const pythonCommand = process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python")

    const did2s = await runPyfixestBackend({
      pythonCommand,
      cwd: process.cwd(),
      payload: {
        method: "did2s",
        dataPath,
        outputDir: path.join(tempDir, "did2s"),
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
    const saturated = await runPyfixestBackend({
      pythonCommand,
      cwd: process.cwd(),
      payload: {
        method: "did_event_study_saturated",
        dataPath,
        outputDir: path.join(tempDir, "saturated"),
        dependentVar: "outcome",
        cohortVar: "cohort",
        entityVar: "unit",
        timeVar: "year",
        clusterVar: "unit",
        covariates: [],
        aggregateAtt: false,
      },
    })

    expect(did2s.success).toBe(true)
    expect(did2s.referencePeriod).toBe(-1)
    expect(did2s.coefficients?.length).toBeGreaterThan(3)
    expect(did2s.coefficients?.some((item) => item.term.includes("event_time::0"))).toBe(true)
    expect(did2s.primary?.term).toContain("event_time::0")
    expect(did2s.primary?.estimate).toBeCloseTo(1.5, 1)
    expect(saturated.success).toBe(true)
    expect(saturated.coefficients?.length).toBeGreaterThan(3)
    expect(saturated.coefficients?.every((item) => !item.term.includes("v_"))).toBe(true)
    expect(saturated.coefficients?.every((item) => !item.term.includes("rel_time"))).toBe(true)
    expect(saturated.coefficients?.every((item) => !item.term.includes("first_treated_period"))).toBe(true)
    expect(saturated.coefficients?.find((item) => item.term === "0.0")?.estimate).toBeCloseTo(1.5, 1)
  }, 60_000)

  test("fails closed when DID treatment reverses from one back to zero", async () => {
    const dataPath = path.join(tempDir, "invalid-did.csv")
    const rows = ["unit,year,treated,event_time,outcome"]
    for (let unit = 1; unit <= 20; unit += 1) {
      for (let year = 1; year <= 6; year += 1) {
        let treated = unit <= 10 && year >= 3 ? 1 : 0
        if (unit === 1 && year === 6) treated = 0
        const eventTime = unit <= 10 ? year - 3 : "-inf"
        rows.push(`${unit},${year},${treated},${eventTime},${unit * 0.1 + year * 0.2 + treated}`)
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    await expect(runPyfixestBackend({
      pythonCommand: process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python"),
      cwd: process.cwd(),
      payload: {
        method: "did2s",
        dataPath,
        outputDir: path.join(tempDir, "invalid-did-result"),
        dependentVar: "outcome",
        treatmentVar: "treated",
        relativeTimeVar: "event_time",
        entityVar: "unit",
        timeVar: "year",
        clusterVar: "unit",
        covariates: [],
        referencePeriod: -1,
      },
    })).rejects.toThrow("处理状态一旦变为 1，就不能再回到 0")
  }, 30_000)

  test("fails closed when DID relative time disagrees with the observed treatment start", async () => {
    const dataPath = path.join(tempDir, "misaligned-event-time.csv")
    const rows = ["unit,year,treated,event_time,outcome"]
    for (let unit = 1; unit <= 20; unit += 1) {
      for (let year = 1; year <= 6; year += 1) {
        const treated = unit <= 10 && year >= 3 ? 1 : 0
        const eventTime = unit <= 10 ? year - 2 : "-inf"
        rows.push(`${unit},${year},${treated},${eventTime},${unit * 0.1 + year * 0.2 + treated}`)
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    await expect(runPyfixestBackend({
      pythonCommand: process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python"),
      cwd: process.cwd(),
      payload: {
        method: "did2s",
        dataPath,
        outputDir: path.join(tempDir, "misaligned-event-time-result"),
        dependentVar: "outcome",
        treatmentVar: "treated",
        relativeTimeVar: "event_time",
        entityVar: "unit",
        timeVar: "year",
        clusterVar: "unit",
        covariates: [],
        referencePeriod: -1,
      },
    })).rejects.toThrow("相对时期与实际首次处理时点不一致")
  }, 30_000)

  test("requires the saturated event study to declare never-treated units as cohort zero", async () => {
    const dataPath = path.join(tempDir, "no-never-treated.csv")
    const rows = ["unit,year,cohort,outcome"]
    for (let unit = 1; unit <= 20; unit += 1) {
      const cohort = unit <= 10 ? 3 : 5
      for (let year = 1; year <= 7; year += 1) {
        const treated = year >= cohort ? 1 : 0
        rows.push(`${unit},${year},${cohort},${unit * 0.1 + year * 0.2 + treated}`)
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    await expect(runPyfixestBackend({
      pythonCommand: process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python"),
      cwd: process.cwd(),
      payload: {
        method: "did_event_study_saturated",
        dataPath,
        outputDir: path.join(tempDir, "no-never-treated-result"),
        dependentVar: "outcome",
        cohortVar: "cohort",
        entityVar: "unit",
        timeVar: "year",
        clusterVar: "unit",
        covariates: [],
        aggregateAtt: false,
      },
    })).rejects.toThrow("首次处理时期变量必须用 0 表示从未处理组")
  }, 30_000)

  test("requires one stable treatment cohort per entity", async () => {
    const dataPath = path.join(tempDir, "changing-cohort.csv")
    const rows = ["unit,year,cohort,outcome"]
    for (let unit = 1; unit <= 30; unit += 1) {
      for (let year = 1; year <= 7; year += 1) {
        let cohort = unit <= 10 ? 3 : unit <= 20 ? 5 : 0
        if (unit === 1 && year === 7) cohort = 5
        const treated = cohort > 0 && year >= cohort ? 1 : 0
        rows.push(`${unit},${year},${cohort},${unit * 0.1 + year * 0.2 + treated}`)
      }
    }
    fs.writeFileSync(dataPath, `${rows.join("\n")}\n`, "utf-8")

    await expect(runPyfixestBackend({
      pythonCommand: process.env.KILLSTATA_PYTHON ?? path.join(os.homedir(), ".killstata", "venv", "bin", "python"),
      cwd: process.cwd(),
      payload: {
        method: "did_event_study_saturated",
        dataPath,
        outputDir: path.join(tempDir, "changing-cohort-result"),
        dependentVar: "outcome",
        cohortVar: "cohort",
        entityVar: "unit",
        timeVar: "year",
        clusterVar: "unit",
        covariates: [],
        aggregateAtt: false,
      },
    })).rejects.toThrow("同一个体的首次处理时期必须保持不变")
  }, 30_000)

  test("rejects incomplete success payloads from the Python boundary", () => {
    expect(() => validatePyfixestBackendResult({ success: true })).toThrow("结果结构不完整")

    const coefficient = {
      term: "x",
      estimate: 1,
      stdError: 0.2,
      statistic: 5,
      pValue: 0.001,
      confLow: null,
      confHigh: null,
    }
    expect(() => validatePyfixestBackendResult({
      success: true,
      method: "hdfe_regression",
      backend: "pyfixest",
      pyfixestVersion: "0.60.0",
      rowsInput: 100,
      rowsUsed: 100,
      droppedRows: 0,
      coefficients: [coefficient],
      primary: coefficient,
      rSquared: 0.5,
      rSquaredWithin: 0.4,
      covariance: "HC1",
      clusterVars: [],
      clusterCounts: {},
      fixedEffects: ["firm"],
      coefficientsPath: "/tmp/coefficients.csv",
      resultPath: "/tmp/results.json",
      warnings: [],
    })).toThrow("结果结构不完整")
  })
})
