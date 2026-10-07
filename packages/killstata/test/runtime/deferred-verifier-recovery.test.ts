import { expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Identifier } from "@/id/id"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/runtime/agent-control"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { Instance } from "@/project/instance"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session-state"
import {
  deferAutomaticVerifier,
  flushDeferredAutomaticVerifiers,
  resumePendingAutomaticVerifiers,
  runVerifierGate,
} from "@/runtime/workflow/rerun"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"

async function withPendingStage(
  fn: (input: { sessionID: string; messageID: string; callID: string }) => Promise<void>,
  kind: "validate" | "baseline_estimate" = "validate",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-deferred-verifier-"))
  try {
    await Instance.provide({ directory: root, fn: async () => {
      const session = await Session.create({})
      const messageID = Identifier.ascending("message")
      const callID = "call_validate_1"
      const artifact = path.join(root, "validate.json")
      const stepOutput = kind === "baseline_estimate" ? "估计结果已生成。" : "检查结果已生成。"
      const pendingNotice = kind === "baseline_estimate"
        ? "提示：估计结果已生成，状态：待核验；核验完成前请勿将其作为最终结论。"
        : "提示：当前步骤已完成，独立核验待完成；这不表示计量估计已完成。"
      const toolName = kind === "baseline_estimate" ? "ols_regression" : "data_import"
      const toolInput = kind === "baseline_estimate" ? { methodID: "ols_regression" } : { action: "validate" }
      fs.writeFileSync(artifact, "{}")
      await Session.updateMessage({
        id: messageID, sessionID: session.id, role: "assistant", parentID: Identifier.ascending("message"),
        mode: "analyst", agent: "analyst", path: { cwd: root, root }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test", providerID: "test", time: { created: Date.now() },
      } as never)
      await Session.updatePart({
        id: Identifier.ascending("part"), messageID, sessionID: session.id, type: "tool", callID,
        tool: toolName, state: {
          status: "completed", input: toolInput, title: kind === "baseline_estimate" ? "OLS 回归" : "数据质量检查",
          output: `${stepOutput}\n\n${pendingNotice}`,
          modelOutput: `${stepOutput}\n\n${pendingNotice}`,
          metadata: { verifierPending: true }, time: { start: Date.now(), end: Date.now() },
        },
      } as never)
      const state = readWorkflowSession(session.id)
      state.activeRunId = "wf_deferred"
      state.runs.push({
        workflowRunId: "wf_deferred", sessionID: session.id, workflowMode: "econometrics", workflowLocale: "zh-CN",
        datasetId: "d", branch: "main", activeStage: "verifier", stageSequence: [], edges: [],
        trustedArtifacts: [], stages: [{
          nodeId: "main:validate_000", stageId: "validate_000", kind, status: "completed",
          branch: "main", datasetId: "d", replayInput: { datasetId: "d", stageId: "stage_000" },
          metadata: { datasetId: "d", stageId: "stage_000", rowsBefore: 10, rowsAfter: 10 },
          artifactRefs: [artifact], readableArtifactRefs: [artifact], trustedArtifacts: [],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as never)
      writeWorkflowSession(state)
      await fn({ sessionID: session.id, messageID, callID })
    } })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test("取消发生在后台派发前时，待核验任务仍落盘并可从核验阶段恢复", async () => {
  await withPendingStage(async ({ sessionID, messageID, callID }) => {
    deferAutomaticVerifier({ sessionID, stageId: "validate_000", messageID, callID })
    const aborted = new AbortController()
    aborted.abort()
    await flushDeferredAutomaticVerifiers(sessionID, messageID, aborted.signal)

    const pending = readWorkflowSession(sessionID).runs[0]!
    expect(pending.stages.find((stage) => stage.stageId === "validate_000")?.metadata?.verifierPending).toBe(true)
    expect(pending.stages.find((stage) => stage.kind === "verifier")?.status).toBe("pending")

    // 模拟重启：恢复只依据磁盘上的 workflow，不依赖原有进程内队列。
    await resumePendingAutomaticVerifiers(sessionID)
    const recovered = readWorkflowSession(sessionID).runs[0]!
    expect(recovered.stages.find((stage) => stage.kind === "verifier")?.status).toBe("completed")
    expect(recovered.stages.find((stage) => stage.stageId === "validate_000")?.metadata?.verifierPending).toBeUndefined()
    const tool = (await MessageV2.parts(messageID)).find((part) => part.type === "tool" && part.callID === callID)
    expect(tool?.type).toBe("tool")
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("expected completed tool part")
    expect(tool.state.metadata?.verifierPending).toBeUndefined()
    expect(tool.state.output).not.toContain("状态：待核验")
    expect(tool.state.output).not.toContain("当前步骤已完成，独立核验待完成")
    expect(tool.state.output).toContain("核验通过")

    await runVerifierGate({ sessionID, stageId: "validate_000", preferFreshRun: false })
    const verifiedAgain = (await MessageV2.parts(messageID)).find((part) => part.type === "tool" && part.callID === callID)
    if (verifiedAgain?.type !== "tool" || verifiedAgain.state.status !== "completed") throw new Error("expected completed tool part")
    expect(verifiedAgain.state.output.match(/独立核验通过/g)).toHaveLength(1)
  })
})

test("同一估计阶段的旧产物在新语义核验完成前不能继续留在可信集合", async () => {
  const agent = spyOn(Agent, "get").mockImplementation(async () => ({ name: "verifier", model: { providerID: "test", modelID: "test" } }) as never)
  const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({ parts: [{ type: "text", text: "格式错误" }] } as never)
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      const state = readWorkflowSession(sessionID)
      const run = state.runs[0]!
      const old = path.join(path.dirname(run.stages[0]!.artifactRefs[0]!), "old-estimate.json")
      fs.writeFileSync(old, "{}")
      run.trustedArtifacts = [old]
      run.stages[0]!.artifactRefs.push(old)
      run.stages[0]!.readableArtifactRefs?.push(old)
      writeWorkflowSession(state)

      const aborted = new AbortController()
      aborted.abort()
      await runVerifierGate({
        sessionID, stageId: "validate_000", messageID, callID,
        model: { providerID: "test", modelID: "test" }, abortSignal: aborted.signal,
      })
      const pending = readWorkflowSession(sessionID).runs[0]!
      expect(pending.trustedArtifacts).not.toContain(old)
      expect(pending.stages.find((stage) => stage.stageId === "validate_000")?.trustedArtifacts).toEqual([])
    }, "baseline_estimate")
  } finally {
    prompt.mockRestore()
    agent.mockRestore()
  }
})

test("核验派发前取消时，复用路径的旧可信引用也立即撤下", async () => {
  await withPendingStage(async ({ sessionID, messageID, callID }) => {
    const state = readWorkflowSession(sessionID)
    const run = state.runs[0]!
    const artifact = run.stages[0]!.artifactRefs[0]!
    run.trustedArtifacts = [artifact]
    writeWorkflowSession(state)

    deferAutomaticVerifier({ sessionID, workflowRunId: run.workflowRunId, branch: "main", stageId: "validate_000", messageID, callID })
    const pending = readWorkflowSession(sessionID).runs[0]!
    expect(pending.trustedArtifacts).not.toContain(artifact)
    expect(pending.stages.find((stage) => stage.stageId === "validate_000")?.trustedArtifacts).toEqual([])
  })
})

test("旧研究轮的延迟核验只更新原 workflow run，不触碰新研究轮同名阶段", async () => {
  await withPendingStage(async ({ sessionID, messageID, callID }) => {
    deferAutomaticVerifier({
      sessionID, workflowRunId: "wf_deferred", branch: "main",
      stageId: "validate_000", messageID, callID,
    } as never)
    const session = readWorkflowSession(sessionID)
    const oldRun = session.runs[0]!
    const newRun = structuredClone(oldRun)
    newRun.workflowRunId = "wf_new"
    newRun.stages = newRun.stages.filter((stage) => stage.kind !== "verifier")
    newRun.stages[0]!.metadata = { datasetId: "d", stageId: "stage_000", rowsBefore: 10, rowsAfter: 10 }
    newRun.activeStage = "validate"
    newRun.activeNodeId = newRun.stages[0]!.nodeId
    newRun.trustedArtifacts = []
    session.runs.push(newRun)
    session.activeRunId = "wf_new"
    writeWorkflowSession(session)

    await flushDeferredAutomaticVerifiers(sessionID, messageID)
    const after = readWorkflowSession(sessionID)
    expect(after.activeRunId).toBe("wf_new")
    expect(after.runs[0]?.stages.find((stage) => stage.kind === "verifier")?.status).toBe("completed")
    expect(after.runs[1]?.stages.some((stage) => stage.kind === "verifier")).toBe(false)
    expect(after.runs[1]?.trustedArtifacts).toEqual([])
  })
})

test("旧研究轮的核验异常不会把新研究轮同名阶段标为待修复", async () => {
  const decision = spyOn(AgentControl, "recordDecision").mockImplementation(() => { throw new Error("old verifier crashed") })
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      deferAutomaticVerifier({ sessionID, workflowRunId: "wf_deferred", branch: "main", stageId: "validate_000", messageID, callID })
      const session = readWorkflowSession(sessionID)
      const newRun = structuredClone(session.runs[0]!)
      newRun.workflowRunId = "wf_new"
      newRun.stages = newRun.stages.filter((stage) => stage.kind !== "verifier")
      newRun.stages[0]!.metadata = { datasetId: "d", stageId: "stage_000" }
      newRun.activeStage = "validate"
      newRun.activeNodeId = newRun.stages[0]!.nodeId
      session.runs.push(newRun)
      session.activeRunId = "wf_new"
      writeWorkflowSession(session)

      await flushDeferredAutomaticVerifiers(sessionID, messageID)
      const after = readWorkflowSession(sessionID)
      expect(after.runs[0]?.stages[0]?.metadata?.verifierFailure).toContain("核验未完成")
      expect(after.runs[1]?.stages[0]?.metadata?.verifierFailure).toBeUndefined()
      expect(after.runs[1]?.activeStage).toBe("validate")
    }, "baseline_estimate")
  } finally {
    decision.mockRestore()
  }
})

