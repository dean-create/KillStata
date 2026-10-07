import { QuestionTool } from "./question"
import { BashTool, ShellTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import z from "zod"
import { ListTool } from "./ls"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { DataImportTool } from "./data-import"
import { DataPreprocessTool } from "./data-preprocess"
import { CompositeEvaluationTool } from "./composite-evaluation"
import { HeterogeneityRunnerTool } from "./heterogeneity-runner"
import { ExperimentLogTool } from "./experiment-log"
import { PipelineTool } from "./pipeline"
import { resolveToolAvailability, workflowToolPolicy } from "@/runtime/workflow"
import type { ToolAvailabilityPolicy } from "@/runtime/types"
import { isDataMethodToolAdmitted } from "@/runtime/data-method-admission"
import { TOOL_MANIFEST } from "@/runtime/tool-manifest"
import { ToolSearchTool } from "./tool-search"
import { EconometricsExecuteTool } from "./econometrics-execute"
import { EconometricsRecommendTool } from "./auto-recommend"
import { AnalysisRequestTool } from "./analysis-request"
import { AnalysisPrepareTool } from "./analysis-prepare"
import { createEngineMethodTool } from "./engine-method-tool"

export namespace ToolRegistry {
  export type InitializedTool = Tool.Info & Awaited<ReturnType<Tool.Info["init"]>>
  const log = Log.create({ service: "tool.registry" })
  // 这些 ID 仅是历史消息/工作流的兼容索引；实际执行统一回到 Python Registry。
  // 不在这里导入任何旧 TS wrapper，避免历史回放把旧算法重新带入正常运行时。
  const registryMethodIDs = new Set(
    TOOL_MANIFEST
      .filter((entry) => entry.family === "diagnostic" || entry.family === "estimator")
      .map((entry) => entry.id),
  )

  export const state = Instance.state(async () => ({ custom: [] as Tool.Info[] }))

  export async function register(tool: Tool.Info) {
    const candidate = tool as Partial<Tool.Info>
    if (!candidate.id || !candidate.execution || !candidate.model || !Object.hasOwn(Tool.ModelNamespaceLabel, candidate.model.namespace)) {
      throw new Error("自定义工具注册失败：必须声明非空 id、execution，以及包含合法 namespace 的 model 契约。")
    }
    if (TOOL_MANIFEST.some((entry) => entry.id === candidate.id)) {
      throw new Error(`自定义工具注册失败：工具 ID“${candidate.id}”是内置或 manifest 保留 ID，禁止同名覆盖。`)
    }
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)
    const dataPreprocessTool = isDataMethodToolAdmitted("data_preprocess") ? [DataPreprocessTool] : []
    const compositeEvaluationTool = isDataMethodToolAdmitted("composite_evaluation") ? [CompositeEvaluationTool] : []
    return [
      ...(["app", "cli", "desktop"].includes(Flag.KILLSTATA_CLIENT) ? [QuestionTool] : []),
      ListTool,
      BashTool,
      ShellTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      WebFetchTool,
      TodoWriteTool,
      TodoReadTool,
      SkillTool,
      PipelineTool,
      AnalysisRequestTool,
      AnalysisPrepareTool,
      ToolSearchTool,
      EconometricsExecuteTool,
      EconometricsRecommendTool,
      DataImportTool,
      ...dataPreprocessTool,
      ...compositeEvaluationTool,
      HeterogeneityRunnerTool,
      ExperimentLogTool,
      ...custom,
    ]
  }

  export async function ids() {
    return all().then((x) => [...new Set([...x.map((t) => t.id), ...registryMethodIDs])])
  }

  /**
   * 按 ID 取内部执行实现，**不代表该工具对模型可见**。
   *
   * `tools()` 返回经过当前 stage/intent 策略过滤的 Provider 工具集；`byID()` 只供 Harness
   * 在 `econometrics_execute` 已核验 PreparedSpec 后获取通用 Python 引擎适配器，或内部
   * workflow 重放非估计工具。模型不得用这里的实现替代稳定执行协议。
   */
  export async function byID(toolID: string): Promise<Tool.Info | undefined> {
    const current = await all()
    return current.find((tool) => tool.id === toolID) ??
      (registryMethodIDs.has(toolID) ? createEngineMethodTool(toolID) : undefined)
  }

  export async function resolvePool(
    model: { providerID: string; modelID: string },
    agent?: Agent.Info,
    context?: ToolAvailabilityPolicy,
  ) {
    const registered = await all()
    const admitted = new Set(TOOL_MANIFEST.map((entry) => entry.id))
    const candidates = registered.filter((tool) => admitted.has(tool.id))
    const policy = workflowToolPolicy({
      ...context,
      sessionID: context?.sessionID,
      agent: context?.agent ?? agent?.name,
      platformCapabilities: {
        mcp: context?.platformCapabilities?.mcp ?? true,
        images: context?.platformCapabilities?.images ?? true,
        remote: context?.platformCapabilities?.remote ?? false,
      },
      modelCapabilities: {
        supportsTools: context?.modelCapabilities?.supportsTools ?? true,
        supportsImages: context?.modelCapabilities?.supportsImages ?? true,
      },
    })
    const resolution = resolveToolAvailability({ policy, toolIDs: candidates.map((tool) => tool.id) })
    // 方法在模型侧是 Python Registry 的虚拟 deferred 项，不进入 candidates 或 direct
    // implementations；这里仅保留 ID 影子，兼容旧 workflow API 和渐进式工具搜索。
    // 正式 resolveTools 不会把 deferred 列表加载进 Provider tools。
    const virtualMethodIDs = TOOL_MANIFEST
      .filter((entry) => (entry.family === "diagnostic" || entry.family === "estimator") && entry.intents.includes(policy.inputIntent ?? "analysis"))
      .map((entry) => entry.id)
    resolution.deferredToolIDs = [...new Set([...(resolution.deferredToolIDs ?? []), ...virtualMethodIDs])]
    const byID = new Map(candidates.map((tool) => [tool.id, tool]))
    const direct = (resolution.directToolIDs ?? []).flatMap((id) => byID.get(id) ?? [])
    const searchable = (resolution.deferredToolIDs ?? []).flatMap((id) => byID.get(id) ?? [])
    const loadable = new Set([...direct, ...searchable].map((tool) => tool.id))

    const load = async (toolIDs: readonly string[]): Promise<InitializedTool[]> => {
      const unique = [...new Set(toolIDs)]
      const registryMethods = new Map<string, Tool.Info>()
      for (const id of unique) {
        if (!loadable.has(id) && registryMethodIDs.has(id)) registryMethods.set(id, createEngineMethodTool(id))
      }
      const forbidden = unique.filter((id) => !loadable.has(id) && !registryMethods.has(id))
      if (forbidden.length > 0) {
        throw new Error(`工具不可通过工具搜索加载：${forbidden.join("、")}`)
      }
      return Promise.all(unique.map(async (id) => {
        const info = byID.get(id) ?? registryMethods.get(id)!
        using _ = log.time(info.id)
        return {
          id: info.id,
          model: info.model,
          execution: info.execution,
          ...(await info.init({ agent })),
        }
      })) as Promise<InitializedTool[]>
    }

    return { resolution, direct, searchable, load }
  }

  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
    context?: ToolAvailabilityPolicy,
  ): Promise<InitializedTool[]> {
    const pool = await resolvePool(model, agent, context)
    return pool.load(pool.resolution.directToolIDs ?? [])
  }
}
