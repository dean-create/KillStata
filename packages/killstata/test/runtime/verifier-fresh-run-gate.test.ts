/**
 * fresh verifier 子会话的触发门槛。
 *
 * 现场（2026-08-08 用户实测）：一晚起了 13 个 verifier 子会话、219 条消息、
 * 540 次工具调用，全部只为回答"产物文件在不在"——而这三项本地机械检查
 * （artifacts_present / row_drop_audit / panel_key_duplicates）在 buildVerifierChecks
 * 里已经有确定答案，交给模型复读没有任何增量信息。
 *
 * 门槛：只有本地检查 block（需要模型定位原因给修复建议），或阶段是 baseline_estimate
 * （回归结果是否合理本地无从判断）时，才值得起 LLM 子会话。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { AgentControl } from "@/runtime/agent-control"
import { runAutomaticVerifier } from "@/runtime/workflow"
import { mergeVerifierEnvelope, needsSemanticVerifier, parseVerifierEnvelope, withVerifierCancellationOnTimeout } from "@/runtime/workflow/rerun"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import type { StageNode, VerifierReport } from "@/runtime/types"

function report(status: VerifierReport["status"]): VerifierReport {
  return {
    status,
    checks: [],
    blockingFindings: status === "block" ? ["No saved artifacts were found for the current stage."] : [],
    repairHints: [],
    trustedArtifacts: [],
    createdAt: new Date().toISOString(),
  }
}

function stage(kind: StageNode["kind"]): StageNode {
  return { kind } as StageNode
}

describe("fresh verifier gate", () => {
  test("空内容的 pass envelope 不能冒充已核验结论", () => {
    expect(parseVerifierEnvelope('<verifier_result>{"status":"pass","checks":[],"blockingFindings":[],"repairHints":[],"trustedArtifacts":[],"summary":"核验结果与阶段记录一致","findings":[]}</verifier_result>')).toBeUndefined()
  })

  test("总体通过与内部阻断检查矛盾时不能信任估计产物", () => {
    const merged = mergeVerifierEnvelope({ ...report("pass"), trustedArtifacts: ["/tmp/estimate.json"] }, {
      status: "pass",
      checks: [{ key: "sample_loss", label: "Sample loss", status: "block", message: "样本损失无法解释。" }],
      blockingFindings: [], repairHints: [], trustedArtifacts: ["/tmp/estimate.json"],
      summary: "总体通过", findings: [], sessionID: "verifier_session", agent: "verifier",
      mode: "fresh-run", createdAt: new Date().toISOString(),
    })
    expect(merged.status).toBe("block")
    expect(merged.blockingFindings).toContain("样本损失无法解释。")
    expect(merged.trustedArtifacts).toEqual([])
  })
  test("fresh verifier 超时会先取消子会话并等待任务收敛", async () => {
    let cancelled = false
    let finish!: () => void
    const task = new Promise<void>((resolve) => {
      finish = resolve
    })

    await expect(
      withVerifierCancellationOnTimeout(
        task,
        () => {
          cancelled = true
          finish()
        },
        5,
      ),
    ).rejects.toThrow()
    expect(cancelled).toBe(true)
  })

  test("本地检查全过的数据准备阶段不值得起 LLM 子会话", () => {
    expect(needsSemanticVerifier({ report: report("pass"), stage: stage("validate") })).toBe(false)
    expect(needsSemanticVerifier({ report: report("warn"), stage: stage("validate") })).toBe(false)
    expect(needsSemanticVerifier({ report: report("pass"), stage: stage("import") })).toBe(false)
    expect(needsSemanticVerifier({ report: report("warn"), stage: stage("preprocess_or_filter") })).toBe(false)
  })

  test("本地检查 block 时必须起子会话——需要模型定位原因并给修复建议", () => {
    expect(needsSemanticVerifier({ report: report("block"), stage: stage("validate") })).toBe(true)
    expect(needsSemanticVerifier({ report: report("block"), stage: stage("import") })).toBe(true)
  })

  test("baseline_estimate 即使本地全过也要起——回归结果合理性本地判断不了", () => {
    expect(needsSemanticVerifier({ report: report("pass"), stage: stage("baseline_estimate") })).toBe(true)
  })

  test("产物齐全的 validate 走完自动校验后不产生 verifier 子会话产物", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-gate-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const good = ".killstata/datasets/d/reports/validate.json"
          fs.mkdirSync(path.dirname(path.join(root, good)), { recursive: true })
          fs.writeFileSync(path.join(root, good), "{}")

          const sessionID = "gate-no-subsession"
          const state = readWorkflowSession(sessionID)
          state.runs.push({
            workflowRunId: "wf_gate",
            sessionID,
            workflowMode: "econometrics",
            workflowLocale: "zh-CN",
            datasetId: "d",
            branch: "main",
            activeStage: "validate",
            stageSequence: [],
            edges: [],
            trustedArtifacts: [],
            stages: [
              {
                nodeId: "main:stage_000__validate",
                stageId: "stage_000__validate",
                kind: "validate",
                status: "completed",
                branch: "main",
                datasetId: "d",
                replayInput: { datasetId: "d", stageId: "stage_000" },
                metadata: { datasetId: "d", stageId: "stage_000", rowsBefore: 10, rowsAfter: 10 },
                artifactRefs: [good],
                readableArtifactRefs: [good],
                trustedArtifacts: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as never)
          state.activeRunId = "wf_gate"
          writeWorkflowSession(state)

          const verified = await runAutomaticVerifier({
            sessionID,
            stageId: "stage_000__validate",
            messageID: "m",
            agent: "general",
            model: { providerID: "p", modelID: "m" },
          } as never)

          // 产物齐全 → 本地报告不 block → 根本不该派发 verifier fork。
          // 断言 fork 决策数为 0：这是唯一不依赖"子会话能否真的跑起来"的可观测信号
          //（测试环境下子会话本就跑不起来，只断言 envelope 为空锁不住门槛）。
          expect(verified?.report.status).not.toBe("block")
          expect(AgentControl.current(sessionID).decisions).toHaveLength(0)
          expect(verified?.envelope).toBeUndefined()
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
