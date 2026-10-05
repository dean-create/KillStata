import { expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Agent } from "@/agent/agent"
import { Instance } from "@/project/instance"
import { SessionPrompt } from "@/session/prompt"
import { executeRerunPlan } from "@/runtime/workflow/rerun"
import { PipelineTool } from "@/tool/pipeline"
import * as rerunModule from "@/runtime/workflow/rerun"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import { appendStage, createDatasetManifest, datasetRoot, writeDatasetManifest } from "@/tool/analysis-state"

test("rerun stops when the active workflow changes instead of replaying a same-ID stage from another run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-workflow-rerun-run-guard-"))
  const sessionID = "ses_rerun_run_guard"
  const executedPaths: string[] = []
  let registrySpy: { mockRestore(): void } | undefined
  try {
    await Instance.provide({ directory: root, fn: async () => {
      const timestamp = new Date().toISOString()
      const stage = (input: { stageId: string; datasetId: string; filePath: string; dependsOn?: string[] }) => ({
        nodeId: `main:${input.stageId}`,
        stageId: input.stageId,
        kind: "profile_or_schema_check" as const,
        status: "completed" as const,
        branch: "main",
        datasetId: input.datasetId,
        dependsOn: input.dependsOn ?? [],
        downstream: [],
        replayable: true,
        executionMode: "normal" as const,
        toolName: "read",
        replayInput: { filePath: input.filePath },
        artifactRefs: [],
        readableArtifactRefs: [],
        trustedArtifacts: [],
        metadata: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      const run = (workflowRunId: string, datasetId: string, stages: ReturnType<typeof stage>[]) => ({
        workflowRunId,
        sessionID,
        workflowMode: "econometrics" as const,
        workflowLocale: "zh-CN" as const,
        datasetId,
        branch: "main",
        activeStage: "profile_or_schema_check" as const,
        stageSequence: [],
        edges: [],
        stages,
        trustedArtifacts: [],
        analysisChecklist: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      })

      const state = readWorkflowSession(sessionID)
      state.activeRunId = "wf_rerun_a"
      state.runs = [
        run("wf_rerun_a", "dataset_a", [
          stage({ stageId: "stage_000", datasetId: "dataset_a", filePath: "/a/first.csv" }),
          stage({ stageId: "stage_001", datasetId: "dataset_a", filePath: "/a/next.csv", dependsOn: ["stage_000"] }),
        ]),
        run("wf_rerun_b", "dataset_b", [
          stage({ stageId: "stage_001", datasetId: "dataset_b", filePath: "/b/next.csv" }),
        ]),
      ] as never
      writeWorkflowSession(state)

      const { ToolRegistry } = await import("@/tool/registry")
      registrySpy = spyOn(ToolRegistry, "byID").mockImplementation(async (id) => id === "read" ? ({
        id: "read",
        init: async () => ({
          execute: async (args: { filePath: string }) => {
            executedPaths.push(args.filePath)
            if (executedPaths.length === 1) {
              const updated = readWorkflowSession(sessionID)
              updated.activeRunId = "wf_rerun_b"
              writeWorkflowSession(updated)
            }
            return { title: "read", output: "test content", metadata: { datasetId: "dataset_b" } }
          },
        }),
      } as never) : undefined)

      await executeRerunPlan({
        sessionID,
        stageId: "stage_000",
        ctx: {
          sessionID,
          messageID: "message_rerun_guard",
          agent: "analyst",
          abort: new AbortController().signal,
          metadata: () => undefined,
          ask: async () => undefined,
        },
      })

      expect(executedPaths).toEqual(["/a/first.csv"])
      const after = readWorkflowSession(sessionID)
      expect(after.activeRunId).toBe("wf_rerun_b")
      expect(after.runs.find((item) => item.workflowRunId === "wf_rerun_b")?.stages).toHaveLength(1)
    } })
  } finally {
    registrySpy?.mockRestore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("rerun cancellation is forwarded to the verifier and prevents a cancelled child session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-workflow-rerun-verifier-abort-"))
  const sessionID = "ses_rerun_verifier_abort"
  const agent = spyOn(Agent, "get").mockImplementation(async () => ({
    name: "verifier",
    model: { providerID: "test", modelID: "test" },
  }) as never)
  const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({ parts: [{ type: "text", text: "invalid response" }] } as never)
  try {
    await Instance.provide({ directory: root, fn: async () => {
      const timestamp = new Date().toISOString()
      const artifact = path.join(root, "estimate.json")
      fs.writeFileSync(artifact, JSON.stringify({ success: true, coefficient: 0.5 }), "utf-8")
      const state = readWorkflowSession(sessionID)
      state.activeRunId = "wf_rerun_abort"
      state.runs = [{
        workflowRunId: "wf_rerun_abort",
        sessionID,
        workflowMode: "econometrics",
        workflowLocale: "zh-CN",
        datasetId: "dataset_rerun_abort",
        branch: "main",
        activeStage: "verifier",
        stageSequence: [],
        edges: [],
        stages: [
          {
            nodeId: "main:baseline_000",
            stageId: "baseline_000",
            kind: "baseline_estimate",
            status: "completed",
            branch: "main",
            datasetId: "dataset_rerun_abort",
            replayable: true,
            executionMode: "normal",
            toolName: "ols_regression",
            replayInput: { methodName: "ols_regression", dependentVar: "y", treatmentVar: "x" },
            artifactRefs: [artifact],
            readableArtifactRefs: [artifact],
            trustedArtifacts: [],
            metadata: { rowsBefore: 10, rowsAfter: 10 },
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          {
            nodeId: "main:baseline_000__verifier",
            stageId: "baseline_000__verifier",
            kind: "verifier",
            status: "pending",
            branch: "main",
            datasetId: "dataset_rerun_abort",
            parentStageId: "baseline_000",
            replayable: true,
            executionMode: "normal",
            toolName: "pipeline",
            replayInput: { action: "verify", stageId: "baseline_000" },
            artifactRefs: [],
            trustedArtifacts: [],
            metadata: {},
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        trustedArtifacts: [],
        analysisChecklist: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      } as never]
      writeWorkflowSession(state)

      const abort = new AbortController()
      abort.abort()
      await executeRerunPlan({
        sessionID,
        stageId: "baseline_000__verifier",
        ctx: {
          sessionID,
          messageID: "message_rerun_verifier_abort",
          agent: "analyst",
          abort: abort.signal,
          metadata: () => undefined,
          ask: async () => undefined,
        },
      })

      expect(prompt).not.toHaveBeenCalled()
    } })
  } finally {
    prompt.mockRestore()
    agent.mockRestore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("rerun verifier context retains the originating workflow ID and abort signal", () => {
  const buildRerunVerifierInput = (rerunModule as unknown as {
    rerunVerifierGateInput?: (input: {
      sessionID: string
      workflowRunId: string
      stageId: string
      ctx: { messageID: string; agent: string; abort: AbortSignal }
    }) => { workflowRunId?: string; abortSignal?: AbortSignal }
  }).rerunVerifierGateInput
  expect(typeof buildRerunVerifierInput).toBe("function")
  if (!buildRerunVerifierInput) return

  const abort = new AbortController().signal
  const verifierInput = buildRerunVerifierInput({
    sessionID: "ses_rerun_verifier_identity",
    workflowRunId: "wf_origin",
    stageId: "baseline_000",
    ctx: { messageID: "message_rerun_verifier_identity", agent: "analyst", abort },
  })
  expect(verifierInput).toMatchObject({ workflowRunId: "wf_origin", abortSignal: abort })
})

test("estimate rerun handoff never loads the legacy estimator adapter", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-workflow-rerun-estimator-handoff-"))
  const sessionID = "ses_rerun_estimator_handoff"
  let registrySpy: { mockRestore(): void } | undefined
  try {
    await Instance.provide({ directory: root, fn: async () => {
      const now = new Date().toISOString()
      const sourceMessageId = "message_rerun_estimate_current"
      const taskId = "task_rerun_estimate_current"
      const priorSourceMessageId = "message_rerun_estimate_previous"
      const priorTaskId = "task_rerun_estimate_previous"
      const datasetId = "dataset_rerun_estimator_handoff"
      const dataPath = path.join(datasetRoot(datasetId), "stages", "stage_003.parquet")
      fs.mkdirSync(path.dirname(dataPath), { recursive: true })
      fs.writeFileSync(dataPath, "stage data")
      const manifest = createDatasetManifest({ datasetId, sourcePath: path.join(root, "source.csv"), sourceFormat: "csv" })
      appendStage(manifest, {
        stageId: "stage_003",
        runId: "run_previous",
        branch: "main",
        action: "import",
        workingPath: dataPath,
        workingFormat: "parquet",
        rowCount: 20,
        createdAt: now,
      })
      writeDatasetManifest(manifest)
      RuntimeTaskLedger.recordQueued({
        id: priorTaskId,
        sessionID,
        type: "prompt",
        priority: 10,
        createdAt: Date.now(),
        metadata: { messageID: priorSourceMessageId, requiredToolIDs: ["ols_regression"] },
      })
      const priorRequest = RuntimeTaskLedger.recordAnalysisRequest({
        sessionID,
        taskId: priorTaskId,
        sourceMessageId: priorSourceMessageId,
        kind: "estimate",
        researchGoal: "此前的 OLS 规格",
        constraints: [],
      })
      const stageFingerprint = `sha256:${"a".repeat(64)}`
      const priorSpec = RuntimeTaskLedger.recordAnalysisSpec({
        sessionID,
        taskId: priorTaskId,
        requestId: priorRequest.requestId,
        sourceMessageId: priorSourceMessageId,
        methodID: "ols_regression",
        arguments: {
          dependentVar: "outcome",
          treatmentVar: "exposure",
          covariates: ["income"],
          covariance: "HC1",
        },
        argumentSources: Object.fromEntries(["dependentVar", "treatmentVar", "covariates", "covariance"].map((field) => [
          field,
          { kind: "model_interpretation", sourceMessageId: priorSourceMessageId },
        ])),
        datasetId,
        stageId: "stage_003",
        stageFingerprint,
        registryVersion: 1,
        schemaVersion: 1,
        specHash: `sha256:${"b".repeat(64)}`,
        status: "ready",
        preflight: {
          executable: true,
          status: "ready",
          dataFingerprint: stageFingerprint,
          issues: [],
          repairPlan: [],
        },
      })
      if (!priorSpec.preparedSpec) throw new Error("此前的合法规格没有生成 PreparedSpec")
      RuntimeTaskLedger.recordQueued({
        id: taskId,
        sessionID,
        type: "prompt",
        priority: 10,
        createdAt: Date.now(),
        metadata: { messageID: sourceMessageId, requiredToolIDs: ["ols_regression"] },
      })
      const request = RuntimeTaskLedger.recordAnalysisRequest({
        sessionID,
        taskId,
        sourceMessageId,
        kind: "estimate",
        researchGoal: "重跑当前 OLS 估计",
        constraints: [],
      })
      const state = readWorkflowSession(sessionID)
      state.activeRunId = "workflow_rerun_estimator_handoff"
      state.runs = [{
        workflowRunId: state.activeRunId,
        sessionID,
        workflowMode: "econometrics",
        workflowLocale: "zh-CN",
        datasetId,
        runId: "run_previous",
        branch: "main",
        activeStage: "baseline_estimate",
        activeNodeId: "main:estimate_003",
        stageSequence: [],
        edges: [],
        stages: [
          {
            nodeId: "main:stage_003",
            stageId: "stage_003",
            kind: "import",
            status: "completed",
            branch: "main",
            datasetId,
            runId: "run_previous",
            replayable: true,
            executionMode: "normal",
            toolName: "data_import",
            replayInput: { action: "import", datasetId, stageId: "stage_003" },
            artifactRefs: [],
            readableArtifactRefs: [],
            trustedArtifacts: [],
            metadata: { datasetId, stageId: "stage_003" },
            createdAt: now,
            updatedAt: now,
          },
          {
            nodeId: "main:estimate_003",
            stageId: "estimate_003",
            kind: "baseline_estimate",
            status: "failed",
            branch: "main",
            datasetId,
            runId: "run_previous",
            replayable: true,
            executionMode: "normal",
            toolName: "econometrics_execute",
            replayInput: { specId: priorSpec.preparedSpec.specId },
            artifactRefs: [],
            readableArtifactRefs: [],
            trustedArtifacts: [],
            metadata: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
        trustedArtifacts: [],
        analysisChecklist: [],
        approvalStatus: "approved",
        createdAt: now,
        updatedAt: now,
      } as never]
      writeWorkflowSession(state)

      const { ToolRegistry } = await import("@/tool/registry")
      registrySpy = spyOn(ToolRegistry, "byID").mockImplementation(async () => {
        throw new Error("legacy methodID replay must not be called")
      })
      const result = await (await PipelineTool.init()).execute({ action: "rerun", stageId: "estimate_003" }, {
          sessionID,
          messageID: "message_rerun_estimate_current",
          agent: "analyst",
          abort: new AbortController().signal,
          extra: { sourceUserMessageId: sourceMessageId },
          metadata: () => undefined,
          ask: async () => undefined,
        })

      expect(registrySpy).not.toHaveBeenCalled()
      const modelResult = JSON.parse(result.output) as Record<string, any>
      expect(modelResult.execution).toMatchObject({ status: "awaiting_prepared_spec", executedStageCount: 0, reusedStageCount: 0 })
      expect(modelResult.stableExecutionHandoff).toMatchObject({
        methodID: "ols_regression",
        arguments: {
          dependentVar: "outcome",
          treatmentVar: "exposure",
          covariates: ["income"],
          covariance: "HC1",
        },
      })
      const visibleOutput = JSON.stringify(modelResult)
      expect(visibleOutput).not.toContain("/private/")
      expect(visibleOutput).not.toContain("stage_003")
      expect(visibleOutput).not.toContain(datasetId)
      expect(visibleOutput).not.toContain("data_path")
      expect(visibleOutput).not.toContain("output_dir")
      expect(modelResult.stableExecutionHandoff).not.toHaveProperty("requestId")
      expect(modelResult.stableExecutionHandoff.message_zh).toContain("当前运行时上下文中的 requestId")
    } })
  } finally {
    registrySpy?.mockRestore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("stable estimator rerun without its historical PreparedSpec blocks before legacy lookup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-workflow-rerun-spec-handoff-"))
  const sessionID = "ses_rerun_spec_handoff"
  let registrySpy: { mockRestore(): void } | undefined
  try {
    await Instance.provide({ directory: root, fn: async () => {
      const now = new Date().toISOString()
      const sourceMessageId = "message_current_rerun_request"
      const taskId = "task_current_rerun_request"
      RuntimeTaskLedger.recordQueued({
        id: taskId,
        sessionID,
        type: "prompt",
        priority: 10,
        createdAt: Date.now(),
        metadata: { messageID: sourceMessageId, requiredToolIDs: ["ols_regression"] },
      })
      RuntimeTaskLedger.recordAnalysisRequest({
        sessionID,
        taskId,
        sourceMessageId,
        kind: "estimate",
        researchGoal: "重跑当前 OLS 估计",
        constraints: ["保留当前方法和变量"],
      })
      const state = readWorkflowSession(sessionID)
      state.activeRunId = "workflow_rerun_spec_handoff"
      state.runs = [{
        workflowRunId: state.activeRunId,
        sessionID,
        workflowMode: "econometrics",
        workflowLocale: "zh-CN",
        datasetId: "dataset_rerun_spec_handoff",
        runId: "run_previous",
        branch: "main",
        activeStage: "baseline_estimate",
        activeNodeId: "main:estimate_003",
        stageSequence: [],
        edges: [],
        stages: [
          {
            nodeId: "main:estimate_002",
            stageId: "estimate_002",
            kind: "baseline_estimate",
            status: "completed",
            branch: "main",
            datasetId: "dataset_rerun_spec_handoff",
            runId: "run_previous",
            replayable: true,
            executionMode: "normal",
            toolName: "econometrics_execute",
            replayInput: { specId: "spec_missing_from_task_ledger" },
            cacheKey: "same-historical-spec",
            artifactRefs: ["analysis/ols/results.json"],
            readableArtifactRefs: ["analysis/ols/results.json"],
            trustedArtifacts: ["analysis/ols/results.json"],
            metadata: {},
            createdAt: now,
            updatedAt: now,
          },
          {
            nodeId: "main:estimate_003",
            stageId: "estimate_003",
            kind: "baseline_estimate",
            status: "failed",
            branch: "main",
            datasetId: "dataset_rerun_spec_handoff",
            runId: "run_previous",
            replayable: true,
            executionMode: "normal",
            toolName: "econometrics_execute",
            replayInput: { specId: "spec_missing_from_task_ledger" },
            cacheKey: "same-historical-spec",
            artifactRefs: [],
            readableArtifactRefs: [],
            trustedArtifacts: [],
            metadata: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
        trustedArtifacts: [],
        analysisChecklist: [],
        approvalStatus: "approved",
        createdAt: now,
        updatedAt: now,
      } as never]
      writeWorkflowSession(state)

      const { ToolRegistry } = await import("@/tool/registry")
      registrySpy = spyOn(ToolRegistry, "byID").mockImplementation(async () => {
        throw new Error("legacy methodID replay must not be called")
      })
      const result = await executeRerunPlan({
        sessionID,
        stageId: "estimate_003",
        ctx: {
          sessionID,
          messageID: "message_current_rerun_request",
          agent: "analyst",
          abort: new AbortController().signal,
          extra: { sourceUserMessageId: sourceMessageId },
          metadata: () => undefined,
          ask: async () => undefined,
        },
      }) as Record<string, any>

      expect(registrySpy).toHaveBeenCalledTimes(0)
      expect(result.execution).toMatchObject({ status: "awaiting_user" })
      expect(result.rerunHandoff).toMatchObject({ status: "estimate_request_required" })
      expect(result.rerunHandoff.message_zh).toContain("PreparedSpec 已不在任务账本")
    } })
  } finally {
    registrySpy?.mockRestore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("stable estimator rerun handoff keeps model arguments but strips historical runtime lineage", () => {
  const project = (rerunModule as unknown as {
    stableEstimatorRerunHandoff?: (input: {
      methodID: string
      replayInput: Record<string, unknown>
    }) => Record<string, unknown>
  }).stableEstimatorRerunHandoff
  expect(project).toBeFunction()
  if (!project) return

  const handoff = project({
    methodID: "ols_regression",
    replayInput: {
      methodID: "ols_regression",
      arguments: {
        dependentVar: "outcome",
        treatmentVar: "exposure",
        covariates: ["income"],
        covariance: "HC1",
      },
      datasetId: "dataset_previous",
      stageId: "stage_003",
      runId: "run_previous",
      branch: "main",
      data_path: "/private/old.parquet",
      output_dir: "/private/old-results",
      runtime: { datasetId: "dataset_previous", stageId: "stage_003" },
    },
  })
  expect(handoff).toEqual({
    methodID: "ols_regression",
    arguments: {
      dependentVar: "outcome",
      treatmentVar: "exposure",
      covariates: ["income"],
      covariance: "HC1",
    },
  })
})
