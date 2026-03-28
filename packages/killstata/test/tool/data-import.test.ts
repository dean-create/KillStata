import { describe, expect, test } from "bun:test"
import { DataImportTool } from "../../src/tool/data-import"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "data-import",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.data_import", () => {
  test("initializes with schema and description", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await DataImportTool.init()
        expect(tool).toBeDefined()
        expect(tool.description.toLowerCase()).toContain("data")
      },
    })
  })

  test("throws when input file is missing", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await DataImportTool.init()

        let thrown: Error | undefined
        try {
          await tool.execute(
            {
              action: "import",
              inputPath: "missing.csv",
              preserveLabels: true,
              createInspectionArtifacts: true,
            },
            ctx as any,
          )
        } catch (error) {
          thrown = error as Error
        }

        expect(thrown).toBeDefined()
        expect(thrown!.message).toContain("Input file not found")
      },
    })
  })

  test("accepts new workflow actions in schema", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await DataImportTool.init()

        const filterParsed = tool.parameters.parse({
          action: "filter",
          inputPath: "panel.csv",
          preserveLabels: true,
          filters: [
            {
              column: "省份",
              operator: "not_in",
              values: ["北京市", "天津市", "上海市", "重庆市"],
              caseSensitive: false,
            },
          ],
        })
        const describeParsed = tool.parameters.parse({
          action: "describe",
          datasetId: "dataset_x",
          stageId: "stage_000",
          runId: "run_20260324-153010_demo",
          preserveLabels: true,
          variables: ["数字经济指数", "数字普惠金融指数"],
        })
        const importParsed = tool.parameters.parse({
          action: "import",
          inputPath: "panel.dta",
          format: "parquet",
          preserveLabels: true,
        })
        const preprocessParsed = tool.parameters.parse({
          action: "preprocess",
          datasetId: "dataset_x",
          stageId: "stage_000",
          preserveLabels: true,
          operations: [
            {
              type: "group_linear_interpolate",
              variables: ["经济发展水平"],
              params: {
                group_by: ["地区"],
                time_var: "year",
              },
            },
          ],
        })
        const healthParsed = tool.parameters.parse({
          action: "healthcheck",
          preserveLabels: true,
        })
        const rollbackParsed = tool.parameters.parse({
          action: "rollback",
          datasetId: "dataset_x",
          stageId: "stage_000",
          preserveLabels: true,
        })

        expect(filterParsed.action).toBe("filter")
        expect(describeParsed.action).toBe("describe")
        expect(describeParsed.runId).toBe("run_20260324-153010_demo")
        expect(importParsed.format).toBe("parquet")
        expect(preprocessParsed.operations?.[0]?.type).toBe("group_linear_interpolate")
        expect(healthParsed.action).toBe("healthcheck")
        expect(rollbackParsed.action).toBe("rollback")
      },
    })
  })

  test("requires inputPath for non-healthcheck actions", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await DataImportTool.init()

        let thrown: Error | undefined
        try {
          await tool.execute(
            {
              action: "filter",
              preserveLabels: true,
              createInspectionArtifacts: true,
              filters: [{ column: "省份", operator: "not_in", values: ["北京市"], caseSensitive: false }],
            },
            ctx as any,
          )
        } catch (error) {
          thrown = error as Error
        }

        expect(thrown).toBeDefined()
        expect(thrown!.message).toContain("requires inputPath or datasetId + stageId")
      },
    })
  })
})
