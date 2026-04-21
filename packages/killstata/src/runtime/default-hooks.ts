import { Instance } from "@/project/instance"
import { classifyToolFailure, persistToolReflection } from "@/tool/analysis-reflection"
import { RuntimeHooks } from "./hooks"
import { recordWorkflowStageFailure, recordWorkflowStageSuccess, runAutomaticVerifier, workflowPromptSummary } from "./workflow"

let registered = false
const WORKFLOW_TRACKED_TOOLS = new Set([
  "data_import",
  "econometrics",
  "regression_table",
  "research_brief",
  "paper_draft",
  "slide_generator",
])

export function registerDefaultRuntimeHooks() {
  if (registered) return
  registered = true

  RuntimeHooks.registerPromptAssembled(({ sessionID }) => {
    return {
      appendSystem: workflowPromptSummary(sessionID),
    }
  })

  RuntimeHooks.registerPostTool(async ({ sessionID, messageID, agent, model, toolName, args, result }) => {
    if (!WORKFLOW_TRACKED_TOOLS.has(toolName)) return
    const normalizedArgs =
      typeof args === "object" && args && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
    const { workflowRun, stage } = recordWorkflowStageSuccess({
      sessionID,
      toolName,
      args: normalizedArgs,
      metadata: result.metadata,
    })
    const autoVerify = await runAutomaticVerifier({
      sessionID,
      stageId: stage.stageId,
      messageID,
      agent,
      model,
    })
    return {
      metadata: {
        workflowRunId: workflowRun.workflowRunId,
        artifactRefs: stage.artifactRefs,
        verifierRequired: ["import", "qa_gate", "preprocess_or_filter", "baseline_estimate"].includes(stage.kind),
        verifierReport: autoVerify?.report,
        verifierEnvelope: autoVerify?.envelope,
        repairOnly: autoVerify?.report.status === "block",
        trustedArtifacts: autoVerify?.report.trustedArtifacts ?? stage.trustedArtifacts ?? [],
      },
    }
  })

  RuntimeHooks.registerPostToolFailure(({ sessionID, toolName, args, error }) => {
    if (!WORKFLOW_TRACKED_TOOLS.has(toolName)) return
    const reflection = classifyToolFailure({
      toolName,
      error: String(error),
      input: typeof args === "object" && args && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
    })
    const reflectionPath = persistToolReflection(reflection)
    const relativePath = reflectionPath.startsWith(Instance.directory)
      ? reflectionPath.slice(Instance.directory.length + 1)
      : reflectionPath
    if (typeof args === "object" && args && !Array.isArray(args)) {
      const { stage } = recordWorkflowStageFailure({
        sessionID,
        toolName,
        args: args as Record<string, unknown>,
        reflection: {
          ...reflection,
          reflectionPath: relativePath,
        },
      })
      return {
        metadata: {
          reflection: {
            ...reflection,
            reflectionPath: relativePath,
          },
          repairContext: stage.failure?.repairMetadata,
          workflowFailure: stage.failure,
        },
        repair: {
          toolName,
          retryStage: stage.failure?.retryStage ?? reflection.retryStage,
          repairAction: stage.failure?.repairAction ?? reflection.repairAction,
          reflectionPath: relativePath,
        },
      }
    }
    return {
      metadata: {
        reflection: {
          ...reflection,
          reflectionPath: relativePath,
        },
      },
      repair: {
        toolName,
        retryStage: reflection.retryStage,
        repairAction: reflection.repairAction,
        reflectionPath: relativePath,
      },
    }
  })
}
