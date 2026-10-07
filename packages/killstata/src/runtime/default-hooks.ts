import { relativeWithinProject } from "@/tool/analysis-path"
import { classifyToolFailure, persistToolReflection } from "@/runtime/failure-reflection"
import { RuntimeHooks } from "./hooks"
import { Memory } from "./memory"
import {
  recordWorkflowStageFailure,
  recordWorkflowStageSuccess,
  runAutomaticVerifier,
  deferAutomaticVerifier,
  stageNeedsVerifier,
} from "./workflow"
import { isWorkflowAnalysisTool } from "./tool-catalog"
import { ConfirmedMethods } from "./confirmed-methods"

let registered = false
const WORKFLOW_TRACKED_TOOLS = new Set([
  "data_import",
  "data_preprocess",
  "composite_evaluation",
])

function isWorkflowTrackedTool(toolName: string) {
  return WORKFLOW_TRACKED_TOOLS.has(toolName) || isWorkflowAnalysisTool(toolName)
}

/**
 * 估计器在门禁拒绝时往往会以"切到交错 DID / 事件研究"等措辞提示模型换方法。
 * 把这些稳定提示自动映射到 confirmedToolIDs，避免模型还要通过 tool_search
 * 猜目标估计器（真实 did-direct 第三轮回放，2026-08-26）。
 *
 * 触发条件仅限 estimation_failure 的核心 DID 家族；扩展/调整新方法时在此追加。
 */
const ESTIMATOR_METHOD_SWITCH_HINTS: Array<{ source: RegExp; confirmed: string[] }> = [
  { source: /交错|错位实施|gardner|两阶段\s*did|相对时期|平均处理效应\s*att/i, confirmed: ["did2s"] },
  { source: /传统 DID 必须同时包含|四个样本单元|处理组.*对照组.*政策/i, confirmed: ["did2s"] },
  { source: /事件研究|动态效应/, confirmed: ["did_event_study_saturated"] },
]

function detectConfirmedMethodTools(input: { toolName: string; error: string; repairAction: string }): string[] {
  if (input.toolName !== "did_static" && input.toolName !== "did_event_study_saturated" && input.toolName !== "did2s") {
    return []
  }
  const haystack = `${input.error}\n${input.repairAction}`
  const confirmed: string[] = []
  for (const hint of ESTIMATOR_METHOD_SWITCH_HINTS) {
    if (hint.confirmed.some((tool) => confirmed.includes(tool))) continue
    if (hint.source.test(haystack)) confirmed.push(...hint.confirmed)
  }
  return confirmed
}