test("同一 workflow 的旧阶段核验完成不会倒退当前阶段和最新核验状态", async () => {
  await withPendingStage(async ({ sessionID, messageID, callID }) => {
    const session = readWorkflowSession(sessionID)
    const run = session.runs[0]!
    const oldStage = run.stages[0]!
    oldStage.kind = "baseline_estimate"
    oldStage.stageId = "baseline_001"
    oldStage.nodeId = "main:baseline_001"
    const currentStage = structuredClone(oldStage)
    currentStage.stageId = "baseline_002"
    currentStage.nodeId = "main:baseline_002"
    currentStage.metadata = { ...currentStage.metadata, stageId: "stage_001" }
    currentStage.replayInput = { datasetId: "d", stageId: "stage_001", methodName: "ols_regression" }
    run.stages.push(currentStage)
    run.activeNodeId = currentStage.nodeId
    run.activeStage = "verifier"
    run.lastCheckpointId = "checkpoint_current_stage"
    const currentReport = { status: "warn", checks: [], blockingFindings: [], repairHints: [], trustedArtifacts: [], createdAt: new Date().toISOString() }
    run.latestVerifier = currentReport as never
    writeWorkflowSession(session)

    deferAutomaticVerifier({ sessionID, workflowRunId: run.workflowRunId, branch: "main", stageId: oldStage.stageId, messageID, callID })
    const beforeVerify = readWorkflowSession(sessionID).runs[0]!
    const aborted = new AbortController()
    aborted.abort()
    await runVerifierGate({
      sessionID, workflowRunId: run.workflowRunId, branch: "main", stageId: oldStage.stageId,
      messageID, callID, abortSignal: aborted.signal,
    })

    const after = readWorkflowSession(sessionID).runs[0]!
    expect(beforeVerify.activeNodeId).toBe(currentStage.nodeId)
    expect(after.activeNodeId).toBe(currentStage.nodeId)
    expect(after.activeStage).toBe("verifier")
    expect(after.latestVerifier?.status).toBe("warn")
    expect(after.lastCheckpointId).toBe("checkpoint_current_stage")
    expect(after.stages.find((stage) => stage.stageId === oldStage.stageId)?.metadata?.verifierPending).toBe(true)
    expect(after.stages.find((stage) => stage.stageId === currentStage.stageId)?.metadata?.verifierPending).toBeUndefined()
  }, "baseline_estimate")
})

