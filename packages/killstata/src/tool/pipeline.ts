import fs from "fs"
import path from "path"
import z from "zod"
import { MCP } from "@/mcp"
import { getRuntimePythonStatus } from "@/killstata/runtime-config"
import { AgentControl } from "@/runtime/agent-control"
import { DEFAULT_EXEC_POLICY } from "@/runtime/exec-policy"
import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import { Instance } from "@/project/instance"
import { assertExternalDirectory } from "./external-directory"
import {
  buildRerunPlan,
  buildVerifierReport,
  executeRerunPlan,
  explainMcpToolForWorkflow,
  recommendedSkillBundle,
  resolveToolAvailability,
  restoreWorkflowCheckpoint,
  runVerifierGate,
  workflowTaskLedger,
  workflowArtifactList,
  canonicalDataStageForWorkflow,
  workflowStageDetails,
  workflowStatusSummary,
  workflowToolPolicy,
} from "@/runtime/workflow"
import {
  WORKFLOW_EXTERNAL_ACTIONS,
  WORKFLOW_FILESYSTEM_ACTIONS,
  WORKFLOW_KNOWN_TOOL_IDS,
  WORKFLOW_READ_ONLY_ACTIONS,
  WORKFLOW_SESSION_ACTIONS,
  workflowAction,
} from "@/runtime/tool-catalog"

const parameters = z.object({
  action: z.enum([
    "status",
    "stage",
    "artifacts",
    "doctor",
    "verify",
    "rerun_plan",
    "rerun",
    "tasks",
    "timeline",
    "restore",
    "tools",
    "skills",
    "diagnostics",
    "agent",
    "export_artifact",
  ]).describe("要执行的工作流动作；状态查询优先用 status，只有定位具体阶段时再传 stageId。"),
  stageId: z.string().optional().describe("可选的阶段 ID；必须来自 workflow status/stage 或数据工具返回，不能自行编造。"),
  artifactPath: z.string().optional().describe("export_artifact 必填：必须原样使用本工具 artifacts 返回的可信产物路径，不能自行拼接内部目录。"),
  outputPath: z.string().optional().describe("export_artifact 必填：当前项目目录中的交付文件名或路径，例如‘回归结果.csv’；不要写入工作区外。"),
})

type WorkflowToolMetadata = {
  workflowRunId?: string
  stageId?: string
  branch?: string
  artifactRefs: string[]
  verifierRequired?: boolean
  verifierPending?: boolean
  verifierReport?: ReturnType<typeof buildVerifierReport>["report"]
}

export const WORKFLOW_EXECUTION: Tool.ExecutionPolicy = {
  ...Tool.Execution.session,
  resolve(args) {
    const action = workflowAction(args)
    if (action && WORKFLOW_READ_ONLY_ACTIONS.has(action)) return Tool.Execution.readOnly
    if (action && WORKFLOW_FILESYSTEM_ACTIONS.has(action)) return Tool.Execution.managedFilesystem
    if (action && WORKFLOW_EXTERNAL_ACTIONS.has(action)) return Tool.Execution.managedExternal
    if (action && WORKFLOW_SESSION_ACTIONS.has(action)) return Tool.Execution.session
    return Tool.Execution.session
  },
}

