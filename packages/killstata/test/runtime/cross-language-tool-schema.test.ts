import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { providerToolSchemaText, resolveTools } from "@/session/prompt/tools"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { econometricsEngineRoot, ensureRuntimePythonReady, resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { Token } from "@/util/token"

const CAPABILITIES = [
  "data_import",
  "data_preprocess",
  "composite_evaluation",
  "econometrics_recommend",
  "heterogeneity_runner",
] as const

describe("跨语言领域工具只向模型暴露 Python Registry Schema", () => {
  test("五项 Provider Schema 精确等价，方法检索正确且不改变固定工具前缀", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const runtime = await ensureRuntimePythonReady()
        expect(runtime.ok).toBe(true)
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const sessionID = `session-cross-schema-${Date.now()}`
        const workflowRunId = `workflow-cross-schema-${Date.now()}`
        const now = new Date().toISOString()
        const workflow = readWorkflowSession(sessionID)
        workflow.runs.push({
          workflowRunId,
          sessionID,
          workflowMode: "econometrics",
          workflowLocale: "zh-CN",
          branch: "main",
          activeStage: "baseline_estimate",
          activeNodeId: "main:estimate",
          stageSequence: [],
          edges: [],
          trustedArtifacts: [],
          analysisChecklist: [],
          approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate",
            stageId: "stage_000",
            kind: "baseline_estimate",
            status: "completed",
            branch: "main",
            toolName: "ols_regression",
            replayInput: {},
            artifactRefs: [],
            trustedArtifacts: [],
            createdAt: now,
            updatedAt: now,
          }],
          createdAt: now,
          updatedAt: now,
        } as never)
        workflow.activeRunId = workflowRunId
        writeWorkflowSession(workflow)
        const resolved = await resolveTools({
          agent: await Agent.get("analyst"),
          model,
          session: { id: sessionID, permission: [] } as never,
          processor: {
            message: { id: "message-cross-schema" },
            partFromToolCall: () => undefined,
            executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) =>
              options.run(args),
          } as never,
          intent: "analysis",
        })
        const engine = new EconometricsEngineClient({
          command: await resolveRuntimePythonCommand(),
          cwd: Instance.directory,
          pythonPath: path.join(econometricsEngineRoot(), "src"),
          methodRoot: path.join(econometricsEngineRoot(), "python"),
        })
        try {
          for (const toolID of CAPABILITIES) {
            const definition = resolved.definitions[toolID]
            expect(definition, `${toolID} must be present in this analysis tool pool`).toBeDefined()
            const described = await engine.describe(toolID)
            expect(definition.descriptor?.executor, toolID).toBe("python")
            expect(JSON.stringify(definition.descriptor?.input_schema), `${toolID} descriptor input`).toBe(JSON.stringify(described.input_schema))
            expect(JSON.stringify(definition.descriptor?.output_schema), `${toolID} descriptor output`).toBe(JSON.stringify(described.output_schema))
            expect(definition.descriptor?.description, `${toolID} description`).toBe(described.description as string)
            expect(
              JSON.stringify((definition.inputSchema as { jsonSchema?: unknown }).jsonSchema),
              `${toolID} Provider input`,
            ).toBe(JSON.stringify(described.input_schema))
          }

          const fixedPool = resolved.toolPoolSnapshot()
          expect(fixedPool.methodToolCount).toBe(0)
          expect(fixedPool.systemToolCount).toBeLessThanOrEqual(20)
          expect(fixedPool.schemaTokens).toBeLessThan(20_000)
          expect(fixedPool.schemaTokens).toBe(Token.estimate(providerToolSchemaText(resolved.definitions)))
          const retrievalCases = [
            { query: "普通最小二乘", expected: "ols_regression" },
            { query: "面板固定效应", expected: "panel_fe_regression" },
            { query: "两阶段最小二乘", expected: "iv_2sls" },
          ]
          for (let index = 0; index < retrievalCases.length; index++) {
            const { query, expected } = retrievalCases[index]!
            const searchResult = await resolved.port.execute({
              id: `schema-budget-search-${index}`,
              name: "tool_search",
              input: { query, limit: 1 },
              abort: new AbortController().signal,
            }) as { metadata?: { loadedToolIDs?: string[] } }
            expect(searchResult.metadata?.loadedToolIDs).toEqual([expected])
            await resolved.commitDeferredTools()
            const poolWithMethod = resolved.toolPoolSnapshot()
            expect(poolWithMethod.methodToolCount).toBe(index + 1)
            expect(poolWithMethod.systemToolCount).toBe(fixedPool.systemToolCount)
            expect(poolWithMethod.schemaTokens).toBe(fixedPool.schemaTokens)
          }
        } finally {
          await engine.close()
        }
      },
    })
  })
})