test("旧阶段迟到核验不会创建并提升默认恢复 checkpoint", async () => {
  const agent = spyOn(Agent, "get").mockImplementation(async () => ({ name: "verifier", model: { providerID: "test", modelID: "test" } }) as never)
  const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({ parts: [{ type: "text", text: '<verifier_result>{"status":"pass","checks":[{"key":"result_consistency","label":"结果一致性","status":"pass","message":"估计结果与阶段记录一致。"}],"blockingFindings":[],"repairHints":[],"trustedArtifacts":[],"summary":"估计结果与阶段记录一致。","findings":[]}</verifier_result>' }] } as never)
  const checkpoint = spyOn(RuntimeTaskLedger, "createCheckpoint")
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      const state = readWorkflowSession(sessionID)
      const run = state.runs[0]!
      const oldStage = run.stages[0]!
      oldStage.kind = "baseline_estimate"
      oldStage.stageId = "baseline_001"
      oldStage.nodeId = "main:baseline_001"
      const currentStage = structuredClone(oldStage)
      currentStage.stageId = "baseline_002"
      currentStage.nodeId = "main:baseline_002"
      currentStage.metadata = { ...currentStage.metadata, stageId: "stage_001" }
      currentStage.replayInput = { datasetId: "d", stageId: "stage_001", methodName: "ols_regression" }
      run.stages.push(currentStage)
      run.activeNodeId = currentStage.nodeId
      run.activeStage = "verifier"
      run.lastCheckpointId = "checkpoint_current"
      run.latestVerifier = { status: "warn", checks: [], blockingFindings: [], repairHints: [], trustedArtifacts: [], createdAt: new Date().toISOString() } as never
      writeWorkflowSession(state)

      const result = await runVerifierGate({
        sessionID, workflowRunId: run.workflowRunId, branch: "main", stageId: oldStage.stageId,
        messageID, callID, model: { providerID: "test", modelID: "test" },
      })
      expect(result.report.status).toBe("pass")
      expect(checkpoint).not.toHaveBeenCalled()
      const after = readWorkflowSession(sessionID).runs[0]!
      expect(after.lastCheckpointId).toBe("checkpoint_current")
      expect(after.latestVerifier?.status).toBe("warn")
      expect(after.activeNodeId).toBe(currentStage.nodeId)
    }, "baseline_estimate")
  } finally {
    checkpoint.mockRestore()
    prompt.mockRestore()
    agent.mockRestore()
  }
})

