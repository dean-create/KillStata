import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { EconometricsTool } from "../../src/tool/econometrics"
import { buildSmartDatasetProfile, recommendEconometricsPlan } from "../../src/tool/econometrics-smart"
import { Instance } from "../../src/project/instance"
import { getRuntimePythonStatus } from "../../src/killstata/runtime-config"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
}

// 这个用例会真实启动项目实例并执行 auto_recommend 管线；Windows 上初始化和文件 IO 偶尔会超过 Bun 默认 5 秒。
const AUTO_RECOMMEND_TEST_TIMEOUT_MS = 15_000

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "killstata-econometrics-smart-"))
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = makeTempDir()
  try {
    return await Instance.provide({
      directory: root,
      fn: async () => fn(root),
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("tool.econometrics-smart", () => {
  test("recommends panel FE for panel-shaped data", () => {
    const profile = buildSmartDatasetProfile({
      rowCount: 120,
      entityVar: "firm_id",
      timeVar: "year",
      treatmentVar: "did",
      dependentVar: "y",
      entityCount: 20,
      timeCount: 6,
      avgPeriodsPerEntity: 6,
      duplicatePanelKeys: 0,
      columns: [
        {
          name: "firm_id",
          dtypeFamily: "categorical",
          nonNullCount: 120,
          uniqueCount: 20,
          binary: false,
          numeric: false,
          datetime: false,
          integerLike: false,
          nonnegative: false,
        },
        {
          name: "year",
          dtypeFamily: "numeric",
          nonNullCount: 120,
          uniqueCount: 6,
          binary: false,
          numeric: true,
          datetime: false,
          integerLike: true,
          nonnegative: true,
        },
        {
          name: "did",
          dtypeFamily: "numeric",
          nonNullCount: 120,
          uniqueCount: 2,
          binary: true,
          numeric: true,
          datetime: false,
          integerLike: true,
          nonnegative: true,
        },
        {
          name: "y",
          dtypeFamily: "numeric",
          nonNullCount: 120,
          uniqueCount: 120,
          binary: false,
          numeric: true,
          datetime: false,
          integerLike: false,
          nonnegative: false,
        },
      ],
    })

    const recommendation = recommendEconometricsPlan(profile)
    expect(profile.dataStructure).toBe("panel")
    expect(recommendation.recommendedMethod).toBe("panel_fe_regression")
    expect(recommendation.covariance).toBe("cluster")
  })

  test("never promotes an instrument-like column name into an automatic IV specification", () => {
    const profile = buildSmartDatasetProfile({
      rowCount: 500,
      dependentVar: "outcome",
      treatmentVar: "education",
      columns: [
        {
          name: "outcome",
          dtypeFamily: "numeric",
          nonNullCount: 500,
          uniqueCount: 480,
          binary: false,
          numeric: true,
          datetime: false,
          integerLike: false,
          nonnegative: false,
        },
        {
          name: "education",
          dtypeFamily: "numeric",
          nonNullCount: 500,
          uniqueCount: 20,
          binary: false,
          numeric: true,
          datetime: false,
          integerLike: true,
          nonnegative: true,
        },
        {
          name: "z",
          dtypeFamily: "numeric",
          nonNullCount: 500,
          uniqueCount: 2,
          binary: true,
          numeric: true,
          datetime: false,
          integerLike: true,
          nonnegative: true,
        },
      ],
    })

    const recommendation = recommendEconometricsPlan(profile)
    expect(profile.candidateInstrumentVars).toEqual(["z"])
    expect(recommendation.recommendedMethod).toBe("ols_regression")
    expect(recommendation.nextBestMethods).not.toContain("psm_double_robust")
    expect(recommendation.warnings.join("\n")).toContain("must be confirmed by the user or research design")
  })

  test("auto_recommend generates profile and recommendation artifacts", async () => {
    await withInstance(async (root) => {
      const runtime = await getRuntimePythonStatus()
      if (!runtime.ok || runtime.missing.length > 0) return

      const csvPath = path.join(root, "panel.csv")
      const rows = ["firm_id,year,did,y"]
      for (let firm = 1; firm <= 8; firm += 1) {
        for (let year = 2018; year <= 2021; year += 1) {
          const did = year >= 2020 ? 1 : 0
          const y = firm * 0.5 + year * 0.01 + did * 2
          rows.push(`${firm},${year},${did},${y.toFixed(3)}`)
        }
      }
      fs.writeFileSync(csvPath, rows.join("\n"), "utf-8")

      const tool = await EconometricsTool.init()
      const result = await tool.execute(
        {
          methodName: "auto_recommend",
          dataPath: "panel.csv",
          dependentVar: "y",
          treatmentVar: "did",
          entityVar: "firm_id",
          timeVar: "year",
        },
        ctx as any,
      )

      expect(result.metadata.profile).toBeDefined()
      expect(result.metadata.recommendation).toBeDefined()
      expect(result.metadata.profile!.dataStructure).toBe("panel")
      expect(result.metadata.recommendation!.recommendedMethod).toBe("panel_fe_regression")

      const outputDir = path.join(root, "analysis", "auto_recommend")
      expect(fs.existsSync(path.join(outputDir, "profile.json"))).toBe(true)
      expect(fs.existsSync(path.join(outputDir, "recommendation.json"))).toBe(true)
      expect(fs.existsSync(path.join(outputDir, "results.json"))).toBe(true)
    })
  }, AUTO_RECOMMEND_TEST_TIMEOUT_MS)

  test("auto_recommend handles boolean dtype before numeric subtraction", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "tool", "econometrics.ts"), "utf-8")
    const boolGuard = source.indexOf("if is_bool_dtype(series):\n        return True")
    const numericSubtraction = source.indexOf("numeric - numeric.round()")

    expect(boolGuard).toBeGreaterThan(-1)
    expect(numericSubtraction).toBeGreaterThan(boolGuard)
  })
})
