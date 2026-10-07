import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { resolveTools } from "@/session/prompt/tools"
import { DEEPSEEK_DEFAULT_MODEL_ID, DEEPSEEK_PROVIDER_ID } from "@/provider/deepseek-policy"
import { readWorkflowSession, writeWorkflowSession } from "@/runtime/workflow/state"
import { ConfirmedMethods } from "@/runtime/confirmed-methods"
import { Question } from "@/question"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"

describe("工具搜索后的延迟 Schema", () => {
  test("question 确认的三项方法在下一轮全部直达，不受基础工具槽位截断", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_lazy_confirmed_${Date.now()}`
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_lazy_confirmed" },
          partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        }
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_lazy_confirmed", sessionID, workflowMode: "econometrics", workflowLocale: "zh-CN",
          branch: "main", activeStage: "baseline_estimate", activeNodeId: "main:estimate", stageSequence: [], edges: [],
          trustedArtifacts: [], analysisChecklist: [], approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate", stageId: "estimate", kind: "baseline_estimate", status: "running",
            branch: "main", toolName: "econometrics_recommend", replayInput: {}, artifactRefs: [], trustedArtifacts: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_lazy_confirmed"
        writeWorkflowSession(state)

        const confirmed = ["did2s", "did_event_study_saturated", "hdfe_regression"]
        ConfirmedMethods.add(sessionID, confirmed)
        const resolved = await resolveTools({
          agent, model, session: { id: sessionID, permission: [] } as any,
          processor: processor as any, intent: "analysis",
        }) as any

        // 方法加载后只保留 Registry 引用，不回写稳定 Provider tools 前缀
        expect(Object.keys(resolved.definitions)).not.toEqual(expect.arrayContaining(confirmed))
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).toEqual(
          expect.arrayContaining(confirmed),
        )
        expect(resolved.toolPoolSnapshot().methodToolCount).toBe(3)
        expect(resolved.toolPoolSnapshot().visibleCount).toBe(
          resolved.toolPoolSnapshot().systemToolCount + resolved.toolPoolSnapshot().methodToolCount,
        )

        const lookup = await resolved.port.execute({
          id: "search-confirmed-method",
          name: "tool_search",
          input: { query: "did2s", limit: 1 },
          abort: new AbortController().signal,
        }) as { output: string }
        expect(lookup.output).toContain("did2s")
      },
    })
  })

  test("同一任务内 question 确认方法后，刷新工具池立即在下一次模型请求可见", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_lazy_question_refresh_${Date.now()}`
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_lazy_question_refresh" },
          partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        }
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_lazy_question_refresh", sessionID, workflowMode: "econometrics", workflowLocale: "zh-CN",
          branch: "main", activeStage: "baseline_estimate", activeNodeId: "main:estimate", stageSequence: [], edges: [],
          trustedArtifacts: [], analysisChecklist: [], approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate", stageId: "estimate", kind: "baseline_estimate", status: "running",
            branch: "main", toolName: "econometrics_recommend", replayInput: {}, artifactRefs: [], trustedArtifacts: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_lazy_question_refresh"
        writeWorkflowSession(state)

        const resolved = await resolveTools({
          agent, model, session: { id: sessionID, permission: [] } as any,
          processor: processor as any, intent: "analysis",
        }) as any
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).not.toContain("did2s")

        ConfirmedMethods.add(sessionID, ["did2s"])
        await resolved.refreshToolPool()
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).toContain("did2s")
      },
    })
  })

  test("同一响应先搜索再执行时消费 pending 方法，并进入当前数据阶段门禁", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_lazy_pending_execute_${Date.now()}`
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const calls: string[] = []
        const sourceUserMessageId = "message_lazy_pending_execute"
        const taskId = "task_lazy_pending_execute"
        RuntimeTaskLedger.recordQueued({
          id: taskId,
          sessionID,
          type: "prompt",
          priority: 10,
          createdAt: Date.now(),
          metadata: { messageID: sourceUserMessageId, requiredToolIDs: ["ols_regression"] },
        })
        RuntimeTaskLedger.recordAnalysisRequest({
          sessionID,
          taskId,
          sourceMessageId: sourceUserMessageId,
          kind: "estimate",
          researchGoal: "执行 OLS 回归",
          constraints: [],
        })
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_lazy_pending_execute", sessionID, workflowMode: "econometrics", workflowLocale: "zh-CN",
          branch: "main", activeStage: "baseline_estimate", activeNodeId: "main:estimate", stageSequence: [], edges: [],
          trustedArtifacts: [], analysisChecklist: [], approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate", stageId: "estimate", kind: "baseline_estimate", status: "running",
            branch: "main", toolName: "econometrics_recommend", replayInput: {}, artifactRefs: [], trustedArtifacts: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_lazy_pending_execute"
        writeWorkflowSession(state)

        const resolved = await resolveTools({
          agent, model, session: { id: sessionID, permission: [] } as any,
          processor: {
            message: { id: "assistant_lazy_pending_execute", parentID: sourceUserMessageId },
            partFromToolCall: () => undefined,
            executeTool: async (name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => {
              if (name === "tool_search") return options.run(args)
              calls.push(`${name}:${JSON.stringify(args)}`)
              return { title: "已执行", output: "OLS 已执行" }
            },
          } as any,
          intent: "analysis",
        }) as any

        const searchResult = await resolved.port.execute({
          id: "search-before-execute", name: "tool_search", input: { query: "ols_regression", limit: 1 },
          abort: new AbortController().signal,
        }) as { metadata: { loadedToolIDs?: string[] } }
        expect(searchResult.metadata.loadedToolIDs).toContain("ols_regression")
        const execution = await resolved.port.execute({
          id: "execute-pending", name: "econometrics_execute",
          input: { specId: "spec_not_prepared" },
          abort: new AbortController().signal,
        }) as { title?: string; output?: string; metadata?: Record<string, unknown> }

        expect(execution.metadata?.requiresUserDecision).toBe(true)
        expect(execution.metadata?.estimateExecuted).toBe(false)
        expect(execution.output).toContain("规范化数据阶段")
        expect(calls).toHaveLength(0)
      },
    })
  })

  test("没有搜索命中时如实报告未找到，不把现有动态工具误报为已满", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_lazy_method_search_${Date.now()}`
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_lazy_no_match" },
          partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        }
        const resolved = await resolveTools({
          agent, model, session: { id: `session_lazy_no_match_${Date.now()}`, permission: [] } as any,
          processor: processor as any, intent: "analysis",
        }) as any
        const before = Object.keys(resolved.definitions).sort()
        const result = await resolved.port.execute({
          id: "search-no-match", name: "tool_search", input: { query: "生成音乐播放列表", limit: 1 },
          abort: new AbortController().signal,
        }) as { title: string; output: string }

        expect(result.title).toBe("未加载计量方法")
        expect(result.output).toContain("没有方法 ID 匹配")
        expect(result.output).not.toContain("工具池已满")
        await resolved.commitDeferredTools()
        expect(Object.keys(resolved.definitions).sort()).toEqual(before)
      },
    })
  })

  test("同一响应内的多次 tool_search 按顺序合并，不能覆盖前一次方法引用", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_lazy_multiple_search_${Date.now()}`
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_lazy_multiple_search" },
          partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        }
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_lazy_multiple_search", sessionID, workflowMode: "econometrics", workflowLocale: "zh-CN",
          branch: "main", activeStage: "baseline_estimate", activeNodeId: "main:estimate", stageSequence: [], edges: [],
          trustedArtifacts: [], analysisChecklist: [], approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate", stageId: "estimate", kind: "baseline_estimate", status: "running",
            branch: "main", toolName: "econometrics_recommend", replayInput: {}, artifactRefs: [], trustedArtifacts: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_lazy_multiple_search"
        writeWorkflowSession(state)

        const resolved = await resolveTools({
          agent, model, session: { id: sessionID, permission: [] } as any,
          processor: processor as any, intent: "analysis",
        }) as any
        await resolved.port.execute({
          id: "search-did-first", name: "tool_search", input: { query: "did_static", limit: 1 },
          abort: new AbortController().signal,
        })
        await resolved.port.execute({
          id: "search-ols-second", name: "tool_search", input: { query: "ols_regression", limit: 1 },
          abort: new AbortController().signal,
        })

        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).not.toContain("did_static")
        await resolved.commitDeferredTools()
        const methodIDs = resolved.methodReferences().map((item: { toolID: string }) => item.toolID)
        expect(methodIDs).toContain("did_static")
        expect(methodIDs).toContain("ols_regression")
      },
    })
  })

  test("重复搜索已加载方法时返回已可用，不误报方法窗口已满", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_lazy_duplicate_search_${Date.now()}`
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_lazy_duplicate_search" },
          partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        }
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_lazy_duplicate_search", sessionID, workflowMode: "econometrics", workflowLocale: "zh-CN",
          branch: "main", activeStage: "baseline_estimate", activeNodeId: "main:estimate", stageSequence: [], edges: [],
          trustedArtifacts: [], analysisChecklist: [], approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate", stageId: "estimate", kind: "baseline_estimate", status: "running",
            branch: "main", toolName: "econometrics_recommend", replayInput: {}, artifactRefs: [], trustedArtifacts: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_lazy_duplicate_search"
        writeWorkflowSession(state)

        const resolved = await resolveTools({
          agent, model, session: { id: sessionID, permission: [] } as any,
          processor: processor as any, intent: "analysis",
        }) as any
        await resolved.port.execute({
          id: "search-duplicate-first", name: "tool_search", input: { query: "ols_regression", limit: 1 },
          abort: new AbortController().signal,
        })
        await resolved.commitDeferredTools()
        const repeated = await resolved.port.execute({
          id: "search-duplicate-second", name: "tool_search", input: { query: "ols_regression", limit: 1 },
          abort: new AbortController().signal,
        }) as { title: string; output: string }

        expect(repeated.title).not.toBe("工具池已满")
        expect(repeated.output).toContain("ols_regression")
      },
    })
  })

  test("方法窗口尚有容量时，新搜索与已有方法共存", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_lazy_replace_${Date.now()}`
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_lazy_replace" },
          partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        }
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_lazy_replace", sessionID, workflowMode: "econometrics", workflowLocale: "zh-CN",
          branch: "main", activeStage: "baseline_estimate", activeNodeId: "main:estimate", stageSequence: [], edges: [],
          trustedArtifacts: [], analysisChecklist: [], approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate", stageId: "estimate", kind: "baseline_estimate", status: "running",
            branch: "main", toolName: "econometrics_recommend", replayInput: {}, artifactRefs: [], trustedArtifacts: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_lazy_replace"
        writeWorkflowSession(state)

        const resolved = await resolveTools({
          agent, model, session: { id: sessionID, permission: [] } as any,
          processor: processor as any, intent: "analysis",
        }) as any
        const searchResult = await resolved.port.execute({
          id: "search-did", name: "tool_search", input: { query: "did", limit: 3 },
          abort: new AbortController().signal,
        }) as { output: string }
        expect(searchResult.output).toContain("参数 Schema")
        expect(searchResult.output).toContain("dependentVar")
        expect(searchResult.output).toContain("groupVar")
        expect(searchResult.output).not.toContain("datasetId")
        expect(searchResult.output).not.toContain("stageId")
        await resolved.commitDeferredTools()
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).toContain("did_static")

        await resolved.port.execute({
          id: "search-ols", name: "tool_search", input: { query: "ols_regression", limit: 1 },
          abort: new AbortController().signal,
        })
        await resolved.commitDeferredTools()
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).toContain("ols_regression")
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).toContain("did_static")
      },
    })
  })

  test("初始十个计量方法已可见时，新搜索替换末位未确认方法而非报满", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_lazy_replace_direct_${Date.now()}`
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_lazy_replace_direct" },
          partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        }
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_lazy_replace_direct", sessionID, workflowMode: "econometrics", workflowLocale: "zh-CN",
          branch: "main", activeStage: "baseline_estimate", activeNodeId: "main:estimate", stageSequence: [], edges: [],
          trustedArtifacts: [], analysisChecklist: [], approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate", stageId: "estimate", kind: "baseline_estimate", status: "running",
            branch: "main", toolName: "econometrics_recommend", replayInput: {}, artifactRefs: [], trustedArtifacts: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_lazy_replace_direct"
        writeWorkflowSession(state)

        const preferredToolIDs = [
          "did_static", "did2s", "did_event_study_saturated", "ols_regression", "panel_fe_regression",
          "iv_2sls", "hdfe_regression", "psm_matching", "psm_ipw", "psm_regression",
        ]
        const resolved = await resolveTools({
          agent, model, session: { id: sessionID, permission: [] } as any,
          processor: processor as any, intent: "analysis", preferredToolIDs,
        }) as any
        expect(resolved.methodReferences().filter((item: { toolID: string }) => preferredToolIDs.includes(item.toolID))).toHaveLength(10)

        const searchResult = await resolved.port.execute({
          id: "search-quantile", name: "tool_search", input: { query: "quantile_regression", limit: 1 },
          abort: new AbortController().signal,
        }) as { title: string; metadata: { loadedToolIDs?: string[] } }
        expect(searchResult.title).not.toBe("工具池已满")
        expect(searchResult.metadata.loadedToolIDs).toContain("quantile_regression")
        await resolved.commitDeferredTools()

        const methodIDs = resolved.methodReferences().map((item: { toolID: string }) => item.toolID).filter((id: string) => [
          ...preferredToolIDs, "quantile_regression",
        ].includes(id))
        expect(methodIDs).toHaveLength(10)
        expect(methodIDs).toContain("quantile_regression")
        expect(methodIDs).not.toContain("psm_regression")

        await resolved.refreshToolPool()
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).toContain("quantile_regression")
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).not.toContain("psm_regression")
      },
    })
  })

  test("计量方法搜索只在提交后的下一轮可见，二次搜索替换旧动态项", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_lazy_method_search_${Date.now()}`
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_lazy" },
          partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        }
        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_lazy_method_search", sessionID, workflowMode: "econometrics", workflowLocale: "zh-CN",
          branch: "main", activeStage: "baseline_estimate", activeNodeId: "main:estimate", stageSequence: [], edges: [],
          trustedArtifacts: [], analysisChecklist: [], approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate", stageId: "estimate", kind: "baseline_estimate", status: "running",
            branch: "main", toolName: "econometrics_recommend", replayInput: {}, artifactRefs: [], trustedArtifacts: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_lazy_method_search"
        writeWorkflowSession(state)
        const resolved = await resolveTools({
          agent,
          model,
          session: { id: sessionID, permission: [] } as any,
          processor: processor as any,
          intent: "analysis",
        }) as any

        const baseIDs = Object.keys(resolved.definitions)
        expect(baseIDs).toContain("tool_search")
        expect(baseIDs).toEqual(expect.arrayContaining(["glob", "grep", "data_import", "econometrics_recommend"]))
        expect(baseIDs).not.toContain("did_static")

        await resolved.port.execute({
          id: "search-1", name: "tool_search", input: { query: "did", limit: 3 },
          abort: new AbortController().signal,
        })
        expect(Object.keys(resolved.definitions)).not.toContain("did_static")
        await expect(resolved.port.execute({
          id: "hidden-same-round", name: "did_static", input: {}, abort: new AbortController().signal,
        })).rejects.toThrow(/规范化数据阶段|econometrics_execute/)

        await resolved.commitDeferredTools()
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).toContain("did_static")
        expect(resolved.toolPoolSnapshot()).toMatchObject({
          visibleToolIDs: expect.arrayContaining(["tool_search", "did_static", "econometrics_execute"]),
        })
        expect(resolved.toolPoolSnapshot().schemaTokens).toBeGreaterThan(0)
        expect(resolved.toolPoolSnapshot().schemaTokens).toBeLessThan(25_000)

        await resolved.port.execute({
          id: "search-2", name: "tool_search", input: { query: "ols_regression", limit: 1 },
          abort: new AbortController().signal,
        })
        await resolved.commitDeferredTools()
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).toContain("ols_regression")
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).toContain("did_static")
      },
    })
  })

  test("每次搜索重新读取最新 workflow stage，允许同一用户轮从导入推进到估计", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const sessionID = `session_lazy_stage_refresh_${Date.now()}`
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_lazy_stage" },
          partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        }
        const resolved = await resolveTools({
          agent, model, session: { id: sessionID, permission: [] } as any,
          processor: processor as any, intent: "analysis",
        }) as any
        expect(resolved.deferredToolSummary().some((item: any) => item.modelNamespace === "econometrics_estimator")).toBe(true)

        const state = readWorkflowSession(sessionID)
        state.runs.push({
          workflowRunId: "workflow_lazy_stage", sessionID, workflowMode: "econometrics", workflowLocale: "zh-CN",
          branch: "main", activeStage: "baseline_estimate", activeNodeId: "main:estimate", stageSequence: [], edges: [],
          trustedArtifacts: [], analysisChecklist: [], approvalStatus: "approved",
          stages: [{
            nodeId: "main:estimate", stageId: "estimate", kind: "baseline_estimate", status: "running",
            branch: "main", toolName: "econometrics_recommend", replayInput: {}, artifactRefs: [], trustedArtifacts: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_lazy_stage"
        writeWorkflowSession(state)
        await resolved.refreshToolPool()

        await resolved.port.execute({
          id: "search-stage", name: "tool_search", input: { query: "did", limit: 3 },
          abort: new AbortController().signal,
        })
        await resolved.commitDeferredTools()
        // 搜索“DID + 平行趋势”可同时装入当前方法窗口；系统工具不占用方法预算。
        expect(resolved.methodReferences().map((item: { toolID: string }) => item.toolID)).toEqual(
          expect.arrayContaining(["did_static"]),
        )
        expect(resolved.toolPoolSnapshot().methodToolCount).toBeLessThanOrEqual(10)
        // refreshToolPool 替换 definitions 后，ToolPort 的 request allowlist 也必须同步；
        // 否则下一轮虽然看见 did_static，执行入口仍按旧集合报 unavailable。
        await expect(
          resolved.port.execute({
            id: "execute-refreshed",
            name: "econometrics_execute",
            input: { methodID: "did_static", arguments: {} },
            abort: new AbortController().signal,
          }),
        ).rejects.not.toThrow(/not available/i)
      },
    })
  })

  test("用户显式禁用的工具不会被搜索加载或从执行端绕过", async () => {
    await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_lazy_disabled" }, partFromToolCall: () => undefined,
          executeTool: async (_name: string, args: unknown, options: { run(input: unknown): Promise<unknown> }) => options.run(args),
        }
        const resolved = await resolveTools({
          agent, model, session: { id: `session_lazy_disabled_${Date.now()}`, permission: [] } as any,
          processor: processor as any, intent: "analysis", tools: { grep: false },
        }) as any

        resolved.setRequestAllowlist(["read"])
        await expect(resolved.port.execute({
          id: "request-hidden", name: "tool_search", input: { query: "文件", limit: 1 },
          abort: new AbortController().signal,
        })).rejects.toThrow(/not available/i)
        resolved.setRequestAllowlist(Object.keys(resolved.definitions))

        await resolved.port.execute({
          id: "search-disabled", name: "tool_search", input: { query: "搜索文件里的关键词", limit: 3 },
          abort: new AbortController().signal,
        })
        await resolved.commitDeferredTools()
        expect(Object.keys(resolved.definitions)).not.toContain("grep")
        await expect(resolved.port.execute({
          id: "execute-disabled", name: "grep", input: { pattern: "secret" }, abort: new AbortController().signal,
        })).rejects.toThrow(/not available/i)

        const deniedBySession = await resolveTools({
          agent, model,
          session: {
            id: `session_lazy_permission_${Date.now()}`,
            permission: [{ permission: "grep", pattern: "*", action: "deny" }],
          } as any,
          processor: processor as any, intent: "analysis",
        }) as any
        await deniedBySession.port.execute({
          id: "search-session-deny", name: "tool_search", input: { query: "搜索文件里的关键词", limit: 3 },
          abort: new AbortController().signal,
        })
        await deniedBySession.commitDeferredTools()
        expect(Object.keys(deniedBySession.definitions)).not.toContain("grep")
      },
    })
  })

  test("模型直接构造post时必须先获得用户确认，不能只依赖提示词", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-post-gate-"))
    try {
      await Instance.provide({
        directory,
        fn: async () => {
        const sessionID = `session_post_gate_${Date.now()}`
        const datasetId = `dataset_post_gate_${Date.now()}`
        const manifest = createDatasetManifest({ datasetId, sourcePath: path.join(directory, "source.csv"), sourceFormat: "csv" })
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
          workflowRunId: "workflow_post_gate",
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
            nodeId: "main:profile",
            stageId: "stage_000",
            kind: "profile_or_schema_check",
            status: "completed",
            branch: "main",
            toolName: "data_import",
            replayInput: {},
            artifactRefs: [],
            trustedArtifacts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as never)
        state.activeRunId = "workflow_post_gate"
        writeWorkflowSession(state)
        const model = await Provider.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_DEFAULT_MODEL_ID)
        const agent = await Agent.get("analyst")
        const processor = {
          message: { id: "message_post_gate" },
          partFromToolCall: () => undefined,
          executeTool: async () => {
            throw new Error("data_preprocess 不应在未确认时启动")
          },
        }
        const ask = spyOn(Question, "ask").mockResolvedValue([["我提供其他规则"]])
        try {
          const resolved = await resolveTools({
            agent,
            model,
            session: { id: sessionID, permission: [] } as any,
            processor: processor as any,
            intent: "analysis",
            userText: "post不存在则先构造",
          }) as any
          const result = await resolved.port.execute({
            id: "post-gate-call",
            name: "data_preprocess",
            input: {
              datasetId: "dataset_demo",
              stageId: "stage_000",
              method: "create_column",
              columns: ["year"],
              options: { operator: "gte", right_column: "time", output_column: "post" },
            },
            abort: new AbortController().signal,
          }) as { metadata: Record<string, unknown> }

          expect(ask).toHaveBeenCalledTimes(1)
          expect(result.metadata).toMatchObject({
            requiresUserDecision: true,
            policyConstructionConfirmation: true,
          })
        } finally {
          ask.mockRestore()
        }
        },
      })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