test("旧 workflow run 的迟到成功核验不能创建当前 task 的恢复 checkpoint", async () => {
  const agent = spyOn(Agent, "get").mockImplementation(async () => ({ name: "verifier", model: { providerID: "test", modelID: "test" } }) as never)
  const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({ parts: [{ type: "text", text: '<verifier_result>{"status":"pass","checks":[{"key":"result_consistency","label":"结果一致性","status":"pass","message":"估计结果与阶段记录一致。"}],"blockingFindings":[],"repairHints":[],"trustedArtifacts":[],"summary":"估计结果与阶段记录一致。","findings":[]}</verifier_result>' }] } as never)
  const checkpoint = spyOn(RuntimeTaskLedger, "createCheckpoint")
  const timeline = spyOn(RuntimeTaskLedger, "appendEvent")
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      const state = readWorkflowSession(sessionID)
      const oldRun = state.runs[0]!
      const oldStage = oldRun.stages[0]!
      const activeTask = RuntimeTaskLedger.recordQueued({
        id: "task_current", sessionID, type: "prompt", priority: 0, createdAt: Date.now(),
      })
      oldStage.kind = "baseline_estimate"
      oldStage.stageId = "baseline_001"
      oldStage.nodeId = "main:baseline_001"
      oldRun.activeNodeId = oldStage.nodeId
      oldRun.activeStage = "baseline_estimate"
      oldRun.lastCheckpointId = "checkpoint_old"
      oldRun.activeTaskId = activeTask.taskId

      const activeRun = structuredClone(oldRun)
      activeRun.workflowRunId = "wf_current"
      activeRun.lastCheckpointId = "checkpoint_current"
      activeRun.latestVerifier = { status: "warn", checks: [], blockingFindings: [], repairHints: [], trustedArtifacts: [], createdAt: new Date().toISOString() } as never
      state.runs.push(activeRun)
      state.activeRunId = activeRun.workflowRunId
      writeWorkflowSession(state)

      const result = await runVerifierGate({
        sessionID, workflowRunId: oldRun.workflowRunId, branch: "main", stageId: oldStage.stageId,
        messageID, callID, model: { providerID: "test", modelID: "test" },
      })

      expect(result.report.status).toBe("pass")
      expect(checkpoint).not.toHaveBeenCalled()
      const after = readWorkflowSession(sessionID)
      expect(after.activeRunId).toBe("wf_current")
      expect(after.runs.find((run) => run.workflowRunId === "wf_current")?.lastCheckpointId).toBe("checkpoint_current")
      expect(after.runs.find((run) => run.workflowRunId === "wf_current")?.latestVerifier?.status).toBe("warn")
      expect(timeline.mock.calls.some(([event]) => event.kind === "verifier" && event.workflowRunId === oldRun.workflowRunId)).toBe(false)
      const currentTask = RuntimeTaskLedger.listTasks(sessionID).tasks.find((task) => task.taskId === activeTask.taskId)
      expect(currentTask?.stageId).toBeUndefined()
      expect(currentTask?.workflowRunId).toBeUndefined()
    }, "baseline_estimate")
  } finally {
    timeline.mockRestore()
    checkpoint.mockRestore()
    prompt.mockRestore()
    agent.mockRestore()
  }
})

