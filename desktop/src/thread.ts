/**
 * 对话流消息模型（Codex 风格界面）。
 *
 * 四种消息：
 * - user      研究者提交的问题（可选附件：数据文件 + 工作表）
 * - progress  分析引擎的实时进度（工具调用等）
 * - assistant 引擎返回的结果文档（markdown，读成段落/表格/标题）
 * - system    引擎状态、错误、取消等系统提示（弱化居中显示）
 */

export type RunStatus = "idle" | "preparing" | "running" | "waiting_for_user" | "completed" | "failed" | "cancelled" | "interrupted"

export type ProgressStep = {
  id: string
  label: string
  phase: "analysis"
  status: "queued" | "running" | "completed" | "failed" | "recovered" | "pending"
}

export type ThreadMessage =
  | { kind: "user"; id: number; createdAt?: string; text: string; datasetName?: string; worksheetName?: string }
  | { kind: "progress"; id: number; createdAt?: string; message: string; step?: ProgressStep }
  | { kind: "assistant"; id: number; createdAt?: string; document: string; resultExportable?: boolean; reasoning?: string; streaming?: boolean }
  | { kind: "system"; id: number; createdAt?: string; message: string; tone: "info" | "warning" | "error" }

/** 尚未分配 id 的消息（union 上的分布式 Omit，避免只保留共同属性）。 */
export type NewThreadMessage = ThreadMessage extends infer T
  ? T extends ThreadMessage
    ? Omit<T, "id">
    : never
  : never

/** markdown 结果文档的安全阅读块：只读成标题、段落与严格管道表格。 */
export type ResultDocumentBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "paragraph"; text: string }

export function nextThreadID(thread: ThreadMessage[]): number {
  return thread.reduce((max, message) => Math.max(max, message.id), 0) + 1
}

/** progress 消息的展示状态：按 engine/event-relay.ts 已知的固定中文文案模式分类。 */
export type ProgressTone = "working" | "done" | "attention" | "waiting"

export type RunProgressSnapshot = {
  elapsedMilliseconds: number
  progressUpdates: number
}

/**
 * 未匹配任何已知模式时回退 "working"（当前唯一样式），保证新增/未预见的进度文案
 * 不会被误判成其他状态——分类只做加法，不改变协议或既有视觉。
 */
export function progressTone(message: string): ProgressTone {
  if (message.endsWith("已完成") || message.endsWith("已恢复")) return "done"
  if (message.includes("独立核验通过") || message.includes("独立核验完成")) return "done"
  if (message.includes("独立核验未通过")) return "attention"
  if (message.includes("独立核验未完成")) return "attention"
  if (message.endsWith("未完成，引擎正在处理")) return "attention"
  if (message.includes("澄清问题") || message.includes("请求授权")) return "waiting"
  return "working"
}

/** 把从 Date.now() 差值得到的毫秒时长格式化为紧凑中文；只按整秒运作，不做任何估算。 */
export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`
  return `${Math.floor(totalSeconds / 3600)} 时 ${Math.floor((totalSeconds % 3600) / 60)} 分`
}
