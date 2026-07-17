import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { WORKFLOW_KNOWN_TOOL_IDS } from "@/runtime/tool-catalog"
import { ToolRegistry } from "@/tool/registry"
import { loadRealPaperDatasetContract } from "../helpers/real-paper-datasets"

type Decision = "call" | "call_after_repair" | "clarify" | "repair_data"

type IntentCase = {
  id: string
  prompt: string
  decision: Decision
  expectedTool?: string
  expectedArgs?: Record<string, unknown>
  forbiddenTools: string[]
  riskTags: string[]
  requiredGuidance?: string[]
  summaryRules?: string[]
  rationale: string
}

type IntentFixture = {
  dataset: string
  cases: IntentCase[]
}

const FIXTURES_ROOT = path.join(import.meta.dir, "..", "fixtures", "real-paper-intents")

function loadIntentFixtures() {
  return fs
    .readdirSync(FIXTURES_ROOT)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, file), "utf-8")) as IntentFixture
      return fixture.cases.map((item) => ({ ...item, dataset: fixture.dataset, file }))
    })
}

async function withAnalysisTools<T>(fn: (tools: Awaited<ReturnType<typeof ToolRegistry.tools>>) => Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-real-intents-"))
  try {
    return await Instance.provide({
      directory: root,
      fn: async () =>
        fn(
          await ToolRegistry.tools(
            { providerID: "deepseek", modelID: "deepseek-v4-flash" },
            undefined,
            {
              inputIntent: "analysis",
              currentStage: "preprocess_or_filter",
              platformCapabilities: { mcp: false, images: false, remote: false },
              modelCapabilities: { supportsTools: true, supportsImages: false },
            },
          ),
        ),
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const RISK_POLICIES: Record<
  string,
  { decision?: Decision; forbidden?: string[]; expectedTool?: string; guidance?: string[] }
> = {
  fixed_effects_requested: { forbidden: ["ols_regression"] },
  staggered_panel: { forbidden: ["did_static"] },
  raw_cohort_sentinel: {
    decision: "repair_data",
    forbidden: ["did2s", "did_event_study_saturated"],
    guidance: ["never-treated", "相对时期"],
  },
  missing_iv_design: { decision: "clarify", forbidden: ["iv_2sls"], guidance: ["工具变量", "排除限制"] },
  panel_psm_unit_mismatch: {
    decision: "clarify",
    forbidden: ["psm_construction", "psm_visualize", "psm_matching"],
    guidance: ["基期", "ATT"],
  },
  missing_heterogeneity_definition: {
    decision: "clarify",
    forbidden: ["heterogeneity_runner"],
    guidance: ["分组变量"],
  },
  ambiguous_panel_key: {
    decision: "repair_data",
    forbidden: ["panel_fe_regression", "hdfe_regression"],
    guidance: ["复合键", "静默去重"],
  },
  profile_before_estimation: { expectedTool: "econometrics_recommend" },
  requires_validated_repair: { decision: "call_after_repair" },
}

function stringsFromArgs(args: Record<string, unknown>) {
  const roleKeys = [
    "dependentVar",
    "treatmentVar",
    "entityVar",
    "timeVar",
    "clusterVar",
    "endogenousVar",
    "instrumentVar",
    "groupVar",
    "postVar",
    "relativeTimeVar",
    "cohortVar",
  ]
  const listKeys = ["covariates", "fixedEffects", "clusterVars"]
  return [
    ...roleKeys.flatMap((key) => (typeof args[key] === "string" ? [args[key] as string] : [])),
    ...listKeys.flatMap((key) => (Array.isArray(args[key]) ? (args[key] as unknown[]).filter((x): x is string => typeof x === "string") : [])),
  ]
}

describe("real-paper research intent routing contracts", () => {
  const fixtures = loadIntentFixtures()

  test("fixtures are uniquely identified and contain an explicit decision rationale", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(14)
    expect(new Set(fixtures.map((item) => item.id)).size).toBe(fixtures.length)
    for (const fixture of fixtures) {
      expect(fixture.prompt.trim().length, fixture.id).toBeGreaterThan(8)
      expect(fixture.rationale.trim().length, fixture.id).toBeGreaterThan(8)
      expect(fixture.riskTags.length, fixture.id).toBeGreaterThan(0)
      if (fixture.decision === "call" || fixture.decision === "call_after_repair") {
        expect(fixture.expectedTool, fixture.id).toBeDefined()
        expect(fixture.expectedArgs, fixture.id).toBeDefined()
      } else {
        expect(fixture.expectedTool, fixture.id).toBeUndefined()
        expect(fixture.expectedArgs, fixture.id).toBeUndefined()
        expect(fixture.requiredGuidance?.length ?? 0, fixture.id).toBeGreaterThan(0)
      }
    }
  })

  test("every expected call passes the actual model-visible ToolRegistry schema", async () => {
    await withAnalysisTools(async (tools) => {
      const toolsById = new Map(tools.map((tool) => [tool.id, tool]))
      const knownToolIds = new Set<string>(WORKFLOW_KNOWN_TOOL_IDS)
      for (const fixture of fixtures) {
        for (const forbidden of fixture.forbiddenTools) {
          expect(knownToolIds.has(forbidden), `${fixture.id}: unknown forbidden tool ${forbidden}`).toBe(true)
        }
        if (!fixture.expectedTool || !fixture.expectedArgs) continue
        const tool = toolsById.get(fixture.expectedTool)
        expect(tool, `${fixture.id}: ${fixture.expectedTool} is not model-visible`).toBeDefined()
        if (!tool) continue
        const parsed = tool.parameters.safeParse(fixture.expectedArgs)
        if (!parsed.success) {
          throw new Error(`${fixture.id}: ${fixture.expectedTool} 参数未通过真实 Schema：${JSON.stringify(parsed.error.issues)}`)
        }
        expect(fixture.forbiddenTools).not.toContain(fixture.expectedTool)
        for (const legacyKey of ["dataPath", "methodName", "options", "outputDir", "cwd", "command"]) {
          expect(fixture.expectedArgs).not.toHaveProperty(legacyKey)
        }
      }
    })
  })

  test("all intended variable roles are grounded in source or declared derived columns", () => {
    const contract = loadRealPaperDatasetContract()
    for (const fixture of fixtures) {
      if (!fixture.expectedArgs) continue
      const allowed = fixture.dataset.startsWith("did.xlsx")
        ? new Set(contract.did.headers)
        : new Set([...contract.digital.headers, ...contract.digital.plannedDerivedColumns])
      for (const column of stringsFromArgs(fixture.expectedArgs)) {
        expect(allowed.has(column), `${fixture.id}: column not grounded: ${column}`).toBe(true)
      }
    }
  })

  test("semantic risk policies block method substitution before schema-valid calls can execute", () => {
    for (const fixture of fixtures) {
      for (const tag of fixture.riskTags) {
        const policy = RISK_POLICIES[tag]
        if (!policy) continue
        if (policy.decision) expect(fixture.decision, `${fixture.id}: ${tag}`).toBe(policy.decision)
        if (policy.expectedTool) expect(fixture.expectedTool, `${fixture.id}: ${tag}`).toBe(policy.expectedTool)
        for (const tool of policy.forbidden ?? []) {
          expect(fixture.forbiddenTools, `${fixture.id}: ${tag}`).toContain(tool)
        }
        const guidance = fixture.requiredGuidance?.join(" ") ?? ""
        for (const word of policy.guidance ?? []) expect(guidance, `${fixture.id}: ${tag}`).toContain(word)
      }
    }
  })

  test("mechanism screens require restrained Chinese interpretation rules", () => {
    const mechanismCases = fixtures.filter((fixture) => fixture.riskTags.includes("mechanism_screen"))
    expect(mechanismCases.length).toBeGreaterThanOrEqual(3)
    for (const fixture of mechanismCases) {
      const rules = fixture.summaryRules?.join(" ") ?? ""
      expect(rules).toMatch(/机制线索|关联证据/)
      expect(rules).toContain("不能声称已证明中介因果效应")
    }
  })
})
