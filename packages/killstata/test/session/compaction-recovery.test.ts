import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "@/session/compaction"
import { Truncate } from "@/tool/truncation"
import type { CompactionSnapshot, ContextManagerSnapshot } from "@/runtime/types"
import { MessageV2 } from "@/session/message-v2"
import { Instance } from "@/project/instance"
import { writeWorkflowSession } from "@/runtime/workflow/state"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { Todo } from "@/session/todo"
import fs from "fs"
import os from "os"
import path from "path"

describe("compaction lifecycle protocol", () => {
  test("creates a stable operation identity and normalizes lifecycle fields", () => {
    const operationId = SessionCompaction.compactionOperationId("ses_1", "msg_1")
    const lifecycle = SessionCompaction.compactionLifecycle({
      operationId,
      sessionID: "ses_1",
      parentID: "msg_1",
      reason: "overflow",
      status: "started",
      inputMessageCount: -1,
      createdAt: "2026-08-20T00:00:00.000Z",
    })

    expect(operationId).toMatch(/^cmp_ses_1_msg_1_prt_/)
    expect(lifecycle).toMatchObject({
      operationId,
      sessionID: "ses_1",
      status: "started",
      inputMessageCount: 0,
      updatedAt: "2026-08-20T00:00:00.000Z",
    })
  })

  test("classifies abort separately from ordinary compaction failure", () => {
    expect(SessionCompaction.compactionFailureCode(new DOMException("stop", "AbortError"))).toBe("COMPACTION_ABORTED")
    expect(SessionCompaction.compactionFailureCode(new Error("provider failed"))).toBe("COMPACTION_FAILED")
  })

  test("压缩后恢复计量事实胶囊、任务断点和可分页证据", async () => {
    const reference = await Truncate.persist("完整工具证据")
    const context: ContextManagerSnapshot = {
      sessionID: "ses_1",
      historyVersion: 7,
      referenceContext: {
        activeTaskId: "task_1",
        activeWorkflowRunId: "workflow_1",
        activeStageId: "stage_estimate",
        latestFailureCode: "VALIDATE_BLOCKED",
        latestVerifierStatus: "warn",
        trustedArtifacts: ["artifacts/model.json"],
        inputGraphRefs: ["dataset:did", "stage:clean"],
      },
      tokenEstimate: 100,
      protectedItems: [],
      imageInputs: [],
      createdAt: new Date().toISOString(),
      capsule: {
        version: 1,
        capsuleHash: "capsule_hash",
        capturedAt: new Date().toISOString(),
        dataIdentity: { datasetId: "dataset_did", sourceFormat: "xlsx" },
        population: { scope: "analysis_sample", datasetId: "dataset_did", stageId: "stage_estimate", rowCount: 500, rowsUsed: 480 },
        qualityGate: { status: "warn", stageId: "stage_estimate", reason: "平行趋势待复核" },
        panel: { status: "declared", entityVar: "id", timeVar: "year" },
        identification: { status: "unknown", reason: "no_persisted_contract", observedSpecifications: [] },
        workflow: { workflowRunId: "workflow_1", branch: "main", activeStageKind: "baseline_estimate", latestFailureCode: "VALIDATE_BLOCKED", latestVerifierStatus: "warn", checklist: [] },
        trustedEvidence: [{ kind: "estimate", ref: "artifacts/model.json", scope: "analysis_sample" }],
        experiment: { totalAttempts: 2, stageAttempts: 1, latestMethod: "did_static", significantCount: 1 },
        sideEffectReceipts: [],
        conflicts: [],
        tokenEstimate: 100,
      },
    }
    const snapshot: CompactionSnapshot = {
      latestGoal: "估计政策效应",
      activeTodos: ["检查 stage_000 与 dataset_01234567；读取 .killstata/datasets/dataset_01234567/manifest.json"],
      unresolvedQuestions: ["确认 workflow_0123456789ab；查看 /tmp/killstata-private/result.json"],
      trustedArtifactPaths: ["artifacts/model.json"],
      childSessionSummaries: ["子 Agent 已核验平行趋势图"],
      numericGroundingState: ["verified"],
      activeTaskId: "task_1",
      latestCheckpointId: "checkpoint_7",
      activeStageId: "stage_estimate",
      latestFailureCode: "VALIDATE_BLOCKED",
      latestVerifierStatus: "warn",
      inputGraphRefs: ["dataset:did", "stage:clean"],
      latestContextSnapshot: context,
    }
    const messages = [{
      info: { id: "a1", role: "assistant" },
      parts: [{
        id: "p1",
        messageID: "a1",
        sessionID: "ses_1",
        type: "tool",
        tool: "read",
        callID: "call_1",
        state: {
          status: "completed",
          input: {},
          output: "摘要",
          outputReference: reference,
          title: "读取",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      }],
    }] as never

    const restored = SessionCompaction.buildRestorationPayload({
      snapshot,
      messages,
      userMessageLedgerReference: ".killstata/context-ledgers/ses_1/user-messages.md",
      userMessageCount: 12,
    })
    expect(restored.text).toContain("活动任务：存在一个未完成任务")
    expect(restored.text).toContain("已保存可恢复断点")
    expect(restored.text).toContain("子 Agent：子 Agent 已核验平行趋势图")
    expect(restored.text).toContain("活跃阶段类型：基准估计")
    expect(restored.text).toContain("最新失败：VALIDATE_BLOCKED")
    expect(restored.text).toContain("verifier：warn")
    expect(restored.text).toContain("数据来源：本会话已关联当前数据集（XLSX）")
    expect(restored.text).toContain("analysis_sample")
    expect(restored.text).toContain("识别契约: unknown")
    expect(restored.text).toContain("已登记 1 个可信产物")
    expect(restored.text).toContain("本会话的 12 条用户消息账本已保存")
    for (const internalValue of [
      "task_1",
      "checkpoint_7",
      "stage_estimate",
      "dataset_did",
      "workflow_1",
      "dataset:did",
      "stage:clean",
      "artifacts/model.json",
      ".killstata/context-ledgers/ses_1/user-messages.md",
      "activeStageId",
      "workflowRunId",
      "datasetId",
      "stageId",
      "stage_000",
      "dataset_01234567",
      "workflow_0123456789ab",
      ".killstata/",
      "/tmp/killstata-private/",
    ]) expect(restored.text).not.toContain(internalValue)
    expect(restored.references).toContain(reference)
    expect(restored.userMessageLedgerReference).toBe(".killstata/context-ledgers/ses_1/user-messages.md")
    expect(restored.text).toContain(reference)
    expect(restored.text).not.toContain("base64")
  })

  test("progressive compaction exposes workflow state but not internal dataset, stage, task, or file identifiers", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-progressive-context-private-"))
    try {
      await Instance.provide({ directory, fn: async () => {
        const sessionID = "session_context_private"
        const now = new Date().toISOString()
        await Todo.update({
          sessionID,
          todos: [{
            id: "todo_private",
            content: "检查 stage_000 与 dataset_01234567；读取 .killstata/datasets/dataset_01234567/manifest.json",
            status: "in_progress",
            priority: "high",
          }],
        })
        writeWorkflowSession({
          version: 1,
          sessionID,
          activeRunId: "workflow_private",
          runs: [{
            workflowRunId: "workflow_private",
            sessionID,
            workflowMode: "econometrics",
            workflowLocale: "zh-CN",
            datasetId: "dataset_private",
            runId: "run_private",
            branch: "main",
            activeNodeId: "node_private",
            activeStage: "baseline_estimate",
            stageSequence: [],
            edges: [],
            stages: [{
              nodeId: "node_private",
              stageId: "stage_private",
              kind: "baseline_estimate",
              status: "completed",
              branch: "main",
              datasetId: "dataset_private",
              artifactRefs: [".killstata/datasets/dataset_private/result.json"],
              trustedArtifacts: ["/Users/cw/private/result.json"],
              createdAt: now,
              updatedAt: now,
            }],
            trustedArtifacts: ["/Users/cw/private/result.json"],
            analysisChecklist: [],
            createdAt: now,
            updatedAt: now,
          }],
        })
        RuntimeTaskLedger.recordQueued({
          id: "task_private",
          sessionID,
          type: "prompt",
          priority: 10,
          createdAt: Date.now(),
          metadata: {
            messageID: "message_private",
            inputGraph: [{ id: "graph_private", type: "dataset", ref: "/Users/cw/private/did.xlsx" }],
          },
        })

        const result = await SessionCompaction.progressiveContext({
          sessionID,
          messages: [{
            info: { id: "message_private", sessionID, role: "assistant", parentID: "user_private" },
            parts: [{
              id: "part_private", messageID: "message_private", sessionID,
              type: "tool", tool: "pipeline", callID: "call_private",
              state: {
                status: "completed", input: {}, output: "", title: "结果查询",
                metadata: { trustedArtifactPaths: ["/Users/cw/private/result.csv"] },
                time: { start: 1, end: 2 },
              },
            }],
          } as never],
        })
        const modelSystemText = result.system.join("\n")
        expect(modelSystemText).toContain("活跃阶段类型=基准估计")
        expect(modelSystemText).toContain("可信结果产物：已登记 1 项")
        for (const internalValue of [
          "dataset_private", "stage_private", "node_private", "workflow_private", "run_private", "task_private", "message_private",
          ".killstata/", "/Users/cw/private/", "activeStageId", "datasetId", "stageId", "workflowRunId",
          "dataset_01234567",
        ]) expect(modelSystemText).not.toContain(internalValue)
      } })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("恢复载荷不截断 ContextCapsule 尾部事实", () => {
    const marker = "CAPSULE_TAIL_MARKER"
    const snapshot = {
      activeTodos: [],
      unresolvedQuestions: [],
      trustedArtifactPaths: [],
      childSessionSummaries: [],
      numericGroundingState: [],
      latestContextSnapshot: {
        sessionID: "ses_capsule",
        historyVersion: 1,
        referenceContext: { trustedArtifacts: [], inputGraphRefs: [] },
        tokenEstimate: 1,
        protectedItems: [],
        imageInputs: [],
        createdAt: new Date().toISOString(),
        capsule: {
          version: 1,
          capsuleHash: "hash",
          capturedAt: new Date().toISOString(),
          population: { scope: "unknown" },
          qualityGate: { status: "unknown" },
          panel: { status: "unknown" },
          identification: { status: "unknown", reason: "no_persisted_contract", observedSpecifications: [] },
          trustedEvidence: [],
          experiment: { totalAttempts: 0, stageAttempts: 0, significantCount: 0 },
          sideEffectReceipts: [],
          diagnosis: {
            stageId: "stage_private",
            recommendedMethodIds: [marker],
            compatibleMethodIds: [],
            blockingIssueCount: 0,
            warningIssueCount: 0,
          },
          workflow: { checklist: [] },
          conflicts: [],
          tokenEstimate: 1,
        },
      },
    }
    const restored = SessionCompaction.buildRestorationPayload({
      snapshot,
      messages: [],
    } as never)
    expect(restored.text).toContain(marker)
  })

  test("全量恢复阶段保留全部仍存活的工具输出引用", async () => {
    const refs = await Promise.all(
      Array.from({ length: 10 }, (_, index) => Truncate.persist(`证据 ${index}`)),
    )
    const messages = refs.map((reference, index) => ({
      info: { id: `a-${index}`, role: "assistant" },
      parts: [{
        id: `p-${index}`,
        messageID: `a-${index}`,
        sessionID: "ses_refs",
        type: "tool",
        tool: "read",
        callID: `call-${index}`,
        state: {
          status: "completed",
          input: {},
          output: "摘要",
          outputReference: reference,
          title: "读取",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      }],
    })) as never
    expect(SessionCompaction.recoveryReferences(messages)).toEqual(refs)
  })

  test("assistant 摘要上的 restore part 会真实进入下一轮模型上下文", () => {
    const restored = "[上下文压缩恢复状态]\n数据来源：本会话上传的工作簿\n活跃阶段类型：基准估计"
    const messages = [{
      info: {
        id: "summary_1",
        sessionID: "ses_1",
        role: "assistant",
        parentID: "user_1",
        mode: "compaction",
        agent: "compaction",
        path: { cwd: ".", root: "." },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test",
        providerID: "test",
        time: { created: 1, completed: 2 },
        summary: true,
        finish: "stop",
      },
      parts: [
        {
          id: "summary_text",
          messageID: "summary_1",
          sessionID: "ses_1",
          type: "text",
          text: "# 会话摘要\n继续估计政策效应。",
        },
        {
          id: "summary_restore",
          messageID: "summary_1",
          sessionID: "ses_1",
          type: "compaction-restore",
          summarySource: "model",
          text: restored,
          recoveryReferences: [],
        },
      ],
    }] as MessageV2.WithParts[]

    const projected = MessageV2.toModelMessages(messages, {
      id: "test",
      providerID: "test",
      capabilities: { input: {} },
    } as never)
    expect(JSON.stringify(projected)).toContain("会话摘要")
    expect(JSON.stringify(projected)).toContain("本会话上传的工作簿")
    expect(JSON.stringify(projected)).toContain("活跃阶段类型：基准估计")
    expect(JSON.stringify(projected)).not.toContain("dataset_did")
    expect(JSON.stringify(projected)).not.toContain("stage_estimate")
  })

  test("压缩边界保留触发与规模，但不把内部消息 ID 暴露给模型", () => {
    const messages = [
      {
        info: {
          id: "boundary",
          sessionID: "ses_chain",
          role: "user",
          time: { created: 1 },
          agent: "analyst",
          model: { providerID: "test", modelID: "test" },
        },
        parts: [{
          id: "boundary-part",
          messageID: "boundary",
          sessionID: "ses_chain",
          type: "compaction",
          auto: true,
          reason: "threshold",
          preCompactTokens: 187_001,
          lastMessageID: "msg_private_boundary_anchor",
        }],
      },
      {
        info: {
          id: "summary",
          sessionID: "ses_chain",
          role: "assistant",
          parentID: "boundary",
          mode: "compaction",
          agent: "analyst",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
          time: { created: 2, completed: 3 },
          summary: true,
          finish: "stop",
        },
        parts: [
          { id: "summary-text", messageID: "summary", sessionID: "ses_chain", type: "text", text: "本会话从一次上下文压缩后继续。\n当前工作：检查平行趋势。" },
          { id: "restore", messageID: "summary", sessionID: "ses_chain", type: "compaction-restore", summarySource: "model", text: "[上下文压缩恢复状态]\n数据集：did", recoveryReferences: [] },
        ],
      },
      {
        info: {
          id: "continue",
          sessionID: "ses_chain",
          role: "user",
          time: { created: 4 },
          agent: "analyst",
          model: { providerID: "test", modelID: "test" },
        },
        parts: [{ id: "continue-text", messageID: "continue", sessionID: "ses_chain", type: "text", text: "直接继续压缩前任务。", synthetic: true }],
      },
    ] as MessageV2.WithParts[]
    const projected = MessageV2.toModelMessages(messages, {
      id: "test",
      providerID: "test",
      capabilities: { input: {} },
    } as never)
    expect(projected.map((message) => message.role)).toEqual(["user", "assistant", "user"])
    const serialized = JSON.stringify(projected)
    expect(serialized).toContain("压缩边界")
    expect(serialized).toContain("187001")
    expect(serialized).not.toContain("msg_private_boundary_anchor")
    expect(serialized).toContain("上下文压缩恢复状态")
    expect(serialized).toContain("直接继续压缩前任务")
    expect(serialized).not.toContain("请基于已有上下文概括")
  })
})
