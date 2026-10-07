import { Bus } from "@/bus"
import crypto from "crypto"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { PermissionNext } from "@/permission/next"
import { registerDefaultRuntimeHooks } from "@/runtime/default-hooks"
import { RuntimeHooks } from "@/runtime/hooks"
import {
  QueryRuntime,
  REPEATED_TOOL_CALL_THRESHOLD,
  repeatedToolCallCount,
  toolCallSignature,
} from "@/runtime/query-runtime"
import { toolExecutionTraits } from "@/runtime/tool-policy"
import { getExecutionMode, isAllowedInPlanMode } from "@/runtime/execution-mode"
import { isWorkflowAnalysisTool, isWorkflowEstimateTool, isWorkflowReadOnlyAction, isWorkflowRecommendTool } from "@/runtime/tool-catalog"
import { ToolOrchestrator } from "@/runtime/tool-orchestrator"
import { TraceLogger } from "@/runtime/trace-logger"
import { TurnAssembler } from "@/runtime/turn-assembler"
import type { QueryRuntimeResult, WorkflowInputIntent } from "@/runtime/types"
import { Log } from "@/util/log"
import type { MessageV2 } from "./message-v2"
import type { Provider } from "@/provider/provider"
import { Session } from "."
import type { ModelGateway } from "@/runtime/services/model-gateway"
import { prepareToolMetadata, summarizeToolError } from "@/runtime/tool-result-policy"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { maxToolFailureAttempts } from "@/runtime/tool-attempt-policy"
import { buildRerunPlan } from "@/runtime/workflow/rerun"
import type { Tool } from "@/tool/tool"
import { FailurePolicy } from "@/runtime/failure-policy"

