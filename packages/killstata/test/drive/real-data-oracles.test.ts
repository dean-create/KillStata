import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  REAL_DATA_ORACLES,
  realDataOracleFilePath,
  validateRealDataOracle,
} from "./data-oracles"
import { findScenario } from "./scenarios"

test("real-data oracle reports an absent local fixture without requiring user data in Git", () => {
    const emptyDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-empty-real-data-"))
    try {
      const missing = validateRealDataOracle("did.xlsx", emptyDataDirectory)
      expect(missing).toHaveLength(1)
      expect(missing[0]).toContain("数据文件不存在")
  } finally {
    fs.rmSync(emptyDataDirectory, { recursive: true, force: true })
  }
})

describe("真实数据 Oracle 与首靶点旅程", () => {
  for (const file of Object.keys(REAL_DATA_ORACLES) as Array<keyof typeof REAL_DATA_ORACLES>) {
    const name = `${file} 本地真实数据指纹`
    const dataDirectory = process.env.KILLSTATA_TEST_DATA_DIR
    if (fs.existsSync(realDataOracleFilePath(file, dataDirectory))) {
      test(name, () => {
        expect(validateRealDataOracle(file, dataDirectory), file).toEqual([])
      })
    } else {
      // 原始 workbook 是本地忽略数据。无文件的干净 checkout 明确显示 skip，
      // 仍保留用户本机存在时的 SHA-256 验证，不能把缺文件当成验证通过。
      test.skip(`${name}（未提供本地数据文件）`, () => {})
    }
  }

  test("test_datasets.xlsx 锁定复合实体键事实与文件指纹", () => {
    const oracle = REAL_DATA_ORACLES["test_datasets.xlsx"]
    expect(oracle).toMatchObject({
      sha256: "a001c91e746b69d37cb3beeb46b1059065691fa532cb65b1e462eb4c10a02927",
      sheet: "Sheet1",
      rows: 9_683,
      columns: 8,
      panel: {
        entityVar: "地区",
        timeVar: "年份",
        duplicateEntityTimeRows: 115,
        compositeEntityColumns: ["省份", "地区"],
        compositeEntities: 421,
        duplicateCompositeTimeRows: 0,
      },
    })
  })

  test("digital-panel-composite-key 场景只使用真实列并锁定 UX/修复行为", () => {
    const scenario = findScenario("digital-panel-composite-key")
    expect(scenario).toBeDefined()
    expect(scenario?.dataFile).toBe("test_datasets.xlsx")
    expect(scenario?.expectEstimate).toBe(true)
    const message = scenario?.userMessage?.("/tmp/test_datasets.xlsx") ?? ""
    for (const column of ["地区", "年份", "数字普惠金融指数", "每百人互联网用户数", "省份"]) {
      expect(message).toContain(column)
    }

    const assertions = scenario!.behavior({
      toolCalls: [
        {
          tool: "data_preprocess",
          status: "completed",
          args: JSON.stringify({
            method: "combine_columns",
            columns: ["省份", "地区"],
            options: { output_column: "省份_地区" },
          }),
        },
        {
          tool: "panel_fe_regression",
          status: "completed",
          args: JSON.stringify({
            entityVar: "省份_地区",
            timeVar: "年份",
            dependentVar: "数字普惠金融指数",
            independentVars: ["每百人互联网用户数"],
          }),
        },
      ],
      toolErrors: [],
      timedOut: false,
      run: {
        stages: [
          { kind: "preprocess_or_filter", status: "completed" },
          { kind: "validate", status: "completed" },
          { kind: "baseline_estimate", status: "completed" },
        ],
      } as never,
      resultFiles: ["result.json"],
      questionCount: 0,
      questionEvents: [],
      assistantText: "发现跨省同名地区，构造省份+地区复合实体键，不删除任何观测。",
      assistantTexts: [
        "开始导入并检查面板键。",
        "发现跨省同名地区，正在构造复合实体键，不删除任何观测。",
        "重新质检通过，开始双向固定效应估计。",
      ],
      turnTexts: [[]],
      lastTurnAssistantText: "双向固定效应估计完成。",
      finalAssistantText: "双向固定效应估计完成，样本量 9683。",
    })
    expect(assertions.every((item) => item.pass), assertions.map((item) => item.detail).join("\n")).toBe(true)
    expect(assertions.some((item) => item.category === "ux")).toBe(true)
  })

  test("Phase 2 导入旅程锁定 named sheet、空 sheet 与 CSV BOM 边界", () => {
    const cases = [
      ["did-raw-sheet", "did.xlsx", "Data_原始编码"],
      ["gf-nonempty-sheet", "gf.xlsx", "Sheet1"],
      ["did-csv-bom", "did_stage000.csv", "year"],
    ] as const
    for (const [id, file, marker] of cases) {
      const scenario = findScenario(id)
      expect(scenario, id).toBeDefined()
      expect(scenario?.dataFile).toBe(file)
      expect(scenario?.expectEstimate).toBe(false)
      expect(scenario?.userMessage?.(`/tmp/${file}`)).toContain(marker)
    }

    const base = {
      toolErrors: [],
      timedOut: false,
      run: {
        stages: [
          { kind: "import", status: "completed" },
          { kind: "profile_or_diagnostics", status: "completed" },
        ],
      } as never,
      resultFiles: [],
      questionCount: 0,
      questionEvents: [],
      assistantTexts: ["导入完成。", "画像完成。"],
      turnTexts: [[]],
      lastTurnAssistantText: "画像完成。",
      finalAssistantText: "画像完成。",
    }
    const contexts = {
      "did-raw-sheet": {
        ...base,
        assistantText: "已导入 Data_原始编码 工作表。",
        toolCalls: [
          { tool: "data_import", status: "completed", args: JSON.stringify({ action: "import", sheetPolicy: { mode: "named_sheet", sheetName: "Data_原始编码" } }) },
          { tool: "data_import", status: "completed", args: JSON.stringify({ action: "profile" }) },
        ],
      },
      "gf-nonempty-sheet": {
        ...base,
        assistantText: "已使用 Sheet1，9545行×11列；空工作表未影响导入。",
        toolCalls: [
          { tool: "data_import", status: "completed", args: JSON.stringify({ action: "import", sheetPolicy: { mode: "first_sheet" } }) },
          { tool: "data_import", status: "completed", args: JSON.stringify({ action: "profile" }) },
        ],
      },
      "did-csv-bom": {
        ...base,
        assistantText: "CSV 导入为4709行×34列，year 列名正常。",
        toolCalls: [
          { tool: "data_import", status: "completed", args: JSON.stringify({ action: "import" }) },
          { tool: "data_import", status: "completed", args: JSON.stringify({ action: "profile" }) },
        ],
      },
    }
    for (const [id, context] of Object.entries(contexts)) {
      const assertions = findScenario(id)!.behavior(context as never)
      expect(assertions.every((assertion) => assertion.pass), `${id}: ${assertions.map((item) => item.detail).join(" | ")}`).toBe(true)
    }
  })

  test("跨数据集回切不重新导入，也不把 gf 的变量带回 did", () => {
    const scenario = findScenario("two-datasets-return")
    expect(scenario).toBeDefined()
    expect(scenario?.dataFile).toBe("did.xlsx")
    expect(scenario?.extraDataFiles).toEqual(["gf.xlsx"])
    const messages = scenario?.userMessages?.("/tmp/did.xlsx", ["/tmp/gf.xlsx"]) ?? []
    expect(messages).toHaveLength(3)
    expect(messages[2]).toContain("回到第一份")

    const assertions = scenario!.behavior({
      toolCalls: [
        { tool: "data_import", status: "completed", args: JSON.stringify({ action: "import", inputPath: "/tmp/did.xlsx" }) },
        { tool: "ols_regression", status: "completed", args: JSON.stringify({ dependentVar: "创新指数", treatmentVar: "高质量发展指数" }) },
        { tool: "data_import", status: "completed", args: JSON.stringify({ action: "import", inputPath: "/tmp/gf.xlsx" }) },
        { tool: "ols_regression", status: "completed", args: JSON.stringify({ dependentVar: "绿色金融指数", treatmentVar: "绿色信贷" }) },
        { tool: "ols_regression", status: "completed", args: JSON.stringify({ dependentVar: "创新指数", treatmentVar: "高质量发展指数" }) },
      ],
      toolErrors: [],
      timedOut: false,
      run: { stages: [{ kind: "baseline_estimate", status: "completed" }] } as never,
      resultFiles: ["did-first.json", "gf.json", "did-return.json"],
      questionCount: 0,
      questionEvents: [],
      assistantText: "已回到第一份 did 数据，不重新导入。",
      assistantTexts: ["did OLS 完成", "gf OLS 完成", "已回到第一份 did 数据，不重新导入"],
      turnTexts: [["did OLS 完成"], ["gf OLS 完成"], ["已回到第一份 did 数据，不重新导入"]],
      lastTurnAssistantText: "已回到第一份 did 数据，不重新导入。",
      finalAssistantText: "已回到第一份 did 数据，不重新导入。",
    })
    expect(assertions.every((item) => item.pass), assertions.map((item) => item.detail).join(" | ")).toBe(true)
  })
})