test("语义核验被取消时保留估计结果与待核验状态，不把本地通过误报为最终通过", async () => {
  await withPendingStage(async ({ sessionID, messageID, callID }) => {
    deferAutomaticVerifier({ sessionID, stageId: "validate_000", messageID, callID })
    const aborted = new AbortController()
    aborted.abort()
    const result = await runVerifierGate({
      sessionID, stageId: "validate_000", messageID, callID,
      abortSignal: aborted.signal, preferFreshRun: true,
    })

    expect(result.envelope).toBeUndefined()
    const run = readWorkflowSession(sessionID).runs[0]!
    expect(run.stages.find((stage) => stage.kind === "verifier")?.status).toBe("pending")
    expect(run.stages.find((stage) => stage.stageId === "validate_000")?.metadata?.verifierPending).toBe(true)
    const tool = (await MessageV2.parts(messageID)).find((part) => part.type === "tool" && part.callID === callID)
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("expected completed tool part")
    expect(tool.state.metadata?.verifierPending).toBe(true)
    expect(tool.state.metadata?.verifierFailure).toContain("核验未完成")
    expect(tool.state.output).toContain("估计结果已生成")
  }, "baseline_estimate")
})

test("已启动核验的取消只在后续自动恢复一次，重试成功后不再重复调用", async () => {
  const agent = spyOn(Agent, "get").mockImplementation(async () => ({ name: "verifier", model: { providerID: "test", modelID: "test" } }) as never)
  const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({ parts: [{ type: "text", text: '<verifier_result>{"status":"pass","checks":[{"key":"result_consistency","label":"结果一致性","status":"pass","message":"估计结果与阶段记录一致。"}],"blockingFindings":[],"repairHints":[],"trustedArtifacts":[],"summary":"估计结果与阶段记录一致。","findings":[]}</verifier_result>' }] } as never)
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      deferAutomaticVerifier({ sessionID, stageId: "validate_000", messageID, callID })
      const aborted = new AbortController()
      aborted.abort()
      await runVerifierGate({ sessionID, stageId: "validate_000", messageID, callID, model: { providerID: "test", modelID: "test" }, abortSignal: aborted.signal })
      expect(readWorkflowSession(sessionID).runs[0]?.stages.find((stage) => stage.stageId === "validate_000")?.metadata?.verifierAttempts).toBe(1)

      await resumePendingAutomaticVerifiers(sessionID)
      expect(prompt).toHaveBeenCalledTimes(1)
      const run = readWorkflowSession(sessionID).runs[0]!
      expect(run.stages.find((stage) => stage.kind === "verifier")?.status).toBe("completed")
      expect(run.stages.find((stage) => stage.stageId === "validate_000")?.metadata?.verifierAttempts).toBe(2)

      await resumePendingAutomaticVerifiers(sessionID)
      expect(prompt).toHaveBeenCalledTimes(1)
    }, "baseline_estimate")
  } finally {
    prompt.mockRestore()
    agent.mockRestore()
  }
})

