import { describe, expect, test } from "bun:test"
import { EconometricsTool } from "../../src/tool/econometrics"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.econometrics", () => {
  test("initializes with supported method schema", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await EconometricsTool.init()
        expect(tool).toBeDefined()

        const parsed = tool.parameters.parse({
          methodName: "panel_fe_regression",
          datasetId: "did_dataset",
          stageId: "stage_000",
          runId: "run_20260324-153010_demo",
          dependentVar: "y",
          treatmentVar: "x",
          entityVar: "province",
          timeVar: "year",
        })

        expect(parsed.methodName).toBe("panel_fe_regression")
        expect(parsed.runId).toBe("run_20260324-153010_demo")
      },
    })
  })

  test("requires treatmentVar for treatment-effect methods", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await EconometricsTool.init()

        let thrown: Error | undefined
        try {
          await tool.execute(
            {
              methodName: "ols_regression",
              dataPath: "missing.csv",
              dependentVar: "y",
            },
            ctx as any,
          )
        } catch (error) {
          thrown = error as Error
        }

        expect(thrown).toBeDefined()
        expect(thrown!.message).toContain("requires treatmentVar")
      },
    })
  })

  test("accepts canonical dataset references", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await EconometricsTool.init()

        const parsed = tool.parameters.parse({
          methodName: "baseline_regression",
          datasetId: "did_dataset",
          stageId: "stage_000",
          branch: "baseline",
          dependentVar: "经济发展水平",
          treatmentVar: "did",
          entityVar: "地区",
          timeVar: "year",
        })

        expect(parsed.datasetId).toBe("did_dataset")
        expect(parsed.stageId).toBe("stage_000")
      },
    })
  })

  test("requires entityVar and timeVar for panel FE", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await EconometricsTool.init()

        let thrown: Error | undefined
        try {
          await tool.execute(
            {
              methodName: "panel_fe_regression",
              dataPath: "missing.csv",
              dependentVar: "y",
              treatmentVar: "x",
            },
            ctx as any,
          )
        } catch (error) {
          thrown = error as Error
        }

        expect(thrown).toBeDefined()
        expect(thrown!.message).toContain("entityVar and timeVar")
      },
    })
  })

  test("requires method-specific options for IV", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await EconometricsTool.init()

        let thrown: Error | undefined
        try {
          await tool.execute(
            {
              methodName: "iv_2sls",
              dataPath: "missing.csv",
              dependentVar: "y",
              treatmentVar: "x",
              covariates: ["c1"],
              options: {},
            },
            ctx as any,
          )
        } catch (error) {
          thrown = error as Error
        }

        expect(thrown).toBeDefined()
        expect(thrown!.message).toContain("requires options")
        expect(thrown!.message).toContain("iv_variable")
      },
    })
  })
})
