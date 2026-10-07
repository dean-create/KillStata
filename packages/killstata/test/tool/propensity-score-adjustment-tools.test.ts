import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { executeRerunPlan, recordWorkflowStageFailure } from "@/runtime/workflow"
import { classifyToolFailure } from "@/tool/analysis-reflection"
import { ToolRegistry } from "@/tool/registry"
import { registerCanonicalDataset } from "../helpers/canonical-dataset"

function context(sessionID: string) {
  return {
    sessionID,
    messageID: "message_1",
    callID: "call_1",
    agent: "econometrics",
    abort: new AbortController().signal,
    metadata: async () => undefined,
    ask: async () => undefined,
  }
}

async function withInstance<T>(fn: (root: string) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-psm-adjustment-"))
  const previousPython = process.env.KILLSTATA_PYTHON
  if (!previousPython) process.env.KILLSTATA_PYTHON = path.join(os.homedir(), ".killstata", "venv", "bin", "python")
  try {
    return await Instance.provide({ directory: root, fn: () => fn(root) })
  } finally {
    if (previousPython === undefined) delete process.env.KILLSTATA_PYTHON
    else process.env.KILLSTATA_PYTHON = previousPython
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function modelVisibleTools() {
  const pool = await ToolRegistry.resolvePool({ providerID: "deepseek", modelID: "deepseek-v4-flash" }, undefined, {
    inputIntent: "analysis",
    currentStage: "preprocess_or_filter",
    platformCapabilities: { mcp: false, images: false, remote: false },
    modelCapabilities: { supportsTools: true, supportsImages: false },
  })
  return pool.load(["psm_regression", "psm_double_robust"])
}

function writeBalancedFixture(root: string) {
  const rows = ["unit,outcome,treated,x"]
  let unit = 0
  for (const [x, controlCount, treatedCount] of [
    [-1, 60, 40],
    [1, 40, 60],
  ] as const) {
    for (let index = 0; index < controlCount; index += 1) rows.push(`${++unit},${2 + 1.5 * x},0,${x}`)
    for (let index = 0; index < treatedCount; index += 1) rows.push(`${++unit},${2 + 3 + 1.5 * x},1,${x}`)
  }
  const sourcePath = path.join(root, "adjustment.csv")
  fs.writeFileSync(sourcePath, rows.join("\n"), "utf-8")
  return sourcePath
}

describe("model-visible strict propensity-score adjustment tools", () => {
  test("exposes exactly regression adjustment and AIPW, not the legacy duplicate", async () => {
    await withInstance(async () => {
      const tools = await modelVisibleTools()
      expect(tools.map((tool) => tool.id)).toEqual(expect.arrayContaining(["psm_regression", "psm_double_robust"]))
      expect(tools.map((tool) => tool.id)).not.toContain("psm_dr_ipw_ra")
    })
  })

  test.each([
    ["psm_regression", "倾向得分回归调整"],
    ["psm_double_robust", "双重稳健 AIPW"],
  ] as const)(
    "%s executes a fixed no-inference ATE contract",
    async (toolID, expectedTitle) => {
      await withInstance(async (root) => {
        const sessionID = `strict_${toolID}`
        const source = registerCanonicalDataset({ sessionID, sourcePath: writeBalancedFixture(root) })
        const tool = (await modelVisibleTools()).find((candidate) => candidate.id === toolID)
        if (!tool) throw new Error(`${toolID} is not model-visible`)
        const args = {
          ...source,
          dependentVar: "outcome",
          treatmentVar: "treated",
          covariates: ["x"],
          analysisUnitVar: "unit",
          preTreatmentAggregation: "not_applicable",
        }
        expect(tool.parameters.safeParse({ ...args, dependentVar: "treated" }).success).toBe(false)

        const execution = await tool.execute(args, context(sessionID) as never)
        const result = execution.metadata.result as
          | {
              ate?: number
              weighted_max_abs_smd?: number
              diagnostics_path?: string
              output_path?: string
              principle_checks?: { claim_ceiling?: string }
            }
          | undefined
        expect(result?.ate).toBeCloseTo(3, 12)
        expect(result?.weighted_max_abs_smd).toBeLessThanOrEqual(0.1)
        expect(result?.principle_checks?.claim_ceiling).toBe("full")
        expect(result?.diagnostics_path).toBeDefined()
        expect(result?.output_path).toBeDefined()
        const diagnostics = JSON.parse(fs.readFileSync(path.join(root, result!.diagnostics_path!), "utf-8")) as {
          matching?: {
            common_support?: { passed?: boolean }
            weighting?: { treatment_ess?: number }
            balance?: { weighted_max_abs_smd?: number }
          }
        }
        expect(diagnostics.matching?.common_support?.passed).toBe(true)
        expect(diagnostics.matching?.weighting?.treatment_ess).toBeGreaterThanOrEqual(20)
        expect(diagnostics.matching?.balance?.weighted_max_abs_smd).toBeLessThanOrEqual(0.1)
        const concise = fs.readFileSync(
          path.join(root, path.dirname(result!.output_path!), "delivery_result_summary.md"),
          "utf-8",
        )
        expect(concise).toContain(expectedTitle)
        expect(concise).not.toContain("missing numeric_snapshot")
        expect(execution.output).toContain(expectedTitle)
        expect(execution.output).toContain("未输出标准误、p 值、置信区间或显著性结论")
        expect(execution.output).toContain("协变量必须在处理前形成")
        expect(execution.metadata.groundingScope).toBe("outcome_adjustment")
      })
    },
    50_000,
  )

  test.each(["psm_regression", "psm_double_robust"] as const)(
    "%s requires a current estimate request before historical workflow handoff",
    async (toolID) => {
      await withInstance(async (root) => {
        const sessionID = `rerun_${toolID}`
        const source = registerCanonicalDataset({ sessionID, sourcePath: writeBalancedFixture(root) })
        const args = {
          ...source,
          dependentVar: "outcome",
          treatmentVar: "treated",
          covariates: ["x"],
          analysisUnitVar: "unit",
          preTreatmentAggregation: "not_applicable",
        }
        const failed = recordWorkflowStageFailure({
          sessionID,
          toolName: toolID,
          args,
          reflection: classifyToolFailure({
            toolName: toolID,
            error: "transient estimation failure",
            input: args,
            sessionId: sessionID,
          }),
        })

        const lookup = spyOn(ToolRegistry, "byID")
        try {
          const replay = await executeRerunPlan({
            sessionID,
            stageId: failed.stage.stageId,
            ctx: context(sessionID),
          })
          expect(replay.blocked).toBe(true)
          expect(replay.execution).toMatchObject({ status: "awaiting_user" })
          const handoff = "rerunHandoff" in replay ? replay.rerunHandoff : undefined
          expect(handoff).toMatchObject({ status: "estimate_request_required", methodID: toolID })
          expect(lookup).not.toHaveBeenCalled()
        } finally {
          lookup.mockRestore()
        }
      })
    },
    50_000,
  )
})
