import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Instance } from "@/project/instance"
import { ToolRegistry } from "@/tool/registry"
import { EconometricsExecuteInput, EconometricsExecuteTool } from "@/tool/econometrics-execute"
import { TOOL_MANIFEST } from "@/runtime/tool-manifest"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { resolveTools } from "@/session/prompt/tools"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import { appendStage, createDatasetManifest, datasetRoot, writeDatasetManifest } from "@/tool/analysis-state"
import type { DataReadinessReport } from "@/runtime/data-readiness"
import { EconometricsEngineClient } from "@/runtime/services/econometrics-engine-client"
import { analysisSpecHash } from "@/runtime/services/analysis-spec-service"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"

function seedPreparedOls(input: {
  sessionID: string
  sourceMessageId: string
  datasetId: string
  stageId: string
  stageFingerprint: string
  arguments?: Record<string, unknown>
}) {
  const taskId = `task_${input.sessionID}`
  const args = input.arguments ?? { dependentVar: "outcome", treatmentVar: "exposure", covariates: [], covariance: "HC1" }
  RuntimeTaskLedger.recordQueued({
    id: taskId,
    sessionID: input.sessionID,
    type: "prompt",
    priority: 10,
    createdAt: Date.now(),
    metadata: {
      messageID: input.sourceMessageId,
      requiredToolIDs: ["ols_regression"],
      confirmedToolIDs: ["ols_regression"],
    },
  })
  const request = RuntimeTaskLedger.recordAnalysisRequest({
    sessionID: input.sessionID,
    taskId,
    sourceMessageId: input.sourceMessageId,
    kind: "estimate",
    researchGoal: "明确指定 OLS 基准回归",
    constraints: [],
  })
  const preflight = {
    executable: true,
    status: "ready" as const,
    dataFingerprint: input.stageFingerprint,
    issues: [],
    repairPlan: [],
  }
  const schemaVersion = 2
  const registryVersion = 2
  const specHash = analysisSpecHash({
    requestId: request.requestId,
    methodID: "ols_regression",
    arguments: args,
    datasetId: input.datasetId,
    stageId: input.stageId,
    stageFingerprint: input.stageFingerprint,
    registryVersion,
    schemaVersion,
  })
  const stored = RuntimeTaskLedger.recordAnalysisSpec({
    sessionID: input.sessionID,
    taskId,
    requestId: request.requestId,
    sourceMessageId: input.sourceMessageId,
    methodID: "ols_regression",
    arguments: args,
    argumentSources: Object.fromEntries(Object.keys(args).map((field) => [field, {
      kind: "model_interpretation" as const,
      sourceMessageId: input.sourceMessageId,
    }])),
    datasetId: input.datasetId,
    stageId: input.stageId,
    stageFingerprint: input.stageFingerprint,
    registryVersion,
    schemaVersion,
    specHash,
    status: "ready",
    preflight,
  })
  if (!stored.preparedSpec) throw new Error("failed to seed PreparedSpec")
  return { taskId, requestId: request.requestId, preparedSpec: stored.preparedSpec }
}

function fakeResultArtifact(outputDir: unknown, filename = "result.json") {
  if (typeof outputDir !== "string") throw new Error("fake engine call is missing output_dir")
  fs.mkdirSync(outputDir, { recursive: true })
  const artifactPath = path.join(outputDir, filename)
  fs.writeFileSync(artifactPath, JSON.stringify({ success: true }))
  return [{ kind: "result", path: artifactPath }]
}

