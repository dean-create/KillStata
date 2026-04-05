import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { EconometricsTool } from "../../src/tool/econometrics"
import { buildSmartDatasetProfile, recommendEconometricsPlan } from "../../src/tool/econometrics-smart"
import { Instance } from "../../src/project/instance"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
}

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

  test("auto_recommend generates profile and recommendation artifacts", async () => {
    await withInstance(async (root) => {
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
  })
})