test("本地质量门禁已阻断时不改写为待核验阶段", async () => {
  await withPendingStage(async ({ sessionID, messageID, callID }) => {
    const state = readWorkflowSession(sessionID)
    const run = state.runs[0]!
    run.stages[0]!.status = "blocked"
    run.stages[0]!.metadata = { ...(run.stages[0]!.metadata ?? {}), qaGateStatus: "block" }
    run.activeStage = "validate"
    run.repairOnly = true
    writeWorkflowSession(state)

    deferAutomaticVerifier({ sessionID, stageId: "validate_000", messageID, callID })
    const updated = readWorkflowSession(sessionID).runs[0]!
    expect(updated.activeStage).toBe("validate")
    expect(updated.repairOnly).toBe(true)
    expect(updated.stages.find((stage) => stage.stageId === "validate_000")?.status).toBe("blocked")
    expect(updated.stages.find((stage) => stage.stageId === "validate_000")?.metadata?.verifierPending).toBeUndefined()

    const aborted = new AbortController()
    aborted.abort()
    const checked = await runVerifierGate({ sessionID, stageId: "validate_000", abortSignal: aborted.signal })
    expect(checked.report.status).toBe("block")
    const after = readWorkflowSession(sessionID).runs[0]!
    expect(after.repairOnly).toBe(true)
    expect(after.activeStage).toBe("validate")
    const tool = (await MessageV2.parts(messageID)).find((part) => part.type === "tool" && part.callID === callID)
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("expected completed tool part")
    expect(tool.state.metadata?.verifierStatus).toBe("block")
    expect(tool.state.metadata?.verifierPending).toBeUndefined()
  })
})

test("后台核验在派发阶段抛错时留下可见、可恢复的待核验状态", async () => {
  const decision = spyOn(AgentControl, "recordDecision").mockImplementation(() => { throw new Error("synthetic verifier failure") })
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      deferAutomaticVerifier({ sessionID, stageId: "validate_000", messageID, callID })
      await flushDeferredAutomaticVerifiers(sessionID, messageID)
      const stage = readWorkflowSession(sessionID).runs[0]!.stages.find((item) => item.stageId === "validate_000")!
      expect(stage.metadata?.verifierPending).toBe(true)
      expect(stage.metadata?.verifierFailure).toContain("核验未完成")
      const tool = (await MessageV2.parts(messageID)).find((part) => part.type === "tool" && part.callID === callID)
      if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("expected completed tool part")
      expect(tool.state.metadata?.verifierPending).toBe(true)
      expect(tool.state.metadata?.verifierFailure).toContain("核验未完成")
    }, "baseline_estimate")
  } finally {
    decision.mockRestore()
  }
})

test("创建 verifier 子会话期间发生取消时，不启动子模型请求", async () => {
  const agent = spyOn(Agent, "get").mockImplementation(async () => ({ name: "verifier", model: { providerID: "test", modelID: "test" } }) as never)
  const controller = new AbortController()
  const createSession = Session.create
  let createCount = 0
  const create = spyOn(Session, "create").mockImplementation((async (input: Parameters<typeof Session.create>[0]) => {
    createCount += 1
    if (createCount === 1) return createSession(input)
    controller.abort()
    return { id: "child_cancelled" } as never
  }) as never)
  const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue(undefined as never)
  const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({ parts: [] } as never)
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      deferAutomaticVerifier({ sessionID, stageId: "validate_000", messageID, callID })
      await runVerifierGate({
        sessionID, stageId: "validate_000", messageID, callID,
        model: { providerID: "test", modelID: "test" }, abortSignal: controller.signal,
      })
      expect(create).toHaveBeenCalledTimes(2)
      expect(cancel).toHaveBeenCalledWith("child_cancelled")
      expect(prompt).not.toHaveBeenCalled()
    }, "baseline_estimate")
  } finally {
    prompt.mockRestore()
    cancel.mockRestore()
    create.mockRestore()
    agent.mockRestore()
  }
})

