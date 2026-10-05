import { afterEach, expect, test } from "bun:test"
import { Instance } from "@/project/instance"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { HeterogeneityRunnerTool } from "@/tool/heterogeneity-runner"

afterEach(async () => {
  await Instance.disposeAll()
})

function seedRequest(sessionID: string, kind: "inspect" | "estimate") {
  const suffix = `${Date.now()}_${kind}`
  const taskId = `task_heterogeneity_${suffix}`
  const sourceUserMessageId = `message_heterogeneity_${suffix}`
  RuntimeTaskLedger.recordQueued({
    id: taskId,
    sessionID,
    type: "prompt",
    priority: 10,
    createdAt: Date.now(),
    metadata: { messageID: sourceUserMessageId },
  })
  RuntimeTaskLedger.recordAnalysisRequest({
    sessionID,
    taskId,
    sourceMessageId: sourceUserMessageId,
    kind,
    researchGoal: kind === "inspect" ? "只检查已有规格" : "执行异质性估计",
    constraints: [],
  })
  return sourceUserMessageId
}

test("heterogeneity_runner does not estimate during an inspect request", async () => {
  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const sessionID = `ses_heterogeneity_inspect_${Date.now()}`
      const sourceUserMessageId = seedRequest(sessionID, "inspect")

      const tool = await HeterogeneityRunnerTool.init()
      const result = await tool.execute({
        datasetId: "dataset_current",
        stageId: "stage_000",
        methodFamily: "fe",
        dependentVar: "outcome",
        treatmentVar: "exposure",
        entityVar: "unit",
        timeVar: "year",
        covariates: [],
        heterogeneityVars: ["group"],
      }, {
        sessionID,
        messageID: "message_heterogeneity_call",
        callID: "call_heterogeneity_inspect",
        agent: "analyst",
        abort: new AbortController().signal,
        extra: { model: {}, sourceUserMessageId },
        ask: async () => undefined,
        metadata: async () => undefined,
      } as never)
      expect(result.metadata).toMatchObject({ requiresUserDecision: true, estimateExecuted: false })
      expect(result.output).toContain("当前请求登记为“inspect”")
      expect(result.output).toContain("没有启动 Python")
    },
  })
})

test("quality-only scope blocks heterogeneity even if the model misclassified the request as estimate", async () => {
  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const sessionID = `ses_heterogeneity_quality_only_${Date.now()}`
      const sourceUserMessageId = seedRequest(sessionID, "estimate")
      const tool = await HeterogeneityRunnerTool.init()
      const result = await tool.execute({
        datasetId: "dataset_current",
        stageId: "stage_000",
        methodFamily: "fe",
        dependentVar: "outcome",
        treatmentVar: "exposure",
        entityVar: "unit",
        timeVar: "year",
        covariates: [],
        heterogeneityVars: ["group"],
      }, {
        sessionID,
        messageID: "message_heterogeneity_call",
        callID: "call_heterogeneity_quality_only",
        agent: "analyst",
        abort: new AbortController().signal,
        extra: { model: {}, sourceUserMessageId, qualityInspectionOnly: true },
        ask: async () => undefined,
        metadata: async () => undefined,
      } as never)

      expect(result.metadata).toMatchObject({ requiresUserDecision: true, estimateExecuted: false })
      expect(result.output).toContain("本轮明确只做数据质量检查")
      expect(result.output).toContain("没有启动 Python")
    },
  })
})
