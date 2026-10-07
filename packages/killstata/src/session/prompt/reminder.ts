import type { Agent } from "../../agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Session } from "../session-state"

/**
 * 主 Agent 不再依赖 Explorer/Analyst 切换提示。
 * 研究设计、数据状态与关键澄清均来自结构化 runtime context 和主提示词，
 * 避免每轮向模型重复注入模式交接、计划审批等历史包袱。
 */
export async function insertReminders(input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  return input.messages
}
