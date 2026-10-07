import { expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { resolveTools } from "@/session/prompt/tools"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"

test("方法推荐使用当前规范化阶段，覆盖模型抄来的脱敏引用", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-recommend-lineage-"))
  try {
    await Instance.provide({
      directory,
      fn: async () => {
        const sessionID = `session_recommend_lineage_${Date.now()}`
        const datasetId = `dataset_recommend_lineage_${Date.now()}`
        const manifest = createDatasetManifest({ datasetId, sourcePath: path.join(directory, "source.xlsx"), sourceFormat: "xlsx" })
        appendStage(manifest, {
          stageId: "stage_000",
          branch: "main",
          action: "import",
          workingPath: path.join(directory, "stage.parquet"),
          workingFormat: "parquet",
          createdAt: new Date().toISOString(),
        })
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_recommend_lineage",
          sessionID,
          workflowMode: "econometrics",
          workflowLocale: "zh-CN",
          datasetId,
          branch: "main",
          activeStage: "profile_or_schema_check",
          activeNodeId: "main:profile",
          stageSequence: [],
          edges: [],
          trustedArtifacts: [],
          analysisChecklist: [],
          approvalStatus: "approved",
          stages: [{
            nodeId: "main:profile", stageId: "stage_000", kind: "profile_or_schema_check", status: "completed",
            branch: "main", toolName: "data_import", replayInput: {}, artifactRefs: [], trustedArtifacts: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_recommend_lineage"
        writeWorkflowSession(state)

        let executed: { datasetId?: string; stageId?: string } | undefined
        const resolved = await resolveTools({
          agent: await Agent.get("analyst"),
          model: await Provider.getModel("deepseek", "deepseek-v4-flash"),
          session: { id: sessionID, permission: [] } as never,
          processor: {
            message: { id: "message_recommend_lineage" },
            partFromToolCall: () => undefined,
            executeTool: async (_name: string, args: unknown, options: {
              beforeRun?: (input: unknown) => Promise<unknown>
              run: (input: unknown) => Promise<unknown>
            }) => {
              const finalArgs = { ...(args as Record<string, unknown>), datasetId: "[已脱敏]", stageId: "[已脱敏]" }
              const blocked = await options.beforeRun?.(finalArgs)
              if (blocked) return blocked
              executed = finalArgs as typeof executed
              return { title: "已执行", metadata: {}, output: "完成" }
            },
          } as never,
          intent: "analysis",
        })
        const recommendationDefinition = resolved.definitions.econometrics_recommend
        expect(recommendationDefinition.descriptor?.input_schema).toMatchObject({
          type: "object",
          properties: expect.objectContaining({ dependentVar: expect.any(Object), treatmentVar: expect.any(Object) }),
        })
        expect(recommendationDefinition.descriptor?.input_schema.properties).not.toHaveProperty("datasetId")
        expect(recommendationDefinition.descriptor?.input_schema.properties).not.toHaveProperty("stageId")
        expect((recommendationDefinition.inputSchema as { jsonSchema: unknown }).jsonSchema)
          .toEqual(recommendationDefinition.descriptor?.input_schema)
        expect(recommendationDefinition.description).toContain("不适用：")
        await resolved.port.execute({
          id: "recommend-redacted-lineage",
          name: "econometrics_recommend",
          input: { datasetId: "[已脱敏]", stageId: "[已脱敏]", dependentVar: "创新指数" },
          abort: new AbortController().signal,
        })
        expect(executed).toMatchObject({ datasetId, stageId: "stage_000" })
      },
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