export function registerDefaultRuntimeHooks() {
  if (registered) return
  registered = true

  RuntimeHooks.registerPostTool(async ({ sessionID, messageID, callID, agent, model, toolName, args, deferVerification, result }) => {
    if (toolName === "question") {
      const answers = (result.metadata as { answers?: string[][] } | undefined)?.answers ?? []
      const flat = answers.flat().join(" ")
      const confirmed: string[] = []
      if (/交错|did2s|gardner|两阶段/i.test(flat)) confirmed.push("did2s")
      if (/事件研究|动态效应/.test(flat)) confirmed.push("did_event_study_saturated")
      if (confirmed.length) ConfirmedMethods.add(sessionID, confirmed)
      // question 本身不产生 workflow stage，直接返回已记录的确认方法，避免被 isWorkflowTrackedTool 拦截
      if (confirmed.length) return { confirmedToolIDs: [...new Set(confirmed)] }
      return
    }
    if (!isWorkflowTrackedTool(toolName)) return
    const normalizedArgs =
      typeof args === "object" && args && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
    const { workflowRun, stage } = recordWorkflowStageSuccess({
      sessionID,
      toolName,
      args: normalizedArgs,
      metadata: result.metadata,
    })
    const resultMetadata = result.metadata as Record<string, unknown> | undefined
    if (resultMetadata?.requiresUserDecision === true || resultMetadata?.qaGateStatus === "block") {
      return {
        metadata: {
          workflowRunId: workflowRun.workflowRunId,
          artifactRefs: [],
          verifierRequired: false,
          verifierPending: false,
          repairOnly: true,
          trustedArtifacts: [],
        },
      }
    }
    const verifierInput = {
      sessionID, workflowRunId: workflowRun.workflowRunId, branch: stage.branch,
      stageId: stage.stageId, messageID, callID, agent, model,
    }
    if (deferVerification && stageNeedsVerifier(stage.kind)) {
      deferAutomaticVerifier(verifierInput)
      return {
        metadata: {
          workflowRunId: workflowRun.workflowRunId,
          artifactRefs: stage.artifactRefs,
          verifierRequired: true,
          verifierPending: stage.status !== "blocked",
          repairOnly: stage.status === "blocked",
          trustedArtifacts: stage.trustedArtifacts ?? [],
        },
      }
    }
    const autoVerify = await runAutomaticVerifier(verifierInput)
    return {
      metadata: {
        workflowRunId: workflowRun.workflowRunId,
        artifactRefs: autoVerify?.pending ? [] : stage.artifactRefs,
        verifierRequired: ["import", "validate", "preprocess_or_filter", "baseline_estimate"].includes(stage.kind),
        verifierPending: autoVerify?.pending === true,
        verifierReport: autoVerify?.pending ? undefined : autoVerify?.report,
        verifierEnvelope: autoVerify?.envelope,
        repairOnly: autoVerify?.report.status === "block",
        trustedArtifacts: autoVerify?.pending ? [] : autoVerify?.report.trustedArtifacts ?? stage.trustedArtifacts ?? [],
      },
    }
  })

  RuntimeHooks.registerPostToolFailure(async ({ sessionID, toolName, args, error, errorCode }) => {
    if (!isWorkflowTrackedTool(toolName)) return
    const reflection = classifyToolFailure({
      toolName,
      error: String(error),
      errorCode,
      input: typeof args === "object" && args && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
    })
    const reflectionPath = persistToolReflection(reflection)

    // 附上本会话历史上同类工具失败的记录（最多 3 条），让修复决策有上下文。
    // 会话隔离：不传 sessionID 会被 Memory.priorReflections 拒收——避免新窗口被喂
    // 上一会话的失败历史。诊断反复出现的工具缺陷请显式传 scope: "project"。
    const priorReflections = await Memory.priorReflections(toolName, 3, { sessionID }).catch(() => [])

    // DID 估计器门禁拒绝时，repairAction 通常已经提示了"切到交错 DID did2s / 事件研究"。
    // 直接把它固化为 confirmedToolIDs，下一轮 resolveTools 会优先加载而不是依赖模型
    // 再次调用 tool_search（2026-08-26 did-direct 第三轮：模型已被门禁提示切 did2s，
    // 但旧扁平预算让它仍停留在 deferred，最终在搜索循环里耗尽自动修复预算）。
    const confirmedToolIDs = detectConfirmedMethodTools({
      toolName,
      error: String(error),
      repairAction: reflection.repairAction,
    })
    if (confirmedToolIDs.length) ConfirmedMethods.add(sessionID, confirmedToolIDs)

    // reflection 落盘在 projectReflectionRoot()（= worktree 下），directory 剥前缀在
    // directory !== worktree 时恒假（同 query-runtime.ts 的修法，2026-08-14 同批修复）。
    const relativePath = relativeWithinProject(reflectionPath)
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
            priorReflections: priorReflections.length > 0 ? priorReflections : undefined,
          },
          repairContext: stage.failure?.repairMetadata,
          workflowFailure: stage.failure,
        },
        preventContinuation:
          reflection.failureType === "result_contract_failure" ||
          (toolName === "did_static" && /四个样本单元/.test(String(error))),
        repair: {
          toolName,
          retryStage: stage.failure?.retryStage ?? reflection.retryStage,
          repairAction: stage.failure?.repairAction ?? reflection.repairAction,
          reflectionPath: relativePath,
        },
        confirmedToolIDs: confirmedToolIDs.length ? confirmedToolIDs : undefined,
      }
    }
    return {
      metadata: {
        reflection: {
          ...reflection,
          reflectionPath: relativePath,
          priorReflections: priorReflections.length > 0 ? priorReflections : undefined,
        },
      },
      preventContinuation:
        reflection.failureType === "result_contract_failure" ||
        (toolName === "did_static" && /四个样本单元/.test(String(error))),
      repair: {
        toolName,
        retryStage: reflection.retryStage,
        repairAction: reflection.repairAction,
        reflectionPath: relativePath,
      },
      confirmedToolIDs: confirmedToolIDs.length ? confirmedToolIDs : undefined,
    }
  })
}
