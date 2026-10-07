import { Tool } from "./tool"
import { ToolModel } from "./model-contracts"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { cancel as cancelSessionPrompt, prompt as promptSession } from "../session/prompt/dispatch"
import { resolvePromptParts } from "../session/prompt/message"
import { iife } from "@killstata/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { createSubagentContract } from "@/runtime/tool-policy"
import { RuntimeEvents } from "@/runtime/events"
import { Instance } from "@/project/instance"
import path from "path"

function collectArtifactHints(messages: MessageV2.WithParts[]) {
  const artifacts = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file" && part.filename) artifacts.add(part.filename)
      if (
        part.type === "tool" &&
        part.state.status === "completed" &&
        Array.isArray(part.state.metadata?.["trustedArtifactPaths"])
      ) {
        for (const artifact of part.state.metadata["trustedArtifactPaths"] as string[]) {
          artifacts.add(artifact)
        }
      }
    }
  }
  return [...artifacts].slice(0, 8)
}

const parameters = z.object({
  description: z.string().describe("任务的简短中文说明（3 至 5 个词）"),
  prompt: z.string().describe("交给内部 Agent 的明确任务"),
  subagent_type: z.string().describe("本任务使用的专用 Agent 类型"),
  session_id: z.string().describe("要继续的既有子任务会话").optional(),
  command: z.string().describe("触发此任务的命令").optional(),
})

type TaskParameters = z.infer<typeof parameters>

function matchesUserAuthorization(authorization: unknown, params: TaskParameters) {
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) return false
  const approved = authorization as Partial<TaskParameters>
  return (
    approved.description === params.description &&
    approved.prompt === params.prompt &&
    approved.subagent_type === params.subagent_type &&
    approved.session_id === params.session_id &&
    approved.command === params.command
  )
}

export const TaskTool = Tool.define("task", Tool.Execution.protectedExternal, ToolModel.forTool("task"), async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "该子 Agent 只应在用户明确指定时调用。"}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      // @/命令生成的 subtask part 是本次调用的精确用户授权证据；它只跳过 task 自己的
      // 重复弹窗，仍必须经过 SessionProcessor、ToolOrchestrator 和其余资源权限检查。
      if (!matchesUserAuthorization(ctx.extra?.userInitiatedTask, params)) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`未知子 Agent 类型：${params.subagent_type} 不在当前可用列表中。`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch(() => undefined)
          if (!found) throw new Error(`TASK_SESSION_NOT_FOUND：找不到要续接的子会话 ${params.session_id}。`)
          const sameParent = found.parentID === ctx.sessionID
          const sameProject = found.projectID === Instance.project.id
          const sameDirectory = path.resolve(found.directory) === path.resolve(Instance.directory)
          if (!sameParent || !sameProject || !sameDirectory) {
            throw new Error("TASK_SESSION_SCOPE_MISMATCH：只能续接当前父会话在同一项目和目录中创建的子会话。")
          }
          return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("子会话最后一条消息不是 Agent 结果，暂时无法汇总。")

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
        },
      })
      ctx.progress?.({
        message: `子 Agent ${agent.name} 已排队`,
        title: params.description,
        metadata: { sessionId: session.id, agent: agent.name },
      })
      RuntimeTaskLedger.appendEventBestEffort({
        sessionID: ctx.sessionID,
        kind: "agent.control",
        message: `subagent ${agent.name} queued`,
        metadata: { childSessionID: session.id, description: params.description },
      })
      Bus.publish(RuntimeEvents.SubagentLifecycle, {
        sessionID: ctx.sessionID,
        subagentSessionID: session.id,
        agent: agent.name,
        phase: "queued",
      })

      const messageID = Identifier.ascending("message")
      const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
      const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
        if (evt.properties.part.sessionID !== session.id) return
        if (evt.properties.part.messageID === messageID) return
        if (evt.properties.part.type !== "tool") return
        const part = evt.properties.part
        parts[part.id] = {
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }
        ctx.metadata({
          title: params.description,
          metadata: {
            summary: Object.values(parts).sort((a, b) => a.id.localeCompare(b.id)),
            sessionId: session.id,
          },
        })
        ctx.progress?.({
          message: `子 Agent ${agent.name} 正在执行`,
          title: params.description,
          metadata: { completedToolCount: Object.values(parts).filter((item) => item.state.status === "completed").length },
        })
      })

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      RuntimeTaskLedger.linkChildTask({ sessionID: ctx.sessionID, childSessionID: session.id })

      function cancel() {
        cancelSessionPrompt(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await resolvePromptParts(params.prompt)
      Bus.publish(RuntimeEvents.SubagentLifecycle, {
        sessionID: ctx.sessionID,
        subagentSessionID: session.id,
        agent: agent.name,
        phase: "running",
      })

      let result: MessageV2.WithParts
      try {
        result = await promptSession({
          messageID,
          sessionID: session.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: agent.name,
          tools: {
            todowrite: false,
            todoread: false,
            ...(hasTaskPermission ? {} : { task: false }),
            ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
          },
          parts: promptParts,
        })
      } catch (error) {
        RuntimeTaskLedger.recordChildTaskOutcome({
          sessionID: ctx.sessionID,
          childSessionID: session.id,
          status: "failed",
          result: { error: String(error) },
        })
        Bus.publish(RuntimeEvents.SubagentLifecycle, {
          sessionID: ctx.sessionID,
          subagentSessionID: session.id,
          agent: agent.name,
          phase: "failed",
        })
        throw error
      }
      unsub()
      const messages = await Session.messages({ sessionID: session.id })
      const summary = messages
        .filter((x) => x.info.role === "assistant")
        .flatMap((msg) => msg.parts.filter((x: any) => x.type === "tool") as MessageV2.ToolPart[])
        .map((part) => ({
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }))
      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""
      const contract = createSubagentContract({
        description: params.description,
        agent: agent.name,
        sessionID: session.id,
        summary: text,
        producedArtifacts: collectArtifactHints(messages),
        nextStepRecommendation: text
          ? "Integrate the subagent summary into the parent turn and decide whether follow-up work is needed."
          : "",
      })

      RuntimeTaskLedger.recordChildTaskOutcome({
        sessionID: ctx.sessionID,
        childSessionID: session.id,
        status: "completed",
        result: { summary: text, contract },
      })
      Bus.publish(RuntimeEvents.SubagentLifecycle, {
        sessionID: ctx.sessionID,
        subagentSessionID: session.id,
        agent: agent.name,
        phase: "completed",
      })

      const output = [text, "", "<subagent_result>", JSON.stringify(contract, null, 2), "</subagent_result>"].join("\n")

      return {
        title: params.description,
        metadata: {
          summary,
          sessionId: session.id,
          contract,
        },
        output,
      }
    },
  }
})
