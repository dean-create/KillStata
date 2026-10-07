import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { needsAnalysisPreparation, needsAnalysisRequestRegistration } from "@/runtime/analysis-request"
import { AnalysisRequestTool } from "@/tool/analysis-request"

async function withInstance<T>(fn: () => T | Promise<T>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-analysis-request-"))
  try {
    return await Instance.provide({ directory: root, fn })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function seedTask(sessionID: string, taskID: string, messageID: string) {
  RuntimeTaskLedger.recordQueued({
    id: taskID,
    sessionID,
    type: "prompt",
    priority: 10,
    createdAt: Date.now(),
    metadata: { messageID },
  })
}

describe("AnalysisRequest task binding", () => {
  test("estimate requests stay incomplete after spec preparation until a successful estimate or explicit stop", async () => {
    const { needsAnalysisCompletion } = await import("@/runtime/analysis-request")
    expect(needsAnalysisCompletion).toBeFunction()
    if (typeof needsAnalysisCompletion !== "function") return
    const estimateRequest = {
      version: 1 as const,
      requestId: "analysis_completion_request",
      sourceMessageId: "message_estimate",
      kind: "estimate" as const,
      researchGoal: "选择适合的基准模型并估计关系",
      constraints: [],
      registeredAt: "2026-10-03T00:00:00.000Z",
    }
    expect(needsAnalysisCompletion({
      request: estimateRequest,
      hasDecisionStop: false,
      hasSuccessfulEstimate: false,
    })).toBe(true)
    expect(needsAnalysisCompletion({
      request: estimateRequest,
      hasDecisionStop: false,
      hasSuccessfulEstimate: true,
    })).toBe(false)
    expect(needsAnalysisCompletion({
      request: estimateRequest,
      hasDecisionStop: true,
      hasSuccessfulEstimate: false,
    })).toBe(false)
    expect(needsAnalysisCompletion({
      request: { ...estimateRequest, kind: "inspect" },
      hasDecisionStop: false,
      hasSuccessfulEstimate: false,
    })).toBe(false)
  })

  test("estimate requests require a stage-bound PreparedSpec or an explicit stop; inspect requests do not", () => {
    const request = {
      version: 1 as const,
      requestId: "analysis_request_1",
      sourceMessageId: "message_user_1",
      kind: "estimate" as const,
      researchGoal: "估计 x 与 y 的关系",
      constraints: [],
      registeredAt: "2026-10-01T00:00:00.000Z",
    }
    const currentData = { datasetId: "dataset_1", stageId: "stage_000" }
    const preparedSpec = {
      version: 1 as const,
      specId: "spec_1",
      requestId: request.requestId,
      sourceMessageId: request.sourceMessageId,
      revision: 1,
      methodID: "ols_regression",
      arguments: { dependentVar: "y", treatmentVar: "x" },
      datasetId: currentData.datasetId,
      stageId: currentData.stageId,
      stageFingerprint: `sha256:${"a".repeat(64)}`,
      registryVersion: 2,
      schemaVersion: 2,
      specHash: `sha256:${"b".repeat(64)}`,
      preflight: {
        executable: true,
        status: "ready" as const,
        dataFingerprint: `sha256:${"a".repeat(64)}`,
        issues: [],
        repairPlan: [],
      },
      preparedAt: "2026-10-01T00:00:00.000Z",
    }

    expect(needsAnalysisPreparation({ request, currentData, hasDecisionStop: false, hasSuccessfulEstimate: false })).toBe(true)
    expect(needsAnalysisPreparation({ request, preparedSpec, currentData, hasDecisionStop: false, hasSuccessfulEstimate: false })).toBe(false)
    expect(needsAnalysisPreparation({ request, preparedSpec, currentData: { ...currentData, stageId: "stage_001" }, hasDecisionStop: false, hasSuccessfulEstimate: false })).toBe(true)
    expect(needsAnalysisPreparation({ request, currentData, hasDecisionStop: true, hasSuccessfulEstimate: false })).toBe(false)
    expect(needsAnalysisPreparation({ request, currentData, hasDecisionStop: false, hasSuccessfulEstimate: true })).toBe(false)
    expect(needsAnalysisPreparation({ request: { ...request, kind: "inspect" }, currentData, hasDecisionStop: false, hasSuccessfulEstimate: false })).toBe(false)
  })

  test("tool schema accepts interpretation fields but forbids model-supplied provenance IDs", async () => {
    const tool = await AnalysisRequestTool.init()
    const valid = {
      kind: "estimate",
      researchGoal: "估计 x 与 y 的关系",
      constraints: [],
    }

    expect(tool.parameters.safeParse(valid).success).toBe(true)
    expect(tool.parameters.safeParse({ ...valid, sourceMessageId: "forged-user-message" }).success).toBe(false)
    expect(tool.parameters.safeParse({ ...valid, requestId: "forged-request" }).success).toBe(false)
  })

  test("requires registration for data attachments, but not for unrelated conversation on an old dataset", () => {
    expect(needsAnalysisRequestRegistration({
      agent: "analyst",
      intent: "conversation",
      userMessageId: "message_upload",
      hasDataAttachment: true,
      hasExplicitDataSource: false,
      hasActiveDataset: false,
    })).toBe(true)
    expect(needsAnalysisRequestRegistration({
      agent: "analyst",
      intent: "conversation",
      userMessageId: "message_smalltalk",
      hasDataAttachment: false,
      hasExplicitDataSource: false,
      hasActiveDataset: true,
    })).toBe(false)
    expect(needsAnalysisRequestRegistration({
      agent: "analyst",
      intent: "ingest",
      userMessageId: "message_import",
      hasDataAttachment: false,
      hasExplicitDataSource: true,
      hasActiveDataset: false,
    })).toBe(true)
  })

  test("persists a structured request against its exact source user message", async () => {
    await withInstance(() => {
      const sessionID = "session_analysis_request"
      const taskID = "task_analysis_request"
      seedTask(sessionID, taskID, "message_user_1")

      const registered = RuntimeTaskLedger.recordAnalysisRequest({
        sessionID,
        taskId: taskID,
        sourceMessageId: "message_user_1",
        kind: "estimate",
        researchGoal: "估计绿色信贷与绿色金融指数的关系",
        constraints: ["仅解释统计关联，不作因果解释"],
      })

      expect(registered).toMatchObject({
        version: 1,
        sourceMessageId: "message_user_1",
        kind: "estimate",
        researchGoal: "估计绿色信贷与绿色金融指数的关系",
        constraints: ["仅解释统计关联，不作因果解释"],
      })
      const ledger = RuntimeTaskLedger.listTasks(sessionID)
      expect(ledger.tasks[0]?.analysisRequest).toEqual(registered)
      expect(ledger.tasks[0]?.messageID).toBe(registered.sourceMessageId)
    })
  })

  test("repeated registration for one user message is idempotent and cannot rewrite intent", async () => {
    await withInstance(() => {
      const sessionID = "session_analysis_request_idempotent"
      const taskID = "task_analysis_request_idempotent"
      seedTask(sessionID, taskID, "message_user_2")
      const first = RuntimeTaskLedger.recordAnalysisRequest({
        sessionID,
        taskId: taskID,
        sourceMessageId: "message_user_2",
        kind: "inspect",
        researchGoal: "先检查数据结构",
        constraints: [],
      })

      const repeated = RuntimeTaskLedger.recordAnalysisRequest({
        sessionID,
        taskId: taskID,
        sourceMessageId: "message_user_2",
        kind: "estimate",
        researchGoal: "改成回归估计",
        constraints: ["由第二次工具调用提供"],
      })

      expect(repeated).toEqual(first)
      expect(RuntimeTaskLedger.listTasks(sessionID).tasks[0]?.analysisRequest).toEqual(first)
    })
  })

  test("rejects a request bound to a different user message or task", async () => {
    await withInstance(() => {
      const sessionID = "session_analysis_request_scope"
      seedTask(sessionID, "task_analysis_request_scope", "message_user_3")

      expect(() => RuntimeTaskLedger.recordAnalysisRequest({
        sessionID,
        taskId: "task_analysis_request_scope",
        sourceMessageId: "message_user_forged",
        kind: "repair",
        researchGoal: "修复数据",
        constraints: [],
      })).toThrow(/源用户消息与任务不匹配/)

      expect(() => RuntimeTaskLedger.recordAnalysisRequest({
        sessionID,
        taskId: "task_missing",
        sourceMessageId: "message_user_3",
        kind: "repair",
        researchGoal: "修复数据",
        constraints: [],
      })).toThrow(/当前任务不存在/)
    })
  })
})