describe("稳定计量方法执行器", () => {
  test("以稳定工具 ID 注册，并拥有明确的模型契约", async () => {
    expect(TOOL_MANIFEST.some((entry) => entry.id === "econometrics_execute")).toBe(true)
    expect(EconometricsExecuteTool.id).toBe("econometrics_execute")
    expect(EconometricsExecuteTool.model.useWhen).toContain("analysis_prepare")

    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        expect(await ToolRegistry.byID("econometrics_execute")).toBe(EconometricsExecuteTool)
      },
    })
  })

  test("新执行契约只接受 Harness 签发的 specId，不接收 methodID 或研究参数", () => {
    expect(EconometricsExecuteInput.safeParse({ specId: "spec_demo" }).success).toBe(true)
    expect(EconometricsExecuteInput.safeParse({
      specId: "spec_demo",
      methodID: "ols_regression",
      arguments: { dependentVar: "y", treatmentVar: "x" },
    }).success).toBe(false)
    expect(EconometricsExecuteInput.safeParse({
      methodID: "ols_regression",
      arguments: { dependentVar: "y", treatmentVar: "x" },
    }).success).toBe(false)
    expect(EconometricsExecuteInput.safeParse({ specId: "spec_demo", datasetId: "forged_dataset" }).success).toBe(false)
  })

  test("已确认方法只进入延迟引用，不污染稳定 Provider 工具前缀", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const agent = await Agent.get("analyst")
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const sessionID = `session_dispatch_surface_${Date.now()}`
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_dispatch_surface",
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
            stageId: "estimate",
            kind: "baseline_estimate",
            status: "running",
            branch: "main",
            toolName: "econometrics_recommend",
            replayInput: {},
            artifactRefs: [],
            trustedArtifacts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_dispatch_surface"
        writeWorkflowSession(state)
        const resolved = await resolveTools({
          agent,
          model,
          session: { id: sessionID, permission: [] } as never,
          processor: {
            message: { id: "message_dispatch_surface" },
            partFromToolCall: () => undefined,
          } as never,
          intent: "analysis",
          confirmedToolIDs: ["ols_regression"],
        })

        expect(resolved.definitions).toHaveProperty("tool_search")
        // 方法契约通过 Python Registry 的 tool reference 进入消息历史，不回写稳定 tools 前缀
        expect(resolved.definitions).not.toHaveProperty("ols_regression")
        expect(resolved.toolPoolSnapshot().methodToolCount).toBe(1)
        // 稳定路由不内联具体方法 ID，保证固定前缀可缓存
        expect(resolved.definitions).toHaveProperty("econometrics_execute")
        const stableSchema = JSON.stringify(resolved.definitions.econometrics_execute.inputSchema)
        for (const methodID of ["ols_regression", "did_static", "panel_fe_regression", "did2s"]) {
          expect(stableSchema).not.toContain(methodID)
        }
        // 未加载的方法不得出现在工具面
        expect(resolved.definitions).not.toHaveProperty("did2s")
        const methodReference = resolved.methodReferences().find((item) => item.toolID === "ols_regression")
        expect(methodReference?.inputSchema).toMatchObject({
          type: "object",
          properties: expect.objectContaining({ dependentVar: expect.any(Object) }),
        })
        expect(methodReference?.inputSchema).not.toMatchObject({
          properties: expect.objectContaining({ datasetId: expect.anything() }),
        })
        expect(methodReference?.inputSchema).not.toMatchObject({
          properties: expect.objectContaining({ stageId: expect.anything() }),
        })
      },
    })
  })

  test("稳定路由只从 PreparedSpec 执行，完成后拒绝重放，并拒绝直接 methodID", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const agent = await Agent.get("analyst")
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const sessionID = `session_dispatch_route_${Date.now()}`
        const datasetId = `dataset_dispatch_route_${Date.now()}`
        const manifest = createDatasetManifest({
          datasetId,
          sourcePath: "/tmp/route.csv",
          sourceFormat: "csv",
        })
        const dataPath = path.join(datasetRoot(datasetId), "stages", "route.parquet")
        const dataFingerprint = `sha256:${"d".repeat(64)}`
        appendStage(manifest, {
          stageId: "stage_000",
          branch: "main",
          action: "import",
          workingPath: dataPath,
          workingFormat: "parquet",
          createdAt: new Date().toISOString(),
          metadata: {
            dataDiagnosis: {
              version: 1,
              dataset_id: datasetId,
              stage_id: "stage_000",
              data_fingerprint: dataFingerprint,
              rows: 20,
              columns: ["outcome", "exposure"],
              issues: [],
              panel_candidates: [],
              method_compatibility: [],
              recommended_method_ids: [],
            },
          },
        })
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_dispatch_route",
          sessionID,
          workflowMode: "econometrics",
          workflowLocale: "zh-CN",
          datasetId,
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
            status: "running",
            branch: "main",
            toolName: "econometrics_recommend",
            replayInput: {},
            artifactRefs: [],
            trustedArtifacts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_dispatch_route"
        writeWorkflowSession(state)

        const sourceUserMessageId = "user_message_dispatch_route"
        const taskId = "task_dispatch_route"
        const methodArguments = { dependentVar: "outcome", treatmentVar: "exposure", covariates: [], covariance: "HC1" }
        RuntimeTaskLedger.recordQueued({
          id: taskId,
          sessionID,
          type: "prompt",
          priority: 10,
          createdAt: Date.now(),
          metadata: {
            messageID: sourceUserMessageId,
            requiredToolIDs: ["ols_regression"],
            confirmedToolIDs: ["ols_regression"],
          },
        })
        const analysisRequest = RuntimeTaskLedger.recordAnalysisRequest({
          sessionID,
          taskId,
          sourceMessageId: sourceUserMessageId,
          kind: "estimate",
          researchGoal: "OLS：outcome 对 exposure",
          constraints: [],
        })
        const preflightRecord = {
          executable: true,
          status: "ready" as const,
          dataFingerprint,
          issues: [],
          repairPlan: [],
        }
        const specHash = analysisSpecHash({
          requestId: analysisRequest.requestId,
          methodID: "ols_regression",
          arguments: methodArguments,
          datasetId,
          stageId: "stage_000",
          stageFingerprint: dataFingerprint,
          registryVersion: 2,
          schemaVersion: 2,
        })
        const storedSpec = RuntimeTaskLedger.recordAnalysisSpec({
          sessionID,
          taskId,
          requestId: analysisRequest.requestId,
          sourceMessageId: sourceUserMessageId,
          methodID: "ols_regression",
          arguments: methodArguments,
          argumentSources: Object.fromEntries(Object.keys(methodArguments).map((field) => [field, {
            kind: "model_interpretation" as const,
            sourceMessageId: sourceUserMessageId,
          }])),
          datasetId,
          stageId: "stage_000",
          stageFingerprint: dataFingerprint,
          registryVersion: 2,
          schemaVersion: 2,
          specHash,
          status: "ready",
          preflight: preflightRecord,
        })
        if (!storedSpec.preparedSpec) throw new Error("test setup did not persist PreparedSpec")

        const calls: Array<{ name: string; args: unknown; deferVerification?: boolean }> = []
        const engineCalls: Array<Record<string, unknown>> = []
        const preflightCalls: Array<Record<string, unknown>> = []
        const preflightSpy = spyOn(EconometricsEngineClient.prototype, "preflight").mockImplementation(async (payload) => {
          preflightCalls.push(payload as unknown as Record<string, unknown>)
          return {
            method_id: payload.method_id,
            executable: true,
            status: "ready",
            normalized_arguments: payload.arguments,
            data_fingerprint: dataFingerprint,
            issues: [],
            repair_plan: [],
          }
        })
        const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(async (payload) => {
          engineCalls.push(payload)
          const artifacts = fakeResultArtifact(payload.output_dir)
          return {
            method_id: "ols_regression",
            schema_version: 2,
            success: true,
            payload: { method: "ols_regression", nobs: 20, coefficients: [] },
            diagnostics: {},
            artifacts,
            warnings: [],
          }
        })
        try {
          const resolved = await resolveTools({
            agent,
            model,
            session: { id: sessionID, permission: [] } as never,
            processor: {
              message: { id: "message_dispatch_route" },
              partFromToolCall: () => undefined,
              executeTool: async (name: string, args: unknown, options?: {
                deferVerification?: boolean
                beforeRun?: (input: unknown) => Promise<unknown>
                run(input: unknown): Promise<unknown>
              }) => {
                const blocked = await options?.beforeRun?.(args)
                if (blocked) return blocked
                calls.push({ name, args, deferVerification: options?.deferVerification })
                await options?.run(args)
                return { title: "已路由", output: "路由成功" }
              },
            } as never,
            intent: "analysis",
            userText: "请对 outcome 使用 OLS 回归，核心解释变量为 exposure。",
            sourceUserMessageId,
            requiredToolIDs: ["ols_regression"],
            confirmedToolIDs: ["ols_regression"],
          })

          const result = await resolved.port.execute({
            id: "route-call",
            name: "econometrics_execute",
            input: { specId: storedSpec.preparedSpec.specId },
            abort: new AbortController().signal,
          }) as { title: string; output: string }

          expect(result.title).toBe("已路由")
          expect(calls).toEqual([{
            name: "ols_regression",
            args: { ...methodArguments, datasetId, stageId: "stage_000" },
            deferVerification: true,
          }])
          expect(engineCalls).toHaveLength(1)
          expect(engineCalls[0]?.arguments).toEqual(methodArguments)
          expect(preflightCalls[0]?.data_path).toBe(dataPath)
          expect(engineCalls[0]?.data_path).toBe(dataPath)
          expect(engineCalls[0]?.output_dir).not.toBe("/tmp/model-forged-output")
          expect(preflightCalls[0]?.runtime).toEqual({})
          expect(engineCalls[0]?.runtime).toEqual({})
          expect(engineCalls[0]?.expected_data_fingerprint).toBe(dataFingerprint)

          await expect(resolved.port.execute({
            id: "direct-route-call",
            name: "ols_regression",
            input: {
              datasetId: "dataset_stale",
              stageId: "stage_stale",
              dataset_id: "dataset_snake_stale",
              stage_id: "stage_snake_stale",
              data_path: "/tmp/model-direct-forged-input.parquet",
              output_dir: "/tmp/model-direct-forged-output",
              input_path: "/tmp/model-direct-forged-input.xlsx",
              output_path: "/tmp/model-direct-forged-output.parquet",
              dependent_var: "outcome",
              independent_vars: ["exposure"],
              covariates: "",
              robust_se: true,
              confidence_level: 0.95,
            },
            abort: new AbortController().signal,
          })).rejects.toThrow(/不是本轮可直接调用的工具.*tool_search.*analysis_prepare.*econometrics_execute\(specId\)/)
          expect(engineCalls).toHaveLength(1)

          await expect(resolved.port.execute({
            id: "completed-spec-replay",
            name: "econometrics_execute",
            input: { specId: storedSpec.preparedSpec.specId },
            abort: new AbortController().signal,
          })).rejects.toThrow(/当前规格未就绪|不能开始估计/)
          expect(engineCalls).toHaveLength(1)
        } finally {
          executeSpy.mockRestore()
          preflightSpy.mockRestore()
        }
      },
    })
  })

  test("稳定路由拒绝指向受管数据根外的阶段符号链接，且不启动 Python", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-stage-route-workspace-"))
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-stage-route-external-"))
    const outsidePath = path.join(external, "private.parquet")
    try {
      fs.writeFileSync(outsidePath, "private data")
      await Instance.provide({
        directory: workspace,
        fn: async () => {
          const agent = await Agent.get("analyst")
          const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
          const sessionID = `session_stage_symlink_${Date.now()}`
          const datasetId = `dataset_stage_symlink_${Date.now()}`
          const workingPath = path.join(datasetRoot(datasetId), "stages", "stage_000.parquet")
          fs.mkdirSync(path.dirname(workingPath), { recursive: true })
          fs.symlinkSync(outsidePath, workingPath)
          const manifest = createDatasetManifest({ datasetId, sourcePath: outsidePath, sourceFormat: "csv" })
          appendStage(manifest, {
            stageId: "stage_000",
            branch: "main",
            action: "import",
            workingPath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
            metadata: {
              dataDiagnosis: {
                version: 1,
                dataset_id: datasetId,
                stage_id: "stage_000",
                data_fingerprint: `sha256:${"e".repeat(64)}`,
                rows: 20,
                columns: ["outcome", "exposure"],
                issues: [],
                panel_candidates: [],
                method_compatibility: [],
                recommended_method_ids: [],
              },
              dataReadiness: {
                version: 1,
                generatedAt: new Date().toISOString(),
                rowCount: 20,
                columnCount: 2,
                columns: ["outcome", "exposure"].map((name) => ({
                  name,
                  type: "numeric",
                  missingCount: 0,
                  uniqueCount: 20,
                  constant: false,
                })),
                panelCandidates: [],
                exactLinearDependencies: [],
                candidateMethods: [{ methodID: "ols_regression", status: "candidate", reason: "数值列", repairSuggestions: [] }],
                warnings: [],
              },
            },
          })
          const state = readWorkflowSession(sessionID)
          state.runs.push({
            workflowRunId: "workflow_stage_symlink",
            sessionID,
            workflowMode: "econometrics",
            workflowLocale: "zh-CN",
            datasetId,
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
              status: "running",
              branch: "main",
              toolName: "ols_regression",
              replayInput: {},
              artifactRefs: [],
              trustedArtifacts: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as never)
          state.activeRunId = "workflow_stage_symlink"
          writeWorkflowSession(state)
          const sourceUserMessageId = "user_message_stage_symlink"
          const prepared = seedPreparedOls({
            sessionID,
            sourceMessageId: sourceUserMessageId,
            datasetId,
            stageId: "stage_000",
            stageFingerprint: `sha256:${"e".repeat(64)}`,
          })

          const preflightSpy = spyOn(EconometricsEngineClient.prototype, "preflight").mockImplementation(async (payload) => ({
            method_id: payload.method_id,
            executable: true,
            status: "ready",
            normalized_arguments: payload.arguments,
            data_fingerprint: `sha256:${"e".repeat(64)}`,
            issues: [],
            repair_plan: [],
          }))
          try {
            const resolved = await resolveTools({
              agent,
              model,
              session: { id: sessionID, permission: [] } as never,
              processor: {
                message: { id: "message_stage_symlink" },
                partFromToolCall: () => undefined,
                executeTool: async (_name: string, args: unknown, options: {
                  beforeRun?: (input: unknown) => Promise<unknown>
                  run: (input: unknown) => Promise<unknown>
                }) => {
                  const blocked = await options.beforeRun?.(args)
                  if (blocked) return blocked
                  return options.run(args)
                },
              } as never,
              intent: "analysis",
              userText: "请对 outcome 用 OLS 回归，核心解释变量 exposure。",
              sourceUserMessageId,
              requiredToolIDs: ["ols_regression"],
              confirmedToolIDs: ["ols_regression"],
            })

            await expect(resolved.port.execute({
              id: "stage-symlink-call",
              name: "econometrics_execute",
              input: { specId: prepared.preparedSpec.specId },
              abort: new AbortController().signal,
            })).rejects.toThrow(/受管数据目录之外|受管数据路径包含符号链接/)
            expect(preflightSpy).not.toHaveBeenCalled()

            fs.unlinkSync(workingPath)
            fs.writeFileSync(workingPath, "stage data")
            const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(async (payload) => ({
              method_id: "ols_regression",
              schema_version: 2,
              success: true,
              payload: { method: "ols_regression", nobs: 20, coefficients: [] },
              diagnostics: {},
              artifacts: fakeResultArtifact(payload.output_dir),
              warnings: [],
            }))
            preflightSpy.mockImplementation(async (payload) => {
              fs.unlinkSync(workingPath)
              fs.symlinkSync(outsidePath, workingPath)
              return {
                method_id: payload.method_id,
                executable: true,
                status: "ready",
                normalized_arguments: payload.arguments,
                data_fingerprint: `sha256:${"e".repeat(64)}`,
                issues: [],
                repair_plan: [],
              }
            })
            try {
              await expect(resolved.port.execute({
                id: "stage-swap-after-preflight",
                name: "econometrics_execute",
                input: { specId: prepared.preparedSpec.specId },
                abort: new AbortController().signal,
              })).rejects.toThrow(/符号链接|路径发生变化/)
              expect(executeSpy).not.toHaveBeenCalled()
            } finally {
              executeSpy.mockRestore()
            }
          } finally {
            preflightSpy.mockRestore()
          }
        },
      })
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })

  test("直接调用具体方法没有 PreparedSpec 时会得到可恢复的稳定路由提示", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const agent = await Agent.get("analyst")
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const sessionID = `session_direct_envelope_${Date.now()}`
        const resolved = await resolveTools({
          agent,
          model,
          session: { id: sessionID, permission: [] } as never,
          processor: {
            message: { id: "message_direct_envelope" },
            partFromToolCall: () => undefined,
            executeTool: async () => ({ title: "不应执行", output: "不应执行" }),
          } as never,
          intent: "analysis",
        })

        const describe = spyOn(EconometricsEngineClient.prototype, "describe")
        try {
          await expect(resolved.port.execute({
            id: "direct-envelope-call",
            name: "ols_regression",
            input: {
              methodID: "ols_regression",
              arguments: { dependentVar: "outcome", treatmentVar: "exposure", covariates: [] },
            },
            abort: new AbortController().signal,
          })).rejects.toThrow(/不是本轮可直接调用的工具.*tool_search.*analysis_prepare.*econometrics_execute\(specId\)/)
          expect(describe).not.toHaveBeenCalled()
        } finally {
          describe.mockRestore()
        }
      },
    })
  })

  test("稳定路由没有 PreparedSpec 时拒绝执行并返回明确的规格重建停点", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const agent = await Agent.get("analyst")
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const sessionID = `session_dispatch_unloaded_${Date.now()}`
        const resolved = await resolveTools({
          agent,
          model,
          session: { id: sessionID, permission: [] } as never,
          processor: {
            message: { id: "message_dispatch_unloaded" },
            partFromToolCall: () => undefined,
            executeTool: async () => ({ title: "不应执行", output: "不应执行" }),
          } as never,
          intent: "analysis",
        })

        const result = await resolved.port.execute({
          id: "route-unloaded",
          name: "econometrics_execute",
          input: { specId: "spec_not_prepared" },
          abort: new AbortController().signal,
        }) as { metadata?: Record<string, unknown>; output?: string }
        expect(result.metadata?.requiresUserDecision).toBe(true)
        expect(result.metadata?.estimateExecuted).toBe(false)
        expect(result.output).toContain("没有对应的原始用户消息")
      },
    })
  })

  test("PreparedSpec 执行由 Python preflight 决策，不重复依赖 TS DataReadiness", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_dispatch_readiness_${Date.now()}`
        const datasetId = `dataset_dispatch_readiness_${Date.now()}`
        const manifest = createDatasetManifest({
          datasetId,
          sourcePath: path.join(datasetRoot(datasetId), "source.xlsx"),
          sourceFormat: "xlsx",
        })
        const dataColumns = ["绿色金融指数", "绿色信贷", "绿色投资", "绿色保险", "绿色债券", "绿色支持", "绿色基金", "绿色权益"]
        const readiness: DataReadinessReport = {
          version: 1,
          generatedAt: new Date().toISOString(),
          rowCount: 100,
          columnCount: dataColumns.length,
          columns: dataColumns.map((name) => ({
            name,
            type: "numeric" as const,
            missingCount: 0,
            uniqueCount: 50,
            constant: false,
          })),
          panelCandidates: [],
          exactLinearDependencies: [{
            columns: ["绿色信贷", "绿色投资", "绿色保险", "绿色债券", "绿色支持"],
            relation: "绿色信贷 = 绿色投资 + 绿色保险 + 绿色债券 + 绿色支持",
            rank: 6,
            designColumns: 7,
          }],
          candidateMethods: [{ methodID: "ols_regression", status: "candidate", reason: "数值列", repairSuggestions: [] }],
          warnings: [],
          sourceStageId: "stage_000",
        }
        const diagnosisFingerprint = `sha256:${"c".repeat(64)}`
        const dataPath = path.join(datasetRoot(datasetId), "stages", "stage_000.parquet")
        fs.mkdirSync(path.dirname(dataPath), { recursive: true })
        fs.writeFileSync(dataPath, "Python preflight mock fixture")
        appendStage(manifest, {
          stageId: "stage_000",
          branch: "main",
          action: "import",
          workingPath: dataPath,
          workingFormat: "parquet",
          createdAt: new Date().toISOString(),
          metadata: {
            dataReadiness: readiness,
            dataDiagnosis: {
              version: 1,
              dataset_id: datasetId,
              stage_id: "stage_000",
              data_fingerprint: diagnosisFingerprint,
              rows: 100,
              columns: dataColumns,
              issues: [],
              panel_candidates: [],
              method_compatibility: [],
              recommended_method_ids: [],
            },
          },
        })
        const workflowState = readWorkflowSession(sessionID)
        workflowState.runs.push({
          workflowRunId: `workflow_dispatch_readiness_${Date.now()}`,
          sessionID,
          workflowMode: "econometrics",
          workflowLocale: "zh-CN",
          datasetId,
          runId: "run_dispatch_readiness",
          branch: "main",
          activeStage: "baseline_estimate",
          activeNodeId: "main:baseline_estimate",
          stageSequence: [],
          edges: [],
          trustedArtifacts: [],
          analysisChecklist: [],
          approvalStatus: "approved",
          stages: [{
            nodeId: "main:baseline_estimate",
            stageId: "stage_000",
            kind: "baseline_estimate",
            status: "running",
            branch: "main",
            toolName: "ols_regression",
            replayInput: {},
            artifactRefs: [],
            trustedArtifacts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as never)
        workflowState.activeRunId = workflowState.runs.at(-1)!.workflowRunId
        writeWorkflowSession(workflowState)
        const sourceUserMessageId = "message_dispatch_readiness_user"
        const methodArguments = {
          dependentVar: "绿色金融指数",
          treatmentVar: "绿色信贷",
          covariates: ["绿色投资", "绿色保险", "绿色债券", "绿色支持", "绿色基金", "绿色权益"],
          covariance: "HC1",
        }
        const seededSpec = seedPreparedOls({
          sessionID,
          sourceMessageId: sourceUserMessageId,
          datasetId,
          stageId: "stage_000",
          stageFingerprint: diagnosisFingerprint,
          arguments: methodArguments,
        })

        const preflightSpy = spyOn(EconometricsEngineClient.prototype, "preflight").mockImplementation(async (payload) => ({
          method_id: payload.method_id,
          executable: true,
          status: "ready",
          normalized_arguments: payload.arguments,
          data_fingerprint: diagnosisFingerprint,
          issues: [],
          repair_plan: [],
        }))
        const executeSpy = spyOn(EconometricsEngineClient.prototype, "execute").mockImplementation(async (payload) => ({
          method_id: "ols_regression",
          schema_version: 2,
          success: true,
          payload: { method: "ols_regression", rowsUsed: 100, coefficients: [] },
          diagnostics: {},
          artifacts: fakeResultArtifact(payload.output_dir),
          warnings: [],
        }))

        try {
        const agent = await Agent.get("analyst")
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const calls: string[] = []
        const resolved = await resolveTools({
          agent,
          model,
          session: { id: sessionID, permission: [] } as never,
          processor: {
            message: { id: "message_dispatch_readiness" },
            partFromToolCall: () => undefined,
            executeTool: async (name: string, args: unknown, options: {
              beforeRun?: (input: unknown) => Promise<unknown>
              run: (input: unknown) => Promise<unknown>
            }) => {
              const blocked = await options.beforeRun?.(args)
              if (blocked) return blocked
              calls.push(name)
              return options.run(args)
            },
            } as never,
            intent: "analysis",
            userText: "请执行 OLS 回归：绿色金融指数对绿色信贷，控制绿色投资、绿色保险、绿色债券、绿色支持、绿色基金、绿色权益。",
            sourceUserMessageId,
            requiredToolIDs: ["ols_regression"],
            confirmedToolIDs: ["ols_regression"],
          })

        const result = await resolved.port.execute({
          id: "route-readiness",
          name: "econometrics_execute",
          input: { specId: seededSpec.preparedSpec.specId },
          abort: new AbortController().signal,
        }) as { title: string; output: string; metadata: Record<string, unknown> }

          expect(result.metadata.requiresUserDecision).not.toBe(true)
          expect(result.metadata.method).toBe("ols_regression")
          expect(result.output).not.toContain("完全共线")
        expect(calls).toEqual(["ols_regression"])
        expect(preflightSpy).toHaveBeenCalledTimes(1)
        expect(executeSpy).toHaveBeenCalledTimes(1)

        // 独立方法名调用不能绕过 PreparedSpec stable route。
        await expect(resolved.port.execute({
          id: "direct-readiness",
          name: "ols_regression",
          input: methodArguments,
          abort: new AbortController().signal,
        })).rejects.toThrow(/不是本轮可直接调用的工具/)
        expect(calls).toEqual(["ols_regression"])
        expect(executeSpy).toHaveBeenCalledTimes(1)
        } finally {
          preflightSpy.mockRestore()
          executeSpy.mockRestore()
        }
      },
    })
  })
})
