import z from "zod"
import { MCP } from "@/mcp"
import { getRuntimePythonStatus } from "@/killstata/runtime-config"
import { Tool } from "./tool"
import {
  buildRerunPlan,
  buildVerifierReport,
  executeRerunPlan,
  runVerifierGate,
  workflowArtifactList,
  workflowStageDetails,
  workflowStatusSummary,
} from "@/runtime/workflow"

const parameters = z.object({
  action: z.enum(["status", "stage", "artifacts", "doctor", "verify", "rerun_plan", "rerun"]),
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
