import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { resolveTools } from "@/session/prompt/tools"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { econometricsEngineRoot, ensureRuntimePythonReady, resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"

describe("Python Registry 与动态方法引用 Schema 等价性", () => {
  test("Provider 动态引用原样保留 Python describe 的输入/输出 Schema", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const runtime = await ensureRuntimePythonReady()
        expect(runtime.ok).toBe(true)
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const sessionID = `session-schema-equivalence-${Date.now()}`
        const resolved = await resolveTools({
          agent,
          model,
          session: { id: sessionID, permission: [] } as never,
          processor: { message: { id: "message-schema-equivalence" }, partFromToolCall: () => undefined } as never,
          intent: "analysis",
          confirmedToolIDs: ["ols_regression"],
        })
        const reference = resolved.methodReferences().find((item) => item.toolID === "ols_regression")
        expect(reference?.descriptor?.executor).toBe("python")

        const engine = new EconometricsEngineClient({
          command: await resolveRuntimePythonCommand(),
          cwd: Instance.directory,
          pythonPath: path.join(econometricsEngineRoot(), "src"),
          methodRoot: path.join(econometricsEngineRoot(), "python"),
        })
        try {
          const described = await engine.describe("ols_regression")
          expect(reference?.descriptor?.input_schema).toEqual(described.input_schema as Record<string, unknown>)
          expect(reference?.descriptor?.output_schema).toEqual(described.output_schema as Record<string, unknown>)
          expect(reference?.descriptor?.description).toBe(described.description as string)
        } finally {
          await engine.close()
        }
      },
    })
  })
})