export namespace SessionProcessor {
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
    inputIntent?: WorkflowInputIntent
    repairToolName?: string
    repairInputSignature?: string
    onRepairToolSucceeded?: () => void
    /** 同一用户动作内跨模型回合复用成功结果；新动作由 dispatch 创建新 Map。 */
    successfulToolResults?: Map<string, unknown>
    /**
     * 仅供固定参数回放等隔离验证使用：保留正式的编排、权限与生命周期，
     * 但不触发会再次驱动代理循环的全局运行时钩子。
     */
    runRuntimeHooks?: boolean
  }) {
    const runRuntimeHooks = input.runRuntimeHooks ?? true
    // 一个模型响应里的多个串行工具可能跨过“修复成功”边界；锁必须是 processor
    // 内可释放的运行时状态，不能只读地绑定在 create() 参数上。
    let activeRepairToolName = input.repairToolName
    let activeRepairInputSignature = input.repairInputSignature
    if (runRuntimeHooks) registerDefaultRuntimeHooks()

    const assembler = new TurnAssembler({
      assistantMessage: input.assistantMessage,
      sessionID: input.sessionID,
      model: input.model,
      inputIntent: input.inputIntent,
    })
    const orchestrator = new ToolOrchestrator(input.sessionID)
    const activeToolCalls = new Map<string, number>()
    // 同一模型响应可能重复发出完全相同的串行工具调用。成功结果在当前
    // processor 内可安全复用：不再次运行 Python/写文件，也不再次触发 postTool
    // verifier；不同用户轮次会创建新的 processor，不会把旧结果越权带入新请求。
    const successfulToolResults = input.successfulToolResults ?? new Map<string, unknown>()
    let forcedStop = false

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return assembler.partFromToolCall(toolCallID)
      },
      async executeTool<M extends Record<string, unknown>>(
        toolName: string,
        args: unknown,
        meta: {
          callID?: string
          execution?: Tool.ExecutionPolicy
          deferVerification?: boolean
          run: (args: unknown) => Promise<
            {
              title: string
              metadata: M
              output: string
              attachments?: MessageV2.FilePart[]
            } & Record<string, unknown>
          >
          beforeRun?: (args: unknown) => Promise<
            | {
                title: string
                metadata: Record<string, unknown>
                output: string
                attachments?: MessageV2.FilePart[]
              }
            | undefined
          >
        },
      ) {
        // hook 可以改参数，因此所有 repair、权限、重复调用和调度判定必须只看 finalArgs。
        // 原始 args 仅作为 hook 输入和审计来源，绝不能据此提前放行。
        const pre = runRuntimeHooks
          ? await RuntimeHooks.preTool({
              sessionID: input.sessionID,
              toolName,
              args,
              callID: meta.callID ?? "",
            })
          : {}
        if (pre.block) throw new Error(pre.block)
        const finalArgs = pre.updatedInput ?? args

        if (
          activeRepairToolName &&
          toolName === activeRepairToolName &&
          activeRepairInputSignature === toolCallSignature(toolName, finalArgs)
        ) {
          throw new Error(`REPAIR_INPUT_UNCHANGED：自动修复 ${activeRepairToolName} 时拒绝原样重复上次失败参数。`)
        }
        // 修复模式禁止切换到其他估计器/诊断器（方法锁定），但 econometrics_recommend 是
        // 修复前置条件（缺 profile）的必经工具，必须放行——否则估计器失败后模型无法
        // 完成画像，修复循环必然死锁（2026-08-05 真实数据测试：repairAction 指向
        // profile 但 recommend 被 REPAIR_TOOL_MISMATCH 拦下，2 次修复后停止）。
        if (
          activeRepairToolName &&
          toolName !== activeRepairToolName &&
          isWorkflowAnalysisTool(toolName) &&
          !isWorkflowRecommendTool(toolName)
        ) {
          throw new Error(`REPAIR_TOOL_MISMATCH：自动修复只能重试 ${activeRepairToolName}，拒绝切换到 ${toolName}。`)
        }
        if (
          activeRepairToolName &&
          toolName === "pipeline" &&
          typeof (finalArgs as { action?: unknown })?.action === "string" &&
          (finalArgs as { action: string }).action === "rerun"
        ) {
          const stageID = (finalArgs as { stageId?: unknown }).stageId
          // 显式/隐式 rerun 必须使用执行路径同一套 target 解析；否则省略 stageId 时
          // buildRerunPlan 选中的 latestFailed/active estimator 可以绕过方法锁。
          const plan = buildRerunPlan(input.sessionID, typeof stageID === "string" ? stageID : undefined)
          const targetTool = plan.toolName ?? plan.target?.toolName
          if (
            targetTool &&
            isWorkflowAnalysisTool(targetTool) &&
            !isWorkflowRecommendTool(targetTool) &&
            targetTool !== activeRepairToolName
          ) {
            throw new Error(
              `REPAIR_TOOL_MISMATCH：自动修复只能重试 ${activeRepairToolName}，拒绝通过 pipeline rerun 切换到 ${targetTool}。`,
            )
          }
        }
        // 修复模式禁止 pipeline 写操作（restore/rerun 之外的 mutation），但 rerun 是
        // 修复建议指向的合法动作（如"重跑 validate 阶段"），必须放行——否则 verifier 报
        // ARTIFACT_MISSING 后模型调 pipeline rerun 修复，被该守卫拦下，2 次修复后停止
        // （2026-08-06 真实数据测试）。restore 等更危险的动作仍被拒。
        if (
          activeRepairToolName &&
          toolName === "pipeline" &&
          !isWorkflowReadOnlyAction(finalArgs) &&
          !(
            typeof (finalArgs as { action?: unknown })?.action === "string" &&
            (finalArgs as { action: string }).action === "rerun"
          )
        ) {
          throw new Error(
            `REPAIR_WORKFLOW_MUTATION_DENIED：自动修复 ${activeRepairToolName} 期间只允许查看工作流状态。`,
          )
        }

        // 只有通过 finalArgs repair 守卫的调用才需要解析执行策略。正式 ToolPort 直接携带；
        // 隔离 Harness/历史调用仅可按 ID 回查同一个 Tool.Info，查不到仍 fail-closed。
        const execution =
          meta.execution ?? (await (await import("@/tool/registry")).ToolRegistry.byID(toolName))?.execution
        if (!execution) {
          throw new Error(`TOOL_EXECUTION_POLICY_MISSING：${toolName} 未声明可执行的安全契约，已阻断。`)
        }
        const admissionTraits = toolExecutionTraits(execution, finalArgs)
        if (admissionTraits.approval === "blocked") {
          throw new Error(`TOOL_EXECUTION_POLICY_MISSING：${toolName} 未声明可执行的安全契约，已阻断。`)
        }
        // Plan（规划与受管检查）模式：除 data_import 的受管检查动作外，其他非只读工具不执行。
        // 工具可见性与 Auto 一致——模型照常
        // tool_search 加载估计方法、读数据画像——差异只在这里：估计器、data_import、
        // data_preprocess、econometrics_recommend、edit/write/bash、pipeline 的 restore/rerun
        // 等一律拒绝，提示模型把方法名、参数和步骤写进计划，由用户切到 Auto 后运行。
        // question/todowrite/skill 属于规划期正常交互，放行（两种模式都支持主动询问用户）。
        // data_import 的检查动作（import/profile/validate/correlation/frequency/healthcheck）
        // 同样放行：它们不改用户原始文件，却是 Plan 模式拿到真实列名与面板键的唯一途径，
        // 否则只能问空泛问题或臆造列名。export/rollback 仍被拒。
        if (
          getExecutionMode() === "plan" &&
          admissionTraits.sideEffectLevel !== "none" &&
          !isAllowedInPlanMode(toolName, finalArgs)
          ) {
          throw new Error(
            `PLAN_MODE_EXECUTION_BLOCKED：当前是 Plan 只读规划模式，不执行 ${toolName}。` +
              `把要运行的方法名、完整参数和分析步骤写进给用户的方案里；用户切换到 Auto 后再执行。`,
          )
        }
        const beforeRunResult = await meta.beforeRun?.(finalArgs)
        if (beforeRunResult) return beforeRunResult as Awaited<ReturnType<typeof meta.run>>
        if (admissionTraits.requiresConfirmation && admissionTraits.confirmation === "dispatcher") {
          const agent = await Agent.get(input.assistantMessage.agent)
          await PermissionNext.ask({
            permission: toolName,
            patterns: ["*"],
            sessionID: input.sessionID,
            metadata: { tool: toolName, input: finalArgs },
            // always 是"模式"列表，必须能匹配本次请求的 patterns。写成工具名会存下
            // {permission:"write", pattern:"write"}，evaluate("write","*") 永远命不中，
            // 用户点了"始终允许"下次仍会被重复询问。
            always: ["*"],
            ruleset: agent.permission,
          })
        }

        // AI SDK 会并发启动同一响应里的多个 tool-call；finalArgs 确定后、下一次 await 前
        // 同步登记，保证两个相同的最终调用不会同时漏过 doom-loop 计数。
        const signature = toolCallSignature(toolName, finalArgs)
        const ledgerSignature = `sha256:${crypto
          .createHash("sha256")
          .update(`${input.sessionID}\0${signature}`)
          .digest("hex")}`
        const activeDuplicates = activeToolCalls.get(signature) ?? 0
        activeToolCalls.set(signature, activeDuplicates + 1)

        try {
          // 必须在 orchestrator/meta.run 之前检查；等 fullStream 发出 tool-call 时，原生工具可能已经执行。
          const recentMessages = await Session.messages({ sessionID: input.sessionID, limit: 20 })
          const historicalDuplicates = repeatedToolCallCount(
            recentMessages.flatMap((message) => message.parts),
            {
              toolCallId: meta.callID ?? "",
              toolName,
              input: finalArgs,
            },
          )
          const repeated = historicalDuplicates + activeDuplicates >= REPEATED_TOOL_CALL_THRESHOLD
          if (repeated) {
            const agent = await Agent.get(input.assistantMessage.agent)
            if (agent) {
              await PermissionNext.ask({
                permission: "doom_loop",
                patterns: [toolName],
                sessionID: input.sessionID,
                metadata: { tool: toolName, input: finalArgs },
                always: [toolName],
                ruleset: agent.permission,
              })
            }
          }

        const attemptBudget = RuntimeTaskLedger.recordToolAttempt({
            sessionID: input.sessionID,
            toolName,
            signature: ledgerSignature,
            kind: "started",
            stageId: typeof (finalArgs as Record<string, unknown>)?.stageId === "string" ? String((finalArgs as Record<string, unknown>).stageId) : undefined,
            maxAttempts: maxToolFailureAttempts(toolName),
          })
          if (!attemptBudget.allowed) {
            throw new Error(`TOOL_ATTEMPT_BUDGET_EXHAUSTED：${toolName} 的同一参数组合已连续失败 ${attemptBudget.max} 次，停止重复执行。`)
          }
          const traits = toolExecutionTraits(execution, finalArgs)
          // 这两个工具的结果依赖可变的运行时状态：tool_search 会更新方法池并重新披露 Schema；
          // analysis_prepare 绑定当前数据阶段和 fingerprint。缓存旧的投影/阶段结果会让恢复轮
          // 收到 noNewInformation 或过期 preflight，故不能走通用成功结果复用。
          const canReuseSuccessfulResult =
            traits.sideEffectLevel !== "external" && toolName !== "tool_search" && toolName !== "analysis_prepare"
          const correlation = {
            sessionID: input.sessionID,
            turnID: input.assistantMessage.id,
            requestID: `tool-${meta.callID ?? input.assistantMessage.id}`,
            stepID: meta.callID ?? toolName,
            attempt: 0,
            providerID: input.model.providerID,
            modelID: input.model.id,
          }
          RuntimeTaskLedger.appendEventBestEffort({
            sessionID: input.sessionID,
            kind: "tool.lifecycle",
            correlation,
            message: `${toolName} execution accepted`,
          })

          return await orchestrator.execute({
            callID: meta.callID ?? "",
            toolName,
            traits,
            correlation,
            signal: input.abort,
            run: async () => {
              const cached = canReuseSuccessfulResult ? successfulToolResults.get(signature) as {
                title: string
                metadata: Record<string, unknown>
                output: string
                attachments?: MessageV2.FilePart[]
              } | undefined : undefined
              if (cached) {
                return {
                  ...cached,
                  output: `已复用当前轮次同规格工具结果。\n${cached.output}`,
                  // 同一用户动作内再次请求完全相同的结果不会产生新信息。把它作为
                  // 内部控制信号交给 QueryRuntime，让本轮直接进入文字收尾，避免
                  // 模型围绕同一 profile/frequency 结果继续空转。
                  metadata: { ...cached.metadata, reused: true, noNewInformation: true },
                } as unknown as Awaited<ReturnType<typeof meta.run>>
              }
              try {
                const executionResult = await meta.run(finalArgs)
                const post = runRuntimeHooks
                  ? await RuntimeHooks.postTool({
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.id,
                      agent: input.assistantMessage.agent,
                      model: {
                        providerID: input.model.providerID,
                        modelID: input.model.id,
                      },
                      toolName,
                      args: finalArgs,
                      callID: meta.callID ?? "",
                      correlation,
                      deferVerification: meta.deferVerification,
                      result: executionResult,
                    })
                  : {}
                if (post.preventContinuation) forcedStop = true
                const resultSignal = FailurePolicy.toolResultSignal({
                  output: executionResult.output,
                  metadata: {
                    ...executionResult.metadata,
                    ...(post.metadata ?? {}),
                  },
                })
                RuntimeTaskLedger.appendEventBestEffort({
                  sessionID: input.sessionID,
                  kind: "tool.result",
                  correlation,
                  message: `${toolName} execution completed`,
                  metadata: { title: summarizeToolError(executionResult.title, 512), resultSignal },
                })
                RuntimeTaskLedger.recordToolAttempt({
                  sessionID: input.sessionID,
                  toolName,
                  signature: ledgerSignature,
                  kind: "completed",
                  stageId: typeof (finalArgs as Record<string, unknown>)?.stageId === "string" ? String((finalArgs as Record<string, unknown>).stageId) : undefined,
                  maxAttempts: maxToolFailureAttempts(toolName),
                })
                if (toolName === activeRepairToolName) {
                  activeRepairToolName = undefined
                  activeRepairInputSignature = undefined
                  input.onRepairToolSucceeded?.()
                }
                const completedMetadata = prepareToolMetadata({
                  ...executionResult.metadata,
                  ...(post.metadata ?? {}),
                }) as M
                const pendingVerificationNotice = isWorkflowEstimateTool(toolName)
                  ? "估计结果已生成，状态：待核验；核验完成前请勿将其作为最终结论。"
                  : "当前步骤已完成，独立核验待完成；这不表示计量估计已完成。"
                const completedOutput = completedMetadata.verifierPending === true &&
                  !/待核验|等待独立核验/.test(executionResult.output)
                  ? `${executionResult.output}\n\n提示：${pendingVerificationNotice}`
                  : executionResult.output
                const completedResult = {
                  ...executionResult,
                  output: completedOutput,
                  metadata: completedMetadata,
                }
                // SchemaNotSent 是上下文相关的可恢复状态：模型加载完整方法 Schema 后，
                // 相同的 requestId/methodID/arguments 必须重新进入 Python validate/preflight，
                // 不能被本轮旧的“尚未披露”结果缓存成 noNewInformation。
                if (canReuseSuccessfulResult && completedMetadata.analysisSpecStatus !== "schema_not_sent") {
                  successfulToolResults.set(signature, completedResult)
                }
                return completedResult
              } catch (error) {
                RuntimeTaskLedger.recordToolAttempt({
                  sessionID: input.sessionID,
                  toolName,
                  signature: ledgerSignature,
                  kind: "failed",
                  stageId: typeof (finalArgs as Record<string, unknown>)?.stageId === "string" ? String((finalArgs as Record<string, unknown>).stageId) : undefined,
                  errorCode: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : undefined,
                  maxAttempts: maxToolFailureAttempts(toolName),
                })
                throw error
              }
            },
          })
        } finally {
          const remaining = (activeToolCalls.get(signature) ?? 1) - 1
          if (remaining === 0) activeToolCalls.delete(signature)
          else activeToolCalls.set(signature, remaining)
        }
      },
      async process(streamInput: ModelGateway.StreamInput) {
        log.info("process")
        // trace logger 在首个 turn 启动时注册（幂等）。这里才注册是因为 Config.get 是
        // async，而 create() 是同步的；process() 里的 runtime.run 才开始发 tool 事件，
        // 先 await config 再注册不会漏掉任何 pre/post。
        const cfg = await Config.get()
        TraceLogger.register({
          sessionID: input.sessionID,
          enabled: cfg.experimental?.traceLogger?.enabled,
          dirOverride: cfg.experimental?.traceLogger?.dir,
          maxFiles: cfg.experimental?.traceLogger?.maxFiles,
          maxFileBytes: cfg.experimental?.traceLogger?.maxFileBytes,
        })
        const runtime = new QueryRuntime({
          assistantMessage: input.assistantMessage,
          sessionID: input.sessionID,
          model: input.model,
          abort: input.abort,
          partFromToolCall(toolCallID) {
            return assembler.partFromToolCall(toolCallID)
          },
        })

        let finalResult: QueryRuntimeResult = "continue"
        let finalError: unknown

        try {
          for await (const event of runtime.run(streamInput)) {
            if (event.type === "turn-finish") {
              finalResult = forcedStop && event.result === "continue" ? "stop" : event.result
              finalError = event.error
              continue
            }
            await assembler.consume(event)
          }
        } catch (error) {
          // 取消/超时可能发生在模型已交付工具结果、但尚未生成最后一段正文时。
          // 如果直接把异常抛给 dispatch，TurnAssembler 不会收尾，已完成的结果既不能
          // 生成兜底摘要，running 工具也会一直显示为执行中。中止不是分析失败，不把
          // AbortError 写成用户可见的模型错误；其他异常仍保留原错误并继续向上抛出。
          finalResult = "stop"
          const timeoutError = error instanceof Session.TimeoutError || input.abort.reason instanceof Session.TimeoutError
          finalError = timeoutError
            ? (error instanceof Session.TimeoutError ? error : input.abort.reason)
            : input.abort.aborted || error instanceof Session.CancelledError || (error instanceof Error && error.name === "AbortError")
              ? undefined
              : error
          try {
            await assembler.finalize(finalResult, finalError)
          } catch (finalizeError) {
            log.error("assistant finalize after runtime failure failed", { sessionID: input.sessionID, error: finalizeError })
          }
          throw error
        }

        await assembler.finalize(finalResult, finalError)
        if (input.assistantMessage.error) {
          Bus.publish(Session.Event.Error, {
            sessionID: input.assistantMessage.sessionID,
            error: input.assistantMessage.error,
          })
          return "stop"
        }
        return finalResult
      },
    }
    return result
  }
}