test("核验模型返回无效格式时保持待核验，不能以 fallback 警告冒充核验完成", async () => {
  const agent = spyOn(Agent, "get").mockImplementation(async () => ({ name: "verifier", model: { providerID: "test", modelID: "test" } }) as never)
  const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({ parts: [{ type: "text", text: "这里没有可解析的核验结果" }] } as never)
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      deferAutomaticVerifier({ sessionID, stageId: "validate_000", messageID, callID })
      const result = await runVerifierGate({
        sessionID, stageId: "validate_000", messageID, callID,
        model: { providerID: "test", modelID: "test" }, preferFreshRun: true,
      })
      expect(result.envelope).toBeUndefined()
      expect(result.pending).toBe(true)
      const run = readWorkflowSession(sessionID).runs[0]!
      expect(run.stages.find((stage) => stage.kind === "verifier")?.status).toBe("pending")
      expect(run.trustedArtifacts).toEqual([])
      expect(run.stages.find((stage) => stage.stageId === "validate_000")?.trustedArtifacts).toEqual([])
      const tool = (await MessageV2.parts(messageID)).find((part) => part.type === "tool" && part.callID === callID)
      if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("expected completed tool part")
      expect(tool.state.metadata?.verifierPending).toBe(true)
    }, "baseline_estimate")
  } finally {
    prompt.mockRestore()
    agent.mockRestore()
  }
})

test("语义核验先失败后成功时只修复核验阶段，并清除原结果的待核验提示", async () => {
  const agent = spyOn(Agent, "get").mockImplementation(async () => ({ name: "verifier", model: { providerID: "test", modelID: "test" } }) as never)
  const prompt = spyOn(SessionPrompt, "prompt")
    .mockResolvedValue({ parts: [{ type: "text", text: '<verifier_result>{"status":"pass","checks":[{"key":"result_consistency","label":"结果一致性","status":"pass","message":"估计数值与阶段记录一致。"}],"blockingFindings":[],"repairHints":[],"trustedArtifacts":[],"summary":"估计数值与阶段记录一致。","findings":[]}</verifier_result>' }] } as never)
    .mockResolvedValueOnce({ parts: [{ type: "text", text: "格式错误" }] } as never)
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      deferAutomaticVerifier({ sessionID, stageId: "validate_000", messageID, callID })
      await runVerifierGate({ sessionID, stageId: "validate_000", model: { providerID: "test", modelID: "test" } })
      expect(readWorkflowSession(sessionID).runs[0]?.stages.find((stage) => stage.kind === "verifier")?.status).toBe("pending")
      await resumePendingAutomaticVerifiers(sessionID)
      expect(prompt).toHaveBeenCalledTimes(2)
      const run = readWorkflowSession(sessionID).runs[0]!
      expect(run.stages.find((stage) => stage.kind === "verifier")?.status).toBe("completed")
      expect(run.latestVerifier?.status).toBe("pass")
      expect(run.stages.find((stage) => stage.stageId === "validate_000")?.metadata?.verifierPending).toBeUndefined()
      const tool = (await MessageV2.parts(messageID)).find((part) => part.type === "tool" && part.callID === callID)
      if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("expected completed tool part")
      expect(tool.state.metadata?.verifierPending).toBeUndefined()
      expect(tool.state.metadata?.verifierFailure).toBeUndefined()
      expect(tool.state.output).toContain("独立核验通过")
      expect(tool.state.output).not.toContain("待核验")
      await resumePendingAutomaticVerifiers(sessionID)
      expect(prompt).toHaveBeenCalledTimes(2)
    }, "baseline_estimate")
  } finally {
    prompt.mockRestore()
    agent.mockRestore()
  }
})

