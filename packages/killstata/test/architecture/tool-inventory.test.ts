import { describe, expect, test } from "bun:test"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { isConcreteMethodTool } from "@/runtime/workflow/exposure"
import { TOOL_MANIFEST } from "@/runtime/tool-manifest"

const model = { providerID: "deepseek", modelID: "deepseek-v4-flash" }
const analysisContext = {
  inputIntent: "analysis" as const,
  workflowMode: "econometrics" as const,
  currentStage: "baseline_estimate" as const,
  agent: "analyst",
  platformCapabilities: { mcp: false, images: false, remote: false },
  modelCapabilities: { supportsTools: true, supportsImages: false },
}

describe("工具架构 inventory", () => {
  test("计量方法只通过稳定入口进入模型直出面", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const pool = await ToolRegistry.resolvePool(model, undefined, analysisContext)
        const concreteMethods = TOOL_MANIFEST
          .filter((entry) => entry.family === "diagnostic" || entry.family === "estimator")
          .map((entry) => entry.id)

        const directToolIDs = pool.resolution.directToolIDs ?? []
        expect(directToolIDs).toContain("tool_search")
        expect(directToolIDs).toContain("econometrics_execute")
        expect(directToolIDs.filter(isConcreteMethodTool)).toEqual([])
        expect(pool.resolution.deferredToolIDs).toEqual(expect.arrayContaining(concreteMethods))
      },
    })
  })

  test("历史 replay 实现存在，但不进入 Provider 直出工具集合", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const pool = await ToolRegistry.resolvePool(model, undefined, analysisContext)
        const replay = await pool.load(["ols_regression"])
        expect(replay.map((tool) => tool.id)).toEqual(["ols_regression"])
        expect(pool.direct.map((tool) => tool.id)).not.toContain("ols_regression")
      },
    })
  })

  test("manifest ID 不重复，方法 ID 全部能被 ToolRegistry 识别", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const manifestIDs = TOOL_MANIFEST.map((entry) => entry.id)
        expect(new Set(manifestIDs).size).toBe(manifestIDs.length)
        const registeredIDs = new Set(await ToolRegistry.ids())
        for (const entry of TOOL_MANIFEST) expect(registeredIDs.has(entry.id)).toBe(true)
      },
    })
  })
})