function jsonBlock(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function metadata(input: WorkflowToolMetadata): WorkflowToolMetadata {
  return input
}

function boundedStatusText(value: string, maxChars = 320) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`
}

function boundedStatusList(values: string[], maxItems = 3) {
  return values.slice(0, maxItems).map((value) => boundedStatusText(value))
}

function modelStatusSummary(summary: ReturnType<typeof workflowStatusSummary>) {
  const run = summary.workflow
  const canonicalDataStage = run ? canonicalDataStageForWorkflow(run, summary.activeStage) : null
  return {
    sessionID: summary.sessionID,
    canonicalDataStage,
    workflowState: run
      ? {
          workflowRunId: run.workflowRunId,
          activeStage: run.activeStage,
          activeWorkflowNode: summary.activeStage
            ? {
                stageId: summary.activeStage.stageId,
                kind: summary.activeStage.kind,
                status: summary.activeStage.status,
                usage: "仅供 workflow 查询；不要把这个 ID 传给数据或计量工具",
              }
            : null,
          repairOnly: run.repairOnly,
          verifier: run.latestVerifier
            ? {
                status: run.latestVerifier.status,
                blockingFindings: boundedStatusList(run.latestVerifier.blockingFindings),
                repairHints: boundedStatusList(run.latestVerifier.repairHints),
                trustedArtifactCount: run.latestVerifier.trustedArtifacts.length,
              }
            : null,
          latestFailure: run.latestFailure
            ? {
                code: run.latestFailure.code,
                toolName: run.latestFailure.toolName,
                retryStage: run.latestFailure.retryStage,
                repairAction: boundedStatusText(run.latestFailure.repairAction),
              }
            : null,
          currentChecklistItem: summary.currentChecklistItem
            ? {
                id: summary.currentChecklistItem.id,
                label: boundedStatusText(summary.currentChecklistItem.label, 120),
                status: summary.currentChecklistItem.status,
                linkedStageId: summary.currentChecklistItem.linkedStageId,
                summary: summary.currentChecklistItem.summary
                  ? boundedStatusText(summary.currentChecklistItem.summary)
                  : undefined,
              }
            : null,
        }
      : null,
  }
}

async function registeredToolIDs() {
  try {
    const { ToolRegistry } = await import("./registry")
    return await ToolRegistry.ids()
  } catch {
    return [...WORKFLOW_KNOWN_TOOL_IDS]
  }
}

async function mcpExposure(policy: Parameters<typeof explainMcpToolForWorkflow>[0]["policy"]) {
  const mcpToolIDs = Object.keys(await MCP.tools())
  const explanations = mcpToolIDs.map((toolName) => explainMcpToolForWorkflow({ toolName, policy }))
  const exposedToolIDs = explanations.filter((item) => item.available).map((item) => item.toolID)
  const blockedToolIDs = explanations.filter((item) => !item.available).map((item) => item.toolID)
  return {
    toolCount: mcpToolIDs.length,
    exposedToolCount: exposedToolIDs.length,
    exposedToolIDs,
    blockedToolIDs,
    explanations,
  }
}

export const PipelineTool = Tool.define("pipeline", WORKFLOW_EXECUTION, ToolModel.forTool("pipeline"), async () => ({
  description:
    "查看和受控管理当前分析流水线。status/stage 查看状态与阶段，artifacts 列出可信产物，export_artifact 将 artifacts 返回的已验证结果文件复制到当前项目目录，doctor/diagnostics 检查环境，verify 执行核验门禁，rerun_plan/rerun 仅处理失败阶段，tasks/timeline 查看任务历史，restore 恢复明确 checkpoint，tools/skills 查看可用能力，agent 查看内部 Agent 控制状态。不要用状态查询代替数据或估计工具；状态未变化时不要重复调用。export_artifact 只能交付可信产物，data_import export 导出的是观测数据，不能代替回归结果。",
  parameters,
  async execute(params, ctx) {
    if (params.action === "status") {
      const summary = workflowStatusSummary(ctx.sessionID)
      const modelSummary = modelStatusSummary(summary)
      return {
        title: "Workflow Status",
        metadata: metadata({
          workflowRunId: summary.workflow?.workflowRunId,
          stageId: modelSummary.canonicalDataStage?.stageId,
          branch: summary.workflow?.branch,
          artifactRefs: summary.activeStage?.artifactRefs ?? [],
        }),
        output: jsonBlock(modelSummary),
      }
    }

    if (params.action === "stage") {
      const details = workflowStageDetails(ctx.sessionID, params.stageId)
      return {
        title: "Workflow Stage",
        metadata: metadata({
          workflowRunId: details.workflow?.workflowRunId,
          stageId: details.stage?.stageId,
          branch: details.stage?.branch ?? details.workflow?.branch,
          artifactRefs: details.stage?.artifactRefs ?? [],
        }),
        output: jsonBlock(details),
      }
    }

    if (params.action === "artifacts") {
      const artifacts = workflowArtifactList(ctx.sessionID, params.stageId)
      return {
        title: "Workflow Artifacts",
        metadata: metadata({
          workflowRunId: artifacts.workflow?.workflowRunId,
          stageId: artifacts.stage?.stageId,
          branch: artifacts.stage?.branch ?? artifacts.workflow?.branch,
          artifactRefs: artifacts.artifacts,
        }),
        // 只投影产物索引。整份 workflow 含历史数据与重放参数，会先耗尽输出预算，
        // 将末尾真正需要的结果路径截掉，甚至产生无法解析的半截 JSON。
        output: jsonBlock({
          stageId: artifacts.stage?.stageId,
          artifacts: [...new Set(artifacts.artifacts)],
          guidance: "以上是本次查询返回的准确产物路径，读取时原样使用，不要拼接或猜测目录。回归结果使用 coefficients.csv 或对应估计结果产物；data_import export 导出的是观测数据，不能代替回归结果。需要其他阶段的产物时传入该阶段 stageId 查询。",
        }),
      }
    }

    if (params.action === "export_artifact") {
      if (!params.artifactPath?.trim()) throw new Error("export_artifact 缺少 artifactPath：先调用 pipeline artifacts，再原样选择其中的可信结果路径。")
      if (!params.outputPath?.trim()) throw new Error("export_artifact 缺少 outputPath：请提供当前项目目录中的交付文件名。")
      const artifacts = workflowArtifactList(ctx.sessionID, params.stageId)
      const requested = path.normalize(params.artifactPath)
      const trusted = artifacts.artifacts.find((item) => path.normalize(item) === requested)
      if (!trusted) throw new Error("artifactPath 不是当前阶段返回的可信产物。请先查询 pipeline artifacts，并原样使用其中的路径。")
      const source = path.isAbsolute(trusted) ? path.normalize(trusted) : path.resolve(Instance.directory, trusted)
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`可信产物不存在或不是文件：${trusted}`)
      const target = path.resolve(Instance.directory, params.outputPath)
      if (target !== Instance.directory && !target.startsWith(`${Instance.directory}${path.sep}`)) {
        throw new Error("outputPath 必须位于当前项目目录内。")
      }
      await assertExternalDirectory(ctx, target)
      await ctx.ask({
        permission: "edit",
        patterns: [path.relative(Instance.worktree, target)],
        always: ["*"],
        metadata: { filepath: target, sourceArtifact: trusted },
      })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
      return {
        title: "交付分析结果",
        metadata: { artifactRefs: [target], sourceArtifact: trusted, outputPath: target, artifactType: path.basename(source) },
        output: `已将可信分析产物交付到当前项目目录：${path.relative(Instance.directory, target) || path.basename(target)}。该文件来自已完成的估计结果，未重新估计。`,
      }
    }

    if (params.action === "doctor") {
      const workflow = workflowStatusSummary(ctx.sessionID)
      const python = await getRuntimePythonStatus()
      const policy = workflowToolPolicy({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        inputIntent: ctx.extra?.inputIntent,
        platformCapabilities: {
          mcp: true,
          images: true,
          remote: false,
        },
        modelCapabilities: {
          supportsTools: true,
          supportsImages: true,
        },
      })
      const mcp = await mcpExposure(policy)
      return {
        title: "Workflow Doctor",
        metadata: metadata({
          workflowRunId: workflow.workflow?.workflowRunId,
          stageId: workflow.activeStage?.stageId,
          branch: workflow.workflow?.branch,
          artifactRefs: workflow.activeStage?.artifactRefs ?? [],
        }),
        output: jsonBlock({
          workflow,
          python,
          mcp,
        }),
      }
    }

    if (params.action === "diagnostics") {
      const workflow = workflowStatusSummary(ctx.sessionID)
      const python = await getRuntimePythonStatus()
      const policy = workflowToolPolicy({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        inputIntent: ctx.extra?.inputIntent,
        platformCapabilities: {
          mcp: true,
          images: true,
          remote: false,
        },
        modelCapabilities: {
          supportsTools: true,
          supportsImages: true,
        },
      })
      const mcp = await mcpExposure(policy)
      const registeredTools = await registeredToolIDs()
      const ledger = workflowTaskLedger(ctx.sessionID)
      const latestTask = ledger.tasks.at(-1)
      return {
        title: "Workflow Diagnostics",
        metadata: metadata({
          workflowRunId: workflow.workflow?.workflowRunId,
          stageId: workflow.activeStage?.stageId,
          branch: workflow.workflow?.branch,
          artifactRefs: workflow.activeStage?.artifactRefs ?? [],
        }),
        output: jsonBlock({
          workflow,
          python,
          tools: {
            registeredToolIDs: registeredTools,
            registeredToolCount: registeredTools.length,
          },
          mcp,
          execPolicy: {
            profile: DEFAULT_EXEC_POLICY.profile,
            networkRequiresApproval: DEFAULT_EXEC_POLICY.networkRequiresApproval,
            externalWriteRequiresApproval: DEFAULT_EXEC_POLICY.externalWriteRequiresApproval,
            latestDecision: latestTask?.policyDecisions?.at(-1),
          },
          context: {
            latestContextVersion: latestTask?.contextVersion,
            latestContextSnapshot: latestTask?.metadata?.latestContextSnapshot,
          },
          taskLedger: {
            activeTaskId: ledger.activeTaskId,
            taskCount: ledger.tasks.length,
            checkpointCount: ledger.checkpoints.length,
            latestTask,
            latestCheckpoint: ledger.checkpoints.at(-1),
          },
        }),
      }
    }

    if (params.action === "tasks") {
      const ledger = workflowTaskLedger(ctx.sessionID)
      const workflow = workflowStatusSummary(ctx.sessionID)
      return {
        title: "Runtime Tasks",
        metadata: metadata({
          workflowRunId: workflow.workflow?.workflowRunId,
          stageId: workflow.activeStage?.stageId,
          branch: workflow.workflow?.branch,
          artifactRefs: workflow.activeStage?.artifactRefs ?? [],
        }),
        output: jsonBlock({
          activeTaskId: ledger.activeTaskId,
          tasks: ledger.tasks.slice(-20),
          checkpoints: ledger.checkpoints.slice(-10),
        }),
      }
    }

    if (params.action === "timeline") {
      const ledger = workflowTaskLedger(ctx.sessionID)
      const workflow = workflowStatusSummary(ctx.sessionID)
      const events = ledger.tasks
        .flatMap((task) => task.timeline)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      return {
        title: "Runtime Timeline",
        metadata: metadata({
          workflowRunId: workflow.workflow?.workflowRunId,
          stageId: workflow.activeStage?.stageId,
          branch: workflow.workflow?.branch,
          artifactRefs: workflow.activeStage?.artifactRefs ?? [],
        }),
        output: jsonBlock({
          activeTaskId: ledger.activeTaskId,
          events: events.slice(-80),
        }),
      }
    }

    if (params.action === "restore") {
      const result = restoreWorkflowCheckpoint(ctx.sessionID, { stageId: params.stageId })
      return {
        title: "Workflow Restore",
        metadata: metadata({
          workflowRunId: result.workflow?.workflowRunId,
          stageId: result.stage?.stageId ?? result.checkpoint?.stageId,
          branch: result.stage?.branch ?? result.workflow?.branch,
          artifactRefs: result.workflow?.trustedArtifacts ?? result.checkpoint?.trustedArtifacts ?? [],
        }),
        output: jsonBlock(result),
      }
    }

    if (params.action === "tools") {
      const workflow = workflowStatusSummary(ctx.sessionID)
      const modelSummary = modelStatusSummary(workflow)
      const policy = workflowToolPolicy({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        inputIntent: ctx.extra?.inputIntent,
        platformCapabilities: {
          mcp: true,
          images: true,
          remote: false,
        },
        modelCapabilities: {
          supportsTools: true,
          supportsImages: true,
        },
      })
      const registeredTools = await registeredToolIDs()
      const resolution = resolveToolAvailability({ policy, toolIDs: registeredTools })
      const mcp = await mcpExposure(policy)
      return {
        title: "Workflow Tools",
        metadata: metadata({
          workflowRunId: workflow.workflow?.workflowRunId,
          stageId: modelSummary.canonicalDataStage?.stageId,
          branch: workflow.workflow?.branch,
          artifactRefs: workflow.activeStage?.artifactRefs ?? [],
        }),
        output: jsonBlock({
          workflowStage: resolution.policy.currentStage,
          directToolIDs: resolution.directToolIDs,
          deferredToolIDs: resolution.deferredToolIDs,
          blockedToolCount: resolution.blockedToolIDs?.length ?? 0,
          mcp: {
            toolCount: mcp.toolCount,
            exposedToolIDs: mcp.exposedToolIDs,
          },
          guidance: "只调用 directToolIDs；需要 deferredToolIDs 中的能力时调用一次 tool_search。若 tool_search 明确工具池已满或未加载工具，停止继续搜索并报告能力缺口。",
        }),
      }
    }

    if (params.action === "agent") {
      const workflow = workflowStatusSummary(ctx.sessionID)
      const state = AgentControl.current(ctx.sessionID)
      return {
        title: "Workflow Agent Control",
        metadata: metadata({
          workflowRunId: workflow.workflow?.workflowRunId,
          stageId: workflow.activeStage?.stageId,
          branch: workflow.workflow?.branch,
          artifactRefs: workflow.activeStage?.artifactRefs ?? [],
        }),
        output: jsonBlock({
          workflow: {
            activeCoordinatorAgent: workflow.workflow?.activeCoordinatorAgent,
            activeStage: workflow.workflow?.activeStage,
            repairOnly: workflow.workflow?.repairOnly,
          },
          agentControl: state,
        }),
      }
    }

    if (params.action === "skills") {
      const workflow = workflowStatusSummary(ctx.sessionID)
      const kind = workflow.workflow?.activeStage ?? workflow.activeStage?.kind
      return {
        title: "Workflow Skills",
        metadata: metadata({
          workflowRunId: workflow.workflow?.workflowRunId,
          stageId: workflow.activeStage?.stageId,
          branch: workflow.workflow?.branch,
          artifactRefs: workflow.activeStage?.artifactRefs ?? [],
        }),
        output: jsonBlock({
          activeStage: kind,
          recommendedSkillBundle: kind ? recommendedSkillBundle(kind) : [],
        }),
      }
    }

    if (params.action === "verify") {
      const result = await runVerifierGate({
        sessionID: ctx.sessionID,
        stageId: params.stageId,
        messageID: ctx.messageID,
        agent: ctx.agent,
        preferFreshRun: true,
      })
      return {
        title: "Workflow Verify",
        metadata: metadata({
          workflowRunId: result.workflowRun?.workflowRunId,
          stageId: result.stage?.stageId,
          branch: result.stage?.branch ?? result.workflowRun?.branch,
          artifactRefs: result.pending ? [] : result.report.trustedArtifacts,
          verifierRequired: result.pending,
          verifierPending: result.pending,
          verifierReport: result.pending ? undefined : result.report,
        }),
        output: result.pending
          ? jsonBlock({ status: "pending", stageId: result.stage?.stageId, message: "独立核验尚未完成；结果已保留，请只从核验阶段继续，不要重跑估计。" })
          : jsonBlock(result),
      }
    }

    if (params.action === "rerun") {
      const result: any = await executeRerunPlan({
        sessionID: ctx.sessionID,
        stageId: params.stageId,
        ctx,
      })
      const modelResult = result.verifier?.pending
        ? {
            ...result,
            verifier: {
              pending: true,
              stageId: result.verifier.stage?.stageId,
              message: "独立核验尚未完成；已有估计结果已保留，请只从核验阶段继续，不要重跑估计。",
            },
          }
        : result
      return {
        title: "Workflow Rerun",
        metadata: metadata({
          workflowRunId: result.workflowRun?.workflowRunId,
          stageId: result.target?.stageId,
          branch: result.target?.branch ?? result.workflowRun?.branch,
          artifactRefs: result.verifier?.pending ? [] : result.target?.artifactRefs ?? result.workflowRun?.trustedArtifacts ?? [],
          verifierRequired: Boolean(result.verifier?.pending || (result.verifier?.report && result.verifier.report.status !== "pass")),
          verifierPending: result.verifier?.pending === true,
          verifierReport: result.verifier?.pending ? undefined : result.verifier?.report,
        }),
        output: jsonBlock(modelResult),
      }
    }

    const rerunPlan = buildRerunPlan(ctx.sessionID, params.stageId)
    return {
      title: "Workflow Rerun Plan",
      metadata: metadata({
        workflowRunId: rerunPlan.workflowRun?.workflowRunId,
        stageId: rerunPlan.target?.stageId,
        branch: rerunPlan.target?.branch ?? rerunPlan.workflowRun?.branch,
        artifactRefs: rerunPlan.target?.artifactRefs ?? [],
      }),
      output: jsonBlock(rerunPlan),
    }
  },
}))

export const WorkflowTool = PipelineTool
