import z from "zod"
import { MCP } from "@/mcp"
import { getRuntimePythonStatus } from "@/killstata/runtime-config"
import { AgentControl } from "@/runtime/agent-control"
import { DEFAULT_EXEC_POLICY } from "@/runtime/exec-policy"
import { Tool } from "./tool"
import {
  buildRerunPlan,
  buildVerifierReport,
  executeRerunPlan,
  recommendedSkillBundle,
  resolveToolAvailability,
  restoreWorkflowCheckpoint,
  runVerifierGate,
  workflowTaskLedger,
  workflowArtifactList,
  workflowStageDetails,
  workflowStatusSummary,
  workflowToolPolicy,
} from "@/runtime/workflow"

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
  ]),
  stageId: z.string().optional(),
})

type WorkflowToolMetadata = {
  workflowRunId?: string
  stageId?: string
  branch?: string
  artifactRefs: string[]
  verifierRequired?: boolean
  verifierReport?: ReturnType<typeof buildVerifierReport>["report"]
}

function jsonBlock(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function metadata(input: WorkflowToolMetadata): WorkflowToolMetadata {
  return input
}

const KNOWN_TOOL_IDS = [
  "invalid",
  "question",
  "read",
  "list",
  "glob",
  "grep",
  "skill",
  "workflow",
  "webfetch",
  "websearch",
  "codesearch",
  "task",
  "todo_read",
  "todoread",
  "todowrite",
  "bash",
  "shell",
  "edit",
  "write",
  "apply_patch",
  "data_import",
  "data_batch",
  "econometrics",
  "regression_table",
  "research_brief",
  "paper_draft",
  "slide_generator",
  "heterogeneity_runner",
]

export const WorkflowTool = Tool.define("workflow", async () => ({
  description:
    "Inspect the current econometrics workflow state, verify the active stage, list artifacts, or build a rerun plan for the failed stage only.",
  parameters,
  async execute(params, ctx) {
    if (params.action === "status") {
      const summary = workflowStatusSummary(ctx.sessionID)
      return {
        title: "Workflow Status",
        metadata: metadata({
          workflowRunId: summary.workflow?.workflowRunId,
          stageId: summary.activeStage?.stageId,
          branch: summary.workflow?.branch,
          artifactRefs: summary.activeStage?.artifactRefs ?? [],
        }),
        output: jsonBlock(summary),
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
        output: jsonBlock(artifacts),
      }
    }

    if (params.action === "doctor") {
      const workflow = workflowStatusSummary(ctx.sessionID)
      const python = await getRuntimePythonStatus()
      const mcpTools = Object.keys(await MCP.tools()).length
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
          mcp: {
            toolCount: mcpTools,
          },
        }),
      }
    }

    if (params.action === "diagnostics") {
      const workflow = workflowStatusSummary(ctx.sessionID)
      const python = await getRuntimePythonStatus()
      const mcpTools = Object.keys(await MCP.tools()).length
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
          mcp: { toolCount: mcpTools },
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
      const events = ledger.tasks.flatMap((task) => task.timeline).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
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
      const policy = workflowToolPolicy({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
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
      const resolution = resolveToolAvailability({ policy, toolIDs: KNOWN_TOOL_IDS })
      return {
        title: "Workflow Tools",
        metadata: metadata({
          workflowRunId: workflow.workflow?.workflowRunId,
          stageId: workflow.activeStage?.stageId,
          branch: workflow.workflow?.branch,
          artifactRefs: workflow.activeStage?.artifactRefs ?? [],
        }),
        output: jsonBlock({
          policy: resolution.policy,
          allowedToolIDs: resolution.allowedToolIDs,
          directToolIDs: resolution.directToolIDs,
          deferredToolIDs: resolution.deferredToolIDs,
          blockedToolIDs: resolution.blockedToolIDs,
          exposurePlan: resolution.exposurePlan,
          explanations: resolution.explanations,
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
          artifactRefs: result.report.trustedArtifacts,
          verifierRequired: false,
          verifierReport: result.report,
        }),
        output: jsonBlock(result),
      }
    }

    if (params.action === "rerun") {
      const result: any = await executeRerunPlan({
        sessionID: ctx.sessionID,
        stageId: params.stageId,
        ctx,
      })
      return {
        title: "Workflow Rerun",
        metadata: metadata({
          workflowRunId: result.workflowRun?.workflowRunId,
          stageId: result.target?.stageId,
          branch: result.target?.branch ?? result.workflowRun?.branch,
          artifactRefs: result.target?.artifactRefs ?? result.workflowRun?.trustedArtifacts ?? [],
          verifierRequired: Boolean(result.verifier?.report && result.verifier.report.status !== "pass"),
          verifierReport: result.verifier?.report,
        }),
        output: jsonBlock(result),
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