test("同一 workflow 阶段的并发核验请求合并成一次子会话", async () => {
  const agent = spyOn(Agent, "get").mockImplementation(async () => ({ name: "verifier", model: { providerID: "test", modelID: "test" } }) as never)
  let release!: (value: never) => void
  let entered!: () => void
  const enteredPrompt = new Promise<void>((resolve) => { entered = resolve })
  const promptResult = new Promise<never>((resolve) => { release = resolve })
  const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
    entered()
    return promptResult
  }) as never)
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      const first = runVerifierGate({ sessionID, stageId: "validate_000", messageID, callID, model: { providerID: "test", modelID: "test" } })
      await enteredPrompt
      const secondMessage = await Session.updateMessage({
        id: Identifier.ascending("message"), sessionID, role: "assistant", parentID: Identifier.ascending("message"),
        mode: "analyst", agent: "analyst", path: { cwd: process.cwd(), root: process.cwd() }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test", providerID: "test", time: { created: Date.now() },
      } as never)
      const secondCallID = "call_pipeline_verify"
      await Session.updatePart({
        id: Identifier.ascending("part"), messageID: secondMessage.id, sessionID, type: "tool", callID: secondCallID,
        tool: "pipeline", state: {
          status: "completed", input: { action: "verify" }, title: "核验", output: "待核验", modelOutput: "待核验",
          metadata: { verifierPending: true }, time: { start: Date.now(), end: Date.now() },
        },
      } as never)
      const second = runVerifierGate({ sessionID, stageId: "validate_000", messageID: secondMessage.id, callID: secondCallID, model: { providerID: "test", modelID: "test" } })
      expect(prompt).toHaveBeenCalledTimes(1)
      release({ parts: [{ type: "text", text: '<verifier_result>{"status":"pass","checks":[{"key":"result_consistency","label":"结果一致性","status":"pass","message":"估计结果与阶段记录一致。"}],"blockingFindings":[],"repairHints":[],"trustedArtifacts":[],"summary":"估计结果与阶段记录一致。","findings":[]}</verifier_result>' }] } as never)
      const [firstResult, secondResult] = await Promise.all([first, second])
      expect(firstResult.envelope?.summary).toBe("估计结果与阶段记录一致。")
      expect(secondResult.envelope?.summary).toBe("估计结果与阶段记录一致。")
      expect(prompt).toHaveBeenCalledTimes(1)
      const firstPart = (await MessageV2.parts(messageID)).find((part) => part.type === "tool" && part.callID === callID)
      if (firstPart?.type !== "tool" || firstPart.state.status !== "completed") throw new Error("expected first completed tool part")
      expect(firstPart.state.metadata?.verifierStatus).toBe("pass")
      const secondPart = (await MessageV2.parts(secondMessage.id)).find((part) => part.type === "tool" && part.callID === secondCallID)
      if (secondPart?.type !== "tool" || secondPart.state.status !== "completed") throw new Error("expected second completed tool part")
      expect(secondPart.state.metadata?.verifierStatus).toBe("pass")
    }, "baseline_estimate")
  } finally {
    prompt.mockRestore()
    agent.mockRestore()
  }
})

test("并发请求加入的独立核验可在原后台核验取消后用自己的取消信号继续", async () => {
  const agent = spyOn(Agent, "get").mockImplementation(async () => ({ name: "verifier", model: { providerID: "test", modelID: "test" } }) as never)
  let releaseFirst!: (value: never) => void
  let enteredFirst!: () => void
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve })
  let promptCount = 0
  const valid = { parts: [{ type: "text", text: '<verifier_result>{"status":"pass","checks":[{"key":"result_consistency","label":"结果一致性","status":"pass","message":"估计结果与阶段记录一致。"}],"blockingFindings":[],"repairHints":[],"trustedArtifacts":[],"summary":"估计结果与阶段记录一致。","findings":[]}</verifier_result>' }] }
  const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
    promptCount += 1
    if (promptCount === 1) {
      enteredFirst()
      return new Promise<never>((resolve) => { releaseFirst = resolve })
    }
    return valid as never
  }) as never)
  const cancel = spyOn(SessionPrompt, "cancel").mockImplementation(async () => {
    releaseFirst({ parts: [{ type: "text", text: "已取消" }] } as never)
  })
  try {
    await withPendingStage(async ({ sessionID, messageID, callID }) => {
      const oldAbort = new AbortController()
      const newAbort = new AbortController()
      const first = runVerifierGate({ sessionID, stageId: "validate_000", messageID, callID, model: { providerID: "test", modelID: "test" }, abortSignal: oldAbort.signal })
      await firstEntered
      const second = runVerifierGate({ sessionID, stageId: "validate_000", model: { providerID: "test", modelID: "test" }, abortSignal: newAbort.signal })
      oldAbort.abort()
      const [, secondResult] = await Promise.all([first, second])
      expect(secondResult.report.status).toBe("pass")
      expect(secondResult.pending).toBe(false)
      expect(promptCount).toBe(2)
    }, "baseline_estimate")
  } finally {
    cancel.mockRestore()
    prompt.mockRestore()
    agent.mockRestore()
  }
})
